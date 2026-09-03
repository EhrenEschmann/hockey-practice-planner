// Cloud sync: practices are auto-saved to Firebase (Firestore) under the signed-in user, and changes made
// on another device arrive live. Without a js/firebase-config.js the app simply stays local (localStorage).
//
// Data layout in Firestore:  users/{uid}/practices/{practiceId}  — one document per practice (the same
// JSON the app keeps locally, plus `updatedAt` in ms). Newest `updatedAt` wins when local and cloud differ.

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
export const SAVE_DELAY = 800; // ms of quiet after an edit before it is written

/** The Firebase web config from js/firebase-config.js (or firebase-config.js in the project root), or null when local-only. */
export async function loadConfig() {
  for (const path of ['./firebase-config.js', '../firebase-config.js']) {
    try { const cfg = (await import(path)).firebaseConfig; if (cfg?.projectId) return cfg; } catch { /* not there — try the next location */ }
  }
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
    onUser(cb) { return auth.onAuthStateChanged(a, u => cb(u ? { uid: u.uid, name: u.displayName || u.email || 'Signed in' } : null)); },
    async signIn() { await auth.signInWithPopup(a, new auth.GoogleAuthProvider()); },
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
    /** Live view of one practice in someone else's account (presentation mode; rules check the viewer's email). */
    subscribePractice(uid, id, cb) {
      return fs.onSnapshot(fs.doc(col(uid), id), s => cb(s.exists() ? s.data() : null, null), err => cb(null, err));
    },
  };
}

/**
 * Keeps a Store in sync with a backend for the signed-in user:
 *  - on sign-in, merges cloud practices with local ones (newest wins, missing ones copied both ways)
 *  - auto-saves a practice SAVE_DELAY ms after it last changed (store.save → onSave hook)
 *  - deletes propagate; changes from other devices are applied live
 * `onStatus(state, detail)` reports: signedout | syncing | saving | saved | error.
 * `onRemote(ids)` fires after cloud changes were applied to those practices.
 */
export function createSync({ store, backend, onStatus = () => {}, onRemote = () => {} }) {
  let uid = null, user = null, unsub = null, applying = false;
  const timers = new Map();
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
    try { await backend.save(uid, clean(p)); if (!timers.size) status('saved'); }
    catch (e) { status('error', e?.message || String(e)); }
  }
  async function flush() { for (const id of [...timers.keys()]) { clearTimeout(timers.get(id)); await flushOne(id); } }
  async function remove(id) {
    if (!uid || applying) return;
    clearTimeout(timers.get(id)); timers.delete(id);
    try { await backend.remove(uid, id); status('saved'); } catch (e) { status('error', e?.message || String(e)); }
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
    onRemote(changed, { full: true });
    status(timers.size ? 'saving' : 'saved');
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
    user = u; uid = u?.uid || null;
    if (!uid) { status('signedout'); return; }
    try {
      // The local cache belongs to whoever signed in last; another account must not inherit it.
      if (store.data.ownerUid && store.data.ownerUid !== uid) store.reset();
      store.data.ownerUid = uid; store.persist();
      await pull();
      unsub = backend.subscribe(uid, onChange);
    } catch (e) { status('error', e?.message || String(e)); }
  });

  store.onSave = p => schedule(p);
  store.onDelete = id => remove(id);
  if (typeof addEventListener === 'function') {
    addEventListener('beforeunload', () => { for (const id of [...timers.keys()]) { clearTimeout(timers.get(id)); flushOne(id); } });
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
