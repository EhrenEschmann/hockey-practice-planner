import { RINK, VIEWS, rinkSVG, SVG_STYLE, nearestBoardPoint } from './rink.js';
import * as G from './geometry.js';
import { renderObjects, standaloneSVG, SKATER_COLORS, ZONE_COLORS, ARROW_STYLES, starPoints } from './render.js';
import { makeSim, facingOf, isPlayer, underPad, jumpHeight, skaterPoints, DEFAULT_PASS_SPEED, DEFAULT_SHOT_SPEED, CONTACT_DIST } from './sim.js';
import { Store, uid, newDrill, newPractice, practiceLabel, cloneObjects, migrateDrill, syncFollowers } from './store.js';
import { loadConfig, firebaseBackend, createSync } from './cloud.js';
import { PS_ELEMENTS, createPSView } from './powerskate.js';

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
      return `<li data-i="${i}" class="${i === (psViewInst?.index || 0) ? 'active' : ''}" title="${escHtml(e?.desc || '')}\nClick to open this element in the 3D view"><span class="muted">${i + 1}.</span><span class="name">${escHtml(e?.name || k)}</span><button data-act="psdel" title="Remove from the list">✕</button></li>`;
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
  fxLayer.innerHTML = '';
  const selObj = getObj(sel);
  objLayer.innerHTML = renderObjects(d, sel, { tool, showPaths: drillPaths(), sim, numberWaypoints: selObj?.type === 'puck' || !!selObj?.trigger || (isPlayer(selObj) && !!selObj.path?.length) });
  drawSelection();
  if (anim.t > 0) applyAnimation(anim.t);
  $$('#viewbar [data-view]').forEach(b => b.classList.toggle('active', sameView(VIEWS[b.dataset.view], d.view)));
}

function sameView(a, b) { return a && b && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < 0.01); }

function drawSelection() {
  overlay.innerHTML = '';
  if (!sel) return;
  const el = objLayer.querySelector(`[data-id="${sel}"]:not(.path-under)`);
  if (!el) { sel = null; return; }
  const target = el.querySelector('.skater-body, .coach-body, .puck-disc') || el;
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
  $('#btn-undo').disabled = !store.undoStack.length;
  $('#btn-redo').disabled = !store.redoStack.length;
}

function renderAll() { renderCanvas(); renderUI(); updateRoute(); }

// ---------- routing: the URL tracks the open practice & drill so refresh restores them ----------
function updateRoute() {
  if (/view=/.test(location.hash)) return; // presentation mode owns the URL
  const p = store.practice, d = store.drill;
  if (!p || !d) return;
  if ((store.data.lastDrill ||= {})[p.id] !== d.id) { store.data.lastDrill[p.id] = d.id; store.persist(); }
  const hash = `#p=${p.id}&d=${d.id}`;
  if (location.hash !== hash) history.replaceState(null, '', hash); // replaceState: no history spam, no hashchange loop
}

/** Open the practice/drill named in the URL hash; fall back to the last drill viewed in that practice. */
function applyRoute() {
  const pid = location.hash.match(/p=(\w+)/)?.[1];
  const did = location.hash.match(/d=(\w+)/)?.[1];
  if (pid && pid !== store.data.currentId && store.data.practices.some(x => x.id === pid)) store.switchPractice(pid);
  const p = store.practice;
  const want = did || store.data.lastDrill?.[p.id];
  const i = p.drills.findIndex(x => x.id === want);
  if (i >= 0) store.drillIndex = i;
}

window.addEventListener('hashchange', () => {
  refreshPresent();
  if (presenting) return; // the editor underneath stays as it was
  finishActive();
  applyRoute();
  sel = null; stopAnim(); renderAll();
});

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
  text: 'Click to place a text label',
  erase: 'Click an object to remove it',
};

