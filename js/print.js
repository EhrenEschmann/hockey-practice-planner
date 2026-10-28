// The planner’s paper and image exports: the print page, the long image, and the ADM sheet.
// Loaded only with the editor (editor.js imports it) — viewers never fetch it.
import * as G from './geometry.js';
import { RINK, rinkSVG, SVG_STYLE, surfaceOf } from './rink.js';
import { standaloneSVG } from './render.js';
import { uid, practiceLabel, isGame, itemNoun, docTitle } from './store.js';
import { rosterTeamFor, routePath } from './access.js';
import { icon } from './icons.js';
import { $, download, escHtml, fmtSecs, safeName } from './ui.js';
import { closePopovers, drill, store, svg, zoneRules } from './core.js';
import { activeDrills, clock, clockFull, parseStart, shareView, whenLabel } from './doc.js';
import { cloudBackend, cloudSync, hasVideo, videoPoster } from './present.js';

// The practice document: the share view each drill is shown through outside the editor, the
// print page, and the long-image / ADM-sheet exports. Used by both the editor and the viewer.

// ---------- practice document (shared by print & presentation mode) ----------
/**
 * Print: every drill overlaid on one full-rink picture — the whole practice's use of the ice at a glance.
 * Each drill's area is numbered to match the drill list below (a drill with nothing but nets gets no number).
 */
