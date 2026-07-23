// Generates build/icon.png (512x512) — a violet orb app icon. No deps. Always exits 0.
const zlib = require('zlib'); const fs = require('fs'); const path = require('path');
try {
  const S = 512; const buf = Buffer.alloc(S * S * 4);
  const mix = (a, b, t) => Math.round(a + (b - a) * t);
  const cx = S * 0.5, cy = S * 0.46;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const gy = y / S; let r = mix(14, 40, gy), g = mix(11, 24, gy), b = mix(26, 74, gy);
    const d = Math.hypot(x - cx, y - cy) / (S * 0.5); const glow = Math.max(0, 1 - d); const orb = Math.max(0, 1 - d * 1.7);
    r = mix(r, 154, glow * 0.5); g = mix(g, 134, glow * 0.45); b = mix(b, 255, glow * 0.55);
    r = mix(r, 255, orb * orb); g = mix(g, 244, orb * orb); b = mix(b, 255, orb * orb);
    const i = (y * S + x) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  }
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  const crcTab = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTab[n] = c >>> 0; }
  const crc32 = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) c = crcTab[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (~c) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  const dir = path.join(__dirname, '..', 'build'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'icon.png'), png);
  console.log('Wrote build/icon.png');
} catch (e) { console.warn('gen-icon skipped:', e.message); }
process.exit(0);
