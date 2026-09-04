// Pure SVG-string rendering of drill objects.
import { smoothPath, closestOnPolyline } from './geometry.js';
import { makeSim, skaterPoints } from './sim.js';
export { skaterPoints };

export const SKATER_COLORS = {
  blue: '#1e56d6', red: '#d62828', green: '#1f9d55', black: '#222222',
  yellow: '#e6b800', white: '#f5f5f5', orange: '#f07f13', purple: '#7b3fbf',
};
export const ZONE_COLORS = ['#2b6cb0', '#c05621', '#2f855a', '#805ad5', '#b83280', '#4a5568'];
export const ARROW_STYLES = { skate: 'Skate', pass: 'Pass (dashed)', shot: 'Shot (thick)', backward: 'Backward (dotted)' };

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = v => Math.round((+v || 0) * 100) / 100;
const ptsStr = pts => pts.map(p => `${n(p.x)},${n(p.y)}`).join(' ');

function arrowHead(dense, color, size = 2.2) {
  if (dense.length < 2) return '';
  let i = dense.length - 2;
  while (i > 0 && Math.hypot(dense[i].x - dense[dense.length - 1].x, dense[i].y - dense[dense.length - 1].y) < 0.3) i--;
  const a = dense[i], b = dense[dense.length - 1];
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const p = (r, da) => `${n(b.x + r * Math.cos(ang + da))},${n(b.y + r * Math.sin(ang + da))}`;
  return `<polygon points="${n(b.x)},${n(b.y)} ${p(size, Math.PI - 0.5)} ${p(size, Math.PI + 0.5)}" fill="${color}"/>`;
}

/** Numbered waypoint badges (shown while a puck is selected, or a player is triggered by a waypoint). */
function wpLabels(o) {
  return (o.path || []).map((p, i) => `<g class="wp-label" transform="translate(${n(p.x)} ${n(p.y)})"><circle r="1.1"/><text y=".5" font-size="1.4" text-anchor="middle">${i + 1}</text></g>`).join('');
}

function handles(pts) {
  return pts.map((p, i) => `<circle class="handle" data-handle="${i}" cx="${n(p.x)}" cy="${n(p.y)}" r="1"/>`).join('');
}

// Goalies draw as pseudo-type 'goalie': above pucks so shot lines pass under them.
const Z_ORDER = ['zone', 'barricade', 'obstacle', 'jumppad', 'net', 'arrow', 'tire', 'raisedpad', 'cone', 'minicone', 'pile', 'text', 'coach', 'skater', 'puck', 'goalie', 'contact'];
const zType = o => (o.type === 'skater' && o.role === 'G' ? 'goalie' : o.type);

/** A player's skating path (line + arrowhead), or '' if there is none to draw. Backward stretches (from `backward` / waypoint pivots) draw dotted, with a ⇄ marker at each pivot. */
function playerPath(o, opts) {
  if (!o.path?.length || opts.showPaths === false) return '';
  const isCoach = o.type === 'coach';
  const color = SKATER_COLORS[o.color] || o.color || (isCoach ? SKATER_COLORS.black : SKATER_COLORS.blue);
  const pts = skaterPoints(o);
  const dense = smoothPath(pts);
  const dash = back => isCoach ? 'stroke-dasharray="2.5 1.5"' : back ? 'stroke-dasharray="1.5 1.2"' : '';
  const hit = `<polyline class="path-hit" points="${ptsStr(dense)}"/>`; // fat invisible stroke: forgiving click / double-click target
  const pivots = pts.filter((p, i) => i > 0 && p.pivot);
  if (!pivots.length) return `${hit}<polyline class="path-line" points="${ptsStr(dense)}" stroke="${color}" ${dash(o.backward)}/>${arrowHead(dense, color)}`;
  // Split the line at each pivot; the stretches alternate forward/backward from the start direction.
  const idxOf = p => { let bi = 0, bd = Infinity; for (let i = 0; i < dense.length; i++) { const d = (dense[i].x - p.x) ** 2 + (dense[i].y - p.y) ** 2; if (d < bd) { bd = d; bi = i; } } return bi; };
  const cuts = [0, ...pivots.map(idxOf).sort((a, b) => a - b), dense.length - 1];
  let back = !!o.backward;
  const segs = [];
  for (let s = 0; s + 1 < cuts.length; s++) {
    const slice = dense.slice(cuts[s], cuts[s + 1] + 1);
    if (slice.length > 1) segs.push(`<polyline class="path-line" points="${ptsStr(slice)}" stroke="${color}" ${dash(back)}/>`);
    back = !back;
  }
  const marks = pivots.map(p => `<g class="pivot-mark" transform="translate(${n(p.x)} ${n(p.y)})"><circle r=".95" fill="#fff" stroke="${color}" stroke-width=".3"/><text y=".45" font-size="1.2" text-anchor="middle" fill="${color}">${p.pivot === 'L' ? '⟲' : p.pivot === 'R' ? '⟳' : '⇄'}</text></g>`).join('');
  return hit + segs.join('') + arrowHead(dense, color) + marks;
}

