// Written by the hosting predeploy hook (firebase.json): version.json carries a stamp for this deploy. The viewer
// re-reads it when it moves to a practice or the list and when it comes back to the foreground, and reloads itself
// when the stamp has changed — so a phone that has kept the app open for a week still runs the latest viewer.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let hash = '';
try { hash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git checkout */ }
const at = new Date().toISOString();
const v = `${at.replace(/[-:]/g, '').slice(0, 15)}${hash ? `-${hash}` : ''}`;
writeFileSync(new URL('../version.json', import.meta.url), JSON.stringify({ v, at }) + '\n');
console.log(`version.json → ${v}`);
