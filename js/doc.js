// The practice document helpers every screen shares: the share view a drill is shown through
// outside the editor, and the clock / date wording. Printing and the PNG exports live in print.js.
import * as G from './geometry.js';
import { RINK } from './rink.js';
import { usDate, isGame } from './store.js';
import { $ } from './ui.js';
import { drill, drillPoints } from './core.js';

/**
 * The window a drill is shown through outside the editor: its saved view, widened just enough that nothing
 * in the drill is cropped — a wheel zoom left in the editor must never cut a coach's animation short.
 */
function shareView(d) {
  // A focus area says exactly which space the drill is about: show that whole box, and nothing more.
  const boxes = d.objects.filter(o => o.type === 'focus' && o.w > 0 && o.h > 0);
  if (boxes.length) {
    const bx0 = Math.min(...boxes.map(b => b.x)) - 3, by0 = Math.min(...boxes.map(b => b.y)) - 3;
    const bx1 = Math.max(...boxes.map(b => b.x + b.w)) + 3, by1 = Math.max(...boxes.map(b => b.y + b.h)) + 3;
    return { x: G.round1(bx0), y: G.round1(by0), w: G.round1(bx1 - bx0), h: G.round1(by1 - by0) };
  }
  const v = { ...d.view };
  let x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.h;
  for (const q of drillPoints(d)) { x0 = Math.min(x0, q.x - 4); y0 = Math.min(y0, q.y - 4); x1 = Math.max(x1, q.x + 4); y1 = Math.max(y1, q.y + 4); }
  // never beyond a comfortable margin around the boards
  x0 = Math.max(-6, x0); y0 = Math.max(-6, y0); x1 = Math.min(RINK.W + 6, x1); y1 = Math.min(RINK.H + 6, y1);
  return { x: G.round1(x0), y: G.round1(y0), w: G.round1(x1 - x0), h: G.round1(y1 - y0) };
}
/** The drills the team actually gets: a hidden drill stays in the editor (to come back to) but is left out of the plan. */
const activeDrills = p => p.drills.filter(d => !d.hidden);
const parseStart = p => !isGame(p) && /^\d{1,2}:\d{2}$/.test(p.time || '') ? p.time.split(':').reduce((h, m) => +h * 60 + +m) : null; // a game's time is when it starts, not a running clock
// Every date and time the app shows is US format: mm/dd/yyyy @ hh:mm AM/PM (never the browser's locale).
const pad2 = n => String(n).padStart(2, '0');
const clock = m => `${pad2(((Math.floor(m / 60) + 11) % 12) + 1)}:${pad2(m % 60)}`; // minutes since midnight → "05:00"
const ampm = m => (Math.floor(m / 60) % 24) < 12 ? ' AM' : ' PM';
const clockFull = m => clock(m) + ampm(m);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "Mon 09/21/2026" (long: "Monday 09/21/2026") — the viewer always says which day of the week a practice is. */
const dayDate = (date, long = false) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return date || 'no date';
  const wd = WEEKDAYS[new Date(date + 'T12:00').getDay()];
  return `${long ? wd : wd.slice(0, 3)} ${usDate(date)}`;
};
const startLabel = x => { const m = parseStart(x); return m != null ? clockFull(m) : ''; };
/** A practice's date and start time: "Mon 09/21/2026 @ 05:00 PM". */
const whenLabel = (x, long = false) => `${dayDate(x.date, long)}${startLabel(x) ? ` @ ${startLabel(x)}` : ''}`;
/** A timestamp: "09/21/2026 @ 05:07 PM". */
const stamp = ms => { const d = new Date(ms); return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()} @ ${clockFull(d.getHours() * 60 + d.getMinutes())}`; };
const todayISO = () => { const n = new Date(); return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`; };
const longDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? dayDate(date, true) : (date || '');

export { activeDrills, clock, clockFull, dayDate, pad2, parseStart, shareView, stamp, todayISO, whenLabel };
