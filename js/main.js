import { RINK, VIEWS, rinkSVG, SVG_STYLE } from './rink.js';
import * as G from './geometry.js';
import { renderObjects, standaloneSVG, setStick, SKATER_COLORS, ZONE_COLORS, ARROW_STYLES } from './render.js';
import { makeSim, facingOf, DEFAULT_PASS_SPEED, DEFAULT_SHOT_SPEED } from './sim.js';
import { Store, uid, newDrill, newPractice, cloneObjects, migrateDrill } from './store.js';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const isEditing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

// ---------- setup ----------
const svg = $('#rink');
svg.innerHTML = `<style>${SVG_STYLE}</style><g id="rink-layer">${rinkSVG()}</g><g id="obj-layer"></g><g id="overlay-layer"></g>`;
const objLayer = svg.querySelector('#obj-layer');
const overlay = svg.querySelector('#overlay-layer');

const store = new Store();
let tool = 'select';
let sel = null;            // selected object id
let activeSkater = null;   // skater currently receiving waypoints
let activePoly = null;     // barricade/arrow currently being drawn
let drag = null;           // current pointer drag operation
let spaceDown = false;
let snap = false;
let showPaths = true;
let lastSkaterColor = 'blue';
let lastZoneColor = 0;

const anim = { playing: false, t: 0, speed: 1, loop: true, raf: null, last: 0 };
let sim = null;          // simulation of the current drill (rebuilt on every canvas render)
let pickTarget = null;   // { puckId, ev } while waiting for a click to set a shot target

const drill = () => store.drill;
const getObj = id => drill().objects.find(o => o.id === id);
const snapPt = p => snap ? { x: Math.round(p.x), y: Math.round(p.y) } : { x: G.round1(p.x), y: G.round1(p.y) };

function toRink(e) {
  const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return { x: pt.x, y: pt.y };
}

// ---------- rendering ----------
function renderCanvas() {
  const d = drill();
  svg.setAttribute('viewBox', `${d.view.x} ${d.view.y} ${d.view.w} ${d.view.h}`);
  sim = makeSim(d);
  objLayer.innerHTML = renderObjects(d, sel, { tool, showPaths, sim, numberWaypoints: getObj(sel)?.type === 'puck' });
  drawSelection();
  if (anim.t > 0) applyAnimation(anim.t);
  $$('#viewbar [data-view]').forEach(b => b.classList.toggle('active', sameView(VIEWS[b.dataset.view], d.view)));
}

function sameView(a, b) { return a && b && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < 0.01); }

function drawSelection() {
  overlay.innerHTML = '';
  if (!sel) return;
  const el = objLayer.querySelector(`[data-id="${sel}"]`);
  if (!el) { sel = null; return; }
  const target = el.querySelector('.body, .puck-disc') || el; // body only, so the stick doesn't inflate the box
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
  renderDrillProps();
  renderProps();
  renderAnimBar();
  $('#btn-undo').disabled = !store.undoStack.length;
  $('#btn-redo').disabled = !store.redoStack.length;
}

function renderAll() { renderCanvas(); renderUI(); }

/** Push an undo snapshot, apply a mutation, save and re-render. */
function commit(fn) {
  store.pushUndo();
  fn?.();
  store.save();
  renderAll();
}

