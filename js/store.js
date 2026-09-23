// Persistent state: a library of practices, each with drills. Undo/redo for the current practice.
import { VIEWS, RINK } from './rink.js';
import { stageOf } from './access.js';

const KEY = 'hpp.v1';
const UNDO_LIMIT = 100;

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

/**
 * Two kinds of document share everything (drills, sharing, presentation): a practice, and a game — game-prep
 * material whose "drills" are coaching points. `kind` is absent on a practice; a game has kind 'game' and an opponent.
 */
export const isGame = p => p?.kind === 'game';
export const docNoun = p => (isGame(p) ? 'game' : 'practice');
export const itemNoun = p => (isGame(p) ? 'coaching point' : 'drill');
/** The document's name: the team, or for a game "Team vs Opponent". Works on inbox cards too (they carry the same fields). */
export const docTitle = p => (isGame(p) ? `${p.team || 'Game'} vs ${p.opponent || '?'}` : (p.team || 'Practice'));

export function newDrill(n = 1, kind = null) {
  if (kind === 'game') return newCoachingPoint(n);
  // Drills start with clean ice — add nets with the Net tool (N) where the drill needs them.
  return { id: uid(), name: `Drill ${n}`, duration: 10, notes: '', view: { ...VIEWS.full }, objects: [] };
}
/**
 * A game's coaching point: the left half of the ice set up for half-ice mites — one net on the goal line, the other
 * at the near edge of the centre circle facing it, and dividing boards along the centre line whose ends curve in
 * toward the playing half (no square corners for pucks to die in).
 */
export function newCoachingPoint(n = 1) {
  const cy = RINK.H / 2, mid = RINK.W / 2, r = 10; // the divider's end curves: radius 10 ft, meeting the side boards 10 ft short of centre
  const arc = (from, to, steps, cx, cyy) => Array.from({ length: steps + 1 }, (_, i) => { const a = (from + (to - from) * i / steps) * Math.PI / 180; return { x: +(cx + r * Math.cos(a)).toFixed(2), y: +(cyy + r * Math.sin(a)).toFixed(2) }; });
  const divider = [...arc(-90, 0, 4, mid - r, r), ...arc(0, 90, 4, mid - r, RINK.H - r)]; // top board → curve → straight down the centre line → curve → bottom board
  return { id: uid(), name: `Coaching point ${n}`, duration: 0, notes: '', view: { ...VIEWS.leftHalf }, objects: [
    { id: uid(), type: 'net', x: 11, y: cy, rot: 0 },             // on the goal line, facing centre
    { id: uid(), type: 'net', x: mid - 15, y: cy, rot: 180 },     // at the edge of the centre circle, facing the goal line
    { id: uid(), type: 'barricade', points: divider },
  ] };
}

export function newPractice(team = '', kind = null, opponent = '') {
  const base = { id: uid(), team, date: new Date().toISOString().slice(0, 10), drills: [newDrill(1, kind)] };
  return kind === 'game' ? { ...base, kind: 'game', opponent } : base;
}

