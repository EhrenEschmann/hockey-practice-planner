// Everything a viewer sees: presentation mode, routing/personas (who is here), the team home
// (dashboard, tasks, games, survey), club teams, rink mode, cloud sync, and the planner’s inbox.
// The editor module is NOT loaded here — see loadEditor / editorApi for the planner’s path.
import { rinkSVG, SVG_STYLE, surfaceOf, isDryland } from './rink.js';
import { standaloneSVG } from './render.js';
import { makeSim, isPlayer } from './sim.js';
import { uid, practiceLabel, usDate, migrateDrill, isGame, docNoun, itemNoun, docTitle } from './store.js';
import { loadConfig, firebaseBackend, createSync, friendlyAuthError } from './cloud.js';
import { stageOf, publishedCopy, parseRoute, routePath, resolveRoute, byCalendar, calendarFocus, clubDoc, TASK_UNITS, weekKey, weekStart, shiftWeek, tasksForWeek, legacyWeek, normalWeek } from './access.js';
import { PS_ELEMENTS, createPSView } from './powerskate.js';
import { icon } from './icons.js';
import { videoEmbed, videoPlayerHTML } from './video.js';
import { idbDelClip, canPlay } from './clips.js';
import { $, $$, escHtml, fmtSecs, isEditing } from './ui.js';
import { ERASE_SECS, animateFrame, boardInkSVG, canSpeak, clipMem, closePopovers, drill, drillCues, editorApi, editorOn, fetchClip, fetchTaskAudio, fetchTaskVideo, fetchUpload, forgetClip, hushVoice, isPSDrill, keyFor, loserOption, makeNarrator, narrAt, narrCtx, narrationBuffer, navigate, overlay, ownerFor, playClip, playNarration, prefetchNarration, primeVoice, readAloud, reading, setEditorOn, setVoiceOn, stopReading, store, storedVoice, svg, teamOf, toRink, videoKey, voiceOn, zoneRules } from './core.js';
import { activeDrills, clock, clockFull, dayDate, pad2, parseStart, shareView, stamp, todayISO, whenLabel } from './doc.js';

// Everything a viewer sees: presentation mode, routing/personas (who is here), the team home
// (dashboard, tasks, games, survey), club teams, rink mode, cloud sync, and the planner’s inbox.

// ---------- presentation mode: a read-only scroll-through at #view=<ownerUid>/<practiceId> ----------
// The owner opens it with 📺 Present; coaches listed in the practice's "Coach emails" open the same
// link, sign in with Google, and read the practice live from the owner's cloud account.
let presenting = false;
let presentAudience = 'coach'; // which link is open: /coach or /team — the same page; a coach on /coach can also leave feedback
let feedbackOn = false;        // this viewer may leave feedback on the practice on screen
let showingPractice = false;   // a practice (not a list or a message) fills the viewer
let presentOwner = 'local';    // whose account the shown practice (and its intro clips) belongs to — the key its copies are cached under
/** The team a practice is filed under in the cloud: the editor's own copy, else the one on screen. */
const teamFor = pid => store.data.practices.find(p => p.id === pid)?.teamId || (presentPractice?.id === pid ? presentPractice.teamId : null) || screen?.teamId || null;
let presentUnsub = null, presentKey = null;
let cloudSync = null, cloudBackend = null; // set once Firebase boots (below)
let cloudBoot = 'loading', cloudBootError = ''; // 'loading' → 'ready' | 'failed' (SDK/config didn't load) | 'none' (no config: local-only)
let uploadsChecked = false; // pending intro uploads are retried once per session

/** A drill's video, collapsed to a button: the player only loads when tapped (data, and it takes the diagram's place on a phone). */
/** A drill's poster frame: the captured first frame of an upload, or a YouTube thumbnail for links. */
function videoPoster(d) {
  if (d.upload?.poster) return d.upload.poster;
  const v = !d.upload && d.video ? videoEmbed(d.video) : null;
  return v && /youtube/i.test(v.host || '') && v.id ? `https://img.youtube.com/vi/${v.id}/hqdefault.jpg` : null;
}
const hasVideo = d => !!(d.upload || (d.video && videoEmbed(d.video)));
/** The coaches-only block on a drill card: shown on the coach link only. */
function coachNotesHTML(d) {
  if (presentAudience !== 'coach' || (!(d.coachNotes || '').trim() && !d.coachnote)) return '';
  return `<div class="pr-coachnotes"><div class="pr-cn-head">👁 Coaches only${d.coachnote ? ` <button class="pr-cn-play" data-cndid="${d.id}">▶ Audio note (${Math.round(d.coachnote.secs)} s)</button>` : ''}</div>${(d.coachNotes || '').trim() ? `<pre>${escHtml(d.coachNotes)}</pre>` : ''}</div>`;
}

function videoBlockHTML(d) {
  const poster = videoPoster(d);
  const img = poster ? `<img class="pr-poster" src="${poster}" alt="" title="Watch the video">` : '';
  if (d.upload) return `<div class="pr-video" data-upload="1">${img}<button class="pr-video-btn wp-toggle">🎬 Watch video <span class="muted small">(${fmtSecs(d.upload.secs)})</span></button></div>`;
  const v = d.video ? videoEmbed(d.video) : null;
  return v ? `<div class="pr-video" data-src="${escHtml(v.src)}" data-kind="${v.kind}" data-host="${escHtml(v.host)}">${img}<button class="pr-video-btn wp-toggle">🎬 Watch video <span class="muted small">(${escHtml(v.host)})</span></button></div>` : '';
}
// ----- chalk talk in the viewer: the coach's drawing replays over the drill's ice, voice in sync -----
let prBoard = null; // { sec, btn, layer, audio, raf }
function stopPrBoard() {
  if (!prBoard) return;
  cancelAnimationFrame(prBoard.raf);
  prBoard.audio?.pause();
  prBoard.layer?.remove();
  prBoard.btn.textContent = '🖍 Chalk talk';
  prBoard = null;
}
async function togglePrBoard(sec, btn) {
  if (prBoard?.sec === sec) { stopPrBoard(); return; }
  stopPrBoard();
  const d = (presentPractice?.drills || []).find(x => x.id === sec?.dataset.did);
  const svgEl = sec?.querySelector('.pr-fig svg');
  if (!d?.board?.strokes?.length || !svgEl) return;
  sec._pause?.(); // the drill's own animation (and voice) steps aside
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  layer.setAttribute('class', 'pr-board-layer');
  svgEl.appendChild(layer);
  let audio = null;
  if (d.boardAudio) {
    const entry = await fetchClip(presentOwner, presentPractice.id, d, 'boardAudio').catch(() => null);
    if (entry) audio = new Audio(entry.url);
  }
  const strokes = d.board.strokes;
  const speed = +d.board.speed || 1;
  const inkEnd = strokes.reduce((m, st) => Math.max(m, st.gone != null ? st.gone + ERASE_SECS : 0, ...st.pts.map(q => q.t || 0)), 0);
  const t0 = performance.now();
  const me = { sec, btn, layer, audio, raf: 0 };
  prBoard = me;
  btn.textContent = '■ Stop chalk talk';
  audio?.play().catch(() => {});
  const frame = () => {
    if (prBoard !== me) return;
    const el = (performance.now() - t0) / 1000;
    layer.innerHTML = boardInkSVG(strokes, el * speed);
    const audioDone = !audio || audio.ended || audio.paused;
    if (el >= inkEnd / speed + 0.5 && audioDone) { stopPrBoard(); return; }
    me.raf = requestAnimationFrame(frame);
  };
  me.raf = requestAnimationFrame(frame);
}

let prCnPlaying = null;
$('#present-body').addEventListener('click', async e => {
  const bb = e.target.closest('.pr-board-btn');
  if (bb) { togglePrBoard(bb.closest('.pr-drill'), bb); return; }
  const cn = e.target.closest('.pr-cn-play');
  if (cn) {
    if (prCnPlaying) { prCnPlaying.stop(); prCnPlaying = null; return; }
    const d = (presentPractice?.drills || []).find(x => x.id === cn.dataset.cndid);
    if (!d?.coachnote) return;
    const entry = await fetchClip(presentOwner, presentPractice.id, d, 'coachnote');
    if (entry) prCnPlaying = playClip(entry, { onEnd: () => { prCnPlaying = null; } });
    return;
  }
  const poster = e.target.closest('.pr-poster');
  if (poster) { poster.closest('.pr-video')?.querySelector('.pr-video-btn')?.click(); return; }
  const tab = e.target.closest('.pr-tab');
  if (!tab) return;
  const sec = tab.closest('.pr-drill'); if (!sec) return;
  for (const b of sec.querySelectorAll('.pr-tab')) b.classList.toggle('active', b === tab);
  for (const pn of sec.querySelectorAll('.pr-pane')) pn.hidden = pn.dataset.pane !== tab.dataset.prtab;
  if (tab.dataset.prtab === 'layout') sec._pause?.(); // leaving the video for the layout parks whatever is playing
});

function wireVideos(p) {
  for (const box of $$('#present-body .pr-video')) {
    const sec = box.closest('.pr-drill');
    const btn = box.querySelector('.pr-video-btn');
    const d = p.drills.find(x => x.id === sec.dataset.did);
    // A drill with a video and nothing drawn on the ice is the video: it opens by itself and the empty rink stays hidden.
    const videoOnly = !!d && !(d.objects || []).length;
    const label = () => box.dataset.upload ? `🎬 Watch video <span class="muted small">(${fmtSecs(d?.upload?.secs)})</span>` : `🎬 Watch video <span class="muted small">(${escHtml(box.dataset.host)})</span>`;
    // While the coach's intro plays (before the animation), the video keeps out of the way: its button is disabled
    // and an open player is paused; the video's own intro (introBeforeVideo) holds the player the same way.
    sec._videoLock = on => {
      btn.disabled = on; btn.title = on ? 'Wait for the coach’s intro to finish' : '';
      const v = box.querySelector('video'); if (on && v && !v.paused) v.pause();
    };
    const toggle = async ({ auto = false } = {}) => {
      if (sec._introOn?.()) return; // not while the intro is playing
      const open = auto || !sec.classList.contains('video-open');
      sec.classList.toggle('video-open', open);
      box.querySelector('.video-box')?.remove();
      if (open) {
        sec._pause?.(); // the drill animation stops while the video is up
        if (box.dataset.upload) { // downloaded once, then kept on the phone
          btn.textContent = 'Loading…';
          const entry = await fetchUpload(presentOwner, p.id, d, (i, n) => { btn.textContent = `Downloading ${i} / ${n}…`; });
          if (!sec.classList.contains('video-open')) return; // closed while loading
          if (!entry) { btn.textContent = '⚠ video not available — tap ↻ to resync, or check the connection'; btn.hidden = false; sec.classList.remove('video-open'); layoutPresent(); return; }
          const autoplay = !auto && (presentMode !== 'focus' || sec.classList.contains('current')); // an auto-opened player waits for a tap (phones block sound without one); so does one whose drill was left while it loaded
          box.insertAdjacentHTML('beforeend', `<div class="video-box"><video src="${entry.url}" controls playsinline ${autoplay ? 'autoplay' : ''} preload="auto"></video></div>`);
          if (d.intro) introBeforeVideo(box.querySelector('video'), sec, p, d);
        } else box.insertAdjacentHTML('beforeend', videoPlayerHTML({ kind: box.dataset.kind, src: box.dataset.src, host: box.dataset.host }));
      }
      btn.innerHTML = open ? '✕ Close video' : label();
      btn.hidden = videoOnly && open; // nothing to close back to
      layoutPresent();
    };
    btn.addEventListener('click', () => toggle());
    // Leaving the drill stops its video: an uploaded clip pauses where it is; an embedded player (YouTube etc.) can't be
    // paused from outside its frame, so it is unloaded and put back, stopped, when the drill comes on screen again.
    sec._stopMedia = () => {
      const vid = box.querySelector('video'); if (vid) { vid.pause(); return; }
      if (box.querySelector('iframe')) { box.querySelector('.video-box')?.remove(); sec._mediaReopen = true; }
    };
    sec._resumeMedia = () => {
      if (!sec._mediaReopen) return;
      sec._mediaReopen = false;
      if (sec.classList.contains('video-open') && !box.querySelector('.video-box')) box.insertAdjacentHTML('beforeend', videoPlayerHTML({ kind: box.dataset.kind, src: box.dataset.src, host: box.dataset.host }));
    };
    if (videoOnly) { sec.classList.add('video-only'); toggle({ auto: true }); }
  }
}
/**
 * A drill with a recorded intro and an uploaded video: the first ▶ on the video (from the start, voice on) plays the
 * coach's intro first, then the video runs. Pressing ▶ again during the intro skips it. (A YouTube-style embed is
 * inside its own frame, so it can't be held back — only uploaded clips get the intro.)
 */
function introBeforeVideo(vid, sec, p, d) {
  if (!vid) return;
  let cur = null, done = false;
  const cue = sec.querySelector('.pr-cue') || sec.querySelector('.pr-video').appendChild(Object.assign(document.createElement('div'), { className: 'pr-cue', hidden: true }));
  const say = (text, ms) => { cue.textContent = text; cue.hidden = false; if (ms) setTimeout(() => { cue.hidden = true; }, ms); };
  vid.addEventListener('play', () => {
    if (cur || sec._introOn?.()) { vid.pause(); say('🎙 Coach’s intro first — the video starts when it ends'); return; } // no playing the video over the intro
    if (done || vid.currentTime > 0.5) return;
    done = true; // one intro per opening of the player
    const clip = clipMem.get(keyFor(presentOwner, p.id, d));
    if (!clip) { say('🎙 intro not downloaded yet — tap ↻ to resync', 3500); return; }
    if (!canPlay(clip.mime)) { say(`🎙 intro can’t play on this device (${clip.mime})`, 4000); return; }
    vid.pause();
    say('🎙 Coach’s intro…');
    cur = playClip(clip, { onEnd: err => {
      const skipped = cur?.cancelled; cur = null;
      if (err) say(`🎙 intro didn’t play — ${err}`, 4000); else cue.hidden = true;
      if (!skipped) vid.play().catch(() => {});
    } });
  });
  sec._pauseIntro = () => { if (cur) { cur.cancelled = true; cur.stop(); } };
}
const REACTIONS = [['😀', 'Good'], ['🏒', 'Great hockey'], ['😍', 'Loved it'], ['🤩', 'Amazing']];
/** After practice: a tap on one of the four emoji is remembered on this phone and logged for the coach. */
function wireReactions(p) {
  const box = $('#present-body .pr-react'); if (!box) return;
  const key = `hpp.react.${p.id}`;
  let picked = null;
  try { picked = localStorage.getItem(key); } catch { /* fine */ }
  const btns = [...box.querySelectorAll('.pr-react-btn')];
  const note = box.querySelector('.pr-react-note');
  const show = () => btns.forEach(b => b.classList.toggle('picked', b.dataset.emoji === picked));
  show();
  if (picked) note.textContent = 'Thanks — tap another to change your pick.';
  box.addEventListener('click', e => {
    const b = e.target.closest('.pr-react-btn'); if (!b) return;
    picked = b.dataset.emoji;
    try { localStorage.setItem(key, picked); } catch { /* fine */ }
    show();
    const sent = logReaction(p, picked);
    note.textContent = sent ? 'Thanks! Sent to the coach.' : 'Thanks! Sign in when you’re online to send it to the coach.';
  });
}
/**
 * How long a coach or parent needs to go through the plan once: every drill's animation at its playback speed
 * (plus the intro clip that plays before it), uploaded videos, and reading the notes and station rules at an
 * easy pace — with a few seconds per card to take in the diagram. Rounded up to whole minutes.
 */
function reviewEstimate(p) {
  const parts = { watch: 0, listen: 0, video: 0, read: 0, look: 0 };
  for (const d of activeDrills(p)) {
    parts.look += 5;
    if (isPSDrill(d)) parts.watch += 12 * (d.psElements || []).length; // each 3D element loops; a dozen seconds tells the story
    else if ((d.objects || []).some(o => isPlayer(o) && o.path?.length || o.type === 'puck')) {
      let T = 0; try { T = makeSim(d).duration(); } catch { T = 0; }
      parts.watch += T / (+d.animSpeed || 1);
    }
    if (d.intro?.secs) parts.listen += +d.intro.secs;
    if (d.upload?.secs) parts.video += +d.upload.secs;
    else if (d.video) parts.video += 60; // a linked clip of unknown length: call it a minute
    const words = `${d.notes || ''} ${zoneRules(d).flatMap(z => [z.label, ...z.lines]).join(' ')}`.trim().split(/\s+/).filter(Boolean).length;
    parts.read += words / 200 * 60; // ~200 words a minute
  }
  const secs = Object.values(parts).reduce((a, b) => a + b, 0);
  const min = Math.max(1, Math.ceil(secs / 60));
  const bits = [parts.watch ? `${fmtSecs(parts.watch)} of animation` : '', parts.listen ? `${fmtSecs(parts.listen)} of intros` : '', parts.video ? `${fmtSecs(parts.video)} of video` : '', parts.read ? `${fmtSecs(parts.read)} reading` : ''].filter(Boolean);
  return { min, secs, detail: bits.join(' · ') };
}
function presentHTML(p) {
  const fbBtn = key => feedbackOn ? `<button class="pr-fb wp-toggle" data-fb="${key}" title="Only the head coach sees what you write">💬 Feedback</button>` : '';
  const rink = rinkSVG(surfaceOf(p));
  const drills = activeDrills(p);
  const total = drills.reduce((a, d) => a + (+d.duration || 0), 0);
  const startMin = parseStart(p);
  const est = reviewEstimate(p);
  let t = startMin ?? 0; // no start time on the practice: the schedule runs from 0:00 instead of a clock time
  // Each drill's slot on the running clock — exactly when it starts and finishes (data-* feed the live "now" marker).
  const game = isGame(p);
  const whenHTML = (at, dur) => game ? '' : startMin != null
    ? `<span class="pr-time" data-from="${at}" data-to="${at + dur}">${clock(at)}–${clockFull(at + dur)}</span><span class="pr-now" hidden></span>`
    : `<span class="pr-time" title="Minutes into practice — set a start time on the practice to get clock times">${at}–${at + dur} min in</span>`;
  const minHTML = d => game ? '' : `<span class="pr-min">(${+d.duration || 0} min)</span>`;
  return `
    <div class="pr-head">
    <div class="pr-team">${escHtml(docTitle(p))}</div>
    <div class="pr-meta">${escHtml(whenLabel(p, true))}</div>
    ${p.coaches ? `<div class="pr-meta">Coaches: ${escHtml(p.coaches)}</div>` : ''}
    <div class="pr-meta">${drills.length} ${itemNoun(p)}${drills.length === 1 ? '' : 's'}${game ? '' : ` · ${total} min`}${p.coachOnly?.count ? ` <span class="pr-coachonly" title="Part of the practice the coaches run without a diagram here">+ ${p.coachOnly.minutes} min coach-led (${p.coachOnly.count} segment${p.coachOnly.count === 1 ? '' : 's'})</span>` : ''}${startMin != null ? ` · start @ ${clockFull(startMin)}` : ''}</div>
    <div class="pr-meta pr-review" title="${escHtml(est.detail)}">⏱ About ${est.min} min to review this plan${est.detail ? ` <span class="muted">(${escHtml(est.detail)})</span>` : ''}</div>
    </div>
    ${drills.map((d, i) => {
      const at = d.at != null ? (startMin ?? 0) + d.at : t; t = at + (+d.duration || 0); // `at`: the team's copy keeps the slot of a coaches-only drill left out before this one
      if (isPSDrill(d)) {
        const tiles = (d.psElements || []).map(k => {
          const e = PS_ELEMENTS.find(x => x.key === k);
          return e ? `<figure class="pr-pstile" data-ps="${e.key}" title="${escHtml(e.desc)}"><canvas></canvas><figcaption>${escHtml(e.name)}</figcaption></figure>` : '';
        }).join('');
        return `
      <section class="pr-drill" data-did="${d.id}">
        <header><b>${i + 1}. ${escHtml(d.name)}</b>${minHTML(d)}${whenHTML(at, +d.duration || 0)}</header>
        ${tiles ? `<div class="pr-psgrid">${tiles}</div>` : ''}
        ${videoBlockHTML(d)}
        <div class="pr-text">${d.notes ? `<pre>${escHtml(d.notes)}</pre>` : ''}${coachNotesHTML(d)}${fbBtn(d.id)}</div>
      </section>`;
      }
      return `
      <section class="pr-drill" data-did="${d.id}">
        <header><b>${i + 1}. ${escHtml(d.name)}</b>${minHTML(d)}${whenHTML(at, +d.duration || 0)}</header>
        ${hasVideo(d) ? `<div class="pr-tabs"><button class="pr-tab active" data-prtab="video">🎬 Video</button><button class="pr-tab" data-prtab="layout">Layout</button></div>
        <div class="pr-pane" data-pane="video">${videoBlockHTML(d)}</div>
        <div class="pr-pane" data-pane="layout" hidden>` : ''}
        <div class="pr-fig" data-ar="${(shareView(d).w / shareView(d).h).toFixed(3)}">${standaloneSVG(d, rink, SVG_STYLE, shareView(d), { showPaths: d.showPaths !== false })}</div>
        <div class="pr-animbar">
          <button class="pr-play" title="Watch the drill">${icon('play')}</button>
          <input type="range" class="pr-tl" min="0" max="10" step="0.01" value="0">
          <span class="pr-timedisp muted small"></span>
          <span class="pr-break"></span>
          <select class="pr-speed" title="${d.narration ? 'Speed is fixed: the coach recorded a voice-over at this speed' : 'Playback speed'}" ${d.narration ? 'disabled' : ''}>${['0.25', '0.5', '0.75', '0.9', '1', '1.5', '2'].map(s => `<option value="${s}" ${+s === (+d.animSpeed || 1) ? 'selected' : ''}>${s}×</option>`).join('')}</select>
          <label class="check small"><input type="checkbox" class="pr-paths" ${d.showPaths !== false ? 'checked' : ''}> paths</label>
          <span class="pr-impact"></span>
          ${d.board?.strokes?.length ? `<button class="pr-board-btn" title="Chalk talk — the coach draws on this ice and talks it through${d.boardAudio ? '' : ' (no voice recorded)'}">🖍 Chalk talk</button>` : ''}
        </div>
        ${hasVideo(d) ? '</div>' : ''}
        <div class="pr-text"><div class="pr-cue" hidden></div>
        ${rulesHTML(d)}
        ${d.notes ? `<pre>${escHtml(d.notes)}</pre>` : ''}${coachNotesHTML(d)}${fbBtn(d.id)}</div>
      </section>`;
    }).join('')}
    <section class="pr-drill pr-dismissal">
      <header><b>* ${game ? 'Game time' : 'Dismissal'}</b>${game ? '' : startMin != null ? `<span class="pr-time">${clockFull(startMin + total)}</span>` : `<span class="pr-time">${total} min in</span>`}</header>
      <div class="pr-react">
        <div class="pr-react-q">${game ? 'How was the game?' : 'How was practice?'}</div>
        <div class="pr-react-row">${REACTIONS.map(([e, name]) => `<button class="pr-react-btn" data-emoji="${e}" title="${name}" aria-label="${name}">${e}</button>`).join('')}</div>
        <div class="pr-react-note muted small"></div>
      </div>
      ${feedbackOn ? `<div class="pr-text">${fbBtn('overall').replace('💬 Feedback', '💬 Overall feedback')}</div>` : ''}
    </section>`;
}

