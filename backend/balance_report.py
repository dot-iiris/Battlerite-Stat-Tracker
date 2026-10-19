"""BR Stats - how well does MMR predict results?  (read-only report)

Used by GET /api/reports/mmr-prediction (report(env) returns the text), or run on its own:
    python balance_report.py /opt/brstats/backend.env
Nothing in the database is changed.
"""
import math
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from pymongo import MongoClient

BASE = 1200.0
EXPERIENCED = 5          # "settled" = every player had at least this many earlier ranked games that season
PRIOR_GAMES = 4          # win-rate predictor: each record counts as if it had 4 extra games at 50%


def load_env(path):
    env = {}
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def when(v):
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def expected(a, b):
    return 1.0 / (1.0 + 10 ** ((b - a) / 400.0))


def wilson(k, n, z=1.96):
    if not n:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def pct(x):
    return f"{100 * x:.0f}%"


def summarize(recs, key, title, lines):
    """recs: list of dicts with key -> P(Team A wins) and 'a_won'."""
    rows = [(r[key], r["a_won"]) for r in recs if r.get(key) is not None]
    lines.append(f"\n## {title}")
    if not rows:
        lines.append("  no matches")
        return
    n = len(rows)
    brier = sum((p - (1.0 if y else 0.0)) ** 2 for p, y in rows) / n
    fav = [(max(p, 1 - p), (p > 0.5) == y) for p, y in rows if abs(p - 0.5) > 1e-9]
    lines.append(f"  matches: {n}   (coin-flip Brier = 0.250, lower is better)   Brier: {brier:.3f}")
    if fav:
        k = sum(1 for _, w in fav if w)
        lo, hi = wilson(k, len(fav))
        mean_pred = sum(p for p, _ in fav) / len(fav)
        lines.append(f"  favourite won {k}/{len(fav)} = {pct(k / len(fav))}  (95% range {pct(lo)}-{pct(hi)})"
                     f"   predicted on average: {pct(mean_pred)}")
        for lo_b, hi_b in ((0.5, 0.55), (0.55, 0.65), (0.65, 1.01)):
            b = [(p, w) for p, w in fav if lo_b <= p < hi_b]
            if b:
                kk = sum(1 for _, w in b if w)
                l2, h2 = wilson(kk, len(b))
                lines.append(f"    predicted {pct(lo_b)}-{pct(min(hi_b, 1))}: {len(b):3d} matches, "
                             f"favourite won {pct(kk / len(b))} (range {pct(l2)}-{pct(h2)}), "
                             f"predicted {pct(sum(p for p, _ in b) / len(b))}")


def report(env):
    """The report as text. env needs MONGO_URL, and may hold DB_NAME and UNPROVEN_ROLE_PENALTY."""
    client = MongoClient(env["MONGO_URL"])
    try:
        return _report(env, client[env.get("DB_NAME") or "brstats"])
    finally:
        client.close()


