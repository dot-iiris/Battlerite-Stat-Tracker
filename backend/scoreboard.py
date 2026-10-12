"""Read a Battlerite end-of-match scoreboard screenshot.

- Text (names, stats, champion labels) is read with local OCR (RapidOCR - no
  account or API key). Positions come from the on-screen headings ("Your Team",
  "Damage", ...) so any resolution works.
- Champions are also recognised from their portrait icons, using reference
  icons saved every time an admin confirms a match (it gets better over time).
- Round score comes from the lit orbs either side of the top-centre timer.

Everything here is a *suggestion*: an admin checks every match on the
website's Pending page before it is logged.
"""
from __future__ import annotations

import difflib
import os
import re
from typing import Dict, List, Optional

STAT_COLUMNS = ("score", "damage", "protection", "disables")
ICON_SIZE = 20             # reference icons are compared at 20x20 pixels
ICON_MATCH_MAX = 0.12      # mean colour difference (0-1) to accept an icon match
ICON_MATCH_SURE = 0.08     # below this the portrait wins over the OCR'd label

_ocr = None


def _get_ocr():
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR  # optional dependency, loaded on first use
        _ocr = RapidOCR()
    return _ocr


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def similarity(a: str, b: str) -> float:
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _int(text: str) -> Optional[int]:
    digits = re.sub(r"[^0-9]", "", text.replace("O", "0").replace("o", "0"))
    return int(digits) if digits else None


