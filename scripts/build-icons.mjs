// Regenerates js/icons.js from lucide-static (run: npm run icons)
import { readFileSync, writeFileSync } from 'node:fs';

// app name -> lucide icon candidates (first that exists wins)
const WANTED = {
  select: ['mouse-pointer'], pan: ['hand'], skater: ['user-round', 'user'],
  coach: ['clipboard-list'], goalie: ['shield'], contact: ['zap'], arrow: ['move-up-right', 'arrow-up-right'],
  cone: ['cone', 'triangle'], minicone: ['triangle'], tire: ['life-buoy'], puck: ['circle-dot'],
  pile: ['database'], net: ['grid-3x3', 'grid'], obstacle: ['rectangle-horizontal', 'minus'],
  raisedpad: ['layers', 'layers-3'], jumppad: ['mountain'], barricade: ['construction', 'traffic-cone'],
  zone: ['square-dashed', 'box-select'], text: ['type'], erase: ['eraser'],
  undo: ['undo-2'], redo: ['redo-2'], play: ['play'], pause: ['pause'], stop: ['square'],
  notes: ['sticky-note'], edit: ['pencil'], up: ['chevron-up'], down: ['chevron-down'],
  copy: ['copy'], x: ['x'], check: ['check'], library: ['library', 'library-big'], calendar: ['calendar'],
  prev: ['chevron-left'], next: ['chevron-right'], rotate: ['rotate-cw'], fullscreen: ['maximize'], unfullscreen: ['minimize'],
  list: ['rows-3', 'list'], focus: ['smartphone'], sync: ['refresh-cw'], eye: ['eye'], eyeoff: ['eye-off'], focusarea: ['scan', 'focus'],
  account: ['circle-user', 'user'], signout: ['log-out'], mic: ['mic'], video: ['video', 'clapperboard'],
};

// Hand-drawn, in Lucide's own grammar (24×24, 2px round strokes): what the tool puts on the ice, as the rink draws it.
// These win over the lucide candidates above.
const CUSTOM = {
  skater: '<circle cx="15.5" cy="4.5" r="2.5" /><path d="M13.5 8 8 12.5" /><path d="m8 12.5 5 3-1.5 5.5" /><path d="M8 12.5 2.5 19" /><path d="m12 9.5 3 2 5 7" /><path d="m20 18.5 3-2" />', // a skater in full stride, stick down on the ice
  coach: '<path d="M12 3l9 9-9 9-9-9z" /><path d="M14 10.5a2.6 2.6 0 1 0 0 3" />',                                        // the diamond marker coaches get on the ice, with its C
  goalie: '<path d="M12 2a8 8 0 0 0-8 8v4a8 8 0 0 0 16 0v-4a8 8 0 0 0-8-8z" /><path d="M6.5 9h11" /><path d="M7 14h10" /><path d="M9.5 9v9.5" /><path d="M14.5 9v9.5" />', // a goalie mask: eye bar and cage
  contact: '<circle cx="6.5" cy="12" r="4" /><circle cx="17.5" cy="12" r="4" /><path d="M12 4v3" /><path d="M12 17v3" /><path d="m8.5 5.5 1 2" /><path d="m15.5 5.5-1 2" />', // two players meeting, sparks at the point of contact
  arrow: '<path d="M4 19c3-6 7-10 15-12" /><path d="M13.4 4.8 19 7l-4 4.5" />',                                             // a curving skate path with its head
  minicone: '<path d="m8 17 4-10 4 10" /><ellipse cx="12" cy="18" rx="6" ry="2" />',                                        // a small cone, low in the frame
  tire: '<circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" />',                                              // a tire flat on the ice
  puck: '<ellipse cx="12" cy="9" rx="8" ry="3" /><path d="M4 9v5a8 3 0 0 0 16 0V9" />',                                     // a puck on its side
  pile: '<path d="M4 10h16" /><path d="m5 10 1.6 11h10.8L19 10" /><ellipse cx="9" cy="6.5" rx="3.5" ry="1.5" /><ellipse cx="15.5" cy="5" rx="3.5" ry="1.5" /><path d="M12 5.8V8" />', // the bucket of pucks
  net: '<path d="M7 3v18" /><path d="M7 4h4a8 8 0 0 1 0 16H7" /><path d="M7 12h12" /><path d="M12 4.5v15" />',             // a net from above: goal line, frame, mesh
  obstacle: '<rect x="3" y="7" width="18" height="10" rx="2" /><path d="M8 7v10" /><path d="M16 7v10" />',                 // a padded box
  raisedpad: '<rect x="3" y="5" width="18" height="5" rx="1.5" /><circle cx="7" cy="16" r="3" /><circle cx="17" cy="16" r="3" />', // a pad resting on two tires, seen from the side
  jumppad: '<rect x="3" y="16" width="18" height="4" rx="1" /><path d="M5 13c3-8 11-8 14 0" /><path d="M18.3 8.1 19 12l-3.9-.7" />', // a low pad with the jump over it
  barricade: '<rect x="2" y="9" width="20" height="6" rx="1" /><path d="m7 9-4 4" /><path d="m12 9-5 6" /><path d="m17 9-5 6" /><path d="m21.5 10-4.5 5" />', // a striped divider board
};

const out = {};
const missing = [];
for (const [name, candidates] of Object.entries(WANTED)) {
  if (CUSTOM[name]) { out[name] = { used: 'custom', body: CUSTOM[name] }; continue; }
  let body = null, used = null;
  for (const c of candidates) {
    try {
      const svg = readFileSync(new URL(`../node_modules/lucide-static/icons/${c}.svg`, import.meta.url), 'utf8');
      body = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').replace(/<!--[\s\S]*?-->/g, '').trim().replace(/\n\s*/g, '');
      used = c;
      break;
    } catch { /* try next */ }
  }
  if (!body) { missing.push(`${name} (${candidates.join(', ')})`); continue; }
  out[name] = { used, body };
}
if (missing.length) { console.error('MISSING:', missing.join(' | ')); process.exit(1); }

const lines = Object.entries(out).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v.body)}, // ${v.used === 'custom' ? 'drawn for this app' : `lucide: ${v.used}`}`);
const js = [
  '// Generated by scripts/build-icons.mjs from lucide-static (ISC license, https://lucide.dev) plus the hockey icons drawn there — do not edit by hand.',
  'const ICONS = {',
  ...lines,
  '};',
  '',
  '/** Inline SVG markup for a named icon (24×24 viewBox, stroked with currentColor). */',
  'export function icon(name, cls = \'\') {',
  '  const body = ICONS[name];',
  '  if (!body) return \'\';',
  '  return `<svg class="lucide lucide-${name}${cls ? \' \' + cls : \'\'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;',
  '}',
  '',
  '/** Fill every element carrying data-icon with its SVG. */',
  'export function hydrateIcons(root = document) {',
  '  root.querySelectorAll(\'[data-icon]\').forEach(el => { el.innerHTML = icon(el.dataset.icon); });',
  '}',
  '',
].join('\n');
writeFileSync(new URL('../js/icons.js', import.meta.url), js);
console.log(`js/icons.js: ${Object.keys(out).length} icons`);
