// Track layout checks for the upload service: the same rules as tools/same_layout.py and
// Lap Logic's Helpers/TrackLayouts.cs. Two laps are the same layout when each lies on the
// other almost everywhere (>= 97 % of points within 12 m, no stretch over 30 m off it), both
// are driven the same way round and their lengths agree within 8 %. Different layouts of one
// venue (MCC ACW / MCC National) always have a section only one of them uses, so they are
// never duplicates; reversed layouts fail the direction test.

const M_PER_DEG = 111195;
const ON_TRACK_M = 12;
const MAX_OFF_RUN_M = 30;
const MIN_ON_FRACTION = 0.97;
const MAX_LENGTH_RATIO = 1.08;
const STEP_M = 3;
const MAX_POINTS = 4000;
const CELL_M = 25;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function distM(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
            Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * 6371008.8 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** One lap of [lat, lon] points resampled every few metres, or null if unusable. */
export function buildTrace(points) {
  const valid = (points || []).filter(p => Array.isArray(p) && p.length >= 2 &&
    Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] && p[1] && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
  if (valid.length < 20) return null;
  const [lat0, lon0] = valid[0];
  const kx = Math.cos(lat0 * Math.PI / 180) * M_PER_DEG;
  const xy = valid.map(([la, lo]) => [(lo - lon0) * kx, (la - lat0) * M_PER_DEG]);
  let raw = 0;
  for (let i = 1; i < xy.length; i++) raw += dist(xy[i - 1], xy[i]);
  const step = Math.max(STEP_M, raw / MAX_POINTS);
  const kept = [xy[0]];
  for (const p of xy.slice(1)) if (dist(kept[kept.length - 1], p) >= step) kept.push(p);
  let total = 0;
  for (let i = 1; i < kept.length; i++) total += dist(kept[i - 1], kept[i]);
  if (kept.length < 20 || total < 150 || total > 30000) return null;
  return {
    lat: kept.map(([, y]) => lat0 + y / M_PER_DEG),
    lon: kept.map(([x]) => lon0 + x / kx),
    lengthM: total,
  };
}

function centre(t) {
  return [(Math.min(...t.lat) + Math.max(...t.lat)) / 2, (Math.min(...t.lon) + Math.max(...t.lon)) / 2];
}

function project(t, lat0, lon0, kx) {
  return t.lat.map((la, i) => [(t.lon[i] - lon0) * kx, (la - lat0) * M_PER_DEG]);
}

// segments of q by the 25 m cells their bounding boxes (plus the tolerance) touch
function grid(q) {
  const cells = new Map();
  for (let j = 0; j + 1 < q.length; j++) {
    const [ax, ay] = q[j], [bx, by] = q[j + 1];
    const x0 = Math.floor((Math.min(ax, bx) - ON_TRACK_M) / CELL_M), x1 = Math.floor((Math.max(ax, bx) + ON_TRACK_M) / CELL_M);
    const y0 = Math.floor((Math.min(ay, by) - ON_TRACK_M) / CELL_M), y1 = Math.floor((Math.max(ay, by) + ON_TRACK_M) / CELL_M);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const k = cx + ',' + cy;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(j);
      }
  }
  return cells;
}

// how much of p lies on q: share of points within tolerance, longest run off (m), heading agreement
function coverage(p, q) {
  const n = p.length, cells = grid(q), off = new Array(n).fill(false), tol2 = ON_TRACK_M * ON_TRACK_M;
  let on = 0, dirSum = 0, dirN = 0;
  for (let i = 0; i < n; i++) {
    const [px, py] = p[i];
    let best = Infinity, seg = -1;
    for (const j of cells.get(Math.floor(px / CELL_M) + ',' + Math.floor(py / CELL_M)) || []) {
      const [ax, ay] = q[j], [bx, by] = q[j + 1];
      const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0;
      const ex = ax + vx * t - px, ey = ay + vy * t - py, d2 = ex * ex + ey * ey;
      if (d2 < best) { best = d2; seg = j; }
    }
    if (best > tol2) { off[i] = true; continue; }
    on++;
    if (i > 0 && i + 1 < n) {
      const tx = p[i + 1][0] - p[i - 1][0], ty = p[i + 1][1] - p[i - 1][1];
      const sx = q[seg + 1][0] - q[seg][0], sy = q[seg + 1][1] - q[seg][1];
      const norm = Math.sqrt((tx * tx + ty * ty) * (sx * sx + sy * sy));
      if (norm > 0) { dirSum += (tx * sx + ty * sy) / norm; dirN++; }
    }
  }
  let longest = 0, run = 0;
  for (let k = 0; k < 2 * n; k++) { run = off[k % n] ? run + 1 : 0; longest = Math.max(longest, run); }
  longest = Math.min(longest, n);
  let length = 0;
  for (let i = 1; i < n; i++) length += dist(p[i - 1], p[i]);
  const spacing = n > 1 ? length / (n - 1) : STEP_M;
  return { on: on / n, longestOff: longest * spacing, direction: dirN ? dirSum / dirN : 0 };
}

