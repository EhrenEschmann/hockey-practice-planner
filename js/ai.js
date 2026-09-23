// AI help for the planner: "describe a coaching point / drill" and Claude lays it out on the rink.
//
// Two halves. (1) The planner's Anthropic API key, kept encrypted: the browser derives an AES-GCM key from a
// passphrase (PBKDF2) and stores only ciphertext + salt in the planner's private Firestore document, so the key
// is never in the clear anywhere but the unlocked browser. (2) Generation: one Messages API call with a JSON
// schema (structured outputs), whose answer is converted into ordinary drill objects — skaters with paths, pucks
// with passes and shots, equipment, zones, labels — exactly what the editor would have made by hand.

export const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm'; // the official SDK, as a browser module (this site has no bundler)
export const MODEL = 'claude-opus-5';
export const KDF_ITERATIONS = 310_000;

// ---------- encryption ----------
const te = new TextEncoder(), td = new TextDecoder();
const toB64 = u8 => btoa(String.fromCharCode(...u8));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** Encrypt a secret with a passphrase. Returns a plain record safe to store anywhere: { v, kdf, iterations, salt, iv, data, at }. */
export async function encryptSecret(secret, passphrase) {
  if (!passphrase) throw new Error('a passphrase is required');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(secret)));
  return { v: 1, kdf: 'PBKDF2-SHA256', cipher: 'AES-256-GCM', iterations: KDF_ITERATIONS, salt: toB64(salt), iv: toB64(iv), data: toB64(data), at: Date.now() };
}
/** Decrypt a record made by encryptSecret. Throws when the passphrase is wrong (GCM refuses to open it). */
export async function decryptSecret(rec, passphrase) {
  if (!rec?.data || !rec.salt || !rec.iv) throw new Error('nothing to unlock');
  const key = await deriveKey(passphrase, fromB64(rec.salt), +rec.iterations || KDF_ITERATIONS);
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(rec.iv) }, key, fromB64(rec.data)); }
  catch { throw new Error('wrong passphrase'); }
  return td.decode(plain);
}
/** A plausible Anthropic key: they start with sk-ant-. Only a sanity check before a request is sent. */
export const looksLikeKey = k => /^sk-ant-[\w-]{20,}$/.test(String(k || '').trim());

// ---------- what Claude returns ----------
// Every property is required and objects are closed (what structured outputs wants); "optional" fields are nullable.
const num = { type: 'number' }, str = { type: 'string' }, nstr = { type: ['string', 'null'] }, nnum = { type: ['number', 'null'] };
const obj = (properties, description) => ({ type: 'object', ...(description ? { description } : {}), properties, required: Object.keys(properties), additionalProperties: false });
export const DRILL_SCHEMA = obj({
  name: { ...str, description: 'Short title, e.g. "2-on-1 rush from the divider"' },
  notes: { ...str, description: 'Coaching points for the coach to read, 2-6 short lines separated by newlines' },
  players: { type: 'array', items: obj({
    kind: { type: 'string', enum: ['skater', 'coach'] },
    label: { ...str, description: 'Short label: skaters are numbered per side ("1", "2"…), goalies "G", coaches "C"' },
    side: { type: ['string', 'null'], enum: ['O', 'D', null], description: 'Offense (blue) or defense (red) for skaters; null for goalies and coaches' },
    role: { type: 'string', enum: ['F', 'D', 'G'], description: 'F forward, D defenceman, G goalie (coaches: F)' },
    x: num, y: num,
    speed: { ...num, description: 'ft/s along the path' },
    delay: { ...num, description: 'seconds to wait before starting to skate' },
    backward: { type: 'boolean', description: 'skates backward (defenders gapping up)' },
    startCue: { ...nstr, description: 'What the coach says as this player starts, or null' },
    path: { type: 'array', items: obj({ x: num, y: num, cue: { ...nstr, description: 'Spoken cue on reaching this waypoint, or null' } }), description: 'Waypoints in order; empty for a player who stands still' },
  }) },
  pucks: { type: 'array', items: obj({
    carrier: { ...nstr, description: 'Label of the player who starts with this puck, or null for a loose puck' },
    x: nnum, y: nnum,
    events: { type: 'array', items: obj({
      type: { type: 'string', enum: ['pass', 'shoot', 'pickup'] },
      wp: { type: 'integer', description: 'Waypoint index of the carrier where it happens: 0 = their start spot, 1 = first waypoint…' },
      to: { ...nstr, description: 'pass: receiver label; pickup: who picks a loose puck up; shoot: null' },
      targetX: nnum, targetY: nnum,
    }), description: 'In order. A shot with no target goes at the nearest net' },
  }) },
  equipment: { type: 'array', items: obj({
    type: { type: 'string', enum: ['cone', 'minicone', 'tire', 'net', 'pile'] },
    x: num, y: num,
    rot: { ...nnum, description: 'nets only: 0 = mouth faces +x (right), 180 = faces left, 90 = faces down the screen, 270 = up' },
  }) },
  zones: { type: 'array', items: obj({ label: str, x: num, y: num, w: num, h: num, constraints: { ...nstr, description: 'Station rules, one per line, or null' } }), description: 'Rectangles marking areas or stations (top-left corner, size)' },
  labels: { type: 'array', items: obj({ text: str, x: num, y: num }), description: 'Short text annotations on the ice' },
}, 'One drill or coaching point laid out on the rink');

