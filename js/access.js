// Routing & authorization logic (docs/requirements-routing-auth.md) — pure functions, no DOM and no Firebase,
// shared by the editor (what to publish, and to whom) and the viewer (where a person may be).
//
// Cloud layout this feeds (rules in firestore.rules):
//   users/{uid}/practices/{pid}     the planner's working document — planner only
//   published/{pid}                 the copy coaches and the team read (written while stage ≠ draft)
//   published/{pid}/feedback/{fid}  a coach's feedback: one document per coach per drill (fid = `${uid}_${drillId|overall}`)
//   access/{pid}                    { stage, coach: [emails], team: [emails] } — planner only; the rules look people up here
//   inbox/{email}                   { persona, practices: { [pid]: { role, team, date, time } }, club } — that person's list
//   requests/{uid}                  an access request from someone who is on no roster
//   club/{teamId}                   an official club team's weekly tasks + who may log for which player (clubDoc below)
//   club/{teamId}/stats/{pid_week}  one player's numbers for one week — their family (or a coach) writes, coaches read
//   club/{teamId}/media/{mid}       a task's how-to: `{taskId}_audio` (base64 clip) or `{taskId}_video_{at}_{i}` (chunks) — planner writes, members read

export const STAGES = ['draft', 'coaches', 'team'];
export const STAGE_LABELS = { draft: 'Draft — only you', coaches: 'Out to coaches for feedback', team: 'Released to the team' };

const norm = e => String(e || '').trim().toLowerCase();
const emails = list => [...new Set((list || []).map(norm).filter(Boolean))];

/** A practice's stage. Practices shared before stages existed keep their audience: a team list → 'team', a coach list → 'coaches'. */
export function stageOf(p) {
  if (p?.deleted) return 'draft'; // soft-deleted: pulled back from everyone until it is restored
  if (STAGES.includes(p?.stage)) return p.stage;
  if (p?.sharedTeam?.length) return 'team';
  if (p?.sharedWith?.length) return 'coaches';
  return 'draft';
}

/** The roster team a practice belongs to: by name, else the only / first team (same choice the roster buttons always made). */
export function rosterTeamFor(roster, p) {
  const teams = roster?.teams || [];
  return teams.find(t => norm(t.name) === norm(p?.team)) || teams[0] || null;
}
export const rosterCoachEmails = team => emails((team?.coaches || []).map(c => c.email));
export const rosterFamilyEmails = team => emails((team?.players || []).flatMap(pl => (pl.contacts || []).map(k => k.email)));

/** Who may open a practice: the roster (the source of truth) plus the practice's own extra emails. A coach who is also a parent is a coach. */
export function accessFor(roster, p) {
  const t = rosterTeamFor(roster, p);
  const coach = emails([...rosterCoachEmails(t), ...(p.sharedWith || [])]);
  const team = emails([...rosterFamilyEmails(t), ...(p.sharedTeam || [])]).filter(e => !coach.includes(e));
  return { stage: stageOf(p), open: !!p.open, coach, team };
}

/** What coaches and the team download: the practice without its access lists, stage bookkeeping or hidden drills. */
export function publishedCopy(p, owner) {
  const c = JSON.parse(JSON.stringify(p));
  for (const k of ['sharedWith', 'sharedTeam', 'stage', 'sentCoachesAt', 'sentTeamAt', 'open']) delete c[k];
  c.drills = (c.drills || []).filter(d => !d.hidden);
  c.owner = owner;
  return c;
}

/** Every person's list document, keyed by email: their persona (from the roster) and the practices released to them. */
export function inboxDocs(roster, practices) {
  const out = new Map();
  const doc = e => { if (!out.has(e)) out.set(e, { persona: 'team', practices: {} }); return out.get(e); };
  for (const t of roster?.teams || []) {
    for (const e of rosterFamilyEmails(t)) doc(e);
    for (const e of rosterCoachEmails(t)) doc(e).persona = 'coach';
  }
  for (const p of practices || []) {
    const a = accessFor(roster, p);
    if (a.stage === 'draft') continue;
    const card = role => ({ role, stage: a.stage, team: p.team || '', date: p.date || '', time: p.time || '', ...(p.kind === 'game' ? { kind: 'game', opponent: p.opponent || '' } : {}) });
    for (const e of a.coach) { const d = doc(e); d.persona = 'coach'; d.practices[p.id] = card('coach'); }
    if (a.stage === 'team') for (const e of a.team) doc(e).practices[p.id] = card('team');
    else for (const e of a.team) doc(e); // known to the app (not a stranger), nothing to open yet
  }
  // Official club teams: each coach gets the whole team's weekly output; each family gets its own players' profiles.
  for (const t of roster?.teams || []) {
    if (!t.club) continue;
    const players = (t.players || []).map(pl => ({ id: pl.id, name: pl.name || '' }));
    for (const e of rosterCoachEmails(t)) { const d = doc(e); (d.club ||= {})[t.id] = { name: t.name || '', role: 'coach', players }; }
    for (const pl of t.players || []) for (const e of emails((pl.contacts || []).map(k => k.email))) {
      if (rosterCoachEmails(t).includes(e)) continue; // a coach-parent already has everyone
      const d = doc(e), c = (d.club ||= {})[t.id] ||= { name: t.name || '', role: 'family', players: [] };
      if (!c.players.some(x => x.id === pl.id)) c.players.push({ id: pl.id, name: pl.name || '' });
    }
  }
  return out;
}

