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
export const clipKey = (owner, pid, did) => `${owner}/${pid}/${did}`;
export const idbGetClip = key => tx('readonly', s => s.get(key));
export const idbPutClip = (key, val) => tx('readwrite', s => s.put(val, key));
export const idbDelClip = key => tx('readwrite', s => s.delete(key));

export const canRecord = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
/** Recording format: AAC in mp4 plays on every phone; Opus in WebM is the fallback where the browser can't write mp4. */
export function pickMime() {
  // AAC first: plain 'audio/mp4' can come back as Opus-in-MP4 (Chrome), which iPhones don't play.
  return ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4;codecs=aac', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported?.(m)) || '';
}
export const canPlay = mime => !!document.createElement('audio').canPlayType(String(mime || '').split(';')[0]);

/** Start recording from the microphone; `stop()` resolves { blob, mime, secs }. Stops itself at maxSecs. */
export async function startRecording({ maxSecs = 90 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 }); // speech: 32 kb/s is plenty
  const chunks = [];
  const t0 = performance.now();
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(res => {
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const type = rec.mimeType || mime || 'audio/webm';
      res({ blob: new Blob(chunks, { type }), mime: type, secs: Math.round((performance.now() - t0) / 100) / 10 });
    };
  });
  rec.start(250);
  const timer = setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, maxSecs * 1000);
  return { stop() { clearTimeout(timer); if (rec.state === 'recording') rec.stop(); return done; }, since: t0 };
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
