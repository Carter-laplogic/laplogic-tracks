"""Are two GPS laps the same track layout? The rule Lap Logic uses to group sessions
(Lap Logic: Helpers/TrackLayouts.cs) and the upload service uses to spot duplicates
(service/src/layouts.js): each trace lies on the other almost everywhere (>= 97 % of its
points within 12 m, no stretch longer than 30 m off it), both are driven the same way round
and their lengths agree within 8 %. Layouts of one venue (MCC ACW / MCC National) always
have a section only one of them uses, so they stay apart; reversed layouts fail the
direction test."""
import math

M_PER_DEG = 111_195.0
ON_TRACK_M = 12.0
MAX_OFF_RUN_M = 30.0
MIN_ON_FRACTION = 0.97
MAX_LENGTH_RATIO = 1.08
STEP_M = 3.0
MAX_POINTS = 4000
CELL_M = 25.0


def build_trace(points):
    """One lap of [lat, lon] points, resampled every few metres; None if unusable."""
    valid = [(float(a), float(b)) for a, b in points
             if a and b and abs(a) <= 90 and abs(b) <= 180]
    if len(valid) < 20:
        return None
    lat0, lon0 = valid[0]
    kx = math.cos(math.radians(lat0)) * M_PER_DEG
    xy = [((lon - lon0) * kx, (lat - lat0) * M_PER_DEG) for lat, lon in valid]
    raw = sum(math.dist(xy[i - 1], xy[i]) for i in range(1, len(xy)))
    step = max(STEP_M, raw / MAX_POINTS)
    kept = [xy[0]]
    for p in xy[1:]:
        if math.dist(kept[-1], p) >= step:
            kept.append(p)
    total = sum(math.dist(kept[i - 1], kept[i]) for i in range(1, len(kept)))
    if len(kept) < 20 or total < 150 or total > 30_000:
        return None
    return {
        "lat": [lat0 + y / M_PER_DEG for _, y in kept],
        "lon": [lon0 + x / kx for x, _ in kept],
        "length_m": total,
    }


def _centre(t):
    return (min(t["lat"]) + max(t["lat"])) / 2, (min(t["lon"]) + max(t["lon"])) / 2


def _project(t, lat0, lon0, kx):
    return [((lo - lon0) * kx, (la - lat0) * M_PER_DEG) for la, lo in zip(t["lat"], t["lon"])]


def _grid(q):
    """Segment indices of q by the cells their bounding boxes (plus the tolerance) touch."""
    cells = {}
    for j in range(len(q) - 1):
        (ax, ay), (bx, by) = q[j], q[j + 1]
        x0 = int(math.floor((min(ax, bx) - ON_TRACK_M) / CELL_M))
        x1 = int(math.floor((max(ax, bx) + ON_TRACK_M) / CELL_M))
        y0 = int(math.floor((min(ay, by) - ON_TRACK_M) / CELL_M))
        y1 = int(math.floor((max(ay, by) + ON_TRACK_M) / CELL_M))
        for cx in range(x0, x1 + 1):
            for cy in range(y0, y1 + 1):
                cells.setdefault((cx, cy), []).append(j)
    return cells


def _coverage(p, q):
    """How much of p lies on q: share of points within tolerance, longest run off (m), heading agreement."""
    n = len(p)
    grid = _grid(q)
    off = [False] * n
    on = 0
    dir_sum, dir_n = 0.0, 0
    tol2 = ON_TRACK_M * ON_TRACK_M
    for i, (px, py) in enumerate(p):
        best, seg = float("inf"), -1
        for j in grid.get((int(math.floor(px / CELL_M)), int(math.floor(py / CELL_M))), ()):
            (ax, ay), (bx, by) = q[j], q[j + 1]
            vx, vy = bx - ax, by - ay
            l2 = vx * vx + vy * vy
            t = min(1.0, max(0.0, ((px - ax) * vx + (py - ay) * vy) / l2)) if l2 > 0 else 0.0
            ex, ey = ax + vx * t - px, ay + vy * t - py
            d2 = ex * ex + ey * ey
            if d2 < best:
                best, seg = d2, j
        if best > tol2:
            off[i] = True
            continue
        on += 1
        if 0 < i < n - 1:
            tx, ty = p[i + 1][0] - p[i - 1][0], p[i + 1][1] - p[i - 1][1]
            sx, sy = q[seg + 1][0] - q[seg][0], q[seg + 1][1] - q[seg][1]
            norm = math.sqrt((tx * tx + ty * ty) * (sx * sx + sy * sy))
            if norm > 0:
                dir_sum += (tx * sx + ty * sy) / norm
                dir_n += 1
    longest = run = 0
    for k in range(2 * n):  # a lap wraps around the start line
        run = run + 1 if off[k % n] else 0
        longest = max(longest, run)
    longest = min(longest, n)
    length = sum(math.dist(p[i - 1], p[i]) for i in range(1, n))
    spacing = length / (n - 1) if n > 1 else STEP_M
    return on / n, longest * spacing, (dir_sum / dir_n if dir_n else 0.0)


def same_layout(a, b):
    """(same?, score 0..1) for two traces from build_trace."""
    if not a or not b or len(a["lat"]) < 20 or len(b["lat"]) < 20:
        return False, 0.0
    lat0, lon0 = _centre(a)
    blat, blon = _centre(b)
    kx = math.cos(math.radians(lat0)) * M_PER_DEG
    if math.hypot((blon - lon0) * kx, (blat - lat0) * M_PER_DEG) > 3000:
        return False, 0.0  # another venue
    if max(a["length_m"], b["length_m"]) / min(a["length_m"], b["length_m"]) > MAX_LENGTH_RATIO:
        return False, 0.0  # another length = another layout
    pa, pb = _project(a, lat0, lon0, kx), _project(b, lat0, lon0, kx)
    ab, ba = _coverage(pa, pb), _coverage(pb, pa)
    score = (ab[0] + ba[0]) / 2
    if (ab[2] + ba[2]) / 2 < 0.5:
        return False, score  # driven the other way round
    a_on_b = ab[0] >= MIN_ON_FRACTION and ab[1] <= MAX_OFF_RUN_M
    b_on_a = ba[0] >= MIN_ON_FRACTION and ba[1] <= MAX_OFF_RUN_M
    return a_on_b and b_on_a, score