/** The stations' titles and constraints under a drill card, with a button that reads them out in order. */
function rulesHTML(d) {
  const zones = zoneRules(d);
  if (!zones.length) return '';
  let k = 0;
  return `<div class="pr-rules">
    <div class="pr-rules-head"><b>${zones.length > 1 ? 'Stations' : 'Rules'}</b>${canSpeak ? '<button class="pr-read wp-toggle" title="Read the title and constraints aloud, one at a time">🔊 Read rules</button>' : ''}</div>
    ${zones.map(z => `<div class="pr-rule" style="border-color:${escHtml(z.color)}"><div class="pr-rule-title" data-line="${k++}">${escHtml(z.label)}</div>
      <ol>${z.lines.map(l => `<li data-line="${k++}">${escHtml(l)}</li>`).join('')}</ol></div>`).join('')}
  </div>`;
}
function wireRules(sec) {
  const btn = sec.querySelector('.pr-read');
  if (!btn) return;
  const lines = [...sec.querySelectorAll('[data-line]')];
  const idle = () => { btn.classList.remove('reading'); btn.textContent = '🔊 Read rules'; lines.forEach(l => l.classList.remove('speaking')); };
  btn.addEventListener('click', () => {
    if (btn.classList.contains('reading')) { stopReading(); return; }
    btn.classList.add('reading'); btn.textContent = '■ Stop';
    readAloud(lines.map(l => l.textContent), { onLine: k => lines.forEach((l, i) => l.classList.toggle('speaking', i === k)), onDone: idle });
  });
}
function presentDoc(p) {
  // An older link named the practice alone: now that its team is known, the address gets the full form.
  if (screen?.screen === 'practice' && !screen.teamId && p.teamId) { screen.teamId = p.teamId; history.replaceState(null, '', routePath({ view: presentAudience, teamId: p.teamId, pid: p.id })); }
  $('#present-title').textContent = practiceLabel(p) + (who.persona === 'planner' ? ` · ${presentAudience} view` : '');
  if (!showingPractice) { showingPractice = true; applyPresentMode(); }
  $('#present-body').innerHTML = presentHTML(p);
  wirePresentAnims(p);
  $('#present-gate').hidden = true;
  presentNote('');
  // Rink mode: opening a practice lands on the drill that's happening right now (by the practice clock);
  // a live update while viewing keeps the coach on the drill they were looking at.
  if (presentShownId !== p.id) { presentShownId = p.id; presentIndex = drillNowIndex(p); }
  presentPractice = p;
  showDrill(presentIndex);
  wireReactions(p);
  wireVideos(p);
  watchListViews(p);
  flushViewQueue();
  loadMyFeedback(p);
  clearInterval(nowTimer); nowTimer = setInterval(tickNow, 15000); tickNow();
  paintWhen();
}
let presentPractice = null; // the practice on screen, for the audit log
/** While the practice is happening (its date is today), the drill on the clock right now says so, with the minutes it has left. */
let nowTimer = 0;
function tickNow() {
  paintWhen(); // midnight moves the calendar on
  const p = presentPractice, now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const min = now.getHours() * 60 + now.getMinutes();
  for (const el of $$('#present-body .pr-time[data-from]')) {
    const on = !!p && p.date === today && min >= +el.dataset.from && min < +el.dataset.to;
    const tag = el.nextElementSibling;
    el.classList.toggle('now', on);
    if (tag?.classList.contains('pr-now')) { tag.hidden = !on; if (on) tag.textContent = `now · ${+el.dataset.to - min} min left`; }
  }
}
/** Status line under the presentation top bar (e.g. "Offline copy from …"); '' hides it. */
function presentNote(text) {
  $('#present-note').textContent = text;
  $('#present-note').hidden = !text;
}

// Each drill card gets its own little player: ▶/⏸, a scrubber and the drill clock,
// driving animateFrame() on that card's SVG copy of the drill.
const presentAnims = [];
const presentPSTiles = []; // little looping 3D viewers on power skating cards
let presentPSObserver = null; // runs a tile's loop only while it is actually on screen
function stopPresentAnims() {
  stopPrBoard();
  hushVoice();
  for (const a of presentAnims) { cancelAnimationFrame(a.raf); if (a.intro) { a.intro.cancelled = true; a.intro.stop(); } a.stopNarr?.(); }
  presentAnims.length = 0;
  for (const v of presentPSTiles) v.stop();
  presentPSTiles.length = 0;
  presentPSObserver?.disconnect(); presentPSObserver = null;
}
/**
 * Split a card's diagram into a static layer and a moving one. The rendered SVG keeps the rink, paths and
 * equipment — painted once — while everything that moves during playback (player bodies, pucks, the pad
 * slabs above them, the shot echoes above goalies, impact bursts) is moved into a transparent overlay SVG
 * on top. A frame then repaints a handful of shapes instead of the whole diagram — the difference between
 * smooth and stuttering on a phone, where inline SVG repaints in full on any change.
 */
function splitLayers(fig, svgEl) {
  fig.querySelector('.pr-overlay')?.remove();
  const overlay = svgEl.cloneNode(false); // same viewBox / size, no content
  overlay.classList.add('pr-overlay');
  overlay.innerHTML = `<style>${SVG_STYLE}</style>`;
  for (const el of svgEl.querySelectorAll('.puck-disc, [data-skater], .raisedpad-top, .shot-overlay, .obj.focus')) overlay.appendChild(el); // document order keeps their stacking; the focus mask dims moving skaters outside its box too
  const fx = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  overlay.appendChild(fx);
  fig.appendChild(overlay);
  return fx;
}
function wirePresentAnims(p) {
  stopPresentAnims();
  // power skating cards: a looping mini 3D demo per element — but only while the tile is on screen
  // (a card that is hidden or scrolled away would otherwise keep burning CPU on every frame)
  presentPSObserver = new IntersectionObserver(entries => {
    for (const e of entries) { const v = e.target._ps; if (v && e.isIntersecting !== v.playing) v.toggle(); }
  }, { threshold: 0.05 });
  for (const fig of $$('#present-body .pr-pstile')) {
    const v = createPSView(fig.querySelector('canvas'), { wheel: false }); // wheel scrolls the page, drag still orbits
    v.setElements([fig.dataset.ps]);
    fig._ps = v;
    presentPSTiles.push(v);
    presentPSObserver.observe(fig);
  }
  const rinkStr = rinkSVG(surfaceOf(p));
  for (const d of p.drills) { if (d.intro) fetchClip(presentOwner, p.id, d); prefetchNarration(presentOwner, p.id, d); } // intros and voice-over bytes ready before the first tap; a voice-over is decoded when its drill plays (a phone can't hold them all as PCM)
  for (const sec of $$('#present-body .pr-drill[data-did]')) {
    wireRules(sec); // rules-only stations have no animation but do have something to say
    const d = p.drills.find(x => x.id === sec.dataset.did);
    const fig = sec.querySelector('.pr-fig');
    let svgEl = fig?.querySelector(':scope > svg');
    const bar = sec.querySelector('.pr-animbar');
    if (!d || !svgEl || !bar) continue;
    // The card animates a local view of the drill, so a coach's tweaks (impact loser) never touch the practice.
    const dcur = { ...d };
    let sm = makeSim(dcur);
    let T = sm.duration();
    wirePinchZoom(fig);
    if (T <= 0) { // nothing moves in this drill — but a recorded intro still gets a play button
      if (d.intro) {
        bar.innerHTML = `<button class="pr-play" title="Play the coach’s intro">${icon('play')}</button><span class="muted small">🎙 coach’s intro</span>`;
        const ib = bar.querySelector('.pr-play'); let cur = null;
        ib.addEventListener('click', async () => {
          if (cur) { cur.stop(); return; }
          const entry = await fetchClip(presentOwner, p.id, d);
          if (!entry) return;
          ib.innerHTML = icon('pause');
          sec._videoLock?.(true); // the card's video waits for the intro
          cur = playClip(entry, { onEnd: () => { cur = null; ib.innerHTML = icon('play'); sec._videoLock?.(false); } });
        });
        sec._introOn = () => !!cur;
        sec._pause = () => { if (cur) cur.stop(); }; // leaving the drill stops the intro
      } else bar.remove();
      continue;
    }
    let full = T; // cards park on the final positions; ▶ restarts from the top
    let fx = splitLayers(fig, svgEl);
    wirePinchZoom(fig);
    const btn = bar.querySelector('.pr-play'), tl = bar.querySelector('.pr-tl'), disp = bar.querySelector('.pr-timedisp');
    const cueEl = sec.querySelector('.pr-cue');
    let voice = makeNarrator(drillCues(dcur, sm), text => { cueEl.textContent = text; cueEl.hidden = !text; });
    let spd = +d.animSpeed || 1; // seeded from the drill's saved playback speed
    bar.querySelector('.pr-speed')?.addEventListener('change', e => spd = +e.target.value);
    bar.querySelector('.pr-paths')?.addEventListener('change', e => { // re-render this card with paths on/off
      const tmp = document.createElement('div');
      tmp.innerHTML = standaloneSVG(dcur, rinkStr, SVG_STYLE, shareView(dcur), { showPaths: e.target.checked });
      const fresh = tmp.firstElementChild;
      svgEl.replaceWith(fresh);
      svgEl = fresh;
      fx = splitLayers(fig, svgEl);
      fig.classList.remove('zoomed'); // the fresh copy is back at the full view
      draw();
      layoutPresent(); // a rotated / landscape diagram is sized inline; the fresh copy needs it again
    });
    // "Impact: worse for" — same control as the editor's animation bar, when the drill has real impacts
    const impacts = sm.contacts();
    const linked = [...new Set(impacts.flatMap(c => [c.a, c.b]))].filter(id => dcur.objects.find(o => o.id === id)?.type === 'skater');
    if (linked.length) {
      bar.querySelector('.pr-impact').innerHTML = `<label class="check small">Impact: worse for <select class="pr-loser">
        <option value="">— even —</option>${linked.map(id => loserOption(dcur.objects.find(x => x.id === id), dcur.impactLoser === id)).join('')}</select></label>`;
      bar.querySelector('.pr-loser').addEventListener('change', e => {
        dcur.impactLoser = e.target.value || null;
        sm = makeSim(dcur); // the loser's slowdown changes the drill's timing
        voice = makeNarrator(drillCues(dcur, sm), text => { cueEl.textContent = text; cueEl.hidden = !text; });
        T = sm.duration();
        full = T;
        tl.max = T;
        a.t = Math.min(a.t, full);
        draw();
      });
    }
    tl.max = T;
    const a = { raf: 0, t: 0, playing: false, last: 0 };
    presentAnims.push(a);
    // The coach's recorded voice-over runs with the picture (voice on): from any point, and on past the end if it is longer.
    const stopNarr = () => { a.narrToken = (a.narrToken || 0) + 1; const n = a.narr; a.narr = null; n?.stop(); };
    a.stopNarr = stopNarr;
    const startNarr = () => {
      stopNarr();
      if (!voiceOn || !d.narration) return;
      const entry = clipMem.get(keyFor(presentOwner, p.id, d, 'narration')); if (!entry) return;
      const token = a.narrToken;
      const say = msg => { cueEl.textContent = msg; cueEl.hidden = false; setTimeout(() => { cueEl.hidden = true; }, 5000); };
      const begin = buf => {
        if (a.narrToken !== token || !a.playing) return;
        if (!buf) { say('🎙 voice-over couldn’t be decoded on this device'); return; }
        a.narr = playNarration(buf, narrAt(a.t, spd), { onEnd: () => { if (a.narr) { a.narr = null; draw(); } } }); draw();
        // A beat later the context must be running, or the phone is holding the audio back: say so, rather than play silence.
        setTimeout(() => { const st = narrCtx().state; if (a.narr && a.narrToken === token && st !== 'running') say(`🎙 the phone is holding audio back (${st}) — tap ▶ again`); }, 1500);
      };
      if (entry.buffer) begin(entry.buffer); else narrationBuffer(entry).then(begin);
    };
    let shown = null; // only rewrite the icon when the state flips — replacing it every frame eats clicks
    const draw = () => {
      animateFrame(dcur, sm, fig, fx, a.t, a.playing); // the figure spans both layers
      tl.value = Math.min(a.t, T);
      disp.textContent = `${Math.min(a.t, T).toFixed(1)} / ${T.toFixed(1)} s${a.narr && !a.playing ? ' · 🎙' : ''}`;
      const busy = a.playing || !!a.intro || !!a.narr;
      if (shown !== busy) { shown = busy; btn.innerHTML = icon(busy ? 'pause' : 'play'); btn.title = busy ? 'Pause' : 'Watch the drill'; }
    };
    const step = now => {
      if (!a.playing) return;
      const prev = a.fresh ? -1 : a.t; // a cue at 0.0 s fires on the first frame of a fresh start
      a.fresh = false;
      a.t += Math.min(0.1, (now - a.last) / 1000) * spd; a.last = now;
      if (a.t >= full) { a.t = full; a.playing = false; } // parked; a longer voice-over keeps talking
      draw();
      voice.step(prev, a.t, { silent: !!a.narr }); // captions only while the coach's recorded voice is talking
      if (a.playing) a.raf = requestAnimationFrame(step);
    };
    btn.addEventListener('click', () => {
      if (a.intro) { a.intro.cancelled = true; a.intro.stop(); return; } // ⏸ during the intro skips it, parked at the start
      if (!a.playing && a.narr) { stopNarr(); draw(); return; } // the picture is parked, the voice still going: ⏸ ends it
      if (a.playing) { a.playing = false; cancelAnimationFrame(a.raf); voice.clear(); stopNarr(); draw(); return; }
      primeVoice();
      logDrillView(p, d.id, 'play');
      if (a.t >= full) a.t = 0;
      const go = () => { a.fresh = a.t === 0; a.playing = true; a.last = performance.now(); a.raf = requestAnimationFrame(step); startNarr(); draw(); };
      // From the top with a recorded intro (and voice on): the coach speaks first, then the drill runs.
      const clip = a.t === 0 && voiceOn && d.intro ? clipMem.get(keyFor(presentOwner, p.id, d)) : null;
      if (!clip) {
        if (a.t === 0 && voiceOn && d.intro) { cueEl.textContent = '🎙 intro not downloaded yet — tap ↻ to resync'; cueEl.hidden = false; setTimeout(() => { cueEl.hidden = true; }, 3500); }
        go(); return;
      }
      if (!canPlay(clip.mime)) { cueEl.textContent = `🎙 intro can’t play on this device (${clip.mime})`; cueEl.hidden = false; setTimeout(() => { cueEl.hidden = true; }, 4000); go(); return; }
      cueEl.textContent = '🎙 Coach’s intro…'; cueEl.hidden = false;
      a.intro = playClip(clip, { onEnd: err => {
        const skip = a.intro?.cancelled; a.intro = null;
        sec._videoLock?.(false);
        if (err) { cueEl.textContent = `🎙 intro didn’t play — ${err}`; setTimeout(() => { cueEl.hidden = true; }, 4000); } else cueEl.hidden = true;
        if (skip) draw(); else go();
      } });
      sec._videoLock?.(true); // the card's video (button and player) waits for the intro
      draw();
    });
    sec._introOn = () => !!a.intro;
    tl.addEventListener('input', () => { a.t = +tl.value; draw(); if (a.playing) startNarr(); else stopNarr(); });
    // On a phone the diagram itself is the biggest play button there is.
    fig.addEventListener('click', () => { if (!fig.classList.contains('zoomed')) btn.click(); });
    sec._pause = () => { if (a.intro) { a.intro.cancelled = true; a.intro.stop(); } if (a.playing) btn.click(); else if (a.narr) { stopNarr(); draw(); } }; // leaving the drill in rink mode parks it
    draw();
  }
}
/** A message card over the viewer. `opts`: signIn / reload / request (show that control), list: '/coach' (a link back to their practices). */
function presentMsg(msg, opts = {}) {
  $('#present-gate').hidden = false;
  $('#present-msg').textContent = msg;
  $('#present-signin').hidden = !opts.signIn;
  $('#present-anon').hidden = !opts.anon;
  $('#present-reload').hidden = !opts.reload;
  $('#present-request').hidden = !opts.request;
  $('#present-tolist').hidden = !opts.list;
  if (opts.list) $('#present-tolist').dataset.to = opts.list;
  // Signed in but stuck on a message (usually: the wrong Google account for this link) — say who, and offer the way out.
  const u = cloudSync?.user, quiet = msg === 'Loading…' || msg === CHECKING;
  $('#present-switch').hidden = !u || quiet;
  $('#present-who').textContent = u && !quiet ? `Signed in as ${u.email || u.name}` : '';
}
const CHECKING = 'Checking your sign-in…';
/** Sign out of the viewer. The offline practice copies on this device go too: they belong to the account that could read them. */
async function presentSignOut() {
  closeAcct();
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('hpp.viewcache.') || k.startsWith('hpp.inbox.') || k.startsWith('hpp.teamlist.')) localStorage.removeItem(k); } catch { /* storage blocked */ }
  try { localStorage.removeItem(viewQueueKey); } catch { /* fine */ }
  leavePractice();
  try { await cloudSync?.signOut(); } catch (e) { presentMsg(`Sign-out failed: ${e?.message || e}`); }
}
function openAcct() {
  const u = cloudSync?.user; if (!u) return;
  const guest = who.persona === 'guest';
  $('#present-acct-who').textContent = guest ? 'A guest — watching an open practice without an account.' : u.email && u.name !== u.email ? `${u.name} · ${u.email}` : u.name;
  $('#present-acct-google').hidden = !guest;
  $('#present-signout').hidden = guest;
  $('#present-acct-note').textContent = guest ? 'Coaches and families on the team list: sign in with that Google account to get your own list of practices (and, for coaches, the feedback button).' : 'Signing out removes the practice copies kept on this device for offline use. Sign in again with the Google email the practice was shared with.';
  $('#present-acct').hidden = false;
}
$('#present-acct-google').addEventListener('click', () => { closeAcct(); cloudSync?.signIn().catch(e => presentMsg(`Sign-in failed: ${friendlyAuthError(e)}`, { signIn: true })); });
function closeAcct() { $('#present-acct').hidden = true; }

