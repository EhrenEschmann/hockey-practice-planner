// Power skating mode: a pseudo-3D canvas where a stick-figure skater demonstrates technique
// elements (stride, C-cuts, crossovers, …) with skate trails on the ice. Pure canvas math,
// no dependencies — drag to orbit, wheel to zoom.

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, u) => a + (b - a) * u;
const ease = u => u * u * (3 - 2 * u);

// ---------------------------------------------------------------------------
// Elements. Each pose(t) returns the skater in world feet (+x = travel, z up):
// { x, y, heading, lean (rad, + = toward skater's left), crouch (0..1),
//   feet: { L: {x, y, z, on}, R: {…} } }  — foot coords in world, `on` = blade on ice.
// ---------------------------------------------------------------------------

/** Stride legs for straight skating: sweep back-and-out on the ice, recover through the air. */
function strideFoot(bx, by, heading, side, u, drive = 1) {
  const cs = Math.cos(heading), sn = Math.sin(heading);
  let fx, fy, z, on;
  if (u < 0.62) { const p = u / 0.62; fx = lerp(0.5, -1.35 * drive, p); fy = 0.28 + lerp(0, 0.75 * drive, ease(p)); z = 0; on = true; }
  else { const p = (u - 0.62) / 0.38; fx = lerp(-1.35 * drive, 0.5, ease(p)); fy = lerp(0.28 + 0.75 * drive, 0.28, p); z = 0.34 * Math.sin(Math.PI * p) * drive; on = false; }
  fy *= side;
  return { x: bx + cs * fx - sn * fy, y: by + sn * fx + cs * fy, z, on };
}

function straight(t, speed) { return { x: t * speed - 14, y: 0 }; }

