// Firestore rules test — runs against the emulator with plain REST calls (no extra npm packages):
//   npm run test:rules      (= firebase emulators:exec --only firestore --project demo-hpp "node tests/rules.test.mjs")
// Checks the server-side guarantees of docs/requirements-routing-auth.md §8.
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8787';
const BASE = `http://${HOST}/v1/projects/demo-hpp/databases/(default)/documents`;
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (uid, email, verified = true) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: uid, user_id: uid, email, email_verified: verified, iss: 'https://securetoken.google.com/demo-hpp', aud: 'demo-hpp', iat: 0, exp: 9999999999, firebase: { sign_in_provider: 'google.com', identities: {} } })}.`;
const val = v => v === null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(val) } } : { mapValue: { fields: fields(v) } };
const fields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, val(v)]));
const hdr = who => ({ 'content-type': 'application/json', authorization: `Bearer ${who === 'admin' ? 'owner' : who}` });
const get = (who, path) => fetch(`${BASE}/${path}`, { headers: hdr(who) }).then(r => r.status);
const set = (who, path, data) => fetch(`${BASE}/${path}`, { method: 'PATCH', headers: hdr(who), body: JSON.stringify({ fields: fields(data) }) }).then(r => r.status);
const del = (who, path) => fetch(`${BASE}/${path}`, { method: 'DELETE', headers: hdr(who) }).then(r => r.status);
const query = (who, parent, collectionId, where, allDescendants = false) => fetch(`${BASE}${parent ? `/${parent}` : ''}:runQuery`, { method: 'POST', headers: hdr(who), body: JSON.stringify({ structuredQuery: {
  from: [{ collectionId, allDescendants }], ...(where ? { where: { fieldFilter: { field: { fieldPath: where[0] }, op: 'EQUAL', value: val(where[1]) } } } : {}) } }) })
  .then(async r => ({ status: r.status, n: r.ok ? (await r.json()).filter(x => x.document).length : 0 }));

const PLANNER = token('own', 'ehren.eschmann@gmail.com'), COACH_A = token('ca', 'Coach.A@example.com'), COACH_B = token('cb', 'coachb@example.com');
const PARENT = token('pa', 'parent@example.com'), STRANGER = token('st', 'stranger@example.com'), FAKE = token('fk', 'parent@example.com', false);
let failed = 0, n = 0;
const ok = (name, got, want) => { n++; const pass = typeof want === 'function' ? want(got) : got === want; if (!pass) { failed++; console.log(`  ✗ ${name} — got ${JSON.stringify(got)}`); } else console.log(`  ✓ ${name}`); };
const ALLOW = 200, DENY = 403;

// ---- seed (admin bypasses rules): p1 released to the team, p2 out to coaches only, p3 a draft
const lists = { coach: ['coach.a@example.com', 'coachb@example.com'], team: ['parent@example.com'] };
for (const [pid, stage] of [['p1', 'team'], ['p2', 'coaches'], ['p3', 'draft']]) {
  await set('admin', `users/own/practices/${pid}`, { id: pid, team: 'Mites', sharedWith: lists.coach });
  await set('admin', `access/${pid}`, { stage, ...lists });
  if (stage !== 'draft') await set('admin', `published/${pid}`, { id: pid, team: 'Mites', owner: 'own' });
  await set('admin', `users/own/practices/${pid}/clips/d1`, { data: 'x' });
  await set('admin', `users/own/practices/${pid}/views/v0`, { uid: 'ca' });
}
await set('admin', 'users/own/meta/roster', { teams: [] });
await set('admin', 'inbox/parent@example.com', { persona: 'team' });
await set('admin', 'inbox/coach.a@example.com', { persona: 'coach' });
await set('admin', 'published/p1/feedback/cb_d1', { uid: 'cb', email: 'coachb@example.com', text: 'from B', drillId: 'd1' });

await set('admin', 'users/own/private/anthropic', { v: 1, data: 'ciphertext', salt: 's', iv: 'i' });
console.log('private documents (the encrypted API key record): the planner alone');
ok('planner reads own private doc', await get(PLANNER, 'users/own/private/anthropic'), ALLOW);
ok('planner writes own private doc', await set(PLANNER, 'users/own/private/anthropic', { v: 1, data: 'new', salt: 's', iv: 'i' }), ALLOW);
ok('coach cannot read the planner\'s private doc', await get(COACH_A, 'users/own/private/anthropic'), DENY);
ok('parent cannot read the planner\'s private doc', await get(PARENT, 'users/own/private/anthropic'), DENY);
ok('stranger cannot write a private doc under the planner', await set(STRANGER, 'users/own/private/anthropic', { data: 'x' }), DENY);
ok('planner deletes own private doc', await del(PLANNER, 'users/own/private/anthropic'), ALLOW);

await set('admin', 'club/t1', { id: 't1', name: 'Mites', tasks: [{ id: 'k1', title: 'Shots', unit: 'shots', target: 100 }], coaches: ['coach.a@example.com'], members: ['coach.a@example.com', 'parent@example.com'], players: { pl1: { name: 'Sam', contacts: ['parent@example.com'] }, pl2: { name: 'Alex', contacts: [] } } });
await set('admin', 'club/t1/stats/pl2_2026-W41', { playerId: 'pl2', week: '2026-W41', values: { k1: 40 }, by: 'coach.a@example.com' });
console.log('official club team: tasks for members, numbers by family or coach');
ok('planner writes the club doc', await set(PLANNER, 'club/t1', { id: 't1', name: 'Mites', tasks: [], coaches: ['coach.a@example.com'], members: ['coach.a@example.com', 'parent@example.com'], players: { pl1: { name: 'Sam', contacts: ['parent@example.com'] }, pl2: { name: 'Alex', contacts: [] } } }), ALLOW);
ok('a coach reads the club doc', await get(COACH_A, 'club/t1'), ALLOW);
ok('a family reads the club doc', await get(PARENT, 'club/t1'), ALLOW);
ok('a stranger cannot read the club doc', await get(STRANGER, 'club/t1'), DENY);
ok('a coach cannot rewrite the club doc', await set(COACH_A, 'club/t1', { tasks: [] }), DENY);
const stat = (pid, by, extra = {}) => ({ playerId: pid, week: '2026-W41', values: { k1: 25 }, by, ...extra });
ok('a parent logs their own player\'s week', await set(PARENT, 'club/t1/stats/pl1_2026-W41', stat('pl1', 'parent@example.com')), ALLOW);
ok('…and updates it', await set(PARENT, 'club/t1/stats/pl1_2026-W41', stat('pl1', 'parent@example.com', { values: { k1: 30 } })), ALLOW);
ok('a parent cannot log for another player', await set(PARENT, 'club/t1/stats/pl2_2026-W41', stat('pl2', 'parent@example.com')), DENY);
ok('a parent cannot sign as someone else', await set(PARENT, 'club/t1/stats/pl1_2026-W40', stat('pl1', 'coach.a@example.com', { week: '2026-W40' })), DENY);
ok('the document id must match player and week', await set(PARENT, 'club/t1/stats/pl1_2026-W39', stat('pl1', 'parent@example.com')), DENY);
ok('a coach logs for any player', await set(COACH_A, 'club/t1/stats/pl2_2026-W42', stat('pl2', 'coach.a@example.com', { week: '2026-W42' })), ALLOW);
ok('a parent reads their player\'s week', await get(PARENT, 'club/t1/stats/pl1_2026-W41'), ALLOW);
ok('a parent cannot read another player\'s week', await get(PARENT, 'club/t1/stats/pl2_2026-W41'), DENY);
ok('a coach reads any player\'s week', await get(COACH_A, 'club/t1/stats/pl1_2026-W41'), ALLOW);
ok('a coach lists the week\'s numbers for the whole team', await query(COACH_A, 'club/t1', 'stats', ['week', '2026-W41']), r => r.status === 200 && r.n === 2);
ok('a parent lists their own player\'s weeks', await query(PARENT, 'club/t1', 'stats', ['playerId', 'pl1']), r => r.status === 200 && r.n === 1);
ok('a parent cannot list the whole team', await query(PARENT, 'club/t1', 'stats', ['week', '2026-W41']), r => r.status !== 200);
ok('a stranger gets nothing', await get(STRANGER, 'club/t1/stats/pl1_2026-W41'), DENY);
ok('only the planner deletes numbers', await del(PARENT, 'club/t1/stats/pl1_2026-W41'), DENY);
ok('the planner reads everything', await get(PLANNER, 'club/t1/stats/pl1_2026-W41'), ALLOW);

console.log('working document, roster, access lists: planner only');
ok('planner reads own working doc', await get(PLANNER, 'users/own/practices/p1'), ALLOW);
ok('planner writes own working doc', await set(PLANNER, 'users/own/practices/p1', { id: 'p1', team: 'Mites' }), ALLOW);
for (const [who, t] of [['coach', COACH_A], ['parent', PARENT], ['stranger', STRANGER]]) {
  ok(`${who} cannot read the working doc`, await get(t, 'users/own/practices/p1'), DENY);
  ok(`${who} cannot read the roster`, await get(t, 'users/own/meta/roster'), DENY);
  ok(`${who} cannot read access lists`, await get(t, 'access/p1'), DENY);
  ok(`${who} cannot read the view log`, await get(t, 'users/own/practices/p1/views/v0'), DENY);
  ok(`${who} cannot write a published practice`, await set(t, 'published/p1', { id: 'p1', team: 'hacked' }), DENY);
  ok(`${who} cannot write access lists`, await set(t, 'access/p1', { stage: 'team', coach: [], team: ['stranger@example.com'] }), DENY);
  ok(`${who} cannot write an inbox`, await set(t, 'inbox/stranger@example.com', { persona: 'coach' }), DENY);
}
ok('a non-planner cannot create practices in their own account', await set(COACH_A, 'users/ca/practices/x', { id: 'x' }), DENY);

console.log('published copy follows the stage');
ok('coach reads a practice out to coaches (email matched case-insensitively)', await get(COACH_A, 'published/p2'), ALLOW);
ok('coach reads a released practice', await get(COACH_A, 'published/p1'), ALLOW);
ok('parent reads a released practice', await get(PARENT, 'published/p1'), ALLOW);
ok('parent cannot read a practice still with the coaches', await get(PARENT, 'published/p2'), DENY);
ok('nobody but the planner reads a draft', await get(COACH_A, 'published/p3'), DENY);
ok('stranger reads nothing', await get(STRANGER, 'published/p1'), DENY);
ok('unverified email with a parent\'s address reads nothing', await get(FAKE, 'published/p1'), DENY);
ok('planner reads any published copy', await get(PLANNER, 'published/p2'), ALLOW);
ok('parent reads a released practice\'s clip', await get(PARENT, 'users/own/practices/p1/clips/d1'), ALLOW);
ok('parent cannot read a clip of an unreleased practice', await get(PARENT, 'users/own/practices/p2/clips/d1'), DENY);
ok('parent logs a view in their own name', await set(PARENT, 'users/own/practices/p1/views/v1', { uid: 'pa', action: 'view' }), ALLOW);
ok('parent cannot log a view as someone else', await set(PARENT, 'users/own/practices/p1/views/v2', { uid: 'ca', action: 'view' }), DENY);
ok('planner logs their own preview', await set(PLANNER, 'users/own/practices/p1/views/v3', { uid: 'own', action: 'view', audience: 'planner' }), ALLOW);
ok('planner logs a view of a draft', await set(PLANNER, 'users/own/practices/p3/views/v4', { uid: 'own', action: 'view', audience: 'planner' }), ALLOW);
ok('planner reads the log', await query(PLANNER, 'users/own/practices/p1', 'views'), r => r.status === 200 && r.n >= 2);
ok('coach cannot list the log', (await query(COACH_A, 'users/own/practices/p1', 'views')).status, DENY);

console.log('feedback: coaches write their own, never see each other\'s; the team has none');
const fb = { uid: 'ca', email: 'coach.a@example.com', name: 'Coach A', text: 'too long', drillId: 'd1', at: 1 };
ok('coach A writes feedback', await set(COACH_A, 'published/p1/feedback/ca_d1', fb), ALLOW);
ok('coach A edits it', await set(COACH_A, 'published/p1/feedback/ca_d1', { ...fb, text: 'shorter' }), ALLOW);
ok('coach A reads it back', await get(COACH_A, 'published/p1/feedback/ca_d1'), ALLOW);
ok('coach A cannot read coach B\'s', await get(COACH_A, 'published/p1/feedback/cb_d1'), DENY);
ok('coach A cannot write in coach B\'s name', await set(COACH_A, 'published/p1/feedback/cb_d2', { ...fb, uid: 'cb', email: 'coachb@example.com' }), DENY);
ok('coach A cannot overwrite coach B\'s', await set(COACH_A, 'published/p1/feedback/cb_d1', fb), DENY);
ok('coach A cannot mark their own resolved', await set(COACH_A, 'published/p1/feedback/ca_d1', { ...fb, resolved: true }), DENY);
ok('coach A lists their own feedback', await query(COACH_A, 'published/p1', 'feedback', ['uid', 'ca']), r => r.status === 200 && r.n === 1);
ok('coach A cannot list everyone\'s feedback', (await query(COACH_A, 'published/p1', 'feedback')).status, DENY);
ok('parent cannot write feedback', await set(PARENT, 'published/p1/feedback/pa_d1', { ...fb, uid: 'pa', email: 'parent@example.com' }), DENY);
ok('parent cannot read feedback', await get(PARENT, 'published/p1/feedback/ca_d1'), DENY);
ok('parent cannot list feedback', (await query(PARENT, 'published/p1', 'feedback', ['uid', 'ca'])).status, DENY);
ok('planner reads all feedback in one query', await query(PLANNER, '', 'feedback', null, true), r => r.status === 200 && r.n === 2);
ok('planner marks feedback resolved', await set(PLANNER, 'published/p1/feedback/ca_d1', { ...fb, text: 'shorter', resolved: true }), ALLOW);
ok('coach A rewriting it makes it unresolved again', await set(COACH_A, 'published/p1/feedback/ca_d1', { ...fb, text: 'still too long' }), ALLOW);
ok('coach A deletes their own', await del(COACH_A, 'published/p1/feedback/ca_d1'), ALLOW);

console.log('inbox: each person reads only their own list');
ok('parent reads their inbox', await get(PARENT, 'inbox/parent@example.com'), ALLOW);
ok('coach (mixed-case address) reads their inbox', await get(COACH_A, 'inbox/coach.a@example.com'), ALLOW);
ok('parent cannot read a coach\'s inbox', await get(PARENT, 'inbox/coach.a@example.com'), DENY);
ok('stranger\'s own (missing) inbox is readable — it just does not exist', await get(STRANGER, 'inbox/stranger@example.com'), 404);
ok('nobody but the planner lists inboxes', (await query(PARENT, '', 'inbox')).status, DENY);

console.log('access requests');
const req = { uid: 'st', email: 'stranger@example.com', name: 'Gran', role: 'team', note: "Sam's grandma", status: 'open', at: 1 };
ok('stranger files a request', await set(STRANGER, 'requests/st', req), ALLOW);
ok('stranger reads their own request', await get(STRANGER, 'requests/st'), ALLOW);
ok('stranger cannot file one for someone else', await set(STRANGER, 'requests/pa', { ...req, uid: 'pa' }), DENY);
ok('stranger cannot use another email', await set(STRANGER, 'requests/st', { ...req, email: 'parent@example.com' }), DENY);
ok('stranger cannot approve themselves', await set(STRANGER, 'requests/st', { ...req, status: 'approved' }), DENY);
ok('parent cannot read the request', await get(PARENT, 'requests/st'), DENY);
ok('planner lists requests', await query(PLANNER, '', 'requests'), r => r.status === 200 && r.n === 1);
ok('planner denies it', await set(PLANNER, 'requests/st', { ...req, status: 'denied', deniedAt: Date.now() }), ALLOW);
ok('a denied account cannot re-request right away', await set(STRANGER, 'requests/st', req), DENY);
await set('admin', 'requests/st', { ...req, status: 'denied', deniedAt: Date.now() - 8 * 86400000 });
ok('…but can after 7 days', await set(STRANGER, 'requests/st', req), ALLOW);
ok('stranger cannot delete requests', await del(STRANGER, 'requests/st'), DENY);

console.log('sign-ins without access are recorded, in their own name only');
const att = { uid: 'st', email: 'stranger@example.com', name: 'Gran', path: '/coach/p1', at: 1, count: 1 };
ok('stranger records their failed sign-in', await set(STRANGER, 'attempts/st', att), ALLOW);
ok('…and updates it next time', await set(STRANGER, 'attempts/st', { ...att, at: 2, count: 2 }), ALLOW);
ok('stranger cannot record it under another account', await set(STRANGER, 'attempts/pa', { ...att, uid: 'pa' }), DENY);
ok('stranger cannot claim another email', await set(STRANGER, 'attempts/st', { ...att, email: 'parent@example.com' }), DENY);
ok('stranger cannot read attempts (not even their own)', await get(STRANGER, 'attempts/st'), DENY);
ok('parent cannot list attempts', (await query(PARENT, '', 'attempts')).status, DENY);
ok('planner lists attempts', await query(PLANNER, '', 'attempts'), r => r.status === 200 && r.n === 1);
ok('planner clears one', await del(PLANNER, 'attempts/st'), ALLOW);
ok('stranger cannot delete', await del(STRANGER, 'attempts/st'), DENY);

console.log('revocation');
await set('admin', 'access/p1', { stage: 'team', coach: ['coachb@example.com'], team: [] });
ok('a coach removed from the list is denied on the next read', await get(COACH_A, 'published/p1'), DENY);
ok('a parent removed from the list is denied on the next read', await get(PARENT, 'published/p1'), DENY);
await set('admin', 'access/p1', { stage: 'draft', ...lists });
ok('pulling a practice back to draft removes access', await get(COACH_B, 'published/p1'), DENY);

console.log(`\n${n - failed} / ${n} passed`);
process.exit(failed ? 1 : 0);