/** { same, score } for two traces from buildTrace. */
export function sameLayout(a, b) {
  if (!a || !b || a.lat.length < 20 || b.lat.length < 20) return { same: false, score: 0 };
  const [lat0, lon0] = centre(a), [blat, blon] = centre(b);
  const kx = Math.cos(lat0 * Math.PI / 180) * M_PER_DEG;
  if (Math.hypot((blon - lon0) * kx, (blat - lat0) * M_PER_DEG) > 3000) return { same: false, score: 0 };
  if (Math.max(a.lengthM, b.lengthM) / Math.min(a.lengthM, b.lengthM) > MAX_LENGTH_RATIO) return { same: false, score: 0 };
  const pa = project(a, lat0, lon0, kx), pb = project(b, lat0, lon0, kx);
  const ab = coverage(pa, pb), ba = coverage(pb, pa);
  const score = (ab.on + ba.on) / 2;
  if ((ab.direction + ba.direction) / 2 < 0.5) return { same: false, score };
  const aOnB = ab.on >= MIN_ON_FRACTION && ab.longestOff <= MAX_OFF_RUN_M;
  const bOnA = ba.on >= MIN_ON_FRACTION && ba.longestOff <= MAX_OFF_RUN_M;
  return { same: aOnB && bOnA, score };
}

/**
 * Check an upload and turn it into a layout file's content (without id / dates).
 * Throws an Error with a message for the uploader when something is wrong.
 */
export function cleanUpload(body) {
  const fail = msg => { throw new Error(msg); };
  if (!body || typeof body !== 'object') fail('Send JSON.');
  const name = String(body.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60) fail('The track name must be 2 to 60 characters.');
  const sf = body.sf || {};
  const lat = Number(sf.lat), lon = Number(sf.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) fail('The start/finish line has no position.');
  if (Math.abs(lat) < 6 && Math.abs(lon) < 6) fail('The start/finish line is near 0, 0: the track needs real GPS positions.');
  let heading = sf.heading == null ? null : Number(sf.heading);
  if (heading !== null && !(heading >= 0 && heading <= 360)) heading = null;
  const halfWidth = Math.min(50, Math.max(3, Number(body.half_width_m) || 15));
  const path = Array.isArray(body.path) ? body.path : [];
  if (path.length < 20 || path.length > 8000) fail('The lap needs 20 to 8000 GPS points.');
  const trace = buildTrace(path);
  if (!trace) fail('The lap is not usable GPS (150 m to 30 km of valid points).');
  if (Math.min(...path.map(p => distM(lat, lon, p[0], p[1]))) > 60) fail('The lap does not pass its start/finish line.');
  const ends = distM(path[0][0], path[0][1], path[path.length - 1][0], path[path.length - 1][1]);
  if (ends > 80) fail('The path is not one closed lap.');
  // a point every 5 m keeps the file small and is plenty for the duplicate check
  const thin = [path[0]];
  for (const p of path.slice(1)) {
    const last = thin[thin.length - 1];
    if (distM(last[0], last[1], p[0], p[1]) >= 5) thin.push(p);
  }
  const by = String(body.by ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return {
    name,
    sf: { lat: +lat.toFixed(7), lon: +lon.toFixed(7), heading: heading === null ? null : +heading.toFixed(1) },
    half_width_m: halfWidth,
    length_m: Math.round(trace.lengthM),
    path: thin.map(([a, b]) => [+Number(a).toFixed(6), +Number(b).toFixed(6)]),
    source: 'upload',
    ...(by ? { by } : {}),
    trace,
  };
}

/** Layouts in the database that are the same track as this lap (best match first). */
export function findDuplicates(trace, layouts) {
  const out = [];
  for (const l of layouts || []) {
    if (!Array.isArray(l.path) || l.path.length < 20) continue;
    if (distM(trace.lat[0], trace.lon[0], l.sf.lat, l.sf.lon) > 5000) continue;
    const r = sameLayout(trace, buildTrace(l.path));
    if (r.same) out.push({ layout: l, score: r.score });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function slug(name) {
  const s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'track').slice(0, 60).replace(/-+$/, '');
}
