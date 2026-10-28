// Shared runtime both the viewer and the editor stand on: the store and open drill, the rink
// SVG layers, URL navigation, audio clips + narration + speech, the animation frame driver, and
// the editorApi registry through which the viewer side reaches the lazily loaded editor.
import { rinkSVG, SVG_STYLE } from './rink.js';
import { skaterHex, ZONE_COLORS, starPoints } from './render.js';
import { goalieSquareTo, goalieHome, isPlayer, underPad, jumpHeight, stickRotation, CONTACT_DIST } from './sim.js';
import { Store } from './store.js';
import { rosterTeamFor } from './access.js';
import { chunksToBlob } from './video.js';
import { clipKey, idbGetClip, idbPutClip, base64ToBlob } from './clips.js';
import { $, escHtml } from './ui.js';
import { clock } from './doc.js';
import { cloudBackend, cloudSync, loadEditor, presenting, refreshScreen, screen, syncEditor, teamFor } from './present.js';

const svg = $('#rink');
svg.innerHTML = `<style>${SVG_STYLE}</style><g id="rink-layer">${rinkSVG()}</g><g id="obj-layer"></g><g id="fx-layer"></g><g id="board-layer"></g><g id="overlay-layer"></g>`;

const objLayer = svg.querySelector('#obj-layer');
const fxLayer = svg.querySelector('#fx-layer');
const overlay = svg.querySelector('#overlay-layer');

const store = new Store();

const drill = () => store.drill;

function toRink(e) {
  const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return { x: pt.x, y: pt.y };
}

const isPSDrill = d => /power\s*skat/i.test(d?.name || '');

// The practice creator is only brought up for the planner (see syncEditor): share links and other
// accounts never get it — until then it stays out of the page and nothing in it is rendered.
let editorOn = false;

const teamOf = p => (store.roster.teams || []).find(t => t.id === p?.teamId) || rosterTeamFor(store.roster, p);

/** Go to another screen of the app without a page load. */
function navigate(path, { replace = false } = {}) {
  if (path === location.pathname && !location.hash) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  onLocationChange();
}
function onLocationChange() {
  const wasEditor = editorOn;
  refreshScreen();
  if (editorOn && wasEditor) editorRoute?.(); // moving within the editor re-renders it (entering it renders afresh — syncEditor)
}
window.addEventListener('popstate', onLocationChange);
window.addEventListener('hashchange', onLocationChange); // links from before paths existed (#view=… / #team=…)

const ERASE_SECS = 0.6; // how long an undone stroke takes to un-draw itself in the replay

/**
 * The ink as SVG at ink-time `tInk` (Infinity = the finished board). A stroke undone during the take
 * carries `gone`: it draws, then retracts at that moment; after the retraction (and on the live board)
 * it is off the ice. Shared by the editor's whiteboard and the viewer's chalk-talk playback.
 */