// ---------- tools ----------
const HINTS = {
  select: 'Click to select · drag to move · drag handles to reshape · double-click a waypoint to delete it · Delete removes',
  pan: 'Drag to pan · wheel to zoom',
  skater: 'Click to place a skater, then click (or drag) to add path waypoints · Enter/Esc to finish · click an existing skater to extend',
  coach: 'Click to place a coach · or drag the Coach button straight onto the ice',
  arrow: 'Click points · double-click or Enter to finish · Esc cancels',
  cone: 'Click to place a cone', tire: 'Click to place a tire', puck: 'Click a skater to give them a puck · click open ice for a loose puck · select a puck to add passes & shots', net: 'Click to place a net (rotate in Selection panel)',
  obstacle: 'Drag a box to add an obstacle / pad',
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

/** Finish any in-progress skater path or polyline. */
function finishActive() {
  let changed = false;
  if (activePoly) {
    const o = getObj(activePoly);
    if (o) {
      o.points.pop(); // drop the preview point
      while (o.points.length > 1 && G.dist(o.points.at(-1), o.points.at(-2)) < 0.2) o.points.pop();
      if (o.points.length < 2) drill().objects = drill().objects.filter(x => x.id !== o.id);
    }
    activePoly = null; changed = true;
  }
  if (activeSkater) { activeSkater = null; changed = true; }
  if (changed) { store.save(); renderAll(); }
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
const PLACEABLE = new Set(['coach', 'skater', 'cone', 'tire', 'puck', 'net']);

/** A fresh object of the given placeable type at point p (no id yet). */
function makePlaceable(type, p) {
  const count = t => drill().objects.filter(x => x.type === t).length;
  switch (type) {
    case 'coach': { const k = count('coach'); return { type: 'coach', x: p.x, y: p.y, label: k ? `C${k + 1}` : 'C', color: 'black' }; }
    case 'skater': return { type: 'skater', x: p.x, y: p.y, label: String(count('skater') + 1), color: lastSkaterColor, role: 'F', speed: 20, delay: 0, backward: false, path: [] };
    case 'cone': return { type: 'cone', x: p.x, y: p.y, color: '#ff6a00' };
    case 'tire': return { type: 'tire', x: p.x, y: p.y };
    case 'net': return { type: 'net', x: p.x, y: p.y, rot: p.x > RINK.W / 2 ? 180 : 0 };
    case 'puck': {
      // Dropped onto a skater without a puck → that skater carries it.
      const s = drill().objects.find(o => o.type === 'skater' && G.dist(o, p) < 3);
      const taken = s && drill().objects.some(o => o.type === 'puck' && o.carrier === s.id);
      return newPuck(p, s && !taken ? s.id : null);
    }
  }
  return null;
}

function deleteObject(id) {
  if (!id) return;
  const victim = getObj(id);
  commit(() => {
    const d = drill();
    d.objects = d.objects.filter(o => o.id !== id);
    if (victim?.type === 'skater') for (const pk of d.objects) if (pk.type === 'puck') {
      if (pk.carrier === id) { pk.carrier = null; pk.x = victim.x; pk.y = victim.y; }
      pk.events = (pk.events || []).filter(ev => ev.to !== id && ev.skater !== id);
    }
  });
  if (sel === id) sel = null;
  if (activeSkater === id) activeSkater = null;
  renderAll();
}

function select(id) { sel = id; renderCanvas(); renderProps(); }

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
    const ev = getObj(pickTarget.puckId)?.events?.[pickTarget.ev];
    pickTarget = null;
    $('#hint').textContent = HINTS[tool] || '';
    if (ev) commit(() => ev.target = { x: p.x, y: p.y });
    return;
  }

  if (e.button === 1 || spaceDown || tool === 'pan') {
    drag = { type: 'pan', sx: e.clientX, sy: e.clientY, view: { ...drill().view } };
    document.body.classList.add('panning');
    return;
  }

  switch (tool) {
    case 'select': {
      if (handleEl && id) {
        const o = getObj(id);
        drag = { type: 'handle', id, index: +handleEl.dataset.handle, key: o.type === 'skater' ? 'path' : 'points', pushed: false };
        select(id);
      } else if (id) {
        const o = getObj(id);
        if (o.type === 'puck' && o.carrier) { const q = sim.puckPos(o.id, 0); o.x = G.round1(q.x); o.y = G.round1(q.y); }
        drag = { type: 'move', id, start: raw, orig: JSON.parse(JSON.stringify(o)), pushed: false };
        select(id);
      } else {
        select(null);
      }
      break;
    }
    case 'skater': {
      const o = id && getObj(id);
      if (o?.type === 'skater' && o.id !== activeSkater) {
        activeSkater = o.id; select(o.id);
      } else if (activeSkater && getObj(activeSkater)) {
        drag = { type: 'freehand', id: activeSkater, pts: [raw], start: p };
      } else {
        const s = addObject(makePlaceable('skater', p));
        activeSkater = s.id; select(s.id);
      }
      break;
    }
    case 'coach': select(addObject(makePlaceable('coach', p)).id); break;
    case 'cone': addObject(makePlaceable('cone', p)); break;
    case 'tire': addObject(makePlaceable('tire', p)); break;
    case 'puck': {
      const s = id && getObj(id);
      if (s?.type === 'skater') {
        const existing = drill().objects.find(o => o.type === 'puck' && o.carrier === s.id);
        if (existing) select(existing.id);
        else select(addObject(newPuck(p, s.id)).id);
      } else if (s?.type === 'puck') {
        select(s.id);
      } else {
        select(addObject(newPuck(p, null)).id);
      }
      break;
    }
    case 'net': addObject(makePlaceable('net', p)); break;
    case 'text': { const t = addObject({ type: 'text', x: p.x, y: p.y, text: 'Label', size: 3, color: '#111' }); select(t.id); focusProp('text'); break; }
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
      const tr = q => ({ x: G.round1(q.x + dx), y: G.round1(q.y + dy) });
      if (o.points) o.points = drag.orig.points.map(tr);
      else { Object.assign(o, tr(drag.orig)); if (o.path) o.path = drag.orig.path.map(tr); }
      if (o.type === 'puck') o.carrier = null; // dragging detaches; dropping on a skater re-attaches (see onPointerUp)
      renderCanvas();
      break;
    }
    case 'handle': {
      const o = getObj(drag.id); if (!o) return;
      if (!drag.pushed) { store.pushUndo(); drag.pushed = true; }
      o[drag.key][drag.index] = p;
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
  if (!drag) return;
  const dg = drag; drag = null;
  const d = drill();
  switch (dg.type) {
    case 'pan': store.save(); break;
    case 'move': {
      const o = getObj(dg.id);
      if (o?.type === 'puck' && dg.pushed) {
        const target = d.objects.find(s => s.type === 'skater' && G.dist(s, o) < 3);
        o.carrier = target ? target.id : null;
      }
      store.save(); renderAll(); break;
    }
    case 'handle': store.save(); renderAll(); break;
    case 'rect': {
      const o = getObj(dg.id);
      if (o.w < 1.5 || o.h < 1.5) {
        if (o.type === 'obstacle') { o.w = 4; o.h = 2; }
        else d.objects = d.objects.filter(x => x.id !== o.id);
      }
      store.save();
      sel = getObj(dg.id) ? dg.id : null;
      renderAll();
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

function onDblClick(e) {
  const handleEl = e.target.closest('[data-handle]');
  const idEl = e.target.closest('[data-id]');
  if (tool === 'select' && handleEl && idEl) {
    const o = getObj(idEl.dataset.id);
    const key = o.type === 'skater' ? 'path' : 'points';
    if (key === 'points' && o.points.length <= 2) return;
    commit(() => o[key].splice(+handleEl.dataset.handle, 1));
    return;
  }
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
  const keys = { v: 'select', h: 'pan', s: 'skater', k: 'coach', a: 'arrow', c: 'cone', t: 'tire', p: 'puck', n: 'net', o: 'obstacle', b: 'barricade', z: 'zone', x: 'text', e: 'erase' };
  const t = keys[e.key.toLowerCase()];
  if (t) setTool(t);
});
document.addEventListener('keyup', e => {
  if (e.key === ' ') {
    if (spaceDown && !isEditing() && !drag) togglePlay();
    spaceDown = false;
  }
});

function translateObj(o, dx, dy) {
  if (!o) return;
  const tr = q => ({ x: G.round1(q.x + dx), y: G.round1(q.y + dy) });
  if (o.points) o.points = o.points.map(tr);
  else { Object.assign(o, tr(o)); if (o.path) o.path = o.path.map(tr); }
}

function doUndo() { finishActive(); if (store.undo()) { sel = null; renderAll(); } }
function doRedo() { if (store.redo()) { sel = null; renderAll(); } }

// ---------- animation ----------
function totalDuration() { return sim ? sim.duration() : 0; }

function applyAnimation(t) {
  for (const o of drill().objects) {
    let el, p;
    if (o.type === 'skater' && o.path?.length) {
      p = sim.skaterPose(o.id, t); el = objLayer.querySelector(`.skater-body[data-skater="${o.id}"]`);
      if (el) setStick(el.querySelector('.stick'), p.heading, p.lat);
    }
    else if (o.type === 'puck') { p = sim.puckPos(o.id, t); el = objLayer.querySelector(`.puck-disc[data-puck="${o.id}"]`); }
    if (el) el.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
  }
}

function tick(now) {
  if (!anim.playing) return;
  const dt = Math.min(0.1, (now - anim.last) / 1000);
  anim.last = now;
  anim.t += dt * anim.speed;
  const T = totalDuration();
  if (anim.t >= T) {
    if (anim.loop && T > 0) anim.t = 0;
    else { anim.t = T; anim.playing = false; }
  }
  applyAnimation(anim.t);
  renderAnimBar();
  if (anim.playing) anim.raf = requestAnimationFrame(tick);
}

function togglePlay() {
  if (anim.playing) { anim.playing = false; cancelAnimationFrame(anim.raf); }
  else {
    if (totalDuration() <= 0) return;
    if (anim.t >= totalDuration()) anim.t = 0;
    anim.playing = true; anim.last = performance.now();
    anim.raf = requestAnimationFrame(tick);
  }
  renderAnimBar();
}

function stopAnim() {
  anim.playing = false; cancelAnimationFrame(anim.raf); anim.t = 0;
  renderCanvas(); renderAnimBar();
}

function renderAnimBar() {
  const T = totalDuration();
  $('#btn-play').textContent = anim.playing ? '⏸' : '▶';
  $('#btn-play').disabled = T <= 0;
  const tl = $('#timeline');
  tl.max = Math.max(T, 0.01); tl.value = Math.min(anim.t, T);
  $('#time-display').textContent = `${anim.t.toFixed(1)} / ${T.toFixed(1)} s`;
}

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-stop').addEventListener('click', stopAnim);
$('#timeline').addEventListener('input', e => { anim.t = +e.target.value; if (anim.t === 0) renderCanvas(); else applyAnimation(anim.t); renderAnimBar(); });
$('#anim-speed').addEventListener('change', e => anim.speed = +e.target.value);
$('#anim-loop').addEventListener('change', e => anim.loop = e.target.checked);
$('#anim-trails').addEventListener('change', e => { showPaths = e.target.checked; renderCanvas(); });

// ---------- view bar ----------
$$('#viewbar [data-view]').forEach(b => b.addEventListener('click', () => setView(VIEWS[b.dataset.view])));
$('#btn-zoom-in').addEventListener('click', () => { const v = drill().view; zoomAt({ x: v.x + v.w / 2, y: v.y + v.h / 2 }, 1 / 1.25); });
$('#btn-zoom-out').addEventListener('click', () => { const v = drill().view; zoomAt({ x: v.x + v.w / 2, y: v.y + v.h / 2 }, 1.25); });
$('#snap-toggle').addEventListener('change', e => snap = e.target.checked);
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
  select(o.id);
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
  s.innerHTML = store.data.practices.map(p => `<option value="${p.id}">${escHtml(p.name || 'Untitled')}${p.date ? ' — ' + p.date : ''}</option>`).join('');
  s.value = store.data.currentId;
}
const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderPracticeProps() {
  const p = store.practice;
  for (const [id, key] of [['#practice-name', 'name'], ['#practice-team', 'team'], ['#practice-date', 'date']]) {
    const el = $(id);
    if (document.activeElement !== el) el.value = p[key] || '';
  }
}
for (const [id, key] of [['#practice-name', 'name'], ['#practice-team', 'team'], ['#practice-date', 'date']]) {
  const el = $(id);
  el.addEventListener('focus', () => store.beginPending());
  el.addEventListener('input', () => { store.practice[key] = el.value; store.save(); renderPracticeSelect(); });
  el.addEventListener('change', () => { store.commitPending(); renderUI(); });
}

function renderPlan() {
  const p = store.practice;
  const total = p.drills.reduce((a, d) => a + (+d.duration || 0), 0);
  $('#plan-total').textContent = `${total} min total`;
  $('#drill-list').innerHTML = p.drills.map((d, i) => `
    <li class="${i === store.drillIndex ? 'active' : ''}" data-index="${i}">
      <span class="name">${i + 1}. ${escHtml(d.name)}</span>
      <span class="dur">${+d.duration || 0} min</span>
      <button data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button data-act="down" title="Move down" ${i === p.drills.length - 1 ? 'disabled' : ''}>↓</button>
      <button data-act="dup" title="Duplicate">⧉</button>
      <button data-act="del" title="Delete" ${p.drills.length === 1 ? 'disabled' : ''}>✕</button>
    </li>`).join('');
}

$('#drill-list').addEventListener('click', e => {
  const li = e.target.closest('li'); if (!li) return;
  const i = +li.dataset.index;
  const act = e.target.closest('button')?.dataset.act;
  const p = store.practice;
  finishActive();
  if (!act) { switchDrill(i); return; }
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
    commit(() => { p.drills.splice(i, 1); store.drillIndex = Math.min(i, p.drills.length - 1); });
  }
  sel = null; stopAnim(); renderAll();
});

function switchDrill(i) {
  store.drillIndex = i; sel = null; stopAnim(); renderAll();
}

$('#btn-add-drill').addEventListener('click', () => {
  finishActive();
  const p = store.practice;
  commit(() => { p.drills.push(newDrill(p.drills.length + 1)); store.drillIndex = p.drills.length - 1; });
  sel = null; stopAnim(); renderAll();
});

function renderDrillProps() {
  const d = drill();
  for (const [id, key] of [['#drill-name', 'name'], ['#drill-duration', 'duration'], ['#drill-notes', 'notes']]) {
    const el = $(id);
    if (document.activeElement !== el) el.value = d[key] ?? '';
  }
}
for (const [id, key] of [['#drill-name', 'name'], ['#drill-duration', 'duration'], ['#drill-notes', 'notes']]) {
  const el = $(id);
  el.addEventListener('focus', () => store.beginPending());
  el.addEventListener('input', () => { drill()[key] = key === 'duration' ? +el.value : el.value; store.save(); renderPlan(); });
  el.addEventListener('change', () => { store.commitPending(); renderUI(); });
}

// ---------- selection properties ----------
const PROPS = {
  skater: [
    ['label', 'text', 'Label'], ['color', 'swatch', 'Color'], ['role', 'select:F=Forward,D=Defense,G=Goalie', 'Role'],
    ['speed', 'number', 'Speed (ft/s)'], ['delay', 'number', 'Start delay (s)'],
    ['backward', 'checkbox', 'Skating backward'], ['facing', 'number', 'Facing (°, blank = auto)'],
  ],
  coach: [['label', 'text', 'Label'], ['color', 'swatch', 'Color'], ['facing', 'number', 'Facing (°, blank = auto)']],
  cone: [['color', 'color', 'Color']],
  tire: [],
  puck: [['passSpeed', 'number', 'Pass speed (ft/s)'], ['shotSpeed', 'number', 'Shot speed (ft/s)']],
  net: [['rot', 'number', 'Rotation (°)']],
  obstacle: [['label', 'text', 'Label'], ['w', 'number', 'Width (ft)'], ['h', 'number', 'Depth (ft)'], ['rot', 'number', 'Rotation (°)']],
  zone: [['label', 'text', 'Label'], ['color', 'zoneswatch', 'Color'], ['w', 'number', 'Width (ft)'], ['h', 'number', 'Height (ft)']],
  barricade: [],
  arrow: [['style', 'select:' + Object.entries(ARROW_STYLES).map(([k, v]) => `${k}=${v}`).join(','), 'Style'], ['color', 'color', 'Color']],
  text: [['text', 'text', 'Text'], ['size', 'number', 'Size'], ['color', 'color', 'Color']],
};
const TYPE_NAMES = { skater: 'Skater', coach: 'Coach', cone: 'Cone', tire: 'Tire', puck: 'Puck', net: 'Net', obstacle: 'Obstacle', zone: 'Zone', barricade: 'Barricade', arrow: 'Arrow', text: 'Text' };

function renderProps() {
  const body = $('#props-body');
  if (body.contains(document.activeElement)) return; // don't clobber an input being edited
  const o = sel && getObj(sel);
  if (!o) { body.innerHTML = '<p class="muted">Nothing selected. Click an object with the Select tool.</p>'; return; }
  const fields = (PROPS[o.type] || [])
    .filter(([key]) => !(key === 'facing' && o.type === 'skater' && o.path?.length)) // a moving skater faces along its path
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

  const custom = o.type === 'puck' ? puckProps(o) : '';
  const extra = [];
  if (o.type === 'skater') {
    const tm = sim.skater(o.id);
    extra.push(`<p class="muted">Path: ${tm.len.toFixed(0)} ft · ${(tm.len / tm.speed).toFixed(1)} s${o.path?.length ? '' : ' (no path yet — use the Skater tool to add waypoints)'}</p>`);
    const myPuck = drill().objects.find(pk => pk.type === 'puck' && pk.carrier === o.id);
    extra.push(myPuck ? `<button data-act="selpuck">Puck: passes &amp; shots…</button>` : `<button data-act="givepuck">Give puck</button>`);
    extra.push(`<button data-act="extend">Extend path</button>`);
    extra.push(`<button data-act="clearpath" ${o.path?.length ? '' : 'disabled'}>Clear path</button>`);
  }
  if (o.type === 'zone') extra.push(`<button data-act="focus">Focus view on zone</button>`);
  if (o.type === 'net') extra.push(`<button data-act="rot90">Rotate 90°</button>`);
  if (o.type === 'coach' || (o.type === 'skater' && !o.path?.length)) extra.push(`<button data-act="face45">Turn 45°</button>`);
  if (o.type === 'obstacle') extra.push(`<button data-act="rot90">Rotate 90°</button>`);
  extra.push(`<button data-act="dup">Duplicate</button>`);
  extra.push(`<button data-act="del" class="danger">Delete</button>`);

  body.innerHTML = `<p><b>${TYPE_NAMES[o.type] || o.type}</b> <span class="muted">(${G.round1(o.x ?? o.points?.[0]?.x ?? 0)}, ${G.round1(o.y ?? o.points?.[0]?.y ?? 0)})</span></p>${fields}${custom}<div class="row">${extra.join('')}</div>`;
}

const EV_TYPES = { pass: 'Pass', shoot: 'Shoot', pickup: 'Pickup' };

function skaterOptions(val, noneLabel) {
  const skaters = drill().objects.filter(s => s.type === 'skater');
  return `<option value="" ${!val ? 'selected' : ''}>${noneLabel}</option>` +
    skaters.map(s => `<option value="${s.id}" ${s.id === val ? 'selected' : ''}>#${escHtml(s.label)} (${s.color}${s.role === 'G' ? ', G' : ''})</option>`).join('');
}

function puckProps(o) {
  const ps = sim.puck(o.id);
  const evs = o.events || [];
  const rows = evs.map((ev, i) => {
    const rec = ps.info[i];
    const who = rec?.carrier ? '#' + escHtml(getObj(rec.carrier)?.label ?? '?') : 'loose puck';
    let problem = '';
    if (!rec?.ok) {
      if (ev.type === 'pickup') problem = rec?.carrier ? 'puck is already carried here' : 'pick a skater';
      else if (!rec?.carrier) problem = 'nobody has the puck here';
      else problem = 'pick a receiver';
    }
    const status = problem ? `<span class="warn">⚠ ${problem}</span>` : `<span class="muted">t = ${rec.t.toFixed(1)} s</span>`;
    const wp = `<input class="wp" type="number" min="0" step="1" data-ev="${i}" data-evprop="wp" value="${ev.wp ?? 0}" title="0 = skater's start, 1… = path waypoints">`;
    let body;
    if (ev.type === 'pass') body = `<span>${who} at waypoint</span>${wp}<span>passes to</span><select data-ev="${i}" data-evprop="to">${skaterOptions(ev.to, '— receiver —')}</select>`;
    else if (ev.type === 'shoot') body = `<span>${who} at waypoint</span>${wp}<span>shoots at</span><span class="muted">${ev.target ? `(${G.round1(ev.target.x)}, ${G.round1(ev.target.y)})` : 'nearest net'}</span><button data-act="pick" data-ev="${i}">Pick target</button>`;
    else body = `<select data-ev="${i}" data-evprop="skater">${skaterOptions(ev.skater, '— skater —')}</select><span>picks it up at waypoint</span>${wp}`;
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
  return `<label class="field inline"><span>Starts with</span><select data-prop="carrier">${skaterOptions(o.carrier, 'Loose on the ice')}</select></label>
    <div class="field"><span>Events (in order)</span>${rows || '<p class="muted">No passes or shots yet.</p>'}</div>
    <div class="row"><button data-act="addpass">+ Pass</button><button data-act="addshoot">+ Shoot</button><button data-act="addpickup">+ Pickup</button></div>
    <p class="muted small">Waypoint numbers are shown on the ice while the puck is selected (0 = the skater's start). Drag the puck onto a skater to hand it over.</p>`;
}

/** Who holds the puck after all of its events. */
function finalCarrier(o) { const last = sim.puck(o.id).segs.at(-1); return last.kind === 'carried' ? last.carrier : null; }
function nearestSkater(p, exclude) {
  return drill().objects.filter(s => s.type === 'skater' && s.id !== exclude).sort((a, b) => G.dist(a, p) - G.dist(b, p))[0] || null;
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
    else if (k === 'type') { ev.type = el.value; if (ev.type === 'pickup' && !ev.skater) ev.skater = null; }
    else ev[k] = el.value || null;
    if (el.tagName === 'SELECT') el.blur(); // let the following 'change' re-render the row
    store.save(); renderCanvas(); renderAnimBar();
    return;
  }
  if (!key) return;
  o[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
  if (key === 'facing') o.facing = el.value === '' ? null : +el.value;
  if (key === 'carrier') { o.carrier = el.value || null; el.blur(); }
  if (o.type === 'skater' && key === 'color') lastSkaterColor = o.color;
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
    case 'face45': commit(() => { const cur = Math.round(facingOf(o, drill().objects) * 180 / Math.PI); o.facing = ((cur + 45) % 360 + 360) % 360; }); break;
    case 'givepuck': { const pk = { id: uid(), ...newPuck(o, o.id) }; commit(() => drill().objects.push(pk)); select(pk.id); renderProps(); break; }
    case 'selpuck': { const pk = drill().objects.find(p => p.type === 'puck' && p.carrier === o.id); if (pk) { select(pk.id); renderProps(); } break; }
    case 'addpass': case 'addshoot': case 'addpickup': {
      const carrier = finalCarrier(o);
      const wp = carrier ? (getObj(carrier).path?.length || 0) : 0;
      let ev;
      if (btn.dataset.act === 'addpass') {
        const from = carrier ? sim.skaterPos(carrier, sim.wpTime(carrier, wp)) : o;
        ev = { type: 'pass', wp, to: nearestSkater(from, carrier)?.id || null };
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
    case 'pick': pickTarget = { puckId: o.id, ev: evIndex }; $('#hint').textContent = 'Click on the ice to set the shot target (Esc to cancel)'; break;
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
$('#btn-new-practice').addEventListener('click', () => {
  const name = prompt('Practice name:', 'New practice'); if (name === null) return;
  finishActive(); store.addPractice(newPractice(name)); sel = null; stopAnim(); renderAll();
});
$('#btn-dup-practice').addEventListener('click', () => {
  const copy = JSON.parse(JSON.stringify(store.practice));
  copy.id = uid(); copy.name += ' (copy)';
  copy.drills.forEach(d => { d.id = uid(); d.objects = cloneObjects(d.objects); });
  finishActive(); store.addPractice(copy); sel = null; stopAnim(); renderAll();
});
$('#btn-del-practice').addEventListener('click', () => {
  if (!confirm(`Delete practice "${store.practice.name}"? This cannot be undone.`)) return;
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
  download(`${safeName(p.name)}.hpp.json`, new Blob([JSON.stringify({ format: 'hockey-practice-planner', version: 1, practice: p }, null, 2)], { type: 'application/json' }));
});
$('#btn-import').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const list = data.practice ? [data.practice] : data.practices ? data.practices : Array.isArray(data) ? data : [data];
    let last = null;
    for (const p of list) {
      if (!p || !Array.isArray(p.drills)) throw new Error('Not a practice file');
      p.id = uid(); p.drills.forEach(d => { d.id = uid(); d.view = d.view || { ...VIEWS.full }; d.objects = cloneObjects(migrateDrill(d).objects); });
      store.data.practices.push(p); last = p.id;
    }
    finishActive(); store.switchPractice(last); sel = null; stopAnim(); renderAll();
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
    c.toBlob(b => download(`${safeName(store.practice.name)}_${safeName(d.name)}.png`, b), 'image/png');
  };
  img.onerror = () => alert('PNG export failed');
  img.src = url;
});

$('#btn-print').addEventListener('click', () => {
  const p = store.practice;
  const rink = rinkSVG();
  const total = p.drills.reduce((a, d) => a + (+d.duration || 0), 0);
  $('#print-area').innerHTML = `
    <h1>${escHtml(p.name)}</h1>
    <div class="p-meta">${escHtml(p.team)}${p.team ? ' · ' : ''}${escHtml(p.date)} · ${p.drills.length} drills · ${total} min</div>
    ${p.drills.map((d, i) => `
      <div class="p-drill">
        <h2>${i + 1}. ${escHtml(d.name)} <span class="p-meta">(${+d.duration || 0} min)</span></h2>
        ${standaloneSVG(d, rink, SVG_STYLE)}
        ${d.notes ? `<pre>${escHtml(d.notes)}</pre>` : ''}
      </div>`).join('')}`;
  window.print();
});

// ---------- boot ----------
setTool('select');
renderAll();
window.addEventListener('resize', drawSelection);
