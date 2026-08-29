// Pure SVG-string rendering of drill objects.
import { smoothPath } from './geometry.js';
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

function handles(pts) {
  return pts.map((p, i) => `<circle class="handle" data-handle="${i}" cx="${n(p.x)}" cy="${n(p.y)}" r="1"/>`).join('');
}

const Z_ORDER = ['zone', 'barricade', 'obstacle', 'net', 'arrow', 'tire', 'cone', 'text', 'coach', 'skater', 'puck'];

export function renderObjects(drill, selId, opts = {}) {
  const objs = drill.objects
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (Z_ORDER.indexOf(a.o.type) - Z_ORDER.indexOf(b.o.type)) || (a.i - b.i))
    .map(x => x.o);
  const o2 = { ...opts, sim: opts.sim || makeSim(drill) };
  return objs.map(o => (draw[o.type] ? draw[o.type](o, o.id === selId, o2) : '')).join('');
}

const draw = {
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

  puck(o, sel, opts) {
    const sim = opts.sim;
    const ps = sim.puck(o.id);
    const pos = sim.puckPos(o.id, 0);
    const lines = ps.info.filter(r => r.ok && r.from).map(r => r.type === 'pass'
      ? `<line class="pass-line" x1="${n(r.from.x)}" y1="${n(r.from.y)}" x2="${n(r.to.x)}" y2="${n(r.to.y)}"/>${arrowHead([r.from, r.to], '#333', 1.6)}`
      : `<line class="shot-line" x1="${n(r.from.x)}" y1="${n(r.from.y)}" x2="${n(r.to.x)}" y2="${n(r.to.y)}"/>${arrowHead([r.from, r.to], '#333', 2)}`
    ).join('');
    const letter = { pass: 'P', shoot: 'S', pickup: 'U' };
    const marks = ps.info.map((r, i) => r.ok && r.mark
      ? `<g class="ev-mark ${r.type}${sel ? ' draggable' : ''}" data-evmark="${i}" transform="translate(${n(r.mark.x)} ${n(r.mark.y)})"><circle r="1.25"/><text y=".55" font-size="1.5" text-anchor="middle">${letter[r.type] || '?'}</text></g>`
      : '').join('');
    return `<g class="obj puck" data-id="${o.id}"><g class="puck-lines">${lines}</g>${marks}
      <g class="puck-disc" data-puck="${o.id}" transform="translate(${n(pos.x)} ${n(pos.y)})"><circle r="1.6" fill="transparent"/><circle r=".65" class="puck"/>${sel ? '<circle r="1.3" class="puck-ring"/>' : ''}</g></g>`;
  },

  coach(o) {
    const color = SKATER_COLORS[o.color] || o.color || SKATER_COLORS.black;
    const textFill = (o.color === 'white' || o.color === 'yellow') ? '#111' : '#fff';
    return `<g class="obj coach" data-id="${o.id}">
      <g class="coach-body" transform="translate(${n(o.x)} ${n(o.y)})">
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
    let path = '';
    if (o.path?.length && opts.showPaths !== false) {
      const dense = smoothPath(skaterPoints(o));
      path = `<polyline class="path-line" points="${ptsStr(dense)}" stroke="${color}" ${o.backward ? 'stroke-dasharray="1.5 1.2"' : ''}/>${arrowHead(dense, color)}`;
    }
    const h = sel ? handles(o.path || []) : '';
    const body = o.role === 'G'
      ? `<rect class="body" x="-1.8" y="-1.8" width="3.6" height="3.6" rx=".7" fill="${color}"/>`
      : `<circle class="body" r="1.75" fill="${color}"/>`;
    const textFill = (o.color === 'white' || o.color === 'yellow') ? '#111' : '#fff';
    const wps = opts.numberWaypoints && o.path?.length
      ? o.path.map((p, i) => `<g class="wp-label" transform="translate(${n(p.x)} ${n(p.y)})"><circle r="1.1"/><text y=".5" font-size="1.4" text-anchor="middle">${i + 1}</text></g>`).join('')
      : '';
    return `<g class="obj skater" data-id="${o.id}">${path}${h}${wps}
      <g class="skater-body" data-skater="${o.id}" transform="translate(${n(o.x)} ${n(o.y)})">
        ${body}<text y=".7" font-size="1.9" text-anchor="middle" fill="${textFill}" font-weight="700">${esc(o.label)}</text>
      </g>
    </g>`;
  },
};

/** Standalone SVG document string for export/print. */
export function standaloneSVG(drill, rinkSVG, style, view) {
  const v = view || drill.view;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(v.x)} ${n(v.y)} ${n(v.w)} ${n(v.h)}" width="${n(v.w * 6)}" height="${n(v.h * 6)}">
  <style>${style}</style><rect x="${n(v.x)}" y="${n(v.y)}" width="${n(v.w)}" height="${n(v.h)}" fill="#fff"/>
  ${rinkSVG}${renderObjects(drill, null)}</svg>`;
}