export const RINK_GUIDE = `Rink coordinates are feet, origin at the top-left corner of a 200 x 85 NHL rink: x runs 0 (left end boards) to 200 (right end boards), y runs 0 (top boards) to 85 (bottom boards). Goal lines are at x = 11 and x = 189 with the nets centred on y = 42.5; a net at x = 11 faces +x (rot 0), one at x = 189 faces −x (rot 180). Blue lines are at x = 75 and 125, the centre red line at x = 100, the centre circle radius 15. End-zone faceoff dots are at (31, 20.5), (31, 64.5), (169, 20.5), (169, 64.5); neutral-zone dots at x = 80 / 120, same y. A goalie standing in a crease is about 3.5 ft in front of the goal line (x ≈ 14.5 or 185.5).`;

/** The system prompt: rink facts, what is already on the ice, and how the animation reads the numbers. */
export function systemPrompt({ game = false, view = null, existing = [] } = {}) {
  const box = view ? `The drawing is set to the view x ${Math.round(view.x)}–${Math.round(view.x + view.w)}, y ${Math.round(view.y)}–${Math.round(view.y + view.h)}; keep everything inside it.` : '';
  const have = existing.length ? `Already on the ice (do not add these again): ${existing.map(o => `${o.type}${o.label ? ` "${o.label}"` : ''} at (${Math.round(o.x)}, ${Math.round(o.y)})${o.type === 'net' ? `, mouth facing ${({ 0: 'right', 90: 'down', 180: 'left', 270: 'up' })[((o.rot || 0) % 360 + 360) % 360] || o.rot + '°'}` : ''}`).join('; ')}.` : '';
  return [
    `You lay out youth hockey ${game ? 'game coaching points' : 'practice drills'} on a rink diagram for a coach. Answer only with the JSON the schema asks for.`,
    RINK_GUIDE,
    game ? 'This is half-ice game prep for mites (8U): play uses the left half of the rink, x from 0 to 100. Dividing boards run along x = 100, so nothing crosses it. The two nets are already placed (see below): the real one on the goal line at (11, 42.5) facing right and a second at (85, 42.5) facing left.' : '',
    box, have,
    'How the animation reads your numbers: each player skates their path waypoint by waypoint at `speed` ft/s after `delay` seconds (mites 10–14 ft/s, older kids 15–22; coaches ~10). A pass or shot happens when its carrier reaches waypoint `wp` (0 = where they start); the receiver should be somewhere sensible at that moment, so give players enough delay or path length that timing works. A puck with a carrier starts on that player, so leave its x/y null. Shots with no target go to the nearest net. Keep it readable: only the players the situation needs, short paths, numbers as labels ("1", "2" per side, "G" for goalies, "C" for coaches). Put the coaching points in `notes` as short lines. Use spoken cues sparingly, only where a coach would call something out.',
  ].filter(Boolean).join('\n\n');
}

/**
 * Ask Claude for a layout. `sdk` is the imported SDK module (default export = the Anthropic client class).
 * Resolves the parsed JSON; throws with a readable message on refusal, truncation or bad JSON.
 */
export async function generateLayout({ sdk, apiKey, prompt, system, model = MODEL, signal = null }) {
  const Anthropic = sdk.default || sdk.Anthropic;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  const res = await client.messages.create({
    model, max_tokens: 16000, system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema: DRILL_SCHEMA } },
  }, signal ? { signal } : undefined);
  if (res.stop_reason === 'refusal') throw new Error(`Claude declined this request${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ''}`);
  if (res.stop_reason === 'max_tokens') throw new Error('the answer was cut off — try a simpler description');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try { return { layout: JSON.parse(text), usage: res.usage }; } catch { throw new Error('Claude did not return a usable layout — try again'); }
}