const ELS = {
  stride: {
    name: 'Forward stride', desc: 'Deep knee bend; full push to the side, quiet recovery under the body.', dur: 7,
    pose(t) {
      const { x, y } = straight(t, 9);
      const cyc = 1.4, u = (t / cyc) % 1;
      return { x, y, heading: 0, lean: 0, crouch: 0.58 + 0.07 * Math.sin(t / cyc * TAU * 2),
        feet: { L: strideFoot(x, y, 0, 1, u), R: strideFoot(x, y, 0, -1, (u + 0.5) % 1) } };
    },
  },
  ccuts: {
    name: 'C-cuts', desc: 'One blade glides straight and stays quiet; the other carves the C push. Alternate feet.', dur: 8,
    pose(t) { return cCuts(t, 5.5, 1); },
  },
  bccuts: {
    name: 'Backward C-cuts', desc: 'Skating backward, hips low: the glide blade stays quiet, the heel leads each C push.', dur: 8,
    pose(t) { return cCuts(t, 4.2, -1); },
  },
  swizzle: {
    name: 'Swizzles', desc: 'Toes out: press both blades apart, then squeeze them back together — lemons on the ice.', dur: 8,
    pose(t) { return swizzles(t, 4.8, 1); },
  },
  bswizzle: {
    name: 'Backward swizzles', desc: 'Heels lead: both blades push apart and pull back together while skating backward.', dur: 8,
    pose(t) { return swizzles(t, 4, -1); },
  },
  slalom: {
    name: 'Slalom', desc: 'Feet together, knees soft: carve edge to edge in one long serpentine.', dur: 8,
    pose(t) {
      const speed = 7, amp = 2.2, k = TAU / 14;            // one full weave every 14 ft
      const x = t * speed - 14;
      const y = amp * Math.sin(k * x);
      const heading = Math.atan2(amp * k * Math.cos(k * x), 1);
      const lean = -0.38 * Math.sin(k * x);                 // into each curve
      const crouch = 0.6 + 0.1 * Math.abs(Math.sin(k * x));
      const cs = Math.cos(heading), sn = Math.sin(heading);
      const foot = side => ({ x: x + cs * side * 0.12 - sn * side * 0.24, y: y + sn * side * 0.12 + cs * side * 0.24, z: 0, on: true });
      return { x, y, heading, lean, crouch, feet: { L: foot(1), R: foot(-1) } };
    },
  },
  xoverf: {
    name: 'Forward crossovers', desc: 'On the circle: outside foot crosses over, inside foot pulls under.', dur: 8,
    pose(t) { return crossovers(t, 0); },
  },
  xoverb: {
    name: 'Backward crossovers', desc: 'Same circle, skating backward — chest stays over the circle.', dur: 8,
    pose(t) { return crossovers(t, Math.PI); },
  },
  pivotfb: {
    name: 'Forward → backward pivot', desc: 'Open the hips and turn 180° without losing speed.', dur: 6,
    pose(t) {
      const { x, y } = straight(t, 7);
      const u = clamp((t - 2.5) / 0.9, 0, 1);
      const heading = Math.PI * ease(u);
      const lift = Math.sin(Math.PI * u);
      const cs = Math.cos(heading), sn = Math.sin(heading);
      const foot = (side, fx, z, on) => ({ x: x + cs * fx - sn * side * 0.32, y: y + sn * fx + cs * side * 0.32, z, on });
      return { x, y, heading, lean: 0, crouch: 0.55 + 0.15 * lift,
        feet: { L: foot(1, 0.28, 0.22 * lift * (u < 0.5 ? 1 : 0), u >= 0.5 || u === 0), R: foot(-1, -0.28, 0.22 * lift * (u >= 0.5 ? 1 : 0), u < 0.5) } };
    },
  },
  powerturn: {
    name: 'Power turn', desc: 'Carve a tight 180: feet staggered, knees deep, shoulders level.', dur: 7,
    pose(t) {
      const vin = 8.5, r = 4.2, tIn = 2.2, tTurn = Math.PI * r / vin;
      let x, y, heading, lean = 0, crouch = 0.55;
      if (t < tIn) { x = t * vin - 16; y = 0; heading = 0; }
      else if (t < tIn + tTurn) {
        const a = (t - tIn) / tTurn * Math.PI;
        x = (tIn * vin - 16) + r * Math.sin(a); y = r - r * Math.cos(a);
        heading = a; lean = 0.5 * Math.sin(Math.min(Math.PI, a + 0.3)); crouch = 0.75;
      } else { x = (tIn * vin - 16) - (t - tIn - tTurn) * vin; y = 2 * r; heading = Math.PI; }
      const cs = Math.cos(heading), sn = Math.sin(heading);
      const foot = (side, fx) => ({ x: x + cs * fx - sn * side * 0.34, y: y + sn * fx + cs * side * 0.34, z: 0, on: true });
      return { x, y, heading, lean, crouch, feet: { L: foot(1, lean > 0.05 ? 0.55 : 0.2), R: foot(-1, -0.15) } };
    },
  },
  onefootstop: {
    name: 'One-foot outside edge stop', desc: 'Glide, swing the stopping blade fully sideways and ride its outside edge to a stand-still — free foot off the ice.', dur: 6.5,
    pose(t) {
      const tAcc = 2.2, tGlide = 0.6, v = 8, tStop = 1.7;
      let x, dec = 0;
      if (t < tAcc) x = t * v - 15;
      else if (t < tAcc + tGlide) x = tAcc * v - 15 + (t - tAcc) * v;
      else { const u = clamp((t - tAcc - tGlide) / tStop, 0, 1); dec = u; x = tAcc * v - 15 + tGlide * v + v * tStop * (u - u * u / 2); }
      const stopping = t >= tAcc + tGlide;
      const u = (t / 1.4) % 1;
      let feet, heading = 0, lean = 0, crouch = 0.5;
      if (t < tAcc) feet = { L: strideFoot(x, 0, 0, 1, u, 0.9), R: strideFoot(x, 0, 0, -1, (u + 0.5) % 1, 0.9) };
      else if (!stopping) feet = { L: { x: x + 0.15, y: 0.32, z: 0, on: true }, R: { x: x + 0.4, y: -0.32, z: 0, on: true } };
      else {
        const turn = ease(clamp(dec * 2.4, 0, 1));       // the blade snaps sideways at the start of the stop
        const lift = ease(clamp(dec * 2, 0, 1));
        heading = 0.3 * turn;                            // shoulders open slightly with the stop
        lean = -0.28 * turn;                             // weight stacked over the outside edge
        crouch = 0.5 + 0.28 * turn;
        feet = {
          L: { x: x - 0.35 - 0.45 * lift, y: 0.38, z: 0.45 * lift, on: false },          // free foot rises behind
          R: { x: x + 0.35, y: -0.12, z: 0, on: true, dir: Math.PI / 2 * 0.94 * turn },  // stopping blade turned across the travel
        };
      }
      return { x, y: 0, heading, lean, crouch, feet };
    },
  },
};

