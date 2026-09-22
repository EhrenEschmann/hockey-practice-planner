import { RINK, VIEWS, rinkSVG, SVG_STYLE, nearestBoardPoint } from './rink.js';
import * as G from './geometry.js';
import { renderObjects, standaloneSVG, SKATER_COLORS, skaterHex, ZONE_COLORS, ARROW_STYLES, starPoints } from './render.js';
import { makeSim, facingOf, isPlayer, underPad, jumpHeight, skaterPoints, DEFAULT_PASS_SPEED, DEFAULT_SHOT_SPEED, CONTACT_DIST } from './sim.js';
import { Store, uid, newDrill, newPractice, practiceLabel, usDate, cloneObjects, migrateDrill, syncFollowers } from './store.js';
import { loadConfig, firebaseBackend, createSync } from './cloud.js';
import { STAGES, STAGE_LABELS, stageOf, accessFor, rosterTeamFor, publishedCopy, parseRoute, routePath, resolveRoute, byCalendar, calendarFocus } from './access.js';
import { PS_ELEMENTS, createPSView } from './powerskate.js';
import { icon, hydrateIcons } from './icons.js';
import { videoEmbed, videoPlayerHTML, probeVideoFile, transcodeVideo, blobToChunks, chunksToBlob, MAX_VIDEO_SECS, VIDEO_MAX_WIDTH } from './video.js';
import { clipKey, idbGetClip, idbPutClip, idbDelClip, canRecord, canPlay, phoneFriendly, startRecording, blobToBase64, base64ToBlob } from './clips.js';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const isEditing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

// ---------- setup ----------
const svg = $('#rink');
svg.innerHTML = `<style>${SVG_STYLE}</style><g id="rink-layer">${rinkSVG()}</g><g id="obj-layer"></g><g id="fx-layer"></g><g id="overlay-layer"></g>`;
const objLayer = svg.querySelector('#obj-layer');
const fxLayer = svg.querySelector('#fx-layer');
const overlay = svg.querySelector('#overlay-layer');

const store = new Store();
let tool = 'select';
let sel = null;            // selected object id
let activeSkater = null;   // skater currently receiving waypoints
let activePoly = null;     // barricade/arrow currently being drawn
let drag = null;           // current pointer drag operation
let spaceDown = false;
let snap = false;
// Playback preferences (speed, show paths) live on the drill itself, so they save with the
// practice, sync to the cloud, and carry into presentation mode for coaches.
const drillSpeed = () => +drill().animSpeed || 1;
const drillPaths = () => drill().showPaths !== false;
let lastSkaterColor = 'blue';
const SIDES = { O: { color: 'blue', name: 'Offense' }, D: { color: 'red', name: 'Defense' } };
let newSide = 'O';            // side (and colour) given to newly placed skaters
let lastZoneColor = 0;

const anim = { playing: false, t: 0, speed: 1, raf: null, last: 0 };
let sim = null;          // simulation of the current drill (rebuilt on every canvas render)
let pickTarget = null;   // { puckId, ev, kind: 'target' | 'dist' | 'bank' } while waiting for a click to set a shot target / path mark / board bounce

const drill = () => store.drill;
const getObj = id => drill().objects.find(o => o.id === id);
const snapPt = p => snap ? { x: Math.round(p.x), y: Math.round(p.y) } : { x: G.round1(p.x), y: G.round1(p.y) };

function toRink(e) {
  const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return { x: pt.x, y: pt.y };
}

// ---------- rendering ----------
// ---------- power skating mode: a drill named "power skating" swaps the rink for the 3D technique viewer ----------
const isPSDrill = d => /power\s*skat/i.test(d?.name || '');
let psViewInst = null;
function psView() {
  return (psViewInst ||= createPSView($('#ps-canvas'), {
    onCaption: txt => { $('#ps-caption').textContent = txt; },
    onIndex: i => { // playback advanced (or a row was picked): highlight the current list entry
      $$('#ps-seq li').forEach(li => li.classList.toggle('active', +li.dataset.i === i));
    },
  }));
}
function renderPSMode(d) {
  const ps = isPSDrill(d);
  $('#canvas-wrap').hidden = ps;
  $('#ps-wrap').hidden = !ps;
  if (!ps) { if (psViewInst?.playing) psViewInst.stop(); return; }
  const seq = (d.psElements || []).filter(k => PS_ELEMENTS.some(e => e.key === k));
  $('#ps-list').innerHTML = `
    <div class="row ps-addrow">
      <select id="ps-pick" title="Element to add">${PS_ELEMENTS.map(e => `<option value="${e.key}">${escHtml(e.name)}</option>`).join('')}</select>
      <button data-act="psadd" title="Add this element to the drill's list">＋ Add</button>
    </div>
    <ol id="ps-seq">${seq.map((k, i) => {
      const e = PS_ELEMENTS.find(x => x.key === k);
      return `<li data-i="${i}" class="${i === (psViewInst?.index || 0) ? 'active' : ''}" title="${escHtml(e?.desc || '')}\nClick to open this element in the 3D view"><span class="muted">${i + 1}.</span><span class="name">${escHtml(e?.name || k)}</span><button data-act="psdel" title="Remove from the list">${icon('x')}</button></li>`;
    }).join('')}</ol>
    ${seq.length ? '' : '<p class="muted small">No elements yet — add some above.</p>'}`;
  psView().setElements(seq, true);
}
$('#ps-list').addEventListener('click', e => {
  const d = drill();
  const btn = e.target.closest('button');
  if (btn?.dataset.act === 'psadd') {
    (d.psElements ||= []).push($('#ps-pick').value);
    store.save(); renderPSMode(d); renderAnimBar();
    psView().select(d.psElements.length - 1); // jump the 3D view to the newly added element
    return;
  }
  const li = e.target.closest('#ps-seq li');
  if (!li) return;
  const i = +li.dataset.i;
  if (btn?.dataset.act === 'psdel') {
    d.psElements.splice(i, 1);
    store.save(); renderPSMode(d); renderAnimBar();
    return;
  }
  // selecting a list entry opens that element in the 3D view and plays it
  psView().select(i);
  if (!psView().playing) psView().toggle();
  renderAnimBar();
});

function renderCanvas() {
  const d = drill();
  syncFollowers(d); // shared routes: followers pick up any edit to their leader's path
  renderPSMode(d);
  svg.setAttribute('viewBox', `${d.view.x} ${d.view.y} ${d.view.w} ${d.view.h}`);
  sim = makeSim(d);
  narrator = makeNarrator(drillCues(d, sim), text => { cueCaption.textContent = text; cueCaption.hidden = !text; });
  if (d.intro) fetchClip(ownerFor(), store.practice.id, d); // ready in memory so ▶ can start it inside the tap
  fxLayer.innerHTML = '';
  const selObj = getObj(sel);
  objLayer.innerHTML = renderObjects(d, sel, { tool, showPaths: drillPaths(), sim, numberWaypoints: selObj?.type === 'puck' || !!selObj?.trigger || (isPlayer(selObj) && !!selObj.path?.length) });
  drawSelection();
  if (anim.t > 0) applyAnimation(anim.t);
  $$('#viewbar [data-view]').forEach(b => b.classList.toggle('active', sameView(VIEWS[b.dataset.view], d.view)));
  const off = offScreenCount(d);
  $('#offscreen').hidden = !off;
  $('#offscreen').textContent = `${off} off-screen`;
}

function sameView(a, b) { return a && b && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < 0.01); }

function drawSelection() {
  overlay.innerHTML = '';
  if (!sel) return;
  const el = objLayer.querySelector(`[data-id="${sel}"]:not(.path-under)`);
  if (!el) { sel = null; return; }
  const target = el.querySelector('.skater-body, .coach-body, .puck-disc, .focus-edge') || el;
  const handlesToHide = Array.from(el.querySelectorAll('.handle'));
  handlesToHide.forEach(h => h.style.display = 'none');
  const bb = target.getBBox();
  handlesToHide.forEach(h => h.style.display = '');
  // getBBox() is in the element's own user space; map its corners into the layer's space (handles transforms).
  const mtx = objLayer.getScreenCTM().inverse().multiply(target.getScreenCTM());
  const corners = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
    .map(([x, y]) => new DOMPoint(x, y).matrixTransform(mtx));
  const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
  const b = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  const m = 0.8;
  overlay.innerHTML = `<rect class="selection" x="${b.x - m}" y="${b.y - m}" width="${b.width + 2 * m}" height="${b.height + 2 * m}" rx=".6"/>`;
}

function renderUI() {
  renderPracticeSelect();
  renderPracticeProps();
  renderPlan();
  renderProps();
  renderAnimBar();
  paintInboxButtons();
  $('#btn-undo').disabled = !store.undoStack.length;
  $('#btn-redo').disabled = !store.redoStack.length;
}

// The practice creator is only brought up for the planner (see syncEditor): share links and other
// accounts never get it — until then it stays out of the page and nothing in it is rendered.
let editorOn = false;
function renderAll() { if (!editorOn) return; renderCanvas(); renderUI(); updateRoute(); }

// ---------- routing: the URL tracks the open practice & drill so refresh restores them ----------
// The URL is a path: /editor/<practice>/<drill> for the planner, /coach/<practice> and /team/<practice> for everyone
// else (js/access.js decides who may be where). Inside the editor the path tracks the open practice & drill.
function updateRoute() {
  if (!editorOn) return; // only the editor writes its place into the URL
  const p = store.practice, d = store.drill;
  if (!p || !d) return;
  if ((store.data.lastDrill ||= {})[p.id] !== d.id) { store.data.lastDrill[p.id] = d.id; store.persist(); }
  const path = routePath({ view: 'editor', pid: p.id, did: d.id });
  if (location.pathname !== path || location.hash) history.replaceState(null, '', path); // replaceState: no history spam
}

/** Open the practice/drill named in the URL; fall back to the last drill viewed in that practice. */
function applyRoute() {
  const { pid, did } = parseRoute(location);
  if (pid && pid !== store.data.currentId && store.data.practices.some(x => x.id === pid)) store.switchPractice(pid);
  const p = store.practice;
  const want = did || store.data.lastDrill?.[p.id];
  const i = p.drills.findIndex(x => x.id === want);
  if (i >= 0) store.drillIndex = i;
}

/** Go to another screen of the app without a page load. */
function navigate(path, { replace = false } = {}) {
  if (path === location.pathname && !location.hash) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  onLocationChange();
}
function onLocationChange() {
  const wasEditor = editorOn;
  refreshScreen();
  if (!editorOn || !wasEditor) return; // entering the editor renders it afresh (syncEditor)
  finishActive();
  applyRoute();
  sel = null; stopAnim(); renderAll();
}
window.addEventListener('popstate', onLocationChange);
window.addEventListener('hashchange', onLocationChange); // links from before paths existed (#view=… / #team=…)

/** Push an undo snapshot, apply a mutation, save and re-render. */
function commit(fn) {
  store.pushUndo();
  fn?.();
  store.save();
  renderAll();
}

// ---------- tools ----------
const HINTS = {
  select: 'Click to select · drag to move · drag handles to reshape · double-click a path to add a waypoint, a waypoint to delete it · Delete removes',
  pan: 'Drag to pan · wheel to zoom',
  skater: 'Click to place a skater, then click (or drag) to add path waypoints · Enter/Esc to finish · click an existing skater or coach to extend their path',
  coach: 'Click to place a coach · or drag the Coach button straight onto the ice',
  goalie: 'Click near a net to put a goalie in its crease (facing out) · click open ice for a goalie anywhere',
  arrow: 'Click points · double-click or Enter to finish · Esc cancels',
  contact: 'Click where two skaters should collide — the two nearest paths are linked and their timing syncs to meet there',
  cone: 'Click to place a cone', tire: 'Click to place a tire',
  minicone: 'Click to place a small cone · drag to lay a row (one every ~3 ft) · a puck carrier stickhandles through them', puck: 'Click a skater or coach to give them a puck · click a pile to take a puck from it · click open ice for a loose puck',
  pile: 'Click to place a pile of pucks · skaters take pucks from it ("Take puck from pile" in their panel)', net: 'Click to place a net (rotate in Selection panel)',
  obstacle: 'Drag a box to add an obstacle / pad',
  raisedpad: 'Click to place a raised pad on tires · skaters whose path runs through it slide under',
  jumppad: 'Click to place a low pad · skaters whose path runs over it jump it',
  barricade: 'Click points to lay a barricade · double-click or Enter to finish',
  zone: 'Drag a box to mark a section / station',
  focusarea: 'Drag a box around the space to work in — the rest of the ice grays out',
  text: 'Click to place a text label',
  erase: 'Click an object to remove it',
};

function setTool(t) {
  finishActive();
  pickTarget = null;
  tool = t;
  document.body.dataset.tool = t;
  $$('#toolbar .tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  $('#hint').textContent = (HINTS[t] || '') + (keepTool[t] ? ' · keeps placing until you press V' : '');
  renderCanvas();
}

/** Finish any in-progress skater path or polyline, then hand off to the Select tool. */
function finishActive() {
  let changed = false, doneId = null;
  if (activePoly) {
    const o = getObj(activePoly);
    if (o) {
      o.points.pop(); // drop the preview point
      while (o.points.length > 1 && G.dist(o.points.at(-1), o.points.at(-2)) < 0.2) o.points.pop();
      if (o.points.length < 2) drill().objects = drill().objects.filter(x => x.id !== o.id);
      else doneId = o.id;
    }
    activePoly = null; changed = true;
  }
  if (activeSkater) {
    if (getObj(activeSkater)) doneId = activeSkater;
    activeSkater = null; changed = true;
  }
  if (changed) { store.save(); renderAll(); }
  if (doneId && tool !== 'select') placed(doneId); // setTool→finishActive recursion is a no-op by now
}

function addObject(o) {
  o.id = o.id || uid();
  commit(() => drill().objects.push(o));
  return o;
}

function newPuck(p, carrier) {
  return { type: 'puck', x: p.x, y: p.y, carrier, events: [], passSpeed: DEFAULT_PASS_SPEED, shotSpeed: DEFAULT_SHOT_SPEED };
}

/** Tools that place a single object at a point — usable by click and by dragging the toolbar button onto the ice. */
const PLACEABLE = new Set(['coach', 'skater', 'goalie', 'cone', 'minicone', 'tire', 'puck', 'pile', 'net', 'raisedpad', 'jumppad', 'contact']);
const CREASE_DEPTH = 3.5;  // ft in front of the goal line where a goalie stands
const NET_SNAP = 8;        // ft: a goalie placed this close to a net goes into its crease
const MINICONE_SPACING = 3; // ft between small cones when laying a row

/** A fresh object of the given placeable type at point p (no id yet). */
function makePlaceable(type, p) {
  const count = t => drill().objects.filter(x => x.type === t).length;
  switch (type) {
    case 'coach': { const k = count('coach'); return { type: 'coach', x: p.x, y: p.y, label: k ? `C${k + 1}` : 'C', speed: 10, delay: 0, path: [] }; } // no colour: coaches draw dark (COACH_COLOR) until one is picked
    case 'skater': {
      // Offense (blue) or defense (red), numbered per side; a custom last colour is used when no side is set.
      const side = SIDES[newSide] ? newSide : null;
      const n = drill().objects.filter(x => x.type === 'skater' && x.role !== 'G' && (side ? x.side === side : !x.side)).length + 1;
      return { type: 'skater', x: p.x, y: p.y, label: String(n), color: side ? SIDES[side].color : lastSkaterColor, role: 'F', speed: 20, delay: 0, backward: false, path: [], ...(side ? { side } : {}) };
    }
    case 'goalie': {
      const net = drill().objects.filter(o => o.type === 'net' && G.dist(o, p) < NET_SNAP).sort((a, b) => G.dist(a, p) - G.dist(b, p))[0];
      return makeGoalie(net, p);
    }
    case 'cone': return { type: 'cone', x: p.x, y: p.y, color: '#ff6a00' };
    case 'minicone': return { type: 'minicone', x: p.x, y: p.y, color: '#ffb300' };
    case 'tire': return { type: 'tire', x: p.x, y: p.y };
    case 'pile': return { type: 'pile', x: p.x, y: p.y, count: 12 };
    case 'raisedpad': return { type: 'raisedpad', x: p.x, y: p.y, w: 6, h: 2, rot: 0, label: '' };
    case 'jumppad': return { type: 'jumppad', x: p.x, y: p.y, w: 6, h: 1.5, rot: 0, label: '' };
    case 'net': return { type: 'net', x: p.x, y: p.y, rot: p.x > RINK.W / 2 ? 180 : 0 };
    case 'contact': {
      // Link the two nearest participants: skaters by their paths, coaches (tackle pad) by where they stand.
      const near = drill().objects
        .filter(o => (o.type === 'skater' && o.path?.length) || o.type === 'coach')
        .map(o => ({ id: o.id, d: G.closestOnPolyline(G.smoothPath(skaterPoints(o), 4), p).dist }))
        .sort((a, b) => a.d - b.d);
      return { type: 'contact', x: p.x, y: p.y, a: near[0]?.id ?? null, b: near[1]?.id ?? null };
    }
    case 'puck': {
      // Dropped onto a skater or coach without a puck → they carry it.
      const s = drill().objects.find(o => isPlayer(o) && G.dist(o, p) < 3);
      const taken = s && drill().objects.some(o => o.type === 'puck' && o.carrier === s.id);
      return newPuck(p, s && !taken ? s.id : null);
    }
  }
  return null;
}

/** A puck that starts in `pile`, picked up by `player` where their path passes closest to the pile. */
function puckFromPile(pile, player) {
  const pk = { id: uid(), type: 'puck', x: pile.x, y: pile.y, carrier: null, pile: pile.id, events: [], passSpeed: DEFAULT_PASS_SPEED, shotSpeed: DEFAULT_SHOT_SPEED };
  if (player) {
    const tm = sim.skater(player.id);
    const ev = { type: 'pickup', skater: player.id, wp: 0 };
    if (player.path?.length) ev.dist = G.round1(G.projectOnPolyline(tm.dense, tm.cum, pile).d);
    pk.events.push(ev);
  }
  return pk;
}
// ---------- coach at a puck pile: chips into the corner / around the boards ----------
const PILE_LINK_DIST = 5; // ft: a coach standing this close to a pile feeds pucks from it
function pileAtCoach(coach) { return drill().objects.find(p => p.type === 'pile' && G.dist(p, coach) <= PILE_LINK_DIST) || null; }
function coachAtPile(pile) { return drill().objects.find(c => c.type === 'coach' && G.dist(c, pile) <= PILE_LINK_DIST) || null; }

/** Where dumped pucks collect: just inside the glass in each corner. */
const CORNERS = [{ x: 9, y: 9 }, { x: 9, y: 76 }, { x: 191, y: 9 }, { x: 191, y: 76 }];
const nearestCorner = p => [...CORNERS].sort((a, b) => G.dist(a, p) - G.dist(b, p))[0];

/** A puck the coach takes from the pile and chips in: straight into the nearest corner, or banked there and rimmed around the end boards to the far corner. */
function chipPuck(coach, pile, around) {
  const c1 = nearestCorner(coach);
  const ev = { type: 'shoot', wp: 0, target: { ...c1 } };
  if (around) { ev.bank = { ...c1 }; ev.target = { ...CORNERS.find(c => c.x === c1.x && c !== c1) }; }
  return { id: uid(), type: 'puck', x: pile.x, y: pile.y, carrier: coach.id, pile: pile.id, events: [ev], passSpeed: DEFAULT_PASS_SPEED, shotSpeed: 55 };
}

/** The pile closest to a player's path (or to the player), if there is one. */
function nearestPile(player) {
  const piles = drill().objects.filter(o => o.type === 'pile');
  if (!piles.length) return null;
  const tm = sim.skater(player.id);
  return piles.sort((a, b) => G.projectOnPolyline(tm.dense, tm.cum, a).dist - G.projectOnPolyline(tm.dense, tm.cum, b).dist)[0];
}

/** The puck that ends up loose (chipped into the corner, a missed shot, a plain loose puck) nearest this player's path: { pk, at, d } or null. */
function nearestLoosePuck(player) {
  const tm = sim.skater(player.id);
  let best = null;
  for (const pk of drill().objects.filter(x => x.type === 'puck' && x.id !== player.id)) {
    const last = sim.puck(pk.id).segs.at(-1);
    if (last.kind !== 'loose') continue; // ends the drill carried by someone
    const d = G.projectOnPolyline(tm.dense, tm.cum, last.at).dist;
    if (!best || d < best.d) best = { pk, at: last.at, d };
  }
  return best;
}

/** Where a goalie stands for a net: just in front of the goal line, on the side the net opens to. */
function creaseSpot(net) {
  const a = (net.rot || 0) * Math.PI / 180;
  return { x: G.round1(net.x + CREASE_DEPTH * Math.cos(a)), y: G.round1(net.y + CREASE_DEPTH * Math.sin(a)) };
}
/** A goalie in the crease of `net` (facing out of it), or at point p if no net is given. */
function makeGoalie(net, p) {
  const n = drill().objects.filter(o => o.type === 'skater' && o.role === 'G').length;
  const pos = net ? creaseSpot(net) : p;
  const g = { type: 'skater', x: pos.x, y: pos.y, label: n ? `G${n + 1}` : 'G', color: 'green', role: 'G', speed: 20, delay: 0, backward: false, path: [] };
  if (net) g.facing = ((net.rot || 0) % 360 + 360) % 360;
  return g;
}
/** The goalie already standing in a net's crease, if any. */
function goalieOf(net) {
  const spot = creaseSpot(net);
  return drill().objects.find(o => o.type === 'skater' && o.role === 'G' && G.dist(o, spot) < 4) || null;
}

/** Evenly spaced points from a to b, about MINICONE_SPACING ft apart (at least two). */
function rowPoints(a, b) {
  const len = G.dist(a, b);
  const count = Math.max(2, Math.round(len / MINICONE_SPACING) + 1);
  return Array.from({ length: count }, (_, i) => ({ x: G.round1(a.x + (b.x - a.x) * i / (count - 1)), y: G.round1(a.y + (b.y - a.y) * i / (count - 1)) }));
}

function deleteObject(id) {
  if (!id) return;
  const victim = getObj(id);
  commit(() => {
    const d = drill();
    d.objects = d.objects.filter(o => o.id !== id);
    if (isPlayer(victim)) for (const x of d.objects) if (x.trigger?.player === id) delete x.trigger;
    if (victim?.type === 'pile') for (const pk of d.objects) if (pk.type === 'puck' && pk.pile === id) { pk.x = victim.x; pk.y = victim.y; delete pk.pile; }
    if (isPlayer(victim)) for (const x of d.objects) if (x.type === 'contact') { if (x.a === id) x.a = null; if (x.b === id) x.b = null; }
    if (d.impactLoser === id) d.impactLoser = null;
    if (isPlayer(victim)) for (const pk of d.objects) if (pk.type === 'puck') {
      if (pk.carrier === id) { pk.carrier = null; pk.x = victim.x; pk.y = victim.y; }
      pk.events = (pk.events || []).filter(ev => ev.to !== id && ev.skater !== id);
    }
  });
  if (sel === id) sel = null;
  if (activeSkater === id) activeSkater = null;
  renderAll();
}

function select(id) { sel = id; renderCanvas(); renderProps(); }

/** A placement is done: hand control back to the Select tool with the new object selected. */
// Tools that stay selected after a placement ("keep placing"), so a row of tires takes one click each.
const keepTool = { tire: false };
try { keepTool.tire = localStorage.getItem('hpp.keep.tire') === '1'; } catch { /* fine */ }
$('#tire-keep').checked = keepTool.tire;
$('#tire-keep').addEventListener('change', e => {
  keepTool.tire = e.target.checked;
  try { localStorage.setItem('hpp.keep.tire', keepTool.tire ? '1' : '0'); } catch { /* fine */ }
  if (tool === 'tire') $('#hint').textContent = HINTS.tire + (keepTool.tire ? ' · keeps placing until you press V' : '');
});
function placed(id) {
  select(id);
  if (tool !== 'select' && !keepTool[tool]) setTool('select');
}

// ---------- pointer handling ----------
svg.addEventListener('pointerdown', onPointerDown);
svg.addEventListener('pointermove', onPointerMove);
svg.addEventListener('pointerup', onPointerUp);
svg.addEventListener('pointercancel', onPointerUp);
svg.addEventListener('dblclick', onDblClick);
svg.addEventListener('wheel', onWheel, { passive: false });
svg.addEventListener('contextmenu', e => e.preventDefault());

function onPointerDown(e) {
  if (e.button === 2) return;
  svg.setPointerCapture(e.pointerId);
  const raw = toRink(e);
  const p = snapPt(raw);
  const idEl = e.target.closest('[data-id]');
  const id = idEl?.dataset.id;
  const handleEl = e.target.closest('[data-handle]');

  if (pickTarget) {
    const pt = pickTarget; pickTarget = null;
    $('#hint').textContent = HINTS[tool] || '';
    const pk = getObj(pt.puckId); const ev = pk?.events?.[pt.ev];
    if (!ev) return;
    if (pt.kind === 'dist') {
      const who = eventSkater(pk, pt.ev);
      if (who) commit(() => ev.dist = pathDistanceAt(who, raw));
    } else if (pt.kind === 'bank') commit(() => ev.bank = boardPt(raw));
    else commit(() => ev.target = { x: p.x, y: p.y });
    return;
  }

  if (e.button === 1 || spaceDown || tool === 'pan') {
    drag = { type: 'pan', sx: e.clientX, sy: e.clientY, view: { ...drill().view } };
    document.body.classList.add('panning');
    return;
  }

  // Double-clicks are detected here by hand: setPointerCapture retargets pointerup to the svg,
  // which stops the browser from ever synthesizing a native dblclick on the canvas.
  const now = performance.now();
  const dbl = lastDown && now - lastDown.t < 400 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 8;
  lastDown = { t: now, x: e.clientX, y: e.clientY };
  if (dbl) {
    lastDown = null; // a triple-click shouldn't chain
    if (activePoly || activeSkater) { finishActive(); drag = null; return; } // double-click finishes a drawing
    // Like a native dblclick, the action fires on *release* — if this press turns into a drag
    // (select something, then immediately grab a handle and pull), it must drag, not double-click.
    if (tool === 'select') pendingDbl = { x: e.clientX, y: e.clientY, idEl, handleEl, rink: raw };
  }

  switch (tool) {
    case 'select': {
      const markEl = e.target.closest('[data-evmark]');
      const markWho = markEl && id ? eventSkater(getObj(id), +markEl.dataset.evmark) : null;
      const bankEl = e.target.closest('[data-bank]');
      const arriveEl = e.target.closest('[data-arrive]');
      const arriveTo = arriveEl && id ? getObj(id)?.events?.[+arriveEl.dataset.arrive]?.to : null;
      const cornerEl = e.target.closest('[data-corner]');
      if (cornerEl && id && getObj(id)) {
        // resize a zone / focus box: the opposite corner stays put
        const o = getObj(id), c = cornerEl.dataset.corner;
        const anchor = { x: c.includes('w') ? o.x + o.w : o.x, y: c.includes('n') ? o.y + o.h : o.y };
        drag = { type: 'resize', id, anchor, pushed: false };
        select(id);
      } else if (bankEl && id && getObj(id)?.events?.[+bankEl.dataset.bank]) {
        drag = { type: 'bank', id, ev: +bankEl.dataset.bank, pushed: false };
        select(id);
      } else if (arriveTo && getObj(arriveTo)?.path?.length) {
        // the arrival end of a pass: drag it along the receiver's path
        drag = { type: 'arrive', id, ev: +arriveEl.dataset.arrive, who: arriveTo, pushed: false };
        select(id);
      } else if (markWho) {
        drag = { type: 'evmark', id, ev: +markEl.dataset.evmark, who: markWho, pushed: false };
        select(id);
      } else if (handleEl && id) {
        const o = getObj(id);
        drag = { type: 'handle', id, index: +handleEl.dataset.handle, key: isPlayer(o) ? 'path' : 'points', pushed: false };
        select(id);
      } else if (id) {
        const o = getObj(id);
        if (o.type === 'puck' && (o.carrier || o.pile)) { const q = sim.puckPos(o.id, 0); o.x = G.round1(q.x); o.y = G.round1(q.y); }
        drag = { type: 'move', id, start: raw, orig: JSON.parse(JSON.stringify(o)), pushed: false };
        select(id);
      } else {
        select(null);
      }
      break;
    }
    case 'skater': {
      const o = id && getObj(id);
      if (isPlayer(o) && o.id !== activeSkater) {
        if (o.follow) { select(o.id); $('#hint').textContent = `${playerName(o)} follows ${playerName(getObj(o.follow))}'s path — set "Same path as" to their own path to draw one.`; break; }
        o.path ||= [];
        activeSkater = o.id; select(o.id);
      } else if (activeSkater && getObj(activeSkater)) {
        drag = { type: 'freehand', id: activeSkater, pts: [raw], start: p };
      } else {
        const s = addObject(makePlaceable('skater', p));
        activeSkater = s.id; select(s.id);
      }
      break;
    }
    case 'coach': placed(addObject(makePlaceable('coach', p)).id); break;
    case 'contact': placed(addObject(makePlaceable('contact', p)).id); break;
    case 'goalie': placed(addObject(makePlaceable('goalie', p)).id); break;
    case 'cone': placed(addObject(makePlaceable('cone', p)).id); break;
    case 'minicone': drag = { type: 'row', start: p }; break; // click = one cone, drag = a row (decided on pointerup)
    case 'tire': placed(addObject(makePlaceable('tire', p)).id); break;
    case 'pile': placed(addObject(makePlaceable('pile', p)).id); break;
    case 'raisedpad': placed(addObject(makePlaceable('raisedpad', p)).id); break;
    case 'jumppad': placed(addObject(makePlaceable('jumppad', p)).id); break;
    case 'puck': {
      const s = id && getObj(id);
      if (isPlayer(s)) {
        const existing = drill().objects.find(o => o.type === 'puck' && o.carrier === s.id);
        if (existing) placed(existing.id);
        else placed(addObject(newPuck(p, s.id)).id);
      } else if (s?.type === 'pile') {
        const pk = puckFromPile(s, null);
        commit(() => drill().objects.push(pk)); placed(pk.id);
      } else if (s?.type === 'puck') {
        placed(s.id);
      } else {
        placed(addObject(newPuck(p, null)).id);
      }
      break;
    }
    case 'net': placed(addObject(makePlaceable('net', p)).id); break;
    case 'text': { const t = addObject({ type: 'text', x: p.x, y: p.y, text: 'Label', size: 3, color: '#111' }); placed(t.id); focusProp('text'); break; }
    case 'obstacle':
    case 'focusarea':
    case 'zone': {
      const o = tool === 'zone'
        ? { id: uid(), type: 'zone', x: p.x, y: p.y, w: 0, h: 0, label: `Station ${drill().objects.filter(x => x.type === 'zone').length + 1}`, color: ZONE_COLORS[lastZoneColor++ % ZONE_COLORS.length] }
        : tool === 'focusarea' ? { id: uid(), type: 'focus', x: p.x, y: p.y, w: 0, h: 0, dim: '0.55' }
        : { id: uid(), type: 'obstacle', x: p.x, y: p.y, w: 0, h: 0, rot: 0, label: '' };
      store.pushUndo();
      drill().objects.push(o);
      drag = { type: 'rect', id: o.id, start: p };
      renderCanvas();
      break;
    }
    case 'barricade':
    case 'arrow': {
      if (activePoly && getObj(activePoly)) {
        const o = getObj(activePoly);
        o.points[o.points.length - 1] = p;
        o.points.push({ ...p });
      } else {
        const o = tool === 'barricade'
          ? { id: uid(), type: 'barricade', points: [p, { ...p }] }
          : { id: uid(), type: 'arrow', points: [p, { ...p }], style: 'skate', color: '#111' };
        store.pushUndo();
        drill().objects.push(o);
        activePoly = o.id; sel = o.id;
      }
      renderCanvas();
      break;
    }
    case 'erase': if (id) deleteObject(id); break;
  }
}

function onPointerMove(e) {
  if (pendingDbl && Math.hypot(e.clientX - pendingDbl.x, e.clientY - pendingDbl.y) > 4) pendingDbl = null; // it became a drag
  if (!drag) {
    if (activePoly && getObj(activePoly)) {
      const o = getObj(activePoly);
      o.points[o.points.length - 1] = snapPt(toRink(e));
      renderCanvas();
    }
    return;
  }
  const raw = toRink(e);
  const p = snapPt(raw);
  const d = drill();
  switch (drag.type) {
    case 'pan': {
      const ctm = svg.getScreenCTM();
      d.view.x = drag.view.x - (e.clientX - drag.sx) / ctm.a;
      d.view.y = drag.view.y - (e.clientY - drag.sy) / ctm.d;
      renderCanvas();
      break;
    }
    case 'move': {
      const o = getObj(drag.id); if (!o) return;
      if (!drag.pushed) { store.pushUndo(JSON.stringify(withObj(drag.orig))); drag.pushed = true; }
      let dx = raw.x - drag.start.x, dy = raw.y - drag.start.y;
      if (snap) { dx = Math.round(dx); dy = Math.round(dy); }
      const tr = q => ({ ...q, x: G.round1(q.x + dx), y: G.round1(q.y + dy) }); // spread keeps waypoint flags (e.g. pivot)
      if (o.points) o.points = drag.orig.points.map(tr);
      else { Object.assign(o, tr(drag.orig)); if (o.path) o.path = drag.orig.path.map(tr); }
      if (o.type === 'puck') { o.carrier = null; delete o.pile; } // dragging detaches; dropping on a skater re-attaches (see onPointerUp)
      renderCanvas();
      break;
    }
    case 'handle': {
      const o = getObj(drag.id); if (!o) return;
      if (!drag.pushed) { store.pushUndo(); drag.pushed = true; }
      Object.assign(o[drag.key][drag.index], p); // assign in place: waypoint flags (e.g. pivot) survive the drag
      renderCanvas();
      break;
    }
    case 'evmark': {
      const ev = getObj(drag.id)?.events?.[drag.ev]; if (!ev) return;
      if (!drag.pushed) { store.pushUndo(); drag.pushed = true; }
      ev.dist = pathDistanceAt(drag.who, raw);
      renderCanvas();
      break;
    }
    case 'bank': {
      const ev = getObj(drag.id)?.events?.[drag.ev]; if (!ev) return;
      if (!drag.pushed) { store.pushUndo(); drag.pushed = true; }
      ev.bank = boardPt(raw);
      renderCanvas();
      break;
    }
    case 'arrive': { // the pass now arrives where the receiver's path passes the pointer (receiver-timed)
      const ev = getObj(drag.id)?.events?.[drag.ev]; if (!ev) return;
      if (!drag.pushed) { store.pushUndo(); drag.pushed = true; }
      ev.by = 'receiver';
      ev.dist = pathDistanceAt(drag.who, raw);
      renderCanvas();
      break;
    }
    case 'resize': {
      const o = getObj(drag.id); if (!o) return;
      if (!drag.pushed) { store.pushUndo(); drag.pushed = true; }
      const r = G.rectFromPoints(drag.anchor, p);
      Object.assign(o, { x: r.x, y: r.y, w: Math.max(1.5, r.w), h: Math.max(1.5, r.h) });
      renderCanvas();
      if (!propsBody.contains(document.activeElement)) renderProps(); // width / height fields follow the drag
      break;
    }
    case 'rect': {
      const o = getObj(drag.id); if (!o) return;
      const r = G.rectFromPoints(drag.start, p);
      if (o.type === 'zone' || o.type === 'focus') Object.assign(o, r);
      else Object.assign(o, { x: G.round1(r.x + r.w / 2), y: G.round1(r.y + r.h / 2), w: G.round1(r.w), h: G.round1(r.h) });
      renderCanvas();
      break;
    }
    case 'row': {
      const pts = G.dist(drag.start, p) < 1.5 ? [drag.start] : rowPoints(drag.start, p);
      overlay.innerHTML = `<g class="drop-preview">${renderObjects({ objects: pts.map((q, i) => ({ id: `row${i}`, ...makePlaceable('minicone', q) })) }, null, {})}</g>`;
      break;
    }
    case 'freehand': {
      drag.pts.push(raw);
      if (drag.pts.length > 2) {
        const o = getObj(drag.id);
        overlay.innerHTML = `<polyline points="${drag.pts.map(q => `${q.x},${q.y}`).join(' ')}" fill="none" stroke="${skaterHex(o)}" stroke-width=".4" stroke-dasharray="1 .6"/>`;
      }
      break;
    }
  }
}

/** Snapshot of the current practice with one object replaced (used so move-undo restores the pre-drag position). */
function withObj(orig) {
  const p = JSON.parse(store.snapshot());
  const dd = p.drills[store.drillIndex];
  const i = dd.objects.findIndex(o => o.id === orig.id);
  if (i >= 0) dd.objects[i] = orig;
  return p;
}

function onPointerUp(e) {
  document.body.classList.remove('panning');
  if (pendingDbl) { // released without moving: this really was a double-click
    const pd = pendingDbl; pendingDbl = null;
    if (doubleClickSelect(pd.rink, pd.idEl, pd.handleEl)) { drag = null; return; }
  }
  if (!drag) return;
  const dg = drag; drag = null;
  const d = drill();
  switch (dg.type) {
    case 'pan': store.save(); break;
    case 'move': {
      const o = getObj(dg.id);
      if (o?.type === 'puck' && dg.pushed) {
        const target = d.objects.find(s => isPlayer(s) && G.dist(s, o) < 3);
        o.carrier = target ? target.id : null;
      }
      store.save(); renderAll(); break;
    }
    case 'evmark': case 'arrive': {
      // Dropped before the puck can be there? The sim already fires the event where the player has it;
      // store that spot so the panel's feet-on-path matches the marker instead of showing an impossible value.
      const pk = getObj(dg.id); const ev = pk?.events?.[dg.ev];
      if (ev && ev.dist != null) { sim = makeSim(drill()); if (sim.puck(pk.id).info[dg.ev]?.late) { const eff = effectiveDist(pk, dg.ev); if (eff != null) ev.dist = eff; } }
      store.save(); renderAll(); break;
    }
    case 'handle': case 'bank': case 'resize': store.save(); renderAll(); break;
    case 'rect': {
      const o = getObj(dg.id);
      if (o.w < 1.5 || o.h < 1.5) {
        if (o.type === 'obstacle') { o.w = 4; o.h = 2; }
        else d.objects = d.objects.filter(x => x.id !== o.id);
      }
      store.save();
      sel = getObj(dg.id) ? dg.id : null;
      renderAll();
      if (sel) placed(sel);
      break;
    }
    case 'row': {
      const p = snapPt(toRink(e));
      const pts = G.dist(dg.start, p) < 1.5 ? [dg.start] : rowPoints(dg.start, p);
      const made = [];
      commit(() => { for (const q of pts) { const o = { id: uid(), ...makePlaceable('minicone', q) }; made.push(o); drill().objects.push(o); } });
      if (made.length) placed(made.at(-1).id);
      break;
    }
    case 'freehand': {
      const o = getObj(dg.id); if (!o) return;
      const total = G.cumulative(dg.pts).at(-1);
      store.pushUndo();
      if (total < 2) {
        o.path.push(dg.start);
      } else {
        const simplified = G.rdp(dg.pts, 1.2).slice(1).map(q => ({ x: G.round1(q.x), y: G.round1(q.y) }));
        o.path.push(...simplified);
      }
      store.save();
      renderAll();
      break;
    }
  }
}

let canvasClipboard = null; // deep copies of the last ⌘C'd object (plus its carried puck), pasteable into any drill
let lastDown = null;   // {t, x, y} of the previous pointerdown, for manual double-click detection
let pendingDbl = null; // a detected double-click waiting for its release; movement cancels it (it became a drag)

/** Double-click with the Select tool: delete the clicked waypoint handle, or insert a waypoint on the clicked path line. Returns true if consumed. */
function doubleClickSelect(p, idEl, handleEl) {
  if (handleEl && idEl) {
    const o = getObj(idEl.dataset.id);
    if (!o) return false;
    const key = isPlayer(o) ? 'path' : 'points';
    if (key === 'points' && o.points.length <= 2) return true;
    commit(() => o[key].splice(+handleEl.dataset.handle, 1));
    return true;
  }
  if (!idEl) return false;
  const o = getObj(idEl.dataset.id);
  if (!isPlayer(o) || !o.path?.length) return false;
  if (o.follow) { $('#hint').textContent = `${playerName(o)} follows ${playerName(getObj(o.follow))}'s path — add the waypoint on that path instead.`; return true; }
  // Test against the smoothed curve — that's the line the user sees and clicks.
  const pts = skaterPoints(o);
  const dense = G.smoothPath(pts);
  const proj = G.projectOnPolyline(dense, G.cumulative(dense), p);
  if (!proj || proj.dist >= 3) return false;
  // Insert between the raw waypoints whose positions along the smooth curve bracket the click.
  let i = 0;
  while (i + 1 < pts.length - 1 && G.closestOnPolyline(dense, pts[i + 1]).along <= proj.d) i++;
  commit(() => o.path.splice(i, 0, snapPt(proj)));
  select(o.id);
  return true;
}

function onDblClick() {
  // Real dblclick rarely reaches the canvas (see the manual detection in onPointerDown); kept as a harmless fallback.
  if (activePoly || activeSkater) finishActive();
}

function onWheel(e) {
  e.preventDefault();
  const p = toRink(e);
  const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
  zoomAt(p, f);
}

function zoomAt(p, f) {
  const v = drill().view;
  const nw = G.clamp(v.w * f, 20, 400);
  const ff = nw / v.w;
  v.x = p.x - (p.x - v.x) * ff;
  v.y = p.y - (p.y - v.y) * ff;
  v.w = nw; v.h = v.h * ff;
  store.save();
  renderCanvas();
}

function setView(v) { drill().view = { ...v }; store.save(); renderCanvas(); }

// ---------- keyboard ----------

document.addEventListener('keydown', e => {
  if (presenting) { presentKeydown(e); return; } // presentation is view-only and terminal: no editor shortcuts, no way "back"
  if (!editorOn) return;
  if (!$('#library').hidden) { if (e.key === 'Escape') closeLibrary(); return; } // the library modal captures the keyboard
  if (!$('#teammgr').hidden) { if (e.key === 'Escape' && !isEditing()) closeTeamMgr(); return; } // same for the team manager
  if (!$('#viewlog').hidden) { if (e.key === 'Escape') $('#viewlog').hidden = true; return; }
  if (!$('#feedback').hidden) { if (e.key === 'Escape') $('#feedback').hidden = true; return; }
  if (e.key === ' ' && !isEditing()) { e.preventDefault(); if (!spaceDown) { spaceDown = true; } return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
  // Copy / paste the selected object (works across drills; a carried puck rides along)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && sel && !isEditing()) {
    const o = getObj(sel); if (!o) return;
    e.preventDefault();
    const group = [o, ...drill().objects.filter(pk => pk.type === 'puck' && pk.carrier === o.id)];
    canvasClipboard = JSON.parse(JSON.stringify(group));
    $('#hint').textContent = `Copied ${TYPE_NAMES[o.type] || o.type} — ⌘/Ctrl+V pastes (in this drill or another)`;
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && canvasClipboard && !isEditing()) {
    e.preventDefault();
    for (const c of canvasClipboard) translateObj(c, 4, 4); // stagger repeated pastes
    const copies = cloneObjects(canvasClipboard);
    commit(() => drill().objects.push(...copies));
    select(copies[0].id);
    renderProps();
    return;
  }
  if (isEditing()) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (e.key === 'Escape') {
    if (pickTarget) { pickTarget = null; $('#hint').textContent = HINTS[tool] || ''; }
    else if (activePoly || activeSkater) finishActive();
    else select(null);
    return;
  }
  if (e.key === 'Enter') { finishActive(); return; }
  if (e.key === 'PageUp') { e.preventDefault(); stepDrill(-1); return; }
  if (e.key === 'PageDown') { e.preventDefault(); stepDrill(1); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteObject(sel); return; }
  if (e.key.startsWith('Arrow') && sel) {
    e.preventDefault();
    const step = e.shiftKey ? 5 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    commit(() => translateObj(getObj(sel), dx, dy));
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const keys = { v: 'select', h: 'pan', s: 'skater', k: 'coach', g: 'goalie', i: 'contact', r: 'raisedpad', j: 'jumppad', l: 'pile', a: 'arrow', c: 'cone', m: 'minicone', t: 'tire', p: 'puck', n: 'net', o: 'obstacle', b: 'barricade', z: 'zone', f: 'focusarea', x: 'text', e: 'erase' };
  const t = keys[e.key.toLowerCase()];
  if (t) setTool(t);
});
document.addEventListener('keyup', e => {
  if (presenting || !editorOn) return;
  if (e.key === ' ') {
    if (spaceDown && !isEditing() && !drag) togglePlay();
    spaceDown = false;
  }
});

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
const offScreenCount = d => drillPoints(d).filter(p => p.x < d.view.x || p.y < d.view.y || p.x > d.view.x + d.view.w || p.y > d.view.y + d.view.h).length;
/** Zoom out so the whole rink and everything in the drill — wherever it ended up — is on the canvas. */
function fitAll() {
  let x0 = -3, y0 = -3, x1 = RINK.W + 3, y1 = RINK.H + 3;
  for (const p of drillPoints(drill())) { x0 = Math.min(x0, p.x - 4); y0 = Math.min(y0, p.y - 4); x1 = Math.max(x1, p.x + 4); y1 = Math.max(y1, p.y + 4); }
  setView({ x: G.round1(x0), y: G.round1(y0), w: G.round1(x1 - x0), h: G.round1(y1 - y0) });
}

/**
 * Mirror an object across the rink's centre line (axis 'x': left ↔ right) or its long axis ('y': top ↔ bottom).
 * Any reflection flips handedness, so pivots swap sides and rotations / facings are reflected too.
 */
function mirrorObj(o, axis = 'x') {
  const W = RINK.W, H = RINK.H;
  const mp = q => ({ ...q, x: axis === 'x' ? G.round1(W - q.x) : q.x, y: axis === 'y' ? G.round1(H - q.y) : q.y });
  const ang = a => (a == null || a === '' ? a : ((axis === 'x' ? 180 - +a : -+a) % 360 + 360) % 360);
  if (o.points) o.points = o.points.map(mp);
  if (o.type === 'zone' || o.type === 'focus') { // boxes are anchored top-left: reflect the far edge
    if (axis === 'x') o.x = G.round1(W - o.x - o.w); else o.y = G.round1(H - o.y - o.h);
  } else if (o.x != null) Object.assign(o, mp(o));
  if (o.path) o.path = o.path.map(pt => { const q = mp(pt); if (q.pivot) q.pivot = q.pivot === 'L' ? 'R' : 'L'; return q; });
  if (o.rot != null) o.rot = ang(o.rot);
  if (o.facing != null) o.facing = ang(o.facing);
  if (o.trigger?.dist == null && o.trigger) { /* waypoint-timed: unchanged */ }
  for (const ev of o.events || []) { if (ev.target) ev.target = mp(ev.target); if (ev.bank) ev.bank = mp(ev.bank); }
  return o;
}
function mirrorView(v, axis) { return axis === 'x' ? { ...v, x: G.round1(RINK.W - v.x - v.w) } : { ...v, y: G.round1(RINK.H - v.y - v.h) }; }
/** Flip the whole drill (and its view) across an axis. */
function mirrorDrill(axis) {
  finishActive();
  commit(() => { const d = drill(); d.objects.forEach(o => mirrorObj(o, axis)); d.view = mirrorView(d.view, axis); });
  select(null);
}
/** Add a mirrored copy of everything in the drill, so the same drill runs at both ends (or both sides) at once. */
function copyDrillMirrored(axis) {
  finishActive();
  const src = drill().objects.filter(o => o.type !== 'focus'); // one gray-out is enough
  const copies = cloneObjects(src).map(o => mirrorObj(o, axis));
  commit(() => { const d = drill(); d.objects.push(...copies); d.view = { ...VIEWS.full }; });
  select(null);
}

function translateObj(o, dx, dy) {
  if (!o) return;
  const tr = q => ({ ...q, x: G.round1(q.x + dx), y: G.round1(q.y + dy) }); // spread keeps waypoint flags (e.g. pivot)
  if (o.points) o.points = o.points.map(tr);
  else { Object.assign(o, tr(o)); if (o.path) o.path = o.path.map(tr); }
}

/** Uniformly scale and centre everything in the drill (except `zone` itself) to fit inside `zone`. */
function resizeDrillInto(zone) {
  const objs = drill().objects.filter(o => o.id !== zone.id);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const o of objs) {
    if (o.points) o.points.forEach(p => grow(p.x, p.y));
    if (o.x != null) grow(o.x, o.y);
    (o.path || []).forEach(p => grow(p.x, p.y));
    if (o.type === 'zone' || o.type === 'focus') { grow(o.x, o.y); grow(o.x + o.w, o.y + o.h); }
  }
  if (!isFinite(minX)) return;
  const m = 2; // ft of breathing room inside the zone
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const s = Math.min((zone.w - 2 * m) / bw, (zone.h - 2 * m) / bh);
  if (!(s > 0)) { alert('The zone is too small to fit the drill into.'); return; }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const zx = zone.x + zone.w / 2, zy = zone.y + zone.h / 2;
  const tx = x => G.round1(zx + (x - cx) * s), ty = y => G.round1(zy + (y - cy) * s);
  commit(() => {
    for (const o of objs) {
      if (o.points) o.points = o.points.map(p => ({ ...p, x: tx(p.x), y: ty(p.y) }));
      if (o.x != null) { o.x = tx(o.x); o.y = ty(o.y); }
      if (o.path) o.path = o.path.map(p => ({ ...p, x: tx(p.x), y: ty(p.y) }));
      if (o.w != null) o.w = G.round1(o.w * s);
      if (o.h != null) o.h = G.round1(o.h * s);
      if (o.type === 'text' && o.size) o.size = G.round1(o.size * s);
      if (o.type === 'puck') for (const ev of o.events || []) {
        if (ev.target) ev.target = { x: tx(ev.target.x), y: ty(ev.target.y) };
        if (ev.bank) ev.bank = { x: tx(ev.bank.x), y: ty(ev.bank.y) };
        if (ev.dist != null && ev.dist !== '') ev.dist = G.round1(+ev.dist * s); // marks are distances along now-shorter paths
      }
      if (o.trigger?.dist != null) o.trigger.dist = G.round1(+o.trigger.dist * s);
    }
  });
}

function doUndo() { finishActive(); if (store.undo()) { sel = null; renderAll(); } }
function doRedo() { if (store.redo()) { sel = null; renderAll(); } }

// ---------- animation ----------
function totalDuration() { return sim ? sim.duration() : 0; }

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
        el.querySelector('.dir')?.setAttribute('transform', `rotate(${(heading * 180 / Math.PI).toFixed(1)})`);
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
      if (el && o.type === 'skater') el.querySelector('.dir')?.setAttribute('transform', `rotate(${(p.heading * 180 / Math.PI).toFixed(1)})`);
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
    if (el) el.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
  }
}

