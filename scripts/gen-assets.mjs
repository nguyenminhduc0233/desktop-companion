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
  const items = pack.layers || pack.bones || pack.parts || [];   // v4/v3 = layers, v2 = bones, v1 = parts
  const write = (id, image) => {
    if (!image || !String(image).startsWith('data:')) return;
    const dest = join(dir, id + '.png');
    if (existsSync(dest)) return;
    writeFileSync(dest, Buffer.from(image.split(',')[1], 'base64'));
    console.log('✓ gen', id + '.png');
  };
  for (const p of items) write(p.id, p.image);
  (pack.windFrames || []).forEach((img, i) => write('w' + String(i).padStart(2, '0'), img));   // v4 hair-breeze frames
} catch (e) { console.warn('gen-assets skipped:', e.message); }
process.exit(0);
