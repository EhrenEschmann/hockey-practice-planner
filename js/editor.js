// The planner’s editor: the rink canvas, tools, drills, sidebar, settings, team manager,
// survey manager, AI helpers, and the practice/drill libraries. Loaded on demand (dynamic
// import in present.js) — a viewer’s phone never fetches this file.
import * as G from './geometry.js';
import { RINK, VIEWS, rinkSVG, SVG_STYLE, nearestBoardPoint, surfaceOf, isDryland } from './rink.js';
import { renderObjects, standaloneSVG, SKATER_COLORS, skaterHex, ZONE_COLORS, ARROW_STYLES } from './render.js';
import { makeSim, facingOf, isPlayer, skaterPoints, DEFAULT_PASS_SPEED, DEFAULT_SHOT_SPEED } from './sim.js';
import { uid, newDrill, newPractice, practiceLabel, usDate, parseUsDate, cloneObjects, migrateDrill, syncFollowers, isGame, docNoun, itemNoun, docTitle } from './store.js';
import { STAGES, STAGE_LABELS, stageOf, accessFor, rosterTeamFor, parseRoute, routePath, byCalendar, TASK_UNITS, weekKey, weekStart, shiftWeek, migrateClubTeam } from './access.js';
import { PS_ELEMENTS, createPSView } from './powerskate.js';
import { icon } from './icons.js';
import { videoEmbed, videoPlayerHTML, probeVideoFile, transcodeVideo, blobToChunks, chunksToBlob, VIDEO_MAX_WIDTH, VIDEO_WARN_MB, estimateVideoMB } from './video.js';
import { SDK_URL, encryptSecret, decryptSecret, looksLikeKey, systemPrompt, generateLayout, layoutToObjects, drillBrief, generateIntroScript } from './ai.js';
import { clipKey, idbGetClip, idbPutClip, idbDelClip, canRecord, canPlay, phoneFriendly, startRecording, blobToBase64, base64ToBlob, CLIP_CLOUD_MAX_BYTES, CLIP_WARN_BYTES, fmtKB } from './clips.js';
import { $, $$, download, escHtml, fmtSecs, isEditing, safeName } from './ui.js';
import { ERASE_SECS, activeNarr, animateFrame, boardInkSVG, canSpeak, clipDocId, clipMem, closePopovers, drill, drillCues, drillPoints, editorApi, editorOn, fetchClip, fetchTaskAudio, fetchTaskVideo, fetchUpload, forgetClip, fxLayer, hushVoice, isPSDrill, keyFor, loserOption, makeNarrator, narrAt, narrationBuffer, objLayer, onEditorRoute, overlay, ownerFor, playClip, playNarration, playerName, popovers, primeVoice, readAloud, reading, returnFrame, returnTime, setVoiceOn, speak, store, svg, taskAudioKey, taskVideoKey, teamOf, toRink, videoKey, voiceOn, wakeAudio, zoneLines } from './core.js';
import { accessAttempts, accessRequests, cloudBackend, cloudBoot, cloudSync, clubState, deniedSignIns, feedbackAll, hasVideo, isOwner, loadEditor, openClubOutput, openFeedbackFor, openRequests, paintInboxButtons, presentMode, presenting, pull, screen, setPresentModePref, teamFor, who } from './present.js';
import { activeDrills, clock, clockFull, parseStart, stamp, todayISO, whenLabel } from './doc.js';
import { shareDrill } from './print.js';

// The planner’s editor: the rink canvas, tools, drills, sidebar, settings, team manager,
// survey manager, AI helpers, and the practice/drill libraries. Split out of main.js.

// ---------- setup ----------
let paintedSurface = 'ice';
/** The surface under the open practice: the rink, or a dryland floor. Redrawn only when it changes. */
function paintSurface() {
  const s = surfaceOf(store.practice);
  if (s === paintedSurface) return;
  paintedSurface = s;
  svg.querySelector('#rink-layer').innerHTML = rinkSVG(s);
  $('#viewbar [data-view="full"]').textContent = s === 'dryland' ? 'Full floor' : 'Full ice';
}

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

const getObj = id => drill().objects.find(o => o.id === id);
const snapPt = p => snap ? { x: Math.round(p.x), y: Math.round(p.y) } : { x: G.round1(p.x), y: G.round1(p.y) };

// ---------- rendering ----------
// ---------- power skating mode: a drill named "power skating" swaps the rink for the 3D technique viewer ----------
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
  paintSurface();
  syncFollowers(d); // shared routes: followers pick up any edit to their leader's path
  renderPSMode(d);
  svg.setAttribute('viewBox', `${d.view.x} ${d.view.y} ${d.view.w} ${d.view.h}`);
  sim = makeSim(d);
  narrator = makeNarrator(drillCues(d, sim), text => { cueCaption.textContent = text; cueCaption.hidden = !text; });
  if (d.intro) fetchClip(ownerFor(), store.practice.id, d); // ready in memory so ▶ can start it inside the tap
  primeNarration(ownerFor(), store.practice.id, d);
  fxLayer.innerHTML = '';
  const selObj = getObj(sel);
  objLayer.innerHTML = renderObjects(d, sel, { tool, dryland: isDryland(store.practice), showPaths: drillPaths(), sim, numberWaypoints: selObj?.type === 'puck' || !!selObj?.trigger || (isPlayer(selObj) && !!selObj.path?.length) });
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
  renderTeamPick();
  renderPracticeSelect();
  renderPracticeProps();
  renderAIPop();
  renderPlan();
  renderProps();
  renderAnimBar();
  paintInboxButtons();
  $('#btn-undo').disabled = !store.undoStack.length;
  $('#btn-redo').disabled = !store.redoStack.length;
}

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

// ---------- the current team: the editor works on one team at a time ----------
// The picker shows that team's practices and games, new ones belong to it, and 📅 Tasks is its calendar. Remembered per browser.
const TEAM_KEY = 'hpp.ui.team';
let curTeamId = null;
try { curTeamId = localStorage.getItem(TEAM_KEY) || null; } catch { /* fine */ }
/** The team being worked on: the remembered one when it still exists, else the open practice's, else the first on the roster. */
function currentTeam() {
  const teams = store.roster.teams || [];
  return teams.find(t => t.id === curTeamId) || teamOf(store.practice) || teams[0] || null;
}
const inTeam = (p, t) => !!t && (p.teamId ? p.teamId === t.id : String(p.team || '').trim().toLowerCase() === String(t.name || '').trim().toLowerCase());
/** Switch teams: remember it and open that team's most recent practice (the picker only shows that team). */
function setCurrentTeam(id) {
  curTeamId = id;
  try { localStorage.setItem(TEAM_KEY, id || ''); } catch { /* fine */ }
  const t = currentTeam();
  if (t && !inTeam(store.practice, t)) {
    const mine = store.live.filter(p => inTeam(p, t)).sort((a, b) => byCalendar(b, a));
    if (mine.length) { finishActive(); store.switchPractice(mine[0].id); sel = null; stopAnim(); }
  }
  renderAll();
}
function renderTeamPick() {
  const t = currentTeam(), teams = store.roster.teams || [];
  $('#team-current').textContent = t ? (t.name || 'unnamed team') : 'No team yet';
  if (!$('#team-pop').hidden) {
    const count = x => store.live.filter(p => inTeam(p, x)).length;
    $('#team-items').innerHTML = teams.map(x => `<button class="plist-item${t && x.id === t.id ? ' current' : ''}" data-team="${x.id}" title="${escHtml(x.name || 'unnamed team')}">
      <b>${escHtml(x.name || 'unnamed team')}</b><span class="when">${count(x)} practice${count(x) === 1 ? '' : 's'}${x.club ? ' · club' : ''}</span></button>`).join('') || '<p class="muted small">No team yet — add one under Manage teams.</p>';
  }
  $('#btn-tasks').hidden = !t;
  $('#btn-tasks').title = t ? `${t.name || 'This team'}: weekly tasks — a calendar of weeks, each week's task list and how-tos, and every player's output${t.club ? '' : ' (marks the team as an official club team)'}` : '';
}
$('#team-items').addEventListener('click', e => {
  const b = e.target.closest('[data-team]'); if (!b) return;
  $('#team-pop').hidden = true; setCurrentTeam(b.dataset.team);
});
$('#team-manage').addEventListener('click', () => { $('#team-pop').hidden = true; openTeamMgr(); });

/** Open the practice/drill named in the URL; fall back to the last drill viewed in that practice. */
function applyRoute() {
  const { pid, did } = parseRoute(location);
  if (pid && pid !== store.data.currentId && store.live.some(x => x.id === pid)) store.switchPractice(pid);
  const p = store.practice;
  const want = did || store.data.lastDrill?.[p.id];
  const i = p.drills.findIndex(x => x.id === want);
  if (i >= 0) store.drillIndex = i;
}

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
  pan: 'Drag to pan · scroll / two fingers to pan · pinch or Ctrl+scroll to zoom',
  skater: 'Click to place a skater, then click (or drag) to add path waypoints · Enter/Esc to finish · click an existing skater or coach to extend their path',
  coach: 'Click to place a coach · or drag the Coach button straight onto the ice',
  goalie: 'Click near a net to put a goalie in its crease (facing out) · click open ice for a goalie anywhere',
  arrow: 'Click points · double-click or Enter to finish · Esc cancels · pick Line in the Selection panel for a plain line, and its colour and width there',
  contact: 'Click where two skaters should collide — the two nearest paths are linked and their timing syncs to meet there',
  cone: 'Click to place a cone', tire: 'Click to place a tire',
  minicone: 'Click to place a small cone · drag to lay a row (one every ~3 ft) · a puck carrier stickhandles through them', puck: 'Click a skater or coach to give them a puck · click a pile to take a puck from it · click open ice for a loose puck',
  pile: 'Click to place a pile of pucks · skaters take pucks from it ("Take puck from pile" in their panel)', net: 'Click to place a net (rotate in Selection panel)',
  obstacle: 'Drag a box to add an obstacle / pad',
  raisedpad: 'Click to place a raised pad on tires · skaters whose path runs through it slide under',
  jumppad: 'Click to place a low pad · skaters whose path runs over it jump it',
  barricade: 'Click points to lay a barricade · double-click or Enter to finish',
  zone: 'Drag a box to mark a section / station',
  focusarea: 'Drag a box around the space to work in — or click corner points for any shape (Enter/double-click closes it). The rest of the ice grays out',
  text: 'Click to place a text label',
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
      if (o.points.length < (o.type === 'focus' ? 3 : 2)) drill().objects = drill().objects.filter(x => x.id !== o.id);
      else { doneId = o.id; syncFocusBox(o); }
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
const CREASE_DEPTH = 2.2;  // ft in front of the goal line where a goalie stands — tucked into the mouth of the net
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
// Tools that stay selected after a placement ("keep placing"): a row of tires, or a line of skaters, takes one click each.
// With the skater option on, a click on open ice always places a new skater (finishing the one before as it stands); a
// skater's path is drawn by clicking the skater itself, which extends its path as it always has.
const keepTool = { tire: false, skater: false, cone: false };
let skaterExtending = false; // the active skater was clicked to extend its path (so, with keep placing on, clicks add waypoints)
// The switch is a pin badge on the tool's own button (plus a hidden checkbox the Settings panel mirrors).
for (const [t, box] of [['tire', '#tire-keep'], ['skater', '#skater-keep'], ['cone', '#cone-keep']]) {
  try { keepTool[t] = localStorage.getItem(`hpp.keep.${t}`) === '1'; } catch { /* fine */ }
  const btn = $(`#toolbar .tool[data-tool="${t}"]`), badge = btn.querySelector('.qp');
  const paint = () => { btn.classList.toggle('qp-on', keepTool[t]); badge.setAttribute('aria-checked', String(keepTool[t])); };
  $(box).checked = keepTool[t]; paint();
  $(box).addEventListener('change', e => {
    keepTool[t] = e.target.checked; paint();
    try { localStorage.setItem(`hpp.keep.${t}`, keepTool[t] ? '1' : '0'); } catch { /* fine */ }
    if (tool === t) $('#hint').textContent = HINTS[t] + (keepTool[t] ? ' · keeps placing until you press V' : '');
  });
  // The badge toggles without selecting the tool or starting a drag from the palette.
  badge.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); });
  badge.addEventListener('click', e => { e.stopPropagation(); $(box).checked = !$(box).checked; $(box).dispatchEvent(new Event('change')); });
}
function placed(id) {
  select(id);
  if (tool !== 'select' && !keepTool[tool]) setTool('select');
}

// ---------- chalk talk: a whiteboard over the drill — draw while you talk, replay in sync ----------
const boardLayer = svg.querySelector('#board-layer');
let boardMode = null; // { strokes, cur, rec, recT0, recTimer, revoice, staged, audioMeta, playing, speed, color, dirty }
const bNow = () => boardMode?.recT0 ? (performance.now() - boardMode.recT0) / 1000 : 0;
const inkSecs = () => { let m = 0; for (const st of boardMode.strokes) { for (const q of st.pts) m = Math.max(m, q.t || 0); if (st.gone != null) m = Math.max(m, st.gone + ERASE_SECS); } return m; };

function enterBoard() {
  if (boardMode) return;
  finishActive();
  if (anim.playing) togglePlay();
  const d = drill();
  boardMode = {
    strokes: JSON.parse(JSON.stringify(d.board?.strokes || [])),
    cur: null, rec: null, recT0: 0, recTimer: 0, revoice: false,
    staged: null, audioMeta: d.boardAudio || null, playing: null, arming: false,
    speed: +(d.board?.speed) || 1, color: $('#board-color').value || '#e11d48', dirty: false,
  };
  document.body.classList.add('board-mode');
  $('#board-bar').hidden = false;
  $('#board-speed').value = String(boardMode.speed);
  drawBoard();
  renderBoardBar();
}

function exitBoard() {
  if (!boardMode) return;
  stopBoardPlayback();
  clearInterval(boardMode.recTimer);
  if (boardMode.rec) boardMode.rec.stop().catch(() => {});
  boardMode = null;
  boardLayer.innerHTML = '';
  document.body.classList.remove('board-mode');
  $('#board-bar').hidden = true;
  renderAnimBar();
}

function drawBoard(tInk = Infinity) {
  if (!boardMode) return;
  boardLayer.innerHTML = boardInkSVG(boardMode.strokes, tInk);
}

function boardDown(e) {
  if (boardMode.playing) stopBoardPlayback();
  svg.setPointerCapture(e.pointerId);
  const q = toRink(e);
  boardMode.cur = { color: boardMode.color, w: 0.7, pts: [{ x: G.round1(q.x), y: G.round1(q.y), t: Math.round(bNow() * 100) / 100 }] };
  boardMode.strokes.push(boardMode.cur);
  boardMode.dirty = true;
  drawBoard(); renderBoardBar();
}
function boardMove(e) {
  const cur = boardMode.cur; if (!cur) return;
  const q = toRink(e);
  const last = cur.pts[cur.pts.length - 1];
  if (Math.hypot(q.x - last.x, q.y - last.y) < 0.25) return;
  cur.pts.push({ x: G.round1(q.x), y: G.round1(q.y), t: Math.round(bNow() * 100) / 100 });
  drawBoard();
}
function boardUp() { boardMode.cur = null; }

async function boardRecToggle() {
  const b = boardMode;
  if (b.arming) return; // the microphone is still warming up
  if (b.rec) { // stop a take (fresh or re-voice)
    const r = b.rec; b.rec = null;
    clearInterval(b.recTimer);
    stopBoardPlayback();
    const { blob, mime, secs } = await r.stop();
    if (blob.size && secs > 0.5) { b.staged = { blob, mime, secs }; b.dirty = true; }
    b.revoice = false;
    renderBoardBar(); return;
  }
  // The take starts NOW: the board clears and the clock runs, so strokes drawn while the
  // microphone is still warming up are kept (re-based to the audio clock once it starts).
  b.revoice = false; b.arming = true;
  b.strokes = []; b.staged = null; b.dirty = true;
  b.recT0 = performance.now();
  b.recTimer = setInterval(renderBoardBar, 500);
  drawBoard(); renderBoardBar();
  let rec = null;
  try { rec = await startRecording(); } catch (e) {
    clearInterval(b.recTimer); b.recT0 = 0; b.arming = false;
    alert(`Microphone not available: ${e?.message || e}`);
    renderBoardBar(); return;
  }
  b.arming = false;
  if (!boardMode || boardMode !== b) { rec.stop().catch(() => {}); return; } // the mode was left while the mic came up
  const delay = (performance.now() - b.recT0) / 1000;
  if (delay > 0.05) { // ink drawn during warm-up slides back to the start of the audio
    for (const st of b.strokes) for (const q of st.pts) q.t = Math.max(0, Math.round((q.t - delay) * 100) / 100);
    b.recT0 = performance.now();
  }
  b.rec = rec;
  renderBoardBar();
}

async function boardRevoice() { // keep the ink; the drawing replays silently while a new voice records
  const b = boardMode;
  if (b.rec) return;
  try { b.rec = await startRecording(); } catch (e) { alert(`Microphone not available: ${e?.message || e}`); return; }
  b.revoice = true;
  b.recT0 = performance.now();
  b.recTimer = setInterval(renderBoardBar, 500);
  startBoardPlayback({ silent: true });
  renderBoardBar();
}

async function startBoardPlayback({ silent = false } = {}) {
  stopBoardPlayback();
  const b = boardMode;
  const speed = b.speed || 1;
  const total = inkSecs() / speed;
  let audio = null, audioUrl = null;
  if (!silent) {
    if (b.staged) { audioUrl = URL.createObjectURL(b.staged.blob); audio = new Audio(audioUrl); }
    else if (b.audioMeta) {
      if (!clipMem.has(keyFor(ownerFor(), store.practice.id, drill(), 'boardAudio'))) { b.fetching = true; renderBoardBar(); }
      const entry = await fetchClip(ownerFor(), store.practice.id, drill(), 'boardAudio');
      b.fetching = false;
      if (boardMode !== b) return; // board mode was left while the voice came down
      if (entry) audio = new Audio(entry.url);
    }
    audio?.play().catch(() => {});
  }
  const t0 = performance.now();
  const st = { audio, audioUrl, raf: 0 };
  b.playing = st;
  const frame = () => {
    if (boardMode?.playing !== st) return;
    const el = (performance.now() - t0) / 1000;
    drawBoard(el * speed);
    const audioDone = !audio || audio.ended || audio.paused;
    if (el >= total + 0.3 && audioDone && !(silent && boardMode.rec)) { stopBoardPlayback(); renderBoardBar(); return; }
    st.raf = requestAnimationFrame(frame);
  };
  st.raf = requestAnimationFrame(frame);
  renderBoardBar();
}
function stopBoardPlayback() {
  const st = boardMode?.playing; if (!st) return;
  cancelAnimationFrame(st.raf);
  st.audio?.pause();
  if (st.audioUrl) URL.revokeObjectURL(st.audioUrl);
  boardMode.playing = null;
  drawBoard();
}

async function boardSave() {
  const b = boardMode, d = drill(), pid = store.practice.id;
  let audio = b.audioMeta || null;
  if (b.staged) {
    const { blob, mime, secs } = b.staged;
    const at = Date.now();
    const key = keyFor(ownerFor(), pid, d, 'boardAudio');
    forgetClip(key); idbDelClip(key).catch(() => {});
    try { await idbPutClip(clipKey(ownerFor(), pid, clipDocId(d.id, 'boardAudio'), at), { mime, blob, secs }); } catch { /* the cloud copy still serves this device */ }
    const up = await uploadClip(pid, clipDocId(d.id, 'boardAudio'), { mime, blob, secs });
    audio = { secs, mime, size: blob.size, at, cloud: up.ok, ...(up.error ? { cloudError: up.error } : {}) };
  }
  const strokes = b.strokes.filter(st => st.pts.length > 1);
  commit(() => {
    if (!strokes.length && !audio) { delete d.board; delete d.boardAudio; }
    else {
      d.board = { strokes, speed: b.speed, secs: Math.round(Math.max(inkSecs(), audio?.secs || 0) * 10) / 10 };
      if (audio) d.boardAudio = audio; else delete d.boardAudio;
    }
  });
  b.audioMeta = audio; b.staged = null; b.dirty = false;
  renderBoardBar();
}

function renderBoardBar() {
  const b = boardMode; if (!b) return;
  $('#board-rec').textContent = b.arming ? '● mic…' : b.rec && !b.revoice ? `■ Stop (${bNow().toFixed(0)} s)` : '● Record talk';
  $('#board-rec').classList.toggle('danger', (!!b.rec || b.arming) && !b.revoice);
  $('#board-rec').disabled = !!b.rec && b.revoice;
  $('#board-revoice').hidden = !b.strokes.length && !b.rec;
  $('#board-revoice').textContent = b.rec && b.revoice ? `■ Stop (${bNow().toFixed(0)} s)` : '🎙 Re-record voice';
  $('#board-revoice').classList.toggle('danger', !!b.rec && b.revoice);
  $('#board-play').hidden = !!b.rec || (!b.strokes.length && !b.staged && !b.audioMeta);
  $('#board-play').textContent = b.fetching ? '… downloading' : b.playing ? '■ Stop' : '▶ Replay';
  $('#board-play').disabled = !!b.fetching;
  $('#board-save').disabled = !b.dirty;
  $('#board-status').textContent = b.rec ? (b.revoice ? '● New voice — the drawing is replaying, talk over it' : '● Recording — draw as you talk')
    : b.staged ? `New voice staged (${b.staged.secs.toFixed(0)} s) — Save to keep it`
    : b.audioMeta ? `Voice: ${Math.round(b.audioMeta.secs)} s${b.audioMeta.cloud !== true ? ' · ⚠ not in the cloud' : ''}`
    : 'Draw on the ice — ● records your voice while you draw';
}

