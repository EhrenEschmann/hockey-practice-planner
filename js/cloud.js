// Cloud sync: the planner's practices, roster and club data are auto-saved to Firebase (Firestore) and changes made on
// another device arrive live. Without a js/firebase-config.js the app simply stays local (localStorage).
//
// Data layout (docs/data-model.md): everything lives under its team — teams/{teamId}/practices/{pid} is a light
// header and …/plan/body the drills; members, players, tasks, stats and media sit beside them; people/{email} tells a
// viewer which teams are theirs. Newest `updatedAt` wins when local and cloud differ.

import { peopleDocs, memberDocs, playerDocs, teamDoc, clubDoc, practiceHeader, practiceBody, practiceFromParts, statId } from './access.js';

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

/** Firestore + Google sign-in implementation of the backend used by createSync() and the viewer (js/main.js). */
export async function firebaseBackend(config) {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${SDK}firebase-app.js`), import(`${SDK}firebase-auth.js`), import(`${SDK}firebase-firestore.js`),
  ]);
  // Sign-in runs through Firebase's auth handler page. Served from this very site (Firebase Hosting has it at
  // /__/auth/), it is first-party, so browsers that wall off third-party storage (Safari, in-app browsers) don't
  // lose the sign-in state halfway — the "missing initial state" error. The config's own authDomain is only used
  // when the app is served from somewhere else (a dev server, say).
  if (location.protocol === 'https:' && /\.(web\.app|firebaseapp\.com)$/.test(location.host)) config = { ...config, authDomain: location.host };
  const app = initializeApp(config);
  const a = auth.getAuth(app);
  // A redirect sign-in comes back here: a failure on the way (or a cancelled chooser) is reported like any other.
  let authErr = null, onAuthErr = null;
  auth.getRedirectResult(a).catch(e => { authErr = e; onAuthErr?.(e); });
  const db = fs.getFirestore(app);
  const T = t => fs.doc(db, 'teams', t);
  const P = (t, pid) => fs.doc(db, 'teams', t, 'practices', pid);
  const B = (t, pid) => fs.doc(db, 'teams', t, 'practices', pid, 'plan', 'body');
  const sub = (t, pid, name) => fs.collection(db, 'teams', t, 'practices', pid, name);
  const SUBS = ['clips', 'videos', 'views', 'feedback'];
  const listSub = async (t, pid, name) => (await fs.getDocs(sub(t, pid, name))).docs.map(d => ({ id: d.id, data: d.data() }));
  const merged = async (t, h) => practiceFromParts(h, (await fs.getDoc(B(t, h.id))).data() || null);
  return {
    onUser(cb) { return auth.onAuthStateChanged(a, u => cb(u ? { uid: u.uid, email: u.email || '', name: u.displayName || u.email || (u.isAnonymous ? 'Guest' : 'Signed in'), isAnonymous: !!u.isAnonymous } : null)); },
    onAuthError(cb) { onAuthErr = cb; if (authErr) cb(authErr); },
    async signInAnon() { await auth.signInAnonymously(a); },
    async signIn() {
      const provider = new auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' }); // always offer the account chooser, so signing out really lets someone switch emails
      // Phones: a full-page redirect (a popup there is a second tab that may never make it back). Desktops: a popup,
      // which keeps the page — and if the popup is blocked, the redirect instead.
      if (matchMedia('(pointer: coarse)').matches) return auth.signInWithRedirect(a, provider);
      try { await auth.signInWithPopup(a, provider); }
      catch (e) {
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'].includes(e?.code)) return auth.signInWithRedirect(a, provider);
        throw e;
      }
    },
    async signOut() { await auth.signOut(a); },
    // ---- the planner's practices: header + body under their team
    async loadPractices(teamIds) {
      const out = [];
      for (const t of teamIds) {
        const heads = (await fs.getDocs(fs.collection(db, 'teams', t, 'practices'))).docs.map(d => d.data());
        out.push(...await Promise.all(heads.map(h => merged(t, h))));
      }
      return out;
    },
    /** Header (always), body (when asked) and the index entry, in one batch. */
    async savePractice(p, { body = true } = {}) {
      const t = p.teamId; if (!t) throw new Error('a practice needs a team before it can be saved to the cloud');
      const batch = fs.writeBatch(db);
      batch.set(P(t, p.id), practiceHeader(p));
      if (body) batch.set(B(t, p.id), practiceBody(p));
      batch.set(fs.doc(db, 'practiceIndex', p.id), { teamId: t });
      await batch.commit();
    },
    async removePractice(t, pid) {
      for (const name of SUBS) for (const d of await listSub(t, pid, name)) await fs.deleteDoc(d.ref || fs.doc(sub(t, pid, name), d.id)).catch(() => {});
      await fs.deleteDoc(B(t, pid)).catch(() => {});
      await fs.deleteDoc(P(t, pid));
      await fs.deleteDoc(fs.doc(db, 'practiceIndex', pid)).catch(() => {});
    },
    /** A practice re-homed to another team: its clips, videos, views and feedback go with it. */
    async movePractice(from, to, p) {
      for (const name of SUBS) for (const d of await listSub(from, p.id, name)) await fs.setDoc(fs.doc(sub(to, p.id, name), d.id), d.data);
      await this.savePractice({ ...p, teamId: to });
      for (const name of SUBS) for (const d of await listSub(from, p.id, name)) await fs.deleteDoc(fs.doc(sub(from, p.id, name), d.id)).catch(() => {});
      await fs.deleteDoc(B(from, p.id)).catch(() => {});
      await fs.deleteDoc(P(from, p.id)).catch(() => {});
    },
    /** Live header changes for one team's practices; the body is fetched for each change. */
    subscribePractices(t, cb) {
      return fs.onSnapshot(fs.collection(db, 'teams', t, 'practices'), snap => {
        if (snap.metadata.hasPendingWrites) return; // our own edits echoing back
        for (const ch of snap.docChanges()) {
          if (ch.type === 'removed') cb('removed', ch.doc.id, null);
          else merged(t, ch.doc.data()).then(p => cb(ch.type, ch.doc.id, p)).catch(e => cb('error', null, e));
        }
      }, err => cb('error', null, err));
    },
    // ---- teams: the documents everyone reads, derived from the planner's roster
    async saveTeam(t, doc) { await fs.setDoc(T(t), doc); },
    async removeTeam(t) {
      for (const name of ['members', 'players']) for (const d of (await fs.getDocs(fs.collection(db, 'teams', t, name))).docs) await fs.deleteDoc(d.ref).catch(() => {});
      await fs.deleteDoc(T(t));
    },
    async loadTeam(t) { const s = await fs.getDoc(T(t)); return s.exists() ? s.data() : null; },
    async saveMember(t, email, doc) { await fs.setDoc(fs.doc(db, 'teams', t, 'members', email), doc); },
    async removeMember(t, email) { await fs.deleteDoc(fs.doc(db, 'teams', t, 'members', email)); },
    async savePlayer(t, id, doc) { await fs.setDoc(fs.doc(db, 'teams', t, 'players', id), doc); },
    async removePlayer(t, id) { await fs.deleteDoc(fs.doc(db, 'teams', t, 'players', id)); },
    async loadPlayers(t) { return Object.fromEntries((await fs.getDocs(fs.collection(db, 'teams', t, 'players'))).docs.map(d => [d.id, d.data()])); },
    async listPeople() { return (await fs.getDocs(fs.collection(db, 'people'))).docs.map(d => ({ email: d.id, ...d.data() })); },
    async savePerson(email, doc) { await fs.setDoc(fs.doc(db, 'people', email), doc); },
    async removePerson(email) { await fs.deleteDoc(fs.doc(db, 'people', email)); },
    subscribePerson(email, cb) { return fs.onSnapshot(fs.doc(db, 'people', email), s => cb(s.exists() ? s.data() : null, null), err => cb(null, err)); },
    /** An older link that named only the practice: which team is it under? */
    async lookupTeam(pid) { const s = await fs.getDoc(fs.doc(db, 'practiceIndex', pid)); return s.exists() ? s.data().teamId : null; },
    // ---- viewers: one team's released headers, live; one practice (header + body), live
    subscribeTeamPractices(t, stages, cb) {
      return fs.onSnapshot(fs.query(fs.collection(db, 'teams', t, 'practices'), fs.where('stage', 'in', stages)), snap => cb(snap.docs.map(d => d.data()), null), err => cb(null, err));
    },
    subscribePractice(t, pid, cb) {
      let h = undefined, b = undefined;
      const emit = () => { if (h === undefined || b === undefined) return; cb(h ? practiceFromParts(h, b) : null, null); };
      const u1 = fs.onSnapshot(P(t, pid), s => { h = s.exists() ? s.data() : null; emit(); }, err => cb(null, err));
      const u2 = fs.onSnapshot(B(t, pid), s => { b = s.exists() ? s.data() : null; emit(); }, err => cb(null, err));
      return () => { u1(); u2(); };
    },
    // ---- an official club team: the week's task list, each player's numbers, and a task's how-to media
    async saveTasks(t, week, doc) { await fs.setDoc(fs.doc(db, 'teams', t, 'tasks', week), doc); },
    async removeTasks(t, week) { await fs.deleteDoc(fs.doc(db, 'teams', t, 'tasks', week)); },
    async loadTasks(t, week) { const s = await fs.getDoc(fs.doc(db, 'teams', t, 'tasks', week)); return s.exists() ? s.data() : null; },
    async saveStat(t, data) { await fs.setDoc(fs.doc(db, 'teams', t, 'stats', statId(data.playerId, data.week)), data); },
    async loadWeekStats(t, week) { return (await fs.getDocs(fs.query(fs.collection(db, 'teams', t, 'stats'), fs.where('week', '==', week)))).docs.map(d => d.data()); },
    async loadPlayerStats(t, playerId) { return (await fs.getDocs(fs.query(fs.collection(db, 'teams', t, 'stats'), fs.where('playerId', '==', playerId)))).docs.map(d => d.data()); },
    async saveClubMedia(t, id, data) { await fs.setDoc(fs.doc(db, 'teams', t, 'media', id), data); },
    async loadClubMedia(t, id) { const s = await fs.getDoc(fs.doc(db, 'teams', t, 'media', id)); return s.exists() ? s.data() : null; },
    async removeClubMedia(t, id) { await fs.deleteDoc(fs.doc(db, 'teams', t, 'media', id)); },
    // ---- feedback: teams/{t}/practices/{pid}/feedback/{uid}_{drillId|overall} — a coach reads only their own; the planner reads all
    async saveFeedback(t, pid, fid, entry) { await fs.setDoc(fs.doc(sub(t, pid, 'feedback'), fid), entry); },
    async removeFeedback(t, pid, fid) { await fs.deleteDoc(fs.doc(sub(t, pid, 'feedback'), fid)); },
    async loadMyFeedback(t, pid, uid) { return (await fs.getDocs(fs.query(sub(t, pid, 'feedback'), fs.where('uid', '==', uid)))).docs.map(d => ({ fid: d.id, ...d.data() })); },
    subscribeAllFeedback(cb) {
      return fs.onSnapshot(fs.collectionGroup(db, 'feedback'),
        snap => cb(snap.docs.map(d => ({ fid: d.id, pid: d.ref.parent.parent.id, teamId: d.ref.parent.parent.parent.parent.id, ...d.data() })), null), err => cb(null, err));
    },
    async resolveFeedback(t, pid, fid, resolved) { await fs.updateDoc(fs.doc(sub(t, pid, 'feedback'), fid), { resolved }); },
    // ---- sign-ins that got nowhere, and access requests (unchanged)
    async logAttempt(uid, a) { await fs.setDoc(fs.doc(db, 'attempts', uid), { ...a, count: fs.increment(1) }, { merge: true }); },
    subscribeAttempts(cb) { return fs.onSnapshot(fs.collection(db, 'attempts'), snap => cb(snap.docs.map(d => d.data()), null), err => cb(null, err)); },
    async removeAttempt(uid) { await fs.deleteDoc(fs.doc(db, 'attempts', uid)); },
    async loadRequest(uid) { const s = await fs.getDoc(fs.doc(db, 'requests', uid)); return s.exists() ? s.data() : null; },
    async saveRequest(uid, req) { await fs.setDoc(fs.doc(db, 'requests', uid), req); },
    async denyRequest(uid) { await fs.updateDoc(fs.doc(db, 'requests', uid), { status: 'denied', deniedAt: Date.now() }); },
    async removeRequest(uid) { await fs.deleteDoc(fs.doc(db, 'requests', uid)); },
    subscribeRequests(cb) { return fs.onSnapshot(fs.collection(db, 'requests'), snap => cb(snap.docs.map(d => d.data()), null), err => cb(null, err)); },
    // ---- the planner's private documents (users/{uid}/private/{name}), e.g. 'anthropic': the encrypted API key record
    async savePrivate(uid, name, data) { await fs.setDoc(fs.doc(db, 'users', uid, 'private', name), data); },
    async loadPrivate(uid, name) { const s = await fs.getDoc(fs.doc(db, 'users', uid, 'private', name)); return s.exists() ? s.data() : null; },
    async removePrivate(uid, name) { await fs.deleteDoc(fs.doc(db, 'users', uid, 'private', name)); },
    // ---- a practice's recordings and video, under its team
    async saveClip(t, pid, did, clip) { await fs.setDoc(fs.doc(sub(t, pid, 'clips'), did), clip); },
    async loadClip(t, pid, did) { const s = await fs.getDoc(fs.doc(sub(t, pid, 'clips'), did)); return s.exists() ? s.data() : null; },
    async removeClip(t, pid, did) { await fs.deleteDoc(fs.doc(sub(t, pid, 'clips'), did)); },
    async logView(t, pid, entry) { await fs.addDoc(sub(t, pid, 'views'), entry); },
    async loadViews(t, pid, max = 3000) { return (await fs.getDocs(fs.query(sub(t, pid, 'views'), fs.orderBy('at', 'desc'), fs.limit(max)))).docs.map(d => ({ id: d.id, ...d.data() })); },
    async clearViews(t, pid) { const snap = await fs.getDocs(sub(t, pid, 'views')); await Promise.all(snap.docs.map(d => fs.deleteDoc(d.ref))); },
    async saveVideo(t, pid, did, at, chunks, meta) {
      for (let i = 0; i < chunks.length; i++) await fs.setDoc(fs.doc(sub(t, pid, 'videos'), `${did}_${at}_${i}`), { i, n: chunks.length, data: chunks[i], ...meta, at });
    },
    async loadVideo(t, pid, did, at, n, onChunk = () => {}) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const s = await fs.getDoc(fs.doc(sub(t, pid, 'videos'), `${did}_${at}_${i}`));
        if (!s.exists()) throw new Error(`video chunk ${i + 1} of ${n} is missing`);
        out.push(s.data().data); onChunk(i + 1, n);
      }
      return out;
    },
    async removeVideo(t, pid, did, at, n) { for (let i = 0; i < n; i++) await fs.deleteDoc(fs.doc(sub(t, pid, 'videos'), `${did}_${at}_${i}`)).catch(() => {}); },
    // ---- the planner's roster: the working document the team documents are derived from
    async loadRoster(uid) { const s = await fs.getDoc(fs.doc(db, 'users', uid, 'meta', 'roster')); return s.exists() ? s.data() : null; },
    async saveRoster(uid, r) { await fs.setDoc(fs.doc(db, 'users', uid, 'meta', 'roster'), r); },
    subscribeRoster(uid, cb) {
      return fs.onSnapshot(fs.doc(db, 'users', uid, 'meta', 'roster'), s => { if (!s.metadata.hasPendingWrites && s.exists()) cb(s.data()); }, () => { /* best-effort */ });
    },
  };
}

/** Firebase's auth errors, in words a parent can act on. */
export function friendlyAuthError(e) {
  const code = e?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' || code === 'auth/user-cancelled') return 'Sign-in was cancelled.';
  if (code === 'auth/network-request-failed') return 'No connection — check your internet and try again.';
  if (code === 'auth/unauthorized-domain') return 'This address is not set up for sign-in yet (the site\'s domain must be authorised in Firebase).';
  if (code === 'auth/missing-initial-state' || /missing initial state/i.test(e?.message || '')) return 'The browser lost the sign-in halfway (it blocks storage for this site). Open the link in Safari or Chrome itself and try again.';
  return e?.message || String(e);
}

/**
 * Keeps a Store in sync with a backend for the signed-in planner:
 *  - on sign-in, merges the cloud's practices (every team on the roster) with local ones — newest wins, missing ones copied both ways
 *  - auto-saves a practice SAVE_DELAY ms after it last changed: its header every time, its body only when the drills changed
 *  - the roster is saved as the planner's working document and unfolded into the team documents everyone reads
 *  - deletes propagate; changes from other devices are applied live, per team
 * `onStatus(state, detail)` reports: signedout | viewer | syncing | saving | saved | error.
 */
export function createSync({ store, backend, onStatus = () => {}, onRemote = () => {}, onRoster = () => {}, canSync = () => true }) {
  let uid = null, user = null, unsubs = new Map(), unsubRoster = null, applying = false;
  const timers = new Map();
  let rosterTimer = null;
  const clean = p => JSON.parse(JSON.stringify(p)); // drops undefined (Firestore rejects it) and detaches
  const local = id => store.data.practices.find(p => p.id === id);
  const newer = (a, b) => (a?.updatedAt || 0) > (b?.updatedAt || 0);
  const status = (state, detail) => onStatus(state, detail);
  const fp = o => { const t = JSON.stringify(o); let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return `${t.length}:${h}`; };
  // What this device last sent, so only changes are written: header / body fingerprints and location per practice,
  // the team documents, and each person's document. Lost? Everything is simply re-sent next time.
  const PUB_KEY = 'hpp.pubstate.v2';
  let pub = { owner: null, h: {}, b: {}, loc: {}, t: {}, i: {} };
  const loadPub = () => { try { const v = JSON.parse(localStorage.getItem(PUB_KEY) || 'null'); pub = v?.owner === uid ? { h: {}, b: {}, loc: {}, t: {}, i: {}, ...v } : { owner: uid, h: {}, b: {}, loc: {}, t: {}, i: {} }; } catch { pub = { owner: uid, h: {}, b: {}, loc: {}, t: {}, i: {} }; } };
  const savePub = () => { try { localStorage.setItem(PUB_KEY, JSON.stringify(pub)); } catch { /* blocked */ } };
  /** The team a practice is filed under: its own id when that team exists, else matched by name, else the first team. */
  function homeTeam(p) {
    const teams = store.roster.teams || [];
    if (p.teamId && teams.some(t => t.id === p.teamId)) return p.teamId;
    const byName = teams.find(t => String(t.name || '').trim().toLowerCase() === String(p.team || '').trim().toLowerCase());
    return byName?.id || p.teamId || teams[0]?.id || null;
  }

  // ----- writes: practices -----
  function schedule(p) {
    if (!uid || applying || !p) return;
    clearTimeout(timers.get(p.id));
    status('saving');
    timers.set(p.id, setTimeout(() => flushOne(p.id), SAVE_DELAY));
  }
  async function pushPractice(p) {
    const t = homeTeam(p);
    if (!t) { status('error', 'add a team under 👥 Team — practices are kept by team'); return; }
    if (p.teamId !== t) { p.teamId = t; store.persist(); }
    const c = clean({ ...p, owner: uid }); // the owner's uid rides on the header: viewers key their cached copies by it
    const hf = fp(practiceHeader(c)), bf = fp(practiceBody(c));
    if (pub.loc[p.id] && pub.loc[p.id] !== t) { await backend.movePractice(pub.loc[p.id], t, c); } // re-homed: everything moves with it
    else if (pub.h[p.id] !== hf || pub.b[p.id] !== bf) await backend.savePractice(c, { body: pub.b[p.id] !== bf });
    pub.h[p.id] = hf; pub.b[p.id] = bf; pub.loc[p.id] = t; savePub();
    watchTeam(t);
  }
  async function flushOne(id) {
    timers.delete(id);
    const p = local(id);
    if (!p || !uid) return;
    try { await pushPractice(p); if (!timers.size) status('saved'); }
    catch (e) { status('error', e?.message || String(e)); }
  }
  async function remove(id) {
    if (!uid || applying) return;
    clearTimeout(timers.get(id)); timers.delete(id);
    const t = pub.loc[id]; if (!t) return;
    try { await backend.removePractice(t, id); delete pub.h[id]; delete pub.b[id]; delete pub.loc[id]; savePub(); status('saved'); }
    catch (e) { status('error', e?.message || String(e)); }
  }

  // ----- writes: the roster, unfolded into the team documents everyone reads -----
  function scheduleRoster() {
    if (!uid || applying || !backend.saveRoster) return;
    clearTimeout(rosterTimer);
    status('saving');
    rosterTimer = setTimeout(flushRoster, SAVE_DELAY);
  }
  async function syncTeams() {
    if (!uid || !backend.saveTeam) return;
    const teams = (store.roster.teams || []).filter(t => t.id);
    const seen = new Set();
    for (const t of teams) {
      seen.add(t.id);
      const rec = (pub.t[t.id] ||= { doc: null, m: {}, p: {} });
      const doc = clean(teamDoc(t)); const df = fp(doc);
      if (rec.doc !== df) { await backend.saveTeam(t.id, doc); rec.doc = df; }
      const members = memberDocs(t), players = playerDocs(t);
      for (const [email, m] of members) { const f = fp(m); if (rec.m[email] !== f) { await backend.saveMember(t.id, email, clean(m)); rec.m[email] = f; } }
      for (const email of Object.keys(rec.m)) if (!members.has(email)) { await backend.removeMember(t.id, email); delete rec.m[email]; }
      for (const [id, pl] of players) { const f = fp(pl); if (rec.p[id] !== f) { await backend.savePlayer(t.id, id, clean(pl)); rec.p[id] = f; } }
      for (const id of Object.keys(rec.p)) if (!players.has(id)) { await backend.removePlayer(t.id, id); delete rec.p[id]; }
      // An official club team's week lists, one document per week.
      const weeks = clubDoc(t)?.weeks || {}; rec.w ||= {};
      for (const [w, list] of Object.entries(weeks)) { const f = fp(list); if (rec.w[w] !== f) { await backend.saveTasks(t.id, w, clean({ week: w, tasks: list })); rec.w[w] = f; } }
      for (const w of Object.keys(rec.w)) if (!weeks[w]) { await backend.removeTasks(t.id, w); delete rec.w[w]; }
      watchTeam(t.id);
    }
    for (const id of Object.keys(pub.t)) if (!seen.has(id)) { await backend.removeTeam(id); delete pub.t[id]; } // a team taken off the roster (its practices stay where they are)
    // Each person's own document: their teams and roles.
    const want = peopleDocs(store.roster);
    for (const [email, doc] of want) { if (email.includes('/')) continue; const f = fp(doc); if (pub.i[email] !== f) { await backend.savePerson(email, clean(doc)); pub.i[email] = f; } }
    for (const email of Object.keys(pub.i)) if (!want.has(email)) { await backend.removePerson(email); delete pub.i[email]; }
    savePub();
  }
  async function flushRoster() {
    if (!rosterTimer) return;
    clearTimeout(rosterTimer); rosterTimer = null;
    if (!uid) return;
    try { await backend.saveRoster(uid, clean(store.roster)); await syncTeams(); if (!timers.size) status('saved'); }
    catch (e) { status('error', e?.message || String(e)); }
  }
  async function flush() { for (const id of [...timers.keys()]) { clearTimeout(timers.get(id)); await flushOne(id); } await flushRoster(); }

  // ----- live updates from elsewhere, per team -----
  function watchTeam(t) {
    if (!uid || unsubs.has(t) || !backend.subscribePractices) return;
    unsubs.set(t, backend.subscribePractices(t, onChange));
  }
  function onChange(type, id, data) {
    if (type === 'error') { status('error', data?.message || String(data)); return; }
    if (timers.has(id)) return; // we have unsaved local edits to this one; ours will win when written
    applying = true;
    try {
      if (type === 'removed') {
        if (!local(id)) return;
        store.data.practices = store.data.practices.filter(p => p.id !== id);
        if (!store.live.length) store.data.practices.push(store.blankPractice());
        if (store.data.currentId === id) store.switchPractice(store.live[0].id);
        store.persist();
      } else {
        const i = store.data.practices.findIndex(p => p.id === id);
        if (i >= 0 && !newer(data, store.data.practices[i])) return;
        if (i < 0) store.data.practices.push(data); else store.data.practices[i] = data;
        const c = clean(data); pub.h[id] = fp(practiceHeader(c)); pub.b[id] = fp(practiceBody(c)); pub.loc[id] = data.teamId; savePub(); // in step: nothing to re-send
        store.migrate(); store.persist();
      }
    } finally { applying = false; }
    onRemote([id]);
  }

  // ----- initial merge -----
  async function pull() {
    status('syncing');
    loadPub();
    // The roster first: it names the teams whose practices we load. Newest copy wins, missing side copied over.
    if (backend.loadRoster) {
      try {
        const rr = await backend.loadRoster(uid);
        if (rr && (rr.updatedAt || 0) > (store.roster.updatedAt || 0)) { store.data.roster = rr; store.migrate(); store.persist(); onRoster(); }
        else if ((store.roster.updatedAt || 0) > (rr?.updatedAt || 0)) await backend.saveRoster(uid, clean(store.roster));
      } catch (e) { status('error', `team roster: ${e?.message || e} — are the latest firestore.rules deployed?`); }
    }
    const teamIds = [...new Set([...(store.roster.teams || []).map(t => t.id), ...store.data.practices.map(p => p.teamId)].filter(Boolean))];
    const remote = await backend.loadPractices(teamIds);
    const changed = [];
    applying = true;
    try {
      for (const r of remote) {
        const i = store.data.practices.findIndex(p => p.id === r.id);
        if (i < 0) { store.data.practices.push(r); changed.push(r.id); }
        else if (newer(r, store.data.practices[i])) { store.data.practices[i] = r; changed.push(r.id); }
        else if (r.teamId && store.data.practices[i].teamId !== r.teamId) { store.data.practices[i].teamId = r.teamId; changed.push(r.id); } // same copy, filed under a team in the cloud: keep it there
        const c = clean(r); pub.h[r.id] = fp(practiceHeader(c)); pub.b[r.id] = fp(practiceBody(c)); pub.loc[r.id] = r.teamId;
      }
      if (changed.length) { store.migrate(); store.persist(); }
    } finally { applying = false; }
    try {
      for (const p of store.data.practices) { const r = remote.find(x => x.id === p.id); if (!r || newer(p, r)) await pushPractice(p); }
      pub.i = Object.fromEntries((await backend.listPeople()).map(({ email, ...doc }) => [email, fp(doc)])); // the cloud is the truth about which person documents exist
      await syncTeams();
      for (const t of teamIds) watchTeam(t);
      savePub();
      onRemote(changed, { full: true });
      status(timers.size ? 'saving' : 'saved');
    } catch (e) { status('error', `sharing: ${e?.message || e} — are the latest firestore.rules deployed?`); }
  }

  // ----- auth -----
  backend.onAuthError?.(e => status('error', friendlyAuthError(e)));
  backend.onUser(async u => {
    for (const un of unsubs.values()) un(); unsubs = new Map();
    unsubRoster?.(); unsubRoster = null;
    user = u; uid = u && canSync(u) ? u.uid : null;
    if (!u) { status('signedout'); return; }
    if (!uid) { status('viewer'); return; } // a share link's viewer: the store and their account are left alone
    try {
      // The local cache belongs to whoever signed in last; another account must not inherit it.
      if (store.data.ownerUid && store.data.ownerUid !== uid) store.reset();
      store.data.ownerUid = uid; store.persist();
      await pull();
      unsubRoster = backend.subscribeRoster?.(uid, r => {
        if (rosterTimer || !r || (r.updatedAt || 0) <= (store.roster.updatedAt || 0)) return;
        store.data.roster = r; store.migrate(); store.persist(); onRoster();
        for (const t of store.roster.teams || []) if (t.id) watchTeam(t.id);
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
    signInAnon: () => backend.signInAnon?.(),
    signOut: async () => { await flush(); await backend.signOut(); },
    flush,
    get user() { return user; },
    get pending() { return timers.size; },
  };
}
