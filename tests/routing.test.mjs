// Browser tests for docs/requirements-routing-auth.md §11 — headless Chrome driven over CDP, the real app served by
// serve.js, and tests/fake-cloud.mjs standing in for Firebase.   Run:  npm run test:routes   (CHROME=/path/to/chrome to override)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeCloud, pageBackend } from './fake-cloud.mjs';

const APP = 5191, CLOUD = 5192, ORIGIN = `http://localhost:${APP}`;
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = new URL('..', import.meta.url).pathname;
const kids = [], dirs = [];

const U = {
  planner: { uid: 'own', email: 'ehren.eschmann@gmail.com', name: 'Ehren' },
  coachA: { uid: 'ca', email: 'Coach.A@example.com', name: 'Coach A' }, coachB: { uid: 'cb', email: 'coachb@example.com', name: 'Coach B' },
  parent: { uid: 'pa', email: 'parent@example.com', name: 'Pat Parent' }, stranger: { uid: 'st', email: 'gran@example.com', name: 'Gran' },
};
const today = new Date(), iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const drill = (id, name, extra = {}) => ({ id, name, duration: 10, notes: `notes for ${name}`, view: { x: 0, y: 0, w: 200, h: 85 }, objects: [], ...extra });
const SEED = { ownerUid: 'own', currentId: 'p1', practices: [
  { id: 'p1', team: 'Mites', date: iso(today), time: '17:00', stage: 'team', updatedAt: 5, sharedWith: ['guest@example.com'], drills: [drill('d1', 'Warmup'), drill('d2', 'Secret', { hidden: true }), drill('d3', 'Scrimmage')] },
  { id: 'p2', team: 'Mites', date: iso(new Date(+today + 86400000)), stage: 'coaches', updatedAt: 5, drills: [drill('d4', 'Edges')] },
  { id: 'p3', team: 'Mites', date: iso(new Date(+today + 2 * 86400000)), stage: 'draft', updatedAt: 5, drills: [drill('d5', 'Draft drill')] }],
  roster: { updatedAt: 5, teams: [{ id: 't1', name: 'Mites', coaches: [{ id: 'c1', name: 'Coach A', email: 'coach.a@example.com' }, { id: 'c2', name: 'Coach B', email: 'CoachB@example.com' }],
    players: [{ id: 'pl1', name: 'Sam', contacts: [{ id: 'k1', rel: 'mom', name: 'Pat', email: 'parent@example.com' }] }] }] } };

