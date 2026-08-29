// Drill simulation: skater timing along their paths, and puck timelines (carry / pass / shoot / pickup).
import * as G from './geometry.js';

export const SEG = 8;                              // spline subdivisions per waypoint segment
export const DEFAULT_PASS_SPEED = 45;              // ft/s
export const DEFAULT_SHOT_SPEED = 90;              // ft/s

/**
 * Stick geometry, in the player's own frame (x forward, y to the player's right).
 * The blade heel sits `reach` ft ahead of the body centre and `lat` ft to the side; a carried puck rides
 * `puck` ft beyond the blade, so the puck leads the skater.
 */
export const STICK = {
  reach: 4.2,   // ft from body centre to the blade heel
  puck: 0.6,    // ft beyond the blade where a carried puck sits
  rest: 1.3,    // lateral position on a straight (forehand side)
  max: 2.3,     // furthest the blade swings to either side
  tau: 2,       // ft of travel over which the blade eases toward its target side
  avoid: 6,     // ft: cones/tires closer than this push the puck to the far side
  curve: 12,    // lateral ft per rad/ft of turn (puck swings to the outside of a turn)
  step: 0.5,    // ft between precomputed stick samples along a path
};

/** A skater's full path: its own position followed by its waypoints. */
export function skaterPoints(o) { return [{ x: o.x, y: o.y }, ...(o.path || [])]; }

/** Blade heel (bx,by), shaft direction (ux,uy) and blade normal (nx,ny) for a lateral blade offset. */
export function stickGeom(lat) {
  const bx = STICK.reach, by = lat;
  const len = Math.hypot(bx, by);
  const ux = bx / len, uy = by / len;
  return { bx, by, ux, uy, nx: -uy, ny: ux };
}

/** World position of the puck on a player's blade for a pose {x, y, heading (rad), lat}. */
export function bladePos(pose) {
  const g = stickGeom(pose.lat);
  const lx = g.bx + STICK.puck * g.ux, ly = g.by + STICK.puck * g.uy;
  const c = Math.cos(pose.heading), s = Math.sin(pose.heading);
  return { x: pose.x + c * lx - s * ly, y: pose.y + s * lx + c * ly };
}

const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Heading (radians) of a player that is not moving along a path: the explicit `facing` if set, otherwise
 * skaters face the nearest net, goalies and coaches face centre ice.
 */
export function facingOf(o, objs = []) {
  if (o.facing !== undefined && o.facing !== null && o.facing !== '') return (+o.facing) * Math.PI / 180;
  let target = { x: 100, y: 42.5 };
  if (o.type === 'skater' && o.role !== 'G') {
    let bd = Infinity;
    for (const x of objs) if (x.type === 'net') { const d = G.dist(x, o); if (d < bd) { bd = d; target = x; } }
  }
  return Math.atan2(target.y - o.y, target.x - o.x);
}

/**
 * Stick samples along a skater's path, every STICK.step ft: heading (body facing) and lateral blade offset.
 * The blade rests on the forehand side, swings to the outside of turns and to the far side of nearby
 * cones/tires, easing between targets over STICK.tau ft so it sweeps rather than snaps.
 */
function stickFrames(o, dense, cum, objs) {
  const len = cum[cum.length - 1];
  if (len < 0.01) return { step: 0, h: [facingOf(o, objs)], l: [STICK.rest] };
  const flip = o.backward ? Math.PI : 0;
  const N = Math.max(2, Math.ceil(len / STICK.step) + 1);
  const step = len / (N - 1);
  const ease = 1 - Math.exp(-step / STICK.tau);
  const obstacles = objs.filter(x => x.type === 'cone' || x.type === 'tire');
  const h = [], l = [];
  let lat = null, prevH = null;
  for (let i = 0; i < N; i++) {
    const d = i * step;
    const p = G.pointAt(dense, cum, d);
    const a = G.pointAt(dense, cum, Math.max(0, d - 0.5)), b = G.pointAt(dense, cum, Math.min(len, d + 0.5));
    const hd = wrapAngle(Math.atan2(b.y - a.y, b.x - a.x) + flip);
    let target = STICK.rest;
    if (prevH !== null) target -= G.clamp(wrapAngle(hd - prevH) / step * STICK.curve, -STICK.max, STICK.max);
    for (const c of obstacles) {
      const dc = G.dist(c, p);
      if (dc >= STICK.avoid) continue;
      const side = Math.cos(hd) * (c.y - p.y) - Math.sin(hd) * (c.x - p.x); // >0: obstacle on the player's right
      target -= Math.sign(side || 1) * (1 - dc / STICK.avoid) * 2 * STICK.max;
    }
    target = G.clamp(target, -STICK.max, STICK.max);
    lat = lat === null ? target : lat + (target - lat) * ease;
    h.push(hd); l.push(lat); prevH = hd;
  }
  return { step, h, l };
}

