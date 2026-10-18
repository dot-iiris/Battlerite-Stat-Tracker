"""Read a Battlerite end-of-match scoreboard screenshot.

- Text (names, stats, champion labels) is read with local OCR (RapidOCR 3 +
  onnxruntime, headless OpenCV - no account, API key or system libraries). Positions come from the on-screen headings ("Your Team",
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

_ocr = None   # kind -> RapidOCR (set to None to rebuild them, e.g. after OCR_THREADS changes)
# Finding where text is ("detection") is the slow part, and its cost grows with the picture's size.
#   full:  detection at the size given (small pictures are enlarged to 736 px first) - low-res screenshots
#   fast:  detection on a copy shrunk to FAST_DETECT_PX; each piece of text found is still read from the
#          full-size picture - plenty for screenshots of 1080p and up, and several times quicker
#   small: for narrow strips (the round timer) - only enlarged to 320 px, not 736
FAST_DETECT_PX = 960
_DET = {"full": ("min", 736), "fast": ("max", FAST_DETECT_PX), "small": ("min", 320)}


def _get_ocr(kind: str = "full"):
    global _ocr
    if _ocr is None:
        _ocr = {}
    if kind not in _ocr:
        from rapidocr import RapidOCR  # optional dependency, loaded on first use
        # no upside-down check: scoreboards are never upside down, and the check flipped "99" into "66"
        # one CPU core at most (OCR_THREADS to change it), so a screenshot never takes over the server
        threads = int(os.environ.get("OCR_THREADS") or 1)
        limit_type, limit = _DET[kind]
        _ocr[kind] = RapidOCR(params={"Global.log_level": "error", "Global.use_cls": False,
                                      "Det.limit_type": limit_type, "Det.limit_side_len": limit,
                                      "EngineConfig.onnxruntime.intra_op_num_threads": threads,
                                      "EngineConfig.onnxruntime.inter_op_num_threads": 1})
    return _ocr[kind]


def _ocr_run(img_rgb, kind: str = "full"):
    """[(box, text)] for every piece of text RapidOCR finds."""
    r = _get_ocr(kind)(img_rgb, use_det=True, use_cls=False, use_rec=True)
    if r is None or r.boxes is None or r.txts is None:
        return []
    return list(zip(r.boxes.tolist(), r.txts))


def _read_line(img_rgb) -> List[str]:
    """Read a picture that holds one line of text, skipping detection (a few milliseconds)."""
    r = _get_ocr("full")(img_rgb, use_det=False, use_cls=False, use_rec=True)
    return [t for t in (getattr(r, "txts", None) or []) if t]


def _load_image(image):
    """Accepts raw bytes (from the database) or a file path."""
    import cv2
    import numpy as np

    if isinstance(image, (bytes, bytearray, memoryview)):
        return cv2.imdecode(np.frombuffer(bytes(image), np.uint8), cv2.IMREAD_COLOR)
    return cv2.imread(str(image))


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
def _tokens(img, f: float, whole: bool = False) -> List[dict]:
    """OCR the centre of the screen (where the scoreboard is) at zoom f - or, with whole=True,
    the entire image (for screenshots cropped close around the scoreboard).
    Coordinates are mapped back to the full image."""
    import cv2

    h, w = img.shape[:2]
    if whole:
        x0, y0, crop = 0, 0, img
    else:
        x0, y0 = int(w * 0.18), int(h * 0.12)
        crop = img[y0:int(h * 0.88), x0:int(w * 0.82)]
    # a big enough original: find the text on a smaller copy (much quicker), read it at full size
    kind = "fast" if max(crop.shape[:2]) >= 1200 else "full"
    if f != 1.0:
        crop = cv2.resize(crop, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    out = []
    for box, text in _ocr_run(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB), kind):
        xs = [p[0] / f + x0 for p in box]
        ys = [p[1] / f + y0 for p in box]
        out.append({"text": text.strip(), "x": sum(xs) / 4, "y": sum(ys) / 4,
                    "x0": min(xs), "x1": max(xs), "h": max(ys) - min(ys)})
    return _join_labels(out)


_LABELS = ("yourteam", "enemyteam", "averagetotal", "leavematch")


def _join_labels(toks: List[dict]) -> List[dict]:
    """OCR sometimes splits a heading into words ("Enemy" + "Team"); glue those back together."""
    out = list(toks)
    for a in toks:
        for b in toks:
            if a is b or b["x"] <= a["x"] or b["x0"] - a["x1"] > 2 * max(a["h"], b["h"]):
                continue
            if abs(a["y"] - b["y"]) > max(a["h"], b["h"]) * 0.6:
                continue
            if _norm(a["text"] + b["text"]) in _LABELS:
                out.append({"text": f"{a['text']} {b['text']}", "x": (a["x0"] + b["x1"]) / 2,
                            "y": (a["y"] + b["y"]) / 2, "x0": a["x0"], "x1": b["x1"],
                            "h": max(a["h"], b["h"])})
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
    for box, text in _ocr_run(cv2.cvtColor(band, cv2.COLOR_BGR2RGB), "small"):
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
    cands = []   # (colour, x, y, diameter) of every round-ish blob on the correct side
    for colour, rs in ranges.items():
        mask = None
        for lo, hi in rs:
            m = cv2.inRange(hsv, np.array(lo), np.array(hi))
            mask = m if mask is None else cv2.bitwise_or(mask, m)
        n, _, stats, cents = cv2.connectedComponentsWithStats(mask)
        for i in range(1, n):
            bw, bh, area = stats[i][2], stats[i][3], stats[i][4]
            if not (min_d <= bw <= max_d and min_d <= bh <= max_d):
                continue
            # round: about as wide as tall and not a filled rectangle (health-bar segments are)
            if not 0.75 <= bw / bh <= 1.33 or not 0.35 * bw * bh <= area <= 0.92 * bw * bh:
                continue
            cx, cy = cents[i]
            if (colour == "blue" and cx < centre) or (colour == "red" and cx > centre):
                cands.append((colour, cx, cy, (bw + bh) / 2))
    # the orbs are the biggest round blobs, all the same size and on one line
    counts = {"blue": 0, "red": 0}
    if cands:
        d = max(c[3] for c in cands)
        orbs = [c for c in cands if c[3] >= 0.7 * d]
        line_y = sorted(c[2] for c in orbs)[len(orbs) // 2]
        orbs = [c for c in orbs if abs(c[2] - line_y) <= 0.3 * d]
        # Lit orbs form an evenly spaced chain outwards from the timer. Anything round and
        # coloured further out (e.g. a red lantern on the map) is not an orb.
        for colour in counts:
            dists = sorted(abs(c[1] - centre) for c in orbs if c[0] == colour)
            prev = 0.0
            for i, dist in enumerate(dists):
                if dist - prev > (6 if i == 0 else 3) * d:
                    break
                counts[colour] += 1
                prev = dist
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


def encode_icon(img, box: List[int]) -> Optional[bytes]:
    """PNG bytes of a portrait crop, for saving as a reference icon."""
    import cv2

    icon = crop_icon(img, box)
    if icon is None:
        return None
    ok, buf = cv2.imencode(".png", icon)
    return buf.tobytes() if ok else None


def load_icon_refs(*dirs: str, stored: Optional[List[tuple]] = None) -> Dict[str, list]:
    """{champion: [icon arrays]} from folders laid out as <dir>/<Champion>/*.png
    plus stored = [(champion, png bytes)] (icons learned and kept in the database)."""
    import cv2

    refs: Dict[str, list] = {}
    for champ, png in stored or []:
        im = _load_image(png)
        if im is not None:
            refs.setdefault(champ, []).append(cv2.resize(im, (ICON_SIZE, ICON_SIZE)).astype("float32"))
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


def match_icon(img, box: List[int], refs: Dict[str, list]):
    """Best matching champion for the portrait at box. Tries small shifts so a
    slightly-off box (different resolution / OCR positions) still matches."""
    import numpy as np

    if not refs:
        return None, None
    x0, y0, x1, y1 = box
    step = max(1, int((x1 - x0) * 0.12))
    best, best_d = None, 1.0
    for dx in (-step, 0, step):
        for dy in (-step, 0, step):
            icon = crop_icon(img, [x0 + dx, y0 + dy, x1 + dx, y1 + dy])
            if icon is None:
                continue
            q = icon.astype("float32")
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


# On a full-screen screenshot the "Your Team" and "Enemy Team" headings are this fraction of the
# screen height apart (the same at 720p, 1080p and 1440p). Distances below are fractions of the
# screen height, so for a cropped screenshot the "screen height" is worked out from that gap.
TEAM_GAP_OF_SCREEN = 0.157


def _parse_pass(img, toks: List[dict], champion_names: List[str]) -> dict:
    img_h, w = img.shape[:2]
    h = img_h

    def find(label: str) -> Optional[dict]:
        cands = [t for t in toks if _norm(t["text"]) == _norm(label)]
        return min(cands, key=lambda t: t["y"]) if cands else None

    your_hdr, enemy_hdr = find("Your Team"), find("Enemy Team")
    if not your_hdr or not enemy_hdr:
        return {"your_team": [], "enemy_team": [], "average_tab": False}
    if enemy_hdr["y"] > your_hdr["y"]:
        h = (enemy_hdr["y"] - your_hdr["y"]) / TEAM_GAP_OF_SCREEN   # the screen this scoreboard belongs to
    leave = find("Leave Match")
    end_y = leave["y"] if leave else img_h

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


def _label_closeup(img, box: List[int], champion_names: List[str]) -> Optional[str]:
    """Read the champion name printed under a portrait from a zoomed-in crop - short labels
    like "IVA" over a busy portrait are often missed when reading the whole scoreboard."""
    import cv2

    x0, y0, x1, y1 = box
    s = x1 - x0
    if s <= 0:
        return None
    h, w = img.shape[:2]
    cx = (x0 + x1) / 2
    crop = img[max(0, int(y0 + s * 0.45)):min(h, int(y1 + s * 0.45)), max(0, int(cx - s * 0.95)):min(w, int(cx + s * 0.95))]
    if crop.size == 0:
        return None
    crop = cv2.resize(crop, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)

    def best_of(texts):
        best, best_s = None, 0.0
        for text in texts:
            for c in champion_names:
                sc = similarity(c, text)
                if sc > best_s:
                    best, best_s = c, sc
        return best if best_s >= 0.75 else None

    # quick try: read the crop (and its lower part, where the label is) as a single line of text
    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    quick = best_of(_read_line(rgb) + _read_line(rgb[int(rgb.shape[0] * 0.35):]))
    if quick:
        return quick
    crop = cv2.copyMakeBorder(crop, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=(0, 0, 0))
    return best_of(text for _, text in _ocr_run(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)))


def _filled(p: dict) -> int:
    return sum(v is not None for v in p["stats"].values()) + bool(p.get("name")) + bool(p.get("champion"))


def parse_scoreboard(image, champion_names: List[str], icon_refs: Optional[Dict[str, list]] = None) -> dict:
    """OCR at a few zoom levels, keep the most complete reading of every cell,
    then fill in champions from portrait icons and read the round orbs.
    image: raw bytes or a file path."""
    img = _load_image(image)
    if img is None:
        return {"ok": False, "warnings": ["Couldn't open the image"]}
    h, w = img.shape[:2]

    def zoom(whole: bool) -> float:
        # the text reader works on at most 2000 px (it shrinks anything bigger), so zooming the
        # region past that only costs time
        long_side = max(w, h) if whole else max(w * 0.64, h * 0.76)
        return round(min(3.0, max(1.0, 2000.0 / long_side)), 2)

    def complete(ps: dict) -> bool:
        rows = ps["your_team"] + ps["enemy_team"]
        return bool(ps["your_team"] and ps["enemy_team"]) and \
            all(r.get("name") and None not in r["stats"].values() for r in rows)

    # a full-screen screenshot is widescreen; a squarer image was cropped around the scoreboard
    whole = w / h < 1.5
    passes = [] if whole else [_parse_pass(img, _tokens(img, zoom(False)), champion_names)]
    if whole or not (passes[0]["your_team"] and passes[0]["enemy_team"]):
        # not in the middle of the image: probably cropped close around the scoreboard - read all of it
        whole = True
        passes.append(_parse_pass(img, _tokens(img, zoom(True), whole=True), champion_names))
    if not complete(passes[-1]):
        # something's missing: one more look at a different zoom (champions are handled below)
        z = zoom(whole)
        alt = 1.0 if z >= 1.4 else round(min(3.0, z * 1.5), 2)
        passes.append(_parse_pass(img, _tokens(img, alt, whole=whole), champion_names))

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
            if not p["champion"]:
                close = _label_closeup(img, p["icon_box"], champion_names)
                if close:
                    p["champion"], p["champion_source"] = close, "label"
            icon_champ, dist = match_icon(img, p["icon_box"], icon_refs or {})
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

    team_a / team_b: [{"id", "names": [website name, in-game name, ...]}] - the teams the bot made.
    Normally "Your Team" is one of those teams. If the names show players swapped
    teams, the screenshot's teams are proposed instead (returned in "teams").
    """
    from itertools import permutations

    def name_score(row, player):
        return max((similarity(row.get("name") or "", n) for n in player["names"] if n), default=0.0)

    def best_match(rows, players):
        if len(rows) != len(players):
            return None, -1.0
        best, best_s = None, -1.0
        for perm in permutations(players):
            sc = sum(name_score(r, p) for r, p in zip(rows, perm))
            if sc > best_s:
                best, best_s = list(zip(rows, perm)), sc
        return best, best_s

    your, enemy = parsed.get("your_team") or [], parsed.get("enemy_team") or []
    warnings = list(parsed.get("warnings") or [])
    everyone = team_a + team_b
    if len(your) + len(enemy) != len(everyone) or len(your) != len(enemy):
        warnings.append("The screenshot's team sizes don't match this match")
        return {"players": {}, "teams": {}, "team_a_rounds": None, "team_b_rounds": None, "warnings": warnings}

    # 1) bot's teams kept: Your Team is either A or B
    options = []
    for your_side, yours, theirs in (("A", team_a, team_b), ("B", team_b, team_a)):
        m1, s1 = best_match(your, yours)
        m2, s2 = best_match(enemy, theirs)
        options.append((s1 + s2, your_side, m1 + m2))
    kept_score, your_side, pairs = max(options, key=lambda o: o[0])
    teams = {p["id"]: ("A" if p in team_a else "B") for p in everyone}

    # 2) any rows to any players - if clearly better, players swapped teams in game
    free, free_score = best_match(your + enemy, everyone)

    def strong(prs):  # rows whose name clearly matches (similar names like Iris/Sirius don't count)
        return sum(name_score(r, p) >= 0.9 for r, p in prs)

    if strong(free) > strong(pairs) or free_score > kept_score + 0.5:
        pairs = free
        your_ids = [pl["id"] for _, pl in free[:len(your)]]
        a_ids = {p["id"] for p in team_a}
        your_side = "A" if sum(i in a_ids for i in your_ids) * 2 >= len(your_ids) else "B"
        enemy_side = "B" if your_side == "A" else "A"
        teams = {pl["id"]: (your_side if i < len(your) else enemy_side) for i, (_, pl) in enumerate(free)}
        warnings.append("Players were on different teams in the game than the bot planned - "
                        "teams below follow the screenshot. Please check.")

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
    return {"players": players, "teams": teams, "team_a_rounds": a_r, "team_b_rounds": b_r,
            "your_team_side": your_side, "warnings": warnings}
