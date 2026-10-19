from dotenv import load_dotenv
from pathlib import Path
ROOT_DIR = Path(__file__).parent
import sys
sys.path.insert(0, str(ROOT_DIR))  # so scoreboard.py imports wherever uvicorn is started
load_dotenv(ROOT_DIR / '.env')

import os
import hashlib
import math
import threading
import hmac
import logging
import uuid
import jwt
import bcrypt
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Literal
from itertools import combinations, permutations

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Response, UploadFile, File, Form
from fastapi.responses import RedirectResponse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError
import secrets
from pydantic import BaseModel, Field, EmailStr


# --------- Mongo ---------
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# --------- App ---------
app = FastAPI(title="Battlerite Arena Tracker")
api_router = APIRouter(prefix="/api")

# --------- Constants ---------
JWT_ALGORITHM = "HS256"
K_FACTOR = 24
BASE_MMR = 1200
PLACEMENT_MATCHES = 10            # first N matches of the season (per player)
PLACEMENT_WIN_MULTIPLIER = 2.0    # placement wins earn 2x MMR
CARRY_WIN_MULTIPLIER = 1.15       # +15% when carrying a sub-average teammate
# Both bonuses are off unless PLACEMENT_BONUS=true / CARRY_BONUS=true is in the backend settings.
# Each match keeps the rules it was logged under (bonus_rules), so changing these only affects
# matches logged afterwards - nothing is recalculated.
_on = lambda name: os.environ.get(name, "false").strip().lower() in ("1", "true", "yes", "on")
PLACEMENT_BONUS = _on("PLACEMENT_BONUS")
CARRY_BONUS = _on("CARRY_BONUS")
UNRANKED_SEASON_NAME = "Unranked"
ACTIVE_FORMATS = ("2v2", "3v3")   # 1v1 is retired: old 1v1 games stay viewable, no new ones  # permanent season for unranked games (no MMR)

CHAMPIONS = [
    # Melee
    {"name": "Bakko", "role": "Melee"},
    {"name": "Croak", "role": "Melee"},
    {"name": "Freya", "role": "Melee"},
    {"name": "Jamila", "role": "Melee"},
    {"name": "Raigon", "role": "Melee"},
    {"name": "Rook", "role": "Melee"},
    {"name": "Ruh Kaan", "role": "Melee"},
    {"name": "Shifu", "role": "Melee"},
    {"name": "Thorn", "role": "Melee"},
    # Ranged
    {"name": "Alysia", "role": "Ranged"},
    {"name": "Ashka", "role": "Ranged"},
    {"name": "Destiny", "role": "Ranged"},
    {"name": "Ezmo", "role": "Ranged"},
    {"name": "Iva", "role": "Ranged"},
    {"name": "Jade", "role": "Ranged"},
    {"name": "Jumong", "role": "Ranged"},
    {"name": "Shen Rao", "role": "Ranged"},
    {"name": "Taya", "role": "Ranged"},
    {"name": "Varesh", "role": "Ranged"},
    # Support
    {"name": "Blossom", "role": "Support"},
    {"name": "Lucie", "role": "Support"},
    {"name": "Oldur", "role": "Support"},
    {"name": "Pearl", "role": "Support"},
    {"name": "Pestilus", "role": "Support"},
    {"name": "Poloma", "role": "Support"},
    {"name": "Sirius", "role": "Support"},
    {"name": "Ulric", "role": "Support"},
    {"name": "Zander", "role": "Support"},
]


# --------- Auth Helpers ---------
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))

def get_jwt_secret() -> str:
    return os.environ["JWT_SECRET"]

def create_access_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(days=7),
        "type": "access",
    }
    return jwt.encode(payload, get_jwt_secret(), algorithm=JWT_ALGORITHM)