// ---------- audit log: who looked at which drill, and when ----------
// Each viewer appends records to users/{owner}/practices/{pid}/views (rules: append-only in their own name;
// the owner alone reads them). A "view" is a drill card on screen for 2 s; a "play" is its ▶. One record per
// drill / action / viewer per 5 minutes, so a coach flipping back and forth doesn't flood the log.
// Records that can't be written right away (offline at the rink) wait in localStorage for the next load.
const VIEW_GAP = 5 * 60 * 1000;
const viewLogged = new Map(); // `${pid}:${did}:${action}` → last logged ms
let viewTimer = 0;
const viewQueueKey = 'hpp.viewqueue';
function logDrillView(p, did, action) {
  if (!cloudBackend?.logView || !cloudSync?.user) return; // nobody to log as (offline copies with no session are anonymous)
  // The planner's own views are logged too (marked 'planner'), so the log can be checked without a second account.
  const d = p.drills.find(x => x.id === did); if (!d) return;
  const key = `${p.id}:${did}:${action}`;
  const now = Date.now();
  if (now - (viewLogged.get(key) || 0) < VIEW_GAP) return;
  viewLogged.set(key, now);
  const u = cloudSync.user;
  const entry = { uid: u.uid, email: (u.email || '').toLowerCase(), name: u.name || '', drillId: did, drillName: d.name, action, at: now,
    audience: who.persona === 'planner' ? 'planner' : presentAudience, device: matchMedia('(pointer: coarse)').matches ? 'phone' : 'desktop' };
  sendView(presentOwner, p.id, entry);
}
function logReaction(p, emoji) {
  if (!cloudBackend?.logView || !cloudSync?.user) return false;

  const key = `${p.id}:react:${emoji}`;
  const now = Date.now();
  if (now - (viewLogged.get(key) || 0) < VIEW_GAP) return true;
  viewLogged.set(key, now);
  const u = cloudSync.user;
  sendView(presentOwner, p.id, { uid: u.uid, email: (u.email || '').toLowerCase(), name: u.name || '', drillId: null, drillName: 'Dismissal', action: 'react', emoji, at: now,
    audience: who.persona === 'planner' ? 'planner' : presentAudience, device: matchMedia('(pointer: coarse)').matches ? 'phone' : 'desktop' });
  return true;
}
async function sendView(owner, pid, entry, teamId = teamFor(pid)) {
  try { await cloudBackend.logView(teamId, pid, entry); }
  catch { try { const q = JSON.parse(localStorage.getItem(viewQueueKey) || '[]'); q.push({ owner, pid, entry, teamId }); localStorage.setItem(viewQueueKey, JSON.stringify(q.slice(-200))); } catch { /* full: dropped */ } }
}
/** Retry records queued while offline — called once a signed-in session is up. */
async function flushViewQueue() {
  let q = [];
  try { q = JSON.parse(localStorage.getItem(viewQueueKey) || '[]'); } catch { q = []; }
  if (!q.length || !cloudBackend?.logView || !cloudSync?.user) return;
  localStorage.removeItem(viewQueueKey);
  for (const item of q) if (item.entry?.uid === cloudSync.user.uid) await sendView(item.owner, item.pid, item.entry, item.teamId);
}
/** The card on screen counts as viewed after it has been there 2 s (focus mode: the current card). */
function noteCurrentView(p) {
  clearTimeout(viewTimer);
  const sec = presentCards()[presentIndex];
  const did = sec?.dataset.did; if (!did) return;
  viewTimer = setTimeout(() => { if (presentCards()[presentIndex]?.dataset.did === did) logDrillView(p, did, 'view'); }, 2000);
}
let presentViewIO = null; // list mode: a card scrolled at least half into view for 2 s
function watchListViews(p) {
  presentViewIO?.disconnect();
  const timers = new Map();
  // "On screen" = at least half the card, or at least half the viewport when the card is taller than it (a phone, where a
  // card with a diagram can never be half visible at once) — a view is logged after 2 s of that.
  const onScreen = e => e.isIntersecting && e.intersectionRect.height >= 0.5 * Math.min(e.boundingClientRect.height, (e.rootBounds?.height || innerHeight));
  presentViewIO = new IntersectionObserver(entries => {
    for (const e of entries) {
      const did = e.target.dataset.did; if (!did) continue;
      clearTimeout(timers.get(did));
      if (onScreen(e) && presentMode === 'list') timers.set(did, setTimeout(() => logDrillView(p, did, 'view'), 2000));
    }
  }, { root: $('#present-scroll'), threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 1] });
  for (const sec of $$('#present-body .pr-drill[data-did]')) presentViewIO.observe(sec);
}

// ---------- who is here, and the screen they get (docs/requirements-routing-auth.md; the matrix is resolveRoute in access.js) ----------
let authKnown = false;   // Firebase has said whether anyone is signed in
let signInError = '';
let viewerInbox;         // a non-planner's list document (inbox/{email}): undefined = not loaded yet, null = on no roster
let inboxUnsub = null, inboxFor = null, inboxTimer = 0, inboxStale = false;
let who = { persona: 'checking' };
let screen = { screen: 'checking' };
const inboxKey = email => `hpp.inbox.${email}`;
const ownerFlag = () => { try { return localStorage.getItem('hpp.owner') === '1'; } catch { return false; } };

/** { persona: 'checking' | 'offline' | 'anonymous' | 'planner' | 'coach' | 'team' | 'unknown', roles: { [practiceId]: 'coach' | 'team' } } */
function currentWho() {
  if (cloudBoot === 'none') return { persona: 'planner' }; // local-only install (no Firebase config): nothing to sign in to
  if (cloudBoot === 'loading') return { persona: 'checking' };
  // Cloud didn't load: the planner's own device still works offline; anyone else sees what this device kept, or an error.
  if (cloudBoot === 'failed') return { persona: ownerFlag() ? 'planner' : 'offline' };
  if (!authKnown) return { persona: 'checking' };
  const u = cloudSync?.user;
  if (!u) return { persona: 'anonymous' };
  if (isOwner(u)) return { persona: 'planner', teams: plannerTeams(), practiceTeam: Object.fromEntries(store.data.practices.map(p => [p.id, p.teamId || teamOf(p)?.id || null])) };
  if (u.isAnonymous) return { persona: 'guest', roles: {} }; // may watch open practices; has no inbox
  if (viewerInbox === undefined) return { persona: inboxStale ? 'offline' : 'checking' };
  if (!viewerInbox) return { persona: 'unknown' };
  const teams = Object.entries(viewerInbox.teams || {}).map(([id, t]) => ({ id, ...t }));
  return { persona: viewerInbox.persona === 'coach' ? 'coach' : 'team', teams };
}

/** Follow the signed-in viewer's list document live: being approved, or a practice being released, shows up without a reload. */
function watchInbox() {
  const u = cloudSync?.user;
  const email = u && !isOwner(u) ? String(u.email || '').toLowerCase() : null;
  if (email === inboxFor) return;
  inboxUnsub?.(); inboxUnsub = null; clearTimeout(inboxTimer);
  inboxFor = email; viewerInbox = undefined; inboxStale = false;
  if (!email || !cloudBackend?.subscribePerson) return;
  for (const rec of teamLists.values()) rec.unsub?.(); teamLists.clear(); // another person: their teams' lists start over
  try { viewerInbox = JSON.parse(localStorage.getItem(inboxKey(email)) || 'null') || undefined; } catch { viewerInbox = undefined; } // last known list: the rink has no signal
  inboxTimer = setTimeout(() => { if (viewerInbox === undefined) { inboxStale = true; refreshScreen(); } }, 8000);
  inboxUnsub = cloudBackend.subscribePerson(email, (doc, err) => {
    clearTimeout(inboxTimer);
    if (inboxFor !== email) return;
    if (err) { if (viewerInbox === undefined) inboxStale = true; refreshScreen(); return; }
    viewerInbox = doc; inboxStale = false;
    try {
      if (doc) localStorage.setItem(inboxKey(email), JSON.stringify(doc));
      else for (const k of Object.keys(localStorage)) if (k === inboxKey(email) || k.startsWith('hpp.viewcache.') || k.startsWith('hpp.teamlist.')) localStorage.removeItem(k); // off every roster: the offline copies go too
    } catch { /* fine */ }
    refreshScreen();
  });
}

const viewCacheKey = pid => `hpp.viewcache.${pid}`;
function leavePractice() {
  stopPresentAnims(); presentUnsub?.(); presentUnsub = null; presentKey = null; presentShownId = null; presentPractice = null;
  presentViewIO?.disconnect(); clearTimeout(viewTimer); clearInterval(nowTimer); closeFeedback();
  if (showingPractice) { showingPractice = false; $('#present-body').innerHTML = ''; applyPresentMode(); }
  paintWhen();
}
/** The copy of a practice this device kept from the last visit (rink mode) — shown with a note about why it is not live. */
function showCachedPractice(pid, note) {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(viewCacheKey(pid)) || 'null'); } catch { cached = null; }
  if (!cached?.p) return false;
  if (presentKey !== `cached/${pid}`) {
    leavePractice(); presentKey = `cached/${pid}`;
    (cached.p.drills || []).forEach(migrateDrill);
    presentOwner = cached.p.owner || 'local'; feedbackOn = false;
    presentDoc(cached.p);
  }
  presentNote(`Offline copy from ${stamp(cached.at)} — ${note}`);
  return true;
}

/** Put the right screen up for the URL and whoever is signed in; called at boot, on navigation and on every sign-in / list change. */
function refreshScreen() {
  who = currentWho();
  const waiting = who.persona === 'checking' || who.persona === 'offline';
  // Until we know who this is, only links from before paths existed and unknown paths move; everything else waits where it is.
  const decide = route => waiting && !(route.view === 'unknown' || (route.legacy && route.view !== 'root'))
    ? { screen: who.persona, as: route.view, pid: route.pid } : resolveRoute(route, who);
  let route = parseRoute(location);
  // Approved (or signed in to the right account) while on the request screen: carry on to the link they first opened.
  if (route.view === 'request' && ['coach', 'team', 'planner'].includes(who.persona)) {
    let wanted = null;
    try { wanted = sessionStorage.getItem('hpp.wanted'); sessionStorage.removeItem('hpp.wanted'); } catch { /* fine */ }
    if (wanted && parseRoute({ pathname: wanted }).view !== 'request') { history.replaceState(null, '', wanted); route = parseRoute(location); }
  }
  let r = decide(route);
  for (let i = 0; r.go && i < 5; i++) {
    if (r.go === '/request-access' && route.pid) { try { sessionStorage.setItem('hpp.wanted', location.pathname); } catch { /* fine */ } }
    history.replaceState(null, '', r.go); // replace: Back must not bounce through the redirect
    route = parseRoute(location); r = decide(route);
  }
  screen = r;
  presenting = r.screen !== 'editor';
  // The viewer always speaks: intros, voice-overs and cues play for coaches and families no matter what this browser's
  // editor mute says (there is no mute in the viewer). Back in the editor the device's own preference returns.
  setVoiceOn(presenting ? true : storedVoice());
  document.body.classList.toggle('presenting', presenting);
  syncEditor(!presenting);
  $('#present').hidden = !presenting;
  keepAwake(r.screen === 'practice');
  if (!presenting) { leavePractice(); return; }
  $('#present-user').textContent = who.persona === 'guest' ? 'Guest' : cloudSync?.user?.name || '';
  $('#present-account').hidden = !cloudSync?.user;
  if (!cloudSync?.user) closeAcct();
  applyPresentMode();
  // The tab bar stays up throughout the team's app — the home tabs and inside a practice or game alike — whenever a team is in hand.
  if (r.screen === 'list' && r.teamId) paintTabs(r.as, r.teamId, r.tab || (r.as === 'coach' ? 'dashboard' : 'practice'));
  else if (r.screen === 'practice' && r.teamId && ['coach', 'team', 'planner'].includes(who.persona)) paintTabs(r.as, r.teamId, practiceItems(r.as).find(x => x.pid === r.pid)?.kind === 'game' ? 'games' : 'practice');
  else $('#present-tabs').hidden = true;
  const offlineMsg = `Couldn't connect. Check your internet connection — a content blocker or a filtered Wi-Fi network can also stop it — then try again.${cloudBootError ? ` (${cloudBootError})` : ''}`;
  $('#ask-screen').hidden = r.screen !== 'ask';
  switch (r.screen) {
    case 'ask': leavePractice(); showAsk(r); break;
    case 'practice': showPractice(r); paintWhen(); break; // the list may have changed under an open practice (a newer one released)
    case 'list': leavePractice(); showList(r); break;
    case 'teams': leavePractice(); showTeams(r); break;
    case 'request': leavePractice(); showRequest(); break;
    case 'unavailable':
      leavePractice();
      if (!inboxStale) { try { localStorage.removeItem(viewCacheKey(r.pid)); } catch { /* fine */ } } // released no longer (or never): the offline copy goes too
      $('#present-title').textContent = '';
      presentMsg("This practice isn't available yet. It will show up in your list once your coach sends it out.", { list: `/${r.as}` });
      break;
    case 'signin':
      if (route.pid && showCachedPractice(route.pid, 'sign in when online to get updates.')) break;
      leavePractice(); $('#present-title').textContent = '';
      presentMsg(signInError ? `Sign-in failed: ${signInError}` : inAppBrowser() ? `This link opened inside another app's browser, where Google sign-in doesn't work. Open it in ${/iPhone|iPad/.test(navigator.userAgent) ? 'Safari' : 'Chrome'} instead — tap the ⋯ or share button and choose “Open in browser”, or copy the address: ${location.origin}${location.pathname}`
        : route.view === 'editor' || route.view === 'root'
        ? 'Sign in to continue.' : 'Practice plans are shared with the team. Sign in with the Google account your coach has on the team list.', { signIn: true, anon: !!route.pid });
      break;
    case 'offline':
      if (route.pid && showCachedPractice(route.pid, 'reconnect to get updates.')) break;
      leavePractice(); $('#present-title').textContent = '';
      presentMsg(offlineMsg, { reload: true });
      break;
    default: // checking
      if (route.pid && showCachedPractice(route.pid, 'checking for updates…')) break;
      leavePractice(); $('#present-title').textContent = '';
      presentMsg(CHECKING);
  }
}

/** One practice, as /coach/<id> or /team/<id> shows it. */
function showPractice(r) {
  ensureLatestViewer(); // a stale page reloads itself (the URL brings it straight back here) before the practice is used
  const pid = r.pid;
  presentAudience = r.as;
  if (who.persona === 'planner') {
    // The planner previews their own practice straight from the store (drafts included, offline too) — as the audience would get it.
    const mine = store.data.practices.find(x => x.id === pid && !x.deleted);
    if (mine) {
      const key = `mine/${r.as}/${pid}/${mine.updatedAt || 0}`;
      if (presentKey === key) return;
      presentUnsub?.(); presentUnsub = null; presentKey = key;
      presentOwner = ownerFor(); feedbackOn = false;
      presentDoc(publishedCopy(mine, ownerFor(), r.as));
      return;
    }
    if (!cloudBackend) { leavePractice(); presentMsg("This practice isn't on this device.", { list: `/${r.as}` }); return; }
  }
  if (!r.teamId) { // an older link that named only the practice: its team is in the index — then back here with the full address
    const key0 = `lookup/${pid}`; if (presentKey === key0) return; presentUnsub?.(); presentUnsub = null; presentKey = key0;
    if (!showCachedPractice(pid, 'finding its team…')) { leavePractice(); presentKey = key0; presentMsg('Loading…'); }
    cloudBackend.lookupTeam(pid).then(t => { if (presentKey !== key0) return; presentKey = null; if (t) navigate(routePath({ view: r.as, teamId: t, pid }), { replace: true }); else { leavePractice(); presentMsg('This practice no longer exists.', { list: `/${r.as}` }); } })
      .catch(e => { if (presentKey === key0) { presentKey = null; leavePractice(); presentMsg(`Could not find that practice: ${e?.message || e}`, { reload: true }); } });
    return;
  }
  watchTeamList(r.teamId); // the switcher bar lists this team
  const mayComment = r.as === 'coach' && (who.teams || []).find(t => t.id === r.teamId)?.role === 'coach';
  const key = `live/${r.as}/${r.teamId}/${pid}/${mayComment}`;
  if (presentKey === key) return; // already watching this practice
  const hadCopy = showCachedPractice(pid, 'checking for updates…');
  presentUnsub?.(); presentUnsub = null;
  presentKey = key; feedbackOn = mayComment;
  if (!hadCopy) { leavePractice(); presentKey = key; feedbackOn = mayComment; presentMsg('Loading…'); }
  presentUnsub = cloudBackend.subscribePractice(r.teamId, pid, (raw, err) => {
    if (presentKey !== key) return;
    if (err) {
      // Not (or no longer) on the list: the copy kept for offline use goes too, rather than outliving the access.
      if (err.code === 'permission-denied') {
        try { localStorage.removeItem(viewCacheKey(pid)); } catch { /* fine */ }
        leavePractice(); presentKey = key;
        if (who.persona === 'guest') presentMsg("This practice isn't open to guests. Sign in with the Google account your coach has on the team list.", { signIn: true });
        else if (who.persona === 'unknown') { try { sessionStorage.setItem('hpp.wanted', location.pathname); } catch { /* fine */ } navigate('/request-access', { replace: true }); } // on no roster and not an open practice: ask for access (and come back here once approved)
        else if (r.probe) presentMsg("This practice isn't available to you. It will show up in your list once your coach sends it out.", { list: `/${who.persona}` });
        else presentMsg("This practice isn't available to you. It will show up in your list once your coach sends it out.", { list: routePath({ view: r.as, teamId: r.teamId }) }); // on the team, but this one is a draft, or not yet released to their role
      } else if (!showingPractice) presentMsg(`Could not load the practice: ${err.message || err}`, { reload: true });
      else presentNote('Offline — showing the copy on this device.');
      return;
    }
    if (!raw) { try { localStorage.removeItem(viewCacheKey(pid)); } catch { /* fine */ } leavePractice(); presentKey = key; return presentMsg('This practice no longer exists.', { list: `/${r.as}` }); }
    const p = publishedCopy(raw, raw.owner || 'local', r.as); // as the audience gets it: hidden (and, for the team, coaches-only) drills and the sharing bookkeeping left out
    (p.drills || []).forEach(migrateDrill);
    try { localStorage.setItem(viewCacheKey(pid), JSON.stringify({ p, at: Date.now() })); } catch { /* full/blocked storage: live view still works */ }
    presentOwner = p.owner || 'local'; feedbackOn = mayComment;
    presentDoc(p);
  });
}