$('#btn-board').addEventListener('click', enterBoard);
$('#board-exit').addEventListener('click', exitBoard);
$('#board-rec').addEventListener('click', boardRecToggle);
$('#board-revoice').addEventListener('click', () => (boardMode?.rec && boardMode.revoice ? boardRecToggle() : boardRevoice()));
$('#board-play').addEventListener('click', () => (boardMode?.playing ? (stopBoardPlayback(), renderBoardBar()) : startBoardPlayback()));
$('#board-color').addEventListener('input', e => { if (boardMode) boardMode.color = e.target.value; });
$('#board-speed').addEventListener('change', e => { if (!boardMode) return; boardMode.speed = +e.target.value || 1; boardMode.dirty = true; renderBoardBar(); });
$('#board-undo').addEventListener('click', () => {
  const b = boardMode; if (!b || (b.rec && b.revoice)) return;
  if (b.rec) { // mid-take: the stroke stays in the story — it draws, then erases itself at this moment
    const st = [...b.strokes].reverse().find(x => x.gone == null);
    if (st) { st.gone = Math.round(bNow() * 100) / 100; b.dirty = true; }
  } else {
    const i = b.strokes.findLastIndex(x => x.gone == null);
    b.strokes.splice(i >= 0 ? i : b.strokes.length - 1, 1);
    b.dirty = true;
  }
  b.cur = null; drawBoard(); renderBoardBar();
});
$('#board-save').addEventListener('click', () => { boardSave(); });
$('#board-clear').addEventListener('click', () => {
  const b = boardMode; if (!b || (b.rec && b.revoice)) return;
  if (b.rec) { // mid-take: a sweeping erase in the replay
    const t = Math.round(bNow() * 100) / 100;
    for (const st of b.strokes) if (st.gone == null) st.gone = t;
  } else b.strokes = [];
  b.cur = null; b.dirty = true; drawBoard(); renderBoardBar();
});

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
  if (boardMode) { if (e.button === 0) boardDown(e); return; }
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
      const releaseEl = e.target.closest('[data-release]');
      const releaseWho = releaseEl && id ? sim.puck(id).info[+releaseEl.dataset.release]?.carrier : null;
      const rotEl = e.target.closest('[data-rot]');
      if (rotEl && id && getObj(id)?.type === 'focus') {
        const o = getObj(id);
        const pts = o.points ? o.points.map(q => ({ ...q })) : [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x, y: o.y + o.h }];
        const center = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
        const cargo0 = focusCargo(o);
        const contents = [
          ...cargo0.inside.map(x => ({ id: x.id, orig: JSON.parse(JSON.stringify(x)) })),
          ...cargo0.riders.map(x => ({ id: x.id, orig: JSON.parse(JSON.stringify(x)), eventsOnly: true })),
        ];
        drag = { type: 'rotate', id, center, pts, contents, a0: Math.atan2(raw.y - center.y, raw.x - center.x), pushed: false };
        select(id);
        break;
      }
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
      } else if (releaseWho && getObj(releaseWho)?.path?.length) {
        // the release end of a receiver-timed pass: dragging it pins the release (and the R re-derives)
        drag = { type: 'release', id, ev: +releaseEl.dataset.release, who: releaseWho, pushed: false };
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
        if (o.type === 'focus' && !e.altKey) {
          const cg = focusCargo(o);
          drag.cargo = [
            ...cg.inside.map(x => ({ id: x.id, orig: JSON.parse(JSON.stringify(x)) })),
            ...cg.riders.map(x => ({ id: x.id, orig: JSON.parse(JSON.stringify(x)), eventsOnly: true })),
          ];
        }
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
        activeSkater = o.id; skaterExtending = true; select(o.id);
      } else if (activeSkater && getObj(activeSkater) && (!keepTool.skater || skaterExtending || o?.id === activeSkater)) {
        // Draw the path. With "keep placing" on, only after a skater was clicked to extend its path (or when clicking
        // the active skater itself) — otherwise a click on open ice is the next skater.
        drag = { type: 'freehand', id: activeSkater, pts: [raw], start: p };
      } else {
        if (activeSkater) finishActive(); // keep placing: the skater before stands where it is, this click is a new one
        const s = addObject(makePlaceable('skater', p));
        activeSkater = s.id; skaterExtending = false; select(s.id);
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
      if (tool === 'focusarea' && activePoly && getObj(activePoly)?.type === 'focus') {
        const o = getObj(activePoly);
        o.points[o.points.length - 1] = p;
        o.points.push({ ...p });
        renderCanvas();
        break;
      }
      const o = tool === 'zone'
        ? { id: uid(), type: 'zone', x: p.x, y: p.y, w: 0, h: 0, label: `Station ${drill().objects.filter(x => x.type === 'zone').length + 1}`, color: ZONE_COLORS[lastZoneColor++ % ZONE_COLORS.length] }
        : tool === 'focusarea' ? { id: uid(), type: 'focus', x: p.x, y: p.y, w: 0, h: 0, dim: '0.55', fade: '0.5' }
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
  }
}