async def get_current_user(request: Request) -> dict:
    token = request.cookies.get("access_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALGORITHM])
        user = await db.users.find_one({"id": payload["sub"]})
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        user.pop("_id", None)
        user.pop("password_hash", None)
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def admin_required(request: Request) -> dict:
    user = await get_current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


# --------- Discord bot auth ---------
# The bot authenticates with a shared secret sent in the X-Bot-Key header.
# Set BOT_API_KEY in backend/.env (and the same value in the bot's .env).
BOT_USER = {"id": "discord-bot", "name": "Discord Bot", "role": "bot"}

def _bot_key_ok(request: Request) -> bool:
    expected = os.environ.get("BOT_API_KEY", "")
    given = request.headers.get("X-Bot-Key", "")
    return bool(expected) and hmac.compare_digest(given.encode(), expected.encode())

async def bot_required(request: Request) -> dict:
    if not _bot_key_ok(request):
        raise HTTPException(status_code=401, detail="Valid bot key required")
    return BOT_USER

async def admin_or_bot(request: Request) -> dict:
    if _bot_key_ok(request):
        return BOT_USER
    return await admin_required(request)


# --------- Models ---------
class LoginInput(BaseModel):
    email: EmailStr
    password: str

class RegisterInput(BaseModel):
    email: EmailStr
    password: str
    name: Optional[str] = None

class SeasonCreate(BaseModel):
    name: str
    end_date: Optional[str] = None  # ISO date string

class SeasonUpdate(BaseModel):
    name: Optional[str] = None
    end_date: Optional[str] = None

class PlayerCreate(BaseModel):
    name: str

class PlayerStats(BaseModel):
    """Raw scoreboard numbers from the in-game "Average Total" tab (per-round
    averages), stored exactly as shown.
    Any normalisation is derived at read time (see normalize_match_stats)."""
    score: Optional[int] = Field(default=None, ge=0)
    damage: Optional[int] = Field(default=None, ge=0)
    protection: Optional[int] = Field(default=None, ge=0)
    disables: Optional[int] = Field(default=None, ge=0)

class MatchPlayerInput(BaseModel):
    player_id: str
    champion: str
    role: str  # Melee/Ranged/Support
    team: Literal["A", "B"]
    stats: Optional[PlayerStats] = None

class MatchCreate(BaseModel):
    season_id: str
    format: Literal["1v1", "2v2", "3v3"]
    team_a_rounds: int
    team_b_rounds: int
    players: List[MatchPlayerInput]
    notes: Optional[str] = ""
    played_at: Optional[str] = None
    screenshot_id: Optional[str] = None   # a screenshot read with /screenshots/read, attached on save
    tournament_match_id: Optional[str] = None   # a game in a tournament match ("<tournament id>:<match id>")


# --------- ELO ---------
def expected_score(rating_a: float, rating_b: float) -> float:
    return 1.0 / (1.0 + 10 ** ((rating_b - rating_a) / 400.0))

def compute_elo_delta(team_a_mmr: float, team_b_mmr: float,
                     team_a_rounds: int, team_b_rounds: int) -> float:
    """Legacy helper: returns team-level ELO change for team A."""
    if team_a_rounds == team_b_rounds:
        return 0.0
    actual_a = 1.0 if team_a_rounds > team_b_rounds else 0.0
    exp_a = expected_score(team_a_mmr, team_b_mmr)
    round_diff = abs(team_a_rounds - team_b_rounds)
    max_rounds = max(team_a_rounds, team_b_rounds)
    multiplier = 1.0 + (round_diff / max_rounds if max_rounds else 0)
    return K_FACTOR * (actual_a - exp_a) * multiplier


def current_bonus_rules() -> dict:
    return {"placement": PLACEMENT_BONUS, "carry": CARRY_BONUS}


def match_bonus_rules(m: dict) -> dict:
    """The bonus rules a logged match is scored under. Matches from before rules were stored
    were scored with both bonuses (old-site imports with none)."""
    if m.get("bonus_rules") is not None:
        return m["bonus_rules"]
    return {"placement": True, "carry": True}


def compute_player_deltas(team_a_mmrs: dict, team_b_mmrs: dict,
                          team_a_rounds: int, team_b_rounds: int,
                          placement_counts: dict = None, bonuses: bool = True,
                          rules: Optional[dict] = None) -> dict:
    """Compute per-player ELO deltas.

    Within the winning team the weaker player gains a larger share (bigger upset for them),
    within the losing team the stronger player loses a larger share.

    Bonuses applied to winners only (break strict zero-sum):
    - Placement bonus: if player has played < PLACEMENT_MATCHES this season (before this match),
      the win is multiplied by PLACEMENT_WIN_MULTIPLIER.
    - Carry bonus: if a winning player's MMR exceeds the enemy average AND at least one of
      their teammates has an MMR below the enemy average, their gain is multiplied by
      CARRY_WIN_MULTIPLIER.

    bonuses=False skips both (matches imported from the old site, which were scored
    before these bonuses existed, keep their original MMR changes).
    rules: {"placement": bool, "carry": bool} - which bonuses this match was logged under
    (default: the current settings). Placement still counts every match of the season.

    Returns {player_id: {"delta": float, "placement_bonus": bool, "carry_bonus": bool}}.
    """
    out = {}
    if not team_a_mmrs or not team_b_mmrs:
        return out
    if team_a_rounds == team_b_rounds:
        return {pid: {"delta": 0.0, "placement_bonus": False, "carry_bonus": False}
                for pid in list(team_a_mmrs) + list(team_b_mmrs)}

    placement_counts = placement_counts or {}
    rules = rules if rules is not None else current_bonus_rules()
    use_placement, use_carry = bool(rules.get("placement")), bool(rules.get("carry"))

    avg_a = sum(team_a_mmrs.values()) / len(team_a_mmrs)
    avg_b = sum(team_b_mmrs.values()) / len(team_b_mmrs)
    a_won = team_a_rounds > team_b_rounds
    round_diff = abs(team_a_rounds - team_b_rounds)
    max_rounds = max(team_a_rounds, team_b_rounds)
    multiplier = 1.0 + (round_diff / max_rounds if max_rounds else 0)

    team_size = len(team_a_mmrs)
    team_delta_a = K_FACTOR * ((1.0 if a_won else 0.0) - expected_score(avg_a, avg_b)) * multiplier * team_size

    def distribute(team_delta: float, team_mmrs: dict, opp_avg: float, won: bool) -> dict:
        if won:
            weights = {pid: max(0.1, 1.0 - expected_score(mmr, opp_avg)) for pid, mmr in team_mmrs.items()}
        else:
            weights = {pid: max(0.1, expected_score(mmr, opp_avg)) for pid, mmr in team_mmrs.items()}
        total = sum(weights.values()) or 1.0
        return {pid: team_delta * (w / total) for pid, w in weights.items()}

    base_a = distribute(team_delta_a, team_a_mmrs, avg_b, a_won)
    base_b = distribute(-team_delta_a, team_b_mmrs, avg_a, not a_won)

    def finalize(base: dict, team_mmrs: dict, opp_avg: float, won: bool) -> dict:
        has_weak_mate = any(mmr < opp_avg for mmr in team_mmrs.values())
        result = {}
        for pid, delta in base.items():
            placement_bonus = False
            carry_bonus = False
            if won and delta > 0 and bonuses:
                if use_placement and placement_counts.get(pid, 0) < PLACEMENT_MATCHES:
                    delta *= PLACEMENT_WIN_MULTIPLIER
                    placement_bonus = True
                if use_carry and has_weak_mate and team_mmrs[pid] > opp_avg:
                    other_mmrs = [m for pid2, m in team_mmrs.items() if pid2 != pid]
                    if any(m < opp_avg for m in other_mmrs):
                        delta *= CARRY_WIN_MULTIPLIER
                        carry_bonus = True
            result[pid] = {"delta": delta, "placement_bonus": placement_bonus, "carry_bonus": carry_bonus}
        return result

    out.update(finalize(base_a, team_a_mmrs, avg_b, a_won))
    out.update(finalize(base_b, team_b_mmrs, avg_a, not a_won))
    return out


async def _no_docs():
    return
    yield


# --------- Startup ---------
@app.on_event("startup")
async def startup():
    # Indexes
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.users.create_index("discord_id", unique=True, sparse=True)
    await db.players.create_index("id", unique=True)
    await db.seasons.create_index("id", unique=True)
    await db.matches.create_index("id", unique=True)
    # quick lookups instead of reading every match: a player's matches (player pages, MMR, team
    # balancing, repeat-team check), a season's matches in order, and a match by its code
    await db.matches.create_index("players.player_id")
    await db.matches.create_index([("season_id", 1), ("played_at", 1)])
    await db.matches.create_index("discord_match_id")
    await db.players.create_index("discord_id", unique=True, sparse=True)
    await db.pending_matches.create_index("id", unique=True)
    await db.link_requests.create_index("id", unique=True)
    await db.screenshots.create_index("id", unique=True)
    await db.champion_icons.create_index("champion")
    await db.ocr_feedback.create_index("created_at")
    await db.screenshots.create_index("sha256")
    await db.admin_settings.create_index("key", unique=True)
    try:   # an earlier version put this index on the wrong collection
        await db.settings.drop_index("key_1")
    except Exception:
        pass
    await load_setting_overrides()
    _spawn(prune_screenshots())
    _spawn(_backfill_mmr_before())
    try:
        await backfill_match_codes()
    except Exception:
        logging.getLogger(__name__).exception("Match code backfill failed")
    try:
        await clean_discord_notes()
    except Exception:
        logging.getLogger(__name__).exception("Discord notes cleanup failed")
    schedule_leaderboard_push()   # picks up settings changes (e.g. DISCORD_LEADERBOARD_SIZE) on every restart

    # Seed admin
    admin_email = os.environ["ADMIN_EMAIL"].lower()
    admin_password = os.environ["ADMIN_PASSWORD"]
    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": admin_email,
            "password_hash": hash_password(admin_password),
            "name": "Admin",
            "role": "admin",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    elif not verify_password(admin_password, existing["password_hash"]):
        await db.users.update_one(
            {"email": admin_email},
            {"$set": {"password_hash": hash_password(admin_password)}}
        )

    # Seed champions
    count = await db.champions.count_documents({})
    if count == 0:
        await db.champions.insert_many([{**c} for c in CHAMPIONS])
    else:
        # Sync roster: upsert every champion + fix roles on existing docs
        for c in CHAMPIONS:
            await db.champions.update_one({"name": c["name"]}, {"$set": c}, upsert=True)
        # Migrate historical matches when a champion's role has changed. This reads every match, so it
        # only runs with CHAMPION_ROLE_SYNC=true in the settings (set it once after changing a role).
        current_roles = {c["name"]: c["role"] for c in CHAMPIONS}
        matches_cursor = db.matches.find({}) if _on("CHAMPION_ROLE_SYNC") else None
        async for m in (matches_cursor or _no_docs()):
            changed = False
            new_players = []
            for p in m["players"]:
                target = current_roles.get(p["champion"])
                if target and p.get("role") != target:
                    p = {**p, "role": target}
                    changed = True
                new_players.append(p)
            if changed:
                await db.matches.update_one({"id": m["id"]}, {"$set": {"players": new_players}})

    # Seed default season
    if await db.seasons.count_documents({}) == 0:
        await db.seasons.insert_one({
            "id": str(uuid.uuid4()),
            "name": "Season 1",
            "active": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    await ensure_unranked_season()


@app.on_event("shutdown")
async def shutdown():
    client.close()


# --------- Auth endpoints ---------
@api_router.post("/auth/login")
async def login(data: LoginInput, response: Response):
    email = data.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not user.get("password_hash") or not verify_password(data.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token(user["id"], user["email"])
    response.set_cookie(
        key="access_token", value=token, httponly=True,
        secure=True, samesite="none", max_age=7 * 24 * 3600, path="/",
    )
    return {"id": user["id"], "email": user["email"], "name": user["name"], "role": user["role"], "token": token}


@api_router.post("/auth/register")
async def register(data: RegisterInput, response: Response):
    email = data.email.lower().strip()
    if len(data.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(409, "An account with this email already exists")
    uid = str(uuid.uuid4())
    name = (data.name or email.split("@")[0]).strip() or email
    await db.users.insert_one({
        "id": uid, "email": email,
        "password_hash": hash_password(data.password),
        "name": name, "role": "viewer",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    token = create_access_token(uid, email)
    response.set_cookie(
        key="access_token", value=token, httponly=True,
        secure=True, samesite="none", max_age=7 * 24 * 3600, path="/",
    )
    return {"id": uid, "email": email, "name": name, "role": "viewer", "token": token}


@api_router.post("/auth/logout")
async def logout(response: Response, user: dict = Depends(get_current_user)):
    response.delete_cookie("access_token", path="/")
    return {"ok": True}


@api_router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user


class SeasonPick(BaseModel):
    name: Literal["all", "leaderboard"]   # which season picker
    value: str = Field(default="", max_length=64)   # "" = All, "ranked" = All Ranked, else a season id


@api_router.put("/auth/me/season-pick")
async def save_season_pick(data: SeasonPick, user: dict = Depends(get_current_user)):
    """Remember a logged-in player's last season pick on their account (it follows them across devices)."""
    await db.users.update_one({"id": user["id"]}, {"$set": {f"prefs.seasons.{data.name}": data.value}})
    return {"ok": True}



# --------- Log in with Discord ---------
# Discord Developer Portal > your app (the bot's app is fine) > OAuth2:
#   copy Client ID + Client Secret, and add the redirect URL below.
DISCORD_CLIENT_ID = os.environ.get("DISCORD_CLIENT_ID", "").strip()
DISCORD_CLIENT_SECRET = os.environ.get("DISCORD_CLIENT_SECRET", "").strip()
DISCORD_REDIRECT_URI = os.environ.get("DISCORD_REDIRECT_URI", "").strip()   # .../api/auth/discord/callback
FRONTEND_URL = os.environ.get("FRONTEND_URL", "").rstrip("/")              # where to send people after login
DISCORD_ADMIN_IDS = {x.strip() for x in os.environ.get("DISCORD_ADMIN_IDS", "").split(",") if x.strip()}


def _discord_enabled() -> bool:
    return bool(DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET and DISCORD_REDIRECT_URI)


def _discord_http(method: str, url: str, form: Optional[dict] = None, token: Optional[str] = None):
    import json
    import urllib.error
    import urllib.parse
    import urllib.request
    headers = {"User-Agent": "BRStats (login, 1.0)"}
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None


def _set_session_cookie(response: Response, token: str):
    response.set_cookie(key="access_token", value=token, httponly=True,
                        secure=True, samesite="none", max_age=7 * 24 * 3600, path="/")


@api_router.get("/auth/discord/enabled")
async def discord_login_enabled():
    return {"enabled": _discord_enabled()}


@api_router.get("/auth/discord/login")
async def discord_login(request: Request):
    import secrets
    import urllib.parse
    if not _discord_enabled():
        raise HTTPException(400, "Discord login isn't set up (see DISCORD_CLIENT_ID in backend/.env)")
    state = secrets.token_urlsafe(24)
    url = "https://discord.com/oauth2/authorize?" + urllib.parse.urlencode({
        "client_id": DISCORD_CLIENT_ID, "redirect_uri": DISCORD_REDIRECT_URI,
        "response_type": "code", "scope": "identify", "state": state, "prompt": "none",
    })
    resp = RedirectResponse(url, status_code=302)
    resp.set_cookie("discord_oauth_state", state, httponly=True, samesite="lax", max_age=600, path="/",
                    secure=DISCORD_REDIRECT_URI.startswith("https://"))
    return resp


@api_router.get("/auth/discord/callback")
async def discord_callback(request: Request, code: Optional[str] = None, state: Optional[str] = None,
                           error: Optional[str] = None):
    front = FRONTEND_URL or str(request.base_url).rstrip("/")
    def fail(reason: str):
        r = RedirectResponse(f"{front}/login?discord_error={reason}", status_code=302)
        r.delete_cookie("discord_oauth_state", path="/")
        return r
    if error:
        return fail("cancelled")
    expected = request.cookies.get("discord_oauth_state")
    if not code or not state or not expected or not hmac.compare_digest(state, expected):
        return fail("expired")
    loop = asyncio.get_running_loop()
    status, tok = await loop.run_in_executor(None, _discord_http, "POST", "https://discord.com/api/oauth2/token", {
        "client_id": DISCORD_CLIENT_ID, "client_secret": DISCORD_CLIENT_SECRET,
        "grant_type": "authorization_code", "code": code, "redirect_uri": DISCORD_REDIRECT_URI,
    }, None)
    if status >= 300 or not tok or not tok.get("access_token"):
        return fail("token")
    status, du = await loop.run_in_executor(None, _discord_http, "GET", "https://discord.com/api/users/@me",
                                            None, tok["access_token"])
    if status >= 300 or not du or not du.get("id"):
        return fail("profile")
    return await _finish_discord_login(du, front)


async def _finish_discord_login(du: dict, front: str):
    discord_id = str(du["id"])
    display = du.get("global_name") or du.get("username") or "Discord user"
    role = "admin" if discord_id in DISCORD_ADMIN_IDS else "player"
    user = await db.users.find_one({"discord_id": discord_id}, {"_id": 0})
    if user:
        upd = {"name": display, "discord_name": du.get("username"), "discord_avatar": du.get("avatar")}
        if discord_id in DISCORD_ADMIN_IDS:
            upd["role"] = "admin"
        elif user.get("role") == "admin":
            upd["role"] = "player"  # removed from DISCORD_ADMIN_IDS
        await db.users.update_one({"id": user["id"]}, {"$set": upd})
        user = {**user, **upd}
    else:
        user = {"id": str(uuid.uuid4()), "email": f"discord:{discord_id}", "name": display, "role": role,
                "discord_id": discord_id, "discord_name": du.get("username"), "discord_avatar": du.get("avatar"),
                "created_at": _now_iso()}
        await db.users.insert_one({**user})
    linked = await db.players.find_one({"discord_id": discord_id}, {"_id": 0, "id": 1, "discord_name": 1})
    if linked and du.get("username") and linked.get("discord_name") != du["username"]:
        # e.g. an admin linked them by user ID only, or they renamed on Discord
        await db.players.update_one({"id": linked["id"]}, {"$set": {"discord_name": du["username"]}})
    resp = RedirectResponse(f"{front}/me" if linked else f"{front}/me?setup=1", status_code=302)
    _set_session_cookie(resp, create_access_token(user["id"], user["email"]))
    resp.delete_cookie("discord_oauth_state", path="/")
    return resp


async def _discord_user_required(request: Request) -> dict:
    user = await get_current_user(request)
    if not user.get("discord_id"):
        raise HTTPException(400, "Log in with Discord to use this")
    return user


@api_router.get("/me")
async def my_profile(user: dict = Depends(get_current_user)):
    out = {"user": user, "player": None, "link_request": None}
    if not user.get("discord_id"):
        return out
    player = await db.players.find_one({"discord_id": user["discord_id"]}, {"_id": 0})
    out["player"] = player   # the site sends linked players straight to their player page
    if not player:
        out["link_request"] = await db.link_requests.find_one(
            {"discord_id": user["discord_id"], "status": "pending"}, {"_id": 0})
    return out


class MyLinkInput(BaseModel):
    player_name: str


@api_router.post("/me/link")
async def my_link(data: MyLinkInput, user: dict = Depends(_discord_user_required)):
    """Discord-verified link: a new name is created and linked at once; an existing
    player needs an admin to approve (Discord proves who you are, not that you own that name)."""
    name = " ".join(data.player_name.split())
    if not 1 <= len(name) <= 30:
        raise HTTPException(400, "Player names must be 1-30 characters")
    did = user["discord_id"]
    if await db.players.find_one({"discord_id": did}):
        raise HTTPException(409, "You're already linked to a player")
    existing = await _find_player_by_name(name)
    if existing and existing.get("discord_id"):
        raise HTTPException(409, f"{existing['name']} is already linked to another Discord account")
    await db.link_requests.update_many({"discord_id": did, "status": "pending"},
                                       {"$set": {"status": "superseded", "decided_at": _now_iso()}})
    if not existing:
        player = {"id": str(uuid.uuid4()), "name": name, "created_at": _now_iso(),
                  "created_via": "discord-login", "discord_id": did, "discord_name": user.get("discord_name") or ""}
        await db.players.insert_one({**player})
        return {"linked": True, "player": player}
    req = {"id": str(uuid.uuid4()), "discord_id": did, "discord_name": user.get("discord_name") or user["name"],
           "player_id": existing["id"], "player_name": existing["name"], "new_player": False,
           "status": "pending", "source": "website", "created_at": _now_iso()}
    await db.link_requests.insert_one({**req})
    req.pop("_id", None)
    return {"linked": False, "link_request": req}


# --------- Champions ---------
@api_router.get("/champions")
async def list_champions():
    docs = await db.champions.find({}, {"_id": 0}).to_list(1000)
    return sorted(docs, key=lambda x: (x["role"], x["name"]))


import re

def is_ranked_season(season: Optional[dict]) -> bool:
    return bool(season) and season.get("ranked", True) is not False

async def season_filter(season_id: Optional[str]) -> dict:
    """Match query for a season picker value: "" / "all" = every season (unranked included),
    "ranked" = every ranked season, anything else = that one season."""
    if not season_id or season_id == "all":
        return {}
    if season_id == "ranked":
        ids = [x["id"] for x in await db.seasons.find({"ranked": {"$ne": False}}, {"_id": 0, "id": 1}).to_list(1000)]
        return {"season_id": {"$in": ids}}
    return {"season_id": season_id}


async def ensure_unranked_season() -> dict:
    """The single permanent 'Unranked' season. Matches logged here never change MMR."""
    s = await db.seasons.find_one({"ranked": False}, {"_id": 0})
    if s:
        return s
    doc = {
        "id": str(uuid.uuid4()),
        "name": UNRANKED_SEASON_NAME,
        "ranked": False,
        "active": False,
        "end_date": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.seasons.insert_one(doc)
    doc.pop("_id", None)
    return doc

async def get_active_ranked_season() -> Optional[dict]:
    return await db.seasons.find_one({"active": True, "ranked": {"$ne": False}}, {"_id": 0})


# --------- Match codes: S2-3v3-a1f9 = Season 2, a 3v3, match a1f9 (U-... = unranked) ---------
# The last part is a random 4-digit hex id, unique across every match ever (so "#a1f9" alone finds it too).
HEX_ID_RE = re.compile(r"^[0-9a-f]{4}$")
MATCH_CODE_RE = re.compile(r"^(S\d+|U)-(1v1|2v2|3v3)-([0-9a-f]{4})$")

def norm_code(text: Optional[str]) -> str:
    """'#s2-3V3-A1F9' -> 'S2-3v3-a1f9'; anything else just lowercased."""
    k = (text or "").strip().lstrip("#")
    parts = k.split("-")
    if len(parts) == 3:
        return f"{parts[0].upper()}-{parts[1].lower()}-{parts[2].lower()}"
    return k.lower()

def code_hex(code: Optional[str]) -> Optional[str]:
    k = norm_code(code)
    m = MATCH_CODE_RE.match(k)
    if m:
        return m.group(3)
    if re.match(r"^[0-9a-f]{4}([0-9a-f]{2})?$", k):   # a bare id, or an old 6-character one (keeps its start)
        return k[:4]
    return None

async def season_code(season: dict) -> str:
    if not is_ranked_season(season):
        return "U"
    m = re.match(r"^\s*Season\s+(\d+)", season.get("name") or "", re.IGNORECASE)
    if m:
        return f"S{int(m.group(1))}"
    ids = [x["id"] for x in await db.seasons.find({"ranked": {"$ne": False}}, {"_id": 0, "id": 1})
           .sort("created_at", 1).to_list(1000)]
    return f"S{ids.index(season['id']) + 1 if season['id'] in ids else len(ids) + 1}"

async def code_fits(code: Optional[str], season: dict, fmt: str) -> bool:
    """Is this a new-style code for this season and format?"""
    return bool(MATCH_CODE_RE.match(code or "")) and code.startswith(f"{await season_code(season)}-{fmt}-")

async def hex_taken(h: str, except_mid: Optional[str] = None) -> bool:
    q = {"discord_match_id": {"$regex": f"-{h}$"}}
    if except_mid:
        q["id"] = {"$ne": except_mid}
    return bool(await db.matches.find_one(q, {"_id": 1}))

async def new_hex() -> str:
    """A hex id nobody has had before. Reserved ids are never reused, even if the match is cancelled."""
    for _ in range(500):
        h = secrets.token_hex(2)
        try:
            await db.match_codes.insert_one({"_id": h, "at": _now_iso()})
        except DuplicateKeyError:
            continue
        if not await hex_taken(h):
            return h
    raise HTTPException(503, "Couldn't find a free match id")

async def claim_hex(h: str, except_mid: Optional[str] = None) -> bool:
    """Keep an id the match already has (reserved by the bot, or made up while the website was down)."""
    if await hex_taken(h, except_mid):
        return False
    try:
        await db.match_codes.insert_one({"_id": h, "at": _now_iso()})
    except DuplicateKeyError:
        pass   # reserved earlier - for this match
    return True

async def make_code(season: dict, fmt: str, wanted: Optional[str] = None, mid: Optional[str] = None) -> str:
    h = code_hex(wanted) if wanted else None
    if not (h and await claim_hex(h, mid)):
        h = await new_hex()
    return f"{await season_code(season)}-{fmt}-{h}"

def match_ref_query(key: str) -> dict:
    """Find a match by its id, its code (any capitalisation), just its hex id (#a1f9),
    or an old code it used to have (#f94749)."""
    k = (key or "").strip().lstrip("#")
    keys = list({k, k.lower(), norm_code(k)})
    q = [{"id": k}, {"discord_match_id": {"$in": keys}}, {"legacy_refs": {"$in": keys}}]
    if HEX_ID_RE.match(k.lower()):
        q.append({"discord_match_id": {"$regex": f"-{k.lower()}$"}})
    return {"$or": q}

async def backfill_match_codes():
    """One-off: give every existing match a code. Old ids keep their first 4 characters where free
    (f94749 -> S1-3v3-f947) and stay findable (legacy_refs); Discord match log posts are edited."""
    if await db.counters.find_one({"_id": "match-codes-v2"}):
        return
    seasons = {x["id"]: x for x in await db.seasons.find({}, {"_id": 0}).to_list(1000)}
    docs = await db.matches.find({}, {"_id": 0, "id": 1, "season_id": 1, "format": 1, "discord_match_id": 1, "legacy_refs": 1}) \
        .sort("played_at", 1).to_list(100000)
    touched = set()
    for d in docs:
        season = seasons.get(d["season_id"])
        if not season:
            continue
        old = d.get("discord_match_id")
        if await code_fits(old, season, d["format"]) and await claim_hex(code_hex(old), d["id"]):
            continue
        hexy = [r for r in [old] + (d.get("legacy_refs") or []) if r and re.match(r"^[0-9a-f]{6}$", r)]
        code = await make_code(season, d["format"], hexy[0][:4] if hexy else None, d["id"])
        upd = {"$set": {"discord_match_id": code}}
        if old and old != code:
            upd["$addToSet"] = {"legacy_refs": old}
        await db.matches.update_one({"id": d["id"]}, upd)
        touched.add(d["season_id"])
    await db.counters.insert_one({"_id": "match-codes-v2", "at": _now_iso()})
    for sid in touched:
        schedule_match_log_resync(sid, "")


BOT_NOTE_RE = re.compile(r"^Discord match #[\w-]+( - no screenshot)?(.*)$", re.DOTALL)

def strip_bot_note(notes: str) -> str:
    """'Discord match #f94749 - no screenshot' -> 'No screenshot' (the match code is shown anyway).
    Anything an admin wrote after it is kept."""
    m = BOT_NOTE_RE.match(notes or "")
    if not m:
        return notes
    rest = m.group(2).strip().lstrip("-·").strip()
    return " - ".join(x for x in ["No screenshot" if m.group(1) else "", rest] if x)

async def clean_discord_notes():
    """One-off: drop the bot's 'Discord match #...' text from match notes (and from matches still
    waiting to be confirmed). Only the website changes - nothing is posted or edited in Discord."""
    if await db.counters.find_one({"_id": "discord-notes-v1"}):
        return
    q = {"notes": {"$regex": "^Discord match #"}}
    for coll in (db.matches, db.pending_matches):
        for d in await coll.find(q, {"_id": 1, "notes": 1}).to_list(100000):
            await coll.update_one({"_id": d["_id"]}, {"$set": {"notes": strip_bot_note(d["notes"])}})
    await db.counters.insert_one({"_id": "discord-notes-v1", "at": _now_iso()})


class Lineup(BaseModel):
    code: str
    format: Literal["2v2", "3v3"]
    team_a: List[str]
    team_b: List[str]


@api_router.post("/matchmaking/lineups")
async def record_lineup(data: Lineup, user: dict = Depends(admin_or_bot)):
    """The bot launched a match with these teams: count them for repeat avoidance straight away,
    before the result is logged."""
    await db.lineups.update_one({"code": data.code}, {"$set": {
        "code": data.code, "format": data.format, "team_a": data.team_a, "team_b": data.team_b,
        "players": data.team_a + data.team_b, "at": _now_iso()}}, upsert=True)
    old = await db.lineups.find({}, {"_id": 1}).sort("at", -1).skip(500).to_list(1000)
    if old:
        await db.lineups.delete_many({"_id": {"$in": [d["_id"] for d in old]}})
    return {"ok": True}


@api_router.delete("/matchmaking/lineups/{code}")
async def forget_lineup(code: str, user: dict = Depends(admin_or_bot)):
    """A launched match was cancelled: its teams don't count as played."""
    await db.lineups.delete_one({"code": code})
    return {"ok": True}


class ReserveCode(BaseModel):
    format: Literal["2v2", "3v3"]
    ranked: bool = True


@api_router.post("/matches/reserve-code")
async def reserve_match_code(data: ReserveCode, user: dict = Depends(admin_or_bot)):
    """The bot takes a code when a lobby fills, so the players can see it straight away."""
    season = await get_active_ranked_season() if data.ranked else await ensure_unranked_season()
    if not season:
        raise HTTPException(400, "There is no active ranked season")
    return {"code": await make_code(season, data.format), "season_id": season["id"]}

async def check_and_close_expired_seasons():
    """Auto-close active seasons whose end_date has passed. Spawn next season."""
    now = datetime.now(timezone.utc)
    active = await db.seasons.find({"active": True, "end_date": {"$ne": None}}).to_list(100)
    for s in active:
        try:
            end = datetime.fromisoformat(s["end_date"])
        except Exception:
            continue
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        if end <= now:
            await db.seasons.update_one({"id": s["id"]}, {"$set": {
                "active": False, "closed_at": now.isoformat(),
            }})
            # Determine next season number from existing names
            all_names = [x["name"] for x in await db.seasons.find({}, {"_id": 0}).to_list(1000)]
            nums = [int(m.group(1)) for n in all_names for m in [re.match(r"^\s*Season\s+(\d+)", n or "", re.IGNORECASE)] if m]
            next_num = (max(nums) if nums else 0) + 1
            await db.seasons.insert_one({
                "id": str(uuid.uuid4()),
                "name": f"Season {next_num}",
                "active": True,
                "end_date": None,
                "created_at": now.isoformat(),
                "auto_created_from": s["id"],
            })


# --------- Seasons ---------
@api_router.get("/seasons")
async def list_seasons():
    await check_and_close_expired_seasons()
    docs = await db.seasons.find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return docs

@api_router.post("/seasons")
async def create_season(data: SeasonCreate, user: dict = Depends(admin_required)):
    data.name = " ".join(data.name.split())
    if not data.name:
        raise HTTPException(400, "Season name can't be empty")
    if data.name.lower() == UNRANKED_SEASON_NAME.lower():
        raise HTTPException(400, f"'{UNRANKED_SEASON_NAME}' is reserved")
    # Deactivate others
    await db.seasons.update_many({}, {"$set": {"active": False}})
    doc = {
        "id": str(uuid.uuid4()),
        "name": data.name,
        "active": True,
        "end_date": data.end_date,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.seasons.insert_one(doc)
    doc.pop("_id", None)
    schedule_leaderboard_push()
    return doc

@api_router.patch("/seasons/{sid}")
async def update_season(sid: str, data: SeasonUpdate, user: dict = Depends(admin_required)):
    # fields that were sent; end_date may be sent as null to remove it
    upd = data.model_dump(exclude_unset=True)
    if "name" in upd:
        upd["name"] = " ".join((upd["name"] or "").split())
        if not upd["name"]:
            raise HTTPException(400, "Season name can't be empty")
        if upd["name"].lower() == UNRANKED_SEASON_NAME.lower():
            raise HTTPException(400, f"'{UNRANKED_SEASON_NAME}' is reserved")
    if not upd:
        raise HTTPException(400, "Nothing to update")
    target = await db.seasons.find_one({"id": sid}, {"_id": 0})
    if target and not is_ranked_season(target):
        raise HTTPException(400, "The Unranked season can't be edited")
    result = await db.seasons.update_one({"id": sid}, {"$set": upd})
    if result.matched_count == 0:
        raise HTTPException(404, "Season not found")
    doc = await db.seasons.find_one({"id": sid}, {"_id": 0})
    schedule_leaderboard_push()   # the post shows the season name
    return doc

@api_router.post("/seasons/{sid}/activate")
async def activate_season(sid: str, user: dict = Depends(admin_required)):
    target = await db.seasons.find_one({"id": sid})
    if not target:
        raise HTTPException(404, "Season not found")
    if not is_ranked_season(target):
        raise HTTPException(400, "The Unranked season can't be made active")
    await db.seasons.update_many({}, {"$set": {"active": False}})
    result = await db.seasons.update_one({"id": sid}, {"$set": {"active": True}})
    if result.matched_count == 0:
        raise HTTPException(404, "Season not found")
    schedule_leaderboard_push()
    return {"ok": True}

@api_router.delete("/seasons/{sid}")
async def delete_season(sid: str, user: dict = Depends(admin_required)):
    target = await db.seasons.find_one({"id": sid})
    if target and not is_ranked_season(target):
        raise HTTPException(400, "The Unranked season can't be deleted")
    await db.seasons.delete_one({"id": sid})
    await db.matches.delete_many({"season_id": sid})
    schedule_leaderboard_push()
    return {"ok": True}


# --------- Players ---------
@api_router.get("/players")
async def list_players():
    docs = await db.players.find({}, {"_id": 0, "discord_id": 0}).to_list(1000)
    return sorted(docs, key=lambda x: x["name"].lower())

@api_router.post("/players")
async def create_player(data: PlayerCreate, user: dict = Depends(admin_required)):
    doc = {
        "id": str(uuid.uuid4()),
        "name": data.name.strip(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.players.insert_one(doc)
    doc.pop("_id", None)
    return doc

@api_router.delete("/players/{pid}")
async def delete_player(pid: str, user: dict = Depends(admin_required)):
    await db.players.delete_one({"id": pid})
    return {"ok": True}


# --------- Matches ---------
def rating_key(mp: dict) -> str:
    """Which MMR track a match entry belongs to. Normally the player's own id; after a
    merge, games from the identity whose MMR wasn't kept carry mmr_track and keep
    their own separate rating history (so nobody else's MMR changes)."""
    return mp.get("mmr_track") or mp["player_id"]


def counts_for_mmr(mp: dict) -> bool:
    return not mp.get("mmr_track")


async def _backfill_mmr_before():
    """Matches logged before each player's MMR-before was stored: replay their seasons once."""
    sids = await db.matches.distinct("season_id", {"players": {"$elemMatch": {"mmr_before": {"$exists": False}}}})
    for sid in sids:
        await recompute_season_elo(sid)


async def recompute_season_elo(season_id: str):
    """Recompute elo_delta for every match in a season in chronological order."""
    season = await db.seasons.find_one({"id": season_id})
    matches = await db.matches.find({"season_id": season_id}).sort("played_at", 1).to_list(10000)
    if season and not is_ranked_season(season):
        for m in matches:
            upd = {
                "players": [{**p, "elo_delta": 0, "placement_bonus": False, "carry_bonus": False, "mmr_before": None}
                            for p in m["players"]],
                "winner_team": "A" if m["team_a_rounds"] > m["team_b_rounds"] else "B",
            }
            if any(m.get(k) != v for k, v in upd.items()):
                await db.matches.update_one({"id": m["id"]}, {"$set": upd})
        return
    player_mmr = {}
    player_match_count = {}  # pid -> matches played in this season before current
    adjs = await season_adjustments(season_id)
    ai = 0
    for m in matches:
        # admin MMR adjustments made before this match count towards it
        while ai < len(adjs) and adjs[ai]["at"] <= m["played_at"]:
            k = rating_key(adjs[ai])
            player_mmr[k] = player_mmr.get(k, BASE_MMR) + adjs[ai]["delta"]
            ai += 1
        team_a = [p for p in m["players"] if p["team"] == "A"]
        team_b = [p for p in m["players"] if p["team"] == "B"]
        if not team_a or not team_b:
            continue
        ta_mmrs = {rating_key(p): player_mmr.get(rating_key(p), BASE_MMR) for p in team_a}
        tb_mmrs = {rating_key(p): player_mmr.get(rating_key(p), BASE_MMR) for p in team_b}
        placement_counts = {rating_key(p): player_match_count.get(rating_key(p), 0)
                             for p in m["players"]}
        deltas = compute_player_deltas(ta_mmrs, tb_mmrs,
                                       m["team_a_rounds"], m["team_b_rounds"],
                                       placement_counts=placement_counts,
                                       bonuses=not m.get("legacy_scoring"),
                                       rules=match_bonus_rules(m))
        new_players = []
        for p in m["players"]:
            key = rating_key(p)
            info = deltas.get(key, {"delta": 0.0, "placement_bonus": False, "carry_bonus": False})
            d = info["delta"]
            new_players.append({
                **p,
                "mmr_before": round(player_mmr.get(key, BASE_MMR), 2),   # after = mmr_before + elo_delta
                "elo_delta": round(d, 2),
                "placement_bonus": info["placement_bonus"],
                "carry_bonus": info["carry_bonus"],
            })
            player_mmr[key] = player_mmr.get(key, BASE_MMR) + d
            player_match_count[key] = player_match_count.get(key, 0) + 1
        ta_avg = sum(ta_mmrs.values()) / len(ta_mmrs)
        tb_avg = sum(tb_mmrs.values()) / len(tb_mmrs)
        upd = {
            "players": new_players,
            "team_a_mmr_before": round(ta_avg, 2),
            "team_b_mmr_before": round(tb_avg, 2),
            "winner_team": "A" if m["team_a_rounds"] > m["team_b_rounds"] else "B",
        }
        if any(m.get(k) != v for k, v in upd.items()):   # most matches don't change - skip those writes
            await db.matches.update_one({"id": m["id"]}, {"$set": upd})
    schedule_leaderboard_push()


async def season_adjustments(season_id: str, player_id: Optional[str] = None, counted_only: bool = False) -> list:
    """Admin MMR adjustments in a season, oldest first. Each is a delta applied at
    `at`, so recomputing a season replays it in order with the matches."""
    q = {"season_id": season_id}
    if player_id:
        q["player_id"] = player_id
    if counted_only:
        q["mmr_track"] = {"$exists": False}
    return await db.mmr_adjustments.find(q, {"_id": 0}).sort("at", 1).to_list(100000)


async def get_player_mmr(player_id: str, season_id: str) -> float:
    """Compute current MMR for a player in a season based on matches."""
    # only this player's matches, and only the fields needed
    matches = await db.matches.find({"season_id": season_id, "players.player_id": player_id},
                                    {"_id": 0, "players.player_id": 1, "players.elo_delta": 1, "players.mmr_track": 1}).to_list(10000)
    mmr = BASE_MMR
    for m in matches:
        for mp in m["players"]:
            if mp["player_id"] == player_id and counts_for_mmr(mp):
                mmr += mp.get("elo_delta", 0)
                break
    for a in await season_adjustments(season_id, player_id, counted_only=True):
        mmr += a["delta"]
    return mmr


async def _team_mmr(player_ids: List[str], season_id: str) -> float:
    if not player_ids:
        return BASE_MMR
    total = 0.0
    for pid in player_ids:
        total += await get_player_mmr(pid, season_id)
    return total / len(player_ids)


@api_router.post("/matches")
async def create_match(data: MatchCreate, user: dict = Depends(admin_required)):
    """Log Match tab: save the match and post it to the Discord match log."""
    if data.format not in ACTIVE_FORMATS:
        raise HTTPException(400, "1v1 is no longer a format - log it as 2v2 or 3v3")
    if data.tournament_match_id:   # a tournament game: kept with its tournament, out of the stats
        return await _log_tournament_game(data, user.get("name") or user.get("email"))
    if data.screenshot_id:
        await _staged_screenshot(data.screenshot_id)   # check it before saving anything
    doc = await _insert_match(data)
    if data.screenshot_id:
        await _attach_screenshot(doc["id"], data.screenshot_id, user)
        doc = await db.matches.find_one({"id": doc["id"]}, {"_id": 0})
    schedule_match_log(doc["id"])
    return doc


async def _insert_match(data: MatchCreate, code: Optional[str] = None) -> dict:
    await check_and_close_expired_seasons()
    # Validate
    team_a = [p for p in data.players if p.team == "A"]
    team_b = [p for p in data.players if p.team == "B"]
    expected = {"1v1": 1, "2v2": 2, "3v3": 3}[data.format]
    if len(team_a) != expected or len(team_b) != expected:
        raise HTTPException(400, f"Expected {expected} players per team for {data.format}")
    if data.team_a_rounds == data.team_b_rounds:
        raise HTTPException(400, "Rounds cannot be tied")
    # No duplicate players across the whole match
    pids = [p.player_id for p in data.players]
    if len(set(pids)) != len(pids):
        raise HTTPException(400, "A player can only appear once per match")
    # No duplicate champions within the same team
    for team_label, team in [("A", team_a), ("B", team_b)]:
        champs = [p.champion for p in team]
        if len(set(champs)) != len(champs):
            raise HTTPException(400, f"Team {team_label} cannot pick the same champion twice")

    season = await db.seasons.find_one({"id": data.season_id})
    if not season:
        raise HTTPException(404, "Season not found")

    team_a_ids = [p.player_id for p in team_a]
    team_b_ids = [p.player_id for p in team_b]

    # Compute per-player deltas (placement + carry bonuses applied for winners)
    ta_mmrs = {pid: await get_player_mmr(pid, data.season_id) for pid in team_a_ids}
    tb_mmrs = {pid: await get_player_mmr(pid, data.season_id) for pid in team_b_ids}
    team_a_mmr = sum(ta_mmrs.values()) / len(ta_mmrs)
    team_b_mmr = sum(tb_mmrs.values()) / len(tb_mmrs)

    # Count matches each player has already played in this season (for placement bonus).
    placement_counts = {}
    for pid in team_a_ids + team_b_ids:
        placement_counts[pid] = await db.matches.count_documents({
            "season_id": data.season_id,
            "players": {"$elemMatch": {"player_id": pid, "mmr_track": {"$exists": False}}},
        })
    rules = current_bonus_rules()
    deltas = compute_player_deltas(ta_mmrs, tb_mmrs, data.team_a_rounds, data.team_b_rounds,
                                   placement_counts=placement_counts, rules=rules)
    if not is_ranked_season(season):
        deltas = {}  # unranked: logged for history/stats only, never moves MMR

    players_with_delta = []
    for p in data.players:
        info = deltas.get(p.player_id, {"delta": 0.0, "placement_bonus": False, "carry_bonus": False})
        players_with_delta.append({
            "player_id": p.player_id,
            "champion": p.champion,
            "role": p.role,
            "team": p.team,
            "elo_delta": round(info["delta"], 2),
            "mmr_before": round({**ta_mmrs, **tb_mmrs}[p.player_id], 2) if is_ranked_season(season) else None,
            "placement_bonus": info["placement_bonus"],
            "carry_bonus": info["carry_bonus"],
            "stats": p.stats.model_dump() if p.stats else None,
        })

    doc = {
        "id": str(uuid.uuid4()),
        "season_id": data.season_id,
        "format": data.format,
        "team_a_rounds": data.team_a_rounds,
        "team_b_rounds": data.team_b_rounds,
        "winner_team": "A" if data.team_a_rounds > data.team_b_rounds else "B",
        "players": players_with_delta,
        "notes": data.notes or "",
        "played_at": data.played_at or datetime.now(timezone.utc).isoformat(),
        "team_a_mmr_before": round(team_a_mmr, 2),
        "team_b_mmr_before": round(team_b_mmr, 2),
        "bonus_rules": rules,   # this match keeps these even if the settings change later
    }
    # keeps the id the bot reserved; a new one if there's none (or it's an old-style id)
    doc["discord_match_id"] = await make_code(season, data.format, code)
    if code and norm_code(code) != doc["discord_match_id"]:
        doc["legacy_refs"] = [code]
    await db.matches.insert_one(doc)
    doc.pop("_id", None)
    schedule_leaderboard_push()
    return doc


@api_router.get("/matches")
async def list_matches(season_id: Optional[str] = None, player_id: Optional[str] = None,
                       format: Optional[str] = None, q: Optional[str] = None,
                       limit: Optional[int] = None, offset: int = 0, around: Optional[str] = None):
    """Newest first. With `limit`: one page as {"items", "total"} (the Matches page); without it,
    every match as a list (dashboard, player pages). `q` searches player names, champions, notes and
    match codes (old ones too). `around` (an id or code) picks the page with that match in the middle,
    for links to a match; the reply then also says where the page starts and which match it was."""
    query = {}
    query.update(await season_filter(season_id))
    if player_id:
        query["players.player_id"] = player_id
    if format and format != "all":
        query["format"] = format
    text = (q or "").strip().lstrip("#")
    if text:
        rx = {"$regex": re.escape(text), "$options": "i"}
        named = [p["id"] for p in await db.players.find({"$or": [{"name": rx}, {"ign": rx}]}, {"_id": 0, "id": 1}).to_list(1000)]
        query["$or"] = [{"notes": rx}, {"players.champion": rx}, {"discord_match_id": rx}, {"legacy_refs": rx},
                        {"players.player_id": {"$in": named}}]
    cursor = db.matches.find(query, {"_id": 0}).sort([("played_at", -1), ("id", -1)])
    if limit is None:
        return await cursor.to_list(10000)
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    target = None
    if around:
        t = await db.matches.find_one({"$and": [query, match_ref_query(around)]}, {"_id": 0, "id": 1, "played_at": 1})
        if t:
            target = t["id"]
            newer = await db.matches.count_documents({"$and": [query, {"$or": [
                {"played_at": {"$gt": t["played_at"]}},
                {"played_at": t["played_at"], "id": {"$gt": t["id"]}}]}]})
            offset = max(0, newer - limit // 2)
            cursor = db.matches.find(query, {"_id": 0}).sort([("played_at", -1), ("id", -1)])
    items = await cursor.skip(offset).limit(limit).to_list(limit)
    return {"items": items, "total": await db.matches.count_documents(query), "offset": offset, "target": target}


@api_router.get("/matches/{mid}")
async def get_match(mid: str):
    """One match by its id or code (e.g. a link from the Discord match log to an old match)."""
    m = await db.matches.find_one(match_ref_query(mid), {"_id": 0})
    if not m:
        raise HTTPException(404, "Match not found")
    return m


@api_router.post("/admin/recompute-all")
async def recompute_all_seasons(user: dict = Depends(admin_required)):
    seasons = await db.seasons.find({}, {"_id": 0}).to_list(1000)
    for s in seasons:
        await recompute_season_elo(s["id"])
    return {"ok": True, "seasons": len(seasons)}


@api_router.put("/matches/{mid}")
async def update_match(mid: str, data: MatchCreate, user: dict = Depends(admin_required)):
    existing = await db.matches.find_one({"id": mid})
    if not existing:
        raise HTTPException(404, "Match not found")
    if data.format not in ACTIVE_FORMATS and existing.get("format") != data.format:
        raise HTTPException(400, "1v1 is no longer a format - use 2v2 or 3v3")
    team_a = [p for p in data.players if p.team == "A"]
    team_b = [p for p in data.players if p.team == "B"]
    expected = {"1v1": 1, "2v2": 2, "3v3": 3}[data.format]
    if len(team_a) != expected or len(team_b) != expected:
        raise HTTPException(400, f"Expected {expected} players per team for {data.format}")
    if data.team_a_rounds == data.team_b_rounds:
        raise HTTPException(400, "Rounds cannot be tied")
    pids = [p.player_id for p in data.players]
    if len(set(pids)) != len(pids):
        raise HTTPException(400, "A player can only appear once per match")
    for team_label, team in [("A", team_a), ("B", team_b)]:
        champs = [p.champion for p in team]
        if len(set(champs)) != len(champs):
            raise HTTPException(400, f"Team {team_label} cannot pick the same champion twice")

    if data.screenshot_id:
        await _staged_screenshot(data.screenshot_id)
    elif existing.get("screenshot_id") and _ocr_fields(existing) != _ocr_fields({
            "team_a_rounds": data.team_a_rounds, "team_b_rounds": data.team_b_rounds,
            "players": [p.model_dump() for p in data.players]}):
        await reset_ocr_streak()   # an admin corrected a screenshot result
    tracks = {p["player_id"]: p.get("mmr_track") for p in existing["players"]}  # keep merge history
    new_season = await db.seasons.find_one({"id": data.season_id}, {"_id": 0})
    if not new_season:
        raise HTTPException(404, "Season not found")
    recode = {}
    if not await code_fits(existing.get("discord_match_id"), new_season, data.format):
        # same hex id, new season/format part
        recode = {"discord_match_id": await make_code(new_season, data.format, existing.get("discord_match_id"), mid)}
        if existing.get("discord_match_id"):
            await db.matches.update_one({"id": mid}, {"$addToSet": {"legacy_refs": existing["discord_match_id"]}})
    await db.matches.update_one({"id": mid}, {"$set": {
        **recode,
        "season_id": data.season_id,
        "format": data.format,
        "team_a_rounds": data.team_a_rounds,
        "team_b_rounds": data.team_b_rounds,
        "notes": data.notes or "",
        "players": [{
            "player_id": p.player_id, "champion": p.champion,
            "role": p.role, "team": p.team, "elo_delta": 0,
            "stats": p.stats.model_dump() if p.stats else None,
            **({"mmr_track": tracks[p.player_id]} if tracks.get(p.player_id) else {}),
        } for p in data.players],
    }})
    if data.screenshot_id:
        await _attach_screenshot(mid, data.screenshot_id, user)
    # Recompute affected season(s)
    await recompute_season_elo(data.season_id)
    if existing["season_id"] != data.season_id:
        await recompute_season_elo(existing["season_id"])
    updated = await db.matches.find_one({"id": mid}, {"_id": 0})
    # this post and every later one in the season (their MMR-after numbers may have moved)
    schedule_match_log_resync(data.season_id, existing["played_at"])
    if existing["season_id"] != data.season_id:
        schedule_match_log_resync(existing["season_id"], existing["played_at"])
    return updated


@api_router.delete("/matches/{mid}")
async def delete_match(mid: str, user: dict = Depends(admin_required)):
    existing = await db.matches.find_one({"id": mid})
    if not existing:
        return {"ok": True}
    season_id = existing["season_id"]
    await db.matches.delete_one({"id": mid})
    await recompute_season_elo(season_id)
    if existing.get("discord_log"):
        _spawn(remove_match_log(existing))
    schedule_match_log_resync(season_id, existing["played_at"])   # later posts' MMR-after numbers
    return {"ok": True}


# --------- Stats ---------
@api_router.get("/stats/leaderboard")
async def leaderboard(season_id: Optional[str] = None, format: Optional[str] = None):
    if not season_id:
        s = await db.seasons.find_one({"active": True})
        if not s:
            return []
        season_id = s["id"]

    players = await db.players.find({}, {"_id": 0}).to_list(1000)
    q = {"season_id": season_id}
    if format and format in ("1v1", "2v2", "3v3"):   # 1v1 is retired, but old 1v1 games can still be viewed
        q["format"] = format
    matches = await db.matches.find(q, {"_id": 0, "players.stats": 0}).sort("played_at", 1).to_list(10000)

    stats = {}
    for p in players:
        stats[p["id"]] = {
            "player_id": p["id"], "name": p["name"],
            "mmr": BASE_MMR, "peak_mmr": BASE_MMR,
            "matches": 0, "wins": 0, "losses": 0,
            "rounds_won": 0, "rounds_lost": 0,
            "streak": 0,  # >0 = win streak, <0 = loss streak (current)
            "_recent": [],  # list of bools newest first for streak calc
        }

    adjs = await season_adjustments(season_id, counted_only=True)
    ai = 0

    def apply_adjustments(until: Optional[str]):
        nonlocal ai
        while ai < len(adjs) and (until is None or adjs[ai]["at"] <= until):
            st = stats.get(adjs[ai]["player_id"])
            if st:
                st["mmr"] += adjs[ai]["delta"]
                st["peak_mmr"] = max(st["peak_mmr"], st["mmr"])
            ai += 1

    # matches are in chronological order (played_at asc)
    for m in matches:
        apply_adjustments(m["played_at"])
        for mp in m["players"]:
            if mp["player_id"] not in stats:
                continue
            s = stats[mp["player_id"]]
            if counts_for_mmr(mp):
                s["mmr"] += mp.get("elo_delta", 0)
                s["peak_mmr"] = max(s["peak_mmr"], s["mmr"])
            s["matches"] += 1
            is_a = mp["team"] == "A"
            won = (is_a and m["team_a_rounds"] > m["team_b_rounds"]) or \
                  (not is_a and m["team_b_rounds"] > m["team_a_rounds"])
            if won:
                s["wins"] += 1
            else:
                s["losses"] += 1
            if is_a:
                s["rounds_won"] += m["team_a_rounds"]
                s["rounds_lost"] += m["team_b_rounds"]
            else:
                s["rounds_won"] += m["team_b_rounds"]
                s["rounds_lost"] += m["team_a_rounds"]
            s["_recent"].append(won)
    apply_adjustments(None)

    result = []
    for s in stats.values():
        # Compute current streak from most recent backwards
        streak = 0
        recent = list(reversed(s["_recent"]))
        if recent:
            first = recent[0]
            for r in recent:
                if r == first:
                    streak += 1
                else:
                    break
            s["streak"] = streak if first else -streak
        s.pop("_recent", None)
        s["mmr"] = round(s["mmr"], 2)
        s["peak_mmr"] = round(s["peak_mmr"], 2)
        s["winrate"] = round((s["wins"] / s["matches"] * 100) if s["matches"] > 0 else 0, 1)
        if s["matches"]:   # players with no games in this season/format aren't listed
            result.append(s)
    result.sort(key=lambda x: (-x["mmr"], -x["wins"]))
    for i, r in enumerate(result):
        r["rank"] = i + 1
    return result


async def trajectory_season(season_id: Optional[str]) -> Optional[dict]:
    """The one season an MMR trajectory is drawn for: the season picked if it's a ranked one, otherwise
    the active ranked season, or - between seasons - the ranked season that was played last."""
    if season_id and season_id not in ("all", "ranked"):
        s = await db.seasons.find_one({"id": season_id}, {"_id": 0})
        if is_ranked_season(s):
            return s
    s = await get_active_ranked_season()
    if s:
        return s
    ranked = await db.seasons.find({"ranked": {"$ne": False}}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    if not ranked:
        return None
    last = await db.matches.find_one({"season_id": {"$in": [x["id"] for x in ranked]}}, {"_id": 0, "season_id": 1},
                                     sort=[("played_at", -1)])
    return next((x for x in ranked if last and x["id"] == last["season_id"]), ranked[0])


async def mmr_trajectory(pid: str, season: Optional[dict]) -> list:
    """A player's MMR after each of their matches (and admin adjustments) in one season, oldest first."""
    if not season:
        return []
    ms = await db.matches.find({"season_id": season["id"], "players.player_id": pid},
                               {"_id": 0, "id": 1, "played_at": 1, "players.player_id": 1, "players.elo_delta": 1,
                                "players.mmr_track": 1}).sort("played_at", 1).to_list(10000)
    events = [(m["played_at"], 1, m) for m in ms] + \
             [(a["at"], 0, a) for a in await season_adjustments(season["id"], pid, counted_only=True)]
    mmr, out = BASE_MMR, []
    for at, kind, ev in sorted(events, key=lambda e: (e[0], e[1])):
        if kind == 0:
            mmr += ev["delta"]
            out.append({"match_id": None, "mmr": round(mmr, 2), "played_at": at,
                        "adjustment": ev["delta"], "reason": ev.get("reason", "")})
            continue
        my = next((x for x in ev["players"] if x["player_id"] == pid), None)
        if my and counts_for_mmr(my):
            mmr += my.get("elo_delta", 0)
        out.append({"match_id": ev["id"], "mmr": round(mmr, 2), "played_at": at})
    return out


@api_router.get("/stats/player/{pid}")
async def player_stats(pid: str, season_id: Optional[str] = None, format: Optional[str] = None):
    """A player's page. `format` (2v2 / 3v3) narrows the stats - matches, win rate, champions, roles,
    teammates, opponents, streak - but MMR and peak always cover every format (there's one MMR)."""
    fmt = format if format in ("2v2", "3v3") else None
    player = await db.players.find_one({"id": pid}, {"_id": 0})
    if not player:
        raise HTTPException(404, "Player not found")

    q = {"players.player_id": pid}
    q.update(await season_filter(season_id))
    matches = await db.matches.find(q, {"_id": 0, "players.stats": 0}).sort("played_at", -1).to_list(10000)

    # Compute all-time peak across every season (even if filtering current view by one season)
    all_seasons = await db.seasons.find({}, {"_id": 0}).to_list(1000)
    season_names = {s["id"]: s["name"] for s in all_seasons}
    peak_all_time = BASE_MMR
    peak_season_id = None
    for s in all_seasons:
        s_matches = await db.matches.find(
            {"season_id": s["id"], "players.player_id": pid}, {"_id": 0}
        ).sort("played_at", 1).to_list(10000)
        cur = BASE_MMR
        local_peak = BASE_MMR
        s_adjs = await season_adjustments(s["id"], pid, counted_only=True)
        events = [(sm["played_at"], 1, sm) for sm in s_matches] + [(a["at"], 0, a) for a in s_adjs]
        for _, kind, ev in sorted(events, key=lambda e: (e[0], e[1])):
            if kind == 0:
                cur += ev["delta"]
                local_peak = max(local_peak, cur)
                continue
            mp = next((p for p in ev["players"] if p["player_id"] == pid), None)
            if mp and counts_for_mmr(mp):
                cur += mp.get("elo_delta", 0)
                local_peak = max(local_peak, cur)
        if local_peak > peak_all_time:
            peak_all_time = local_peak
            peak_season_id = s["id"]

    champ_stats = {}  # champion -> wins/losses/matches
    role_stats = {"Melee": 0, "Ranged": 0, "Support": 0}
    role_wins = {"Melee": 0, "Ranged": 0, "Support": 0}
    teammates = {}
    opponents = {}
    total_wins = 0
    in_format = lambda m: not fmt or m.get("format") == fmt
    total_matches = sum(1 for m in matches if in_format(m))
    mmr = BASE_MMR
    peak = BASE_MMR
    mmr_history = []

    all_players = {p["id"]: p["name"] for p in await db.players.find({}, {"_id": 0}).to_list(1000)}

    # admin MMR adjustments, replayed in order with the matches
    aq = {"player_id": pid, "mmr_track": {"$exists": False}, **(await season_filter(season_id))}
    p_adjs = await db.mmr_adjustments.find(aq, {"_id": 0}).sort("at", 1).to_list(100000)
    ai = 0

    def apply_adjustments(until: Optional[str]):
        nonlocal ai, mmr, peak
        while ai < len(p_adjs) and (until is None or p_adjs[ai]["at"] <= until):
            a = p_adjs[ai]
            mmr += a["delta"]
            peak = max(peak, mmr)
            mmr_history.append({"match_id": None, "mmr": round(mmr, 2), "played_at": a["at"],
                                "adjustment": a["delta"], "reason": a.get("reason", "")})
            ai += 1

    # Iterate old->new for mmr history
    for m in reversed(matches):
        apply_adjustments(m["played_at"])
        my = next((p for p in m["players"] if p["player_id"] == pid), None)
        if not my:
            continue
        if not in_format(m):   # other format: counts for MMR only
            if counts_for_mmr(my):
                mmr += my.get("elo_delta", 0)
            peak = max(peak, mmr)
            continue
        won = (my["team"] == "A" and m["team_a_rounds"] > m["team_b_rounds"]) or \
              (my["team"] == "B" and m["team_b_rounds"] > m["team_a_rounds"])
        if won:
            total_wins += 1

        # Champion
        c = my["champion"]
        if c not in champ_stats:
            champ_stats[c] = {"champion": c, "role": my["role"], "matches": 0, "wins": 0}
        champ_stats[c]["matches"] += 1
        if won:
            champ_stats[c]["wins"] += 1

        # Role
        role_stats[my["role"]] += 1
        if won:
            role_wins[my["role"]] += 1

        # Teammates and opponents
        for p in m["players"]:
            if p["player_id"] == pid:
                continue
            name = all_players.get(p["player_id"], "Unknown")
            target = teammates if p["team"] == my["team"] else opponents
            if p["player_id"] not in target:
                target[p["player_id"]] = {"player_id": p["player_id"], "name": name, "matches": 0, "wins": 0}
            target[p["player_id"]]["matches"] += 1
            if won:
                target[p["player_id"]]["wins"] += 1

        if counts_for_mmr(my):
            mmr += my.get("elo_delta", 0)
        peak = max(peak, mmr)
        mmr_history.append({"match_id": m["id"], "mmr": round(mmr, 2), "played_at": m["played_at"]})
    apply_adjustments(None)

    fav_champs = sorted(champ_stats.values(), key=lambda x: -x["matches"])
    for c in fav_champs:
        c["winrate"] = round(c["wins"] / c["matches"] * 100, 1) if c["matches"] else 0

    def compute_rate(d):
        return round(d["wins"] / d["matches"] * 100, 1) if d["matches"] else 0

    teammate_list = list(teammates.values())
    for t in teammate_list:
        t["winrate"] = compute_rate(t)
    opponent_list = list(opponents.values())
    for o in opponent_list:
        o["winrate"] = compute_rate(o)

    traj = await trajectory_season(season_id)

    # Compute current streak from most recent matches backwards
    outcomes = []  # newest first
    for m in filter(in_format, matches):  # matches sorted DESC by played_at
        my = next((p for p in m["players"] if p["player_id"] == pid), None)
        if not my:
            continue
        won = (my["team"] == "A" and m["team_a_rounds"] > m["team_b_rounds"]) or \
              (my["team"] == "B" and m["team_b_rounds"] > m["team_a_rounds"])
        outcomes.append(won)
    streak = 0
    if outcomes:
        first = outcomes[0]
        for r in outcomes:
            if r == first:
                streak += 1
            else:
                break
        streak = streak if first else -streak

    return {
        "player": player,
        "total_matches": total_matches,
        "total_wins": total_wins,
        "total_losses": total_matches - total_wins,
        "winrate": round(total_wins / total_matches * 100, 1) if total_matches else 0,
        "mmr": round(mmr, 2),
        "peak_mmr": round(peak, 2),
        "peak_mmr_all_time": round(peak_all_time, 2),
        "peak_season_id": peak_season_id,
        "peak_season_name": season_names.get(peak_season_id) if peak_season_id else None,
        "streak": streak,
        "champions": fav_champs,
        "roles": [
            {"role": r, "matches": role_stats[r], "wins": role_wins[r],
             "winrate": round(role_wins[r] / role_stats[r] * 100, 1) if role_stats[r] else 0}
            for r in ["Melee", "Ranged", "Support"]
        ],
        "teammates": sorted(teammate_list, key=lambda x: -x["matches"]),
        "opponents": sorted(opponent_list, key=lambda x: -x["matches"]),
        # always one ranked season - "All" would run several seasons' MMR together
        "mmr_history": await mmr_trajectory(pid, traj),
        "mmr_history_season_name": traj["name"] if traj else None,
        "recent_matches": [m for m in matches if in_format(m)][:10],
        "format": fmt or "all",
    }


@api_router.get("/stats/matrix")
async def matrix(season_id: Optional[str] = None):
    """Player vs Player matrix. Returns pairs w/ head-to-head record (as opponents)."""
    players = await db.players.find({}, {"_id": 0}).to_list(1000)
    q = {}
    q.update(await season_filter(season_id))
    matches = await db.matches.find(q, {"_id": 0, "players.stats": 0}).to_list(10000)

    # matrix[a][b] = {matches, a_wins}
    m = {}
    for p in players:
        m[p["id"]] = {}
        for q_ in players:
            if p["id"] == q_["id"]:
                continue
            m[p["id"]][q_["id"]] = {"matches": 0, "wins": 0}

    for match in matches:
        team_a_ids = [p["player_id"] for p in match["players"] if p["team"] == "A"]
        team_b_ids = [p["player_id"] for p in match["players"] if p["team"] == "B"]
        a_won = match["team_a_rounds"] > match["team_b_rounds"]
        for aid in team_a_ids:
            for bid in team_b_ids:
                if aid in m and bid in m[aid]:
                    m[aid][bid]["matches"] += 1
                    if a_won:
                        m[aid][bid]["wins"] += 1
                if bid in m and aid in m[bid]:
                    m[bid][aid]["matches"] += 1
                    if not a_won:
                        m[bid][aid]["wins"] += 1

    return {"players": players, "matrix": m}


@api_router.get("/stats/champion-matrix")
async def champion_matrix(season_id: Optional[str] = None):
    """Champion vs Champion winrate when facing each other across teams."""
    q = {}
    q.update(await season_filter(season_id))
    matches = await db.matches.find(q, {"_id": 0, "players.stats": 0}).to_list(10000)

    # Start from the full roster so unplayed champions still appear
    roster = await db.champions.find({}, {"_id": 0}).to_list(1000)
    role_by_name = {c["name"]: c["role"] for c in roster}
    champions_used = set(role_by_name.keys())

    m = {}
    for match in matches:
        team_a = [p for p in match["players"] if p["team"] == "A"]
        team_b = [p for p in match["players"] if p["team"] == "B"]
        a_won = match["team_a_rounds"] > match["team_b_rounds"]
        for pa in team_a:
            for pb in team_b:
                ca, cb = pa["champion"], pb["champion"]
                champions_used.add(ca); champions_used.add(cb)
                m.setdefault(ca, {}).setdefault(cb, {"matches": 0, "wins": 0})
                m[ca][cb]["matches"] += 1
                if a_won:
                    m[ca][cb]["wins"] += 1
                m.setdefault(cb, {}).setdefault(ca, {"matches": 0, "wins": 0})
                m[cb][ca]["matches"] += 1
                if not a_won:
                    m[cb][ca]["wins"] += 1

    # Champion pick/win totals — seed with full roster so 0-pick champs are listed
    totals = {c["name"]: {"champion": c["name"], "role": c["role"], "picks": 0, "wins": 0} for c in roster}
    for match in matches:
        a_won = match["team_a_rounds"] > match["team_b_rounds"]
        for p in match["players"]:
            c = p["champion"]
            totals.setdefault(c, {"champion": c, "role": role_by_name.get(c, p["role"]), "picks": 0, "wins": 0})
            totals[c]["picks"] += 1
            won = (p["team"] == "A" and a_won) or (p["team"] == "B" and not a_won)
            if won:
                totals[c]["wins"] += 1

    for c in totals.values():
        c["winrate"] = round(c["wins"] / c["picks"] * 100, 1) if c["picks"] else 0

    return {
        "champions": sorted(list(champions_used)),
        "matrix": m,
        "totals": sorted(totals.values(), key=lambda x: (-x["picks"], x["champion"])),
    }


@api_router.get("/stats/recap")
async def recap(days: int = 7, season_id: Optional[str] = None):
    """Weekly recap: top climbers, biggest upsets, champion trends."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    q = {"played_at": {"$gte": cutoff}}
    q.update(await season_filter(season_id))
    matches = await db.matches.find(q, {"_id": 0, "players.stats": 0}).sort("played_at", 1).to_list(10000)

    all_players = {p["id"]: p["name"] for p in await db.players.find({}, {"_id": 0}).to_list(1000)}

    # Top climbers
    climbers = {}  # pid -> {name, delta, matches, wins}
    for m in matches:
        won_a = m["team_a_rounds"] > m["team_b_rounds"]
        for p in m["players"]:
            if p["player_id"] not in climbers:
                climbers[p["player_id"]] = {
                    "player_id": p["player_id"],
                    "name": all_players.get(p["player_id"], "Unknown"),
                    "delta": 0.0, "matches": 0, "wins": 0,
                }
            c = climbers[p["player_id"]]
            if counts_for_mmr(p):
                c["delta"] += p.get("elo_delta", 0)
            c["matches"] += 1
            won = (p["team"] == "A" and won_a) or (p["team"] == "B" and not won_a)
            if won:
                c["wins"] += 1
    for c in climbers.values():
        c["delta"] = round(c["delta"], 2)
        c["winrate"] = round(c["wins"] / c["matches"] * 100, 1) if c["matches"] else 0

    climbers_list = sorted(climbers.values(), key=lambda x: -x["delta"])

    # Biggest upsets: matches where team with lower mmr_before won by biggest round margin
    upsets = []
    for m in matches:
        mmr_a = m.get("team_a_mmr_before", BASE_MMR)
        mmr_b = m.get("team_b_mmr_before", BASE_MMR)
        won_a = m["team_a_rounds"] > m["team_b_rounds"]
        winner_mmr = mmr_a if won_a else mmr_b
        loser_mmr = mmr_b if won_a else mmr_a
        if winner_mmr >= loser_mmr:
            continue
        upset_delta = loser_mmr - winner_mmr
        round_margin = abs(m["team_a_rounds"] - m["team_b_rounds"])
        winner_players = [all_players.get(p["player_id"], "?") for p in m["players"] if (p["team"] == "A") == won_a]
        loser_players = [all_players.get(p["player_id"], "?") for p in m["players"] if (p["team"] == "A") != won_a]
        upsets.append({
            "match_id": m["id"],
            "played_at": m["played_at"],
            "format": m["format"],
            "score": f"{m['team_a_rounds']}-{m['team_b_rounds']}",
            "winners": winner_players,
            "losers": loser_players,
            "mmr_gap": round(upset_delta, 2),
            "round_margin": round_margin,
            "upset_score": round(upset_delta + round_margin * 20, 2),
        })
    upsets.sort(key=lambda x: -x["upset_score"])

    # Champion trends
    champ_trend = {}
    for m in matches:
        won_a = m["team_a_rounds"] > m["team_b_rounds"]
        for p in m["players"]:
            c = p["champion"]
            if c not in champ_trend:
                champ_trend[c] = {"champion": c, "role": p["role"], "picks": 0, "wins": 0}
            champ_trend[c]["picks"] += 1
            won = (p["team"] == "A" and won_a) or (p["team"] == "B" and not won_a)
            if won:
                champ_trend[c]["wins"] += 1
    for c in champ_trend.values():
        c["winrate"] = round(c["wins"] / c["picks"] * 100, 1) if c["picks"] else 0

    trending = sorted(champ_trend.values(), key=lambda x: (-x["picks"], -x["winrate"]))

    # Rivalries: head-to-head records between pairs of players who faced each other
    rivalries_agg = {}  # frozenset({pid_a, pid_b}) -> {matches, wins_by_pid}
    for m in matches:
        team_a_ids = [p["player_id"] for p in m["players"] if p["team"] == "A"]
        team_b_ids = [p["player_id"] for p in m["players"] if p["team"] == "B"]
        won_a = m["team_a_rounds"] > m["team_b_rounds"]
        for aid in team_a_ids:
            for bid in team_b_ids:
                key = frozenset((aid, bid))
                if key not in rivalries_agg:
                    rivalries_agg[key] = {"ids": (aid, bid), "matches": 0, "wins": {aid: 0, bid: 0}}
                r = rivalries_agg[key]
                r["matches"] += 1
                winner = aid if won_a else bid
                r["wins"][winner] = r["wins"].get(winner, 0) + 1

    rivalries = []
    for key, r in rivalries_agg.items():
        if r["matches"] < 2:
            continue  # a rivalry needs at least two meetings
        pid_a, pid_b = r["ids"]
        a_wins = r["wins"].get(pid_a, 0)
        b_wins = r["wins"].get(pid_b, 0)
        total = r["matches"]
        wr_a = a_wins / total if total else 0.5
        # Heat score: more matches + closer to 50/50 split => hotter rivalry
        closeness = 1.0 - abs(0.5 - wr_a) * 2  # 0..1 (1 at perfectly even)
        heat = total * (0.5 + closeness / 2)
        rivalries.append({
            "player_a_id": pid_a,
            "player_a_name": all_players.get(pid_a, "Unknown"),
            "player_b_id": pid_b,
            "player_b_name": all_players.get(pid_b, "Unknown"),
            "matches": total,
            "a_wins": a_wins,
            "b_wins": b_wins,
            "a_winrate": round(wr_a * 100, 1),
            "heat_score": round(heat, 2),
        })
    rivalries.sort(key=lambda x: (-x["heat_score"], -x["matches"]))

    return {
        "period_days": days,
        "total_matches": len(matches),
        "top_climbers": climbers_list[:10],
        "biggest_upsets": upsets[:5],
        "champion_trends": trending[:12],
        "rivalries": rivalries[:5],
    }


@api_router.get("/stats/champion/{name}")
async def champion_stats(name: str, season_id: Optional[str] = None):
    """Champion profile: winrates, which players piloted them, teammates & opponents."""
    champ = await db.champions.find_one({"name": name}, {"_id": 0})
    if not champ:
        raise HTTPException(404, "Champion not found")

    q = {"players.champion": name}
    q.update(await season_filter(season_id))
    matches = await db.matches.find(q, {"_id": 0}).sort("played_at", -1).to_list(10000)

    all_players = {p["id"]: p["name"] for p in await db.players.find({}, {"_id": 0}).to_list(1000)}
    role_by_name = {c["name"]: c["role"] for c in await db.champions.find({}, {"_id": 0}).to_list(1000)}

    total_picks = 0
    total_wins = 0
    players_agg = {}       # player_id -> {name, matches, wins}
    teammates_agg = {}     # champion -> {matches, wins}
    opponents_agg = {}     # champion -> {matches, wins}
    role_wins = 0
    pick_history = []      # (played_at, winner_bool)

    for m in matches:
        won_a = m["team_a_rounds"] > m["team_b_rounds"]
        for p in m["players"]:
            if p["champion"] != name:
                continue
            total_picks += 1
            won = (p["team"] == "A" and won_a) or (p["team"] == "B" and not won_a)
            if won:
                total_wins += 1
                role_wins += 1

            # per-player breakdown
            pid = p["player_id"]
            if pid not in players_agg:
                players_agg[pid] = {
                    "player_id": pid,
                    "name": all_players.get(pid, "Unknown"),
                    "matches": 0, "wins": 0,
                }
            players_agg[pid]["matches"] += 1
            if won:
                players_agg[pid]["wins"] += 1

            # teammate & opponent champion aggregation
            for other in m["players"]:
                if other["player_id"] == pid and other["champion"] == name:
                    continue
                target = teammates_agg if other["team"] == p["team"] else opponents_agg
                oc = other["champion"]
                if oc not in target:
                    target[oc] = {
                        "champion": oc,
                        "role": role_by_name.get(oc, other.get("role", "")),
                        "matches": 0, "wins": 0,
                    }
                target[oc]["matches"] += 1
                if won:
                    target[oc]["wins"] += 1

            pick_history.append({"played_at": m["played_at"], "won": won, "match_id": m["id"]})

    def _finalize(d):
        d["winrate"] = round(d["wins"] / d["matches"] * 100, 1) if d["matches"] else 0
        return d

    players_list = sorted((_finalize(v) for v in players_agg.values()), key=lambda x: -x["matches"])
    teammates_list = sorted((_finalize(v) for v in teammates_agg.values()), key=lambda x: -x["matches"])
    opponents_list = sorted((_finalize(v) for v in opponents_agg.values()), key=lambda x: -x["matches"])

    return {
        "champion": champ["name"],
        "role": champ["role"],
        "total_picks": total_picks,
        "total_wins": total_wins,
        "total_losses": total_picks - total_wins,
        "winrate": round(total_wins / total_picks * 100, 1) if total_picks else 0,
        "players": players_list,
        "teammate_champions": teammates_list,
        "opponent_champions": opponents_list,
        "recent_matches": matches[:10],
        "matches": matches,   # every match this champion played (newest first) - the champion page lists them
    }


# --------- Matchmaking ---------
class MatchmakingRequest(BaseModel):
    player_ids: List[str]
    format: Literal["2v2", "3v3"]
    mode: Literal["mmr", "synergy", "hybrid"] = "hybrid"
    season_id: Optional[str] = None
    # teams (lists of player ids) not to repeat - e.g. the same players' previous match. The best split
    # without any of them is used; only if every split repeats one is the best overall used.
    avoid_teams: Optional[List[List[str]]] = None
    # avoid the teams from each player's recent games in this format (REPEAT_DEPTH games back)
    avoid_repeats: bool = False

REPEAT_DEPTH = {"2v2": 1, "3v3": 2}   # how many of each player's recent games to avoid repeating


def _when(v) -> datetime:
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


async def recent_teams(player_ids: List[str], fmt: str) -> List[List[str]]:
    """Teams from each of these players' last REPEAT_DEPTH games in this format that could happen
    again with this line-up. Games are logged matches, plus (with the bot) matches launched from a
    lobby that haven't been logged yet."""
    depth, ids = REPEAT_DEPTH.get(fmt, 1), set(player_ids)
    cap = depth * len(ids) * 2 + 10
    games, codes = [], set()
    async for m in db.matches.find({"format": fmt, "players.player_id": {"$in": list(ids)}},
                                   {"_id": 0, "played_at": 1, "discord_match_id": 1, "players.player_id": 1, "players.team": 1}
                                   ).sort("played_at", -1).limit(cap):
        games.append((_when(m.get("played_at")), [[p["player_id"] for p in m["players"] if p["team"] == t] for t in "AB"]))
        codes.add(m.get("discord_match_id"))
    async for l in db.lineups.find({"format": fmt, "players": {"$in": list(ids)}}, {"_id": 0}).sort("at", -1).limit(cap):
        if l.get("code") not in codes:   # launched, not logged yet
            games.append((_when(l.get("at")), [l["team_a"], l["team_b"]]))
    games.sort(key=lambda g: g[0], reverse=True)
    seen, avoid = dict.fromkeys(ids, 0), []
    for _, teams in games:
        involved = [pid for pid in ids if any(pid in t for t in teams)]
        if not any(seen[pid] < depth for pid in involved):
            continue   # already past this game for everyone in it
        for pid in involved:
            seen[pid] += 1
        for t in teams:
            if t and set(t) <= ids and sorted(t) not in avoid:
                avoid.append(sorted(t))
        if all(v >= depth for v in seen.values()):
            break
    return avoid

# --------- Team balancing: role part ---------
# BALANCE_ROLE_MODEL: "role_mmr" (default) - each player's hidden role MMR (general MMR plus how much
# better/worse they do in that role than usual) decides the teams' best role line-ups; "spread" - the
# old check of how varied the teams' most-played roles are.
BALANCE_ROLE_MODEL = (os.environ.get("BALANCE_ROLE_MODEL") or "role_mmr").strip().lower()
def _num_env(name, default, lo, hi):
    try:
        return min(hi, max(lo, float(os.environ.get(name) or default)))
    except ValueError:
        return default
HYBRID_MMR_WEIGHT = _num_env("HYBRID_MMR_WEIGHT", 0.8, 0.0, 1.0)     # Hybrid: general MMR share (old: 0.6)
SUPPORT_WEIGHT_2V2 = _num_env("SUPPORT_WEIGHT_2V2", 0.6, 0.0, 1.0)   # 2v2: the support's share of a line-up
ROLE_PRIOR_GAMES = 15    # a role offset counts games/(games+15) - few games stay close to general MMR
ROLE_OFFSET_CAP = 150
# A role the player has rarely or never played starts this much below their MMR, fading out as they play
# it (none once it's ROLE_MAIN_SHARE of their games) and as their games in it show how they really do.
UNPROVEN_ROLE_PENALTY = _num_env("UNPROVEN_ROLE_PENALTY", 50, 0, 150)
ROLE_MAIN_SHARE = 0.3
ROLE_POINT_MMR = 1600 / math.log(10) / K_FACTOR   # 1 MMR point/game better than usual ~ this much MMR
ROLES = ("Melee", "Ranged", "Support")


async def role_offsets(pid: str) -> dict:
    """How much better (+) or worse (-) a player does in each role than their own usual, in MMR.
    From the MMR changes of their ranked games in every season (role = the champion played)."""
    ranked_ids = {x["id"] for x in await db.seasons.find({"ranked": {"$ne": False}}, {"_id": 0, "id": 1}).to_list(1000)}
    by_role = {r: [] for r in ROLES}
    async for m in db.matches.find({"players.player_id": pid, "season_id": {"$in": list(ranked_ids)}},
                                   {"_id": 0, "players": 1}):
        for mp in m["players"]:
            if mp["player_id"] == pid and counts_for_mmr(mp) and mp.get("elo_delta") is not None:
                r = mp.get("role") or CHAMPION_ROLES.get(mp.get("champion"))
                if r in by_role:
                    by_role[r].append(mp["elo_delta"])
    every = [d for ds in by_role.values() for d in ds]
    if not every:
        return {r: 0.0 for r in ROLES}   # no ranked games yet: nothing known about any role
    usual = sum(every) / len(every)
    out = {}
    for r, ds in by_role.items():
        # unproven roles: assumed worse, less so the more of their games are in it
        prior = -UNPROVEN_ROLE_PENALTY * (1 - min(1.0, len(ds) / len(every) / ROLE_MAIN_SHARE))
        raw = (sum(ds) / len(ds) - usual) * ROLE_POINT_MMR if ds else 0.0
        trust = len(ds) / (len(ds) + ROLE_PRIOR_GAMES)
        out[r] = max(-ROLE_OFFSET_CAP, min(ROLE_OFFSET_CAP, raw * trust + prior * (1 - trust)))
    return out


def best_lineup(team: List[dict]) -> tuple:
    """(strength, {player id: role}) of a team's best role line-up, from hidden role MMR.
    3v3: one Melee, one Ranged, one Support. 2v2: a Support + a damage dealer (Melee or Ranged),
    the support counting SUPPORT_WEIGHT_2V2."""
    rm = lambda p, r: p["mmr"] + p["role_offsets"].get(r, 0.0)
    if len(team) == 3:
        best = None
        for roles in permutations(ROLES):
            v = sum(rm(p, r) for p, r in zip(team, roles)) / 3
            if best is None or v > best[0]:
                best = (v, {p["id"]: r for p, r in zip(team, roles)})
        return best
    if len(team) == 2:
        best = None
        for sup, dmg in ((team[0], team[1]), (team[1], team[0])):
            dr = max(("Melee", "Ranged"), key=lambda r: rm(dmg, r))
            v = SUPPORT_WEIGHT_2V2 * rm(sup, "Support") + (1 - SUPPORT_WEIGHT_2V2) * rm(dmg, dr)
            if best is None or v > best[0]:
                best = (v, {sup["id"]: "Support", dmg["id"]: dr})
        return best
    return (sum(p["mmr"] for p in team) / len(team), {})


def role_fit_score(str_a: float, str_b: float, gen_a: float, gen_b: float) -> float:
    """0-100: half for the two line-ups being equally strong, half for both teams being able to put
    players on roles they're good at (line-up strength above the team's general MMR)."""
    fair = max(0.0, 100.0 - abs(str_a - str_b) / 4.0)
    skilled = max(0.0, min(100.0, 50.0 + ((str_a - gen_a) + (str_b - gen_b)) / 2.0 / 2.0))
    return 0.5 * fair + 0.5 * skilled


def role_synergy_score(roles: List[str]) -> float:
    """Higher is better. Reward role coverage."""
    unique = len(set(roles))
    total = len(roles)
    # Reward diversity; penalize dupes
    return (unique / total) * 100


@api_router.post("/matchmaking/balance")
async def matchmaking(data: MatchmakingRequest):
    team_size = {"2v2": 2, "3v3": 3}[data.format]
    if len(data.player_ids) != team_size * 2:
        raise HTTPException(400, f"Need exactly {team_size * 2} players for {data.format}")

    season_id = data.season_id
    if not season_id:
        s = await get_active_ranked_season()
        if s:
            season_id = s["id"]

    # Get player details + MMR
    players = {}
    for pid in data.player_ids:
        p = await db.players.find_one({"id": pid}, {"_id": 0, "discord_id": 0})
        if not p:
            raise HTTPException(404, f"Player {pid} not found")
        p["mmr"] = await get_player_mmr(pid, season_id) if season_id else BASE_MMR
        # Determine dominant role from stats
        matches = await db.matches.find({"players.player_id": pid}, {"_id": 0}).to_list(1000)
        role_counts = {"Melee": 0, "Ranged": 0, "Support": 0}
        for m in matches:
            for mp in m["players"]:
                if mp["player_id"] == pid:
                    role_counts[mp["role"]] = role_counts.get(mp["role"], 0) + 1
        p["preferred_role"] = max(role_counts, key=role_counts.get) if any(role_counts.values()) else "Melee"
        if BALANCE_ROLE_MODEL != "spread":
            p["role_offsets"] = await role_offsets(pid)   # hidden: removed before replying
        players[pid] = p

    ids = list(players.keys())
    best = None
    best_fresh = None   # best split that doesn't repeat an avoided team
    avoid = {frozenset(t) for t in (data.avoid_teams or []) if t}
    if data.avoid_repeats:
        avoid |= {frozenset(t) for t in await recent_teams(data.player_ids, data.format)}

    for combo in combinations(ids, team_size):
        team_a = list(combo)
        team_b = [i for i in ids if i not in combo]
        # Avoid duplicate splits
        if sorted(team_a) > sorted(team_b):
            continue
        mmr_a = sum(players[i]["mmr"] for i in team_a) / team_size
        mmr_b = sum(players[i]["mmr"] for i in team_b) / team_size
        mmr_diff = abs(mmr_a - mmr_b)
        mmr_score = max(0.0, 100.0 - mmr_diff / 4.0)  # 400 diff => 0

        roles_of = {}
        if BALANCE_ROLE_MODEL == "spread":
            syn_a = role_synergy_score([players[i]["preferred_role"] for i in team_a])
            syn_b = role_synergy_score([players[i]["preferred_role"] for i in team_b])
            syn_score = (syn_a + syn_b) / 2
        else:   # role MMR: each team's best line-up
            str_a, ra = best_lineup([players[i] for i in team_a])
            str_b, rb = best_lineup([players[i] for i in team_b])
            roles_of = {**ra, **rb}
            syn_score = role_fit_score(str_a, str_b, mmr_a, mmr_b)
            # per team: how well its players' roles suit them (shown as the team's synergy)
            syn_a = max(0.0, min(100.0, 50.0 + (str_a - mmr_a) / 2.0))
            syn_b = max(0.0, min(100.0, 50.0 + (str_b - mmr_b) / 2.0))

        if data.mode == "mmr":
            total = mmr_score
        elif data.mode == "synergy":
            total = syn_score
        else:
            total = HYBRID_MMR_WEIGHT * mmr_score + (1 - HYBRID_MMR_WEIGHT) * syn_score

        def shown(i):   # role MMR stays hidden; with role MMR the suggested role is shown instead
            p = {k: v for k, v in players[i].items() if k != "role_offsets"}
            if i in roles_of:
                p["preferred_role"] = roles_of[i]
            return p

        entry = {
            "team_a": [shown(i) for i in team_a],
            "team_b": [shown(i) for i in team_b],
            "team_a_mmr": round(mmr_a, 2),
            "team_b_mmr": round(mmr_b, 2),
            "mmr_diff": round(mmr_diff, 2),
            "team_a_synergy": round(syn_a, 1),
            "team_b_synergy": round(syn_b, 1),
            "balance_score": round(total, 2),
            "role_model": BALANCE_ROLE_MODEL if BALANCE_ROLE_MODEL == "spread" else "role_mmr",
            "win_probability_a": round(expected_score(mmr_a, mmr_b) * 100, 1),
        }
        if best is None or entry["balance_score"] > best["balance_score"]:
            best = entry
        repeats = frozenset(team_a) in avoid or frozenset(team_b) in avoid
        if not repeats and (best_fresh is None or entry["balance_score"] > best_fresh["balance_score"]):
            best_fresh = entry

    if avoid:
        chosen = best_fresh or best
        chosen["avoided_repeat"] = best_fresh is not None and best_fresh is not best
        chosen["recent_teams_avoided"] = len(avoid)
        chosen["all_splits_repeat"] = best_fresh is None
        return chosen
    return best


# --------- Tournament team balancer (admins) ---------
# Splits any number of players into teams of 2 or 3 whose strengths are as close as possible, using the
# same strength as matchmaking (MMR, plus each team's best role line-up). Small groups are searched
# completely; bigger ones start from a snake draft (and random starts) and keep swapping players
# between teams while that narrows the gap. Pairs can be kept apart or together.
class TournamentRequest(BaseModel):
    player_ids: List[str]
    format: Literal["2v2", "3v3"] = "3v3"
    mode: Literal["hybrid", "mmr", "synergy"] = "hybrid"
    season_id: Optional[str] = None
    apart: List[List[str]] = []      # pairs that must be on different teams
    together: List[List[str]] = []   # pairs that must be on the same team
    subs: List[str] = []             # players chosen to sit out (else picked when the numbers don't divide)
    mmr_overrides: Dict[str, float] = {}   # player id -> MMR to use here instead of theirs (tournament only)


TOURNAMENT_MAX_PLAYERS = 60
EXACT_SPLITS_MAX = 60000   # up to this many possible splits, every one is checked


def _team_strength(team: List[dict], mode: str) -> tuple:
    """(strength in MMR, average MMR, {player id: role}) - as in matchmaking."""
    avg = sum(p["mmr"] for p in team) / len(team)
    if BALANCE_ROLE_MODEL == "spread" or mode == "mmr":
        return avg, avg, {}
    line, roles = best_lineup(team)
    if mode == "synergy":
        return line, avg, roles
    return HYBRID_MMR_WEIGHT * avg + (1 - HYBRID_MMR_WEIGHT) * line, avg, roles


def _balance_tournament(players: Dict[str, dict], size: int, n_subs: int, fixed_subs: List[str], mode: str,
                        apart: List[tuple], together: List[tuple], restarts: int = 40) -> list:
    """Best few splits found: [(score, [[ids] per team], [sub ids])]. Lower score = more even."""
    import random
    ids = [i for i in players if i not in fixed_subs]
    k = (len(ids) - n_subs) // size
    rng = random.Random(7)   # same players, same answer
    cache = {}

    def strength(team):
        key = frozenset(team)
        if key not in cache:
            cache[key] = _team_strength([players[i] for i in team], mode)[0]
        return cache[key]

    def score(buckets):
        teams, bench = buckets[:k], buckets[k] if n_subs else []
        where = {i: t for t, team in enumerate(teams) for i in team}
        for i in bench:
            where[i] = -1
        broken = sum(where[a] == where[b] and where[a] != -1 for a, b in apart) + \
                 sum(where[a] != where[b] for a, b in together)
        st = [strength(t) for t in teams]
        mean = sum(st) / k
        return (broken, round(max(st) - min(st), 3), round(sum((x - mean) ** 2 for x in st), 3))

    def snake(order):
        buckets = [[] for _ in range(k)] + ([[]] if n_subs else [])
        for n, i in enumerate(order):
            if n >= k * size:
                buckets[k].append(i)   # weakest left over sit out to begin with; swaps can change that
                continue
            rnd, pos = divmod(n, k)
            buckets[pos if rnd % 2 == 0 else k - 1 - pos].append(i)
        return buckets

    def improve(buckets):
        cur = score(buckets)
        better = True
        while better:
            better = False
            for a in range(len(buckets)):
                for b in range(a + 1, len(buckets)):
                    for x in range(len(buckets[a])):
                        for y in range(len(buckets[b])):
                            buckets[a][x], buckets[b][y] = buckets[b][y], buckets[a][x]
                            new = score(buckets)
                            if new < cur:
                                cur, better = new, True
                            else:
                                buckets[a][x], buckets[b][y] = buckets[b][y], buckets[a][x]
        return cur, buckets

    found = {}
    # small enough: try every split (the search below can stop at a good-but-not-best one)
    from math import comb, factorial
    total = factorial(len(ids) - n_subs) // (factorial(size) ** k * factorial(k)) * comb(len(ids), n_subs)
    if total <= EXACT_SPLITS_MAX:
        def parts(rest):
            if not rest:
                yield []
                return
            first = rest[0]
            for mates in combinations(rest[1:], size - 1):
                team = [first, *mates]
                left = [i for i in rest if i not in team]
                for more in parts(left):
                    yield [team] + more
        for bench in combinations(ids, n_subs):
            rest = [i for i in ids if i not in bench]
            for teams in parts(rest):
                buckets = teams + ([list(bench)] if n_subs else [])
                key = (frozenset(frozenset(t) for t in teams), frozenset(bench))
                found[key] = (score(buckets), [list(t) for t in teams], list(bench))
        return sorted(found.values(), key=lambda f: f[0])[:3]
    by_mmr = sorted(ids, key=lambda i: -players[i]["mmr"])
    starts = [by_mmr] + [rng.sample(ids, len(ids)) for _ in range(restarts)]
    for order in starts:
        sc, buckets = improve(snake(order))
        key = (frozenset(frozenset(t) for t in buckets[:k]), frozenset(buckets[k]) if n_subs else frozenset())
        found[key] = (sc, [list(t) for t in buckets[:k]], list(buckets[k]) if n_subs else [])
    best = sorted(found.values(), key=lambda f: f[0])
    if len(best) < 3:   # every start ended the same: offer the best one-swap changes as alternatives
        top = best[0][1] + ([best[0][2]] if n_subs else [])
        for a in range(len(top)):
            for b in range(a + 1, len(top)):
                for x in range(len(top[a])):
                    for y in range(len(top[b])):
                        alt = [list(t) for t in top]
                        alt[a][x], alt[b][y] = alt[b][y], alt[a][x]
                        key = (frozenset(frozenset(t) for t in alt[:k]), frozenset(alt[k]) if n_subs else frozenset())
                        if key not in found:
                            found[key] = (score(alt), alt[:k], alt[k] if n_subs else [])
        best = sorted(found.values(), key=lambda f: f[0])
    return [x for x in best if x[0][0] <= best[0][0][0]][:3]   # no alternative that breaks more rules


@api_router.post("/tournament/balance")
async def tournament_balance(data: TournamentRequest, user: dict = Depends(admin_required)):
    size = {"2v2": 2, "3v3": 3}[data.format]
    ids = list(dict.fromkeys(data.player_ids))
    if len(ids) > TOURNAMENT_MAX_PLAYERS:
        raise HTTPException(400, f"At most {TOURNAMENT_MAX_PLAYERS} players")
    subs = [i for i in dict.fromkeys(data.subs) if i in ids]
    playing = len(ids) - len(subs)
    if playing < size * 2:
        raise HTTPException(400, f"Need at least {size * 2} players (not counting subs) for {data.format}")
    n_subs = playing % size   # still to pick
    pairs = lambda xs: [(a, b) for a, b in (tuple(x[:2]) for x in xs if len(x) >= 2) if a != b and a in ids and b in ids]
    apart, together = pairs(data.apart), pairs(data.together)
    # together groups must fit in a team, and can't contain a pair that's kept apart
    groups = {i: {i} for i in ids}
    for a, b in together:
        merged = groups[a] | groups[b]
        for i in merged:
            groups[i] = merged
    for g in {frozenset(g) for g in groups.values()}:
        if len(g) > size:
            raise HTTPException(400, f"{len(g)} players are linked together, but a team only has {size}")
        if any(a in g and b in g for a, b in apart):
            raise HTTPException(400, "Two players are both kept together and kept apart")
        if g & set(subs) and not g <= set(subs):
            raise HTTPException(400, "A sub is linked to a player who's playing")

    season_id = data.season_id or ((await get_active_ranked_season()) or {}).get("id")
    players = {}
    for pid in ids:
        p = await db.players.find_one({"id": pid}, {"_id": 0, "id": 1, "name": 1})
        if not p:
            raise HTTPException(404, f"Player {pid} not found")
        p["mmr"] = await get_player_mmr(pid, season_id) if season_id else BASE_MMR
        p["season_mmr"] = p["mmr"]
        if pid in data.mmr_overrides:
            v = data.mmr_overrides[pid]
            if not 0 <= v <= 4000:
                raise HTTPException(400, f"{p['name']}'s MMR must be between 0 and 4000")
            p["mmr"] = float(v)   # role adjustments still apply on top
        if BALANCE_ROLE_MODEL != "spread" and data.mode != "mmr":
            p["role_offsets"] = await role_offsets(pid)   # hidden: not sent back
        players[pid] = p

    results = await asyncio.get_running_loop().run_in_executor(
        None, _balance_tournament, players, size, n_subs, subs, data.mode, apart, together)

    def show(split):
        sc, teams, picked_subs = split
        out = []
        for t in teams:
            team = [players[i] for i in t]
            strength, avg, roles = _team_strength(team, data.mode)
            out.append({"strength": round(strength, 1), "avg_mmr": round(avg, 1),
                        "players": [{"id": p["id"], "name": p["name"], "mmr": round(p["mmr"]),
                                     "season_mmr": round(p["season_mmr"]), "overridden": p["id"] in data.mmr_overrides,
                                     "role": roles.get(p["id"])} for p in sorted(team, key=lambda p: -p["mmr"])]})
        out.sort(key=lambda t: -t["strength"])   # seed 1 first
        for n, t in enumerate(out, 1):
            t["seed"] = n
        sub_list = [{"id": i, "name": players[i]["name"], "mmr": round(players[i]["mmr"]), "chosen": i in subs,
                     "overridden": i in data.mmr_overrides}
                    for i in subs + picked_subs]
        return {"teams": out, "subs": sub_list, "spread": sc[1], "rules_broken": sc[0]}

    return {"options": [show(r) for r in results], "format": data.format, "mode": data.mode,
            "role_model": "spread" if BALANCE_ROLE_MODEL == "spread" else "role_mmr"}


# =====================================================================
# Discord bot integration: account linking + pending matches
# =====================================================================
CHAMPION_ROLES = {c["name"]: c["role"] for c in CHAMPIONS}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _find_player_by_name(name: str) -> Optional[dict]:
    pattern = f"^{re.escape(name.strip())}$"
    return await db.players.find_one({"name": {"$regex": pattern, "$options": "i"}}, {"_id": 0})


# --------- Discord account links ---------
class LinkRequestCreate(BaseModel):
    discord_id: str
    discord_name: str
    player_name: str

class LinkDecision(BaseModel):
    approve: bool
    decided_by: Optional[str] = None

class DiscordLinkInput(BaseModel):
    discord_id: Optional[str] = None   # None / "" = unlink
    discord_name: Optional[str] = None
    move: bool = False                 # admin: take the link from whichever player has it now


async def _check_link_conflicts(discord_id: str, player: dict):
    if player.get("discord_id") and player["discord_id"] != discord_id:
        raise HTTPException(409, f"{player['name']} is already linked to another Discord account")
    other = await db.players.find_one({"discord_id": discord_id, "id": {"$ne": player["id"]}}, {"_id": 0})
    if other:
        raise HTTPException(409, f"This Discord account is already linked to {other['name']}")


@api_router.get("/players/linked-discord")
async def linked_discord_accounts(user: dict = Depends(admin_or_bot)):
    """Discord ids of every linked player (for the bot's linked-player role)."""
    docs = await db.players.find({"discord_id": {"$nin": [None, ""]}}, {"_id": 0, "id": 1, "name": 1, "discord_id": 1}).to_list(10000)
    return [{"player_id": d["id"], "name": d["name"], "discord_id": str(d["discord_id"])} for d in docs]


@api_router.get("/players/by-discord/{discord_id}")
async def player_by_discord(discord_id: str, user: dict = Depends(admin_or_bot)):
    p = await db.players.find_one({"discord_id": discord_id}, {"_id": 0})
    if not p:
        raise HTTPException(404, "No player linked to this Discord account")
    return p


@api_router.put("/players/{pid}/discord")
async def set_player_discord(pid: str, data: DiscordLinkInput, user: dict = Depends(admin_or_bot)):
    player = await db.players.find_one({"id": pid}, {"_id": 0})
    if not player:
        raise HTTPException(404, "Player not found")
    if not data.discord_id:
        await db.players.update_one({"id": pid}, {"$unset": {"discord_id": "", "discord_name": ""}})
    else:
        did = data.discord_id.strip()
        if not did.isdigit():
            raise HTTPException(400, "A Discord user ID is a long number (right-click the user > Copy User ID)")
        other = await db.players.find_one({"discord_id": did, "id": {"$ne": pid}}, {"_id": 0})
        if other:
            if not (data.move and user.get("role") == "admin"):
                raise HTTPException(409, f"This Discord account is already linked to {other['name']}")
            await db.players.update_one({"id": other["id"]}, {"$unset": {"discord_id": "", "discord_name": ""}})
        name = data.discord_name
        if not name:  # fill in a name we already know for this account
            known = await db.users.find_one({"discord_id": did}) or await db.link_requests.find_one({"discord_id": did}) or {}
            name = known.get("discord_name") or ""
        await db.players.update_one({"id": pid}, {"$set": {"discord_id": did, "discord_name": name}})
        # any open request from this account is settled by the direct link
        await db.link_requests.update_many({"discord_id": did, "status": "pending"}, {"$set": {
            "status": "superseded", "decided_by": user.get("name") or "admin", "decided_at": _now_iso()}})
    return await db.players.find_one({"id": pid}, {"_id": 0})


class PlayerUpdate(BaseModel):
    name: Optional[str] = None
    ign: Optional[str] = None   # "" clears it


@api_router.patch("/players/{pid}")
async def update_player(pid: str, data: PlayerUpdate, user: dict = Depends(admin_required)):
    player = await db.players.find_one({"id": pid}, {"_id": 0})
    if not player:
        raise HTTPException(404, "Player not found")
    upd, unset = {}, {}
    if data.name is not None:
        name = " ".join(data.name.split())
        if not 1 <= len(name) <= 30:
            raise HTTPException(400, "Player names must be 1-30 characters")
        clash = await _find_player_by_name(name)
        if clash and clash["id"] != pid:
            raise HTTPException(409, f"There's already a player called {clash['name']}")
        upd["name"] = name
    if data.ign is not None:
        if data.ign.strip():
            upd["ign"] = data.ign.strip()
        else:
            unset["ign"] = ""
    if upd or unset:
        await db.players.update_one({"id": pid}, {k: v for k, v in (("$set", upd), ("$unset", unset)) if v})
    return await db.players.find_one({"id": pid}, {"_id": 0})



# --------- Merge players ---------
class MergePlayersInput(BaseModel):
    source_id: str          # the duplicate - removed after the merge
    target_id: str          # the player that stays
    dry_run: bool = False   # preview only


@api_router.post("/admin/players/merge")
async def merge_players(data: MergePlayersInput, user: dict = Depends(admin_required)):
    """Move every match from source to target. All match/champion stats combine.
    MMR: in each ranked season, the identity that played most recently keeps its
    rating; the other identity's games stay in history on a separate rating track."""
    if data.source_id == data.target_id:
        raise HTTPException(400, "Pick two different players")
    src = await db.players.find_one({"id": data.source_id}, {"_id": 0})
    tgt = await db.players.find_one({"id": data.target_id}, {"_id": 0})
    if not src or not tgt:
        raise HTTPException(404, "Player not found")
    both = await db.matches.count_documents({"$and": [{"players.player_id": src["id"]},
                                                      {"players.player_id": tgt["id"]}]})
    if both:
        raise HTTPException(409, f"{src['name']} and {tgt['name']} played in the same match {both} time(s), "
                                 f"so they can't be the same person. Fix those matches first.")
    seasons = {s["id"]: s for s in await db.seasons.find({}, {"_id": 0}).to_list(1000)}
    src_matches = await db.matches.find({"players.player_id": src["id"]}, {"_id": 0}).to_list(100000)
    tgt_matches = await db.matches.find({"players.player_id": tgt["id"]}, {"_id": 0}).to_list(100000)

    def last_main(matches, pid):
        out = {}
        for m in matches:
            mp = next(p for p in m["players"] if p["player_id"] == pid)
            if counts_for_mmr(mp) and m["played_at"] > out.get(m["season_id"], ""):
                out[m["season_id"]] = m["played_at"]
        return out

    src_last, tgt_last = last_main(src_matches, src["id"]), last_main(tgt_matches, tgt["id"])
    plan = []        # per ranked season: whose MMR is kept
    retire_src, retire_tgt = set(), set()
    for sid in sorted(set(src_last) | set(tgt_last)):
        season = seasons.get(sid)
        if not is_ranked_season(season):
            continue
        keep = "source" if src_last.get(sid, "") > tgt_last.get(sid, "") else "target"
        if src_last.get(sid) and tgt_last.get(sid):
            (retire_tgt if keep == "source" else retire_src).add(sid)
        plan.append({"season_id": sid, "season": (season or {}).get("name", "?"),
                     "mmr_kept_from": src["name"] if keep == "source" else tgt["name"],
                     "source_last_played": src_last.get(sid), "target_last_played": tgt_last.get(sid)})
    summary = {"source": src["name"], "target": tgt["name"], "source_matches": len(src_matches),
               "target_matches": len(tgt_matches), "seasons": plan,
               "discord": ("kept " + tgt["name"] + "'s link" if tgt.get("discord_id")
                           else (f"moves {src['name']}'s link" if src.get("discord_id") else "none"))}
    if data.dry_run:
        return {"dry_run": True, **summary}

    for m in src_matches + tgt_matches:
        new_players = []
        for p in m["players"]:
            if p["player_id"] == src["id"]:
                p = {**p, "player_id": tgt["id"]}
                if m["season_id"] in retire_src and counts_for_mmr(p):
                    p["mmr_track"] = f"merged:{src['id']}"
            elif p["player_id"] == tgt["id"] and m["season_id"] in retire_tgt and counts_for_mmr(p):
                p = {**p, "mmr_track": f"merged:{tgt['id']}"}
            new_players.append(p)
        await db.matches.update_one({"id": m["id"]}, {"$set": {"players": new_players}})

    # MMR adjustments follow the same rule as the matches
    for sid in retire_src:
        await db.mmr_adjustments.update_many({"player_id": src["id"], "season_id": sid, "mmr_track": {"$exists": False}},
                                             {"$set": {"mmr_track": f"merged:{src['id']}"}})
    for sid in retire_tgt:
        await db.mmr_adjustments.update_many({"player_id": tgt["id"], "season_id": sid, "mmr_track": {"$exists": False}},
                                             {"$set": {"mmr_track": f"merged:{tgt['id']}"}})
    await db.mmr_adjustments.update_many({"player_id": src["id"]}, {"$set": {"player_id": tgt["id"]}})
    adj_seasons = {a["season_id"] for a in await db.mmr_adjustments.find({"player_id": tgt["id"]}, {"_id": 0, "season_id": 1}).to_list(100000)}

    for coll, field in (("pending_matches", "team_a"), ("pending_matches", "team_b")):
        await db[coll].update_many({field: src["id"]}, {"$set": {f"{field}.$": tgt["id"]}})
    await db.link_requests.update_many({"player_id": src["id"]}, {"$set": {"player_id": tgt["id"], "player_name": tgt["name"]}})
    upd = {}
    if not tgt.get("discord_id") and src.get("discord_id"):
        upd.update({"discord_id": src["discord_id"], "discord_name": src.get("discord_name", "")})
    if not tgt.get("ign") and src.get("ign"):
        upd["ign"] = src["ign"]
    await db.players.delete_one({"id": src["id"]})   # before moving the link (unique index)
    if upd:
        await db.players.update_one({"id": tgt["id"]}, {"$set": upd})
    await db.player_merges.insert_one({"id": str(uuid.uuid4()), "source": src, "target_id": tgt["id"],
                                       "plan": plan, "by": user.get("name"), "at": _now_iso()})
    for sid in {m["season_id"] for m in src_matches + tgt_matches} | adj_seasons:
        await recompute_season_elo(sid)
    return {"dry_run": False, **summary}


@api_router.get("/admin/players")
async def admin_players(user: dict = Depends(admin_required)):
    """Players with their Discord link and in-game name (hidden from the public list)."""
    docs = await db.players.find({}, {"_id": 0}).to_list(5000)
    return sorted(docs, key=lambda x: x["name"].lower())


class MmrAdjustInput(BaseModel):
    season_id: str
    set_to: Optional[float] = None     # give one of these: the new MMR...
    delta: Optional[float] = None      # ...or how much to add (negative to take away)
    reason: Optional[str] = ""


@api_router.get("/admin/players/{pid}/mmr")
async def admin_player_mmr(pid: str, user: dict = Depends(admin_required)):
    """A player's current MMR in each ranked season, plus every manual adjustment."""
    if not await db.players.find_one({"id": pid}):
        raise HTTPException(404, "Player not found")
    seasons = [s for s in await db.seasons.find({}, {"_id": 0}).sort("created_at", -1).to_list(1000) if is_ranked_season(s)]
    out = []
    for s in seasons:
        out.append({"season_id": s["id"], "season": s["name"], "active": bool(s.get("active")),
                    "mmr": round(await get_player_mmr(pid, s["id"]), 2)})
    names = {s["id"]: s["name"] for s in seasons}
    adjs = await db.mmr_adjustments.find({"player_id": pid, "mmr_track": {"$exists": False}}, {"_id": 0}).sort("at", -1).to_list(1000)
    for a in adjs:
        a["season"] = names.get(a["season_id"], "?")
    return {"seasons": out, "adjustments": adjs}


@api_router.post("/admin/players/{pid}/mmr")
async def admin_adjust_mmr(pid: str, data: MmrAdjustInput, user: dict = Depends(admin_required)):
    player = await db.players.find_one({"id": pid}, {"_id": 0})
    if not player:
        raise HTTPException(404, "Player not found")
    season = await db.seasons.find_one({"id": data.season_id}, {"_id": 0})
    if not season:
        raise HTTPException(404, "Season not found")
    if not is_ranked_season(season):
        raise HTTPException(400, "Unranked games don't have MMR")
    if (data.set_to is None) == (data.delta is None):
        raise HTTPException(400, "Give either a new MMR or an amount to add")
    current = await get_player_mmr(pid, data.season_id)
    if data.set_to is not None:
        if not 0 <= data.set_to <= 5000:
            raise HTTPException(400, "MMR must be between 0 and 5000")
        delta = data.set_to - current
    else:
        delta = data.delta
    delta = round(delta, 2)
    if delta == 0:
        raise HTTPException(400, f"{player['name']} is already on {round(current)} MMR")
    doc = {"id": str(uuid.uuid4()), "player_id": pid, "season_id": data.season_id, "delta": delta,
           "mmr_before": round(current, 2), "mmr_after": round(current + delta, 2),
           "reason": (data.reason or "").strip()[:200], "by": user.get("name") or user.get("email"), "at": _now_iso()}
    await db.mmr_adjustments.insert_one(doc)
    doc.pop("_id", None)
    await recompute_season_elo(data.season_id)   # later matches (if any were backdated) and the leaderboard
    return doc


@api_router.delete("/admin/mmr-adjustments/{aid}")
async def admin_undo_mmr_adjustment(aid: str, user: dict = Depends(admin_required)):
    a = await db.mmr_adjustments.find_one({"id": aid}, {"_id": 0})
    if not a:
        raise HTTPException(404, "Adjustment not found")
    await db.mmr_adjustments.delete_one({"id": aid})
    await recompute_season_elo(a["season_id"])
    return {"ok": True}


@api_router.get("/admin/discord-accounts")
async def admin_discord_accounts(user: dict = Depends(admin_required)):
    """Discord accounts the site has seen (Discord logins, link requests, existing links)."""
    seen: dict = {}
    async for u in db.users.find({"discord_id": {"$exists": True}}, {"_id": 0}):
        seen[u["discord_id"]] = {"discord_id": u["discord_id"], "discord_name": u.get("discord_name") or u.get("name"),
                                 "display_name": u.get("name"), "source": "website login"}
    async for r in db.link_requests.find({}, {"_id": 0}).sort("created_at", -1):
        seen.setdefault(r["discord_id"], {"discord_id": r["discord_id"], "discord_name": r.get("discord_name"),
                                          "display_name": None, "source": "link request"})
    async for p in db.players.find({"discord_id": {"$exists": True}}, {"_id": 0}):
        acc = seen.setdefault(p["discord_id"], {"discord_id": p["discord_id"], "discord_name": p.get("discord_name"),
                                                "display_name": None, "source": "linked"})
        acc["linked_player_id"], acc["linked_player"] = p["id"], p["name"]
    return sorted(seen.values(), key=lambda a: (a.get("discord_name") or "").lower())


@api_router.post("/link-requests")
async def create_link_request(data: LinkRequestCreate, user: dict = Depends(bot_required)):
    name = " ".join(data.player_name.split())
    if not 1 <= len(name) <= 30:
        raise HTTPException(400, "Player names must be 1-30 characters")
    player = await _find_player_by_name(name)
    if player:
        if player.get("discord_id") == data.discord_id:
            raise HTTPException(409, f"You're already linked to {player['name']}")
        await _check_link_conflicts(data.discord_id, player)
    else:
        # No such player yet: approving this request will create them
        linked = await db.players.find_one({"discord_id": data.discord_id}, {"_id": 0})
        if linked:
            raise HTTPException(409, f"This Discord account is already linked to {linked['name']}")
    # One open request per Discord account: a new request replaces the old one
    await db.link_requests.update_many(
        {"discord_id": data.discord_id, "status": "pending"},
        {"$set": {"status": "superseded", "decided_at": _now_iso()}},
    )
    doc = {
        "id": str(uuid.uuid4()),
        "discord_id": data.discord_id,
        "discord_name": data.discord_name,
        "player_id": player["id"] if player else None,
        "player_name": player["name"] if player else name,
        "new_player": player is None,
        "status": "pending",
        "created_at": _now_iso(),
    }
    await db.link_requests.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.get("/link-requests")
async def list_link_requests(status: Optional[str] = "pending", user: dict = Depends(admin_or_bot)):
    q = {"status": status} if status else {}
    return await db.link_requests.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)


@api_router.post("/link-requests/{rid}/decision")
async def decide_link_request(rid: str, data: LinkDecision, user: dict = Depends(admin_or_bot)):
    req = await db.link_requests.find_one({"id": rid}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Link request not found")
    if req["status"] != "pending":
        raise HTTPException(409, f"This request was already {req['status']}")
    decided_by = data.decided_by or user.get("name") or user.get("email") or "admin"
    if data.approve:
        if req.get("player_id"):
            player = await db.players.find_one({"id": req["player_id"]}, {"_id": 0})
            if not player:
                raise HTTPException(404, "That player no longer exists")
        else:
            # New-player request: someone may have added the name since - reuse it if so
            player = await _find_player_by_name(req["player_name"])
            if not player:
                player = {"id": str(uuid.uuid4()), "name": req["player_name"],
                          "created_at": _now_iso(), "created_via": "discord-link"}
                await db.players.insert_one({**player})
            req["player_id"] = player["id"]
            await db.link_requests.update_one({"id": rid}, {"$set": {"player_id": player["id"]}})
        await _check_link_conflicts(req["discord_id"], player)
        await db.players.update_one({"id": player["id"]}, {"$set": {
            "discord_id": req["discord_id"], "discord_name": req["discord_name"],
        }})
    status = "approved" if data.approve else "denied"
    await db.link_requests.update_one({"id": rid}, {"$set": {
        "status": status, "decided_by": decided_by, "decided_at": _now_iso(),
    }})
    return {**req, "status": status, "decided_by": decided_by}


# --------- Pending matches (reported from Discord, completed by an admin) ---------
class PendingMatchCreate(BaseModel):
    ranked: bool = True
    format: Literal["1v1", "2v2", "3v3"]
    team_a: List[str]               # player ids
    team_b: List[str]
    team_a_rounds: Optional[int] = Field(default=None, ge=0, le=20)  # None = read from screenshot
    team_b_rounds: Optional[int] = Field(default=None, ge=0, le=20)
    balance_mode: Optional[str] = None
    map: Optional[str] = None
    reported_by: Optional[str] = None
    confirmed_by: Optional[str] = None
    source: str = "discord"
    source_ref: Optional[str] = None   # e.g. link to the Discord message
    discord_match_id: Optional[str] = None  # the bot's match number, shown in the match log
    notes: Optional[str] = ""
    played_at: Optional[str] = None
    tournament_match_id: Optional[str] = None   # a game in a tournament match

class PendingPlayerInput(BaseModel):
    player_id: str
    champion: str
    team: Optional[Literal["A", "B"]] = None   # override if players swapped teams in game
    role: Optional[str] = None          # defaults to the champion's role
    stats: Optional[PlayerStats] = None

class PendingMatchComplete(BaseModel):
    players: List[PendingPlayerInput]
    team_a_rounds: Optional[int] = None
    team_b_rounds: Optional[int] = None
    season_id: Optional[str] = None
    notes: Optional[str] = None
    confirmed_by: Optional[str] = None   # set by the bot when the players confirmed the result
    needs_check: Optional[List[str]] = None   # bot: what an admin should look at (read problems)


@api_router.post("/pending-matches")
async def create_pending_match(data: PendingMatchCreate, user: dict = Depends(admin_or_bot)):
    await check_and_close_expired_seasons()
    if data.format not in ACTIVE_FORMATS:
        raise HTTPException(400, "1v1 is no longer a format")
    size = {"1v1": 1, "2v2": 2, "3v3": 3}[data.format]
    if len(data.team_a) != size or len(data.team_b) != size:
        raise HTTPException(400, f"Expected {size} players per team for {data.format}")
    ids = data.team_a + data.team_b
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "A player can only appear once per match")
    if data.team_a_rounds is not None and data.team_a_rounds == data.team_b_rounds:
        raise HTTPException(400, "Rounds cannot be tied")
    for pid in ids:
        if not await db.players.find_one({"id": pid}):
            raise HTTPException(404, f"Player {pid} not found")
    if data.tournament_match_id:
        await _tournament_match_check(data.tournament_match_id, data.team_a, data.team_b, data.format)
        season = await ensure_unranked_season()   # (only for the pending record; the game isn't a match)
    elif data.ranked:
        season = await get_active_ranked_season()
        if not season:
            raise HTTPException(400, "There is no active ranked season")
    else:
        season = await ensure_unranked_season()

    doc = {
        "id": str(uuid.uuid4()),
        "status": "pending",
        "tournament_match_id": data.tournament_match_id,
        "season_id": season["id"],
        "ranked": data.ranked,
        "format": data.format,
        "team_a": data.team_a,
        "team_b": data.team_b,
        "team_a_rounds": data.team_a_rounds,
        "team_b_rounds": data.team_b_rounds,
        "balance_mode": data.balance_mode,
        "map": data.map,
        "reported_by": data.reported_by,
        "confirmed_by": data.confirmed_by,
        "source": data.source,
        "source_ref": data.source_ref,
        "discord_match_id": data.discord_match_id,
        "notes": data.notes or "",
        "played_at": data.played_at or _now_iso(),
        "created_at": _now_iso(),
    }
    await db.pending_matches.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.get("/pending-matches")
async def list_pending_matches(status: Optional[str] = "pending", user: dict = Depends(admin_or_bot)):
    q = {"status": status} if status else {}
    return await db.pending_matches.find(q, {"_id": 0}).sort("played_at", 1).to_list(500)


@api_router.get("/pending-matches/{pmid}")
async def get_pending_match(pmid: str, user: dict = Depends(admin_or_bot)):
    """Status of one reported match; once logged, includes the final match and its stats."""
    pm = await db.pending_matches.find_one({"id": pmid}, {"_id": 0, "ocr": 0})
    if not pm:
        raise HTTPException(404, "Pending match not found")
    if pm.get("match_id"):
        m = await db.matches.find_one({"id": pm["match_id"]}, {"_id": 0})
        if m:
            pm["match"] = m
            pm["match_stats"] = normalize_match_stats(m)
    return pm


@api_router.post("/pending-matches/{pmid}/complete")
async def complete_pending_match(pmid: str, data: PendingMatchComplete, user: dict = Depends(admin_or_bot)):
    """Log a reported match: an admin on the Pending page, or the bot once the players confirmed it."""
    pm = await db.pending_matches.find_one({"id": pmid}, {"_id": 0})
    if not pm:
        raise HTTPException(404, "Pending match not found")
    if pm["status"] != "pending":
        raise HTTPException(409, f"This match was already {pm['status']}")
    team_of = {pid: "A" for pid in pm["team_a"]}
    team_of.update({pid: "B" for pid in pm["team_b"]})
    given = {p.player_id for p in data.players}
    if given != set(team_of):
        raise HTTPException(400, "Players must match the reported teams")
    for p in data.players:
        if p.team:
            team_of[p.player_id] = p.team
    if list(team_of.values()).count("A") != len(team_of) // 2:
        raise HTTPException(400, "Both teams need the same number of players")
    players = []
    for p in data.players:
        role = p.role or CHAMPION_ROLES.get(p.champion)
        if not role:
            raise HTTPException(400, f"Unknown champion '{p.champion}'")
        players.append(MatchPlayerInput(player_id=p.player_id, champion=p.champion, role=role,
                                        team=team_of[p.player_id], stats=p.stats))
    season_id = data.season_id or pm["season_id"]
    a_rounds = pm.get("team_a_rounds") if data.team_a_rounds is None else data.team_a_rounds
    b_rounds = pm.get("team_b_rounds") if data.team_b_rounds is None else data.team_b_rounds
    if a_rounds is None or b_rounds is None:
        raise HTTPException(400, "Enter the round score")
    if pm.get("tournament_match_id"):   # a tournament game: logged with its tournament only
        is_bot = user.get("role") == "bot"
        game = await _log_tournament_game(MatchCreate(
            season_id="", format=pm["format"], team_a_rounds=a_rounds, team_b_rounds=b_rounds, players=players,
            notes=pm.get("notes", "") if data.notes is None else data.notes, played_at=pm["played_at"],
            tournament_match_id=pm["tournament_match_id"]),
            "players" if is_bot else (user.get("name") or user.get("email")), code=pm.get("discord_match_id"),
            extra={"source": pm.get("source"), "map": pm.get("map"), "reported_by": pm.get("reported_by"),
                   "confirmed_by": data.confirmed_by if is_bot else None, "pending_match_id": pmid,
                   "needs_check": (data.needs_check or None) if is_bot else None})
        if pm.get("screenshot") and pm.get("prefill"):
            await _learn_icons(pm, {p.player_id: p.champion for p in data.players})
        await db.pending_matches.update_one({"id": pmid}, {"$set": {
            "status": "completed", "tournament_game_id": game["id"], "completed_at": _now_iso()}})
        return game
    match_in = MatchCreate(
        season_id=season_id,
        format=pm["format"],
        team_a_rounds=a_rounds,
        team_b_rounds=b_rounds,
        players=players,
        notes=pm.get("notes", "") if data.notes is None else data.notes,
        played_at=pm["played_at"],
    )
    match = await _insert_match(match_in, code=pm.get("discord_match_id"))   # posted to the match log below, once MMR is final
    await db.matches.update_one({"id": match["id"]}, {"$set": {
        "source": pm.get("source"), "source_ref": pm.get("source_ref"), "map": pm.get("map"),
        "balance_mode": pm.get("balance_mode"), "reported_by": pm.get("reported_by"),
        "confirmed_by": data.confirmed_by if user.get("role") == "bot" else None,
        "completed_by": "players" if user.get("role") == "bot" else (user.get("name") or user.get("email")),
        "needs_check": (data.needs_check or None) if user.get("role") == "bot" else None,
        "pending_match_id": pmid,
        "screenshot_id": pmid if pm.get("screenshot") else None,
    }})
    if pm.get("screenshot") and pm.get("prefill"):
        await _learn_icons(pm, {p.player_id: p.champion for p in data.players})
        final = await db.matches.find_one({"id": match["id"]}, {"_id": 0})
        await _record_ocr_feedback(pm, final)
    # Matches can be completed out of order: replay the season so MMR follows played_at.
    await recompute_season_elo(season_id)
    await db.pending_matches.update_one({"id": pmid}, {"$set": {
        "status": "completed", "match_id": match["id"], "completed_at": _now_iso(),
    }})
    schedule_match_log(match["id"])  # post the confirmed result to the Discord match log
    return await db.matches.find_one({"id": match["id"]}, {"_id": 0})


class PendingNeedsAdmin(BaseModel):
    reasons: List[str]
    team_a_rounds: int = Field(ge=0, le=20)
    team_b_rounds: int = Field(ge=0, le=20)
    confirmed_by: Optional[str] = None


@api_router.post("/pending-matches/{pmid}/needs-admin")
async def pending_needs_admin(pmid: str, data: PendingNeedsAdmin, user: dict = Depends(bot_required)):
    """The players confirmed the score, but the match can't be logged as read (e.g. a champion
    wasn't read): it stays on the Pending page, with the confirmed score, for an admin to finish."""
    if data.team_a_rounds == data.team_b_rounds:
        raise HTTPException(400, "Rounds cannot be tied")
    res = await db.pending_matches.update_one({"id": pmid, "status": "pending"}, {"$set": {
        "team_a_rounds": data.team_a_rounds, "team_b_rounds": data.team_b_rounds, "score_confirmed": True,
        "confirmed_by": data.confirmed_by, "needs_check": data.reasons[:20]}})
    if not res.matched_count:
        raise HTTPException(409, "This match isn't pending any more")
    return {"ok": True}


@api_router.get("/matches-to-check")
async def matches_to_check(user: dict = Depends(admin_required)):
    """Matches the players logged whose scoreboard read had something an admin should look at."""
    return await db.matches.find({"needs_check": {"$nin": [None, []]}}, {"_id": 0}).sort("played_at", -1).to_list(200)


@api_router.post("/matches/{mid}/checked")
async def match_checked(mid: str, user: dict = Depends(admin_required)):
    res = await db.matches.update_one({"id": mid}, {"$set": {
        "needs_check": None, "checked_by": user.get("name") or user.get("email"), "checked_at": _now_iso()}})
    if not res.matched_count:
        raise HTTPException(404, "Match not found")
    return {"ok": True}


@api_router.delete("/pending-matches/{pmid}")
async def discard_pending_match(pmid: str, user: dict = Depends(admin_required)):
    res = await db.pending_matches.update_one({"id": pmid, "status": "pending"}, {"$set": {
        "status": "discarded", "discarded_at": _now_iso(),
    }})
    if res.modified_count:
        await db.screenshots.delete_one({"id": pmid})  # no match will point at it
    return {"ok": True}


# --------- Scoreboard screenshots ---------
# Screenshots and learned champion icons live in MongoDB (not on disk), so they
# survive redeploys on hosts that wipe the server's files.
ICON_SEED_DIR = ROOT_DIR / "champion_icons_seed"  # shipped starter icons (read-only)
MAX_ICONS_PER_CHAMPION = 40
MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024           # MongoDB documents max out at 16 MB
def _lowest_priority():
    """Screenshot reading only gets CPU the website, database and bot aren't using."""
    try:
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 19)   # this thread only (Linux)
    except (AttributeError, OSError):
        pass


_ocr_pool = ThreadPoolExecutor(max_workers=1, initializer=_lowest_priority)   # one at a time, off the event loop
_icon_refs = None


async def _run_ocr(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(_ocr_pool, fn, *args)


async def _get_icon_refs():
    global _icon_refs
    if _icon_refs is None:
        import scoreboard
        stored = [(d["champion"], d["png"]) for d in
                  await db.champion_icons.find({}, {"_id": 0, "champion": 1, "png": 1}).to_list(5000)]
        _icon_refs = await _run_ocr(lambda: scoreboard.load_icon_refs(str(ICON_SEED_DIR), stored=stored))
    return _icon_refs


def _read_screenshot(data: bytes, team_a: list, team_b: list, refs) -> dict:
    import scoreboard
    parsed = scoreboard.parse_scoreboard(data, [c["name"] for c in CHAMPIONS], refs)
    return {"parsed": parsed, "prefill": scoreboard.assign_to_roster(parsed, team_a, team_b)}


DETECT_MIN_SIMILARITY = 0.6   # below this a scoreboard name is treated as a player not on the site yet

def _detect_screenshot(data: bytes, everyone: list, refs) -> dict:
    """Read a scoreboard when the players aren't known yet: match each row's name to the closest
    player on the site (name or in-game name). Your Team becomes Team A."""
    import scoreboard
    parsed = scoreboard.parse_scoreboard(data, [c["name"] for c in CHAMPIONS], refs)
    your, enemy = parsed.get("your_team") or [], parsed.get("enemy_team") or []
    warnings = list(parsed.get("warnings") or [])
    rows = [("A", r) for r in your] + [("B", r) for r in enemy]
    pairs = sorted(((max((scoreboard.similarity(r.get("name") or "", n) for n in p["names"] if n), default=0.0), ri, pi)
                    for ri, (_, r) in enumerate(rows) for pi, p in enumerate(everyone)), reverse=True)
    taken_rows, taken_players, match = set(), set(), {}
    for score, ri, pi in pairs:   # best matches first, each row and player used once
        if score < DETECT_MIN_SIMILARITY:
            break
        if ri in taken_rows or pi in taken_players:
            continue
        taken_rows.add(ri); taken_players.add(pi); match[ri] = (everyone[pi]["id"], round(score, 2))
    slots, players, teams = {"A": [], "B": []}, {}, {}
    for ri, (side, r) in enumerate(rows):
        pid, conf = match.get(ri, (None, 0.0))
        info = {"champion": r.get("champion"), "champion_source": r.get("champion_source"), "stats": r.get("stats"),
                "ocr_name": r.get("name"), "name_confidence": conf, "icon_box": r.get("icon_box")}
        slots[side].append({"player_id": pid, **{k: info[k] for k in ("ocr_name", "name_confidence", "champion", "stats")}})
        key = pid or f"row:{side}{len(slots[side]) - 1}"   # rows for new players: matched by name when saved
        players[key] = info
        if pid:
            teams[pid] = side
        if not pid and r.get("name"):
            warnings.append(f"'{r.get('name')}' isn't a player on the site yet - check the name before recording")
    prefill = {"players": players, "teams": teams,
               "team_a_rounds": parsed.get("your_team_rounds"), "team_b_rounds": parsed.get("enemy_team_rounds"),
               "your_team_side": "A", "warnings": warnings}
    return {"parsed": parsed, "prefill": prefill, "slots": slots}


def _icon_crops(data: bytes, prefill: dict, confirmed: dict) -> list:
    """[(champion, player_id, png bytes)] for each confirmed player's portrait."""
    import scoreboard
    img = scoreboard._load_image(data)
    if img is None:
        return []
    out = []
    for pid, info in (prefill or {}).get("players", {}).items():
        champ, box = confirmed.get(pid), info.get("icon_box")
        if champ and box:
            png = scoreboard.encode_icon(img, box)
            if png:
                out.append((champ, pid, png))
    return out


async def _learn_icons(pm: dict, confirmed: dict):
    """Keep each confirmed champion's portrait as a reference for future screenshots."""
    global _icon_refs
    shot = await db.screenshots.find_one({"id": pm["id"]})
    if not shot:
        return
    try:
        crops = await _run_ocr(_icon_crops, bytes(shot["data"]), pm.get("prefill"), confirmed)
    except ImportError:
        return
    for champ, pid, png in crops:
        if await db.champion_icons.count_documents({"champion": champ}) >= MAX_ICONS_PER_CHAMPION:
            continue
        await db.champion_icons.insert_one({"id": str(uuid.uuid4()), "champion": champ, "png": png,
                                            "pending_match_id": pm["id"], "player_id": pid,
                                            "created_at": _now_iso()})
    await db.pending_matches.update_one({"id": pm["id"]}, {"$set": {"icons_learned": True}})
    _icon_refs = None  # reload next time


async def _roster(pm: dict):
    async def side(ids):
        out = []
        for pid in ids:
            p = await db.players.find_one({"id": pid}, {"_id": 0}) or {}
            out.append({"id": pid, "names": [p.get("name"), p.get("ign")]})
        return out
    return await side(pm["team_a"]), await side(pm["team_b"])


async def _parse_into_pending(pm: dict) -> dict:
    shot = await db.screenshots.find_one({"id": pm["id"]})
    team_a, team_b = await _roster(pm)
    try:
        res = await _run_ocr(_read_screenshot, bytes(shot["data"]), team_a, team_b, await _get_icon_refs())
    except ImportError:
        res = {"parsed": None, "prefill": {"players": {}, "warnings": [
            "Screenshot reading isn't installed on the server (rapidocr, onnxruntime, opencv-python-headless)"]}}
    except Exception as e:  # never lose the upload because the reader failed
        logging.getLogger(__name__).exception("Scoreboard parse failed")
        res = {"parsed": None, "prefill": {"players": {}, "warnings": [f"Couldn't read the screenshot ({e.__class__.__name__})"]}}
    upd = {"ocr": res["parsed"], "prefill": res["prefill"], "parsed_at": _now_iso()}
    pre = res["prefill"]
    # Fill the round score from the orbs if nobody entered one
    if pm.get("team_a_rounds") is None and pre.get("team_a_rounds") is not None and pre.get("team_b_rounds") is not None \
            and pre["team_a_rounds"] != pre["team_b_rounds"]:
        upd["team_a_rounds"], upd["team_b_rounds"] = pre["team_a_rounds"], pre["team_b_rounds"]
    await db.pending_matches.update_one({"id": pm["id"]}, {"$set": upd})
    out = await db.pending_matches.find_one({"id": pm["id"]}, {"_id": 0})
    out["ocr_streak"] = await ocr_streak()   # the bot skips player corrections once this is high enough
    return out


async def _read_in_background(pmid: str):
    """The full scoreboard read after a quick upload (the pending match gets "parsed_at" when done)."""
    try:
        pm = await db.pending_matches.find_one({"id": pmid}, {"_id": 0})
        if pm:
            await _parse_into_pending(pm)
    except Exception:
        logging.getLogger(__name__).exception("Background scoreboard read failed")
        await db.pending_matches.update_one({"id": pmid}, {"$set": {
            "parsed_at": _now_iso(), "prefill": {"players": {}, "warnings": ["The scoreboard couldn't be read"]}}})
    await _compress_stored(pmid)
    _spawn(prune_screenshots())


@api_router.post("/pending-matches/{pmid}/screenshot")
async def upload_pending_screenshot(pmid: str, file: UploadFile = File(...), uploaded_by: Optional[str] = None,
                                    quick: bool = False, user: dict = Depends(admin_or_bot)):
    """quick (the bot): answer with just the round score ("quick_rounds": your/enemy team) and read the
    rest of the scoreboard in the background."""
    pm = await db.pending_matches.find_one({"id": pmid}, {"_id": 0})
    if not pm:
        raise HTTPException(404, "Pending match not found")
    if pm["status"] != "pending":
        raise HTTPException(409, f"This match was already {pm['status']}")
    ext = (Path(file.filename or "").suffix or ".png").lower()
    types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
    if ext not in types:
        raise HTTPException(400, "Upload a PNG, JPG or WEBP screenshot")
    data = await file.read()
    if len(data) > MAX_SCREENSHOT_BYTES:
        raise HTTPException(400, "Screenshot is too big (max 12 MB)")
    sha = hashlib.sha256(data).hexdigest()
    other = await db.screenshots.find_one({"sha256": sha, "id": {"$ne": pmid}}, {"_id": 0, "id": 1})
    if other:
        used = await db.pending_matches.find_one({"id": other["id"]}, {"_id": 0}) or {}
        if used.get("status") in ("pending", "completed"):
            label = f"match #{used['discord_match_id']}" if used.get("discord_match_id") else "another match"
            raise HTTPException(409, f"This exact screenshot was already submitted for {label}")
    meta = {"file": f"{pmid}{ext}", "uploaded_at": _now_iso(),
            "uploaded_by": uploaded_by or user.get("name") or user.get("email")}
    await db.screenshots.replace_one({"id": pmid}, {
        "id": pmid, "data": data, "content_type": types[ext], "size": len(data), "sha256": sha, **meta,
    }, upsert=True)
    await db.pending_matches.update_one({"id": pmid}, {"$set": {"screenshot": meta}})
    pm["screenshot"] = meta
    if quick:
        rounds = {}
        try:
            import scoreboard
            rounds = await _run_ocr(scoreboard.read_rounds, data) or {}
        except Exception:
            logging.getLogger(__name__).exception("Couldn't read the round orbs")
        await db.pending_matches.update_one({"id": pmid}, {"$set": {
            "quick_rounds": {"your": rounds.get("blue"), "enemy": rounds.get("red")},
            "prefill": None, "parsed_at": None}})
        _spawn(_read_in_background(pmid))
        return await db.pending_matches.find_one({"id": pmid}, {"_id": 0, "ocr": 0})
    out = await _parse_into_pending(pm)   # read from the original upload
    await _compress_stored(pmid)           # then keep a much smaller copy
    _spawn(prune_screenshots())
    return out


# --------- Screenshot storage limit ---------
# Screenshots are kept under SCREENSHOT_STORAGE_MB, oldest deleted first. What was learned from
# one stays: the champion portraits it taught the reader (champion_icons), how accurate the read
# was (ocr_feedback) and the text it read (on the pending match). Screenshots of results still
# being confirmed are never deleted.
SCREENSHOT_STORAGE_MB = float(os.environ.get("SCREENSHOT_STORAGE_MB") or 1024)
_prune_lock = asyncio.Lock()


STORE_WEBP_QUALITY = 90   # tested: reads the same as the original PNG at ~10x smaller


def _to_webp(data: bytes) -> Optional[bytes]:
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None
    ok, buf = cv2.imencode(".webp", img, [cv2.IMWRITE_WEBP_QUALITY, STORE_WEBP_QUALITY])
    return buf.tobytes() if ok and len(buf) < len(data) else None


async def _compress_stored(sid: str):
    """Swap a stored screenshot for a WebP copy (the sha256 of the original upload is kept, for duplicates)."""
    shot = await db.screenshots.find_one({"id": sid}, {"_id": 0})
    if not shot or shot.get("content_type") == "image/webp":
        return
    try:
        small = await _run_ocr(_to_webp, bytes(shot["data"]))
    except Exception:
        logging.getLogger(__name__).exception("Couldn't compress screenshot %s", sid)
        return
    if not small:
        return
    file = f"{sid}.webp"
    await db.screenshots.update_one({"id": sid}, {"$set": {
        "data": small, "content_type": "image/webp", "size": len(small), "file": file,
        "original_size": shot.get("size"),
    }})
    await db.pending_matches.update_one({"id": sid}, {"$set": {"screenshot.file": file}})


async def screenshot_storage() -> dict:
    rows = await db.screenshots.aggregate([{"$group": {"_id": None, "bytes": {"$sum": "$size"}, "n": {"$sum": 1}}}]).to_list(1)
    used = rows[0]["bytes"] if rows else 0
    return {"count": rows[0]["n"] if rows else 0, "used_mb": round(used / 1048576, 1), "limit_mb": SCREENSHOT_STORAGE_MB}


async def _drop_screenshot(sid: str, why: str):
    await db.screenshots.delete_one({"id": sid})
    await db.matches.update_many({"screenshot_id": sid}, {"$set": {"screenshot_id": None, "screenshot_removed": why}})
    await db.pending_matches.update_one({"id": sid}, {"$set": {"screenshot.removed": why}})


async def _keep_learning(pm: dict):
    """Learn this screenshot's champion portraits before it's deleted, if that never happened."""
    if pm.get("icons_learned") or not pm.get("match_id") or not pm.get("prefill"):
        return
    m = await db.matches.find_one({"id": pm["match_id"]}, {"_id": 0, "players": 1})
    if m:
        try:
            await _learn_icons(pm, {p["player_id"]: p["champion"] for p in m["players"]})
        except Exception:
            logging.getLogger(__name__).exception("Couldn't learn icons before deleting a screenshot")


async def prune_screenshots():
    """Remove duplicate and unused screenshots, then the oldest ones while over the limit."""
    async with _prune_lock:
        shots = await db.screenshots.find({}, {"_id": 0, "data": 0}).sort("uploaded_at", 1).to_list(100000)
        for s in shots:   # screenshots stored before compression: shrink them (hash the original first)
            if s.get("content_type") != "image/webp":
                if not s.get("sha256"):
                    full = await db.screenshots.find_one({"id": s["id"]}, {"_id": 0, "data": 1})
                    s["sha256"] = hashlib.sha256(bytes(full["data"])).hexdigest()
                    await db.screenshots.update_one({"id": s["id"]}, {"$set": {"sha256": s["sha256"]}})
                await _compress_stored(s["id"])
                s["size"] = ((await db.screenshots.find_one({"id": s["id"]}, {"_id": 0, "size": 1})) or {}).get("size", s.get("size"))
        for s in shots:   # screenshots from before hashes were kept
            if not s.get("sha256"):
                full = await db.screenshots.find_one({"id": s["id"]}, {"_id": 0, "data": 1})
                s["sha256"] = hashlib.sha256(bytes(full["data"])).hexdigest()
                await db.screenshots.update_one({"id": s["id"]}, {"$set": {"sha256": s["sha256"]}})
        pendings = {p["id"]: p for p in await db.pending_matches.find(
            {"id": {"$in": [s["id"] for s in shots]}}, {"_id": 0, "ocr": 0}).to_list(100000)}
        used_by = {}
        for m in await db.matches.find({"screenshot_id": {"$ne": None}}, {"_id": 0, "id": 1, "screenshot_id": 1}).to_list(100000):
            used_by.setdefault(m["screenshot_id"], []).append(m["id"])
        keep, first = [], {}
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=STAGED_HOURS)).isoformat()
        for s in shots:
            if s.get("staged"):      # read for a form that hasn't been saved (yet)
                if s.get("uploaded_at", "") < cutoff:
                    await db.screenshots.delete_one({"id": s["id"]})
                continue
            pm = pendings.get(s["id"]) or {}
            if pm.get("status") == "pending":
                keep.append(s)          # still being confirmed - never touched
                continue
            if s["id"] not in used_by:  # discarded, or its match was deleted
                await _drop_screenshot(s["id"], "unused")
                continue
            if s["sha256"] in first:    # same image as an older one: point the match at that copy
                await _keep_learning(pm)
                await db.matches.update_many({"screenshot_id": s["id"]}, {"$set": {"screenshot_id": first[s["sha256"]]}})
                await db.screenshots.delete_one({"id": s["id"]})
                await db.pending_matches.update_one({"id": s["id"]}, {"$set": {"screenshot.removed": "duplicate"}})
                continue
            first[s["sha256"]] = s["id"]
            keep.append(s)
        limit = SCREENSHOT_STORAGE_MB * 1048576
        total = sum(s.get("size") or 0 for s in keep)
        for s in keep:                  # oldest first
            if total <= limit:
                break
            pm = pendings.get(s["id"]) or {}
            if pm.get("status") == "pending":
                continue
            await _keep_learning(pm)
            await _drop_screenshot(s["id"], "storage limit")
            total -= s.get("size") or 0


@api_router.post("/pending-matches/{pmid}/reparse")
async def reparse_pending_screenshot(pmid: str, user: dict = Depends(admin_required)):
    pm = await db.pending_matches.find_one({"id": pmid}, {"_id": 0})
    if not pm or not await db.screenshots.find_one({"id": pmid}, {"_id": 1}):
        raise HTTPException(404, "No screenshot for this match")
    return await _parse_into_pending(pm)


async def _screenshot_response(sid: Optional[str]):
    shot = await db.screenshots.find_one({"id": sid}) if sid else None
    if not shot:
        raise HTTPException(404, "No screenshot")
    return Response(content=bytes(shot["data"]), media_type=shot.get("content_type", "image/png"),
                    headers={"Cache-Control": "private, max-age=86400"})


@api_router.get("/pending-matches/{pmid}/screenshot")
async def get_pending_screenshot(pmid: str):
    return await _screenshot_response(pmid)


@api_router.get("/screenshots/{sid}")
async def get_screenshot(sid: str):
    return await _screenshot_response(sid)


@api_router.get("/matches/{mid}/screenshot")
async def get_match_screenshot(mid: str):
    m = await db.matches.find_one({"id": mid}, {"_id": 0})
    return await _screenshot_response((m or {}).get("screenshot_id"))


async def _forget_screenshot(sid: Optional[str], keep_for_mid: str):
    """Delete a stored screenshot nothing else points at any more."""
    if not sid or await db.matches.find_one({"screenshot_id": sid, "id": {"$ne": keep_for_mid}}, {"_id": 1}):
        return
    pm = await db.pending_matches.find_one({"id": sid}, {"_id": 0, "status": 1})
    if pm and pm.get("status") == "pending":
        return
    await db.screenshots.delete_one({"id": sid})


STAGED_HOURS = 6   # a screenshot read but never saved is deleted after this


def _rounds_agree(read_a, read_b, a: int, b: int) -> bool:
    """The screenshot's round score is this match's. Either way round counts, because the
    reader can mix up which side is which team (3-0 read as 0-3)."""
    return sorted((read_a, read_b)) == sorted((a, b))


@api_router.post("/screenshots/read")
async def read_screenshot(file: UploadFile = File(...), team_a: str = Form(""), team_b: str = Form(""),
                          match_id: Optional[str] = Form(None), user: dict = Depends(admin_required)):
    """Read a scoreboard for the Log Match / Edit Match forms. The screenshot is kept for a few
    hours and attached when the form is saved (with screenshot_id); what's saved is compared with
    what was read, for the reader's accuracy and its corrections-in-a-row count. For a match that's
    already logged, the screenshot's round score must be that match's."""
    a_ids = [x for x in team_a.split(",") if x]
    b_ids = [x for x in team_b.split(",") if x]
    detect = not a_ids and not b_ids and not match_id   # Log Match without players picked: find them
    if not detect and (not a_ids or len(a_ids) != len(b_ids)):
        raise HTTPException(400, "Pick every player in both teams first")
    match = None
    if match_id:
        match = await db.matches.find_one({"id": match_id}, {"_id": 0})
        if not match:
            raise HTTPException(404, "Match not found")
    ext = (Path(file.filename or "").suffix or ".png").lower()
    types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
    if ext not in types:
        raise HTTPException(400, "Upload a PNG, JPG or WEBP screenshot")
    data = await file.read()
    if len(data) > MAX_SCREENSHOT_BYTES:
        raise HTTPException(400, "Screenshot is too big (max 12 MB)")
    sha = hashlib.sha256(data).hexdigest()
    for other in await db.screenshots.find({"sha256": sha}, {"_id": 0, "id": 1, "staged": 1}).to_list(20):
        used = await db.matches.find_one({"screenshot_id": other["id"]}, {"_id": 0, "id": 1, "discord_match_id": 1, "played_at": 1})
        pend = await db.pending_matches.find_one({"id": other["id"], "status": "pending"}, {"_id": 1})
        if used and match and used["id"] == match["id"]:
            raise HTTPException(409, "This match already has that screenshot")
        if used or pend:
            label = f"match #{used['discord_match_id']}" if used and used.get("discord_match_id") else \
                (f"the match on {used['played_at'][:10]}" if used else "a result still being confirmed")
            raise HTTPException(409, f"This exact screenshot is already attached to {label}")
    try:
        if detect:
            everyone = [{"id": p["id"], "names": [p.get("name"), p.get("ign")]}
                        for p in await db.players.find({}, {"_id": 0, "id": 1, "name": 1, "ign": 1}).to_list(5000)]
            res = await _run_ocr(_detect_screenshot, data, everyone, await _get_icon_refs())
        else:
            roster_a, roster_b = await _roster({"team_a": a_ids, "team_b": b_ids})
            res = await _run_ocr(_read_screenshot, data, roster_a, roster_b, await _get_icon_refs())
    except ImportError:
        raise HTTPException(503, "Screenshot reading isn't installed on the server")
    pre, parsed = res["prefill"], res["parsed"] or {}
    if detect:
        sizes = {len(res["slots"]["A"]), len(res["slots"]["B"])}
        if len(sizes) != 1 or sizes.pop() not in (2, 3):
            raise HTTPException(400, "; ".join(pre.get("warnings") or []) or "Couldn't find both teams on that screenshot")
    elif not pre.get("players"):
        raise HTTPException(400, "; ".join(pre.get("warnings") or []) or "Couldn't read that screenshot")
    if match:
        ra, rb = pre.get("team_a_rounds"), pre.get("team_b_rounds")
        a, b = match["team_a_rounds"], match["team_b_rounds"]
        if ra is not None and rb is not None:
            if not _rounds_agree(ra, rb, a, b):
                raise HTTPException(400, f"This screenshot's round score ({ra}-{rb}) isn't this match's ({a}-{b}) - "
                                         "it looks like a different game")
            pre["team_a_rounds"], pre["team_b_rounds"] = a, b
        else:   # orbs unreadable: only accept it if the names clearly belong to this match
            sure = sum((p.get("name_confidence") or 0) >= 0.8 for p in pre["players"].values())
            if sure * 2 < len(a_ids) * 2:
                raise HTTPException(400, "Couldn't read the round score, and the names don't clearly match this "
                                         "match's players - is it the right screenshot?")
            pre.setdefault("warnings", []).append("The round score couldn't be read - matched by player names instead")
            pre["team_a_rounds"], pre["team_b_rounds"] = a, b
    sid = str(uuid.uuid4())
    await db.screenshots.insert_one({
        "id": sid, "data": data, "content_type": types[ext], "size": len(data), "sha256": sha,
        "file": f"{sid}{ext}", "uploaded_at": _now_iso(), "uploaded_by": user.get("name") or user.get("email"),
        "staged": True, "staged_for": match_id, "read": {"prefill": pre, "image_size": parsed.get("image_size")},
    })
    out = {"screenshot_id": sid, "players": pre.get("players") or {}, "teams": pre.get("teams") or {},
           "team_a_rounds": pre.get("team_a_rounds"), "team_b_rounds": pre.get("team_b_rounds"),
           "warnings": pre.get("warnings") or []}
    if detect:
        out.update(detected=True, format=f"{len(res['slots']['A'])}v{len(res['slots']['A'])}", slots=res["slots"])
        out["players"] = {k: v for k, v in out["players"].items() if not k.startswith("row:")}
        for v in out["players"].values():
            v.pop("icon_box", None)
    return out


async def _staged_screenshot(sid: str) -> dict:
    shot = await db.screenshots.find_one({"id": sid}, {"_id": 0, "data": 0})
    if not shot or not shot.get("staged"):
        raise HTTPException(400, "That screenshot has expired - upload it again")
    return shot


async def _attach_screenshot(mid: str, sid: str, user: dict):
    """Attach a read screenshot to a saved match: compare what was saved with what was read
    (accuracy + corrections in a row), learn the champion portraits, store it compressed."""
    shot = await _staged_screenshot(sid)
    final = await db.matches.find_one({"id": mid}, {"_id": 0})
    read = shot.get("read") or {}
    prefill = read.get("prefill") or {}
    unkeyed = {k: v for k, v in (prefill.get("players") or {}).items() if k.startswith("row:")}
    if unkeyed:   # detected rows for players created when the match was saved: match them by name
        import scoreboard
        rp = dict(prefill["players"])
        names = {p["id"]: [p.get("name"), p.get("ign")] for p in await db.players.find(
            {"id": {"$in": [x["player_id"] for x in final["players"]]}}, {"_id": 0, "id": 1, "name": 1, "ign": 1}).to_list(10)}
        for key, info in unkeyed.items():
            free = [pid for pid in names if pid not in rp]
            best = max(free, default=None, key=lambda pid: max((scoreboard.similarity(info.get("ocr_name") or "", n)
                                                              for n in names[pid] if n), default=0.0))
            if best:
                rp[best] = rp.pop(key)
                prefill.setdefault("teams", {})[best] = "A" if key.startswith("row:A") else "B"
        prefill = {**prefill, "players": rp}
    pm = {"id": sid, "prefill": prefill, "ocr": {"image_size": read.get("image_size")}}
    try:
        await _record_ocr_feedback(pm, final)
        await _learn_icons(pm, {p["player_id"]: p["champion"] for p in final["players"]})
    except Exception:
        logging.getLogger(__name__).exception("Couldn't learn from the screenshot of match %s", mid)
    await db.screenshots.update_one({"id": sid}, {"$set": {"match_id": mid}, "$unset": {"staged": "", "staged_for": ""}})
    await _compress_stored(sid)
    old = final.get("screenshot_id")
    await db.matches.update_one({"id": mid}, {"$set": {"screenshot_id": sid}, "$unset": {"screenshot_removed": ""}})
    if old and old != sid:
        await _forget_screenshot(old, mid)
    _spawn(prune_screenshots())


@api_router.delete("/screenshots/{sid}")
async def discard_staged_screenshot(sid: str, user: dict = Depends(admin_required)):
    """The form was cancelled: drop a screenshot that was read but never saved."""
    await db.screenshots.delete_one({"id": sid, "staged": True})
    return {"ok": True}


@api_router.delete("/matches/{mid}/screenshot")
async def remove_match_screenshot(mid: str, user: dict = Depends(admin_required)):
    m = await db.matches.find_one({"id": mid}, {"_id": 0, "screenshot_id": 1})
    if not m:
        raise HTTPException(404, "Match not found")
    await db.matches.update_one({"id": mid}, {"$set": {"screenshot_id": None}})
    await _forget_screenshot(m.get("screenshot_id"), mid)
    return {"ok": True}


class IgnInput(BaseModel):
    ign: Optional[str] = None


@api_router.put("/players/{pid}/ign")
async def set_player_ign(pid: str, data: IgnInput, user: dict = Depends(admin_or_bot)):
    """In-game name - used to match screenshot rows to players when it differs from the website name."""
    if not await db.players.find_one({"id": pid}):
        raise HTTPException(404, "Player not found")
    if data.ign and data.ign.strip():
        await db.players.update_one({"id": pid}, {"$set": {"ign": data.ign.strip()}})
    else:
        await db.players.update_one({"id": pid}, {"$unset": {"ign": ""}})
    return await db.players.find_one({"id": pid}, {"_id": 0, "discord_id": 0})


# --------- Discord leaderboard push ---------
# Set DISCORD_LEADERBOARD_WEBHOOK_URL (Discord: channel settings > Integrations >
# Webhooks > New Webhook > Copy URL) and the website keeps one leaderboard post in
# that channel up to date, editing it right after any change to matches or seasons.
LEADERBOARD_WEBHOOK = os.environ.get("DISCORD_LEADERBOARD_WEBHOOK_URL", "").strip()
LEADERBOARD_SIZE = int(os.environ.get("DISCORD_LEADERBOARD_SIZE") or 25)
PUBLIC_SITE_URL = os.environ.get("PUBLIC_SITE_URL", "").rstrip("/")
_lb_task: Optional[asyncio.Task] = None
_lb_again = False


def schedule_leaderboard_push():
    """Ask for a leaderboard refresh. Rapid changes are batched into one Discord edit."""
    global _lb_task, _lb_again
    if not LEADERBOARD_WEBHOOK:
        return
    if _lb_task and not _lb_task.done():
        _lb_again = True
        return
    _lb_task = asyncio.get_running_loop().create_task(_leaderboard_push_worker())


async def _leaderboard_push_worker():
    global _lb_again
    while True:
        _lb_again = False
        await asyncio.sleep(2)  # let a burst of edits settle
        try:
            await push_leaderboard()
        except Exception:
            logging.getLogger(__name__).exception("Leaderboard push failed")
        if not _lb_again:
            return


def _webhook_call(method: str, url: str, payload: Optional[dict]):
    import json
    import urllib.request
    import urllib.error
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "BRStats (webhooks, 1.0)"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read()
            return r.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        return e.code, None


def leaderboard_payload(rows: list, season_name: str) -> dict:
    played = [r for r in rows if r["matches"]][:LEADERBOARD_SIZE]
    medals = {1: "🥇", 2: "🥈", 3: "🥉"}
    lines = []
    for pos, r in enumerate(played, 1):
        hot = f" 🔥{r['streak']}" if r.get("streak", 0) >= 3 else ""
        place = medals.get(pos) or "`#{:>2}`".format(pos)
        lines.append(f"{place} **{r['name']}** · {round(r['mmr'])} MMR · {r['wins']}-{r['losses']} ({r['winrate']}%){hot}")
    embed = {
        "title": f"🏆 BR Stats leaderboard — {season_name}",
        "description": "\n".join(lines) or "No ranked matches this season yet.",
        "color": 0x22D3EE,
        "footer": {"text": "Updates automatically when a match is logged"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if PUBLIC_SITE_URL:
        embed["url"] = f"{PUBLIC_SITE_URL}/leaderboard"
    return {"embeds": [embed], "allowed_mentions": {"parse": []}}


async def push_leaderboard():
    season = await get_active_ranked_season()
    rows = await leaderboard(season_id=season["id"]) if season else []
    payload = leaderboard_payload(rows, season["name"] if season else "no active season")
    state = await db.settings.find_one({"id": "leaderboard_post"}) or {}
    loop = asyncio.get_running_loop()
    if state.get("message_id") and state.get("webhook") == LEADERBOARD_WEBHOOK:
        status, _ = await loop.run_in_executor(None, _webhook_call, "PATCH",
                                               f"{LEADERBOARD_WEBHOOK}/messages/{state['message_id']}", payload)
        if status < 300:
            return
    # first post, webhook changed, or the old post was deleted: post a new one
    status, msg = await loop.run_in_executor(None, _webhook_call, "POST", f"{LEADERBOARD_WEBHOOK}?wait=true", payload)
    if status < 300 and msg:
        await db.settings.update_one({"id": "leaderboard_post"}, {"$set": {
            "id": "leaderboard_post", "message_id": msg["id"], "webhook": LEADERBOARD_WEBHOOK,
        }}, upsert=True)
    else:
        logging.getLogger(__name__).warning("Discord webhook returned %s", status)


@api_router.post("/admin/push-leaderboard")
async def push_leaderboard_now(user: dict = Depends(admin_required)):
    if not LEADERBOARD_WEBHOOK:
        raise HTTPException(400, "DISCORD_LEADERBOARD_WEBHOOK_URL isn't set in backend/.env")
    await push_leaderboard()
    return {"ok": True}


# --------- Discord match log ---------
# Set DISCORD_MATCH_LOG_WEBHOOK_URL and every match an admin logs (Log Match tab, or the Pending
# page (i.e. confirmed /submit results) is posted to that channel. Editing the match
# on the website edits the post; deleting the match deletes it.
MATCH_LOG_WEBHOOK = os.environ.get("DISCORD_MATCH_LOG_WEBHOOK_URL", "").strip()
BALANCE_MODE_NAMES = {"hybrid": "Hybrid Balance", "synergy": "Role Synergy", "mmr": "MMR Balance"}
_bg_tasks: set = set()


def _spawn(coro):
    """Run a webhook call in the background so admin pages never wait on Discord."""
    async def guarded():
        try:
            await coro
        except Exception:
            logging.getLogger(__name__).exception("Discord match log failed")
    t = asyncio.get_running_loop().create_task(guarded())
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)


def schedule_match_log(mid: str):
    if MATCH_LOG_WEBHOOK:
        _spawn(post_match_log(mid))


def _fmt_stat(v):
    if v is None:
        return "—"
    return str(int(v)) if float(v).is_integer() else f"{v:g}"


async def _mmr_after_match(m: dict) -> dict:
    """Each player's MMR straight after this match (replays the season in order)."""
    matches = await db.matches.find({"season_id": m["season_id"]}, {"_id": 0, "id": 1, "played_at": 1, "players": 1}) \
        .sort("played_at", 1).to_list(100000)
    adjs = await season_adjustments(m["season_id"])
    rating, ai = {}, 0
    for x in matches:
        while ai < len(adjs) and adjs[ai]["at"] <= x["played_at"]:
            k = rating_key(adjs[ai])
            rating[k] = rating.get(k, BASE_MMR) + adjs[ai]["delta"]
            ai += 1
        for p in x["players"]:
            k = rating_key(p)
            rating[k] = rating.get(k, BASE_MMR) + (p.get("elo_delta") or 0)
        if x["id"] == m["id"]:
            return {rating_key(p): rating[rating_key(p)] for p in x["players"]}
    return {}


async def match_log_payload(m: dict) -> dict:
    ids = [p["player_id"] for p in m["players"]]
    names = {p["id"]: p["name"] for p in await db.players.find({"id": {"$in": ids}}, {"_id": 0, "id": 1, "name": 1}).to_list(20)}
    season = await db.seasons.find_one({"id": m["season_id"]}, {"_id": 0}) or {}
    ranked = is_ranked_season(season) if season else True
    a, b = m["team_a_rounds"], m["team_b_rounds"]
    won = m.get("winner_team") or ("A" if a > b else "B")
    after = await _mmr_after_match(m) if ranked else {}

    def lines(team):
        out = []
        for p in [x for x in m["players"] if x["team"] == team]:
            row = f"**{names.get(p['player_id'], '?')}** · {p['champion']}"
            if ranked:
                d = p.get("elo_delta") or 0
                row += f" · {'+' if d >= 0 else ''}{round(d, 1)}"
                final = after.get(rating_key(p))
                if final is not None:
                    row += f" → **{round(final)}**"
            out.append(row)
        return "\n".join(out) or "-"

    def team_name(team):
        avg = m.get("team_a_mmr_before" if team == "A" else "team_b_mmr_before")
        label = f"Team {team}{' 🏆' if won == team else ''}"
        return f"{label} · avg {round(avg)}" if ranked and avg else label

    num = f"Match #{m['discord_match_id']} — " if m.get("discord_match_id") else ""
    bits = [f"**Team {won} wins**", f"{m['format']} {'Ranked' if ranked else 'Unranked'}"]
    if ranked and season.get("name"):
        bits.append(season["name"])
    if m.get("map"):
        bits.append(m["map"])
    if m.get("balance_mode"):
        bits.append(BALANCE_MODE_NAMES.get(m["balance_mode"], m["balance_mode"]))
    embed = {
        "title": f"{num}Team A {a} – {b} Team B",
        "description": " · ".join(bits),
        "color": 0x22C55E,
        "fields": [
            {"name": team_name("A"), "value": lines("A"), "inline": True},
            {"name": team_name("B"), "value": lines("B"), "inline": True},
        ],
        "timestamp": m.get("played_at") or _now_iso(),
    }
    foot = (["MMR change → MMR after the match", "avg = team MMR before"] if ranked else []) \
        + ([f"submitted by {m['reported_by']}"] if m.get("reported_by") else []) \
        + ([f"confirmed by {m['confirmed_by']}"] if m.get("confirmed_by") else [])
    if foot:
        embed["footer"] = {"text": " · ".join(foot)}
    if PUBLIC_SITE_URL:
        embed["url"] = f"{PUBLIC_SITE_URL}/matches?match={m['id']}"
    return {"embeds": [embed], "allowed_mentions": {"parse": []}}


_match_log_lock = asyncio.Lock()   # one post at a time, so the channel stays in order
_backfill_running = False


async def _webhook_retry(method: str, url: str, payload: Optional[dict]):
    """Webhook call that waits and retries when Discord says we're going too fast."""
    loop = asyncio.get_running_loop()
    for attempt in range(6):
        status, body = await loop.run_in_executor(None, _webhook_call, method, url, payload)
        if status != 429:
            return status, body
        await asyncio.sleep(2 + attempt * 2)
    return status, body


async def post_match_log(mid: str):
    """Post the match to the log channel, or edit its existing post."""
    async with _match_log_lock:
        await _post_match_log(mid)


SUPPRESS_NOTIFICATIONS = 1 << 12   # Discord's "@silent" message flag


async def _post_match_log(mid: str, silent: bool = False):
    """silent: bulk jobs (posting old matches, reposting after an import) post without pinging anyone.
    Edits never ping, so re-syncs and code changes are always quiet."""
    m = await db.matches.find_one({"id": mid}, {"_id": 0})
    if not m or not MATCH_LOG_WEBHOOK:
        return
    payload = await match_log_payload(m)
    loop = asyncio.get_running_loop()
    log_ref = m.get("discord_log") or {}
    if log_ref.get("message_id"):
        if log_ref.get("webhook") != MATCH_LOG_WEBHOOK:
            return  # posted through an old webhook we can no longer edit
        status, _ = await _webhook_retry("PATCH", f"{MATCH_LOG_WEBHOOK}/messages/{log_ref['message_id']}", payload)
        if status >= 300:
            logging.getLogger(__name__).warning("Match log edit returned %s", status)
        return  # if someone deleted the post in Discord, leave it deleted
    if silent:
        payload["flags"] = SUPPRESS_NOTIFICATIONS   # only allowed on new posts, not edits
    status, msg = await _webhook_retry("POST", f"{MATCH_LOG_WEBHOOK}?wait=true", payload)
    if status < 300 and msg:
        await db.matches.update_one({"id": mid}, {"$set": {
            "discord_log": {"message_id": msg["id"], "webhook": MATCH_LOG_WEBHOOK},
        }})
    else:
        logging.getLogger(__name__).warning("Match log webhook returned %s", status)


async def _backfill_match_log(ids: list):
    global _backfill_running
    try:
        async with _match_log_lock:   # new matches logged meanwhile wait, then post after these
            for mid in ids:
                await _post_match_log(mid, silent=True)
                await asyncio.sleep(1)   # stay well under Discord's webhook rate limit
    finally:
        _backfill_running = False


@api_router.get("/admin/match-log/backfill")
async def match_log_backfill_status(user: dict = Depends(admin_required)):
    unposted = await db.matches.count_documents({"discord_log": {"$exists": False}})
    return {"configured": bool(MATCH_LOG_WEBHOOK), "unposted": unposted, "running": _backfill_running}


@api_router.post("/admin/match-log/backfill")
async def match_log_backfill(user: dict = Depends(admin_required)):
    """Post every match that isn't in the Discord match log yet, oldest first."""
    global _backfill_running
    if not MATCH_LOG_WEBHOOK:
        raise HTTPException(400, "DISCORD_MATCH_LOG_WEBHOOK_URL isn't set")
    if _backfill_running:
        raise HTTPException(409, "Already posting old matches - give it a minute")
    docs = await db.matches.find({"discord_log": {"$exists": False}}, {"_id": 0, "id": 1, "played_at": 1}) \
        .sort("played_at", 1).to_list(100000)
    if docs:
        _backfill_running = True
        _spawn(_backfill_match_log([d["id"] for d in docs]))
    return {"queued": len(docs), "seconds": len(docs)}


def schedule_match_log_resync(season_id: str, from_played_at: str):
    if MATCH_LOG_WEBHOOK:
        _spawn(_resync_match_log(season_id, from_played_at))


async def _resync_match_log(season_id: str, from_played_at: str):
    """Edit the posts of every logged match in a season from a point onwards."""
    async with _match_log_lock:
        docs = await db.matches.find({"season_id": season_id, "played_at": {"$gte": from_played_at},
                                      "discord_log": {"$exists": True}}, {"_id": 0, "id": 1}) \
            .sort("played_at", 1).to_list(100000)
        for d in docs:
            await _post_match_log(d["id"])
            await asyncio.sleep(0.5)


# --------- Import matches played elsewhere (e.g. on a test copy of the site) ---------
class ImportedPlayer(BaseModel):
    player_id: str          # a live player id
    champion: str
    team: Literal["A", "B"]
    stats: Optional[PlayerStats] = None

class ImportedMatch(BaseModel):
    format: Literal["1v1", "2v2", "3v3"]
    team_a_rounds: int
    team_b_rounds: int
    players: List[ImportedPlayer]
    notes: Optional[str] = ""
    map: Optional[str] = None
    balance_mode: Optional[str] = None
    played_at: Optional[str] = None   # when it was really played - kept if that's still before `before`

class ImportMatches(BaseModel):
    before: str                       # the live match they go just before: its id or Discord number (#f94749)
    matches: List[ImportedMatch]      # oldest first
    dry_run: bool = False


@api_router.post("/admin/import-matches")
async def import_matches(data: ImportMatches, user: dict = Depends(admin_required)):
    """Insert matches into the season of `before`, in order, just before it; replay the season's
    MMR; post them to the Discord match log and repost `before` and every later match below them."""
    key = data.before.strip().lstrip("#")
    target = await db.matches.find_one(match_ref_query(key), {"_id": 0})
    if not target:
        raise HTTPException(404, f"No match {data.before}")
    if not data.matches:
        raise HTTPException(400, "Nothing to import")
    if any(im.format not in ACTIVE_FORMATS for im in data.matches):
        raise HTTPException(400, "1v1 is no longer a format")
    sid = target["season_id"]
    prev = await db.matches.find({"season_id": sid, "played_at": {"$lt": target["played_at"]}}, {"_id": 0, "played_at": 1}) \
        .sort("played_at", -1).to_list(1)
    def when(v: str) -> datetime:
        d = datetime.fromisoformat(v.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    t_end = when(target["played_at"])
    t_start = when(prev[0]["played_at"]) if prev else t_end - timedelta(minutes=10 * (len(data.matches) + 1))
    n = len(data.matches)
    times = [(t_start + (t_end - t_start) * (i + 1) / (n + 1)).isoformat() for i in range(n)]
    try:   # their real times, if those still fall (in order) between the previous match and `before`
        real = [when(im.played_at) for im in data.matches] if all(im.played_at for im in data.matches) else None
    except ValueError:
        real = None
    if real and all(a < b for a, b in zip([t_start] + real, real + [t_end])):
        times = [t.isoformat() for t in real]
    problems = []
    for i, im in enumerate(data.matches):
        for p in im.players:
            if p.champion not in CHAMPION_ROLES:
                problems.append(f"match {i + 1}: unknown champion '{p.champion}'")
            if not await db.players.find_one({"id": p.player_id}, {"_id": 1}):
                problems.append(f"match {i + 1}: unknown player {p.player_id}")
    if problems:
        raise HTTPException(400, "; ".join(problems))
    refs = [im.played_at for im in data.matches if im.played_at]
    if refs and await db.matches.find_one({"source": "import", "import_ref": {"$in": refs}}, {"_id": 1}):
        raise HTTPException(409, "These matches have already been imported")
    later = await db.matches.find({"season_id": sid, "played_at": {"$gte": target["played_at"]}}, {"_id": 0}) \
        .sort("played_at", 1).to_list(100000)
    if data.dry_run:
        return {"season_id": sid, "before": target["id"], "played_at": times,
                "reposted": [m.get("discord_match_id") or m["id"] for m in later]}
    new_ids = []
    for im, at in zip(data.matches, times):
        mc = MatchCreate(season_id=sid, format=im.format, team_a_rounds=im.team_a_rounds, team_b_rounds=im.team_b_rounds,
                         notes=im.notes or "", played_at=at,
                         players=[MatchPlayerInput(player_id=p.player_id, champion=p.champion, role=CHAMPION_ROLES[p.champion],
                                                   team=p.team, stats=p.stats) for p in im.players])
        doc = await _insert_match(mc)
        await db.matches.update_one({"id": doc["id"]}, {"$set": {
            "source": "import", "map": im.map, "balance_mode": im.balance_mode,
            "import_ref": im.played_at}})   # its original time, so the same match can't be imported twice
        new_ids.append(doc["id"])
    await recompute_season_elo(sid)
    if MATCH_LOG_WEBHOOK:
        # take the later posts down now; they go back up below the imported matches
        for m in later:
            if m.get("discord_log"):
                await remove_match_log(m)
                await db.matches.update_one({"id": m["id"]}, {"$unset": {"discord_log": ""}})
        _spawn(_backfill_match_log(new_ids + [m["id"] for m in later]))
    return {"imported": new_ids, "played_at": times, "reposted": [m.get("discord_match_id") or m["id"] for m in later]}


@api_router.post("/admin/matches/{mid}/attach-screenshot")
async def attach_screenshot_as_is(mid: str, file: UploadFile = File(...), user: dict = Depends(admin_required)):
    """Attach a screenshot to a logged match without reading it (imports). It isn't compared
    with the match, so it doesn't count toward the reader's accuracy."""
    m = await db.matches.find_one({"id": mid}, {"_id": 0, "id": 1, "screenshot_id": 1})
    if m is None:
        raise HTTPException(404, "Match not found")
    ext = (Path(file.filename or "").suffix or ".png").lower()
    types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
    if ext not in types:
        raise HTTPException(400, "Upload a PNG, JPG or WEBP screenshot")
    data = await file.read()
    if len(data) > MAX_SCREENSHOT_BYTES:
        raise HTTPException(400, "Screenshot is too big (max 12 MB)")
    sha = hashlib.sha256(data).hexdigest()
    if await db.screenshots.find_one({"sha256": sha, "staged": {"$ne": True}}, {"_id": 1}):
        raise HTTPException(409, "That screenshot is already stored")
    sid = str(uuid.uuid4())
    await db.screenshots.insert_one({"id": sid, "data": data, "content_type": types[ext], "size": len(data), "sha256": sha,
                                     "file": f"{sid}{ext}", "uploaded_at": _now_iso(), "match_id": mid,
                                     "uploaded_by": user.get("name") or user.get("email")})
    await _compress_stored(sid)
    old = m.get("screenshot_id")
    await db.matches.update_one({"id": mid}, {"$set": {"screenshot_id": sid}})
    if old:
        await _forget_screenshot(old, mid)
    return {"screenshot_id": sid}


async def remove_match_log(m: dict):
    log_ref = m.get("discord_log") or {}
    if log_ref.get("message_id") and log_ref.get("webhook"):
        await asyncio.get_running_loop().run_in_executor(
            None, _webhook_call, "DELETE", f"{log_ref['webhook']}/messages/{log_ref['message_id']}", None)


# --------- Screenshot reading accuracy ---------
# Every time an admin logs a match that came with a screenshot, compare what the
# reader suggested with what the admin actually logged. Nothing here changes how
# screenshots are read - it measures how often (and where) the reader is wrong.
OCR_FIELDS = ("score", "damage", "protection", "disables", "champion", "team", "rounds")


def _ocr_outcome(read, final) -> Optional[str]:
    if final is None or final == "":
        return None          # admin left it empty: nothing to compare against
    if read is None or read == "":
        return "missed"
    return "correct" if read == final else "wrong"


def _ocr_fields(m: dict) -> tuple:
    """What the screenshot reader fills in, for spotting corrections."""
    def stats(p):
        st = p.get("stats") or {}
        return tuple(st.get(f) for f in ("score", "damage", "protection", "disables"))
    return (m.get("team_a_rounds"), m.get("team_b_rounds"),
            sorted((p["player_id"], p.get("champion"), p.get("team"), stats(p)) for p in m.get("players") or []))


async def reset_ocr_streak():
    await db.settings.update_one({"id": "ocr_streak"}, {"$set": {"reset_at": _now_iso()}}, upsert=True)


async def ocr_streak() -> int:
    """Screenshots in a row (newest first) that were logged without any correction, by players
    in Discord or by an admin. Any correction, including an admin editing a logged screenshot
    match, starts it again from 0."""
    reset_at = ((await db.settings.find_one({"id": "ocr_streak"})) or {}).get("reset_at") or ""
    q = {"created_at": {"$gt": reset_at}} if reset_at else {}
    n = 0
    for d in await db.ocr_feedback.find(q, {"_id": 0, "items": 1}).sort("created_at", -1).to_list(50):
        if not d.get("items") or any(i.get("outcome") != "correct" for i in d["items"]):
            break
        n += 1
    return n


async def _record_ocr_feedback(pm: dict, final: dict):
    pre = pm.get("prefill") or {}
    read_players = pre.get("players") or {}
    read_teams = pre.get("teams") or {}
    items = []
    for p in final.get("players", []):
        r = read_players.get(p["player_id"]) or {}
        rs, fs = r.get("stats") or {}, p.get("stats") or {}
        for f in ("score", "damage", "protection", "disables"):
            out = _ocr_outcome(rs.get(f), fs.get(f))
            if out:
                items.append({"player_id": p["player_id"], "field": f, "read": rs.get(f), "final": fs.get(f), "outcome": out})
        out = _ocr_outcome(r.get("champion"), p["champion"])
        items.append({"player_id": p["player_id"], "field": "champion", "read": r.get("champion"),
                      "final": p["champion"], "outcome": out, "source": r.get("champion_source")})
        if read_teams:
            items.append({"player_id": p["player_id"], "field": "team", "read": read_teams.get(p["player_id"]),
                          "final": p["team"], "outcome": _ocr_outcome(read_teams.get(p["player_id"]), p["team"])})
    read_score = (pre.get("team_a_rounds"), pre.get("team_b_rounds"))
    final_score = (final["team_a_rounds"], final["team_b_rounds"])
    items.append({"player_id": None, "field": "rounds",
                  "read": None if None in read_score else f"{read_score[0]}-{read_score[1]}",
                  "final": f"{final_score[0]}-{final_score[1]}",
                  "outcome": "missed" if None in read_score else ("correct" if read_score == final_score else "wrong")})
    size = (pm.get("ocr") or {}).get("image_size") or [None, None]
    await db.ocr_feedback.insert_one({
        "id": str(uuid.uuid4()), "pending_match_id": pm["id"], "match_id": final["id"],
        "image_width": size[0], "image_height": size[1],
        "created_at": _now_iso(), "items": [i for i in items if i["outcome"]],
    })


def _resolution_label(h: Optional[int]) -> str:
    if not h:
        return "unknown"
    for limit, label in ((800, "≤720p"), (1200, "1080p"), (1500, "1440p")):
        if h < limit:
            return label
    return "4K+"


@api_router.get("/admin/ocr-accuracy")
async def ocr_accuracy(user: dict = Depends(admin_required)):
    docs = await db.ocr_feedback.find({}, {"_id": 0}).sort("created_at", -1).to_list(5000)
    players = {p["id"]: p["name"] for p in await db.players.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(5000)}

    def blank():
        return {"correct": 0, "wrong": 0, "missed": 0}

    by_field = {f: blank() for f in OCR_FIELDS}
    by_res: dict = {}
    corrections = []
    for d in docs:
        res = _resolution_label(d.get("image_height"))
        by_res.setdefault(res, {"screenshots": 0, **blank()})
        by_res[res]["screenshots"] += 1
        for it in d["items"]:
            by_field.setdefault(it["field"], blank())[it["outcome"]] += 1
            by_res[res][it["outcome"]] += 1
            if it["outcome"] != "correct" and len(corrections) < 25:
                corrections.append({**it, "player": players.get(it["player_id"]) if it["player_id"] else None,
                                    "resolution": res, "match_id": d["match_id"], "at": d["created_at"]})

    def rate(c):
        total = c["correct"] + c["wrong"] + c["missed"]
        return round(c["correct"] / total * 100, 1) if total else None

    return {
        "screenshots": len(docs),
        "fields": [{"field": f, **c, "accuracy": rate(c)} for f, c in by_field.items()],
        "resolutions": [{"resolution": r, **c, "accuracy": rate(c)} for r, c in sorted(by_res.items())],
        "recent_corrections": corrections,
        "streak": await ocr_streak(),
        "storage": await screenshot_storage(),
    }


# --------- Scoreboard stat normalisation (derived, never stored) ---------
STATS_MODEL_VERSION = 2
STAT_FIELDS = ("score", "damage", "protection", "disables")
# The in-game "Average Total" tab shows (sum of every round) / rounds played,
# so stored raw stats are per-round averages.
STATS_RAW_BASIS = "per_round_average"

def normalize_match_stats(match: dict) -> dict:
    """Derive comparable numbers from raw scoreboard stats.

    Raw values stay untouched in match.players[].stats, so this function can be
    rewritten (bump STATS_MODEL_VERSION) and every match re-derived at any time.
    Raw stats are per-round averages (STATS_RAW_BASIS). The whole match is
    passed in, so formulas can use teammates' and opponents' numbers.
    v2: share of own team's total, and normalised damage
    (damage - enemy team protection x player's damage share).
    """
    rounds = (match.get("team_a_rounds") or 0) + (match.get("team_b_rounds") or 0)
    teams = {"A": [], "B": []}
    for p in match.get("players", []):
        teams[p["team"]].append(p)

    def team_total(team, field):
        return sum((p.get("stats") or {}).get(field) or 0 for p in teams[team])

    out = []
    for p in match.get("players", []):
        raw = p.get("stats") or {}
        enemy = "B" if p["team"] == "A" else "A"
        derived = {}
        if raw:
            for f in STAT_FIELDS:
                v = raw.get(f)
                if v is None:
                    continue
                tot = team_total(p["team"], f)
                derived[f"{f}_team_share"] = round(v / tot, 4) if tot else None
            # Normalised damage: the enemy team's protection is split across this
            # team in proportion to each player's share of the team's damage, then
            # subtracted (never below 0).
            dmg = raw.get("damage")
            if dmg is not None:
                team_dmg = team_total(p["team"], "damage")
                share = dmg / team_dmg if team_dmg else 0
                enemy_prot = team_total(enemy, "protection")
                derived["damage_normalised"] = round(max(0.0, dmg - enemy_prot * share), 2)
        out.append({"player_id": p["player_id"], "team": p["team"], "champion": p["champion"],
                    "raw": raw or None, "derived": derived})
    return {"match_id": match.get("id"), "rounds": rounds, "model_version": STATS_MODEL_VERSION,
            "raw_basis": STATS_RAW_BASIS, "players": out}


@api_router.get("/matches/{mid}/stats")
async def match_stats(mid: str):
    m = await db.matches.find_one({"id": mid}, {"_id": 0})
    if not m:
        raise HTTPException(404, "Match not found")
    return normalize_match_stats(m)


# --------- Include Router ---------
# --------- Settings admins can change (Settings page, and the bot's /admin settings) ---------
# A value saved here replaces the .env value until it's reset; the .env value is the default.
# Secrets (tokens, keys, passwords, webhooks, the database address) are deliberately not here -
# they only ever live in the .env files.
BOT_SETTINGS = True   # bot-integration: the Discord bot's settings are kept here too
MAP_NAMES = [
    "Mount Araz (Day)", "Mount Araz (Night)", "Blackstone Arena (Day)", "Blackstone Arena (Night)",
    "Dragon Garden (Day)", "Dragon Garden (Night)", "Daharin Battlegrounds (Day)",
    "Daharin Battlegrounds (Night)", "The Great Market (Night)", "Meriko Summit (Night)",
    "Orman Temple (Night)",
]
SETTING_GROUPS = ["Website", "Team balancing", "Lobbies", "Lobby pings", "Results", "Roles", "Map pools"]
SETTING_SPECS = [
    # app "website": used by the website itself; "bot": used by the Discord bot
    {"key": "OCR_THREADS", "app": "website", "group": "Website", "type": "int", "min": 1, "max": 4,
     "label": "Screenshot reading cores", "help": "CPU cores one screenshot read may use. More than the server has doesn't help."},
    {"key": "DISCORD_LEADERBOARD_SIZE", "app": "website", "group": "Website", "type": "int", "min": 1, "max": 50,
     "label": "Discord leaderboard size", "help": "Players shown in the live leaderboard post in Discord."},
    {"key": "BALANCE_ROLE_MODEL", "app": "website", "group": "Team balancing", "type": "choice",
     "choices": [["role_mmr", "Hidden role MMR"], ["spread", "Role spread (old)"]],
     "label": "Role model", "help": "How roles count when balancing: each player's hidden role MMR, or how varied the teams' usual roles are."},
    {"key": "HYBRID_MMR_WEIGHT", "app": "website", "group": "Team balancing", "type": "float", "min": 0, "max": 1,
     "label": "Hybrid: MMR share", "help": "In Hybrid Balance, how much general MMR counts (0-1); the rest is the role part."},
    {"key": "UNPROVEN_ROLE_PENALTY", "app": "website", "group": "Team balancing", "type": "int", "min": 0, "max": 150,
     "label": "Unproven role penalty (MMR)", "help": "A role a player has rarely or never played counts this much below their MMR until their games in it show otherwise. 0 = off."},
    {"key": "SUPPORT_WEIGHT_2V2", "app": "website", "group": "Team balancing", "type": "float", "min": 0, "max": 1,
     "label": "2v2: support share", "help": "How much the Support counts in a 2v2 team's role line-up (0-1)."},
    {"key": "LOBBY_TIMEOUT_MINUTES", "app": "bot", "group": "Lobbies", "type": "float", "min": 0, "max": 1440,
     "label": "Lobby timeout (minutes)", "help": "A lobby nobody joins or leaves for this long closes. 0 = never."},
    {"key": "STICKY_SETTINGS_MINUTES", "app": "bot", "group": "Lobbies", "type": "float", "min": 0, "max": 1440,
     "label": "Reuse last settings (minutes)", "help": "/join opens a lobby like the channel's last match if it started within this long."},
    {"key": "REJOIN_AFTER", "app": "bot", "group": "Lobbies", "type": "choice",
     "choices": [["submit", "Result submitted"], ["confirmed", "Result confirmed"]],
     "label": "Players can queue again once", "help": "Result submitted: as soon as someone /submits. Result confirmed: only once enough players have confirmed it (or it's settled by an admin)."},
    {"key": "LOBBY_CHANNEL_IDS", "app": "bot", "group": "Lobbies", "type": "channels",
     "label": "Lobby channels", "help": "Channels lobbies may be opened in. None = any channel."},
    {"key": "LOBBY_PING_ROLE_ID", "app": "bot", "group": "Lobby pings", "type": "role",
     "label": "Ping role", "help": "Role mentioned to gather players. Off = no pings."},
    {"key": "LOBBY_PING_QUIET_MINUTES", "app": "bot", "group": "Lobby pings", "type": "float", "min": 0, "max": 1440,
     "label": "New lobby: quiet for (minutes)", "help": "A new lobby pings the role when no lobby of its format has filled for this long."},
    {"key": "LOBBY_PING_COOLDOWN_MINUTES", "app": "bot", "group": "Lobby pings", "type": "float", "min": 0, "max": 1440,
     "label": "Ping cooldown (minutes)", "help": "At most one new-lobby ping per this long, and one 'one player short' ping per lobby."},
    {"key": "RESULT_CONFIRMATIONS", "app": "bot", "group": "Results", "type": "int", "min": 1, "max": 6,
     "label": "3v3: confirmations", "help": "Players who must confirm a 3v3 result before it's logged."},
    {"key": "RESULT_LOSER_CONFIRMATIONS", "app": "bot", "group": "Results", "type": "int", "min": 0, "max": 3,
     "label": "3v3: from the losing team", "help": "How many of those confirmations must come from the losing team."},
    {"key": "RESULT_CONFIRMATIONS_2V2", "app": "bot", "group": "Results", "type": "int", "min": 1, "max": 4,
     "label": "2v2: confirmations", "help": "Players who must confirm a 2v2 result before it's logged."},
    {"key": "RESULT_LOSER_CONFIRMATIONS_2V2", "app": "bot", "group": "Results", "type": "int", "min": 0, "max": 2,
     "label": "2v2: from the losing team", "help": "How many of those confirmations must come from the losing team."},
    {"key": "RESULT_CHECK", "app": "bot", "group": "Results", "type": "choice",
     "choices": [["score", "Round score only"], ["full", "Whole scoreboard"]],
     "label": "What players confirm", "help": "Round score only: players confirm the score and the rest is read in the background, with anything unclear listed for admins. Whole scoreboard: players check and fix every champion and stat before confirming."},
    {"key": "CLEAN_MATCH_POST", "app": "bot", "group": "Results", "type": "bool",
     "label": "Tidy match posts", "help": "Delete lobby, ping and 'Match found' posts once a match is submitted or cancelled."},
    {"key": "LINKED_ROLE_ID", "app": "bot", "group": "Roles", "type": "role",
     "label": "Linked player role", "help": "Role given to members linked to a website player. Off = none."},
    {"key": "ADMIN_ROLE_IDS", "app": "bot", "group": "Roles", "type": "roles",
     "label": "Bot admin roles", "help": "Roles that can use the bot's admin commands (anyone with Manage Server always can)."},
    {"key": "MAP_POOL_2V2", "app": "bot", "group": "Map pools", "type": "maps",
     "label": "2v2 maps", "help": "Maps a 2v2 match can be played on."},
    {"key": "MAP_POOL_3V3", "app": "bot", "group": "Map pools", "type": "maps",
     "label": "3v3 maps", "help": "Maps a 3v3 match can be played on."},
]
SETTING_SPECS = [x for x in SETTING_SPECS if x["app"] == "website" or BOT_SETTINGS]
SETTING_GROUPS = [g for g in SETTING_GROUPS if any(x["group"] == g for x in SETTING_SPECS)]
SETTING_BY_KEY = {x["key"]: x for x in SETTING_SPECS}
WEBSITE_DEFAULTS = {   # what the .env files gave at startup
    "OCR_THREADS": int(os.environ.get("OCR_THREADS") or 1),
    "DISCORD_LEADERBOARD_SIZE": LEADERBOARD_SIZE,
    "BALANCE_ROLE_MODEL": BALANCE_ROLE_MODEL if BALANCE_ROLE_MODEL == "spread" else "role_mmr",
    "HYBRID_MMR_WEIGHT": HYBRID_MMR_WEIGHT,
    "SUPPORT_WEIGHT_2V2": SUPPORT_WEIGHT_2V2,
    "UNPROVEN_ROLE_PENALTY": int(UNPROVEN_ROLE_PENALTY),
}
_SNOWFLAKE = re.compile(r"\d{15,21}")


def parse_setting(spec: dict, raw):
    """A typed, checked value from what an admin entered (raises ValueError with a readable reason)."""
    t = spec["type"]
    text = raw if isinstance(raw, str) else ("" if raw is None else str(raw))
    if t in ("int", "float"):
        if isinstance(raw, bool):
            raise ValueError("Enter a number")
        try:
            v = float(text.strip())
        except ValueError:
            raise ValueError("Enter a number")
        if t == "int":
            if v != int(v):
                raise ValueError("Enter a whole number")
            v = int(v)
        if v < spec["min"] or v > spec["max"]:
            raise ValueError(f"Must be between {spec['min']:g} and {spec['max']:g}")
        return v
    if t == "bool":
        if isinstance(raw, bool):
            return raw
        x = text.strip().lower()
        if x in ("1", "true", "yes", "on", "enabled"):
            return True
        if x in ("0", "false", "no", "off", "disabled"):
            return False
        raise ValueError("Use on or off")
    if t == "choice":
        x = text.strip().lower()
        for key, label in spec["choices"]:
            if x in (key, label.lower()):
                return key
        raise ValueError("Choose one of: " + ", ".join(label for _, label in spec["choices"]))
    if t == "role":
        if text.strip().lower() in ("", "0", "off", "none"):
            return ""
        ids = _SNOWFLAKE.findall(text)
        if len(ids) != 1:
            raise ValueError("Give one role (its ID, or mention it), or 'off'")
        return ids[0]
    if t in ("roles", "channels"):
        items = raw if isinstance(raw, list) else re.split(r"[\s,]+", text)
        items = [str(i).strip() for i in items if str(i).strip()]
        if len(items) == 1 and items[0].lower() in ("none", "off", "any"):
            return []
        ids = []
        for i in items:
            found = _SNOWFLAKE.findall(i)
            if len(found) != 1:
                raise ValueError(f"'{i}' isn't a {'role' if t == 'roles' else 'channel'} ID or mention")
            if found[0] not in ids:
                ids.append(found[0])
        if len(ids) > 25:
            raise ValueError("At most 25")
        return ids
    if t == "maps":
        items = raw if isinstance(raw, list) else re.split(r"[|,\n]", text)
        out = []
        for i in items:
            name = " ".join(str(i).split())
            if not name:
                continue
            if len(name) > 60:
                raise ValueError("Map names are at most 60 characters")
            known = next((m for m in MAP_NAMES if m.lower() == name.lower()), name)
            if known.lower() not in (o.lower() for o in out):
                out.append(known)
        if not out:
            raise ValueError("Keep at least one map")
        if len(out) > 40:
            raise ValueError("At most 40 maps")
        return out
    raise ValueError("Unknown setting type")


def _apply_website_setting(key: str, value):
    """Use a website setting right away (value None = back to the .env default)."""
    global BALANCE_ROLE_MODEL, HYBRID_MMR_WEIGHT, SUPPORT_WEIGHT_2V2, LEADERBOARD_SIZE, UNPROVEN_ROLE_PENALTY
    v = WEBSITE_DEFAULTS[key] if value is None else value
    if key == "OCR_THREADS":
        os.environ["OCR_THREADS"] = str(int(v))
        sb = sys.modules.get("scoreboard")
        if sb is not None:
            sb._ocr = None   # rebuilt with the new core count on the next read
    elif key == "DISCORD_LEADERBOARD_SIZE":
        LEADERBOARD_SIZE = int(v)
        schedule_leaderboard_push()
    elif key == "BALANCE_ROLE_MODEL":
        BALANCE_ROLE_MODEL = v
    elif key == "HYBRID_MMR_WEIGHT":
        HYBRID_MMR_WEIGHT = float(v)
    elif key == "SUPPORT_WEIGHT_2V2":
        SUPPORT_WEIGHT_2V2 = float(v)
    elif key == "UNPROVEN_ROLE_PENALTY":
        UNPROVEN_ROLE_PENALTY = float(v)


async def load_setting_overrides():
    async for d in db.admin_settings.find({}, {"_id": 0}):
        spec = SETTING_BY_KEY.get(d.get("key"))
        if spec and spec["app"] == "website":
            try:
                _apply_website_setting(spec["key"], parse_setting(spec, d.get("value")))
            except ValueError:
                logging.getLogger(__name__).warning("Ignoring the saved %s setting: not valid", spec["key"])


async def _settings_rows(app: Optional[str] = None) -> list:
    saved = {d["key"]: d async for d in db.admin_settings.find({}, {"_id": 0})}
    bot_defaults = ((await db.settings_meta.find_one({"id": "bot"}, {"_id": 0})) or {}).get("defaults") or {}
    rows = []
    for spec in SETTING_SPECS:
        if app and spec["app"] != app:
            continue
        default = WEBSITE_DEFAULTS.get(spec["key"]) if spec["app"] == "website" else bot_defaults.get(spec["key"])
        o = saved.get(spec["key"])
        rows.append({**spec, "default": default, "value": o["value"] if o else default, "overridden": bool(o),
                     "updated_by": o.get("updated_by") if o else None, "updated_at": o.get("updated_at") if o else None})
    return rows


class SettingIn(BaseModel):
    value: object = None
    by: Optional[str] = None   # bot only: the Discord admin who changed it


async def _save_setting(key: str, raw, by: str, app: Optional[str] = None) -> dict:
    spec = SETTING_BY_KEY.get(key)
    if not spec or (app and spec["app"] != app):
        raise HTTPException(404, "No such setting")
    try:
        value = parse_setting(spec, raw)
    except ValueError as e:
        raise HTTPException(400, f"{spec['label']}: {e}")
    await db.admin_settings.update_one({"key": key}, {"$set": {
        "key": key, "value": value, "updated_by": by, "updated_at": datetime.now(timezone.utc).isoformat()}}, upsert=True)
    if spec["app"] == "website":
        _apply_website_setting(key, value)
    return next(r for r in await _settings_rows() if r["key"] == key)


async def _reset_setting(key: str, app: Optional[str] = None) -> dict:
    spec = SETTING_BY_KEY.get(key)
    if not spec or (app and spec["app"] != app):
        raise HTTPException(404, "No such setting")
    await db.admin_settings.delete_one({"key": key})
    if spec["app"] == "website":
        _apply_website_setting(key, None)
    return next(r for r in await _settings_rows() if r["key"] == key)


@api_router.get("/admin/settings")
async def admin_settings(user: dict = Depends(admin_required)):
    meta = (await db.settings_meta.find_one({"id": "bot"}, {"_id": 0})) or {}
    return {"settings": await _settings_rows(), "groups": SETTING_GROUPS, "map_names": MAP_NAMES,
            "bot": {"seen_at": meta.get("seen_at"), "roles": meta.get("roles") or [],
                    "channels": meta.get("channels") or []} if BOT_SETTINGS else None}


@api_router.put("/admin/settings/{key}")
async def admin_set_setting(key: str, data: SettingIn, user: dict = Depends(admin_required)):
    return await _save_setting(key, data.value, user.get("name") or user.get("email") or "admin")


@api_router.delete("/admin/settings/{key}")
async def admin_reset_setting(key: str, user: dict = Depends(admin_required)):
    return await _reset_setting(key)


# The bot reports its .env defaults (and the server's roles and channels, for the Settings page),
# reads the changed values every minute, and changes them for /admin settings.
class BotHello(BaseModel):
    defaults: dict = {}
    roles: list = []
    channels: list = []


@api_router.post("/bot/settings/hello")
async def bot_settings_hello(data: BotHello, user: dict = Depends(bot_required)):
    defaults = {}
    for key, raw in (data.defaults or {}).items():
        spec = SETTING_BY_KEY.get(key)
        if spec and spec["app"] == "bot":
            try:
                defaults[key] = parse_setting(spec, raw)
            except ValueError:
                defaults[key] = [] if spec["type"] in ("roles", "channels") else ("" if spec["type"] == "role" else None)
    clean = lambda xs: [{"id": str(x.get("id")), "name": str(x.get("name"))[:100]} for x in (xs or [])[:500] if isinstance(x, dict)]
    await db.settings_meta.update_one({"id": "bot"}, {"$set": {
        "id": "bot", "defaults": defaults, "roles": clean(data.roles), "channels": clean(data.channels),
        "seen_at": datetime.now(timezone.utc).isoformat()}}, upsert=True)
    return await bot_settings(user)


@api_router.get("/bot/settings")
async def bot_settings(user: dict = Depends(bot_required)):
    rows = await _settings_rows("bot")
    return {"overrides": {r["key"]: r["value"] for r in rows if r["overridden"]}, "settings": rows,
            "map_names": MAP_NAMES}


@api_router.put("/bot/settings/{key}")
async def bot_set_setting(key: str, data: SettingIn, user: dict = Depends(bot_required)):
    return await _save_setting(key, data.value, f"{(data.by or 'admin')[:60]} (Discord)", app="bot")


@api_router.delete("/bot/settings/{key}")
async def bot_reset_setting(key: str, user: dict = Depends(bot_required)):
    return await _reset_setting(key, app="bot")


# --------- Tournaments ---------
# A tournament has teams, an optional league stage (round robin, Swiss or groups) and an optional
# playoff bracket (single or double elimination, with or without a grand final reset). Its games are
# kept in their own collection (tournament_games), apart from logged matches, so they never touch MMR or
# the ranked / unranked stats - each tournament has stats of its own. A tournament can still be set to
# count for MMR: each game's MMR changes are then saved as MMR adjustments (see _tournament_game_mmr). They're entered on the website
# (Log Match) or with /submit in Discord.
# Series results, standings and the bracket are worked out from those games every time (see
# tournaments.py), so editing or deleting a game moves through the bracket by itself.
import tournaments as T_

BEST_OF = (1, 3, 5, 7)


class TournamentTeamIn(BaseModel):
    name: str
    player_ids: List[str]


class TournamentLeagueIn(BaseModel):
    type: Literal["round_robin", "swiss", "groups"]
    best_of: int = 1
    rounds: Optional[int] = None       # Swiss: how many rounds (default: enough to find a winner)
    groups: int = 2                    # groups: how many
    advance_per_group: int = 2         # groups: how many from each go to the playoffs


class TournamentPlayoffsIn(BaseModel):
    type: Literal["single", "double"]
    grand_reset: bool = True           # double: the losers-bracket team must win the final twice
    best_of: int = 1                   # early rounds
    semis_best_of: Optional[int] = None
    final_best_of: Optional[int] = None
    teams: Optional[int] = None        # after a league: how many teams go through (default: all)


class TournamentCreate(BaseModel):
    name: str
    format: Literal["2v2", "3v3"] = "3v3"
    counts_for_mmr: bool = False       # games also move MMR in the active ranked season (stats stay separate)
    teams: List[TournamentTeamIn]
    league: Optional[TournamentLeagueIn] = None
    playoffs: Optional[TournamentPlayoffsIn] = None


def _check_bo(*values):
    for v in values:
        if v is not None and v not in BEST_OF:
            raise HTTPException(400, "Matches are best of 1, 3, 5 or 7")


async def _tournament_match_check(tm_id: str, side_a: List[str], side_b: List[str], fmt: str) -> tuple:
    """A game for a tournament match must be its two teams (either way round). -> (tournament id, match)"""
    tid, _, mid = (tm_id or "").partition(":")
    t = await db.tournaments.find_one({"id": tid}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Tournament not found")
    if fmt != t["format"]:
        raise HTTPException(400, f"This tournament is {t['format']}")
    view = await _tournament_view(t)
    m = next((x for x in view["matches"] if x["id"] == mid), None)
    if not m:
        raise HTTPException(404, "Tournament match not found")
    teams = {x["id"]: set(x["player_ids"]) for x in t["teams"]}
    sides = [m.get("team1"), m.get("team2")]
    if None in sides or T_.BYE in sides:
        raise HTTPException(400, "Both teams of this tournament match aren't known yet")
    if m["done"]:
        raise HTTPException(409, "This tournament match is already decided")
    if {frozenset(side_a), frozenset(side_b)} != {frozenset(teams[sides[0]]), frozenset(teams[sides[1]])}:
        raise HTTPException(400, "The players don't match the two teams of this tournament match")
    return tid, m


async def _log_tournament_game(data: "MatchCreate", by: Optional[str], code: Optional[str] = None,
                               extra: Optional[dict] = None) -> dict:
    """Save a game of a tournament match. Tournament games are kept apart from logged matches: they
    don't count in any ranked or unranked stats - only in their tournament's (and move MMR only if the
    tournament counts for MMR)."""
    team_a = [p for p in data.players if p.team == "A"]
    team_b = [p for p in data.players if p.team == "B"]
    size = {"1v1": 1, "2v2": 2, "3v3": 3}[data.format]
    if len(team_a) != size or len(team_b) != size:
        raise HTTPException(400, f"Expected {size} players per team for {data.format}")
    if data.team_a_rounds == data.team_b_rounds:
        raise HTTPException(400, "Rounds cannot be tied")
    if len({p.player_id for p in data.players}) != len(data.players):
        raise HTTPException(400, "A player can only appear once per match")
    for label, team in (("A", team_a), ("B", team_b)):
        if len({p.champion for p in team}) != len(team):
            raise HTTPException(400, f"Team {label} cannot pick the same champion twice")
    tid, _ = await _tournament_match_check(data.tournament_match_id, [p.player_id for p in team_a],
                                           [p.player_id for p in team_b], data.format)
    doc = {"id": str(uuid.uuid4()), "tournament_id": tid, "tournament_match_id": data.tournament_match_id,
           "format": data.format, "team_a_rounds": data.team_a_rounds, "team_b_rounds": data.team_b_rounds,
           "winner_team": "A" if data.team_a_rounds > data.team_b_rounds else "B",
           "players": [{"player_id": p.player_id, "champion": p.champion, "role": p.role, "team": p.team,
                        "stats": p.stats.model_dump() if p.stats else None} for p in data.players],
           "notes": data.notes or "", "played_at": data.played_at or _now_iso(), "code": code,
           "logged_by": by, "logged_at": _now_iso(), **(extra or {})}
    await db.tournament_games.insert_one(doc)
    doc.pop("_id", None)
    await _tournament_game_mmr(doc)
    _spawn(_tournament_progress(tid))
    return doc


async def _tournament_game_mmr(game: dict):
    """A tournament that counts for MMR: the game's MMR changes (the normal formula, no placement or carry
    bonuses) are saved as MMR adjustments in the active ranked season, labelled with the tournament. The
    game itself stays out of the matches, so the ranked stats don't change."""
    t = await db.tournaments.find_one({"id": game["tournament_id"]}, {"_id": 0})
    if not t or not t.get("counts_for_mmr"):
        return
    season = await get_active_ranked_season()
    if not season:
        await db.tournament_games.update_one({"id": game["id"]}, {"$set": {"mmr_note": "No active ranked season - no MMR change"}})
        return
    sid = season["id"]
    mmr = {p["player_id"]: await get_player_mmr(p["player_id"], sid) for p in game["players"]}
    ta = {p["player_id"]: mmr[p["player_id"]] for p in game["players"] if p["team"] == "A"}
    tb = {p["player_id"]: mmr[p["player_id"]] for p in game["players"] if p["team"] == "B"}
    deltas = compute_player_deltas(ta, tb, game["team_a_rounds"], game["team_b_rounds"], bonuses=False)
    mid = (game["tournament_match_id"] or "").partition(":")[2]
    m = next((x for x in t["matches"] if x["id"] == mid), {})
    number = await db.tournament_games.count_documents({"tournament_match_id": game["tournament_match_id"],
                                                        "played_at": {"$lte": game["played_at"]}})
    reason = f"{t['name']} · {m.get('label') or ('Round %s' % m.get('round', '?'))}" + (f" · game {number}" if m.get("best_of", 1) > 1 else "")
    changes = {}
    for pid, d in deltas.items():
        delta = round(d["delta"], 2)
        changes[pid] = delta
        await db.mmr_adjustments.insert_one({
            "id": str(uuid.uuid4()), "player_id": pid, "season_id": sid, "delta": delta,
            "mmr_before": round(mmr[pid], 2), "mmr_after": round(mmr[pid] + delta, 2), "reason": reason[:200],
            "by": "Tournament", "at": game["played_at"],
            "tournament_id": game["tournament_id"], "tournament_game_id": game["id"]})
    await db.tournament_games.update_one({"id": game["id"]}, {"$set": {"mmr_season_id": sid, "mmr_changes": changes}})
    game.update(mmr_season_id=sid, mmr_changes=changes)
    await recompute_season_elo(sid)   # in case later matches were logged before this game was


async def _drop_tournament_mmr(q: dict):
    """Remove the MMR adjustments of deleted tournament games (q: which ones)."""
    seasons = set(await db.mmr_adjustments.distinct("season_id", q))
    await db.mmr_adjustments.delete_many(q)
    for sid in seasons:
        await recompute_season_elo(sid)


async def _tournament_games(t: dict) -> Dict[str, list]:
    """Logged games of a tournament, by tournament match: [{winner, rounds, match_id, code, played_at}]"""
    team_of = {pid: x["id"] for x in t["teams"] for pid in x["player_ids"]}
    out: Dict[str, list] = {}
    async for m in db.tournament_games.find({"tournament_id": t["id"]}, {"_id": 0, "players.stats": 0}).sort("played_at", 1):
        side = {}
        for s in ("A", "B"):
            votes = [team_of.get(p["player_id"]) for p in m["players"] if p["team"] == s]
            side[s] = max(set(votes), key=votes.count) if votes else None
        if not side["A"] or not side["B"] or side["A"] == side["B"]:
            continue
        mid = (m.get("tournament_match_id") or "").partition(":")[2]
        out.setdefault(mid, []).append({
            "winner": side[m["winner_team"]], "rounds": {side["A"]: m["team_a_rounds"], side["B"]: m["team_b_rounds"]},
            "game_id": m["id"], "code": m.get("code"), "played_at": m["played_at"],
            "players": [{"player_id": p["player_id"], "champion": p["champion"], "team": side[p["team"]]} for p in m["players"]]})
    return out


def _league_total_rounds(t: dict) -> int:
    lg = t.get("league") or {}
    if lg.get("type") != "swiss":
        return max((m["round"] for m in t["matches"] if m["stage"] == "league"), default=0)
    return lg.get("rounds") or max(1, math.ceil(math.log2(max(2, len(t["teams"])))))


async def _tournament_view(t: dict) -> dict:
    games = await _tournament_games(t)
    seeds_default = [x["id"] for x in sorted(t["teams"], key=lambda x: x["seed"])]
    res = T_.resolve(t["matches"], t.get("playoff_seeds") or seeds_default, lambda mid: games.get(mid, []),
                     t.get("forfeits") or {})
    names = {x["id"]: x["name"] for x in t["teams"]}
    names[T_.BYE] = "Bye"
    seed_of = {x["id"]: x["seed"] for x in t["teams"]}
    league = [m for m in t["matches"] if m["stage"] == "league"]
    lg = t.get("league") or {}
    tables = []
    if league:
        if lg.get("type") == "groups":
            for g, ids in (t.get("groups") or {}).items():
                tables.append({"group": g, "rows": T_.standings(ids, [m for m in league if m.get("group") == g], res, seed_of)})
        else:
            tables.append({"group": None, "rows": T_.standings(seeds_default, league, res, seed_of,
                                                               swiss=lg.get("type") == "swiss")})
    for tb in tables:
        for row in tb["rows"]:
            row["name"] = names.get(row["team"])
            row.pop("opponents", None)
    total = _league_total_rounds(t)
    played_rounds = max((m["round"] for m in league), default=0)
    league_done = bool(league) and played_rounds >= total and all(res[m["id"]]["done"] for m in league)
    matches = []
    for m in t["matches"]:
        r = res[m["id"]]
        matches.append({**{k: v for k, v in m.items() if k not in ("team1", "team2")}, **r,
                        "team1_name": names.get(r["team1"]), "team2_name": names.get(r["team2"]),
                        "winner_name": names.get(r["winner"]), "game_list": games.get(m["id"], [])})
    champ = T_.champion(t["matches"], res)
    if not champ and league_done and not t.get("playoffs") and len(tables) == 1 and tables[0]["rows"]:
        champ = tables[0]["rows"][0]["team"]   # league only: the top of the table wins
    return {**{k: v for k, v in t.items() if k not in ("matches",)}, "matches": matches, "standings": tables,
            "league_rounds": total, "league_round": played_rounds, "league_done": league_done,
            "champion": champ, "champion_name": names.get(champ)}


async def _tournament_progress(tid: str):
    """After a result: start the next Swiss round when one finishes, and mark the tournament won."""
    t = await db.tournaments.find_one({"id": tid}, {"_id": 0})
    if not t:
        return
    view = await _tournament_view(t)
    upd = {}
    lg = t.get("league") or {}
    league = [m for m in view["matches"] if m["stage"] == "league"]
    if t["status"] == "league" and lg.get("type") == "swiss" and view["league_round"] < view["league_rounds"] \
            and all(m["done"] for m in league):
        table = view["standings"][0]["rows"] if view["standings"] else None
        played = {frozenset((m["team1"], m["team2"])) for m in league if m.get("team2")}
        had_bye = {m["team1"] for m in league if m.get("bye")}
        new = T_.swiss_round([x["id"] for x in sorted(t["teams"], key=lambda x: x["seed"])], view["league_round"] + 1,
                             lg.get("best_of", 1), table, played, had_bye)
        upd["matches"] = t["matches"] + new
    if view["champion"] and t["status"] != "finished":
        upd.update(status="finished", finished_at=_now_iso())
    elif not view["champion"] and t["status"] == "finished":
        upd["status"] = "playoffs" if any(m["stage"] == "playoffs" for m in t["matches"]) else "league"
    if upd:
        await db.tournaments.update_one({"id": tid}, {"$set": upd})


async def _tournament_or_404(tid: str) -> dict:
    t = await db.tournaments.find_one({"id": tid}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Tournament not found")
    return t


@api_router.post("/tournaments")
async def create_tournament(data: TournamentCreate, user: dict = Depends(admin_required)):
    name = " ".join(data.name.split())[:80]
    if not name:
        raise HTTPException(400, "Give the tournament a name")
    size = {"2v2": 2, "3v3": 3}[data.format]
    if len(data.teams) < 2:
        raise HTTPException(400, "A tournament needs at least 2 teams")
    if len(data.teams) > 64:
        raise HTTPException(400, "At most 64 teams")
    if not data.league and not data.playoffs:
        raise HTTPException(400, "Choose a league stage, playoffs, or both")
    seen, team_names, teams = set(), set(), []
    for n, tm in enumerate(data.teams, 1):
        tname = " ".join(tm.name.split())[:40] or f"Team {n}"
        if tname.lower() in team_names:
            raise HTTPException(400, f"Two teams are called '{tname}'")
        team_names.add(tname.lower())
        ids = list(dict.fromkeys(tm.player_ids))
        if len(ids) != size:
            raise HTTPException(400, f"{tname} needs {size} players for {data.format}")
        for pid in ids:
            if pid in seen:
                raise HTTPException(400, "A player can only be in one team")
            seen.add(pid)
            if not await db.players.find_one({"id": pid}, {"_id": 1}):
                raise HTTPException(404, f"Player {pid} not found")
        teams.append({"id": f"T{n}", "name": tname, "player_ids": ids, "seed": n})
    order = [x["id"] for x in teams]
    matches, groups = [], None
    lg = data.league.model_dump() if data.league else None
    po = data.playoffs.model_dump() if data.playoffs else None
    if lg:
        _check_bo(lg["best_of"])
        if lg["type"] == "round_robin":
            matches = T_.round_robin(order, lg["best_of"])
        elif lg["type"] == "groups":
            if not 2 <= lg["groups"] <= len(teams) // 2:
                raise HTTPException(400, "Each group needs at least 2 teams")
            groups = T_.split_groups(order, lg["groups"])
            for g, ids in groups.items():
                matches += T_.round_robin(ids, lg["best_of"], g)
            if po:
                lg["advance_per_group"] = max(1, min(lg["advance_per_group"], min(len(x) for x in groups.values())))
        else:
            if lg["rounds"] is not None and not 1 <= lg["rounds"] <= len(teams) - 1:
                raise HTTPException(400, f"Swiss: between 1 and {len(teams) - 1} rounds")
            matches = T_.swiss_round(order, 1, lg["best_of"])
    if po:
        _check_bo(po["best_of"], po["semis_best_of"], po["final_best_of"])
        if po["teams"] is not None and not 2 <= po["teams"] <= len(teams):
            raise HTTPException(400, f"Between 2 and {len(teams)} teams can go through to the playoffs")
        if not lg:
            matches = T_.build_playoffs(len(teams), po["type"], po["grand_reset"], po["best_of"],
                                        po["semis_best_of"], po["final_best_of"])
    doc = {"id": str(uuid.uuid4())[:8], "name": name, "format": data.format, "counts_for_mmr": data.counts_for_mmr,
           "stream_key": secrets.token_urlsafe(12), "teams": teams, "league": lg, "playoffs": po,
           "groups": groups, "matches": matches, "forfeits": {}, "playoff_seeds": None if lg else order,
           "status": "league" if lg else "playoffs", "created_at": _now_iso(),
           "created_by": user.get("name") or user.get("email")}
    await db.tournaments.insert_one(doc)
    doc.pop("_id", None)
    return await _tournament_view(doc)


# While tournaments are in preview, only admins see them - except a stream overlay, which can't log
# in: its link carries the tournament's stream key.
async def _tournament_for_viewer(tid: str, request: Request, key: Optional[str]) -> dict:
    t = await _tournament_or_404(tid)
    if key and t.get("stream_key") and secrets.compare_digest(key, t["stream_key"]):
        return t
    try:
        await admin_required(request)
    except HTTPException:
        raise HTTPException(404, "Tournament not found")
    return t


@api_router.get("/tournaments")
async def list_tournaments(user: dict = Depends(admin_required)):
    out = []
    async for t in db.tournaments.find({}, {"_id": 0}).sort("created_at", -1):
        champ = None
        if t["status"] == "finished":
            champ = (await _tournament_view(t))["champion_name"]
        out.append({k: t.get(k) for k in ("id", "name", "format", "status", "created_at", "finished_at", "counts_for_mmr")}
                   | {"teams": len(t["teams"]), "champion_name": champ,
                      "games": await db.tournament_games.count_documents({"tournament_id": t["id"]}),
                      "league": (t.get("league") or {}).get("type"), "playoffs": (t.get("playoffs") or {}).get("type")})
    return out


@api_router.get("/tournaments/{tid}")
async def get_tournament(tid: str, request: Request, key: Optional[str] = None):
    return await _tournament_full(await _tournament_for_viewer(tid, request, key))


async def _tournament_full(t: dict) -> dict:
    view = await _tournament_view(t)
    pnames = {p["id"]: p["name"] for p in await db.players.find(
        {"id": {"$in": [pid for x in t["teams"] for pid in x["player_ids"]]}}, {"_id": 0, "id": 1, "name": 1}).to_list(500)}
    for x in view["teams"]:
        x["players"] = [{"id": pid, "name": pnames.get(pid, "?")} for pid in x["player_ids"]]
    return view


@api_router.get("/tournaments/{tid}/stats")
async def tournament_stats(tid: str, request: Request, key: Optional[str] = None):
    t = await _tournament_for_viewer(tid, request, key)
    team_of = {pid: x["id"] for x in t["teams"] for pid in x["player_ids"]}
    names = {p["id"]: p["name"] for p in await db.players.find({"id": {"$in": list(team_of)}}, {"_id": 0, "id": 1, "name": 1}).to_list(500)}
    tnames = {x["id"]: x["name"] for x in t["teams"]}
    rows = {pid: {"player_id": pid, "name": names.get(pid, "?"), "team": tnames.get(team_of[pid]), "games": 0, "wins": 0,
                  "champions": {}, "stat_games": 0, "mmr_change": 0.0, "score": 0, "damage": 0, "protection": 0, "disables": 0} for pid in team_of}
    games = 0
    async for m in db.tournament_games.find({"tournament_id": tid}, {"_id": 0}):
        games += 1
        for p in m["players"]:
            r = rows.get(p["player_id"])
            if not r:
                continue
            r["games"] += 1
            r["wins"] += p["team"] == m["winner_team"]
            r["mmr_change"] += (m.get("mmr_changes") or {}).get(p["player_id"], 0)
            r["champions"][p["champion"]] = r["champions"].get(p["champion"], 0) + 1
            st = p.get("stats") or {}
            if any(st.get(k) is not None for k in STAT_FIELDS_ALL):
                r["stat_games"] += 1
                for k in STAT_FIELDS_ALL:
                    r[k] += st.get(k) or 0
    players = []
    for r in rows.values():
        n = r.pop("stat_games")
        for k in STAT_FIELDS_ALL:
            r[k] = round(r[k] / n, 1) if n else None
        r["champions"] = sorted(r["champions"].items(), key=lambda x: -x[1])
        r["winrate"] = round(r["wins"] / r["games"] * 100) if r["games"] else None
        r["mmr_change"] = round(r["mmr_change"], 1) if t.get("counts_for_mmr") else None
        players.append(r)
    players.sort(key=lambda r: (-r["games"], r["name"]))
    leaders = {k: sorted([r for r in players if r[k] is not None], key=lambda r: -r[k])[:3] for k in STAT_FIELDS_ALL}
    champs = {}
    for r in players:
        for c, n in r["champions"]:
            champs[c] = champs.get(c, 0) + n
    return {"games": games, "players": players, "leaders": leaders,
            "champions": sorted(champs.items(), key=lambda x: -x[1])}


STAT_FIELDS_ALL = ("score", "damage", "protection", "disables")


class TournamentEdit(BaseModel):
    name: Optional[str] = None
    team_names: Optional[Dict[str, str]] = None


@api_router.patch("/tournaments/{tid}")
async def edit_tournament(tid: str, data: TournamentEdit, user: dict = Depends(admin_required)):
    t = await _tournament_or_404(tid)
    upd = {}
    if data.name is not None and " ".join(data.name.split()):
        upd["name"] = " ".join(data.name.split())[:80]
    if data.team_names:
        teams = [dict(x) for x in t["teams"]]
        for x in teams:
            new = " ".join((data.team_names.get(x["id"]) or "").split())[:40]
            if new:
                x["name"] = new
        if len({x["name"].lower() for x in teams}) != len(teams):
            raise HTTPException(400, "Two teams would have the same name")
        upd["teams"] = teams
    if upd:
        await db.tournaments.update_one({"id": tid}, {"$set": upd})
    return await _tournament_full(await _tournament_or_404(tid))


@api_router.delete("/tournaments/{tid}")
async def delete_tournament(tid: str, user: dict = Depends(admin_required)):
    """The tournament goes, with its games (they aren't logged anywhere else) and any MMR they moved."""
    await _tournament_or_404(tid)
    await db.tournament_games.delete_many({"tournament_id": tid})
    await _drop_tournament_mmr({"tournament_id": tid})
    await db.tournaments.delete_one({"id": tid})
    return {"ok": True}


@api_router.delete("/tournaments/{tid}/games/{gid}")
async def delete_tournament_game(tid: str, gid: str, user: dict = Depends(admin_required)):
    """Remove a wrongly entered game; the series, standings and bracket follow."""
    res = await db.tournament_games.delete_one({"id": gid, "tournament_id": tid})
    if not res.deleted_count:
        raise HTTPException(404, "Game not found")
    await _drop_tournament_mmr({"tournament_game_id": gid})
    await _tournament_progress(tid)
    return await _tournament_full(await _tournament_or_404(tid))


class ForfeitIn(BaseModel):
    winner: Optional[str] = None   # team id; None clears the forfeit


@api_router.post("/tournaments/{tid}/matches/{mid}/forfeit")
async def tournament_forfeit(tid: str, mid: str, data: ForfeitIn, user: dict = Depends(admin_required)):
    t = await _tournament_or_404(tid)
    m = next((x for x in (await _tournament_view(t))["matches"] if x["id"] == mid), None)
    if not m:
        raise HTTPException(404, "Tournament match not found")
    forfeits = dict(t.get("forfeits") or {})
    if data.winner is None:
        forfeits.pop(mid, None)
    elif data.winner not in (m.get("team1"), m.get("team2")) or data.winner == T_.BYE:
        raise HTTPException(400, "The winner must be one of the match's teams")
    else:
        forfeits[mid] = data.winner
    await db.tournaments.update_one({"id": tid}, {"$set": {"forfeits": forfeits}})
    await _tournament_progress(tid)
    return await _tournament_full(await _tournament_or_404(tid))


@api_router.post("/tournaments/{tid}/next-round")
async def tournament_next_round(tid: str, user: dict = Depends(admin_required)):
    await _tournament_or_404(tid)
    await _tournament_progress(tid)
    return await _tournament_full(await _tournament_or_404(tid))


class PlayoffStart(BaseModel):
    seeds: Optional[List[str]] = None   # team ids in seed order (default: from the league standings)


@api_router.post("/tournaments/{tid}/start-playoffs")
async def tournament_start_playoffs(tid: str, data: PlayoffStart, user: dict = Depends(admin_required)):
    t = await _tournament_or_404(tid)
    po = t.get("playoffs")
    if not po:
        raise HTTPException(400, "This tournament has no playoffs")
    if any(m["stage"] == "playoffs" for m in t["matches"]):
        raise HTTPException(409, "The playoffs have already started")
    view = await _tournament_view(t)
    if data.seeds:
        ids = {x["id"] for x in t["teams"]}
        seeds = list(dict.fromkeys(data.seeds))
        if not set(seeds) <= ids or len(seeds) < 2:
            raise HTTPException(400, "Seeds must be at least 2 of the tournament's teams")
    else:
        tables = view["standings"]
        if (t.get("league") or {}).get("type") == "groups":
            per = (t["league"] or {}).get("advance_per_group", 2)
            seeds = []
            for rank in range(per):   # all group winners first, then the runners-up... (alternating order)
                tier = [tb["rows"][rank]["team"] for tb in tables if rank < len(tb["rows"])]
                seeds += tier if rank % 2 == 0 else tier[::-1]
        else:
            seeds = [r["team"] for r in tables[0]["rows"]] if tables else [x["id"] for x in t["teams"]]
        seeds = seeds[:po.get("teams") or len(seeds)]
    matches = t["matches"] + T_.build_playoffs(len(seeds), po["type"], po["grand_reset"], po["best_of"],
                                               po.get("semis_best_of"), po.get("final_best_of"))
    await db.tournaments.update_one({"id": tid}, {"$set": {"matches": matches, "playoff_seeds": seeds, "status": "playoffs"}})
    return await _tournament_full(await _tournament_or_404(tid))


@api_router.get("/bot/tournament-match")
async def bot_tournament_match(discord_id: str, user: dict = Depends(bot_required)):
    """The tournament match a Discord member's team plays next (for /submit outside a lobby)."""
    player = await db.players.find_one({"discord_id": str(discord_id)}, {"_id": 0, "id": 1})
    if not player:
        raise HTTPException(404, "Not linked to a player")
    best = None
    async for t in db.tournaments.find({"status": {"$in": ["league", "playoffs"]}, "teams.player_ids": player["id"]}, {"_id": 0}):
        team = next(x for x in t["teams"] if player["id"] in x["player_ids"])
        view = await _tournament_view(t)
        for n, m in enumerate(view["matches"]):
            if m["status"] in ("ready", "live") and team["id"] in (m["team1"], m["team2"]):
                key = (t["created_at"], n)
                if best is None or key < best[0]:
                    best = (key, t, m)
                break
    if not best:
        raise HTTPException(404, "No tournament match to play")
    _, t, m = best
    people = {p["id"]: p for p in await db.players.find(
        {"id": {"$in": [pid for x in t["teams"] for pid in x["player_ids"]]}}, {"_id": 0, "id": 1, "name": 1, "discord_id": 1}).to_list(200)}
    side = lambda tid: [{"player_id": pid, "name": people.get(pid, {}).get("name", "?"),
                         "discord_id": people.get(pid, {}).get("discord_id")}
                        for pid in next(x for x in t["teams"] if x["id"] == tid)["player_ids"]]
    return {"tournament_id": t["id"], "tournament_name": t["name"], "ranked": False, "format": t["format"],
            "tournament_match_id": f"{t['id']}:{m['id']}", "label": m.get("label") or f"Round {m.get('round')}",
            "best_of": m["best_of"], "wins1": m["wins1"], "wins2": m["wins2"],
            "team1": {"name": m["team1_name"], "players": side(m["team1"])},
            "team2": {"name": m["team2_name"], "players": side(m["team2"])}}


app.include_router(api_router)

# --------- CSV Exports ---------
import csv, io
from fastapi.responses import StreamingResponse

def _csv_response(rows: list, headers: list, filename: str):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(headers)
    for r in rows:
        w.writerow(r)
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})

@app.get("/api/exports/matches.csv")
async def export_matches_csv(season_id: Optional[str] = None, format: Optional[str] = None,
                             user: dict = Depends(admin_required)):
    q = {}
    q.update(await season_filter(season_id))
    if format and format != "all":
        q["format"] = format
    matches = await db.matches.find(q, {"_id": 0}).sort("played_at", -1).to_list(10000)
    players = {p["id"]: p["name"] for p in await db.players.find({}, {"_id": 0}).to_list(1000)}
    seasons = {s["id"]: s["name"] for s in await db.seasons.find({}, {"_id": 0}).to_list(1000)}
    rows = []
    for m in matches:
        for p in m["players"]:
            rows.append([
                m["played_at"], seasons.get(m["season_id"], ""), m["format"],
                f"{m['team_a_rounds']}-{m['team_b_rounds']}", m.get("winner_team", ""),
                p["team"], players.get(p["player_id"], ""),
                p["champion"], p["role"], p.get("elo_delta", 0),
                m.get("notes", ""),
            ])
    return _csv_response(rows,
        ["played_at", "season", "format", "score", "winner_team", "team", "player", "champion", "role", "elo_delta", "notes"],
        "matches.csv")

@app.get("/api/exports/leaderboard.csv")
async def export_leaderboard_csv(season_id: Optional[str] = None, format: Optional[str] = None,
                                 user: dict = Depends(admin_required)):
    lb = await leaderboard(season_id=season_id, format=format)
    rows = [[r["rank"], r["name"], round(r["mmr"], 2), round(r["peak_mmr"], 2),
             r["wins"], r["losses"], r["winrate"], r["rounds_won"], r["rounds_lost"]] for r in lb]
    return _csv_response(rows,
        ["rank", "player", "mmr", "peak_mmr", "wins", "losses", "winrate", "rounds_won", "rounds_lost"],
        f"leaderboard{('_' + format) if format else ''}.csv")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
