// Drill videos: a link to YouTube, Vimeo or Cloudflare Stream (or a direct .mp4 / .webm file) becomes an
// embedded player. Only these hosts are ever placed in an iframe — a pasted link that isn't one of them is
// refused rather than embedded blind.

/** Turn a pasted link (or a pasted <iframe> snippet) into { kind: 'iframe' | 'file', src, host, id } — or null. */
export function videoEmbed(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  const snippet = s.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  if (snippet) s = snippet[1];
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);

  // YouTube: watch?v=, youtu.be/, /shorts/, /embed/, /live/ — with an optional start time
  if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'youtu.be'].includes(host)) {
    const id = host === 'youtu.be' ? seg[0] : (u.searchParams.get('v') || (['shorts', 'embed', 'live', 'v'].includes(seg[0]) ? seg[1] : null));
    if (!/^[\w-]{6,}$/.test(id || '')) return null;
    const t = u.searchParams.get('t') || u.searchParams.get('start');
    const start = t ? (String(t).match(/^\d+$/) ? +t : ytSeconds(t)) : 0;
    return { kind: 'iframe', host: 'YouTube', id, src: `https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0&modestbranding=1${start ? `&start=${start}` : ''}` };
  }
  // Vimeo: vimeo.com/ID, vimeo.com/ID/HASH (unlisted), player.vimeo.com/video/ID
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const i = seg.indexOf('video');
    const id = i >= 0 ? seg[i + 1] : seg.find(x => /^\d+$/.test(x));
    if (!/^\d+$/.test(id || '')) return null;
    const hash = u.searchParams.get('h') || (host === 'vimeo.com' && /^[0-9a-f]{8,}$/i.test(seg[seg.indexOf(id) + 1] || '') ? seg[seg.indexOf(id) + 1] : null);
    return { kind: 'iframe', host: 'Vimeo', id, src: `https://player.vimeo.com/video/${id}?playsinline=1&dnt=1${hash ? `&h=${hash}` : ''}` };
  }
  // Cloudflare Stream: watch.cloudflarestream.com/ID, iframe.videodelivery.net/ID, customer-xxx.cloudflarestream.com/ID/(iframe|watch|manifest…)
  if (host === 'watch.cloudflarestream.com' || host === 'iframe.videodelivery.net' || host === 'iframe.cloudflarestream.com') {
    const id = seg[0];
    if (!/^[0-9a-f]{20,}$/i.test(id || '')) return null;
    return { kind: 'iframe', host: 'Cloudflare Stream', id, src: `https://iframe.videodelivery.net/${id}` };
  }
  if (/^customer-[\w-]+\.cloudflarestream\.com$/.test(host)) {
    const id = seg[0];
    if (!/^[0-9a-f]{20,}$/i.test(id || '')) return null;
    return { kind: 'iframe', host: 'Cloudflare Stream', id, src: `https://${host}/${id}/iframe` };
  }
  // A plain video file
  if (u.protocol === 'https:' && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u.pathname + u.search)) return { kind: 'file', host: host, id: seg.at(-1), src: u.href };
  return null;
}