function setTool(t) {
  finishActive();
  pickTarget = null;
  tool = t;
  document.body.dataset.tool = t;
  $$('#toolbar .tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  $('#hint').textContent = HINTS[t] || '';
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
    case 'coach': { const k = count('coach'); return { type: 'coach', x: p.x, y: p.y, label: k ? `C${k + 1}` : 'C', color: 'black', speed: 10, delay: 0, path: [] }; }
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
      // Link the two skaters whose paths pass closest to the marker.
      const near = drill().objects
        .filter(o => o.type === 'skater' && o.path?.length)
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
function placed(id) {
  select(id);
  if (tool !== 'select') setTool('select');
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
      if (bankEl && id && getObj(id)?.events?.[+bankEl.dataset.bank]) {
        drag = { type: 'bank', id, ev: +bankEl.dataset.bank, pushed: false };
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
    case 'zone': {
      const o = tool === 'zone'
        ? { id: uid(), type: 'zone', x: p.x, y: p.y, w: 0, h: 0, label: `Station ${drill().objects.filter(x => x.type === 'zone').length + 1}`, color: ZONE_COLORS[lastZoneColor++ % ZONE_COLORS.length] }
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
    case 'rect': {
      const o = getObj(drag.id); if (!o) return;
      const r = G.rectFromPoints(drag.start, p);
      if (o.type === 'zone') Object.assign(o, r);
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
        overlay.innerHTML = `<polyline points="${drag.pts.map(q => `${q.x},${q.y}`).join(' ')}" fill="none" stroke="${SKATER_COLORS[o.color] || o.color}" stroke-width=".4" stroke-dasharray="1 .6"/>`;
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
    case 'handle': case 'evmark': case 'bank': store.save(); renderAll(); break;
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
let gated = false; // sign-in required (Firebase configured, nobody signed in): the app is read-only behind the gate

document.addEventListener('keydown', e => {
  if (gated) return;
  if (presenting) return; // presentation is view-only and terminal: no editor shortcuts, no way "back"
  if (!$('#library').hidden) { if (e.key === 'Escape') closeLibrary(); return; } // the library modal captures the keyboard
  if (!$('#teammgr').hidden) { if (e.key === 'Escape' && !isEditing()) closeTeamMgr(); return; } // same for the team manager
  if (e.key === ' ' && !isEditing()) { e.preventDefault(); if (!spaceDown) { spaceDown = true; } return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
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
  const keys = { v: 'select', h: 'pan', s: 'skater', k: 'coach', g: 'goalie', i: 'contact', r: 'raisedpad', j: 'jumppad', l: 'pile', a: 'arrow', c: 'cone', m: 'minicone', t: 'tire', p: 'puck', n: 'net', o: 'obstacle', b: 'barricade', z: 'zone', x: 'text', e: 'erase' };
  const t = keys[e.key.toLowerCase()];
  if (t) setTool(t);
});
document.addEventListener('keyup', e => {
  if (gated || presenting) return;
  if (e.key === ' ') {
    if (spaceDown && !isEditing() && !drag) togglePlay();
    spaceDown = false;
  }
});

function translateObj(o, dx, dy) {
  if (!o) return;
  const tr = q => ({ ...q, x: G.round1(q.x + dx), y: G.round1(q.y + dy) }); // spread keeps waypoint flags (e.g. pivot)
  if (o.points) o.points = o.points.map(tr);
  else { Object.assign(o, tr(o)); if (o.path) o.path = o.path.map(tr); }
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
  const mover = id => { const o = dr.objects.find(x => x.id === id); return o?.type === 'skater' && o.path?.length ? o : null; };
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
      const [shA, shB] = loser === A ? [0.9, 0.1] : loser === B ? [0.1, 0.9] : [0.5, 0.5]; // the loser absorbs the hit
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
/** After the drill ends, players skate straight back to their spots at 2× speed; the phase lasts until the slowest returner is home. */
function returnTime(dr, sm) {
  const T = sm.duration();
  let R = 0;
  for (const o of dr.objects) {
    if (!isPlayer(o) || !o.path?.length) continue;
    const a = sm.skaterPose(o.id, T), b = sm.skaterPose(o.id, 0);
    R = Math.max(R, Math.hypot(b.x - a.x, b.y - a.y) / (2 * sm.skater(o.id).speed));
  }
  return R;
}

/** One frame of the return phase, tr seconds after the drill ended: everyone glides home. */
function returnFrame(dr, sm, root, fx, tr) {
  fx.innerHTML = '';
  const T = sm.duration();
  const R = returnTime(dr, sm);
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
  fx.innerHTML = (playing && t > 0 ? sm.contacts() : []).filter(c => t >= c.t && t - c.t <= FX_DUR).map(c => {
    const u = (t - c.t) / FX_DUR;
    return `<g class="fx-burst" transform="translate(${c.x.toFixed(2)} ${c.y.toFixed(2)})" opacity="${(1 - u).toFixed(2)}">` +
      `<polygon points="${starPoints(2 + 3 * u)}"/><circle r="${(1 + 5 * u).toFixed(2)}"/></g>`;
  }).join('');
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

function applyAnimation(t) { animateFrame(drill(), sim, objLayer, fxLayer, t, anim.playing); }

/** Drill time plus the skate-back-to-start phase that plays after it. */
function fullDuration() { return sim ? totalDuration() + returnTime(drill(), sim) : 0; }

function tick(now) {
  if (!anim.playing) return;
  const dt = Math.min(0.1, (now - anim.last) / 1000);
  anim.last = now;
  anim.t += dt * drillSpeed();
  const T = fullDuration();
  if (anim.t >= T) { anim.t = T; anim.playing = false; }
  applyAnimation(anim.t);
  renderAnimBar();
  if (anim.playing) anim.raf = requestAnimationFrame(tick);
}

function togglePlay() {
  if (isPSDrill(drill())) { psView().toggle(); renderAnimBar(); return; } // power skating mode: ▶ plays the technique elements
  if (anim.playing) { anim.playing = false; cancelAnimationFrame(anim.raf); fxLayer.innerHTML = ''; }
  else {
    if (totalDuration() <= 0) return;
    // Playing is for watching, not editing: drop the selection and finish anything being drawn.
    finishActive();
    if (pickTarget) { pickTarget = null; $('#hint').textContent = HINTS[tool] || ''; }
    if (sel) select(null);
    if (anim.t >= fullDuration()) anim.t = 0;
    anim.playing = true; anim.last = performance.now();
    anim.raf = requestAnimationFrame(tick);
  }
  renderAnimBar();
}

function stopAnim() {
  anim.playing = false; cancelAnimationFrame(anim.raf); anim.t = 0;
  if (psViewInst && isPSDrill(drill())) psViewInst.stop();
  renderCanvas(); renderAnimBar();
}

function renderAnimBar() {
  if (isPSDrill(drill())) { // power skating mode: ▶/⏹ drive the 3D viewer; the timeline doesn't apply
    $('#btn-play').textContent = psViewInst?.playing ? '⏸' : '▶';
    $('#btn-play').disabled = !(drill().psElements || []).length;
    $('#timeline').disabled = true;
    $('#time-display').textContent = 'technique demo';
    $('#impact-loser-wrap').hidden = true;
    return;
  }
  $('#timeline').disabled = false;
  const T = totalDuration();
  $('#btn-play').textContent = anim.playing ? '⏸' : '▶';
  $('#btn-play').disabled = T <= 0;
  const tl = $('#timeline');
  tl.max = Math.max(T, 0.01); tl.value = Math.min(anim.t, T);
  if (document.activeElement !== $('#anim-speed')) $('#anim-speed').value = String(drillSpeed());
  $('#anim-trails').checked = drillPaths();
  $('#time-display').textContent = anim.t > T ? `↩ ${T.toFixed(1)} / ${T.toFixed(1)} s` : `${anim.t.toFixed(1)} / ${T.toFixed(1)} s`;
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
  const hex = SKATER_COLORS[o.color] || o.color || '';
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
$('#btn-stop').addEventListener('click', stopAnim);
$('#timeline').addEventListener('input', e => { anim.t = +e.target.value; if (anim.t === 0) renderCanvas(); else applyAnimation(anim.t); renderAnimBar(); });
$('#timeline').addEventListener('change', e => e.target.blur()); // scrub done → hotkeys work again
$('#anim-speed').addEventListener('change', e => { drill().animSpeed = +e.target.value; store.save(); });
$('#anim-trails').addEventListener('change', e => { drill().showPaths = e.target.checked; store.save(); renderCanvas(); });

// ---------- view bar ----------
$$('#viewbar [data-view]').forEach(b => b.addEventListener('click', () => setView(VIEWS[b.dataset.view])));
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
function renderPracticeSelect() {
  const s = $('#practice-select');
  s.innerHTML = store.data.practices.map(p => `<option value="${p.id}">${escHtml(practiceLabel(p))}</option>`).join('');
  s.value = store.data.currentId;
}
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PRACTICE_FIELDS = [['#practice-team', 'team'], ['#practice-date', 'date'], ['#practice-time', 'time'], ['#practice-coaches', 'coaches']];
function renderPracticeProps() {
  const p = store.practice;
  for (const [id, key] of PRACTICE_FIELDS) {
    const el = $(id);
    if (document.activeElement !== el) el.value = p[key] || '';
  }
  const em = $('#practice-emails');
  if (document.activeElement !== em) em.value = (p.sharedWith || []).join(', ');
}
for (const [id, key] of PRACTICE_FIELDS) {
  const el = $(id);
  el.addEventListener('focus', () => store.beginPending());
  el.addEventListener('input', () => { store.practice[key] = el.value; store.save(); renderPracticeSelect(); });
  el.addEventListener('change', () => { store.commitPending(); renderUI(); });
}
{ // coach emails: stored as a lowercased array — these people may open the practice in presentation mode
  const el = $('#practice-emails');
  el.addEventListener('focus', () => store.beginPending());
  el.addEventListener('input', () => { store.practice.sharedWith = el.value.split(/[\s,;]+/).filter(Boolean).map(s => s.toLowerCase()); store.save(); });
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
function closeTeamMgr() { $('#teammgr').hidden = true; }

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
      <button data-act="delcoach" title="Remove coach">✕</button>
    </div>`).join('');
  const playerBlocks = t.players.map(p => `
    <div class="ros-player" data-pid="${p.id}">
      <div class="ros-row">
        <input placeholder="Player name" data-field="name" value="${escHtml(p.name || '')}">
        <button data-act="addcontact" title="Add a parent / grandparent contact">＋ contact</button>
        <button data-act="delplayer" title="Remove player">✕</button>
      </div>
      ${(p.contacts || []).map(k => `
      <div class="ros-row ros-contact" data-kid="${k.id}">
        <input class="ros-rel" placeholder="mom / grandpa …" data-field="rel" value="${escHtml(k.rel || '')}">
        <input placeholder="Contact name" data-field="name" value="${escHtml(k.name || '')}">
        <input placeholder="email@…" data-field="email" value="${escHtml(k.email || '')}" spellcheck="false">
        <button data-act="delcontact" title="Remove contact">✕</button>
      </div>`).join('')}
    </div>`).join('');
  body.innerHTML = `
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
  if (el.dataset.field === 'teamname') { t.name = el.value; store.saveRoster(); return; }
  const row = el.closest('[data-cid],[data-kid],[data-pid]');
  if (!row) return;
  const obj = row.dataset.cid ? t.coaches.find(c => c.id === row.dataset.cid)
    : row.dataset.kid ? t.players.flatMap(p => p.contacts || []).find(k => k.id === row.dataset.kid)
    : t.players.find(p => p.id === row.dataset.pid);
  if (!obj) return;
  obj[el.dataset.field] = el.value;
  store.saveRoster();
});
$('#team-body').addEventListener('change', e => { if (e.target.dataset.field === 'teamname') renderTeamMgr(); }); // the team select shows the new name
$('#team-body').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn?.dataset.act) return;
  const t = currentMgrTeam(); if (!t) return;
  const player = t.players.find(p => p.id === btn.closest('[data-pid]')?.dataset.pid);
  switch (btn.dataset.act) {
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
// Practice popover: pull the roster team's coach emails into this practice's viewer list.
$('#btn-team-emails').addEventListener('click', () => {
  const team = store.roster.teams.find(t => (t.name || '').toLowerCase() === (store.practice.team || '').toLowerCase()) || store.roster.teams[0];
  const emails = (team?.coaches || []).map(c => (c.email || '').trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return alert('No coach emails in the team roster yet — add them under 👥 Team.');
  store.beginPending();
  store.practice.sharedWith = [...new Set([...(store.practice.sharedWith || []), ...emails])];
  store.commitPending();
  store.save();
  renderPracticeProps();
});

let notesOpenFor = null;  // drill id whose notes editor is expanded in the list
let editingDrill = null;  // drill id being renamed inline (explicit edit mode: ✎ → save/cancel)

function renderPlan() {
  const p = store.practice;
  const total = p.drills.reduce((a, d) => a + (+d.duration || 0), 0);
  $('#plan-total').textContent = `${total} min total`;
  const list = $('#drill-list');
  if (list.contains(document.activeElement)) return; // someone is typing in the list — don't clobber it
  const btns = (d, i) => `
      <button data-act="notes" class="${(d.notes || '').trim() ? 'has-notes' : ''}${notesOpenFor === d.id ? ' open' : ''}" title="Coaching notes">🗒</button>
      <button data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button data-act="down" title="Move down" ${i === p.drills.length - 1 ? 'disabled' : ''}>↓</button>
      <button data-act="dup" title="Duplicate">⧉</button>
      <button data-act="del" title="Delete" ${p.drills.length === 1 ? 'disabled' : ''}>✕</button>`;
  list.innerHTML = p.drills.map((d, i) => {
    const row = editingDrill === d.id
      ? `<li class="${i === store.drillIndex ? 'active ' : ''}editing" data-index="${i}">
          <span class="num">${i + 1}.</span>
          <input class="dname" value="${escHtml(d.name)}" title="Drill name" spellcheck="false">
          <input class="dmin" type="number" min="0" step="1" value="${+d.duration || 0}" title="Minutes">
          <span class="dur">min</span>
          <button data-act="save" class="primary" title="Save (Enter)">✓</button>
          <button data-act="cancel" title="Cancel (Esc)">✕</button>
        </li>`
      : `<li class="${i === store.drillIndex ? 'active' : ''}" data-index="${i}">
          <span class="num">${i + 1}.</span>
          <span class="name">${escHtml(d.name)}</span>
          <span class="dur">${+d.duration || 0} min</span>
          <button data-act="edit" title="Rename / edit minutes">✎</button>${btns(d, i)}
        </li>`;
    const notes = notesOpenFor === d.id
      ? `<li class="notes-editor"><textarea data-notes="${i}" rows="3" placeholder="Notes / coaching points…">${escHtml(d.notes || '')}</textarea></li>`
      : '';
    return row + notes;
  }).join('');
}

// Inline notes editing (live) — name/minutes only commit via the edit row's Save button.
$('#drill-list').addEventListener('focusin', e => { if (e.target.matches('textarea')) store.beginPending(); });
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
  if (!li || li.classList.contains('editing') || li.classList.contains('notes-editor')) return;
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
  if (li.classList.contains('notes-editor')) return;
  finishActive();
  if (act === 'edit') {
    editingDrill = p.drills[i].id;
    if (store.drillIndex !== i) switchDrill(i); else renderPlan();
    const el = $('#drill-list li.editing .dname');
    if (el) { el.focus(); el.select(); }
    return;
  }
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
  if (act === 'up' || act === 'down') {
    const j = act === 'up' ? i - 1 : i + 1;
    commit(() => { [p.drills[i], p.drills[j]] = [p.drills[j], p.drills[i]]; store.drillIndex = j; });
  } else if (act === 'dup') {
    commit(() => {
      const copy = JSON.parse(JSON.stringify(p.drills[i]));
      copy.id = uid(); copy.name += ' (copy)';
      copy.objects = cloneObjects(copy.objects);
      p.drills.splice(i + 1, 0, copy); store.drillIndex = i + 1;
    });
  } else if (act === 'del') {
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
    if (q && !`${d.name} ${p.team || ''} ${p.date || ''}`.toLowerCase().includes(q)) continue;
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
  coach: [['label', 'text', 'Label'], ['color', 'swatch', 'Color'], ['speed', 'number', 'Speed (ft/s)'], ['delay', 'number', 'Start delay (s)'], ['facing', 'number', 'Facing (°, blank = auto)']],
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
  zone: [['label', 'text', 'Label'], ['color', 'zoneswatch', 'Color'], ['w', 'number', 'Width (ft)'], ['h', 'number', 'Height (ft)']],
  barricade: [],
  arrow: [['style', 'select:' + Object.entries(ARROW_STYLES).map(([k, v]) => `${k}=${v}`).join(','), 'Style'], ['color', 'color', 'Color']],
  text: [['text', 'text', 'Text'], ['size', 'number', 'Size'], ['color', 'color', 'Color']],
};
const TYPE_NAMES = { contact: 'Contact', skater: 'Skater', coach: 'Coach', cone: 'Cone', minicone: 'Small cone', raisedpad: 'Raised pad', jumppad: 'Jump pad', pile: 'Puck pile', tire: 'Tire', puck: 'Puck', net: 'Net', obstacle: 'Obstacle', zone: 'Zone', barricade: 'Barricade', arrow: 'Arrow', text: 'Text' };

function renderProps() {
  const body = $('#props-body');
  if (body.contains(document.activeElement)) return; // don't clobber an input being edited
  const o = sel && getObj(sel);
  if (!o) { body.innerHTML = '<p class="muted">Nothing selected. Click an object with the Select tool.</p>'; return; }
  const fields = (PROPS[o.type] || [])
    .filter(([key]) => !(key === 'facing' && o.path?.length)) // a moving skater faces along its path; facing only places a stationary skater's puck
    .map(([key, kind, label]) => {
    let input;
    const v = o[key] ?? '';
    if (kind === 'text') input = `<input data-prop="${key}" value="${escHtml(v)}">`;
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
    if (o.type === 'skater' && o.path?.length && !o.follow) {
      const toggles = o.path.map((pt, i) => `<button class="wp-toggle ${pt.pivot ? 'active' : ''}" data-act="pivot" data-wp="${i}" title="Pivot at waypoint ${i + 1} — click cycles: no pivot → ⟲ face swings left → ⟳ face swings right">${i + 1}${pt.pivot === 'L' ? ' ⟲' : pt.pivot ? ' ⟳' : ''}</button>`).join('');
      extra.push(`<div class="field"><span title="Waypoints are numbered on the ice while this skater is selected. A pivot turns the skater 180° (forward ⇄ backward); pick which way their face and the puck swing around.">Pivot forward ⇄ backward at waypoint</span><div class="row wp-row">${toggles}</div></div>`);
    }
    if (o.type === 'skater') {
      const leaders = drill().objects.filter(s => s.type === 'skater' && s.id !== o.id && !s.follow && s.path?.length);
      if (leaders.length || o.follow) extra.push(`<label class="field inline"><span>Same path as</span><select data-prop="follow">
        <option value="">— their own path —</option>
        ${leaders.map(s => `<option value="${s.id}" ${o.follow === s.id ? 'selected' : ''}>${playerName(s)} (${s.color})</option>`).join('')}</select></label>`);
      if (o.follow) extra.push(`<p class="muted small">Skates ${playerName(getObj(o.follow))}'s route from their own spot in line. Edit that skater's path to reroute everyone; stagger the line with each skater's Delay.</p>`);
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
  if (o.type === 'zone') extra.push(`<button data-act="focus">Focus view on zone</button>`);
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

  body.innerHTML = `<p><b>${TYPE_NAMES[o.type] || o.type}</b> <span class="muted">(${G.round1(o.x ?? o.points?.[0]?.x ?? 0)}, ${G.round1(o.y ?? o.points?.[0]?.y ?? 0)})</span></p>${fields}${custom}<div class="row">${extra.join('')}</div>`;
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
  const movers = drill().objects.filter(x => x.type === 'skater' && x.path?.length);
  const opt = val => `<option value="" ${!val ? 'selected' : ''}>— pick a skater —</option>` +
    movers.map(x => `<option value="${x.id}" ${x.id === val ? 'selected' : ''}>${playerName(x)} (${x.color})</option>`).join('');
  const info = sim.contactSync(o.id);
  const name = id => playerName(getObj(id) || {});
  let status;
  if (!o.a || !o.b || o.a === o.b) status = `<p class="warn">⚠ pick two different skaters (each needs a path)</p>`;
  else if (!info.ok) status = info.far
    ? `<p class="warn">⚠ marker is ${info.far.toFixed(0)} ft off the paths, so it is ignored — drag it onto the spot where the paths converge (or delete it)</p>`
    : `<p class="warn">⚠ both skaters need a skating path</p>`;
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
    const late = !rec?.late ? ''
      : ev.type === 'shoot' ? ` <span class="warn" title="They reach this waypoint before the puck gets back to them, so the shot happens later, from wherever they are once they have it">⚠ no puck yet at this waypoint — shot deferred</span>`
      : ` <span class="warn" title="The skater passes the marked spot before the puck reaches them, so this happens where they are when it arrives">⚠ puck arrives after the mark</span>`;
    const status = problem ? `<span class="warn">⚠ ${problem}</span>`
      : `<span class="muted">${ev.type === 'pass' && ev.by === 'receiver' ? `arrives t = ${rec.arrive.toFixed(1)} s` : `t = ${rec.t.toFixed(1)} s`}</span>${late}`;
    const onPath = ev.dist != null;
    const where = (prefix = 'at ') => onPath
      ? `<span>${prefix.trim()}</span><input class="wp" type="number" min="0" step="0.5" data-ev="${i}" data-evprop="dist" value="${ev.dist}" title="Feet along the skater's path"><span>ft on path</span>`
      : `<span>${prefix}waypoint</span><input class="wp" type="number" min="0" step="1" data-ev="${i}" data-evprop="wp" value="${ev.wp ?? 0}" title="0 = skater's start, 1… = path waypoints">`;
    const canMark = !!getObj(eventSkater(o, i))?.path?.length; // only a moving skater has a path to mark
    const mark = `<button data-act="mark" data-ev="${i}" ${canMark ? '' : 'disabled'} title="Click a spot on the skater's path to mark where this happens (you can also drag the marker on the ice)">📍 ${onPath ? 'Move mark' : 'Mark on path'}</button>`
      + (onPath ? `<button data-act="unmark" data-ev="${i}" title="Time this by waypoint instead">✕</button>` : '');
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
        + (ev.bank ? `<button data-act="bounce" data-ev="${i}" title="Click near the boards to set where the puck bounces (or drag the B marker on the ice)">Bounce point…</button>` : '');
      body = `<span>${who} passes to</span><select data-ev="${i}" data-evprop="to">${skaterOptions(ev.to, '— receiver —', ev.bank ? null : rec?.carrier, rec?.carrier)}</select>${bankUI}${bySel}${where('')}${arrive}${mark}`;
    }
    else if (ev.type === 'shoot') {
      const bankUI = `<label class="check"><input type="checkbox" data-ev="${i}" data-evprop="bank" ${ev.bank ? 'checked' : ''}> off the boards</label>`
        + (ev.bank ? `<button data-act="bounce" data-ev="${i}" title="Click near the boards to set where the puck bounces (or drag the B marker on the ice)">Bounce point…</button>` : '');
      body = `<span>${who}</span>${where()}<span>shoots at</span><span class="muted">${ev.target ? `(${G.round1(ev.target.x)}, ${G.round1(ev.target.y)})` : 'nearest net'}</span><button data-act="pick" data-ev="${i}">Pick target</button>${bankUI}${mark}`;
    }
    else body = `<select data-ev="${i}" data-evprop="skater">${skaterOptions(ev.skater, '— player —')}</select><span>picks it up</span>${where()}${mark}`;
    return `<div class="event">
      <div class="event-head">
        <select data-ev="${i}" data-evprop="type">${Object.entries(EV_TYPES).map(([k, v]) => `<option value="${k}" ${ev.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        ${status}<span class="spacer"></span>
        <button data-act="evup" data-ev="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-act="evdown" data-ev="${i}" ${i === evs.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-act="evdel" data-ev="${i}">✕</button>
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
  store.save(); renderCanvas(); renderAnimBar();
});
propsBody.addEventListener('change', () => { store.commitPending(); renderUI(); });
propsBody.addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  btn.blur(); // so renderProps() isn't skipped for "focus inside panel"
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
$('#practice-select').addEventListener('change', e => { finishActive(); store.switchPractice(e.target.value); sel = null; stopAnim(); renderAll(); });
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
wirePopover('#btn-new-practice', '#practice-pop', '#practice-team');
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
$('#btn-create-practice').addEventListener('click', () => {
  finishActive();
  store.addPractice(newPractice(store.practice.team || ''));
  sel = null; stopAnim(); renderAll();
  $('#practice-team').focus(); $('#practice-team').select(); // popover stays open on the fresh practice
});
$('#btn-dup-practice').addEventListener('click', () => {
  const copy = JSON.parse(JSON.stringify(store.practice));
  copy.id = uid(); copy.date = new Date().toISOString().slice(0, 10);
  copy.drills.forEach(d => { d.id = uid(); d.objects = cloneObjects(d.objects); });
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
      p.id = uid(); p.drills.forEach(d => { d.id = uid(); d.view = d.view || { ...VIEWS.full }; d.objects = cloneObjects(migrateDrill(d).objects); });
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
const parseStart = p => /^\d{1,2}:\d{2}$/.test(p.time || '') ? p.time.split(':').reduce((h, m) => +h * 60 + +m) : null;
const clock = m => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}`;
const ampm = m => (Math.floor(m / 60) % 24) < 12 ? 'am' : 'pm';
const longDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '')
  ? new Date(date + 'T12:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
  : (date || '');

$('#btn-print').addEventListener('click', () => {
  const p = store.practice;
  const rink = rinkSVG();
  const total = p.drills.reduce((a, d) => a + (+d.duration || 0), 0);
  const startMin = parseStart(p);
  let t = startMin;
  const drillRows = p.drills.map((d, i) => {
    const at = t; if (t != null) t += (+d.duration || 0);
    return `
      <div class="p-drill">
        <div class="p-head"><b>${i + 1}. ${escHtml(d.name)}</b><span class="p-meta">(${+d.duration || 0} minutes)</span>${at != null ? `<span class="p-time">${clock(at)}</span>` : ''}</div>
        ${standaloneSVG(d, rink, SVG_STYLE)}
        ${d.notes ? `<pre>${escHtml(d.notes)}</pre>` : ''}
      </div>`;
  }).join('');
  $('#print-area').innerHTML = `
    <div class="p-title">${escHtml(p.team || 'Practice')}</div>
    <div class="p-sub">${escHtml(longDate(p.date))}${startMin != null ? `; ${clock(startMin)}${ampm(startMin)}` : ''}</div>
    ${p.coaches ? `<div class="p-sub">Coaches: ${escHtml(p.coaches)}</div>` : ''}
    <div class="p-overview">${p.drills.map(d => standaloneSVG(d, rink, SVG_STYLE)).join('')}</div>
    <div class="p-sub">${startMin != null ? `Start @ ${clock(startMin)}` : ''} <span class="p-meta">${p.drills.length} drills · ${total} min</span></div>
    <div class="p-cols">
    ${drillRows}
    <div class="p-drill"><div class="p-head"><b>* Dismissal</b>${startMin != null ? `<span class="p-time">${clock(startMin + total)}</span>` : ''}</div></div>
    </div>`;
  window.print();
});

// ---------- presentation mode: a read-only scroll-through at #view=<ownerUid>/<practiceId> ----------
// The owner opens it with 📺 Present; coaches listed in the practice's "Coach emails" open the same
// link, sign in with Google, and read the practice live from the owner's cloud account.
let presenting = false;
let presentUnsub = null, presentKey = null;
let cloudSync = null, cloudBackend = null; // set once Firebase boots (below)

function presentHTML(p) {
  const rink = rinkSVG();
  const total = p.drills.reduce((a, d) => a + (+d.duration || 0), 0);
  const startMin = parseStart(p);
  let t = startMin;
  return `
    <div class="pr-team">${escHtml(p.team || 'Practice')}</div>
    <div class="pr-meta">${escHtml(longDate(p.date))}${startMin != null ? `; ${clock(startMin)}${ampm(startMin)}` : ''}</div>
    ${p.coaches ? `<div class="pr-meta">Coaches: ${escHtml(p.coaches)}</div>` : ''}
    <div class="pr-meta">${p.drills.length} drills · ${total} min${startMin != null ? ` · start @ ${clock(startMin)}` : ''}</div>
    ${p.drills.map((d, i) => {
      const at = t; if (t != null) t += (+d.duration || 0);
      if (isPSDrill(d)) return `
      <section class="pr-drill" data-did="${d.id}">
        <header><b>${i + 1}. ${escHtml(d.name)}</b><span class="pr-min">(${+d.duration || 0} min)</span>${at != null ? `<span class="pr-time">${clock(at)}</span>` : ''}</header>
        <ul class="pr-ps">${(d.psElements || []).map(k => { const e = PS_ELEMENTS.find(x => x.key === k); return e ? `<li><b>${escHtml(e.name)}</b> — ${escHtml(e.desc)}</li>` : ''; }).join('') || '<li class="muted">Technique work — elements on the whiteboard.</li>'}</ul>
        ${d.notes ? `<pre>${escHtml(d.notes)}</pre>` : ''}
      </section>`;
      return `
      <section class="pr-drill" data-did="${d.id}">
        <header><b>${i + 1}. ${escHtml(d.name)}</b><span class="pr-min">(${+d.duration || 0} min)</span>${at != null ? `<span class="pr-time">${clock(at)}</span>` : ''}</header>
        ${standaloneSVG(d, rink, SVG_STYLE, undefined, { showPaths: d.showPaths !== false })}
        <div class="pr-animbar">
          <button class="pr-play" title="Watch the drill">▶</button>
          <input type="range" class="pr-tl" min="0" max="10" step="0.01" value="0">
          <span class="pr-timedisp muted small"></span>
          <select class="pr-speed" title="Playback speed">${['0.25', '0.5', '1', '2'].map(s => `<option value="${s}" ${+s === (+d.animSpeed || 1) ? 'selected' : ''}>${s}×</option>`).join('')}</select>
          <label class="check small"><input type="checkbox" class="pr-paths" ${d.showPaths !== false ? 'checked' : ''}> paths</label>
          <span class="pr-impact"></span>
        </div>
        ${d.notes ? `<pre>${escHtml(d.notes)}</pre>` : ''}
      </section>`;
    }).join('')}
    ${startMin != null ? `<section class="pr-drill"><header><b>* Dismissal</b><span class="pr-time">${clock(startMin + total)}</span></header></section>` : ''}`;
}

function presentDoc(p) {
  $('#present-title').textContent = practiceLabel(p);
  $('#present-body').innerHTML = presentHTML(p);
  wirePresentAnims(p);
  $('#present-gate').hidden = true;
  presentNote('');
}
/** Status line under the presentation top bar (e.g. "Offline copy from …"); '' hides it. */
function presentNote(text) {
  $('#present-note').textContent = text;
  $('#present-note').hidden = !text;
}

// Each drill card gets its own little player: ▶/⏸, a scrubber and the drill clock,
// driving animateFrame() on that card's SVG copy of the drill.
const presentAnims = [];
function stopPresentAnims() { for (const a of presentAnims) cancelAnimationFrame(a.raf); presentAnims.length = 0; }
function wirePresentAnims(p) {
  stopPresentAnims();
  const rinkStr = rinkSVG();
  for (const sec of $$('#present-body .pr-drill[data-did]')) {
    const d = p.drills.find(x => x.id === sec.dataset.did);
    let svgEl = sec.querySelector('svg');
    const bar = sec.querySelector('.pr-animbar');
    if (!d || !svgEl || !bar) continue;
    // The card animates a local view of the drill, so a coach's tweaks (impact loser) never touch the practice.
    const dcur = { ...d };
    let sm = makeSim(dcur);
    let T = sm.duration();
    if (T <= 0) { bar.remove(); continue; } // nothing moves in this drill
    let full = T + returnTime(dcur, sm); // the drill, then everyone skates home at 2× speed
    const fx = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    svgEl.appendChild(fx);
    const btn = bar.querySelector('.pr-play'), tl = bar.querySelector('.pr-tl'), disp = bar.querySelector('.pr-timedisp');
    let spd = +d.animSpeed || 1; // seeded from the drill's saved playback speed
    bar.querySelector('.pr-speed')?.addEventListener('change', e => spd = +e.target.value);
    bar.querySelector('.pr-paths')?.addEventListener('change', e => { // re-render this card with paths on/off
      const tmp = document.createElement('div');
      tmp.innerHTML = standaloneSVG(dcur, rinkStr, SVG_STYLE, undefined, { showPaths: e.target.checked });
      const fresh = tmp.firstElementChild;
      svgEl.replaceWith(fresh);
      svgEl = fresh;
      svgEl.appendChild(fx);
      draw();
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
        T = sm.duration();
        full = T + returnTime(dcur, sm);
        tl.max = T;
        a.t = Math.min(a.t, full);
        draw();
      });
    }
    tl.max = T;
    const a = { raf: 0, t: 0, playing: false, last: 0 };
    presentAnims.push(a);
    const draw = () => {
      animateFrame(dcur, sm, svgEl, fx, a.t, a.playing);
      tl.value = Math.min(a.t, T);
      disp.textContent = `${Math.min(a.t, T).toFixed(1)} / ${T.toFixed(1)} s`;
      btn.textContent = a.playing ? '⏸' : '▶';
    };
    const step = now => {
      if (!a.playing) return;
      a.t += Math.min(0.1, (now - a.last) / 1000) * spd; a.last = now;
      if (a.t >= full) { a.t = full; a.playing = false; }
      draw();
      if (a.playing) a.raf = requestAnimationFrame(step);
    };
    btn.addEventListener('click', () => {
      a.playing = !a.playing;
      if (a.playing) { if (a.t >= full) a.t = 0; a.last = performance.now(); a.raf = requestAnimationFrame(step); }
      else cancelAnimationFrame(a.raf);
      draw();
    });
    tl.addEventListener('input', () => { a.t = +tl.value; draw(); });
    draw();
  }
}
function presentMsg(msg, canSignIn = false) {
  $('#present-gate').hidden = false;
  $('#present-msg').textContent = msg;
  $('#present-signin').hidden = !canSignIn;
}

/** Show/hide presentation mode to match the URL; called at boot, on hash changes and on sign-in changes. */
function refreshPresent() {
  const m = location.hash.match(/view=(\w+)\/(\w+)/);
  presenting = !!m;
  document.body.classList.toggle('presenting', presenting);
  $('#present').hidden = !presenting;
  if (!presenting) { stopPresentAnims(); presentUnsub?.(); presentUnsub = null; presentKey = null; return; }
  $('#present-user').textContent = cloudSync?.user?.name || '';
  const [, ownerUid, pid] = m;
  const mine = store.data.practices.find(x => x.id === pid);
  if (mine) { presentUnsub?.(); presentUnsub = null; presentKey = null; presentDoc(mine); return; } // own practice: straight from the store
  // Rink mode: a previously viewed copy is kept on this device, shown immediately, and replaced live when online.
  const key = `${ownerUid}/${pid}`;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(`hpp.viewcache.${key}`) || 'null'); } catch { cached = null; }
  const showCached = note => {
    if (!cached?.p) return false;
    (cached.p.drills || []).forEach(migrateDrill);
    presentDoc(cached.p);
    presentNote(`Offline copy from ${new Date(cached.at).toLocaleString()} — ${note}`);
    return true;
  };
  if (!cloudBackend) { if (!showCached('reconnect to get updates.')) presentMsg('This practice is not available on this device.'); return; }
  if (!cloudSync?.user) { if (!showCached('sign in when online to get updates.')) presentMsg('This practice plan is shared with specific coaches. Sign in to view it.', true); return; }
  if (presentKey === key) return; // already watching this practice
  presentUnsub?.();
  presentKey = key;
  if (!showCached('checking for updates…')) presentMsg('Loading…');
  presentUnsub = cloudBackend.subscribePractice(ownerUid, pid, (p, err) => {
    if (err) {
      const msg = err.code === 'permission-denied'
        ? "You don't have access to this practice. Ask the coach who shared it to add your Google email in the practice details."
        : `Could not load the practice: ${err.message || err}`;
      if (!showCached('could not reach the cloud.')) presentMsg(msg);
      return;
    }
    if (!p) return presentMsg('This practice no longer exists.');
    (p.drills || []).forEach(migrateDrill);
    try { localStorage.setItem(`hpp.viewcache.${key}`, JSON.stringify({ p, at: Date.now() })); } catch { /* full/blocked storage: live view still works */ }
    cached = { p, at: Date.now() };
    presentDoc(p);
  });
}

$('#btn-present').addEventListener('click', () => {
  // Presentation is its own destination (same URL coaches get) — a new tab, so the editor stays put.
  window.open(`${location.origin}${location.pathname}#view=${store.data.ownerUid || 'local'}/${store.practice.id}`, '_blank');
});
$('#present-signin').addEventListener('click', () => cloudSync?.signIn().catch(e => presentMsg(`Sign-in failed: ${e?.message || e}`, true)));
$('#btn-share-link').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (!store.data.ownerUid) return alert('Sign in first — coaches read the practice from your cloud account.');
  const url = `${location.origin}${location.pathname}#view=${store.data.ownerUid}/${store.practice.id}`;
  try { await navigator.clipboard.writeText(url); } catch { prompt('Copy this link:', url); return; }
  const old = b.textContent;
  b.textContent = '✓ Link copied';
  setTimeout(() => { b.textContent = old; }, 1500);
});

// ---------- cloud sync (Firebase) ----------
const CLOUD_LABELS = { signedout: 'Not signed in (local only)', syncing: 'Syncing…', saving: 'Saving…', saved: 'Saved ✓', error: 'Cloud error' };
function renderCloudStatus(sync, state, detail) {
  const u = sync.user;
  $('#cloud-status').textContent = (u && state !== 'signedout' ? `${u.name} · ` : '') + (CLOUD_LABELS[state] || '') + (state === 'error' && detail ? ` (${detail})` : '');
  $('#cloud-status').classList.toggle('warn', state === 'error');
  $('#btn-signin').hidden = !!u;
  $('#btn-signout').hidden = !u;
}
/** Show (state = 'checking' | 'signedout' | 'error') or hide (null) the sign-in gate that covers the app. */
function setGate(state, detail = '') {
  gated = !!state;
  $('#gate').hidden = !state;
  document.body.classList.toggle('gated', gated);
  if (!state) return;
  finishActive(); pickTarget = null; if (anim.playing) togglePlay();
  $('#gate-msg').textContent = state === 'checking' ? 'Checking your sign-in…' : 'Sign in to plan practices. Your practices are saved to your account and follow you between devices.';
  $('#gate-signin').hidden = state === 'checking';
  $('#gate-detail').textContent = state === 'error' ? `Sign-in failed: ${detail}` : '';
}

(async () => {
  // `globalThis.__hppBackend` lets tests plug in a fake backend; otherwise use Firebase when configured.
  let backend = globalThis.__hppBackend || null;
  let cfg = null;
  if (!backend) {
    cfg = await loadConfig();
    if (cfg) {
      setGate('checking');
      try { backend = await firebaseBackend(cfg); }
      catch { setGate(null); } // offline and the SDK isn't cached yet: run local-only rather than hang the gate
    }
  }
  if (!backend) { refreshPresent(); return; } // no config (or offline boot): local-only; presentation falls back to its offline copy
  setGate('checking');
  $('#cloud').hidden = false;
  const sync = createSync({
    store, backend,
    onStatus: (state, detail) => {
      renderCloudStatus(sync, state, detail);
      // The app is only usable while signed in.
      if (state === 'signedout') setGate('signedout');
      else if (state === 'error' && !sync.user) setGate('error', detail);
      else if (sync.user) setGate(null);
      refreshPresent(); // presentation mode reacts to sign-in changes too
    },
    onRemote: (ids, { full } = {}) => {
      // Practices changed from another device (or first sync): refresh what is on screen.
      if (full || ids.includes(store.data.currentId) || !store.practice) { finishActive(); sel = null; stopAnim(); renderAll(); }
      else renderPracticeSelect();
      if (presenting) refreshPresent(); // presenting one's own practice: pick up the change live
    },
    onRoster: () => { if (!$('#teammgr').hidden) renderTeamMgr(); }, // roster edited on another device
  });
  cloudSync = sync; cloudBackend = backend;
  $('#gate-signin').addEventListener('click', () => sync.signIn().catch(e => setGate('error', e?.message || String(e))));
  $('#btn-signin').addEventListener('click', () => sync.signIn().catch(e => renderCloudStatus(sync, 'error', e?.message || String(e))));
  $('#btn-signout').addEventListener('click', () => sync.signOut().catch(e => renderCloudStatus(sync, 'error', e?.message || String(e))));
  renderCloudStatus(sync, 'signedout');
})();

// ---------- boot ----------
// Offline support: cache the app shell so the rink works without internet (needs HTTPS or localhost).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
applyRoute();
setTool('select');
refreshPresent();
renderAll();
window.addEventListener('resize', drawSelection);
