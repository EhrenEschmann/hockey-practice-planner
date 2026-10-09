// Routing & authorization logic (docs/requirements-routing-auth.md) — pure functions, no DOM and no Firebase,
// shared by the editor (what to publish, and to whom) and the viewer (where a person may be).
//
// Cloud layout this feeds (docs/data-model.md; the guarantees are in firestore.rules): everything lives under its team.
//   teams/{teamId}                            teamDoc(): { id, name, club, admins }
//   teams/{teamId}/members/{email}            memberDocs(): { role: 'coach' | 'family', name, playerIds }
//   teams/{teamId}/players/{playerId}         playerDocs(): { name, contacts }
//   teams/{teamId}/practices/{pid}            practiceHeader(): the light part every list reads; `stage` gates who may read it
//   teams/{teamId}/practices/{pid}/plan/body  practiceBody(): the drills
//   …/practices/{pid}/clips|videos|views|feedback
//   teams/{teamId}/tasks/{week}, stats/{pid_week}, media/{id}   an official club team's week lists, numbers and how-tos
//   people/{email}                            peopleDocs(): that person's teams and roles — read once at start
//   practiceIndex/{pid}                       { teamId } for older links that named the practice alone

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
/**
 * Each person's own document (people/{email}): their persona and the teams they are on, with their role there and,
 * for a family, which players are theirs. The viewer reads it once at start; every list after that is per team.
 */
export function peopleDocs(roster) {
  const out = new Map();
  const doc = e => { if (!out.has(e)) out.set(e, { persona: 'team', teams: {} }); return out.get(e); };
  for (const t of roster?.teams || []) {
    if (!t.id) continue;
    const coaches = rosterCoachEmails(t);
    for (const e of coaches) { const d = doc(e); d.persona = 'coach'; d.teams[t.id] = { name: t.name || '', role: 'coach', ...(t.club ? { club: true } : {}) }; }
    for (const pl of t.players || []) for (const e of emails((pl.contacts || []).map(k => k.email))) {
      if (coaches.includes(e)) continue; // a coach-parent is a coach on that team
      const d = doc(e), entry = d.teams[t.id] ||= { name: t.name || '', role: 'family', players: [], ...(t.club ? { club: true } : {}) };
      if (!pl.id) continue;
      entry.players ||= [];
      if (!entry.players.some(x => x.id === pl.id)) entry.players.push({ id: pl.id, name: pl.name || '' });
    }
  }
  return out;
}
/** The member documents a team needs (teams/{t}/members/{email}): coaches as 'coach', family contacts as 'family' with their players. */
export function memberDocs(t) {
  const out = new Map();
  for (const e of rosterCoachEmails(t)) out.set(e, { role: 'coach', name: (t.coaches || []).find(c => norm(c.email) === e)?.name || '', playerIds: [] });
  for (const pl of t.players || []) for (const k of pl.contacts || []) {
    const e = norm(k.email); if (!e || !pl.id) continue;
    if (out.has(e)) { if (!out.get(e).playerIds.includes(pl.id)) out.get(e).playerIds.push(pl.id); continue; }
    out.set(e, { role: 'family', name: k.name || '', playerIds: [pl.id] });
  }
  return out;
}
/** The player documents (teams/{t}/players/{id}): name and the family emails that may log for them. */
export const playerDocs = t => new Map((t.players || []).filter(pl => pl.id).map(pl => [pl.id, { name: pl.name || '', contacts: emails((pl.contacts || []).map(k => k.email)) }]));
/** The team document (teams/{t}). `admins` are extra editors by email; the planner is always one. */
export const teamDoc = t => ({ id: t.id, name: t.name || '', club: !!t.club, admins: emails(t.admins || []), updatedAt: t.updatedAt || 0 });