/**
 * Build a (lazily cached) simulation for a drill. Everything is a pure function of the drill's objects;
 * rebuild it whenever the objects change.
 */
export function makeSim(drill) {
  const objs = drill.objects;
  const byId = id => objs.find(o => o.id === id);
  const isSkater = id => byId(id)?.type === 'skater';
  const timings = new Map();
  const pucks = new Map();

  function skater(id) {
    let t = timings.get(id);
    if (!t) {
      const o = byId(id);
      const pts = skaterPoints(o);
      const dense = G.smoothPath(pts, SEG);
      const cum = G.cumulative(dense);
      t = { dense, cum, len: cum[cum.length - 1], delay: +o.delay || 0, speed: Math.max(1, +o.speed || 20), nPts: pts.length, frames: stickFrames(o, dense, cum, objs) };
      timings.set(id, t);
    }
    return t;
  }

  function skaterPos(id, t) {
    const tm = skater(id);
    return G.pointAt(tm.dense, tm.cum, G.clamp((t - tm.delay) * tm.speed, 0, tm.len));
  }

  /** Position, body heading (radians) and lateral blade offset of a skater at time t. */
  function skaterPose(id, t) {
    const tm = skater(id);
    const d = G.clamp((t - tm.delay) * tm.speed, 0, tm.len);
    const p = G.pointAt(tm.dense, tm.cum, d);
    const { step, h, l } = tm.frames;
    if (h.length < 2) return { x: p.x, y: p.y, heading: h[0], lat: l[0] };
    const f = G.clamp(d / step, 0, h.length - 1);
    const i = Math.min(Math.floor(f), h.length - 2), u = f - i;
    return { x: p.x, y: p.y, heading: h[i] + wrapAngle(h[i + 1] - h[i]) * u, lat: l[i] + (l[i + 1] - l[i]) * u };
  }

  /** Where a puck carried by skater `id` is at time t (on the blade). */
  function puckAt(id, t) { return bladePos(skaterPose(id, t)); }

  function skaterEnd(id) { const tm = skater(id); return tm.delay + tm.len / tm.speed; }

  /** Time at which a skater reaches waypoint `wp` (0 = its start position, 1.. = path waypoints). */
  function wpTime(id, wp) {
    const tm = skater(id);
    const k = G.clamp(Math.round(+wp || 0), 0, tm.nPts - 1);
    const idx = tm.nPts < 3 ? k : k * SEG;
    return tm.delay + tm.cum[Math.min(idx, tm.cum.length - 1)] / tm.speed;
  }

  function nearestNet(p) {
    let best = null, bd = Infinity;
    for (const o of objs) if (o.type === 'net') { const d = G.dist(o, p); if (d < bd) { bd = d; best = o; } }
    return best ? { x: best.x, y: best.y } : { x: 189, y: 42.5 };
  }

  /**
   * Puck timeline: a list of segments {t0,t1,kind:'carried'|'flying'|'loose',...} plus per-event info
   * (whether it resolved, when it fires, and the pass/shot line endpoints for drawing).
   */
  function puck(id) {
    let s = pucks.get(id);
    if (s) return s;
    const p = byId(id);
    const segs = [], info = [];
    let t = 0;
    let carrier = isSkater(p.carrier) ? p.carrier : null;
    let loose = { x: p.x, y: p.y };
    const passSpeed = +p.passSpeed || DEFAULT_PASS_SPEED;
    const shotSpeed = +p.shotSpeed || DEFAULT_SHOT_SPEED;

    for (const ev of p.events || []) {
      const rec = { type: ev.type, carrier, ok: false, t: null };
      info.push(rec);
      if (ev.type === 'pickup') {
        if (carrier || !isSkater(ev.skater)) continue;
        const tp = Math.max(t, wpTime(ev.skater, ev.wp));
        segs.push({ t0: t, t1: tp, kind: 'loose', at: loose });
        t = tp; carrier = ev.skater;
        Object.assign(rec, { ok: true, t: tp, at: loose });
      } else if (!carrier) {
        continue; // nobody to pass/shoot
      } else if (ev.type === 'pass') {
        if (!isSkater(ev.to) || ev.to === carrier) continue;
        const tr = Math.max(t, wpTime(carrier, ev.wp));
        segs.push({ t0: t, t1: tr, kind: 'carried', carrier });
        const from = puckAt(carrier, tr);
        // Lead the receiver: iterate travel time against where they'll be on arrival.
        let travel = G.dist(from, puckAt(ev.to, tr)) / passSpeed;
        for (let i = 0; i < 4; i++) travel = G.dist(from, puckAt(ev.to, tr + travel)) / passSpeed;
        const to = puckAt(ev.to, tr + travel);
        segs.push({ t0: tr, t1: tr + travel, kind: 'flying', from, to });
        t = tr + travel; carrier = ev.to;
        Object.assign(rec, { ok: true, t: tr, from, to });
      } else if (ev.type === 'shoot') {
        const tr = Math.max(t, wpTime(carrier, ev.wp));
        segs.push({ t0: t, t1: tr, kind: 'carried', carrier });
        const from = puckAt(carrier, tr);
        const to = ev.target || nearestNet(from);
        const travel = G.dist(from, to) / shotSpeed;
        segs.push({ t0: tr, t1: tr + travel, kind: 'flying', from, to });
        t = tr + travel; carrier = null; loose = to;
        Object.assign(rec, { ok: true, t: tr, from, to });
      }
    }
    segs.push(carrier ? { t0: t, t1: Infinity, kind: 'carried', carrier } : { t0: t, t1: Infinity, kind: 'loose', at: loose });
    s = { segs, info, end: t };
    pucks.set(id, s);
    return s;
  }

  function puckPos(id, t) {
    const { segs } = puck(id);
    let seg = segs[segs.length - 1];
    for (const s of segs) if (t >= s.t0 && t < s.t1) { seg = s; break; }
    if (seg.kind === 'carried') return puckAt(seg.carrier, t);
    if (seg.kind === 'loose') return seg.at;
    const f = seg.t1 > seg.t0 ? G.clamp((t - seg.t0) / (seg.t1 - seg.t0), 0, 1) : 1;
    return { x: seg.from.x + (seg.to.x - seg.from.x) * f, y: seg.from.y + (seg.to.y - seg.from.y) * f };
  }

  /** Which skater carries the puck at time t (null if loose/flying). */
  function puckCarrierAt(id, t) {
    for (const s of puck(id).segs) if (t >= s.t0 && t < s.t1) return s.kind === 'carried' ? s.carrier : null;
    const last = puck(id).segs.at(-1);
    return last.kind === 'carried' ? last.carrier : null;
  }

  function duration() {
    let T = 0;
    for (const o of objs) {
      if (o.type === 'skater' && o.path?.length) T = Math.max(T, skaterEnd(o.id));
      if (o.type === 'puck') T = Math.max(T, puck(o.id).end);
    }
    return Math.round(T * 100) / 100;
  }

  return { byId, skater, skaterPos, skaterPose, puckAt, skaterEnd, wpTime, puck, puckPos, puckCarrierAt, duration };
}