/** The bounding box of what a drill actually draws on the ice (nets ignored); null when nothing is drawn. */
function drillInkBox(d) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of d.objects) {
    if (o.type === 'net') continue;
    const pts = [];
    if (o.x != null) pts.push({ x: o.x, y: o.y });
    if ((o.type === 'zone' || o.type === 'focus') && o.x != null) pts.push({ x: o.x + o.w, y: o.y + o.h });
    (o.path || []).forEach(q => pts.push(q));
    (o.points || []).forEach(q => pts.push(q));
    for (const ev of o.events || []) { if (ev.target) pts.push(ev.target); if (ev.bank) pts.push(ev.bank); }
    for (const q of pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}
/** 1-based numbers for the drills that show on the overview, in order; null for a drill with nothing drawn. */
function overviewNumbers(drills) { let n = 0; return drills.map(d => drillInkBox(d) ? ++n : null); }
function combinedOverview(drills, rink, nums = null) {
  if (!drills.length) return null;
  const boxes = drills.map(drillInkBox);
  const merged = { ...drills[0], objects: drills.flatMap(d => d.objects.filter(o => o.type !== 'focus')) }; // no gray-out masks on the shared picture
  // Each drill's number as a badge at the top-left of its space — a white-ringed disc that reads on top of anything.
  const num = i => nums ? nums[i] : i + 1;
  const badges = drills.length > 1 ? boxes.map((b, i) => b && num(i) != null ? `<g transform="translate(${G.round1(G.clamp(b.x0 - 0.5, 3, RINK.W - 3))} ${G.round1(G.clamp(b.y0 - 1, 3.5, RINK.H - 3))})"><circle r="3.4" fill="#111" stroke="#fff" stroke-width=".6"/><text y="1.5" font-size="4.4" font-weight="700" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif">${num(i)}</text></g>` : '').join('') : '';
  return standaloneSVG(merged, rink, SVG_STYLE, { x: -3, y: -3, w: RINK.W + 6, h: RINK.H + 6 }).replace(/<\/svg>\s*$/, `<g class="ov-badges">${badges}</g></svg>`);
}

/**
 * Send one drill on its own: publish a single-drill copy under its own id (marked shareOnly so it never
 * shows up in anyone's practice lists) and copy the link. Anyone with the link can watch it — signed in
 * with Google or as an anonymous guest. Pressing share again after edits republishes the snapshot.
 */
async function shareDrill(d, btn) {
  const u = cloudSync?.user;
  const p = store.practice;
  const teamId = p.teamId || rosterTeamFor(store.roster, p)?.id;
  if (!u || !cloudBackend?.savePractice) { alert('Sign in first — a shared drill is read from your cloud account.'); return; }
  if (!teamId) { alert('Pick a team for this practice first (👥 Team) — the shared drill is filed under it.'); return; }
  const dd = JSON.parse(JSON.stringify(d));
  delete dd.hidden; delete dd.audience;             // sharing it on its own overrides its visibility in the plan
  delete dd.coachNotes; delete dd.coachnote;        // coach-only content never rides a public share
  delete dd.upload; delete dd.intro; delete dd.narration; // chunked video / recorded clips live under the original practice and don't travel
  const single = {
    ...JSON.parse(JSON.stringify(p)),
    id: `${p.id}d${d.id}`, teamId, drills: [dd],
    stage: 'team', open: true, shareOnly: true, sharedWith: [], sharedTeam: [],
    owner: u.uid, updatedAt: Date.now(),
  };
  delete single.deleted;
  try {
    await cloudBackend.savePractice(single);
    const url = `${location.origin}${routePath({ view: 'team', teamId, pid: single.id })}`;
    try { await navigator.clipboard.writeText(url); } catch { prompt('Copy this link:', url); return; }
    if (btn) { btn.innerHTML = icon('check'); setTimeout(() => { btn.innerHTML = icon('send'); }, 1500); }
  } catch (e) { alert(`Could not share the drill: ${e?.message || e}`); }
}

$('#btn-print-page').addEventListener('click', () => { closePopovers(); $('#btn-print').click(); });
$('#btn-long-image').addEventListener('click', () => { closePopovers(); exportLongImage().catch(e => alert(`Image export failed: ${e?.message || e}`)); });
/**
 * The whole practice as one tall PNG: title and date, then every drill top to bottom — its number, name, minutes and
 * clock time, its diagram (the same framing the print and the viewer use), station rules, notes and coaches-only
 * notes — ending with dismissal. Drawn on a canvas (text by hand, each diagram from its own SVG), so it needs no
 * server and comes out the same on every device.
 */
// ----- drawing a practice on a canvas (the long image and the ADM sheet) -----
const measCtx = document.createElement('canvas').getContext('2d');
/** Lines of `text` that fit `maxW` in `font`, honouring the writer's own line breaks. */
function wrapText(text, font, maxW) {
  measCtx.font = font; const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) { const next = line ? `${line} ${word}` : word; if (measCtx.measureText(next).width > maxW && line) { out.push(line); line = word; } else line = next; }
    out.push(line);
  }
  return out;
}
/** A self-contained SVG string as an Image, ready to draw. */
const loadSVG = svg => new Promise((res, rej) => { const img = new Image(); const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); img.onload = () => { URL.revokeObjectURL(url); res(img); }; img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('a diagram could not be drawn')); }; img.src = url; });
/** A canvas of W × H CSS px at `scale`, white, scaled; returns [canvas, ctx]. */
function sheetCanvas(W, H, scale) {
  const c = document.createElement('canvas'); c.width = Math.round(W * scale); c.height = Math.round(H * scale);
  const ctx = c.getContext('2d'); ctx.scale(scale, scale); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.textBaseline = 'top';
  return [c, ctx];
}
const savePNG = (c, name) => new Promise((res, rej) => c.toBlob(b => b ? (download(name, b), res()) : rej(new Error('the image could not be encoded')), 'image/png'));
async function exportLongImage() {
  const p = store.practice, drills = activeDrills(p), rink = rinkSVG(surfaceOf(p));
  if (!drills.length) { alert('Nothing to export — the practice has no drills.'); return; }
  const W = 1400, M = 64, INNER = W - 2 * M, startMin = parseStart(p), total = drills.reduce((a, d) => a + (+d.duration || 0), 0);
  const F = { title: 'bold 40px system-ui, sans-serif', sub: '24px system-ui, sans-serif', head: 'bold 30px system-ui, sans-serif', meta: '22px system-ui, sans-serif', body: '23px system-ui, sans-serif', bodyB: 'bold 23px system-ui, sans-serif' };
  const LH = 32; // body line height
  // The full-ice breakdown first: every drill's space on one rink, numbered — the same overview the printed sheet opens with.
  const ovSVG = combinedOverview(drills, rink);
  const ov = ovSVG ? { img: await loadSVG(ovSVG), h: Math.round(INNER * (RINK.H + 6) / (RINK.W + 6)) } : null;
  const items = await Promise.all(drills.map(async d => {
    const v = shareView(d), img = await loadSVG(standaloneSVG(d, rink, SVG_STYLE, v));
    const figH = Math.round(INNER * v.h / v.w);
    const text = []; // [font, line, colour]
    for (const z of zoneRules(d)) { text.push([F.bodyB, z.label, '#111']); for (const l of z.lines) for (const w of wrapText(`• ${l}`, F.body, INNER - 24)) text.push([F.body, w, '#111', 24]); }
    if (d.notes) for (const w of wrapText(d.notes, F.body, INNER)) text.push([F.body, w, '#222']);
    if (hasVideo(d)) text.push([F.meta, `🎬 Video: ${d.upload ? `uploaded clip, ${fmtSecs(d.upload.secs)} (in the app)` : d.video || ''}`, '#555']);
    const cn = String(d.coachNotes || '').trim(); if (cn) { text.push([F.bodyB, '👁 Coaches only', '#92400e']); for (const w of wrapText(cn, F.body, INNER)) text.push([F.body, w, '#92400e']); }
    return { d, img, figH, text, h: 48 + figH + 16 + text.length * LH + 40 };
  }));
  const headH = 150 + (p.coaches ? LH : 0) + (ov ? 48 + ov.h + 40 : 0), H = headH + items.reduce((a, it) => a + it.h, 0) + 80;
  const scale = Math.min(2, Math.floor((32000 / H) * 10) / 10); // crisp on a phone, under the browser's canvas limit
  const [c, ctx] = sheetCanvas(W, H, scale);
  ctx.fillStyle = '#111';
  let y = M;
  ctx.font = F.title; ctx.fillText(docTitle(p), M, y); y += 50;
  ctx.font = F.sub; ctx.fillStyle = '#444'; ctx.fillText(whenLabel(p, true), M, y); y += LH;
  if (p.coaches) { ctx.fillText(`Coaches: ${p.coaches}`, M, y); y += LH; }
  ctx.fillText(`${startMin != null ? `Start @ ${clockFull(startMin)} · ` : ''}${drills.length} ${itemNoun(p)}${drills.length === 1 ? '' : 's'}${isGame(p) ? '' : ` · ${total} min`}`, M, y); y += LH + 8;
  if (ov) {
    ctx.fillStyle = '#111'; ctx.font = F.head; ctx.fillText('Full ice — where each drill runs', M, y); y += 48;
    ctx.drawImage(ov.img, M, y, INNER, ov.h); ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 1; ctx.strokeRect(M + 0.5, y + 0.5, INNER - 1, ov.h - 1); y += ov.h + 40;
  }
  let t = startMin;
  items.forEach((it, i) => {
    const d = it.d, at = t; if (t != null) t += (+d.duration || 0);
    ctx.fillStyle = '#e5e7eb'; ctx.fillRect(M, y, INNER, 2); y += 18; // a rule between drills
    ctx.fillStyle = '#111'; ctx.font = F.head; ctx.fillText(`${i + 1}. ${d.name}`, M, y);
    ctx.font = F.meta; ctx.fillStyle = '#555';
    const right = `${isGame(p) ? '' : `${+d.duration || 0} min`}${at != null ? `  ·  ${clockFull(at)}` : ''}`;
    ctx.textAlign = 'right'; ctx.fillText(right, W - M, y + 6); ctx.textAlign = 'left';
    y += 48;
    ctx.drawImage(it.img, M, y, INNER, it.figH); ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 1; ctx.strokeRect(M + 0.5, y + 0.5, INNER - 1, it.figH - 1); y += it.figH + 16;
    for (const [font, line, colour, indent] of it.text) { ctx.font = font; ctx.fillStyle = colour; ctx.fillText(line, M + (indent || 0), y); y += LH; }
    y += 40;
  });
  ctx.fillStyle = '#e5e7eb'; ctx.fillRect(M, y, INNER, 2); y += 18;
  ctx.fillStyle = '#111'; ctx.font = F.head; ctx.fillText('* Dismissal', M, y);
  if (startMin != null) { ctx.font = F.meta; ctx.fillStyle = '#555'; ctx.textAlign = 'right'; ctx.fillText(clockFull(startMin + total), W - M, y + 6); ctx.textAlign = 'left'; }
  await savePNG(c, `${safeName(practiceLabel(p))}_plan.png`);
}
/**
 * The ADM sheet: the station-practice page — one full ice sheet with every drill drawn on it where it runs, each
 * numbered, and under it the drills listed by number with their name, minutes, clock time and description, in two
 * columns. The same overview the print opens with, made the whole point of the page.
 */
