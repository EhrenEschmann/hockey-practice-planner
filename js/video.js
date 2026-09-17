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