/** How a practice is shown anywhere it needs a label. */
/** Dates are shown US style, mm/dd/yyyy (stored as yyyy-mm-dd, which sorts). */
export const usDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}` : (date || '');
export function practiceLabel(p) { return `${isGame(p) ? docTitle(p) : (p.team || 'No team')} — ${usDate(p.date) || 'no date'}`; }

/**
 * Skaters can share a route: a skater with `follow` skates another skater's path. The route is
 * materialised into the follower's own `path` (leader's spot, then their waypoints — so the follower
 * skates from their place in line to the start, then the route) and kept in sync here whenever the
 * drill is loaded or re-rendered. Everything downstream (sim, render, print, presentation) just sees
 * an ordinary path.
 */
export function syncFollowers(d) {
  for (const o of d.objects || []) {
    if (o.type !== 'skater' || !o.follow) continue;
    const lead = d.objects.find(x => x.id === o.follow);
    // Leader gone, no longer routed, or itself a follower (chains would cycle): keep the copied path, stop following.
    if (!lead || lead.type !== 'skater' || lead.id === o.id || lead.follow || !lead.path?.length) { delete o.follow; continue; }
    // Join the route at the leader's start (default) or at one of their waypoints: from their own spot the
    // follower skates to that point, then the rest of the leader's route. Spread keeps waypoint flags (e.g. pivot).
    const route = [{ x: lead.x, y: lead.y }, ...lead.path];
    const k = Math.max(0, Math.min(route.length - 1, Math.round(+o.followWp || 0)));
    o.path = route.slice(k).map(p => ({ ...p }));
  }
}

/** Normalise older saved drills (e.g. skater.hasPuck → a puck object carried by that skater). */
export function migrateDrill(d) {
  d.objects ||= [];
  // A contact marker must sit on the ice where two paths converge. One dragged (or corrupted) off the
  // rink is invisible in every view yet still syncs skaters and shows the "Impact: worse for" selector — drop it.
  d.objects = d.objects.filter(o => o.type !== 'contact' || (o.x >= -5 && o.x <= 205 && o.y >= -5 && o.y <= 90));
  for (const o of [...d.objects]) {
    if (o.type === 'skater' && o.hasPuck) {
      d.objects.push({ id: uid(), type: 'puck', x: o.x, y: o.y, carrier: o.id, events: [], passSpeed: 45, shotSpeed: 90 });
      delete o.hasPuck;
    }
  }
  for (const o of d.objects) if (o.type === 'puck') { o.events ||= []; o.carrier ??= null; o.passSpeed ??= 45; o.shotSpeed ??= 90; }
  for (const o of d.objects) if (o.type === 'coach') { o.path ||= []; o.speed ??= 10; o.delay ??= 0; } // coaches learned to move
  for (const o of d.objects) if (o.type === 'skater' && o.role === 'G' && o.color === 'black') o.color = 'green'; // goalies wear green now
  syncFollowers(d);
  return d;
}

/** Deep-copy objects with fresh ids, remapping puck→skater references. */
export function cloneObjects(objects) {
  const map = new Map(objects.map(o => [o.id, uid()]));
  const re = id => (id ? (map.get(id) ?? null) : id);
  return objects.map(o => {
    const c = JSON.parse(JSON.stringify(o));
    c.id = map.get(o.id);
    if (c.trigger?.player) c.trigger.player = re(c.trigger.player);
    if (c.follow) c.follow = re(c.follow);
    if (c.type === 'contact') { c.a = re(c.a); c.b = re(c.b); }
    if (c.type === 'puck') {
      c.carrier = re(c.carrier);
      if (c.pile) c.pile = re(c.pile);
      for (const ev of c.events || []) { if ('to' in ev) ev.to = re(ev.to); if ('skater' in ev) ev.skater = re(ev.skater); }
    }
    return c;
  });
}

export class Store {
  constructor() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { data = null; }
    this.data = data && Array.isArray(data.practices) ? data : { practices: [], currentId: null };
    if (!this.data.practices.length) this.data.practices.push(newPractice());
    if (!this.practice) this.data.currentId = this.data.practices[0].id;
    this.migrate();
    this.drillIndex = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
  }

  get practice() { return this.data.practices.find(p => p.id === this.data.currentId); }
  get drill() {
    const p = this.practice;
    this.drillIndex = Math.max(0, Math.min(this.drillIndex, p.drills.length - 1));
    return p.drills[this.drillIndex];
  }

  /** An edit was made to the current practice: stamp it, persist locally and notify cloud sync (if any). */
  save() {
    if (this.practice) this.practice.updatedAt = Date.now();
    this.persist();
    this.onSave?.(this.practice);
  }

  /** The team roster: coaches (with emails) and players (with family contacts), per team. */
  get roster() { return (this.data.roster ||= { teams: [], updatedAt: 0 }); }

  /** The roster was edited: stamp it, persist locally and notify cloud sync (if any). */
  saveRoster() {
    this.roster.updatedAt = Date.now();
    this.persist();
    this.onRosterSave?.(this.roster);
  }

  /** Write everything to browser storage without marking anything as edited. */
  persist() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); }
    catch (e) { console.warn('Save failed', e); }
  }

  /** Normalise every practice — local or freshly arrived from the cloud. */
  migrate() {
    for (const p of this.data.practices) {
      if (p.name) { if (!p.team) p.team = p.name; delete p.name; } // practices are now identified by team + date
      for (const d of p.drills || []) migrateDrill(d);
      p.stage = stageOf(p); // practices shared by link before stages existed keep their audience (team list → released, coach list → with coaches)
    }
  }
  blankPractice() { return newPractice(); }

  /** Forget everything local (a different account signed in on this browser). */
  reset() {
    const p = newPractice();
    this.data = { practices: [p], currentId: p.id };
    this.drillIndex = 0; this.undoStack.length = 0; this.redoStack.length = 0; this.pending = null;
    this.persist();
  }

  snapshot() { return JSON.stringify(this.practice); }

  pushUndo(snap = this.snapshot()) {
    this.undoStack.push(snap);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Take a snapshot now; commit it to the undo stack later (used for form edits). */
  beginPending() { if (!this.pending) this.pending = this.snapshot(); }
  commitPending() {
    if (this.pending && this.pending !== this.snapshot()) this.pushUndo(this.pending);
    this.pending = null;
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.snapshot());
    this._replace(JSON.parse(this.undoStack.pop()));
    return true;
  }
  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.snapshot());
    this._replace(JSON.parse(this.redoStack.pop()));
    return true;
  }
  _replace(p) {
    const i = this.data.practices.findIndex(x => x.id === this.data.currentId);
    this.data.practices[i] = p;
    this.save();
  }

  switchPractice(id) {
    if (!this.data.practices.some(p => p.id === id)) return;
    this.data.currentId = id;
    // come back to the drill that was open the last time this practice was viewed
    const last = this.data.lastDrill?.[id];
    this.drillIndex = Math.max(0, this.practice.drills.findIndex(d => d.id === last));
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pending = null;
    this.persist(); // switching is not an edit
  }
  addPractice(p) {
    this.data.practices.push(p);
    this.switchPractice(p.id);
    this.save(); // a new practice is an edit: stamp it so it is uploaded
  }
  deletePractice(id) {
    this.data.practices = this.data.practices.filter(p => p.id !== id);
    this.onDelete?.(id);
    if (!this.data.practices.length) { this.data.practices.push(newPractice()); this.switchPractice(this.data.practices[0].id); this.save(); }
    else this.switchPractice(this.data.practices[0].id);
  }
}
