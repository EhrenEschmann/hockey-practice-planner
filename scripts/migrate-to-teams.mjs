// One-off migration from the account-centric layout (users/{uid}/practices, published/, access/, inbox/, club/) to the
// team-centric one (docs/data-model.md). Reads the LIVE database, derives the new documents with the very same
// functions the app uses (js/access.js), writes them, then re-reads and verifies every one. Nothing legacy is
// deleted or modified except the planner's roster, which gains an "Unassigned" team when some practices name no team.
//
//   rehearsal:  firebase emulators:exec --only firestore --project demo-hpp \
//                 "node scripts/migrate-to-teams.mjs --import backups/firestore-<stamp>.json --apply"
//   production: FIRESTORE_TOKEN="$(gcloud auth application-default print-access-token)" node scripts/migrate-to-teams.mjs            (dry run: prints the plan)
//               FIRESTORE_TOKEN=… node scripts/migrate-to-teams.mjs --apply                                                          (writes + verifies)
import { readFileSync, writeFileSync } from 'node:fs';
import { peopleDocs, memberDocs, playerDocs, teamDoc, clubDoc, practiceHeader, practiceBody, practiceFromParts, migrateClubTeam, weekKey, stageOf } from '../js/access.js';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EMU = process.env.FIRESTORE_EMULATOR_HOST || null;
const PROJECT = EMU ? (process.env.GCLOUD_PROJECT || 'demo-hpp') : 'mite-practice-planner';
const BASE = EMU ? `http://${EMU}/v1/projects/${PROJECT}/databases/(default)/documents` : `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = EMU ? 'owner' : process.env.FIRESTORE_TOKEN;
if (!token) { console.error('FIRESTORE_TOKEN is required (gcloud auth application-default print-access-token)'); process.exit(2); }
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const PLANNERS = ['ehren.eschmann@gmail.com'];

// ---------- REST plumbing ----------
async function api(url, init) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { headers: H, ...init });
    if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 500 * 2 ** attempt)); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url}\n${await r.text()}`);
    return r.json();
  }
  throw new Error(`gave up on ${url}`);
}
const rel = name => name.split('/documents/')[1];
const full = path => `projects/${PROJECT}/databases/(default)/documents/${path}`;
async function listCollections(docPath) { const r = await api(`${BASE}${docPath ? `/${docPath}` : ''}:listCollectionIds`, { method: 'POST', body: '{}' }); return r.collectionIds || []; }
async function listDocs(parent, col) {
  const out = []; let pt = '';
  do {
    const r = await api(`${BASE}${parent ? `/${parent}` : ''}/${col}?pageSize=300&showMissing=true${pt ? `&pageToken=${pt}` : ''}`);
    for (const d of r.documents || []) out.push(d);
    pt = r.nextPageToken || '';
  } while (pt);
  return out;
}
/** Every document under `roots` (top-level collections; all of them when empty): [{ path, fields, missing }]. */
async function dump(roots = []) {
  const docs = [];
  const walk = async (parent, only) => {
    for (const col of await listCollections(parent)) {
      if (only && !only.includes(col)) continue;
      for (const d of await listDocs(parent, col)) { const path = rel(d.name); docs.push({ path, fields: d.fields || null, missing: !d.createTime }); await walk(path, null); }
    }
  };
  await walk('', roots.length ? roots : null);
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}
/** Commit writes in batches: at most 400 per request and well under the 10 MiB request limit (video chunks are ~1 MB each). */
async function commitAll(writes, label) {
  let batch = [], bytes = 0, done = 0;
  const flush = async () => { if (!batch.length) return; await api(`${BASE.replace(/\/documents$/, '')}/documents:commit`, { method: 'POST', body: JSON.stringify({ writes: batch }) }); done += batch.length; process.stderr.write(`  ${label}: ${done} / ${writes.length}\n`); batch = []; bytes = 0; };
  for (const w of writes) {
    const n = JSON.stringify(w).length;
    if (batch.length >= 400 || bytes + n > 8_000_000) await flush();
    batch.push(w); bytes += n;
  }
  await flush();
}

