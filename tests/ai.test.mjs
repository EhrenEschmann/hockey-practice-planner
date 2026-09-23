// js/ai.js: the encrypted key record round-trips (and refuses the wrong passphrase); Claude's layout becomes drill objects.
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, looksLikeKey, DRILL_SCHEMA, systemPrompt, layoutToObjects } from '../js/ai.js';

let n = 0;
const uid = () => `id${++n}`;

// ---- encryption
const rec = await encryptSecret('sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'correct horse');
assert.deepEqual(Object.keys(rec).sort(), ['at', 'cipher', 'data', 'iterations', 'iv', 'kdf', 'salt', 'v']);
assert.ok(!JSON.stringify(rec).includes('sk-ant'), 'the record never carries the key in the clear');
assert.equal(await decryptSecret(rec, 'correct horse'), 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
await assert.rejects(() => decryptSecret(rec, 'wrong'), /wrong passphrase/);
await assert.rejects(() => decryptSecret({}, 'x'), /nothing to unlock/);
const rec2 = await encryptSecret('sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'correct horse');
assert.notEqual(rec2.data, rec.data, 'a fresh salt and iv every time');
assert.ok(looksLikeKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz') && !looksLikeKey('hello') && !looksLikeKey(''));

// ---- schema: closed objects, every property required (what structured outputs needs)
const walk = (s, path = '$') => {
  if (s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object'))) {
    assert.equal(s.additionalProperties, false, `${path} is closed`);
    assert.deepEqual([...(s.required || [])].sort(), Object.keys(s.properties).sort(), `${path} requires every property`);
    for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`);
  }
  if (s.items) walk(s.items, `${path}[]`);
};
walk(DRILL_SCHEMA);

// ---- the system prompt names the half-ice setup for games and what is already on the ice
const sys = systemPrompt({ game: true, view: { x: -3, y: -3, w: 106, h: 91 }, existing: [{ type: 'net', x: 11, y: 42.5, rot: 0 }, { type: 'net', x: 85, y: 42.5, rot: 180 }] });
assert.match(sys, /half-ice game prep/); assert.match(sys, /net at \(11, 43\), mouth facing right/); assert.match(sys, /net at \(85, 43\), mouth facing left/);
assert.doesNotMatch(systemPrompt({ game: false }), /half-ice game prep/);

// ---- layout → objects
const layout = {
  name: '2-on-1', notes: 'Drive wide\nShoot early',
  players: [
    { kind: 'skater', label: '1', side: 'O', role: 'F', x: 95, y: 20, speed: 18, delay: 0, backward: false, startCue: 'Go!', path: [{ x: 60, y: 15, cue: null }, { x: 30, y: 30, cue: 'Shoot' }] },
    { kind: 'skater', label: '2', side: 'O', role: 'F', x: 95, y: 60, speed: 18, delay: 0.5, backward: false, startCue: null, path: [{ x: 40, y: 55, cue: null }] },
    { kind: 'skater', label: '1', side: 'D', role: 'D', x: 60, y: 42, speed: 12, delay: 0, backward: true, startCue: null, path: [{ x: 25, y: 42, cue: null }] },
    { kind: 'skater', label: 'G', side: null, role: 'G', x: 14.5, y: 42.5, speed: 20, delay: 0, backward: false, startCue: null, path: [] },
    { kind: 'coach', label: 'C', side: null, role: 'F', x: 250, y: -4, speed: 10, delay: 0, backward: false, startCue: null, path: [] },
  ],
  pucks: [{ carrier: '1', x: null, y: null, events: [{ type: 'pass', wp: 1, to: '2', targetX: null, targetY: null }, { type: 'shoot', wp: 1, to: null, targetX: 11, targetY: 44 }, { type: 'pass', wp: 2, to: 'nobody', targetX: null, targetY: null }] },
          { carrier: null, x: 50, y: 10, events: [{ type: 'pickup', wp: 0, to: 'D1', targetX: null, targetY: null }] }],
  equipment: [{ type: 'cone', x: 70, y: 10, rot: null }, { type: 'net', x: 189, y: 42.5, rot: null }, { type: 'pile', x: 98, y: 5, rot: null }],
  zones: [{ label: 'Slot', x: 15, y: 30, w: 25, h: 25, constraints: 'One touch' }],
  labels: [{ text: 'Start', x: 96, y: 40 }],
};
const objs = layoutToObjects(layout, { uid });
const skaters = objs.filter(o => o.type === 'skater');
assert.equal(skaters.length, 4);
assert.deepEqual(skaters.map(s => [s.label, s.color, s.role, s.side ?? null]), [['1', 'blue', 'F', 'O'], ['2', 'blue', 'F', 'O'], ['1', 'red', 'D', 'D'], ['G', 'green', 'G', null]]);
assert.equal(skaters[0].startCue, 'Go!'); assert.equal(skaters[0].path[1].cue, 'Shoot'); assert.equal('cue' in skaters[0].path[0], false);
assert.equal(skaters[2].backward, true);
const coach = objs.find(o => o.type === 'coach');
assert.deepEqual([coach.x, coach.y], [200, 0], 'coordinates are clamped to the rink');
const pucks = objs.filter(o => o.type === 'puck');
assert.equal(pucks[0].carrier, skaters[0].id, 'carrier resolved by label');
assert.deepEqual([pucks[0].x, pucks[0].y], [skaters[0].x, skaters[0].y], 'a carried puck starts on its carrier');
assert.deepEqual(pucks[0].events, [{ type: 'pass', wp: 1, to: skaters[1].id }, { type: 'shoot', wp: 1, target: { x: 11, y: 44 } }], 'a pass to an unknown label is dropped');
assert.deepEqual(pucks[1].events, [{ type: 'pickup', skater: skaters[2].id, wp: 0 }], '"D1" resolves the defender labelled 1');
assert.equal(objs.find(o => o.type === 'net').rot, 180, 'a net on the right faces left by default');
assert.equal(objs.find(o => o.type === 'pile').count, 12);
const zone = objs.find(o => o.type === 'zone');
assert.deepEqual([zone.x, zone.y, zone.w, zone.h, zone.label, zone.constraints], [15, 30, 25, 25, 'Slot', 'One touch']);
assert.equal(objs.find(o => o.type === 'text').text, 'Start');
assert.equal(new Set(objs.map(o => o.id)).size, objs.length, 'fresh unique ids');
assert.deepEqual(layoutToObjects({}, { uid }), [], 'an empty layout is nothing');

console.log('ai.js: all assertions passed');
