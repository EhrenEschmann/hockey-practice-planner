// Cloud sync: practices are auto-saved to Firebase (Firestore) under the signed-in user, and changes made
// on another device arrive live. Without a js/firebase-config.js the app simply stays local (localStorage).
//
// Data layout in Firestore:  users/{uid}/practices/{practiceId}  — one document per practice (the same
// JSON the app keeps locally, plus `updatedAt` in ms). Newest `updatedAt` wins when local and cloud differ.

import { accessFor, publishedCopy, inboxDocs } from './access.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
export const SAVE_DELAY = 800; // ms of quiet after an edit before it is written

/** The Firebase web config from js/firebase-config.js (or firebase-config.js in the project root), or null when local-only. */
export async function loadConfig() {
  let unreachable = null;
  for (const path of ['./firebase-config.js', '../firebase-config.js']) {
    try { const cfg = (await import(path)).firebaseConfig; if (cfg?.projectId) return cfg; }
    catch (e) {
      // Not there (404) — try the next location. Anything else means the file couldn't be fetched
      // (offline, blocked): that is a failed boot, not a local-only install.
      // (A host that answers unknown paths with the app's HTML page is saying "not there" as well.)
      try {
        const r = await fetch(new URL(path, import.meta.url), { method: 'HEAD', cache: 'no-store' });
        if (r.status !== 404 && !(r.headers.get('content-type') || '').includes('text/html')) unreachable = e;
      }
      catch { unreachable = e; }
    }
  }
  if (unreachable) throw unreachable;
  return null;
}

/**
 * Firestore + Google sign-in implementation of the backend used by createSync():
 *   onUser(cb), signIn(), signOut(), load(uid), save(uid, practice), remove(uid, id), subscribe(uid, cb)
 */
