// Unit tests for js/access.js — the redirect matrix (requirements §5) and who-gets-what.   Run: npm run test:unit
import assert from 'node:assert/strict';
import { calendarFocus, stageOf, accessFor, publishedCopy, peopleDocs, memberDocs, playerDocs, teamDoc, practiceHeader, practiceBody, practiceFromParts, parseRoute, routePath, resolveRoute } from '../js/access.js';
import { newPractice, newDrill, practiceLabel, docTitle, itemNoun, docNoun, isGame } from '../js/store.js';

const at = (pathname, hash = '') => parseRoute({ pathname, hash });
const go = (path, who, hash) => { const r = resolveRoute(at(path, hash), who); return r.go || `${r.screen}${r.as ? `:${r.as}` : ''}${r.teamId ? `:${r.teamId}` : ''}${r.pid ? `:${r.pid}` : ''}`; };
const anon = { persona: 'anonymous' }, unknown = { persona: 'unknown' };
const planner = { persona: 'planner', teams: [{ id: 't1', name: 'Mites', role: 'coach' }], practiceTeam: { a: 't1', b: 't1' } };
const coach = { persona: 'coach', teams: [{ id: 't1', name: 'Mites', role: 'coach' }], practiceTeam: { a: 't1', b: 't1' } };
const team = { persona: 'team', teams: [{ id: 't1', name: 'Mites', role: 'family' }], practiceTeam: { a: 't1' } };

// the matrix — lists are per team: "/"  /editor  /coach  /coach/t1  /coach/t1/a  /team  /team/t1  /team/t1/a
const M = [
  [anon,    ['signin',          'signin',          'signin',          'signin',          'signin',                'signin',          'signin',          'signin']],
  [planner, ['/editor',         'editor',          '/coach/t1',       'list:coach:t1',   'practice:coach:t1:a',   '/team/t1',        'list:team:t1',    'practice:team:t1:a']],
  [coach,   ['/coach',          '/coach',          '/coach/t1',       'list:coach:t1',   'practice:coach:t1:a',   '/team/t1',        'list:team:t1',    'practice:team:t1:a']],
  [team,    ['/team',           '/team',           '/team',           '/team/t1',        '/team/t1/a',            '/team/t1',        'list:team:t1',    'practice:team:t1:a']],
  [unknown, ['/request-access', '/request-access', '/request-access', 'practice:team:t1', 'practice:team:t1:a',    '/request-access', 'practice:team:t1', 'practice:team:t1:a']], // on no roster a lone id is tried as an older practice link (a refusal → request access)
];
for (const [who, row] of M) ['/', '/editor', '/coach', '/coach/t1', '/coach/t1/a', '/team', '/team/t1', '/team/t1/a'].forEach((p, i) => assert.equal(go(p, who), row[i], `${who.persona} on ${p}`));
assert.equal(go('/request-access', unknown), 'request');
assert.equal(go('/request-access', coach), '/coach');
assert.equal(go('/request-access', planner), '/editor');
assert.equal(go('/coach/t1/b', team), '/team/t1/b', 'a family on that team opening a coach link gets the team link');
assert.equal(go('/coach/t2/zzz', coach), 'practice:team:t2:zzz', 'a practice on a team they are not on is still tried, as the team sees it (an open practice is for anyone signed in)');
assert.equal(resolveRoute(at('/team/t2/zzz'), team).probe, true, '…marked as a probe so a refusal is explained as "not on your list yet"');
assert.equal(go('/coach/t1/zzz', coach), 'practice:coach:t1:zzz', 'a coach on the team opens any practice of it as a coach (the rules decide what is released)');
// older links named the practice alone: a known practice is sent to its full path; a lone team id is that team's list
assert.equal(go('/coach/a', coach), '/coach/t1/a', 'an older /coach/{practice} link goes to /coach/{team}/{practice}');
assert.equal(go('/team/a', team), '/team/t1/a');
assert.equal(go('/coach/t1', coach), 'list:coach:t1', 'a lone team id is the list');
assert.equal(go('/coach/zzz', coach), 'practice:team:zzz', 'a lone unknown id is tried as a practice (the app fills the team in once it loads)');
const twoTeams = { persona: 'coach', teams: [{ id: 't1', name: 'Mites', role: 'coach' }, { id: 't2', name: 'Squirts', role: 'coach' }] };
assert.equal(go('/coach', twoTeams), 'teams:coach', 'on several teams, /coach offers a choice of team');
assert.equal(go('/coach', { persona: 'coach', teams: [] }), 'list:coach', 'on no team at all: an empty list');
assert.equal(go('/editor/p/d', planner), 'editor:p');
assert.equal(go('/nope', anon), '/');
assert.equal(go('/coach/a/b/c', coach), '/', 'too many segments');
// links from before paths existed
assert.equal(go('/', anon, '#view=OWNER123/abc'), '/coach/abc', 'a link from before paths existed names the practice alone; it is resolved once the person is known');
assert.equal(go('/', team, '#team%3DOWNER123%2Fabc'), '/team/abc');
assert.equal(go('/index.html', planner, '#p=abc&d=def'), '/editor/abc/def');
assert.equal(routePath({ view: 'editor', pid: 'p', did: 'd' }), '/editor/p/d');
assert.deepEqual(at('/coach/abc'), { view: 'coach', teamId: null, pid: 'abc', did: null, ambiguous: true }, 'a lone id: team or practice, resolveRoute decides');
assert.deepEqual(at('/coach/t1/abc'), { view: 'coach', teamId: 't1', pid: 'abc', did: null });
assert.deepEqual(at('/team/t1'), { view: 'team', teamId: null, pid: 't1', did: null, ambiguous: true });
assert.deepEqual(at('/team/t1/tasks'), { view: 'team', teamId: 't1', pid: null, did: null, tab: 'tasks' }); assert.deepEqual(at('/coach/t1/games'), { view: 'coach', teamId: 't1', pid: null, did: null, tab: 'games' });
assert.equal(routePath({ view: 'team', teamId: 't1', tab: 'tasks' }), '/team/t1/tasks'); assert.equal(routePath({ view: 'team', teamId: 't1', tab: 'practice' }), '/team/t1'); assert.equal(routePath({ view: 'team', teamId: 't1', pid: 'p', tab: 'games' }), '/team/t1/p');
assert.equal(routePath({ view: 'coach', teamId: 't1', pid: 'p' }), '/coach/t1/p'); assert.equal(routePath({ view: 'team', teamId: 't1' }), '/team/t1'); assert.equal(routePath({ view: 'team', pid: 'p' }), '/team/p');

