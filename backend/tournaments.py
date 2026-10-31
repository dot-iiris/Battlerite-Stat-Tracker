"""Tournament formats: league schedules (round robin, Swiss, groups, player rotation), playoff brackets
(single or double elimination, with or without a grand final reset), series results and standings.

Pure functions - no database. The server stores a tournament's matches as made here, works out each
series from the games logged for it, and calls resolve() to fill the bracket from those results, so a
result edited or deleted later moves through the bracket by itself.
"""
from __future__ import annotations

import itertools
import math
import random
from collections import Counter
from typing import Callable, Dict, List, Optional

BYE = "BYE"


def wins_needed(best_of: int) -> int:
    return best_of // 2 + 1


# ------------------------------------------------------------------ league
def round_robin(team_ids: List[str], best_of: int, group: Optional[str] = None) -> List[dict]:
    """Every team plays every other once (circle method); an odd team count gives each team a rest round."""
    teams: List[Optional[str]] = list(team_ids)
    if len(teams) % 2:
        teams.append(None)
    n, out = len(teams), []
    for r in range(n - 1):
        for i in range(n // 2):
            a, b = teams[i], teams[n - 1 - i]
            if a and b:
                out.append({"id": f"L-{group or 'X'}-{r + 1}-{i + 1}", "stage": "league", "group": group,
                            "round": r + 1, "team1": a, "team2": b, "best_of": best_of})
        teams = [teams[0], teams[-1]] + teams[1:-1]
    return out


def split_groups(team_ids: List[str], n_groups: int) -> Dict[str, List[str]]:
    """Teams in seed order, snaked into groups A, B, C... so every group gets a fair spread."""
    names = [chr(ord("A") + g) for g in range(n_groups)]
    groups = {g: [] for g in names}
    for i, t in enumerate(team_ids):
        r, pos = divmod(i, n_groups)
        groups[names[pos if r % 2 == 0 else n_groups - 1 - pos]].append(t)
    return groups


def swiss_round(team_ids: List[str], round_no: int, best_of: int, table: Optional[List[dict]] = None,
                played: Optional[set] = None, had_bye: Optional[set] = None) -> List[dict]:
    """One Swiss round. Round 1: top half of the seeds against the bottom half. Later rounds: teams on
    the same record play each other, avoiding rematches where possible. With an odd count the lowest
    team without a bye yet gets one (it counts as a win)."""
    played, had_bye = played or set(), had_bye or set()
    if round_no == 1 or not table:
        order = list(team_ids)
    else:
        order = [row["team"] for row in table]          # already sorted best first
    bye = None
    if len(order) % 2:
        bye = next((t for t in reversed(order) if t not in had_bye), order[-1])
        order = [t for t in order if t != bye]
    if round_no == 1:
        half = len(order) // 2
        pairs = list(zip(order[:half], order[half:]))
    else:
        pairs = _pair_without_rematches(order, played) or [(order[i], order[i + 1]) for i in range(0, len(order), 2)]
    out = [{"id": f"L-S-{round_no}-{i + 1}", "stage": "league", "group": None, "round": round_no,
            "team1": a, "team2": b, "best_of": best_of} for i, (a, b) in enumerate(pairs)]
    if bye:
        out.append({"id": f"L-S-{round_no}-bye", "stage": "league", "group": None, "round": round_no,
                    "team1": bye, "team2": None, "best_of": best_of, "bye": True})
    return out


def match_cost(team1: List[str], team2: List[str], partners: Counter, opponents: Counter,
               mmr: Optional[Dict[str, float]]) -> float:
    """How bad one rotation match would be - lower is better. partners / opponents count how often each
    pair of players (a frozenset) has already been on the same / the other team in earlier rounds.
    mmr is each player's MMR when the tournament balances by MMR, else None."""
    # squared, so a third time together costs more than two pairs meeting twice; partners count double
    cost = sum(2 * partners[frozenset(x)] ** 2 for t in (team1, team2) for x in itertools.combinations(t, 2))
    cost += sum(opponents[frozenset((a, b))] ** 2 for a in team1 for b in team2)
    if mmr:   # 50 MMR of difference between the team averages ~ one repeat partner
        gap = abs(sum(mmr[p] for p in team1) / len(team1) - sum(mmr[p] for p in team2) / len(team2))
        cost += gap / 25
    return cost


def _best_split(group: List[str], size: int, partners: Counter, opponents: Counter,
                mmr: Optional[Dict[str, float]]) -> tuple:
    """The cheapest way to split 2 x size players into two teams -> (cost, team1, team2)."""
    first, rest = group[0], group[1:]
    best = None
    for mates in itertools.combinations(rest, size - 1):   # fixing `first` in team 1 skips mirror splits
        t1 = [first, *mates]
        t2 = [p for p in rest if p not in mates]
        cost = match_cost(t1, t2, partners, opponents, mmr)
        if best is None or cost < best[0]:
            best = (cost, t1, t2)
    return best


def rotation_schedule(player_ids: List[str], size: int, rounds: int, best_of: int,
                      mmr: Optional[Dict[str, float]] = None, tries: int = 300,
                      rng: Optional[random.Random] = None) -> tuple:
    """A player rotation league: every round the players are put into new teams, so partners and
    opponents repeat as little as possible (and, with mmr, the teams are even). When the players don't
    fill whole matches, the ones who've sat out least sit out. -> (teams, matches, rests by round)"""
    rng = rng or random.Random()
    per_match = 2 * size
    n_matches = len(player_ids) // per_match
    partners, opponents = Counter(), Counter()
    rested = {p: 0 for p in player_ids}
    teams, matches, rests = [], [], {}
    for r in range(1, rounds + 1):
        order = sorted(player_ids, key=lambda p: (rested[p], rng.random()))
        sit = order[:len(player_ids) - n_matches * per_match]
        playing = order[len(sit):]
        best = None
        for _ in range(tries):
            rng.shuffle(playing)
            splits = [_best_split(playing[i:i + per_match], size, partners, opponents, mmr)
                      for i in range(0, len(playing), per_match)]
            total = sum(s[0] for s in splits)
            if best is None or total < best[0]:
                best = (total, splits)
        for i, (_, t1, t2) in enumerate(best[1], 1):
            a, b = f"R{r}-{i}a", f"R{r}-{i}b"
            teams += [{"id": a, "player_ids": t1, "round": r}, {"id": b, "player_ids": t2, "round": r}]
            matches.append({"id": f"L-R-{r}-{i}", "stage": "league", "group": None, "round": r,
                            "team1": a, "team2": b, "best_of": best_of})
            for t in (t1, t2):
                partners.update(frozenset(x) for x in itertools.combinations(t, 2))
            opponents.update(frozenset((x, y)) for x in t1 for y in t2)
        for p in sit:
            rested[p] += 1
        rests[str(r)] = sit
    return teams, matches, rests


def _pair_without_rematches(order: List[str], played: set) -> Optional[List[tuple]]:
    if not order:
        return []
    first = order[0]
    for j in range(1, len(order)):
        other = order[j]
        if frozenset((first, other)) in played:
            continue
        rest = _pair_without_rematches(order[1:j] + order[j + 1:], played)
        if rest is not None:
            return [(first, other)] + rest
    return None


# ------------------------------------------------------------------ playoffs
def bracket_order(size: int) -> List[int]:
    """Seed positions for a bracket of `size` (a power of 2): 1 v size, and the top seeds meet last."""
    order = [1]
    while len(order) < size:
        m = len(order) * 2
        order = [x for s in order for x in (s, m + 1 - s)]
    return order


def build_playoffs(n_teams: int, kind: str = "single", grand_reset: bool = True, best_of: int = 1,
                   semis_best_of: Optional[int] = None, final_best_of: Optional[int] = None) -> List[dict]:
    """The bracket's matches, in an order where every match comes after the ones it takes teams from.
    Sources: {"seed": n}, {"winner": match id} or {"loser": match id}."""
    semis_best_of = semis_best_of or best_of
    final_best_of = final_best_of or semis_best_of
    size = max(2, 1 << math.ceil(math.log2(max(2, n_teams))))
    k = int(math.log2(size))
    order = bracket_order(size)
    out, wb = [], []

    def add(mid, bracket, rnd, idx, s1, s2, bo, label):
        out.append({"id": mid, "stage": "playoffs", "bracket": bracket, "round": rnd, "index": idx,
                    "src1": s1, "src2": s2, "best_of": bo, "label": label})
        return mid

    def wb_label(r):
        left = k - r
        if left == 0:
            return "Final" if kind == "single" else "Winners Final"
        if left == 1:
            return "Semifinals" if kind == "single" else "Winners Semifinals"
        if left == 2:
            return "Quarterfinals" if kind == "single" else "Winners Quarterfinals"
        return f"{'Round' if kind == 'single' else 'Winners Round'} {r}"

    for r in range(1, k + 1):
        bo = final_best_of if r == k and kind == "single" else semis_best_of if r >= k - 1 else best_of
        cur = []
        for i in range(size >> r):
            if r == 1:
                s1, s2 = {"seed": order[2 * i]}, {"seed": order[2 * i + 1]}
            else:
                s1, s2 = {"winner": wb[r - 2][2 * i]}, {"winner": wb[r - 2][2 * i + 1]}
            cur.append(add(f"P-W{r}-{i + 1}", "W", r, i, s1, s2, bo, wb_label(r)))
        wb.append(cur)
    if kind != "double":
        return out

    lb_round, prev = 0, []
    if k >= 2:
        lb_round = 1
        prev = [add(f"P-L1-{i + 1}", "L", 1, i, {"loser": wb[0][2 * i]}, {"loser": wb[0][2 * i + 1]}, best_of,
                    "Losers Round 1") for i in range(size // 4)]
        for j in range(2, k + 1):
            lb_round += 1
            drops = wb[j - 1]
            n = len(prev)
            last = j == k
            label = "Losers Final" if last else f"Losers Round {lb_round}"
            prev = [add(f"P-L{lb_round}-{i + 1}", "L", lb_round, i, {"winner": prev[i]},
                        {"loser": drops[i if j % 2 == 0 else n - 1 - i]}, semis_best_of if last else best_of, label)
                    for i in range(n)]
            if not last:
                lb_round += 1
                prev = [add(f"P-L{lb_round}-{i + 1}", "L", lb_round, i, {"winner": prev[2 * i]},
                            {"winner": prev[2 * i + 1]}, best_of, f"Losers Round {lb_round}")
                        for i in range(len(prev) // 2)]
    lb_champ = {"winner": prev[0]} if prev else {"loser": wb[-1][0]}
    add("P-GF", "GF", 1, 0, {"winner": wb[-1][0]}, lb_champ, final_best_of, "Grand Final")
    if grand_reset:
        add("P-GF2", "GF", 2, 0, {"winner": "P-GF"}, {"loser": "P-GF"}, final_best_of, "Grand Final Reset")
    return out


# ------------------------------------------------------------------ results
def series(m: dict, games: List[dict], forfeit: Optional[str]) -> dict:
    """A match's state from its games ([{"winner": team id, "rounds": {team id: rounds won}}])."""
    t1, t2 = m.get("team1"), m.get("team2")
    st = {"team1": t1, "team2": t2, "wins1": 0, "wins2": 0, "rounds1": 0, "rounds2": 0, "games": len(games),
          "winner": None, "loser": None, "done": False, "status": "waiting"}
    if m.get("bye"):
        st.update(winner=t1, loser=None, done=True, status="bye")
        return st
    if t1 == BYE or t2 == BYE:
        if t1 == BYE and t2 == BYE:
            st.update(winner=BYE, loser=BYE, done=True, status="bye")
        elif t1 and t2:
            real = t2 if t1 == BYE else t1
            st.update(winner=real, loser=BYE, done=True, status="bye")
        return st
    if not t1 or not t2:
        return st
    for g in games:
        st["wins1"] += g["winner"] == t1
        st["wins2"] += g["winner"] == t2
        st["rounds1"] += g["rounds"].get(t1, 0)
        st["rounds2"] += g["rounds"].get(t2, 0)
    need = wins_needed(m["best_of"])
    if forfeit in (t1, t2):
        st.update(winner=forfeit, loser=t2 if forfeit == t1 else t1, done=True, status="forfeit")
    elif st["wins1"] >= need or st["wins2"] >= need:
        w = t1 if st["wins1"] >= need else t2
        st.update(winner=w, loser=t2 if w == t1 else t1, done=True, status="done")
    else:
        st["status"] = "live" if games else "ready"
    return st


def resolve(matches: List[dict], seeds: List[str], games_of: Callable[[str], List[dict]],
            forfeits: Dict[str, str]) -> Dict[str, dict]:
    """Every match's teams and state, filling the bracket from the results so far."""
    out: Dict[str, dict] = {}

    def team(src):
        if "seed" in src:
            n = src["seed"]
            return seeds[n - 1] if n <= len(seeds) else BYE
        ref = out.get(src.get("winner") or src.get("loser"))
        if not ref or not ref["done"]:
            return None
        return ref["winner"] if "winner" in src else ref["loser"]

    for m in matches:
        if m["stage"] == "league":
            out[m["id"]] = series(m, games_of(m["id"]), forfeits.get(m["id"]))
            continue
        filled = {**m, "team1": team(m["src1"]), "team2": team(m["src2"])}
        if m["id"] == "P-GF2":
            gf = out.get("P-GF")
            if not gf or not gf["done"]:
                out[m["id"]] = {**series({**filled, "team1": None, "team2": None}, [], None), "status": "waiting"}
                continue
            if gf["winner"] != gf["team2"]:   # the winners-bracket team won: no reset needed
                out[m["id"]] = {**series({**filled, "team1": None, "team2": None}, [], None), "status": "not needed"}
                continue
            filled.update(team1=gf["team1"], team2=gf["team2"])
        out[m["id"]] = series(filled, games_of(m["id"]), forfeits.get(m["id"]))
    return out


def champion(matches: List[dict], res: Dict[str, dict]) -> Optional[str]:
    po = [m for m in matches if m["stage"] == "playoffs"]
    if not po:
        return None
    if any(m["id"] == "P-GF" for m in po):
        gf, gf2 = res.get("P-GF"), res.get("P-GF2")
        if gf2 and gf2["status"] not in ("waiting", "not needed"):
            return gf2["winner"] if gf2["done"] else None
        return gf["winner"] if gf and gf["done"] and (not gf2 or gf2["status"] == "not needed") else None
    final = po[-1]
    r = res.get(final["id"])
    return r["winner"] if r and r["done"] else None


def standings(team_ids: List[str], league: List[dict], res: Dict[str, dict], seed_of: Dict[str, int],
              swiss: bool = False) -> List[dict]:
    """League table: series wins first, then (Swiss) opponents' wins, game difference, round difference, seed."""
    rows = {t: {"team": t, "played": 0, "wins": 0, "losses": 0, "game_wins": 0, "game_losses": 0,
                "rounds_won": 0, "rounds_lost": 0, "opponents": [], "byes": 0} for t in team_ids}
    for m in league:
        r = res.get(m["id"])
        if not r or not r["done"]:
            continue
        if r["status"] == "bye":
            if m["team1"] in rows:
                rows[m["team1"]]["wins"] += 1
                rows[m["team1"]]["byes"] += 1
            continue
        t1, t2 = r["team1"], r["team2"]
        if t1 not in rows or t2 not in rows:
            continue
        for me, other, gw, gl, rw, rl in ((t1, t2, r["wins1"], r["wins2"], r["rounds1"], r["rounds2"]),
                                          (t2, t1, r["wins2"], r["wins1"], r["rounds2"], r["rounds1"])):
            row = rows[me]
            row["played"] += 1
            row["wins" if r["winner"] == me else "losses"] += 1
            row["game_wins"] += gw
            row["game_losses"] += gl
            row["rounds_won"] += rw
            row["rounds_lost"] += rl
            row["opponents"].append(other)
    for row in rows.values():
        row["buchholz"] = sum(rows[o]["wins"] for o in row["opponents"])
        row["game_diff"] = row["game_wins"] - row["game_losses"]
        row["round_diff"] = row["rounds_won"] - row["rounds_lost"]
    key = lambda r: (-r["wins"], -(r["buchholz"] if swiss else 0), -r["game_diff"], -r["round_diff"],
                     seed_of.get(r["team"], 999))
    out = sorted(rows.values(), key=key)
    for i, row in enumerate(out, 1):
        row["rank"] = i
    return out


def player_standings(player_ids: List[str], teams: List[dict], league: List[dict], res: Dict[str, dict],
                     rests: Dict[str, List[str]]) -> List[dict]:
    """Player rotation table: a player gets their team's result. Series wins first, then fewer losses
    (so sitting out doesn't count against you), round difference, game difference, roster order."""
    members = {x["id"]: x["player_ids"] for x in teams}
    rows = {p: {"team": p, "played": 0, "wins": 0, "losses": 0, "game_wins": 0, "game_losses": 0,
                "rounds_won": 0, "rounds_lost": 0, "rests": 0} for p in player_ids}
    for sit in rests.values():
        for p in sit:
            if p in rows:
                rows[p]["rests"] += 1
    for m in league:
        r = res.get(m["id"])
        if not r or not r["done"] or r["status"] == "bye":
            continue
        for me, gw, gl, rw, rl in ((r["team1"], r["wins1"], r["wins2"], r["rounds1"], r["rounds2"]),
                                   (r["team2"], r["wins2"], r["wins1"], r["rounds2"], r["rounds1"])):
            for p in members.get(me, []):
                row = rows.get(p)
                if not row:
                    continue
                row["played"] += 1
                row["wins" if r["winner"] == me else "losses"] += 1
                row["game_wins"] += gw
                row["game_losses"] += gl
                row["rounds_won"] += rw
                row["rounds_lost"] += rl
    order = {p: i for i, p in enumerate(player_ids)}
    for row in rows.values():
        row["game_diff"] = row["game_wins"] - row["game_losses"]
        row["round_diff"] = row["rounds_won"] - row["rounds_lost"]
    out = sorted(rows.values(), key=lambda r: (-r["wins"], r["losses"], -r["round_diff"], -r["game_diff"],
                                               order[r["team"]]))
    for i, row in enumerate(out, 1):
        row["rank"] = i
    return out