// ---------- voice cues: notes typed on a player's waypoints, spoken aloud as they get there during playback ----------
// A cue lives on the waypoint itself (`pt.cue`, or `startCue` on the player for their start), so it copies,
// nudges and clones with the path and is timed by the same sim clock as passes and triggered starts.
const canSpeak = 'speechSynthesis' in window;
let voiceOn = true;
try { voiceOn = localStorage.getItem('hpp.voice') !== '0'; } catch { /* storage blocked: on */ }
let voicePrimed = false;
const hasCues = dr => dr.objects.some(o => isPlayer(o) && (o.startCue?.trim() || (o.path || []).some(pt => pt.cue?.trim())));
const hasVoice = dr => (canSpeak && hasCues(dr)) || !!dr.intro; // anything the 🔊 toggle would silence
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
function hushVoice() { stopReading(); if (canSpeak) speechSynthesis.cancel(); }

// ----- intro clips: the coach's recorded voice, played before a drill's animation (see js/clips.js) -----
const clipMem = new Map(); // clip key → { url, mime, secs }: clips already fetched this session, ready to play on a tap
const ownerFor = () => store.data.ownerUid || 'local';
/** Fetch a clip into memory: this device's IndexedDB first, then the owner's cloud copy (cached locally for the rink). */
const keyFor = (owner, pid, d) => clipKey(owner, pid, d.id, d.intro?.at);
async function fetchClip(owner, pid, d) {
  const key = keyFor(owner, pid, d), did = d.id;
  if (clipMem.has(key)) return clipMem.get(key);
  let rec = null;
  try { rec = await idbGetClip(key); } catch { rec = null; }
  if (!rec && cloudBackend?.loadClip && cloudSync?.user) {
    try {
      const c = await cloudBackend.loadClip(owner, pid, did);
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
  let done = false;
  const finish = err => { if (done) return; done = true; onEnd(err || null); };
  audio.onended = () => finish();
  audio.onerror = () => finish(`can’t decode ${entry.mime || 'this clip'} on this device`);
  audio.play().catch(e => finish(e?.name === 'NotAllowedError' ? 'the browser blocked audio until you tap again' : (e?.message || 'playback failed')));
  return { stop() { if (done) return; audio.pause(); finish(); }, cancelled: false };
}
let introPlaying = null; // the Drills panel's ▶ Listen preview

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
function setVoice(on) {
  voiceOn = on;
  try { localStorage.setItem('hpp.voice', on ? '1' : '0'); } catch { /* fine */ }
  if (!on) hushVoice();
  for (const b of $$('#anim-voice, .pr-voice')) { b.classList.toggle('active', on); b.textContent = on ? '🔊 voice' : '🔇 muted'; b.title = on ? 'Voice on — click to mute intros and cues' : 'Voice muted on this device — click to hear intros and cues'; }
}
/**
 * Narrator for one playback: step(prev, now) speaks and captions every cue whose second falls in (prev, now].
 * `caption(text)` shows the words on screen too — a rink is loud, and a muted phone still shows the cue.
 */
function makeNarrator(cues, caption) {
  let timer = 0;
  const show = text => { caption(text); clearTimeout(timer); if (text) timer = setTimeout(() => caption(''), 5000); };
  return {
    step(prev, now) { for (const c of cues) if (c.t > prev && c.t <= now) { speak(c.text); show(c.text); } },
    clear() { hushVoice(); show(''); },
  };
}
const cueCaption = $('#cue-caption');
let narrator = makeNarrator([], () => {});

function applyAnimation(t) { animateFrame(drill(), sim, objLayer, fxLayer, t, anim.playing); }

function tick(now) {
  if (!anim.playing) return;
  const dt = Math.min(0.1, (now - anim.last) / 1000);
  anim.last = now;
  const prev = anim.fresh ? -1 : anim.t; // a cue at 0.0 s fires on the first frame of a fresh start
  anim.fresh = false;
  anim.t += dt * drillSpeed();
  const T = totalDuration();
  if (anim.t >= T) { anim.t = T; anim.playing = false; } // park on the final positions — ⏹ sends everyone home
  applyAnimation(anim.t);
  narrator.step(prev, anim.t);
  renderAnimBar();
  if (anim.playing) anim.raf = requestAnimationFrame(tick);
}

function togglePlay() {
  if (isPSDrill(drill())) { psView().toggle(); renderAnimBar(); return; } // power skating mode: ▶ plays the technique elements
  if (returning) cancelReturn();
  if (anim.intro) { cancelIntro(); renderAnimBar(); return; } // ⏸ during the intro skips it and stays parked at the start
  if (anim.playing) { anim.playing = false; cancelAnimationFrame(anim.raf); fxLayer.innerHTML = ''; hushVoice(); }
  else {
    if (totalDuration() <= 0) return;
    primeVoice();
    // Playing is for watching, not editing: drop the selection and finish anything being drawn.
    finishActive();
    if (pickTarget) { pickTarget = null; $('#hint').textContent = HINTS[tool] || ''; }
    if (sel) select(null);
    if (anim.t >= totalDuration()) anim.t = 0;
    const go = () => { anim.fresh = anim.t === 0; anim.playing = true; anim.last = performance.now(); anim.raf = requestAnimationFrame(tick); renderAnimBar(); };
    // From the top with a recorded intro (and voice on): the coach speaks first, then the drill runs.
    const d = drill();
    if (anim.t === 0 && !voiceOn && hasVoice(d)) { cueCaption.textContent = '🔇 voice is muted on this device — click 🔇 muted to hear the intro and cues'; cueCaption.hidden = false; setTimeout(() => { cueCaption.hidden = true; }, 4000); }
    const clip = anim.t === 0 && voiceOn && d.intro ? clipMem.get(keyFor(ownerFor(), store.practice.id, d)) : null;
    if (!clip) { go(); return; }
    if (!canPlay(clip.mime)) { cueCaption.textContent = `🎙 intro can’t play here (${clip.mime})`; cueCaption.hidden = false; setTimeout(() => { cueCaption.hidden = true; }, 4000); go(); return; }
    cueCaption.textContent = '🎙 Coach’s intro…'; cueCaption.hidden = false;
    anim.intro = playClip(clip, { onEnd: err => {
      const skip = anim.intro?.cancelled; anim.intro = null;
      if (err) { cueCaption.textContent = `🎙 intro didn’t play — ${err}`; setTimeout(() => { cueCaption.hidden = true; }, 4000); } else cueCaption.hidden = true;
      if (skip) renderAnimBar(); else go();
    } });
  }
  renderAnimBar();
}
function cancelIntro() { if (anim.intro) { anim.intro.cancelled = true; anim.intro.stop(); } }

/** Immediate reset to the start (used when switching drills, deleting, etc.). */
function stopAnim() {
  if (returning) cancelReturn();
  anim.playing = false; cancelAnimationFrame(anim.raf); anim.t = 0;
  cancelIntro();
  narrator.clear();
  if (psViewInst && isPSDrill(drill())) psViewInst.stop();
  renderCanvas(); renderAnimBar();
}

// ----- the ⏹ button: everyone skates home at 2× speed from wherever they are, then the drill resets -----
let returning = null; // { t0, tr, last, raf } while the skate-home animation runs
function cancelReturn() { cancelAnimationFrame(returning?.raf); returning = null; }
function stopWithReturn() {
  if (isPSDrill(drill())) { stopAnim(); return; }
  if (returning) return; // already skating home
  if (anim.playing) { anim.playing = false; cancelAnimationFrame(anim.raf); fxLayer.innerHTML = ''; }
  if (anim.t <= 0 || !sim || returnTime(drill(), sim, anim.t) <= 0.01) { stopAnim(); return; }
  returning = { t0: anim.t, tr: 0, last: performance.now() };
  $('#time-display').textContent = '↩ skating back';
  const step = now => {
    if (!returning) return;
    returning.tr += Math.min(0.05, (now - returning.last) / 1000);
    returning.last = now;
    if (returning.tr >= returnTime(drill(), sim, returning.t0)) { cancelReturn(); stopAnim(); return; }
    returnFrame(drill(), sim, objLayer, fxLayer, returning.tr, returning.t0);
    returning.raf = requestAnimationFrame(step);
  };
  returning.raf = requestAnimationFrame(step);
}

function renderAnimBar() {
  if (isPSDrill(drill())) { // power skating mode: ▶/⏹ drive the 3D viewer; the timeline doesn't apply
    $('#btn-play').innerHTML = icon(psViewInst?.playing ? 'pause' : 'play');
    $('#btn-play').disabled = !(drill().psElements || []).length;
    $('#timeline').disabled = true;
    $('#time-display').textContent = 'technique demo';
    $('#impact-loser-wrap').hidden = true;
    return;
  }
  $('#timeline').disabled = false;
  const T = totalDuration();
  $('#btn-play').innerHTML = icon(anim.playing || anim.intro ? 'pause' : 'play');
  $('#btn-play').disabled = T <= 0;
  const tl = $('#timeline');
  tl.max = Math.max(T, 0.01); tl.value = Math.min(anim.t, T);
  if (document.activeElement !== $('#anim-speed')) $('#anim-speed').value = String(drillSpeed());
  $('#anim-trails').checked = drillPaths();
  $('#anim-voice').hidden = !hasVoice(drill());
  $('#anim-voice').classList.toggle('active', voiceOn);
  $('#anim-voice').textContent = voiceOn ? '🔊 voice' : '🔇 muted';
  $('#time-display').textContent = returning ? '↩ skating back' : anim.intro ? '🎙 intro…' : `${Math.min(anim.t, T).toFixed(1)} / ${T.toFixed(1)} s`;
  // "worse for" selector: skaters that actually collide — a marker that never resolves into an impact doesn't count
  const impacts = sim ? sim.contacts() : [];
  const linked = [...new Set(impacts.flatMap(c => [c.a, c.b]))]
    .filter(id => getObj(id)?.type === 'skater');
  const el = $('#impact-loser');
  $('#impact-loser-wrap').hidden = !linked.length;
  $('#impact-loser-wrap').title = impacts // hover explains where the impacts driving this selector are
    .map(c => `${playerName(getObj(c.a))} × ${playerName(getObj(c.b))} at ${c.t.toFixed(1)}s (${Math.round(c.x)}, ${Math.round(c.y)} ft)`).join('\n');
  const sig = linked.map(id => { const o = getObj(id); return `${id}:${o.label}:${o.color}`; }).join(',');
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = `<option value="">— even —</option>` + linked.map(id => loserOption(getObj(id), id === drill().impactLoser)).join('');
  }
  if (document.activeElement !== el) el.value = linked.includes(drill().impactLoser) ? drill().impactLoser : '';
}

/** One "Impact: worse for" option: number + colour name, tinted in the skater's colour (readable fallback for light ones). */
function loserOption(o, selected) {
  const hex = skaterHex(o) || '';
  const tint = o.color === 'white' || o.color === 'yellow' ? '' : ` style="color:${escHtml(hex)}"`;
  return `<option value="${o.id}"${tint} ${selected ? 'selected' : ''}>${playerName(o)} (${escHtml(o.color || '')})</option>`;
}

$('#impact-loser').addEventListener('change', e => {
  drill().impactLoser = e.target.value || null;
  store.save();
  e.target.blur();
  renderCanvas();
  renderAnimBar(); // the loser's slowdown changes the drill's total time
});

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-stop').addEventListener('click', stopWithReturn);
$('#timeline').addEventListener('input', e => { anim.t = +e.target.value; if (anim.t === 0) renderCanvas(); else applyAnimation(anim.t); renderAnimBar(); });
$('#timeline').addEventListener('change', e => e.target.blur()); // scrub done → hotkeys work again
$('#anim-speed').addEventListener('change', e => { drill().animSpeed = +e.target.value; store.save(); });
$('#anim-trails').addEventListener('change', e => { drill().showPaths = e.target.checked; store.save(); renderCanvas(); });
$('#anim-voice').addEventListener('click', () => setVoice(!voiceOn));

// ---------- view bar ----------
$$('#viewbar [data-view]').forEach(b => b.addEventListener('click', () => setView(VIEWS[b.dataset.view])));
$('#btn-fit').addEventListener('click', fitAll);
$('#offscreen').addEventListener('click', fitAll);
$('#btn-zoom-in').addEventListener('click', () => { const v = drill().view; zoomAt({ x: v.x + v.w / 2, y: v.y + v.h / 2 }, 1 / 1.25); });
$('#btn-zoom-out').addEventListener('click', () => { const v = drill().view; zoomAt({ x: v.x + v.w / 2, y: v.y + v.h / 2 }, 1.25); });
$('#snap-toggle').addEventListener('change', e => snap = e.target.checked);
$$('#toolbar [data-side]').forEach(b => b.addEventListener('click', () => {
  newSide = b.dataset.side;
  $$('#toolbar [data-side]').forEach(x => x.classList.toggle('active', x === b));
  setTool('skater'); // picking a side implies you're about to place skaters
}));
$$('#toolbar .tool').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.dragged) { delete b.dataset.dragged; return; } // the click that follows a drag-and-drop
  setTool(b.dataset.tool);
}));

// ---------- drag a tool from the toolbar onto the ice ----------
const canvasWrap = $('#canvas-wrap');
const ghost = document.createElement('div');
ghost.id = 'drag-ghost'; ghost.hidden = true;
document.body.appendChild(ghost);
let paletteDrag = null; // { type, btn, sx, sy, active }