const plannerTeams = () => (store.roster.teams || []).filter(t => t.id).map(t => ({ id: t.id, name: t.name || '', role: 'coach' }));
// A viewer's lists come straight from each team's practice headers, live: the query carries the stages their role may
// read (coaches: out to coaches or released; families: released), so it is small and the rules can prove it.
const teamLists = new Map(); // teamId → { items, ready, error, unsub }
const teamListKey = teamId => `hpp.teamlist.${teamId}`;
function watchTeamList(teamId) {
  const mine = (who.teams || []).find(t => t.id === teamId);
  if (!teamId || !mine || !cloudBackend?.subscribeTeamPractices || !cloudSync?.user || who.persona === 'planner') return; // only someone on the team may list it
  const role = mine.role === 'coach' ? 'coach' : 'team';
  const had = teamLists.get(teamId);
  if (had?.role === role) return;
  had?.unsub?.(); // their role on the team changed: the list is asked for again with the stages that role may read
  const rec = { role, items: [], ready: false, error: null, unsub: null };
  try { rec.items = JSON.parse(localStorage.getItem(teamListKey(teamId)) || '[]').filter(x => x.role === role); } catch { /* fine */ }
  teamLists.set(teamId, rec);
  rec.unsub = cloudBackend.subscribeTeamPractices(teamId, role === 'coach' ? ['coaches', 'team'] : ['team'], (heads, err) => {
    if (err) { rec.ready = true; rec.error = err; refreshScreen(); return; }
    rec.items = (heads || []).filter(h => !h.shareOnly).map(h => ({ pid: h.id, role, stage: h.stage, team: h.team || '', teamId, date: h.date || '', time: h.time || '', drillCount: h.drillCount || 0, minutes: h.minutes || 0, drillNames: h.drillNames || [], ...(h.surface === 'dryland' ? { surface: 'dryland' } : {}), ...(h.kind === 'game' ? { kind: 'game', opponent: h.opponent || '' } : {}) }));
    rec.ready = true; rec.error = null;
    try { localStorage.setItem(teamListKey(teamId), JSON.stringify(rec.items)); } catch { /* fine */ } // the list from the last visit: the rink has no signal
    refreshScreen();
  });
}
/** The practices this person can open on /coach or /team: { pid, role, team, teamId, date, time }. The planner previewing one practice (`all`) can step through drafts too. */
function practiceItems(as) {
  if (who.persona === 'planner') {
    // The coach view is where the planner previews: drafts are listed there (marked), as a coach will see them once sent out. The team view shows only what the team has.
    return store.live.filter(p => as === 'team' ? stageOf(p) === 'team' : true)
      .map(p => { const ds = (p.drills || []).filter(d => !d.hidden); return { pid: p.id, role: as, stage: stageOf(p), team: p.team, teamId: p.teamId || teamOf(p)?.id || '', date: p.date, time: p.time, drillCount: ds.length, minutes: ds.reduce((a, d) => a + (+d.duration || 0), 0), drillNames: ds.map(d => d.name || ''), ...(isDryland(p) ? { surface: 'dryland' } : {}), ...(isGame(p) ? { kind: 'game', opponent: p.opponent || '' } : {}) }; });
  }
  return [...teamLists.values()].flatMap(r => r.items);
}
const itemPath = (as, x) => routePath({ view: as === 'coach' && x.role === 'coach' ? 'coach' : 'team', teamId: x.teamId || null, pid: x.pid }); // a coach's parent-only practices open as the team sees them
const teamName = id => (who.teams || []).find(t => t.id === id)?.name || '';

/**
 * Which practice is this? The bar under the top bar names the team and has a dropdown of dates to switch to any other
 * practice released to the team. And when the one on screen is not the one the calendar points at — the next practice (today's counts all
 * day), else the most recent — a red banner says so and jumps there: nobody runs last week's plan by mistake.
 */
let whenTarget = null;
function paintWhen() {
  const p = showingPractice ? presentPractice : null;
  const bar = $('#present-when'), warn = $('#present-warn'), sel = $('#when-select');
  const was = `${bar.hidden}${warn.hidden}`;
  if (!p) { bar.hidden = true; warn.hidden = true; whenTarget = null; }
  else {
    // The dropdown lists exactly what has been released to this person: as a coach, every practice and game sent to
    // the coaches or the team; as a team member, only those released to the team. Never a draft. All teams, so an old
    // one under a different team name is still a way back. The banner points at the calendar's pick (today's, else
    // the next, else the most recent) whenever that is not the one on screen.
    const tid = p.teamId || screen?.teamId || null; // the practice's team: the bar switches within it
    if (tid) watchTeamList(tid);
    const items = practiceItems(presentAudience).filter(x => (x.stage === 'team' || (x.stage === 'coaches' && presentAudience === 'coach') || (x.stage === 'draft' && who.persona === 'planner' && presentAudience === 'coach')) && (!tid || x.teamId === tid)).sort(byCalendar);
    const listed = items.some(x => x.pid === p.id);
    const today = todayISO();
    const teams = new Set(items.map(x => String(x.team || '').trim().toLowerCase()));
    const say = x => `${teams.size > 1 || x.kind === 'game' || x.surface === 'dryland' ? `${docTitle(x)} · ` : ''}${whenLabel(x)}${x.stage === 'draft' ? ' · draft' : ''}`;
    bar.hidden = false;
    $('#when-team').textContent = docTitle(p);
    const opt = (x, extra = '') => `<option value="${escHtml(itemPath(presentAudience, x))}"${x.pid === p.id ? ' selected' : ''}>${escHtml(say(x))}${x.date === today ? ' · today' : ''}${extra}</option>`;
    // An unreleased one (the planner previewing a draft) is never listed: a placeholder stands in for it.
    sel.innerHTML = (listed ? '' : '<option value="" selected disabled>— not released yet —</option>') + items.map(x => opt(x)).join('');
    // The banner waits until this person's list is actually known (the inbox has arrived) and the practice on screen is
    // on it: on a first open the practice can land before the list does, and a banner computed from a half-loaded list
    // would wrongly flag the right practice as the wrong one.
    const listKnown = who.persona === 'planner' || (viewerInbox !== undefined && (!tid || !teamLists.has(tid) || teamLists.get(tid).ready));
    const focus = listKnown && listed ? calendarFocus(items, today) : null;
    whenTarget = focus && focus.pid !== p.id ? itemPath(presentAudience, focus) : null;
    warn.hidden = !whenTarget;
    if (whenTarget) {
      const upcoming = (focus.date || '') >= today;
      const noun = docNoun(p), fnoun = focus.kind === 'game' ? 'game' : 'practice';
      warn.textContent = `${byCalendar(p, focus) < 0 ? `⚠ This is an older ${noun}` : `⚠ This is a future ${noun}`} (${dayDate(p.date)}). `
        + `${upcoming ? (focus.date === today ? `Today’s ${fnoun}` : `The next ${fnoun}`) : `The most recent ${fnoun}`} is ${say(focus)} — tap to open it.`;
    }
  }
  if (was !== `${bar.hidden}${warn.hidden}`) layoutPresent();
}
$('#when-select').addEventListener('change', e => { if (e.target.value && e.target.value !== location.pathname) navigate(e.target.value); });
$('#present-warn').addEventListener('click', () => { if (whenTarget) navigate(whenTarget); });

/** /coach and /team: every practice released to this person, upcoming first — one bookmark for the whole season. */
/** Someone on several teams: pick one. */
function showTeams(r) {
  const as = r.as;
  $('#present-title').textContent = 'Your teams';
  $('#present-gate').hidden = true; presentNote('');
  $('#present-body').innerHTML = `<div class="pl-list"><h2>Teams</h2>${(who.teams || []).map(t => `<a class="pl-item" href="${routePath({ view: as === 'coach' && t.role === 'coach' ? 'coach' : 'team', teamId: t.id })}" data-nav><b>${escHtml(t.name || 'Team')}</b><span>${t.role === 'coach' ? 'coach' : 'family'}</span></a>`).join('')}</div>`;
  $('#present-scroll').scrollTop = 0;
}
/** A team's home, as an app: Practice (the one the calendar points at, then the rest), Tasks (a club team's week) and Games (notes). */
const LIST_TAB_DEFS = [['dashboard', 'Dashboard', 'dashboard'], ['practice', 'Practice', 'calendar'], ['tasks', 'Tasks', 'tasks'], ['games', 'Games', 'games'], ['questions', 'Survey', 'notes']]; // Dashboard: coaches only
let listKey = null; // which home is on screen, so a repaint doesn't wipe the Tasks tab while someone types
/** The bottom tab bar: Dashboard (coaches) · Practice · Tasks (club teams) · Games — `tab` is the lit one. */
function paintTabs(as, teamId, tab) {
  const club = clubsFor().some(c => c.id === teamId);
  const html = LIST_TAB_DEFS.filter(([k]) => (k !== 'tasks' || club) && (k !== 'dashboard' || as === 'coach')).map(([k, label, ic]) => `<a class="pr-tab${k === tab ? ' active' : ''}" href="${routePath({ view: as, teamId, tab: k })}" data-nav>${icon(ic)}<span>${label}</span></a>`).join('');
  const bar = $('#present-tabs');
  if (bar.innerHTML !== html) bar.innerHTML = html;
  bar.hidden = false;
}
const draftBadge = x => x.stage === 'draft' ? '<span class="pl-draft" title="Only you see this: it has not been sent to the coaches yet">draft</span>' : ''; // the planner's coach view lists drafts
function showList(r) {
  ensureLatestViewer();
  const as = r.as, tab = r.tab || (as === 'coach' ? 'dashboard' : 'practice');
  if (r.teamId) watchTeamList(r.teamId); else for (const t of who.teams || []) watchTeamList(t.id);
  const all = practiceItems(as).filter(x => !r.teamId || x.teamId === r.teamId); // one team's list
  const rec = r.teamId ? teamLists.get(r.teamId) : null, loading = who.persona !== 'planner' && rec && !rec.ready && !rec.items.length;
  const today = todayISO();
  const tn = r.teamId ? teamName(r.teamId) : '';
  $('#present-title').textContent = `${tn || 'Practices'}${who.persona === 'planner' ? ` — ${as} view` : ''}`;
  $('#present-gate').hidden = true; presentNote(inboxStale || (rec && !rec.ready && rec.items.length) ? 'Offline — this is the list from your last visit.' : '');
  $('#present-home').title = (who.teams || []).length > 1 ? 'Your teams' : 'All your practices';
  const club = r.teamId ? clubsFor().find(c => c.id === r.teamId) : null;
  const key = `${as}/${r.teamId}/${tab}`;
  if (tab === 'tasks') { if (listKey === key && $('#tasks-tab')) return; listKey = key; renderTasksTab(club, as); $('#present-scroll').scrollTop = 0; return; }
  if (tab === 'questions') { listKey = key; renderQuestionsTab(r, key); $('#present-scroll').scrollTop = 0; return; }
  listKey = key;
  const empty = loading ? '<p class="muted">Loading…</p>' : rec?.error && !rec.items.length ? `<p class="warn">Could not load this team's practices: ${escHtml(rec.error.message || rec.error)}</p>` : null;
  const row = x => `<a class="pl-item" href="${itemPath(as, x)}" data-nav>
      <b>${escHtml(docTitle(x))}</b><span>${escHtml(whenLabel(x, true))}</span>
      ${draftBadge(x)}${x.date === today ? '<span class="pl-today">today</span>' : ''}</a>`;
  let html;
  if (tab === 'dashboard') html = dashboardHTML(r, all, club, today);
  else if (tab === 'games') {
    // Game notes: each game with its coaching points listed; open it for the diagrams, video and the coach's voice.
    const games = all.filter(x => x.kind === 'game').sort(byCalendar).reverse();
    const grow = x => `<a class="pl-item pl-game" href="${itemPath(as, x)}" data-nav><b>${escHtml(docTitle(x))}${draftBadge(x)}</b><span>${escHtml(whenLabel(x, true))}${x.date === today ? ' · today' : ''}</span>
      ${x.drillNames?.length ? `<ul class="pl-points">${x.drillNames.map(n => `<li>${escHtml(n || 'Coaching point')}</li>`).join('')}</ul>` : ''}</a>`;
    html = games.length ? `<h2>Game notes</h2>${games.map(grow).join('')}` : empty || '<p class="muted">No game notes yet — they show up here once your coach sends a game out.</p>';
  } else {
    // The practice the calendar points at (today's, else the next, else the most recent) up top; the rest below it.
    const practices = all.filter(x => x.kind !== 'game');
    const focus = practices.length ? calendarFocus(practices, today) : null;
    const rest = practices.filter(x => x !== focus);
    const upcoming = rest.filter(x => (x.date || '') >= today).sort(byCalendar), past = rest.filter(x => (x.date || '') < today).sort(byCalendar).reverse();
    const hero = focus ? `<a class="pl-item pl-hero" href="${itemPath(as, focus)}" data-nav>
      <small>${focus.date === today ? 'Today’s' : (focus.date || '') > today ? 'Next' : 'Last'} ${focus.surface === 'dryland' ? 'dryland' : 'practice'}${focus.stage === 'draft' ? ' · draft, not sent out yet' : ''}</small>
      <b>${escHtml(whenLabel(focus, true))}</b>
      <span>${focus.drillCount || 0} drill${focus.drillCount === 1 ? '' : 's'}${focus.minutes ? ` · ${focus.minutes} min` : ''}</span>
      <em>Open ▶</em></a>` : '';
    html = `${hero}${!practices.length ? (empty || '<p class="muted">Nothing here yet — practices show up once your coach sends them out.</p>') : ''}
      ${upcoming.length ? `<h2>Upcoming</h2>${upcoming.map(row).join('')}` : ''}
      ${past.length ? `<h2>Earlier</h2>${past.map(row).join('')}` : ''}`;
  }
  $('#present-body').innerHTML = `<div class="pl-list">${html}</div>`;
  $('#present-scroll').scrollTop = 0;
}
// ---------- the coach's dashboard: the season at a glance, and how the week's tasks are going across the team ----------
const dashCache = new Map(); // teamId → { week, ready, error, tasks, players, stats }
/** The week's task list, the roster and every player's numbers for one team — fetched once per week, then the dashboard repaints. */
function loadDashboard(teamId, week) {
  const had = dashCache.get(teamId);
  if (had && had.week === week) return had;
  const rec = { week, ready: false, error: null, tasks: [], players: {}, stats: new Map() };
  dashCache.set(teamId, rec);
  (async () => {
    try {
      const doc = await loadClubDoc(teamId);
      if (!doc) throw new Error('could not load the club team');
      rec.players = doc.players || {};
      rec.tasks = who.persona === 'planner' ? tasksForWeek(doc, week) : ((await cloudBackend.loadTasks(teamId, week))?.tasks || []);
      if (cloudBackend?.loadWeekStats && cloudSync?.user) {
        const [now, old] = await Promise.all([cloudBackend.loadWeekStats(teamId, week), cloudBackend.loadWeekStats(teamId, legacyWeek(week)).catch(() => [])]);
        for (const s of old) rec.stats.set(s.playerId, { ...s, week });
        for (const s of now) rec.stats.set(s.playerId, s);
      }
    } catch (e) { rec.error = e?.message || String(e); }
    rec.ready = true; refreshScreen();
  })();
  return rec;
}
function dashboardHTML(r, all, club, today) {
  const as = r.as, bar = pct => `<div class="dash-bar"><i class="${pct >= 1 ? '' : pct > 0 ? 'part' : 'none'}" style="width:${Math.round(pct * 100)}%"></i></div>`;
  const items = [...all].sort(byCalendar);
  const focus = items.length ? calendarFocus(items, today) : null;
  const practices = items.filter(x => x.kind !== 'game'), games = items.filter(x => x.kind === 'game');
  const past = practices.filter(x => (x.date || '') < today), upcoming = items.filter(x => (x.date || '') >= today && x !== focus);
  const minutes = past.reduce((a, x) => a + (+x.minutes || 0), 0);
  const kindWord = x => x.kind === 'game' ? 'game' : x.surface === 'dryland' ? 'dryland' : 'practice';
  const hero = focus ? `<a class="pl-item pl-hero" href="${itemPath(as, focus)}" data-nav>
      <small>${focus.date === today ? 'Today’s' : (focus.date || '') > today ? 'Next' : 'Last'} ${kindWord(focus)}${focus.stage === 'draft' ? ' · draft, not sent out yet' : ''}</small>
      <b>${escHtml(focus.kind === 'game' ? docTitle(focus) : whenLabel(focus, true))}</b>
      <span>${focus.kind === 'game' ? escHtml(whenLabel(focus, true)) : `${focus.drillCount || 0} drill${focus.drillCount === 1 ? '' : 's'}${focus.minutes ? ` · ${focus.minutes} min` : ''}`}</span>
      <em>Open ▶</em></a>` : '<p class="muted">Nothing released to this team yet.</p>';
  const cards = `<div class="dash-grid">
      <div class="dash-card"><b>${past.length}</b><span>practice${past.length === 1 ? '' : 's'} so far</span></div>
      <div class="dash-card"><b>${practices.length - past.length}</b><span>practice${practices.length - past.length === 1 ? '' : 's'} coming up</span></div>
      <div class="dash-card"><b>${games.length}</b><span>game${games.length === 1 ? '' : 's'} with notes</span></div>
      <div class="dash-card"><b>${minutes >= 120 ? `${Math.round(minutes / 60 * 10) / 10} h` : `${minutes} min`}</b><span>of drills run</span></div>
    </div>`;
  // This week's tasks across the team.
  let tasks = '';
  if (club) {
    const week = weekKey(), rec = loadDashboard(club.id, week);
    const players = Object.entries(rec.players).map(([id, p]) => ({ id, name: p.name || 'Player' })).sort((a, b) => a.name.localeCompare(b.name));
    const stat = id => rec.stats.get(id) || { values: {}, done: {} };
    const overall = id => rec.tasks.length ? rec.tasks.reduce((a, k) => a + progressOf(k, stat(id)), 0) / rec.tasks.length : 0;
    const logged = players.filter(p => rec.stats.has(p.id)).length;
    const teamPct = players.length ? players.reduce((a, p) => a + overall(p.id), 0) / players.length : 0;
    let body;
    if (!rec.ready) body = '<p class="muted">Loading the week…</p>';
    else if (rec.error) body = `<p class="warn">Could not load the week: ${escHtml(rec.error)}</p>`;
    else if (!rec.tasks.length) body = '<p class="muted">No task list set for this week.</p>';
    else body = `<div class="dash-row"><b>Whole team</b><span class="pct">${Math.round(teamPct * 100)}%</span><span class="m">${logged} of ${players.length} player${players.length === 1 ? '' : 's'} logged something</span>${bar(teamPct)}</div>
      ${rec.tasks.map(k => { const pct = players.length ? players.reduce((a, p) => a + progressOf(k, stat(p.id)), 0) / players.length : 0; const n = players.filter(p => progressOf(k, stat(p.id)) > 0).length;
        return `<div class="dash-row"><b>${escHtml(k.title)}</b><span class="pct">${Math.round(pct * 100)}%</span><span class="m">${escHtml(goalText(k))} · ${n} of ${players.length} started</span>${bar(pct)}</div>`; }).join('')}
      <h2>By player</h2>
      ${players.map(p => { const pct = overall(p.id); return `<div class="dash-row"><b>${escHtml(p.name)}</b><span class="pct">${rec.stats.has(p.id) ? `${Math.round(pct * 100)}%` : '—'}</span>${bar(pct)}</div>`; }).join('') || '<p class="muted">No players on the roster yet.</p>'}`;
    tasks = `<h2>This week’s tasks</h2><p class="muted small">${escHtml(weekLabel(week))}</p><div class="dash-box">${body}</div>
      <a class="dash-link" href="${routePath({ view: as, teamId: r.teamId, tab: 'tasks' })}" data-nav>Full weekly output →</a>`;
  }
  const row = x => `<a class="pl-item" href="${itemPath(as, x)}" data-nav><b>${escHtml(docTitle(x))}</b><span>${escHtml(whenLabel(x, true))}</span>${draftBadge(x)}${x.date === today ? '<span class="pl-today">today</span>' : ''}</a>`;
  const next = upcoming.length ? `<h2>Up next</h2>${upcoming.slice(0, 3).map(row).join('')}` : '';
  const more = `<a class="dash-link" href="${routePath({ view: as, teamId: r.teamId, tab: 'practice' })}" data-nav>All practices →</a>${games.length ? ` · <a class="dash-link" href="${routePath({ view: as, teamId: r.teamId, tab: 'games' })}" data-nav>Game notes →</a>` : ''}`;
  return `${hero}${cards}${tasks}${next}<p>${more}</p>`;
}
/**
 * The Tasks tab: a family logs their player's week right here; a coach gets the team's weekly output. A coach who is
 * also a parent gets their own skater on the team view (/team) and the whole team on the coach view (/coach).
 */