# ------------------------------------------------------------------ OCR
def _tokens(img, f: float) -> List[dict]:
    """OCR the centre of the screen (where the scoreboard is) at zoom f.
    Coordinates are mapped back to the full image."""
    import cv2

    h, w = img.shape[:2]
    x0, y0 = int(w * 0.18), int(h * 0.12)
    crop = img[y0:int(h * 0.88), x0:int(w * 0.82)]
    if f != 1.0:
        crop = cv2.resize(crop, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    result, _ = _get_ocr()(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
    out = []
    for box, text, _conf in result or []:
        xs = [p[0] / f + x0 for p in box]
        ys = [p[1] / f + y0 for p in box]
        out.append({"text": text.strip(), "x": sum(xs) / 4, "y": sum(ys) / 4,
                    "x0": min(xs), "x1": max(xs), "h": max(ys) - min(ys)})
    return out


def _timer_x(img) -> Optional[float]:
    """x position of the round timer (e.g. 01:30) - the orbs sit either side of it."""
    import cv2

    h, w = img.shape[:2]
    x0 = int(w * 0.35)
    band = img[0:int(h * 0.06), x0:int(w * 0.65)]
    f = max(1.0, 2400.0 / h)
    if f > 1.0:
        band = cv2.resize(band, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    result, _ = _get_ocr()(cv2.cvtColor(band, cv2.COLOR_BGR2RGB))
    for box, text, _conf in result or []:
        if re.fullmatch(r"\d{1,2}:\d{2}", text.strip()):
            return sum(p[0] for p in box) / 4 / f + x0
    return None


# ------------------------------------------------------------------ round orbs
def _count_orbs(img, timer_x: Optional[float]) -> Dict[str, int]:
    """Count lit blue (your team) and red (enemy team) round orbs in the top-centre HUD."""
    import cv2
    import numpy as np

    h, w = img.shape[:2]
    x_lo, x_hi = int(w * 0.30), int(w * 0.70)
    hsv = cv2.cvtColor(img[0:int(h * 0.06), x_lo:x_hi], cv2.COLOR_BGR2HSV)
    ranges = {
        "blue": [((95, 120, 120), (130, 255, 255))],
        "red": [((0, 120, 120), (10, 255, 255)), ((170, 120, 120), (180, 255, 255))],
    }
    min_d, max_d = w * 0.006, w * 0.03
    centre = (timer_x - x_lo) if timer_x else (x_hi - x_lo) / 2
    counts = {}
    for colour, rs in ranges.items():
        mask = None
        for lo, hi in rs:
            m = cv2.inRange(hsv, np.array(lo), np.array(hi))
            mask = m if mask is None else cv2.bitwise_or(mask, m)
        n, _, stats, cents = cv2.connectedComponentsWithStats(mask)
        found = 0
        for i in range(1, n):
            bw, bh, area = stats[i][2], stats[i][3], stats[i][4]
            if not (min_d <= bw <= max_d and min_d <= bh <= max_d):
                continue
            if not 0.6 <= bw / bh <= 1.6 or area < 0.35 * bw * bh:
                continue
            cx = cents[i][0]
            if (colour == "blue" and cx < centre) or (colour == "red" and cx > centre):
                found += 1
        counts[colour] = found
    return counts


# ------------------------------------------------------------------ champion icons
def crop_icon(img, box: List[int]):
    """Inner part of a champion portrait, shrunk to ICON_SIZE x ICON_SIZE."""
    import cv2

    x0, y0, x1, y1 = box
    pad_x, pad_y = (x1 - x0) * 0.1, (y1 - y0) * 0.1
    c = img[max(0, int(y0 + pad_y)):int(y1 - pad_y), max(0, int(x0 + pad_x)):int(x1 - pad_x)]
    if c.size == 0:
        return None
    return cv2.resize(c, (ICON_SIZE, ICON_SIZE), interpolation=cv2.INTER_AREA)


def load_icon_refs(*dirs: str) -> Dict[str, list]:
    """{champion: [icon arrays]} from folders laid out as <dir>/<Champion>/*.png."""
    import cv2

    refs: Dict[str, list] = {}
    for d in dirs:
        if not d or not os.path.isdir(d):
            continue
        for champ in os.listdir(d):
            cdir = os.path.join(d, champ)
            if not os.path.isdir(cdir):
                continue
            for f in os.listdir(cdir):
                im = cv2.imread(os.path.join(cdir, f))
                if im is not None:
                    refs.setdefault(champ, []).append(cv2.resize(im, (ICON_SIZE, ICON_SIZE)).astype("float32"))
    return refs


def match_icon(icon, refs: Dict[str, list]):
    import numpy as np

    if icon is None or not refs:
        return None, None
    q = icon.astype("float32")
    best, best_d = None, 1.0
    for champ, arrs in refs.items():
        d = min(float(np.mean(np.abs(q - a))) / 255.0 for a in arrs)
        if d < best_d:
            best, best_d = champ, d
    return (best, round(best_d, 3)) if best_d <= ICON_MATCH_MAX else (None, round(best_d, 3))


# ------------------------------------------------------------------ table reading
def _columns(toks: List[dict], hdr: dict, h: int) -> Dict[str, float]:
    tol = max(hdr["h"], h * 0.008)
    cols = {}
    for c in STAT_COLUMNS:
        t = next((t for t in toks if _norm(t["text"]) == c and abs(t["y"] - hdr["y"]) < tol), None)
        if t:
            cols[c] = t["x"]
    return cols


def _parse_pass(img, toks: List[dict], champion_names: List[str]) -> dict:
    h, w = img.shape[:2]

    def find(label: str) -> Optional[dict]:
        cands = [t for t in toks if _norm(t["text"]) == _norm(label)]
        return min(cands, key=lambda t: t["y"]) if cands else None

    your_hdr, enemy_hdr = find("Your Team"), find("Enemy Team")
    if not your_hdr or not enemy_hdr:
        return {"your_team": [], "enemy_team": [], "average_tab": False}
    leave = find("Leave Match")
    end_y = leave["y"] if leave else h

    cols_y, cols_e = _columns(toks, your_hdr, h), _columns(toks, enemy_hdr, h)
    for c in STAT_COLUMNS:  # both tables share the same columns
        cols_y.setdefault(c, cols_e.get(c))
        cols_e.setdefault(c, cols_y.get(c))

    def section(hdr: dict, cols: Dict[str, Optional[float]], stop_y: float) -> List[dict]:
        if any(v is None for v in cols.values()):
            return []
        line_tol = max(hdr["h"], h * 0.008)
        col_w = (max(cols.values()) - min(cols.values())) / 3
        first_col = min(cols.values())
        body = [t for t in toks if hdr["y"] + line_tol < t["y"] < stop_y - line_tol]
        rows = [t for t in sorted(body, key=lambda t: t["y"])
                if abs(t["x"] - cols["score"]) < col_w * 0.35 and _int(t["text"]) is not None]
        players = []
        for r in rows:
            tol = max(r["h"], h * 0.01)
            p: dict = {"stats": {}}
            for c in STAT_COLUMNS:
                cx = cols[c]
                t = min((t for t in body if abs(t["y"] - r["y"]) < tol and abs(t["x"] - cx) < col_w * 0.35),
                        key=lambda t: abs(t["x"] - cx), default=None)
                p["stats"][c] = _int(t["text"]) if t else None
            left = [t for t in body if t["x1"] < first_col - col_w * 0.4]
            # name: left-hand text on or just above the row (titles like "Contender" sit below it)
            names = [t for t in left if r["y"] - h * 0.03 <= t["y"] <= r["y"] + h * 0.003]
            name = max(names, key=lambda t: t["y"], default=None)
            p["name"] = name["text"] if name else None
            # champion label: small caps text just below the row's numbers, under the portrait
            cands = []
            for t in left:
                if t is name or not r["y"] <= t["y"] <= r["y"] + h * 0.022:
                    continue
                best = max(champion_names, key=lambda c: similarity(c, t["text"]))
                s = similarity(best, t["text"])
                if s >= 0.75:
                    cands.append((s, -abs(t["x"] - first_col), best))
            p["champion"] = max(cands)[2] if cands else None
            p["champion_source"] = "label" if cands else None
            # portrait box (used for icon matching and for saving reference icons)
            cx, cy, s = first_col - 0.675 * col_w, r["y"] - 0.004 * h, 0.024 * h
            p["icon_box"] = [int(cx - s / 2), int(cy - s / 2), int(cx + s / 2), int(cy + s / 2)]
            players.append(p)
        return players

    return {
        "your_team": section(your_hdr, cols_y, enemy_hdr["y"]),
        "enemy_team": section(enemy_hdr, cols_e, end_y),
        "average_tab": any(_norm(t["text"]) == "averagetotal" for t in toks),
    }


def _filled(p: dict) -> int:
    return sum(v is not None for v in p["stats"].values()) + bool(p.get("name")) + bool(p.get("champion"))


def parse_scoreboard(path: str, champion_names: List[str], icon_refs: Optional[Dict[str, list]] = None) -> dict:
    """OCR at a few zoom levels, keep the most complete reading of every cell,
    then fill in champions from portrait icons and read the round orbs."""
    import cv2

    img = cv2.imread(path)
    if img is None:
        return {"ok": False, "warnings": ["Couldn't open the image"]}
    h, w = img.shape[:2]
    factors = sorted({round(max(1.0, t / h), 2) for t in (h, 1800.0, 2600.0)})
    passes = [_parse_pass(img, _tokens(img, f), champion_names) for f in factors]

    result = {"average_tab": any(p["average_tab"] for p in passes)}
    for side in ("your_team", "enemy_team"):
        best = max(passes, key=lambda ps: (len(ps[side]) > 0, sum(_filled(p) for p in ps[side])))
        rows = best[side]
        for other in passes:
            if other is best or len(other[side]) != len(rows):
                continue
            for row, o in zip(rows, other[side]):
                if row.get("name") and o.get("name") and similarity(row["name"], o["name"]) < 0.6:
                    continue  # rows don't line up
                for c in STAT_COLUMNS:
                    if row["stats"].get(c) is None and o["stats"].get(c) is not None:
                        row["stats"][c] = o["stats"][c]
                for k in ("name", "champion", "champion_source"):
                    if not row.get(k) and o.get(k):
                        row[k] = o[k]
        result[side] = rows

    warnings: List[str] = []
    for side, label in (("your_team", "Your Team"), ("enemy_team", "Enemy Team")):
        for p in result[side]:
            icon_champ, dist = match_icon(crop_icon(img, p["icon_box"]), icon_refs or {})
            if icon_champ and not p["champion"]:
                p["champion"], p["champion_source"] = icon_champ, "icon"
            elif icon_champ and icon_champ != p["champion"]:
                label = p["champion"]
                if dist <= ICON_MATCH_SURE:  # a close portrait match beats a blurry label
                    p["champion"], p["champion_source"] = icon_champ, "icon"
                warnings.append(f"{p['name'] or '?'}: label reads {label} but the portrait looks like {icon_champ}")
            if None in p["stats"].values() or not p["name"] or not p["champion"]:
                warnings.append(f"Row '{p['name'] or '?'}' under '{label}' was only partly read")
    if not result["your_team"] or not result["enemy_team"]:
        warnings.insert(0, "Couldn't find both teams on the scoreboard")
    if not result.pop("average_tab"):
        warnings.append("Couldn't see the 'Average Total' tab - check the stats are averages")
    orbs = _count_orbs(img, _timer_x(img))
    if not orbs.get("blue") and not orbs.get("red"):
        warnings.append("Couldn't read the round orbs")
    return {
        "ok": bool(result["your_team"] and result["enemy_team"]),
        "your_team_rounds": orbs.get("blue"),
        "enemy_team_rounds": orbs.get("red"),
        "your_team": result["your_team"],
        "enemy_team": result["enemy_team"],
        "image_size": [w, h],
        "warnings": warnings,
    }


# ------------------------------------------------------------------ map onto a match
def assign_to_roster(parsed: dict, team_a: List[dict], team_b: List[dict]) -> dict:
    """Work out which side of the screenshot is Team A, and which row is which player.

    team_a / team_b: [{"id", "names": [website name, in-game name, ...]}].
    Tries "Your Team = A" and "Your Team = B" and keeps the better name match.
    """
    from itertools import permutations

    def name_score(row, player):
        return max((similarity(row.get("name") or "", n) for n in player["names"] if n), default=0.0)

    def best_match(rows, players):
        if len(rows) != len(players):
            return None, 0.0
        best, best_s = None, -1.0
        for perm in permutations(players):
            s = sum(name_score(r, p) for r, p in zip(rows, perm))
            if s > best_s:
                best, best_s = list(zip(rows, perm)), s
        return best, best_s

    your, enemy = parsed.get("your_team") or [], parsed.get("enemy_team") or []
    options = []
    for your_side, yours, theirs in (("A", team_a, team_b), ("B", team_b, team_a)):
        m1, s1 = best_match(your, yours)
        m2, s2 = best_match(enemy, theirs)
        if m1 is not None and m2 is not None:
            options.append((s1 + s2, your_side, m1 + m2))
    warnings = list(parsed.get("warnings") or [])
    if not options:
        warnings.append("The screenshot's team sizes don't match this match's teams")
        return {"players": {}, "team_a_rounds": None, "team_b_rounds": None, "warnings": warnings}
    _total, your_side, pairs = max(options, key=lambda o: o[0])
    players = {}
    for row, player in pairs:
        conf = round(name_score(row, player), 2)
        if conf < 0.6:
            warnings.append(f"'{row.get('name')}' was matched to a player by elimination - please check")
        players[player["id"]] = {
            "champion": row.get("champion"), "champion_source": row.get("champion_source"),
            "stats": row.get("stats"), "ocr_name": row.get("name"), "name_confidence": conf,
            "icon_box": row.get("icon_box"),
        }
    yr, er = parsed.get("your_team_rounds"), parsed.get("enemy_team_rounds")
    a_r, b_r = (yr, er) if your_side == "A" else (er, yr)
    if a_r is not None and b_r is not None and a_r == b_r:
        warnings.append("Round orbs look tied - please check the score")
    return {"players": players, "team_a_rounds": a_r, "team_b_rounds": b_r,
            "your_team_side": your_side, "warnings": warnings}