// stages, incl. practices shared before stages existed
assert.equal(stageOf({}), 'draft');
assert.equal(stageOf({ sharedWith: ['a@x.io'] }), 'coaches');
assert.equal(stageOf({ sharedWith: ['a@x.io'], sharedTeam: ['b@x.io'] }), 'team');
assert.equal(stageOf({ stage: 'draft', sharedTeam: ['b@x.io'] }), 'draft', 'an explicit stage wins');

const roster = { teams: [
  { id: 't1', name: 'Mites', coaches: [{ email: ' Head@X.io ' }, { email: '' }], players: [{ contacts: [{ email: 'mom@x.io' }, { email: 'head@x.io' }] }, { contacts: [] }] },
  { id: 't2', name: 'Squirts', coaches: [{ email: 'sq@x.io' }], players: [{ contacts: [{ email: 'head@x.io' }] }] }] };
const p1 = { id: 'p1', team: 'mites', date: '2026-09-21', stage: 'team', sharedTeam: ['Guest@x.io'], drills: [{ id: 'd1' }, { id: 'd2', hidden: true }] };
assert.deepEqual(accessFor(roster, p1), { stage: 'team', open: false, coach: ['head@x.io'], team: ['mom@x.io', 'guest@x.io'] }, 'roster + extras, lower-cased, a coach-parent is a coach');
assert.deepEqual(accessFor(roster, { team: 'Squirts', stage: 'coaches' }), { stage: 'coaches', open: false, coach: ['sq@x.io'], team: ['head@x.io'] }, 'per team: the Mites coach is a parent on the Squirts');
const copy = publishedCopy({ ...p1, sharedWith: ['x@x.io'], sentTeamAt: 1 }, 'OWNER');
assert.deepEqual(Object.keys(copy).sort(), ['date', 'drills', 'id', 'owner', 'team']);
assert.equal(copy.drills.length, 1, 'hidden drills are not published');

