// Geometry helpers. All coordinates are in rink feet.

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Catmull-Rom spline through the given points, returned as a dense polyline. */
export function smoothPath(pts, seg = 8) {
  if (pts.length < 3) return pts.map(p => ({ x: p.x, y: p.y }));
  const out = [{ x: pts[0].x, y: pts[0].y }];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
    for (let j = 1; j <= seg; j++) {
      const t = j / seg, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return out;
}

/** Cumulative arc length at each vertex of a polyline. */
export function cumulative(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]));
  return c;
}

/** Point (and heading angle in radians) at arc-length distance d along a polyline. */
export function pointAt(pts, cum, d) {
  const total = cum[cum.length - 1];
  if (pts.length === 1 || d <= 0) return { x: pts[0].x, y: pts[0].y, angle: heading(pts, 0) };
  if (d >= total) return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, angle: heading(pts, pts.length - 2) };
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
  const segLen = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / segLen;
  const a = pts[lo], b = pts[hi];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

function heading(pts, i) {
  if (pts.length < 2) return 0;
  const a = pts[Math.max(0, i)], b = pts[Math.min(pts.length - 1, i + 1)];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** Ramer–Douglas–Peucker simplification. */
export function rdp(pts, eps = 1) {
  if (pts.length < 3) return pts.slice();
  const first = pts[0], last = pts[pts.length - 1];
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], first, last);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const l = rdp(pts.slice(0, idx + 1), eps), r = rdp(pts.slice(idx), eps);
    return l.slice(0, -1).concat(r);
  }
  return [first, last];
}

function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Closest point on a polyline to p: its coordinates, arc-length distance `d` along the line, and `dist` from p. */
export function projectOnPolyline(pts, cum, p) {
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, d: 0, dist: dist(p, pts[0]) };
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const dd = dist(p, q);
    if (!best || dd < best.dist) best = { x: q.x, y: q.y, d: cum[i] + t * Math.sqrt(l2), dist: dd };
  }
  return best;
}

/** Closest point on a polyline to p: arc-length along it and the offset distance. */
export function closestOnPolyline(pts, p) {
  if (!pts.length) return { along: 0, dist: Infinity };
  if (pts.length === 1) return { along: 0, dist: dist(p, pts[0]) };
  let along = 0, best = Infinity, run = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
    const u = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const d = dist(p, { x: a.x + u * dx, y: a.y + u * dy });
    if (d < best) { best = d; along = run + u * len; }
    run += len;
  }
  return { along, dist: best };
}

export function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const round1 = v => Math.round(v * 10) / 10;
