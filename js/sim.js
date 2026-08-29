// Drill simulation: skater timing along their paths, and puck timelines (carry / pass / shoot / pickup).
import * as G from './geometry.js';

export const SEG = 8;                              // spline subdivisions per waypoint segment
export const DEFAULT_PASS_SPEED = 45;              // ft/s
export const DEFAULT_SHOT_SPEED = 90;              // ft/s

/**
 * Where a carried puck sits, in the skater's own frame (x forward, y to the skater's right):
 * `lead` ft ahead of the body centre and `lat` ft to the side, so the puck leads the skater.
 */
export const CARRY = {
  lead: 4.5,    // ft ahead of the body centre
  rest: 1.3,    // lateral position on a straight (forehand side)
  max: 2.3,     // furthest the puck swings to either side
  tau: 2,       // ft of travel over which the puck eases toward its target side
  avoid: 6,     // ft: cones/tires closer than this push the puck to the far side
  curve: 12,    // lateral ft per rad/ft of turn (puck swings to the outside of a turn)
  step: 0.5,    // ft between precomputed samples along a path
};

/** A skater's full path: its own position followed by its waypoints. */
export function skaterPoints(o) { return [{ x: o.x, y: o.y }, ...(o.path || [])]; }

/** World position of a carried puck for a skater pose {x, y, heading (rad), lat}. */
export function carriedPuckPos(pose) {
  const c = Math.cos(pose.heading), s = Math.sin(pose.heading);
  return { x: pose.x + c * CARRY.lead - s * pose.lat, y: pose.y + s * CARRY.lead + c * pose.lat };
}

const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

/** Skaters and coaches can carry, pass and receive the puck. */
export const isPlayer = o => o?.type === 'skater' || o?.type === 'coach';

/**
 * Heading (radians) of a player that is not moving along a path: the explicit `facing` if set, otherwise
 * skaters face the nearest net; goalies and coaches face centre ice.
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
 * Puck-carry samples along a skater's path, every CARRY.step ft: heading (body facing) and lateral puck offset.
 * The puck rests on the forehand side, swings to the outside of turns and to the far side of nearby
 * cones/tires, easing between targets over CARRY.tau ft so it sweeps rather than snaps.
 */
