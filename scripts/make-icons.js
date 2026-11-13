// Tekent de app-pictogrammen als PNG, zonder afhankelijkheden (eigen PNG-schrijver bovenop node:zlib).
// Gebruik: node scripts/make-icons.js      (schrijft naar client/)
//
// Het beeld is hetzelfde als client/icon.svg: een afgerond vlak met een vinkje. De "maskable" variant vult het
// hele vlak en houdt het vinkje binnen de veilige zone, zodat Android er zelf een vorm uit mag snijden.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** @param {(x: number, y: number) => [number, number, number, number]} pixel kleur (0-255) op een punt in een vlak van 512 x 512 */
function png(size, pixel) {
  const SS = 4; // 4 x 4 meetpunten per beeldpunt voor gladde randen
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filtertype: geen
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = pixel(((x + (sx + 0.5) / SS) * 512) / size, ((y + (sy + 0.5) / SS) * 512) / size);
          r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
        }
      }
      const o = row + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round(a / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits per kanaal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [15, 118, 110, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];
const CHECK = [[148, 268], [220, 340], [364, 172]];

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inRoundedSquare(x, y, radius) {
  const cx = Math.max(radius, Math.min(512 - radius, x));
  const cy = Math.max(radius, Math.min(512 - radius, y));
  return Math.hypot(x - cx, y - cy) <= radius;
}
function icon({ radius, scale }) {
  const pts = CHECK.map(([x, y]) => [256 + (x - 256) * scale, 256 + (y - 256) * scale]);
  const half = 22 * scale;
  return (x, y) => {
    if (radius > 0 && !inRoundedSquare(x, y, radius)) return CLEAR;
    if (distToSegment(x, y, pts[0], pts[1]) <= half || distToSegment(x, y, pts[1], pts[2]) <= half) return WHITE;
    return BG;
  };
}

const out = (name) => fileURLToPath(new URL(`../client/${name}`, import.meta.url));
const files = [
  ['icon-192.png', png(192, icon({ radius: 112, scale: 1 }))],
  ['icon-512.png', png(512, icon({ radius: 112, scale: 1 }))],
  ['icon-maskable-512.png', png(512, icon({ radius: 0, scale: 0.72 }))],
];
for (const [name, data] of files) {
  writeFileSync(out(name), data);
  console.log(`${name}: ${data.length} bytes`);
}