def _report(env, db):
    seasons = {s["id"]: s for s in db.seasons.find({}, {"_id": 0})}
    ranked = lambda sid: sid in seasons and seasons[sid].get("ranked", True) is not False
    roles = {c["name"]: c.get("role") for c in db.champions.find({}, {"_id": 0, "name": 1, "role": 1})}
    names = {p["id"]: p["name"] for p in db.players.find({}, {"_id": 0, "id": 1, "name": 1})}
    matches = sorted(db.matches.find({}, {"_id": 0}), key=lambda m: when(m.get("played_at")))

    # replay ranked seasons: earlier games per player, and each player's latest (= current) MMR
    prior, final, last_season = defaultdict(int), {}, {}
    pre = {}   # match id -> min earlier ranked games of its players that season
    for m in matches:
        if not ranked(m["season_id"]):
            continue
        sid = m["season_id"]
        pre[m["id"]] = min(prior[(sid, p["player_id"])] for p in m["players"])
        for p in m["players"]:
            if p.get("mmr_track"):
                continue
            prior[(sid, p["player_id"])] += 1
            if p.get("mmr_before") is not None:
                final[(sid, p["player_id"])] = p["mmr_before"] + (p.get("elo_delta") or 0)
            last_season[p["player_id"]] = sid

    # leave-one-out win records over every match (ranked and unranked)
    rec = defaultdict(lambda: [0, 0])   # player -> [wins, games]
    for m in matches:
        for p in m["players"]:
            rec[p["player_id"]][1] += 1
            rec[p["player_id"]][0] += p["team"] == m.get("winner_team")

    def loo_strength(m, team):
        out = []
        for p in m["players"]:
            if p["team"] != team:
                continue
            w, g = rec[p["player_id"]]
            won = p["team"] == m.get("winner_team")
            out.append((w - won + PRIOR_GAMES / 2) / (g - 1 + PRIOR_GAMES))
        return sum(out) / len(out)

    def hindsight(m, team):
        vals = []
        for p in m["players"]:
            if p["team"] != team:
                continue
            sid = m["season_id"] if ranked(m["season_id"]) else last_season.get(p["player_id"])
            vals.append(final.get((sid, p["player_id"]), BASE))
        return sum(vals) / len(vals)

    recs = []
    for m in matches:
        if m.get("winner_team") not in ("A", "B"):
            continue
        r = {"id": m["id"], "format": m.get("format"), "ranked": ranked(m["season_id"]),
             "a_won": m["winner_team"] == "A", "min_prior": pre.get(m["id"])}
        a, b = m.get("team_a_mmr_before"), m.get("team_b_mmr_before")
        if r["ranked"] and a is not None and b is not None:
            r["at_time"] = expected(a, b)
            r["gap_at_time"] = abs(a - b)
        ha, hb = hindsight(m, "A"), hindsight(m, "B")
        r["hindsight"] = expected(ha, hb)
        r["gap_hindsight"] = abs(ha - hb)
        sa, sb = loo_strength(m, "A"), loo_strength(m, "B")
        logit = lambda x: math.log(x / (1 - x))
        r["winrate"] = 1 / (1 + math.exp(-(logit(sa) - logit(sb)) * 1.0))
        for t in "AB":
            rs = [roles.get(p["champion"]) for p in m["players"] if p["team"] == t]
            r[f"div_{t}"] = len(set(rs))
            r[f"sup_{t}"] = "Support" in rs
        recs.append(r)

    L = ["BR Stats - balance report", "=" * 26,
         f"Matches with a result: {len(recs)}  (ranked {sum(r['ranked'] for r in recs)}, "
         f"unranked {sum(not r['ranked'] for r in recs)};  2v2 {sum(r['format'] == '2v2' for r in recs)}, "
         f"3v3 {sum(r['format'] == '3v3' for r in recs)})"]

    ranked_recs = [r for r in recs if r.get("at_time") is not None]
    summarize(ranked_recs, "at_time", "1. Prediction at the time (ranked, MMR when the match was played)", L)
    for fmt in ("2v2", "3v3"):
        summarize([r for r in ranked_recs if r["format"] == fmt], "at_time", f"1{'a' if fmt == '2v2' else 'b'}. ... {fmt} only", L)
    settled = [r for r in ranked_recs if (r["min_prior"] or 0) >= EXPERIENCED]
    newer = [r for r in ranked_recs if (r["min_prior"] or 0) < EXPERIENCED]
    summarize(settled, "at_time", f"2a. At the time, everyone had >= {EXPERIENCED} earlier ranked games", L)
    summarize(newer, "at_time", f"2b. At the time, someone had < {EXPERIENCED} earlier ranked games", L)
    summarize(ranked_recs, "hindsight", "3a. Hindsight: same ranked matches, re-scored with today's MMR", L)
    summarize(recs, "hindsight", "3b. Hindsight: every match incl. unranked, today's MMR", L)
    summarize(recs, "winrate", "4. No MMR: players' win rates in their other matches (sanity check)", L)

    L.append("\n## 5. How even were the teams?")
    g1 = [r["gap_at_time"] for r in ranked_recs]
    g2 = [r["gap_hindsight"] for r in ranked_recs]
    if g1:
        L.append(f"  ranked: average MMR gap when made {sum(g1) / len(g1):.0f}, "
                 f"by today's MMR {sum(g2) / len(g2):.0f}")
        big = sum(1 for g in g2 if g >= 100)
        L.append(f"  ranked matches that look 100+ MMR lopsided by today's MMR: {big}/{len(g2)}")

    L.append("\n## 6. Roles (champions actually played)")
    div = [r for r in recs if r["div_A"] != r["div_B"]]
    if div:
        k = sum(1 for r in div if (r["div_A"] > r["div_B"]) == r["a_won"])
        lo, hi = wilson(k, len(div))
        L.append(f"  team with more different roles won {k}/{len(div)} = {pct(k / len(div))} (range {pct(lo)}-{pct(hi)})")
    sup = [r for r in recs if r["sup_A"] != r["sup_B"]]
    if sup:
        k = sum(1 for r in sup if r["sup_A"] == r["a_won"])
        lo, hi = wilson(k, len(sup))
        L.append(f"  only one team had a Support: that team won {k}/{len(sup)} = {pct(k / len(sup))} (range {pct(lo)}-{pct(hi)})")

    # 7. hidden role MMR, exactly as matchmaking works it out
    K = 24.0
    try:
        src = Path(__file__).with_name("server.py").read_text(encoding="utf-8")
        K = float(re.search(r"^K_FACTOR\s*=\s*([\d.]+)", src, re.M).group(1))
    except Exception:
        pass
    point = 1600 / math.log(10) / K
    penalty = float(env.get("UNPROVEN_ROLE_PENALTY") or 50)
    saved = db.admin_settings.find_one({"key": "UNPROVEN_ROLE_PENALTY"})
    if saved and saved.get("value") is not None:
        penalty = float(saved["value"])
    active = next((sid for sid, s_ in seasons.items() if s_.get("active") and ranked(sid)), None)
    deltas = defaultdict(lambda: defaultdict(list))   # player -> role -> [elo_delta] (ranked, all seasons)
    for m in matches:
        if not ranked(m["season_id"]):
            continue
        for p in m["players"]:
            if p.get("mmr_track") or p.get("elo_delta") is None:
                continue
            r = p.get("role") or roles.get(p.get("champion"))
            if r in ("Melee", "Ranged", "Support"):
                deltas[p["player_id"]][r].append(p["elo_delta"])
    L.append("\n## 7. Hidden role MMR (what matchmaking uses)")
    L.append(f"  general MMR = current season; role offset = (avg MMR change in role - avg overall) x {point:.0f},")
    L.append(f"  x games/(games+15), plus an unproven-role penalty of -{penalty:g} for roles under 30% of their games")
    L.append(f"  (fading as they play them), capped at +-150.   Role MMR = general + offset.")
    L.append(f"  {'player':16s} {'general':>7s}   {'Melee':>16s}   {'Ranged':>16s}   {'Support':>16s}")
    rows = []
    for pid, by in deltas.items():
        every = [d for ds in by.values() for d in ds]
        usual = sum(every) / len(every)
        gen = final.get((active, pid), BASE)
        cells = []
        for r in ("Melee", "Ranged", "Support"):
            ds = by.get(r, [])
            trust = len(ds) / (len(ds) + 15)
            prior = -penalty * (1 - min(1.0, len(ds) / len(every) / 0.3))
            raw = (sum(ds) / len(ds) - usual) * point if ds else 0.0
            off = max(-150.0, min(150.0, raw * trust + prior * (1 - trust)))
            cells.append(f"{gen + off:5.0f} ({off:+4.0f}, {len(ds):2d}g)")
        rows.append((names.get(pid, pid), gen, cells))
    for name, gen, cells in sorted(rows, key=lambda x: -x[1]):
        L.append(f"  {name[:16]:16s} {gen:7.0f}   " + "   ".join(cells))

    L.append("\nNotes: 'range' is a 95% margin of error - with few matches it is wide. Hindsight scores use MMR")
    L.append("that already includes each match's own result, so they flatter MMR slightly.")
    return "\n".join(L)


def main():
    print(report(load_env(sys.argv[1] if len(sys.argv) > 1 else "/opt/brstats/backend.env")))


if __name__ == "__main__":
    main()
