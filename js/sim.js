// Drill simulation: skater timing along their paths, and puck timelines (carry / pass / shoot / pickup).
import * as G from './geometry.js';

export const SEG = 8;                              // spline subdivisions per waypoint segment
export const PUCK_OFFSET = { x: 2.2, y: 1.4 };     // where a carried puck sits relative to the skater
export const DEFAULT_PASS_SPEED = 45;              // ft/s
export const DEFAULT_SHOT_SPEED = 90;              // ft/s

/** A skater's full path: its own position followed by its waypoints. */
export function skaterPoints(o) { return [{ x: o.x, y: o.y }, ...(o.path || [])]; }

export const withOffset = p => ({ x: p.x + PUCK_OFFSET.x, y: p.y + PUCK_OFFSET.y });

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
      t = { dense, cum, len: cum[cum.length - 1], delay: +o.delay || 0, speed: Math.max(1, +o.speed || 20), nPts: pts.length };
      timings.set(id, t);
    }
    return t;
  }

  function skaterPos(id, t) {
    const tm = skater(id);
    return G.pointAt(tm.dense, tm.cum, G.clamp((t - tm.delay) * tm.speed, 0, tm.len));
  }

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
        const from = withOffset(skaterPos(carrier, tr));
        // Lead the receiver: iterate travel time against where they'll be on arrival.
        let travel = G.dist(from, withOffset(skaterPos(ev.to, tr))) / passSpeed;
        for (let i = 0; i < 4; i++) travel = G.dist(from, withOffset(skaterPos(ev.to, tr + travel))) / passSpeed;
        const to = withOffset(skaterPos(ev.to, tr + travel));
        segs.push({ t0: tr, t1: tr + travel, kind: 'flying', from, to });
        t = tr + travel; carrier = ev.to;
        Object.assign(rec, { ok: true, t: tr, from, to });
      } else if (ev.type === 'shoot') {
        const tr = Math.max(t, wpTime(carrier, ev.wp));
        segs.push({ t0: t, t1: tr, kind: 'carried', carrier });
        const from = withOffset(skaterPos(carrier, tr));
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
    if (seg.kind === 'carried') return withOffset(skaterPos(seg.carrier, t));
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

  return { byId, skater, skaterPos, skaterEnd, wpTime, puck, puckPos, puckCarrierAt, duration };
}
