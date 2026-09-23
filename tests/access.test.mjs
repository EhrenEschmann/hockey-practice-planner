// Unit tests for js/access.js — the redirect matrix (requirements §5) and who-gets-what.   Run: npm run test:unit
import assert from 'node:assert/strict';
import { calendarFocus, stageOf, accessFor, publishedCopy, inboxDocs, parseRoute, routePath, resolveRoute } from '../js/access.js';
import { newPractice, newDrill, practiceLabel, docTitle, itemNoun, docNoun, isGame } from '../js/store.js';

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
assert.deepEqual(inbox.get('mom@x.io'), { persona: 'team', practices: { p1: { role: 'team', stage: 'team', team: 'mites', date: '2026-09-21', time: '' } } });
assert.deepEqual(inbox.get('sq@x.io'), { persona: 'coach', practices: { p2: { role: 'coach', stage: 'coaches', team: 'Squirts', date: '', time: '' } } });
assert.ok(inbox.has('guest@x.io') && !inbox.has(''), 'extras are known people; blank emails are nobody');
// a game is a practice document with kind + opponent: it publishes the same way and its inbox card says so
const game = newPractice('Mites', 'game', 'Hawks'); game.stage = 'team'; game.date = '2026-10-01';
assert.ok(isGame(game) && !isGame(p1));
assert.equal(docTitle(game), 'Mites vs Hawks'); assert.equal(docTitle(p1), 'mites');
assert.equal(practiceLabel(game), 'Mites vs Hawks — 10/01/2026');
assert.equal(itemNoun(game), 'coaching point'); assert.equal(docNoun(game), 'game'); assert.equal(itemNoun(p1), 'drill');
assert.equal(game.drills[0].name, 'Coaching point 1');
const nets = game.drills[0].objects.filter(o => o.type === 'net'), divider = game.drills[0].objects.find(o => o.type === 'barricade');
assert.deepEqual(nets.map(o => [o.x, o.y, o.rot]), [[11, 42.5, 0], [85, 42.5, 180]], 'nets on the goal line and at the edge of the centre circle, facing each other');
assert.ok(divider && divider.points[0].y === 0 && divider.points.at(-1).y === 85, 'the divider runs board to board');
assert.ok(divider.points.every(pt => pt.x <= 100) && divider.points.some(pt => pt.x === 100), 'along the centre line, curving in toward the playing half');
assert.equal(game.drills[0].view.w, 106, 'half ice');
assert.equal(newDrill(3).name, 'Drill 3'); assert.equal(newDrill(3, 'game').name, 'Coaching point 3');
const gameInbox = inboxDocs(roster, [game]);
assert.deepEqual(gameInbox.get('mom@x.io').practices[game.id], { role: 'team', stage: 'team', team: 'Mites', date: '2026-10-01', time: '', kind: 'game', opponent: 'Hawks' });
const gCopy = publishedCopy(game, 'u1');
assert.equal(gCopy.kind, 'game'); assert.equal(gCopy.opponent, 'Hawks');
// the practice the calendar points at: the next one (today's counts all day), else the most recent
const cal = [{ pid: 'old', date: '2026-09-14', time: '17:00' }, { pid: 'am', date: '2026-09-21', time: '07:00' }, { pid: 'pm', date: '2026-09-21', time: '17:00' }, { pid: 'next', date: '2026-09-23' }];
assert.equal(calendarFocus(cal, '2026-09-21').pid, 'am');
assert.equal(calendarFocus(cal, '2026-09-22').pid, 'next');
assert.equal(calendarFocus(cal, '2026-10-01').pid, 'next', 'nothing upcoming: the most recent');
assert.equal(calendarFocus([], '2026-10-01'), null);
console.log('access.js: all assertions passed');