export async function firebaseBackend(config) {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${SDK}firebase-app.js`), import(`${SDK}firebase-auth.js`), import(`${SDK}firebase-firestore.js`),
  ]);
  const app = initializeApp(config);
  const a = auth.getAuth(app);
  const db = fs.getFirestore(app);
  const col = uid => fs.collection(db, 'users', uid, 'practices');
  return {
    onUser(cb) { return auth.onAuthStateChanged(a, u => cb(u ? { uid: u.uid, email: u.email || '', name: u.displayName || u.email || 'Signed in' } : null)); },
    async signIn() {
      const provider = new auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' }); // always offer the account chooser, so signing out really lets someone switch emails
      await auth.signInWithPopup(a, provider);
    },
    async signOut() { await auth.signOut(a); },
    async load(uid) { return (await fs.getDocs(col(uid))).docs.map(d => d.data()); },
    async save(uid, p) { await fs.setDoc(fs.doc(col(uid), p.id), p); },
    async remove(uid, id) { await fs.deleteDoc(fs.doc(col(uid), id)); },
    subscribe(uid, cb) {
      return fs.onSnapshot(col(uid), snap => {
        if (snap.metadata.hasPendingWrites) return; // our own edits echoing back
        for (const ch of snap.docChanges()) cb(ch.type, ch.doc.id, ch.doc.data());
      }, err => cb('error', null, err));
    },
    // ---- routing & authorization (js/access.js has the layout; firestore.rules the guarantees) ----
    // Planner: the copy coaches and the team read, and the access lists the rules look people up in.
    async savePublished(pid, copy) { await fs.setDoc(fs.doc(db, 'published', pid), copy); },
    async removePublished(pid) { await fs.deleteDoc(fs.doc(db, 'published', pid)); },
    async saveAccess(pid, access) { await fs.setDoc(fs.doc(db, 'access', pid), access); },
    async removeAccess(pid) { await fs.deleteDoc(fs.doc(db, 'access', pid)); },
    async loadInboxes() { return (await fs.getDocs(fs.collection(db, 'inbox'))).docs.map(d => ({ email: d.id, ...d.data() })); },
    async saveInbox(email, doc) { await fs.setDoc(fs.doc(db, 'inbox', email), doc); },
    async removeInbox(email) { await fs.deleteDoc(fs.doc(db, 'inbox', email)); },
    // Viewer: who am I here (null = on no roster), and one released practice, live.
    subscribeInbox(email, cb) {
      return fs.onSnapshot(fs.doc(db, 'inbox', email), s => cb(s.exists() ? s.data() : null, null), err => cb(null, err));
    },
    subscribePublished(pid, cb) {
      return fs.onSnapshot(fs.doc(db, 'published', pid), s => cb(s.exists() ? s.data() : null, null), err => cb(null, err));
    },
    // Feedback: published/{pid}/feedback/{uid}_{drillId|overall} — a coach reads only their own; the planner reads all.
    async saveFeedback(pid, fid, entry) { await fs.setDoc(fs.doc(db, 'published', pid, 'feedback', fid), entry); },
    async removeFeedback(pid, fid) { await fs.deleteDoc(fs.doc(db, 'published', pid, 'feedback', fid)); },
    async loadMyFeedback(pid, uid) {
      const q = fs.query(fs.collection(db, 'published', pid, 'feedback'), fs.where('uid', '==', uid));
      return (await fs.getDocs(q)).docs.map(d => ({ fid: d.id, ...d.data() }));
    },
    subscribeAllFeedback(cb) {
      return fs.onSnapshot(fs.collectionGroup(db, 'feedback'),
        snap => cb(snap.docs.map(d => ({ fid: d.id, pid: d.ref.parent.parent.id, ...d.data() })), null), err => cb(null, err));
    },
    async resolveFeedback(pid, fid, resolved) { await fs.updateDoc(fs.doc(db, 'published', pid, 'feedback', fid), { resolved }); },
    // Access requests: requests/{uid} — filed by someone on no roster, answered by the planner.
    async loadRequest(uid) { const s = await fs.getDoc(fs.doc(db, 'requests', uid)); return s.exists() ? s.data() : null; },
    async saveRequest(uid, req) { await fs.setDoc(fs.doc(db, 'requests', uid), req); },
    async denyRequest(uid) { await fs.updateDoc(fs.doc(db, 'requests', uid), { status: 'denied', deniedAt: Date.now() }); },
    async removeRequest(uid) { await fs.deleteDoc(fs.doc(db, 'requests', uid)); },
    subscribeRequests(cb) {
      return fs.onSnapshot(fs.collection(db, 'requests'), snap => cb(snap.docs.map(d => d.data()), null), err => cb(null, err));
    },
    // Intro clips: users/{uid}/practices/{pid}/clips/{drillId} — { mime, data (base64), secs, at }.
    // One small document per clip, so a practice's own document stays light; read rules mirror the practice's.
    async saveClip(uid, pid, did, clip) { await fs.setDoc(fs.doc(db, 'users', uid, 'practices', pid, 'clips', did), clip); },
    async loadClip(uid, pid, did) { const s = await fs.getDoc(fs.doc(db, 'users', uid, 'practices', pid, 'clips', did)); return s.exists() ? s.data() : null; },
    async removeClip(uid, pid, did) { await fs.deleteDoc(fs.doc(db, 'users', uid, 'practices', pid, 'clips', did)); },
    // Audit log: users/{uid}/practices/{pid}/views/{autoId} — one record per drill view / play by a viewer.
    async logView(uid, pid, entry) { await fs.addDoc(fs.collection(db, 'users', uid, 'practices', pid, 'views'), entry); },
    async loadViews(uid, pid, max = 3000) {
      const q = fs.query(fs.collection(db, 'users', uid, 'practices', pid, 'views'), fs.orderBy('at', 'desc'), fs.limit(max));
      return (await fs.getDocs(q)).docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async clearViews(uid, pid) {
      const snap = await fs.getDocs(fs.collection(db, 'users', uid, 'practices', pid, 'views'));
      await Promise.all(snap.docs.map(d => fs.deleteDoc(d.ref)));
    },
    // Uploaded drill videos: users/{uid}/practices/{pid}/videos/{drillId}_{at}_{i} — base64 chunks (≤ ~930 KB each)
    // of one re-encoded clip, read back in order. Firestore's free tier hosts them without a storage bucket.
    async saveVideo(uid, pid, did, at, chunks, meta) {
      for (let i = 0; i < chunks.length; i++) {
        await fs.setDoc(fs.doc(db, 'users', uid, 'practices', pid, 'videos', `${did}_${at}_${i}`), { i, n: chunks.length, data: chunks[i], ...meta, at });
      }
    },
    async loadVideo(uid, pid, did, at, n, onChunk = () => {}) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const s = await fs.getDoc(fs.doc(db, 'users', uid, 'practices', pid, 'videos', `${did}_${at}_${i}`));
        if (!s.exists()) throw new Error(`video chunk ${i + 1} of ${n} is missing`);
        out.push(s.data().data); onChunk(i + 1, n);
      }
      return out;
    },
    async removeVideo(uid, pid, did, at, n) {
      for (let i = 0; i < n; i++) await fs.deleteDoc(fs.doc(db, 'users', uid, 'practices', pid, 'videos', `${did}_${at}_${i}`)).catch(() => {});
    },
    // The team roster: one document per user at users/{uid}/meta/roster.
    async loadRoster(uid) { const s = await fs.getDoc(fs.doc(db, 'users', uid, 'meta', 'roster')); return s.exists() ? s.data() : null; },
    async saveRoster(uid, r) { await fs.setDoc(fs.doc(db, 'users', uid, 'meta', 'roster'), r); },
    subscribeRoster(uid, cb) {
      return fs.onSnapshot(fs.doc(db, 'users', uid, 'meta', 'roster'), s => {
        if (!s.metadata.hasPendingWrites && s.exists()) cb(s.data());
      }, () => { /* roster sync is best-effort; practice sync reports errors */ });
    },
  };
}

/**
 * Keeps a Store in sync with a backend for the signed-in user:
 *  - on sign-in, merges cloud practices with local ones (newest wins, missing ones copied both ways)
 *  - auto-saves a practice SAVE_DELAY ms after it last changed (store.save → onSave hook)
 *  - deletes propagate; changes from other devices are applied live
 * `onStatus(state, detail)` reports: signedout | viewer | syncing | saving | saved | error.
 * `canSync(user)` false → that account is signed in (`sync.user`) but nothing is synced for it ('viewer').
 * `onRemote(ids)` fires after cloud changes were applied to those practices.
 */
export function createSync({ store, backend, onStatus = () => {}, onRemote = () => {}, onRoster = () => {}, canSync = () => true }) {
  let uid = null, user = null, unsub = null, unsubRoster = null, applying = false;
  const timers = new Map();
  let rosterTimer = null;
  const clean = p => JSON.parse(JSON.stringify(p)); // drops undefined (Firestore rejects it) and detaches
  const local = id => store.data.practices.find(p => p.id === id);
  const newer = (a, b) => (a?.updatedAt || 0) > (b?.updatedAt || 0);

  function status(state, detail) { onStatus(state, detail); }

  // ----- writes -----
  function schedule(p) {
    if (!uid || applying || !p) return;
    clearTimeout(timers.get(p.id));
    status('saving');
    timers.set(p.id, setTimeout(() => flushOne(p.id), SAVE_DELAY));
  }
  async function flushOne(id) {
    timers.delete(id);
    const p = local(id);
    if (!p || !uid) return;
    try { await backend.save(uid, clean(p)); await publishOne(p); await syncInboxes(); if (!timers.size) status('saved'); }
    catch (e) { status('error', e?.message || String(e)); }
  }

  // ----- publishing: what coaches and the team can open follows every save (js/access.js) -----
  // Only changes are written: a fingerprint of everything last sent is kept on this device.
  const PUB_KEY = 'hpp.pubstate';
  const fp = o => { const t = JSON.stringify(o); let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return `${t.length}:${h}`; };
  let pub = { owner: null, p: {}, a: {}, i: {} };
  function loadPub() {
    try { const v = JSON.parse(localStorage.getItem(PUB_KEY) || 'null'); if (v?.owner === uid) { pub = { p: {}, a: {}, i: {}, ...v }; return; } } catch { /* start clean */ }
    pub = { owner: uid, p: {}, a: {}, i: {} };
  }
  const savePub = () => { try { localStorage.setItem(PUB_KEY, JSON.stringify(pub)); } catch { /* blocked: everything is simply re-sent next time */ } };
  async function publishOne(p) {
    if (!uid || !backend.savePublished) return;
    const a = accessFor(store.roster, p);
    if (a.stage === 'draft' && !pub.a[p.id] && !pub.p[p.id]) return; // never released: nothing in the cloud to keep in step
    if (pub.a[p.id] !== fp(a)) { await backend.saveAccess(p.id, a); pub.a[p.id] = fp(a); } // the list first: pulling back must cut access before anything else
    if (a.stage === 'draft') { if (pub.p[p.id]) { await backend.removePublished(p.id); delete pub.p[p.id]; } }
    else {
      const copy = clean(publishedCopy(p, uid));
      if (pub.p[p.id] !== fp(copy)) { await backend.savePublished(p.id, copy); pub.p[p.id] = fp(copy); }
    }
    savePub();
  }
  async function unpublish(id) {
    if (!uid || !backend.savePublished || (!pub.a[id] && !pub.p[id])) return;
    await backend.removeAccess(id); await backend.removePublished(id);
    delete pub.a[id]; delete pub.p[id]; savePub();
  }
  /** Each person's list document: persona from the roster, practices from what is released to them. */
  async function syncInboxes() {
    if (!uid || !backend.saveInbox) return;
    const want = inboxDocs(store.roster, store.data.practices);
    for (const [email, doc] of want) {
      if (email.includes('/') || pub.i[email] === fp(doc)) continue;
      await backend.saveInbox(email, clean(doc)); pub.i[email] = fp(doc);
    }
    for (const email of Object.keys(pub.i)) if (!want.has(email)) { await backend.removeInbox(email); delete pub.i[email]; }
    savePub();
  }
  /** After sign-in: bring the published side in step with this (freshly merged) store — also the one-time migration of practices shared by link. */
  async function republish() {
    if (!backend.savePublished) return true;
    loadPub();
    try {
      // The cloud is the truth about which list documents exist (another device may have written them).
      pub.i = Object.fromEntries((await backend.loadInboxes()).map(({ email, ...doc }) => [email, fp(doc)]));
      for (const p of store.data.practices) await publishOne(p);
      for (const id of Object.keys({ ...pub.a, ...pub.p })) if (!local(id)) await unpublish(id);
      await syncInboxes();
      return true;
    } catch (e) { status('error', `sharing: ${e?.message || e} — are the latest firestore.rules deployed?`); return false; }
  }
  async function flush() { for (const id of [...timers.keys()]) { clearTimeout(timers.get(id)); await flushOne(id); } await flushRoster(); }

  // ----- roster (one meta document, same debounce + newest-wins treatment) -----
  function scheduleRoster() {
    if (!uid || applying || !backend.saveRoster) return;
    clearTimeout(rosterTimer);
    status('saving');
    rosterTimer = setTimeout(flushRoster, SAVE_DELAY);
  }
  async function flushRoster() {
    if (!rosterTimer) return;
    clearTimeout(rosterTimer); rosterTimer = null;
    if (!uid) return;
    try {
      await backend.saveRoster(uid, clean(store.roster));
      for (const p of store.data.practices) await publishOne(p); // the roster is who has access: every released practice follows it
      await syncInboxes();
      if (!timers.size) status('saved');
    } catch (e) { status('error', e?.message || String(e)); }
  }
  async function remove(id) {
    if (!uid || applying) return;
    clearTimeout(timers.get(id)); timers.delete(id);
    try { await backend.remove(uid, id); await unpublish(id); await syncInboxes(); status('saved'); } catch (e) { status('error', e?.message || String(e)); }
  }

  // ----- initial merge -----
  async function pull() {
    status('syncing');
    const remote = await backend.load(uid);
    const changed = [];
    applying = true;
    try {
      for (const r of remote) {
        const i = store.data.practices.findIndex(p => p.id === r.id);
        if (i < 0) { store.data.practices.push(r); changed.push(r.id); }
        else if (newer(r, store.data.practices[i])) { store.data.practices[i] = r; changed.push(r.id); }
      }
      if (changed.length) { store.migrate(); store.persist(); }
    } finally { applying = false; }
    for (const p of store.data.practices) {
      const r = remote.find(x => x.id === p.id);
      if (!r || newer(p, r)) await backend.save(uid, clean(p));
    }
    // Roster: newest copy wins, missing side copied over. Roster trouble (e.g. rules not yet
    // deployed for users/{uid}/meta) must never block practice syncing — report it and move on.
    if (backend.loadRoster) {
      try {
        const rr = await backend.loadRoster(uid);
        if (rr && (rr.updatedAt || 0) > (store.roster.updatedAt || 0)) { store.data.roster = rr; store.persist(); onRoster(); }
        else if ((store.roster.updatedAt || 0) > (rr?.updatedAt || 0)) await backend.saveRoster(uid, clean(store.roster));
      } catch (e) { status('error', `team roster: ${e?.message || e} — are the latest firestore.rules deployed?`); }
    }
    const shared = await republish();
    onRemote(changed, { full: true });
    if (shared !== false) status(timers.size ? 'saving' : 'saved');
  }

  // ----- live updates from elsewhere -----
  function onChange(type, id, data) {
    if (type === 'error') { status('error', data?.message || String(data)); return; }
    if (timers.has(id)) return; // we have unsaved local edits to this one; ours will win when written
    applying = true;
    try {
      if (type === 'removed') {
        if (!local(id)) return;
        store.data.practices = store.data.practices.filter(p => p.id !== id);
        if (!store.data.practices.length) store.data.practices.push(store.blankPractice());
        if (store.data.currentId === id) store.switchPractice(store.data.practices[0].id);
        store.persist();
      } else {
        const i = store.data.practices.findIndex(p => p.id === id);
        if (i >= 0 && !newer(data, store.data.practices[i])) return;
        if (i < 0) store.data.practices.push(data); else store.data.practices[i] = data;
        store.migrate(); store.persist();
      }
    } finally { applying = false; }
    onRemote([id]);
  }

  // ----- auth -----
  backend.onUser(async u => {
    unsub?.(); unsub = null;
    unsubRoster?.(); unsubRoster = null;
    user = u; uid = u && canSync(u) ? u.uid : null;
    if (!u) { status('signedout'); return; }
    if (!uid) { status('viewer'); return; } // a share link's viewer: the store and their account are left alone
    try {
      // The local cache belongs to whoever signed in last; another account must not inherit it.
      if (store.data.ownerUid && store.data.ownerUid !== uid) store.reset();
      store.data.ownerUid = uid; store.persist();
      await pull();
      unsub = backend.subscribe(uid, onChange);
      unsubRoster = backend.subscribeRoster?.(uid, r => {
        if (rosterTimer || !r || (r.updatedAt || 0) <= (store.roster.updatedAt || 0)) return;
        store.data.roster = r; store.persist(); onRoster();
      });
    } catch (e) { status('error', e?.message || String(e)); }
  });

  store.onSave = p => schedule(p);
  store.onRosterSave = () => scheduleRoster();
  store.onDelete = id => remove(id);
  if (typeof addEventListener === 'function') {
    addEventListener('beforeunload', () => { for (const id of [...timers.keys()]) { clearTimeout(timers.get(id)); flushOne(id); } flushRoster(); });
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  }

  return {
    signIn: () => backend.signIn(),
    signOut: async () => { await flush(); await backend.signOut(); },
    flush,
    get user() { return user; },
    get pending() { return timers.size; },
  };
}
