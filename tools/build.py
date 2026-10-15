"""Validate the layouts and build tracks.json, the file Lap Logic downloads.

    python tools/build.py            check everything, write tracks.json
    python tools/build.py --check    check only (CI on pull requests)

Inputs
  venues.json       kart tracks and race circuits from OpenStreetMap ("kind": karting /
                    circuit), (c) OpenStreetMap contributors, ODbL 1.0
                    (refreshed with ll01-firmware/tools/build_track_db.py --fetch, then seed.py)
  layouts/*.json    one start/finish line + lap path per track layout (uploads land here)

Output
  tracks.json       {attribution, generated, venues, layouts}; layouts carry the path so Lap
                    Logic can show them and check uploads for duplicates
  layouts.json      {generated, layouts}: the same layouts without the venues, for the upload
                    service's duplicate check (tracks.json is megabytes with every circuit)

A layout that matches another one (same_layout.py) is reported but not an error: the upload
service holds those for review, and a reviewer may keep one on purpose (a better line).
"""
import argparse
import datetime
import glob
import json
import math
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from same_layout import build_trace, same_layout  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ATTRIBUTION = ("Venues (c) OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright). "
               "Start/finish lines and laps from Lap Logic users, ODbL 1.0.")
ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def dist_m(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = math.sin((lat2 - lat1) * r / 2) ** 2 + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2
    return 2 * 6371008.8 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# letters that have no accent to strip (NFKD leaves them as they are)
TRANSLIT = str.maketrans({"ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D",
                          "þ": "th", "Þ": "Th", "ð": "d", "Ð": "D", "œ": "oe", "Œ": "OE", "ı": "i", "ħ": "h", "Ħ": "H"})


def ascii_name(s):
    s = unicodedata.normalize("NFKD", (s or "").translate(TRANSLIT))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = "".join(c if 32 <= ord(c) < 127 else " " for c in s)
    return re.sub(r"\s+", " ", s).strip()


def short_name(name, max_len=31):
    """Fit a name on the logger's dash: drop filler words before cutting."""
    if len(name) <= max_len:
        return name
    for pat in (r"\b(of|the|and|de|la|le|del|di|der)\b", r"\b(International|Raceway|Circuit|Karting|Kartbahn|Kart|Track|Park)\b"):
        shorter = re.sub(r"\s+", " ", re.sub(pat, "", name, flags=re.I)).strip()
        if len(shorter) <= max_len:
            return shorter
        name = shorter
    cut = name[:max_len]
    return cut.rsplit(" ", 1)[0] if " " in cut[10:] else cut


def venue_at(venues, lat, lon):
    """The venue at a point, as the logger picks it: of those that contain it the smallest
    (a kart track in a circuit's infield), else the nearest within its radius + 300 m."""
    near = [(dist_m(v["lat"], v["lon"], lat, lon), v) for v in venues if abs(v["lat"] - lat) < 0.06]
    inside = [v for d, v in near if d <= v["radius_m"]]
    if inside:
        return min(inside, key=lambda v: v["radius_m"])
    near = [(d, v) for d, v in near if d <= v["radius_m"] + 300]
    return min(near, key=lambda x: x[0])[1] if near else None


def check_layout(path, l, errors):
    """Errors in one layout file (appended to errors)."""
    name = os.path.basename(path)
    def bad(msg):
        errors.append(f"{name}: {msg}")
    if l.get("id") != os.path.splitext(name)[0] or not ID_RE.match(l.get("id", "")):
        bad("id must match the file name (lower case, digits, dashes)")
    if not isinstance(l.get("name"), str) or not 2 <= len(l["name"].strip()) <= 60:
        bad("name must be 2 to 60 characters")
    sf = l.get("sf") or {}
    lat, lon = sf.get("lat"), sf.get("lon")
    if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and abs(lat) <= 90 and abs(lon) <= 180):
        bad("sf.lat / sf.lon missing")
        return
    if abs(lat) < 6 and abs(lon) < 6:
        bad("start/finish near 0, 0 (made-up coordinates?)")
    h = sf.get("heading")
    if h is not None and not (isinstance(h, (int, float)) and 0 <= h <= 360):
        bad("sf.heading must be 0..360 or null")
    w = l.get("half_width_m", 15)
    if not (isinstance(w, (int, float)) and 3 <= w <= 50):
        bad("half_width_m must be 3..50")
    p = l.get("path")
    if p is not None:
        if not isinstance(p, list) or len(p) < 20:
            bad("path needs at least 20 points")
            return
        if build_trace(p) is None:
            bad("path is not one usable lap (150 m to 30 km of valid GPS points)")
            return
        if min(dist_m(lat, lon, a, b) for a, b in p) > 60:
            bad("the path does not pass the start/finish line (60 m)")
        if dist_m(p[0][0], p[0][1], p[-1][0], p[-1][1]) > 80:
            bad("the path is not a closed lap (its ends are more than 80 m apart)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="check only, do not write tracks.json")
    a = ap.parse_args()

    venues = json.load(open(os.path.join(ROOT, "venues.json"), encoding="utf-8"))
    errors, layouts, traces = [], [], {}
    for path in sorted(glob.glob(os.path.join(ROOT, "layouts", "*.json"))):
        try:
            l = json.load(open(path, encoding="utf-8"))
        except ValueError as e:
            errors.append(f"{os.path.basename(path)}: not JSON ({e})")
            continue
        n = len(errors)
        check_layout(path, l, errors)
        if len(errors) > n:
            continue
        l["name"] = l["name"].strip()
        l["short"] = short_name(ascii_name(l["name"]))
        l.setdefault("half_width_m", 15)
        if l.get("path"):
            t = build_trace(l["path"])
            traces[l["id"]] = t
            l["length_m"] = round(t["length_m"])
        v = venue_at(venues, l["sf"]["lat"], l["sf"]["lon"])
        l["venue"] = v["id"] if v else ""
        layouts.append(l)

    # layouts that look like the same track (reported only)
    for i, x in enumerate(layouts):
        for y in layouts[i + 1:]:
            if x["id"] in traces and y["id"] in traces:
                same, score = same_layout(traces[x["id"]], traces[y["id"]])
                if same:
                    print(f"note: {x['id']} and {y['id']} look like the same layout ({score:.0%})")

    if errors:
        print("\n".join(errors))
        sys.exit(1)
    karts = sum(1 for v in venues if v.get("kind", "karting") == "karting")
    print(f"{len(venues)} venues ({karts} karting, {len(venues) - karts} circuits), {len(layouts)} layouts OK")
    if a.check:
        return
    order = ["id", "name", "short", "venue", "sf", "half_width_m", "length_m", "source", "uploaded", "by", "path"]
    generated = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = [{k: l[k] for k in order if k in l} for l in sorted(layouts, key=lambda l: l["id"])]
    db = {"attribution": ATTRIBUTION, "generated": generated, "venues": venues, "layouts": out}
    with open(os.path.join(ROOT, "tracks.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(db, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(ROOT, "layouts.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"attribution": ATTRIBUTION, "generated": generated, "layouts": out}, f,
                  ensure_ascii=False, separators=(",", ":"))
    print("wrote tracks.json, layouts.json")


if __name__ == "__main__":
    main()
