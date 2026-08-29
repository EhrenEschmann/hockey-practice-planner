// Rink drawing. Coordinates are feet; origin top-left; NHL-size 200 x 85.

export const RINK = { W: 200, H: 85, R: 28 };

export const VIEWS = {
  full:      { x: -3,   y: -3, w: 206, h: 91 },
  leftHalf:  { x: -3,   y: -3, w: 106, h: 91 },
  rightHalf: { x: 97,   y: -3, w: 106, h: 91 },
  leftZone:  { x: -3,   y: -3, w: 82,  h: 91 },
  neutral:   { x: 72,   y: -3, w: 56,  h: 91 },
  rightZone: { x: 121,  y: -3, w: 82,  h: 91 },
};

export const SVG_STYLE = `
  .ice{fill:#f7fbff}
  .boards{fill:none;stroke:#1d2430;stroke-width:1.2}
  .goal-line{stroke:#d7263d;stroke-width:.35}
  .blue-line{fill:#1f5fd6}
  .red-line{fill:#d7263d}
  .circle-blue{fill:none;stroke:#1f5fd6;stroke-width:.3}
  .circle-red{fill:none;stroke:#d7263d;stroke-width:.3}
  .dot-blue{fill:#1f5fd6}
  .dot-red{fill:#d7263d}
  .hash{stroke:#d7263d;stroke-width:.25}
  .crease{fill:#9ec9ee;fill-opacity:.75;stroke:#d7263d;stroke-width:.3}
  .trap{stroke:#d7263d;stroke-width:.3}
  .path-line{fill:none;stroke-width:.6;stroke-linecap:round;stroke-linejoin:round}
  .arrow-line{fill:none;stroke-width:.6;stroke-linecap:round;stroke-linejoin:round}
  .skater-body .body{stroke:#fff;stroke-width:.3}
  .skater-body text{font-family:system-ui,sans-serif;pointer-events:none}
  .coach-body .body{stroke:#fff;stroke-width:.35}
  .stick .shaft{stroke:#5b3a17;stroke-width:.38;stroke-linecap:round}
  .stick .blade{stroke:#111;stroke-width:.5;stroke-linecap:round}
  .coach-body text{font-family:system-ui,sans-serif;pointer-events:none}
  .drop-preview{opacity:.65;pointer-events:none}
  .puck{fill:#111}
  .handle{fill:#fff;stroke:#3b82f6;stroke-width:.35;cursor:move}
  .handle:hover{fill:#bfdbfe}
  .obj{cursor:pointer}
  .selection{fill:none;stroke:#3b82f6;stroke-width:.4;stroke-dasharray:1 .8;pointer-events:none}
  .zone text,.obstacle text,.txt{font-family:system-ui,sans-serif}
  .barricade .core{fill:none;stroke:#222;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
  .pass-line{stroke:#333;stroke-width:.35;stroke-dasharray:1.2 .9}
  .shot-line{stroke:#333;stroke-width:.6}
  .puck-ring{fill:none;stroke:#3b82f6;stroke-width:.3}
  .wp-label circle{fill:#fff;stroke:#555;stroke-width:.2}
  .wp-label text{fill:#333;font-family:system-ui,sans-serif;font-weight:700;pointer-events:none}
  .barricade .stripe{fill:none;stroke:#f5a623;stroke-width:.7;stroke-dasharray:2 2;stroke-linecap:butt}
`;

export function rinkSVG() {
  const { W, H, R } = RINK;
  const cx = W / 2, cy = H / 2;
  const p = [];
  p.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="${R}" ry="${R}" class="ice"/>`);
  p.push(`<clipPath id="rinkClip"><rect x="0" y="0" width="${W}" height="${H}" rx="${R}" ry="${R}"/></clipPath>`);
  p.push(`<g clip-path="url(#rinkClip)">`);
  // goal lines
  for (const x of [11, W - 11]) p.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" class="goal-line"/>`);
  // trapezoids behind the goals
  p.push(`<line x1="11" y1="${cy - 11}" x2="0" y2="${cy - 14}" class="trap"/><line x1="11" y1="${cy + 11}" x2="0" y2="${cy + 14}" class="trap"/>`);
  p.push(`<line x1="${W - 11}" y1="${cy - 11}" x2="${W}" y2="${cy - 14}" class="trap"/><line x1="${W - 11}" y1="${cy + 11}" x2="${W}" y2="${cy + 14}" class="trap"/>`);
  // blue lines & center line
  for (const x of [75, W - 75]) p.push(`<rect x="${x - 0.5}" y="0" width="1" height="${H}" class="blue-line"/>`);
  p.push(`<rect x="${cx - 0.5}" y="0" width="1" height="${H}" class="red-line"/>`);
  // center circle
  p.push(`<circle cx="${cx}" cy="${cy}" r="15" class="circle-blue"/><circle cx="${cx}" cy="${cy}" r="1" class="dot-blue"/>`);
  // end-zone faceoff circles with hash marks
  for (const x of [31, W - 31]) for (const y of [cy - 22, cy + 22]) {
    p.push(`<circle cx="${x}" cy="${y}" r="15" class="circle-red"/><circle cx="${x}" cy="${y}" r="1" class="dot-red"/>`);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      p.push(`<line x1="${x + sx * 2.8}" y1="${y + sy * 15}" x2="${x + sx * 2.8}" y2="${y + sy * 17}" class="hash"/>`);
    }
  }
  // neutral-zone dots
  for (const x of [80, W - 80]) for (const y of [cy - 22, cy + 22]) p.push(`<circle cx="${x}" cy="${y}" r="1" class="dot-red"/>`);
  // creases
  p.push(crease(11, cy, 1));
  p.push(crease(W - 11, cy, -1));
  p.push(`</g>`);
  p.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="${R}" ry="${R}" class="boards"/>`);
  return p.join('');
}

function crease(x, cy, dir) {
  const sweep = dir > 0 ? 1 : 0;
  const fx = x + 4.5 * dir;
  return `<path class="crease" d="M${x},${cy - 4} L${fx},${cy - 4} A6,6 0 0 ${sweep} ${fx},${cy + 4} L${x},${cy + 4} Z"/>`;
}
