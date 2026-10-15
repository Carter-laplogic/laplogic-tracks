"""One-off: start the repo from ll01-firmware/tracks (OpenStreetMap venues + the measured
start/finish lines), adding each line's lap path from a Lap Logic track library.

    python tools/seed.py --firmware ../ll01-firmware --library "<Lap Logic>/Data/tracks_db.json"

The paths are the library's reference laps (the track outline Lap Logic draws). Look at
layouts/ before pushing: everything in this repo is public. Run again later to refresh
venues.json: layout files that exist already (uploads) are left alone.
"""
import argparse
import datetime
import json
import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def dist_m(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = math.sin((lat2 - lat1) * r / 2) ** 2 + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2
    return 2 * 6371008.8 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def lap_path(geom, sf_lat, sf_lon, step_m=5.0):
    """The reference lap starting at the line, a point every step_m; None if it isn't a lap."""
    pts = [(g["Latitude"], g["Longitude"]) for g in geom if g.get("Latitude") and g.get("Longitude")]
    if len(pts) < 20:
        return None
    i = min(range(len(pts)), key=lambda k: dist_m(sf_lat, sf_lon, *pts[k]))
    if dist_m(sf_lat, sf_lon, *pts[i]) > 60:
        return None
    pts = pts[i:] + pts[:i]
    out = [pts[0]]
    for p in pts[1:]:
        if dist_m(*out[-1], *p) >= step_m:
            out.append(p)
    if dist_m(*out[0], *out[-1]) > 80:
        return None
    return [[round(a, 6), round(b, 6)] for a, b in out]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--firmware", required=True, help="the ll01-firmware repo")
    ap.add_argument("--library", required=True, help="Lap Logic Data/tracks_db.json")
    a = ap.parse_args()

    db = json.load(open(os.path.join(a.firmware, "tracks", "tracks.json"), encoding="utf-8"))
    with open(os.path.join(ROOT, "venues.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(db["venues"], f, ensure_ascii=False, indent=0)
    lib = json.load(open(a.library, encoding="utf-8"))
    os.makedirs(os.path.join(ROOT, "layouts"), exist_ok=True)
    today = datetime.date.today().isoformat()
    for l in json.load(open(os.path.join(a.firmware, "tracks", "layouts.json"), encoding="utf-8"))["layouts"]:
        if os.path.exists(os.path.join(ROOT, "layouts", l["id"] + ".json")):
            continue
        sf = l["sf"]
        out = {"id": l["id"], "name": l["name"], "sf": sf, "half_width_m": l.get("half_width_m", 15),
               "source": l.get("source", ""), "uploaded": today}
        # the library track with this line (same line within 30 m, same name first)
        cands = [t for t in lib if t.get("ReferenceGeometry") and dist_m(sf["lat"], sf["lon"], t.get("SfLat", 0), t.get("SfLon", 0)) < 30]
        cands.sort(key=lambda t: (re.sub(r"\s*\(\d+\)$", "", t.get("Name", "")).lower() != l["name"].lower(),
                                  dist_m(sf["lat"], sf["lon"], t["SfLat"], t["SfLon"])))
        for t in cands:
            p = lap_path(t["ReferenceGeometry"], sf["lat"], sf["lon"])
            if p:
                out["path"] = p
                break
        print(f"{l['id']}: {'path of ' + str(len(out['path'])) + ' points' if 'path' in out else 'no path'}")
        with open(os.path.join(ROOT, "layouts", l["id"] + ".json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