function carryFrames(o, dense, cum, objs) {
  const len = cum[cum.length - 1];
  if (len < 0.01) return { step: 0, h: [facingOf(o, objs)], l: [CARRY.rest] };
  const flip = o.backward ? Math.PI : 0;
  const N = Math.max(2, Math.ceil(len / CARRY.step) + 1);
  const step = len / (N - 1);
  const ease = 1 - Math.exp(-step / CARRY.tau);
  const obstacles = objs.filter(x => x.type === 'cone' || x.type === 'tire');
  const h = [], l = [];
  let lat = null, prevH = null;
  for (let i = 0; i < N; i++) {
    const d = i * step;
    const p = G.pointAt(dense, cum, d);
    const a = G.pointAt(dense, cum, Math.max(0, d - 0.5)), b = G.pointAt(dense, cum, Math.min(len, d + 0.5));
    const hd = wrapAngle(Math.atan2(b.y - a.y, b.x - a.x) + flip);
    let target = CARRY.rest;
    if (prevH !== null) target -= G.clamp(wrapAngle(hd - prevH) / step * CARRY.curve, -CARRY.max, CARRY.max);
    for (const c of obstacles) {
      const dc = G.dist(c, p);
      if (dc >= CARRY.avoid) continue;
      const side = Math.cos(hd) * (c.y - p.y) - Math.sin(hd) * (c.x - p.x); // >0: obstacle on the skater's right
      target -= Math.sign(side || 1) * (1 - dc / CARRY.avoid) * 2 * CARRY.max;
    }
    target = G.clamp(target, -CARRY.max, CARRY.max);
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
  const isSkater = id => isPlayer(byId(id)); // any puck-handling player (skater or coach)
  /** Where to draw an event marker: the player's spot on their path — none for players that don't move. */
  const markAt = (id, t) => (byId(id)?.path?.length ? skaterPos(id, t) : null);
  const timings = new Map();
  const pucks = new Map();

  function skater(id) {
    let t = timings.get(id);
    if (!t) {
      const o = byId(id);
      const pts = skaterPoints(o);
      const dense = G.smoothPath(pts, SEG);
      const cum = G.cumulative(dense);
      t = { dense, cum, len: cum[cum.length - 1], delay: +o.delay || 0, speed: Math.max(1, +o.speed || 20), nPts: pts.length, frames: carryFrames(o, dense, cum, objs) };
      timings.set(id, t);
    }
    return t;
  }

  function skaterPos(id, t) {
    const tm = skater(id);
    return G.pointAt(tm.dense, tm.cum, G.clamp((t - tm.delay) * tm.speed, 0, tm.len));
  }

  /** Position, body heading (radians) and lateral puck offset of a skater at time t. */
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

  /** Where a puck carried by skater `id` is at time t (ahead of the skater). */
  function puckAt(id, t) { return carriedPuckPos(skaterPose(id, t)); }

  function skaterEnd(id) { const tm = skater(id); return tm.delay + tm.len / tm.speed; }

  /** Time at which a skater reaches waypoint `wp` (0 = its start position, 1.. = path waypoints). */
  function wpTime(id, wp) {
    const tm = skater(id);
    const k = G.clamp(Math.round(+wp || 0), 0, tm.nPts - 1);
    const idx = tm.nPts < 3 ? k : k * SEG;
    return tm.delay + tm.cum[Math.min(idx, tm.cum.length - 1)] / tm.speed;
  }

  /**
   * When an event fires for skater `id`: at `ev.dist` ft along their path if it was marked on the path,
   * otherwise when they reach waypoint `ev.wp`.
   */
  function evTime(id, ev) {
    if (ev.dist != null && ev.dist !== '') {
      const tm = skater(id);
      return tm.delay + G.clamp(+ev.dist || 0, 0, tm.len) / tm.speed;
    }
    return wpTime(id, ev.wp);
  }

  function nearestNet(p) {
    let best = null, bd = Infinity;
    for (const o of objs) if (o.type === 'net') { const d = G.dist(o, p); if (d < bd) { bd = d; best = o; } }
    return best ? { x: best.x, y: best.y } : { x: 189, y: 42.5 };
  }

  /**
   * Puck timeline: a list of segments {t0,t1,kind:'carried'|'flying'|'loose',...} plus per-event info
   * (whether it resolved, when it fires, the pass/shot line endpoints for drawing, and `mark`: where the
   * skater is on their path when it happens).
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
        const want = evTime(ev.skater, ev), tp = Math.max(t, want);
        segs.push({ t0: t, t1: tp, kind: 'loose', at: loose });
        t = tp; carrier = ev.skater;
        Object.assign(rec, { ok: true, t: tp, late: tp > want + 1e-6, at: loose, mark: markAt(ev.skater, tp) });
      } else if (!carrier) {
        continue; // nobody to pass/shoot
      } else if (ev.type === 'pass') {
        // A bank pass bounces off the boards at ev.bank — and may come back to the passer themselves.
        const bank = ev.bank && Number.isFinite(+ev.bank.x) && Number.isFinite(+ev.bank.y) ? { x: +ev.bank.x, y: +ev.bank.y } : null;
        if (!isSkater(ev.to) || (ev.to === carrier && !bank)) continue;
        const flight = (a, b) => (bank ? G.dist(a, bank) + G.dist(bank, b) : G.dist(a, b)) / passSpeed;
        const byReceiver = ev.by === 'receiver';
        let want;
        if (byReceiver) {
          // Timed by the receiver: release early enough that the puck arrives as they reach their mark.
          const tArr = evTime(ev.to, ev);
          const to = puckAt(ev.to, tArr);
          let rel = tArr;
          for (let i = 0; i < 4; i++) rel = tArr - flight(puckAt(carrier, rel), to);
          want = rel; // may be < 0 or before the passer has the puck: max(t, …) below defers it and flags it late
        } else want = evTime(carrier, ev);
        const tr = Math.max(t, want);
        rec.late = tr > want + 1e-6;
        segs.push({ t0: t, t1: tr, kind: 'carried', carrier });
        const from = puckAt(carrier, tr);
        // Lead the receiver: iterate travel time against where they'll be on arrival.
        let travel = flight(from, puckAt(ev.to, tr));
        for (let i = 0; i < 4; i++) travel = flight(from, puckAt(ev.to, tr + travel));
        const to = puckAt(ev.to, tr + travel);
        if (bank) {
          const tb = tr + G.dist(from, bank) / passSpeed;
          segs.push({ t0: tr, t1: tb, kind: 'flying', from, to: bank }, { t0: tb, t1: tr + travel, kind: 'flying', from: bank, to });
        } else segs.push({ t0: tr, t1: tr + travel, kind: 'flying', from, to });
        t = tr + travel; carrier = ev.to;
        Object.assign(rec, { ok: true, t: tr, arrive: tr + travel, from, to, bank, by: byReceiver ? 'receiver' : 'carrier',
          mark: byReceiver ? markAt(ev.to, tr + travel) : markAt(rec.carrier, tr) });
      } else if (ev.type === 'shoot') {
        const want = evTime(carrier, ev), tr = Math.max(t, want);
        rec.late = tr > want + 1e-6;
        segs.push({ t0: t, t1: tr, kind: 'carried', carrier });
        const from = puckAt(carrier, tr);
        const to = ev.target || nearestNet(from);
        const travel = G.dist(from, to) / shotSpeed;
        segs.push({ t0: tr, t1: tr + travel, kind: 'flying', from, to });
        t = tr + travel; carrier = null; loose = to;
        Object.assign(rec, { ok: true, t: tr, from, to, mark: markAt(rec.carrier, tr) });
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

  return { byId, skater, skaterPos, skaterPose, puckAt, skaterEnd, wpTime, evTime, puck, puckPos, puckCarrierAt, duration };
}
