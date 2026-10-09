// A stand-in for Firestore + Google sign-in for the browser tests: an in-memory document store behind HTTP that
// enforces the same authorization as firestore.rules (which is tested for real in rules.test.mjs), plus the
// page-side backend that js/main.js picks up through globalThis.__hppBackend. Paths mirror the team layout
// (docs/data-model.md): teams/{t}/practices/{pid} is the header, …/plan/body the drills.
import { createServer } from 'node:http';

const PLANNERS = ['ehren.eschmann@gmail.com'];
export function startFakeCloud(port) {
  const db = new Map(); // path → data
  const log = [];       // every request: { user, op, path, ok }
  const email = u => (u?.email || '').toLowerCase();
  const signedIn = u => !!u && !u.isAnonymous && !!email(u);
  const isPlanner = u => signedIn(u) && PLANNERS.includes(email(u));
  const isAdmin = (u, t) => isPlanner(u) || (signedIn(u) && (db.get(`teams/${t}`)?.admins || []).includes(email(u)));
  const member = (u, t) => signedIn(u) ? db.get(`teams/${t}/members/${email(u)}`) : null;
  const isMember = (u, t) => !!member(u, t);
  const isCoach = (u, t) => member(u, t)?.role === 'coach';
  const viewable = (u, t, h) => !!h && ((h.stage === 'team' && isMember(u, t)) || (h.stage === 'coaches' && isCoach(u, t))
    || (h.stage !== 'draft' && h.open === true && !!u) || (signedIn(u) && h.stage !== 'draft' && (h.sharedWith || []).includes(email(u)))
    || (signedIn(u) && h.stage === 'team' && (h.sharedTeam || []).includes(email(u))));
  const header = (t, pid) => db.get(`teams/${t}/practices/${pid}`);
  const canView = (u, t, pid) => isAdmin(u, t) || viewable(u, t, header(t, pid));
  const coachOf = (u, t, pid) => isCoach(u, t) && !!header(t, pid) && header(t, pid).stage !== 'draft';
  function allowed(u, op, path, data) {
    const seg = path.split('/'), cur = db.get(path), write = op === 'set' || op === 'delete';
    if (seg[0] === 'teams') {
      const t = seg[1];
      if (seg.length === 2) return write ? isAdmin(u, t) : isAdmin(u, t) || isMember(u, t);
      if (seg[2] === 'members') return write ? isAdmin(u, t) : isAdmin(u, t) || (signedIn(u) && email(u) === seg[3]) || isCoach(u, t) || (op === 'list' && isAdmin(u, t));
      if (['players', 'tasks', 'media'].includes(seg[2])) return write ? isAdmin(u, t) : isAdmin(u, t) || isMember(u, t);
      if (seg[2] === 'stats') return write ? isAdmin(u, t) || isCoach(u, t) || signedIn(u) : isAdmin(u, t) || isCoach(u, t) || signedIn(u);
      if (seg[2] !== 'practices') return false;
      const pid = seg[3];
      if (seg.length === 3 && op === 'list') { // headers: admins list all; anyone else only with a stage filter every match passes
        if (isAdmin(u, t)) return true;
        if (data?.where?.[0] !== 'stage' || !Array.isArray(data.where[1])) return false;
        return [...db.entries()].filter(([k, v]) => k.startsWith(`${path}/`) && k.split('/').length === 4 && data.where[1].includes(v.stage)).every(([, v]) => viewable(u, t, v));
      }
      if (seg.length === 4) return write ? isAdmin(u, t) : isAdmin(u, t) || viewable(u, t, cur);
      if (['plan', 'clips', 'videos'].includes(seg[4])) return write ? isAdmin(u, t) : canView(u, t, pid);
      if (seg[4] === 'views') return op === 'set' && !cur ? canView(u, t, pid) && data.uid === u?.uid : isAdmin(u, t);
      if (seg[4] === 'feedback') {
        if (isAdmin(u, t)) return true;
        if (!coachOf(u, t, pid)) return false;
        if (op === 'list') return data?.where?.[0] === 'uid' && data.where[1] === u.uid;
        const mine = d => d.uid === u.uid && d.email === email(u) && new RegExp(`^${u.uid}_[A-Za-z0-9]+$`).test(seg[5]) && typeof d.text === 'string';
        if (op === 'set') return mine(data) && !data.resolved && (!cur || cur.uid === u.uid);
        return !!cur && cur.uid === u.uid;
      }
      return false;
    }
    if (seg[0] === 'feedback*') return isPlanner(u); // collection group
    if (seg[0] === 'practiceIndex') return write ? isPlanner(u) : !!u;
    if (seg[0] === 'people') return write || op === 'list' ? isPlanner(u) : isPlanner(u) || (signedIn(u) && email(u) === seg[1]);
    if (seg[0] === 'users') {
      const own = !!u && u.uid === seg[1];
      if (seg[2] === 'meta') return write ? isPlanner(u) && own : own;
      if (seg[2] === 'private') return isPlanner(u) && own;
      return false;
    }
    if (seg[0] === 'attempts') {
      if (isPlanner(u)) return true;
      return op === 'set' && signedIn(u) && seg[1] === u.uid && data.uid === u.uid && data.email === email(u) && typeof data.name === 'string' && typeof data.path === 'string';
    }
    if (seg[0] === 'requests') {
      if (isPlanner(u)) return true;
      if (!signedIn(u) || op === 'list' || op === 'delete' || seg[1] !== u.uid) return false;
      if (op === 'get') return true;
      return data.uid === u.uid && data.email === email(u) && data.status === 'open' && ['coach', 'team'].includes(data.role)
        && (!cur || cur.status !== 'denied' || Date.now() > cur.deniedAt + 604800000);
    }
    return false;
  }
  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*');
    if (req.method === 'OPTIONS') return res.end();
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { user, op, path, data } = JSON.parse(body || '{}');
      const ok = allowed(user, op, path, data);
      log.push({ user: email(user) || null, op, path, ok });
      let out = { ok };
      if (!ok) out.error = 'permission-denied';
      else if (op === 'get') out.data = db.get(path) ?? null;
      else if (op === 'set') db.set(path, data);
      else if (op === 'delete') db.delete(path);
      else if (op === 'list') {
        const group = path.endsWith('*') ? path.slice(0, -1) : null; // "feedback*" = every feedback collection
        const match = (v, w) => !w || (Array.isArray(w[1]) ? w[1].includes(v[w[0]]) : v[w[0]] === w[1]);
        out.data = [...db.entries()].filter(([k]) => group ? k.split('/').at(-2) === group : k.startsWith(`${path}/`) && k.split('/').length === path.split('/').length + 1)
          .filter(([, v]) => match(v, data?.where)).map(([k, v]) => ({ path: k, data: v }));
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
    });
  }).listen(port);
  return { db, log, close: () => server.close() };
}

