// Tiny pure helpers shared by every part of the app (a leaf module: it imports nothing,
// so it is safe to use while the editor/present/doc module cycle is still evaluating).
export const $ = s => document.querySelector(s);
export const $$ = s => Array.from(document.querySelectorAll(s));
export const isEditing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
export const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmtSecs = t => Number.isFinite(+t) ? `${Math.floor(+t / 60)}:${String(Math.round(+t % 60)).padStart(2, '0')}` : '?:??';
export function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export const safeName = s => (s || 'practice').replace(/[^\w\-]+/g, '_');