function ytSeconds(t) { // "1m30s", "90s", "1h2m"
  const m = String(t).match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

/** Player markup for an embed (16:9 box). */
export function videoPlayerHTML(v) {
  if (!v) return '';
  if (v.kind === 'file') return `<div class="video-box"><video src="${esc(v.src)}" controls playsinline preload="metadata"></video></div>`;
  return `<div class="video-box"><iframe src="${esc(v.src)}" title="${esc(v.host)} video" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" loading="lazy"></iframe></div>`;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- uploaded drill videos: dropped in, re-encoded small in the browser, stored as chunks ----------
// A dropped file is played through a canvas and re-recorded at ≤640 px and a low bitrate, with either its own
// sound or a recorded voiceover as the audio track. That keeps a minute of video to a few MB, which is what makes
// hosting it in Firestore (free tier, no storage bucket, no billing account) workable: see cloud.js saveVideo.
// There is no length cap: the editor estimates the size instead and warns past VIDEO_WARN_MB.
export const VIDEO_MAX_WIDTH = 640;
// Rough output sizes at the encoder's bitrates: moving picture ≈ 0.095 MB/s; a held frame costs little more than its audio.
export const VIDEO_MB_PER_SEC = 0.095, HELD_MB_PER_SEC = 0.02;
export const VIDEO_WARN_MB = 8; // beyond this a clip is slow on a phone's data plan and heavy in Firestore: warn, don't refuse
/** Estimated encoded size in MB for `movingSecs` of video plus `heldSecs` of a held frame (a voiceover running longer than the picture). */
export const estimateVideoMB = (movingSecs, heldSecs = 0) => (Math.max(0, +movingSecs || 0) * VIDEO_MB_PER_SEC) + (Math.max(0, +heldSecs || 0) * HELD_MB_PER_SEC);

/** Read a dropped file's duration and size (rejects files the browser can't decode). */
export function probeVideoFile(file) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.playsInline = true;
    const url = URL.createObjectURL(file);
    v.onloadedmetadata = () => {
      const out = duration => ({ url, duration, width: v.videoWidth, height: v.videoHeight });
      if (Number.isFinite(v.duration)) return res(out(v.duration));
      // A WebM recorded by a browser reports an infinite duration until it is scanned: seek to the end to learn it.
      // If the browser won't tell us within 2 s, carry on with an unknown length — the encoder stops at the real end anyway.
      let settled = false;
      const finish = () => { if (settled) return; settled = true; const d = Number.isFinite(v.duration) ? v.duration : NaN; try { v.currentTime = 0; } catch { /* fine */ } res(out(d)); };
      v.ondurationchange = () => { if (Number.isFinite(v.duration)) finish(); };
      v.onseeked = () => finish();
      setTimeout(finish, 2000);
      try { v.currentTime = 1e6; } catch { finish(); }
    };
    v.onerror = () => { URL.revokeObjectURL(url); rej(new Error('this browser can’t decode that file — try an .mp4 or .mov')); };
    v.src = url;
  });
}

// Encoders, best first: H.264 + AAC in mp4 plays on every phone; VP9/VP8 WebM is the fallback (recent iPhones play it).
const VIDEO_FORMATS = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

/**
 * Re-encode `file` (or the trimmed part of it) at ≤ VIDEO_MAX_WIDTH px. `voiceover` (an audio Blob) replaces
 * the original sound when given; a voiceover longer than the picture is never cut — `voiceoverFit` says what
 * the picture does meanwhile: 'post' (default) holds the last frame while the audio finishes, 'pre' starts
 * the audio on the held first frame and lets the picture roll once the audio has caught up.
 * Runs in real time, so a 90 s clip takes ~90 s; onProgress(secs, total) ticks (total is Infinity while the file's length is unknown). Resolves { blob, mime, secs, width, height }.
 */