function overRink(e) {
  const r = canvasWrap.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

function endPaletteDrag(e) {
  const pd = paletteDrag; paletteDrag = null;
  if (!pd?.active) return; // a plain click — the button's click handler picks the tool
  ghost.hidden = true; ghost.classList.remove('over');
  canvasWrap.classList.remove('drop-target');
  document.body.classList.remove('palette-dragging');
  pd.btn.dataset.dragged = '1';
  setTimeout(() => delete pd.btn.dataset.dragged, 0);
  drawSelection(); // clears the drop preview
  if (e.type !== 'pointerup' || !overRink(e)) return;
  finishActive();
  const o = addObject(makePlaceable(pd.type, snapPt(toRink(e))));
  placed(o.id);
  if (pd.type === 'coach') focusProp('label');
}

$$('#toolbar .tool').forEach(btn => {
  const type = btn.dataset.tool;
  if (!PLACEABLE.has(type)) return;
  btn.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    paletteDrag = { type, btn, sx: e.clientX, sy: e.clientY, active: false };
    btn.setPointerCapture(e.pointerId);
  });
  btn.addEventListener('pointermove', e => {
    if (!paletteDrag || paletteDrag.btn !== btn) return;
    if (!paletteDrag.active) {
      if (Math.hypot(e.clientX - paletteDrag.sx, e.clientY - paletteDrag.sy) < 6) return;
      paletteDrag.active = true;
      ghost.innerHTML = btn.innerHTML; ghost.hidden = false;
      document.body.classList.add('palette-dragging');
    }
    ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`;
    const over = overRink(e);
    ghost.classList.toggle('over', over);
    canvasWrap.classList.toggle('drop-target', over);
    if (over) {
      const o = { id: 'drop-preview', ...makePlaceable(type, snapPt(toRink(e))) };
      overlay.innerHTML = `<g class="drop-preview">${renderObjects({ objects: [o] }, null, {})}</g>`;
    } else drawSelection();
  });
  btn.addEventListener('pointerup', endPaletteDrag);
  btn.addEventListener('pointercancel', endPaletteDrag);
});
$('#btn-undo').addEventListener('click', doUndo);
$('#btn-redo').addEventListener('click', doRedo);

// ---------- practice / plan sidebar ----------
// The practice picker: the last six practices (newest first) with the one that is open marked, its stage and any
// unread coach feedback, and the way to create a new practice — team, date and time first, then it exists.
const PLIST_N = 6;
let plistAll = false;
function renderPracticeSelect() {
  const cur = store.practice;
  $('#plist-current').textContent = practiceLabel(cur) + (openFeedbackFor(cur.id).length ? ` · 💬${openFeedbackFor(cur.id).length}` : '');
  if ($('#plist-pop').hidden) return;
  const all = [...store.data.practices].sort((a, b) => byCalendar(b, a));
  const shown = plistAll ? all : all.slice(0, PLIST_N);
  const stName = { draft: 'draft', coaches: 'with coaches', team: 'released' };
  $('#plist-items').innerHTML = shown.map(p => {
    const st = stageOf(p), fb = openFeedbackFor(p.id).length;
    return `<button class="plist-item${p.id === cur.id ? ' current' : ''}" data-pid="${p.id}" title="${escHtml(practiceLabel(p))}">
      <b>${escHtml(p.team || 'No team')}</b><span class="when">${escHtml(whenLabel(p))}</span>
      ${fb ? `<span class="fb">💬${fb}</span>` : ''}<span class="st ${st}">${stName[st]}</span></button>`;
  }).join('');
  const more = $('#plist-more');
  more.hidden = all.length <= PLIST_N;
  more.textContent = plistAll ? `Show the last ${PLIST_N} only` : `Show all ${all.length} practices…`;
}
$('#plist-items').addEventListener('click', e => {
  const b = e.target.closest('.plist-item'); if (!b) return;
  finishActive(); store.switchPractice(b.dataset.pid); sel = null; stopAnim();
  $('#plist-pop').hidden = true; renderAll();
});
$('#plist-more').addEventListener('click', () => { plistAll = !plistAll; renderPracticeSelect(); });
$('#plist-create').addEventListener('click', () => {
  const f = $('#plist-form'), teams = store.roster.teams.map(t => t.name || '').filter(Boolean);
  if (!teams.length) { $('#plist-pop').hidden = true; alert('Add a team under 👥 Team first — a practice belongs to a team, and the roster is who gets it.'); openTeamMgr(); return; }
  const cur = store.practice.team || '';
  $('#new-team').innerHTML = teams.map(n => `<option value="${escHtml(n)}"${n.toLowerCase() === cur.toLowerCase() ? ' selected' : ''}>${escHtml(n)}</option>`).join('');
  $('#new-date').value = todayISO(); $('#new-time').value = store.practice.time || '';
  f.hidden = false; $('#plist-create').hidden = true;
  $('#new-date').focus();
});
$('#plist-cancel').addEventListener('click', () => { $('#plist-form').hidden = true; $('#plist-create').hidden = false; });
$('#plist-form').addEventListener('submit', e => {
  e.preventDefault();
  const team = $('#new-team').value, date = $('#new-date').value, time = $('#new-time').value;
  if (!team || !date || !time) return; // `required` — the browser has already said which
  finishActive();
  const p = newPractice(team); p.date = date; p.time = time;
  store.addPractice(p);
  sel = null; stopAnim();
  $('#plist-form').hidden = true; $('#plist-create').hidden = false; $('#plist-pop').hidden = true;
  renderAll();
});
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PRACTICE_FIELDS = [['#practice-team', 'team'], ['#practice-date', 'date'], ['#practice-time', 'time'], ['#practice-coaches', 'coaches']];
function renderPracticeProps() {
  const p = store.practice;
  for (const [id, key] of PRACTICE_FIELDS) {
    const el = $(id);
    if (el.tagName === 'SELECT') renderTeamSelect();
    else if (document.activeElement !== el) el.value = p[key] || '';
  }
  for (const [id, key] of SHARE_FIELDS) {
    const em = $(id);
    if (document.activeElement !== em) em.value = (p[key] || []).join(', ');
  }
  renderStage();
}
/** Draft → out to coaches → released to the team: only these buttons release a practice; the roster says to whom. */
function renderStage() {
  const p = store.practice, st = stageOf(p), a = accessFor(store.roster, p), t = rosterTeamFor(store.roster, p);
  const since = ms => ms ? ` since ${stamp(ms)}` : '';
  $('#stage-now').textContent = STAGE_LABELS[st] + (st === 'coaches' ? since(p.sentCoachesAt) : st === 'team' ? since(p.sentTeamAt) : '');
  $('#stage-now').dataset.stage = st;
  $('#btn-stage-next').hidden = st === 'team';
  $('#btn-stage-next').textContent = st === 'draft' ? 'Send to coaches →' : 'Release to team →';
  $('#btn-stage-back').hidden = st === 'draft';
  $('#btn-stage-back').textContent = st === 'team' ? '← Pull back from team' : '← Pull back to draft';
  $('#stage-who').textContent = `${a.coach.length} coach${a.coach.length === 1 ? '' : 'es'} · ${a.team.length} family email${a.team.length === 1 ? '' : 's'}`
    + (t ? ` — the “${t.name || 'unnamed'}” roster (👥 Team) plus any extras below.` : ' — no team roster yet: add people under 👥 Team.');
}
function setStage(next) {
  const p = store.practice, a = accessFor(store.roster, p), st = stageOf(p);
  if (next === st) return;
  const up = STAGES.indexOf(next) > STAGES.indexOf(st);
  if (up && !cloudSync?.user) return alert('Sign in first — a released practice is read from your cloud account.');
  const msg = next === 'coaches' && up ? `Send this practice to ${a.coach.length} coach${a.coach.length === 1 ? '' : 'es'} for feedback?${a.coach.length ? '' : '\n\nThere are no coaches on the roster yet — add them under 👥 Team.'}`
    : next === 'team' ? `Release this practice to the team (${a.team.length} family email${a.team.length === 1 ? '' : 's'})? Coaches keep their access.`
    : next === 'coaches' ? 'Pull this practice back from the team? Families lose access right away; coaches keep theirs.'
    : 'Pull this practice back to a draft? Coaches lose access right away.';
  if (!confirm(msg)) return;
  commit(() => {
    p.stage = next;
    if (next === 'coaches' && up) p.sentCoachesAt = Date.now();
    if (next === 'team') p.sentTeamAt = Date.now();
  });
}
$('#btn-stage-next').addEventListener('click', () => setStage(STAGES[STAGES.indexOf(stageOf(store.practice)) + 1]));
$('#btn-stage-back').addEventListener('click', () => setStage(STAGES[STAGES.indexOf(stageOf(store.practice)) - 1]));
// Extra people beyond the roster (a guest coach, a one-off skater): they get what the practice's stage gives their audience.
const SHARE_FIELDS = [['#practice-emails', 'sharedWith'], ['#practice-team-emails', 'sharedTeam']];
for (const [id, key] of PRACTICE_FIELDS) {
  const el = $(id);
  el.addEventListener('focus', () => store.beginPending());
  el.addEventListener('input', () => { if (el.value === MANAGE_TEAMS) return; store.practice[key] = el.value; store.save(); renderPracticeSelect(); });
  el.addEventListener('change', () => {
    if (el.value === MANAGE_TEAMS) { el.value = store.practice.team || ''; $('#practice-pop').hidden = true; openTeamMgr(); return; }
    store.commitPending(); renderUI();
  });
}
// The team is picked from the roster (👥 Team), never typed: the roster is what decides who can open the practice.
const MANAGE_TEAMS = '__manage-teams__';
function renderTeamSelect() {
  const el = $('#practice-team'), cur = store.practice.team || '';
  const teams = store.roster.teams.map(t => t.name || '').filter(Boolean);
  const known = teams.some(n => n.toLowerCase() === cur.toLowerCase());
  el.innerHTML = [
    !cur ? `<option value="">${teams.length ? '— pick a team —' : '— no teams yet —'}</option>` : '',
    ...teams.map(n => `<option value="${escHtml(n)}"${known && n.toLowerCase() === cur.toLowerCase() ? ' selected' : ''}>${escHtml(n)}</option>`),
    cur && !known ? `<option value="${escHtml(cur)}" selected>${escHtml(cur)} (not on the roster)</option>` : '',
    `<option value="${MANAGE_TEAMS}">＋ Manage teams…</option>`,
  ].join('');
  if (known) el.value = teams.find(n => n.toLowerCase() === cur.toLowerCase());
}
for (const [id, key] of SHARE_FIELDS) { // stored as lowercased arrays — these people may open the practice
  const el = $(id);
  el.addEventListener('focus', () => store.beginPending());
  el.addEventListener('input', () => { store.practice[key] = el.value.split(/[\s,;]+/).filter(Boolean).map(s => s.toLowerCase()); store.save(); });
  el.addEventListener('change', () => { store.commitPending(); renderUI(); });
}

// Drills pane pin: unpinned, the pane collapses to its header and Selection fills the sidebar.
const PLAN_PIN_KEY = 'hpp.ui.planPinned';
function applyPlanPin() {
  let pinned = true;
  try { pinned = localStorage.getItem(PLAN_PIN_KEY) !== '0'; } catch { /* storage blocked: stay pinned */ }
  $('#sidebar').classList.toggle('plan-unpinned', !pinned);
  const b = $('#plan-pin');
  b.textContent = pinned ? '📌' : '📍';
  b.title = pinned ? 'Unpin the drills pane — collapse it so Selection gets the space' : 'Pin the drills pane open';
}
$('#plan-pin').addEventListener('click', () => {
  try { localStorage.setItem(PLAN_PIN_KEY, localStorage.getItem(PLAN_PIN_KEY) !== '0' ? '0' : '1'); } catch { }
  applyPlanPin();
});
applyPlanPin();

// ---------- team manager: coaches (with emails) and players (with family contacts), per team ----------
let teamSelId = null; // team open in the manager

function currentMgrTeam() {
  const teams = store.roster.teams;
  return teams.find(t => t.id === teamSelId)
    || teams.find(t => (t.name || '').toLowerCase() === (store.practice.team || '').toLowerCase())
    || teams[0] || null;
}

function openTeamMgr() {
  finishActive();
  if (!store.roster.teams.length) {
    store.roster.teams.push({ id: uid(), name: store.practice.team || 'My team', coaches: [], players: [] });
    store.saveRoster();
  }
  teamSelId = currentMgrTeam()?.id || null;
  $('#teammgr').hidden = false;
  renderTeamMgr();
}
function closeTeamMgr() { $('#teammgr').hidden = true; renderUI(); } // the team picker and stage box follow the roster

function renderTeamMgr() {
  const t = currentMgrTeam();
  teamSelId = t?.id || null;
  $('#team-select').innerHTML = store.roster.teams.map(x => `<option value="${x.id}" ${x.id === teamSelId ? 'selected' : ''}>${escHtml(x.name || 'unnamed')}</option>`).join('');
  const body = $('#team-body');
  if (!t) { body.innerHTML = '<p class="muted">No team yet — add one with ＋ Team.</p>'; return; }
  const coachRows = t.coaches.map(c => `
    <div class="ros-row" data-cid="${c.id}">
      <input placeholder="Coach name" data-field="name" value="${escHtml(c.name || '')}">
      <input placeholder="email@…" data-field="email" value="${escHtml(c.email || '')}" spellcheck="false">
      <button data-act="delcoach" title="Remove coach">${icon('x')}</button>
    </div>`).join('');
  const playerBlocks = t.players.map(p => `
    <div class="ros-player" data-pid="${p.id}">
      <div class="ros-row">
        <input placeholder="Player name" data-field="name" value="${escHtml(p.name || '')}">
        <button data-act="addcontact" title="Add a parent / grandparent contact">＋ contact</button>
        <button data-act="delplayer" title="Remove player">${icon('x')}</button>
      </div>
      ${(p.contacts || []).map(k => `
      <div class="ros-row ros-contact" data-kid="${k.id}">
        <input class="ros-rel" placeholder="mom / grandpa …" data-field="rel" value="${escHtml(k.rel || '')}">
        <input placeholder="Contact name" data-field="name" value="${escHtml(k.name || '')}">
        <input placeholder="email@…" data-field="email" value="${escHtml(k.email || '')}" spellcheck="false">
        <button data-act="delcontact" title="Remove contact">${icon('x')}</button>
      </div>`).join('')}
    </div>`).join('');
  // People on no roster who asked to be let in: approving puts them on this team's roster — which is what grants access.
  const reqRows = openRequests().map(r => `
    <div class="req-row" data-ruid="${escHtml(r.uid)}">
      <div><b>${escHtml(r.name || r.email)}</b> <span class="muted small">${escHtml(r.email)} · asks to join as ${r.role === 'coach' ? 'a coach' : 'family'}${r.note ? ` · “${escHtml(r.note)}”` : ''}</span></div>
      <div class="row">
        <button data-act="req-coach">Approve as coach</button>
        <select class="req-player" title="Whose family?">${t.players.map(pl => `<option value="${pl.id}">${escHtml(pl.name || 'unnamed player')}</option>`).join('')}<option value="">＋ new player</option></select>
        <button data-act="req-family">Approve as family</button>
        <button data-act="req-deny" class="danger">Deny</button>
      </div>
    </div>`).join('');
  body.innerHTML = `
    ${reqRows ? `<h3>Access requests</h3>${reqRows}` : ''}
    <label class="field inline ros-team-name"><span>Team name</span><input data-field="teamname" value="${escHtml(t.name || '')}"></label>
    <h3>Coaches</h3>
    ${coachRows || '<p class="muted small">No coaches yet.</p>'}
    <div class="row"><button data-act="addcoach">＋ Add coach</button></div>
    <h3>Players &amp; family contacts</h3>
    ${playerBlocks || '<p class="muted small">No players yet.</p>'}
    <div class="row"><button data-act="addplayer">＋ Add player</button></div>`;
}

$('#btn-team').addEventListener('click', openTeamMgr);
$('#team-close').addEventListener('click', closeTeamMgr);
$('#team-select').addEventListener('change', e => { teamSelId = e.target.value; renderTeamMgr(); });
$('#team-add').addEventListener('click', () => {
  const t = { id: uid(), name: 'New team', coaches: [], players: [] };
  store.roster.teams.push(t);
  teamSelId = t.id;
  store.saveRoster(); renderTeamMgr();
  const el = $('#team-body input[data-field="teamname"]'); if (el) { el.focus(); el.select(); }
});
$('#team-del').addEventListener('click', () => {
  const t = currentMgrTeam(); if (!t) return;
  if (!confirm(`Delete team "${t.name || 'unnamed'}" and its roster? This cannot be undone.`)) return;
  store.roster.teams = store.roster.teams.filter(x => x.id !== t.id);
  teamSelId = null;
  store.saveRoster(); renderTeamMgr();
});
$('#team-body').addEventListener('input', e => {
  const el = e.target; const t = currentMgrTeam();
  if (!t || !el.dataset.field) return;
  if (el.dataset.field === 'teamname') { renameFrom ??= t.name; t.name = el.value; store.saveRoster(); return; }
  const row = el.closest('[data-cid],[data-kid],[data-pid]');
  if (!row) return;
  const obj = row.dataset.cid ? t.coaches.find(c => c.id === row.dataset.cid)
    : row.dataset.kid ? t.players.flatMap(p => p.contacts || []).find(k => k.id === row.dataset.kid)
    : t.players.find(p => p.id === row.dataset.pid);
  if (!obj) return;
  obj[el.dataset.field] = el.value;
  store.saveRoster();
});
let renameFrom = null; // a roster team's name before the current edit: its practices are renamed with it
$('#team-body').addEventListener('change', e => {
  if (e.target.dataset.field !== 'teamname') return;
  const from = renameFrom, to = e.target.value.trim(); renameFrom = null;
  if (from && to && from.trim().toLowerCase() !== to.toLowerCase()) {
    for (const p of store.data.practices) if ((p.team || '').trim().toLowerCase() === from.trim().toLowerCase()) { p.team = to; p.updatedAt = Date.now(); store.onSave?.(p); }
    store.persist();
  }
  renderTeamMgr(); // the team select shows the new name
});
$('#team-body').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn?.dataset.act) return;
  const t = currentMgrTeam(); if (!t) return;
  const player = t.players.find(p => p.id === btn.closest('[data-pid]')?.dataset.pid);
  const reqRow = btn.closest('[data-ruid]'), req = reqRow && accessRequests.find(r => r.uid === reqRow.dataset.ruid);
  const settle = (fn, r) => fn(r.uid).catch(e => alert(`Couldn't update the request: ${e?.message || e}`));
  switch (btn.dataset.act) {
    case 'req-coach': if (!req) return; t.coaches.push({ id: uid(), name: req.name || '', email: req.email }); settle(cloudBackend.removeRequest, req); break;
    case 'req-family': {
      if (!req) return;
      let pl = t.players.find(x => x.id === reqRow.querySelector('.req-player').value);
      if (!pl) { pl = { id: uid(), name: '', contacts: [] }; t.players.push(pl); }
      (pl.contacts ||= []).push({ id: uid(), rel: '', name: req.name || '', email: req.email });
      settle(cloudBackend.removeRequest, req); break;
    }
    case 'req-deny': if (req) settle(cloudBackend.denyRequest, req); return;
    case 'addcoach': t.coaches.push({ id: uid(), name: '', email: '' }); break;
    case 'delcoach': t.coaches = t.coaches.filter(c => c.id !== btn.closest('[data-cid]').dataset.cid); break;
    case 'addplayer': t.players.push({ id: uid(), name: '', contacts: [] }); break;
    case 'delplayer': if (!player) return; t.players = t.players.filter(p => p !== player); break;
    case 'addcontact': if (!player) return; (player.contacts ||= []).push({ id: uid(), rel: '', name: '', email: '' }); break;
    case 'delcontact': if (!player) return; player.contacts = (player.contacts || []).filter(k => k.id !== btn.closest('[data-kid]').dataset.kid); break;
    default: return;
  }
  store.saveRoster(); renderTeamMgr();
});
// ---------- coach feedback, as the planner reads it ----------
function openFeedbackPanel() { finishActive(); $('#practice-pop').hidden = true; $('#feedback').hidden = false; renderFeedback(); }
function renderFeedback() {
  const p = store.practice;
  $('#feedback-title').textContent = practiceLabel(p);
  const rows = feedbackAll.filter(f => f.pid === p.id);
  const item = f => `<div class="fb-item${f.resolved ? ' resolved' : ''}" data-fid="${escHtml(f.fid)}">
      <div class="fb-meta"><b>${escHtml(f.name || f.email)}</b> <span class="muted small">${escHtml(f.email)} · ${stamp(f.at || 0)}</span></div>
      <pre>${escHtml(f.text)}</pre>
      <div class="row"><button data-fact="resolve">${f.resolved ? '↺ Reopen' : '✓ Resolve'}</button></div>
    </div>`;
  const groups = [...p.drills.map((d, i) => ({ title: `${i + 1}. ${d.name}`, did: d.id, rows: rows.filter(f => f.drillId === d.id) })),
    { title: 'Overall', did: null, rows: rows.filter(f => !p.drills.some(d => d.id === f.drillId)) }].filter(g => g.rows.length);
  $('#feedback-body').innerHTML = groups.length ? groups.map(g => `<section class="fb-group">
      <h3>${escHtml(g.title)}${g.did ? ` <button data-fact="goto" data-did="${g.did}">Open drill</button>` : ''}</h3>
      ${g.rows.sort((a, b) => (a.resolved ? 1 : 0) - (b.resolved ? 1 : 0) || (b.at || 0) - (a.at || 0)).map(item).join('')}</section>`).join('')
    : `<p class="vl-empty">No feedback on this practice yet.${stageOf(p) === 'draft' ? ' It is still a draft — send it to the coaches from + Practice.' : ''}</p>`;
}
$('#btn-feedback').addEventListener('click', openFeedbackPanel);
$('#feedback-close').addEventListener('click', () => { $('#feedback').hidden = true; });
$('#feedback-body').addEventListener('click', async e => {
  const b = e.target.closest('button[data-fact]'); if (!b) return;
  if (b.dataset.fact === 'goto') {
    const i = store.practice.drills.findIndex(d => d.id === b.dataset.did);
    if (i >= 0) { store.drillIndex = i; sel = null; stopAnim(); $('#feedback').hidden = true; renderAll(); }
    return;
  }
  const f = feedbackAll.find(x => x.pid === store.practice.id && x.fid === b.closest('[data-fid]').dataset.fid); if (!f) return;
  try { await cloudBackend.resolveFeedback(f.pid, f.fid, !f.resolved); } catch (err) { alert(`Couldn't update: ${err?.message || err}`); }
});

let notesOpenFor = null;  // drill id whose notes editor is expanded in the list
let editingDrill = null;  // drill id being renamed inline (explicit edit mode: ✎ → save/cancel)

/** Put a clip in the cloud beside its practice. Resolves { ok, error? }; ok is false when signed out or refused. */
async function uploadClip(pid, did, { mime, blob, secs }) {
  if (!cloudBackend?.saveClip) return { ok: false, error: 'local-only (no cloud configured)' };
  if (!cloudSync?.user) return { ok: false, error: 'not signed in' };
  try { await cloudBackend.saveClip(ownerFor(), pid, did, { mime, data: await blobToBase64(blob), secs, at: Date.now() }); return { ok: true }; }
  catch (e) { return { ok: false, error: e?.message || String(e) }; }
}
/** After sign-in: any clip recorded while offline or refused by the rules is uploaded from this device's copy. */
async function uploadPendingIntros() {
  if (!cloudBackend?.saveClip || !cloudSync?.user) return;
  for (const p of store.data.practices) for (const d of p.drills) {
    if (!d.intro || d.intro.cloud === true) continue;
    let rec = null;
    try { rec = await idbGetClip(keyFor(ownerFor(), p.id, d)); } catch { rec = null; }
    if (!rec?.blob) continue; // recorded on another device: nothing here to send
    const up = await uploadClip(p.id, d.id, rec);
    if (up.ok) { d.intro = { ...d.intro, cloud: true }; delete d.intro.cloudError; store.save(); }
  }
  renderPlan();
}
const cloudHint = err => /permission|insufficient/i.test(err || '') ? ' — deploy the latest firestore.rules, then Upload now' : '';
let videoOpenFor = null; // drill whose 🎬 video row is open in the Drills panel
let vidPending = null;   // a dropped file being prepared: { drillId, file, url, duration, width, height, audio, vo, voSecs, voRec, encoding, error }
const fmtSecs = t => Number.isFinite(+t) ? `${Math.floor(+t / 60)}:${String(Math.round(+t % 60)).padStart(2, '0')}` : '?:??';
/** The span a staged video will keep: [start, end) clipped to the file and to the MAX_VIDEO_SECS cap. */
function trimSpan(vp) {
  const dur = Number.isFinite(vp.duration) ? vp.duration : Infinity;
  const start = Math.min(Math.max(0, +vp.start || 0), Number.isFinite(dur) ? Math.max(0, dur - 0.5) : Infinity);
  const end = Math.min(Number.isFinite(vp.end) ? vp.end : dur, dur);
  return { start, end: Math.max(start + 0.5, end) };
}
function trimSummary(vp) {
  const { start, end } = trimSpan(vp);
  const keep = Number.isFinite(end) ? end - start : NaN;
  const kept = Number.isFinite(keep) ? Math.min(keep, MAX_VIDEO_SECS) : NaN;
  const trimmed = Number.isFinite(vp.duration) && Number.isFinite(keep) && keep < vp.duration - 0.05;
  return `${trimmed ? `Keeps ${fmtSecs(kept)} of ${fmtSecs(vp.duration)}` : fmtSecs(vp.duration)}${Number.isFinite(keep) && keep > MAX_VIDEO_SECS ? ` — capped at ${MAX_VIDEO_SECS} s` : ''} · ${vp.width}×${vp.height} → ${Math.min(vp.width, VIDEO_MAX_WIDTH)} px wide${Number.isFinite(kept) ? `, about ${(kept * 0.095).toFixed(1)} MB` : ''}`;
}
const videoKey = (owner, pid, d) => clipKey(`video:${owner}`, pid, d.id, d.upload?.at);
/** A dropped or chosen file becomes the row's preview, ready to encode. */
async function stageVideoFile(d, file) {
  if (!file) return;
  if (vidPending?.url) URL.revokeObjectURL(vidPending.url);
  if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) { vidPending = { drillId: d.id, error: `${file.name} isn’t a video file — drop an .mp4, .mov or .webm` }; }
  else {
    try { vidPending = { drillId: d.id, file, ...(await probeVideoFile(file)), audio: 'keep', vo: null }; }
    catch (e) { vidPending = { drillId: d.id, error: e?.message || String(e) }; }
  }
  videoOpenFor = d.id; introOpenFor = null; notesOpenFor = null;
  unfocusList(); // the list won't rebuild under a focused input (the link box has focus after opening the row)
  renderPlan();
}
function stopDubPreview(vp, preview) {
  vp.previewing = false;
  if (vp.dubAudio) { vp.dubAudio.pause(); URL.revokeObjectURL(vp.dubAudio.src); vp.dubAudio = null; }
  if (preview) { preview.onended = null; preview.ontimeupdate = null; preview.onpause = null; preview.pause(); preview.muted = false; }
}
const unfocusList = () => { if (document.activeElement?.closest('#drill-list')) document.activeElement.blur(); };
/** Fetch an uploaded video into memory (IndexedDB first, then the chunk documents in the cloud, cached for next time). */
async function fetchUpload(owner, pid, d, onChunk = () => {}) {
  if (!d.upload) return null;
  const key = videoKey(owner, pid, d);
  if (clipMem.has(key)) return clipMem.get(key);
  let rec = null;
  try { rec = await idbGetClip(key); } catch { rec = null; }
  if (!rec && cloudBackend?.loadVideo && cloudSync?.user) {
    try {
      const chunks = await cloudBackend.loadVideo(owner, pid, d.id, d.upload.at, d.upload.chunks, onChunk);
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
async function uploadVideo(pid, d, blob, meta, at) {
  if (!cloudBackend?.saveVideo) return { ok: false, error: 'local-only (no cloud configured)' };
  if (!cloudSync?.user) return { ok: false, error: 'not signed in' };
  try { await cloudBackend.saveVideo(ownerFor(), pid, d.id, at, await blobToChunks(blob), meta); return { ok: true }; }
  catch (e) { return { ok: false, error: e?.message || String(e) }; }
}
async function videoAction(act, li) {
  const d = store.practice.drills.find(x => x.id === videoOpenFor); if (!d) return;
  unfocusList();
  const pid = store.practice.id;
  const vp = vidPending?.drillId === d.id ? vidPending : null;
  if (act === 'pick') { li.querySelector('.vid-file')?.click(); return; }
  if ((act === 'setstart' || act === 'setend') && vp) {
    const t = li.querySelector('.vid-preview')?.currentTime || 0;
    if (act === 'setstart') { vp.start = Math.round(t * 10) / 10; if (Number.isFinite(vp.end) && vp.end <= vp.start + 0.5) vp.end = NaN; }
    else { vp.end = Math.round(t * 10) / 10; if (vp.end <= (+vp.start || 0) + 0.5) vp.start = Math.max(0, vp.end - 0.5); }
    renderPlan(); return;
  }
  if (vp?.previewing && act !== 'vopreview') stopDubPreview(vp, li.querySelector('.vid-preview'));
  if (act === 'cancel') { if (vp?.voRec) { try { await vp.voRec.stop(); } catch { /* fine */ } } if (vp?.url) URL.revokeObjectURL(vp.url); vidPending = null; renderPlan(); return; }
  if (act === 'vorec' && vp) { // talk over the video: it plays silently from the top while the mic records
    try { vp.voRec = await startRecording({ maxSecs: MAX_VIDEO_SECS + 1 }); } catch (e) { vp.error = `Microphone not available: ${e?.message || e}`; renderPlan(); return; }
    renderPlan(); // the row now shows ■ Stop — play the (re-drawn) preview silently from the top
    const preview = $('#drill-list .vid-preview'); if (!preview) return;
    const span = trimSpan(vp);
    preview.muted = true; preview.currentTime = span.start;
    preview.onended = () => videoAction('vostop', $('#drill-list .video-editor'));
    preview.ontimeupdate = () => { if (preview.currentTime >= span.end) { preview.ontimeupdate = null; videoAction('vostop', $('#drill-list .video-editor')); } };
    preview.play().catch(() => {});
    return;
  }
  if (act === 'vopreview' && vp?.vo) { // hear the dub before encoding: the muted video and the recording run together from the in point
    const preview = li.querySelector('.vid-preview'); if (!preview) return;
    if (vp.previewing) { stopDubPreview(vp, preview); renderPlan(); return; }
    const span = trimSpan(vp);
    vp.dubAudio = new Audio(URL.createObjectURL(vp.vo));
    vp.previewing = true;
    renderPlan();
    const pv = $('#drill-list .vid-preview'); if (!pv) return;
    pv.muted = true; pv.currentTime = span.start;
    const stop = () => { stopDubPreview(vp, pv); renderPlan(); };
    pv.onended = stop;
    pv.ontimeupdate = () => { if (pv.currentTime >= span.end) stop(); };
    pv.onpause = () => { if (vp.previewing && !pv.ended && pv.currentTime < span.end) stop(); }; // the user pressed pause on the player
    await pv.play().catch(() => {});
    vp.dubAudio.play().catch(() => {});
    return;
  }
  if (act === 'vostop' && vp?.voRec) {
    const r = vp.voRec; vp.voRec = null;
    const preview = $('#drill-list .vid-preview'); if (preview) { preview.pause(); preview.onended = null; preview.ontimeupdate = null; preview.muted = false; }
    const { blob, secs } = await r.stop();
    if (blob.size && secs >= 0.5) { vp.vo = blob; vp.voSecs = secs; vp.audio = 'vo'; }
    renderPlan();
    return;
  }
  if (act === 'encode' && vp && !vp.encoding) {
    vp.encoding = true; renderPlan();
    const progress = msg => { const el = $('#drill-list .vid-progress'); if (el) el.textContent = msg; };
    try {
      const span = trimSpan(vp);
      const out = await transcodeVideo(vp.file, { voiceover: vp.audio === 'vo' ? vp.vo : null, start: span.start, end: Number.isFinite(span.end) ? span.end : null, onProgress: (t, total) => progress(`Encoding… ${t.toFixed(0)} / ${total.toFixed(0)} s`) });
      const at = Date.now();
      const meta = { mime: out.mime, secs: out.secs, size: out.blob.size, width: out.width, height: out.height };
      try { await idbPutClip(clipKey(`video:${ownerFor()}`, pid, d.id, at), { mime: out.mime, blob: out.blob, secs: out.secs }); } catch { /* the cloud copy still serves this device */ }
      progress(`Uploading ${(out.blob.size / 1048576).toFixed(1)} MB…`);
      const up = await uploadVideo(pid, d, out.blob, meta, at);
      const old = d.upload;
      if (old?.cloud && cloudBackend?.removeVideo && cloudSync?.user) cloudBackend.removeVideo(ownerFor(), pid, d.id, old.at, old.chunks).catch(() => {});
      if (old) { const k = videoKey(ownerFor(), pid, d); forgetClip(k); idbDelClip(k).catch(() => {}); }
      commit(() => { d.upload = { at, ...meta, chunks: Math.ceil(out.blob.size / 700_000), cloud: up.ok, ...(up.error ? { cloudError: up.error } : {}) }; });
      if (vp.url) URL.revokeObjectURL(vp.url);
      vidPending = null;
    } catch (e) { vp.encoding = false; vp.error = `Encoding failed: ${e?.message || e}`; }
    renderPlan();
    return;
  }
  if (act === 'upload' && d.upload) { // retry the cloud copy from this device's encoded file
    const status = msg => { const el = li.querySelector('.vid-progress') || li.querySelector('.intro-status'); if (el) el.textContent = msg; };
    let rec = null; try { rec = await idbGetClip(videoKey(ownerFor(), pid, d)); } catch { rec = null; }
    if (!rec?.blob) { status('No encoded copy on this device — drop the file in again.'); return; }
    status('Uploading…');
    const up = await uploadVideo(pid, d, rec.blob, { mime: d.upload.mime, secs: d.upload.secs, size: d.upload.size, width: d.upload.width, height: d.upload.height }, d.upload.at);
    commit(() => { d.upload = { ...d.upload, cloud: up.ok }; if (up.error) d.upload.cloudError = up.error; else delete d.upload.cloudError; });
    renderPlan(); return;
  }
  if (act === 'play' && d.upload) {
    const box = li.querySelector('.vid-player'); if (!box) return;
    box.innerHTML = '<span class="muted small">Loading…</span>';
    const entry = await fetchUpload(ownerFor(), pid, d, (i, n) => { box.textContent = `Downloading ${i} / ${n}…`; });
    box.innerHTML = entry ? `<video src="${entry.url}" controls playsinline autoplay></video>` : '<span class="warn small">No copy of this video is available here.</span>';
    return;
  }
  if (act === 'del' && d.upload) {
    const old = d.upload;
    if (old.cloud && cloudBackend?.removeVideo && cloudSync?.user) cloudBackend.removeVideo(ownerFor(), pid, d.id, old.at, old.chunks).catch(() => {});
    const k = videoKey(ownerFor(), pid, d); forgetClip(k); idbDelClip(k).catch(() => {});
    commit(() => { delete d.upload; });
    renderPlan();
  }
}
let introOpenFor = null; // drill whose 🎙 recorder is open in the Drills panel
let introRec = null;      // an in-progress recording: { drillId, stop(), since, timer }
/** The recorder row's buttons: record / stop / listen / delete a drill's intro clip. */
async function introAction(iact, li) {
  const d = store.practice.drills.find(x => x.id === introOpenFor); if (!d) return;
  const pid = store.practice.id, key = keyFor(ownerFor(), pid, d); // the current recording's copy on this device
  const status = msg => { const el = $('#drill-list .intro-status'); if (el) el.textContent = msg; };
  if (iact === 'rec') {
    if (introRec) return;
    try { introRec = await startRecording({ maxSecs: 90 }); }
    catch (e) { status(`Microphone not available: ${e?.message || e}`); return; }
    introRec.drillId = d.id;
    renderPlan();
    introRec.timer = setInterval(() => {
      const t = (performance.now() - introRec.since) / 1000;
      const b = $('#drill-list [data-iact="stop"]'); if (b) b.textContent = `■ Stop (${t.toFixed(0)} s)`;
      if (t >= 90) introAction('stop', li);
    }, 500);
  } else if (iact === 'stop') {
    if (!introRec) return;
    const r = introRec; introRec = null; clearInterval(r.timer);
    const { blob, mime, secs } = await r.stop();
    if (!blob.size || secs < 0.5) { renderPlan(); status('Nothing recorded.'); return; }
    const at = Date.now(); // this recording's version: keys its copies everywhere, so devices holding the old one refetch
    forgetClip(key); idbDelClip(key).catch(() => {});
    const newKey = clipKey(ownerFor(), pid, d.id, at);
    try { await idbPutClip(newKey, { mime, blob, secs }); } catch { /* the cloud copy still serves this device */ }
    const up = await uploadClip(pid, d.id, { mime, blob, secs });
    commit(() => { d.intro = { secs, mime, size: blob.size, at, cloud: up.ok, ...(up.error ? { cloudError: up.error } : {}) }; });
    fetchClip(ownerFor(), pid, d);
    renderPlan();
  } else if (iact === 'upload') { // retry the cloud copy from this device's recording
    status('Uploading…');
    let rec = null;
    try { rec = await idbGetClip(key); } catch { rec = null; }
    if (!rec?.blob) { status('No recording on this device to upload — record it again here.'); return; }
    const up = await uploadClip(pid, d.id, rec);
    commit(() => { d.intro = { ...d.intro, cloud: up.ok }; if (up.error) d.intro.cloudError = up.error; else delete d.intro.cloudError; });
    renderPlan();
  } else if (iact === 'play') {
    if (introPlaying) { introPlaying.stop(); return; }
    const entry = await fetchClip(ownerFor(), pid, d);
    if (!entry) { status('No clip available on this device.'); return; }
    introPlaying = playClip(entry, { onEnd: () => { introPlaying = null; renderPlan(); } });
    introPlaying.drillId = d.id;
    renderPlan();
  } else if (iact === 'del') {
    forgetClip(key);
    idbDelClip(key).catch(() => {});
    if (cloudBackend?.removeClip && cloudSync?.user) cloudBackend.removeClip(ownerFor(), pid, d.id).catch(() => {});
    commit(() => { delete d.intro; });
    renderPlan();
  }
}
function renderPlan() {
  const p = store.practice;
  const total = activeDrills(p).reduce((a, d) => a + (+d.duration || 0), 0);
  const hiddenCount = p.drills.length - activeDrills(p).length;
  const startMin = parseStart(p);
  $('#plan-total').textContent = `${total} min total${startMin != null ? ` · ${clockFull(startMin)}–${clockFull(startMin + total)}` : ''}${hiddenCount ? ` · ${hiddenCount} hidden` : ''}`;
  $('#plan-total').title = startMin != null ? 'Set the start time in + Practice to change the clock' : 'Set a start time in + Practice to see clock times on each drill';
  // running time: where each (unhidden) drill starts — as a clock time when the practice has one, else minutes in
  let running = 0;
  const startOf = new Map();
  for (const d of p.drills) { if (d.hidden) continue; startOf.set(d.id, running); running += +d.duration || 0; }
  const when = d => {
    if (d.hidden) return 'hidden';
    const at = startOf.get(d.id);
    return `${+d.duration || 0} min · ${startMin != null ? `${clock(startMin + at)}–${clockFull(startMin + at + (+d.duration || 0))}` : `${at === 0 ? 'starts' : `+${at} min`}`}`;
  };
  const fbCount = d => feedbackAll.filter(f => f.pid === p.id && f.drillId === d.id && !f.resolved).length;
  const list = $('#drill-list');
  // Someone typing in the list must not have their field rebuilt under them — but a focused radio, checkbox
  // or button is no reason to hold back (a click leaves those focused, and their change needs a redraw).
  if (list.contains(document.activeElement) && document.activeElement.matches('textarea, input:not([type]), input[type="text"], input[type="number"], input[type="search"]')) return;
  const btns = d => `
      <button data-act="hide" class="${d.hidden ? 'is-hidden' : ''}" title="${d.hidden ? 'Hidden: left out of the plan, print and the coaches’ view — click to put it back' : 'Hide this drill: keep it here to come back to, but leave it out of the plan, print and the coaches’ view'}">${icon(d.hidden ? 'eyeoff' : 'eye')}</button>
      <button data-act="video" class="${d.video || d.upload ? 'has-video' : ''}${videoOpenFor === d.id ? ' open' : ''}" title="Video for this drill — drop in a file (up to ${MAX_VIDEO_SECS} s, optionally with your own voice over it) or link YouTube / Vimeo / Cloudflare Stream">${icon('video')}</button>
      <button data-act="intro" class="${d.intro ? 'has-intro' : ''}${introOpenFor === d.id ? ' open' : ''}" title="Intro in your voice — recorded here, played before the drill when ▶ is pressed">${icon('mic')}</button>
      <button data-act="notes" class="${(d.notes || '').trim() ? 'has-notes' : ''}${notesOpenFor === d.id ? ' open' : ''}" title="Coaching notes">${icon('notes')}</button>
      <button data-act="del" title="Delete" ${p.drills.length === 1 ? 'disabled' : ''}>${icon('x')}</button>`;
  list.innerHTML = p.drills.map((d, i) => {
    const row = editingDrill === d.id
      ? `<li class="${i === store.drillIndex ? 'active ' : ''}editing" data-index="${i}">
          <span class="num">${i + 1}.</span>
          <input class="dname" value="${escHtml(d.name)}" title="Drill name" spellcheck="false">
          <input class="dmin" type="number" min="0" step="1" value="${+d.duration || 0}" title="Minutes">
          <span class="dur">min</span>
          <button data-act="save" class="primary" title="Save (Enter)">${icon('check')}</button>
          <button data-act="cancel" title="Cancel (Esc)">${icon('x')}</button>
        </li>`
      : `<li class="${i === store.drillIndex ? 'active' : ''}${d.hidden ? ' hidden-drill' : ''}" data-index="${i}" draggable="true" title="${d.hidden ? 'Hidden from the plan · drag to reorder' : 'Drag to reorder'}">
          <span class="num">${i + 1}.</span>
          <span class="name"><span class="dname-text">${escHtml(d.name)}</span><span class="dwhen">${when(d)}</span></span>
          ${fbCount(d) ? `<button data-act="feedback" class="dfb" title="Unresolved coach feedback on this drill — click to read">💬${fbCount(d)}</button>` : ''}
          ${btns(d)}
        </li>`;
    const notes = notesOpenFor === d.id
      ? `<li class="notes-editor"><textarea data-notes="${i}" rows="3" placeholder="Notes / coaching points…">${escHtml(d.notes || '')}</textarea></li>`
      : '';
    const recording = introRec?.drillId === d.id;
    const intro = introOpenFor === d.id ? `<li class="intro-editor"><div class="intro-box">
      <div class="intro-status muted small">${recording ? '● Recording — speak now' : d.intro ? `Intro recorded · ${(+d.intro.secs || 0).toFixed(1)} s${d.intro.size ? ` · ${Math.max(1, Math.round(d.intro.size / 1024))} KB` : ''}${d.intro.cloud === true ? ' · ☁ in the cloud' : ''}${canPlay(d.intro.mime) ? '' : ' · this browser can’t play that format'}` : canRecord() ? 'No intro yet — record yourself introducing this drill.' : 'This browser can’t record audio.'}</div>
      ${d.intro && !recording && !phoneFriendly(d.intro.mime) ? `<div class="intro-warn warn small">⚠ Recorded in a format iPhones can’t play (${escHtml(d.intro.mime)}) — press Re-record; this version records one that plays everywhere.</div>` : ''}
      ${d.intro && !recording && d.intro.cloud !== true ? `<div class="intro-warn warn small">⚠ ${d.intro.cloud === false ? `Not in the cloud — coaches can’t hear it${d.intro.cloudError ? ` (${escHtml(d.intro.cloudError)}${cloudHint(d.intro.cloudError)})` : ''}` : 'Cloud copy unknown — recorded before this version'}</div>` : ''}
      <div class="row">
        ${recording ? '<button data-iact="stop" class="danger">■ Stop</button>' : `<button data-iact="rec" ${canRecord() ? '' : 'disabled'}>● ${d.intro ? 'Re-record' : 'Record'}</button>`}
        <button data-iact="play" ${d.intro && !recording ? '' : 'disabled'}>${introPlaying?.drillId === d.id ? '■ Stop' : '▶ Listen'}</button>
        ${d.intro && !recording && d.intro.cloud !== true && cloudBackend?.saveClip ? '<button data-iact="upload" class="primary">☁ Upload now</button>' : ''}
        <button data-iact="del" ${d.intro && !recording ? '' : 'disabled'}>✕ Delete</button>
      </div>
      <p class="muted small">Plays in your voice before the drill whenever ▶ is pressed — here and on the coaches’ phones — unless 🔊 voice is muted. Up to 90 s.</p>
    </div></li>` : '';
    const v = d.video ? videoEmbed(d.video) : null;
    const vp = vidPending?.drillId === d.id ? vidPending : null, up = d.upload;
    const uploadHTML = vp ? (vp.error
      ? `<div class="intro-warn warn small">⚠ ${escHtml(vp.error)}</div><div class="row"><button data-vact="cancel">OK</button></div>`
      : `<video class="vid-preview" src="${vp.url}" controls playsinline preload="metadata"></video>
        <div class="row vid-trim" title="Trim: only the part between the two times is kept. Play the preview to a spot and press ‘start here’ / ‘end here’, or type the seconds.">
          <span class="muted small">Trim</span>
          <button data-vact="setstart" ${vp.encoding ? 'disabled' : ''}>⟵ start here</button>
          <input type="number" class="vid-in" step="0.1" min="0" value="${(+vp.start || 0).toFixed(1)}" ${vp.encoding ? 'disabled' : ''}>
          <span class="muted small">to</span>
          <input type="number" class="vid-out" step="0.1" min="0" value="${Number.isFinite(vp.end) ? vp.end.toFixed(1) : ''}" placeholder="${Number.isFinite(vp.duration) ? vp.duration.toFixed(1) : 'end'}" ${vp.encoding ? 'disabled' : ''}>
          <button data-vact="setend" ${vp.encoding ? 'disabled' : ''}>end here ⟶</button>
        </div>
        <div class="intro-status muted small vid-summary">${trimSummary(vp)}</div>
        <div class="row">
          <label class="check small"><input type="radio" name="vidaudio" value="keep" ${vp.audio !== 'vo' ? 'checked' : ''} ${vp.encoding ? 'disabled' : ''}> keep its sound</label>
          <label class="check small"><input type="radio" name="vidaudio" value="vo" ${vp.audio === 'vo' ? 'checked' : ''} ${vp.encoding ? 'disabled' : ''}> my voice instead</label>
        </div>
        ${vp.audio === 'vo' && !vp.encoding ? `<div class="row">${vp.voRec
          ? '<button data-vact="vostop" class="danger">■ Stop</button><span class="muted small">● Recording — the video is playing silently, talk over it</span>'
          : `<button data-vact="vorec">● ${vp.vo ? 'Re-record' : 'Record'} voiceover</button>${vp.vo ? `<button data-vact="vopreview">${vp.previewing ? '■ Stop preview' : '▶ Preview with my voice'}</button>` : ''}<span class="muted small">${vp.vo ? `${vp.voSecs.toFixed(1)} s recorded` : 'plays the video (silently) while you talk'}</span>`}</div>` : ''}
        <div class="row">${vp.encoding
          ? '<span class="vid-progress muted small">Starting the encoder…</span>'
          : `<button data-vact="encode" class="primary" ${vp.audio === 'vo' && !vp.vo ? 'disabled title="Record the voiceover first"' : ''}>⬆ Encode &amp; upload</button><button data-vact="cancel">Cancel</button>`}</div>`)
      : up
      ? `<div class="intro-status muted small">Uploaded video · ${fmtSecs(up.secs)} · ${(up.size / 1048576).toFixed(1)} MB · ${up.width}×${up.height}${up.cloud === true ? ' · ☁ in the cloud' : ''}</div>
        ${up.cloud !== true ? `<div class="intro-warn warn small">⚠ Not in the cloud — coaches can’t see it${up.cloudError ? ` (${escHtml(up.cloudError)}${cloudHint(up.cloudError)})` : ''}</div>` : ''}
        <div class="row"><button data-vact="play">▶ Watch</button>${up.cloud !== true && cloudBackend?.saveVideo ? '<button data-vact="upload" class="primary">☁ Upload now</button>' : ''}<button data-vact="del">✕ Delete video</button></div>
        <div class="vid-player"></div><div class="vid-progress muted small"></div>`
      : '';
    const dropHTML = vp ? '' : `<div class="vid-drop">📼 ${up ? 'Drop a new video here to replace it' : `Drop a video here (up to ${MAX_VIDEO_SECS} s)`} or <button data-vact="pick">choose a file</button><input type="file" class="vid-file" accept="video/*,.mov,.mp4,.webm" hidden></div>`;
    const video = videoOpenFor === d.id ? `<li class="video-editor"><div class="intro-box">
      ${uploadHTML}${dropHTML}
      <div class="muted small vid-or">— or link one —</div>
      <input class="video-url" data-video="${d.id}" value="${escHtml(d.video || '')}" placeholder="Paste a YouTube, Vimeo or Cloudflare Stream link" spellcheck="false" autocomplete="off">
      <div class="intro-status muted small">${!d.video ? (up ? 'The uploaded video is what coaches see; a link here is used only when there is no upload.' : 'Coaches get a ▶ Watch video button on the drill; the diagram stays.') : v ? `${v.host} · ${escHtml(v.id)}${up ? ' (the upload above takes precedence)' : ''}` : '⚠ Not a link this app can embed — use a YouTube, Vimeo or Cloudflare Stream page link (or a direct .mp4 link).'}</div>
      ${v && !up ? videoPlayerHTML(v) : ''}
    </div></li>` : '';
    return row + notes + intro + video;
  }).join('');
}

// Drag to reorder drills (↑/↓ buttons remain for touch).
let dragDrill = null; // index being dragged
const clearDropMarks = () => $$('#drill-list li').forEach(li => li.classList.remove('dragging', 'drop-above', 'drop-below'));
$('#drill-list').addEventListener('dragstart', e => {
  const li = e.target.closest('li');
  if (!li || li.classList.contains('editing') || li.matches('.notes-editor, .intro-editor, .video-editor')) { e.preventDefault(); return; }
  dragDrill = +li.dataset.index;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', ''); // Firefox requires data for a drag to start
  li.classList.add('dragging');
});
$('#drill-list').addEventListener('dragover', e => {
  if (dragDrill == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  $(`#drill-list li[data-index="${dragDrill}"]:not(.notes-editor)`)?.classList.add('dragging');
  const li = e.target.closest('li');
  if (!li || li.matches('.notes-editor, .intro-editor, .video-editor') || +li.dataset.index === dragDrill) return;
  const r = li.getBoundingClientRect();
  li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
});
$('#drill-list').addEventListener('drop', e => {
  if (dragDrill == null) return;
  e.preventDefault();
  const li = e.target.closest('li');
  const p = store.practice;
  const from = dragDrill;
  dragDrill = null; clearDropMarks();
  if (!li || li.matches('.notes-editor, .intro-editor, .video-editor')) return;
  const r = li.getBoundingClientRect();
  let to = +li.dataset.index + (e.clientY < r.top + r.height / 2 ? 0 : 1);
  if (to > from) to--;
  if (to === from || !p.drills[from]) return;
  const activeId = p.drills[store.drillIndex]?.id;
  commit(() => {
    const [d] = p.drills.splice(from, 1);
    p.drills.splice(to, 0, d);
    store.drillIndex = Math.max(0, p.drills.findIndex(x => x.id === activeId)); // keep the open drill open
  });
});
$('#drill-list').addEventListener('dragend', () => { dragDrill = null; clearDropMarks(); });

// Inline notes editing (live) — name/minutes only commit via the edit row's Save button.
$('#drill-list').addEventListener('focusin', e => { if (e.target.matches('textarea, .video-url')) store.beginPending(); });
$('#drill-list').addEventListener('dragover', e => { const z = e.target.closest('.vid-drop'); if (!z) return; e.preventDefault(); z.classList.add('over'); });
$('#drill-list').addEventListener('dragleave', e => { e.target.closest('.vid-drop')?.classList.remove('over'); });
$('#drill-list').addEventListener('drop', e => {
  const z = e.target.closest('.vid-drop'); if (!z) return;
  e.preventDefault(); z.classList.remove('over');
  const d = store.practice.drills.find(x => x.id === videoOpenFor); if (!d) return;
  stageVideoFile(d, e.dataTransfer?.files?.[0]);
});
$('#drill-list').addEventListener('change', e => {
  if (e.target.matches('.vid-file')) { const d = store.practice.drills.find(x => x.id === videoOpenFor); if (d) stageVideoFile(d, e.target.files?.[0]); }
  if (e.target.matches('input[name="vidaudio"]') && vidPending) { vidPending.audio = e.target.value; renderPlan(); }
  if (e.target.matches('.vid-in, .vid-out') && vidPending) { unfocusList(); renderPlan(); }
});
$('#drill-list').addEventListener('input', e => {
  if (!e.target.matches('.vid-in, .vid-out') || !vidPending) return;
  const v = e.target.value === '' ? NaN : +e.target.value;
  if (e.target.matches('.vid-in')) vidPending.start = Number.isFinite(v) ? Math.max(0, v) : 0; else vidPending.end = Number.isFinite(v) ? v : NaN;
  const sum = $('#drill-list .vid-summary'); if (sum) sum.textContent = trimSummary(vidPending);
});
$('#drill-list').addEventListener('input', e => {
  if (!e.target.matches('.video-url')) return;
  const d = store.practice.drills.find(x => x.id === e.target.dataset.video); if (!d) return;
  const v = e.target.value.trim();
  if (v) d.video = v; else delete d.video;
  store.save();
});
$('#drill-list').addEventListener('change', e => { if (e.target.matches('.video-url')) { store.commitPending(); e.target.blur(); renderPlan(); } }); // blur: the list won't rebuild under a focused input
$('#drill-list').addEventListener('keydown', e => { if (e.target.matches('.video-url') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); renderPlan(); } });
$('#drill-list').addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.notes != null) {
    const d = store.practice.drills[+el.dataset.notes];
    if (d) { d.notes = el.value; store.save(); }
  }
});
$('#drill-list').addEventListener('change', e => {
  if (e.target.matches('textarea')) { store.commitPending(); renderUI(); }
});
$('#drill-list').addEventListener('keydown', e => {
  const row = e.target.closest('li.editing');
  if (!row || !e.target.matches('input')) return;
  if (e.key === 'Enter') { e.preventDefault(); row.querySelector('[data-act=save]')?.click(); }
  else if (e.key === 'Escape') { e.stopPropagation(); row.querySelector('[data-act=cancel]')?.click(); }
});

