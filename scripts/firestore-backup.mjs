// Full Firestore backup over the REST API — every collection, every document, every subcollection, in the API's own
// typed value format (so a restore is byte-exact). Then a second pass re-reads everything and compares.
//   FIRESTORE_TOKEN="$(gcloud auth application-default print-access-token)" node scripts/firestore-backup.mjs [verify <file>]
import { writeFileSync, readFileSync } from 'node:fs';
const PROJECT = 'mite-practice-planner';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const token = process.env.FIRESTORE_TOKEN; if (!token) { console.error('FIRESTORE_TOKEN is required'); process.exit(2); }
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function api(path, init) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(path, { headers: H, ...init });
    if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 500 * 2 ** attempt)); continue; }
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  }
  throw new Error(`gave up on ${path}`);
}
const rel = name => name.split('/documents/')[1];
async function listCollections(docPath) { const r = await api(`${BASE}${docPath ? `/${docPath}` : ''}:listCollectionIds`, { method: 'POST', body: '{}' }); return r.collectionIds || []; }
async function listDocs(parent, col) {
  const out = []; let token = '';
  do {
    const r = await api(`${BASE}${parent ? `/${parent}` : ''}/${col}?pageSize=300&showMissing=true${token ? `&pageToken=${token}` : ''}`);
    for (const d of r.documents || []) out.push(d);
    token = r.nextPageToken || '';
  } while (token);
  return out;
}
/** Walk the whole database: returns [{ path, fields, updateTime, missing }] in a stable order. */
async function dump(onProgress = () => {}) {
  const docs = [];
  const walk = async parent => {
    for (const col of await listCollections(parent)) {
      for (const d of await listDocs(parent, col)) {
        const path = rel(d.name);
        docs.push({ path, fields: d.fields || null, updateTime: d.updateTime || null, missing: !d.createTime });
        onProgress(docs.length, path);
        await walk(path); // subcollections (clips, videos, views, feedback, stats, media…)
      }
    }
  };
  await walk('');
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}
/** A key-order-independent serialization: the API may return map keys in any order. */
const canon = v => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v);
const summary = docs => { const by = {}; for (const d of docs) { const top = d.path.split('/').filter((_, i) => i % 2 === 0).join('/'); by[top] = (by[top] || 0) + 1; } return by; };
const mode = process.argv[2] || 'backup';
if (mode === 'backup') {
  const t0 = Date.now();
  const docs = await dump((n, p) => { if (n % 50 === 0) process.stderr.write(`  ${n} documents… (${p.slice(0, 70)})\n`); });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const file = `backups/firestore-${stamp}.json`;
  const bytes = JSON.stringify({ project: PROJECT, at: new Date().toISOString(), count: docs.length, documents: docs });
  writeFileSync(file, bytes);
  console.log(`\n${docs.length} documents → ${file} (${(bytes.length / 1048576).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log('per collection path:'); for (const [k, v] of Object.entries(summary(docs)).sort()) console.log(`  ${String(v).padStart(5)}  ${k}`);
  // ---- verify: read it all again and compare field by field
  const again = await dump();
  const byPath = new Map(again.map(d => [d.path, d]));
  let same = 0, changed = 0, gone = 0;
  for (const d of docs) { const b = byPath.get(d.path); if (!b) gone++; else if (canon(b.fields) === canon(d.fields)) same++; else { changed++; console.log(`  ≠ ${d.path}`); } }
  const added = again.filter(d => !docs.some(x => x.path === d.path)).length;
  console.log(`verify: ${same} identical, ${changed} changed since the dump, ${gone} gone, ${added} new (changes mean the app was being used meanwhile)`);
  process.exit(changed || gone ? 1 : 0);
} else if (mode === 'verify') {
  const saved = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const live = await dump(); const byPath = new Map(live.map(d => [d.path, d]));
  let same = 0; const diffs = [];
  for (const d of saved.documents) { const b = byPath.get(d.path); if (b && canon(b.fields) === canon(d.fields)) same++; else diffs.push(d.path); }
  console.log(`${same} / ${saved.documents.length} documents match the live database${diffs.length ? `; differ: ${diffs.join(', ')}` : ''}`);
  process.exit(diffs.length ? 1 : 0);
}
