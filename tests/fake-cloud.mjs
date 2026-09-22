// A stand-in for Firestore + Google sign-in for the browser tests: an in-memory document store behind HTTP that
// enforces the same authorization as firestore.rules (which is tested for real in rules.test.mjs), plus the
// page-side backend that js/main.js picks up through globalThis.__hppBackend.
import { createServer } from 'node:http';

const PLANNERS = ['ehren.eschmann@gmail.com'];
export function startFakeCloud(port) {
  const db = new Map(); // path → data
  const log = [];       // every request: { user, op, path, ok }
  const email = u => (u?.email || '').toLowerCase();
  const isPlanner = u => !!u && PLANNERS.includes(email(u));
  const acc = pid => db.get(`access/${pid}`);
  const isCoachOf = (u, pid) => !!u && !!acc(pid) && ['coaches', 'team'].includes(acc(pid).stage) && acc(pid).coach.includes(email(u));
  const isTeamOf = (u, pid) => !!u && !!acc(pid) && acc(pid).stage === 'team' && acc(pid).team.includes(email(u));
  const canView = (u, pid) => isPlanner(u) || isCoachOf(u, pid) || isTeamOf(u, pid);
  function allowed(u, op, path, data) {
    const seg = path.split('/'), cur = db.get(path), write = op === 'set' || op === 'delete';
    if (seg[0] === 'users') {
      const own = !!u && u.uid === seg[1];
      if (seg[2] === 'meta' || seg.length === 4 || (seg.length === 3 && op === 'list')) return write ? isPlanner(u) && own : own;
      if (seg[4] === 'views') return op === 'set' && !cur ? canView(u, seg[3]) && data.uid === u.uid : isPlanner(u) && own;
      return write ? isPlanner(u) && own : canView(u, seg[3]); // clips, videos
    }
    if (seg[0] === 'published' && seg.length === 2) return write ? isPlanner(u) : canView(u, seg[1]);
    if (seg[0] === 'published' && seg[2] === 'feedback') {
      if (isPlanner(u)) return true;
      if (!isCoachOf(u, seg[1])) return false;
      if (op === 'list') return data?.where?.[0] === 'uid' && data.where[1] === u.uid;
      const mine = d => d.uid === u.uid && d.email === email(u) && new RegExp(`^${u.uid}_[A-Za-z0-9]+$`).test(seg[3]) && typeof d.text === 'string';
      if (op === 'set') return mine(data) && !data.resolved && (!cur || cur.uid === u.uid);
      return !!cur && cur.uid === u.uid;
    }
    if (seg[0] === 'feedback*') return isPlanner(u); // collection group
    if (seg[0] === 'access') return isPlanner(u);
    if (seg[0] === 'inbox') return write || op === 'list' ? isPlanner(u) : isPlanner(u) || (!!u && email(u) === seg[1]);
    if (seg[0] === 'requests') {
      if (isPlanner(u)) return true;
      if (!u || op === 'list' || op === 'delete' || seg[1] !== u.uid) return false;
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
        out.data = [...db.entries()].filter(([k]) => group ? k.split('/').at(-2) === group : k.startsWith(`${path}/`) && k.split('/').length === path.split('/').length + 1)
          .filter(([, v]) => !data?.where || v[data.where[0]] === data.where[1]).map(([k, v]) => ({ path: k, data: v }));
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
  globalThis.__hppBackend = {
    onUser(cb) { onUser = cb; setTimeout(() => cb(user), 30); return () => {}; },
    async signIn() { user = ${JSON.stringify(signInAs)}; onUser(user); },
    async signOut() { user = null; onUser(null); },
    load: async uid => (await call('list', 'users/' + uid + '/practices')).map(x => x.data),
    save: (uid, p) => call('set', 'users/' + uid + '/practices/' + p.id, p),
    remove: (uid, pid) => call('delete', 'users/' + uid + '/practices/' + pid),
    subscribe: () => () => {},
    loadRoster: uid => call('get', 'users/' + uid + '/meta/roster'), saveRoster: (uid, r) => call('set', 'users/' + uid + '/meta/roster', r), subscribeRoster: () => () => {},
    savePublished: (pid, c) => call('set', 'published/' + pid, c), removePublished: pid => call('delete', 'published/' + pid),
    saveAccess: (pid, a) => call('set', 'access/' + pid, a), removeAccess: pid => call('delete', 'access/' + pid),
    loadInboxes: async () => (await call('list', 'inbox')).map(x => ({ email: id(x.path), ...x.data })),
    saveInbox: (e, d) => call('set', 'inbox/' + e, d), removeInbox: e => call('delete', 'inbox/' + e),
    subscribeInbox: (e, cb) => watch(() => call('get', 'inbox/' + e), cb),
    subscribePublished: (pid, cb) => watch(() => call('get', 'published/' + pid), cb),
    saveFeedback: (pid, fid, d) => call('set', 'published/' + pid + '/feedback/' + fid, d),
    removeFeedback: (pid, fid) => call('delete', 'published/' + pid + '/feedback/' + fid),
    loadMyFeedback: async (pid, uid) => (await call('list', 'published/' + pid + '/feedback', { where: ['uid', uid] })).map(x => ({ fid: id(x.path), ...x.data })),
    subscribeAllFeedback: cb => watch(async () => (await call('list', 'feedback*')).map(x => ({ fid: id(x.path), pid: x.path.split('/')[1], ...x.data })), cb),
    resolveFeedback: async (pid, fid, resolved) => { const p = 'published/' + pid + '/feedback/' + fid; await call('set', p, { ...(await call('get', p)), resolved }); },
    loadRequest: uid => call('get', 'requests/' + uid), saveRequest: (uid, r) => call('set', 'requests/' + uid, r),
    denyRequest: async uid => call('set', 'requests/' + uid, { ...(await call('get', 'requests/' + uid)), status: 'denied', deniedAt: Date.now() }),
    removeRequest: uid => call('delete', 'requests/' + uid),
    subscribeRequests: cb => watch(async () => (await call('list', 'requests')).map(x => x.data), cb),
    logView: (uid, pid, e) => call('set', 'users/' + uid + '/practices/' + pid + '/views/' + Math.random().toString(36).slice(2), e),
    loadViews: async (uid, pid) => (await call('list', 'users/' + uid + '/practices/' + pid + '/views')).map(x => ({ id: id(x.path), ...x.data })).sort((a, b) => b.at - a.at),
    clearViews: async (uid, pid) => { for (const x of await call('list', 'users/' + uid + '/practices/' + pid + '/views')) await call('delete', x.path); },
  };
})();`;