// Double-click a drill row: rename it inline (same as the ✎ button).
$('#drill-list').addEventListener('dblclick', e => {
  const li = e.target.closest('li');
  if (!li || li.classList.contains('editing') || li.matches('.notes-editor, .intro-editor, .video-editor')) return;
  if (e.target.closest('button,input,textarea')) return;
  const i = +li.dataset.index;
  if (!store.practice.drills[i]) return;
  finishActive();
  editingDrill = store.practice.drills[i].id;
  if (store.drillIndex !== i) switchDrill(i); else renderPlan();
  const el = $('#drill-list li.editing .dname');
  if (el) { el.focus(); el.select(); }
});

$('#drill-list').addEventListener('click', e => {
  const li = e.target.closest('li'); if (!li) return;
  const i = +li.dataset.index;
  const btn = e.target.closest('button');
  const act = btn?.dataset.act;
  btn?.blur(); // a focused list button must not trip the "typing in the list" rebuild guard
  const p = store.practice;
  if (li.matches('.intro-editor')) { introAction(btn?.dataset.iact, li); return; }
  if (li.matches('.video-editor')) { if (btn?.dataset.vact) videoAction(btn.dataset.vact, li); return; }
  if (act === 'video') { videoOpenFor = videoOpenFor === p.drills[i].id ? null : p.drills[i].id; notesOpenFor = null; introOpenFor = null; renderPlan(); if (videoOpenFor) $('#drill-list .video-url')?.focus(); return; }
  if (act === 'intro') { introOpenFor = introOpenFor === p.drills[i].id ? null : p.drills[i].id; notesOpenFor = null; videoOpenFor = null; renderPlan(); return; }
  if (act === 'feedback') { openFeedbackPanel(); return; }
  if (act === 'hide') { const d = p.drills[i]; commit(() => { if (d.hidden) delete d.hidden; else d.hidden = true; }); renderAll(); return; }
  if (li.matches('.notes-editor, .intro-editor, .video-editor')) return;
  finishActive();
  if (act === 'save' || act === 'cancel') {
    const row = $('#drill-list li.editing');
    if (row?.contains(document.activeElement)) document.activeElement.blur(); // let the list rebuild
    if (act === 'save' && row && editingDrill) {
      const name = row.querySelector('.dname').value.trim();
      const dur = Math.max(0, +row.querySelector('.dmin').value || 0);
      commit(() => {
        const d = p.drills.find(x => x.id === editingDrill);
        if (d) { if (name) d.name = name; d.duration = dur; }
      });
    }
    editingDrill = null;
    renderAll();
    return;
  }
  if (act === 'notes') {
    const d = p.drills[i];
    notesOpenFor = notesOpenFor === d.id ? null : d.id;
    if (store.drillIndex !== i) switchDrill(i); else renderPlan();
    if (notesOpenFor) $('#drill-list .notes-editor textarea')?.focus();
    return;
  }
  if (!act) {
    if (e.target.closest('input,textarea') || li.classList.contains('editing')) return;
    if (i !== store.drillIndex) switchDrill(i);
    return;
  }
  if (act === 'del') {
    if (!confirm(`Delete "${p.drills[i].name}"?`)) return;
    if (editingDrill === p.drills[i].id) editingDrill = null;
    commit(() => { p.drills.splice(i, 1); store.drillIndex = Math.min(i, p.drills.length - 1); });
  }
  sel = null; stopAnim(); renderAll();
});

function switchDrill(i) {
  store.drillIndex = i; sel = null; stopAnim(); renderAll();
}

// ---------- drill library (every drill across all practices) ----------
function libraryCards(filter) {
  const q = filter.trim().toLowerCase();
  const practices = [...store.data.practices].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const cards = [];
  for (const p of practices) for (const d of p.drills || []) {
    if (q && !`${d.name} ${p.team || ''} ${p.date || ''} ${usDate(p.date)}`.toLowerCase().includes(q)) continue;
    const v = d.view || VIEWS.full;
    cards.push(`<div class="lib-card">
      <svg viewBox="${v.x} ${v.y} ${v.w} ${v.h}" preserveAspectRatio="xMidYMid meet">${rinkSVG()}${renderObjects(d, null)}</svg>
      <div class="lib-name" title="${escHtml(d.name)}">${escHtml(d.name)}</div>
      <div class="lib-meta" title="${escHtml(practiceLabel(p))}">${escHtml(practiceLabel(p))} · ${+d.duration || 0} min</div>
      <button data-lib-add="${p.id}:${d.id}">+ Add to this practice</button>
    </div>`);
  }
  return cards.length ? cards.join('') : `<div class="lib-empty">${q ? 'No drills match that search.' : 'No drills yet — drills you create in any practice appear here.'}</div>`;
}
function renderLibrary() {
  $('#lib-target').textContent = practiceLabel(store.practice);
  $('#lib-grid').innerHTML = `<style>${SVG_STYLE}</style>` + libraryCards($('#lib-search').value);
}
function openLibrary() { finishActive(); $('#library').hidden = false; renderLibrary(); $('#lib-search').select(); }
function closeLibrary() { $('#library').hidden = true; }
$('#btn-library').addEventListener('click', openLibrary);
$('#lib-close').addEventListener('click', closeLibrary);
$('#lib-search').addEventListener('input', renderLibrary);
$('#library').addEventListener('click', e => {
  if (e.target === $('#library')) return closeLibrary(); // click on the backdrop
  const btn = e.target.closest('[data-lib-add]'); if (!btn) return;
  const [pid, did] = btn.dataset.libAdd.split(':');
  const src = store.data.practices.find(p => p.id === pid)?.drills.find(d => d.id === did);
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid();
  delete copy.intro; delete copy.upload; // the recorded intro and uploaded video stay with the original
  copy.objects = cloneObjects(migrateDrill(copy).objects);
  const p = store.practice;
  commit(() => { p.drills.push(copy); store.drillIndex = p.drills.length - 1; });
  $('#lib-target').textContent = practiceLabel(store.practice);
  btn.textContent = 'Added ✓'; btn.disabled = true;
  setTimeout(() => { btn.textContent = '+ Add to this practice'; btn.disabled = false; }, 1200);
});

$('#btn-add-drill').addEventListener('click', e => { e.stopPropagation(); addDrillAndRename(); });

function stepDrill(delta) {
  const i = store.drillIndex + delta;
  if (i < 0 || i >= store.practice.drills.length) return;
  finishActive(); switchDrill(i);
}

// ---------- selection properties ----------
const PROPS = {
  skater: [
    ['label', 'text', 'Label'], ['side', 'select:=— none —,O=Offense (blue),D=Defense (red)', 'Side'], ['color', 'swatch', 'Color'], ['role', 'select:F=Forward,D=Defense,G=Goalie', 'Role'],
    ['speed', 'number', 'Speed (ft/s)'], ['delay', 'number', 'Start delay (s)'],
    ['backward', 'checkbox', 'Starts skating backward'], ['facing', 'number', 'Facing (°, blank = auto)'],
  ],
  coach: [['label', 'text', 'Label'], ['color', 'swatch', 'Color'], ['pad', 'checkbox', 'Tackle pad'], ['speed', 'number', 'Speed (ft/s)'], ['delay', 'number', 'Start delay (s)'], ['facing', 'number', 'Facing (°, blank = auto)']],
  cone: [['color', 'color', 'Color']],
  minicone: [['color', 'color', 'Color']],
  tire: [],
  pile: [['count', 'number', 'Pucks in pile']],
  puck: [['passSpeed', 'number', 'Pass speed (ft/s)'], ['shotSpeed', 'number', 'Shot speed (ft/s)']],
  contact: [],
  net: [['rot', 'number', 'Rotation (°)']],
  obstacle: [['label', 'text', 'Label'], ['w', 'number', 'Width (ft)'], ['h', 'number', 'Depth (ft)'], ['rot', 'number', 'Rotation (°)']],
  raisedpad: [['label', 'text', 'Label'], ['w', 'number', 'Length (ft)'], ['h', 'number', 'Depth (ft)'], ['rot', 'number', 'Rotation (°)']],
  jumppad: [['label', 'text', 'Label'], ['w', 'number', 'Length (ft)'], ['h', 'number', 'Depth (ft)'], ['rot', 'number', 'Rotation (°)']],
  focus: [['w', 'number', 'Width (ft)'], ['h', 'number', 'Height (ft)'], ['dim', 'select:0.35=Light,0.55=Medium,0.8=Dark', 'Gray-out outside the box']],
  zone: [['label', 'text', 'Title'], ['color', 'zoneswatch', 'Color'], ['w', 'number', 'Width (ft)'], ['h', 'number', 'Height (ft)'],
    ['constraints', 'textarea', 'Constraints — one per line. Drawn in the zone, listed under the drill, and read aloud in the viewer']],
  barricade: [],
  arrow: [['style', 'select:' + Object.entries(ARROW_STYLES).map(([k, v]) => `${k}=${v}`).join(','), 'Style'], ['color', 'color', 'Color']],
  text: [['text', 'text', 'Text'], ['size', 'number', 'Size'], ['color', 'color', 'Color']],
};
const TYPE_NAMES = { focus: 'Focus area', contact: 'Contact', skater: 'Skater', coach: 'Coach', cone: 'Cone', minicone: 'Small cone', raisedpad: 'Raised pad', jumppad: 'Jump pad', pile: 'Puck pile', tire: 'Tire', puck: 'Puck', net: 'Net', obstacle: 'Obstacle', zone: 'Zone', barricade: 'Barricade', arrow: 'Arrow', text: 'Text' };

