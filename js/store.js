// Persistent state: a library of practices, each with drills. Undo/redo for the current practice.
import { VIEWS } from './rink.js';

const KEY = 'hpp.v1';
const UNDO_LIMIT = 100;

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

export function defaultNets() {
  return [
    { id: uid(), type: 'net', x: 11, y: 42.5, rot: 0 },
    { id: uid(), type: 'net', x: 189, y: 42.5, rot: 180 },
  ];
}

export function newDrill(n = 1) {
  return { id: uid(), name: `Drill ${n}`, duration: 10, notes: '', view: { ...VIEWS.full }, objects: defaultNets() };
}

export function newPractice(team = '') {
  return { id: uid(), team, date: new Date().toISOString().slice(0, 10), drills: [newDrill(1)] };
}

/** How a practice is shown anywhere it needs a label. */
export function practiceLabel(p) { return `${p.team || 'No team'} — ${p.date || 'no date'}`; }

/** Normalise older saved drills (e.g. skater.hasPuck → a puck object carried by that skater). */
export function migrateDrill(d) {
  d.objects ||= [];
  for (const o of [...d.objects]) {
    if (o.type === 'skater' && o.hasPuck) {
      d.objects.push({ id: uid(), type: 'puck', x: o.x, y: o.y, carrier: o.id, events: [], passSpeed: 45, shotSpeed: 90 });
      delete o.hasPuck;
    }
  }
  for (const o of d.objects) if (o.type === 'puck') { o.events ||= []; o.carrier ??= null; o.passSpeed ??= 45; o.shotSpeed ??= 90; }
  for (const o of d.objects) if (o.type === 'coach') { o.path ||= []; o.speed ??= 10; o.delay ??= 0; } // coaches learned to move
  for (const o of d.objects) if (o.type === 'skater' && o.role === 'G' && o.color === 'black') o.color = 'green'; // goalies wear green now
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