/** C-cuts (forward dir=1, backward dir=-1): the glide foot holds a straight line under the body
 *  while the other blade carves a C out-and-around — alternating feet each push, both blades on the ice. */
function cCuts(t, speed, dir) {
  const { x, y } = straight(t, speed);
  const heading = dir > 0 ? 0 : Math.PI;
  const cyc = 1.8, u = (t / cyc) % 1;
  const active = Math.floor(t / cyc) % 2 ? -1 : 1;   // which side pushes this cycle (+1 = left)
  const foot = side => {
    if (side !== active) return { x: x + 0.18 * dir, y: y + side * 0.3, z: 0, on: true }; // the still glide foot
    const out = 0.32 + 0.7 * Math.sin(Math.PI * ease(u));            // bulge out and back in — the C
    const fwd = dir * (0.5 * Math.cos(Math.PI * u) - 0.05);          // sweeps front → back through the push
    return { x: x + fwd, y: y + side * out, z: 0, on: true };
  };
  return { x, y, heading, lean: 0, crouch: 0.72, feet: { L: foot(1), R: foot(-1) } };
}

/** Swizzles (forward dir=1, backward dir=-1): both blades on the ice the whole time,
 *  pressed apart to the widest point and squeezed back together — twin lemon-shaped trails. */
function swizzles(t, speed, dir) {
  const { x, y } = straight(t, speed);
  const heading = dir > 0 ? 0 : Math.PI;
  const cyc = 1.7, u = (t / cyc) % 1;
  const out = 0.16 + 0.78 * Math.sin(Math.PI * ease(u));   // apart, then back together
  const fwd = dir * 0.35 * Math.cos(Math.PI * u);          // slight fore-aft sweep through the lemon
  const foot = side => ({ x: x + fwd, y: y + side * out, z: 0, on: true });
  return { x, y, heading, lean: 0, crouch: 0.62 + 0.1 * Math.sin(Math.PI * u), feet: { L: foot(1), R: foot(-1) } };
}

function crossovers(t, faceFlip) {
  const r = 8.5, speed = 7.5, a0 = -Math.PI / 2;
  const a = a0 + t * speed / r;                      // counter-clockwise circle centred at (0, r+…)
  const cx = 0, cy = r + 1;
  const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
  const tangent = a + Math.PI / 2;
  const heading = tangent + faceFlip;
  const lean = (faceFlip ? -0.32 : 0.36);            // into the circle (toward the skater's left when forward)
  const cyc = 1.15, u = (t / cyc) % 1;
  const cs = Math.cos(tangent), sn = Math.sin(tangent);
  const place = (fx, fy, z, on) => ({ x: x + cs * fx - sn * fy, y: y + sn * fx + cs * fy, z, on });
  // fy > 0 is toward the circle centre (skater's left when travelling CCW). Outside foot = right (fy < 0).
  let L, R;
  if (u < 0.5) { const p = ease(u / 0.5); L = place(0.15, lerp(0.3, -0.15, p), 0, true); R = place(-0.2, lerp(-0.45, -1.05, p), 0, true); } // push: outside drives out, inside pulls under
  else { const p = ease((u - 0.5) / 0.5); L = place(0.15, lerp(-0.15, 0.3, p), 0.18 * Math.sin(Math.PI * p), false); R = place(0.35 * Math.sin(Math.PI * p) - 0.2, lerp(-1.05, 0.35, p), 0.3 * Math.sin(Math.PI * p), false); R.on = p > 0.85; L.on = p > 0.9; }
  return { x, y, heading, lean, crouch: 0.68, feet: { L, R } };
}