function renderProps() {
  const body = $('#props-body');
  if (body.contains(document.activeElement)) return; // don't clobber an input being edited
  const o = sel && getObj(sel);
  if (!o) {
    body.innerHTML = `<p class="muted">Nothing selected. Click an object with the Select tool.</p>
      <h3 class="props-h3">Whole drill</h3>
      <div class="row">
        <button data-dact="mirrorX" title="Flip the drill left ↔ right across the centre line: a drill drawn in the left zone becomes the same drill in the right zone (paths, passes, shots, equipment and the view all move)">⇄ Mirror left ↔ right</button>
        <button data-dact="mirrorY" title="Flip the drill top ↔ bottom across the long axis of the rink">⇅ Mirror top ↔ bottom</button>
      </div>
      <div class="row">
        <button data-dact="copyX" title="Keep this drill and add a mirrored copy at the other end, so it runs at both ends at once">⧉ Copy to the other end</button>
        <button data-dact="copyY" title="Keep this drill and add a mirrored copy on the other side of the rink">⧉ Copy to the other side</button>
      </div>
      <p class="muted small">Mirroring flips handedness too: a turn to the left becomes a turn to the right, and nets, obstacles and facings turn with it.</p>`;
    return;
  }
  const fields = (PROPS[o.type] || [])
    .filter(([key]) => !(key === 'facing' && o.path?.length)) // a moving skater faces along its path; facing only places a stationary skater's puck
    .map(([key, kind, label]) => {
    let input;
    const v = o[key] ?? '';
    if (kind === 'text') input = `<input data-prop="${key}" value="${escHtml(v)}">`;
    else if (kind === 'textarea') return `<label class="field"><span>${label}</span><textarea data-prop="${key}" rows="5" placeholder="e.g. 2 touches max&#10;No passes back&#10;Score only from below the dots">${escHtml(v)}</textarea></label>`;
    else if (kind === 'number') input = `<input data-prop="${key}" type="number" step="any" value="${escHtml(v)}">`;
    else if (kind === 'checkbox') input = `<input data-prop="${key}" type="checkbox" ${v ? 'checked' : ''}>`;
    else if (kind === 'color') input = `<input data-prop="${key}" type="color" value="${escHtml(v || '#000000')}">`;
    else if (kind.startsWith('select:')) {
      const opts = kind.slice(7).split(',').map(s => s.split('='));
      input = `<select data-prop="${key}">${opts.map(([val, txt]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${txt}</option>`).join('')}</select>`;
    } else if (kind === 'swatch') {
      input = `<div class="swatches">${Object.entries(SKATER_COLORS).map(([name, hex]) => `<button class="swatch ${v === name ? 'active' : ''}" data-prop="${key}" data-value="${name}" style="background:${hex}" title="${name}"></button>`).join('')}</div>`;
      return `<div class="field"><span>${label}</span>${input}</div>`;
    } else if (kind === 'zoneswatch') {
      input = `<div class="swatches">${ZONE_COLORS.map(hex => `<button class="swatch ${v === hex ? 'active' : ''}" data-prop="${key}" data-value="${hex}" style="background:${hex}"></button>`).join('')}</div>`;
      return `<div class="field"><span>${label}</span>${input}</div>`;
    }
    return `<label class="field inline"><span>${label}</span>${input}</label>`;
  }).join('');

  const custom = o.type === 'puck' ? puckProps(o) : o.type === 'contact' ? contactProps(o) : isPlayer(o) ? triggerProps(o) : '';
  const extra = [];
  if (isPlayer(o)) {
    const tm = sim.skater(o.id);
    const hasPath = !!o.path?.length;
    const start = tm.delay > 0 || o.trigger ? ` · starts at ${tm.delay.toFixed(1)} s` : '';
    extra.push(`<p class="muted">Path: ${tm.len.toFixed(0)} ft · ${(tm.len / tm.speed).toFixed(1)} s${start}${hasPath ? '' : ` (no path yet — use the Skater tool on this ${o.type} to add waypoints)`}</p>`);
    if (hasPath) {
      // One consolidated waypoint list: position, pivot / full stop / voice cue toggles, and ✕ to remove —
      // a waypoint buried under cones or other skaters is easier to reach here than by double-clicking on the ice.
      const own = !o.follow;
      const cueBtn = (k, cue, name) => (canSpeak || cue != null) ? `<button class="wp-toggle ${cue != null ? 'active' : ''}" data-act="cue" data-wp="${k}" title="Voice cue at ${name} — click to add or remove what is said when ${playerName(o)} gets there">🔊</button>` : '';
      const xy = (kx, ky, pt) => `<span class="wp-pos"><input class="wp-xy" type="number" step="any" ${kx} value="${G.round1(pt.x)}" title="x (ft from the left boards)"><input class="wp-xy" type="number" step="any" ${ky} value="${G.round1(pt.y)}" title="y (ft from the top boards)"></span>`;
      const rows = [`<div class="wp-item" data-wprow="start"><span class="wp-num">S</span>${xy('data-prop="x"', 'data-prop="y"', o)}<span class="wp-what muted">start</span><span class="spacer"></span>${cueBtn('start', o.startCue, 'their start')}</div>`];
      if (o.startCue != null) rows.push(`<label class="field inline wp-sub"><span>Say</span><input data-cue="start" value="${escHtml(o.startCue)}" placeholder="e.g. Go on the whistle" autocomplete="off"></label>`);
      o.path.forEach((pt, i) => {
        const flags = [pt.pivot === 'L' ? 'pivot ⟲' : pt.pivot ? 'pivot ⟳' : '', +pt.stop > 0 ? `stop ${+pt.stop}s` : ''].filter(Boolean).join(' · ');
        rows.push(`<div class="wp-item" data-wprow="${i}"><span class="wp-num">${i + 1}</span>${own ? xy(`data-wpx="${i}"`, `data-wpy="${i}"`, pt) : `<span class="wp-pos muted">(${Math.round(pt.x)}, ${Math.round(pt.y)})</span>`}<span class="wp-what muted">${flags}</span><span class="spacer"></span>
          ${o.type === 'skater' && own ? `<button class="wp-toggle ${pt.pivot ? 'active' : ''}" data-act="pivot" data-wp="${i}" title="Pivot at waypoint ${i + 1} (forward ⇄ backward) — click cycles: none → ⟲ face swings left → ⟳ face swings right">⇄</button><button class="wp-toggle ${+pt.stop > 0 ? 'active' : ''}" data-act="wpstop" data-wp="${i}" title="Full stop at waypoint ${i + 1} — a sharp turn, and everything downstream (passes, contacts) waits with them">⏸</button>` : ''}
          ${cueBtn(String(i), pt.cue, `waypoint ${i + 1}`)}
          ${own ? `<button class="wp-toggle wp-del" data-act="wpdel" data-wp="${i}" title="Remove waypoint ${i + 1}">✕</button>` : ''}</div>`);
        if (+pt.stop > 0) rows.push(`<label class="field inline wp-sub"><span>Hold (s)</span><input type="number" min="0" step="0.25" value="${+pt.stop}" data-wpstopdur="${i}" title="How long the full stop lasts — 0 removes it"></label>`);
        if (pt.cue != null) rows.push(`<label class="field inline wp-sub"><span>Say</span><input data-cue="${i}" value="${escHtml(pt.cue)}" placeholder="e.g. Head up" autocomplete="off"></label>`);
      });
      extra.push(`<div class="field"><span title="Waypoints are numbered on the ice while this player is selected. Hover a row to light its handle up on the ice. Type x / y (feet) to move one — even one that has drifted off the canvas. ⇄ pivot · ⏸ full stop · 🔊 voice cue · ✕ remove.">Waypoints${own ? '' : ` — ${playerName(getObj(o.follow))}'s route`}</span><div class="wp-list">${rows.join('')}</div></div>`);
    } else if (canSpeak || o.startCue != null) {
      extra.push(`<div class="field"><span>Voice cue at their start</span><div class="row wp-row"><button class="wp-toggle ${o.startCue != null ? 'active' : ''}" data-act="cue" data-wp="start" title="Say something when ${playerName(o)} starts — click to add or remove">🔊${o.startCue?.trim() ? ' set' : ''}</button></div></div>`);
      if (o.startCue != null) extra.push(`<label class="field inline"><span>Say at their start</span><input data-cue="start" value="${escHtml(o.startCue)}" placeholder="e.g. Go on the whistle" autocomplete="off"></label>`);
    }
    if (o.type === 'skater') {
      const leaders = drill().objects.filter(s => s.type === 'skater' && s.id !== o.id && !s.follow && s.path?.length);
      if (leaders.length || o.follow) extra.push(`<label class="field inline"><span>Same path as</span><select data-prop="follow">
        <option value="">— their own path —</option>
        ${leaders.map(s => `<option value="${s.id}" ${o.follow === s.id ? 'selected' : ''}>${playerName(s)} (${s.color})</option>`).join('')}</select></label>`);
      if (o.follow) {
        const lead = getObj(o.follow), n = lead?.path?.length || 0, k = Math.max(0, Math.min(n, Math.round(+o.followWp || 0)));
        extra.push(`<label class="field inline"><span>Join their route at</span><select data-prop="followWp">
          <option value="0" ${k === 0 ? 'selected' : ''}>their start</option>
          ${Array.from({ length: n }, (_, i) => `<option value="${i + 1}" ${k === i + 1 ? 'selected' : ''}>waypoint ${i + 1}</option>`).join('')}</select></label>`);
        extra.push(`<label class="field inline"><span>Meet them there — start so both arrive together</span><input data-prop="followMeet" type="checkbox" ${o.followMeet ? 'checked' : ''}></label>`);
        const mi = o.followMeet ? sim.meetInfo(o.id) : null;
        if (mi) extra.push(mi.late > 0.05
          ? `<p class="warn small">⚠ Can't get there in time: ${playerName(lead)} reaches ${k ? `waypoint ${k}` : 'their start'} at ${mi.at.toFixed(1)} s, and it takes ${playerName(o)} ${mi.travel.toFixed(1)} s to skate there — they arrive ${mi.late.toFixed(1)} s behind. Move them closer, speed them up, or join later.</p>`
          : `<p class="muted small">Starts at ${(sim.skater(o.id).delay).toFixed(1)} s and reaches ${k ? `waypoint ${k}` : 'the start'} with ${playerName(lead)} at ${mi.at.toFixed(1)} s${+o.delay ? ` (your ${+o.delay} s delay is added on top)` : ''}.</p>`);
        else extra.push(`<p class="muted small">Skates ${playerName(lead)}'s route from their own spot${k ? `, joining it at waypoint ${k}` : ''}. Edit that skater's path to reroute everyone; stagger the line with each skater's Delay.</p>`);
      }
    }
    const myPuck = drill().objects.find(pk => pk.type === 'puck' && pk.carrier === o.id);
    extra.push(myPuck ? `<button data-act="selpuck">Puck: passes &amp; shots…</button>` : `<button data-act="givepuck">Give puck</button>`);
    extra.push(`<button data-act="extend" ${o.follow ? 'disabled title="Following another skater&#39;s path"' : ''}>${hasPath ? 'Extend path' : 'Add path'}</button>`);
    extra.push(`<button data-act="clearpath" ${hasPath && !o.follow ? '' : 'disabled'}>Clear path</button>`);
    if (drill().objects.some(x => x.type === 'pile')) extra.push(`<button data-act="takepuck" title="Add a puck they pick up from the nearest pile where their path passes it">Take puck from pile</button>`);
    if (!myPuck && nearestLoosePuck(o)) extra.push(`<button data-act="chasepuck" title="They pick up the nearest puck that ends up loose (a coach's chip in the corner, a missed shot, a loose puck) where their path passes its resting spot">Pick up loose puck</button>`);
    if (o.type === 'coach') {
      const pile = pileAtCoach(o);
      if (pile) {
        const chips = drill().objects.filter(pk => pk.type === 'puck' && pk.pile === pile.id && pk.carrier === o.id).length;
        extra.push(`<p class="muted">🪣 At a puck pile${chips ? ` · ${chips} chipped` : ''}. Chips happen at this coach's Delay — select a chipped puck to retarget it or drag its B bounce marker.</p>`);
        extra.push(`<button data-act="chipcorner" title="Take a puck from the pile and chip it into the nearest corner">Chip to corner</button>`);
        extra.push(`<button data-act="chipboards" title="Take a puck from the pile and rim it around the end boards to the far corner">Chip around boards</button>`);
      }
      if (o.pad) extra.push(`<p class="muted small">🛡 Holding a tackle pad — place a 💥 Contact marker where the pad meets a skater's path and they'll take the bump there (staggered and slowed if you pick them as "worse for", but the coach never takes their puck).</p>`);
      extra.push(`<p class="muted small">A coach can move like a skater, receive passes and pass or shoot the puck. Facing sets which way they hold it while standing.${pile ? '' : ' Stand them on a puck pile to chip pucks into play.'}</p>`);
    }
  }
  if (o.type === 'pile') {
    const taken = drill().objects.filter(pk => pk.type === 'puck' && pk.pile === o.id);
    extra.push(`<p class="muted">${taken.length} taken so far · ${Math.max(0, Math.round(+o.count || 0) - taken.length)} left</p>`);
    extra.push(`<label class="field inline"><span>Give a puck to</span><select data-prop="pilegive">${skaterOptions('', '— choose a player —')}</select></label>`);
    const feeder = coachAtPile(o);
    if (feeder) {
      extra.push(`<p class="muted">📋 ${playerName(feeder)} is at this pile and can chip pucks into play.</p>`);
      extra.push(`<button data-act="chipcorner" title="The coach takes a puck and chips it into the nearest corner">Chip to corner</button>`);
      extra.push(`<button data-act="chipboards" title="The coach takes a puck and rims it around the end boards to the far corner">Chip around boards</button>`);
    }
  }
  if (o.type === 'focus') {
    extra.push(`<button data-act="focus">Zoom the view to this box</button>`);
    extra.push(`<button data-act="fitdrill" title="Uniformly scale and centre everything in this drill so it fits inside the box">⇲ Resize drill into box</button>`);
    extra.push(`<p class="muted small">Everything outside the box is grayed out — on the ice, on the printed sheet and in the coaches’ view. Grab the dashed edge to move it; objects inside stay clickable.</p>`);
  }
  if (o.type === 'zone') {
    extra.push(`<button data-act="focus">Focus view on zone</button>`);
    if (canSpeak && zoneLines(o).length) extra.push(`<button data-act="readzone" title="Hear the title and constraints the way the viewer reads them">🔊 Read aloud</button>`);
    extra.push(`<button data-act="fitdrill" title="Uniformly scale and centre everything in this drill so it fits inside this zone — paths, equipment, passes and shots included">⇲ Resize drill into zone</button>`);
  }
  if (o.type === 'net') {
    const g = goalieOf(o);
    extra.push(g ? `<button data-act="selgoalie">Goalie ${escHtml(g.label)}…</button>` : `<button data-act="addgoalie">Add goalie</button>`);
    extra.push(`<button data-act="rot90">Rotate 90°</button>`);
  }
  if (isPlayer(o) && !o.path?.length) extra.push(`<button data-act="face45">Turn 45°</button>`);
  if (o.type === 'obstacle' || o.type === 'raisedpad' || o.type === 'jumppad') extra.push(`<button data-act="rot90">Rotate 90°</button>`);
  if (o.type === 'raisedpad') extra.push(`<p class="muted small">Skaters whose path runs under the pad slide under it, pushing the puck ahead.</p>`);
  if (o.type === 'jumppad') extra.push(`<p class="muted small">Skaters whose path crosses the pad jump over it, pushing the puck ahead.</p>`);
  extra.push(`<button data-act="dup">Duplicate</button>`);
  extra.push(`<button data-act="del" class="danger">Delete</button>`);

  // Position is editable in the header (so an object off the canvas can be brought back); a carried puck rides its carrier.
  const placed = o.x != null && !isPlayer(o) && !(o.type === 'puck' && o.carrier);
  const head = placed
    ? `<span class="wp-pos"><input class="wp-xy" type="number" step="any" data-prop="x" value="${G.round1(o.x)}" title="x (ft from the left boards)"><input class="wp-xy" type="number" step="any" data-prop="y" value="${G.round1(o.y)}" title="y (ft from the top boards)"></span>`
    : `<span class="muted">(${G.round1(o.x ?? o.points?.[0]?.x ?? 0)}, ${G.round1(o.y ?? o.points?.[0]?.y ?? 0)})</span>`;
  const ptList = o.points ? `<div class="field"><span title="Type x / y (feet) to move a point; ✕ removes it (a line keeps at least two).">Points</span><div class="wp-list">${o.points.map((pt, i) => `<div class="wp-item"><span class="wp-num">${i + 1}</span><span class="wp-pos"><input class="wp-xy" type="number" step="any" data-ptx="${i}" value="${G.round1(pt.x)}"><input class="wp-xy" type="number" step="any" data-pty="${i}" value="${G.round1(pt.y)}"></span><span class="spacer"></span>${o.points.length > 2 ? `<button class="wp-toggle wp-del" data-act="ptdel" data-wp="${i}" title="Remove point ${i + 1}">✕</button>` : ''}</div>`).join('')}</div></div>` : '';
  body.innerHTML = `<p class="pin-row"><b>${TYPE_NAMES[o.type] || o.type}</b> ${head}</p>${fields}${custom}${ptList}<div class="row">${extra.join('')}</div>`;
}

const EV_TYPES = { pass: 'Pass', shoot: 'Shoot', pickup: 'Pickup' };

/** "Starts moving" controls for a skater or coach: at t = 0, or when another player reaches a waypoint. */
function triggerProps(o) {
  const tr = o.trigger;
  const others = drill().objects.filter(s => isPlayer(s) && s.id !== o.id);
  const opts = `<option value="" ${!tr ? 'selected' : ''}>at the start (t = 0)</option>`
    + others.map(s => `<option value="${s.id}" ${tr?.player === s.id ? 'selected' : ''}>when ${playerName(s)} reaches…</option>`).join('');
  const wp = tr ? `<label class="field inline"><span>…their waypoint</span><input data-prop="triggerWp" type="number" min="0" step="1" value="${tr.wp ?? 0}" title="0 = their start position, 1… = their path waypoints (numbered on the ice while this player is selected)"></label>` : '';
  const bad = tr && !others.some(s => s.id === tr.player) ? `<p class="warn">⚠ That player no longer exists — pick another.</p>` : '';
  return `<label class="field inline"><span>Starts moving</span><select data-prop="triggerPlayer">${opts}</select></label>${wp}${bad}${tr ? '<p class="muted small">Start delay is added after the trigger.</p>' : ''}`;
}

/** Short name for a skater or coach, e.g. "#3" or "Coach C". */
function playerName(o) { return !o ? '?' : o.type === 'coach' ? `Coach ${escHtml(o.label)}` : `#${escHtml(o.label)}`; }

function contactProps(o) {
  // Skaters need a path to arrive at the marker; a coach (e.g. with a tackle pad) can just stand there.
  const movers = drill().objects.filter(x => (x.type === 'skater' && x.path?.length) || x.type === 'coach');
  const opt = val => `<option value="" ${!val ? 'selected' : ''}>— pick a player —</option>` +
    movers.map(x => `<option value="${x.id}" ${x.id === val ? 'selected' : ''}>${playerName(x)}${x.type === 'coach' && x.pad ? ' 🛡' : ''} (${x.color})</option>`).join('');
  const info = sim.contactSync(o.id);
  const name = id => playerName(getObj(id) || {});
  let status;
  if (!o.a || !o.b || o.a === o.b) status = `<p class="warn">⚠ pick two different players (skaters need a path; a coach can stand still)</p>`;
  else if (!info.ok) status = info.far
    ? `<p class="warn">⚠ marker is ${info.far.toFixed(0)} ft off the paths, so it is ignored — drag it onto the spot where the paths converge (or delete it)</p>`
    : `<p class="warn">⚠ at least one side must be a skater with a path (or a coach)</p>`;
  else {
    const waits = [[o.a, info.aWait], [o.b, info.bWait]].filter(([, w]) => w > 0.05)
      .map(([id, w]) => `${name(id)} waits ${w.toFixed(1)} s`).join(' · ');
    const off = Math.max(info.aOff, info.bOff);
    status = `<p class="muted">Contact at t = ${info.t.toFixed(1)} s${waits ? ' · ' + waits : ''}</p>` +
      (off > 3 ? `<p class="warn">⚠ marker is ${off.toFixed(0)} ft off a path — drag it onto the spot where the paths converge</p>` : '');
  }
  return `<label class="field inline"><span>Skater A</span><select data-prop="a">${opt(o.a)}</select></label>
    <label class="field inline"><span>Skater B</span><select data-prop="b">${opt(o.b)}</select></label>
    ${status}
    <p class="muted small">Whoever would arrive first waits at their start so both hit this spot together. Drag the marker to move the contact. Pick who gets the worse of it on the animation bar — they slow to ${Math.round(100 * 0.55)}% and lose the puck to the winner.</p>`;
}

function skaterOptions(val, noneLabel, exclude = null, selfId = null) {
  const players = drill().objects.filter(s => isPlayer(s) && s.id !== exclude);
  return `<option value="" ${!val ? 'selected' : ''}>${noneLabel}</option>` +
    players.map(s => `<option value="${s.id}" ${s.id === val ? 'selected' : ''}>${playerName(s)}${s.id === selfId ? ' (themselves)' : ''} (${s.color}${s.role === 'G' ? ', G' : ''})</option>`).join('');
}

/** Snap a point to the boards (rounded to 0.1 ft). */
const boardPt = p => { const q = nearestBoardPoint(p); return { x: G.round1(q.x), y: G.round1(q.y) }; };

/** A sensible first bounce point for pass event `i`: the boards nearest the middle of the pass. */
function defaultBank(pk, i) {
  const rec = sim.puck(pk.id).info[i];
  const a = rec?.from || (rec?.carrier ? sim.puckAt(rec.carrier, rec.t ?? 0) : { x: pk.x, y: pk.y });
  const b = rec?.to || a;
  return boardPt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
}

function puckProps(o) {
  const ps = sim.puck(o.id);
  const evs = o.events || [];
  const rows = evs.map((ev, i) => {
    const rec = ps.info[i];
    const who = rec?.carrier ? playerName(getObj(rec.carrier)) : 'loose puck';
    let problem = '';
    if (!rec?.ok) {
      if (ev.type === 'pickup') problem = rec?.carrier ? 'puck is already carried here' : 'pick a player';
      else if (!rec?.carrier) problem = 'nobody has the puck here';
      else if (ev.type === 'pass' && ev.to === rec.carrier && !ev.bank) problem = `${playerName(getObj(rec.carrier))} can't pass to themselves — pick another receiver, or bank it off the boards`;
      else problem = 'pick a receiver';
    }
    const eff = rec?.late ? effectiveDist(o, i) : null;
    const snap = eff != null ? ` <button class="small" data-act="snapdist" data-ev="${i}" title="Re-time this event to that spot, so the number here matches the marker on the ice">Use that spot</button>` : '';
    const late = !rec?.late ? ''
      : ev.type === 'shoot' ? ` <span class="warn" title="They reach the requested spot before the puck gets back to them, so the shot happens later, from wherever they are once they have it">⚠ no puck yet there — shoots at ${rec.t.toFixed(1)} s${eff != null ? `, ${eff} ft along their path` : ''}</span>${snap}`
      : ev.by === 'receiver' ? ` <span class="warn" title="The passer can't release early enough for the puck to get there in time, so it arrives later, where the receiver is once it lands">⚠ can't arrive that early — lands at ${rec.arrive.toFixed(1)} s${eff != null ? `, ${eff} ft along their path` : ''}</span>${snap}`
      : ` <span class="warn" title="They pass the requested spot before the puck reaches them, so the pass waits until they have it and goes from where they are then">⚠ no puck yet there — goes at ${rec.t.toFixed(1)} s${eff != null ? `, ${eff} ft along their path` : ''}</span>${snap}`;
    const status = problem ? `<span class="warn">⚠ ${problem}</span>`
      : `<span class="muted">${ev.type === 'pass' && ev.by === 'receiver' ? `arrives t = ${rec.arrive.toFixed(1)} s` : `t = ${rec.t.toFixed(1)} s`}</span>${late}`;
    const onPath = ev.dist != null;
    const where = (prefix = 'at ') => onPath
      ? `<span>${prefix.trim()}</span><input class="wp" type="number" min="0" step="0.5" data-ev="${i}" data-evprop="dist" value="${ev.dist}" title="Feet along the skater's path"><span>ft on path</span>`
      : `<span>${prefix}waypoint</span><input class="wp" type="number" min="0" step="1" data-ev="${i}" data-evprop="wp" value="${ev.wp ?? 0}" title="0 = skater's start, 1… = path waypoints">`;
    const canMark = !!getObj(eventSkater(o, i))?.path?.length; // only a moving skater has a path to mark
    const mark = `<button data-act="mark" data-ev="${i}" ${canMark ? '' : 'disabled'} title="Click a spot on the skater's path to mark where this happens (you can also drag the marker on the ice)">📍 ${onPath ? 'Move mark' : 'Mark on path'}</button>`
      + (onPath ? `<button data-act="unmark" data-ev="${i}" title="Time this by waypoint instead">${icon('x')}</button>` : '');
    let body;
    if (ev.type === 'pass') {
      const rcv = getObj(ev.to);
      const byReceiver = ev.by === 'receiver';
      // Timing choice only matters when the receiver moves (or is already in use).
      const bySel = rcv && (rcv.path?.length || byReceiver)
        ? `<select data-ev="${i}" data-evprop="by" title="Time the pass by where the passer is when it leaves, or by where the receiver should get it">
             <option value="carrier" ${byReceiver ? '' : 'selected'}>released when ${who} is at</option>
             <option value="receiver" ${byReceiver ? 'selected' : ''}>arriving as ${playerName(rcv)} reaches</option></select>`
        : `<span>released when ${who} is at</span>`;
      const arrive = rec?.ok && byReceiver ? `<span class="muted">(leaves at t = ${rec.t.toFixed(1)} s, arrives ${rec.arrive.toFixed(1)} s)</span>` : '';
      // Off the boards: the receiver may then be the passer themselves.
      const bankUI = `<label class="check"><input type="checkbox" data-ev="${i}" data-evprop="bank" ${ev.bank ? 'checked' : ''}> off the boards</label>`
        + (ev.bank ? `<button data-act="bounce" data-ev="${i}" title="Click near the boards to set where the puck bounces (or drag the B marker on the ice)">Bounce point…</button><span class="wp-pos"><input class="wp-xy" type="number" step="any" data-ev="${i}" data-evprop="bankx" value="${G.round1(ev.bank.x)}" title="bounce x (ft)"><input class="wp-xy" type="number" step="any" data-ev="${i}" data-evprop="banky" value="${G.round1(ev.bank.y)}" title="bounce y (ft)"></span>` : '');
      const arrivesAt = rec?.ok && rec.to ? `<span class="muted" title="Where the pass arrives — drag the → marker on the ice along the receiver's path to change it">arrives at (${G.round1(rec.to.x)}, ${G.round1(rec.to.y)})</span>` : '';
      body = `<span>${who} passes to</span><select data-ev="${i}" data-evprop="to">${skaterOptions(ev.to, '— receiver —', ev.bank ? null : rec?.carrier, rec?.carrier)}</select>${bankUI}${bySel}${where('')}${arrive}${arrivesAt}${mark}`;
    }
    else if (ev.type === 'shoot') {
      const bankUI = `<label class="check"><input type="checkbox" data-ev="${i}" data-evprop="bank" ${ev.bank ? 'checked' : ''}> off the boards</label>`
        + (ev.bank ? `<button data-act="bounce" data-ev="${i}" title="Click near the boards to set where the puck bounces (or drag the B marker on the ice)">Bounce point…</button><span class="wp-pos"><input class="wp-xy" type="number" step="any" data-ev="${i}" data-evprop="bankx" value="${G.round1(ev.bank.x)}" title="bounce x (ft)"><input class="wp-xy" type="number" step="any" data-ev="${i}" data-evprop="banky" value="${G.round1(ev.bank.y)}" title="bounce y (ft)"></span>` : '');
      const tgt = ev.target
        ? `<span class="wp-pos"><input class="wp-xy" type="number" step="any" data-ev="${i}" data-evprop="tx" value="${G.round1(ev.target.x)}" title="target x (ft)"><input class="wp-xy" type="number" step="any" data-ev="${i}" data-evprop="ty" value="${G.round1(ev.target.y)}" title="target y (ft)"></span>`
        : '<span class="muted">nearest net</span>';
      body = `<span>${who}</span>${where()}<span>shoots at</span>${tgt}<button data-act="pick" data-ev="${i}">Pick target</button>${bankUI}${mark}`;
    }
    else body = `<select data-ev="${i}" data-evprop="skater">${skaterOptions(ev.skater, '— player —')}</select><span>picks it up</span>${where()}${mark}`;
    return `<div class="event">
      <div class="event-head">
        <select data-ev="${i}" data-evprop="type">${Object.entries(EV_TYPES).map(([k, v]) => `<option value="${k}" ${ev.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        ${status}<span class="spacer"></span>
        <button data-act="evup" data-ev="${i}" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
        <button data-act="evdown" data-ev="${i}" ${i === evs.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
        <button data-act="evdel" data-ev="${i}">${icon('x')}</button>
      </div>
      <div class="event-body">${body}</div>
    </div>`;
  }).join('');
  const steal = ps.info.steal;
  const stealNote = steal ? `<p class="muted">💥 Stolen at t = ${steal.t.toFixed(1)} s: ${playerName(getObj(steal.from))} loses it to ${playerName(getObj(steal.to))} (impact loser).</p>` : '';
  return `${stealNote}<label class="field inline"><span>Starts with</span><select data-prop="carrier">${skaterOptions(o.carrier, o.pile ? 'In the puck pile' : 'Loose on the ice')}</select></label>
    <div class="field"><span>Events (in order)</span>${rows || '<p class="muted">No passes or shots yet.</p>'}</div>
    <div class="row"><button data-act="addpass">+ Pass</button><button data-act="addshoot">+ Shoot</button><button data-act="addpickup">+ Pickup</button></div>
    <p class="muted small">Waypoint numbers are shown on the ice while the puck is selected (0 = the skater's start). P / S / U markers on the path show where each pass, shot or pickup happens (R = where a receiver-timed pass arrives, B = a board bounce) — drag them to move them. Drag the puck onto a skater to hand it over.</p>`;
}

/**
 * The player (skater or coach) event `i` of puck `pk` is timed against: the carrier at that point, the pickup
 * player, or — for a pass timed by its receiver — the receiver.
 */
function eventSkater(pk, i) {
  const ev = pk?.events?.[i]; if (!ev) return null;
  const who = ev.type === 'pickup' ? ev.skater : (ev.type === 'pass' && ev.by === 'receiver') ? ev.to : sim.puck(pk.id).info[i]?.carrier;
  return who && isPlayer(getObj(who)) ? who : null;
}
/**
 * Where a deferred event really happens, in feet along the path of the player it is timed by: the sim can't
 * fire it before that player has the puck, so it slides to the spot they reach when they get it. Rounded up
 * so re-timing the event there is never a hair too early (which would leave it flagged late again).
 */
function effectiveDist(pk, i) {
  const rec = sim.puck(pk.id).info[i], who = eventSkater(pk, i);
  if (!rec?.ok || !rec.mark || !who) return null;
  const tm = sim.skater(who);
  return Math.ceil(G.projectOnPolyline(tm.dense, tm.cum, rec.mark).d * 10) / 10;
}
/** Distance (ft) along a skater's path of the point nearest to p. */
function pathDistanceAt(skaterId, p) {
  const tm = sim.skater(skaterId);
  return G.round1(G.projectOnPolyline(tm.dense, tm.cum, p).d);
}

/** Who holds the puck after all of its events. */
function finalCarrier(o) { const last = sim.puck(o.id).segs.at(-1); return last.kind === 'carried' ? last.carrier : null; }
function nearestSkater(p, exclude) {
  return drill().objects.filter(s => isPlayer(s) && s.id !== exclude).sort((a, b) => G.dist(a, p) - G.dist(b, p))[0] || null;
}

const propsBody = $('#props-body');
propsBody.addEventListener('focusin', () => store.beginPending());
propsBody.addEventListener('input', e => {
  const el = e.target; const key = el.dataset.prop; const o = sel && getObj(sel);
  if (!o) return;
  if (el.dataset.ev !== undefined) {
    const ev = o.events?.[+el.dataset.ev]; const k = el.dataset.evprop;
    if (!ev || !k) return;
    if (k === 'wp') ev.wp = Math.max(0, Math.round(+el.value || 0));
    else if (k === 'tx' || k === 'ty') { if (ev.target) ev.target[k[1]] = +el.value || 0; }
    else if (k === 'bankx' || k === 'banky') { if (ev.bank) ev.bank[k[4]] = +el.value || 0; } // (not 'bx'/'by': 'by' is the pass-timing select)
    else if (k === 'dist') ev.dist = el.value === '' ? null : Math.max(0, +el.value || 0);
    else if (k === 'bank') { if (el.checked) ev.bank = defaultBank(o, +el.dataset.ev); else delete ev.bank; }
    else if (k === 'by') {
      // wp/dist now refer to a different player's path: reset to a sensible default on it.
      if (el.value === 'receiver') ev.by = 'receiver'; else delete ev.by;
      delete ev.dist;
      const path = getObj(ev.by === 'receiver' ? ev.to : sim.puck(o.id).info[+el.dataset.ev]?.carrier)?.path?.length || 0;
      ev.wp = ev.by === 'receiver' ? Math.min(1, path) : path;
    }
    else if (k === 'type') { ev.type = el.value; if (ev.type === 'pickup' && !ev.skater) ev.skater = null; }
    else ev[k] = el.value || null;
    if (el.tagName === 'SELECT') el.blur(); // let the following 'change' re-render the row
    store.save(); renderCanvas(); renderAnimBar();
    return;
  }
  if (el.dataset.wpstopdur != null) { // full-stop hold length on a waypoint
    const pt = o.path?.[+el.dataset.wpstopdur]; if (!pt) return;
    const v = +el.value;
    if (v > 0) pt.stop = v; else delete pt.stop;
    store.save(); renderCanvas(); renderAnimBar();
    return;
  }
  if (el.dataset.wpx != null || el.dataset.wpy != null) { // waypoint moved by typing its coordinates
    const pt = o.path?.[+(el.dataset.wpx ?? el.dataset.wpy)]; if (!pt) return;
    pt[el.dataset.wpx != null ? 'x' : 'y'] = +el.value || 0;
    store.save(); renderCanvas(); renderAnimBar();
    return;
  }
  if (el.dataset.ptx != null || el.dataset.pty != null) { // polyline point moved by typing
    const pt = o.points?.[+(el.dataset.ptx ?? el.dataset.pty)]; if (!pt) return;
    pt[el.dataset.ptx != null ? 'x' : 'y'] = +el.value || 0;
    store.save(); renderCanvas(); renderAnimBar();
    return;
  }
  if (el.dataset.cue != null) { // words spoken at a waypoint (typing keeps the panel as is; the change event re-renders)
    if (el.dataset.cue === 'start') o.startCue = el.value;
    else { const pt = o.path?.[+el.dataset.cue]; if (!pt) return; pt.cue = el.value; }
    store.save(); renderCanvas(); renderAnimBar(); // the badge on the ice and the 🔊 button follow the text
    return;
  }
  if (!key) return;
  if (key === 'pilegive') {
    const player = getObj(el.value); el.value = '';
    if (player) { const pk = puckFromPile(o, player); commit(() => drill().objects.push(pk)); select(pk.id); renderProps(); }
    return;
  }
  if (key === 'follow') {
    // unfollowing keeps the copied route, so the skater becomes independent with the path they had
    if (el.value) o.follow = el.value; else delete o.follow;
    syncFollowers(drill());
    el.blur();
    store.save(); renderCanvas(); renderAnimBar();
    return;
  }
  if (key === 'triggerPlayer' || key === 'triggerWp') {
    if (key === 'triggerPlayer') { if (el.value) o.trigger = { player: el.value, wp: o.trigger?.wp ?? 1 }; else delete o.trigger; el.blur(); }
    else if (o.trigger) o.trigger.wp = Math.max(0, Math.round(+el.value || 0));
    store.save(); renderCanvas(); renderAnimBar();
    return;
  }
  o[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
  if (key === 'facing') o.facing = el.value === '' ? null : +el.value;
  if (key === 'carrier') { o.carrier = el.value || null; if (o.carrier) delete o.pile; el.blur(); }
  if (o.type === 'contact' && (key === 'a' || key === 'b')) { o[key] = el.value || null; el.blur(); }
  if (o.type === 'skater' && key === 'color') lastSkaterColor = o.color;
  if (key === 'side') { if (SIDES[o.side]) o.color = SIDES[o.side].color; else delete o.side; el.blur(); }
  if (key === 'followWp') { o.followWp = Math.max(0, Math.round(+el.value || 0)); syncFollowers(drill()); el.blur(); }
  if (key === 'followMeet' && !o.followMeet) delete o.followMeet;
  store.save(); renderCanvas(); renderAnimBar();
});
propsBody.addEventListener('change', () => { store.commitPending(); renderUI(); });
// Hovering a waypoint row lights its handle on the ice, so a buried waypoint can be found before it is removed.
const hotHandle = (row, on) => { if (!row || !sel) return; const h = objLayer.querySelector(`[data-id="${sel}"] .handle[data-handle="${row.dataset.wprow}"]`); h?.classList.toggle('hot', on); };
propsBody.addEventListener('mouseover', e => hotHandle(e.target.closest('.wp-item'), true));
propsBody.addEventListener('mouseout', e => hotHandle(e.target.closest('.wp-item'), false));
propsBody.addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  btn.blur(); // so renderProps() isn't skipped for "focus inside panel"
  if (btn.dataset.dact) { // whole-drill transforms (shown when nothing is selected)
    const a = btn.dataset.dact;
    if (a === 'mirrorX') mirrorDrill('x'); else if (a === 'mirrorY') mirrorDrill('y');
    else if (a === 'copyX') copyDrillMirrored('x'); else if (a === 'copyY') copyDrillMirrored('y');
    renderProps();
    return;
  }
  const o = sel && getObj(sel); if (!o) return;
  const evIndex = +btn.dataset.ev;
  if (btn.classList.contains('swatch')) {
    commit(() => { o[btn.dataset.prop] = btn.dataset.value; if (o.type === 'skater') lastSkaterColor = o.color; });
    return;
  }
  switch (btn.dataset.act) {
    case 'del': deleteObject(o.id); break;
    case 'dup': {
      const copy = JSON.parse(JSON.stringify(o)); copy.id = uid(); translateObj(copy, 4, 4);
      commit(() => drill().objects.push(copy)); select(copy.id); renderProps(); break;
    }
    case 'clearpath': commit(() => o.path = []); break;
    case 'extend': setTool('skater'); activeSkater = o.id; select(o.id); break;
    case 'focus': setView({ x: o.x - 2, y: o.y - 2, w: o.w + 4, h: o.h + 4 }); break;
    case 'readzone': readAloud([o.label || 'Zone', ...zoneLines(o)]); break;
    case 'rot90': commit(() => o.rot = ((o.rot || 0) + 90) % 360); break;
    case 'addgoalie': { const g = { id: uid(), ...makeGoalie(o) }; commit(() => drill().objects.push(g)); select(g.id); renderProps(); break; }
    case 'selgoalie': { const g = goalieOf(o); if (g) { select(g.id); renderProps(); } break; }
    case 'face45': commit(() => { const cur = Math.round(facingOf(o, drill().objects) * 180 / Math.PI); o.facing = ((cur + 45) % 360 + 360) % 360; }); break;
    case 'takepuck': { const pile = nearestPile(o); if (!pile) break; const pk = puckFromPile(pile, o); commit(() => drill().objects.push(pk)); select(pk.id); renderProps(); break; }
    case 'pivot': {
      const pt = o.path?.[+btn.dataset.wp]; if (!pt) break;
      // cycle: no pivot → 'L' (face swings left) → 'R' (face swings right) → no pivot
      commit(() => { if (!pt.pivot) pt.pivot = 'L'; else if (pt.pivot === 'L') pt.pivot = 'R'; else delete pt.pivot; });
      renderProps(); break;
    }
    case 'wpstop': {
      const pt = o.path?.[+btn.dataset.wp]; if (!pt) break;
      commit(() => { if (+pt.stop > 0) delete pt.stop; else pt.stop = 1; }); // toggle; tune the seconds in the input below
      renderProps(); break;
    }
    case 'snapdist': { // re-time a deferred event to where it actually happens
      const ev = o.events?.[evIndex]; const eff = effectiveDist(o, evIndex);
      if (ev && eff != null) { commit(() => ev.dist = eff); renderProps(); }
      break;
    }
    case 'ptdel': { const i = +btn.dataset.wp; if (!o.points || o.points.length <= 2 || !o.points[i]) break; commit(() => o.points.splice(i, 1)); renderProps(); break; }
    case 'wpdel': { // remove a waypoint from the list (same as double-clicking its handle on the ice)
      const i = +btn.dataset.wp; if (!o.path?.[i]) break;
      commit(() => o.path.splice(i, 1));
      renderProps(); break;
    }
    case 'cue': { // add (empty, ready to type) or remove the spoken cue at a point
      const k = btn.dataset.wp;
      const holder = k === 'start' ? o : o.path?.[+k]; if (!holder) break;
      const key = k === 'start' ? 'startCue' : 'cue';
      commit(() => { if (holder[key] != null) delete holder[key]; else holder[key] = ''; });
      renderProps();
      propsBody.querySelector(`input[data-cue="${k}"]`)?.focus();
      break;
    }
    case 'fitdrill': resizeDrillInto(o); renderProps(); break;
    case 'chasepuck': {
      const hit = nearestLoosePuck(o); if (!hit) break;
      const ev = { type: 'pickup', skater: o.id, wp: 0 };
      if (o.path?.length) { const tm = sim.skater(o.id); ev.dist = G.round1(G.projectOnPolyline(tm.dense, tm.cum, hit.at).d); }
      commit(() => { hit.pk.events ||= []; hit.pk.events.push(ev); });
      select(hit.pk.id); renderProps(); break;
    }
    case 'chipcorner': case 'chipboards': {
      const coach = o.type === 'coach' ? o : coachAtPile(o);
      const pile = o.type === 'pile' ? o : pileAtCoach(o);
      if (!coach || !pile) break;
      const pk = chipPuck(coach, pile, btn.dataset.act === 'chipboards');
      commit(() => drill().objects.push(pk));
      select(pk.id); renderProps(); break;
    }
    case 'givepuck': { const pk = { id: uid(), ...newPuck(o, o.id) }; commit(() => drill().objects.push(pk)); select(pk.id); renderProps(); break; }
    case 'selpuck': { const pk = drill().objects.find(p => p.type === 'puck' && p.carrier === o.id); if (pk) { select(pk.id); renderProps(); } break; }
    case 'addpass': case 'addshoot': case 'addpickup': {
      const carrier = finalCarrier(o);
      // The sim knows when possession changes hands — default new events to a player's first
      // waypoint after the puck's last event, so a chain (pass, get it back, shoot) doesn't pile up at the path end.
      const wpAfter = who => {
        const path = getObj(who)?.path || [];
        const last = sim.puck(o.id).info.at(-1);
        const tHave = last ? (last.arrive ?? last.t ?? 0) : 0;
        for (let w = 1; w <= path.length; w++) if (sim.wpTime(who, w) >= tHave - 1e-6) return w;
        return path.length;
      };
      const wp = !carrier ? 0 : o.events?.length ? wpAfter(carrier) : (getObj(carrier).path?.length || 0);
      let ev;
      if (btn.dataset.act === 'addpass') {
        const from = carrier ? sim.skaterPos(carrier, sim.wpTime(carrier, wp)) : o;
        const to = nearestSkater(from, carrier);
        ev = { type: 'pass', wp, to: to?.id || null };
        // A stationary passer (coach, waiting skater) feeding a moving receiver: time it by the receiver,
        // at the first waypoint they reach late enough for the puck to actually fly there.
        if (carrier && !getObj(carrier).path?.length && to?.path?.length) {
          ev.by = 'receiver';
          const speed = +o.passSpeed || DEFAULT_PASS_SPEED;
          const last = sim.puck(o.id).info.at(-1);
          const tHave = last ? (last.arrive ?? last.t ?? 0) : 0;
          const passer = getObj(carrier);
          ev.wp = to.path.length;
          for (let w = 1; w <= to.path.length; w++) {
            const q = to.path[w - 1];
            if (sim.wpTime(to.id, w) >= tHave + Math.hypot(q.x - passer.x, q.y - passer.y) / speed - 1e-6) { ev.wp = w; break; }
          }
        }
      } else if (btn.dataset.act === 'addshoot') {
        ev = { type: 'shoot', wp, target: null };
      } else {
        const at = sim.puckPos(o.id, Infinity);
        ev = { type: 'pickup', skater: carrier ? null : nearestSkater(at, null)?.id || null, wp: 0 };
      }
      // A pickup for a puck that starts loose belongs before everything else.
      const atFront = ev.type === 'pickup' && !o.carrier && !(o.events || []).some(x => x.type === 'pickup');
      commit(() => { o.events ||= []; atFront ? o.events.unshift(ev) : o.events.push(ev); }); renderProps(); break;
    }
    case 'evdel': commit(() => o.events.splice(evIndex, 1)); renderProps(); break;
    case 'evup': commit(() => { [o.events[evIndex - 1], o.events[evIndex]] = [o.events[evIndex], o.events[evIndex - 1]]; }); renderProps(); break;
    case 'evdown': commit(() => { [o.events[evIndex + 1], o.events[evIndex]] = [o.events[evIndex], o.events[evIndex + 1]]; }); renderProps(); break;
    case 'pick': pickTarget = { puckId: o.id, ev: evIndex, kind: 'target' }; $('#hint').textContent = 'Click on the ice to set the shot target (Esc to cancel)'; break;
    case 'bounce': pickTarget = { puckId: o.id, ev: evIndex, kind: 'bank' }; $('#hint').textContent = 'Click near the boards to set where the puck bounces (Esc to cancel)'; break;
    case 'mark': pickTarget = { puckId: o.id, ev: evIndex, kind: 'dist' }; $('#hint').textContent = "Click a spot on the skater's path to mark where the pass / shot happens (Esc to cancel)"; break;
    case 'unmark': commit(() => { delete o.events[evIndex].dist; }); renderProps(); break;
  }
});

function focusProp(key) {
  // Deferred: the browser moves focus on mousedown's default action, which would immediately blur the input.
  setTimeout(() => {
    renderProps();
    const el = propsBody.querySelector(`[data-prop="${key}"]`);
    if (el) { el.focus(); el.select?.(); }
  }, 0);
}

// ---------- practice library / import / export ----------
// Details tucked behind buttons: "+ Practice" (topbar) and "+ Drill" (viewbar) each open a popover.
const popovers = [];
function closePopovers() { for (const pop of popovers) pop.hidden = true; }
document.addEventListener('click', closePopovers);
function wirePopover(btnSel, popSel, focusSel) {
  const btn = $(btnSel), pop = $(popSel);
  popovers.push(pop);
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const show = pop.hidden;
    closePopovers();
    if (show) { pop.hidden = false; renderUI(); const el = $(focusSel); el.focus(); el.select?.(); }
  });
  pop.addEventListener('click', e => e.stopPropagation());
  pop.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); pop.hidden = true; btn.focus(); }
  });
}
wirePopover('#btn-new-practice', '#practice-pop', '#practice-date');
wirePopover('#btn-practices', '#plist-pop', '#plist-create');
/** Add a drill and open its list row in edit mode, name selected and ready to type over. */
function addDrillAndRename() {
  finishActive();
  const p = store.practice;
  const d = newDrill(p.drills.length + 1);
  commit(() => { p.drills.push(d); store.drillIndex = p.drills.length - 1; });
  sel = null; stopAnim();
  editingDrill = d.id;
  renderAll();
  const el = $('#drill-list li.editing .dname');
  if (el) { el.focus(); el.select(); }
}
$('#btn-dup-practice').addEventListener('click', () => {
  const copy = JSON.parse(JSON.stringify(store.practice));
  copy.id = uid(); copy.date = new Date().toISOString().slice(0, 10);
  copy.drills.forEach(d => { d.id = uid(); delete d.intro; delete d.upload; d.objects = cloneObjects(d.objects); });
  finishActive(); store.addPractice(copy); sel = null; stopAnim(); renderAll();
});
$('#btn-del-practice').addEventListener('click', () => {
  if (!confirm(`Delete practice "${practiceLabel(store.practice)}"? This cannot be undone.`)) return;
  store.deletePractice(store.data.currentId); sel = null; stopAnim(); renderAll();
});

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const safeName = s => (s || 'practice').replace(/[^\w\-]+/g, '_');

