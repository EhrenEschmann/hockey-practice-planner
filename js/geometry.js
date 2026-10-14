// Geometry helpers. All coordinates are in rink feet.

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Catmull-Rom spline through the given points, returned as a dense polyline with `seg` samples per
 * input segment (so the sample count is uniform regardless of shape). Points flagged `stop` or
 * `corner` are hard corners: the spline breaks there — straight in, straight out — instead of arcing,
 * e.g. a skater who comes to a full stop and then changes direction.
 */
export function smoothPath(pts, seg = 8) {
  if (pts.length < 2) return pts.map(p => ({ x: p.x, y: p.y }));
  const runs = [];
  let start = 0;
  for (let i = 1; i < pts.length - 1; i++) if (+pts[i].stop > 0 || pts[i].corner) { runs.push(pts.slice(start, i + 1)); start = i; }
  runs.push(pts.slice(start));
  const out = [{ x: pts[0].x, y: pts[0].y }];
  for (const r of runs) { const d = smoothRun(r, seg); for (let i = 1; i < d.length; i++) out.push(d[i]); }
  return out;
}

function smoothRun(pts, seg) {
  const out = [{ x: pts[0].x, y: pts[0].y }];
  if (pts.length === 2) {
    for (let j = 1; j <= seg; j++) out.push({ x: pts[0].x + (pts[1].x - pts[0].x) * j / seg, y: pts[0].y + (pts[1].y - pts[0].y) * j / seg });
    return out;
  }
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

/** Ray-cast point-in-polygon test. */
export function pointInPolygon(pts, p) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
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

/** Signed curvature of the circumcircle through three points (0 for collinear). */
function circumCurvature(a, b, c) {
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d = dist(a, b) * dist(b, c) * dist(c, a);
  return d < 1e-9 ? 0 : (2 * cross) / d;
}

/** Least-squares (Kåsa) circle fit → { x, y, r }, or null for degenerate input. */
function fitCircle(pts) {
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / pts.length, my = sy / pts.length;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const uc = (svv * (suuu + suvv) - suv * (svvv + svuu)) / (2 * det);
  const vc = (suu * (svvv + svuu) - suv * (suuu + suvv)) / (2 * det);
  return { x: mx + uc, y: my + vc, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / pts.length) };
}

/**
 * Tidy a drawn path into the shape it was aiming for: straight-ish runs become straight lines, and
 * curved runs (a loop around a tire, a turn around a cone) become true circular arcs with evenly
 * spaced waypoints. Returns a fresh [start, ...waypoints] list; the start point is kept exactly.
 */
export function beautifyPath(pts) {
  const tidy = q => ({ x: round1(q.x), y: round1(q.y) });
  if (pts.length < 3) return pts.map(tidy);
  const dense = smoothPath(pts, 8);
  const cum = cumulative(dense);
  const len = cum[cum.length - 1];
  if (len < 4) return pts.map(tidy);
  // 1. even samples along the drawn line
  const step = clamp(len / 120, 1, 2.5);
  const P = [];
  for (let d = 0; d <= len + 1e-9; d += step) P.push(pointAt(dense, cum, Math.min(d, len)));
  // 2. curvature at each sample, over a ±3 ft window
  const w = Math.max(2, Math.round(3 / step));
  const curv = P.map((_, i) => (i < w || i >= P.length - w) ? null : circumCurvature(P[i - w], P[i], P[i + w]));
  for (let i = 0; i < w; i++) curv[i] = curv[w];
  for (let i = P.length - w; i < P.length; i++) curv[i] = curv[P.length - w - 1];
  // 3. classify (curved = turn radius under ~45 ft), then a small majority filter against jitter
  let cls = curv.map(k => Math.abs(k) > 1 / 45);
  cls = cls.map((c, i) => { const a = cls.slice(Math.max(0, i - 2), i + 3); return a.filter(Boolean).length > a.length / 2; });
  // 4. runs of one kind; short blips are absorbed by their neighbour
  const runs = [];
  for (let i = 0; i < P.length; i++) {
    const r = runs[runs.length - 1];
    if (r && r.curved === cls[i]) r.end = i;
    else runs.push({ curved: cls[i], start: i, end: i });
  }
  const minRun = Math.max(3, Math.round(5 / step));
  for (let i = runs.length - 1; i >= 0 && runs.length > 1; i--) {
    if (runs[i].end - runs[i].start + 1 >= minRun) continue;
    const into = runs[i - 1] || runs[i + 1];
    into.start = Math.min(into.start, runs[i].start);
    into.end = Math.max(into.end, runs[i].end);
    runs.splice(i, 1);
    if (runs[i] && runs[i - 1] && runs[i - 1].curved === runs[i].curved) { runs[i - 1].end = runs[i].end; runs.splice(i, 1); }
  }
  // 5. rebuild: a straight run is just its endpoint; a curved run is an even arc on its fitted circle.
  // A "curved" run that hugs its own chord is really a wobbly straight — treat it as one.
  const chordDev = seg => {
    const a0 = seg[0], b0 = seg[seg.length - 1], L = dist(a0, b0) || 1e-9;
    return Math.max(...seg.map(q => Math.abs((b0.x - a0.x) * (a0.y - q.y) - (a0.x - q.x) * (b0.y - a0.y)) / L));
  };
  const out = [P[0]];
  const push = q => { if (dist(out[out.length - 1], q) > 1.2) out.push(q); };
  for (const r of runs) {
    const seg = P.slice(r.start, r.end + 1);
    const endPt = seg[seg.length - 1];
    const straightish = !r.curved || seg.length < 4 || chordDev(seg) < Math.max(1.4, dist(seg[0], endPt) * 0.04);
    const c = straightish ? null : fitCircle(seg);
    if (!c || c.r < 1.5 || c.r > 80) { push(endPt); continue; }
    // unwrap the samples' angles so a loop past 360° survives
    const a = Math.atan2(seg[0].y - c.y, seg[0].x - c.x);
    let sweep = 0;
    for (let i = 1; i < seg.length; i++) {
      const ai = Math.atan2(seg[i].y - c.y, seg[i].x - c.x);
      let da = ai - (a + sweep);
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      sweep += da;
    }
    const nSeg = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 7)));
    for (let j = 1; j <= nSeg; j++) {
      const t = a + sweep * j / nSeg;
      push({ x: c.x + c.r * Math.cos(t), y: c.y + c.r * Math.sin(t), arc: true });
    }
  }
  const last = P[P.length - 1];
  if (dist(out[out.length - 1], last) > 0.6) out.push(last); else out[out.length - 1] = { ...last, arc: out[out.length - 1].arc };
  // 6. straight stretches collapse to clean lines (arc points are anchors and stay put)
  const res = [];
  let i0 = 0;
  for (let i = 1; i <= out.length; i++) {
    if (i < out.length && !out[i].arc) continue;
    const sub = out.slice(i0, Math.min(i + 1, out.length));
    const simp = rdp(sub, 1.2);
    res.push(...(res.length ? simp.slice(1) : simp));
    i0 = i;
  }
  return res.map(tidy);
}

export function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const round1 = v => Math.round(v * 10) / 10;