// ---------- typed values ⇄ JS ----------
const dec = v => { if (v == null) return null; const k = Object.keys(v)[0], x = v[k];
  switch (k) { case 'nullValue': return null; case 'booleanValue': case 'stringValue': return x; case 'integerValue': return Number(x); case 'doubleValue': return x;
    case 'arrayValue': return (x.values || []).map(dec); case 'mapValue': return Object.fromEntries(Object.entries(x.fields || {}).map(([a, b]) => [a, dec(b)]));
    default: throw new Error(`unsupported Firestore value type ${k} (timestamps/references/bytes are not expected in this database)`); } };
const decode = f => Object.fromEntries(Object.entries(f || {}).map(([a, b]) => [a, dec(b)]));
const enc = v => { if (v === null || v === undefined) return { nullValue: null }; if (typeof v === 'boolean') return { booleanValue: v }; if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 2 ** 53 ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } }; return { mapValue: { fields: encode(v) } }; };
const encode = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, enc(v)]));
const canon = v => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v);
const clean = o => JSON.parse(JSON.stringify(o));
const norm = e => String(e || '').trim().toLowerCase();

// ---------- the plan: a pure function of the legacy documents ----------
function plan(legacy) {
  const byPath = new Map(legacy.filter(d => !d.missing).map(d => [d.path, d]));
  const get = p => byPath.has(p) ? decode(byPath.get(p).fields) : null;
  const notes = [];
  // The planner: whoever owns the roster (there is exactly one planner account).
  const rosterPaths = [...byPath.keys()].filter(p => /^users\/[^/]+\/meta\/roster$/.test(p));
  if (rosterPaths.length !== 1) throw new Error(`expected exactly one roster, found ${rosterPaths.length}: ${rosterPaths.join(', ')}`);
  const uid = rosterPaths[0].split('/')[1];
  const roster = get(rosterPaths[0]);
  roster.teams = (roster.teams || []).filter(t => t?.id);
  for (const t of roster.teams) migrateClubTeam(t, weekKey());
  const practices = [...byPath.keys()].filter(p => new RegExp(`^users/${uid}/practices/[^/]+$`).test(p)).map(p => get(p));
  const otherPractices = [...byPath.keys()].filter(p => /^users\/[^/]+\/practices\/[^/]+$/.test(p) && !p.startsWith(`users/${uid}/`));
  if (otherPractices.length) notes.push(`${otherPractices.length} practice documents under other accounts (blank starters from older sign-ins) are left where they are and not migrated: ${otherPractices.map(p => p.split('/')[1].slice(0, 6) + '…/' + p.split('/')[3]).join(', ')}`);
  // Which team is each practice filed under? Its teamId when that team exists, else the team named on it, else "Unassigned".
  const byName = new Map(roster.teams.map(t => [norm(t.name), t]));
  let unassigned = roster.teams.find(t => t.name === 'Unassigned') || null;
  const teamOf = p => {
    if (p.teamId && roster.teams.some(t => t.id === p.teamId)) return p.teamId;
    const t = byName.get(norm(p.team)); if (t) return t.id;
    if (!unassigned) { unassigned = { id: 'unassigned', name: 'Unassigned', coaches: [], players: [] }; roster.teams.push(unassigned); notes.push('an "Unassigned" team was added to the roster for the practices that name no team'); }
    return unassigned.id;
  };
  const writes = [], expect = new Map(); // path → JS value we expect to read back
  const put = (path, value) => { const v = clean(value); writes.push({ update: { name: full(path), fields: encode(v) } }); expect.set(path, v); };
  const copy = (from, to) => { writes.push({ update: { name: full(to), fields: byPath.get(from).fields || {} } }); expect.set(to, decode(byPath.get(from).fields)); };
  const stats = { practices: 0, bodies: 0, clips: 0, videos: 0, views: 0, feedback: 0, teams: 0, members: 0, players: 0, people: 0, tasks: 0, clubStats: 0, clubMedia: 0 };
  for (const p0 of practices) {
    const p = { ...p0, teamId: teamOf(p0), owner: uid }; // the owner's uid rides on the header, as the app writes it
    const t = p.teamId;
    put(`teams/${t}/practices/${p.id}`, practiceHeader(p)); stats.practices++;
    put(`teams/${t}/practices/${p.id}/plan/body`, practiceBody(p)); stats.bodies++;
    put(`practiceIndex/${p.id}`, { teamId: t });
    for (const [sub, key] of [['clips', 'clips'], ['videos', 'videos'], ['views', 'views']]) {
      const prefix = `users/${uid}/practices/${p.id}/${sub}/`;
      for (const path of byPath.keys()) if (path.startsWith(prefix) && path.split('/').length === 6) { copy(path, `teams/${t}/practices/${p.id}/${sub}/${path.split('/')[5]}`); stats[key]++; }
    }
    const fbPrefix = `published/${p.id}/feedback/`; // a coach's notes lived under the published copy
    for (const path of byPath.keys()) if (path.startsWith(fbPrefix) && path.split('/').length === 4) { copy(path, `teams/${t}/practices/${p.id}/feedback/${path.split('/')[3]}`); stats.feedback++; }
  }
  const pids = new Set(practices.map(p => p.id));
  for (const path of byPath.keys()) { // anything published or logged for a practice the planner no longer has would be lost: refuse
    const m = path.match(/^(?:published|access)\/([^/]+)/); if (m && !pids.has(m[1])) throw new Error(`${path} has no source practice under users/${uid}/practices`);
    const v = path.match(/^users\/([^/]+)\/practices\/([^/]+)\/(clips|videos|views)\//); if (v && v[1] === uid && !pids.has(v[2])) throw new Error(`${path} belongs to no practice`);
  }
  // Teams, members, players, people and week lists: exactly what the app's syncTeams() derives from the roster.
  for (const t of roster.teams) {
    put(`teams/${t.id}`, teamDoc(t)); stats.teams++;
    for (const [email, m] of memberDocs(t)) { put(`teams/${t.id}/members/${email}`, m); stats.members++; }
    for (const [id, pl] of playerDocs(t)) { put(`teams/${t.id}/players/${id}`, pl); stats.players++; }
    for (const [w, list] of Object.entries(clubDoc(t)?.weeks || {})) { put(`teams/${t.id}/tasks/${w}`, { week: w, tasks: list }); stats.tasks++; }
    // A club team's logged numbers and how-to media (club/{t}/stats, club/{t}/media) move under the team verbatim.
    for (const path of byPath.keys()) {
      const s = path.match(new RegExp(`^club/${t.id}/(stats|media)/([^/]+)$`));
      if (s) { copy(path, `teams/${t.id}/${s[1]}/${s[2]}`); stats[s[1] === 'stats' ? 'clubStats' : 'clubMedia']++; }
    }
  }
  for (const path of byPath.keys()) { const m = path.match(/^club\/([^/]+)\/(stats|media)\//); if (m && !roster.teams.some(t => t.id === m[1])) throw new Error(`${path} belongs to a team that is not on the roster`); }
  for (const [email, doc] of peopleDocs(roster)) { if (email.includes('/')) continue; put(`people/${email}`, doc); stats.people++; }
  if (unassigned && !roster.teams.includes(unassigned)) roster.teams.push(unassigned);
  const rosterChanged = canon(roster) !== canon(get(rosterPaths[0]));
  if (rosterChanged) { roster.updatedAt = Date.now(); put(rosterPaths[0], roster); notes.push('the roster document is rewritten (newer updatedAt) so every device picks up the change'); }
  // What the app will reconstruct from header + body must be the original practice (plus its team, owner and effective stage).
  const roundTrip = practices.map(p0 => { const p = clean({ ...p0, teamId: teamOf(p0), owner: uid }); return { pid: p.id, teamId: p.teamId, want: canon({ ...p, stage: stageOf(p) }) }; });
  return { uid, writes, expect, stats, notes, roster, roundTrip, unassignedCount: practices.filter(p => teamOf(p) === unassigned?.id).length };
}

// ---------- run ----------
const t0 = Date.now();
if (opt('--import')) { // rehearsal: load a backup into the (emulator) database first, verbatim
  if (!EMU) { console.error('--import is only for the emulator'); process.exit(2); }
  const saved = JSON.parse(readFileSync(opt('--import'), 'utf8'));
  await commitAll(saved.documents.filter(d => !d.missing).map(d => ({ update: { name: full(d.path), fields: d.fields || {} } })), 'import');
  console.log(`imported ${saved.documents.filter(d => !d.missing).length} documents from ${opt('--import')}`);
}
console.log(`reading ${EMU ? `the emulator (${EMU})` : `PRODUCTION (${PROJECT})`}…`);
const before = await dump();
const legacy = before.filter(d => !/^(teams|people|practiceIndex)\//.test(d.path));
const already = before.filter(d => /^(teams|people|practiceIndex)\//.test(d.path));
if (already.length && !flag('--force')) { console.error(`${already.length} documents already exist under teams/, people/ or practiceIndex/ — this migration has run before. Use --force to overwrite them.`); process.exit(1); }
const P = plan(legacy);
console.log(`\nplan (planner ${P.uid}):`);
for (const [k, v] of Object.entries(P.stats)) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log(`  ${String(P.writes.length).padStart(5)}  documents to write in all (${(JSON.stringify(P.writes).length / 1048576).toFixed(1)} MB)`);
console.log(`  teams: ${P.roster.teams.map(t => `${t.name} (${t.id})`).join(', ')}${P.unassignedCount ? ` — ${P.unassignedCount} practices go to Unassigned` : ''}`);
for (const n of P.notes) console.log(`  note: ${n}`);
if (!flag('--apply')) { console.log('\ndry run — nothing written. Add --apply to migrate.'); process.exit(0); }

await commitAll(P.writes, 'write');
console.log('\nverifying…');
const after = await dump();
const byPath = new Map(after.filter(d => !d.missing).map(d => [d.path, d]));
let okCount = 0; const bad = [];
for (const [path, want] of P.expect) { const got = byPath.get(path); if (!got) bad.push(`${path}: missing`); else if (canon(decode(got.fields)) !== canon(want)) bad.push(`${path}: differs`); else okCount++; }
for (const r of P.roundTrip) { // header + body → the practice the editor and viewer will work with
  const h = byPath.get(`teams/${r.teamId}/practices/${r.pid}`), b = byPath.get(`teams/${r.teamId}/practices/${r.pid}/plan/body`);
  if (!h || !b) { bad.push(`${r.pid}: header or body missing`); continue; }
  const got = canon(practiceFromParts(decode(h.fields), decode(b.fields)));
  if (got !== r.want) bad.push(`${r.pid}: header + body do not rebuild the original practice\n    want ${r.want.slice(0, 300)}\n    got  ${got.slice(0, 300)}`);
}
// The legacy documents must be exactly as they were (the roster aside, which the plan rewrote on purpose).
const beforeMap = new Map(before.map(d => [d.path, d]));
let untouched = 0; const touched = [];
for (const [path, d] of beforeMap) { if (P.expect.has(path)) continue; const now = byPath.get(path); if (!now && !d.missing) touched.push(`${path}: gone`); else if (now && canon(now.fields) !== canon(d.fields)) touched.push(`${path}: changed`); else untouched++; }
console.log(`${okCount} / ${P.expect.size} new documents read back identical; ${P.roundTrip.length} practices rebuild from header + body; ${untouched} legacy documents untouched${touched.length ? `; CHANGED: ${touched.join(', ')}` : ''}`);
if (bad.length) console.log(`PROBLEMS:\n  ${bad.join('\n  ')}`);
const report = `backups/migration-${EMU ? 'rehearsal' : 'production'}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.json`;
writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), target: EMU || PROJECT, stats: P.stats, notes: P.notes, written: [...P.expect.keys()], problems: bad, touched }, null, 1));
console.log(`report: ${report} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(bad.length || touched.length ? 1 : 0);
