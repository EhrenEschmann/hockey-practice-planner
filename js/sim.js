// Drill simulation: skater timing along their paths, and puck timelines (carry / pass / shoot / pickup).
import * as G from './geometry.js';

export const SEG = 8;                              // spline subdivisions per waypoint segment
export const CONTACT_DIST = 3.6;                   // ft: two skater bodies in contact
export const SLOW_FACTOR = 0.55;                   // the contact loser skates at this fraction of their speed afterwards
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
  // Stickhandling through small cones: the puck goes alternately left and right of successive cones.
  weave: 1.1,       // ft of clearance the puck keeps from each small cone
  weaveTau: 0.6,    // ft of travel over which the puck darts to the other side (quick hands)
  weaveReach: 2,    // a small cone within this many ft (ahead/behind) of the puck is the one being handled
  weaveOffset: 3.5, // small cones further than this from the path are ignored
  // Sliding under a raised pad: the puck is pushed straight ahead and further out.
  slideLead: 3,     // extra ft the puck is pushed ahead while sliding under a pad
  slideReach: 3,    // ft before/after the pad's edge where the slide (and the push) begins/ends
};

/** Point p in a pad's own frame (x along its length, y across its depth). */
function padLocal(p, pad) {
  const a = -(pad.rot || 0) * Math.PI / 180;
  const dx = p.x - pad.x, dy = p.y - pad.y;
  return { lx: dx * Math.cos(a) - dy * Math.sin(a), ly: dx * Math.sin(a) + dy * Math.cos(a) };
}

/** Is point p within `margin` ft of a pad's footprint (a w x h rectangle rotated by pad.rot)? */
export function underPad(p, pad, margin = 1) {
  const { lx, ly } = padLocal(p, pad);
  return Math.abs(lx) <= (pad.w || 6) / 2 + margin && Math.abs(ly) <= (pad.h || 2) / 2 + margin;
}

/** Pads that skaters go over or under (and push the puck ahead of). */
export const isPad = o => o?.type === 'raisedpad' || o?.type === 'jumppad';

/**
 * How high a skater is in a jump over `pad` at pose {x, y, heading}: 0 on the ice, 1 at the peak over the
 * pad's centre line. The take-off and landing are `reach` ft either side of the pad, measured along the
 * skater's direction of travel, so the arc fits the pad however it is crossed.
 */
export function jumpHeight(pose, pad, reach = 1.5) {
  if (!underPad(pose, pad, reach)) return 0;
  const rot = (pad.rot || 0) * Math.PI / 180;
  const th = pose.heading - rot; // travel direction in the pad's frame
  const half = (pad.w || 6) / 2 * Math.abs(Math.cos(th)) + (pad.h || 1.5) / 2 * Math.abs(Math.sin(th)) + reach;
  const { lx, ly } = padLocal(pose, pad);
  const s = lx * Math.cos(th) + ly * Math.sin(th); // progress across the pad along the travel direction
  return Math.max(0, Math.cos(Math.PI / 2 * s / half));
}

/** A skater's full path: its own position followed by its waypoints. */
export function skaterPoints(o) { return [{ x: o.x, y: o.y }, ...(o.path || [])]; }