function boardInkSVG(strokes, tInk = Infinity) {
  return (strokes || []).map(st => {
    let pts = st.pts;
    if (tInk === Infinity) {
      if (st.gone != null) return '';
    } else {
      if (st.gone != null && tInk >= st.gone + ERASE_SECS) return '';
      pts = st.pts.filter(q => (q.t || 0) <= tInk);
      if (st.gone != null && tInk > st.gone) { // being erased: un-draw from the end
        const drawn = st.pts.filter(q => (q.t || 0) <= st.gone);
        pts = drawn.slice(0, Math.max(0, Math.round(drawn.length * (1 - (tInk - st.gone) / ERASE_SECS))));
      }
    }
    if (pts.length < 1) return '';
    const dd = 'M' + pts.map(q => `${q.x},${q.y}`).join(' L');
    return `<path d="${dd}" stroke="${st.color}" stroke-width="${st.w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
}

/** Every coordinate a drill contains — positions, waypoints, polyline points, shot targets and bank points — for view fitting and the off-screen check. */
function drillPoints(d) {
  const pts = [];
  for (const o of d.objects) {
    if (o.points) o.points.forEach(p => pts.push(p));
    if (o.x != null && !(o.type === 'puck' && o.carrier)) pts.push({ x: o.x, y: o.y });
    (o.path || []).forEach(p => pts.push(p));
    if (o.type === 'zone' || o.type === 'focus') pts.push({ x: o.x + o.w, y: o.y + o.h });
    for (const ev of o.events || []) { if (ev.target) pts.push(ev.target); if (ev.bank) pts.push(ev.bank); }
  }
  return pts;
}

/**
 * Body-contact resolution — only for pairs explicitly linked by a contact marker: those skaters
 * shoulder each other apart instead of overlapping. Unlinked crossing paths pass freely.
 */
function contactOffsets(dr, sm, t) {
  const off = new Map();
  if (t <= 0) return off;
  const mover = id => { const o = dr.objects.find(x => x.id === id); return (o?.type === 'skater' && o.path?.length) || o?.type === 'coach' ? o : null; };
  const pairs = [...new Set(dr.objects
    .filter(o => o.type === 'contact' && o.a && o.b && o.a !== o.b && mover(o.a) && mover(o.b))
    .map(c => [c.a, c.b].sort().join('|')))].map(k => k.split('|'));
  if (!pairs.length) return off;
  const ids = [...new Set(pairs.flat())];
  const pos = new Map(ids.map(id => [id, sm.skaterPos(id, t)]));
  for (let pass = 0; pass < 2; pass++) {
    for (const [A, B] of pairs) {
      const oa = off.get(A) || { x: 0, y: 0 }, ob = off.get(B) || { x: 0, y: 0 };
      const dx = (pos.get(A).x + oa.x) - (pos.get(B).x + ob.x), dy = (pos.get(A).y + oa.y) - (pos.get(B).y + ob.y);
      const d = Math.hypot(dx, dy);
      if (d >= CONTACT_DIST || d < 1e-6) continue;
      const loser = dr.impactLoser;
      let [shA, shB] = loser === A ? [0.9, 0.1] : loser === B ? [0.1, 0.9] : [0.5, 0.5]; // the loser absorbs the hit
      // A coach (planted, often braced behind a tackle pad) doesn't budge — the player takes the whole push.
      if (mover(A).type === 'coach') { shA = 0; shB = 1; }
      else if (mover(B).type === 'coach') { shB = 0; shA = 1; }
      const push = CONTACT_DIST - d, ux = dx / d, uy = dy / d;
      off.set(A, { x: oa.x + ux * push * shA, y: oa.y + uy * push * shA });
      off.set(B, { x: ob.x - ux * push * shB, y: ob.y - uy * push * shB });
    }
  }
  return off;
}

const FX_DUR = 0.6;    // seconds an impact burst stays on screen
const KNOCK_DUR = 0.9;  // seconds the losing skater staggers after a hit
const KNOCK_DIST = 3.5; // ft they are shoved off their line at the peak

/** If the selected "worse for" skater is mid-stagger at time t: their shove offset and body wobble. */
function knockState(dr, sm, t) {
  const loser = dr.impactLoser;
  if (!loser || t <= 0) return null;
  for (const c of sm.contacts()) {
    if (c.a !== loser && c.b !== loser) continue;
    const u = (t - c.t) / KNOCK_DUR;
    if (u < 0 || u > 1) continue;
    const winner = c.a === loser ? c.b : c.a;
    const wp = sm.skaterPos(winner, c.t), lp = sm.skaterPos(loser, c.t);
    let dx = lp.x - wp.x, dy = lp.y - wp.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) { dx = 0; dy = 1; } else { dx /= d; dy /= d; }
    const shove = KNOCK_DIST * Math.sin(Math.PI * u); // knocked off the line, then recovers
    return { id: loser, x: dx * shove, y: dy * shove, angle: 28 * Math.sin(u * Math.PI * 3) * (1 - u) };
  }
  return null;
}

/** Draw one animation frame of drill `dr` (simulated by `sm`) onto any rendered copy of it: `root` holds the objects, `fx` the impact bursts. */
/** Players skate straight back to their spots at 2× speed, from wherever they are at time t0; the phase lasts until the slowest returner is home. */
function returnTime(dr, sm, t0 = sm.duration()) {
  let R = 0;
  for (const o of dr.objects) {
    if (!isPlayer(o) || !o.path?.length) continue;
    const a = sm.skaterPose(o.id, t0), b = sm.skaterPose(o.id, 0);
    R = Math.max(R, Math.hypot(b.x - a.x, b.y - a.y) / (2 * sm.skater(o.id).speed));
  }
  return R;
}

/** One frame of the skate-home phase, tr seconds after it began at drill time t0: everyone glides back to their start. */
function returnFrame(dr, sm, root, fx, tr, t0 = sm.duration()) {
  if (fx.firstChild) fx.innerHTML = '';
  const T = t0;
  const R = returnTime(dr, sm, t0);
  const k = R > 0 ? Math.min(1, tr / R) : 1; // pucks drift home over the whole phase
  for (const o of dr.objects) {
    let el, p;
    if (isPlayer(o) && o.path?.length) {
      const a = sm.skaterPose(o.id, T), b = sm.skaterPose(o.id, 0);
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const kk = d > 0.01 ? Math.min(1, tr * 2 * sm.skater(o.id).speed / d) : 1; // each at 2× their own speed
      p = { x: a.x + (b.x - a.x) * kk, y: a.y + (b.y - a.y) * kk };
      el = root.querySelector(`[data-skater="${o.id}"]`);
      if (el && o.type === 'skater') { // shed any end-of-drill effects for the skate back
        el.classList.remove('hit', 'sliding', 'jumping');
        el.querySelector('.body')?.setAttribute('transform', '');
        el.querySelector('.figure')?.setAttribute('transform', '');
        const sh = el.querySelector('.shadow'); if (sh) sh.style.display = 'none';
        // face where they're going: home while returning, then their start-of-drill facing
        const heading = kk < 1 && d > 0.01 ? Math.atan2(b.y - a.y, b.x - a.x) : sm.skaterPose(o.id, 0).heading;
        el.querySelector('.dir')?.setAttribute('transform', `rotate(${stickRotation({ heading }, o.role)})`);
      }
    } else if (o.type === 'puck') {
      const a = sm.puckPos(o.id, T), b = sm.puckPos(o.id, 0);
      p = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      el = root.querySelector(`.puck-disc[data-puck="${o.id}"]`);
    }
    if (el && p) el.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
  }
}

function animateFrame(dr, sm, root, fx, t, playing) {
  const T = sm.duration();
  if (t > T && T > 0) return returnFrame(dr, sm, root, fx, t - T);
  const bump = contactOffsets(dr, sm, t);
  const knock = knockState(dr, sm, t);
  // impact bursts flash during playback only — a parked timeline shows just the marker
  const bursts = (playing && t > 0 ? sm.contacts() : []).filter(c => t >= c.t && t - c.t <= FX_DUR).map(c => {
    const u = (t - c.t) / FX_DUR;
    return `<g class="fx-burst" transform="translate(${c.x.toFixed(2)} ${c.y.toFixed(2)})" opacity="${(1 - u).toFixed(2)}">` +
      `<polygon points="${starPoints(2 + 3 * u)}"/><circle r="${(1 + 5 * u).toFixed(2)}"/></g>`;
  }).join('');
  if (bursts || fx.firstChild) fx.innerHTML = bursts; // most frames have no burst: don't dirty the DOM for nothing
  const raised = dr.objects.filter(o => o.type === 'raisedpad');
  const jumps = dr.objects.filter(o => o.type === 'jumppad');
  for (const o of dr.objects) {
    let el, p;
    if (isPlayer(o) && o.path?.length) {
      p = sm.skaterPose(o.id, t); el = root.querySelector(`[data-skater="${o.id}"]`);
      const b = bump.get(o.id);
      if (b) p = { ...p, x: p.x + b.x, y: p.y + b.y };
      if (knock?.id === o.id) p = { ...p, x: p.x + knock.x, y: p.y + knock.y };
      if (el && o.type === 'skater') el.classList.toggle('hit', knock?.id === o.id);
      if (el && o.type === 'skater') el.querySelector('.dir')?.setAttribute('transform', `rotate(${stickRotation(p, o.role)})`);
      if (el && o.type === 'coach' && o.stick) el.querySelector('.dir')?.setAttribute('transform', `rotate(${stickRotation(p, 'coach')})`);
      if (el && o.type === 'skater') {
        // Under a raised pad the skater slides: body stretched along their heading and flattened.
        const sliding = raised.some(pd => underPad(p, pd, 1));
        el.classList.toggle('sliding', sliding);
        el.querySelector('.body')?.setAttribute('transform', sliding ? `rotate(${(p.heading * 180 / Math.PI).toFixed(1)}) scale(1.7 .55)` : '');
        // Over a low pad the skater jumps: the figure grows toward the peak and a shadow falls away beneath.
        const jump = jumps.reduce((m, pd) => Math.max(m, jumpHeight(p, pd)), 0);
        el.classList.toggle('jumping', jump > 0);
        el.querySelector('.figure')?.setAttribute('transform',
          jump > 0 ? `scale(${(1 + 0.45 * jump).toFixed(3)})`
          : knock?.id === o.id ? `rotate(${knock.angle.toFixed(1)})` : '');
        const sh = el.querySelector('.shadow');
        if (sh) { sh.style.display = jump > 0 ? '' : 'none'; sh.setAttribute('transform', `translate(${(1.4 * jump).toFixed(2)} ${(2.6 * jump).toFixed(2)})`); }
      }
    }
    else if (o.type === 'puck') {
      p = sm.puckPos(o.id, t); el = root.querySelector(`.puck-disc[data-puck="${o.id}"]`);
      const carrier = sm.puckCarrierAt(o.id, t);
      const b = bump.get(carrier); // a carried puck rides the body-contact bump too
      if (b) p = { x: p.x + b.x, y: p.y + b.y };
      if (knock?.id === carrier) p = { x: p.x + knock.x, y: p.y + knock.y };
    }
    else if (o.type === 'pile') {
      // Count down as pucks are taken; before the drill starts the badge shows what the pile holds.
      const taken = dr.objects.filter(pk => pk.type === 'puck' && pk.pile === o.id && (t > 0 ? (sm.puck(pk.id).info[0]?.t ?? Infinity) <= t : false)).length;
      const badge = root.querySelector(`[data-id="${o.id}"] .pile-count`);
      if (badge) badge.textContent = Math.max(0, Math.round(+o.count || 0) - (t > 0 ? taken : dr.objects.filter(pk => pk.type === 'puck' && pk.pile === o.id).length));
    }
    // Goalies (and coaches holding a stick) square up to the puck as it moves — standing or on a path of their own, unless
    // they are carrying it themselves; parked at 0 they keep their default facing (a goalie's back to the net).
    if (((o.type === 'skater' && o.role === 'G') || (o.type === 'coach' && o.stick)) && t > 0) {
      const gel = el || root.querySelector(`[data-skater="${o.id}"]`);
      const h = gel ? goalieSquareTo(sm, dr.objects, p || o, t, o.id, o.role === 'G' ? goalieHome(p || o, dr.objects) : null) : null;
      if (h != null) gel.querySelector('.dir')?.setAttribute('transform', `rotate(${stickRotation({ heading: h }, 'G')})`);
    }
    if (el) el.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
  }
}

// A cue lives on the waypoint itself (`pt.cue`, or `startCue` on the player for their start), so it copies,
// nudges and clones with the path and is timed by the same sim clock as passes and triggered starts.
const canSpeak = 'speechSynthesis' in window;
const storedVoice = () => { try { return localStorage.getItem('hpp.voice') !== '0'; } catch { return true; } }; // the editor's per-device mute
let voiceOn = storedVoice();
let voicePrimed = false;

/** Every cue in the drill with the playback second it fires at, in order. */
function drillCues(dr, sm) {
  const out = [];
  const T = sm.duration(); // rounded to 0.01 s, so a last-waypoint cue must be clamped or it would sit just past the end and never fire
  for (const o of dr.objects) {
    if (!isPlayer(o)) continue;
    if (o.startCue?.trim()) out.push({ t: Math.min(T, sm.wpTime(o.id, 0)), text: o.startCue.trim() });
    (o.path || []).forEach((pt, i) => { if (pt.cue?.trim()) out.push({ t: Math.min(T, sm.wpTime(o.id, i + 1)), text: pt.cue.trim() }); });
  }
  return out.sort((a, b) => a.t - b.t);
}
/** Phones only let a page talk after a tap: call from the play button so later cues (fired from frames) are allowed. */
function primeVoice() {
  if (!canSpeak || voicePrimed) return;
  voicePrimed = true;
  try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* fine */ }
}
function speak(text) {
  if (!canSpeak || !voiceOn) return;
  stopReading();
  speechSynthesis.cancel(); // a cue belongs to its waypoint — an earlier one still talking must not push it late
  const u = new SpeechSynthesisUtterance(text);
  u.lang = document.documentElement.lang || 'en';
  speechSynthesis.speak(u);
}
function hushVoice() { stopReading(); if (canSpeak) speechSynthesis.cancel(); for (const n of [...activeNarr]) n.stop(); }

// ----- intro clips: the coach's recorded voice, played before a drill's animation (see js/clips.js) -----
const clipMem = new Map(); // clip key → { url, mime, secs }: clips already fetched this session, ready to play on a tap
const ownerFor = () => store.data.ownerUid || 'local';
/** Fetch a clip into memory: this device's IndexedDB first, then the owner's cloud copy (cached locally for the rink). */
/**
 * A drill can carry two recordings: `intro` (spoken before the animation) and `narration` (the coach's voice
 * over the animation, recorded while it played at `narration.speed`). Each is its own clip document.
 */
const clipDocId = (did, kind) => kind === 'intro' ? did : `${did}_${kind}`;
const keyFor = (owner, pid, d, kind = 'intro') => clipKey(owner, pid, clipDocId(d.id, kind), d[kind]?.at);
async function fetchClip(owner, pid, d, kind = 'intro') {
  const key = keyFor(owner, pid, d, kind), did = clipDocId(d.id, kind);
  if (clipMem.has(key)) return clipMem.get(key);
  let rec = null;
  try { rec = await idbGetClip(key); } catch { rec = null; }
  if (!rec && cloudBackend?.loadClip && cloudSync?.user) {
    try {
      const c = await cloudBackend.loadClip(teamFor(pid), pid, did);
      if (c?.data) { rec = { mime: c.mime, blob: base64ToBlob(c.data, c.mime), secs: c.secs }; idbPutClip(key, rec).catch(() => {}); }
    } catch { rec = null; }
  }
  if (!rec?.blob) return null;
  if (clipMem.has(key)) return clipMem.get(key); // a parallel fetch won the race
  const entry = { url: URL.createObjectURL(rec.blob), mime: rec.mime, secs: rec.secs };
  clipMem.set(key, entry);
  return entry;
}
function forgetClip(key) { const e = clipMem.get(key); if (e) { URL.revokeObjectURL(e.url); clipMem.delete(key); } }
/** Play a fetched clip; onEnd fires once when it finishes, fails or is stopped. */
function playClip(entry, { onEnd }) {
  const audio = new Audio(entry.url);
  audio.setAttribute('playsinline', ''); audio.preload = 'auto';
  let done = false;
  const finish = err => { if (done) return; done = true; onEnd(err || null); };
  audio.onended = () => finish();
  audio.onerror = () => finish(`can’t decode ${entry.mime || 'this clip'} on this device`);
  audio.play().catch(e => finish(e?.name === 'NotAllowedError' ? 'the browser blocked audio until you tap again' : (e?.message || 'playback failed')));
  return { stop() { if (done) return; audio.pause(); finish(); }, cancelled: false };
}

// ----- narration: the coach's voice over the animation. Decoded once and played through WebAudio, which can start at
// any offset (a MediaRecorder WebM can't be seeked reliably), so ⏸ / ▶ and the timeline keep voice and picture together.
// Phones are the hard case. iOS flips the AudioContext to 'interrupted' after an <audio> intro or a video has played,
// after a call or the lock screen — and a source started on a context that is not running is simply silent, which is
// how "the voice cut out" happens. So: one context, created at a speech sample rate (a decoded minute costs half the
// memory of 48 kHz, and a practice can carry many minutes), woken on every tap in the viewer and again whenever the
// state changes while a voice-over should be playing; decoded buffers kept for the last few drills only.
let narrAC = null, audioUnlocked = false;
const activeNarr = new Set();
const decodedLRU = []; // entries with a decoded buffer, oldest first — a phone cannot hold a whole practice's voice-overs as PCM
const DECODED_MAX = 3;
function narrCtx() {
  if (narrAC && narrAC.state !== 'closed') return narrAC;
  const AC = window.AudioContext || window.webkitAudioContext;
  try { narrAC = new AC({ sampleRate: 24000, latencyHint: 'playback' }); } catch { narrAC = new AC(); }
  narrAC.addEventListener?.('statechange', () => { if (narrAC.state !== 'running' && narrAC.state !== 'closed' && activeNarr.size && document.visibilityState === 'visible') narrAC.resume().catch(() => {}); });
  return narrAC;
}
/** Resolve true once the context is running (resume works inside a tap; after that first unlock it works from anywhere). */
function wakeAudio() {
  const ac = narrCtx();
  if (ac.state === 'running') return Promise.resolve(true);
  return ac.resume().then(() => ac.state === 'running').catch(() => false);
}
/** On a tap in the viewer: unlock WebAudio for the session; on iOS 17+ also ask to be heard over the ringer switch, which WebAudio otherwise obeys. */
function unlockAudio() {
  try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch { /* not there */ }
  wakeAudio().then(ok => {
    if (!ok || audioUnlocked) return;
    audioUnlocked = true;
    try { const ac = narrCtx(), s = ac.createBufferSource(); s.buffer = ac.createBuffer(1, 1, ac.sampleRate); s.connect(ac.destination); s.start(0); } catch { /* fine */ } // a silent tick: the classic iOS unlock
  });
}
for (const ev of ['pointerup', 'touchend', 'keydown']) document.addEventListener(ev, () => { if (presenting) unlockAudio(); }, { capture: true, passive: true });

/** Decode a fetched clip into an AudioBuffer (cached on the entry; only the last few stay decoded). */
async function narrationBuffer(entry) {
  if (!entry) return null;
  if (!entry.buffer) {
    try { entry.buffer = await narrCtx().decodeAudioData(await (await fetch(entry.url)).arrayBuffer()); } catch { entry.buffer = null; }
    if (entry.buffer) { decodedLRU.push(entry); while (decodedLRU.length > DECODED_MAX) { const old = decodedLRU.shift(); if (old !== entry) old.buffer = null; } } // a playing source keeps its own reference
  } else { const i = decodedLRU.indexOf(entry); if (i >= 0) decodedLRU.push(...decodedLRU.splice(i, 1)); }
  return entry.buffer;
}

/** Prefetch the bytes only (the viewer: every drill's clip ready to decode, none of them decoded until played). */
const prefetchNarration = (owner, pid, d) => { if (d.narration) fetchClip(owner, pid, d, 'narration').catch(() => {}); };
/**
 * Play a decoded narration from `at` seconds of audio. Resolves synchronously to a handle; onEnd fires once when the
 * clip finishes or is stopped. `at` maps from animation time as t / speed (the clip was recorded in wall time).
 * The source starts once the context is running — straight away normally, a beat later when iOS had interrupted it.
 */
function playNarration(buffer, at, { onEnd }) {
  const ac = narrCtx();
  let done = false, src = null;
  const finish = () => { if (done) return; done = true; activeNarr.delete(handle); onEnd(); };
  const handle = { stop() { if (done) return; try { src?.stop(); } catch { /* not started */ } finish(); } };
  const off = Math.max(0, Math.min(at, buffer.duration - 0.01));
  if (off >= buffer.duration - 0.02) { done = true; onEnd(); return handle; } // nothing left to say from here
  activeNarr.add(handle);
  const start = () => {
    if (done) return;
    src = ac.createBufferSource(); src.buffer = buffer; src.connect(ac.destination);
    src.onended = finish;
    try { src.start(0, off); } catch { finish(); }
  };
  if (ac.state === 'running') start(); else wakeAudio().then(start); // not running: start as soon as it is (a source started on a sleeping context would be silent for good)
  return handle;
}
/** The narration's audio position for animation time t (t runs at `speed` × wall time). */
const narrAt = (t, speed) => Math.max(0, t) / (speed || 1);

// ----- station rules: a zone's title and constraints, read out as a list -----
const zoneLines = z => String(z.constraints || '').split('\n').map(x => x.trim()).filter(Boolean);
/** Zones in a drill that carry constraints — the "stations" of a rules-only drill. */
const zoneRules = d => d.objects.filter(o => o.type === 'zone' && zoneLines(o).length).map(o => ({ label: o.label || 'Zone', color: o.color || ZONE_COLORS[0], lines: zoneLines(o) }));
let reading = null; // the list currently being read, so a second tap (or leaving the drill) can stop it
function stopReading() { const r = reading; reading = null; if (r) { if (canSpeak) speechSynthesis.cancel(); r.done(); } }
/**
 * Read `lines` one after another (each a sentence, so the voice pauses between them).
 * onLine(k) fires as line k starts — used to highlight it; onDone when finished or stopped.
 */
function readAloud(lines, { onLine = () => {}, onDone = () => {} } = {}) {
  stopReading();
  if (!canSpeak || !lines.length) { onDone(); return; }
  primeVoice();
  speechSynthesis.cancel();
  const me = { done: onDone };
  reading = me;
  lines.forEach((text, k) => {
    const u = new SpeechSynthesisUtterance(/[.!?…]$/.test(text) ? text : `${text}.`);
    u.lang = document.documentElement.lang || 'en';
    u.onstart = () => { if (reading === me) onLine(k); };
    if (k === lines.length - 1) u.onend = () => { if (reading === me) { reading = null; onDone(); } };
    speechSynthesis.speak(u);
  });
}

/**
 * Narrator for one playback: step(prev, now) speaks and captions every cue whose second falls in (prev, now].
 * `caption(text)` shows the words on screen too — a rink is loud, and a muted phone still shows the cue.
 */
function makeNarrator(cues, caption) {
  let timer = 0;
  const show = text => { caption(text); clearTimeout(timer); if (text) timer = setTimeout(() => caption(''), 5000); };
  return {
    step(prev, now, { silent = false } = {}) { for (const c of cues) if (c.t > prev && c.t <= now) { if (!silent) speak(c.text); show(c.text); } },
    clear() { hushVoice(); show(''); },
  };
}

/** One "Impact: worse for" option: number + colour name, tinted in the skater's colour (readable fallback for light ones). */
function loserOption(o, selected) {
  const hex = skaterHex(o) || '';
  const tint = o.color === 'white' || o.color === 'yellow' ? '' : ` style="color:${escHtml(hex)}"`;
  return `<option value="${o.id}"${tint} ${selected ? 'selected' : ''}>${playerName(o)} (${escHtml(o.color || '')})</option>`;
}

const taskAudioKey = (teamId, k) => clipKey(`club:${teamId}`, 'task', k.id, k.audio?.at);
const taskVideoKey = (teamId, k) => clipKey(`clubvideo:${teamId}`, 'task', k.id, k.video?.at);
/** A task's how-to clip as { url, mime, secs }: this device first, then the club's media document (cached for next time). */
async function fetchTaskAudio(teamId, k) {
  if (!k.audio) return null;
  const key = taskAudioKey(teamId, k);
  if (clipMem.has(key)) return clipMem.get(key);
  let rec = null;
  try { rec = await idbGetClip(key); } catch { rec = null; }
  if (!rec && cloudBackend?.loadClubMedia && cloudSync?.user) {
    try { const c = await cloudBackend.loadClubMedia(teamId, `${k.id}_audio`); if (c?.data) { rec = { mime: c.mime, blob: base64ToBlob(c.data, c.mime), secs: c.secs }; idbPutClip(key, rec).catch(() => {}); } } catch { rec = null; }
  }
  if (!rec?.blob) return null;
  const entry = { url: URL.createObjectURL(rec.blob), mime: rec.mime, secs: rec.secs };
  clipMem.set(key, entry); return entry;
}
/** A task's how-to video the same way, from its chunk documents. */
async function fetchTaskVideo(teamId, k, onChunk = () => {}) {
  if (!k.video) return null;
  const key = taskVideoKey(teamId, k);
  if (clipMem.has(key)) return clipMem.get(key);
  let rec = null;
  try { rec = await idbGetClip(key); } catch { rec = null; }
  if (!rec && cloudBackend?.loadClubMedia && cloudSync?.user) {
    try {
      const chunks = [];
      for (let i = 0; i < (k.video.chunks || 0); i++) { onChunk(i + 1, k.video.chunks); const c = await cloudBackend.loadClubMedia(teamId, `${k.id}_video_${k.video.at}_${i}`); if (!c?.data) throw new Error('missing chunk'); chunks.push(c.data); }
      rec = { mime: k.video.mime, blob: chunksToBlob(chunks, k.video.mime), secs: k.video.secs };
      idbPutClip(key, rec).catch(() => {});
    } catch { rec = null; }
  }
  if (!rec?.blob) return null;
  const entry = { url: URL.createObjectURL(rec.blob), mime: rec.mime, secs: rec.secs };
  clipMem.set(key, entry); return entry;
}

const videoKey = (owner, pid, d) => clipKey(`video:${owner}`, pid, d.id, d.upload?.at);

/** Fetch an uploaded video into memory (IndexedDB first, then the chunk documents in the cloud, cached for next time). */
async function fetchUpload(owner, pid, d, onChunk = () => {}) {
  if (!d.upload) return null;
  const key = videoKey(owner, pid, d);
  if (clipMem.has(key)) return clipMem.get(key);
  let rec = null;
  try { rec = await idbGetClip(key); } catch { rec = null; }
  if (!rec && cloudBackend?.loadVideo && cloudSync?.user) {
    try {
      const chunks = await cloudBackend.loadVideo(teamFor(pid), pid, d.id, d.upload.at, d.upload.chunks, onChunk);
      rec = { mime: d.upload.mime, blob: chunksToBlob(chunks, d.upload.mime), secs: d.upload.secs };
      idbPutClip(key, rec).catch(() => {});
    } catch { rec = null; }
  }
  if (!rec?.blob) return null;
  if (clipMem.has(key)) return clipMem.get(key);
  const entry = { url: URL.createObjectURL(rec.blob), mime: rec.mime, secs: rec.secs };
  clipMem.set(key, entry);
  return entry;
}

/** Short name for a skater or coach, e.g. "#3" or "Coach C". */
function playerName(o) { return !o ? '?' : o.type === 'coach' ? `Coach ${escHtml(o.label)}` : `#${escHtml(o.label)}`; }

// Details tucked behind buttons: "+ Practice" (topbar) and "+ Drill" (viewbar) each open a popover.
const popovers = [];
function closePopovers() { for (const pop of popovers) pop.hidden = true; }

// ---------- the lazy editor ----------
// The editor module (editor.js, plus print.js for the paper exports) is fetched only when the
// planner opens /editor (see loadEditor in present.js), so a family's phone never parses it.
// Whatever the viewer side needs to poke at the editor goes through this registry, which
// editor.js fills in when it loads; callers use ?. — a missing entry means "no editor here".
const editorApi = {};
let editorRoute = null; // the editor's route handler, registered by editor.js when it loads
const onEditorRoute = fn => { editorRoute = fn; };
const setEditorOn = v => { editorOn = v; };
const setVoiceOn = v => { voiceOn = v; };

export { ERASE_SECS, activeNarr, animateFrame, boardInkSVG, canSpeak, clipDocId, clipMem, closePopovers, drill, drillCues, drillPoints, editorApi, editorOn, fetchClip, fetchTaskAudio, fetchTaskVideo, fetchUpload, forgetClip, fxLayer, hushVoice, isPSDrill, keyFor, loserOption, makeNarrator, narrAt, narrCtx, narrationBuffer, navigate, objLayer, onEditorRoute, overlay, ownerFor, playClip, playNarration, playerName, popovers, prefetchNarration, primeVoice, readAloud, reading, returnFrame, returnTime, setEditorOn, setVoiceOn, speak, stopReading, store, storedVoice, svg, taskAudioKey, taskVideoKey, teamOf, toRink, videoKey, voiceOn, wakeAudio, zoneLines, zoneRules };