/** Source of the page-side backend; `user` is who is signed in at load, `signInAs` who a press of "Sign in" produces. */
export const pageBackend = (port, user, signInAs) => `
(() => {
  let user = ${JSON.stringify(user)}, onUser = () => {};
  const call = async (op, path, data) => {
    const r = await (await fetch('http://127.0.0.1:${port}/', { method: 'POST', body: JSON.stringify({ user, op, path, data }) })).json();
    if (!r.ok) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    return r.data;
  };
  // "live" subscriptions: poll, report changes and errors the way onSnapshot does
  const watch = (read, cb) => { let last, dead = false; const tick = async () => { if (dead) return;
      try { const v = await read(); const j = JSON.stringify(v); if (j !== last) { last = j; cb(v, null); } } catch (e) { if (last !== 'ERR') { last = 'ERR'; cb(null, e); } }
      setTimeout(tick, 250); }; tick(); return () => { dead = true; }; };
  const id = p => p.split('/').at(-1);
  const P = (t, pid) => 'teams/' + t + '/practices/' + pid, B = (t, pid) => P(t, pid) + '/plan/body';
  const SUBS = ['clips', 'videos', 'views', 'feedback'];
  const parts = (h, b) => h ? { ...h, ...(b || {}), drills: b?.drills || [] } : null;
  const merged = async (t, h) => parts(h, await call('get', B(t, h.id)));
  globalThis.__hppBackend = {
    onUser(cb) { onUser = cb; setTimeout(() => cb(user), 30); return () => {}; },
    async signIn() { user = ${JSON.stringify(signInAs)}; onUser(user); },
    async signOut() { user = null; onUser(null); },
    async loadPractices(teamIds) { const out = []; for (const t of teamIds) for (const x of await call('list', 'teams/' + t + '/practices')) out.push(await merged(t, x.data)); return out; },
    async savePractice(p, { body = true } = {}) {
      const { drills, ...h } = p; const t = p.teamId;
      const shown = (drills || []).filter(d => !d.hidden); // the header's summary, as practiceHeader() writes it
      await call('set', P(t, p.id), { ...h, stage: p.stage || 'draft', drillCount: shown.length, drillNames: shown.map(d => d.name || ''), minutes: shown.reduce((a, d) => a + (+d.duration || 0), 0) });
      if (body) await call('set', B(t, p.id), { id: p.id, teamId: t, drills: drills || [], updatedAt: p.updatedAt || 0 });
      await call('set', 'practiceIndex/' + p.id, { teamId: t });
    },
    async removePractice(t, pid) { for (const n of SUBS) for (const x of await call('list', P(t, pid) + '/' + n)) await call('delete', x.path); await call('delete', B(t, pid)); await call('delete', P(t, pid)); await call('delete', 'practiceIndex/' + pid); },
    async movePractice(from, to, p) { for (const n of SUBS) for (const x of await call('list', P(from, p.id) + '/' + n)) await call('set', P(to, p.id) + '/' + n + '/' + id(x.path), x.data); await this.savePractice({ ...p, teamId: to }); await this.removePractice(from, p.id); },
    subscribePractices: () => () => {},
    saveTeam: (t, d) => call('set', 'teams/' + t, d), loadTeam: t => call('get', 'teams/' + t),
    async removeTeam(t) { for (const n of ['members', 'players']) for (const x of await call('list', 'teams/' + t + '/' + n)) await call('delete', x.path); await call('delete', 'teams/' + t); },
    saveMember: (t, e, d) => call('set', 'teams/' + t + '/members/' + e, d), removeMember: (t, e) => call('delete', 'teams/' + t + '/members/' + e),
    savePlayer: (t, i, d) => call('set', 'teams/' + t + '/players/' + i, d), removePlayer: (t, i) => call('delete', 'teams/' + t + '/players/' + i),
    loadPlayers: async t => Object.fromEntries((await call('list', 'teams/' + t + '/players')).map(x => [id(x.path), x.data])),
    listPeople: async () => (await call('list', 'people')).map(x => ({ email: id(x.path), ...x.data })),
    savePerson: (e, d) => call('set', 'people/' + e, d), removePerson: e => call('delete', 'people/' + e),
    subscribePerson: (e, cb) => watch(() => call('get', 'people/' + e), cb),
    lookupTeam: async pid => (await call('get', 'practiceIndex/' + pid))?.teamId || null,
    subscribeTeamPractices: (t, stages, cb) => watch(async () => (await call('list', 'teams/' + t + '/practices', { where: ['stage', stages] })).map(x => x.data), cb),
    subscribePractice: (t, pid, cb) => watch(async () => { const h = await call('get', P(t, pid)); return h ? merged(t, h) : null; }, cb),
    saveTasks: (t, w, d) => call('set', 'teams/' + t + '/tasks/' + w, d), removeTasks: (t, w) => call('delete', 'teams/' + t + '/tasks/' + w), loadTasks: (t, w) => call('get', 'teams/' + t + '/tasks/' + w),
    saveStat: (t, d) => call('set', 'teams/' + t + '/stats/' + d.playerId + '_' + d.week, d),
    loadWeekStats: async (t, w) => (await call('list', 'teams/' + t + '/stats', { where: ['week', w] })).map(x => x.data),
    loadPlayerStats: async (t, p) => (await call('list', 'teams/' + t + '/stats', { where: ['playerId', p] })).map(x => x.data),
    saveClubMedia: (t, i, d) => call('set', 'teams/' + t + '/media/' + i, d), loadClubMedia: (t, i) => call('get', 'teams/' + t + '/media/' + i), removeClubMedia: (t, i) => call('delete', 'teams/' + t + '/media/' + i),
    saveFeedback: (t, pid, fid, d) => call('set', P(t, pid) + '/feedback/' + fid, d),
    removeFeedback: (t, pid, fid) => call('delete', P(t, pid) + '/feedback/' + fid),
    loadMyFeedback: async (t, pid, uid) => (await call('list', P(t, pid) + '/feedback', { where: ['uid', uid] })).map(x => ({ fid: id(x.path), ...x.data })),
    subscribeAllFeedback: cb => watch(async () => (await call('list', 'feedback*')).map(x => ({ fid: id(x.path), pid: x.path.split('/')[3], teamId: x.path.split('/')[1], ...x.data })), cb),
    resolveFeedback: async (t, pid, fid, resolved) => { const p = P(t, pid) + '/feedback/' + fid; await call('set', p, { ...(await call('get', p)), resolved }); },
    logAttempt: async (uid, a) => { let n = 0; try { n = +(window.__att || 0); } catch {} window.__att = n + 1; await call('set', 'attempts/' + uid, { ...a, count: n + 1 }); },
    subscribeAttempts: cb => watch(async () => (await call('list', 'attempts')).map(x => x.data), cb),
    removeAttempt: uid => call('delete', 'attempts/' + uid),
    loadRequest: uid => call('get', 'requests/' + uid), saveRequest: (uid, r) => call('set', 'requests/' + uid, r),
    denyRequest: async uid => call('set', 'requests/' + uid, { ...(await call('get', 'requests/' + uid)), status: 'denied', deniedAt: Date.now() }),
    removeRequest: uid => call('delete', 'requests/' + uid),
    subscribeRequests: cb => watch(async () => (await call('list', 'requests')).map(x => x.data), cb),
    savePrivate: (uid, n, d) => call('set', 'users/' + uid + '/private/' + n, d), loadPrivate: (uid, n) => call('get', 'users/' + uid + '/private/' + n), removePrivate: (uid, n) => call('delete', 'users/' + uid + '/private/' + n),
    saveClip: (t, pid, did, c) => call('set', P(t, pid) + '/clips/' + did, c), loadClip: (t, pid, did) => call('get', P(t, pid) + '/clips/' + did), removeClip: (t, pid, did) => call('delete', P(t, pid) + '/clips/' + did),
    logView: (t, pid, e) => call('set', P(t, pid) + '/views/' + Math.random().toString(36).slice(2), e),
    loadViews: async (t, pid) => (await call('list', P(t, pid) + '/views')).map(x => ({ id: id(x.path), ...x.data })).sort((a, b) => b.at - a.at),
    clearViews: async (t, pid) => { for (const x of await call('list', P(t, pid) + '/views')) await call('delete', x.path); },
    loadRoster: uid => call('get', 'users/' + uid + '/meta/roster'), saveRoster: (uid, r) => call('set', 'users/' + uid + '/meta/roster', r), subscribeRoster: () => () => {},
  };
})();`;