function renderTasksTab(club, as) {
  const body = $('#present-body');
  if (!club) { body.innerHTML = '<div class="pl-list" id="tasks-tab"><p class="muted">Weekly tasks aren’t set up for this team.</p></div>'; return; }
  const players = club.players || [];
  const family = club.role !== 'coach' || (as === 'team' && players.length > 0);
  const chips = family && players.length > 1 ? `<div class="tab-players">${players.map((pl, i) => `<button class="chip${i === 0 ? ' active' : ''}" data-tab-player="${escHtml(pl.id)}">${escHtml(pl.name || 'Player')}</button>`).join('')}</div>` : '';
  body.innerHTML = `<div class="pl-list" id="tasks-tab">${chips}<div id="tasks-mount" class="club-body"></div></div>`;
  const mount = $('#tasks-mount');
  if (!family) openClubOutput(club.id, { mount });
  else if (players.length) openProfile(club.id, players[0].id, { mount });
  else mount.innerHTML = '<p class="muted">None of your players is on this team’s roster yet.</p>';
}
$('#present-body').addEventListener('click', e => {
  const out = e.target.closest('[data-club-output]'); if (out) { openClubOutput(out.dataset.clubOutput, { mount: $('#present-club-body'), sheet: true }); return; }
  const pl = e.target.closest('[data-club-player]'); if (pl) { const [teamId, playerId] = pl.dataset.clubPlayer.split(':'); openProfile(teamId, playerId); return; }
  const chip = e.target.closest('[data-tab-player]'); if (chip) { $$('.tab-players .chip').forEach(x => x.classList.toggle('active', x === chip)); openProfile(screen.teamId, chip.dataset.tabPlayer, { mount: $('#tasks-mount') }); return; }
  const a = e.target.closest('a[data-nav]'); if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault(); navigate(a.getAttribute('href'));
});

// ---------- official club teams: weekly tasks, a player's profile (their family logs the week), the team's weekly output ----------
// Data: club/{teamId} (tasks + lookups, written by the planner's roster sync) and club/{teamId}/stats/{playerId_week}
// ({ playerId, week, values: { taskId: n }, by, updatedAt }). Weeks are ISO weeks, Monday to Sunday.
/** The club teams this person has a part in: for the planner every club team as a coach; for others from their list document. */
function clubsFor() {
  // The planner is a coach of every club team; `players` are their own skaters there (the roster's contacts name them), as for anyone else.
  if (who.persona === 'planner') return (store.roster.teams || []).filter(t => t.club).map(t => ({ id: t.id, name: t.name || '', role: 'coach', players: (t.players || []).filter(pl => pl.id && (pl.contacts || []).some(k => String(k.email || '').trim().toLowerCase() === myEmail())).map(pl => ({ id: pl.id, name: pl.name || '' })) }));
  return Object.entries(viewerInbox?.teams || {}).filter(([, t]) => t.club).map(([id, t]) => ({ id, name: t.name || '', role: t.role === 'coach' ? 'coach' : 'family', players: t.players || [] }));
}
const clubRole = teamId => who.persona === 'planner' ? 'coach' : ((who.teams || []).find(t => t.id === teamId)?.role === 'coach' ? 'coach' : 'family');
const clubState = { teamId: null, doc: null, week: weekKey(), stats: new Map(), player: null, mount: null, busy: '' };
const weekLabel = w => { const s = weekStart(w); if (!s) return w; const e = new Date(s); e.setDate(e.getDate() + 6); const f = d => `${d.getMonth() + 1}/${d.getDate()}`; return `${w === weekKey() ? 'This week · ' : ''}${f(s)}–${f(e)}`; };
const myEmail = () => String(cloudSync?.user?.email || '').toLowerCase();
/** The club document: the planner's own roster is the truth; everyone else reads club/{teamId}. */
async function loadClubDoc(teamId) {
  if (who.persona === 'planner') { const t = (store.roster.teams || []).find(x => x.id === teamId); return clubDoc(t); }
  if (!cloudBackend?.loadTeam) return null;
  try { // the team and its players; each week's task list is fetched as that week comes on screen (loadWeekTasks)
    const [team, players] = await Promise.all([cloudBackend.loadTeam(teamId), cloudBackend.loadPlayers(teamId)]);
    if (!team) return null;
    return { id: teamId, name: team.name || '', club: !!team.club, players, weeks: {} };
  } catch { return null; }
}
const loadingWeeks = new Set();
/** A viewer's task list for one week, fetched once and kept on the club document. */
function loadWeekTasks(week) {
  const d = clubState.doc; if (!d || who.persona === 'planner' || week in (d.weeks || {}) || loadingWeeks.has(`${clubState.teamId}/${week}`)) return;
  loadingWeeks.add(`${clubState.teamId}/${week}`);
  cloudBackend.loadTasks(clubState.teamId, week).then(doc => { d.weeks[week] = doc?.tasks || []; }).catch(() => { d.weeks[week] = []; })
    .finally(() => { loadingWeeks.delete(`${clubState.teamId}/${week}`); if (clubState.doc === d) renderClub(); });
}
async function openClubOutput(teamId, { mount, sheet = false, week = weekKey(), navless = false }) {
  if (week > weekKey()) week = weekKey(); // never a week ahead: there is nothing logged to show
  clubState.teamId = teamId; clubState.player = null; clubState.week = week; clubState.stats = new Map(); clubState.busy = 'Loading…'; clubState.navless = navless;
  clubState.mount = mount;
  if (sheet) $('#present-club').hidden = false;
  renderClub();
  clubState.doc = await loadClubDoc(teamId);
  if (!clubState.doc) { clubState.busy = '✗ Could not load this club team — are the latest firestore.rules deployed?'; renderClub(); return; }
  await loadClubWeek();
}
async function openProfile(teamId, playerId, { mount = $('#present-club-body'), sheet = mount === $('#present-club-body') } = {}) {
  clubState.teamId = teamId; clubState.player = playerId; clubState.week = weekKey(); clubState.stats = new Map(); clubState.busy = 'Loading…'; clubState.undo = [];
  clubState.mount = mount; if (sheet) $('#present-club').hidden = false;
  renderClub();
  clubState.doc = await loadClubDoc(teamId);
  if (!clubState.doc) { clubState.busy = '✗ Could not load this club team.'; renderClub(); return; }
  if (!cloudBackend?.loadPlayerStats || !cloudSync?.user) { clubState.busy = '✗ Sign in to see and log the numbers.'; renderClub(); return; }
  try {
    const all = await cloudBackend.loadPlayerStats(teamId, playerId);
    for (const s of all) if (/W/.test(s.week)) clubState.stats.set(`${s.playerId}_${normalWeek(s.week)}`, { ...s, week: normalWeek(s.week) }); // old Monday-week keys first…
    for (const s of all) if (!/W/.test(s.week)) clubState.stats.set(`${s.playerId}_${s.week}`, s); // …then the current form, which wins
    clubState.busy = '';
  }
  catch (e) { clubState.busy = `✗ Could not load the numbers: ${e?.message || e}`; }
  renderClub();
}
async function loadClubWeek() {
  clubState.busy = 'Loading…'; renderClub();
  if (!cloudBackend?.loadWeekStats || !cloudSync?.user) { clubState.busy = '✗ Sign in to see the numbers — they live in the cloud.'; renderClub(); return; }
  try {
    // Numbers logged in the Monday-week days sit under the old key for the same week: read both, the new key winning.
    const [now, old] = await Promise.all([cloudBackend.loadWeekStats(clubState.teamId, clubState.week), cloudBackend.loadWeekStats(clubState.teamId, legacyWeek(clubState.week)).catch(() => [])]);
    for (const s of old) clubState.stats.set(`${s.playerId}_${clubState.week}`, { ...s, week: clubState.week });
    for (const s of now) clubState.stats.set(`${s.playerId}_${s.week}`, s);
    clubState.busy = '';
  }
  catch (e) { clubState.busy = `✗ Could not load the numbers: ${e?.message || e}`; }
  renderClub();
}
const statFor = (playerId, week) => clubState.stats.get(`${playerId}_${week}`) || { playerId, week, values: {}, done: {} };
const unitName = k => TASK_UNITS[k.unit] || k.unit;
/** "25 shots × 3 a week" / "60 minutes a week" / "minutes". */
const goalText = k => k.target ? (k.times > 1 ? `${k.target} ${unitName(k)} × ${k.times} a week` : `${k.target} ${unitName(k)} a week`) : unitName(k);
/** Progress toward the week: sessions done out of `times` when the task repeats, else the amount against the target. */
function progressOf(k, s) {
  const total = +s.values?.[k.id] || 0, sessions = +s.done?.[k.id] || 0;
  if (k.times > 1) return Math.max(Math.min(1, sessions / k.times), k.target ? Math.min(1, total / (k.target * k.times)) : 0);
  return k.target ? Math.min(1, total / k.target) : 0;
}
/** Write one number — the week's total amount (`values`) or sessions done (`done`) for a task: the stat document for that player and week is rewritten whole, signed by this account. */
/** The tap sizes for a task: a small step and one full session (e.g. +5 and +25 shots); a "times" task counts one at a time. */
function taskSteps(k) {
  if (k.unit === 'times' || !k.target) return [1];
  const t = +k.target, small = t >= 40 ? 10 : t >= 10 ? 5 : t >= 4 ? Math.max(1, Math.round(t / 4)) : 1; // 25 shots → +5 / +25; 10 minutes → +5 / +10; 60 reps → +10 / +60
  return t > small ? [small, t] : [small];
}
/**
 * A stat document: { playerId, week, days: { [0-6]: { taskId: amount } }, base?: { taskId: amount }, values, done, by, updatedAt }.
 * `days` is what the family taps in day by day; `base` holds what was logged before day-by-day tracking (or a total a
 * coach typed in); `values` (the total) and `done` (days with something logged) are kept in step for the output table
 * and the dashboard, which read only those.
 */
function withTotals(doc, taskIds) {
  const values = {}, done = {};
  for (const t of new Set([...taskIds, ...Object.keys(doc.base || {}), ...Object.values(doc.days || {}).flatMap(Object.keys)])) {
    const perDay = Object.values(doc.days || {}).map(dd => +dd[t] || 0);
    const v = (+doc.base?.[t] || 0) + perDay.reduce((a, b) => a + b, 0), n = (+doc.baseDone?.[t] || 0) + perDay.filter(Boolean).length;
    if (v) values[t] = v; if (n) done[t] = n;
  }
  return { ...doc, values, done };
}
const statSaves = new Map(); // playerId_week → timer: taps come in bursts; one write per burst
async function saveStatSoon(next) {
  const key = `${next.playerId}_${next.week}`;
  clubState.stats.set(key, next);
  clearTimeout(statSaves.get(key));
  statSaves.set(key, setTimeout(async () => {
    statSaves.delete(key);
    try { await cloudBackend.saveStat(clubState.teamId, next); clubState.busy = `✓ Saved ${stamp(next.updatedAt)}`; }
    catch (e) { clubState.busy = `✗ Not saved: ${e?.message || e}${/permission/i.test(e?.message || '') ? ' — only this player\'s family or a coach may log their numbers' : ''}`; }
    const el = clubState.mount?.querySelector('.club-note'); if (el) { el.textContent = clubState.busy; el.classList.toggle('warn', /✗/.test(clubState.busy)); }
  }, 600));
}
const LOG_WINDOW_DAYS = 3; // a day can be logged for this many days after it — then it locks, so a week is filled in as it happens, not reconstructed later
/** A tap on the grid: `delta` to one task on one day of the week. */
function logDay(playerId, taskId, day, delta) {
  const dt = weekStart(clubState.week); dt.setDate(dt.getDate() + day);
  const key = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`, d0 = new Date(Date.now() - LOG_WINDOW_DAYS * 86400000);
  if (key > todayISO() || key < `${d0.getFullYear()}-${pad2(d0.getMonth() + 1)}-${pad2(d0.getDate())}`) return; // never a day that hasn't come, nor one that has locked — whatever the screen showed
  const cur = statFor(playerId, clubState.week);
  (clubState.undo ||= []).push({ playerId, week: clubState.week, doc: cur }); if (clubState.undo.length > 30) clubState.undo.shift(); // ↶ Undo puts this back
  const doc = { playerId, week: clubState.week, days: JSON.parse(JSON.stringify(cur.days || {})), by: myEmail(), updatedAt: Date.now() };
  if (cur.base) doc.base = { ...cur.base }; if (cur.baseDone) doc.baseDone = { ...cur.baseDone };
  if (!cur.days && (cur.values || cur.done)) { doc.base = { ...(cur.values || {}) }; doc.baseDone = { ...(cur.done || {}) }; } // what was logged before day-by-day tracking stays counted
  const dd = doc.days[day] = { ...(doc.days[day] || {}) };
  const v = Math.max(0, (+dd[taskId] || 0) + delta); if (v) dd[taskId] = v; else delete dd[taskId];
  if (!Object.keys(dd).length) delete doc.days[day];
  saveStatSoon(withTotals(doc, tasksForWeek(clubState.doc, clubState.week).map(k => k.id)));
  renderClub();
}
/** ↶ Undo: the week as it was before the last tap (any number of taps back, newest first). */
function undoDay() {
  const last = clubState.undo?.pop(); if (!last) return;
  if (last.week !== clubState.week || last.playerId !== clubState.player) { clubState.undo = []; renderClub(); return; } // a different week on screen now: nothing to undo here
  const doc = { ...last.doc, playerId: last.playerId, week: last.week, by: myEmail(), updatedAt: Date.now() };
  saveStatSoon(withTotals(doc, tasksForWeek(clubState.doc, clubState.week).map(k => k.id)));
  renderClub();
}
/** A total typed in (the coaches' output table): the days stay as they are; `base` takes up the difference. */
async function logStat(playerId, taskId, value, kind = 'total') {
  const cur = statFor(playerId, clubState.week);
  const doc = { playerId, week: clubState.week, days: cur.days || {}, base: { ...(cur.base || {}) }, baseDone: { ...(cur.baseDone || {}) }, by: myEmail(), updatedAt: Date.now() };
  const perDay = Object.values(doc.days).map(dd => +dd[taskId] || 0);
  const want = Number.isFinite(+value) && value !== '' ? Math.max(0, Math.round(+value)) : 0;
  if (kind === 'done') doc.baseDone[taskId] = Math.max(0, want - perDay.filter(Boolean).length); else doc.base[taskId] = Math.max(0, want - perDay.reduce((a, b) => a + b, 0));
  const next = withTotals(doc, tasksForWeek(clubState.doc, clubState.week).map(k => k.id));
  clubState.stats.set(`${playerId}_${clubState.week}`, next);
  try { await cloudBackend.saveStat(clubState.teamId, next); clubState.busy = `✓ Saved ${stamp(next.updatedAt)}`; }
  catch (e) { clubState.busy = `✗ Not saved: ${e?.message || e}${/permission/i.test(e?.message || '') ? ' — only this player\'s family or a coach may log their numbers' : ''}`; }
  const el = clubState.mount?.querySelector('.club-note'); if (el) { el.textContent = clubState.busy; el.classList.toggle('warn', /✗/.test(clubState.busy)); }
  renderClub({ keepFocus: true });
}
function renderClub({ keepFocus = false } = {}) {
  const m = clubState.mount; if (!m) return;
  if (keepFocus && m.contains(document.activeElement)) return; // typing: the numbers are already in state; repaint when the field blurs
  const d = clubState.doc, week = clubState.week;
  const nav = clubState.navless ? '' : `<div class="club-week"><button data-club="prev" title="Earlier week">◀</button><span>${escHtml(weekLabel(week))}</span><button data-club="next" title="Later week" ${week >= weekKey() ? 'disabled' : ''}>▶</button>${week !== weekKey() ? '<button data-club="now" class="club-now" title="Back to the current week">This week</button>' : ''}</div>`;
  const note = `<div class="club-note muted small${/✗/.test(clubState.busy) ? ' warn' : ''}">${escHtml(clubState.busy)}</div>`;
  if (!d) { m.innerHTML = `<div class="club-head"><h3>Club</h3></div>${note}`; return; }
  if (who.persona !== 'planner' && !(week in (d.weeks || {}))) loadWeekTasks(week);
  const tasks = tasksForWeek(d, week); // each week has its own list; an unset week is empty
  if (clubState.player) { // one player's profile: the week as a grid — days down, tasks across, a tap per rep logged
    const pl = d.players?.[clubState.player] || { name: 'Player' };
    const s = statFor(clubState.player, week);
    const ws = weekStart(week), todayKey = todayISO(), dayDate = i => { const x = new Date(ws); x.setDate(x.getDate() + i); return x; };
    const iso = x => `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
    const openKey = iso(new Date(Date.now() - LOG_WINDOW_DAYS * 86400000)); // the earliest day still open to log
    const howto = k => `${k.audio ? `<button class="wp-toggle" data-howto="audio" data-task="${k.id}">${clubState.playing?.taskId === k.id ? '■ Stop' : '🎙 Listen'}</button>` : ''}${k.video ? `<button class="wp-toggle" data-howto="video" data-task="${k.id}">🎬 Watch</button>` : ''}${!k.video && k.videoUrl && videoEmbed(k.videoUrl) ? `<button class="wp-toggle" data-howto="link" data-task="${k.id}">🎬 Watch</button>` : ''}`;
    const head = tasks.map(k => `<th><b>${escHtml(k.title)}</b><span>${escHtml(goalText(k))}</span>${howto(k) ? `<div class="club-howto">${howto(k)}</div>` : ''}<div class="club-howto-box" data-task-box="${k.id}"></div></th>`).join('');
    const rows = [0, 1, 2, 3, 4, 5, 6].map(i => {
      const dt = dayDate(i), key = iso(dt), today = key === todayKey, future = key > todayKey, locked = key < openKey;
      const cells = tasks.map(k => {
        const amt = +s.days?.[i]?.[k.id] || 0, st = taskSteps(k);
        const btn = (inc, label) => `<button data-inc="${inc}" data-task="${k.id}" data-day="${i}" ${inc < 0 && !amt ? 'disabled' : ''}>${label}</button>`;
        if (future) return `<td class="dcell"><div class="dval none" title="Not yet — a day can be logged once it comes">—</div></td>`; // nothing to tap on a day that hasn't come
        if (locked) return `<td class="dcell"><div class="dval${amt ? '' : ' none'}" title="Locked — a day can be logged for ${LOG_WINDOW_DAYS} days">${amt || '·'}</div><div class="dlock">🔒</div></td>`; // too long ago: what was logged stands
        return `<td class="dcell"><div class="dval${amt ? '' : ' none'}">${amt || '·'}</div><div class="dbtns">${btn(-st[0], '−')}${st.map(v => btn(v, `+${v}`)).join('')}</div></td>`;
      }).join('');
      return `<tr class="${today ? 'today' : future ? 'future' : locked ? 'locked' : ''}"><th><b>${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]}</b><span>${dt.getMonth() + 1}/${dt.getDate()}</span>${today ? '<em>today</em>' : ''}</th>${cells}</tr>`;
    }).join('');
    const earlier = tasks.some(k => +s.base?.[k.id] > 0) ? `<tr class="earlier"><th><b>Earlier</b><span>before day by day</span></th>${tasks.map(k => `<td class="dcell"><div class="dval${+s.base?.[k.id] ? '' : ' none'}">${+s.base?.[k.id] || '·'}</div></td>`).join('')}</tr>` : '';
    const totals = tasks.map(k => { const v = +s.values?.[k.id] || 0, n = +s.done?.[k.id] || 0, pct = progressOf(k, s);
      return `<td class="dcell total"><b>${v}</b>${k.target ? `<span>/ ${k.target * (k.times || 1)} ${unitName(k)}</span>` : ''}${k.times > 1 ? `<span>${n} of ${k.times} days</span>` : ''}${k.target || k.times > 1 ? `<div class="club-bar"><i class="${pct >= 1 ? '' : 'part'}" style="width:${(pct * 100).toFixed(0)}%"></i></div>` : ''}</td>`; }).join('');
    const weeks = [...new Set([week, ...[...clubState.stats.values()].map(x => x.week)])].sort().reverse().slice(0, 8);
    if (who.persona !== 'planner') for (const w of weeks) if (!(w in (d.weeks || {}))) loadWeekTasks(w);
    const hist = weeks.length > 1 ? `<div class="club-hist"><h3 class="small muted">Recent weeks</h3>${weeks.filter(w => w !== week).map(w => { const st = statFor(clubState.player, w), wt = tasksForWeek(d, w); return `<div class="club-hist-week"><b>${escHtml(weekLabel(w).replace('This week · ', ''))}</b> ${wt.length ? wt.map(k => `<span>${escHtml(k.title)}: ${k.times > 1 ? `${st.done?.[k.id] ?? '·'}/${k.times}× · ` : ''}${st.values?.[k.id] ?? '·'}${k.target ? `/${k.target * (k.times || 1)}` : ''}</span>`).join(' ') : '<span class="muted">no tasks</span>'}</div>`; }).join('')}</div>` : '';
    m.innerHTML = `<div class="club-head"><h3>🏒 ${escHtml(pl.name || 'Player')} <span class="muted small">· ${escHtml(d.name)}</span></h3>${nav}<button data-club="close" title="Close">✕</button></div>
      ${tasks.length ? `<div class="club-grid-wrap"><table class="club-grid"><thead><tr><th></th>${head}</tr></thead><tbody>${earlier}${rows}<tr class="week"><th><b>Week</b></th>${totals}</tr></tbody></table></div>` : '<p class="muted">No tasks set for this week.</p>'}${note}
      <p class="muted small club-undo-row"><button data-club="undo" ${clubState.undo?.length ? '' : 'disabled'} title="Put back what the last tap changed">↶ Undo last tap</button> Tap + on the day it happened — each tap is saved. A day stays open for ${LOG_WINDOW_DAYS} days, then locks 🔒. The week row adds the days up and fills toward the goal.</p>${hist}`;
    return;
  }
  // the whole team: players down, tasks across; coaches and the planner may type in a number for anyone
  const players = Object.entries(d.players || {}).map(([id, p]) => ({ id, name: p.name || 'Player' })).sort((a, b) => a.name.localeCompare(b.name));
  const mayLog = clubRole(clubState.teamId) === 'coach';
  const cell = (pl, k) => {
    const s = statFor(pl.id, week), v = s.values?.[k.id], n = s.done?.[k.id], met = progressOf(k, s) >= 1;
    const box = (kind, val, ph) => mayLog ? `<input type="number" min="0" step="1" inputmode="numeric" data-log="${k.id}" data-kind="${kind}" data-player="${pl.id}" value="${val ?? ''}" placeholder="${ph}">` : `<b>${val ?? '·'}</b>`;
    return `<td class="num">${k.times > 1 ? `${box('done', n, '×')}<span class="muted small">/${k.times}×</span> ` : ''}${box('total', v, '·')}${k.target ? `<span class="muted small">/${k.target * (k.times || 1)}${met ? ' ✓' : ''}</span>` : ''}</td>`;
  };
  const total = pl => { const s = statFor(pl.id, week); const t = tasks.filter(k => k.target || k.times > 1); if (!t.length) return ''; const pct = t.reduce((a, k) => a + progressOf(k, s), 0) / t.length; return `<td class="num">${(pct * 100).toFixed(0)}%<div class="club-bar"><i class="${pct >= 1 ? '' : 'part'}" style="width:${(pct * 100).toFixed(0)}%"></i></div></td>`; };
  m.innerHTML = `${clubState.navless ? '' : `<div class="club-head"><h3>📊 ${escHtml(d.name)} <span class="muted small">· weekly output</span></h3>${nav}${clubState.mount === $('#present-club-body') ? '<button data-club="close" title="Close">✕</button>' : ''}</div>`}
    ${tasks.length && players.length ? `<table class="club-table"><thead><tr><th>Player</th>${tasks.map(k => `<th class="num">${escHtml(k.title)}<br><span class="muted">${escHtml(goalText(k))}</span></th>`).join('')}${tasks.some(k => k.target) ? '<th class="num">Week</th>' : ''}</tr></thead><tbody>${players.map(pl => `<tr><td>${escHtml(pl.name)}</td>${tasks.map(k => cell(pl, k)).join('')}${total(pl)}</tr>`).join('')}</tbody></table>` : `<p class="muted">${tasks.length ? 'No players on the roster yet.' : 'No task list for this week — set one up on the team\'s calendar under 👥 Team.'}</p>`}
    ${note}<p class="muted small">${mayLog ? 'Families log their own player\'s numbers from their practice list; you can type a number in for anyone — it saves when you leave the field.' : 'Numbers come from each player\'s family, logged from their practice list.'}</p>`;
}
/** A task's how-to from the profile: play the clip (tap again to stop), or open the video under the task. */
async function playTaskHowto(kind, taskId) {
  const k = (clubState.doc?.tasks || []).find(x => x.id === taskId); if (!k) return;
  const box = clubState.mount?.querySelector(`[data-task-box="${taskId}"]`);
  if (kind === 'audio') {
    if (clubState.playing) { const was = clubState.playing.taskId; clubState.playing.stop(); if (was === taskId) return; }
    const entry = await fetchTaskAudio(clubState.teamId, k); if (!entry) { if (box) box.innerHTML = '<span class="warn small">Could not load the recording.</span>'; return; }
    clubState.playing = playClip(entry, { onEnd: () => { clubState.playing = null; renderClub(); } }); clubState.playing.taskId = taskId; renderClub();
    return;
  }
  if (!box) return;
  if (box.firstChild) { box.innerHTML = ''; return; } // tap again: close it
  if (kind === 'link') { box.innerHTML = videoPlayerHTML(videoEmbed(k.videoUrl)); return; }
  box.innerHTML = '<span class="muted small">Loading…</span>';
  const entry = await fetchTaskVideo(clubState.teamId, k, (i, n) => { box.textContent = `Downloading ${i} / ${n}…`; });
  box.innerHTML = entry ? `<div class="video-box"><video src="${entry.url}" controls playsinline autoplay></video></div>` : '<span class="warn small">Could not load the video.</span>';
}
for (const sel of ['#tasks-output', '#present-club-body', '#present-body']) { // the editor's Tasks panel, the viewer's sheet, and the team home's Tasks tab
  $(sel).addEventListener('click', e => {
    const h = e.target.closest('[data-howto]'); if (h) { playTaskHowto(h.dataset.howto, h.dataset.task); return; }
    const inc = e.target.closest('[data-inc]'); if (inc) { if (!inc.disabled) logDay(clubState.player, inc.dataset.task, +inc.dataset.day, +inc.dataset.inc); return; }
    const b = e.target.closest('[data-club]'); if (!b) return;
    if (b.dataset.club === 'close') { $('#present-club').hidden = true; clubState.playing?.stop(); return; }
    if (b.dataset.club === 'undo') { undoDay(); return; }
    clubState.week = b.dataset.club === 'now' ? weekKey() : shiftWeek(clubState.week, b.dataset.club === 'prev' ? -1 : 1); clubState.undo = [];
    if (clubState.player) renderClub(); else loadClubWeek();
  });
  $(sel).addEventListener('change', e => {
    const el = e.target; if (!el.matches('[data-log]')) return;
    logStat(el.dataset.player || clubState.player, el.dataset.log, el.value, el.dataset.kind || 'total');
  });
}
$('#present-club').addEventListener('click', e => { if (e.target === e.currentTarget) { $('#present-club').hidden = true; clubState.playing?.stop(); } });
$('#present-home').addEventListener('click', () => { // this team's list; on several teams with no team in hand, the chooser
  if (!['coach', 'team', 'planner'].includes(who.persona) || !screen.as) return;
  const view = screen.as === 'coach' ? 'coach' : 'team';
  navigate(routePath({ view, teamId: screen.screen === 'teams' ? null : (screen.teamId || presentPractice?.teamId || null) }));
});