$('#btn-export').addEventListener('click', () => {
  const p = store.practice;
  download(`${safeName(practiceLabel(p))}.hpp.json`, new Blob([JSON.stringify({ format: 'hockey-practice-planner', version: 1, practice: p }, null, 2)], { type: 'application/json' }));
});
$('#btn-import').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const list = data.practice ? [data.practice] : data.practices ? data.practices : Array.isArray(data) ? data : [data];
    for (const p of list) {
      if (!p || !Array.isArray(p.drills)) throw new Error('Not a practice file');
      p.id = uid(); p.drills.forEach(d => { d.id = uid(); delete d.intro; delete d.upload; d.view = d.view || { ...VIEWS.full }; d.objects = cloneObjects(migrateDrill(d).objects); });
      finishActive(); store.addPractice(p); // each import is an edit, so it is auto-saved to the cloud too
    }
    sel = null; stopAnim(); renderAll();
  } catch (err) { alert('Import failed: ' + err.message); }
});

$('#btn-png').addEventListener('click', async () => {
  const d = drill();
  const svgStr = standaloneSVG(d, rinkSVG(), SVG_STYLE);
  const scale = 3;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml' }));
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = d.view.w * 6 * scale; c.height = d.view.h * 6 * scale;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    c.toBlob(b => download(`${safeName(practiceLabel(store.practice))}_${safeName(d.name)}.png`, b), 'image/png');
  };
  img.onerror = () => alert('PNG export failed');
  img.src = url;
});

// ---------- practice document (shared by print & presentation mode) ----------
/**
 * The window a drill is shown through outside the editor: its saved view, widened just enough that nothing
 * in the drill is cropped — a wheel zoom left in the editor must never cut a coach's animation short.
 */
function shareView(d) {
  // A focus area says exactly which space the drill is about: show that whole box, and nothing more.
  const boxes = d.objects.filter(o => o.type === 'focus' && o.w > 0 && o.h > 0);
  if (boxes.length) {
    const bx0 = Math.min(...boxes.map(b => b.x)) - 3, by0 = Math.min(...boxes.map(b => b.y)) - 3;
    const bx1 = Math.max(...boxes.map(b => b.x + b.w)) + 3, by1 = Math.max(...boxes.map(b => b.y + b.h)) + 3;
    return { x: G.round1(bx0), y: G.round1(by0), w: G.round1(bx1 - bx0), h: G.round1(by1 - by0) };
  }
  const v = { ...d.view };
  let x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.h;
  for (const q of drillPoints(d)) { x0 = Math.min(x0, q.x - 4); y0 = Math.min(y0, q.y - 4); x1 = Math.max(x1, q.x + 4); y1 = Math.max(y1, q.y + 4); }
  // never beyond a comfortable margin around the boards
  x0 = Math.max(-6, x0); y0 = Math.max(-6, y0); x1 = Math.min(RINK.W + 6, x1); y1 = Math.min(RINK.H + 6, y1);
  return { x: G.round1(x0), y: G.round1(y0), w: G.round1(x1 - x0), h: G.round1(y1 - y0) };
}
/** The drills the team actually gets: a hidden drill stays in the editor (to come back to) but is left out of the plan. */
const activeDrills = p => p.drills.filter(d => !d.hidden);
const parseStart = p => /^\d{1,2}:\d{2}$/.test(p.time || '') ? p.time.split(':').reduce((h, m) => +h * 60 + +m) : null;
// Every date and time the app shows is US format: mm/dd/yyyy @ hh:mm AM/PM (never the browser's locale).
const pad2 = n => String(n).padStart(2, '0');
const clock = m => `${pad2(((Math.floor(m / 60) + 11) % 12) + 1)}:${pad2(m % 60)}`; // minutes since midnight → "05:00"
const ampm = m => (Math.floor(m / 60) % 24) < 12 ? ' AM' : ' PM';
const clockFull = m => clock(m) + ampm(m);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "Mon 09/21/2026" (long: "Monday 09/21/2026") — the viewer always says which day of the week a practice is. */
const dayDate = (date, long = false) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return date || 'no date';
  const wd = WEEKDAYS[new Date(date + 'T12:00').getDay()];
  return `${long ? wd : wd.slice(0, 3)} ${usDate(date)}`;
};
const startLabel = x => { const m = parseStart(x); return m != null ? clockFull(m) : ''; };
/** A practice's date and start time: "Mon 09/21/2026 @ 05:00 PM". */
const whenLabel = (x, long = false) => `${dayDate(x.date, long)}${startLabel(x) ? ` @ ${startLabel(x)}` : ''}`;
/** A timestamp: "09/21/2026 @ 05:07 PM". */
const stamp = ms => { const d = new Date(ms); return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()} @ ${clockFull(d.getHours() * 60 + d.getMinutes())}`; };
const todayISO = () => { const n = new Date(); return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`; };
const longDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? dayDate(date, true) : (date || '');

$('#btn-print').addEventListener('click', () => {
  const p = store.practice;
  const drills = activeDrills(p);
  const rink = rinkSVG();
  const total = drills.reduce((a, d) => a + (+d.duration || 0), 0);
  const startMin = parseStart(p);
  let t = startMin;
  const drillRows = drills.map((d, i) => {
    const at = t; if (t != null) t += (+d.duration || 0);
    return `
      <div class="p-drill">
        <div class="p-head"><b>${i + 1}. ${escHtml(d.name)}</b><span class="p-meta">(${+d.duration || 0} minutes)</span>${at != null ? `<span class="p-time">${clockFull(at)}</span>` : ''}</div>
        ${standaloneSVG(d, rink, SVG_STYLE, shareView(d))}
        ${zoneRules(d).map(z => `<div class="p-rules"><b>${escHtml(z.label)}</b><ul>${z.lines.map(l => `<li>${escHtml(l)}</li>`).join('')}</ul></div>`).join('')}
        ${d.upload ? `<div class="p-meta">Video: uploaded clip, ${fmtSecs(d.upload.secs)} (in the app)</div>` : d.video && videoEmbed(d.video) ? `<div class="p-meta">Video: ${escHtml(d.video)}</div>` : ''}
        ${d.notes ? `<pre>${escHtml(d.notes)}</pre>` : ''}
      </div>`;
  }).join('');
  $('#print-area').innerHTML = `
    <div class="p-title">${escHtml(p.team || 'Practice')}</div>
    <div class="p-sub">${escHtml(whenLabel(p, true))}</div>
    ${p.coaches ? `<div class="p-sub">Coaches: ${escHtml(p.coaches)}</div>` : ''}
    <div class="p-overview">${drills.map(d => standaloneSVG(d, rink, SVG_STYLE, shareView(d))).join('')}</div>
    <div class="p-sub">${startMin != null ? `Start @ ${clockFull(startMin)}` : ''} <span class="p-meta">${drills.length} drills · ${total} min</span></div>
    <div class="p-cols">
    ${drillRows}
    <div class="p-drill"><div class="p-head"><b>* Dismissal</b>${startMin != null ? `<span class="p-time">${clockFull(startMin + total)}</span>` : ''}</div></div>
    </div>`;
  window.print();
});

// ---------- presentation mode: a read-only scroll-through at #view=<ownerUid>/<practiceId> ----------
// The owner opens it with 📺 Present; coaches listed in the practice's "Coach emails" open the same
// link, sign in with Google, and read the practice live from the owner's cloud account.
let presenting = false;
let presentAudience = 'coach'; // which link is open: /coach or /team — the same page; a coach on /coach can also leave feedback
let feedbackOn = false;        // this viewer may leave feedback on the practice on screen
let showingPractice = false;   // a practice (not a list or a message) fills the viewer
let presentOwner = 'local';    // whose account the shown practice (and its intro clips) belongs to
let presentUnsub = null, presentKey = null;
let cloudSync = null, cloudBackend = null; // set once Firebase boots (below)
let cloudBoot = 'loading', cloudBootError = ''; // 'loading' → 'ready' | 'failed' (SDK/config didn't load) | 'none' (no config: local-only)
let uploadsChecked = false; // pending intro uploads are retried once per session

/** A drill's video, collapsed to a button: the player only loads when tapped (data, and it takes the diagram's place on a phone). */
function videoBlockHTML(d) {
  if (d.upload) return `<div class="pr-video" data-upload="1"><button class="pr-video-btn wp-toggle">🎬 Watch video <span class="muted small">(${fmtSecs(d.upload.secs)})</span></button></div>`;
  const v = d.video ? videoEmbed(d.video) : null;
  return v ? `<div class="pr-video" data-src="${escHtml(v.src)}" data-kind="${v.kind}" data-host="${escHtml(v.host)}"><button class="pr-video-btn wp-toggle">🎬 Watch video <span class="muted small">(${escHtml(v.host)})</span></button></div>` : '';
}
function wireVideos(p) {
  for (const box of $$('#present-body .pr-video')) {
    const sec = box.closest('.pr-drill');
    const btn = box.querySelector('.pr-video-btn');
    const d = p.drills.find(x => x.id === sec.dataset.did);
    // A drill with a video and nothing drawn on the ice is the video: it opens by itself and the empty rink stays hidden.
    const videoOnly = !!d && !(d.objects || []).length;
    const label = () => box.dataset.upload ? `🎬 Watch video <span class="muted small">(${fmtSecs(d?.upload?.secs)})</span>` : `🎬 Watch video <span class="muted small">(${escHtml(box.dataset.host)})</span>`;
    const toggle = async ({ auto = false } = {}) => {
      const open = auto || !sec.classList.contains('video-open');
      sec.classList.toggle('video-open', open);
      box.querySelector('.video-box')?.remove();
      if (open) {
        sec._pause?.(); // the drill animation stops while the video is up
        if (box.dataset.upload) { // downloaded once, then kept on the phone
          btn.textContent = 'Loading…';
          const entry = await fetchUpload(presentOwner, p.id, d, (i, n) => { btn.textContent = `Downloading ${i} / ${n}…`; });
          if (!sec.classList.contains('video-open')) return; // closed while loading
          if (!entry) { btn.textContent = '⚠ video not available — tap ↻ to resync, or check the connection'; btn.hidden = false; sec.classList.remove('video-open'); layoutPresent(); return; }
          box.insertAdjacentHTML('beforeend', `<div class="video-box"><video src="${entry.url}" controls playsinline ${auto ? '' : 'autoplay'} preload="auto"></video></div>`); // an auto-opened player waits for a tap: phones block sound without one
        } else box.insertAdjacentHTML('beforeend', videoPlayerHTML({ kind: box.dataset.kind, src: box.dataset.src, host: box.dataset.host }));
      }
      btn.innerHTML = open ? '✕ Close video' : label();
      btn.hidden = videoOnly && open; // nothing to close back to
      layoutPresent();
    };
    btn.addEventListener('click', () => toggle());
    if (videoOnly) { sec.classList.add('video-only'); toggle({ auto: true }); }
  }
}
const REACTIONS = [['😀', 'Good'], ['🏒', 'Great hockey'], ['😍', 'Loved it'], ['🤩', 'Amazing']];
/** After practice: a tap on one of the four emoji is remembered on this phone and logged for the coach. */
function wireReactions(p) {
  const box = $('#present-body .pr-react'); if (!box) return;
  const key = `hpp.react.${p.id}`;
  let picked = null;
  try { picked = localStorage.getItem(key); } catch { /* fine */ }
  const btns = [...box.querySelectorAll('.pr-react-btn')];
  const note = box.querySelector('.pr-react-note');
  const show = () => btns.forEach(b => b.classList.toggle('picked', b.dataset.emoji === picked));
  show();
  if (picked) note.textContent = 'Thanks — tap another to change your pick.';
  box.addEventListener('click', e => {
    const b = e.target.closest('.pr-react-btn'); if (!b) return;
    picked = b.dataset.emoji;
    try { localStorage.setItem(key, picked); } catch { /* fine */ }
    show();
    const sent = logReaction(p, picked);
    note.textContent = sent === 'owner' ? 'That’s your own practice — coaches’ and families’ picks show up in your Views log.'
      : sent ? 'Thanks! Sent to the coach.' : 'Thanks! Sign in when you’re online to send it to the coach.';
  });
}
function presentHTML(p) {
  const fbBtn = key => feedbackOn ? `<button class="pr-fb wp-toggle" data-fb="${key}" title="Only the head coach sees what you write">💬 Feedback</button>` : '';
  const rink = rinkSVG();
  const drills = activeDrills(p);
  const total = drills.reduce((a, d) => a + (+d.duration || 0), 0);
  const startMin = parseStart(p);
  let t = startMin ?? 0; // no start time on the practice: the schedule runs from 0:00 instead of a clock time
  // Each drill's slot on the running clock — exactly when it starts and finishes (data-* feed the live "now" marker).
  const whenHTML = (at, dur) => startMin != null
    ? `<span class="pr-time" data-from="${at}" data-to="${at + dur}">${clock(at)}–${clockFull(at + dur)}</span><span class="pr-now" hidden></span>`
    : `<span class="pr-time" title="Minutes into practice — set a start time on the practice to get clock times">${at}–${at + dur} min in</span>`;
  return `
    <div class="pr-head">
    <div class="pr-team">${escHtml(p.team || 'Practice')}</div>
    <div class="pr-meta">${escHtml(whenLabel(p, true))}</div>
    ${p.coaches ? `<div class="pr-meta">Coaches: ${escHtml(p.coaches)}</div>` : ''}
    <div class="pr-meta">${drills.length} drills · ${total} min${startMin != null ? ` · start @ ${clockFull(startMin)}` : ''}</div>
    </div>
    ${drills.map((d, i) => {
      const at = t; t += (+d.duration || 0);
      if (isPSDrill(d)) {
        const tiles = (d.psElements || []).map(k => {
          const e = PS_ELEMENTS.find(x => x.key === k);
          return e ? `<figure class="pr-pstile" data-ps="${e.key}" title="${escHtml(e.desc)}"><canvas></canvas><figcaption>${escHtml(e.name)}</figcaption></figure>` : '';
        }).join('');
        return `
      <section class="pr-drill" data-did="${d.id}">
        <header><b>${i + 1}. ${escHtml(d.name)}</b><span class="pr-min">(${+d.duration || 0} min)</span>${whenHTML(at, +d.duration || 0)}</header>
        ${tiles ? `<div class="pr-psgrid">${tiles}</div>` : '<p class="muted">Technique work — elements on the whiteboard.</p>'}
        ${videoBlockHTML(d)}
        <div class="pr-text">${d.notes ? `<pre>${escHtml(d.notes)}</pre>` : ''}${fbBtn(d.id)}</div>
      </section>`;
      }
      return `
      <section class="pr-drill" data-did="${d.id}">
        <header><b>${i + 1}. ${escHtml(d.name)}</b><span class="pr-min">(${+d.duration || 0} min)</span>${whenHTML(at, +d.duration || 0)}</header>
        <div class="pr-fig" data-ar="${(shareView(d).w / shareView(d).h).toFixed(3)}">${standaloneSVG(d, rink, SVG_STYLE, shareView(d), { showPaths: d.showPaths !== false })}</div>
        ${videoBlockHTML(d)}
        <div class="pr-animbar">
          <button class="pr-play" title="Watch the drill">${icon('play')}</button>
          <input type="range" class="pr-tl" min="0" max="10" step="0.01" value="0">
          <span class="pr-timedisp muted small"></span>
          <span class="pr-break"></span>
          <select class="pr-speed" title="Playback speed">${['0.25', '0.5', '1', '2'].map(s => `<option value="${s}" ${+s === (+d.animSpeed || 1) ? 'selected' : ''}>${s}×</option>`).join('')}</select>
          <label class="check small"><input type="checkbox" class="pr-paths" ${d.showPaths !== false ? 'checked' : ''}> paths</label>
          ${hasVoice(d) ? `<button class="pr-voice wp-toggle ${voiceOn ? 'active' : ''}" title="${voiceOn ? 'Voice on — click to mute intros and cues' : 'Voice muted on this device — click to hear intros and cues'}">${voiceOn ? '🔊 voice' : '🔇 muted'}</button>` : ''}
          <span class="pr-impact"></span>
        </div>
        <div class="pr-text"><div class="pr-cue" hidden></div>
        ${rulesHTML(d)}
        ${d.notes ? `<pre>${escHtml(d.notes)}</pre>` : ''}${fbBtn(d.id)}</div>
      </section>`;
    }).join('')}
    <section class="pr-drill pr-dismissal">
      <header><b>* Dismissal</b>${startMin != null ? `<span class="pr-time">${clockFull(startMin + total)}</span>` : `<span class="pr-time">${total} min in</span>`}</header>
      <div class="pr-react">
        <div class="pr-react-q">How was practice?</div>
        <div class="pr-react-row">${REACTIONS.map(([e, name]) => `<button class="pr-react-btn" data-emoji="${e}" title="${name}" aria-label="${name}">${e}</button>`).join('')}</div>
        <div class="pr-react-note muted small"></div>
      </div>
      ${feedbackOn ? `<div class="pr-text">${fbBtn('overall').replace('💬 Feedback', '💬 Overall feedback')}</div>` : ''}
    </section>`;
}

/** The stations' titles and constraints under a drill card, with a button that reads them out in order. */
function rulesHTML(d) {
  const zones = zoneRules(d);
  if (!zones.length) return '';
  let k = 0;
  return `<div class="pr-rules">
    <div class="pr-rules-head"><b>${zones.length > 1 ? 'Stations' : 'Rules'}</b>${canSpeak ? '<button class="pr-read wp-toggle" title="Read the title and constraints aloud, one at a time">🔊 Read rules</button>' : ''}</div>
    ${zones.map(z => `<div class="pr-rule" style="border-color:${escHtml(z.color)}"><div class="pr-rule-title" data-line="${k++}">${escHtml(z.label)}</div>
      <ol>${z.lines.map(l => `<li data-line="${k++}">${escHtml(l)}</li>`).join('')}</ol></div>`).join('')}
  </div>`;
}
function wireRules(sec) {
  const btn = sec.querySelector('.pr-read');
  if (!btn) return;
  const lines = [...sec.querySelectorAll('[data-line]')];
  const idle = () => { btn.classList.remove('reading'); btn.textContent = '🔊 Read rules'; lines.forEach(l => l.classList.remove('speaking')); };
  btn.addEventListener('click', () => {
    if (btn.classList.contains('reading')) { stopReading(); return; }
    btn.classList.add('reading'); btn.textContent = '■ Stop';
    readAloud(lines.map(l => l.textContent), { onLine: k => lines.forEach((l, i) => l.classList.toggle('speaking', i === k)), onDone: idle });
  });
}
function presentDoc(p) {
  $('#present-title').textContent = practiceLabel(p) + (who.persona === 'planner' ? ` · ${presentAudience} view` : '');
  if (!showingPractice) { showingPractice = true; applyPresentMode(); }
  $('#present-body').innerHTML = presentHTML(p);
  wirePresentAnims(p);
  $('#present-gate').hidden = true;
  presentNote('');
  // Rink mode: opening a practice lands on the drill that's happening right now (by the practice clock);
  // a live update while viewing keeps the coach on the drill they were looking at.
  if (presentShownId !== p.id) { presentShownId = p.id; presentIndex = drillNowIndex(p); }
  presentPractice = p;
  showDrill(presentIndex);
  wireReactions(p);
  wireVideos(p);
  watchListViews(p);
  flushViewQueue();
  loadMyFeedback(p);
  clearInterval(nowTimer); nowTimer = setInterval(tickNow, 15000); tickNow();
  paintWhen();
}
let presentPractice = null; // the practice on screen, for the audit log
/** While the practice is happening (its date is today), the drill on the clock right now says so, with the minutes it has left. */
let nowTimer = 0;
function tickNow() {
  paintWhen(); // midnight moves the calendar on
  const p = presentPractice, now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const min = now.getHours() * 60 + now.getMinutes();
  for (const el of $$('#present-body .pr-time[data-from]')) {
    const on = !!p && p.date === today && min >= +el.dataset.from && min < +el.dataset.to;
    const tag = el.nextElementSibling;
    el.classList.toggle('now', on);
    if (tag?.classList.contains('pr-now')) { tag.hidden = !on; if (on) tag.textContent = `now · ${+el.dataset.to - min} min left`; }
  }
}
/** Status line under the presentation top bar (e.g. "Offline copy from …"); '' hides it. */
function presentNote(text) {
  $('#present-note').textContent = text;
  $('#present-note').hidden = !text;
}

// Each drill card gets its own little player: ▶/⏸, a scrubber and the drill clock,
// driving animateFrame() on that card's SVG copy of the drill.
const presentAnims = [];
const presentPSTiles = []; // little looping 3D viewers on power skating cards
let presentPSObserver = null; // runs a tile's loop only while it is actually on screen
function stopPresentAnims() {
  hushVoice();
  for (const a of presentAnims) { cancelAnimationFrame(a.raf); if (a.intro) { a.intro.cancelled = true; a.intro.stop(); } }
  presentAnims.length = 0;
  for (const v of presentPSTiles) v.stop();
  presentPSTiles.length = 0;
  presentPSObserver?.disconnect(); presentPSObserver = null;
}
/**
 * Split a card's diagram into a static layer and a moving one. The rendered SVG keeps the rink, paths and
 * equipment — painted once — while everything that moves during playback (player bodies, pucks, the pad
 * slabs above them, the shot echoes above goalies, impact bursts) is moved into a transparent overlay SVG
 * on top. A frame then repaints a handful of shapes instead of the whole diagram — the difference between
 * smooth and stuttering on a phone, where inline SVG repaints in full on any change.
 */