// ---------- from Claude's answer to drill objects ----------
const isNum = v => v != null && v !== '' && Number.isFinite(+v); // null is "not given", never 0
const clampRink = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(+v) ? +v : lo));
const px = v => Math.round(clampRink(v, 0, 200) * 10) / 10, py = v => Math.round(clampRink(v, 0, 85) * 10) / 10;
export const ZONE_PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6'];
/**
 * Turn a layout into the editor's objects (fresh ids, labels resolved to ids). `uid` makes ids; `zoneColors` is the
 * editor's palette. Anything unusable (a pass to an unknown label, a coordinate off the rink) is dropped or clamped.
 */
export function layoutToObjects(layout, { uid, zoneColors = ZONE_PALETTE } = {}) {
  const out = [], byLabel = new Map();
  const skaterIds = new Set();
  for (const p of layout.players || []) {
    const id = uid();
    const path = (p.path || []).map(w => ({ x: px(w.x), y: py(w.y), ...(w.cue ? { cue: String(w.cue) } : {}) }));
    const label = String(p.label || '').slice(0, 4) || (p.kind === 'coach' ? 'C' : '?');
    if (p.kind === 'coach') out.push({ id, type: 'coach', x: px(p.x), y: py(p.y), label, speed: clampRink(p.speed || 10, 1, 40), delay: clampRink(p.delay, 0, 120), path });
    else {
      const role = ['F', 'D', 'G'].includes(p.role) ? p.role : 'F';
      const side = role === 'G' ? null : (p.side === 'D' ? 'D' : 'O');
      out.push({ id, type: 'skater', x: px(p.x), y: py(p.y), label, color: role === 'G' ? 'green' : side === 'D' ? 'red' : 'blue', role, speed: clampRink(p.speed || 18, 1, 40), delay: clampRink(p.delay, 0, 120), backward: !!p.backward, path, ...(side ? { side } : {}), ...(p.startCue ? { startCue: String(p.startCue) } : {}) });
      skaterIds.add(id);
    }
    if (!byLabel.has(label)) byLabel.set(label, id);
    if (p.side && !byLabel.has(`${p.side}${label}`)) byLabel.set(`${p.side}${label}`, id); // "O1" / "D2" also resolve
  }
  const playerId = label => (label == null ? null : byLabel.get(String(label).trim()) ?? byLabel.get(String(label).trim().toUpperCase()) ?? null);
  const at = id => out.find(o => o.id === id);
  for (const pk of layout.pucks || []) {
    const carrier = playerId(pk.carrier);
    const home = carrier ? at(carrier) : null;
    const x = home ? home.x : px(pk.x ?? 100), y = home ? home.y : py(pk.y ?? 42.5);
    const events = [];
    for (const ev of pk.events || []) {
      const wp = Math.max(0, Math.round(+ev.wp || 0));
      if (ev.type === 'pass') { const to = playerId(ev.to); if (to) events.push({ type: 'pass', wp, to }); }
      else if (ev.type === 'shoot') events.push({ type: 'shoot', wp, target: isNum(ev.targetX) && isNum(ev.targetY) ? { x: px(ev.targetX), y: py(ev.targetY) } : null });
      else if (ev.type === 'pickup') { const who = playerId(ev.to); if (who) events.push({ type: 'pickup', skater: who, wp }); }
    }
    out.push({ id: uid(), type: 'puck', x, y, carrier, events, passSpeed: 45, shotSpeed: 90 });
  }
  for (const e of layout.equipment || []) {
    const base = { id: uid(), type: e.type, x: px(e.x), y: py(e.y) };
    if (e.type === 'cone') out.push({ ...base, color: '#ff6a00' });
    else if (e.type === 'minicone') out.push({ ...base, color: '#ffb300' });
    else if (e.type === 'tire') out.push(base);
    else if (e.type === 'pile') out.push({ ...base, count: 12 });
    else if (e.type === 'net') out.push({ ...base, rot: isNum(e.rot) ? ((Math.round(+e.rot) % 360) + 360) % 360 : (base.x > 100 ? 180 : 0) });
  }
  (layout.zones || []).forEach((z, i) => {
    const x = px(z.x), y = py(z.y);
    out.push({ id: uid(), type: 'zone', x, y, w: Math.max(2, Math.min(200 - x, +z.w || 20)), h: Math.max(2, Math.min(85 - y, +z.h || 20)), label: String(z.label || `Zone ${i + 1}`).slice(0, 40), color: zoneColors[i % zoneColors.length], ...(z.constraints ? { constraints: String(z.constraints) } : {}) });
  });
  for (const l of layout.labels || []) if (l.text) out.push({ id: uid(), type: 'text', x: px(l.x), y: py(l.y), text: String(l.text).slice(0, 60), size: 3, color: '#111' });
  return out;
}