// ---------- request access: someone signed in who is on no roster ----------
let myRequest;           // undefined = not loaded; null = none filed; else the requests/{uid} document
let myRequestFor = null;
let attemptLogged = null; // uid whose failed sign-in this session already recorded
// ---------- the team's Questions tab: one shared page — a parent taps their player and answers for them ----------
let qtSkater = null; // which of the viewer's own skaters the team Questions tab is showing
async function renderQuestionsTab(r, key) {
  const body = $('#present-body');
  body.innerHTML = '<div class="pl-list"><p class="muted">Loading the survey…</p></div>';
  let polls = [];
  try { polls = await cloudBackend.loadTeamPolls(r.teamId); }
  catch (e) { if (listKey === key) body.innerHTML = `<div class="pl-list"><p class="warn">Could not load the survey: ${escHtml(e?.message || String(e))}</p></div>`; return; }
  if (listKey !== key) return; // navigated away while loading
  polls.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  // The team link shows a family their own skater(s); the coach link shows the whole sheet, any player answerable.
  const myEmail = String(cloudSync?.user?.email || '').toLowerCase();
  let mine = [];
  if (who.persona === 'planner') {
    const t = (store.roster.teams || []).find(x => x.id === r.teamId);
    mine = (t?.players || []).filter(pl => pl.id && (pl.contacts || []).some(c => String(c.email || '').toLowerCase() === myEmail)).map(pl => ({ id: pl.id, name: pl.name || '' }));
  } else mine = ((who.teams || []).find(t => t.id === r.teamId)?.players || []).filter(pl => pl.id);
  const parentView = r.as === 'team' && mine.length > 0;
  // current answers — a family fetches only its own skaters', the coach sheet everyone's
  const answers = {};
  await Promise.all(polls.flatMap(poll => (poll.players || []).filter(pl => !parentView || mine.some(x => x.id === pl.id)).map(async pl => {
    try { answers[`${poll.id}/${pl.token}`] = await cloudBackend.loadPollAnswer(poll.id, pl.token); } catch { /* unanswered */ }
  })));
  if (listKey !== key) return;
  const when = poll => usDate(new Date(poll.createdAt || 0).toISOString().slice(0, 10));
  const tile = (poll, pl) => {
    const a = answers[`${poll.id}/${pl.token}`];
    return `<a class="qt-player${a?.choice ? ' answered' : ''}" href="${routePath({ view: 'ask', pollId: poll.id, token: pl.token })}" data-nav>
            <b>${escHtml(pl.name)}</b><span>${escHtml(a?.choice || 'not answered')}</span></a>`;
  };
  const paint = () => {
    if (listKey !== key) return;
    if (parentView && !mine.some(x => x.id === qtSkater)) qtSkater = mine[0].id;
    const skater = parentView ? mine.find(x => x.id === qtSkater) : null;
    const card = poll => parentView ? `
      <div class="qt-poll">
        <div class="qt-q"><b>${escHtml(poll.question)}</b><span class="muted small">${when(poll)}</span></div>
        ${(() => { const pl = (poll.players || []).find(x => x.id === qtSkater);
          return pl ? `<div class="qt-sub muted small">Tap to answer for ${escHtml(pl.name)} — you can change it any time.</div><div class="qt-grid">${tile(poll, pl)}</div>`
            : `<p class="muted small">This question doesn’t include ${escHtml(skater?.name || 'your skater')}.</p>`; })()}
      </div>` : `
      <div class="qt-poll">
        <div class="qt-q"><b>${escHtml(poll.question)}</b><span class="muted small">${when(poll)}</span></div>
        <div class="qt-sub muted small">Tap a player to see or change their answer.</div>
        <div class="qt-grid">${(poll.players || []).map(pl => tile(poll, pl)).join('')}</div>
      </div>`;
    body.innerHTML = `<div class="pl-list">
      <h2>Survey</h2>
      ${parentView && mine.length > 1 ? `<div class="qt-switch">${mine.map(x => `<button class="qt-sk${x.id === qtSkater ? ' on' : ''}" data-skater="${x.id}">${escHtml(x.name)}</button>`).join('')}</div>` : ''}
      ${polls.length ? polls.map(card).join('') : '<p class="muted">No survey questions right now.</p>'}
    </div>`;
    for (const b of body.querySelectorAll('[data-skater]')) b.addEventListener('click', () => { qtSkater = b.dataset.skater; paint(); });
  };
  paint();
}

// ---------- a player's personal answer page (/ask/{pollId}/{token}) ----------
let askState = null; // { pollId, token, poll, answer, pending, loading, anonTried }
async function showAsk(r) {
  $('#present-title').textContent = '';
  $('#present-gate').hidden = true; // the answer page is its own gate
  const scr = $('#ask-screen');
  scr.hidden = false;
  if (!askState || askState.pollId !== r.pollId || askState.token !== r.token) {
    askState = { pollId: r.pollId, token: r.token, poll: null, answer: null, pending: null, loading: false, anonTried: false };
  }
  const a = askState;
  const card = html => { scr.innerHTML = `<div class="ask-card">${html}</div>`; };
  const u = cloudSync?.user;
  if (!cloudBackend) { card('<p>This link needs a connection — try again online.</p>'); return; }
  if (!u) {
    if (!a.anonTried && cloudSync?.signInAnon) { // no account needed: slip in as a guest
      a.anonTried = true;
      card('<p class="muted">One moment…</p>');
      cloudSync.signInAnon().catch(() => card('<p>Could not open the question. Reload to try again.</p>'));
      return;
    }
    card('<p class="muted">One moment…</p>');
    return;
  }
  if (!a.poll && !a.loading) {
    a.loading = true;
    card('<p class="muted">Loading…</p>');
    try {
      const [poll, answer] = await Promise.all([cloudBackend.loadPoll(a.pollId), cloudBackend.loadPollAnswer(a.pollId, a.token)]);
      a.loading = false;
      if (!poll || !answer) { card('<p>This question is no longer open — ask your coach for a fresh link.</p>'); return; }
      a.poll = poll; a.answer = answer; a.pending = answer.choice || null;
    } catch (e) { a.loading = false; card(`<p>Could not load the question: ${escHtml(e?.message || String(e))}</p>`); return; }
  }
  if (a.poll) renderAsk();
}

function renderAsk(status = '') {
  const a = askState;
  $('#ask-screen').innerHTML = `<div class="ask-card">
    ${history.length > 1 ? '<a href="#" id="ask-back" class="muted small">‹ Back to the team page</a>' : ''}
    <div class="muted small">🏒 ${escHtml(a.poll.team || 'Your team')} asks${a.poll.createdAt ? ` · ${usDate(new Date(a.poll.createdAt).toISOString().slice(0, 10))}` : ''}</div>
    <h2 class="ask-q">${escHtml(a.poll.question)}</h2>
    <div class="ask-for">Answering for <b>${escHtml(a.answer.player || 'you')}</b></div>
    <div class="ask-opts">${(a.poll.options?.length ? a.poll.options : ['Yes', 'No']).map(o =>
      `<button class="ask-opt${a.pending === o ? ' on' : ''}" data-opt="${escHtml(o)}">${escHtml(o)}</button>`).join('')}</div>
    <textarea id="ask-note" rows="2" maxlength="500" placeholder="Anything to add? (optional)">${escHtml(a.answer.note || '')}</textarea>
    <div class="row">
      <button id="ask-save" class="primary" ${a.pending ? '' : 'disabled'}>${a.answer.choice ? 'Update my answer' : 'Send my answer'}</button>
      <span id="ask-status" class="muted small">${escHtml(status || (a.answer.choice ? `Current answer: ${a.answer.choice}${a.answer.answeredAt ? ` · ${stamp(a.answer.answeredAt)}` : ''}` : ''))}</span>
    </div>
    <p class="muted small">You can come back to this link and change your answer any time.</p>
  </div>`;
}

$('#ask-screen').addEventListener('click', async e => {
  if (e.target.closest('#ask-back')) { e.preventDefault(); history.back(); return; }
  const a = askState; if (!a?.poll) return;
  const opt = e.target.closest('.ask-opt');
  if (opt) {
    a.pending = opt.dataset.opt;
    const note = $('#ask-note')?.value ?? a.answer.note ?? '';
    a.answer.note = note;
    renderAsk();
    return;
  }
  if (e.target.closest('#ask-save') && a.pending) {
    const note = ($('#ask-note')?.value || '').slice(0, 500);
    const doc = { player: a.answer.player || '', choice: a.pending, note, answeredAt: Date.now() };
    renderAsk('Sending…');
    try {
      await cloudBackend.savePollAnswer(a.pollId, a.token, doc);
      a.answer = { ...a.answer, ...doc };
      renderAsk('Saved ✓ — thanks!');
    } catch (err) { renderAsk(`Could not save: ${err?.message || err}`); }
  }
});

async function showRequest() {
  $('#present-title').textContent = '';
  const u = cloudSync?.user; if (!u) return;
  if (attemptLogged !== u.uid && cloudBackend?.logAttempt) { // the planner sees who signed in and got nowhere
    attemptLogged = u.uid;
    let wanted = ''; try { wanted = sessionStorage.getItem('hpp.wanted') || ''; } catch { /* fine */ }
    cloudBackend.logAttempt(u.uid, { uid: u.uid, email: String(u.email || '').toLowerCase(), name: u.name || '', path: wanted.slice(0, 300), at: Date.now() }).catch(() => {});
  }
  const paint = () => {
    const open = myRequest?.status === 'open', denied = myRequest?.status === 'denied' && Date.now() < (myRequest.deniedAt || 0) + 7 * 86400000;
    presentMsg(open ? "Request sent — you'll get in as soon as the coach approves it. This page opens by itself once that happens."
      : denied ? 'Your request was not approved. If that seems wrong, talk to your coach.'
      : "This Google account isn't on the team list yet. Ask the coach for access — or switch to the account the coach has for you.", { request: !open && !denied });
  };
  if (myRequestFor !== u.uid) { myRequest = undefined; myRequestFor = u.uid; }
  $('#req-mail').href = `mailto:${OWNER_EMAILS[0]}?subject=${encodeURIComponent('Practice plan access')}&body=${encodeURIComponent(`Hi coach — please add my Google account (${u.email}) to the team list for the practice plans.\n\n${u.name || ''}`)}`;
  if (myRequest === undefined) {
    presentMsg('Loading…');
    try { myRequest = (await cloudBackend.loadRequest(u.uid)) || null; } catch { myRequest = null; }
    if (screen.screen !== 'request') return;
  }
  paint();
}
$('#req-send').addEventListener('click', async () => {
  const u = cloudSync?.user; if (!u) return;
  const req = { uid: u.uid, email: String(u.email || '').toLowerCase(), name: u.name || '', role: $('input[name="req-role"]:checked')?.value === 'coach' ? 'coach' : 'team',
    note: $('#req-note').value.trim().slice(0, 300), status: 'open', at: Date.now() };
  $('#req-send').disabled = true;
  try { await cloudBackend.saveRequest(u.uid, req); myRequest = req; showRequest(); }
  catch (e) { presentMsg(`Couldn't send the request: ${e?.message || e}`, { request: true }); }
  $('#req-send').disabled = false;
});