async function exportADMSheet() {
  const p = store.practice, drills = activeDrills(p), rink = rinkSVG(surfaceOf(p));
  if (!drills.length) { alert('Nothing to export — the practice has no drills.'); return; }
  const nums = overviewNumbers(drills); // only the drills that show on the ice carry a number, 1…n in order
  const ovSVG = combinedOverview(drills, rink, nums); if (!ovSVG) { alert('Nothing drawn on the ice yet.'); return; }
  const W = 1700, M = 64, INNER = W - 2 * M, GAP = 48, COLW = (INNER - GAP) / 2, startMin = parseStart(p), total = drills.reduce((a, d) => a + (+d.duration || 0), 0);
  const F = { title: 'bold 40px system-ui, sans-serif', sub: '24px system-ui, sans-serif', head: 'bold 26px system-ui, sans-serif', meta: '20px system-ui, sans-serif', body: '22px system-ui, sans-serif', bodyB: 'bold 22px system-ui, sans-serif' };
  const LH = 30;
  const ov = await loadSVG(ovSVG), ovH = Math.round(INNER * (RINK.H + 6) / (RINK.W + 6));
  // The legend: each drill's lines, measured for the column width.
  let t = startMin;
  const entries = drills.map((d, i) => {
    const at = t; if (t != null) t += (+d.duration || 0);
    const lines = [[F.head, `${nums[i] != null ? `${nums[i]}. ` : ''}${d.name}`, '#111']];
    const meta = `${isGame(p) ? '' : `${+d.duration || 0} min`}${at != null ? ` · ${clockFull(at)}` : ''}`; if (meta) lines.push([F.meta, meta, '#555']);
    for (const z of zoneRules(d)) { lines.push([F.bodyB, z.label, '#111']); for (const l of z.lines) for (const w of wrapText(`• ${l}`, F.body, COLW - 24)) lines.push([F.body, w, '#111', 24]); }
    if (d.notes) for (const w of wrapText(d.notes, F.body, COLW)) lines.push([F.body, w, '#222']);
    const cn = String(d.coachNotes || '').trim(); if (cn) { lines.push([F.bodyB, '👁 Coaches only', '#92400e']); for (const w of wrapText(cn, F.body, COLW)) lines.push([F.body, w, '#92400e']); }
    return { lines, h: lines.length * LH + 26 };
  });
  // Two columns, filled top to bottom in order: the first column takes entries until it holds about half the height.
  const sum = entries.reduce((a, e) => a + e.h, 0); let acc = 0, split = entries.length;
  for (let i = 0; i < entries.length; i++) { acc += entries[i].h; if (acc >= sum / 2) { split = i + 1; break; } }
  const cols = [entries.slice(0, split), entries.slice(split)];
  const colH = Math.max(...cols.map(col => col.reduce((a, e) => a + e.h, 0)));
  const headH = 150 + (p.coaches ? LH : 0), H = headH + 48 + ovH + 48 + colH + M;
  const scale = Math.min(2, Math.floor((32000 / H) * 10) / 10);
  const [c, ctx] = sheetCanvas(W, H, scale);
  let y = M;
  ctx.fillStyle = '#111'; ctx.font = F.title; ctx.fillText(`${docTitle(p)} — ADM practice`, M, y); y += 50;
  ctx.font = F.sub; ctx.fillStyle = '#444'; ctx.fillText(whenLabel(p, true), M, y); y += LH;
  if (p.coaches) { ctx.fillText(`Coaches: ${p.coaches}`, M, y); y += LH; }
  ctx.fillText(`${startMin != null ? `Start @ ${clockFull(startMin)} · ` : ''}${drills.length} ${itemNoun(p)}${drills.length === 1 ? '' : 's'}${isGame(p) ? '' : ` · ${total} min`}`, M, y); y += LH + 16;
  ctx.drawImage(ov, M, y, INNER, ovH); ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 1; ctx.strokeRect(M + 0.5, y + 0.5, INNER - 1, ovH - 1); y += ovH + 48;
  cols.forEach((col, ci) => {
    const x = M + ci * (COLW + GAP); let cy = y;
    for (const e of col) {
      for (const [font, line, colour, indent] of e.lines) { ctx.font = font; ctx.fillStyle = colour; ctx.fillText(line, x + (indent || 0), cy); cy += LH; }
      cy += 26;
    }
  });
  await savePNG(c, `${safeName(practiceLabel(p))}_ADM.png`);
}
$('#btn-adm-sheet').addEventListener('click', () => { closePopovers(); exportADMSheet().catch(e => alert(`ADM sheet failed: ${e?.message || e}`)); });
$('#btn-print').addEventListener('click', () => {
  const p = store.practice;
  const drills = activeDrills(p);
  const rink = rinkSVG(surfaceOf(p));
  const total = drills.reduce((a, d) => a + (+d.duration || 0), 0);
  const startMin = parseStart(p);
  let t = startMin;
  const drillRows = drills.map((d, i) => {
    const at = t; if (t != null) t += (+d.duration || 0);
    return `
      <div class="p-drill">
        <div class="p-head"><b>${i + 1}. ${escHtml(d.name)}</b><span class="p-meta">(${+d.duration || 0} minutes)</span>${at != null ? `<span class="p-time">${clockFull(at)}</span>` : ''}</div>
        ${standaloneSVG(d, rink, SVG_STYLE, shareView(d))}
        ${zoneRules(d).map(z => `<div class="p-rules"><b>${escHtml(z.label)}</b><ul>${z.lines.map(l => `<li>${escHtml(l)}</li>`).join('')}</ul></div>`).join('')}
        ${hasVideo(d) ? `<div class="p-vid">${videoPoster(d) ? `<img class="p-poster" src="${videoPoster(d)}" alt="">` : ''}<span class="p-meta">🎬 Video: ${d.upload ? `uploaded clip, ${fmtSecs(d.upload.secs)} (in the app)` : escHtml(d.video)}</span></div>` : ''}
        ${d.notes ? `<pre>${escHtml(d.notes)}</pre>` : ''}
        ${(d.coachNotes || '').trim() || d.coachnote ? `<div class="p-coach"><b>👁 Coaches only:</b> ${escHtml(d.coachNotes || '')}${d.coachnote ? `${(d.coachNotes || '').trim() ? ' · ' : ''}▶ audio note (${Math.round(d.coachnote.secs)} s, in the app)` : ''}</div>` : ''}
      </div>`;
  }).join('');
  $('#print-area').innerHTML = `
    <div class="p-title">${escHtml(docTitle(p))}</div>
    <div class="p-sub">${escHtml(whenLabel(p, true))}</div>
    ${p.coaches ? `<div class="p-sub">Coaches: ${escHtml(p.coaches)}</div>` : ''}
    ${(ov => ov ? `<div class="p-combined">${ov}</div>` : '')(combinedOverview(drills, rink))}
    <div class="p-sub">${startMin != null ? `Start @ ${clockFull(startMin)}` : ''} <span class="p-meta">${drills.length} ${itemNoun(p)}${drills.length === 1 ? '' : 's'}${isGame(p) ? '' : ` · ${total} min`}</span></div>
    <div class="p-cols">
    ${drillRows}
    <div class="p-drill"><div class="p-head"><b>* Dismissal</b>${startMin != null ? `<span class="p-time">${clockFull(startMin + total)}</span>` : ''}</div></div>
    </div>`;
  window.print();
});



export { shareDrill };