const people = peopleDocs(roster);
assert.deepEqual(people.get('mom@x.io'), { persona: 'team', teams: { t1: { name: 'Mites', role: 'family', players: [] } } }, 'a family: its team (players need ids to be listed)');
assert.equal(people.get('head@x.io').persona, 'coach'); assert.equal(people.get('head@x.io').teams.t1.role, 'coach', 'a coach-parent is a coach');
assert.equal(people.get('head@x.io').teams.t2.role, 'family', '…and a parent on the other team'); assert.deepEqual(people.get('sq@x.io').teams, { t2: { name: 'Squirts', role: 'coach' } });
assert.ok(!people.has(''), 'blank emails are nobody');
const mem = memberDocs(roster.teams[0]);
assert.deepEqual(mem.get('head@x.io'), { role: 'coach', name: '', playerIds: [] }, 'a coach stays a coach even as a contact');
assert.deepEqual(mem.get('mom@x.io'), undefined, 'a contact of a player with no id is not a member yet (the roster gives players ids)');
assert.deepEqual([...playerDocs({ players: [{ id: 'pl1', name: 'Sam', contacts: [{ email: ' Mom@x.io ' }] }, { name: 'no id' }] }).entries()], [['pl1', { name: 'Sam', contacts: ['mom@x.io'] }]]);
assert.deepEqual(teamDoc({ id: 't1', name: 'Mites', club: true, admins: ['Co@x.io'], updatedAt: 3 }), { id: 't1', name: 'Mites', club: true, admins: ['co@x.io'], updatedAt: 3 });
// header and body
const hp = { id: 'p1', teamId: 't1', team: 'Mites', date: '2026-09-21', time: '17:00', stage: 'team', sharedTeam: ['guest@x.io'], updatedAt: 9, drills: [{ id: 'd1', name: 'Warmup', duration: 10 }, { id: 'd2', name: 'Hidden', duration: 5, hidden: true }, { id: 'd3', name: 'Rush', duration: 15, upload: { at: 1 } }] };
const hh = practiceHeader(hp);
assert.deepEqual(hh, { id: 'p1', teamId: 't1', team: 'Mites', date: '2026-09-21', time: '17:00', sharedTeam: ['guest@x.io'], updatedAt: 9, stage: 'team', drillNames: ['Warmup', 'Rush'], drillCount: 2, minutes: 25, hasVideo: true }, 'the header: card fields plus a summary of the visible drills, no drills');
assert.equal(practiceHeader({ ...hp, deleted: 5 }).stage, 'draft', 'a deleted practice reads as a draft');
assert.deepEqual(practiceBody(hp), { id: 'p1', teamId: 't1', drills: hp.drills, updatedAt: 9 });
assert.deepEqual(practiceFromParts(hh, practiceBody(hp)), { id: 'p1', teamId: 't1', team: 'Mites', date: '2026-09-21', time: '17:00', sharedTeam: ['guest@x.io'], updatedAt: 9, stage: 'team', drills: hp.drills }, 'header + body round-trip to the practice');
// the practice the calendar points at: the next one (today's counts all day), else the most recent
const cal = [{ pid: 'old', date: '2026-09-14', time: '17:00' }, { pid: 'am', date: '2026-09-21', time: '07:00' }, { pid: 'pm', date: '2026-09-21', time: '17:00' }, { pid: 'next', date: '2026-09-23' }];
assert.equal(calendarFocus(cal, '2026-09-21').pid, 'am');
assert.equal(calendarFocus(cal, '2026-09-22').pid, 'next');
assert.equal(calendarFocus(cal, '2026-10-01').pid, 'next', 'nothing upcoming: the most recent');
assert.equal(calendarFocus([], '2026-10-01'), null);
console.log('access.js: all assertions passed');

// ---- official club teams: the club document, the inbox's club field, and week keys
import { clubDoc, weekKey, weekStart, shiftWeek, statId, tasksForWeek, migrateClubTeam, legacyWeek, normalWeek } from '../js/access.js';
const clubTeam = { id: 't1', name: 'Mites', club: true, coaches: [{ email: 'Head@x.io' }], weeks: { '2026-10-04': { tasks: [{ id: 'k1', title: ' Shots on goal ', unit: 'shots', target: 25, times: 3 }, { id: 'k2', title: 'Stickhandling', unit: 'min', target: 60 }, { id: 'k3', title: '', unit: 'min', target: 5 }, { id: 'k4', title: 'Balance', unit: 'nope', target: -3, times: 0 }] }, '2026-10-11': { tasks: [] }, 'junk': { tasks: [{ id: 'z', title: 'x' }] } },
  players: [{ id: 'pl1', name: 'Sam', contacts: [{ email: 'mom@x.io' }, { email: 'DAD@x.io' }] }, { id: 'pl2', name: 'Alex', contacts: [{ email: 'head@x.io' }] }] };