export function renderObjects(drill, selId, opts = {}) {
  const objs = drill.objects
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (Z_ORDER.indexOf(zType(a.o)) - Z_ORDER.indexOf(zType(b.o))) || (a.i - b.i))
    .map(x => x.o);
  const o2 = { ...opts, sim: opts.sim || makeSim(drill), objs: drill.objects };
  // Players' paths all draw in one underlay beneath every player body, so a busy drill's path lines
  // never cover another skater. The underlay groups repeat the player's data-id so clicking a path
  // still selects its player.
  const playerZ = Z_ORDER.indexOf('coach');
  const below = objs.filter(o => Z_ORDER.indexOf(zType(o)) < playerZ);
  const above = objs.filter(o => Z_ORDER.indexOf(zType(o)) >= playerZ);
  const pathLayer = above.filter(o => o.type === 'skater' || o.type === 'coach')
    .map(o => { const p = playerPath(o, o2); return p ? `<g class="obj ${o.type} path-under" data-id="${o.id}">${p}</g>` : ''; }).join('');
  // Raised pads are drawn in two parts: tires in normal order, and the slab on top of everything so
  // skaters visibly slide underneath it.
  return below.map(o => (draw[o.type] ? draw[o.type](o, o.id === selId, o2) : '')).join('')
    + pathLayer
    + above.map(o => (draw[o.type] ? draw[o.type](o, o.id === selId, o2) : '')).join('')
    + objs.filter(o => o.type === 'raisedpad').map(raisedPadTop).join('')
    + shotOverlay(o2);
}

/**
 * Goalies draw above shot lines; so a shot at a defended net stays fully readable, any shot line
 * that passes through a goalie's body is echoed as a translucent copy on top of everything.
 */
function shotOverlay(opts) {
  if (opts.showPaths === false) return ''; // hidden along with the shot lines it echoes
  const goalies = opts.objs.filter(o => o.type === 'skater' && o.role === 'G');
  if (!goalies.length) return '';
  const lines = [];
  for (const o of opts.objs) {
    if (o.type !== 'puck') continue;
    for (const r of opts.sim.puck(o.id).info) {
      if (r.type !== 'shoot' || !r.ok || !r.from) continue;
      const pts = r.bank ? [r.from, r.bank, r.to] : [r.from, r.to];
      if (!goalies.some(g => closestOnPolyline(pts, g).dist < 2.8)) continue;
      lines.push(`<polyline class="shot-line" fill="none" points="${ptsStr(pts)}"/>${arrowHead(pts.slice(-2), '#333', 2)}`);
    }
  }
  return lines.length ? `<g class="shot-overlay">${lines.join('')}</g>` : '';
}

