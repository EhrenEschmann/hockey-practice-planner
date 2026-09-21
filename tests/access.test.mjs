// Unit tests for js/access.js — the redirect matrix (requirements §5) and who-gets-what.   Run: npm run test:unit
import assert from 'node:assert/strict';
import { stageOf, accessFor, publishedCopy, inboxDocs, parseRoute, routePath, resolveRoute } from '../js/access.js';

const at = (pathname, hash = '') => parseRoute({ pathname, hash });
const go = (path, who, hash) => { const r = resolveRoute(at(path, hash), who); return r.go || `${r.screen}${r.as ? `:${r.as}` : ''}${r.pid ? `:${r.pid}` : ''}`; };
const anon = { persona: 'anonymous' }, planner = { persona: 'planner' }, unknown = { persona: 'unknown' };
const coach = { persona: 'coach', roles: { a: 'coach', b: 'team' } }, team = { persona: 'team', roles: { a: 'team' } };

// the matrix:            "/"               /editor           /coach         /coach/a            /team        /team/a
const M = [
  [anon,    ['signin',          'signin',         'signin',      'signin',           'signin',     'signin']],
  [planner, ['/editor',         'editor',         'list:coach',  'practice:coach:a', 'list:team',  'practice:team:a']],
  [coach,   ['/coach',          '/coach',         'list:coach',  'practice:coach:a', 'list:team',  'practice:team:a']],
  [team,    ['/team',           '/team',          '/team',       '/team/a',          'list:team',  'practice:team:a']],
  [unknown, ['/request-access', '/request-access', '/request-access', '/request-access', '/request-access', '/request-access']],
];
for (const [who, row] of M) ['/', '/editor', '/coach', '/coach/a', '/team', '/team/a'].forEach((p, i) => assert.equal(go(p, who), row[i], `${who.persona} on ${p}`));
assert.equal(go('/request-access', unknown), 'request');
assert.equal(go('/request-access', coach), '/coach');
assert.equal(go('/request-access', planner), '/editor');
assert.equal(go('/coach/b', coach), '/team/b', 'a coach who is only a parent on that practice gets the team link');
assert.equal(go('/coach/zzz', coach), 'unavailable:coach:zzz');
assert.equal(go('/team/zzz', team), 'unavailable:team:zzz');
assert.equal(go('/editor/p/d', planner), 'editor:p');
assert.equal(go('/nope', anon), '/');
assert.equal(go('/coach/a/b', coach), '/');
// links from before paths existed
assert.equal(go('/', anon, '#view=OWNER123/abc'), '/coach/abc');
assert.equal(go('/', team, '#team%3DOWNER123%2Fabc'), '/team/abc');
assert.equal(go('/index.html', planner, '#p=abc&d=def'), '/editor/abc/def');
assert.equal(routePath({ view: 'editor', pid: 'p', did: 'd' }), '/editor/p/d');
assert.deepEqual(at('/coach/abc'), { view: 'coach', pid: 'abc', did: null });

// stages, incl. practices shared before stages existed
assert.equal(stageOf({}), 'draft');
assert.equal(stageOf({ sharedWith: ['a@x.io'] }), 'coaches');
assert.equal(stageOf({ sharedWith: ['a@x.io'], sharedTeam: ['b@x.io'] }), 'team');
assert.equal(stageOf({ stage: 'draft', sharedTeam: ['b@x.io'] }), 'draft', 'an explicit stage wins');

const roster = { teams: [
  { name: 'Mites', coaches: [{ email: ' Head@X.io ' }, { email: '' }], players: [{ contacts: [{ email: 'mom@x.io' }, { email: 'head@x.io' }] }, { contacts: [] }] },
  { name: 'Squirts', coaches: [{ email: 'sq@x.io' }], players: [{ contacts: [{ email: 'head@x.io' }] }] }] };
const p1 = { id: 'p1', team: 'mites', date: '2026-09-21', stage: 'team', sharedTeam: ['Guest@x.io'], drills: [{ id: 'd1' }, { id: 'd2', hidden: true }] };
assert.deepEqual(accessFor(roster, p1), { stage: 'team', coach: ['head@x.io'], team: ['mom@x.io', 'guest@x.io'] }, 'roster + extras, lower-cased, a coach-parent is a coach');
assert.deepEqual(accessFor(roster, { team: 'Squirts', stage: 'coaches' }), { stage: 'coaches', coach: ['sq@x.io'], team: ['head@x.io'] }, 'per team: the Mites coach is a parent on the Squirts');
const copy = publishedCopy({ ...p1, sharedWith: ['x@x.io'], sentTeamAt: 1 }, 'OWNER');
assert.deepEqual(Object.keys(copy).sort(), ['date', 'drills', 'id', 'owner', 'team']);
assert.equal(copy.drills.length, 1, 'hidden drills are not published');

const inbox = inboxDocs(roster, [p1, { id: 'p2', team: 'Squirts', stage: 'coaches' }, { id: 'p3', team: 'Mites', stage: 'draft' }]);
assert.deepEqual(Object.keys(inbox.get('head@x.io').practices), ['p1'], 'a practice still with the coaches is not on a parent\'s list');
assert.equal(inbox.get('head@x.io').persona, 'coach');
assert.equal(inbox.get('head@x.io').practices.p1.role, 'coach');
assert.deepEqual(inbox.get('mom@x.io'), { persona: 'team', practices: { p1: { role: 'team', team: 'mites', date: '2026-09-21', time: '' } } });
assert.deepEqual(inbox.get('sq@x.io'), { persona: 'coach', practices: { p2: { role: 'coach', team: 'Squirts', date: '', time: '' } } });
assert.ok(inbox.has('guest@x.io') && !inbox.has(''), 'extras are known people; blank emails are nobody');
console.log('access.js: all assertions passed');
