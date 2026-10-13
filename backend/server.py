from dotenv import load_dotenv
from pathlib import Path
ROOT_DIR = Path(__file__).parent
import sys
sys.path.insert(0, str(ROOT_DIR))  # so scoreboard.py imports wherever uvicorn is started
load_dotenv(ROOT_DIR / '.env')

import os
import hmac
import logging
import uuid
import jwt
import bcrypt
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal
from itertools import combinations, permutations

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Response, UploadFile, File
from fastapi.responses import RedirectResponse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
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
UNRANKED_SEASON_NAME = "Unranked"  # permanent season for unranked games (no MMR)

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


def compute_player_deltas(team_a_mmrs: dict, team_b_mmrs: dict,
                          team_a_rounds: int, team_b_rounds: int,
                          placement_counts: dict = None, bonuses: bool = True) -> dict:
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

    Returns {player_id: {"delta": float, "placement_bonus": bool, "carry_bonus": bool}}.
    """
    out = {}
    if not team_a_mmrs or not team_b_mmrs:
        return out
    if team_a_rounds == team_b_rounds:
        return {pid: {"delta": 0.0, "placement_bonus": False, "carry_bonus": False}
                for pid in list(team_a_mmrs) + list(team_b_mmrs)}

    placement_counts = placement_counts or {}

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
                if placement_counts.get(pid, 0) < PLACEMENT_MATCHES:
                    delta *= PLACEMENT_WIN_MULTIPLIER
                    placement_bonus = True
                if has_weak_mate and team_mmrs[pid] > opp_avg:
                    other_mmrs = [m for pid2, m in team_mmrs.items() if pid2 != pid]
                    if any(m < opp_avg for m in other_mmrs):
                        delta *= CARRY_WIN_MULTIPLIER
                        carry_bonus = True
            result[pid] = {"delta": delta, "placement_bonus": placement_bonus, "carry_bonus": carry_bonus}
        return result

    out.update(finalize(base_a, team_a_mmrs, avg_b, a_won))
    out.update(finalize(base_b, team_b_mmrs, avg_a, not a_won))
    return out


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
    await db.players.create_index("discord_id", unique=True, sparse=True)
    await db.pending_matches.create_index("id", unique=True)
    await db.link_requests.create_index("id", unique=True)
    await db.screenshots.create_index("id", unique=True)
    await db.champion_icons.create_index("champion")
    await db.ocr_feedback.create_index("created_at")

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
        # Migrate historical matches when a champion's role has changed
        current_roles = {c["name"]: c["role"] for c in CHAMPIONS}
        matches_cursor = db.matches.find({})
        async for m in matches_cursor:
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


async def recompute_season_elo(season_id: str):
    """Recompute elo_delta for every match in a season in chronological order."""
    season = await db.seasons.find_one({"id": season_id})
    matches = await db.matches.find({"season_id": season_id}).sort("played_at", 1).to_list(10000)
    if season and not is_ranked_season(season):
        for m in matches:
            upd = {
                "players": [{**p, "elo_delta": 0, "placement_bonus": False, "carry_bonus": False}
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
                                       bonuses=not m.get("legacy_scoring"))
        new_players = []
        for p in m["players"]:
            key = rating_key(p)
            info = deltas.get(key, {"delta": 0.0, "placement_bonus": False, "carry_bonus": False})
            d = info["delta"]
            new_players.append({
                **p,
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
    doc = await _insert_match(data)
    schedule_match_log(doc["id"])
    return doc


async def _insert_match(data: MatchCreate) -> dict:
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
    deltas = compute_player_deltas(ta_mmrs, tb_mmrs, data.team_a_rounds, data.team_b_rounds,
                                   placement_counts=placement_counts)
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
    }
    await db.matches.insert_one(doc)
    doc.pop("_id", None)
    schedule_leaderboard_push()
    return doc


@api_router.get("/matches")
async def list_matches(season_id: Optional[str] = None, player_id: Optional[str] = None):
    q = {}
    if season_id:
        q["season_id"] = season_id
    if player_id:
        q["players.player_id"] = player_id
    docs = await db.matches.find(q, {"_id": 0}).sort("played_at", -1).to_list(10000)
    return docs


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

    tracks = {p["player_id"]: p.get("mmr_track") for p in existing["players"]}  # keep merge history
    await db.matches.update_one({"id": mid}, {"$set": {
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
    if format and format in ("1v1", "2v2", "3v3"):
        q["format"] = format
    matches = await db.matches.find(q, {"_id": 0}).sort("played_at", 1).to_list(10000)

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
        result.append(s)
    result.sort(key=lambda x: (-x["mmr"], -x["wins"]))
    for i, r in enumerate(result):
        r["rank"] = i + 1
    return result


@api_router.get("/stats/player/{pid}")
async def player_stats(pid: str, season_id: Optional[str] = None):
    player = await db.players.find_one({"id": pid}, {"_id": 0})
    if not player:
        raise HTTPException(404, "Player not found")

    q = {"players.player_id": pid}
    if season_id:
        q["season_id"] = season_id
    matches = await db.matches.find(q, {"_id": 0}).sort("played_at", -1).to_list(10000)

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
    total_matches = len(matches)
    mmr = BASE_MMR
    peak = BASE_MMR
    mmr_history = []

    all_players = {p["id"]: p["name"] for p in await db.players.find({}, {"_id": 0}).to_list(1000)}

    # admin MMR adjustments, replayed in order with the matches
    aq = {"player_id": pid, "mmr_track": {"$exists": False}}
    if season_id:
        aq["season_id"] = season_id
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

    # Compute current streak from most recent matches backwards
    outcomes = []  # newest first
    for m in matches:  # matches sorted DESC by played_at
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
        "mmr_history": mmr_history,
        "recent_matches": matches[:10],
    }


@api_router.get("/stats/matrix")
async def matrix(season_id: Optional[str] = None):
    """Player vs Player matrix. Returns pairs w/ head-to-head record (as opponents)."""
    players = await db.players.find({}, {"_id": 0}).to_list(1000)
    q = {}
    if season_id:
        q["season_id"] = season_id
    matches = await db.matches.find(q, {"_id": 0}).to_list(10000)

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
    if season_id:
        q["season_id"] = season_id
    matches = await db.matches.find(q, {"_id": 0}).to_list(10000)

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
    if season_id:
        q["season_id"] = season_id
    matches = await db.matches.find(q, {"_id": 0}).sort("played_at", 1).to_list(10000)

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
    if season_id:
        q["season_id"] = season_id
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
        players[pid] = p

    ids = list(players.keys())
    best = None

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

        syn_a = role_synergy_score([players[i]["preferred_role"] for i in team_a])
        syn_b = role_synergy_score([players[i]["preferred_role"] for i in team_b])
        syn_score = (syn_a + syn_b) / 2

        if data.mode == "mmr":
            total = mmr_score
        elif data.mode == "synergy":
            total = syn_score
        else:
            total = 0.6 * mmr_score + 0.4 * syn_score

        entry = {
            "team_a": [players[i] for i in team_a],
            "team_b": [players[i] for i in team_b],
            "team_a_mmr": round(mmr_a, 2),
            "team_b_mmr": round(mmr_b, 2),
            "mmr_diff": round(mmr_diff, 2),
            "team_a_synergy": round(syn_a, 1),
            "team_b_synergy": round(syn_b, 1),
            "balance_score": round(total, 2),
            "win_probability_a": round(expected_score(mmr_a, mmr_b) * 100, 1),
        }
        if best is None or entry["balance_score"] > best["balance_score"]:
            best = entry

    return best


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


@api_router.post("/pending-matches")
async def create_pending_match(data: PendingMatchCreate, user: dict = Depends(admin_or_bot)):
    await check_and_close_expired_seasons()
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
    if data.ranked:
        season = await get_active_ranked_season()
        if not season:
            raise HTTPException(400, "There is no active ranked season")
    else:
        season = await ensure_unranked_season()

    doc = {
        "id": str(uuid.uuid4()),
        "status": "pending",
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
    match_in = MatchCreate(
        season_id=season_id,
        format=pm["format"],
        team_a_rounds=a_rounds,
        team_b_rounds=b_rounds,
        players=players,
        notes=pm.get("notes", "") if data.notes is None else data.notes,
        played_at=pm["played_at"],
    )
    match = await _insert_match(match_in)   # posted to the match log below, once MMR is final
    await db.matches.update_one({"id": match["id"]}, {"$set": {
        "source": pm.get("source"), "source_ref": pm.get("source_ref"), "map": pm.get("map"),
        "balance_mode": pm.get("balance_mode"), "reported_by": pm.get("reported_by"),
        "discord_match_id": pm.get("discord_match_id"),
        "confirmed_by": data.confirmed_by if user.get("role") == "bot" else None,
        "completed_by": "players" if user.get("role") == "bot" else (user.get("name") or user.get("email")),
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
_ocr_pool = ThreadPoolExecutor(max_workers=1)     # OCR is CPU-heavy: one at a time, off the event loop
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
    return await db.pending_matches.find_one({"id": pm["id"]}, {"_id": 0})


@api_router.post("/pending-matches/{pmid}/screenshot")
async def upload_pending_screenshot(pmid: str, file: UploadFile = File(...), uploaded_by: Optional[str] = None,
                                    user: dict = Depends(admin_or_bot)):
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
    meta = {"file": f"{pmid}{ext}", "uploaded_at": _now_iso(),
            "uploaded_by": uploaded_by or user.get("name") or user.get("email")}
    await db.screenshots.replace_one({"id": pmid}, {
        "id": pmid, "data": data, "content_type": types[ext], "size": len(data), **meta,
    }, upsert=True)
    await db.pending_matches.update_one({"id": pmid}, {"$set": {"screenshot": meta}})
    pm["screenshot"] = meta
    return await _parse_into_pending(pm)


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


@api_router.get("/matches/{mid}/screenshot")
async def get_match_screenshot(mid: str):
    m = await db.matches.find_one({"id": mid}, {"_id": 0})
    return await _screenshot_response((m or {}).get("screenshot_id"))


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


async def _post_match_log(mid: str):
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
                await _post_match_log(mid)
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
async def export_matches_csv(season_id: Optional[str] = None, user: dict = Depends(admin_required)):
    q = {}
    if season_id:
        q["season_id"] = season_id
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
