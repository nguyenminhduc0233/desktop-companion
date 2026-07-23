// Regenerates the rig part images (src/assets/*.png) by decoding the base64
// data URLs embedded in character.example.json. Runs on `npm install` so the
// repo doesn't need to commit binary PNGs. Always exits 0.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const pack = JSON.parse(readFileSync(join(ROOT, 'character.example.json'), 'utf8'));
  const dir = join(ROOT, 'src', 'assets');
  mkdirSync(dir, { recursive: true });
  for (const p of pack.parts || []) {
    if (!p.image || !String(p.image).startsWith('data:')) continue;
    const dest = join(dir, p.id + '.png');
    if (existsSync(dest)) { continue; }
    const b64 = p.image.split(',')[1];
    writeFileSync(dest, Buffer.from(b64, 'base64'));
    console.log('✓ gen', p.id + '.png');
  }
} catch (e) { console.warn('gen-assets skipped:', e.message); }
process.exit(0);