// ---------- coach feedback: one note per drill (and one overall), seen only by the planner ----------
let myFeedback = new Map(), myFeedbackFor = null, fbKey = null;
const fbId = key => `${cloudSync.user.uid}_${key}`;
async function loadMyFeedback(p) {
  if (!feedbackOn || !cloudSync?.user) return;
  if (myFeedbackFor !== p.id) {
    myFeedbackFor = p.id; myFeedback = new Map();
    try { for (const f of await cloudBackend.loadMyFeedback(teamFor(p.id), p.id, cloudSync.user.uid)) myFeedback.set(f.drillId || 'overall', f); } catch { /* offline: buttons just start blank */ }
    if (presentPractice?.id !== p.id) return;
  }
  for (const b of $$('#present-body .pr-fb')) {
    const has = myFeedback.has(b.dataset.fb);
    b.classList.toggle('active', has);
    b.textContent = `${b.dataset.fb === 'overall' ? '💬 Overall feedback' : '💬 Feedback'}${has ? ' ✓' : ''}`;
  }
}
function openFeedback(key) {
  const p = presentPractice; if (!p || !feedbackOn) return;
  fbKey = key;
  const d = p.drills.find(x => x.id === key);
  $('#fb-title').textContent = d ? `Feedback — ${d.name}` : 'Overall feedback on this practice';
  $('#fb-text').value = myFeedback.get(key)?.text || '';
  $('#fb-del').hidden = !myFeedback.has(key);
  $('#fb-note').textContent = 'Only the head coach sees this.';
  $('#present-fb').hidden = false;
  if (!matchMedia('(pointer: coarse)').matches) $('#fb-text').focus();
}
function closeFeedback() { $('#present-fb').hidden = true; fbKey = null; }
$('#present-body').addEventListener('click', e => { const b = e.target.closest('.pr-fb'); if (b) openFeedback(b.dataset.fb); });
$('#present-fb').addEventListener('click', e => { if (e.target === e.currentTarget) closeFeedback(); });
$('#fb-cancel').addEventListener('click', closeFeedback);
$('#fb-send').addEventListener('click', async () => {
  const p = presentPractice, u = cloudSync?.user, text = $('#fb-text').value.trim();
  if (!p || !u || !fbKey) return;
  if (!text) { $('#fb-note').textContent = 'Write something first — or Delete to take your note back.'; return; }
  const d = p.drills.find(x => x.id === fbKey);
  const entry = { uid: u.uid, email: String(u.email || '').toLowerCase(), name: u.name || '', drillId: d ? d.id : '', drillName: d ? d.name : 'Overall', text: text.slice(0, 4000), at: Date.now() };
  $('#fb-note').textContent = 'Sending…';
  try { await cloudBackend.saveFeedback(teamFor(p.id), p.id, fbId(fbKey), entry); myFeedback.set(fbKey, entry); closeFeedback(); loadMyFeedback(p); }
  catch (e) { $('#fb-note').textContent = `Couldn't send: ${e?.message || e}`; }
});
$('#fb-del').addEventListener('click', async () => {
  const p = presentPractice; if (!p || !fbKey) return;
  try { await cloudBackend.removeFeedback(teamFor(p.id), p.id, fbId(fbKey)); myFeedback.delete(fbKey); closeFeedback(); loadMyFeedback(p); }
  catch (e) { $('#fb-note').textContent = `Couldn't delete: ${e?.message || e}`; }
});

// ---------- rink mode: the presentation on a phone, one drill at a time ----------
// Coaches read the plan on a phone at the bench: focus mode shows a single drill card filling the screen
// with glove-sized controls, prev/next + swipe to move through the practice, a jump list, an optional
// sideways diagram for a phone held upright, full screen, and a wake lock so the screen stays on.
let presentMode = null;      // 'focus' (one drill) | 'list' (the whole plan as a scroll-through)
let presentRotate = false;   // focus + portrait: draw the diagram turned 90° so the long side runs down the screen
let presentIndex = 0;        // which .pr-drill card is on screen in focus mode
let presentShownId = null;   // practice currently rendered — the "now" drill is only picked when this changes
try {
  presentMode = localStorage.getItem('hpp.viewmode');
  presentRotate = localStorage.getItem('hpp.viewrot') === '1';
} catch { /* storage blocked: defaults */ }
if (presentMode !== 'focus' && presentMode !== 'list') presentMode = matchMedia('(pointer: coarse)').matches ? 'focus' : 'list';

const presentCards = () => $$('#present-body .pr-drill');
const inLandscape = () => matchMedia('(orientation: landscape) and (max-height: 560px)').matches; // a phone on its side

/**
 * Index of the drill to open on: the first page by default. Only while the practice is actually in progress (today,
 * between its start and its end) does the viewer jump to the drill the clock says is on the ice now.
 */
function drillNowIndex(p) {
  const start = parseStart(p);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (start == null || p.date !== today) return 0;
  const min = now.getHours() * 60 + now.getMinutes();
  if (min < start) return 0;
  const drills = activeDrills(p);
  let t = start;
  for (let i = 0; i < drills.length; i++) { if (drills[i].at != null) t = start + drills[i].at; t += +drills[i].duration || 0; if (min < t) return i; }
  return 0; // practice is over: back to the first page, not the dismissal card
}

function applyPresentMode() {
  const focus = presentMode === 'focus' && showingPractice; // a list or a message is an ordinary page
  $('#present-mode').hidden = !showingPractice;
  $('#present').classList.toggle('focus', focus);
  $('#present-nav').hidden = !focus;
  $('#present-mode').innerHTML = icon(focus ? 'list' : 'focus');
  $('#present-mode').title = focus ? 'Show the whole plan as a scroll-through' : 'One drill at a time (phone / rink mode)';
  $('#present-full').hidden = !document.documentElement.requestFullscreen; // iPhone Safari has no page fullscreen — add to Home Screen instead
  $('#present-rotate').classList.toggle('on', presentRotate);
  layoutPresent();
}
function setPresentMode(m) {
  presentMode = m;
  try { localStorage.setItem('hpp.viewmode', m); } catch { /* fine */ }
  applyPresentMode();
  if (m === 'focus') showDrill(presentIndex);
  else $('#present-scroll').scrollTop = 0;
}

/** Put card i on screen (focus mode); in list mode it just records the index and refreshes the nav. */
function showDrill(i) {
  const cards = presentCards();
  if (!cards.length) return;
  presentIndex = Math.max(0, Math.min(cards.length - 1, i));
  if (cards[presentIndex]?.classList.contains('current') === false) stopReading(); // moving to another drill
  cards.forEach((c, k) => {
    const cur = k === presentIndex;
    if (presentMode === 'focus') { // moving on stops whatever the drill being left is playing: animation, intro clip, video
      if (!cur) { c._pause?.(); c._pauseIntro?.(); c._stopMedia?.(); }
      else c._resumeMedia?.();
    }
    c.classList.toggle('current', cur);
  });
  const nameOf = c => c.querySelector('header b')?.textContent || '';
  $('.pr-nav-count').textContent = `${presentIndex + 1} / ${cards.length}`;
  const next = cards[presentIndex + 1];
  $('.pr-nav-next').textContent = next ? `Next: ${nameOf(next)}` : `End of ${isGame(presentPractice) ? 'game plan' : 'practice'}`;
  $('#present-prev').disabled = presentIndex === 0;
  $('#present-next').disabled = presentIndex === cards.length - 1;
  if (presentMode === 'focus') $('#present-scroll').scrollTop = 0;
  layoutPresent();
  if (presentMode === 'focus' && presentPractice) noteCurrentView(presentPractice);
}

/** Inline sizing for the two cases CSS can't do alone: the sideways portrait diagram and the phone-landscape row. */
const ROTATE_GAIN = 1.3; // in portrait, a diagram is turned 90° only when that makes its long side at least this much bigger
function layoutPresent() {
  if (!presenting) return;
  const focus = presentMode === 'focus' && showingPractice;
  const landscape = focus && inLandscape();
  $('#present').classList.toggle('landscape', landscape);
  const scroll = $('#present-scroll');
  let rotateHelps = false; // set below for the card on screen: turning it 90° would make it noticeably bigger
  for (const sec of presentCards()) {
    const fig = sec.querySelector('.pr-fig'), layers = fig ? [...fig.querySelectorAll(':scope > svg')] : [];
    const player = sec.querySelector('.pr-video .video-box');
    if (player) player.style.cssText = '';
    if (!layers.length) {
      if (player && focus && sec.classList.contains('current') && !landscape) sizeMedia(sec, player, 16 / 9, scroll);
      continue;
    }
    fig.style.cssText = ''; layers.forEach(l => { l.style.cssText = ''; }); fig.classList.remove('rotated');
    if (!focus || !sec.classList.contains('current')) continue;
    if (player && sec.classList.contains('video-open')) { // the video takes the diagram's place
      if (landscape) player.style.width = `${Math.max(160, Math.min(scroll.clientWidth - 24 - 200, (scroll.clientHeight - 24) * 16 / 9))}px`;
      else sizeMedia(sec, player, 16 / 9, scroll);
      continue;
    }
    const ar = +fig.dataset.ar || 2.26;
    if (landscape) {
      // diagram fills the height, capped so the header / controls column beside it keeps ~200px
      const availH = scroll.clientHeight - 24, availW = scroll.clientWidth - 24 - 200;
      fig.style.width = `${Math.max(160, Math.min(availW, availH * ar))}px`;
      continue;
    }
    // Portrait: everything fits the screen with no scrolling. The name, play bar and nav keep their height;
    // the text box (cue, rules, notes) keeps a few lines and scrolls inside itself; the diagram gets the rest.
    const text = sec.querySelector('.pr-text');
    let used = 0;
    for (const el of sec.children) if (el !== fig && el !== text) used += el.offsetHeight;
    const textWant = text ? Math.min(text.scrollHeight, 88) : 0;
    const availH = Math.max(110, scroll.clientHeight - 16 - used - textWant - 28), availW = scroll.clientWidth - 24;
    // Turning a wide diagram 90° so its long side runs down the phone only pays when it comes out noticeably bigger:
    // a diagram that is nearly square, or a box that is already wide enough, would just gain gutters and shrink.
    const upright = Math.min(availW, availH * ar), turned = Math.min(availH, availW * ar); // the long side on screen either way
    rotateHelps = ar > 1.05 && turned >= upright * ROTATE_GAIN;
    if (presentRotate && rotateHelps) {
      // turned 90°: the rink's long side runs down the phone. Box on screen is w × h; the svg is laid out h × w then rotated.
      const h = turned, w = h / ar;
      fig.classList.add('rotated');
      fig.style.width = `${w}px`; fig.style.height = `${h}px`;
      layers.forEach(l => { l.style.width = `${h}px`; l.style.height = `${w}px`; });
    } else {
      fig.style.width = `${upright}px`;
    }
  }
  $('#present-rotate').hidden = !focus || landscape || !rotateHelps; // only offered when turning would actually help
}

/** Portrait focus mode: give one media box (an open video) the height left under the title and controls. */
function sizeMedia(sec, el, ar, scroll) {
  const text = sec.querySelector('.pr-text');
  let used = 0;
  for (const c of sec.children) if (c !== text && !c.contains(el) && c !== sec.querySelector('.pr-fig')) used += c.offsetHeight;
  used += el.parentElement.offsetHeight - el.offsetHeight; // the Close button above the player
  const textWant = text ? Math.min(text.scrollHeight, 88) : 0;
  const availH = Math.max(110, scroll.clientHeight - 16 - used - textWant - 28), availW = scroll.clientWidth - 24;
  el.style.width = `${Math.min(availW, availH * ar)}px`;
}
/**
 * Pinch-to-zoom inside a diagram. The page itself never zooms (touch-action locks it — a zoomed page is how
 * "it doesn't fit on my phone" happens); instead two fingers zoom the drill by shrinking both layers' viewBox
 * around the pinch, one finger pans while zoomed, and a double tap puts it back.
 */
function wirePinchZoom(fig) {
  if (fig._pinch) return;
  fig._pinch = true;
  const base = () => fig.querySelector(':scope > svg');
  const layers = () => fig.querySelectorAll(':scope > svg');
  const orig = () => { if (!fig.dataset.vb) fig.dataset.vb = base()?.getAttribute('viewBox') || ''; return fig.dataset.vb.split(' ').map(Number); };
  const cur = () => (base()?.getAttribute('viewBox') || '').split(' ').map(Number);
  const set = v => { const str = v.map(n => n.toFixed(2)).join(' '); layers().forEach(l => l.setAttribute('viewBox', str)); fig.classList.toggle('zoomed', v[2] < orig()[2] - 0.01); };
  const clamp = v => {
    const o = orig();
    v[2] = Math.min(o[2], Math.max(o[2] / 4, v[2])); v[3] = v[2] * o[3] / o[2];
    v[0] = Math.min(o[0] + o[2] - v[2], Math.max(o[0], v[0])); v[1] = Math.min(o[1] + o[3] - v[3], Math.max(o[1], v[1]));
    return v;
  };
  const toRink = (inv, cx, cy) => { const q = new DOMPoint(cx, cy).matrixTransform(inv); return { x: q.x, y: q.y }; };
  let pinch = null, pan = null, lastTap = 0;
  fig.reset = () => { set(orig()); pinch = pan = null; };
  fig.addEventListener('touchstart', e => {
    const b = base(); if (!b) return;
    if (e.touches.length === 2) {
      const [a, c] = e.touches, inv = b.getScreenCTM().inverse();
      pinch = { d: Math.hypot(a.clientX - c.clientX, a.clientY - c.clientY), vb: cur(), c: toRink(inv, (a.clientX + c.clientX) / 2, (a.clientY + c.clientY) / 2) };
      pan = null;
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { fig.reset(); lastTap = 0; return; }
      lastTap = now;
      if (fig.classList.contains('zoomed')) pan = { x: e.touches[0].clientX, y: e.touches[0].clientY, vb: cur(), inv: b.getScreenCTM().inverse() };
    }
  }, { passive: true });
  fig.addEventListener('touchmove', e => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      const [a, c] = e.touches;
      const k = pinch.d / Math.max(1, Math.hypot(a.clientX - c.clientX, a.clientY - c.clientY)); // fingers apart → smaller box
      const w = pinch.vb[2] * k, h = pinch.vb[3] * k;
      const fx = (pinch.c.x - pinch.vb[0]) / pinch.vb[2], fy = (pinch.c.y - pinch.vb[1]) / pinch.vb[3]; // keep the pinch centre under the fingers
      set(clamp([pinch.c.x - fx * w, pinch.c.y - fy * h, w, h]));
    } else if (pan && e.touches.length === 1) {
      e.preventDefault();
      const p0 = toRink(pan.inv, pan.x, pan.y), p1 = toRink(pan.inv, e.touches[0].clientX, e.touches[0].clientY);
      set(clamp([pan.vb[0] - (p1.x - p0.x), pan.vb[1] - (p1.y - p0.y), pan.vb[2], pan.vb[3]]));
    }
  }, { passive: false });
  fig.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; if (!e.touches.length) pan = null; }, { passive: true });
}
function presentKeydown(e) {
  if (isEditing()) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); showDrill(presentIndex + 1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); showDrill(presentIndex - 1); }
  else if (e.key === ' ' && presentMode === 'focus') { e.preventDefault(); presentCards()[presentIndex]?.querySelector('.pr-play')?.click(); }
  else if (e.key === 'Escape') { closePicker(); closeAcct(); closeFeedback(); }
}

// jump list: every drill with its clock time
function openPicker() {
  const cards = presentCards();
  $('#present-picker-list').innerHTML = cards.map((c, i) => `<li class="${i === presentIndex ? 'current' : ''}" data-i="${i}">
    <span class="name">${escHtml(c.querySelector('header b')?.textContent || '')}</span>
    <span class="when">${escHtml([c.querySelector('.pr-min')?.textContent, c.querySelector('.pr-time')?.textContent].filter(Boolean).join(' · '))}</span></li>`).join('');
  const est = presentPractice ? reviewEstimate(presentPractice) : null;
  $('#present-picker h3').textContent = `Jump to ${itemNoun(presentPractice)}${est ? ` · about ${est.min} min to review` : ''}`;
  $('#present-picker').hidden = false;
  $('#present-picker-list li.current')?.scrollIntoView({ block: 'center' });
}
function closePicker() { $('#present-picker').hidden = true; }
/** ↻ Resync: drop this practice's cached intro clips and reload, so the freshest plan, clips and app version come down. */
$('#present-sync').addEventListener('click', async () => {
  if (!navigator.onLine) { presentNote('Offline — resync once you have a connection.'); return; }
  const p = presentPractice;
  if (p) for (const d of p.drills) {
    for (const k of [d.intro ? keyFor(presentOwner, p.id, d) : null, d.upload ? videoKey(presentOwner, p.id, d) : null]) { if (!k) continue; forgetClip(k); try { await idbDelClip(k); } catch { /* fine */ } }
  }
  try { (await navigator.serviceWorker?.getRegistration())?.update(); } catch { /* fine */ }
  location.reload();
});
$('#present-jump').addEventListener('click', openPicker);
$('#present-account').addEventListener('click', openAcct);
$('#present-acct').addEventListener('click', e => { if (e.target === e.currentTarget) closeAcct(); }); // tap outside the sheet
$('#present-signout').addEventListener('click', presentSignOut);
$('#present-switch').addEventListener('click', presentSignOut);
$('#present-picker').addEventListener('click', e => {
  const li = e.target.closest('li[data-i]');
  if (li) showDrill(+li.dataset.i);
  closePicker();
});
$('#present-prev').addEventListener('click', () => showDrill(presentIndex - 1));
$('#present-next').addEventListener('click', () => showDrill(presentIndex + 1));
$('#present-mode').addEventListener('click', () => setPresentMode(presentMode === 'focus' ? 'list' : 'focus'));
$('#present-rotate').addEventListener('click', () => {
  presentRotate = !presentRotate;
  try { localStorage.setItem('hpp.viewrot', presentRotate ? '1' : '0'); } catch { /* fine */ }
  $('#present-rotate').classList.toggle('on', presentRotate);
  layoutPresent();
});
$('#present-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
document.addEventListener('fullscreenchange', () => { $('#present-full').innerHTML = icon(document.fullscreenElement ? 'unfullscreen' : 'fullscreen'); });

// swipe left / right across the card changes drills (a drag on the scrubber or a 3D tile is not a swipe)
let swipe = null;
$('#present-scroll').addEventListener('touchstart', e => {
  swipe = null;
  if (presentMode !== 'focus' || e.touches.length !== 1 || e.target.closest('input,select,button,canvas,.pr-fig.zoomed')) return;
  swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now() };
}, { passive: true });
$('#present-scroll').addEventListener('touchend', e => {
  if (!swipe) return;
  const dx = e.changedTouches[0].clientX - swipe.x, dy = e.changedTouches[0].clientY - swipe.y, dt = Date.now() - swipe.at;
  swipe = null;
  if (dt < 800 && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) showDrill(presentIndex + (dx < 0 ? 1 : -1));
}, { passive: true });
window.addEventListener('resize', layoutPresent);

// Pull down to reload. The viewer is a fixed, non-scrolling page (and an installed home-screen app has no
// browser chrome at all), so the browser's own pull-to-refresh never fires — this stands in for it on the
// share link and the sign-in gate. Never in the practice creator, where a drag means something else.
const PULL_ARM = 110; // px of pull before letting go reloads
let pull = null;
const pullTip = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'pull-tip', hidden: true }));
const atTop = el => { for (; el && el !== document.body; el = el.parentElement) if (el.scrollTop > 0) return false; return true; };
const endPull = () => { pull = null; pullTip.hidden = true; };
document.addEventListener('touchstart', e => {
  pull = null;
  if (editorOn || e.touches.length !== 1 || e.target.closest('input,select,textarea,canvas,video,.pr-fig.zoomed,#present-picker,#present-acct,#present-fb,#present-club') || !atTop(e.target)) return;
  pull = { x: e.touches[0].clientX, y: e.touches[0].clientY, el: e.target, armed: false };
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!pull) return;
  const dx = e.touches[0].clientX - pull.x, dy = e.touches[0].clientY - pull.y;
  if (e.touches.length !== 1 || !atTop(pull.el) || (Math.abs(dx) > 30 && Math.abs(dx) > dy)) return endPull(); // a pinch, a scroll or a sideways swipe
  if (dy < 24) { pullTip.hidden = true; pull.armed = false; return; }
  pull.armed = dy >= PULL_ARM;
  pullTip.hidden = false;
  pullTip.textContent = pull.armed ? '↻ Release to reload' : '↓ Pull to reload';
  pullTip.classList.toggle('armed', pull.armed);
  pullTip.style.transform = `translate(-50%, ${Math.min(dy, PULL_ARM + 30) * 0.5}px)`;
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!pull?.armed) return endPull();
  pull = null;
  pullTip.textContent = 'Reloading…';
  location.reload();
}, { passive: true });
document.addEventListener('touchcancel', endPull, { passive: true });