/** World position of a carried puck for a skater pose {x, y, heading (rad), lat, lead?}. */
export function carriedPuckPos(pose) {
  const c = Math.cos(pose.heading), s = Math.sin(pose.heading);
  const lead = pose.lead ?? CARRY.lead;
  return { x: pose.x + c * lead - s * pose.lat, y: pose.y + s * lead + c * pose.lat };
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
  if (len < 0.01) return { step: 0, h: [facingOf(o, objs)], l: [CARRY.rest], f: [CARRY.lead] };
  const flip = o.backward ? Math.PI : 0;
  const N = Math.max(2, Math.ceil(len / CARRY.step) + 1);
  const step = len / (N - 1);
  const ease = 1 - Math.exp(-step / CARRY.tau);
  const obstacles = objs.filter(x => x.type === 'cone' || x.type === 'tire');
  // Small cones near the path, in the order the skater meets them; the puck passes them on alternating sides.
  const small = objs.filter(x => x.type === 'minicone')
    .map(c => ({ c, ...G.projectOnPolyline(dense, cum, c) }))
    .filter(s => s.dist < CARRY.weaveOffset)
    .sort((a, b) => a.d - b.d)
    .map((s, i) => ({ c: s.c, side: i % 2 ? -1 : 1 }));
  const easeFast = 1 - Math.exp(-step / CARRY.weaveTau);
  const pads = objs.filter(isPad);
  const h = [], l = [], f = [];
  let lat = null, lead = CARRY.lead, prevH = null;
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
    let k = ease;
    // Stickhandling: which small cone is the puck at right now (in the skater's frame the puck sits `lead` ft ahead)?
    let handling = null, best = CARRY.weaveReach;
    for (const s of small) {
      const dx = s.c.x - p.x, dy = s.c.y - p.y;
      const f = Math.cos(hd) * dx + Math.sin(hd) * dy, ly = Math.cos(hd) * dy - Math.sin(hd) * dx;
      const off = Math.abs(f - CARRY.lead);
      if (off < best && Math.abs(ly) < CARRY.weaveOffset) { best = off; handling = { ly, side: s.side }; }
    }
    if (handling) { target = handling.ly + handling.side * CARRY.weave; k = easeFast; }
    // Sliding under a raised pad or jumping a low one: push the puck straight ahead and further out first.
    let leadTarget = CARRY.lead;
    if (pads.some(pd => underPad(p, pd, CARRY.slideReach))) { target = 0; leadTarget = CARRY.lead + CARRY.slideLead; k = easeFast; }
    lat = lat === null ? target : lat + (target - lat) * k;
    lead += (leadTarget - lead) * easeFast;
    h.push(hd); l.push(lat); f.push(lead); prevH = hd;
  }
  return { step, h, l, f };
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

  /**
   * When a player starts moving: their start delay, plus — if they are triggered by another player — the
   * moment that player reaches the trigger waypoint. (A cycle of triggers falls back to the plain delay.)
   */
  const starting = new Set();
  function startTime(o) {
    let t0 = +o.delay || 0;
    const tr = o.trigger;
    if (tr && tr.player !== o.id && isSkater(tr.player) && !starting.has(o.id)) {
      starting.add(o.id);
      try { t0 += evTime(tr.player, { wp: tr.wp ?? 0, dist: tr.dist }); } finally { starting.delete(o.id); }
    }
    return t0;
  }

  function skater(id) {
    let t = timings.get(id);
    if (!t) {
      const o = byId(id);
      const pts = skaterPoints(o);
      const dense = G.smoothPath(pts, SEG);
      const cum = G.cumulative(dense);
      t = { dense, cum, len: cum[cum.length - 1], delay: startTime(o) + syncExtra(o.id), speed: Math.max(1, +o.speed || 20), nPts: pts.length, frames: carryFrames(o, dense, cum, objs) };
      const st = slowTime(o.id);
      if (st != null) {
        const d0 = G.clamp((st - t.delay) * t.speed, 0, t.len);
        if (d0 < t.len) t.slow = { t0: st, d0 };
      }
      timings.set(id, t);
    }
    return t;
  }

  function skaterPos(id, t) {
    const tm = skater(id);
    return G.pointAt(tm.dense, tm.cum, distAt(tm, t));
  }

  /** Position, body heading (radians) and lateral puck offset of a skater at time t. */
  function skaterPose(id, t) {
    const tm = skater(id);
    const d = distAt(tm, t);
    const p = G.pointAt(tm.dense, tm.cum, d);
    const { step, h, l, f } = tm.frames;
    if (h.length < 2) return { x: p.x, y: p.y, heading: h[0], lat: l[0], lead: f[0] };
    const q = G.clamp(d / step, 0, h.length - 1);
    const i = Math.min(Math.floor(q), h.length - 2), u = q - i;
    return { x: p.x, y: p.y, heading: h[i] + wrapAngle(h[i + 1] - h[i]) * u, lat: l[i] + (l[i + 1] - l[i]) * u, lead: f[i] + (f[i + 1] - f[i]) * u };
  }

  /** Where a puck carried by skater `id` is at time t (ahead of the skater). */
  function puckAt(id, t) { return carriedPuckPos(skaterPose(id, t)); }

  function skaterEnd(id) { const tm = skater(id); return timeAt(tm, tm.len); }

  /** Time at which a skater reaches waypoint `wp` (0 = its start position, 1.. = path waypoints). */
  function wpTime(id, wp) {
    const tm = skater(id);
    const k = G.clamp(Math.round(+wp || 0), 0, tm.nPts - 1);
    const idx = tm.nPts < 3 ? k : k * SEG;
    return timeAt(tm, tm.cum[Math.min(idx, tm.cum.length - 1)]);
  }

  /**
   * When an event fires for skater `id`: at `ev.dist` ft along their path if it was marked on the path,
   * otherwise when they reach waypoint `ev.wp`.
   */
  function evTime(id, ev) {
    if (ev.dist != null && ev.dist !== '') {
      const tm = skater(id);
      return timeAt(tm, +ev.dist || 0);
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
    // A puck taken from a pile starts in the pile (and follows it if the pile is moved).
    const pile = p.pile ? byId(p.pile) : null;
    let loose = pile?.type === 'pile' ? { x: pile.x, y: pile.y } : { x: p.x, y: p.y };
    const passSpeed = +p.passSpeed || DEFAULT_PASS_SPEED;
    const shotSpeed = +p.shotSpeed || DEFAULT_SHOT_SPEED;

    // The contact loser is stripped: a puck they carry transfers to the winner at the hit.
    const steals = [];
    if (drill.impactLoser) for (const c of objs) {
      if (c.type !== 'contact' || (c.a !== drill.impactLoser && c.b !== drill.impactLoser)) continue;
      const ci = contactSync(c.id);
      if (ci.ok) steals.push({ t: ci.t, from: drill.impactLoser, to: c.a === drill.impactLoser ? c.b : c.a, used: false });
    }
    steals.sort((x, y) => x.t - y.t);
    /** Push a carried segment up to t1, splitting it wherever a steal strips the carrier. */
    function pushCarried(t1) {
      for (const st of steals) {
        if (st.used || carrier !== st.from || st.t <= t || st.t >= t1) continue;
        segs.push({ t0: t, t1: st.t, kind: 'carried', carrier });
        t = st.t; carrier = st.to; st.used = true;
        info.steal = { t: st.t, from: st.from, to: st.to }; // surfaced in the properties panel
      }
      segs.push({ t0: t, t1, kind: 'carried', carrier });
      t = t1;
    }

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
        pushCarried(tr);
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
        pushCarried(tr);
        const from = puckAt(carrier, tr);
        const to = ev.target || nearestNet(from);
        const travel = G.dist(from, to) / shotSpeed;
        segs.push({ t0: tr, t1: tr + travel, kind: 'flying', from, to });
        t = tr + travel; carrier = null; loose = to;
        Object.assign(rec, { ok: true, t: tr, from, to, mark: markAt(rec.carrier, tr) });
      }
    }
    if (carrier) pushCarried(Infinity);
    else segs.push({ t0: t, t1: Infinity, kind: 'loose', at: loose });
    s = { segs, info, end: segs.at(-1).t0 };
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

  // ----- explicit contact markers: sync the two skaters so they meet at the marker -----
  let syncCache = null;
  const slowCache = new Map();  // loser skater id → time of the hit that slows them
  const contactInfoCache = new Map();
  const movingSkater = o => o?.type === 'skater' && o.path?.length;
  let syncing = false;

  /** Closest approach of a skater's path to a point: arc-length along the path and the offset distance. */
  function closestAlong(o, p) {
    return G.closestOnPolyline(G.smoothPath(skaterPoints(o), SEG), p);
  }

  function buildSync() {
    syncing = true;
    try {
      syncCache = new Map();
      slowCache.clear();
      contactInfoCache.clear();
      for (const c of objs) {
        if (c.type !== 'contact') continue;
        const A = byId(c.a), B = byId(c.b);
        if (!movingSkater(A) || !movingSkater(B) || c.a === c.b) { contactInfoCache.set(c.id, { ok: false }); continue; }
        const ga = closestAlong(A, c), gb = closestAlong(B, c);
        // A marker nowhere near both paths is a stray (often left off-view): it must not
        // fabricate an impact or distort the skaters' timing.
        if (Math.max(ga.dist, gb.dist) > CONTACT_DIST * 2) { contactInfoCache.set(c.id, { ok: false, far: Math.max(ga.dist, gb.dist) }); continue; }
        const ta = startTime(A) + (syncCache.get(c.a) || 0) + ga.along / Math.max(1, +A.speed || 20);
        const tb = startTime(B) + (syncCache.get(c.b) || 0) + gb.along / Math.max(1, +B.speed || 20);
        const t = Math.max(ta, tb);
        const aWait = t - ta, bWait = t - tb;
        if (aWait > 0) syncCache.set(c.a, (syncCache.get(c.a) || 0) + aWait);
        if (bWait > 0) syncCache.set(c.b, (syncCache.get(c.b) || 0) + bWait);
        contactInfoCache.set(c.id, { ok: true, t, aWait, bWait, aOff: ga.dist, bOff: gb.dist });
        const loser = drill.impactLoser;
        if (loser === c.a || loser === c.b) slowCache.set(loser, Math.min(slowCache.get(loser) ?? Infinity, t));
      }
    } finally {
      syncing = false;
      timings.clear(); // anything cached mid-build lacks the sync delays
    }
  }

  /** Extra wait a contact marker imposes on this skater so both parties arrive together. */
  function syncExtra(id) {
    if (syncing) return 0;
    if (!syncCache) buildSync();
    return syncCache.get(id) || 0;
  }

  /** When this skater gets the worse of a contact (null if never): they skate at SLOW_FACTOR afterwards. */
  function slowTime(id) {
    if (syncing) return null;
    if (!syncCache) buildSync();
    return slowCache.get(id) ?? null;
  }

  /** Distance along the path at time t, honouring the post-contact slowdown. */
  function distAt(tm, t) {
    const d = tm.slow && t > tm.slow.t0
      ? tm.slow.d0 + (t - tm.slow.t0) * tm.speed * SLOW_FACTOR
      : (t - tm.delay) * tm.speed;
    return G.clamp(d, 0, tm.len);
  }

  /** Time at which the skater reaches a distance along their path (inverse of distAt). */
  function timeAt(tm, dist) {
    dist = G.clamp(dist, 0, tm.len);
    if (tm.slow && dist > tm.slow.d0) return tm.slow.t0 + (dist - tm.slow.d0) / (tm.speed * SLOW_FACTOR);
    return tm.delay + dist / tm.speed;
  }

  /** Resolved timing of an explicit contact marker (for the properties panel). */
  function contactSync(id) {
    if (!syncCache) buildSync();
    return contactInfoCache.get(id) || { ok: false };
  }

  /**
   * Contact moments {t, x, y, a, b}, ordered by time. Contacts are always explicit: only a placed
   * contact marker produces one — converging paths alone never collide.
   */
  let contactCache = null;
  function contacts() {
    if (contactCache) return contactCache;
    const out = [];
    for (const c of objs) {
      if (c.type !== 'contact') continue;
      const info = contactSync(c.id);
      if (!info.ok) continue;
      const pa = skaterPos(c.a, info.t), pb = skaterPos(c.b, info.t);
      out.push({ t: info.t, x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, a: c.a, b: c.b });
    }
    return (contactCache = out.sort((p, q) => p.t - q.t));
  }

  function duration() {
    let T = 0;
    for (const o of objs) {
      if (isPlayer(o) && o.path?.length) T = Math.max(T, skaterEnd(o.id));
      if (o.type === 'puck') T = Math.max(T, puck(o.id).end);
    }
    return Math.round(T * 100) / 100;
  }

  return { byId, skater, skaterPos, skaterPose, puckAt, skaterEnd, wpTime, evTime, puck, puckPos, puckCarrierAt, contacts, contactSync, duration };
}