export async function transcodeVideo(file, { voiceover = null, voiceoverFit = 'post', start = 0, end = null, onProgress = () => {} } = {}) {
  const meta = await probeVideoFile(file);
  const from = Math.max(0, +start || 0);
  const to = end != null && Number.isFinite(+end) ? +end : (Number.isFinite(meta.duration) ? meta.duration : Infinity);
  const total = Math.max(0.5, to - from); // the trimmed span; an unknown length (Infinity) runs to the end of the file
  const scale = Math.min(1, VIDEO_MAX_WIDTH / meta.width);
  const W = Math.round(meta.width * scale / 2) * 2, H = Math.round(meta.height * scale / 2) * 2; // even sizes for H.264
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx2d = canvas.getContext('2d');
  const src = document.createElement('video'); src.src = meta.url; src.muted = true; src.playsInline = true; src.preload = 'auto';
  await new Promise((res, rej) => { src.oncanplay = res; src.onerror = () => rej(new Error('could not load the video')); });
  // Audio: the file's own sound (routed through an AudioContext so nothing plays out loud) or the voiceover.
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ac.createMediaStreamDestination();
  let voNode = null;
  if (voiceover) {
    const buf = await ac.decodeAudioData(await voiceover.arrayBuffer());
    voNode = ac.createBufferSource(); voNode.buffer = buf; voNode.connect(dest);
  } else {
    src.muted = false; src.volume = 1; // the element must be audible to the graph; the graph goes to the recorder only
    try { ac.createMediaElementSource(src).connect(dest); } catch { /* no audio track: silent */ }
  }
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  // Pick an encoder that really works (isTypeSupported alone is not proof — see clips.js).
  let rec = null, chunks = [];
  const tried = [];
  for (const mime of VIDEO_FORMATS.filter(m => MediaRecorder.isTypeSupported?.(m)).concat([''])) {
    try { rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 700_000, audioBitsPerSecond: 48_000 }); } catch { tried.push(mime); continue; }
    chunks = [];
    const alive = await new Promise(res => {
      let settled = false; const done = v => { if (!settled) { settled = true; res(v); } };
      rec.ondataavailable = e => { if (e.data.size) { chunks.push(e.data); done(true); } };
      rec.onerror = () => done(false);
      try { rec.start(500); } catch { done(false); }
      ctx2d.drawImage(src, 0, 0, W, H);
      setTimeout(() => done(rec.state === 'recording' && chunks.length > 0), 1500);
    });
    if (alive) break;
    tried.push(mime || 'default');
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* dead */ }
    rec = null;
  }
  if (!rec) { ac.close(); URL.revokeObjectURL(meta.url); throw new Error(`this browser can’t encode video (tried ${tried.join(', ')})`); }
  const mime = rec.mimeType || 'video/webm';
  // The probe's take was a still frame: throw it away and start a fresh recorder for the real one.
  await new Promise(res => { rec.onstop = res; rec.ondataavailable = null; try { rec.stop(); } catch { res(); } });
  rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 700_000, audioBitsPerSecond: 48_000 });
  chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });
  rec.start(500);
  if (from > 0) await new Promise(res => { src.onseeked = () => { src.onseeked = null; res(); }; src.currentTime = from; });
  else src.currentTime = 0;
  await ac.resume();
  // Timeline: the voiceover runs from 0 to voLen. The picture starts at `lead` (0 unless the audio is longer and
  // fits 'pre'), plays for `total` (or until the file ends), and then holds its last frame until the audio is done.
  const voLen = voNode ? voNode.buffer.duration : 0;
  const lead = voNode && voiceoverFit === 'pre' ? Math.max(0, voLen - total) : 0;
  const outLen = Math.max(total, voLen);
  let playing = false, videoDone = false;
  if (!lead) { await src.play(); playing = true; }
  const t0 = performance.now();
  if (voNode) voNode.start();
  const elapsed = () => (performance.now() - t0) / 1000;
  await new Promise(res => {
    const tick = () => {
      const e = elapsed();
      if (!playing && e >= lead) { playing = true; src.play().catch(() => { videoDone = true; }); }
      ctx2d.drawImage(src, 0, 0, W, H); // a held frame is redrawn every tick so the capture stream keeps emitting it
      if (playing && !videoDone && (src.ended || src.currentTime - from >= total)) { videoDone = true; src.pause(); }
      onProgress(Math.min(e, outLen), outLen);
      if (videoDone && (!voNode || e >= voLen)) { res(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  src.pause();
  try { voNode?.stop(); } catch { /* fine */ }
  rec.stop();
  await stopped;
  ac.close();
  URL.revokeObjectURL(meta.url);
  const secs = Math.round(Math.min(outLen, elapsed()) * 10) / 10;
  return { blob: new Blob(chunks, { type: mime }), mime, secs, width: W, height: H };
}

/** Split a blob into base64 chunks that fit Firestore documents. */
export async function blobToChunks(blob, rawBytes = 700_000) {
  const out = [];
  for (let off = 0; off < blob.size; off += rawBytes) {
    const part = blob.slice(off, off + rawBytes);
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(part); });
    out.push(b64);
  }
  return out;
}
export function chunksToBlob(b64s, mime) {
  const parts = b64s.map(b64 => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; });
  return new Blob(parts, { type: mime });
}