function splitLayers(fig, svgEl) {
  fig.querySelector('.pr-overlay')?.remove();
  const overlay = svgEl.cloneNode(false); // same viewBox / size, no content
  overlay.classList.add('pr-overlay');
  overlay.innerHTML = `<style>${SVG_STYLE}</style>`;
  for (const el of svgEl.querySelectorAll('.puck-disc, [data-skater], .raisedpad-top, .shot-overlay, .obj.focus')) overlay.appendChild(el); // document order keeps their stacking; the focus mask dims moving skaters outside its box too
  const fx = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  overlay.appendChild(fx);
  fig.appendChild(overlay);
  return fx;
}
function wirePresentAnims(p) {
  stopPresentAnims();
  // power skating cards: a looping mini 3D demo per element — but only while the tile is on screen
  // (a card that is hidden or scrolled away would otherwise keep burning CPU on every frame)
  presentPSObserver = new IntersectionObserver(entries => {
    for (const e of entries) { const v = e.target._ps; if (v && e.isIntersecting !== v.playing) v.toggle(); }
  }, { threshold: 0.05 });
  for (const fig of $$('#present-body .pr-pstile')) {
    const v = createPSView(fig.querySelector('canvas'), { wheel: false }); // wheel scrolls the page, drag still orbits
    v.setElements([fig.dataset.ps]);
    fig._ps = v;
    presentPSTiles.push(v);
    presentPSObserver.observe(fig);
  }
  const rinkStr = rinkSVG();
  for (const d of p.drills) if (d.intro) fetchClip(presentOwner, p.id, d); // intros ready in memory before the first tap
  for (const sec of $$('#present-body .pr-drill[data-did]')) {
    wireRules(sec); // rules-only stations have no animation but do have something to say
    const d = p.drills.find(x => x.id === sec.dataset.did);
    const fig = sec.querySelector('.pr-fig');
    let svgEl = fig?.querySelector(':scope > svg');
    const bar = sec.querySelector('.pr-animbar');
    if (!d || !svgEl || !bar) continue;
    // The card animates a local view of the drill, so a coach's tweaks (impact loser) never touch the practice.
    const dcur = { ...d };
    let sm = makeSim(dcur);
    let T = sm.duration();
    wirePinchZoom(fig);
    if (T <= 0) { // nothing moves in this drill — but a recorded intro still gets a play button
      if (d.intro) {
        bar.innerHTML = `<button class="pr-play" title="Play the coach’s intro">${icon('play')}</button><span class="muted small">🎙 coach’s intro</span>`;
        const ib = bar.querySelector('.pr-play'); let cur = null;
        ib.addEventListener('click', async () => {
          if (cur) { cur.stop(); return; }
          const entry = await fetchClip(presentOwner, p.id, d);
          if (!entry) return;
          ib.innerHTML = icon('pause');
          cur = playClip(entry, { onEnd: () => { cur = null; ib.innerHTML = icon('play'); } });
        });
      } else bar.remove();
      continue;
    }
    let full = T; // cards park on the final positions; ▶ restarts from the top
    let fx = splitLayers(fig, svgEl);
    wirePinchZoom(fig);
    const btn = bar.querySelector('.pr-play'), tl = bar.querySelector('.pr-tl'), disp = bar.querySelector('.pr-timedisp');
    const cueEl = sec.querySelector('.pr-cue');
    let voice = makeNarrator(drillCues(dcur, sm), text => { cueEl.textContent = text; cueEl.hidden = !text; });
    bar.querySelector('.pr-voice')?.addEventListener('click', () => setVoice(!voiceOn));
    let spd = +d.animSpeed || 1; // seeded from the drill's saved playback speed
    bar.querySelector('.pr-speed')?.addEventListener('change', e => spd = +e.target.value);
    bar.querySelector('.pr-paths')?.addEventListener('change', e => { // re-render this card with paths on/off
      const tmp = document.createElement('div');
      tmp.innerHTML = standaloneSVG(dcur, rinkStr, SVG_STYLE, shareView(dcur), { showPaths: e.target.checked });
      const fresh = tmp.firstElementChild;
      svgEl.replaceWith(fresh);
      svgEl = fresh;
      fx = splitLayers(fig, svgEl);
      fig.classList.remove('zoomed'); // the fresh copy is back at the full view
      draw();
      layoutPresent(); // a rotated / landscape diagram is sized inline; the fresh copy needs it again
    });
    // "Impact: worse for" — same control as the editor's animation bar, when the drill has real impacts
    const impacts = sm.contacts();
    const linked = [...new Set(impacts.flatMap(c => [c.a, c.b]))].filter(id => dcur.objects.find(o => o.id === id)?.type === 'skater');
    if (linked.length) {
      bar.querySelector('.pr-impact').innerHTML = `<label class="check small">Impact: worse for <select class="pr-loser">
        <option value="">— even —</option>${linked.map(id => loserOption(dcur.objects.find(x => x.id === id), dcur.impactLoser === id)).join('')}</select></label>`;
      bar.querySelector('.pr-loser').addEventListener('change', e => {
        dcur.impactLoser = e.target.value || null;
        sm = makeSim(dcur); // the loser's slowdown changes the drill's timing
        voice = makeNarrator(drillCues(dcur, sm), text => { cueEl.textContent = text; cueEl.hidden = !text; });
        T = sm.duration();
        full = T;
        tl.max = T;
        a.t = Math.min(a.t, full);
        draw();
      });
    }
    tl.max = T;
    const a = { raf: 0, t: 0, playing: false, last: 0 };
    presentAnims.push(a);
    let shown = null; // only rewrite the icon when the state flips — replacing it every frame eats clicks
    const draw = () => {
      animateFrame(dcur, sm, fig, fx, a.t, a.playing); // the figure spans both layers
      tl.value = Math.min(a.t, T);
      disp.textContent = `${Math.min(a.t, T).toFixed(1)} / ${T.toFixed(1)} s`;
      const busy = a.playing || !!a.intro;
      if (shown !== busy) { shown = busy; btn.innerHTML = icon(busy ? 'pause' : 'play'); btn.title = busy ? 'Pause' : 'Watch the drill'; }
    };
    const step = now => {
      if (!a.playing) return;
      const prev = a.fresh ? -1 : a.t; // a cue at 0.0 s fires on the first frame of a fresh start
      a.fresh = false;
      a.t += Math.min(0.1, (now - a.last) / 1000) * spd; a.last = now;
      if (a.t >= full) { a.t = full; a.playing = false; }
      draw();
      voice.step(prev, a.t);
      if (a.playing) a.raf = requestAnimationFrame(step);
    };
    btn.addEventListener('click', () => {
      if (a.intro) { a.intro.cancelled = true; a.intro.stop(); return; } // ⏸ during the intro skips it, parked at the start
      if (a.playing) { a.playing = false; cancelAnimationFrame(a.raf); voice.clear(); draw(); return; }
      primeVoice();
      logDrillView(p, d.id, 'play');
      if (a.t >= full) a.t = 0;
      const go = () => { a.fresh = a.t === 0; a.playing = true; a.last = performance.now(); a.raf = requestAnimationFrame(step); draw(); };
      // From the top with a recorded intro (and voice on): the coach speaks first, then the drill runs.
      if (a.t === 0 && !voiceOn && hasVoice(d)) { cueEl.textContent = '🔇 voice is muted on this phone — tap 🔇 muted to hear the intro and cues'; cueEl.hidden = false; setTimeout(() => { cueEl.hidden = true; }, 4000); }
      const clip = a.t === 0 && voiceOn && d.intro ? clipMem.get(keyFor(presentOwner, p.id, d)) : null;
      if (!clip) {
        if (a.t === 0 && voiceOn && d.intro) { cueEl.textContent = '🎙 intro not downloaded yet — tap ↻ to resync'; cueEl.hidden = false; setTimeout(() => { cueEl.hidden = true; }, 3500); }
        go(); return;
      }
      if (!canPlay(clip.mime)) { cueEl.textContent = `🎙 intro can’t play on this device (${clip.mime})`; cueEl.hidden = false; setTimeout(() => { cueEl.hidden = true; }, 4000); go(); return; }
      cueEl.textContent = '🎙 Coach’s intro…'; cueEl.hidden = false;
      a.intro = playClip(clip, { onEnd: err => {
        const skip = a.intro?.cancelled; a.intro = null;
        if (err) { cueEl.textContent = `🎙 intro didn’t play — ${err}`; setTimeout(() => { cueEl.hidden = true; }, 4000); } else cueEl.hidden = true;
        if (skip) draw(); else go();
      } });
      draw();
    });
    tl.addEventListener('input', () => { a.t = +tl.value; draw(); });
    // On a phone the diagram itself is the biggest play button there is.
    fig.addEventListener('click', () => { if (!fig.classList.contains('zoomed')) btn.click(); });
    sec._pause = () => { if (a.intro) { a.intro.cancelled = true; a.intro.stop(); } if (a.playing) btn.click(); }; // leaving the drill in rink mode parks it
    draw();
  }
}
/** A message card over the viewer. `opts`: signIn / reload / request (show that control), list: '/coach' (a link back to their practices). */
function presentMsg(msg, opts = {}) {
  $('#present-gate').hidden = false;
  $('#present-msg').textContent = msg;
  $('#present-signin').hidden = !opts.signIn;
  $('#present-reload').hidden = !opts.reload;
  $('#present-request').hidden = !opts.request;
  $('#present-tolist').hidden = !opts.list;
  if (opts.list) $('#present-tolist').dataset.to = opts.list;
  // Signed in but stuck on a message (usually: the wrong Google account for this link) — say who, and offer the way out.
  const u = cloudSync?.user, quiet = msg === 'Loading…' || msg === CHECKING;
  $('#present-switch').hidden = !u || quiet;
  $('#present-who').textContent = u && !quiet ? `Signed in as ${u.email || u.name}` : '';
}
const CHECKING = 'Checking your sign-in…';
/** Sign out of the viewer. The offline practice copies on this device go too: they belong to the account that could read them. */
async function presentSignOut() {
  closeAcct();
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('hpp.viewcache.') || k.startsWith('hpp.inbox.')) localStorage.removeItem(k); } catch { /* storage blocked */ }
  try { localStorage.removeItem(viewQueueKey); } catch { /* fine */ }
  leavePractice();
  try { await cloudSync?.signOut(); } catch (e) { presentMsg(`Sign-out failed: ${e?.message || e}`); }
}
function openAcct() {
  const u = cloudSync?.user; if (!u) return;
  $('#present-acct-who').textContent = u.email && u.name !== u.email ? `${u.name} · ${u.email}` : u.name;
  $('#present-acct').hidden = false;
}
function closeAcct() { $('#present-acct').hidden = true; }

// ---------- audit log: who looked at which drill, and when ----------
// Each viewer appends records to users/{owner}/practices/{pid}/views (rules: append-only in their own name;
// the owner alone reads them). A "view" is a drill card on screen for 2 s; a "play" is its ▶. One record per
// drill / action / viewer per 5 minutes, so a coach flipping back and forth doesn't flood the log.
// Records that can't be written right away (offline at the rink) wait in localStorage for the next load.
const VIEW_GAP = 5 * 60 * 1000;
const viewLogged = new Map(); // `${pid}:${did}:${action}` → last logged ms
let viewTimer = 0;
const viewQueueKey = 'hpp.viewqueue';
function logDrillView(p, did, action) {
  if (!cloudBackend?.logView || !cloudSync?.user) return; // nobody to log as (offline copies with no session are anonymous)
  if (who.persona === 'planner') return; // the planner's own previews aren't audience views
  const d = p.drills.find(x => x.id === did); if (!d) return;
  const key = `${p.id}:${did}:${action}`;
  const now = Date.now();
  if (now - (viewLogged.get(key) || 0) < VIEW_GAP) return;
  viewLogged.set(key, now);
  const u = cloudSync.user;
  const entry = { uid: u.uid, email: (u.email || '').toLowerCase(), name: u.name || '', drillId: did, drillName: d.name, action, at: now,
    audience: presentAudience, device: matchMedia('(pointer: coarse)').matches ? 'phone' : 'desktop' };
  sendView(presentOwner, p.id, entry);
}
function logReaction(p, emoji) {
  if (!cloudBackend?.logView || !cloudSync?.user) return false;
  if (who.persona === 'planner') return 'owner';
  const key = `${p.id}:react:${emoji}`;
  const now = Date.now();
  if (now - (viewLogged.get(key) || 0) < VIEW_GAP) return true;
  viewLogged.set(key, now);
  const u = cloudSync.user;
  sendView(presentOwner, p.id, { uid: u.uid, email: (u.email || '').toLowerCase(), name: u.name || '', drillId: null, drillName: 'Dismissal', action: 'react', emoji, at: now,
    audience: presentAudience, device: matchMedia('(pointer: coarse)').matches ? 'phone' : 'desktop' });
  return true;
}
async function sendView(owner, pid, entry) {
  try { await cloudBackend.logView(owner, pid, entry); }
  catch { try { const q = JSON.parse(localStorage.getItem(viewQueueKey) || '[]'); q.push({ owner, pid, entry }); localStorage.setItem(viewQueueKey, JSON.stringify(q.slice(-200))); } catch { /* full: dropped */ } }
}
/** Retry records queued while offline — called once a signed-in session is up. */
async function flushViewQueue() {
  let q = [];
  try { q = JSON.parse(localStorage.getItem(viewQueueKey) || '[]'); } catch { q = []; }
  if (!q.length || !cloudBackend?.logView || !cloudSync?.user) return;
  localStorage.removeItem(viewQueueKey);
  for (const item of q) if (item.entry?.uid === cloudSync.user.uid) await sendView(item.owner, item.pid, item.entry);
}
/** The card on screen counts as viewed after it has been there 2 s (focus mode: the current card). */
function noteCurrentView(p) {
  clearTimeout(viewTimer);
  const sec = presentCards()[presentIndex];
  const did = sec?.dataset.did; if (!did) return;
  viewTimer = setTimeout(() => { if (presentCards()[presentIndex]?.dataset.did === did) logDrillView(p, did, 'view'); }, 2000);
}
let presentViewIO = null; // list mode: a card scrolled at least half into view for 2 s
function watchListViews(p) {
  presentViewIO?.disconnect();
  const timers = new Map();
  presentViewIO = new IntersectionObserver(entries => {
    for (const e of entries) {
      const did = e.target.dataset.did; if (!did) continue;
      clearTimeout(timers.get(did));
      if (e.isIntersecting && presentMode === 'list') timers.set(did, setTimeout(() => logDrillView(p, did, 'view'), 2000));
    }
  }, { threshold: 0.5 });
  for (const sec of $$('#present-body .pr-drill[data-did]')) presentViewIO.observe(sec);
}

// ---------- who is here, and the screen they get (docs/requirements-routing-auth.md; the matrix is resolveRoute in access.js) ----------
let authKnown = false;   // Firebase has said whether anyone is signed in
let signInError = '';
let viewerInbox;         // a non-planner's list document (inbox/{email}): undefined = not loaded yet, null = on no roster
let inboxUnsub = null, inboxFor = null, inboxTimer = 0, inboxStale = false;
let who = { persona: 'checking' };
let screen = { screen: 'checking' };
const inboxKey = email => `hpp.inbox.${email}`;
const ownerFlag = () => { try { return localStorage.getItem('hpp.owner') === '1'; } catch { return false; } };

/** { persona: 'checking' | 'offline' | 'anonymous' | 'planner' | 'coach' | 'team' | 'unknown', roles: { [practiceId]: 'coach' | 'team' } } */
function currentWho() {
  if (cloudBoot === 'none') return { persona: 'planner' }; // local-only install (no Firebase config): nothing to sign in to
  if (cloudBoot === 'loading') return { persona: 'checking' };
  // Cloud didn't load: the planner's own device still works offline; anyone else sees what this device kept, or an error.
  if (cloudBoot === 'failed') return { persona: ownerFlag() ? 'planner' : 'offline' };
  if (!authKnown) return { persona: 'checking' };
  const u = cloudSync?.user;
  if (!u) return { persona: 'anonymous' };
  if (isOwner(u)) return { persona: 'planner' };
  if (viewerInbox === undefined) return { persona: inboxStale ? 'offline' : 'checking' };
  if (!viewerInbox) return { persona: 'unknown' };
  const roles = Object.fromEntries(Object.entries(viewerInbox.practices || {}).map(([pid, c]) => [pid, c.role === 'coach' ? 'coach' : 'team']));
  return { persona: viewerInbox.persona === 'coach' ? 'coach' : 'team', roles };
}

/** Follow the signed-in viewer's list document live: being approved, or a practice being released, shows up without a reload. */
function watchInbox() {
  const u = cloudSync?.user;
  const email = u && !isOwner(u) ? String(u.email || '').toLowerCase() : null;
  if (email === inboxFor) return;
  inboxUnsub?.(); inboxUnsub = null; clearTimeout(inboxTimer);
  inboxFor = email; viewerInbox = undefined; inboxStale = false;
  if (!email || !cloudBackend?.subscribeInbox) return;
  try { viewerInbox = JSON.parse(localStorage.getItem(inboxKey(email)) || 'null') || undefined; } catch { viewerInbox = undefined; } // last known list: the rink has no signal
  inboxTimer = setTimeout(() => { if (viewerInbox === undefined) { inboxStale = true; refreshScreen(); } }, 8000);
  inboxUnsub = cloudBackend.subscribeInbox(email, (doc, err) => {
    clearTimeout(inboxTimer);
    if (inboxFor !== email) return;
    if (err) { if (viewerInbox === undefined) inboxStale = true; refreshScreen(); return; }
    viewerInbox = doc; inboxStale = false;
    try {
      if (doc) localStorage.setItem(inboxKey(email), JSON.stringify(doc));
      else for (const k of Object.keys(localStorage)) if (k === inboxKey(email) || k.startsWith('hpp.viewcache.')) localStorage.removeItem(k); // off every roster: the offline copies go too
    } catch { /* fine */ }
    refreshScreen();
  });
}

const viewCacheKey = pid => `hpp.viewcache.${pid}`;
function leavePractice() {
  stopPresentAnims(); presentUnsub?.(); presentUnsub = null; presentKey = null; presentShownId = null; presentPractice = null;
  presentViewIO?.disconnect(); clearTimeout(viewTimer); clearInterval(nowTimer); closeFeedback();
  if (showingPractice) { showingPractice = false; $('#present-body').innerHTML = ''; applyPresentMode(); }
  paintWhen();
}
/** The copy of a practice this device kept from the last visit (rink mode) — shown with a note about why it is not live. */
function showCachedPractice(pid, note) {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(viewCacheKey(pid)) || 'null'); } catch { cached = null; }
  if (!cached?.p) return false;
  if (presentKey !== `cached/${pid}`) {
    leavePractice(); presentKey = `cached/${pid}`;
    (cached.p.drills || []).forEach(migrateDrill);
    presentOwner = cached.p.owner || 'local'; feedbackOn = false;
    presentDoc(cached.p);
  }
  presentNote(`Offline copy from ${stamp(cached.at)} — ${note}`);
  return true;
}

/** Put the right screen up for the URL and whoever is signed in; called at boot, on navigation and on every sign-in / list change. */
function refreshScreen() {
  who = currentWho();
  const waiting = who.persona === 'checking' || who.persona === 'offline';
  // Until we know who this is, only links from before paths existed and unknown paths move; everything else waits where it is.
  const decide = route => waiting && !(route.view === 'unknown' || (route.legacy && route.view !== 'root'))
    ? { screen: who.persona, as: route.view, pid: route.pid } : resolveRoute(route, who);
  let route = parseRoute(location);
  // Approved (or signed in to the right account) while on the request screen: carry on to the link they first opened.
  if (route.view === 'request' && ['coach', 'team', 'planner'].includes(who.persona)) {
    let wanted = null;
    try { wanted = sessionStorage.getItem('hpp.wanted'); sessionStorage.removeItem('hpp.wanted'); } catch { /* fine */ }
    if (wanted && parseRoute({ pathname: wanted }).view !== 'request') { history.replaceState(null, '', wanted); route = parseRoute(location); }
  }
  let r = decide(route);
  for (let i = 0; r.go && i < 5; i++) {
    if (r.go === '/request-access' && route.pid) { try { sessionStorage.setItem('hpp.wanted', location.pathname); } catch { /* fine */ } }
    history.replaceState(null, '', r.go); // replace: Back must not bounce through the redirect
    route = parseRoute(location); r = decide(route);
  }
  screen = r;
  presenting = r.screen !== 'editor';
  document.body.classList.toggle('presenting', presenting);
  syncEditor(!presenting);
  $('#present').hidden = !presenting;
  keepAwake(r.screen === 'practice');
  if (!presenting) { leavePractice(); return; }
  $('#present-user').textContent = cloudSync?.user?.name || '';
  $('#present-account').hidden = !cloudSync?.user;
  if (!cloudSync?.user) closeAcct();
  applyPresentMode();
  const offlineMsg = `Couldn't connect. Check your internet connection — a content blocker or a filtered Wi-Fi network can also stop it — then try again.${cloudBootError ? ` (${cloudBootError})` : ''}`;
  switch (r.screen) {
    case 'practice': showPractice(r); paintWhen(); break; // the list may have changed under an open practice (a newer one released)
    case 'list': leavePractice(); showList(r); break;
    case 'request': leavePractice(); showRequest(); break;
    case 'unavailable':
      leavePractice();
      if (!inboxStale) { try { localStorage.removeItem(viewCacheKey(r.pid)); } catch { /* fine */ } } // released no longer (or never): the offline copy goes too
      $('#present-title').textContent = '';
      presentMsg("This practice isn't available yet. It will show up in your list once your coach sends it out.", { list: `/${r.as}` });
      break;
    case 'signin':
      if (route.pid && showCachedPractice(route.pid, 'sign in when online to get updates.')) break;
      leavePractice(); $('#present-title').textContent = '';
      presentMsg(signInError ? `Sign-in failed: ${signInError}` : route.view === 'editor' || route.view === 'root'
        ? 'Sign in to continue.' : 'Practice plans are shared with the team. Sign in with the Google account your coach has on the team list.', { signIn: true });
      break;
    case 'offline':
      if (route.pid && showCachedPractice(route.pid, 'reconnect to get updates.')) break;
      leavePractice(); $('#present-title').textContent = '';
      presentMsg(offlineMsg, { reload: true });
      break;
    default: // checking
      if (route.pid && showCachedPractice(route.pid, 'checking for updates…')) break;
      leavePractice(); $('#present-title').textContent = '';
      presentMsg(CHECKING);
  }
}

/** One practice, as /coach/<id> or /team/<id> shows it. */
function showPractice(r) {
  const pid = r.pid;
  presentAudience = r.as;
  if (who.persona === 'planner') {
    // The planner previews their own practice straight from the store (drafts included, offline too) — as the audience would get it.
    const mine = store.data.practices.find(x => x.id === pid);
    if (mine) {
      const key = `mine/${r.as}/${pid}/${mine.updatedAt || 0}`;
      if (presentKey === key) return;
      presentUnsub?.(); presentUnsub = null; presentKey = key;
      presentOwner = ownerFor(); feedbackOn = false;
      presentDoc(publishedCopy(mine, ownerFor()));
      return;
    }
    if (!cloudBackend) { leavePractice(); presentMsg("This practice isn't on this device.", { list: `/${r.as}` }); return; }
  }
  const mayComment = r.as === 'coach' && who.roles?.[pid] === 'coach';
  const key = `live/${r.as}/${pid}/${mayComment}`;
  if (presentKey === key) return; // already watching this practice
  const hadCopy = showCachedPractice(pid, 'checking for updates…');
  presentUnsub?.(); presentUnsub = null;
  presentKey = key; feedbackOn = mayComment;
  if (!hadCopy) { leavePractice(); presentKey = key; feedbackOn = mayComment; presentMsg('Loading…'); }
  presentUnsub = cloudBackend.subscribePublished(pid, (p, err) => {
    if (presentKey !== key) return;
    if (err) {
      // Not (or no longer) on the list: the copy kept for offline use goes too, rather than outliving the access.
      if (err.code === 'permission-denied') {
        try { localStorage.removeItem(viewCacheKey(pid)); } catch { /* fine */ }
        leavePractice(); presentKey = key;
        presentMsg("This practice isn't available to you any more.", { list: `/${r.as}` });
      } else if (!showingPractice) presentMsg(`Could not load the practice: ${err.message || err}`, { reload: true });
      else presentNote('Offline — showing the copy on this device.');
      return;
    }
    if (!p) { try { localStorage.removeItem(viewCacheKey(pid)); } catch { /* fine */ } leavePractice(); presentKey = key; return presentMsg('This practice no longer exists.', { list: `/${r.as}` }); }
    (p.drills || []).forEach(migrateDrill);
    try { localStorage.setItem(viewCacheKey(pid), JSON.stringify({ p, at: Date.now() })); } catch { /* full/blocked storage: live view still works */ }
    presentOwner = p.owner || 'local'; feedbackOn = mayComment;
    presentDoc(p);
  });
}

/** The practices this person can open on /coach or /team: { pid, role, team, date, time }. The planner previewing one practice (`all`) can step through drafts too. */
function practiceItems(as) {
  if (who.persona === 'planner') {
    return store.data.practices.filter(p => as === 'team' ? stageOf(p) === 'team' : stageOf(p) !== 'draft')
      .map(p => ({ pid: p.id, role: as, stage: stageOf(p), team: p.team, date: p.date, time: p.time }));
  }
  return Object.entries(viewerInbox?.practices || {}).map(([pid, c]) => ({ pid, ...c }));
}
const itemPath = (as, x) => routePath({ view: as === 'coach' && x.role === 'coach' ? 'coach' : 'team', pid: x.pid }); // a coach's parent-only practices open as the team sees them

/**
 * Which practice is this? The bar under the top bar names the team and has a dropdown of dates to switch to any other
 * practice released to the team. And when the one on screen is not the one the calendar points at — the next practice (today's counts all
 * day), else the most recent — a red banner says so and jumps there: nobody runs last week's plan by mistake.
 */
let whenTarget = null;
function paintWhen() {
  const p = showingPractice ? presentPractice : null;
  const bar = $('#present-when'), warn = $('#present-warn'), sel = $('#when-select');
  const was = `${bar.hidden}${warn.hidden}`;
  if (!p) { bar.hidden = true; warn.hidden = true; whenTarget = null; }
  else {
    // The dropdown lists this team's practices that are released to the team — nothing that is still a draft or
    // with the coaches, and only the ones this person may open. The practice on screen is always in it, marked
    // when it is not one of those (a coach reading a plan out for feedback, the planner previewing a draft).
    const sameTeam = x => String(x.team || '').trim().toLowerCase() === String(p.team || '').trim().toLowerCase();
    const items = practiceItems(presentAudience).filter(x => sameTeam(x) && x.stage === 'team').sort(byCalendar);
    const listed = items.some(x => x.pid === p.id);
    const today = todayISO(), say = x => whenLabel(x);
    bar.hidden = false;
    $('#when-team').textContent = p.team || 'Practice';
    const opt = (x, extra = '') => `<option value="${escHtml(itemPath(presentAudience, x))}"${x.pid === p.id ? ' selected' : ''}>${escHtml(say(x))}${x.date === today ? ' · today' : ''}${extra}</option>`;
    sel.innerHTML = (listed ? '' : opt(p, ' · not yet released to the team')) + items.map(x => opt(x)).join('');
    const focus = listed ? calendarFocus(items, today) : null;
    whenTarget = focus && focus.pid !== p.id ? itemPath(presentAudience, focus) : null;
    warn.hidden = !whenTarget;
    if (whenTarget) {
      const upcoming = (focus.date || '') >= today;
      warn.textContent = `${byCalendar(p, focus) < 0 ? '⚠ This is an older practice' : '⚠ This is a future practice'} (${dayDate(p.date)}). `
        + `${upcoming ? (focus.date === today ? 'Today’s practice' : 'The next practice') : 'The most recent practice'} is ${say(focus)} — tap to open it.`;
    }
  }
  if (was !== `${bar.hidden}${warn.hidden}`) layoutPresent();
}
$('#when-select').addEventListener('change', e => { if (e.target.value && e.target.value !== location.pathname) navigate(e.target.value); });
$('#present-warn').addEventListener('click', () => { if (whenTarget) navigate(whenTarget); });

/** /coach and /team: every practice released to this person, upcoming first — one bookmark for the whole season. */
function showList(r) {
  const as = r.as;
  const items = practiceItems(as);
  const today = todayISO();
  const upcoming = items.filter(x => (x.date || '') >= today).sort(byCalendar), past = items.filter(x => (x.date || '') < today).sort(byCalendar).reverse();
  const row = x => `<a class="pl-item" href="${itemPath(as, x)}" data-nav>
      <b>${escHtml(x.team || 'Practice')}</b><span>${escHtml(whenLabel(x, true))}</span>
      ${x.date === today ? '<span class="pl-today">today</span>' : ''}</a>`;
  $('#present-title').textContent = who.persona === 'planner' ? `Practices — ${as} view` : 'Practices';
  $('#present-gate').hidden = true; presentNote(inboxStale ? 'Offline — this is the list from your last visit.' : '');
  $('#present-body').innerHTML = `<div class="pl-list">
    ${items.length ? '' : '<p class="muted">Nothing here yet — practices show up once your coach sends them out.</p>'}
    ${upcoming.length ? `<h2>Upcoming</h2>${upcoming.map(row).join('')}` : ''}
    ${past.length ? `<h2>Earlier</h2>${past.map(row).join('')}` : ''}
  </div>`;
  $('#present-scroll').scrollTop = 0;
}
$('#present-body').addEventListener('click', e => {
  const a = e.target.closest('a[data-nav]'); if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault(); navigate(a.getAttribute('href'));
});
$('#present-home').addEventListener('click', () => { if (['coach', 'team', 'planner'].includes(who.persona) && screen.as) navigate(`/${screen.as === 'coach' ? 'coach' : 'team'}`); });

// ---------- request access: someone signed in who is on no roster ----------
let myRequest;           // undefined = not loaded; null = none filed; else the requests/{uid} document
let myRequestFor = null;
async function showRequest() {
  $('#present-title').textContent = '';
  const u = cloudSync?.user; if (!u) return;
  const paint = () => {
    const open = myRequest?.status === 'open', denied = myRequest?.status === 'denied' && Date.now() < (myRequest.deniedAt || 0) + 7 * 86400000;
    presentMsg(open ? "Request sent — you'll get in as soon as the coach approves it. This page opens by itself once that happens."
      : denied ? 'Your request was not approved. If that seems wrong, talk to your coach.'
      : "This Google account isn't on the team list yet. Ask the coach for access — or switch to the account the coach has for you.", { request: !open && !denied });
  };
  if (myRequestFor !== u.uid) { myRequest = undefined; myRequestFor = u.uid; }
  $('#req-mail').href = `mailto:${OWNER_EMAILS[0]}?subject=${encodeURIComponent('Practice plan access')}&body=${encodeURIComponent(`Hi coach — please add my Google account (${u.email}) to the team list for the practice plans.\n\n${u.name || ''}`)}`;
  if (myRequest === undefined) {
    presentMsg('Loading…');
    try { myRequest = (await cloudBackend.loadRequest(u.uid)) || null; } catch { myRequest = null; }
    if (screen.screen !== 'request') return;
  }
  paint();
}
$('#req-send').addEventListener('click', async () => {
  const u = cloudSync?.user; if (!u) return;
  const req = { uid: u.uid, email: String(u.email || '').toLowerCase(), name: u.name || '', role: $('input[name="req-role"]:checked')?.value === 'coach' ? 'coach' : 'team',
    note: $('#req-note').value.trim().slice(0, 300), status: 'open', at: Date.now() };
  $('#req-send').disabled = true;
  try { await cloudBackend.saveRequest(u.uid, req); myRequest = req; showRequest(); }
  catch (e) { presentMsg(`Couldn't send the request: ${e?.message || e}`, { request: true }); }
  $('#req-send').disabled = false;
});

