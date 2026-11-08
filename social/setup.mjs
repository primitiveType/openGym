import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
fs.mkdirSync(new URL('social-data/', root), { recursive: true, mode: 0o700 });
try { fs.writeFileSync(new URL('social-secret', root), randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
catch (e) { if (e.code !== 'EEXIST') throw e; }
fs.chmodSync(new URL('social-secret', root), 0o600);
console.log(`Social storage and shared secret ready in ${fileURLToPath(root)}. Keep both out of GitHub.`);