// Keep the screen on while the plan is up at the bench (Screen Wake Lock: Chrome/Android, iOS 16.4+ Safari).
let wakeLock = null;
async function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  if (!on) { wakeLock?.release().catch(() => {}); wakeLock = null; return; }
  if (wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; } // low battery / not allowed: the plan still works, the screen just times out
}
document.addEventListener('visibilitychange', () => { if (presenting && document.visibilityState === 'visible') keepAwake(true); });

// Presentation is its own destination (the very URL coaches / families get) — a new tab, so the editor stays put.
const openPresentation = view => window.open(`${location.origin}${routePath({ view, teamId: store.practice.teamId || teamOf(store.practice)?.id || null, pid: store.practice.id })}`, '_blank');
$('#btn-present').addEventListener('click', () => openPresentation('coach'));
$('#btn-present-coach').addEventListener('click', () => { closePopovers(); openPresentation('coach'); });
$('#btn-present-team').addEventListener('click', () => { closePopovers(); openPresentation('team'); });
$('#btn-open-team').addEventListener('click', () => openPresentation('team'));
$('#btn-open-coach').addEventListener('click', () => openPresentation('coach'));
$('#present-signin').addEventListener('click', () => cloudSync?.signIn().catch(e => presentMsg(`Sign-in failed: ${friendlyAuthError(e)}`, { signIn: true })));
$('#present-anon').addEventListener('click', () => cloudSync?.signInAnon?.().catch(e => presentMsg(`Sign-in failed: ${friendlyAuthError(e)}`, { signIn: true, anon: true })));
/** A page inside another app (a team-chat app's built-in browser): Google refuses to sign anyone in there. */
function inAppBrowser() {
  const ua = navigator.userAgent || '';
  if (/\bwv\b|; wv\)/.test(ua)) return true;                                   // Android WebView
  if (/FBAN|FBAV|Instagram|Line\/|Snapchat|Messenger|GSA\//.test(ua)) return true; // apps known to embed one
  return /iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua); // iOS: any browser but Safari / real browser apps
}
$('#present-tolist').addEventListener('click', e => navigate(e.currentTarget.dataset.to || '/'));
$('#present-reload').addEventListener('click', () => location.reload()); // a failed module import stays failed for the page's lifetime: start over
/** Copy one of the two links: /coach/<id> or /team/<id>. Who can open it is decided by the stage and the roster, not by having the link. */
async function copyShareLink(btn, view) {
  const url = `${location.origin}${routePath({ view, teamId: store.practice.teamId || teamOf(store.practice)?.id || null, pid: store.practice.id })}`;
  try { await navigator.clipboard.writeText(url); } catch { prompt('Copy this link:', url); return; }
  const old = btn.textContent;
  btn.textContent = '✓ Copied';
  setTimeout(() => { btn.textContent = old; }, 1500);
}
// ----- the owner's audit log of views -----
const fmtWhen = stamp;
async function openViewLog() {
  const p = store.practice;
  if (!cloudBackend?.loadViews || !cloudSync?.user || !store.data.ownerUid) return alert('Sign in first — the log lives in your cloud account.');
  $('#practice-pop').hidden = true;
  $('#viewlog').hidden = false;
  $('#viewlog-title').textContent = practiceLabel(p);
  $('#viewlog-body').innerHTML = '<p class="vl-empty">Loading…</p>';
  let rows;
  try { rows = await cloudBackend.loadViews(teamFor(p.id), p.id); }
  catch (e) { $('#viewlog-body').innerHTML = `<p class="vl-empty">Couldn't load the log: ${escHtml(e?.message || e)} — are the latest firestore.rules deployed?</p>`; return; }
  renderViewLog(p, rows);
}
function renderViewLog(p, rows) {
  if (!rows.length) { $('#viewlog-body').innerHTML = '<p class="vl-empty">Nobody has opened this practice yet. Views and plays by the coaches and families you shared it with will show up here.</p>'; return; }
  const who = r => r.name && r.email ? `<span class="vl-who">${escHtml(r.name)} <span class="muted">${escHtml(r.email)}</span></span>` : `<span class="vl-who">${escHtml(r.name || r.email || r.uid)}</span>`;
  // per drill: one line per person with their view / play counts and last time
  // reactions after practice: the latest pick per person, and how many times they changed it
  const reacts = rows.filter(r => r.action === 'react');
  const latest = new Map();
  for (const r of [...reacts].sort((a, b) => (a.at || 0) - (b.at || 0))) { const k = r.uid || r.email; const v = latest.get(k) || { r, n: 0 }; v.r = r; v.n++; latest.set(k, v); }
  const reactHTML = reacts.length ? `<h3>Reactions after practice</h3>
    <div class="vl-tally">${REACTIONS.map(([e]) => `<span class="vl-tally-item"><span class="vl-emoji">${e}</span> ${[...latest.values()].filter(v => v.r.emoji === e).length}</span>`).join('')}</div>
    <table class="vl-table"><tr><th>Who</th><th>Pick</th><th>When</th><th>Via</th></tr>
    ${[...latest.values()].sort((a, b) => (b.r.at || 0) - (a.r.at || 0)).map(v => `<tr><td>${who(v.r)}</td><td><span class="vl-emoji">${escHtml(v.r.emoji || '')}</span>${v.n > 1 ? ` <span class="muted small">changed ${v.n - 1}×</span>` : ''}</td><td class="when">${fmtWhen(v.r.at || 0)}</td><td class="muted">${escHtml(v.r.audience === 'team' ? 'team link' : 'coach link')}${v.r.device ? ` · ${escHtml(v.r.device)}` : ''}</td></tr>`).join('')}</table>` : '';
  const byDrill = new Map();
  for (const r of rows) {
    if (r.action === 'react') continue;
    const d = byDrill.get(r.drillId) || new Map(); byDrill.set(r.drillId, d);
    const k = r.uid || r.email; const v = d.get(k) || { r, views: 0, plays: 0, last: 0, first: Infinity };
    if (r.action === 'play') v.plays++; else v.views++;
    v.last = Math.max(v.last, r.at || 0); v.first = Math.min(v.first, r.at || Infinity);
    d.set(k, v);
  }
  const order = [...p.drills.map(d => d.id), ...[...byDrill.keys()].filter(id => !p.drills.some(d => d.id === id))]; // current drills first, deleted ones after
  const drillName = id => p.drills.find(d => d.id === id)?.name || rows.find(r => r.drillId === id)?.drillName || id;
  const sections = order.filter(id => byDrill.has(id)).map((id, i) => {
    const people = [...byDrill.get(id).values()].sort((a, b) => b.last - a.last);
    return `<h3>${p.drills.some(d => d.id === id) ? `${p.drills.findIndex(d => d.id === id) + 1}. ` : ''}${escHtml(drillName(id))}${p.drills.some(d => d.id === id) ? '' : ' <span class="muted">(drill since removed)</span>'}</h3>
      <table class="vl-table"><tr><th>Who</th><th>Views</th><th>Plays</th><th>First</th><th>Last</th><th>Via</th></tr>
      ${people.map(v => `<tr><td>${who(v.r)}</td><td class="num">${v.views}</td><td class="num">${v.plays}</td><td class="when">${fmtWhen(v.first)}</td><td class="when">${fmtWhen(v.last)}</td><td class="muted">${escHtml(v.r.audience === 'team' ? 'team link' : 'coach link')}${v.r.device ? ` · ${escHtml(v.r.device)}` : ''}</td></tr>`).join('')}</table>`;
  }).join('');
  const feed = rows.slice(0, 150).map(r => `<li><span class="when">${fmtWhen(r.at || 0)}</span><span class="act">${r.action === 'react' ? `${escHtml(r.emoji || '')} pick` : r.action === 'play' ? '▶ play' : '👁 view'}</span>${who(r)}<span class="muted">${r.action === 'react' ? 'after practice' : escHtml(r.drillName || drillName(r.drillId))}</span></li>`).join('');
  const people = new Set(rows.map(r => r.uid || r.email)).size;
  $('#viewlog-body').innerHTML = `<p class="muted small">${rows.length} record${rows.length === 1 ? '' : 's'} · ${people} ${people === 1 ? 'person' : 'people'} · a view is a drill on screen for 2 s, a play is its ▶ — at most one of each per person per drill every 5 minutes; a pick is the emoji tapped on the dismissal card.</p>${reactHTML}${sections}<h3>Recent activity</h3><ul class="vl-feed">${feed}</ul>`;
}
$('#btn-views').addEventListener('click', openViewLog);
$('#viewlog-refresh').addEventListener('click', openViewLog);
$('#viewlog-close').addEventListener('click', () => { $('#viewlog').hidden = true; });
$('#viewlog').addEventListener('click', e => { if (e.target === e.currentTarget) $('#viewlog').hidden = true; });
$('#viewlog-clear').addEventListener('click', async () => {
  if (!confirm('Delete every record in this practice\'s views log?')) return;
  try { await cloudBackend.clearViews(teamFor(store.practice.id), store.practice.id); openViewLog(); }
  catch (e) { alert(`Couldn't clear the log: ${e?.message || e}`); }
});
$('#btn-share-link').addEventListener('click', e => copyShareLink(e.currentTarget, 'coach'));
$('#btn-share-team-link').addEventListener('click', e => copyShareLink(e.currentTarget, 'team'));
$('#btn-share-open-link').addEventListener('click', e => copyShareLink(e.currentTarget, 'team')); // the public link is the team view
$('#practice-open').addEventListener('change', e => {
  const on = e.target.checked;
  editorApi.commit?.(() => { if (on) store.practice.open = true; else delete store.practice.open; });
});

// ---------- cloud sync (Firebase) ----------
const CLOUD_LABELS = { signedout: 'Not signed in (local only)', syncing: 'Syncing…', saving: 'Saving…', saved: 'Saved ✓', error: 'Cloud error' };
function renderCloudStatus(sync, state, detail) {
  const u = sync.user;
  const text = (u && state !== 'signedout' ? `${u.name} · ` : '') + (CLOUD_LABELS[state] || '') + (state === 'error' && detail ? ` (${detail})` : '');
  $('#cloud-status').textContent = text;
  // The status is width-capped with an ellipsis; hovering shows everything (especially full error details).
  $('#cloud-status').title = state === 'error' && detail ? `Cloud error:\n${detail}` : text;
  $('#cloud-status').classList.toggle('warn', state === 'error');
  $('#btn-signin').hidden = !!u;
  $('#btn-signout').hidden = !u;
  // The account button: the person's initial when signed in, and a dot that shows the cloud state at a glance.
  const signed = !!u && state !== 'signedout';
  $('#account-avatar').textContent = signed ? (String(u.name || u.email || '?').trim()[0] || '?').toUpperCase() : '👤';
  $('#btn-account').classList.toggle('signed', signed);
  $('#btn-account').title = `${signed ? `${u.name || u.email} · ` : 'Not signed in · '}${CLOUD_LABELS[state] || ''}${state === 'error' && detail ? ` (${detail})` : ''} — account, cloud status, settings`;
  const dot = $('#account-dot'); dot.hidden = !signed; dot.className = state;
  $('#account-who').textContent = signed ? (u.email && u.name !== u.email ? `${u.name} · ${u.email}` : u.name || u.email) : '';
}
// Only these accounts get the practice-creation interface. Everyone else uses share links
// (this is a UI gate; the real protection is Firestore's rules — nobody can write another
// account's practices, and readers only see the practices they are listed on).
const OWNER_EMAILS = ['ehren.eschmann@gmail.com'];
const isOwner = u => !!u && !u.isAnonymous && (!u.email || OWNER_EMAILS.includes(String(u.email).toLowerCase()));

/** Bring the practice creator up (only ever for the planner on /editor — see resolveRoute) or take it away. */
function syncEditor(on) {
  if (on && !editorApi.renderAll) { // the editor module is fetched on demand; refreshScreen runs again once it is in
    loadEditor().then(ok => { if (!ok) presentMsg('The editor could not load — check the connection and reload.'); });
    return;
  }
  if (on === editorOn) return;
  if (!on) { editorApi.finishActive?.(); editorApi.clearPickTarget?.(); if (editorApi.anim?.playing) editorApi.togglePlay?.(); }
  setEditorOn(on);
  document.body.classList.toggle('no-editor', !on);
  if (on) { editorApi.applyRoute?.(); editorApi.setSel?.(null); editorApi.renderAll?.(); }
}
let editorLoad = null;
/** Fetch editor.js once, on demand: for the planner's /editor screen, or quietly after the planner signs in. */
function loadEditor() {
  editorLoad ||= import('./editor.js').then(() => { refreshScreen(); return true; })
    .catch(e => { editorLoad = null; console.warn('The editor module failed to load:', e); return false; });
  return editorLoad;
}

// ---------- the planner's inbox: coach feedback and access requests, live ----------
let feedbackAll = [], accessRequests = [], accessAttempts = [], feedsUnsub = [];
function watchPlannerFeeds() {
  const on = !!cloudSync?.user && isOwner(cloudSync.user) && !!cloudBackend?.subscribeAllFeedback;
  if (on === !!feedsUnsub.length) return;
  feedsUnsub.forEach(f => f?.()); feedsUnsub = []; feedbackAll = []; accessRequests = []; accessAttempts = [];
  if (!on) return;
  feedsUnsub = [
    cloudBackend.subscribeAllFeedback((rows, err) => { if (err) return console.warn('feedback:', err); feedbackAll = rows; renderInboxBadges(); if (!$('#feedback').hidden) editorApi.renderFeedback?.(); }),
    cloudBackend.subscribeRequests((rows, err) => { if (err) return console.warn('requests:', err); accessRequests = rows; renderInboxBadges(); if (!$('#teammgr').hidden) editorApi.renderTeamMgr?.(); }),
    cloudBackend.subscribeAttempts?.((rows, err) => { if (err) return console.warn('attempts:', err); accessAttempts = rows; renderInboxBadges(); if (!$('#teammgr').hidden) editorApi.renderTeamMgr?.(); }),
  ];
}
const openFeedbackFor = pid => feedbackAll.filter(f => f.pid === pid && !f.resolved);
const openRequests = () => accessRequests.filter(r => r.status === 'open');
/** Accounts that signed in and got nowhere, and haven't asked (an open request says more) or been told no. */
const deniedSignIns = () => accessAttempts.filter(a => !accessRequests.some(r => r.uid === a.uid && (r.status === 'open' || r.status === 'denied'))).sort((a, b) => (b.at || 0) - (a.at || 0));
function renderInboxBadges() {
  if (!editorOn) return;
  paintInboxButtons();
  editorApi.renderPracticeSelect?.(); editorApi.renderPlan?.();
}
function paintInboxButtons() {
  const n = openFeedbackFor(store.practice.id).length;
  $('#btn-feedback').textContent = `💬${n ? ` ${n}` : ''}`;
  $('#btn-feedback').classList.toggle('attn', n > 0);
  const r = openRequests().length + deniedSignIns().length;
  $('#btn-team').textContent = `👥 Team${r ? ` (${r})` : ''}`;
  $('#btn-team').classList.toggle('attn', r > 0);
}

async function bootCloud() {
  // `globalThis.__hppBackend` lets tests plug in a fake backend; otherwise use Firebase when configured.
  let backend = globalThis.__hppBackend || null;
  if (!backend) {
    try {
      const cfg = await loadConfig();
      if (cfg) backend = await firebaseBackend(cfg);
    } catch (e) {
      // Offline and the SDK isn't cached yet, or something on this device blocks it. The planner's own device
      // still works local-only; a viewer sees the copy this device kept, or what went wrong and a way to retry.
      cloudBoot = 'failed'; cloudBootError = e?.message || String(e);
      console.warn('Cloud service did not load:', e);
      addEventListener('online', () => { if (presenting) location.reload(); }, { once: true });
    }
  }
  if (!backend) { if (cloudBoot === 'loading') cloudBoot = 'none'; refreshScreen(); return; } // no config (or failed boot): local-only
  $('#cloud').hidden = false;
  const sync = createSync({
    store, backend,
    canSync: isOwner, // viewers only read what is released to them: no practices are pulled into or saved from their account
    onStatus: (state, detail) => {
      authKnown = true;
      renderCloudStatus(sync, state, detail);
      signInError = state === 'error' && !sync.user ? detail || '' : '';
      if (sync.user) { try { if (isOwner(sync.user)) localStorage.setItem('hpp.owner', '1'); else localStorage.removeItem('hpp.owner'); } catch { /* storage blocked */ } }
      if (sync.user && isOwner(sync.user) && state === 'saved' && !uploadsChecked) { uploadsChecked = true; loadEditor().then(() => editorApi.uploadPendingIntros?.()); } // first quiet moment after sign-in
      if (sync.user && isOwner(sync.user)) loadEditor().then(() => editorApi.loadAIRecord?.()); // the planner's device: the encrypted key record, and the editor warmed up for the toolbar
      watchInbox(); watchPlannerFeeds();
      refreshScreen(); // who is signed in decides the screen
    },
    onRemote: (ids, { full } = {}) => {
      // Practices changed from another device (or first sync): refresh what is on screen.
      if (full || ids.includes(store.data.currentId) || !store.practice) { editorApi.finishActive?.(); editorApi.setSel?.(null); editorApi.stopAnim?.(); editorApi.renderAll?.(); }
      else editorApi.renderPracticeSelect?.();
      if (presenting) refreshScreen(); // previewing one's own practice: pick up the change live
    },
    onRoster: () => { if (!$('#teammgr').hidden) editorApi.renderTeamMgr?.(); }, // roster edited on another device
  });
  cloudSync = sync; cloudBackend = backend; cloudBoot = 'ready';
  $('#btn-signin').addEventListener('click', () => sync.signIn().catch(e => renderCloudStatus(sync, 'error', friendlyAuthError(e))));
  $('#btn-signout').addEventListener('click', () => sync.signOut().catch(e => renderCloudStatus(sync, 'error', e?.message || String(e))));
  renderCloudStatus(sync, 'signedout');
  refreshScreen();
}

// ---------- keeping the viewer current ----------
// Every deploy writes version.json (scripts/stamp-version.mjs, run by the hosting predeploy hook). The page notes the
// stamp it started with and re-reads it whenever the viewer moves to a practice or the list, and when the app comes
// back to the foreground. A changed stamp means a newer deploy: the page reloads itself — the URL brings it straight
// back to the same practice — so a phone that has kept the app open for a week never runs a practice on an old viewer.
// Offline, the service worker hands back the cached stamp, which matches, so nothing happens.
let appVersion = null;
async function readVersion() {
  try { const r = await fetch('/version.json', { cache: 'no-store' }); if (!r.ok) return null; return (await r.json()).v || null; } catch { return null; }
}
async function ensureLatestViewer() {
  const v = await readVersion();
  if (!v) return;
  if (!appVersion) { appVersion = v; return; }
  if (v === appVersion) return;
  let last = null;
  try { last = sessionStorage.getItem('hpp.reloadedFor'); sessionStorage.setItem('hpp.reloadedFor', v); } catch { /* fine */ }
  if (last === v) { appVersion = v; return; } // already reloaded for this stamp once and it still differs: don't loop
  try { (await navigator.serviceWorker?.getRegistration())?.update(); } catch { /* fine */ }
  location.reload();
}
ensureLatestViewer(); // remember the stamp this page started with
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && presenting) ensureLatestViewer(); });

// The editor settings sheet changes the saved presentation mode without presenting (so no relayout).
const setPresentModePref = v => { presentMode = v; try { localStorage.setItem('hpp.viewmode', v); } catch { /* fine */ } };


// Presentation keys (arrows, space): wired here, not in the editor's keydown, so they work
// without the editor module loaded.
document.addEventListener('keydown', e => { if (presenting) presentKeydown(e); });

export { accessAttempts, accessRequests, bootCloud, cloudBackend, cloudBoot, cloudSync, clubState, deniedSignIns, feedbackAll, hasVideo, isOwner, loadEditor, openClubOutput, openFeedbackFor, openRequests, paintInboxButtons, presentMode, presenting, pull, refreshScreen, screen, setPresentModePref, syncEditor, teamFor, videoPoster, who };
