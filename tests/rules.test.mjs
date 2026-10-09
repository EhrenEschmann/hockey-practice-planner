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

const GUEST = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'gu', user_id: 'gu', iss: 'https://securetoken.google.com/demo-hpp', aud: 'demo-hpp', iat: 0, exp: 9999999999, firebase: { sign_in_provider: 'anonymous', identities: {} } })}.`;
const GUESTEMAIL = token('ge', 'guest@example.com'), SQ = token('sq', 'sq@example.com');
const queryIn = (who, parent, collectionId, field, values) => fetch(`${BASE}/${parent}:runQuery`, { method: 'POST', headers: hdr(who), body: JSON.stringify({ structuredQuery: {
  from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath: field }, op: 'IN', value: val(values) } } } }) }).then(async r => ({ status: r.status, n: r.ok ? (await r.json()).filter(x => x.document).length : 0 }));

// ---- seed (admin bypasses rules): team t1 with coaches A and B, Sam's parent; p1 released, p2 with coaches, p3 draft, p4 open, p5 shared with an extra email
await set('admin', 'teams/t1', { id: 't1', name: 'Mites', club: true, admins: [] });
await set('admin', 'teams/t1/members/coach.a@example.com', { role: 'coach', name: 'Coach A' });
await set('admin', 'teams/t1/members/coachb@example.com', { role: 'coach', name: 'Coach B' });
await set('admin', 'teams/t1/members/parent@example.com', { role: 'family', name: 'Pat', playerIds: ['pl1'] });
await set('admin', 'teams/t1/players/pl1', { name: 'Sam', contacts: ['parent@example.com'] });
await set('admin', 'teams/t1/players/pl2', { name: 'Alex', contacts: [] });
for (const [pid, h] of [['p1', { stage: 'team' }], ['p2', { stage: 'coaches' }], ['p3', { stage: 'draft' }], ['p4', { stage: 'team', open: true }], ['p5', { stage: 'coaches', sharedWith: ['guest@example.com'] }]]) {
  await set('admin', `teams/t1/practices/${pid}`, { id: pid, teamId: 't1', team: 'Mites', date: '2026-10-0' + pid[1], kind: 'practice', ...h });
  await set('admin', `teams/t1/practices/${pid}/plan/body`, { id: pid, drills: [{ id: 'd1' }] });
  await set('admin', `teams/t1/practices/${pid}/clips/d1`, { data: 'x' });
  await set('admin', `teams/t1/practices/${pid}/videos/d1_1_0`, { data: 'x', i: 0, n: 1 });
  await set('admin', `teams/t1/practices/${pid}/views/v0`, { uid: 'ca' });
  await set('admin', `practiceIndex/${pid}`, { teamId: 't1' });
}
await set('admin', 'teams/t1/practices/p1/feedback/cb_d1', { uid: 'cb', email: 'coachb@example.com', text: 'from B', drillId: 'd1' });
await set('admin', 'teams/t1/tasks/2026-10-04', { week: '2026-10-04', tasks: [{ id: 'k1', title: 'Shots', unit: 'shots', target: 25, times: 3 }] });
await set('admin', 'teams/t1/stats/pl2_2026-10-04', { playerId: 'pl2', week: '2026-10-04', values: { k1: 40 }, by: 'coach.a@example.com' });
await set('admin', 'teams/t1/media/k1_audio', { mime: 'audio/webm', data: 'abc', secs: 3, at: 1 });
await set('admin', 'teams/t2', { id: 't2', name: 'Squirts', admins: [] });
await set('admin', 'teams/t2/members/sq@example.com', { role: 'coach', name: 'Sq' });
await set('admin', 'teams/t2/practices/q1', { id: 'q1', teamId: 't2', team: 'Squirts', date: '2026-10-09', kind: 'practice', stage: 'team' });
await set('admin', 'people/parent@example.com', { persona: 'team', teams: { t1: { name: 'Mites', role: 'family', players: ['pl1'] } } });
await set('admin', 'people/coach.a@example.com', { persona: 'coach', teams: { t1: { name: 'Mites', role: 'coach' } } });
await set('admin', 'users/own/meta/roster', { teams: [] });
await set('admin', 'users/own/private/anthropic', { v: 1, data: 'ciphertext', salt: 's', iv: 'i' });

console.log('teams, members and players');
ok('a coach reads the team', await get(COACH_A, 'teams/t1'), ALLOW);
ok('a family reads the team', await get(PARENT, 'teams/t1'), ALLOW);
ok('a stranger cannot', await get(STRANGER, 'teams/t1'), DENY);
ok('a coach of another team cannot', await get(SQ, 'teams/t1'), DENY);
ok('a coach cannot rewrite the team', await set(COACH_A, 'teams/t1', { name: 'Hacked' }), DENY);
ok('the planner writes the team', await set(PLANNER, 'teams/t1', { id: 't1', name: 'Mites', club: true, admins: [] }), ALLOW);
ok('a family reads its own member record', await get(PARENT, 'teams/t1/members/parent@example.com'), ALLOW);
ok('…but not another\'s', await get(PARENT, 'teams/t1/members/coach.a@example.com'), DENY);
ok('a coach lists the members', await query(COACH_A, 'teams/t1', 'members'), r => r.status === 200 && r.n === 3);
ok('a family cannot list the members', (await query(PARENT, 'teams/t1', 'members')).status, DENY);
ok('a family reads the players', await get(PARENT, 'teams/t1/players/pl2'), ALLOW);
ok('nobody but an admin writes members', await set(COACH_A, 'teams/t1/members/x@example.com', { role: 'coach' }), DENY);

console.log('practice headers follow the stage');
ok('coach reads a practice out to coaches (email matched case-insensitively)', await get(COACH_A, 'teams/t1/practices/p2'), ALLOW);
ok('coach reads a released practice', await get(COACH_A, 'teams/t1/practices/p1'), ALLOW);
ok('parent reads a released practice', await get(PARENT, 'teams/t1/practices/p1'), ALLOW);
ok('parent cannot read a practice still with the coaches', await get(PARENT, 'teams/t1/practices/p2'), DENY);
ok('nobody but the planner reads a draft', await get(COACH_A, 'teams/t1/practices/p3'), DENY);
ok('stranger reads nothing', await get(STRANGER, 'teams/t1/practices/p1'), DENY);
ok('unverified email with a parent\'s address reads nothing', await get(FAKE, 'teams/t1/practices/p1'), DENY);
ok('a coach of another team reads nothing here', await get(SQ, 'teams/t1/practices/p1'), DENY);
ok('planner reads any header', await get(PLANNER, 'teams/t1/practices/p3'), ALLOW);
ok('an open practice: a signed-in stranger reads it', await get(STRANGER, 'teams/t1/practices/p4'), ALLOW);
ok('an open practice: an anonymous guest reads it', await get(GUEST, 'teams/t1/practices/p4'), ALLOW);
ok('a guest reads nothing that is not open', await get(GUEST, 'teams/t1/practices/p1'), DENY);
ok('an extra email named on the practice reads it', await get(GUESTEMAIL, 'teams/t1/practices/p5'), ALLOW);
ok('…but not others on the team', await get(GUESTEMAIL, 'teams/t1/practices/p1'), DENY);
ok('a coach lists what is out to coaches or released', await queryIn(COACH_A, 'teams/t1', 'practices', 'stage', ['coaches', 'team']), r => r.status === 200 && r.n === 4);
ok('a family lists what is released', await query(PARENT, 'teams/t1', 'practices', ['stage', 'team']), r => r.status === 200 && r.n === 2);
ok('a family cannot list the coaches\' stage', (await queryIn(PARENT, 'teams/t1', 'practices', 'stage', ['coaches', 'team'])).status, DENY);
ok('nobody lists without the stage filter', (await query(COACH_A, 'teams/t1', 'practices')).status, DENY);
ok('a stranger cannot list', (await query(STRANGER, 'teams/t1', 'practices', ['stage', 'team'])).status, DENY);
ok('a coach cannot list another team', (await query(COACH_A, 'teams/t2', 'practices', ['stage', 'team'])).status, DENY);
ok('the planner lists everything', await query(PLANNER, 'teams/t1', 'practices'), r => r.status === 200 && r.n === 5);
ok('a coach cannot write a header', await set(COACH_A, 'teams/t1/practices/p1', { stage: 'team' }), DENY);

console.log('the plan, clips, videos and the views log follow the header');
ok('parent reads a released practice\'s plan', await get(PARENT, 'teams/t1/practices/p1/plan/body'), ALLOW);
ok('parent reads its clip', await get(PARENT, 'teams/t1/practices/p1/clips/d1'), ALLOW);
ok('parent reads its video chunk', await get(PARENT, 'teams/t1/practices/p1/videos/d1_1_0'), ALLOW);
ok('parent cannot read the plan of one still with the coaches', await get(PARENT, 'teams/t1/practices/p2/plan/body'), DENY);
ok('coach reads that plan', await get(COACH_A, 'teams/t1/practices/p2/plan/body'), ALLOW);
ok('a guest reads an open practice\'s plan', await get(GUEST, 'teams/t1/practices/p4/plan/body'), ALLOW);
ok('stranger reads no plan', await get(STRANGER, 'teams/t1/practices/p1/plan/body'), DENY);
ok('parent logs a view in their own name', await set(PARENT, 'teams/t1/practices/p1/views/v1', { uid: 'pa', action: 'view' }), ALLOW);
ok('parent cannot log a view as someone else', await set(PARENT, 'teams/t1/practices/p1/views/v2', { uid: 'ca', action: 'view' }), DENY);
ok('parent cannot log a view on a practice they cannot see', await set(PARENT, 'teams/t1/practices/p2/views/v2', { uid: 'pa', action: 'view' }), DENY);
ok('a guest logs a view of an open practice', await set(GUEST, 'teams/t1/practices/p4/views/g1', { uid: 'gu', action: 'view' }), ALLOW);
ok('planner logs their own preview of a draft', await set(PLANNER, 'teams/t1/practices/p3/views/v4', { uid: 'own', action: 'view', audience: 'planner' }), ALLOW);
ok('planner reads the log', await query(PLANNER, 'teams/t1/practices/p1', 'views'), r => r.status === 200 && r.n >= 2);
ok('coach cannot list the log', (await query(COACH_A, 'teams/t1/practices/p1', 'views')).status, DENY);

console.log('feedback: coaches write their own, never see each other\'s; the team has none');
const fb = { uid: 'ca', email: 'coach.a@example.com', name: 'Coach A', text: 'too long', drillId: 'd1', at: 1 };
ok('coach A writes feedback', await set(COACH_A, 'teams/t1/practices/p1/feedback/ca_d1', fb), ALLOW);
ok('coach A edits it', await set(COACH_A, 'teams/t1/practices/p1/feedback/ca_d1', { ...fb, text: 'shorter' }), ALLOW);
ok('coach A reads it back', await get(COACH_A, 'teams/t1/practices/p1/feedback/ca_d1'), ALLOW);
ok('coach A cannot read coach B\'s', await get(COACH_A, 'teams/t1/practices/p1/feedback/cb_d1'), DENY);
ok('coach A cannot write in coach B\'s name', await set(COACH_A, 'teams/t1/practices/p1/feedback/cb_d2', { ...fb, uid: 'cb', email: 'coachb@example.com' }), DENY);
ok('coach A cannot overwrite coach B\'s', await set(COACH_A, 'teams/t1/practices/p1/feedback/cb_d1', fb), DENY);
ok('coach A cannot mark their own resolved', await set(COACH_A, 'teams/t1/practices/p1/feedback/ca_d1', { ...fb, resolved: true }), DENY);
ok('coach A cannot comment on a draft', await set(COACH_A, 'teams/t1/practices/p3/feedback/ca_d1', fb), DENY);
ok('coach A lists their own feedback', await query(COACH_A, 'teams/t1/practices/p1', 'feedback', ['uid', 'ca']), r => r.status === 200 && r.n === 1);
ok('coach A cannot list everyone\'s feedback', (await query(COACH_A, 'teams/t1/practices/p1', 'feedback')).status, DENY);
ok('parent cannot write feedback', await set(PARENT, 'teams/t1/practices/p1/feedback/pa_d1', { ...fb, uid: 'pa', email: 'parent@example.com' }), DENY);
ok('parent cannot read feedback', await get(PARENT, 'teams/t1/practices/p1/feedback/ca_d1'), DENY);
ok('planner reads all feedback in one query', await query(PLANNER, '', 'feedback', null, true), r => r.status === 200 && r.n === 2);
ok('planner marks feedback resolved', await set(PLANNER, 'teams/t1/practices/p1/feedback/ca_d1', { ...fb, text: 'shorter', resolved: true }), ALLOW);
ok('coach A rewriting it makes it unresolved again', await set(COACH_A, 'teams/t1/practices/p1/feedback/ca_d1', { ...fb, text: 'still too long' }), ALLOW);
ok('coach A deletes their own', await del(COACH_A, 'teams/t1/practices/p1/feedback/ca_d1'), ALLOW);

console.log('official club team: the week\'s tasks for members, numbers by family or coach, how-to media');
ok('a family reads the week\'s tasks', await get(PARENT, 'teams/t1/tasks/2026-10-04'), ALLOW);
ok('a coach reads them', await get(COACH_A, 'teams/t1/tasks/2026-10-04'), ALLOW);
ok('a stranger cannot', await get(STRANGER, 'teams/t1/tasks/2026-10-04'), DENY);
ok('a coach cannot write tasks', await set(COACH_A, 'teams/t1/tasks/2026-10-04', { tasks: [] }), DENY);
const stat = (pid, by, extra = {}) => ({ playerId: pid, week: '2026-10-04', values: { k1: 25 }, by, ...extra });
ok('a parent logs their own player\'s week', await set(PARENT, 'teams/t1/stats/pl1_2026-10-04', stat('pl1', 'parent@example.com')), ALLOW);
ok('…and updates it', await set(PARENT, 'teams/t1/stats/pl1_2026-10-04', stat('pl1', 'parent@example.com', { values: { k1: 30 } })), ALLOW);
ok('a parent cannot log for another player', await set(PARENT, 'teams/t1/stats/pl2_2026-10-04', stat('pl2', 'parent@example.com')), DENY);
ok('a parent cannot sign as someone else', await set(PARENT, 'teams/t1/stats/pl1_2026-09-27', stat('pl1', 'coach.a@example.com', { week: '2026-09-27' })), DENY);
ok('the document id must match player and week', await set(PARENT, 'teams/t1/stats/pl1_2026-09-20', stat('pl1', 'parent@example.com')), DENY);
ok('a coach logs for any player', await set(COACH_A, 'teams/t1/stats/pl2_2026-10-11', stat('pl2', 'coach.a@example.com', { week: '2026-10-11' })), ALLOW);
ok('a parent reads their player\'s week', await get(PARENT, 'teams/t1/stats/pl1_2026-10-04'), ALLOW);
ok('a parent cannot read another player\'s week', await get(PARENT, 'teams/t1/stats/pl2_2026-10-04'), DENY);
ok('a coach lists the week\'s numbers for the whole team', await query(COACH_A, 'teams/t1', 'stats', ['week', '2026-10-04']), r => r.status === 200 && r.n === 2);
ok('a parent lists their own player\'s weeks', await query(PARENT, 'teams/t1', 'stats', ['playerId', 'pl1']), r => r.status === 200 && r.n === 1);
ok('a parent cannot list the whole team', (await query(PARENT, 'teams/t1', 'stats', ['week', '2026-10-04'])).status, DENY);
ok('only an admin deletes numbers', await del(PARENT, 'teams/t1/stats/pl1_2026-10-04'), DENY);
ok('a family plays a task\'s how-to', await get(PARENT, 'teams/t1/media/k1_audio'), ALLOW);
ok('a family cannot replace it', await set(PARENT, 'teams/t1/media/k1_audio', { data: 'x' }), DENY);
ok('a stranger cannot play it', await get(STRANGER, 'teams/t1/media/k1_audio'), DENY);

console.log('lookups: the practice index and each person\'s own document');
ok('anyone signed in reads a practice\'s team from the index', await get(STRANGER, 'practiceIndex/p1'), ALLOW);
ok('a guest too', await get(GUEST, 'practiceIndex/p1'), ALLOW);
ok('nobody but the planner writes the index', await set(COACH_A, 'practiceIndex/p9', { teamId: 't1' }), DENY);
ok('parent reads their own person document', await get(PARENT, 'people/parent@example.com'), ALLOW);
ok('coach (mixed-case address) reads theirs', await get(COACH_A, 'people/coach.a@example.com'), ALLOW);
ok('parent cannot read a coach\'s', await get(PARENT, 'people/coach.a@example.com'), DENY);
ok('a stranger\'s own (missing) document is readable — it just does not exist', await get(STRANGER, 'people/stranger@example.com'), 404);
ok('nobody but the planner lists people', (await query(PARENT, '', 'people')).status, DENY);
ok('nobody but the planner writes people', await set(PARENT, 'people/parent@example.com', { persona: 'coach' }), DENY);

console.log('the planner\'s own account');
ok('planner reads own roster', await get(PLANNER, 'users/own/meta/roster'), ALLOW);
ok('planner writes own roster', await set(PLANNER, 'users/own/meta/roster', { teams: [] }), ALLOW);
ok('coach cannot read the roster', await get(COACH_A, 'users/own/meta/roster'), DENY);
ok('planner reads own private doc', await get(PLANNER, 'users/own/private/anthropic'), ALLOW);
ok('coach cannot read the planner\'s private doc', await get(COACH_A, 'users/own/private/anthropic'), DENY);

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
const att = { uid: 'st', email: 'stranger@example.com', name: 'Gran', path: '/coach/t1/p1', at: 1, count: 1 };
ok('stranger records their failed sign-in', await set(STRANGER, 'attempts/st', att), ALLOW);
ok('…and updates it next time', await set(STRANGER, 'attempts/st', { ...att, at: 2, count: 2 }), ALLOW);
ok('stranger cannot record it under another account', await set(STRANGER, 'attempts/pa', { ...att, uid: 'pa' }), DENY);
ok('stranger cannot claim another email', await set(STRANGER, 'attempts/st', { ...att, email: 'parent@example.com' }), DENY);
ok('stranger cannot read attempts (not even their own)', await get(STRANGER, 'attempts/st'), DENY);
ok('parent cannot list attempts', (await query(PARENT, '', 'attempts')).status, DENY);
ok('planner lists attempts', await query(PLANNER, '', 'attempts'), r => r.status === 200 && r.n === 1);
ok('planner clears one', await del(PLANNER, 'attempts/st'), ALLOW);

console.log('revocation, pulling back, and team admins');
await del('admin', 'teams/t1/members/parent@example.com');
ok('a family removed from the team is denied on the next read', await get(PARENT, 'teams/t1/practices/p1'), DENY);
ok('…and loses the plan too', await get(PARENT, 'teams/t1/practices/p1/plan/body'), DENY);
await set('admin', 'teams/t1/practices/p1', { id: 'p1', teamId: 't1', stage: 'draft' });
ok('pulling a practice back to draft removes a coach\'s access', await get(COACH_B, 'teams/t1/practices/p1'), DENY);
ok('a coach is not an admin: cannot write a header', await set(COACH_B, 'teams/t1/practices/p9', { id: 'p9', stage: 'draft' }), DENY);
await set('admin', 'teams/t1', { id: 't1', name: 'Mites', club: true, admins: ['coachb@example.com'] });
ok('made an admin of the team, coach B writes a header', await set(COACH_B, 'teams/t1/practices/p9', { id: 'p9', teamId: 't1', stage: 'draft' }), ALLOW);
ok('…and reads the draft', await get(COACH_B, 'teams/t1/practices/p3'), ALLOW);
ok('…but coach A still cannot', await set(COACH_A, 'teams/t1/practices/p8', { id: 'p8', stage: 'draft' }), DENY);
ok('an admin of one team is nobody on another', await set(COACH_B, 'teams/t2/practices/q9', { id: 'q9', stage: 'draft' }), DENY);

console.log(`\n${n - failed} / ${n} passed`);
process.exit(failed ? 1 : 0);
