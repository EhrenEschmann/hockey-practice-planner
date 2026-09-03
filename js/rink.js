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

/** Nearest point on the boards (the rounded-rectangle rink edge) to p. */
export function nearestBoardPoint(p) {
  const { W, H, R } = RINK;
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // The boards are everywhere exactly R from the inner rectangle [R, W-R] x [R, H-R].
  const qx = cl(p.x, R, W - R), qy = cl(p.y, R, H - R);
  const dx = p.x - qx, dy = p.y - qy, d = Math.hypot(dx, dy);
  if (d > 1e-9) return { x: qx + dx / d * R, y: qy + dy / d * R };
  // Inside the inner rectangle: head straight for the nearest board.
  const sides = [[p.x - R, -1, 0], [W - R - p.x, 1, 0], [p.y - R, 0, -1], [H - R - p.y, 0, 1]];
  const [dd, nx, ny] = sides.sort((a, b) => a[0] - b[0])[0];
  return { x: p.x + nx * (dd + R), y: p.y + ny * (dd + R) };
}

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
  .skater-body.sliding .body{stroke-dasharray:.6 .4}
  .skater-body text{font-family:system-ui,sans-serif;pointer-events:none}
  .coach-body .body{stroke:#fff;stroke-width:.35}
  .coach-body text{font-family:system-ui,sans-serif;pointer-events:none}
  .drop-preview{opacity:.65;pointer-events:none}
  .puck{fill:#111}
  .pile-count{font-family:system-ui,sans-serif;pointer-events:none}
  .handle{fill:#fff;stroke:#3b82f6;stroke-width:.35;cursor:move}
  .handle:hover{fill:#bfdbfe}
  .obj{cursor:pointer}
  .selection{fill:none;stroke:#3b82f6;stroke-width:.4;stroke-dasharray:1 .8;pointer-events:none}
  .zone text,.obstacle text,.txt{font-family:system-ui,sans-serif}
  .barricade .core{fill:none;stroke:#222;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
  .pass-line{fill:none;stroke:#333;stroke-width:.35;stroke-dasharray:1.2 .9}
  .bank-mark circle{fill:#fff;stroke:#f07f13;stroke-width:.35}
  .bank-mark text{fill:#333;font-family:system-ui,sans-serif;font-weight:700;pointer-events:none}
  .bank-mark.draggable{cursor:move}
  .bank-mark.draggable circle{stroke:#3b82f6;stroke-width:.45}
  .shot-line{stroke:#333;stroke-width:.35}
  .shot-overlay{opacity:.5;pointer-events:none}
  .puck-ring{fill:none;stroke:#3b82f6;stroke-width:.3}
  .ev-mark circle{fill:#fff;stroke:#333;stroke-width:.3}
  .ev-mark.shoot circle{stroke:#d7263d}
  .ev-mark.receive circle{stroke:#1f9d55}
  .ev-mark text{fill:#333;font-family:system-ui,sans-serif;font-weight:700;pointer-events:none}
  .ev-mark.draggable{cursor:move}
  .ev-mark.draggable circle{stroke:#3b82f6;stroke-width:.4}
  .wp-label circle{fill:#fff;stroke:#555;stroke-width:.2}
  .wp-label text{fill:#333;font-family:system-ui,sans-serif;font-weight:700;pointer-events:none}
  .contact-zone{fill:#f59e0b;fill-opacity:.12;stroke:#b45309;stroke-width:.28;stroke-dasharray:.9 .7}
  .contact-t{font-family:system-ui,sans-serif;font-size:1.5px;font-weight:700;fill:#b45309}
  .warn-t{fill:#dc2626}
  .contact-star{fill:#f59e0b;fill-opacity:.9;stroke:#b45309;stroke-width:.25}
  .fx-burst{pointer-events:none}
  .skater-body.hit .body{stroke:#dc2626;stroke-width:.5}
  .fx-burst polygon{fill:#fbbf24;stroke:#b45309;stroke-width:.2}
  .fx-burst circle{fill:none;stroke:#f59e0b;stroke-width:.4}
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
