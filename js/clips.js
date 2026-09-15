// Intro clips: the coach's own recorded voice for a drill, played before the animation when ▶ is pressed.
// The audio bytes never go into the practice document (they would bloat every autosave and overflow the
// browser's small localStorage): they live in IndexedDB on each device and, when signed in, in Firestore
// under the practice (see cloud.js). The drill itself only carries { secs, mime, size, at } metadata.

const DB = 'hpp-clips', STORE = 'clips';
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}
/** Cache key for one recording: versioned by its record time, so a re-recorded intro replaces the old copy on every device. */
export const clipKey = (owner, pid, did, at = 0) => `${owner}/${pid}/${did}@${+at || 0}`;
export const idbGetClip = key => tx('readonly', s => s.get(key));
export const idbPutClip = (key, val) => tx('readwrite', s => s.put(val, key));
export const idbDelClip = key => tx('readwrite', s => s.delete(key));

export const canRecord = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
/**
 * Recording formats, best first. AAC in mp4 plays on every phone; Opus (in mp4 or WebM) is the fallback.
 * `isTypeSupported` is only a claim — Chrome says yes to AAC and then fails with an EncodingError the
 * moment recording starts — so startRecording() tries each format for real and keeps the first that
 * actually delivers audio.
 */
// Opus first: it stays clear for speech at 12 kb/s (~95 KB a minute), less than half of what AAC needs
// (Chrome's AAC encoder floors at ~29 kb/s). AAC is the fallback where a browser can't record Opus (Safari).
const FORMATS = ['audio/mp4;codecs=opus', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'];
const FORMAT_KEY = 'hpp.recmime'; // the format that worked last time on this browser
export const canPlay = mime => !!document.createElement('audio').canPlayType(String(mime || '').split(';')[0]);

/** Start recording from the microphone; `stop()` resolves { blob, mime, secs }. Stops itself at maxSecs. */
export async function startRecording({ maxSecs = 90 } = {}) {
  // Speech only: one channel at a speech sample rate, with the browser's noise suppression on.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  let known = null;
  try { known = localStorage.getItem(FORMAT_KEY); } catch { /* fine */ }
  const order = [...new Set([...(known ? [known] : []), ...FORMATS.filter(m => MediaRecorder.isTypeSupported?.(m)), ''])];
  let rec = null, chunks = [], t0 = 0;
  const tried = [];
  for (const mime of order) {
    // Bandwidth is the cost that matters (every coach's phone downloads each clip once).
    const bps = /opus/i.test(mime) ? 12000 : 24000;
    try { rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: bps }); } catch { tried.push(mime || 'default'); continue; }
    chunks = [];
    // Proof of life: the first chunk with bytes in it (or 700 ms still recording) means the encoder works.
    const alive = await new Promise(res => {
      let settled = false;
      const done = v => { if (!settled) { settled = true; res(v); } };
      rec.ondataavailable = e => { if (e.data.size) { chunks.push(e.data); done(true); } };
      rec.onerror = () => done(false);
      rec.onstop = () => done(false);
      t0 = performance.now();
      try { rec.start(250); } catch { done(false); }
      setTimeout(() => done(rec.state === 'recording'), 700);
    });
    if (alive) break;
    tried.push(mime || 'default');
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* already dead */ }
    rec = null;
  }
  if (!rec) { stream.getTracks().forEach(t => t.stop()); throw new Error(`this browser couldn't encode audio (tried ${tried.join(', ')})`); }
  const mime = rec.mimeType || order[0] || 'audio/webm';
  try { localStorage.setItem(FORMAT_KEY, mime); } catch { /* fine */ }
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.onerror = () => { try { rec.stop(); } catch { /* fine */ } };
  const done = new Promise(res => {
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      res({ blob: new Blob(chunks, { type: mime }), mime, secs: Math.round((performance.now() - t0) / 100) / 10 });
    };
  });
  const timer = setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, maxSecs * 1000);
  return { stop() { clearTimeout(timer); if (rec.state === 'recording') rec.stop(); else if (rec.state === 'inactive') { /* already stopped by an error: onstop has resolved or will */ } return done; }, since: t0 };
}

export const blobToBase64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});
export function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}