/** One signed-in (or not) browser: its own Chrome profile, so nothing leaks between personas. */
async function browser(user, { signInAs = null, seed = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hpp-test-')); dirs.push(dir);
  const port = 9500 + kids.length;
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' }); kids.push(proc);
  let tabs; for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
  const send = (method, params = {}) => new Promise(r => { pending.set(++id, d => r(d.result)); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: pageBackend(CLOUD, user, signInAs)
    + `;window.confirm = () => true; window.alert = m => { (window.__alerts ||= []).push(m); };`
    + (seed ? `;if (!localStorage.getItem('hpp.v1')) localStorage.setItem('hpp.v1', ${JSON.stringify(JSON.stringify(seed))});` : '') });
  const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n  in: ${expr}`); return r.result.value; };
  const b = {
    ev,
    open: async path => { await send('Page.navigate', { url: ORIGIN + path }); await sleep(300); await b.settle(); },
    /** wait until the viewer/editor has stopped "checking" and "loading" */
    settle: async () => { for (let i = 0; i < 60; i++) { await sleep(150); if (await ev(`!!document.querySelector('#present') && !['Checking your sign-in…','Loading…'].includes(document.querySelector('#present-gate').hidden ? '' : document.querySelector('#present-msg').textContent)`)) break; } await sleep(250); },
    until: async (expr, what, ms = 6000) => { for (let t = 0; t < ms; t += 150) { if (await ev(expr)) return true; await sleep(150); } fail(`timed out: ${what}`); return false; },
    path: () => ev('location.pathname + location.hash'),
    state: () => ev(`({ path: location.pathname, editor: getComputedStyle(document.querySelector('#layout')).display !== 'none', editorBuilt: document.querySelector('#practice-select').options.length > 0,
      msg: document.querySelector('#present-gate').hidden || document.querySelector('#present').hidden ? null : document.querySelector('#present-msg').textContent,
      title: document.querySelector('#present-title').textContent, cards: [...document.querySelectorAll('#present-body .pr-drill header b')].map(x => x.textContent),
      list: [...document.querySelectorAll('#present-body .pl-item')].map(x => x.getAttribute('href')), fb: document.querySelectorAll('#present-body .pr-fb').length,
      signIn: !document.querySelector('#present-signin').hidden, request: !document.querySelector('#present-request').hidden })`),
    click: sel => ev(`document.querySelector(${JSON.stringify(sel)}).click()`),
  };
  return b;
}

let n = 0, failed = 0;
const fail = msg => { failed++; console.log(`  ✗ ${msg}`); };
const ok = (name, cond, detail) => { n++; if (cond) console.log(`  ✓ ${name}`); else fail(`${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`); };

const app = spawn('node', ['serve.js'], { cwd: root, env: { ...process.env, PORT: String(APP) }, stdio: 'ignore' }); kids.push(app);
const cloud = startFakeCloud(CLOUD);
const reads = (email, path) => cloud.log.filter(l => l.user === email && l.path === path && l.op === 'get');
try {
  console.log('planner: "/" is the editor\'s front door, and saving publishes');
  const planner = await browser(U.planner, { seed: SEED });
  await planner.open('/');
  let s = await planner.state();
  ok('planner on "/" lands in /editor/<practice>/<drill>', /^\/editor\/p1\/d\d$/.test(s.path) && s.editor, s);
  await planner.until(`fetch('http://127.0.0.1:${CLOUD}/', { method: 'POST', body: JSON.stringify({ user: ${JSON.stringify(U.planner)}, op: 'get', path: 'inbox/parent@example.com' }) }).then(r => r.json()).then(r => !!r.data)`, 'publishing after sign-in');
  ok('released practices are published, the draft is not', cloud.db.has('published/p1') && cloud.db.has('published/p2') && !cloud.db.has('published/p3'), [...cloud.db.keys()]);
  const pub = cloud.db.get('published/p1');
  ok('the published copy has no access lists, no hidden drill, and names its owner', !('sharedWith' in pub) && !('stage' in pub) && pub.drills.length === 2 && pub.owner === 'own', pub);
  ok('access lists come from the roster (+ extras), lower-cased, coach wins over team', JSON.stringify(cloud.db.get('access/p1')) === JSON.stringify({ stage: 'team', coach: ['coach.a@example.com', 'coachb@example.com', 'guest@example.com'], team: ['parent@example.com'] }), cloud.db.get('access/p1'));
  ok('each person gets a list document with their persona', cloud.db.get('inbox/coach.a@example.com')?.persona === 'coach' && Object.keys(cloud.db.get('inbox/coach.a@example.com').practices).length === 2
    && cloud.db.get('inbox/parent@example.com')?.persona === 'team' && Object.keys(cloud.db.get('inbox/parent@example.com').practices).join() === 'p1', cloud.db.get('inbox/parent@example.com'));

  console.log('anonymous');
  const anon = await browser(null, { signInAs: U.parent });
  await anon.open('/'); s = await anon.state();
  ok('signed out on "/" → sign-in screen, no editor', s.signIn && !s.editor && !s.editorBuilt, s);
  await anon.open('/coach/p1'); s = await anon.state();
  ok('signed out on a practice link → sign-in, nothing fetched', s.signIn && !s.cards.length && !reads(null, 'published/p1').length, s);
  await anon.click('#present-signin'); await anon.until(`location.pathname === '/team/p1'`, 'after sign-in the parent continues to the practice'); await anon.settle();
  s = await anon.state(); ok('after signing in (as a parent) they continue to the link they opened — as /team/p1', s.path === '/team/p1' && s.cards.length === 3, s);

  console.log('coach');
  const coachA = await browser(U.coachA);
  await coachA.open('/'); s = await coachA.state();
  ok('coach on "/" → /coach, a list of their practices, upcoming first', s.path === '/coach' && s.list.join() === '/coach/p1,/coach/p2', s);
  await coachA.open('/editor'); s = await coachA.state();
  ok('coach on /editor → /coach; the editor is neither shown nor built', s.path === '/coach' && !s.editor && !s.editorBuilt, s);
  await coachA.open('/coach/p2'); s = await coachA.state();
  ok('coach opens a practice that is out for feedback', s.cards.join() === '1. Edges,* Dismissal' && s.fb === 2, s);
  await coachA.open('/coach/p3'); s = await coachA.state();
  ok('coach on a draft → "isn\'t available yet", nothing fetched', /isn't available yet/.test(s.msg) && !reads('coach.a@example.com', 'published/p3').length, s);
  await coachA.open('/coach/p1'); s = await coachA.state();
  ok('coach view: drills (hidden one left out), notes, a feedback button per drill + overall', s.cards.join() === '1. Warmup,2. Scrimmage,* Dismissal' && s.fb === 3 && await coachA.ev(`document.querySelector('#present-body pre').textContent === 'notes for Warmup'`), s);
  await coachA.click('.pr-fb[data-fb="d1"]'); await coachA.ev(`document.querySelector('#fb-text').value = 'Too long for mites'`); await coachA.click('#fb-send');
  await coachA.until(`document.querySelector('.pr-fb[data-fb="d1"]').textContent.includes('✓')`, 'feedback sent');
  ok('coach feedback is stored under their own id', cloud.db.get('published/p1/feedback/ca_d1')?.text === 'Too long for mites', [...cloud.db.keys()]);
  await coachA.open('/team/p1'); s = await coachA.state();
  ok('a coach may open the team link: same page, no feedback', s.path === '/team/p1' && s.cards.length === 3 && s.fb === 0, s);

  const coachB = await browser(U.coachB);
  await coachB.open('/coach/p1'); s = await coachB.state();
  ok('coach B sees the practice but not coach A\'s feedback', s.fb === 3 && await coachB.ev(`![...document.querySelectorAll('.pr-fb')].some(b => b.textContent.includes('✓'))`)
    && !cloud.log.some(l => l.user === 'coachb@example.com' && l.path.includes('feedback') && l.op === 'get'), s);
  ok('coach B has an offline copy now', await coachB.ev(`!!localStorage.getItem('hpp.viewcache.p1')`));

  console.log('team');
  const parent = await browser(U.parent);
  await parent.open('/'); s = await parent.state();
  ok('parent on "/" → /team with the one released practice', s.path === '/team' && s.list.join() === '/team/p1', s);
  await parent.open('/coach/p1'); s = await parent.state();
  ok('parent on a coach link → the matching team link', s.path === '/team/p1' && s.cards.length === 3 && s.fb === 0, s);
  await parent.ev('history.back()'); await sleep(800); await parent.settle();
  ok('Back does not bounce through the redirect', (await parent.path()) === '/team', await parent.path());
  await parent.open('/coach'); ok('parent on /coach → /team', (await parent.path()) === '/team');
  await parent.open('/editor/p1/d1'); s = await parent.state(); ok('parent on /editor → /team, no editor', s.path === '/team' && !s.editor && !s.editorBuilt, s);
  await parent.open('/team/p2'); s = await parent.state();
  ok('parent on a practice still with the coaches → "isn\'t available yet", nothing fetched, nothing revealed', /isn't available yet/.test(s.msg) && !s.title && !reads('parent@example.com', 'published/p2').length, s);
  await parent.open('/#view=own/p1'); ok('old #view= link → the new URL (and on to /team for a parent)', (await parent.path()) === '/team/p1', await parent.path());
  await coachA.open('/#team%3Down%2Fp1'); ok('old percent-encoded #team= link → /team/p1', (await coachA.path()) === '/team/p1', await coachA.path());
  await coachA.open('/coach/p1/extra/bits'); ok('unknown path → "/" → home', (await coachA.path()) === '/coach', await coachA.path());

  console.log('planner: feedback, previews');
  await planner.open('/editor/p1');
  await planner.until(`document.querySelector('#btn-feedback').textContent.includes('1')`, 'feedback badge');
  ok('planner sees unresolved feedback on the practice and on the drill', await planner.ev(`document.querySelector('#drill-list .dfb')?.textContent === '💬1' && document.querySelector('#practice-select').selectedOptions[0].textContent.includes('💬1')`));
  await planner.click('#btn-feedback');
  ok('feedback panel shows who said what, by drill', await planner.ev(`document.querySelector('#feedback-body').textContent.includes('Too long for mites') && document.querySelector('#feedback-body').textContent.includes('Coach A') && document.querySelector('.fb-group h3').textContent.includes('1. Warmup')`));
  await planner.click('#feedback-body [data-fact="resolve"]');
  await planner.until(`!document.querySelector('#btn-feedback').textContent.includes('1')`, 'resolve clears the badge');
  ok('resolving is saved', cloud.db.get('published/p1/feedback/ca_d1')?.resolved === true);
  await planner.open('/coach/p3'); s = await planner.state();
  ok('planner previews a draft as coaches will see it', s.path === '/coach/p3' && s.cards[0] === '1. Draft drill' && /coach view/.test(s.title) && s.fb === 0, s);
  await planner.open('/team'); s = await planner.state();
  ok('planner previews the team\'s list: released practices only', s.list.join() === '/team/p1', s);

  console.log('request access');
  const gran = await browser(U.stranger);
  await gran.open('/coach/p1'); s = await gran.state();
  ok('someone on no roster → /request-access, nothing fetched', s.path === '/request-access' && s.request && !reads('gran@example.com', 'published/p1').length, s);
  await gran.ev(`document.querySelector('#req-note').value = "Sam's grandma"`); await gran.click('#req-send');
  await gran.until(`/Request sent/.test(document.querySelector('#present-msg').textContent)`, 'request sent');
  ok('the request is filed in their own name', cloud.db.get('requests/st')?.email === 'gran@example.com' && cloud.db.get('requests/st').role === 'team' && cloud.db.get('requests/st').note === "Sam's grandma", cloud.db.get('requests/st'));
  await planner.open('/editor/p1');
  await planner.until(`document.querySelector('#btn-team').textContent.includes('(1)')`, 'request badge');
  await planner.click('#btn-team');
  ok('the planner sees the request in 👥 Team', await planner.ev(`document.querySelector('.req-row')?.textContent.includes("Sam's grandma")`));
  await planner.click('.req-row [data-act="req-family"]');
  await gran.until(`location.pathname === '/team/p1'`, 'approved requester is let in without a new link', 8000); await gran.settle();
  s = await gran.state();
  ok('approved as family → the page they first opened, as the team sees it', s.path === '/team/p1' && s.cards.length === 3, s);
  ok('approval put them on the roster and cleared the request', cloud.db.get('users/own/meta/roster').teams[0].players[0].contacts.some(k => k.email === 'gran@example.com') && !cloud.db.has('requests/st'));

  console.log('revocation and pulling back');
  await planner.click('#team-body [data-cid="c2"] [data-act="delcoach"]');
  await planner.until(`fetch('http://127.0.0.1:${CLOUD}/', { method: 'POST', body: JSON.stringify({ user: ${JSON.stringify(U.planner)}, op: 'get', path: 'access/p1' }) }).then(r => r.json()).then(r => !r.data.coach.includes('coachb@example.com'))`, 'roster change reaches the access list');
  await coachB.until(`location.pathname === '/request-access'`, 'coach B loses the open practice live', 8000);
  ok('a coach removed from the roster loses the practice (live) and the offline copy', await coachB.ev(`!localStorage.getItem('hpp.viewcache.p1') && !document.querySelectorAll('#present-body .pr-drill').length`) && !cloud.db.has('inbox/coachb@example.com'));
  await coachB.open('/coach/p1'); s = await coachB.state();
  ok('…and is now a stranger: request access, nothing fetched', s.path === '/request-access' && s.request, s);
  await planner.click('#team-close'); await planner.click('#btn-new-practice'); await planner.click('#btn-stage-back');
  await parent.open('/team/p1'); // parent had it; now pulled back to "coaches"
  await parent.until(`/isn't available/.test(document.querySelector('#present-msg').textContent)`, 'pulled back from the team', 8000);
  ok('pulling a practice back from the team removes the families\' access', cloud.db.get('access/p1').stage === 'coaches' && !('p1' in cloud.db.get('inbox/parent@example.com').practices));
  await coachA.open('/coach/p1'); s = await coachA.state(); ok('coaches keep theirs', s.cards.length === 3, s);

  console.log('sign out');
  await coachA.click('#present-account'); await coachA.click('#present-signout');
  await coachA.until(`!document.querySelector('#present-signin').hidden`, 'signed out');
  ok('signing out drops the offline copies and the cached list', await coachA.ev(`!Object.keys(localStorage).some(k => k.startsWith('hpp.viewcache.') || k.startsWith('hpp.inbox.'))`));
} catch (e) { failed++; console.log(`\n  ✗ crashed: ${e.stack || e}`); }

console.log(`\n${n - failed < 0 ? 0 : n - failed} / ${n} passed${failed ? ` — ${failed} failed` : ''}`);
for (const k of kids) k.kill();
cloud.close();
await sleep(300);
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* chrome may still hold it */ } }
process.exit(failed ? 1 : 0);