// ---- a practice in the cloud: a light HEADER (lists, calendars, the rules) and a heavy BODY (the drills)
const HEADER_FIELDS = ['id', 'teamId', 'kind', 'team', 'opponent', 'date', 'time', 'coaches', 'open', 'sharedWith', 'sharedTeam', 'sentCoachesAt', 'sentTeamAt', 'deleted', 'updatedAt', 'owner', 'showPaths'];
export function practiceHeader(p) {
  const h = {};
  for (const k of HEADER_FIELDS) if (p[k] !== undefined && p[k] !== null) h[k] = p[k];
  const drills = (p.drills || []).filter(d => !d.hidden);
  h.stage = stageOf(p); // the effective stage: a deleted practice reads as a draft
  h.drillNames = drills.map(d => d.name || '').slice(0, 60);
  h.drillCount = drills.length;
  h.minutes = drills.reduce((a, d) => a + (+d.duration || 0), 0);
  h.hasVideo = drills.some(d => d.upload || d.video);
  return h;
}
export const practiceBody = p => ({ id: p.id, teamId: p.teamId || null, drills: p.drills || [], updatedAt: p.updatedAt || 0 });
/** Header + body back into the practice object the editor and viewer work with. */
export const practiceFromParts = (h, body) => { const p = { ...h, drills: body?.drills || [] }; delete p.drillNames; delete p.drillCount; delete p.minutes; delete p.hasVideo; return p; };

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
  for (const [w, wk] of Object.entries(t.weeks || {})) { if (!/^\d{4}-(\d{2}-\d{2}|W\d{2})$/.test(w)) continue; const list = clean(wk?.tasks); if (list.length) weeks[normalWeek(w)] = list; }
  return { id: t.id, name: t.name || '', weeks, coaches: coach, members, players, updatedAt: t.updatedAt || 0 };
}
/** The task list a club document holds for a week ([] when none is set). */
export const tasksForWeek = (doc, week) => doc?.weeks?.[week] || [];
/** A legacy team that still carries one recurring list: it becomes this week's list. */
export function migrateClubTeam(t, thisWeek) {
  if (!t) return t;
  if (Array.isArray(t.tasks)) { t.weeks ||= {}; if (t.tasks.length && !t.weeks[thisWeek]?.tasks?.length) t.weeks[thisWeek] = { tasks: t.tasks }; delete t.tasks; }
  for (const w of Object.keys(t.weeks || {})) { // Monday-week keys from before move onto their Sunday week
    if (!/^\d{4}-W\d{2}$/.test(w)) continue;
    const k = normalWeek(w);
    if (!t.weeks[k]?.tasks?.length) t.weeks[k] = t.weeks[w];
    delete t.weeks[w];
  }
  return t;
}
/**
 * Weeks run Sunday to Saturday. A week's key is the date of its Sunday, 'YYYY-MM-DD' — the key task lists and stats
 * are filed under. (Keys from before — ISO 'YYYY-Www', Monday weeks — are still read: see legacyWeek / weekStart.)
 */
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function weekKey(d = new Date()) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - s.getDay()); // back to Sunday
  return ymd(s);
}
export const isoWeek = weekKey; // older name
/** The day a week key starts on (local midnight): its Sunday — or, for an old ISO key, the Sunday before that week's Monday. */
export function weekStart(key) {
  const k = String(key || '');
  let m = k.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = k.match(/^(\d{4})-W(\d{2})$/); if (!m) return null;
  const y = +m[1], w = +m[2];
  const jan4 = new Date(y, 0, 4), day = jan4.getDay() || 7; // ISO week 1 holds 4 January
  const monday = new Date(y, 0, 4 - (day - 1) + (w - 1) * 7);
  monday.setDate(monday.getDate() - 1); // the Sunday-to-Saturday week that holds most of that ISO week
  return monday;
}
/** The current-form key for any key (an old ISO key maps onto the Sunday week holding its Monday–Saturday). */
export const normalWeek = key => { const s = weekStart(key); return s ? weekKey(s) : key; };
/** The old ISO key that a Sunday-week's numbers may still be filed under (its Monday's ISO week). */
export function legacyWeek(key) {
  const s = weekStart(key); if (!s) return null;
  const x = new Date(Date.UTC(s.getFullYear(), s.getMonth(), s.getDate() + 1)); // the Monday
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const y = x.getUTCFullYear();
  return `${y}-W${String(Math.ceil(((x - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
/** The week key `n` weeks away from `key`. */
export function shiftWeek(key, n) { const s = weekStart(key); if (!s) return key; s.setDate(s.getDate() + 7 * n); return weekKey(s); }
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
  // /coach/{teamId}/{pid}; /coach/{teamId} is a team's list. A lone /coach/{x} is either (older links named the practice
  // alone): `ambiguous` — resolveRoute tells a team id from a practice id by what the person is on.
  if ((a === 'coach' || a === 'team') && seg.length <= 3) return c ? { view: a, teamId: b, pid: c, did: null } : { view: a, teamId: null, pid: b || null, did: null, ambiguous: !!b };
  if (a === 'request-access' && seg.length === 1) return { view: 'request', pid: null, did: null };
  return { view: 'unknown', pid: null, did: null };
}
export function routePath({ view, teamId = null, pid, did }) {
  if (view === 'editor') return `/editor${pid ? `/${pid}${did ? `/${did}` : ''}` : ''}`;
  if (view === 'coach' || view === 'team') return `/${view}${teamId ? `/${teamId}` : ''}${pid ? `/${pid}` : ''}`;
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
  const persona = who?.persona || 'anonymous';
  const { view } = route;
  if (view === 'unknown') return { go: '/' };
  if (route.legacy && view !== 'root') return { go: routePath(route) };
  if (persona === 'anonymous') return { screen: 'signin' };
  // A lone id after /coach or /team: a team this person is on, else a practice (an older link). A practice whose team
  // is known gets its full path; otherwise it is opened as it is and the app fills the team in once it has loaded.
  let { teamId, pid } = route;
  const teams = who?.teams || [];
  if (route.ambiguous) {
    if (teams.some(t => t.id === pid)) { teamId = pid; pid = null; }
    else if (who?.practiceTeam?.[pid]) return { go: routePath({ view, teamId: who.practiceTeam[pid], pid }) };
  }
  if (persona === 'guest') { // signed in anonymously: may watch open practices, has no list of their own
    if (view === 'coach' && pid) return { go: routePath({ view: 'team', teamId, pid }) };
    if (view === 'team' && pid) return { screen: 'practice', as: 'team', teamId, pid };
    return { screen: 'signin' };
  }
  // A signed-in account on no roster: a practice link is still tried, as the team sees it — an open practice lets
  // anyone signed in watch (probe: a refusal sends them on to request access); anything else → request access.
  if (persona === 'unknown') return (view === 'coach' || view === 'team') && pid ? { screen: 'practice', as: 'team', teamId, pid, probe: true } : view === 'request' ? { screen: 'request' } : { go: '/request-access' };
  // A list needs a team: one team → straight to it; several → choose; none → an empty list.
  const listFor = as => teamId ? { screen: 'list', as, teamId } : teams.length === 1 ? { go: routePath({ view: as, teamId: teams[0].id }) } : teams.length ? { screen: 'teams', as } : { screen: 'list', as, teamId: null };
  if (persona === 'planner') {
    if (view === 'editor') return { screen: 'editor', pid, did: route.did };
    if (view === 'coach' || view === 'team') return pid ? { screen: 'practice', as: view, teamId, pid } : listFor(view);
    return { go: routePath({ view: 'editor', pid, did: route.did }) }; // "/", "/request-access"
  }
  // coach or team
  const home = `/${persona}`;
  if (view === 'root' || view === 'editor' || view === 'request') return { go: home };
  if (view === 'coach' && persona === 'team') return { go: routePath({ view: 'team', teamId, pid }) };
  if (!pid) return listFor(view);
  const role = teams.find(t => t.id === teamId)?.role; // their role on that team: 'coach' or 'family' (a coach of one team can be a parent on another)
  if (!role) return { screen: 'practice', as: 'team', teamId, pid, probe: true }; // not their team (or an older link with no team): still tried — an open practice is for anyone signed in, and a refusal explains
  if (view === 'coach' && role !== 'coach') return { go: routePath({ view: 'team', teamId, pid }) };
  return { screen: 'practice', as: view, teamId, pid };
}