const cd = clubDoc(clubTeam);
assert.deepEqual(cd.weeks['2026-10-04'], [{ id: 'k1', title: 'Shots on goal', unit: 'shots', target: 25, times: 3 }, { id: 'k2', title: 'Stickhandling', unit: 'min', target: 60, times: 1 }, { id: 'k4', title: 'Balance', unit: 'reps', target: 0, times: 1 }], 'a week\'s tasks: trimmed, untitled dropped, unit, target and times sanitised');
assert.deepEqual(Object.keys(cd.weeks), ['2026-10-04'], 'an empty week and a malformed key are left out');
assert.deepEqual(tasksForWeek(cd, '2026-10-11'), []); assert.equal(tasksForWeek(cd, '2026-10-04').length, 3);
const legacy = migrateClubTeam({ id: 't9', club: true, tasks: [{ id: 'k', title: 'Old' }] }, '2026-10-04');
assert.deepEqual(legacy.weeks['2026-10-04'].tasks, [{ id: 'k', title: 'Old' }], 'a recurring list from before becomes this week\'s'); assert.equal('tasks' in legacy, false);
assert.deepEqual(cd.coaches, ['head@x.io']); assert.deepEqual(cd.members.sort(), ['dad@x.io', 'head@x.io', 'mom@x.io']);
assert.deepEqual(cd.players, { pl1: { name: 'Sam', contacts: ['mom@x.io', 'dad@x.io'] }, pl2: { name: 'Alex', contacts: ['head@x.io'] } });
assert.equal(clubDoc({ ...clubTeam, club: false }), null, 'only a team flagged as a club gets a document');
const withMedia = clubDoc({ ...clubTeam, weeks: { '2026-10-18': { tasks: [{ id: 'k9', title: 'Toe drag', unit: 'reps', target: 10, audio: { at: 5, mime: 'audio/webm', secs: 12.5, size: 9000, cloud: true, blob: 'never' }, video: { at: 6, mime: 'video/mp4', secs: 20, size: 1e6, width: 640, height: 360, chunks: 2, cloud: true }, videoUrl: ' https://youtu.be/abc123xyz ' }] } } });
withMedia.tasks = withMedia.weeks['2026-10-18'];
assert.deepEqual(withMedia.tasks[0].audio, { at: 5, mime: 'audio/webm', secs: 12.5, size: 9000 }, 'audio metadata only, no local fields');
assert.deepEqual(withMedia.tasks[0].video, { at: 6, mime: 'video/mp4', secs: 20, size: 1e6, width: 640, height: 360, chunks: 2 });
assert.equal(withMedia.tasks[0].videoUrl, 'https://youtu.be/abc123xyz');
const clubPeople = peopleDocs({ teams: [clubTeam] });
assert.deepEqual(clubPeople.get('head@x.io').teams.t1, { name: 'Mites', role: 'coach', club: true }, 'a coach (even as a parent) is a coach of the club team');
assert.deepEqual(clubPeople.get('mom@x.io').teams.t1, { name: 'Mites', role: 'family', players: [{ id: 'pl1', name: 'Sam' }], club: true }, 'a family gets its own players');
assert.equal(peopleDocs({ teams: [{ ...clubTeam, club: false }] }).get('mom@x.io').teams.t1.club, undefined, 'no club flag without it');
// weeks run Sunday to Saturday and are keyed by their Sunday
assert.equal(weekKey(new Date(2026, 9, 6)), '2026-10-04', 'Tuesday 6 Oct is in the week of Sunday 4 Oct'); assert.equal(weekKey(new Date(2026, 9, 4)), '2026-10-04'); assert.equal(weekKey(new Date(2026, 9, 10)), '2026-10-04', 'Saturday closes the week'); assert.equal(weekKey(new Date(2026, 9, 11)), '2026-10-11');
assert.equal(weekStart('2026-10-04').getDay(), 0, 'a week starts on its Sunday');
assert.equal(shiftWeek('2026-10-04', -1), '2026-09-27'); assert.equal(shiftWeek('2026-12-27', 1), '2027-01-03');
assert.equal(statId('pl1', '2026-10-04'), 'pl1_2026-10-04');
// keys from the Monday-week days still resolve
assert.equal(normalWeek('2026-W41'), '2026-10-04', 'ISO week 41 (Mon 5 Oct) lives on the Sunday 4 Oct week'); assert.equal(legacyWeek('2026-10-04'), '2026-W41');
assert.equal(weekStart('2026-W41').toDateString(), new Date(2026, 9, 4).toDateString());
const moved = migrateClubTeam({ id: 't8', club: true, weeks: { '2026-W41': { tasks: [{ id: 'q', title: 'Old key' }] } } }, '2026-10-04');
assert.deepEqual(Object.keys(moved.weeks), ['2026-10-04']); assert.equal(moved.weeks['2026-10-04'].tasks[0].title, 'Old key');
console.log('access.js club: all assertions passed');