export const PS_ELEMENTS = Object.entries(ELS).map(([key, e]) => ({ key, name: e.name, desc: e.desc }));

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------
export function createPSView(canvas, { onCaption = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  const cam = { yaw: -2.35, pitch: 0.46, dist: 26 };
  const target = { x: 0, y: 0 };
  let keys = [], idx = 0, t = 0.8, playing = false, raf = 0, last = 0;
  const trails = { L: [], R: [] };
  const TRAIL_MAX = 340;

  const el = () => ELS[keys[idx]] || null;

  function caption() {
    const e = el();
    onCaption(e ? `${idx + 1}/${keys.length} · ${e.name} — ${e.desc}` : 'Pick power skating elements on the right, then press ▶.');
  }

  // ----- camera & projection -----
  function project(p) {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const cyw = Math.cos(cam.yaw), syw = Math.sin(cam.yaw);
    const eye = { x: target.x + cam.dist * cp * cyw, y: target.y + cam.dist * cp * syw, z: 1.5 + cam.dist * sp };
    const fwd = norm({ x: target.x - eye.x, y: target.y - eye.y, z: 1.5 - eye.z });
    const right = norm(cross(fwd, { x: 0, y: 0, z: 1 }));
    const up = cross(right, fwd);
    const v = { x: p.x - eye.x, y: p.y - eye.y, z: p.z - eye.z };
    const zc = dot(v, fwd);
    if (zc < 0.5) return null;
    const F = canvas.height * 1.05;
    return { x: canvas.width / 2 + dot(v, right) * F / zc, y: canvas.height / 2 - dot(v, up) * F / zc, s: F / zc };
  }
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const norm = v => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };

  function line(a, b, w, color) {
    const pa = project(a), pb = project(b);
    if (!pa || !pb) return;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
    ctx.lineWidth = Math.max(1, w * (pa.s + pb.s) / 2); ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.stroke();
  }

  // ----- drawing -----
  function draw() {
    const dpr = devicePixelRatio || 1;
    const W = canvas.clientWidth * dpr, H = canvas.clientHeight * dpr;
    if (W && (canvas.width !== W || canvas.height !== H)) { canvas.width = W; canvas.height = H; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const e = el();
    const P = e ? e.pose(t) : { x: 0, y: 0, heading: 0, lean: 0, crouch: 0.5, feet: { L: { x: 0, y: 0.3, z: 0, on: true }, R: { x: 0, y: -0.3, z: 0, on: true } } };
    target.x += (P.x - target.x) * 0.12; target.y += (P.y - target.y) * 0.12;

    // ice: soft sheet + 5 ft grid around the camera target
    const gx = Math.round(target.x / 5) * 5, gy = Math.round(target.y / 5) * 5, R = 40;
    ctx.globalAlpha = 1;
    for (let i = -R; i <= R; i += 5) {
      line({ x: gx + i, y: gy - R, z: 0 }, { x: gx + i, y: gy + R, z: 0 }, 0.02, 'rgba(120,150,190,.28)');
      line({ x: gx - R, y: gy + i, z: 0 }, { x: gx + R, y: gy + i, z: 0 }, 0.02, 'rgba(120,150,190,.28)');
    }
    // skate trails
    for (const [side, color] of [['L', 'rgba(214,40,40,.85)'], ['R', 'rgba(31,157,85,.85)']]) {
      const tr = trails[side];
      for (let i = 1; i < tr.length; i++) {
        if (tr[i].brk || tr[i - 1].brk) continue;
        ctx.globalAlpha = i / tr.length;
        line({ x: tr[i - 1].x, y: tr[i - 1].y, z: 0.02 }, { x: tr[i].x, y: tr[i].y, z: 0.02 }, 0.07, color);
      }
    }
    ctx.globalAlpha = 1;
    drawSkater(P);
  }

  function drawSkater(P) {
    const cs = Math.cos(P.heading), sn = Math.sin(P.heading);
    const latX = -sn, latY = cs;                          // skater's left
    const pelvisH = 3.05 - 1.15 * P.crouch;
    const leanS = Math.sin(P.lean);
    const pelvis = { x: P.x + latX * leanS * 0.9, y: P.y + latY * leanS * 0.9, z: pelvisH };
    const shoulder = { x: pelvis.x + cs * 0.45 * P.crouch + latX * leanS * 0.8, y: pelvis.y + sn * 0.45 * P.crouch + latY * leanS * 0.8, z: pelvisH + 1.5 - 0.25 * P.crouch };
    const head = { x: shoulder.x + cs * 0.12, y: shoulder.y + sn * 0.12, z: shoulder.z + 0.62 };
    const { L, R } = P.feet;
    // shadows
    for (const f of [L, R]) { const s = project({ x: f.x, y: f.y, z: 0 }); if (s && f.z > 0.02) { ctx.beginPath(); ctx.ellipse(s.x, s.y, 8 * s.s / 100, 3.5 * s.s / 100, 0, 0, TAU); ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fill(); } }
    // legs (two-bone IK, knees bend toward the heading)
    for (const [f, side] of [[L, 1], [R, -1]]) {
      const hip = { x: pelvis.x + latX * side * 0.3, y: pelvis.y + latY * side * 0.3, z: pelvis.z };
      const ank = { x: f.x, y: f.y, z: f.z + 0.25 };
      const mid = { x: (hip.x + ank.x) / 2, y: (hip.y + ank.y) / 2, z: (hip.z + ank.z) / 2 };
      const d = Math.hypot(ank.x - hip.x, ank.y - hip.y, ank.z - hip.z);
      const h = Math.sqrt(Math.max(0.05, 1.62 * 1.62 - (d / 2) * (d / 2)));
      const knee = { x: mid.x + cs * h * 0.75, y: mid.y + sn * h * 0.75, z: mid.z + h * 0.35 };
      line(hip, knee, 0.19, '#1e56d6'); line(knee, ank, 0.17, '#1e56d6');
      // blade — a foot may aim its own way (f.dir), e.g. turned sideways for a stop
      const bd = f.dir ?? P.heading, bcs = Math.cos(bd), bsn = Math.sin(bd);
      line({ x: f.x - bcs * 0.5, y: f.y - bsn * 0.5, z: f.z + 0.05 }, { x: f.x + bcs * 0.55, y: f.y + bsn * 0.55, z: f.z + 0.05 }, 0.1, '#dfe6f2');
    }
    // torso, head, arms
    line(pelvis, shoulder, 0.24, '#1e56d6');
    const hp = project(head);
    if (hp) { ctx.beginPath(); ctx.arc(hp.x, hp.y, 0.34 * hp.s, 0, TAU); ctx.fillStyle = '#e6b800'; ctx.fill(); }
    const swing = (L.x - R.x) * cs + (L.y - R.y) * sn;    // arms counter the legs
    for (const side of [1, -1]) {
      const sh = { x: shoulder.x + latX * side * 0.55, y: shoulder.y + latY * side * 0.55, z: shoulder.z };
      const hand = { x: sh.x + cs * clamp(-swing * side * 0.5, -0.9, 0.9) + latX * side * 0.25, y: sh.y + sn * clamp(-swing * side * 0.5, -0.9, 0.9) + latY * side * 0.25, z: shoulder.z - 0.95 };
      line(sh, hand, 0.15, '#1e56d6');
    }
  }

  // ----- playback -----
  function tick(now) {
    if (!playing) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    t += dt;
    const e = el();
    if (e && t >= e.dur) { next(); }
    else record(e);
    draw();
    raf = requestAnimationFrame(tick);
  }
  function record(e) {
    if (!e) return;
    const P = e.pose(t);
    for (const side of ['L', 'R']) {
      const f = P.feet[side], tr = trails[side];
      tr.push(f.on ? { x: f.x, y: f.y } : { x: f.x, y: f.y, brk: true });
      if (tr.length > TRAIL_MAX) tr.shift();
    }
  }
  function next() {
    idx = (idx + 1) % Math.max(1, keys.length);
    t = 0; trails.L.length = 0; trails.R.length = 0;
    caption();
  }
  function toggle() {
    if (!keys.length) return;
    playing = !playing;
    if (playing) { last = performance.now(); raf = requestAnimationFrame(tick); }
    else cancelAnimationFrame(raf);
  }
  function stop() { playing = false; cancelAnimationFrame(raf); idx = 0; t = 0.8; trails.L.length = 0; trails.R.length = 0; caption(); draw(); }

  // ----- orbit / zoom -----
  let dragCam = null;
  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); dragCam = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch }; });
  canvas.addEventListener('pointermove', e => {
    if (!dragCam) return;
    cam.yaw = dragCam.yaw - (e.clientX - dragCam.x) * 0.008;
    cam.pitch = clamp(dragCam.pitch + (e.clientY - dragCam.y) * 0.006, 0.12, 1.25);
    if (!playing) draw();
  });
  canvas.addEventListener('pointerup', () => dragCam = null);
  canvas.addEventListener('wheel', e => { e.preventDefault(); cam.dist = clamp(cam.dist * (e.deltaY > 0 ? 1.1 : 0.9), 10, 60); if (!playing) draw(); }, { passive: false });

  return {
    setElements(k) {
      const same = k.join() === keys.join();
      keys = k.slice();
      if (!same) { idx = 0; t = 0.8; trails.L.length = 0; trails.R.length = 0; }
      if (idx >= keys.length) idx = 0;
      caption(); draw();
    },
    toggle, stop, draw,
    get playing() { return playing; },
  };
}