// ---------- coach feedback: one note per drill (and one overall), seen only by the planner ----------
let myFeedback = new Map(), myFeedbackFor = null, fbKey = null;
const fbId = key => `${cloudSync.user.uid}_${key}`;
async function loadMyFeedback(p) {
  if (!feedbackOn || !cloudSync?.user) return;
  if (myFeedbackFor !== p.id) {
    myFeedbackFor = p.id; myFeedback = new Map();
    try { for (const f of await cloudBackend.loadMyFeedback(p.id, cloudSync.user.uid)) myFeedback.set(f.drillId || 'overall', f); } catch { /* offline: buttons just start blank */ }
    if (presentPractice?.id !== p.id) return;
  }
  for (const b of $$('#present-body .pr-fb')) {
    const has = myFeedback.has(b.dataset.fb);
    b.classList.toggle('active', has);
    b.textContent = `${b.dataset.fb === 'overall' ? '💬 Overall feedback' : '💬 Feedback'}${has ? ' ✓' : ''}`;
  }
}
function openFeedback(key) {
  const p = presentPractice; if (!p || !feedbackOn) return;
  fbKey = key;
  const d = p.drills.find(x => x.id === key);
  $('#fb-title').textContent = d ? `Feedback — ${d.name}` : 'Overall feedback on this practice';
  $('#fb-text').value = myFeedback.get(key)?.text || '';
  $('#fb-del').hidden = !myFeedback.has(key);
  $('#fb-note').textContent = 'Only the head coach sees this.';
  $('#present-fb').hidden = false;
  if (!matchMedia('(pointer: coarse)').matches) $('#fb-text').focus();
}
function closeFeedback() { $('#present-fb').hidden = true; fbKey = null; }
$('#present-body').addEventListener('click', e => { const b = e.target.closest('.pr-fb'); if (b) openFeedback(b.dataset.fb); });
$('#present-fb').addEventListener('click', e => { if (e.target === e.currentTarget) closeFeedback(); });
$('#fb-cancel').addEventListener('click', closeFeedback);
$('#fb-send').addEventListener('click', async () => {
  const p = presentPractice, u = cloudSync?.user, text = $('#fb-text').value.trim();
  if (!p || !u || !fbKey) return;
  if (!text) { $('#fb-note').textContent = 'Write something first — or Delete to take your note back.'; return; }
  const d = p.drills.find(x => x.id === fbKey);
  const entry = { uid: u.uid, email: String(u.email || '').toLowerCase(), name: u.name || '', drillId: d ? d.id : '', drillName: d ? d.name : 'Overall', text: text.slice(0, 4000), at: Date.now() };
  $('#fb-note').textContent = 'Sending…';
  try { await cloudBackend.saveFeedback(p.id, fbId(fbKey), entry); myFeedback.set(fbKey, entry); closeFeedback(); loadMyFeedback(p); }
  catch (e) { $('#fb-note').textContent = `Couldn't send: ${e?.message || e}`; }
});
$('#fb-del').addEventListener('click', async () => {
  const p = presentPractice; if (!p || !fbKey) return;
  try { await cloudBackend.removeFeedback(p.id, fbId(fbKey)); myFeedback.delete(fbKey); closeFeedback(); loadMyFeedback(p); }
  catch (e) { $('#fb-note').textContent = `Couldn't delete: ${e?.message || e}`; }
});

// ---------- rink mode: the presentation on a phone, one drill at a time ----------
// Coaches read the plan on a phone at the bench: focus mode shows a single drill card filling the screen
// with glove-sized controls, prev/next + swipe to move through the practice, a jump list, an optional
// sideways diagram for a phone held upright, full screen, and a wake lock so the screen stays on.
let presentMode = null;      // 'focus' (one drill) | 'list' (the whole plan as a scroll-through)
let presentRotate = false;   // focus + portrait: draw the diagram turned 90° so the long side runs down the screen
let presentIndex = 0;        // which .pr-drill card is on screen in focus mode
let presentShownId = null;   // practice currently rendered — the "now" drill is only picked when this changes
try {
  presentMode = localStorage.getItem('hpp.viewmode');
  presentRotate = localStorage.getItem('hpp.viewrot') === '1';
} catch { /* storage blocked: defaults */ }
if (presentMode !== 'focus' && presentMode !== 'list') presentMode = matchMedia('(pointer: coarse)').matches ? 'focus' : 'list';

const presentCards = () => $$('#present-body .pr-drill');
const inLandscape = () => matchMedia('(orientation: landscape) and (max-height: 560px)').matches; // a phone on its side

/** Index of the drill that should be on screen right now: by the wall clock when the practice is today, else the first. */
function drillNowIndex(p) {
  const start = parseStart(p);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (start == null || p.date !== today) return 0;
  const min = now.getHours() * 60 + now.getMinutes();
  const drills = activeDrills(p);
  let t = start;
  for (let i = 0; i < drills.length; i++) { t += +drills[i].duration || 0; if (min < t) return i; }
  return drills.length; // practice is over: the dismissal card (clamped to the last drill if there is none)
}

function applyPresentMode() {
  const focus = presentMode === 'focus' && showingPractice; // a list or a message is an ordinary page
  $('#present-mode').hidden = !showingPractice;
  $('#present').classList.toggle('focus', focus);
  $('#present-nav').hidden = !focus;
  $('#present-mode').innerHTML = icon(focus ? 'list' : 'focus');
  $('#present-mode').title = focus ? 'Show the whole plan as a scroll-through' : 'One drill at a time (phone / rink mode)';
  $('#present-full').hidden = !document.documentElement.requestFullscreen; // iPhone Safari has no page fullscreen — add to Home Screen instead
  $('#present-rotate').classList.toggle('on', presentRotate);
  layoutPresent();
}
function setPresentMode(m) {
  presentMode = m;
  try { localStorage.setItem('hpp.viewmode', m); } catch { /* fine */ }
  applyPresentMode();
  if (m === 'focus') showDrill(presentIndex);
  else $('#present-scroll').scrollTop = 0;
}

/** Put card i on screen (focus mode); in list mode it just records the index and refreshes the nav. */
function showDrill(i) {
  const cards = presentCards();
  if (!cards.length) return;
  presentIndex = Math.max(0, Math.min(cards.length - 1, i));
  if (cards[presentIndex]?.classList.contains('current') === false) stopReading(); // moving to another drill
  cards.forEach((c, k) => {
    const cur = k === presentIndex;
    if (!cur && presentMode === 'focus') c._pause?.();
    c.classList.toggle('current', cur);
  });
  const nameOf = c => c.querySelector('header b')?.textContent || '';
  $('.pr-nav-count').textContent = `${presentIndex + 1} / ${cards.length}`;
  const next = cards[presentIndex + 1];
  $('.pr-nav-next').textContent = next ? `Next: ${nameOf(next)}` : 'End of practice';
  $('#present-prev').disabled = presentIndex === 0;
  $('#present-next').disabled = presentIndex === cards.length - 1;
  if (presentMode === 'focus') $('#present-scroll').scrollTop = 0;
  layoutPresent();
  if (presentMode === 'focus' && presentPractice) noteCurrentView(presentPractice);
}

/** Inline sizing for the two cases CSS can't do alone: the sideways portrait diagram and the phone-landscape row. */
function layoutPresent() {
  if (!presenting) return;
  const focus = presentMode === 'focus' && showingPractice;
  const landscape = focus && inLandscape();
  $('#present').classList.toggle('landscape', landscape);
  const scroll = $('#present-scroll');
  const curAr = +presentCards()[presentIndex]?.querySelector('.pr-fig')?.dataset.ar || 0;
  $('#present-rotate').hidden = !focus || landscape || curAr <= 1.05; // only offered when the diagram is wider than tall
  for (const sec of presentCards()) {
    const fig = sec.querySelector('.pr-fig'), layers = fig ? [...fig.querySelectorAll(':scope > svg')] : [];
    const player = sec.querySelector('.pr-video .video-box');
    if (player) player.style.cssText = '';
    if (!layers.length) {
      if (player && focus && sec.classList.contains('current') && !landscape) sizeMedia(sec, player, 16 / 9, scroll);
      continue;
    }
    fig.style.cssText = ''; layers.forEach(l => { l.style.cssText = ''; }); fig.classList.remove('rotated');
    if (!focus || !sec.classList.contains('current')) continue;
    if (player && sec.classList.contains('video-open')) { // the video takes the diagram's place
      if (landscape) player.style.width = `${Math.max(160, Math.min(scroll.clientWidth - 24 - 200, (scroll.clientHeight - 24) * 16 / 9))}px`;
      else sizeMedia(sec, player, 16 / 9, scroll);
      continue;
    }
    const ar = +fig.dataset.ar || 2.26;
    if (landscape) {
      // diagram fills the height, capped so the header / controls column beside it keeps ~200px
      const availH = scroll.clientHeight - 24, availW = scroll.clientWidth - 24 - 200;
      fig.style.width = `${Math.max(160, Math.min(availW, availH * ar))}px`;
      continue;
    }
    // Portrait: everything fits the screen with no scrolling. The name, play bar and nav keep their height;
    // the text box (cue, rules, notes) keeps a few lines and scrolls inside itself; the diagram gets the rest.
    const text = sec.querySelector('.pr-text');
    let used = 0;
    for (const el of sec.children) if (el !== fig && el !== text) used += el.offsetHeight;
    const textWant = text ? Math.min(text.scrollHeight, 88) : 0;
    const availH = Math.max(110, scroll.clientHeight - 16 - used - textWant - 28), availW = scroll.clientWidth - 24;
    if (presentRotate && ar > 1.05) {
      // turned 90°: the rink's long side runs down the phone. Box on screen is w × h; the svg is laid out h × w then rotated.
      const h = Math.min(availH, availW * ar), w = h / ar;
      fig.classList.add('rotated');
      fig.style.width = `${w}px`; fig.style.height = `${h}px`;
      layers.forEach(l => { l.style.width = `${h}px`; l.style.height = `${w}px`; });
    } else {
      fig.style.width = `${Math.min(availW, availH * ar)}px`;
    }
  }
}

/** Portrait focus mode: give one media box (an open video) the height left under the title and controls. */
function sizeMedia(sec, el, ar, scroll) {
  const text = sec.querySelector('.pr-text');
  let used = 0;
  for (const c of sec.children) if (c !== text && !c.contains(el) && c !== sec.querySelector('.pr-fig')) used += c.offsetHeight;
  used += el.parentElement.offsetHeight - el.offsetHeight; // the Close button above the player
  const textWant = text ? Math.min(text.scrollHeight, 88) : 0;
  const availH = Math.max(110, scroll.clientHeight - 16 - used - textWant - 28), availW = scroll.clientWidth - 24;
  el.style.width = `${Math.min(availW, availH * ar)}px`;
}
/**
 * Pinch-to-zoom inside a diagram. The page itself never zooms (touch-action locks it — a zoomed page is how
 * "it doesn't fit on my phone" happens); instead two fingers zoom the drill by shrinking both layers' viewBox
 * around the pinch, one finger pans while zoomed, and a double tap puts it back.
 */
function wirePinchZoom(fig) {
  if (fig._pinch) return;
  fig._pinch = true;
  const base = () => fig.querySelector(':scope > svg');
  const layers = () => fig.querySelectorAll(':scope > svg');
  const orig = () => { if (!fig.dataset.vb) fig.dataset.vb = base()?.getAttribute('viewBox') || ''; return fig.dataset.vb.split(' ').map(Number); };
  const cur = () => (base()?.getAttribute('viewBox') || '').split(' ').map(Number);
  const set = v => { const str = v.map(n => n.toFixed(2)).join(' '); layers().forEach(l => l.setAttribute('viewBox', str)); fig.classList.toggle('zoomed', v[2] < orig()[2] - 0.01); };
  const clamp = v => {
    const o = orig();
    v[2] = Math.min(o[2], Math.max(o[2] / 4, v[2])); v[3] = v[2] * o[3] / o[2];
    v[0] = Math.min(o[0] + o[2] - v[2], Math.max(o[0], v[0])); v[1] = Math.min(o[1] + o[3] - v[3], Math.max(o[1], v[1]));
    return v;
  };
  const toRink = (inv, cx, cy) => { const q = new DOMPoint(cx, cy).matrixTransform(inv); return { x: q.x, y: q.y }; };
  let pinch = null, pan = null, lastTap = 0;
  fig.reset = () => { set(orig()); pinch = pan = null; };
  fig.addEventListener('touchstart', e => {
    const b = base(); if (!b) return;
    if (e.touches.length === 2) {
      const [a, c] = e.touches, inv = b.getScreenCTM().inverse();
      pinch = { d: Math.hypot(a.clientX - c.clientX, a.clientY - c.clientY), vb: cur(), c: toRink(inv, (a.clientX + c.clientX) / 2, (a.clientY + c.clientY) / 2) };
      pan = null;
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { fig.reset(); lastTap = 0; return; }
      lastTap = now;
      if (fig.classList.contains('zoomed')) pan = { x: e.touches[0].clientX, y: e.touches[0].clientY, vb: cur(), inv: b.getScreenCTM().inverse() };
    }
  }, { passive: true });
  fig.addEventListener('touchmove', e => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const [a, c] = e.touches;
      const k = pinch.d / Math.max(1, Math.hypot(a.clientX - c.clientX, a.clientY - c.clientY)); // fingers apart → smaller box
      const w = pinch.vb[2] * k, h = pinch.vb[3] * k;
      const fx = (pinch.c.x - pinch.vb[0]) / pinch.vb[2], fy = (pinch.c.y - pinch.vb[1]) / pinch.vb[3]; // keep the pinch centre under the fingers
      set(clamp([pinch.c.x - fx * w, pinch.c.y - fy * h, w, h]));
    } else if (pan && e.touches.length === 1) {
      e.preventDefault();
      const p0 = toRink(pan.inv, pan.x, pan.y), p1 = toRink(pan.inv, e.touches[0].clientX, e.touches[0].clientY);
      set(clamp([pan.vb[0] - (p1.x - p0.x), pan.vb[1] - (p1.y - p0.y), pan.vb[2], pan.vb[3]]));
    }
  }, { passive: false });
  fig.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; if (!e.touches.length) pan = null; }, { passive: true });
}
function presentKeydown(e) {
  if (isEditing()) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); showDrill(presentIndex + 1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); showDrill(presentIndex - 1); }
  else if (e.key === ' ' && presentMode === 'focus') { e.preventDefault(); presentCards()[presentIndex]?.querySelector('.pr-play')?.click(); }
  else if (e.key === 'Escape') { closePicker(); closeAcct(); closeFeedback(); }
}

// jump list: every drill with its clock time
function openPicker() {
  const cards = presentCards();
  $('#present-picker-list').innerHTML = cards.map((c, i) => `<li class="${i === presentIndex ? 'current' : ''}" data-i="${i}">
    <span class="name">${escHtml(c.querySelector('header b')?.textContent || '')}</span>
    <span class="when">${escHtml([c.querySelector('.pr-min')?.textContent, c.querySelector('.pr-time')?.textContent].filter(Boolean).join(' · '))}</span></li>`).join('');
  $('#present-picker').hidden = false;
  $('#present-picker-list li.current')?.scrollIntoView({ block: 'center' });
}
function closePicker() { $('#present-picker').hidden = true; }
/** ↻ Resync: drop this practice's cached intro clips and reload, so the freshest plan, clips and app version come down. */
$('#present-sync').addEventListener('click', async () => {
  if (!navigator.onLine) { presentNote('Offline — resync once you have a connection.'); return; }
  const p = presentPractice;
  if (p) for (const d of p.drills) {
    for (const k of [d.intro ? keyFor(presentOwner, p.id, d) : null, d.upload ? videoKey(presentOwner, p.id, d) : null]) { if (!k) continue; forgetClip(k); try { await idbDelClip(k); } catch { /* fine */ } }
  }
  try { (await navigator.serviceWorker?.getRegistration())?.update(); } catch { /* fine */ }
  location.reload();
});
$('#present-jump').addEventListener('click', openPicker);
$('#present-account').addEventListener('click', openAcct);
$('#present-acct').addEventListener('click', e => { if (e.target === e.currentTarget) closeAcct(); }); // tap outside the sheet
$('#present-signout').addEventListener('click', presentSignOut);
$('#present-switch').addEventListener('click', presentSignOut);
$('#present-picker').addEventListener('click', e => {
  const li = e.target.closest('li[data-i]');
  if (li) showDrill(+li.dataset.i);
  closePicker();
});
$('#present-prev').addEventListener('click', () => showDrill(presentIndex - 1));
$('#present-next').addEventListener('click', () => showDrill(presentIndex + 1));
$('#present-mode').addEventListener('click', () => setPresentMode(presentMode === 'focus' ? 'list' : 'focus'));
$('#present-rotate').addEventListener('click', () => {
  presentRotate = !presentRotate;
  try { localStorage.setItem('hpp.viewrot', presentRotate ? '1' : '0'); } catch { /* fine */ }
  $('#present-rotate').classList.toggle('on', presentRotate);
  layoutPresent();
});
$('#present-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
document.addEventListener('fullscreenchange', () => { $('#present-full').innerHTML = icon(document.fullscreenElement ? 'unfullscreen' : 'fullscreen'); });

// swipe left / right across the card changes drills (a drag on the scrubber or a 3D tile is not a swipe)
let swipe = null;
$('#present-scroll').addEventListener('touchstart', e => {
  swipe = null;
  if (presentMode !== 'focus' || e.touches.length !== 1 || e.target.closest('input,select,button,canvas,.pr-fig.zoomed')) return;
  swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now() };
}, { passive: true });
$('#present-scroll').addEventListener('touchend', e => {
  if (!swipe) return;
  const dx = e.changedTouches[0].clientX - swipe.x, dy = e.changedTouches[0].clientY - swipe.y, dt = Date.now() - swipe.at;
  swipe = null;
  if (dt < 800 && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) showDrill(presentIndex + (dx < 0 ? 1 : -1));
}, { passive: true });
window.addEventListener('resize', layoutPresent);

// Pull down to reload. The viewer is a fixed, non-scrolling page (and an installed home-screen app has no
// browser chrome at all), so the browser's own pull-to-refresh never fires — this stands in for it on the
// share link and the sign-in gate. Never in the practice creator, where a drag means something else.
const PULL_ARM = 110; // px of pull before letting go reloads
let pull = null;
const pullTip = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'pull-tip', hidden: true }));
const atTop = el => { for (; el && el !== document.body; el = el.parentElement) if (el.scrollTop > 0) return false; return true; };
const endPull = () => { pull = null; pullTip.hidden = true; };
document.addEventListener('touchstart', e => {
  pull = null;
  if (editorOn || e.touches.length !== 1 || e.target.closest('input,select,textarea,canvas,video,.pr-fig.zoomed,#present-picker,#present-acct,#present-fb') || !atTop(e.target)) return;
  pull = { x: e.touches[0].clientX, y: e.touches[0].clientY, el: e.target, armed: false };
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!pull) return;
  const dx = e.touches[0].clientX - pull.x, dy = e.touches[0].clientY - pull.y;
  if (e.touches.length !== 1 || !atTop(pull.el) || (Math.abs(dx) > 30 && Math.abs(dx) > dy)) return endPull(); // a pinch, a scroll or a sideways swipe
  if (dy < 24) { pullTip.hidden = true; pull.armed = false; return; }
  pull.armed = dy >= PULL_ARM;
  pullTip.hidden = false;
  pullTip.textContent = pull.armed ? '↻ Release to reload' : '↓ Pull to reload';
  pullTip.classList.toggle('armed', pull.armed);
  pullTip.style.transform = `translate(-50%, ${Math.min(dy, PULL_ARM + 30) * 0.5}px)`;
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!pull?.armed) return endPull();
  pull = null;
  pullTip.textContent = 'Reloading…';
  location.reload();
}, { passive: true });
document.addEventListener('touchcancel', endPull, { passive: true });

// Keep the screen on while the plan is up at the bench (Screen Wake Lock: Chrome/Android, iOS 16.4+ Safari).
let wakeLock = null;
async function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  if (!on) { wakeLock?.release().catch(() => {}); wakeLock = null; return; }
  if (wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; } // low battery / not allowed: the plan still works, the screen just times out
}
document.addEventListener('visibilitychange', () => { if (presenting && document.visibilityState === 'visible') keepAwake(true); });

// Presentation is its own destination (the very URL coaches / families get) — a new tab, so the editor stays put.
const openPresentation = view => window.open(`${location.origin}${routePath({ view, pid: store.practice.id })}`, '_blank');
$('#btn-present').addEventListener('click', () => openPresentation('coach'));
$('#btn-open-team').addEventListener('click', () => openPresentation('team'));
$('#btn-open-coach').addEventListener('click', () => openPresentation('coach'));
$('#present-signin').addEventListener('click', () => cloudSync?.signIn().catch(e => presentMsg(`Sign-in failed: ${e?.message || e}`, { signIn: true })));
$('#present-tolist').addEventListener('click', e => navigate(e.currentTarget.dataset.to || '/'));
$('#present-reload').addEventListener('click', () => location.reload()); // a failed module import stays failed for the page's lifetime: start over
/** Copy one of the two links: /coach/<id> or /team/<id>. Who can open it is decided by the stage and the roster, not by having the link. */
async function copyShareLink(btn, view) {
  const url = `${location.origin}${routePath({ view, pid: store.practice.id })}`;
  try { await navigator.clipboard.writeText(url); } catch { prompt('Copy this link:', url); return; }
  const old = btn.textContent;
  btn.textContent = '✓ Copied';
  setTimeout(() => { btn.textContent = old; }, 1500);
}
// ----- the owner's audit log of views -----
const fmtWhen = stamp;
async function openViewLog() {
  const p = store.practice;
  if (!cloudBackend?.loadViews || !cloudSync?.user || !store.data.ownerUid) return alert('Sign in first — the log lives in your cloud account.');
  $('#practice-pop').hidden = true;
  $('#viewlog').hidden = false;
  $('#viewlog-title').textContent = practiceLabel(p);
  $('#viewlog-body').innerHTML = '<p class="vl-empty">Loading…</p>';
  let rows;
  try { rows = await cloudBackend.loadViews(store.data.ownerUid, p.id); }
  catch (e) { $('#viewlog-body').innerHTML = `<p class="vl-empty">Couldn't load the log: ${escHtml(e?.message || e)} — are the latest firestore.rules deployed?</p>`; return; }
  renderViewLog(p, rows);
}
function renderViewLog(p, rows) {
  if (!rows.length) { $('#viewlog-body').innerHTML = '<p class="vl-empty">Nobody has opened this practice yet. Views and plays by the coaches and families you shared it with will show up here.</p>'; return; }
  const who = r => r.name && r.email ? `<span class="vl-who">${escHtml(r.name)} <span class="muted">${escHtml(r.email)}</span></span>` : `<span class="vl-who">${escHtml(r.name || r.email || r.uid)}</span>`;
  // per drill: one line per person with their view / play counts and last time
  // reactions after practice: the latest pick per person, and how many times they changed it
  const reacts = rows.filter(r => r.action === 'react');
  const latest = new Map();
  for (const r of [...reacts].sort((a, b) => (a.at || 0) - (b.at || 0))) { const k = r.uid || r.email; const v = latest.get(k) || { r, n: 0 }; v.r = r; v.n++; latest.set(k, v); }
  const reactHTML = reacts.length ? `<h3>Reactions after practice</h3>
    <div class="vl-tally">${REACTIONS.map(([e]) => `<span class="vl-tally-item"><span class="vl-emoji">${e}</span> ${[...latest.values()].filter(v => v.r.emoji === e).length}</span>`).join('')}</div>
    <table class="vl-table"><tr><th>Who</th><th>Pick</th><th>When</th><th>Via</th></tr>
    ${[...latest.values()].sort((a, b) => (b.r.at || 0) - (a.r.at || 0)).map(v => `<tr><td>${who(v.r)}</td><td><span class="vl-emoji">${escHtml(v.r.emoji || '')}</span>${v.n > 1 ? ` <span class="muted small">changed ${v.n - 1}×</span>` : ''}</td><td class="when">${fmtWhen(v.r.at || 0)}</td><td class="muted">${escHtml(v.r.audience === 'team' ? 'team link' : 'coach link')}${v.r.device ? ` · ${escHtml(v.r.device)}` : ''}</td></tr>`).join('')}</table>` : '';
  const byDrill = new Map();
  for (const r of rows) {
    if (r.action === 'react') continue;
    const d = byDrill.get(r.drillId) || new Map(); byDrill.set(r.drillId, d);
    const k = r.uid || r.email; const v = d.get(k) || { r, views: 0, plays: 0, last: 0, first: Infinity };
    if (r.action === 'play') v.plays++; else v.views++;
    v.last = Math.max(v.last, r.at || 0); v.first = Math.min(v.first, r.at || Infinity);
    d.set(k, v);
  }
  const order = [...p.drills.map(d => d.id), ...[...byDrill.keys()].filter(id => !p.drills.some(d => d.id === id))]; // current drills first, deleted ones after
  const drillName = id => p.drills.find(d => d.id === id)?.name || rows.find(r => r.drillId === id)?.drillName || id;
  const sections = order.filter(id => byDrill.has(id)).map((id, i) => {
    const people = [...byDrill.get(id).values()].sort((a, b) => b.last - a.last);
    return `<h3>${p.drills.some(d => d.id === id) ? `${p.drills.findIndex(d => d.id === id) + 1}. ` : ''}${escHtml(drillName(id))}${p.drills.some(d => d.id === id) ? '' : ' <span class="muted">(drill since removed)</span>'}</h3>
      <table class="vl-table"><tr><th>Who</th><th>Views</th><th>Plays</th><th>First</th><th>Last</th><th>Via</th></tr>
      ${people.map(v => `<tr><td>${who(v.r)}</td><td class="num">${v.views}</td><td class="num">${v.plays}</td><td class="when">${fmtWhen(v.first)}</td><td class="when">${fmtWhen(v.last)}</td><td class="muted">${escHtml(v.r.audience === 'team' ? 'team link' : 'coach link')}${v.r.device ? ` · ${escHtml(v.r.device)}` : ''}</td></tr>`).join('')}</table>`;
  }).join('');
  const feed = rows.slice(0, 150).map(r => `<li><span class="when">${fmtWhen(r.at || 0)}</span><span class="act">${r.action === 'react' ? `${escHtml(r.emoji || '')} pick` : r.action === 'play' ? '▶ play' : '👁 view'}</span>${who(r)}<span class="muted">${r.action === 'react' ? 'after practice' : escHtml(r.drillName || drillName(r.drillId))}</span></li>`).join('');
  const people = new Set(rows.map(r => r.uid || r.email)).size;
  $('#viewlog-body').innerHTML = `<p class="muted small">${rows.length} record${rows.length === 1 ? '' : 's'} · ${people} ${people === 1 ? 'person' : 'people'} · a view is a drill on screen for 2 s, a play is its ▶ — at most one of each per person per drill every 5 minutes; a pick is the emoji tapped on the dismissal card.</p>${reactHTML}${sections}<h3>Recent activity</h3><ul class="vl-feed">${feed}</ul>`;
}
$('#btn-views').addEventListener('click', openViewLog);
$('#viewlog-refresh').addEventListener('click', openViewLog);
$('#viewlog-close').addEventListener('click', () => { $('#viewlog').hidden = true; });
$('#viewlog').addEventListener('click', e => { if (e.target === e.currentTarget) $('#viewlog').hidden = true; });
$('#viewlog-clear').addEventListener('click', async () => {
  if (!confirm('Delete every record in this practice\'s views log?')) return;
  try { await cloudBackend.clearViews(store.data.ownerUid, store.practice.id); openViewLog(); }
  catch (e) { alert(`Couldn't clear the log: ${e?.message || e}`); }
});
$('#btn-share-link').addEventListener('click', e => copyShareLink(e.currentTarget, 'coach'));
$('#btn-share-team-link').addEventListener('click', e => copyShareLink(e.currentTarget, 'team'));

// ---------- cloud sync (Firebase) ----------
const CLOUD_LABELS = { signedout: 'Not signed in (local only)', syncing: 'Syncing…', saving: 'Saving…', saved: 'Saved ✓', error: 'Cloud error' };
function renderCloudStatus(sync, state, detail) {
  const u = sync.user;
  const text = (u && state !== 'signedout' ? `${u.name} · ` : '') + (CLOUD_LABELS[state] || '') + (state === 'error' && detail ? ` (${detail})` : '');
  $('#cloud-status').textContent = text;
  // The status is width-capped with an ellipsis; hovering shows everything (especially full error details).
  $('#cloud-status').title = state === 'error' && detail ? `Cloud error:\n${detail}` : text;
  $('#cloud-status').classList.toggle('warn', state === 'error');
  $('#btn-signin').hidden = !!u;
  $('#btn-signout').hidden = !u;
}
// Only these accounts get the practice-creation interface. Everyone else uses share links
// (this is a UI gate; the real protection is Firestore's rules — nobody can write another
// account's practices, and readers only see the practices they are listed on).
const OWNER_EMAILS = ['ehren.eschmann@gmail.com'];
const isOwner = u => !u?.email || OWNER_EMAILS.includes(String(u.email).toLowerCase());

/** Bring the practice creator up (only ever for the planner on /editor — see resolveRoute) or take it away. */
function syncEditor(on) {
  if (on === editorOn) return;
  if (!on) { finishActive(); pickTarget = null; if (anim.playing) togglePlay(); }
  editorOn = on;
  document.body.classList.toggle('no-editor', !on);
  if (on) { applyRoute(); sel = null; renderAll(); }
}

// ---------- the planner's inbox: coach feedback and access requests, live ----------
let feedbackAll = [], accessRequests = [], feedsUnsub = [];
function watchPlannerFeeds() {
  const on = !!cloudSync?.user && isOwner(cloudSync.user) && !!cloudBackend?.subscribeAllFeedback;
  if (on === !!feedsUnsub.length) return;
  feedsUnsub.forEach(f => f?.()); feedsUnsub = []; feedbackAll = []; accessRequests = [];
  if (!on) return;
  feedsUnsub = [
    cloudBackend.subscribeAllFeedback((rows, err) => { if (err) return console.warn('feedback:', err); feedbackAll = rows; renderInboxBadges(); if (!$('#feedback').hidden) renderFeedback(); }),
    cloudBackend.subscribeRequests((rows, err) => { if (err) return console.warn('requests:', err); accessRequests = rows; renderInboxBadges(); if (!$('#teammgr').hidden) renderTeamMgr(); }),
  ];
}
const openFeedbackFor = pid => feedbackAll.filter(f => f.pid === pid && !f.resolved);
const openRequests = () => accessRequests.filter(r => r.status === 'open');
function renderInboxBadges() {
  if (!editorOn) return;
  paintInboxButtons();
  renderPracticeSelect(); renderPlan();
}
function paintInboxButtons() {
  const n = openFeedbackFor(store.practice.id).length;
  $('#btn-feedback').textContent = `💬${n ? ` ${n}` : ''}`;
  $('#btn-feedback').classList.toggle('attn', n > 0);
  const r = openRequests().length;
  $('#btn-team').textContent = `👥 Team${r ? ` (${r})` : ''}`;
  $('#btn-team').classList.toggle('attn', r > 0);
}

(async () => {
  // `globalThis.__hppBackend` lets tests plug in a fake backend; otherwise use Firebase when configured.
  let backend = globalThis.__hppBackend || null;
  if (!backend) {
    try {
      const cfg = await loadConfig();
      if (cfg) backend = await firebaseBackend(cfg);
    } catch (e) {
      // Offline and the SDK isn't cached yet, or something on this device blocks it. The planner's own device
      // still works local-only; a viewer sees the copy this device kept, or what went wrong and a way to retry.
      cloudBoot = 'failed'; cloudBootError = e?.message || String(e);
      console.warn('Cloud service did not load:', e);
      addEventListener('online', () => { if (presenting) location.reload(); }, { once: true });
    }
  }
  if (!backend) { if (cloudBoot === 'loading') cloudBoot = 'none'; refreshScreen(); return; } // no config (or failed boot): local-only
  $('#cloud').hidden = false;
  const sync = createSync({
    store, backend,
    canSync: isOwner, // viewers only read what is released to them: no practices are pulled into or saved from their account
    onStatus: (state, detail) => {
      authKnown = true;
      renderCloudStatus(sync, state, detail);
      signInError = state === 'error' && !sync.user ? detail || '' : '';
      if (sync.user) { try { if (isOwner(sync.user)) localStorage.setItem('hpp.owner', '1'); else localStorage.removeItem('hpp.owner'); } catch { /* storage blocked */ } }
      if (sync.user && isOwner(sync.user) && state === 'saved' && !uploadsChecked) { uploadsChecked = true; uploadPendingIntros(); } // first quiet moment after sign-in
      watchInbox(); watchPlannerFeeds();
      refreshScreen(); // who is signed in decides the screen
    },
    onRemote: (ids, { full } = {}) => {
      // Practices changed from another device (or first sync): refresh what is on screen.
      if (full || ids.includes(store.data.currentId) || !store.practice) { finishActive(); sel = null; stopAnim(); renderAll(); }
      else renderPracticeSelect();
      if (presenting) refreshScreen(); // previewing one's own practice: pick up the change live
    },
    onRoster: () => { if (!$('#teammgr').hidden) renderTeamMgr(); }, // roster edited on another device
  });
  cloudSync = sync; cloudBackend = backend; cloudBoot = 'ready';
  $('#btn-signin').addEventListener('click', () => sync.signIn().catch(e => renderCloudStatus(sync, 'error', e?.message || String(e))));
  $('#btn-signout').addEventListener('click', () => sync.signOut().catch(e => renderCloudStatus(sync, 'error', e?.message || String(e))));
  renderCloudStatus(sync, 'signedout');
  refreshScreen();
})();

// ---------- boot ----------
// Offline support: cache the app shell so the rink works without internet (needs HTTPS or localhost).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
hydrateIcons();
applyRoute();
setTool('select');
refreshScreen();
renderAll();
window.addEventListener('resize', drawSelection);
