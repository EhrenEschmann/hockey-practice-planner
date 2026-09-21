// Routing & authorization logic (docs/requirements-routing-auth.md) — pure functions, no DOM and no Firebase,
// shared by the editor (what to publish, and to whom) and the viewer (where a person may be).
//
// Cloud layout this feeds (rules in firestore.rules):
//   users/{uid}/practices/{pid}     the planner's working document — planner only
//   published/{pid}                 the copy coaches and the team read (written while stage ≠ draft)
//   published/{pid}/feedback/{fid}  a coach's feedback: one document per coach per drill (fid = `${uid}_${drillId|overall}`)
//   access/{pid}                    { stage, coach: [emails], team: [emails] } — planner only; the rules look people up here
//   inbox/{email}                   { persona, practices: { [pid]: { role, team, date, time } } } — that person's list
//   requests/{uid}                  an access request from someone who is on no roster

export const STAGES = ['draft', 'coaches', 'team'];
export const STAGE_LABELS = { draft: 'Draft — only you', coaches: 'Out to coaches for feedback', team: 'Released to the team' };

const norm = e => String(e || '').trim().toLowerCase();
const emails = list => [...new Set((list || []).map(norm).filter(Boolean))];

/** A practice's stage. Practices shared before stages existed keep their audience: a team list → 'team', a coach list → 'coaches'. */
export function stageOf(p) {
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
  return { stage: stageOf(p), coach, team };
}

/** What coaches and the team download: the practice without its access lists, stage bookkeeping or hidden drills. */
export function publishedCopy(p, owner) {
  const c = JSON.parse(JSON.stringify(p));
  for (const k of ['sharedWith', 'sharedTeam', 'stage', 'sentCoachesAt', 'sentTeamAt']) delete c[k];
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
    const card = role => ({ role, team: p.team || '', date: p.date || '', time: p.time || '' });
    for (const e of a.coach) { const d = doc(e); d.persona = 'coach'; d.practices[p.id] = card('coach'); }
    if (a.stage === 'team') for (const e of a.team) doc(e).practices[p.id] = card('team');
    else for (const e of a.team) doc(e); // known to the app (not a stranger), nothing to open yet
  }
  return out;
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
  if (persona === 'unknown') return view === 'request' ? { screen: 'request' } : { go: '/request-access' };
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
  if (!role) return { screen: 'unavailable', as: persona, pid };
  if (view === 'coach' && role === 'team') return { go: `/team/${pid}` };
  return { screen: 'practice', as: view, pid };
}