/** An 8-point star as an SVG points string, centred on the origin. */
export function starPoints(r, inner = 0.45) {
  const pts = [];
  for (let k = 0; k < 16; k++) {
    const rr = k % 2 ? r * inner : r, a = k * Math.PI / 8;
    pts.push(`${(rr * Math.cos(a)).toFixed(2)},${(rr * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}


const draw = {
  contact(o, sel, opts) {
    const info = opts.sim.contactSync?.(o.id) || { ok: false };
    return `<g class="obj contact" data-id="${o.id}" transform="translate(${n(o.x)} ${n(o.y)})">
      <circle r="2.7" class="contact-zone"/>
      <polygon class="contact-star" points="${starPoints(1.9)}"/>
      ${info.ok ? `<text class="contact-t" y="4.6" text-anchor="middle">${info.t.toFixed(1)}s</text>` : `<text class="contact-t warn-t" y="4.6" text-anchor="middle">?</text>`}
    </g>`;
  },

  zone(o, sel) {
    const c = o.color || ZONE_COLORS[0];
    return `<g class="obj zone" data-id="${o.id}">
      <rect x="${n(o.x)}" y="${n(o.y)}" width="${n(o.w)}" height="${n(o.h)}" rx=".6" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width=".45" stroke-dasharray="2 1.5"/>
      <text x="${n(o.x + 1.2)}" y="${n(o.y + 3.2)}" font-size="2.8" font-weight="700" fill="${c}">${esc(o.label)}</text>
    </g>`;
  },

  barricade(o, sel) {
    const s = ptsStr(o.points);
    return `<g class="obj barricade" data-id="${o.id}">
      <polyline class="core" points="${s}"/>
      <polyline class="stripe" points="${s}"/>
      ${sel ? handles(o.points) : ''}
    </g>`;
  },

  obstacle(o) {
    const w = o.w || 4, h = o.h || 2;
    return `<g class="obj obstacle" data-id="${o.id}" transform="translate(${n(o.x)} ${n(o.y)}) rotate(${n(o.rot || 0)})">
      <rect x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" rx=".4" fill="#8c93a3" stroke="#3a3f4b" stroke-width=".35"/>
      ${o.label ? `<text y=".6" font-size="${Math.min(2, h * 0.7)}" text-anchor="middle" fill="#111" font-weight="600">${esc(o.label)}</text>` : ''}
    </g>`;
  },

  net(o) {
    return `<g class="obj net" data-id="${o.id}" transform="translate(${n(o.x)} ${n(o.y)}) rotate(${n(o.rot || 0)})">
      <path d="M0,-3 L-3.5,-2.2 L-3.5,2.2 L0,3 Z" fill="#fff" stroke="#d7263d" stroke-width=".45"/>
      <path d="M-1.2,-2.6 L-1.2,2.6 M-2.4,-2.4 L-2.4,2.4 M-3.5,-1 L0,-1 M-3.5,0 L0,0 M-3.5,1 L0,1" stroke="#c99" stroke-width=".15"/>
      <line x1="0" y1="-3" x2="0" y2="3" stroke="#d7263d" stroke-width=".7"/>
    </g>`;
  },

  arrow(o, sel) {
    const color = o.color || '#111';
    const dense = smoothPath(o.points);
    let dash = '';
    if (o.style === 'pass') dash = 'stroke-dasharray="2 1.5"';
    if (o.style === 'backward') dash = 'stroke-dasharray=".4 1.2"';
    const width = o.style === 'shot' ? 'stroke-width="1.1"' : '';
    return `<g class="obj arrow" data-id="${o.id}">
      <polyline class="arrow-line" points="${ptsStr(dense)}" stroke="${color}" ${dash} ${width}/>
      ${arrowHead(dense, color, o.style === 'shot' ? 2.8 : 2.2)}
      ${sel ? handles(o.points) : ''}
    </g>`;
  },

  jumppad(o) {
    const w = o.w || 6, h = o.h || 1.5;
    const stripes = [-1, 0, 1].map(i => `<line x1="${n(i * w / 4 - h / 2)}" y1="${n(-h / 2)}" x2="${n(i * w / 4 + h / 2)}" y2="${n(h / 2)}" stroke="#333" stroke-width=".35"/>`).join('');
    return `<g class="obj jumppad" data-id="${o.id}" transform="translate(${n(o.x)} ${n(o.y)}) rotate(${n(o.rot || 0)})">
      <rect x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" rx=".3" fill="#f4c542" stroke="#333" stroke-width=".35"/>
      ${stripes}
      ${o.label ? `<text y="${n(-h / 2 - 0.6)}" font-size="1.6" text-anchor="middle" fill="#111" font-weight="600">${esc(o.label)}</text>` : ''}
    </g>`;
  },

  raisedpad(o) {
    const w = o.w || 6, h = o.h || 2;
    const tx = Math.max(0, w / 2 - 1.3);
    const tire = x => `<g transform="translate(${n(x)} 0)"><circle r="1.4" fill="#222"/><circle r=".7" fill="#dfe3ea"/></g>`;
    return `<g class="obj raisedpad" data-id="${o.id}" transform="translate(${n(o.x)} ${n(o.y)}) rotate(${n(o.rot || 0)})">
      <rect x="${n(-w / 2)}" y="${n(-h / 2 - 1)}" width="${n(w)}" height="${n(h + 2)}" fill="transparent"/>
      ${tire(-tx)}${tire(tx)}
    </g>`;
  },

  tire(o) {
    return `<g class="obj tire" data-id="${o.id}" transform="translate(${n(o.x)} ${n(o.y)})">
      <circle r="1.4" fill="#222"/><circle r=".7" fill="#dfe3ea"/>
    </g>`;
  },

  cone(o) {
    const c = o.color || '#ff6a00';
    return `<g class="obj cone" data-id="${o.id}" transform="translate(${n(o.x)} ${n(o.y)})">
      <ellipse cy=".7" rx="1.3" ry=".5" fill="#333"/>
      <polygon points="0,-1.4 -1,.7 1,.7" fill="${c}" stroke="#7a3300" stroke-width=".15"/>
    </g>`;
  },

  pile(o, sel, opts) {
    // A heap of pucks: a few discs in a fixed scatter plus a badge with how many are left.
    const spots = [[0, 0], [1.1, .3], [-1, .5], [.4, -1], [-.5, -.9], [1.3, -.8], [-1.3, -.4]];
    const count = Math.max(0, Math.round(+o.count || 0));
    const taken = (opts.objs || []).filter(p => p.type === 'puck' && p.pile === o.id).length;
    const left = Math.max(0, count - taken);
    const discs = spots.slice(0, Math.min(spots.length, Math.max(1, left))).map(([x, y]) => `<circle cx="${n(x)}" cy="${n(y)}" r=".65" class="puck"/>`).join('');
    return `<g class="obj pile" data-id="${o.id}" transform="translate(${n(o.x)} ${n(o.y)})">
      <circle r="3.4" fill="transparent"/>
      <circle r="2.6" fill="#fff" fill-opacity=".6" stroke="#666" stroke-width=".2" stroke-dasharray=".6 .5"/>
      ${discs}
      <g class="pile-badge" transform="translate(2.3 -2.1)"><circle r="1.25" fill="#fff" stroke="#333" stroke-width=".2"/><text class="pile-count" y=".5" font-size="1.4" text-anchor="middle" fill="#111" font-weight="700">${left}</text></g>
    </g>`;
  },

  minicone(o) {
    const c = o.color || '#ffb300';
    return `<g class="obj minicone" data-id="${o.id}" transform="translate(${n(o.x)} ${n(o.y)})">
      <circle r="1.4" fill="transparent"/>
      <ellipse cy=".4" rx=".75" ry=".3" fill="#333"/>
      <polygon points="0,-.9 -.6,.4 .6,.4" fill="${c}" stroke="#7a4a00" stroke-width=".12"/>
    </g>`;
  },

  puck(o, sel, opts) {
    const sim = opts.sim;
    const ps = sim.puck(o.id);
    const pos = sim.puckPos(o.id, 0);
    const lines = opts.showPaths === false ? '' : ps.info.map((r, i) => {
      if (!r.ok || !r.from) return '';
      if (r.type !== 'pass') {
        if (!r.bank) return `<line class="shot-line" x1="${n(r.from.x)}" y1="${n(r.from.y)}" x2="${n(r.to.x)}" y2="${n(r.to.y)}"/>${arrowHead([r.from, r.to], '#333', 2)}`;
        return `<polyline class="shot-line" fill="none" points="${ptsStr([r.from, r.bank, r.to])}"/>${arrowHead([r.bank, r.to], '#333', 2)}
        <g class="bank-mark${sel ? ' draggable' : ''}" data-bank="${i}" transform="translate(${n(r.bank.x)} ${n(r.bank.y)})"><circle r="1.1"/><text y=".5" font-size="1.3" text-anchor="middle">B</text></g>`;
      }
      if (!r.bank) return `<line class="pass-line" x1="${n(r.from.x)}" y1="${n(r.from.y)}" x2="${n(r.to.x)}" y2="${n(r.to.y)}"/>${arrowHead([r.from, r.to], '#333', 1.6)}`;
      return `<polyline class="pass-line" points="${ptsStr([r.from, r.bank, r.to])}"/>${arrowHead([r.bank, r.to], '#333', 1.6)}
        <g class="bank-mark${sel ? ' draggable' : ''}" data-bank="${i}" transform="translate(${n(r.bank.x)} ${n(r.bank.y)})"><circle r="1.1"/><text y=".5" font-size="1.3" text-anchor="middle">B</text></g>`;
    }).join('');
    const letter = { pass: 'P', shoot: 'S', pickup: 'U' };
    const marks = opts.showPaths === false ? '' : ps.info.map((r, i) => r.ok && r.mark
      ? `<g class="ev-mark ${r.type}${r.by === 'receiver' ? ' receive' : ''}${sel ? ' draggable' : ''}" data-evmark="${i}" transform="translate(${n(r.mark.x)} ${n(r.mark.y)})"><circle r="1.25"/><text y=".55" font-size="1.5" text-anchor="middle">${r.by === 'receiver' ? 'R' : letter[r.type] || '?'}</text></g>`
      : '').join('');
    return `<g class="obj puck" data-id="${o.id}"><g class="puck-lines">${lines}</g>${marks}
      <g class="puck-disc" data-puck="${o.id}" transform="translate(${n(pos.x)} ${n(pos.y)})"><circle r="1.6" fill="transparent"/><circle r=".65" class="puck"/>${sel ? '<circle r="1.3" class="puck-ring"/>' : ''}</g></g>`;
  },

  coach(o, sel, opts) {
    const color = SKATER_COLORS[o.color] || o.color || SKATER_COLORS.black;
    const textFill = (o.color === 'white' || o.color === 'yellow') ? '#111' : '#fff';
    const h = sel ? handles(o.path || []) : ''; // the path itself draws in the underlay (see renderObjects)
    const wps = opts.numberWaypoints ? wpLabels(o) : '';
    return `<g class="obj coach" data-id="${o.id}">${h}${wps}
      <g class="coach-body" data-skater="${o.id}" transform="translate(${n(o.x)} ${n(o.y)})">
        <polygon class="body" points="0,-2.5 2.5,0 0,2.5 -2.5,0" fill="${color}"/>
        <text y=".65" font-size="1.8" text-anchor="middle" fill="${textFill}" font-weight="700">${esc(o.label)}</text>
      </g>
    </g>`;
  },

  text(o) {
    return `<g class="obj text" data-id="${o.id}">
      <text class="txt" x="${n(o.x)}" y="${n(o.y)}" font-size="${n(o.size || 3)}" font-weight="600" fill="${o.color || '#111'}">${esc(o.text)}</text>
    </g>`;
  },

  skater(o, sel, opts) {
    const color = SKATER_COLORS[o.color] || o.color || SKATER_COLORS.blue;
    const h = sel && !o.follow ? handles(o.path || []) : ''; // path draws in the underlay; a follower's route is edited via its leader
    const body = o.role === 'G'
      ? `<rect class="body" x="-1.8" y="-1.8" width="3.6" height="3.6" rx=".7" fill="${color}"/>`
      : `<circle class="body" r="1.75" fill="${color}"/>`;
    const textFill = (o.color === 'white' || o.color === 'yellow') ? '#111' : '#fff';
    const wps = opts.numberWaypoints ? wpLabels(o) : '';
    const heading0 = opts.sim ? opts.sim.skaterPose(o.id, 0).heading * 180 / Math.PI : 0; // body facing: path tangent (flipped when backward), or facing when standing
    return `<g class="obj skater" data-id="${o.id}">${h}${wps}
      <g class="skater-body" data-skater="${o.id}" transform="translate(${n(o.x)} ${n(o.y)})">
        <ellipse class="shadow" rx="1.9" ry="1.2" fill="#000" fill-opacity=".22" style="display:none"/>
        <g class="dir" transform="rotate(${n(heading0)})"><polygon points="1.2,-.8 2.75,0 1.2,.8" fill="${color}" stroke="#fff" stroke-width=".22"/></g>
        <g class="figure">${body}<text y=".7" font-size="1.9" text-anchor="middle" fill="${textFill}" font-weight="700">${esc(o.label)}</text></g>
      </g>
    </g>`;
  },
};

/** The slab of a raised pad, drawn above skaters (see renderObjects). */
function raisedPadTop(o) {
  const w = o.w || 6, h = o.h || 2;
  return `<g class="obj raisedpad-top" data-id="${o.id}" transform="translate(${n(o.x)} ${n(o.y)}) rotate(${n(o.rot || 0)})">
    <rect x="${n(-w / 2 + 0.3)}" y="${n(-h / 2 + 0.4)}" width="${n(w)}" height="${n(h)}" rx=".4" fill="#000" fill-opacity=".18"/>
    <rect x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" rx=".4" fill="#c7cdd8" fill-opacity=".85" stroke="#3a3f4b" stroke-width=".35"/>
    ${o.label ? `<text y=".6" font-size="${Math.min(1.8, h * 0.7)}" text-anchor="middle" fill="#111" font-weight="600">${esc(o.label)}</text>` : ''}
  </g>`;
}

/** Standalone SVG document string for export/print. */
export function standaloneSVG(drill, rinkSVG, style, view) {
  const v = view || drill.view;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(v.x)} ${n(v.y)} ${n(v.w)} ${n(v.h)}" width="${n(v.w * 6)}" height="${n(v.h * 6)}">
  <style>${style}</style><rect x="${n(v.x)}" y="${n(v.y)}" width="${n(v.w)}" height="${n(v.h)}" fill="#fff"/>
  ${rinkSVG}${renderObjects(drill, null)}</svg>`;
}
