// Deletes the collections the team-centric layout replaced: published/, access/, inbox/, club/ and users/{uid}/practices
// (with their clips, videos and views). ONLY after the migration has been verified and the new app has been in use.
// Refuses unless --yes-delete-legacy is given; prints what it would delete otherwise. Take a backup first:
//   FIRESTORE_TOKEN="$(gcloud auth application-default print-access-token)" node scripts/firestore-backup.mjs
//   FIRESTORE_TOKEN=… node scripts/cleanup-legacy.mjs [--yes-delete-legacy]
const PROJECT = 'mite-practice-planner';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = process.env.FIRESTORE_TOKEN; if (!token) { console.error('FIRESTORE_TOKEN is required'); process.exit(2); }
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function api(url, init) { const r = await fetch(url, { headers: H, ...init }); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); }
const rel = name => name.split('/documents/')[1];
async function listCollections(docPath) { const r = await api(`${BASE}${docPath ? `/${docPath}` : ''}:listCollectionIds`, { method: 'POST', body: '{}' }); return r.collectionIds || []; }
async function listDocs(parent, col) { const out = []; let pt = ''; do { const r = await api(`${BASE}${parent ? `/${parent}` : ''}/${col}?pageSize=300&showMissing=true${pt ? `&pageToken=${pt}` : ''}`); out.push(...(r.documents || [])); pt = r.nextPageToken || ''; } while (pt); return out; }
async function under(parent, col) { const out = []; for (const d of await listDocs(parent, col)) { const p = rel(d.name); for (const c of await listCollections(p)) out.push(...await under(p, c)); if (d.createTime) out.push(p); } return out; }
// The team layout must be populated before anything legacy goes.
const teams = await listDocs('', 'teams');
if (!teams.length) { console.error('no teams/ documents — the migration has not run; nothing deleted'); process.exit(1); }
const doomed = [];
for (const col of ['published', 'access', 'inbox', 'club']) doomed.push(...await under('', col));
for (const u of await listDocs('', 'users')) doomed.push(...await under(rel(u.name), 'practices'));
console.log(`${doomed.length} legacy documents${process.argv.includes('--yes-delete-legacy') ? ' — deleting' : ' would be deleted (add --yes-delete-legacy)'}`);
for (const p of doomed) console.log(`  ${p}`);
if (!process.argv.includes('--yes-delete-legacy')) process.exit(0);
for (let i = 0; i < doomed.length; i += 400) {
  await api(`${BASE.replace(/\/documents$/, '')}/documents:commit`, { method: 'POST', body: JSON.stringify({ writes: doomed.slice(i, i + 400).map(p => ({ delete: `projects/${PROJECT}/databases/(default)/documents/${p}` })) }) });
  console.log(`  deleted ${Math.min(i + 400, doomed.length)} / ${doomed.length}`);
}