// ---- official club teams: weekly tasks and who may log for whom
export const TASK_UNITS = { reps: 'reps', min: 'minutes', times: 'times', shots: 'shots' };
/** The club document for a team flagged as an official club team (null otherwise): tasks, and the lookups the rules use. */
export function clubDoc(t) {
  if (!t?.club) return null;
  const coach = rosterCoachEmails(t);
  const players = {};
  for (const pl of t.players || []) players[pl.id] = { name: pl.name || '', contacts: emails((pl.contacts || []).map(k => k.email)) };
  const members = emails([...coach, ...Object.values(players).flatMap(p => p.contacts)]);
  // A task is "`target` `unit` per session, `times` sessions a week" — e.g. 25 shots, 3 times a week.
  // A task may carry how-to media: a recorded explanation (`audio`), an uploaded clip (`video`, in chunks under
  // club/{teamId}/media) or a link (`videoUrl`). Only the metadata rides here; the bytes are fetched on demand.
  const media = x => ({ ...(x.audio?.at ? { audio: { at: +x.audio.at, mime: String(x.audio.mime || ''), secs: +x.audio.secs || 0, size: +x.audio.size || 0 } } : {}),
    ...(x.video?.at ? { video: { at: +x.video.at, mime: String(x.video.mime || ''), secs: +x.video.secs || 0, size: +x.video.size || 0, width: +x.video.width || 0, height: +x.video.height || 0, chunks: +x.video.chunks || 0 } } : {}),
    ...(String(x.videoUrl || '').trim() ? { videoUrl: String(x.videoUrl).trim() } : {}) });
  const clean = list => (list || []).filter(x => x && x.id && String(x.title || '').trim()).map(x => ({ id: x.id, title: String(x.title).trim(), unit: TASK_UNITS[x.unit] ? x.unit : 'reps', target: Math.max(0, Math.round(+x.target || 0)), times: Math.max(1, Math.round(+x.times || 1)), ...media(x) }));
  // Tasks are set week by week: weeks['YYYY-Www'] = [tasks]. A week with no list is simply absent.
  const weeks = {};
  for (const [w, wk] of Object.entries(t.weeks || {})) { if (!/^\d{4}-W\d{2}$/.test(w)) continue; const list = clean(wk?.tasks); if (list.length) weeks[w] = list; }
  return { id: t.id, name: t.name || '', weeks, coaches: coach, members, players, updatedAt: t.updatedAt || 0 };
}
/** The task list a club document holds for a week ([] when none is set). */
export const tasksForWeek = (doc, week) => doc?.weeks?.[week] || [];
/** A legacy team that still carries one recurring list: it becomes this week's list. */
export function migrateClubTeam(t, thisWeek) {
  if (!t) return t;
  if (Array.isArray(t.tasks)) { t.weeks ||= {}; if (t.tasks.length && !t.weeks[thisWeek]?.tasks?.length) t.weeks[thisWeek] = { tasks: t.tasks }; delete t.tasks; }
  return t;
}
/** The ISO week a date falls in, as 'YYYY-Www' (weeks start on Monday) — the key a week's stats are filed under. */
export function isoWeek(d = new Date()) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7; // Mon=1 … Sun=7
  x.setUTCDate(x.getUTCDate() + 4 - day); // the Thursday of this week decides the year
  const y = x.getUTCFullYear();
  const week = Math.ceil(((x - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, '0')}`;
}
/** The Monday a 'YYYY-Www' key starts on (local midnight). */
export function weekStart(key) {
  const m = String(key || '').match(/^(\d{4})-W(\d{2})$/); if (!m) return null;
  const y = +m[1], w = +m[2];
  const jan4 = new Date(y, 0, 4), day = jan4.getDay() || 7; // ISO week 1 holds 4 January
  const monday = new Date(y, 0, 4 - (day - 1) + (w - 1) * 7);
  return monday;
}
/** The week key `n` weeks away from `key`. */
export function shiftWeek(key, n) { const s = weekStart(key); if (!s) return key; s.setDate(s.getDate() + 7 * n); return isoWeek(s); }
/** The stats document id for one player's week. */
export const statId = (playerId, week) => `${playerId}_${week}`;

/** Calendar order: by date, then start time (undated practices first). */
export const byCalendar = (a, b) => `${a.date || ''} ${a.time || ''}`.localeCompare(`${b.date || ''} ${b.time || ''}`);
/** The practice the calendar points at on `today` (YYYY-MM-DD): the next one — today's counts all day — else the most recent. */
export function calendarFocus(items, today) {
  const sorted = [...items].sort(byCalendar);
  return sorted.find(x => (x.date || '') >= today) || sorted.at(-1) || null;
}

/** Where a URL points: { view: 'root' | 'editor' | 'coach' | 'team' | 'request' | 'unknown', pid, did, legacy }. */
export function parseRoute({ pathname = '/', hash = '' } = {}) {
  let h = hash;
  try { h = decodeURIComponent(h); } catch { /* a stray % — match it as it is */ }
  // Links sent before paths existed: #view=<owner>/<id> (coaches) and #team=<owner>/<id>, possibly percent-encoded by a mail app.
  const old = h.match(/(view|team)=(\w+)\/(\w+)/);
  if (old) return { view: old[1] === 'team' ? 'team' : 'coach', pid: old[3], did: null, legacy: true };
  const seg = pathname.split('/').filter(Boolean);
  const [a, b, c] = seg;
  if (!a || a === 'index.html') {
    const pid = h.match(/p=(\w+)/)?.[1], did = h.match(/d=(\w+)/)?.[1]; // the editor's old #p=…&d=… bookmark
    return { view: 'root', pid: pid || null, did: did || null, legacy: !!pid };
  }
  if (a === 'editor' && seg.length <= 3) return { view: 'editor', pid: b || null, did: c || null };
  if ((a === 'coach' || a === 'team') && seg.length <= 2) return { view: a, pid: b || null, did: null };
  if (a === 'request-access' && seg.length === 1) return { view: 'request', pid: null, did: null };
  return { view: 'unknown', pid: null, did: null };
}
export function routePath({ view, pid, did }) {
  if (view === 'editor') return `/editor${pid ? `/${pid}${did ? `/${did}` : ''}` : ''}`;
  if (view === 'coach' || view === 'team') return `/${view}${pid ? `/${pid}` : ''}`;
  if (view === 'request') return '/request-access';
  return '/';
}

/**
 * The redirect matrix. `who` = { persona: 'anonymous' | 'planner' | 'coach' | 'team' | 'unknown', roles: { [pid]: 'coach' | 'team' } }.
 * → { go: '/path' }        move there (replacing the history entry)
 *   { screen: 'signin' }    nobody is signed in: sign in, then ask again
 *   { screen: 'editor' | 'list' | 'practice' | 'unavailable' | 'request', as: 'coach' | 'team', pid }
 */
export function resolveRoute(route, who) {
  const { view, pid } = route;
  const persona = who?.persona || 'anonymous';
  if (view === 'unknown') return { go: '/' };
  if (route.legacy && view !== 'root') return { go: routePath(route) };
  if (persona === 'anonymous') return { screen: 'signin' };
  if (persona === 'guest') { // signed in anonymously: may watch open practices, has no list of their own
    if (view === 'coach' && pid) return { go: `/team/${pid}` };
    if (view === 'team' && pid) return { screen: 'practice', as: 'team', pid };
    return { screen: 'signin' };
  }
  // A signed-in account on no roster: a practice link is still tried, as the team sees it — an open practice lets
 // anyone signed in watch (probe: a refusal sends them on to request access); anything else → request access.
  if (persona === 'unknown') return (view === 'coach' || view === 'team') && pid ? { screen: 'practice', as: 'team', pid, probe: true } : view === 'request' ? { screen: 'request' } : { go: '/request-access' };
  if (persona === 'planner') {
    if (view === 'editor') return { screen: 'editor', pid, did: route.did };
    if (view === 'coach' || view === 'team') return pid ? { screen: 'practice', as: view, pid } : { screen: 'list', as: view };
    return { go: routePath({ view: 'editor', pid, did: route.did }) }; // "/", "/request-access"
  }
  // coach or team
  const home = `/${persona}`;
  if (view === 'root' || view === 'editor' || view === 'request') return { go: home };
  if (!pid) return view === 'coach' && persona === 'team' ? { go: '/team' } : { screen: 'list', as: view };
  const role = who.roles?.[pid]; // this practice's role: a coach of one team can be a parent on another
  if (!role) return { screen: 'practice', as: 'team', pid, probe: true }; // not on their list: still tried, since an open practice is for anyone signed in (a refusal explains)
  if (view === 'coach' && role === 'team') return { go: `/team/${pid}` };
  return { screen: 'practice', as: view, pid };
}
