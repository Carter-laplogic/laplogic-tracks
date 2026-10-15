# Lap Logic tracks

The public track database behind Lap Logic and the LL-01 Lap Logger: every karting venue in
OpenStreetMap, plus the start/finish lines and lap paths that drivers share from Lap Logic.
Lap Logic downloads `tracks.json`, shows it on its Tracks page, and puts it on the logger's SD
card so laps are timed at any track with no setup.

## What is here

| Path | What |
|---|---|
| `venues.json` | Karting venues from OpenStreetMap (ODbL). Refresh: `python tools/build_track_db.py --fetch` in ll01-firmware, then `tools/seed.py` (keeps existing layouts) |
| `layouts/<id>.json` | One track layout each: name, start/finish line (`sf`: lat, lon, heading), `half_width_m`, `length_m`, `path` (one lap, a point every ~5 m, starting at the line), `source`, `uploaded`, `by` |
| `tracks.json` | Built from the two above by `tools/build.py` (the GitHub Action does it on every change). Do not edit |
| `tools/` | `build.py` (check + build), `same_layout.py` (the duplicate rule), `seed.py` (one-off start from ll01-firmware) |
| `service/` | The upload service: a Cloudflare Worker that adds uploads to `layouts/` |

## How sharing a track works

1. In Lap Logic: Tracks → a track → **Share**. Lap Logic sends its start/finish line and reference lap.
2. The service checks it (a real closed lap through its line, sensible GPS) and compares it with every
   layout within a few km.
3. **Not in the database** (a new track, or a new layout of a known venue): committed to `layouts/`
   straight away, live within a minute or two (the Action rebuilds `tracks.json`).
4. **Looks like a track already there**: nothing is saved; Lap Logic shows the uploader the matching
   tracks so they can check. If they say theirs is different, it is uploaded as a **pull request**
   for someone to look at before it goes public.

**Same track or not:** two laps are the same layout when each lies on the other almost everywhere
(at least 97 % of the points within 12 m and no stretch longer than 30 m off it), they are driven
the same way round, and their lengths agree within 8 %. Different layouts of one venue (MCC ACW and
MCC National share the start/finish line) always have a section only one of them uses, so they never
count as duplicates and never ask; a reversed layout is different too. Lap Logic groups sessions by
layout with the same rule (`Helpers/TrackLayouts.cs`).

## Deploying the upload service

You need a GitHub account (for this repo) and a free Cloudflare account (for the service).

1. **Publish this repo** on GitHub as a public repository named `laplogic-tracks`:
   ```
   git add -A
   git commit -m "Lap Logic track database"
   git remote add origin https://github.com/YOUR-GITHUB-NAME/laplogic-tracks.git
   git push -u origin main
   ```
2. **A token for the service:** GitHub → Settings → Developer settings → Fine-grained tokens →
   Generate. Repository access: *Only select repositories* → `laplogic-tracks`. Permissions:
   *Contents: Read and write*, *Pull requests: Read and write*. Copy the token.
3. **The Worker** (in `service/`):
   ```
   npm install
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN        (paste the token)
   npx wrangler kv namespace create RATE_LIMIT (optional upload limit: paste the id into wrangler.toml)
   npx wrangler deploy
   ```
   Set `GITHUB_REPO` in `wrangler.toml` to `YOUR-GITHUB-NAME/laplogic-tracks` first.
4. **The address Lap Logic uses**, `https://tracks.laplogic.co`: with laplogic.co's DNS on
   Cloudflare, uncomment the `routes` line in `wrangler.toml` and deploy again. (Until then, set the
   environment variable `LAPLOGIC_TRACKS_URL` to the `*.workers.dev` address wrangler printed.)
5. Check: open `https://tracks.laplogic.co/tracks.json` in a browser.

## Working on it

```
python tools/build.py --check             check the layouts
python tools/build.py                     rebuild tracks.json
node --test service/test/service.test.mjs test the service (Node 20+, no packages)
```