function onPointerMove(e) {
  if (boardMode) { boardMove(e); return; }
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
      syncFocusBox(o);
      for (const it of drag.cargo || []) { // everything inside a focus moves with it (Alt-drag moves just the frame)
        const x = getObj(it.id); if (!x) continue;
        for (const k of Object.keys(x)) delete x[k];
        Object.assign(x, JSON.parse(JSON.stringify(it.orig)));
        if (it.eventsOnly) { for (const ev of x.events || []) { if (ev.target) ev.target = tr(ev.target); if (ev.bank) ev.bank = tr(ev.bank); } }
        else { translateObj(x, dx, dy); for (const ev of x.events || []) { if (ev.target) ev.target = tr(ev.target); if (ev.bank) ev.bank = tr(ev.bank); } }
      }
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
    case 'rotate': {
      const o = getObj(drag.id); if (!o) return;
      const raw2 = toRink(e);
      let deg = (Math.atan2(raw2.y - drag.center.y, raw2.x - drag.center.x) - drag.a0) * 180 / Math.PI;
      deg = Math.round(deg / 5) * 5;
      if (!deg && !o.points) break; // a box only becomes a polygon once it actually turns
      if (!drag.pushed) { store.pushUndo(); drag.pushed = true; }
      const rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      o.points = drag.pts.map(q => ({
        x: G.round1(drag.center.x + (q.x - drag.center.x) * cos - (q.y - drag.center.y) * sin),
        y: G.round1(drag.center.y + (q.x - drag.center.x) * sin + (q.y - drag.center.y) * cos),
      }));
      syncFocusBox(o);
      const rp = q => ({ ...q, x: G.round1(drag.center.x + (q.x - drag.center.x) * cos - (q.y - drag.center.y) * sin), y: G.round1(drag.center.y + (q.x - drag.center.x) * sin + (q.y - drag.center.y) * cos) });
      for (const it of drag.contents) { // contents turn with the shape, re-derived from their grab-time state
        const x = getObj(it.id); if (!x) continue;
        for (const k of Object.keys(x)) delete x[k];
        Object.assign(x, JSON.parse(JSON.stringify(it.orig)));
        if (it.eventsOnly) { for (const ev of x.events || []) { if (ev.target) ev.target = rp(ev.target); if (ev.bank) ev.bank = rp(ev.bank); } }
        else rotateObj(x, drag.center, deg);
      }
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
    case 'release': { // the pass now leaves where the passer's path passes the pointer (carrier-timed; the R re-derives)
      const ev = getObj(drag.id)?.events?.[drag.ev]; if (!ev) return;
      if (!drag.pushed) { store.pushUndo(); drag.pushed = true; }
      delete ev.by;
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
  if (boardMode) { boardUp(e); return; }
  document.body.classList.remove('panning');
  if (pendingDbl) { // released without moving: this really was a double-click
    const pd = pendingDbl; pendingDbl = null;
    if (doubleClickSelect(pd.rink, pd.idEl, pd.handleEl)) { syncFocusBox(sel && getObj(sel)); drag = null; return; }
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
      syncFocusBox(o);
      store.save(); renderAll(); break;
    }
    case 'evmark': case 'arrive': case 'release': {
      // Dropped before the puck can be there? The sim already fires the event where the player has it;
      // store that spot so the panel's feet-on-path matches the marker instead of showing an impossible value.
      const pk = getObj(dg.id); const ev = pk?.events?.[dg.ev];
      if (ev && ev.dist != null) { sim = makeSim(drill()); if (sim.puck(pk.id).info[dg.ev]?.late) { const eff = effectiveDist(pk, dg.ev); if (eff != null) ev.dist = eff; } }
      store.save(); renderAll(); break;
    }
    case 'handle': case 'bank': case 'resize': case 'rotate': syncFocusBox(getObj(dg.id)); store.save(); renderAll(); break;
    case 'rect': {
      const o = getObj(dg.id);
      if (o.w < 1.5 || o.h < 1.5) {
        if (o.type === 'obstacle') { o.w = 4; o.h = 2; }
        else if (o.type === 'focus' && tool === 'focusarea') {
          // a plain click: trace the focus as a polygon — click corners, Enter/double-click closes it
          o.w = 0; o.h = 0;
          o.points = [{ x: o.x, y: o.y }, { x: o.x, y: o.y }];
          activePoly = o.id; sel = o.id;
          store.save(); renderAll();
          break;
        }
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

/**
 * Wheel / trackpad on the canvas. Two-finger scroll (a plain wheel) pans; a pinch — which browsers deliver as a
 * wheel with ctrlKey — or Ctrl/⌘ + wheel zooms around the pointer, scaled to how far the wheel moved, so a trackpad's
 * stream of tiny events zooms gently and a mouse notch zooms about a quarter. Shift + wheel pans sideways.
 */
function onWheel(e) {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1; // lines / pages → px
  if (e.ctrlKey || e.metaKey) {
    zoomAt(toRink(e), Math.exp(G.clamp(e.deltaY * unit, -60, 60) * 0.004));
    return;
  }
  const v = drill().view, ctm = svg.getScreenCTM();
  const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY * unit;
  v.x += dx / ctm.a; v.y += dy / ctm.d;
  renderCanvas(); scheduleViewSave();
}
let viewSaveTimer = 0;
/** A wheel gesture fires dozens of times a second: paint every step, save the view once it settles. */
function scheduleViewSave() { clearTimeout(viewSaveTimer); viewSaveTimer = setTimeout(() => store.save(), 300); }

function zoomAt(p, f) {
  const v = drill().view;
  const nw = G.clamp(v.w * f, 20, 400);
  const ff = nw / v.w;
  v.x = p.x - (p.x - v.x) * ff;
  v.y = p.y - (p.y - v.y) * ff;
  v.w = nw; v.h = v.h * ff;
  renderCanvas(); scheduleViewSave();
}

function setView(v) { drill().view = { ...v }; store.save(); renderCanvas(); }

// ---------- keyboard ----------

document.addEventListener('keydown', e => {
  if (presenting) return; // presentation is view-only and has its own keys (present.js): no editor shortcuts, no way "back"
  if (!editorOn) return;
  if (!$('#library').hidden) { if (e.key === 'Escape') closeLibrary(); return; } // the library modal captures the keyboard
  if (!$('#tasks').hidden) { if (e.key === 'Escape' && !isEditing()) closeTasks(); return; } // the Tasks panel
  if (!$('#teammgr').hidden) { if (e.key === 'Escape' && !isEditing()) closeTeamMgr(); return; } // same for the team manager
  if (!$('#askmgr').hidden) { if (e.key === 'Escape' && !isEditing()) closeAskMgr(); return; } // and the questions manager
  if (boardMode) { // the whiteboard owns the keys: Esc leaves, C (or Delete) clears the ink, Backspace undoes a stroke
    if (e.key === 'Escape') exitBoard();
    else if (!isEditing() && (e.key === 'c' || e.key === 'C' || e.key === 'Delete')) $('#board-clear').click();
    else if (!isEditing() && e.key === 'Backspace') { e.preventDefault(); $('#board-undo').click(); }
    return;
  }
  if (!$('#settings').hidden) { if (e.key === 'Escape') closeSettings(); return; }
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
    commit(() => { const o = getObj(sel); if (o?.type === 'focus') moveFocusBy(o, dx, dy); else translateObj(o, dx, dy); });
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const keys = { v: 'select', h: 'pan', s: 'skater', k: 'coach', g: 'goalie', i: 'contact', r: 'raisedpad', j: 'jumppad', l: 'pile', a: 'arrow', c: 'cone', m: 'minicone', t: 'tire', p: 'puck', n: 'net', o: 'obstacle', b: 'barricade', z: 'zone', f: 'focusarea', x: 'text' };
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
  if (o.type === 'focus' && o.points) syncFocusBox(o);
  else if (o.type === 'zone' || o.type === 'focus') { // boxes are anchored top-left: reflect the far edge
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
  if (o.points) { o.points = o.points.map(tr); syncFocusBox(o); }
  else { Object.assign(o, tr(o)); if (o.path) o.path = o.path.map(tr); }
}

/** Is this object inside the focus shape? Judged by its anchor: centroid for point-chains, centre for boxes. */
function insideFocus(f, o) {
  if (o.type === 'puck' && o.carrier) return false; // rides its carrier
  let a = null;
  if (o.points?.length) a = { x: o.points.reduce((s, q) => s + q.x, 0) / o.points.length, y: o.points.reduce((s, q) => s + q.y, 0) / o.points.length };
  else if ((o.type === 'zone' || o.type === 'focus') && o.x != null) a = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
  else if (o.x != null) a = { x: o.x, y: o.y };
  if (!a) return false;
  return f.points?.length >= 3 ? G.pointInPolygon(f.points, a)
    : a.x >= f.x && a.x <= f.x + f.w && a.y >= f.y && a.y <= f.y + f.h;
}

/** Rotate one object by deg° around centre c: position, path, points, angles, shot targets and banks. */
function rotateObj(o, c, deg) {
  const rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const rp = q => ({ ...q, x: G.round1(c.x + (q.x - c.x) * cos - (q.y - c.y) * sin), y: G.round1(c.y + (q.x - c.x) * sin + (q.y - c.y) * cos) });
  if ((o.type === 'zone' || o.type === 'focus') && !o.points) {
    // axis-aligned boxes can't tilt: rotate the centre, and swap the sides on quarter turns
    const ctr = rp({ x: o.x + o.w / 2, y: o.y + o.h / 2 });
    const quarter = ((deg % 180) + 180) % 180 === 90;
    const w = quarter ? o.h : o.w, h = quarter ? o.w : o.h;
    o.x = G.round1(ctr.x - w / 2); o.y = G.round1(ctr.y - h / 2); o.w = G.round1(w); o.h = G.round1(h);
    return;
  }
  if (o.points) { o.points = o.points.map(rp); syncFocusBox(o); }
  if (o.x != null) { const q = rp({ x: o.x, y: o.y }); o.x = q.x; o.y = q.y; }
  if (o.path) o.path = o.path.map(rp);
  if (o.rot != null && o.rot !== '') o.rot = ((+o.rot + deg) % 360 + 360) % 360;
  if (o.facing != null && o.facing !== '') o.facing = ((+o.facing + deg) % 360 + 360) % 360;
  for (const ev of o.events || []) { if (ev.target) ev.target = rp(ev.target); if (ev.bank) ev.bank = rp(ev.bank); }
}

/** What travels with a focus: the objects inside it, plus pucks carried by someone inside (events only). */
function focusCargo(f) {
  const inside = drill().objects.filter(x => x !== f && insideFocus(f, x));
  const ids = new Set(inside.map(x => x.id));
  const riders = drill().objects.filter(x => x.type === 'puck' && x.carrier && ids.has(x.carrier));
  return { inside, riders };
}

/** Move a focus area and everything inside it by (dx, dy). */
function moveFocusBy(f, dx, dy) {
  const { inside, riders } = focusCargo(f);
  const tp = q => ({ ...q, x: G.round1(q.x + dx), y: G.round1(q.y + dy) });
  const moveEvents = x => { for (const ev of x.events || []) { if (ev.target) ev.target = tp(ev.target); if (ev.bank) ev.bank = tp(ev.bank); } };
  translateObj(f, dx, dy);
  for (const x of inside) { translateObj(x, dx, dy); moveEvents(x); }
  for (const r of riders) moveEvents(r);
}

/** Rotate a focus area by deg° around its centre — everything inside it turns with it. */
function rotateFocus(o, deg) {
  const c = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
  const { inside, riders } = focusCargo(o);
  if (o.points || deg % 90 !== 0) {
    const pts = o.points || [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x, y: o.y + o.h }];
    const rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    o.points = pts.map(q => ({
      x: G.round1(c.x + (q.x - c.x) * cos - (q.y - c.y) * sin),
      y: G.round1(c.y + (q.x - c.x) * sin + (q.y - c.y) * cos),
    }));
    syncFocusBox(o);
  } else if (deg % 180 !== 0) {
    const w = o.h, h = o.w;
    o.x = G.round1(c.x - w / 2); o.y = G.round1(c.y - h / 2); o.w = G.round1(w); o.h = G.round1(h);
  }
  for (const x of inside) rotateObj(x, c, deg);
  const rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const rp = q => ({ ...q, x: G.round1(c.x + (q.x - c.x) * cos - (q.y - c.y) * sin), y: G.round1(c.y + (q.x - c.x) * sin + (q.y - c.y) * cos) });
  for (const r of riders) for (const ev of r.events || []) { if (ev.target) ev.target = rp(ev.target); if (ev.bank) ev.bank = rp(ev.bank); }
}

/** A polygon focus keeps x/y/w/h as its bounding box, so zoom, view-fit, mirroring and Present treat it like the box form. */
function syncFocusBox(o) {
  if (o?.type !== 'focus' || !o.points?.length) return;
  const xs = o.points.map(q => q.x), ys = o.points.map(q => q.y);
  o.x = G.round1(Math.min(...xs)); o.y = G.round1(Math.min(...ys));
  o.w = G.round1(Math.max(...xs) - o.x); o.h = G.round1(Math.max(...ys) - o.y);
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

// ---------- voice cues: notes typed on a player's waypoints, spoken aloud as they get there during playback ----------
const hasCues = dr => dr.objects.some(o => isPlayer(o) && (o.startCue?.trim() || (o.path || []).some(pt => pt.cue?.trim())));
const hasVoice = dr => (canSpeak && hasCues(dr)) || !!dr.intro || !!dr.narration; // anything the 🔊 toggle would silence

let introPlaying = null; // the Drills panel's ▶ Listen preview
let clipFetching = null; // { drillId, kind } while a ▶ tap is still pulling that clip from this device's store or the cloud
const fetchingClip = (kind, d) => clipFetching?.kind === kind && clipFetching.drillId === d.id;

document.addEventListener('visibilitychange', () => { if (presenting && document.visibilityState === 'visible' && activeNarr.size) wakeAudio(); });
/** Prefetch and decode a drill's narration so ▶ can start it inside the tap. */
const primeNarration = (owner, pid, d) => { if (d.narration) fetchClip(owner, pid, d, 'narration').then(e => narrationBuffer(e)).catch(() => {}); };

function setVoice(on) {
  setVoiceOn(on);
  try { localStorage.setItem('hpp.voice', on ? '1' : '0'); } catch { /* fine */ }
  if (!on) hushVoice();
  for (const b of $$('#anim-voice')) { b.classList.toggle('active', on); b.textContent = on ? '🔊 voice' : '🔇 muted'; b.title = on ? 'Voice on — click to mute intros and cues' : 'Voice muted on this device — click to hear intros and cues'; }
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
  if (anim.t >= T) { anim.t = T; anim.playing = false; } // park on the final positions (a longer narration keeps talking) — ⏹ sends everyone home
  applyAnimation(anim.t);
  narrator.step(prev, anim.t, { silent: !!anim.narr || !!anim.recNarr }); // captions only while the recorded voice talks or the mic is open
  renderAnimBar();
  if (anim.playing) anim.raf = requestAnimationFrame(tick);
}

function togglePlay() {
  if (isPSDrill(drill())) { psView().toggle(); renderAnimBar(); return; } // power skating mode: ▶ plays the technique elements
  if (returning) cancelReturn();
  if (anim.intro) { cancelIntro(); renderAnimBar(); return; } // ⏸ during the intro skips it and stays parked at the start
  if (anim.recNarr) { introAction('nstop'); return; } // ⏸ while recording the narration ends the take
  if (!anim.playing && anim.narr) { stopNarration(); renderAnimBar(); return; } // the picture is parked, the voice still going: ⏸ ends it
  if (anim.playing) { anim.playing = false; cancelAnimationFrame(anim.raf); fxLayer.innerHTML = ''; hushVoice(); stopNarration(); }
  else {
    if (totalDuration() <= 0) return;
    primeVoice();
    // Playing is for watching, not editing: drop the selection and finish anything being drawn.
    finishActive();
    if (pickTarget) { pickTarget = null; $('#hint').textContent = HINTS[tool] || ''; }
    if (sel) select(null);
    if (anim.t >= totalDuration()) anim.t = 0;
    const d = drill();
    const go = () => { anim.fresh = anim.t === 0; anim.playing = true; anim.last = performance.now(); anim.raf = requestAnimationFrame(tick); startNarration(d, anim.t); renderAnimBar(); };
    // From the top with a recorded intro (and voice on): the coach speaks first, then the drill runs.
    if (anim.t === 0 && !voiceOn && hasVoice(d)) { cueCaption.textContent = '🔇 voice is muted on this device — click 🔇 muted to hear the intro and cues'; cueCaption.hidden = false; setTimeout(() => { cueCaption.hidden = true; }, 4000); }
    const skipIntro = anim.skipIntro; anim.skipIntro = false;
    const clip = anim.t === 0 && voiceOn && d.intro && !skipIntro ? clipMem.get(keyFor(ownerFor(), store.practice.id, d)) : null;
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
/** Start the drill's narration at animation time t (voice on, clip decoded); a still-decoding clip joins in when ready. */
function startNarration(d, t) {
  stopNarration();
  if (!voiceOn || !d.narration || anim.recNarr) return;
  const entry = clipMem.get(keyFor(ownerFor(), store.practice.id, d, 'narration'));
  if (!entry) return;
  const token = (anim.narrToken = (anim.narrToken || 0) + 1);
  const begin = buf => { if (anim.narrToken !== token || !buf || (!anim.playing && anim.t > 0)) return; anim.narr = playNarration(buf, narrAt(anim.t, drillSpeed()), { onEnd: () => { if (anim.narr) { anim.narr = null; renderAnimBar(); } } }); renderAnimBar(); };
  if (entry.buffer) begin(entry.buffer); else narrationBuffer(entry).then(begin);
}
function stopNarration() { anim.narrToken = (anim.narrToken || 0) + 1; const n = anim.narr; anim.narr = null; n?.stop(); }

/** Immediate reset to the start (used when switching drills, deleting, etc.). */
function stopAnim() {
  if (returning) cancelReturn();
  anim.playing = false; cancelAnimationFrame(anim.raf); anim.t = 0;
  cancelIntro(); stopNarration();
  if (anim.recNarr) introAction('nstop');
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

/** Swap a button's icon only when it changes: rewriting it every tick detaches the SVG mid-press and the click never lands. */
function setBtnIcon(el, name) {
  if (el.dataset.iconNow === name) return;
  el.dataset.iconNow = name;
  el.innerHTML = icon(name);
}

function renderAnimBar() {
  $('#btn-board').classList.toggle('has-board', !!drill()?.board);
  if (isPSDrill(drill())) { // power skating mode: ▶/⏹ drive the 3D viewer; the timeline doesn't apply
    setBtnIcon($('#btn-play'), psViewInst?.playing ? 'pause' : 'play');
    $('#btn-play').disabled = !(drill().psElements || []).length;
    $('#timeline').disabled = true;
    $('#time-display').textContent = 'technique demo';
    $('#impact-loser-wrap').hidden = true;
    return;
  }
  $('#timeline').disabled = false;
  const T = totalDuration();
  setBtnIcon($('#btn-play'), anim.playing || anim.intro || anim.narr || anim.recNarr ? 'pause' : 'play');
  $('#btn-play').disabled = T <= 0;
  const tl = $('#timeline');
  tl.max = Math.max(T, 0.01); tl.value = Math.min(anim.t, T);
  if (document.activeElement !== $('#anim-speed')) $('#anim-speed').value = String(drillSpeed());
  $('#anim-trails').checked = drillPaths();
  $('#anim-voice').hidden = !hasVoice(drill());
  $('#anim-voice').classList.toggle('active', voiceOn);
  $('#anim-voice').textContent = voiceOn ? '🔊 voice' : '🔇 muted';
  $('#time-display').textContent = returning ? '↩ skating back' : anim.intro ? '🎙 intro…' : `${Math.min(anim.t, T).toFixed(1)} / ${T.toFixed(1)} s${anim.recNarr ? ' · ● recording' : anim.narr && !anim.playing ? ' · 🎙 voice…' : ''}`;
  $('#anim-speed').title = drill().narration ? `Recorded voice-over at ${drill().narration.speed || 1}× — changing the speed deletes it` : 'Playback speed';
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

$('#impact-loser').addEventListener('change', e => {
  drill().impactLoser = e.target.value || null;
  store.save();
  e.target.blur();
  renderCanvas();
  renderAnimBar(); // the loser's slowdown changes the drill's total time
});

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-stop').addEventListener('click', stopWithReturn);
$('#timeline').addEventListener('input', e => { anim.t = +e.target.value; if (anim.t === 0) renderCanvas(); else applyAnimation(anim.t); if (anim.playing) startNarration(drill(), anim.t); else stopNarration(); renderAnimBar(); });
$('#timeline').addEventListener('change', e => e.target.blur()); // scrub done → hotkeys work again
$('#anim-speed').addEventListener('change', e => {
  const d = drill();
  if (+e.target.value === drillSpeed()) return;
  // A recorded voice-over only lines up at the speed it was recorded at: changing the speed throws it away (after a warning).
  if (d.narration && !confirm(`This ${itemNoun(store.practice)} has a voice-over recorded at ${d.narration.speed || 1}×. Changing the speed deletes that recording — you can record it again at the new speed.\n\nChange the speed and delete the voice-over?`)) { e.target.value = String(drillSpeed()); return; }
  if (d.narration) deleteNarration(d);
  d.animSpeed = +e.target.value; store.save(); renderPlan();
});
$('#anim-trails').addEventListener('change', e => { drill().showPaths = e.target.checked; store.save(); renderCanvas(); });
$('#anim-voice').addEventListener('click', () => setVoice(!voiceOn));

// ---------- view bar ----------
$$('#viewbar [data-view]').forEach(b => b.addEventListener('click', () => setView(VIEWS[b.dataset.view])));
$('#btn-fit').addEventListener('click', fitAll);
$('#offscreen').addEventListener('click', fitAll);
$('#btn-zoom-in').addEventListener('click', () => { const v = drill().view; zoomAt({ x: v.x + v.w / 2, y: v.y + v.h / 2 }, 1 / 1.25); });
$('#btn-zoom-out').addEventListener('click', () => { const v = drill().view; zoomAt({ x: v.x + v.w / 2, y: v.y + v.h / 2 }, 1.25); });
$('#snap-toggle').addEventListener('change', e => snap = e.target.checked);
// The O / D badge on the Skater tool: tap to switch the side new skaters get (picking a side implies you're about to place skaters).
{
  const badge = $('#toolbar [data-side-toggle]');
  const paintSide = () => { badge.textContent = newSide; badge.classList.toggle('O', newSide === 'O'); badge.classList.toggle('D', newSide === 'D'); badge.setAttribute('aria-label', `New skaters: ${SIDES[newSide].name.toLowerCase()} — tap to switch`); };
  paintSide();
  badge.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); }); // not a drag from the palette
  badge.addEventListener('click', e => { e.stopPropagation(); newSide = newSide === 'O' ? 'D' : 'O'; paintSide(); setTool('skater'); });
}
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
  const team = currentTeam();
  const all = store.live.filter(p => inTeam(p, team) || p.id === cur.id).sort((a, b) => byCalendar(b, a)); // the current team's (the open one always shows)
  const shown = plistAll ? all : all.slice(0, PLIST_N);
  const stName = { draft: 'draft', coaches: 'with coaches', team: 'released' };
  $('#plist-items').innerHTML = shown.map(p => {
    const st = stageOf(p), fb = openFeedbackFor(p.id).length;
    return `<button class="plist-item${p.id === cur.id ? ' current' : ''}" data-pid="${p.id}" title="${escHtml(practiceLabel(p))}">
      <b>${escHtml(isGame(p) || isDryland(p) ? docTitle(p) : (p.team || 'No team'))}</b><span class="when">${escHtml(whenLabel(p))}</span>
      ${fb ? `<span class="fb">💬${fb}</span>` : ''}<span class="st ${st}">${stName[st]}</span></button>`;
  }).join('');
  const more = $('#plist-more');
  more.hidden = all.length <= PLIST_N;
  more.textContent = plistAll ? `Show the last ${PLIST_N} only` : `Show all ${all.length}…`;
  // The trash: soft-deleted documents, newest deletion first, each with Restore and Delete forever.
  const trash = store.trashed.filter(p => inTeam(p, team)).sort((a, b) => (+b.deleted || 0) - (+a.deleted || 0));
  const tb = $('#plist-trash-toggle');
  tb.hidden = !trash.length;
  tb.textContent = `${plistTrashOpen ? '▾' : '▸'} Deleted (${trash.length})`;
  $('#plist-trash').hidden = !trash.length || !plistTrashOpen;
  $('#plist-trash').innerHTML = trash.map(p => `<div class="plist-item trashed" title="Deleted ${escHtml(stamp(p.deleted))}">
      <b>${escHtml(isGame(p) || isDryland(p) ? docTitle(p) : (p.team || 'No team'))}</b><span class="when">${escHtml(whenLabel(p))}</span>
      <button class="small-link" data-restore="${p.id}" title="Put it back in the list (sharing resumes where it was)">↶ Restore</button>
      <button class="small-link danger-link" data-purge="${p.id}" title="Delete for good — this cannot be undone">✕ Forever</button></div>`).join('');
}
let plistTrashOpen = false;
$('#plist-trash-toggle').addEventListener('click', () => { plistTrashOpen = !plistTrashOpen; renderPracticeSelect(); });
$('#plist-trash').addEventListener('click', e => {
  const r = e.target.closest('[data-restore]'), x = e.target.closest('[data-purge]');
  if (r) { store.restorePractice(r.dataset.restore); renderPracticeSelect(); return; }
  if (x) {
    const p = store.data.practices.find(q => q.id === x.dataset.purge); if (!p) return;
    if (!confirm(`Delete ${docNoun(p)} "${practiceLabel(p)}" for good? This cannot be undone.`)) return;
    finishActive(); store.deletePractice(p.id); sel = null; stopAnim(); renderAll(); renderPracticeSelect();
  }
});
$('#plist-items').addEventListener('click', e => {
  const b = e.target.closest('.plist-item'); if (!b) return;
  finishActive(); store.switchPractice(b.dataset.pid); sel = null; stopAnim();
  $('#plist-pop').hidden = true; renderAll();
});
$('#plist-more').addEventListener('click', () => { plistAll = !plistAll; renderPracticeSelect(); });
let plistKind = null; // what the create form is making: null = a practice, 'dryland' = an off-ice practice, 'game' = game-prep material
function openCreateForm(kind) {
  const f = $('#plist-form'), teams = store.roster.teams.map(t => t.name || '').filter(Boolean);
  if (!teams.length) { $('#plist-pop').hidden = true; alert(`Add a team under 👥 Team first — a ${kind === 'game' ? 'game' : 'practice'} belongs to a team, and the roster is who gets it.`); openTeamMgr(); return; }
  plistKind = kind;
  const cur = currentTeam()?.name || store.practice.team || '';
  $('#plist-form-title').textContent = kind === 'game' ? 'New game' : kind === 'dryland' ? 'New dryland practice' : 'New practice';
  $('#new-opponent-wrap').hidden = kind !== 'game'; $('#new-opponent').value = '';
  $('#new-time-label').textContent = kind === 'game' ? 'Game time' : 'Start time';
  $('#new-team').innerHTML = teams.map(n => `<option value="${escHtml(n)}"${n.toLowerCase() === cur.toLowerCase() ? ' selected' : ''}>${escHtml(n)}</option>`).join('');
  $('#new-date').value = usDate(todayISO()); $('#new-time').value = store.practice.time || '';
  f.hidden = false; $('.plist-new').hidden = true;
  (kind === 'game' ? $('#new-opponent') : $('#new-date')).focus();
}
$('#plist-create').addEventListener('click', () => openCreateForm(null));
$('#plist-create-game').addEventListener('click', () => openCreateForm('game'));
$('#plist-create-dryland').addEventListener('click', () => openCreateForm('dryland'));
$('#plist-cancel').addEventListener('click', () => { $('#plist-form').hidden = true; $('.plist-new').hidden = false; });
$('#plist-form').addEventListener('submit', e => {
  e.preventDefault();
  const team = $('#new-team').value, date = parseUsDate($('#new-date').value), time = $('#new-time').value;
  $('#new-date').classList.toggle('invalid', !date);
  if (!date) { $('#new-date').focus(); return; }
  if (!team || !time) return; // `required` — the browser has already said which
  finishActive();
  const tm = (store.roster.teams || []).find(t => (t.name || '') === team);
  const p = newPractice(team, plistKind === 'game' ? 'game' : null, $('#new-opponent').value.trim(), tm?.id || null, plistKind === 'dryland' ? 'dryland' : null); p.date = date; p.time = time;
  if (tm) setCurrentTeam(tm.id); // a practice for another team moves the editor to that team
  store.addPractice(p);
  sel = null; stopAnim();
  $('#plist-form').hidden = true; $('.plist-new').hidden = false; $('#plist-pop').hidden = true;
  renderAll();
});

const PRACTICE_FIELDS = [['#practice-team', 'team'], ['#practice-opponent', 'opponent'], ['#practice-date', 'date'], ['#practice-time', 'time'], ['#practice-coaches', 'coaches']];
function renderPracticeProps() {
  const p = store.practice;
  const game = isGame(p);
  $('#btn-new-practice').textContent = game ? '✎ Game' : '✎ Practice';
  $('#btn-new-practice').title = `Details of the ${docNoun(p)} that is open: team, ${game ? 'opponent, ' : ''}date, time, coaches, sharing`;
  $('#practice-pop-title').textContent = game ? 'Current game' : 'Current practice';
  $('#btn-del-practice').textContent = `🗑 Delete this ${docNoun(p)}`;
  $('#btn-dup-practice').textContent = `⧉ Duplicate this ${docNoun(p)}`;
  $('#practice-opponent-wrap').hidden = !game;
  $('#practice-surface-wrap').hidden = game;
  if (document.activeElement !== $('#practice-surface')) $('#practice-surface').value = surfaceOf(p);
  for (const [id, key] of PRACTICE_FIELDS) {
    const el = $(id);
    if (el.tagName === 'SELECT') renderTeamSelect();
    else if (document.activeElement !== el) el.value = key === 'date' ? usDate(p[key]) : (p[key] || '');
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
  $('#practice-open').checked = !!p.open;
  $('#btn-share-open-link').hidden = !p.open;
  $('#open-note').textContent = !p.open ? ''
    : st === 'draft' ? 'Will be open to anyone with the link once it leaves Draft.'
    : '🌐 Open — anyone with the link can watch, with a Google account or as an anonymous guest.';
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
  el.addEventListener('input', () => {
    if (el.value === MANAGE_TEAMS) return;
    if (key === 'date') {
      const iso = parseUsDate(el.value);
      el.classList.toggle('invalid', !iso);
      if (!iso) return; // keep the old date until the field parses as MM/DD/YYYY
      store.practice.date = iso;
    } else {
      store.practice[key] = el.value;
      if (key === 'team') { const tm = (store.roster.teams || []).find(t => (t.name || '') === el.value); if (tm) { store.practice.teamId = tm.id; setCurrentTeam(tm.id); } }
    }
    store.save(); renderPracticeSelect();
  });
  el.addEventListener('change', () => {
    if (el.value === MANAGE_TEAMS) { el.value = store.practice.team || ''; $('#practice-pop').hidden = true; openTeamMgr(); return; }
    store.commitPending(); renderUI();
  });
}
$('#practice-surface').addEventListener('change', e => { // ice ↔ dryland: the drills stay, the floor under them changes
  commit(() => { if (e.target.value === 'dryland') store.practice.surface = 'dryland'; else delete store.practice.surface; });
  renderAll();
});
// The team is picked from the roster (👥 Team), never typed: the roster is what decides who can open the practice.
const MANAGE_TEAMS = '__manage-teams__';

// Date fields are US-format text inputs; the calendar button opens the hidden native picker.
$$('.datewrap').forEach(w => {
  const text = w.querySelector('input[type=text]');
  const native = w.querySelector('input.datepick-native');
  w.querySelector('.datepick').addEventListener('click', e => {
    e.stopPropagation();
    native.value = parseUsDate(text.value) || todayISO();
    try { native.showPicker(); } catch { native.click(); }
  });
  native.addEventListener('click', e => e.stopPropagation());
  native.addEventListener('change', () => {
    if (!native.value) return;
    text.value = usDate(native.value);
    text.classList.remove('invalid');
    text.dispatchEvent(new Event('input'));
    text.dispatchEvent(new Event('change'));
  });
});
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

// ---------- questions to the players: create a poll, hand out one link per player, watch the answers ----------
let askAnswers = {}; // pollId → { token: answer }
let askEditing = null; // pollId whose question is open for inline editing in the manager
const pollLink = (pollId, token) => `${location.origin}${routePath({ view: 'ask', pollId, token })}`;

async function openAskMgr() {
  $('#teammgr').hidden = true;
  $('#askmgr').hidden = false;
  if (!(store.data.polls || []).length && cloudSync?.user && cloudBackend?.loadPollIndex) {
    try { const idx = await cloudBackend.loadPollIndex(cloudSync.user.uid); if (idx?.polls?.length) { store.data.polls = idx.polls; store.persist(); } } catch { /* local list stands */ }
  }
  renderAskMgr();
  refreshAskAnswers();
}
function closeAskMgr() { $('#askmgr').hidden = true; }

async function refreshAskAnswers() {
  if (!cloudBackend?.loadPollAnswers) return;
  for (const poll of store.data.polls || []) {
    try { askAnswers[poll.id] = await cloudBackend.loadPollAnswers(poll.id); } catch { /* offline: show what we have */ }
  }
  if (!$('#askmgr').hidden && !askEditing) renderAskMgr();
}

function savePollRegistry() {
  store.persist();
  if (cloudSync?.user && cloudBackend?.savePollIndex) cloudBackend.savePollIndex(cloudSync.user.uid, { polls: store.data.polls || [], updatedAt: Date.now() }).catch(() => {});
}

function renderAskMgr() {
  const teams = (store.roster.teams || []).filter(t => (t.name || '').trim());
  const polls = store.data.polls || [];
  $('#askmgr-body').innerHTML = `
    <div class="ask-new">
      <h3>New question</h3>
      <label class="field"><span>Question</span><input id="askq" placeholder="e.g. Can you play the Thanksgiving tournament (Nov 27–29)?" maxlength="200"></label>
      <label class="field"><span>Answer choices (comma-separated)</span><input id="asko" value="Yes, No, Maybe" maxlength="200"></label>
      <label class="field"><span>Team</span><select id="askt">${teams.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('')}</select></label>
      <div class="row"><button id="ask-create" class="primary" ${teams.length ? '' : 'disabled title="Add a team with players under 👥 Team first"'}>Create — one link per player</button></div>
    </div>
    ${polls.map(poll => {
      const ans = askAnswers[poll.id] || {};
      const answered = poll.players.filter(pl => ans[pl.token]?.choice).length;
      const counts = {};
      for (const pl of poll.players) { const c = ans[pl.token]?.choice; if (c) counts[c] = (counts[c] || 0) + 1; }
      const head = askEditing === poll.id ? `<div class="ask-poll-head ask-edit">
          <label class="field"><span>Question</span><input class="ask-eq" value="${escHtml(poll.question)}" maxlength="200"></label>
          <label class="field"><span>Answer choices (comma-separated)</span><input class="ask-eo" value="${escHtml(poll.options.join(', '))}" maxlength="200"></label>
          <div class="row"><button data-pact="esave" class="primary">Save</button><button data-pact="ecancel">Cancel</button></div>
        </div>` : `<div class="ask-poll-head"><b>${escHtml(poll.question)}</b>
          <span class="muted small">${escHtml(poll.team)} · ${usDate(new Date(poll.createdAt).toISOString().slice(0, 10))} · ${answered}/${poll.players.length} answered${Object.keys(counts).length ? ' — ' + Object.entries(counts).map(([k, n]) => `${escHtml(k)}: ${n}`).join(' · ') : ''}</span>
          <span class="spacer"></span>
          <button data-pact="edit" title="Edit the question or its answer choices — the links keep working, answers already given stay">✎</button>
          <button data-pact="teamlink" title="Copy ONE link for the whole team: the Survey tab — each parent taps their own player there">🔗 Team link</button>
          <button data-pact="copyall" title="Copy every player's link, one per line — paste into the team chat">🔗 Copy all links</button>
          <button data-pact="refresh" title="Fetch the latest answers">⟳</button>
          <button data-pact="del" class="danger" title="Delete this question and its answers">${icon('x')}</button>
        </div>`;
      return `<div class="ask-poll" data-poll="${poll.id}">
        ${head}
        <div class="ask-rows">${poll.players.map(pl => {
          const a = ans[pl.token];
          return `<div class="ask-row">
            <span class="ask-name">${escHtml(pl.name)}</span>
            <span class="ask-ans ${a?.choice ? 'on' : ''}">${escHtml(a?.choice || '—')}</span>
            ${a?.note ? `<span class="ask-notetxt" title="${escHtml(a.note)}">💬 ${escHtml(a.note.slice(0, 60))}</span>` : ''}
            <span class="spacer"></span>
            <button data-pact="copy" data-token="${pl.token}" title="Copy ${escHtml(pl.name)}’s personal link">🔗</button>
          </div>`;
        }).join('')}</div>
      </div>`;
    }).join('') || '<p class="muted" style="margin-top:12px">No questions yet.</p>'}`;
}

async function createPoll() {
  const question = $('#askq').value.trim();
  const options = $('#asko').value.split(',').map(x => x.trim()).filter(Boolean).slice(0, 6);
  const team = store.roster.teams.find(t => t.id === $('#askt').value);
  if (!question) { alert('Write the question first.'); return; }
  if (!team) { alert('Pick a team.'); return; }
  const players = (team.players || []).filter(pl => (pl.name || '').trim());
  if (!players.length) { alert(`No players on “${team.name}” yet — add them under 👥 Team.`); return; }
  if (!cloudSync?.user || !cloudBackend?.savePoll) { alert('Sign in first — answers are collected through your cloud account.'); return; }
  const poll = {
    id: uid() + uid(), question, options: options.length ? options : ['Yes', 'No'],
    teamId: team.id, team: team.name || '', createdAt: Date.now(),
    players: players.map(pl => ({ id: pl.id, name: pl.name, token: uid() + uid() })),
  };
  try {
    await cloudBackend.savePoll(poll.id, { question: poll.question, options: poll.options, team: poll.team, createdAt: poll.createdAt });
    for (const pl of poll.players) await cloudBackend.savePollAnswer(poll.id, pl.token, { player: pl.name, choice: '', note: '', createdAt: Date.now() });
    await cloudBackend.saveTeamPoll?.(poll.teamId, poll.id, { id: poll.id, question: poll.question, options: poll.options, createdAt: poll.createdAt, players: poll.players });
  } catch (e) { alert(`Could not create the question: ${e?.message || e}`); return; }
  store.data.polls = [poll, ...(store.data.polls || [])];
  savePollRegistry();
  renderAskMgr();
}

$('#btn-ask').addEventListener('click', openAskMgr);
$('#askmgr-close').addEventListener('click', closeAskMgr);
$('#askmgr').addEventListener('click', async e => {
  if (e.target === $('#askmgr')) return closeAskMgr();
  if (e.target.closest('#ask-create')) { createPoll(); return; }
  const btn = e.target.closest('[data-pact]'); if (!btn) return;
  const pollEl = btn.closest('.ask-poll');
  const poll = (store.data.polls || []).find(x => x.id === pollEl?.dataset.poll); if (!poll) return;
  const flash = txt => { const old = btn.textContent; btn.textContent = txt; setTimeout(() => { btn.textContent = old; }, 1400); };
  if (btn.dataset.pact === 'teamlink') {
    const url = `${location.origin}${routePath({ view: 'team', teamId: poll.teamId, tab: 'questions' })}`;
    try { await navigator.clipboard.writeText(url); flash('✓ Copied'); } catch { prompt('Copy this link:', url); }
  } else if (btn.dataset.pact === 'copy') {
    const url = pollLink(poll.id, btn.dataset.token);
    try { await navigator.clipboard.writeText(url); flash('✓'); } catch { prompt('Copy this link:', url); }
  } else if (btn.dataset.pact === 'copyall') {
    const text = poll.players.map(pl => `${pl.name}: ${pollLink(poll.id, pl.token)}`).join('\n');
    try { await navigator.clipboard.writeText(text); flash('✓ Copied'); } catch { prompt('Copy these links:', text); }
  } else if (btn.dataset.pact === 'refresh') {
    try { askAnswers[poll.id] = await cloudBackend.loadPollAnswers(poll.id); renderAskMgr(); } catch (err) { alert(`Could not fetch answers: ${err?.message || err}`); }
  } else if (btn.dataset.pact === 'edit') {
    askEditing = poll.id; renderAskMgr();
  } else if (btn.dataset.pact === 'ecancel') {
    askEditing = null; renderAskMgr();
  } else if (btn.dataset.pact === 'esave') {
    const question = pollEl.querySelector('.ask-eq').value.trim();
    const options = pollEl.querySelector('.ask-eo').value.split(',').map(x => x.trim()).filter(Boolean).slice(0, 6);
    if (!question) { alert('Write the question first.'); return; }
    btn.disabled = true;
    try {
      await cloudBackend.savePoll(poll.id, { question, options: options.length ? options : ['Yes', 'No'], team: poll.team, createdAt: poll.createdAt });
      await cloudBackend.saveTeamPoll?.(poll.teamId, poll.id, { id: poll.id, question, options: options.length ? options : ['Yes', 'No'], createdAt: poll.createdAt, players: poll.players });
    } catch (err) { btn.disabled = false; alert(`Could not save: ${err?.message || err}`); return; }
    poll.question = question; poll.options = options.length ? options : ['Yes', 'No'];
    askEditing = null;
    savePollRegistry();
    renderAskMgr();
  } else if (btn.dataset.pact === 'del') {
    if (!confirm(`Delete “${poll.question}” and all its answers? The links stop working.`)) return;
    try { await cloudBackend.removePoll(poll.id, poll.players.map(pl => pl.token)); await cloudBackend.removeTeamPoll?.(poll.teamId, poll.id); } catch (err) { alert(`Could not delete: ${err?.message || err}`); return; }
    store.data.polls = store.data.polls.filter(x => x.id !== poll.id);
    savePollRegistry();
    renderAskMgr();
  }
});

function openTeamMgr() {
  finishActive();
  migrateClubs();
  if (!store.roster.teams.length) {
    store.roster.teams.push({ id: uid(), name: store.practice.team || 'My team', coaches: [], players: [] });
    store.saveRoster();
  }
  teamSelId = currentMgrTeam()?.id || null;
  $('#teammgr').hidden = false;
  renderTeamMgr();
}
function closeTeamMgr() { $('#teammgr').hidden = true; renderUI(); } // the team picker and stage box follow the roster

// ---------- ⚙ Settings: the Claude key (see the ✨ section further down) and this device's preferences in one place ----------
// Each preference already has its own control somewhere (toolbar checkboxes, the pane pin, the 🎬 row, the voice
// toggle, the presenter's mode switch); the settings panel mirrors them and drives the same handlers.
function openSettings() { finishActive(); closePopovers(); $('#settings').hidden = false; renderSettings(); }
function closeSettings() { $('#settings').hidden = true; renderUI(); }
function renderSettings() {
  if ($('#settings').hidden) return;
  const u = cloudSync?.user;
  $('#settings-who').textContent = u ? u.email : cloudBoot === 'none' ? 'local only' : 'not signed in';
  $('#settings-account').textContent = u ? `Signed in as ${u.name || u.email} (${u.email})${isOwner(u) ? ' — the planner' : ''}. Sign out is on the top bar.` : cloudBoot === 'none' ? 'No Firebase configured: everything stays on this device.' : 'Not signed in — practices, games and the Claude key are saved to the cloud once you sign in (top bar).';
  const vals = { 'tire-keep': keepTool.tire, 'skater-keep': keepTool.skater, 'cone-keep': keepTool.cone, 'plan-pin': $('#sidebar').classList.contains('plan-unpinned') === false, voice: voiceOn, viewmode: presentMode === 'list' ? 'list' : 'focus' };
  for (const el of $$('#settings [data-set]')) { if (el.type === 'checkbox') el.checked = !!vals[el.dataset.set]; else el.value = vals[el.dataset.set]; }
  renderAIPop();
}
$('#settings').addEventListener('change', e => {
  const k = e.target.dataset.set; if (!k) return;
  const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (k === 'tire-keep' || k === 'skater-keep' || k === 'cone-keep') { const box = $(`#${k}`); if (box.checked !== v) { box.checked = v; box.dispatchEvent(new Event('change')); } }
  else if (k === 'plan-pin') { if ($('#sidebar').classList.contains('plan-unpinned') === v) $('#plan-pin').click(); }
  else if (k === 'voice') setVoice(v);
  else if (k === 'viewmode') setPresentModePref(v);
  renderSettings();
});
$('#btn-settings').addEventListener('click', e => { e.stopPropagation(); closePopovers(); openSettings(); });
$('#settings-close').addEventListener('click', closeSettings);
$('#settings').addEventListener('click', e => { if (e.target === $('#settings')) closeSettings(); }); // a click on the backdrop closes it

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
  const reqRow = (r, what, kind) => `
    <div class="req-row" data-ruid="${escHtml(r.uid)}" data-kind="${kind}">
      <div><b>${escHtml(r.name || r.email)}</b> <span class="muted small">${escHtml(r.email)} · ${what}</span></div>
      <div class="row">
        <button data-act="req-coach">${kind === 'request' ? 'Approve' : 'Add'} as coach</button>
        <select class="req-player" title="Whose family?">${t.players.map(pl => `<option value="${pl.id}">${escHtml(pl.name || 'unnamed player')}</option>`).join('')}<option value="">＋ new player</option></select>
        <button data-act="req-family">${kind === 'request' ? 'Approve' : 'Add'} as family</button>
        <button data-act="req-deny" class="danger">${kind === 'request' ? 'Deny' : 'Dismiss'}</button>
      </div>
    </div>`;
  const reqRows = openRequests().map(r => reqRow(r, `asks to join as ${r.role === 'coach' ? 'a coach' : 'family'}${r.note ? ` · “${escHtml(r.note)}”` : ''}`, 'request')).join('');
  // Signed in, on no roster, and never asked: the audit of who tried to get in — and a one-click way to let them.
  const tryRows = deniedSignIns().map(a => reqRow(a, `signed in without access ${a.count > 1 ? `${a.count} times, last ` : ''}${stamp(a.at || 0)}${a.path ? ` · opened ${escHtml(a.path)}` : ''}`, 'attempt')).join('');
  body.innerHTML = `
    ${reqRows ? `<h3>Access requests</h3>${reqRows}` : ''}
    ${tryRows ? `<h3>Signed in without access</h3>${tryRows}` : ''}
    <label class="field inline ros-team-name"><span>Team name</span><input data-field="teamname" value="${escHtml(t.name || '')}"></label>
    <label class="check"><input type="checkbox" data-field="club" ${t.club ? 'checked' : ''}> Official club team — weekly tasks, player profiles and each player's weekly output</label>
    ${t.club ? `<p class="muted small">Weekly tasks, their how-tos and every player's output live under <b>📅 Tasks</b> on the top bar. Families see their player's profile on their practice list; the players and contacts below decide who may log for whom.</p>
    <div class="row"><button data-act="tasks">📅 Open Tasks for this team</button></div>` : ''}
    <h3>Coaches</h3>
    ${coachRows || '<p class="muted small">No coaches yet.</p>'}
    <div class="row"><button data-act="addcoach">＋ Add coach</button></div>
    <h3>Players &amp; family contacts</h3>
    ${playerBlocks || '<p class="muted small">No players yet.</p>'}
    <div class="row"><button data-act="addplayer">＋ Add player</button></div>`;
}

// ----- a task's how-to media: recorded audio and an uploaded (or linked) video, stored under club/{teamId}/media -----
let taskMediaOpen = null; // the task whose media panel is open in the team manager
let taskRec = null;       // an audio recording in progress: { taskId, rec, timer }
let taskVid = null;       // a video being encoded / uploaded: { taskId, status }
let taskPlaying = null;   // the how-to clip playing in the editor: { taskId, stop() }
function taskMediaHTML(t, k) {
  const rec = taskRec?.taskId === k.id, enc = taskVid?.taskId === k.id;
  const a = k.audio, v = k.video, link = k.videoUrl ? videoEmbed(k.videoUrl) : null;
  return `<div class="ros-media" data-tid="${k.id}">
    <div class="ros-media-col">
      <div class="muted small"><b>🎙 Explain it</b> — ${rec ? '● Recording — describe how to do it' : a ? `recorded · ${(+a.secs || 0).toFixed(1)} s · ${fmtKB(a.size)}${a.cloud === true ? ' · ☁ in the cloud' : a.cloud === false ? ` · <span class="warn">⚠ not in the cloud${a.cloudError ? ` (${escHtml(a.cloudError)})` : ''}</span>` : ''}` : 'no recording yet'}</div>
      <div class="row">
        ${rec ? '<button data-act="tm-stop" class="danger">■ Stop</button>' : `<button data-act="tm-rec" ${canRecord() && !taskRec ? '' : 'disabled'}>● ${a ? 'Re-record' : 'Record'}</button>`}
        <button data-act="tm-play" ${a && !rec ? '' : 'disabled'}>${taskPlaying?.taskId === k.id ? '■ Stop' : '▶ Listen'}</button>
        <button data-act="tm-delaudio" ${a && !rec ? '' : 'disabled'}>✕ Delete</button>
      </div>
    </div>
    <div class="ros-media-col">
      <div class="muted small"><b>🎬 Show it</b> — ${enc ? escHtml(taskVid.status) : v ? `video · ${fmtSecs(v.secs)} · ${(v.size / 1048576).toFixed(1)} MB${v.cloud === true ? ' · ☁ in the cloud' : v.cloud === false ? ` · <span class="warn">⚠ not in the cloud${v.cloudError ? ` (${escHtml(v.cloudError)})` : ''}</span>` : ''}` : 'no video yet'}</div>
      <div class="row">
        <button data-act="tm-pick" ${enc ? 'disabled' : ''}>📼 ${v ? 'Replace' : 'Upload'} a video</button><input type="file" class="tm-file" accept="video/*,.mov,.mp4,.webm" hidden>
        <button data-act="tm-watch" ${v && !enc ? '' : 'disabled'}>▶ Watch</button>
        <button data-act="tm-delvideo" ${v && !enc ? '' : 'disabled'}>✕ Delete</button>
      </div>
      <input class="ros-link" data-field="videoUrl" value="${escHtml(k.videoUrl || '')}" placeholder="…or paste a YouTube / Vimeo link" spellcheck="false">
      ${k.videoUrl && !link ? '<div class="warn small">⚠ Not a link this app can embed — use a YouTube, Vimeo or Cloudflare Stream page link.</div>' : ''}
      <div class="tm-player"></div>
    </div>
    <p class="muted small ros-media-note">Families get these on the player's profile next to the task. Audio is one small document; a video is re-encoded here (640 px, a few MB a minute) and stored in pieces beside the team — a shorter clip is kinder to phones.</p>
  </div>`;
}
async function taskMediaAction(act, t, k, btn) {
  if (!k) return;
  const panel = btn.closest('.ros-media');
  const note = msg => { const el = panel?.querySelector('.ros-media-note'); if (el) el.textContent = msg; };
  if (act === 'tm-rec') {
    if (taskRec) return;
    let rec = null;
    try { rec = await startRecording(); } catch (e) { note(`Microphone not available: ${e?.message || e}`); return; }
    taskRec = { taskId: k.id, rec };
    rerenderTasks();
    taskRec.timer = setInterval(() => { const b = $('#team-body [data-act="tm-stop"]'); if (b && taskRec) b.textContent = `■ Stop (${((performance.now() - taskRec.rec.since) / 1000).toFixed(0)} s · ${fmtKB(taskRec.rec.size())})`; }, 500);
  } else if (act === 'tm-stop') {
    const r = taskRec; if (!r) return; taskRec = null; clearInterval(r.timer);
    const { blob, mime, secs } = await r.rec.stop();
    if (!blob.size || secs < 0.5) { rerenderTasks(); return; }
    const at = Date.now();
    if (k.audio) { const old = taskAudioKey(t.id, k); forgetClip(old); idbDelClip(old).catch(() => {}); }
    k.audio = { at, mime, secs, size: blob.size };
    try { await idbPutClip(taskAudioKey(t.id, k), { mime, blob, secs }); } catch { /* the cloud copy still serves this device */ }
    let up = { ok: false, error: 'not signed in' };
    if (cloudBackend?.saveClubMedia && cloudSync?.user) { try { await cloudBackend.saveClubMedia(t.id, `${k.id}_audio`, { mime, data: await blobToBase64(blob), secs, at }); up = { ok: true }; } catch (e) { up = { ok: false, error: e?.message || String(e) }; } }
    k.audio.cloud = up.ok; if (up.error) k.audio.cloudError = up.error;
    store.saveRoster(); rerenderTasks();
  } else if (act === 'tm-play') {
    if (taskPlaying) { taskPlaying.stop(); return; }
    const entry = await fetchTaskAudio(t.id, k); if (!entry) { note('No copy of the recording here — record it again.'); return; }
    taskPlaying = playClip(entry, { onEnd: () => { taskPlaying = null; rerenderTasks(); } }); taskPlaying.taskId = k.id; rerenderTasks();
  } else if (act === 'tm-delaudio') {
    const key = taskAudioKey(t.id, k); forgetClip(key); idbDelClip(key).catch(() => {});
    if (cloudBackend?.removeClubMedia && cloudSync?.user) cloudBackend.removeClubMedia(t.id, `${k.id}_audio`).catch(() => {});
    delete k.audio; store.saveRoster(); rerenderTasks();
  } else if (act === 'tm-pick') {
    const input = panel.querySelector('.tm-file'); if (!input) return;
    input.onchange = () => { const f = input.files?.[0]; if (f) encodeTaskVideo(t, k, f); };
    input.click();
  } else if (act === 'tm-watch') {
    const box = panel.querySelector('.tm-player'); box.innerHTML = '<span class="muted small">Loading…</span>';
    const entry = await fetchTaskVideo(t.id, k, (i, n) => { box.textContent = `Downloading ${i} / ${n}…`; });
    box.innerHTML = entry ? `<div class="video-box"><video src="${entry.url}" controls playsinline autoplay></video></div>` : '<span class="warn small">No copy of this video is available here.</span>';
  } else if (act === 'tm-delvideo') {
    const old = k.video;
    const key = taskVideoKey(t.id, k); forgetClip(key); idbDelClip(key).catch(() => {});
    if (old?.cloud && cloudBackend?.removeClubMedia && cloudSync?.user) for (let i = 0; i < (old.chunks || 0); i++) cloudBackend.removeClubMedia(t.id, `${k.id}_video_${old.at}_${i}`).catch(() => {});
    delete k.video; store.saveRoster(); rerenderTasks();
  }
}
/** Re-encode a dropped file small (js/video.js) and store it in chunks under the club — the task keeps the metadata. */
async function encodeTaskVideo(t, k, file) {
  if (taskVid) return;
  taskVid = { taskId: k.id, status: 'Starting the encoder…' }; rerenderTasks();
  const progress = msg => { taskVid.status = msg; const el = $(`#tasks-week .ros-media[data-tid="${k.id}"] b`)?.parentElement; if (el && el.textContent.includes('Show it')) el.innerHTML = `<b>🎬 Show it</b> — ${escHtml(msg)}`; };
  try {
    const out = await transcodeVideo(file, { onProgress: (s, total) => progress(`Encoding… ${s.toFixed(0)}${Number.isFinite(total) ? ` / ${total.toFixed(0)}` : ''} s`) });
    const at = Date.now(), chunks = await blobToChunks(out.blob);
    const old = k.video;
    k.video = { at, mime: out.mime, secs: out.secs, size: out.blob.size, width: out.width, height: out.height, chunks: chunks.length };
    try { await idbPutClip(taskVideoKey(t.id, k), { mime: out.mime, blob: out.blob, secs: out.secs }); } catch { /* fine */ }
    let up = { ok: false, error: 'not signed in' };
    if (cloudBackend?.saveClubMedia && cloudSync?.user) {
      try {
        for (let i = 0; i < chunks.length; i++) { progress(`Uploading ${i + 1} / ${chunks.length}…`); await cloudBackend.saveClubMedia(t.id, `${k.id}_video_${at}_${i}`, { i, n: chunks.length, data: chunks[i], mime: out.mime, secs: out.secs, size: out.blob.size, width: out.width, height: out.height, at }); }
        up = { ok: true };
        if (old?.cloud) for (let i = 0; i < (old.chunks || 0); i++) cloudBackend.removeClubMedia(t.id, `${k.id}_video_${old.at}_${i}`).catch(() => {});
      } catch (e) { up = { ok: false, error: e?.message || String(e) }; }
    }
    if (old) { const oldKey = clipKey(`clubvideo:${t.id}`, 'task', k.id, old.at); forgetClip(oldKey); idbDelClip(oldKey).catch(() => {}); }
    k.video.cloud = up.ok; if (up.error) k.video.cloudError = up.error;
    store.saveRoster();
  } catch (e) { alert(`Encoding failed: ${e?.message || e}`); }
  taskVid = null; rerenderTasks();
}

// ----- weeks: the calendar in the team manager, and the design pane for one week's task list -----
const CAL_WEEKS = 16; // weeks shown per calendar page
let calFrom = shiftWeek(weekKey(), -3); // the first week on the calendar page
let weekPlanOpen = null; // { teamId, week } while a week's design pane is open
/** The task array being edited: the open week's (created on demand), else nothing. */
function weekTasks(t) {
  if (!weekPlanOpen || weekPlanOpen.teamId !== t.id) return [];
  const w = (t.weeks ||= {})[weekPlanOpen.week] ||= { tasks: [] };
  return (w.tasks ||= []);
}
const weekRange = w => { const s = weekStart(w); const e = new Date(s); e.setDate(e.getDate() + 6); const f = d => `${d.getMonth() + 1}/${d.getDate()}`; return `${f(s)}–${f(e)}`; };
function weekCalendarHTML(t, selected = null) {
  const now = weekKey();
  const cells = [];
  for (let i = 0, w = calFrom; i < CAL_WEEKS; i++, w = shiftWeek(w, 1)) {
    const list = (t.weeks?.[w]?.tasks || []).filter(k => String(k.title || '').trim());
    const s = weekStart(w);
    const month = i === 0 || s.getDate() <= 7 ? `<span class="cal-month">${s.toLocaleString(undefined, { month: 'short' })}</span>` : '';
    cells.push(`<button class="cal-week${list.length ? ' set' : ' empty'}${w === now ? ' now' : ''}${w < now ? ' past' : ''}${w === selected ? ' sel' : ''}" data-act="cal-week" data-week="${w}" title="${w} · ${weekRange(w)}${list.length ? ` · ${list.length} task${list.length === 1 ? '' : 's'}` : ' · no task list yet'}">
      ${month}<b>${weekRange(w)}</b><span>${list.length ? `✓ ${list.length} task${list.length === 1 ? '' : 's'}` : 'missing'}</span></button>`);
  }
  return `<div class="cal-nav"><button data-act="cal-prev" title="Earlier weeks">◀</button><span class="muted small">${weekRange(calFrom)} → ${weekRange(shiftWeek(calFrom, CAL_WEEKS - 1))}</span><button data-act="cal-next" title="Later weeks">▶</button></div>
    <div class="cal-grid">${cells.join('')}</div>`;
}
// ----- 📅 Tasks: one top-level panel for the current team — the calendar, and under it the selected week's list or output
/** Club teams from earlier versions: a recurring list becomes this week's, and Monday-week keys move onto their Sunday weeks — saved once. */
function migrateClubs() {
  const stale = t => t.club && (Array.isArray(t.tasks) || Object.keys(t.weeks || {}).some(w => /^\d{4}-W\d{2}$/.test(w)));
  if (!(store.roster.teams || []).some(stale)) return;
  for (const t of store.roster.teams) if (t.club) migrateClubTeam(t, weekKey());
  store.saveRoster();
}
let tasksTab = 'tasks'; // 'tasks' | 'output' for the selected week
function openTasks() {
  migrateClubs();
  const t = currentTeam(); if (!t) { alert('Pick a team first (the team selector on the top bar).'); return; }
  if (!t.club) { if (!confirm(`${t.name || 'This team'} isn't marked as an official club team yet. Mark it now?`)) return; t.club = true; t.weeks ||= {}; store.saveRoster(); }
  closeTeamMgr(); closePopovers();
  weekPlanOpen = weekPlanOpen?.teamId === t.id ? weekPlanOpen : { teamId: t.id, week: weekKey() };
  taskMediaOpen = null;
  $('#tasks').hidden = false;
  renderTasks();
}
function closeTasks() { $('#tasks').hidden = true; weekPlanOpen = null; clubState.navless = false; renderUI(); }
function rerenderTasks() { if (!$('#tasks').hidden) renderTasks(); else renderTeamMgr(); }
const taskRowHTML = (t, k) => `
    <div class="ros-row ros-task" data-tid="${k.id}">
      <input placeholder="Task — e.g. Shots on goal" data-field="title" value="${escHtml(k.title || '')}">
      <select data-field="unit" title="What gets counted">${Object.entries(TASK_UNITS).map(([v, l]) => `<option value="${v}" ${(k.unit || 'reps') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="number" min="0" step="1" placeholder="amount" title="How much each time — e.g. 25 shots" data-field="target" value="${+k.target || 0}">
      <span class="ros-x muted small">×</span>
      <input type="number" min="1" step="1" placeholder="times" title="How many times this week — e.g. 3" data-field="times" value="${Math.max(1, +k.times || 1)}">
      <span class="ros-x muted small">this week</span>
      <button data-act="media" class="${k.audio || k.video || k.videoUrl ? 'has-media' : ''}${taskMediaOpen === k.id ? ' open' : ''}" title="Explain how it's done: record audio, upload or link a video">${k.audio ? '🎙' : ''}${k.video || k.videoUrl ? '🎬' : ''}${k.audio || k.video || k.videoUrl ? '' : '🎙🎬'}</button>
      <button data-act="deltask" title="Remove task">${icon('x')}</button>
    </div>${taskMediaOpen === k.id ? taskMediaHTML(t, k) : ''}`;
function renderTasks() {
  if ($('#tasks').hidden || !weekPlanOpen) return;
  const t = (store.roster.teams || []).find(x => x.id === weekPlanOpen.teamId); if (!t) { closeTasks(); return; }
  const { week } = weekPlanOpen, now = weekKey();
  $('#tasks-title').textContent = t.name || 'Team';
  $('#tasks-cal').innerHTML = weekCalendarHTML(t, week);
  $('#tasks-week-head').innerHTML = `<h3>${escHtml(weekRange(week))}<span class="muted small"> · ${week === now ? 'this week' : week < now ? 'past' : 'ahead'}</span></h3>
    <div class="tabs"><button data-tab="tasks" class="${tasksTab === 'tasks' ? 'on' : ''}">Tasks</button><button data-tab="output" class="${tasksTab === 'output' ? 'on' : ''}" ${week > now ? 'disabled title="Numbers come in once the week starts — a week ahead has nothing to show yet"' : ''}>📊 Output</button></div>`;
  if (tasksTab === 'output' && week > now) tasksTab = 'tasks'; // a week ahead has no numbers: plan its tasks, nothing to log yet
  $('#tasks-week').hidden = tasksTab !== 'tasks'; $('#tasks-output').hidden = tasksTab !== 'output';
  if (tasksTab === 'output') { if (clubState.mount !== $('#tasks-output') || clubState.teamId !== t.id || clubState.week !== week) openClubOutput(t.id, { mount: $('#tasks-output'), week, navless: true }); return; }
  const tasks = weekTasks(t);
  const prev = shiftWeek(week, -1), prevTasks = (t.weeks?.[prev]?.tasks || []).filter(k => String(k.title || '').trim());
  const copyFrom = Object.keys(t.weeks || {}).filter(w => w !== week && (t.weeks[w]?.tasks || []).some(k => String(k.title || '').trim())).sort().reverse().slice(0, 12);
  $('#tasks-week').innerHTML = `
    ${tasks.map(k => taskRowHTML(t, k)).join('') || `<p class="muted">No tasks for this week yet.${prevTasks.length ? ' Copy last week\'s list and adjust it, or start from scratch.' : ''}</p>`}
    <div class="row">
      <button data-act="addtask">＋ Add task</button>
      ${copyFrom.length ? `<label class="check small">Copy from <select class="week-copy"><option value="">— a week —</option>${copyFrom.map(w => `<option value="${w}">${weekRange(w)}${w === prev ? ' (last week)' : ''}</option>`).join('')}</select></label><button data-act="copyweek" title="Add that week's tasks to this one">Copy</button>` : ''}
      <span class="spacer"></span>
      ${tasks.length ? '<button data-act="delweek" class="danger">✕ Clear this week</button>' : ''}
    </div>
    <p class="muted small">Amount each time × how many times this week. The 🎙🎬 button on a task attaches a how-to. Copied tasks share their how-to media with the week they came from.</p>`;
}
$('#tasks-close').addEventListener('click', closeTasks);
$('#tasks').addEventListener('click', e => { if (e.target === e.currentTarget) closeTasks(); });
$('#tasks-cal').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]'); if (!btn || !weekPlanOpen) return;
  if (btn.dataset.act === 'cal-prev') calFrom = shiftWeek(calFrom, -CAL_WEEKS);
  else if (btn.dataset.act === 'cal-next') calFrom = shiftWeek(calFrom, CAL_WEEKS);
  else if (btn.dataset.act === 'cal-week') { weekPlanOpen.week = btn.dataset.week; taskMediaOpen = null; }
  renderTasks();
});
$('#tasks-week-head').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; tasksTab = b.dataset.tab; renderTasks(); });
// The week's inputs and buttons behave like the team manager's: same field saving, same task actions.
$('#tasks-week').addEventListener('input', e => {
  const el = e.target, t = (store.roster.teams || []).find(x => x.id === weekPlanOpen?.teamId);
  if (!t || !el.dataset.field) return;
  const row = el.closest('[data-tid]'); if (!row) return;
  const k = weekTasks(t).find(x => x.id === row.dataset.tid); if (!k) return;
  k[el.dataset.field] = el.dataset.field === 'target' ? Math.max(0, Math.round(+el.value || 0)) : el.dataset.field === 'times' ? Math.max(1, Math.round(+el.value || 1)) : el.value;
  store.saveRoster();
});
$('#tasks-week').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn?.dataset.act) return;
  const t = (store.roster.teams || []).find(x => x.id === weekPlanOpen?.teamId); if (!t) return;
  const tasks = weekTasks(t);
  switch (btn.dataset.act) {
    case 'addtask': tasks.push({ id: uid(), title: '', unit: 'reps', target: 0, times: 1 }); break;
    case 'deltask': t.weeks[weekPlanOpen.week].tasks = tasks.filter(k => k.id !== btn.closest('[data-tid]').dataset.tid); break;
    case 'delweek': if (!confirm('Clear every task from this week?')) return; delete t.weeks[weekPlanOpen.week]; break;
    case 'copyweek': {
      const from = $('#tasks-week .week-copy')?.value; const src = t.weeks?.[from]?.tasks || []; if (!from || !src.length) return;
      for (const k of src) if (String(k.title || '').trim()) tasks.push({ ...JSON.parse(JSON.stringify(k)), id: uid() }); // the same how-to media, a fresh task id
      break;
    }
    case 'media': { const id = btn.closest('[data-tid]').dataset.tid; taskMediaOpen = taskMediaOpen === id ? null : id; renderTasks(); return; }
    case 'tm-rec': case 'tm-stop': case 'tm-play': case 'tm-delaudio': case 'tm-pick': case 'tm-watch': case 'tm-delvideo': taskMediaAction(btn.dataset.act, t, tasks.find(k => k.id === btn.closest('[data-tid]').dataset.tid), btn); return;
    default: return;
  }
  store.saveRoster(); renderTasks();
});
$('#btn-tasks').addEventListener('click', openTasks);

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
  const kept = store.data.practices.filter(p => inTeam(p, t)).length;
  if (kept) { alert(`${t.name || 'This team'} still has ${kept} practice${kept === 1 ? '' : 's'} (including deleted ones). Move them to another team or delete them for good first.`); return; }
  if (!confirm(`Delete team "${t.name || 'unnamed'}" and its roster? This cannot be undone.`)) return;
  store.roster.teams = store.roster.teams.filter(x => x.id !== t.id);
  teamSelId = null;
  store.saveRoster(); renderTeamMgr();
});
$('#team-body').addEventListener('input', e => {
  const el = e.target; const t = currentMgrTeam();
  if (!t || !el.dataset.field) return;
  if (el.dataset.field === 'teamname') { renameFrom ??= t.name; t.name = el.value; store.saveRoster(); return; }
  if (el.dataset.field === 'club') return; // a checkbox: handled on change
  const row = el.closest('[data-cid],[data-kid],[data-pid],[data-tid]');
  if (!row) return;
  const obj = row.dataset.cid ? t.coaches.find(c => c.id === row.dataset.cid)
    : row.dataset.kid ? t.players.flatMap(p => p.contacts || []).find(k => k.id === row.dataset.kid)
    : row.dataset.tid ? weekTasks(t).find(k => k.id === row.dataset.tid)
    : t.players.find(p => p.id === row.dataset.pid);
  if (!obj) return;
  obj[el.dataset.field] = el.dataset.field === 'target' ? Math.max(0, Math.round(+el.value || 0)) : el.dataset.field === 'times' ? Math.max(1, Math.round(+el.value || 1)) : el.value;
  store.saveRoster();
});
let renameFrom = null; // a roster team's name before the current edit: its practices are renamed with it
$('#team-body').addEventListener('change', e => {
  if (e.target.dataset.field === 'club') { const t = currentMgrTeam(); if (!t) return; t.club = e.target.checked; if (t.club) t.weeks ||= {}; store.saveRoster(); renderTeamMgr(); return; }
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
  const reqRow = btn.closest('[data-ruid]');
  const fromAttempt = reqRow?.dataset.kind === 'attempt';
  const req = reqRow && (fromAttempt ? accessAttempts : accessRequests).find(r => r.uid === reqRow.dataset.ruid);
  const settle = (fn, r) => { fn(r.uid).catch(e => alert(`Couldn't update the request: ${e?.message || e}`)); if (!fromAttempt) cloudBackend.removeAttempt?.(r.uid).catch(() => {}); }; // a settled request retires the sign-in record too
  const clear = fromAttempt ? cloudBackend?.removeAttempt : cloudBackend?.removeRequest; // no cloud (local-only): the request rows don't exist anyway
  switch (btn.dataset.act) {
    case 'req-coach': if (!req) return; t.coaches.push({ id: uid(), name: req.name || '', email: req.email }); settle(clear, req); break;
    case 'req-family': {
      if (!req) return;
      let pl = t.players.find(x => x.id === reqRow.querySelector('.req-player').value);
      if (!pl) { pl = { id: uid(), name: '', contacts: [] }; t.players.push(pl); }
      (pl.contacts ||= []).push({ id: uid(), rel: '', name: req.name || '', email: req.email });
      settle(clear, req); break;
    }
    case 'req-deny': if (req) settle(fromAttempt ? cloudBackend.removeAttempt : cloudBackend.denyRequest, req); return;
    case 'tasks': closeTeamMgr(); setCurrentTeam(t.id); openTasks(); return; // one panel at a time: the team manager closes first
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
  try { await cloudBackend.resolveFeedback(f.teamId || teamFor(f.pid), f.pid, f.fid, !f.resolved); } catch (err) { alert(`Couldn't update: ${err?.message || err}`); }
});

let notesOpenFor = null;  // drill id whose notes editor is expanded in the list
let editingDrill = null;  // drill id being renamed inline (explicit edit mode: ✎ → save/cancel)

/**
 * A drill copied into another practice (from the library, or by duplicating a practice) keeps its intro, voice-over
 * and uploaded video. Clips and videos live under their practice, so the bytes are copied to the new practice's keys
 * on this device and in the cloud — in the background; until each is up its row says so, and Upload now retries.
 */
function markAssetsPending(d) {
  for (const k of ['intro', 'narration', 'coachnote', 'boardAudio', 'upload']) if (d[k]) d[k] = { ...d[k], cloud: false, cloudError: 'copying from the original…' };
}
async function copyDrillAssets(srcPid, src, dstPid, dst) {
  const owner = ownerFor();
  const settle = (k, up) => { if (!dst[k]) return; dst[k] = { ...dst[k], cloud: up.ok }; if (up.error) dst[k].cloudError = up.error; else delete dst[k].cloudError; store.save(); renderPlan(); };
  const missing = { ok: false, error: 'no copy of the original on this device or in the cloud' };
  for (const kind of ['intro', 'narration', 'coachnote', 'boardAudio']) {
    if (!src[kind] || !dst[kind]) continue;
    let rec = null;
    try { rec = await idbGetClip(keyFor(owner, srcPid, src, kind)); } catch { rec = null; }
    if (!rec?.blob && cloudBackend?.loadClip && cloudSync?.user) {
      try { const c = await cloudBackend.loadClip(teamFor(srcPid), srcPid, clipDocId(src.id, kind)); if (c?.data) rec = { mime: c.mime, blob: base64ToBlob(c.data, c.mime), secs: c.secs }; } catch { rec = null; }
    }
    if (!rec?.blob) { settle(kind, missing); continue; }
    try { await idbPutClip(keyFor(owner, dstPid, dst, kind), rec); } catch { /* the cloud copy still serves this device */ }
    settle(kind, await uploadClip(dstPid, clipDocId(dst.id, kind), rec));
  }
  if (src.upload && dst.upload) {
    let rec = null;
    try { rec = await idbGetClip(videoKey(owner, srcPid, src)); } catch { rec = null; }
    if (!rec?.blob && cloudBackend?.loadVideo && cloudSync?.user) {
      try { const chunks = await cloudBackend.loadVideo(teamFor(srcPid), srcPid, src.id, src.upload.at, src.upload.chunks); rec = { mime: src.upload.mime, blob: chunksToBlob(chunks, src.upload.mime), secs: src.upload.secs }; } catch { rec = null; }
    }
    if (!rec?.blob) { settle('upload', missing); return; }
    try { await idbPutClip(videoKey(owner, dstPid, dst), rec); } catch { /* fine */ }
    const { mime, secs, size, width, height } = dst.upload;
    settle('upload', await uploadVideo(dstPid, dst, rec.blob, { mime, secs, size, width, height }, dst.upload.at));
  }
}
/** Put a clip in the cloud beside its practice. Resolves { ok, error? }; ok is false when signed out or refused. */
async function uploadClip(pid, did, { mime, blob, secs }) {
  if (!cloudBackend?.saveClip) return { ok: false, error: 'local-only (no cloud configured)' };
  if (!cloudSync?.user) return { ok: false, error: 'not signed in' };
  try { await cloudBackend.saveClip(teamFor(pid), pid, did, { mime, data: await blobToBase64(blob), secs, at: Date.now() }); return { ok: true }; }
  catch (e) { return { ok: false, error: e?.message || String(e) }; }
}
/** After sign-in: any clip recorded while offline or refused by the rules is uploaded from this device's copy. */
async function uploadPendingIntros() {
  if (!cloudBackend?.saveClip || !cloudSync?.user) return;
  for (const p of store.data.practices) for (const d of p.drills) for (const kind of ['intro', 'narration', 'coachnote', 'boardAudio']) {
    if (!d[kind] || d[kind].cloud === true) continue;
    let rec = null;
    try { rec = await idbGetClip(keyFor(ownerFor(), p.id, d, kind)); } catch { rec = null; }
    if (!rec?.blob) continue; // recorded on another device: nothing here to send
    const up = await uploadClip(p.id, clipDocId(d.id, kind), rec);
    if (up.ok) { d[kind] = { ...d[kind], cloud: true }; delete d[kind].cloudError; store.save(); }
  }
  renderPlan();
}
const cloudHint = err => /permission|insufficient/i.test(err || '') ? ' — deploy the latest firestore.rules, then Upload now' : '';
let videoOpenFor = null; // drill whose 🎬 video row is open in the Drills panel
let vidPending = null;   // a dropped file being prepared: { drillId, file, url, duration, width, height, audio, vo, voSecs, voFit: 'post'|'pre', voRec, voTimer, encoding, error }
/** The span a staged video will keep: [start, end) clipped to the file. */
function trimSpan(vp) {
  const dur = Number.isFinite(vp.duration) ? vp.duration : Infinity;
  const start = Math.min(Math.max(0, +vp.start || 0), Number.isFinite(dur) ? Math.max(0, dur - 0.5) : Infinity);
  const end = Math.min(Number.isFinite(vp.end) ? vp.end : dur, dur);
  return { start, end: Math.max(start + 0.5, end) };
}
/** Seconds of picture a staged video will keep (the trimmed span), or NaN while the length is unknown. */
function keptSecs(vp) {
  const { start, end } = trimSpan(vp);
  const keep = Number.isFinite(end) ? end - start : NaN;
  return Number.isFinite(keep) ? keep : NaN;
}
/** How far a recorded voiceover runs past the picture (0 when it fits). */
const voOverrun = vp => vp.audio === 'vo' && vp.vo && Number.isFinite(keptSecs(vp)) ? Math.max(0, vp.voSecs - keptSecs(vp)) : 0;
const estimateMB = vp => estimateVideoMB(keptSecs(vp), voOverrun(vp));
function trimSummary(vp) {
  const { start, end } = trimSpan(vp);
  const keep = Number.isFinite(end) ? end - start : NaN;
  const kept = keptSecs(vp), over = voOverrun(vp);
  const trimmed = Number.isFinite(vp.duration) && Number.isFinite(keep) && keep < vp.duration - 0.05;
  return `${trimmed ? `Keeps ${fmtSecs(kept)} of ${fmtSecs(vp.duration)}` : fmtSecs(vp.duration)}${over > 0.25 ? ` + ${fmtSecs(over)} of held frame (voice runs longer)` : ''} · ${vp.width}×${vp.height} → ${Math.min(vp.width, VIDEO_MAX_WIDTH)} px wide${Number.isFinite(kept) ? `, about ${estimateMB(vp).toFixed(1)} MB` : ''}`;
}
const sizeWarning = mb => mb > VIDEO_WARN_MB ? `<div class="intro-warn warn small">⚠ ${mb.toFixed(1)} MB is a big clip — every coach's phone downloads it once, and it counts against the free Firestore quota. Trim the video or keep the voiceover shorter if you can.</div>` : '';
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
  clearTimeout(vp.leadTimer);
  if (vp.dubAudio) { vp.dubAudio.pause(); URL.revokeObjectURL(vp.dubAudio.src); vp.dubAudio = null; }
  if (preview) { preview.onended = null; preview.ontimeupdate = null; preview.onpause = null; preview.pause(); preview.muted = false; }
}
const unfocusList = () => { if (document.activeElement?.closest('#drill-list')) document.activeElement.blur(); };
async function uploadVideo(pid, d, blob, meta, at) {
  if (!cloudBackend?.saveVideo) return { ok: false, error: 'local-only (no cloud configured)' };
  if (!cloudSync?.user) return { ok: false, error: 'not signed in' };
  try { await cloudBackend.saveVideo(teamFor(pid), pid, d.id, at, await blobToChunks(blob), meta); return { ok: true }; }
  catch (e) { return { ok: false, error: e?.message || String(e) }; }
}
async function videoAction(act, li) {
  const d = store.practice.drills.find(x => x.id === videoOpenFor); if (!d) return;
  unfocusList();
  const pid = store.practice.id;
  const vp = vidPending?.drillId === d.id ? vidPending : null;
  if (act === 'pick') { li.querySelector('.vid-file')?.click(); return; }
  if (act === 'close') { videoOpenFor = null; renderPlan(); return; }
  if ((act === 'setstart' || act === 'setend') && vp) {
    const t = li.querySelector('.vid-preview')?.currentTime || 0;
    if (act === 'setstart') { vp.start = Math.round(t * 10) / 10; if (Number.isFinite(vp.end) && vp.end <= vp.start + 0.5) vp.end = NaN; }
    else { vp.end = Math.round(t * 10) / 10; if (vp.end <= (+vp.start || 0) + 0.5) vp.start = Math.max(0, vp.end - 0.5); }
    renderPlan(); return;
  }
  if (vp?.previewing && act !== 'vopreview') stopDubPreview(vp, li.querySelector('.vid-preview'));
  if (act === 'cancel') { clearInterval(vp?.voTimer); if (vp?.voRec) { try { await vp.voRec.stop(); } catch { /* fine */ } } if (vp?.url) URL.revokeObjectURL(vp.url); vidPending = null; renderPlan(); return; }
  if (act === 'vorec' && vp) { // talk over the video: it plays silently from the top while the mic records — and keeps recording after the picture ends
    try { vp.voRec = await startRecording(); } catch (e) { vp.error = `Microphone not available: ${e?.message || e}`; renderPlan(); return; }
    vp.voPastEnd = false;
    renderPlan(); // the row now shows ■ Stop — play the (re-drawn) preview silently from the top
    const preview = $('#video-pane .vid-preview'); if (!preview) return;
    const span = trimSpan(vp);
    const kept = keptSecs(vp);
    preview.muted = true; preview.currentTime = span.start;
    const pictureOver = () => { preview.ontimeupdate = null; preview.onended = null; preview.pause(); vp.voPastEnd = true; };
    preview.onended = pictureOver;
    preview.ontimeupdate = () => { if (preview.currentTime >= span.end || (Number.isFinite(kept) && preview.currentTime - span.start >= kept)) pictureOver(); };
    preview.play().catch(() => {});
    clearInterval(vp.voTimer);
    vp.voTimer = setInterval(() => { // live readout: seconds, and once the picture is over, how the extra audio will be fitted
      const r = vp.voRec; if (!r) { clearInterval(vp.voTimer); return; }
      const t = (performance.now() - r.since) / 1000;
      const b = $('#drill-list [data-vact="vostop"]'); if (b) b.textContent = `■ Stop (${t.toFixed(0)} s)`;
      const st = $('#drill-list .vo-status'); if (!st) return;
      if (!vp.voPastEnd) { st.textContent = '● Recording — the video is playing silently, talk over it'; return; }
      const over = Number.isFinite(kept) ? Math.max(0, t - kept) : 0;
      const mb = estimateVideoMB(kept, over);
      st.innerHTML = `● Still recording — the picture has ended; ${(vp.voFit || 'post') === 'pre' ? 'the first' : 'the last'} frame will hold for the extra ${fmtSecs(over)}${mb > VIDEO_WARN_MB ? ` <span class="warn">⚠ about ${mb.toFixed(1)} MB</span>` : ''}`;
    }, 250);
    return;
  }
  if (act === 'vopreview' && vp?.vo) { // hear the dub before encoding: the muted video and the recording run together from the in point
    const preview = li.querySelector('.vid-preview'); if (!preview) return;
    if (vp.previewing) { stopDubPreview(vp, preview); renderPlan(); return; }
    const span = trimSpan(vp);
    const lead = vp.voFit === 'pre' ? voOverrun(vp) : 0; // 'pre': the picture waits on its first frame until the voice has caught up
    vp.dubAudio = new Audio(URL.createObjectURL(vp.vo));
    vp.previewing = true;
    renderPlan();
    const pv = $('#video-pane .vid-preview'); if (!pv) return;
    pv.muted = true; pv.currentTime = span.start;
    const stop = () => { stopDubPreview(vp, pv); renderPlan(); };
    let vidDone = false, audDone = false;
    const maybeDone = () => { if (vidDone && audDone) stop(); };
    pv.onended = () => { vidDone = true; maybeDone(); };
    pv.ontimeupdate = () => { if (!vidDone && pv.currentTime >= span.end) { vidDone = true; pv.pause(); maybeDone(); } }; // 'post': hold the last frame while the voice finishes
    pv.onpause = () => { if (vp.previewing && !vidDone && !pv.ended && pv.currentTime < span.end) stop(); }; // the user pressed pause on the player
    vp.dubAudio.onended = () => { audDone = true; maybeDone(); };
    if (lead) vp.leadTimer = setTimeout(() => { if (vp.previewing) pv.play().catch(() => {}); }, lead * 1000);
    else await pv.play().catch(() => {});
    vp.dubAudio.play().catch(() => {});
    return;
  }
  if (act === 'vostop' && vp?.voRec) {
    const r = vp.voRec; vp.voRec = null; clearInterval(vp.voTimer); vp.voTimer = null;
    const preview = $('#video-pane .vid-preview'); if (preview) { preview.pause(); preview.onended = null; preview.ontimeupdate = null; preview.muted = false; }
    const { blob, secs } = await r.stop();
    if (blob.size && secs >= 0.5) { vp.vo = blob; vp.voSecs = secs; vp.audio = 'vo'; vp.voFit = vp.voFit || 'post'; }
    renderPlan();
    return;
  }
  if (act === 'encode' && vp && !vp.encoding) {
    vp.encoding = true; renderPlan();
    const progress = msg => { const el = $('#video-pane .vid-progress'); if (el) el.textContent = msg; };
    try {
      const span = trimSpan(vp);
      const out = await transcodeVideo(vp.file, { voiceover: vp.audio === 'vo' ? vp.vo : null, voiceoverFit: vp.voFit || 'post', start: span.start, end: Number.isFinite(span.end) ? span.end : null, onProgress: (t, total) => progress(`Encoding… ${t.toFixed(0)}${Number.isFinite(total) ? ` / ${total.toFixed(0)}` : ''} s`) });
      const at = Date.now();
      const meta = { mime: out.mime, secs: out.secs, size: out.blob.size, width: out.width, height: out.height };
      const poster = await capturePoster(out.blob).catch(() => null);
      try { await idbPutClip(clipKey(`video:${ownerFor()}`, pid, d.id, at), { mime: out.mime, blob: out.blob, secs: out.secs }); } catch { /* the cloud copy still serves this device */ }
      progress(`Uploading ${(out.blob.size / 1048576).toFixed(1)} MB…`);
      const up = await uploadVideo(pid, d, out.blob, meta, at);
      const old = d.upload;
      if (old?.cloud && cloudBackend?.removeVideo && cloudSync?.user) cloudBackend.removeVideo(teamFor(pid), pid, d.id, old.at, old.chunks).catch(() => {});
      if (old) { const k = videoKey(ownerFor(), pid, d); forgetClip(k); idbDelClip(k).catch(() => {}); }
      commit(() => { d.upload = { at, ...meta, ...(poster ? { poster } : {}), chunks: Math.ceil(out.blob.size / 700_000), cloud: up.ok, ...(up.error ? { cloudError: up.error } : {}) }; });
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
    if (old.cloud && cloudBackend?.removeVideo && cloudSync?.user) cloudBackend.removeVideo(teamFor(pid), pid, d.id, old.at, old.chunks).catch(() => {});
    const k = videoKey(ownerFor(), pid, d); forgetClip(k); idbDelClip(k).catch(() => {});
    commit(() => { delete d.upload; });
    renderPlan();
  }
}
/** The size warning for an intro clip: getting big, or already too big for its single cloud document. */
function clipSizeWarning(bytes) {
  if (!(bytes > CLIP_WARN_BYTES)) return '';
  if (bytes > CLIP_CLOUD_MAX_BYTES) return `⚠ ${fmtKB(bytes)} is too big for the cloud copy (${fmtKB(CLIP_CLOUD_MAX_BYTES)} at most) — coaches won’t get it. Stop and record a shorter intro.`;
  return `⚠ Getting big: ${fmtKB(bytes)} of the ${fmtKB(CLIP_CLOUD_MAX_BYTES)} the cloud copy can hold.`;
}
let introOpenFor = null; // drill whose 🎙 recorder is open in the Drills panel
let introRec = null;      // an in-progress recording: { drillId, stop(), since, timer }
/** The recorder row's buttons: record / stop / listen / delete a drill's intro clip. */
let cnRec = null, cnPlaying = null;
/** Coach-only audio note on a drill: recorded like an intro, stored as the drill's 'coachnote' clip. */
async function coachNoteAction(act) {
  const d = store.practice.drills.find(x => x.id === notesOpenFor); if (!d) return;
  const pid = store.practice.id;
  const key = keyFor(ownerFor(), pid, d, 'coachnote');
  if (act === 'cnrec') {
    if (cnRec) return;
    try { cnRec = await startRecording(); } catch (e) { alert(`Microphone not available: ${e?.message || e}`); return; }
    cnRec.drillId = d.id; renderPlan();
  } else if (act === 'cnstop') {
    if (!cnRec) return;
    const r = cnRec; cnRec = null;
    const { blob, mime, secs } = await r.stop();
    if (!blob.size || secs < 0.5) { renderPlan(); return; }
    const at = Date.now();
    forgetClip(key); idbDelClip(key).catch(() => {});
    try { await idbPutClip(clipKey(ownerFor(), pid, clipDocId(d.id, 'coachnote'), at), { mime, blob, secs }); } catch { /* the cloud copy still serves this device */ }
    const up = await uploadClip(pid, clipDocId(d.id, 'coachnote'), { mime, blob, secs });
    commit(() => { d.coachnote = { secs, mime, size: blob.size, at, cloud: up.ok, ...(up.error ? { cloudError: up.error } : {}) }; });
    renderPlan();
  } else if (act === 'cnplay') {
    if (cnPlaying) { cnPlaying.stop(); cnPlaying = null; renderPlan(); return; }
    if (clipFetching) return;
    if (!clipMem.has(key)) { clipFetching = { drillId: d.id, kind: 'coachnote' }; renderPlan(); }
    const entry = await fetchClip(ownerFor(), pid, d, 'coachnote');
    clipFetching = null;
    if (!entry) { renderPlan(); return; }
    cnPlaying = playClip(entry, { onEnd: () => { cnPlaying = null; renderPlan(); } });
    renderPlan();
  } else if (act === 'cndel') {
    forgetClip(key); idbDelClip(key).catch(() => {});
    if (cloudBackend?.removeClip && cloudSync?.user) cloudBackend.removeClip(teamFor(pid), pid, clipDocId(d.id, 'coachnote')).catch(() => {});
    commit(() => { delete d.coachnote; });
    renderPlan();
  }
}

async function introAction(iact, li) {
  const d = store.practice.drills.find(x => x.id === introOpenFor); if (!d) return;
  const pid = store.practice.id, key = keyFor(ownerFor(), pid, d); // the current recording's copy on this device
  const status = msg => { const el = $('#drill-list .intro-status'); if (el) el.textContent = msg; };
  if (iact === 'rec') {
    if (introRec) return;
    try { introRec = await startRecording(); }
    catch (e) { status(`Microphone not available: ${e?.message || e}`); return; }
    introRec.drillId = d.id;
    renderPlan();
    introRec.timer = setInterval(() => { // no length cap: the readout warns as the clip nears what one cloud document can hold
      const t = (performance.now() - introRec.since) / 1000, bytes = introRec.size();
      const b = $('#drill-list [data-iact="stop"]'); if (b) b.textContent = `■ Stop (${t.toFixed(0)} s · ${fmtKB(bytes)})`;
      const w = $('#drill-list .intro-size-warn'); if (w) { const msg = clipSizeWarning(bytes); w.innerHTML = msg; w.hidden = !msg; }
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
    if (clipFetching) return;
    if (!clipMem.has(key)) { clipFetching = { drillId: d.id, kind: 'intro' }; renderPlan(); } // not in memory yet: show the download while IndexedDB / the cloud answers
    const entry = await fetchClip(ownerFor(), pid, d);
    clipFetching = null;
    if (!entry) { renderPlan(); status('No clip available on this device.'); return; }
    introPlaying = playClip(entry, { onEnd: () => { introPlaying = null; renderPlan(); } });
    introPlaying.drillId = d.id;
    renderPlan();
  } else if (iact === 'del') {
    forgetClip(key);
    idbDelClip(key).catch(() => {});
    if (cloudBackend?.removeClip && cloudSync?.user) cloudBackend.removeClip(teamFor(pid), pid, d.id).catch(() => {});
    commit(() => { delete d.intro; });
    renderPlan();
  } else if (iact === 'script') { // ✨ a script to read while recording, pitched at the players' age and sized for the length
    if (scriptBusy) return;
    if (!aiKey) { scriptStatus = '✗ Set up the Claude key under ⚙ Settings first.'; renderPlan(); return; }
    const age = +d.introAge || 7, secs = +d.introSecs || 30;
    scriptBusy = d.id; scriptStatus = 'Asking Claude for a script…'; renderPlan();
    try {
      if (!sdkModule) sdkModule = await import(SDK_URL);
      const { text, usage } = await generateIntroScript({ sdk: sdkModule, apiKey: aiKey, brief: drillBrief(d, { game: isGame(store.practice) }), age, secs, game: isGame(store.practice) });
      commit(() => { d.introScript = text; d.introAge = age; d.introSecs = secs; });
      scriptStatus = `✓ About ${text.split(/\s+/).filter(Boolean).length} words for ${secs} s at age ${age}${usage ? ` · ${usage.input_tokens + usage.output_tokens} tokens` : ''}. Edit it as you like, then press ● Record and read it.`;
    } catch (e) {
      scriptStatus = `✗ ${e?.status === 401 ? 'Anthropic rejected the API key — check it under ⚙ Settings.' : e?.status === 429 ? 'Rate limited by Anthropic — try again in a moment.' : (e?.message || String(e))}`;
    }
    scriptBusy = null; renderPlan();
  } else if (iact === 'nrec') { // voice over the animation: the drill plays from the top (cues captioned, not spoken) while the mic records
    if (anim.recNarr || introRec) return;
    if (store.drill !== d) { store.drillIndex = store.practice.drills.indexOf(d); renderAll(); }
    if (totalDuration() <= 0) { status('Nothing moves in this drill yet — add paths first, or record an intro instead.'); return; }
    let r = null;
    try { r = await startRecording(); } catch (e) { status(`Microphone not available: ${e?.message || e}`); return; }
    stopAnim(); finishActive(); if (sel) select(null);
    anim.recNarr = { rec: r, drillId: d.id };
    anim.fresh = true; anim.playing = true; anim.last = performance.now(); anim.raf = requestAnimationFrame(tick);
    renderPlan(); renderAnimBar();
    anim.recNarr.timer = setInterval(() => {
      const t = (performance.now() - r.since) / 1000, bytes = r.size();
      const b = $('#drill-list [data-iact="nstop"]'); if (b) b.textContent = `■ Stop (${t.toFixed(0)} s · ${fmtKB(bytes)})`;
      const w = $('#drill-list .narr-size-warn'); if (w) { const msg = clipSizeWarning(bytes); w.innerHTML = msg; w.hidden = !msg; }
      const st = $('#drill-list .narr-status'); if (st) st.textContent = anim.playing ? `● Recording — talk over the ${itemNoun(store.practice)} as it plays` : `● Still recording — the ${itemNoun(store.practice)} has finished; keep talking or press Stop`;
    }, 250);
  } else if (iact === 'nstop') {
    const rn = anim.recNarr; if (!rn) return;
    anim.recNarr = null; clearInterval(rn.timer);
    const speed = drillSpeed();
    anim.playing = false; cancelAnimationFrame(anim.raf); anim.t = 0; narrator.clear(); renderCanvas(); renderAnimBar();
    const { blob, mime, secs } = await rn.rec.stop();
    if (!blob.size || secs < 0.5) { renderPlan(); status('Nothing recorded.'); return; }
    const at = Date.now();
    const oldKey = keyFor(ownerFor(), pid, d, 'narration'); forgetClip(oldKey); idbDelClip(oldKey).catch(() => {});
    const newKey = clipKey(ownerFor(), pid, clipDocId(d.id, 'narration'), at);
    try { await idbPutClip(newKey, { mime, blob, secs }); } catch { /* the cloud copy still serves this device */ }
    const up = await uploadClip(pid, clipDocId(d.id, 'narration'), { mime, blob, secs });
    commit(() => { d.narration = { secs, mime, size: blob.size, at, speed, cloud: up.ok, ...(up.error ? { cloudError: up.error } : {}) }; });
    primeNarration(ownerFor(), pid, d);
    renderPlan();
  } else if (iact === 'nplay') { // hear it: the drill plays from the top with the voice-over (the intro is skipped)
    if (store.drill !== d) { store.drillIndex = store.practice.drills.indexOf(d); renderAll(); }
    if (anim.playing || anim.narr) { stopAnim(); renderPlan(); return; }
    stopAnim(); anim.skipIntro = true; togglePlay(); renderPlan();
  } else if (iact === 'nupload') {
    status('Uploading…');
    let rec = null;
    try { rec = await idbGetClip(keyFor(ownerFor(), pid, d, 'narration')); } catch { rec = null; }
    if (!rec?.blob) { status('No recording on this device to upload — record it again here.'); return; }
    const up = await uploadClip(pid, clipDocId(d.id, 'narration'), rec);
    commit(() => { d.narration = { ...d.narration, cloud: up.ok }; if (up.error) d.narration.cloudError = up.error; else delete d.narration.cloudError; });
    renderPlan();
  } else if (iact === 'ndel') {
    if (store.drill === d) stopNarration();
    commit(() => deleteNarration(d));
    renderPlan();
  }
}
/** Drop a drill's voice-over everywhere: memory, this device, the cloud, and the drill itself. */
function deleteNarration(d) {
  const pid = store.practice.id, key = keyFor(ownerFor(), pid, d, 'narration');
  forgetClip(key); idbDelClip(key).catch(() => {});
  if (cloudBackend?.removeClip && cloudSync?.user) cloudBackend.removeClip(teamFor(pid), pid, clipDocId(d.id, 'narration')).catch(() => {});
  delete d.narration;
}
// ---------- ✨ Claude: the API key (encrypted in the cloud, unlocked per device) and "describe a coaching point" ----------
// js/ai.js does the crypto, the schema and the conversion; this is the UI and the key's life cycle.
const AI_REC_KEY = 'hpp.ai.enc', AI_KEY_KEY = 'hpp.ai.key', AI_REMEMBER_KEY = 'hpp.ai.remember';
let aiRecord = null;    // the encrypted record { salt, iv, data … } from the cloud (mirrored in localStorage so a device can unlock offline)
let aiKey = null;       // the unlocked key, in memory (and on this device when "keep unlocked" is on)
let aiRecordLoaded = false, aiBusy = '';
let aiOpen = false;     // the ✨ Describe row is open in the Drills panel
let aiPrompt = '', aiStatus = '', aiGenerating = false, aiAbort = null;
let sdkModule = null;   // the Anthropic SDK, imported on first use
const aiRemember = () => { try { return localStorage.getItem(AI_REMEMBER_KEY) !== '0'; } catch { return true; } };
try { aiRecord = JSON.parse(localStorage.getItem(AI_REC_KEY) || 'null'); if (aiRemember()) aiKey = localStorage.getItem(AI_KEY_KEY) || null; } catch { /* storage blocked */ }
const rememberKey = () => { try { if (aiKey && aiRemember()) localStorage.setItem(AI_KEY_KEY, aiKey); else localStorage.removeItem(AI_KEY_KEY); } catch { /* fine */ } };
/** After sign-in: fetch the encrypted record (the cloud wins over this device's mirror). */
async function loadAIRecord() {
  if (aiRecordLoaded || !cloudBackend?.loadPrivate || !cloudSync?.user) return;
  aiRecordLoaded = true;
  try {
    const rec = await cloudBackend.loadPrivate(cloudSync.user.uid, 'anthropic');
    if (rec?.data) { aiRecord = rec; try { localStorage.setItem(AI_REC_KEY, JSON.stringify(rec)); } catch { /* fine */ } }
    else if (rec === null) { aiRecord = null; aiKey = null; try { localStorage.removeItem(AI_REC_KEY); localStorage.removeItem(AI_KEY_KEY); } catch { /* fine */ } } // removed on another device
  } catch { aiRecordLoaded = false; /* offline: keep the mirror */ }
  renderAIPop();
}
function renderAIPop() {
  const b = $('#btn-settings'); if (!b) return;
  b.classList.toggle('ready', !!aiKey);
  b.title = `Settings: your Claude API key (${aiKey ? 'ready' : aiRecord ? 'locked on this device' : 'not set up'}), editor and presentation preferences`;
  if ($('#settings').hidden) return;
  const st = $('#ai-status');
  st.classList.toggle('warn', !!aiBusy && /✗|⚠/.test(aiBusy));
  st.textContent = aiBusy || (aiKey ? `🔓 Unlocked on this device${aiRecord ? ' · ☁ encrypted copy in the cloud' : ' · not in the cloud'}${aiRecord?.at ? ` (saved ${stamp(aiRecord.at)})` : ''}` : aiRecord ? `🔒 An encrypted key is in the cloud${aiRecord.at ? ` (saved ${stamp(aiRecord.at)})` : ''} — enter the passphrase to use it here.` : cloudSync?.user ? 'No key yet. Paste your Anthropic API key and choose a passphrase.' : 'Sign in first — the encrypted key is kept under your account.');
  $('#ai-unlock').hidden = !aiRecord || !!aiKey;
  $('#ai-setup').open = !aiRecord && !aiKey;
  $('#ai-remember').checked = aiRemember();
  $('#ai-forget').hidden = !aiKey;
  $('#ai-remove').hidden = !aiRecord;
  $('#ai-save').disabled = !cloudSync?.user;
}
$('#ai-remember').addEventListener('change', e => { try { localStorage.setItem(AI_REMEMBER_KEY, e.target.checked ? '1' : '0'); } catch { /* fine */ } rememberKey(); });
$('#ai-save').addEventListener('click', async () => {
  const key = $('#ai-key').value.trim(), pass = $('#ai-pass').value;
  if (!looksLikeKey(key)) { aiBusy = '✗ That does not look like an Anthropic API key (they start with sk-ant-).'; renderAIPop(); return; }
  if (pass.length < 6) { aiBusy = '✗ Choose a passphrase of at least 6 characters.'; renderAIPop(); return; }
  if (!cloudSync?.user) { aiBusy = '✗ Sign in first.'; renderAIPop(); return; }
  aiBusy = 'Encrypting…'; renderAIPop();
  try {
    const rec = await encryptSecret(key, pass);
    await cloudBackend.savePrivate(cloudSync.user.uid, 'anthropic', rec);
    aiRecord = rec; aiKey = key; aiBusy = '';
    try { localStorage.setItem(AI_REC_KEY, JSON.stringify(rec)); } catch { /* fine */ }
    rememberKey();
    $('#ai-key').value = ''; $('#ai-pass').value = '';
  } catch (e) { aiBusy = `✗ Could not save: ${e?.message || e}${cloudHint(e?.message)}`; }
  renderAIPop(); renderPlan();
});
$('#ai-do-unlock').addEventListener('click', async () => {
  const pass = $('#ai-pass-unlock').value; if (!pass) return;
  aiBusy = 'Unlocking…'; renderAIPop();
  try { aiKey = await decryptSecret(aiRecord, pass); aiBusy = ''; rememberKey(); $('#ai-pass-unlock').value = ''; }
  catch (e) { aiBusy = `✗ ${e?.message || e}`; }
  renderAIPop(); renderPlan();
});
$('#ai-pass-unlock').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#ai-do-unlock').click(); } });
$('#ai-forget').addEventListener('click', () => { aiKey = null; try { localStorage.removeItem(AI_KEY_KEY); } catch { /* fine */ } aiBusy = ''; renderAIPop(); renderPlan(); });
$('#ai-remove').addEventListener('click', async () => {
  if (!confirm('Remove the encrypted key from the cloud and forget it on this device? Other devices lose it too once they sync.')) return;
  try { if (cloudBackend?.removePrivate && cloudSync?.user) await cloudBackend.removePrivate(cloudSync.user.uid, 'anthropic'); } catch (e) { aiBusy = `✗ Could not remove: ${e?.message || e}`; renderAIPop(); return; }
  aiRecord = null; aiKey = null; aiBusy = '';
  try { localStorage.removeItem(AI_REC_KEY); localStorage.removeItem(AI_KEY_KEY); } catch { /* fine */ }
  renderAIPop(); renderPlan();
});
/** The ✨ Describe row at the end of the Drills list. */
function aiEditorHTML(p) {
  if (!aiOpen) return '';
  const noun = itemNoun(p);
  return `<li class="ai-editor"><div class="intro-box">
      <div class="row vid-head"><span class="muted small">✨ Describe a ${noun} — Claude lays it out</span><button data-aiact="close" title="Close">✕</button></div>
      <textarea class="ai-prompt" placeholder="${escHtml(isGame(p) ? 'e.g. 2-on-1 rush from the divider: D backs in, F1 carries wide, F2 drives the far post for a pass and shot' : 'e.g. Half-ice 3-on-2 with a backchecker: F1 carries from the corner, D gap up, coach dumps a second puck in')}" ${aiGenerating ? 'disabled' : ''}>${escHtml(aiPrompt)}</textarea>
      <div class="row">${aiGenerating
        ? '<button data-aiact="cancel">■ Cancel</button>'
        : `<button data-aiact="generate" class="primary" ${aiKey ? '' : 'disabled'}>✨ Add as a new ${noun}</button>${aiKey ? '' : '<button data-aiact="setup">Set up the key first…</button>'}`}
      </div>
      <div class="ai-status muted small${/✗/.test(aiStatus) ? ' warn' : ''}">${escHtml(aiStatus || (isGame(p) ? 'The nets and the dividing boards are already in place; describe the situation and the players.' : 'Describe the drill: who, where, what happens. Ctrl+Enter generates.'))}</div>
    </div></li>`;
}
async function aiAction(act, li) {
  if (act === 'close') { if (aiAbort) aiAbort.abort(); aiOpen = false; aiStatus = ''; renderPlan(); return; }
  if (act === 'setup') { openSettings(); return; }
  if (act === 'cancel') { aiAbort?.abort(); return; }
  if (act !== 'generate' || aiGenerating) return;
  const p = store.practice;
  aiPrompt = li.querySelector('.ai-prompt')?.value.trim() || aiPrompt;
  if (!aiPrompt) { aiStatus = '✗ Describe the situation first.'; renderPlan(); return; }
  if (!aiKey) { aiStatus = '✗ Unlock or set up the API key under ✨ AI first.'; renderPlan(); return; }
  unfocusList();
  aiGenerating = true; aiStatus = 'Asking Claude…'; aiAbort = new AbortController(); renderPlan();
  try {
    if (!sdkModule) { aiStatus = 'Loading the Claude SDK…'; renderPlan(); sdkModule = await import(SDK_URL); aiStatus = 'Asking Claude…'; renderPlan(); }
    const draft = newDrill(p.drills.length + 1, p.kind); // a game's coaching point brings its nets and divider; Claude is told they are there
    const sys = systemPrompt({ game: isGame(p), dryland: isDryland(p), view: draft.view, existing: draft.objects.filter(o => o.type === 'net').map(o => ({ type: o.type, x: o.x, y: o.y, rot: o.rot })) });
    const { layout, usage } = await generateLayout({ sdk: sdkModule, apiKey: aiKey, prompt: aiPrompt, system: sys, signal: aiAbort.signal });
    const objects = layoutToObjects(layout, { uid, zoneColors: ZONE_COLORS });
    if (!objects.length) throw new Error('Claude returned an empty layout — try describing the players and where they start');
    draft.name = String(layout.name || draft.name).slice(0, 80);
    draft.notes = String(layout.notes || '');
    draft.objects = [...draft.objects, ...objects];
    migrateDrill(draft);
    finishActive();
    commit(() => { p.drills.push(draft); store.drillIndex = p.drills.length - 1; });
    sel = null; stopAnim();
    const cost = usage ? ` · ${usage.input_tokens + usage.output_tokens} tokens` : '';
    aiStatus = `✓ Added "${draft.name}" — ${objects.filter(o => o.type === 'skater').length} skaters, ${objects.filter(o => o.type === 'puck').length} pucks${cost}. Press ▶ to check the timing, then adjust anything on the ice.`;
    renderAll();
  } catch (e) {
    const msg = e?.name === 'AbortError' || /abort/i.test(e?.message || '') ? 'Cancelled.' : e?.status === 401 ? 'Anthropic rejected the API key — check it under ✨ AI.' : e?.status === 429 ? 'Rate limited by Anthropic — wait a moment and try again.' : e?.status === 400 && /credit|billing/i.test(e?.message || '') ? 'The Anthropic account has no credit — add some in the console.' : (e?.message || String(e));
    aiStatus = `✗ ${msg}`;
  }
  aiGenerating = false; aiAbort = null;
  renderPlan();
}
$('#btn-ai-drill').addEventListener('click', e => { e.stopPropagation(); aiOpen = !aiOpen; aiStatus = ''; renderPlan(); if (aiOpen) $('#drill-list .ai-prompt')?.focus(); });
$('#drill-list').addEventListener('input', e => { if (e.target.matches('.ai-prompt')) aiPrompt = e.target.value; });
$('#drill-list').addEventListener('keydown', e => { if (e.target.matches('.ai-prompt') && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiAction('generate', e.target.closest('li')); } });

// ----- the intro script: age and length set the pitch and size; ✨ writes it; the coach edits it and reads it while recording
let scriptBusy = null, scriptStatus = '';
function introScriptHTML(d, recording) {
  const age = +d.introAge || 7, secs = +d.introSecs || 30, busy = scriptBusy === d.id;
  return `<div class="row intro-script-row">
        <label class="check small">Age <input type="number" class="intro-age" min="4" max="18" step="1" value="${age}" ${busy ? 'disabled' : ''}></label>
        <label class="check small">Length <input type="number" class="intro-secs" min="10" max="300" step="5" value="${secs}" ${busy ? 'disabled' : ''}> s</label>
        <button data-iact="script" ${busy || recording ? 'disabled' : ''} title="${aiKey ? 'Claude writes a script for this intro from the drill and your notes — pitched at this age, sized for this length' : 'Set up the Claude key under ⚙ Settings first'}">${busy ? '… writing' : `✨ ${d.introScript ? 'Rewrite' : 'Write'} a script`}</button>
      </div>
      <textarea class="intro-script${recording ? ' reading' : ''}" rows="${recording ? 8 : 5}" placeholder="What you'll say — write it here, or let ✨ draft it from the drill and your notes, then read it while recording.">${escHtml(d.introScript || '')}</textarea>
      ${scriptStatus && (busy || scriptBusy === null) ? `<div class="intro-status muted small${/✗/.test(scriptStatus) ? ' warn' : ''}">${escHtml(scriptStatus)}</div>` : ''}`;
}
/** The voice-over section of a drill's 🎙 row: record over the animation, listen, upload, delete. */
function narrationHTML(d) {
  const n = d.narration, rec = anim.recNarr?.drillId === d.id, busy = !!introRec || (anim.recNarr && !rec);
  const moving = (d.objects || []).some(o => isPlayer(o) && o.path?.length);
  const playing = store.drill === d && (anim.narr || (anim.playing && n));
  const noun = itemNoun(store.practice);
  return `<hr class="intro-sep">
      <div class="narr-status muted small">${rec ? `● Recording — talk over the ${noun} as it plays` : n ? `Voice-over recorded · ${(+n.secs || 0).toFixed(1)} s${n.size ? ` · ${fmtKB(n.size)}` : ''} · at ${n.speed || 1}×${n.cloud === true ? ' · ☁ in the cloud' : ''}${canPlay(n.mime) ? '' : ' · this browser can’t play that format'}` : moving ? `No voice-over yet — talk over the ${noun} while it plays.` : `Voice-over: needs a ${noun} that moves (players with paths).`}</div>
      <div class="intro-warn warn small narr-size-warn"${(rec ? '' : clipSizeWarning(n?.size)) ? '' : ' hidden'}>${rec ? '' : clipSizeWarning(n?.size)}</div>
      ${n && !rec && n.cloud !== true ? `<div class="intro-warn warn small">⚠ ${n.cloud === false ? `Not in the cloud — coaches can’t hear it${n.cloudError ? ` (${escHtml(n.cloudError)}${cloudHint(n.cloudError)})` : ''}` : 'Cloud copy unknown'}</div>` : ''}
      <div class="row">
        ${rec ? '<button data-iact="nstop" class="danger">■ Stop</button>' : `<button data-iact="nrec" ${canRecord() && moving && !busy ? '' : 'disabled'}>● ${n ? 'Re-record' : 'Record'} over the ${noun}</button>`}
        <button data-iact="nplay" ${n && !rec && !busy ? '' : 'disabled'}>${playing ? '■ Stop' : '▶ Watch with voice'}</button>
        ${n && !rec && n.cloud !== true && cloudBackend?.saveClip ? '<button data-iact="nupload" class="primary">☁ Upload now</button>' : ''}
        <button data-iact="ndel" ${n && !rec ? '' : 'disabled'}>✕ Delete</button>
      </div>
      <p class="muted small">Recording plays the ${noun} from the top at its current speed (${drillSpeed()}×) with the mic open; keep talking after it finishes if you like. Plays back in sync whenever ▶ runs it. Changing the speed later deletes it.</p>`;
}
/** A small JPEG poster from the start of an encoded clip (null when the frame can't be read). */
function capturePoster(blob, at = 0.1) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = URL.createObjectURL(blob);
    let settled = false;
    const done = url => { if (settled) return; settled = true; URL.revokeObjectURL(v.src); resolve(url); };
    v.onerror = () => done(null);
    v.onloadeddata = () => { try { v.currentTime = Math.min(at, Math.max(0, (v.duration || 1) - 0.05)); } catch { done(null); } };
    v.onseeked = () => {
      try {
        const w = 320, h = Math.round(w * v.videoHeight / v.videoWidth) || 180;
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        done(c.toDataURL('image/jpeg', 0.6));
      } catch { done(null); }
    };
    setTimeout(() => done(null), 4000);
  });
}

/** The split-pane video manager that opens beside the rink (🎬 on a drill row): drop/trim/voice-over/encode, or a link. */
function videoPaneHTML(d, p) {
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
        ${vp.encoding || vp.voRec ? '' : sizeWarning(estimateMB(vp))}
        <div class="row">
          <label class="check small"><input type="radio" name="vidaudio" value="keep" ${vp.audio !== 'vo' ? 'checked' : ''} ${vp.encoding ? 'disabled' : ''}> keep its sound</label>
          <label class="check small"><input type="radio" name="vidaudio" value="vo" ${vp.audio === 'vo' ? 'checked' : ''} ${vp.encoding ? 'disabled' : ''}> my voice instead</label>
        </div>
        ${vp.audio === 'vo' && !vp.encoding ? `<div class="row">${vp.voRec
          ? '<button data-vact="vostop" class="danger">■ Stop</button><span class="vo-status muted small">● Recording — the video is playing silently, talk over it</span>'
          : `<button data-vact="vorec">● ${vp.vo ? 'Re-record' : 'Record'} voiceover</button>${vp.vo ? `<button data-vact="vopreview">${vp.previewing ? '■ Stop preview' : '▶ Preview with my voice'}</button>` : ''}<span class="muted small">${vp.vo ? `${vp.voSecs.toFixed(1)} s recorded${voOverrun(vp) > 0.25 ? ` — ${fmtSecs(voOverrun(vp))} longer than the picture` : ''}` : 'plays the video (silently) while you talk; keep talking after it ends if you like'}</span>`}</div>
        ${vp.vo && !vp.voRec && voOverrun(vp) > 0.25 ? `<div class="row vo-fit" title="Your voice runs longer than the picture. Neither is cut: choose which frame holds still for the extra time.">
          <span class="muted small">Extra voice</span>
          <label class="check small"><input type="radio" name="vofit" value="pre" ${vp.voFit === 'pre' ? 'checked' : ''}> before the video — hold the first frame</label>
          <label class="check small"><input type="radio" name="vofit" value="post" ${vp.voFit !== 'pre' ? 'checked' : ''}> after the video — hold the last frame</label>
        </div>` : ''}` : ''}
        <div class="row">${vp.encoding
          ? '<span class="vid-progress muted small">Starting the encoder…</span>'
          : `<button data-vact="encode" class="primary" ${vp.audio === 'vo' && !vp.vo ? 'disabled title="Record the voiceover first"' : ''}>⬆ Encode &amp; upload</button><button data-vact="cancel">Cancel</button>`}</div>`)
      : up
      ? `${up.poster ? `<img class="vid-poster" src="${up.poster}" alt="">` : ''}<div class="intro-status muted small">Uploaded video · ${fmtSecs(up.secs)} · ${(up.size / 1048576).toFixed(1)} MB · ${up.width}×${up.height}${up.cloud === true ? ' · ☁ in the cloud' : ''}</div>
        ${up.cloud !== true ? `<div class="intro-warn warn small">⚠ Not in the cloud — coaches can’t see it${up.cloudError ? ` (${escHtml(up.cloudError)}${cloudHint(up.cloudError)})` : ''}</div>` : ''}
        ${sizeWarning((+up.size || 0) / 1048576)}
        <div class="row"><button data-vact="play">▶ Watch</button>${up.cloud !== true && cloudBackend?.saveVideo ? '<button data-vact="upload" class="primary">☁ Upload now</button>' : ''}<button data-vact="del">✕ Delete video</button></div>
        <div class="vid-player"></div><div class="vid-progress muted small"></div>`
      : '';
    const dropHTML = vp ? '' : `<div class="vid-drop">📼 ${up ? 'Drop a new video here to replace it' : 'Drop a video here (any length — trim it or watch the size estimate below)'} or <button data-vact="pick">choose a file</button><input type="file" class="vid-file" accept="video/*,.mov,.mp4,.webm" hidden></div>`;
    return `<div class="intro-box">
      <div class="row vid-head"><span class="muted small">🎬 Video for “${escHtml(d.name)}” — plays beside the layout</span><span class="spacer"></span><button data-vact="close" title="Close the video pane">${icon('x')}</button></div>
      ${uploadHTML}${dropHTML}
      <div class="muted small vid-or">— or link one —</div>
      <input class="video-url" data-video="${d.id}" value="${escHtml(d.video || '')}" placeholder="Paste a YouTube, Vimeo or Cloudflare Stream link" spellcheck="false" autocomplete="off">
      <div class="intro-status muted small">${!d.video ? (up ? 'The uploaded video is what coaches see; a link here is used only when there is no upload.' : 'Coaches get a ▶ Watch video button on the drill; the diagram stays.') : v ? `${v.host} · ${escHtml(v.id)}${up ? ' (the upload above takes precedence)' : ''}` : '⚠ Not a link this app can embed — use a YouTube, Vimeo or Cloudflare Stream page link (or a direct .mp4 link).'}</div>
      ${v && !up ? videoPlayerHTML(v) : ''}
    </div>`;
}

/** Show or hide the video pane beside the canvas for the drill whose 🎬 row is open. */
function renderVideoPane() {
  const pane = $('#video-pane');
  const p = store.practice;
  const d = p.drills.find(x => x.id === videoOpenFor);
  pane.hidden = !d;
  document.body.classList.toggle('video-split', !!d);
  if (!d) { if (pane.innerHTML) { pane.innerHTML = ''; drawSelection(); } return; }
  if (pane.contains(document.activeElement) && document.activeElement.matches('input[type="number"], input[type="text"], input:not([type]), textarea')) return; // typing — don't clobber
  pane.innerHTML = videoPaneHTML(d, p);
  drawSelection(); // the canvas may have changed size
}

function renderPlan() {
  const p = store.practice;
  renderVideoPane();
  const total = activeDrills(p).reduce((a, d) => a + (+d.duration || 0), 0);
  const hiddenCount = p.drills.length - activeDrills(p).length;
  const startMin = parseStart(p), game = isGame(p);
  $('#plan-title').textContent = game ? 'Coaching points' : 'Drills';
  $('#btn-add-drill').textContent = game ? '+ Add coaching point' : '+ Add drill';
  $('#plan-total').textContent = game
    ? `${activeDrills(p).length} coaching point${activeDrills(p).length === 1 ? '' : 's'}${hiddenCount ? ` · ${hiddenCount} hidden` : ''}`
    : `${total} min total${startMin != null ? ` · ${clockFull(startMin)}–${clockFull(startMin + total)}` : ''}${hiddenCount ? ` · ${hiddenCount} hidden` : ''}`;
  $('#plan-total').title = game ? 'Game prep has no running clock — coaching points are read in order' : startMin != null ? 'Set the start time in + Practice to change the clock' : 'Set a start time in + Practice to see clock times on each drill';
  // running time: where each (unhidden) drill starts — as a clock time when the practice has one, else minutes in
  let running = 0;
  const startOf = new Map();
  for (const d of p.drills) { if (d.hidden) continue; startOf.set(d.id, running); running += +d.duration || 0; }
  const when = d => {
    if (d.hidden) return 'hidden';
    const co = d.audience === 'coaches' ? ' · coaches only' : '';
    if (game) return co.slice(3);
    const at = startOf.get(d.id);
    return `${+d.duration || 0} min · ${startMin != null ? `${clock(startMin + at)}–${clockFull(startMin + at + (+d.duration || 0))}` : `${at === 0 ? 'starts' : `+${at} min`}`}${co}`;
  };
  const fbCount = d => feedbackAll.filter(f => f.pid === p.id && f.drillId === d.id && !f.resolved).length;
  const list = $('#drill-list');
  // Someone typing in the list must not have their field rebuilt under them — but a focused radio, checkbox
  // or button is no reason to hold back (a click leaves those focused, and their change needs a redraw).
  if (list.contains(document.activeElement) && document.activeElement.matches('textarea, input:not([type]), input[type="text"], input[type="number"], input[type="search"]')) return;
  const btns = d => `
      <button data-act="hide" class="${d.hidden ? 'is-hidden' : d.audience === 'coaches' ? 'is-coaches' : ''}" title="${d.hidden ? 'Hidden from everyone: left out of the plan, print and the coaches’ view — click to show it again' : d.audience === 'coaches' ? 'Coaches only: on the coaches’ minute-by-minute agenda, left out of the team’s copy (their clock times stay right across the gap) — click to hide it from everyone' : 'Shown to everyone — click for coaches only (e.g. free play the team needn’t see), click again to hide it from everyone'}">${d.hidden ? icon('eyeoff') : d.audience === 'coaches' ? icon('coach') : icon('eye')}</button>
      <button data-act="video" class="${d.video || d.upload ? 'has-video' : ''}${videoOpenFor === d.id ? ' open' : ''}" title="Video for this drill — drop in a file (any length — it warns when the clip gets big; optionally with your own voice over it) or link YouTube / Vimeo / Cloudflare Stream">${icon('video')}</button>
      <button data-act="intro" class="${d.intro || d.narration ? 'has-intro' : ''}${introOpenFor === d.id ? ' open' : ''}" title="${d.intro || d.narration ? `Audio on this drill: ${[d.intro ? 'intro' : '', d.narration ? 'voice-over' : ''].filter(Boolean).join(' + ')}. ` : ''}Intro in your voice (played before the drill when ▶ is pressed) and a voice-over recorded over the animation — both recorded here">${icon('mic')}</button>
      <button data-act="notes" class="${(d.notes || '').trim() || (d.coachNotes || '').trim() || d.coachnote ? 'has-notes' : ''}${notesOpenFor === d.id ? ' open' : ''}" title="Coaching notes — including coach-only notes and audio">${icon('notes')}</button>
      <button data-act="sharedrill" title="Send just this drill: copies a link anyone can open — the other coach signs in with Google or anonymously. Press again after edits to update the shared copy.">${icon('send')}</button>
      <button data-act="del" title="Delete" ${p.drills.length === 1 ? 'disabled' : ''}>${icon('x')}</button>`;
  list.innerHTML = p.drills.map((d, i) => {
    const row = editingDrill === d.id
      ? `<li class="${i === store.drillIndex ? 'active ' : ''}editing" data-index="${i}">
          <span class="num">${i + 1}.</span>
          <input class="dname" value="${escHtml(d.name)}" title="${game ? 'Coaching point' : 'Drill'} name" spellcheck="false">
          <input class="dmin" type="number" min="0" step="1" value="${+d.duration || 0}" title="Minutes" ${game ? 'hidden' : ''}>
          <span class="dur" ${game ? 'hidden' : ''}>min</span>
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
      ? `<li class="notes-editor"><textarea data-notes="${i}" rows="3" placeholder="Notes / coaching points…">${escHtml(d.notes || '')}</textarea>
        <div class="coach-notes">
          <div class="muted small">👁 Coaches only — never in the team’s copy</div>
          <textarea data-coachnotes="${i}" rows="2" placeholder="Notes just for the coaches…">${escHtml(d.coachNotes || '')}</textarea>
          <div class="row">
            ${cnRec?.drillId === d.id ? '<button data-act="cnstop" class="danger">■ Stop recording</button>' : `<button data-act="cnrec">● ${d.coachnote ? 'Re-record' : 'Record'} audio</button>`}
            ${d.coachnote ? `<button data-act="cnplay" ${fetchingClip('coachnote', d) ? 'disabled' : ''}>${fetchingClip('coachnote', d) ? '… downloading' : cnPlaying ? '■ Stop' : `▶ Play (${Math.round(d.coachnote.secs)} s)`}</button><button data-act="cndel" title="Delete the audio note">${icon('x')}</button>` : ''}
            <span class="intro-status muted small">${d.coachnote && d.coachnote.cloud !== true ? '⚠ audio not in the cloud — coaches can’t hear it yet' : ''}</span>
          </div>
        </div></li>`
      : '';
    const recording = introRec?.drillId === d.id;
    const intro = introOpenFor === d.id ? `<li class="intro-editor"><div class="intro-box">
      <div class="intro-status muted small">${recording ? '● Recording — speak now' : d.intro ? `Intro recorded · ${(+d.intro.secs || 0).toFixed(1)} s${d.intro.size ? ` · ${Math.max(1, Math.round(d.intro.size / 1024))} KB` : ''}${d.intro.cloud === true ? ' · ☁ in the cloud' : ''}${canPlay(d.intro.mime) ? '' : ' · this browser can’t play that format'}` : canRecord() ? 'No intro yet — record yourself introducing this drill.' : 'This browser can’t record audio.'}</div>
      <div class="intro-warn warn small intro-size-warn"${(recording ? '' : clipSizeWarning(d.intro?.size)) ? '' : ' hidden'}>${recording ? '' : clipSizeWarning(d.intro?.size)}</div>
      ${d.intro && !recording && !phoneFriendly(d.intro.mime) ? `<div class="intro-warn warn small">⚠ Recorded in a format iPhones can’t play (${escHtml(d.intro.mime)}) — press Re-record; this version records one that plays everywhere.</div>` : ''}
      ${d.intro && !recording && d.intro.cloud !== true ? `<div class="intro-warn warn small">⚠ ${d.intro.cloud === false ? `Not in the cloud — coaches can’t hear it${d.intro.cloudError ? ` (${escHtml(d.intro.cloudError)}${cloudHint(d.intro.cloudError)})` : ''}` : 'Cloud copy unknown — recorded before this version'}</div>` : ''}
      ${introScriptHTML(d, recording)}
      <div class="row">
        ${recording ? '<button data-iact="stop" class="danger">■ Stop</button>' : `<button data-iact="rec" ${canRecord() ? '' : 'disabled'}>● ${d.intro ? 'Re-record' : 'Record'}</button>`}
        <button data-iact="play" ${d.intro && !recording && !fetchingClip('intro', d) ? '' : 'disabled'}>${fetchingClip('intro', d) ? '… downloading' : introPlaying?.drillId === d.id ? '■ Stop' : '▶ Listen'}</button>
        ${d.intro && !recording && d.intro.cloud !== true && cloudBackend?.saveClip ? '<button data-iact="upload" class="primary">☁ Upload now</button>' : ''}
        <button data-iact="del" ${d.intro && !recording ? '' : 'disabled'}>✕ Delete</button>
      </div>
      <p class="muted small">Plays in your voice before the drill whenever ▶ is pressed — here (unless 🔊 voice is muted in the editor) and always on the coaches’ phones. No length limit — it warns when a clip gets too big for the cloud.</p>
      ${narrationHTML(d)}
    </div></li>` : '';
    return row + notes + intro;
  }).join('') + aiEditorHTML(p);
}

// Drag to reorder drills (↑/↓ buttons remain for touch).
let dragDrill = null; // index being dragged
const clearDropMarks = () => $$('#drill-list li').forEach(li => li.classList.remove('dragging', 'drop-above', 'drop-below'));
$('#drill-list').addEventListener('dragstart', e => {
  const li = e.target.closest('li');
  if (!li || li.classList.contains('editing') || li.matches('.notes-editor, .intro-editor, .video-editor, .ai-editor')) { e.preventDefault(); return; }
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
  if (!li || li.matches('.notes-editor, .intro-editor, .video-editor, .ai-editor') || +li.dataset.index === dragDrill) return;
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
  if (!li || li.matches('.notes-editor, .intro-editor, .video-editor, .ai-editor')) return;
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
$('#drill-list').addEventListener('focusin', e => { if (e.target.matches('textarea:not(.ai-prompt)')) store.beginPending(); });
$('#video-pane').addEventListener('focusin', e => { if (e.target.matches('.video-url')) store.beginPending(); });
$('#video-pane').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (btn?.dataset.vact) { btn.blur(); videoAction(btn.dataset.vact, $('#video-pane')); }
});
$('#video-pane').addEventListener('dragover', e => { const z = e.target.closest('.vid-drop'); if (!z) return; e.preventDefault(); z.classList.add('over'); });
$('#video-pane').addEventListener('dragleave', e => { e.target.closest('.vid-drop')?.classList.remove('over'); });
$('#video-pane').addEventListener('drop', e => {
  const z = e.target.closest('.vid-drop'); if (!z) return;
  e.preventDefault(); z.classList.remove('over');
  const d = store.practice.drills.find(x => x.id === videoOpenFor); if (!d) return;
  stageVideoFile(d, e.dataTransfer?.files?.[0]);
});
$('#video-pane').addEventListener('change', e => {
  if (e.target.matches('.vid-file')) { const d = store.practice.drills.find(x => x.id === videoOpenFor); if (d) stageVideoFile(d, e.target.files?.[0]); }
  if (e.target.matches('input[name="vidaudio"]') && vidPending) { vidPending.audio = e.target.value; renderPlan(); }
  if (e.target.matches('input[name="vofit"]') && vidPending) { if (vidPending.previewing) stopDubPreview(vidPending, $('#video-pane .vid-preview')); vidPending.voFit = e.target.value; renderPlan(); }
  if (e.target.matches('.vid-in, .vid-out') && vidPending) { unfocusList(); renderPlan(); }
});
$('#video-pane').addEventListener('input', e => {
  if (!e.target.matches('.vid-in, .vid-out') || !vidPending) return;
  const v = e.target.value === '' ? NaN : +e.target.value;
  if (e.target.matches('.vid-in')) vidPending.start = Number.isFinite(v) ? Math.max(0, v) : 0; else vidPending.end = Number.isFinite(v) ? v : NaN;
  const sum = $('#video-pane .vid-summary'); if (sum) sum.textContent = trimSummary(vidPending);
});
$('#video-pane').addEventListener('input', e => {
  if (!e.target.matches('.video-url')) return;
  const d = store.practice.drills.find(x => x.id === e.target.dataset.video); if (!d) return;
  const v = e.target.value.trim();
  if (v) d.video = v; else delete d.video;
  store.save();
});
$('#video-pane').addEventListener('change', e => { if (e.target.matches('.video-url')) { store.commitPending(); e.target.blur(); renderPlan(); } }); // blur: the pane won't rebuild under a focused input
$('#video-pane').addEventListener('keydown', e => { if (e.target.matches('.video-url') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); renderPlan(); } });
$('#drill-list').addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.notes != null) {
    const d = store.practice.drills[+el.dataset.notes];
    if (d) { d.notes = el.value; store.save(); }
  }
  if (el.dataset.coachnotes != null) {
    const d = store.practice.drills[+el.dataset.coachnotes];
    if (d) { if (el.value.trim()) d.coachNotes = el.value; else delete d.coachNotes; store.save(); }
  }
  if (el.matches('.intro-script, .intro-age, .intro-secs')) {
    const d = store.practice.drills.find(x => x.id === introOpenFor); if (!d) return;
    if (el.matches('.intro-script')) d.introScript = el.value;
    else if (el.matches('.intro-age')) d.introAge = Math.max(4, Math.min(18, Math.round(+el.value || 7)));
    else d.introSecs = Math.max(10, Math.min(300, Math.round(+el.value || 30)));
    store.save();
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
  if (!li || li.classList.contains('editing') || li.matches('.notes-editor, .intro-editor, .video-editor, .ai-editor')) return;
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
  if (li.matches('.ai-editor')) { if (btn?.dataset.aiact) aiAction(btn.dataset.aiact, li); return; }
  if (li.matches('.notes-editor')) { if (btn?.dataset.act?.startsWith('cn')) coachNoteAction(btn.dataset.act); return; }
  if (act === 'video') { videoOpenFor = videoOpenFor === p.drills[i].id ? null : p.drills[i].id; notesOpenFor = null; introOpenFor = null; renderPlan(); if (videoOpenFor) $('#video-pane .video-url')?.focus(); return; }
  if (act === 'intro') { introOpenFor = introOpenFor === p.drills[i].id ? null : p.drills[i].id; notesOpenFor = null; videoOpenFor = null; renderPlan(); return; }
  if (act === 'feedback') { openFeedbackPanel(); return; }
  if (act === 'hide') { // cycle: everyone → coaches only → hidden from all → everyone
    const d = p.drills[i];
    commit(() => { if (d.hidden) { delete d.hidden; delete d.audience; } else if (d.audience === 'coaches') { delete d.audience; d.hidden = true; } else d.audience = 'coaches'; });
    renderAll(); return;
  }
  if (li.matches('.notes-editor, .intro-editor, .video-editor, .ai-editor')) return;
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
  if (act === 'sharedrill') { shareDrill(p.drills[i], btn); return; }
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
  const practices = [...store.live].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const cards = [];
  for (const p of practices) for (const d of p.drills || []) {
    if (q && !`${d.name} ${p.team || ''} ${p.date || ''} ${usDate(p.date)}`.toLowerCase().includes(q)) continue;
    const v = d.view || VIEWS.full;
    cards.push(`<div class="lib-card">
      <svg viewBox="${v.x} ${v.y} ${v.w} ${v.h}" preserveAspectRatio="xMidYMid meet">${rinkSVG(surfaceOf(p))}${renderObjects(d, null, { dryland: isDryland(p) })}</svg>
      ${hasVideo(d) ? `<span class="lib-video" title="This drill has a video">${icon('video')} video</span>` : ''}
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
  markAssetsPending(copy); // the recordings and uploaded video come along: copied in the background below
  copy.objects = cloneObjects(migrateDrill(copy).objects);
  const p = store.practice;
  commit(() => { p.drills.push(copy); store.drillIndex = p.drills.length - 1; });
  copyDrillAssets(pid, src, p.id, copy);
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
    ['backward', 'checkbox', 'Starts skating backward'], ['cross', 'select:=— no —,L=Crossovers, facing left,R=Crossovers, facing right', 'Side-steps to waypoint 1'], ['facing', 'number', 'Facing (°, blank = auto)'],
  ],
  coach: [['label', 'text', 'Label'], ['color', 'swatch', 'Color'], ['pad', 'checkbox', 'Tackle pad'], ['stick', 'checkbox', 'Stick'], ['speed', 'number', 'Speed (ft/s)'], ['delay', 'number', 'Start delay (s)'], ['facing', 'number', 'Facing (°, blank = auto)']],
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
  focus: [['w', 'number', 'Width (ft)'], ['h', 'number', 'Height (ft)'], ['dim', 'select:0.35=Light,0.55=Medium,0.8=Dark', 'Gray-out outside the box'],
    ['fade', 'select:0=Full,0.5=Lightened,0.75=Faint,1=Hidden', 'Ice markings inside the box']],
  zone: [['label', 'text', 'Title'], ['color', 'zoneswatch', 'Color'], ['w', 'number', 'Width (ft)'], ['h', 'number', 'Height (ft)'],
    ['constraints', 'textarea', 'Constraints — one per line. Drawn in the zone, listed under the drill, and read aloud in the viewer']],
  barricade: [],
  arrow: [['style', 'select:' + Object.entries(ARROW_STYLES).map(([k, v]) => `${k}=${v}`).join(','), 'Style'], ['color', 'color', 'Color'], ['width', 'number', 'Width (ft, blank = normal)']],
  text: [['text', 'text', 'Text'], ['size', 'number', 'Size'], ['color', 'color', 'Color']],
};
const TYPE_NAMES = { focus: 'Focus area', contact: 'Contact', skater: 'Skater', coach: 'Coach', cone: 'Cone', minicone: 'Small cone', raisedpad: 'Raised pad', jumppad: 'Jump pad', pile: 'Puck pile', tire: 'Tire', puck: 'Puck', net: 'Net', obstacle: 'Obstacle', zone: 'Zone', barricade: 'Barricade', arrow: 'Arrow / line', text: 'Text' };

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
        const flags = [pt.pivot === 'L' ? 'pivot ⟲' : pt.pivot ? 'pivot ⟳' : '', pt.cross === 'L' ? 'crossovers, facing left' : pt.cross === 'R' ? 'crossovers, facing right' : '', +pt.stop > 0 ? `stop ${+pt.stop}s` : ''].filter(Boolean).join(' · ');
        rows.push(`<div class="wp-item" data-wprow="${i}"><span class="wp-num">${i + 1}</span>${own ? xy(`data-wpx="${i}"`, `data-wpy="${i}"`, pt) : `<span class="wp-pos muted">(${Math.round(pt.x)}, ${Math.round(pt.y)})</span>`}<span class="wp-what muted">${flags}</span><span class="spacer"></span>
          ${o.type === 'skater' && own ? `<button class="wp-toggle ${pt.pivot ? 'active' : ''}" data-act="pivot" data-wp="${i}" title="Pivot at waypoint ${i + 1} (forward ⇄ backward) — click cycles: none → ⟲ face swings left → ⟳ face swings right">⇄</button><button class="wp-toggle ${pt.cross ? 'active' : ''}" data-act="cross" data-wp="${i}" title="Crossovers (side-steps) from waypoint ${i + 1} to the next: the body faces across the line of travel — click cycles: none → facing left → facing right">×</button><button class="wp-toggle ${+pt.stop > 0 ? 'active' : ''}" data-act="wpstop" data-wp="${i}" title="Full stop at waypoint ${i + 1} — a sharp turn, and everything downstream (passes, contacts) waits with them">⏸</button>` : ''}
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
    extra.push(`<button data-act="tidypath" ${hasPath && !o.follow ? '' : 'disabled'} title="Fit the drawn path to clean geometry: straight-ish runs become straight, loops and turns become even circular arcs. Waypoint flags (pivots, stops) are reset.">✨ Even out path</button>`);
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
    extra.push(`<button data-act="rot90" title="Quarter-turn the focus and everything inside it around its centre — or drag the round grip above it to rotate freely">Rotate 90°</button>`);
    extra.push(`<button data-act="fitdrill" title="Uniformly scale and centre everything in this drill so it fits inside the box">⇲ Resize drill into box</button>`);
    extra.push(`<p class="muted small">Everything outside ${o.points ? 'the shape' : 'the box'} is grayed out — on the ice, on the printed sheet and in the coaches’ view. Drag the dashed edge (or edit x/y, or nudge with arrow keys) to move it <b>with everything inside</b> — Alt-drag moves just the frame${o.points ? '; drag its corner handles to reshape' : ''}. Objects inside stay clickable.</p>`);
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

const EV_TYPES = { pass: 'Pass', shoot: 'Shoot', dump: 'Dump', pickup: 'Pickup' };

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
      const arrivesAt = rec?.ok && rec.to ? `<span class="muted" title="Where the pass arrives — drag the → marker on the ice along the receiver's path to change it">arrives at (${G.round1(rec.to.x)}, ${G.round1(rec.to.y)})${rec.impliedSpeed ? ` · puck ${Math.round(rec.impliedSpeed)} ft/s` : ''}</span>`
        + (rec.offBy > 2.5 ? `<span class="warn">⚠ the reflected pass misses ${playerName(rcv)} by ${Math.round(rec.offBy)} ft — move the bounce point or the release</span>` : '') : '';
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
    else if (ev.type === 'dump') {
      const bankUI = `<label class="check"><input type="checkbox" data-ev="${i}" data-evprop="bank" ${ev.bank ? 'checked' : ''}> off the boards</label>`
        + (ev.bank ? `<button data-act="bounce" data-ev="${i}" title="Click near the boards to set where the puck bounces (or drag the B marker on the ice)">Bounce point…</button>` : '');
      const tgt = ev.target
        ? `<span class="wp-pos"><input class="wp-xy" type="number" step="any" data-ev="${i}" data-evprop="tx" value="${G.round1(ev.target.x)}" title="x (ft)"><input class="wp-xy" type="number" step="any" data-ev="${i}" data-evprop="ty" value="${G.round1(ev.target.y)}" title="y (ft)"></span>`
        : '<span class="muted">the nearest corner</span>';
      body = `<span>${who}</span>${where()}<span>dumps it to</span>${tgt}<button data-act="pick" data-ev="${i}" title="Click a spot on the ice — a corner, along the boards, behind a barrier">Pick spot</button>${bankUI}${mark}
        <span class="muted small">It lies there until a player picks it up (+ Pickup) — at pass speed, and goalies pay it no mind.</span>`;
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
    <div class="row"><button data-act="addpass">+ Pass</button><button data-act="addshoot">+ Shoot</button><button data-act="adddump" title="Put the puck somewhere — a corner, the boards, behind a barrier — for someone to go and get">+ Dump</button><button data-act="addpickup">+ Pickup</button></div>
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
    if (el.tagName === 'SELECT' || el.type === 'checkbox') el.blur(); // let the following 'change' re-render the row (e.g. bank → receiver list gains “themselves”)
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
  if (o.type === 'focus' && (key === 'x' || key === 'y')) {
    const v = +el.value;
    if (Number.isFinite(v)) moveFocusBy(o, key === 'x' ? G.round1(v - o.x) : 0, key === 'y' ? G.round1(v - o.y) : 0);
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
    case 'tidypath': commit(() => { o.path = G.beautifyPath([{ x: o.x, y: o.y }, ...(o.path || [])]).slice(1); }); renderProps(); break;
    case 'extend': setTool('skater'); activeSkater = o.id; select(o.id); break;
    case 'focus': setView({ x: o.x - 2, y: o.y - 2, w: o.w + 4, h: o.h + 4 }); break;
    case 'readzone': readAloud([o.label || 'Zone', ...zoneLines(o)]); break;
    case 'rot90': commit(() => { if (o.type === 'focus') rotateFocus(o, 90); else o.rot = ((o.rot || 0) + 90) % 360; }); break;
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
    case 'cross': {
      const pt = o.path?.[+btn.dataset.wp]; if (!pt) break;
      // cycle: forward stride → crossovers facing left → facing right → forward stride
      commit(() => { if (!pt.cross) pt.cross = 'L'; else if (pt.cross === 'L') pt.cross = 'R'; else delete pt.cross; });
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
    case 'addpass': case 'addshoot': case 'adddump': case 'addpickup': {
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
      } else if (btn.dataset.act === 'adddump') {
        ev = { type: 'dump', wp, target: null }; // the nearest corner until a spot is picked
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
    case 'pick': pickTarget = { puckId: o.id, ev: evIndex, kind: 'target' }; $('#hint').textContent = o.events[evIndex]?.type === 'dump' ? 'Click the spot on the ice the puck is dumped to — a corner, the boards, behind a barrier (Esc to cancel)' : 'Click on the ice to set the shot target (Esc to cancel)'; break;
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
  const d = newDrill(p.drills.length + 1, p.kind);
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
  const srcPid = store.practice.id, pairs = [];
  copy.drills.forEach((d, i) => { d.id = uid(); markAssetsPending(d); d.objects = cloneObjects(d.objects); pairs.push([store.practice.drills[i], d]); });
  finishActive(); store.addPractice(copy); sel = null; stopAnim(); $('#practice-pop').hidden = true; renderAll();
  (async () => { for (const [s, d] of pairs) await copyDrillAssets(srcPid, s, copy.id, d); })(); // recordings and videos follow, one drill at a time
});
$('#btn-del-practice').addEventListener('click', () => {
  const p = store.practice;
  const shared = stageOf(p) !== 'draft';
  if (!confirm(`Delete ${docNoun(p)} "${practiceLabel(p)}"?${shared ? ' Coaches and the team lose access to it.' : ''}\n\nIt moves to Deleted at the bottom of the picker, where you can restore it or delete it for good.`)) return;
  finishActive(); store.trashPractice(p.id); sel = null; stopAnim(); renderAll();
});

$('#btn-export-json').addEventListener('click', () => { closePopovers(); $('#btn-export').click(); });
wirePopover('#btn-export-more', '#export-pop', '#btn-export-json');
wirePopover('#btn-present-more', '#present-pop', '#btn-present-coach');
wirePopover('#btn-print-more', '#print-pop', '#btn-print-page');
wirePopover('#btn-teams', '#team-pop', '#team-manage');
wirePopover('#btn-account', '#account-pop', '#btn-settings');
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
      p.id = uid(); p.drills.forEach(d => { d.id = uid(); delete d.intro; delete d.narration; delete d.upload; d.view = d.view || { ...VIEWS.full }; d.objects = cloneObjects(migrateDrill(d).objects); });
      finishActive(); store.addPractice(p); // each import is an edit, so it is auto-saved to the cloud too
    }
    sel = null; stopAnim(); renderAll();
  } catch (err) { alert('Import failed: ' + err.message); }
});

$('#btn-png').addEventListener('click', async () => {
  closePopovers(); // picked from the Export menu
  const d = drill();
  const svgStr = standaloneSVG(d, rinkSVG(surfaceOf(store.practice)), SVG_STYLE);
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

// The presentation side flips these editor flags; module imports are read-only bindings, so it goes through setters.
const setSel = v => { sel = v; };
const clearPickTarget = () => { pickTarget = null; };



// ---------- plugging into the viewer side ----------
// This module loads on demand (loadEditor in present.js); the viewer reaches it only through
// editorApi and the route hook, so nothing here is needed just to watch a practice.
Object.assign(editorApi, { anim, applyRoute, clearPickTarget, commit, finishActive, loadAIRecord, renderAll, renderFeedback, renderPlan, renderPracticeSelect, renderTeamMgr, setSel, stopAnim, togglePlay, uploadPendingIntros });
onEditorRoute(() => { finishActive(); applyRoute(); setSel(null); stopAnim(); renderAll(); });
setTool('select');
window.addEventListener('resize', drawSelection);
