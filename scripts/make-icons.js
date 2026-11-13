// Tekent de pictogrammen van Tickory als PNG, zonder afhankelijkheden (eigen PNG-schrijver bovenop node:zlib).
// Gebruik: node scripts/make-icons.js                (schrijft naar client/ en website/assets/)
//          node scripts/make-icons.js --preview map  (schrijft daarnaast proefafbeeldingen in allerlei formaten naar `map`)
//
// Het beeld is hetzelfde als client/icon.svg en website/assets/logo.svg: een afgerond vlak met een vinkje waarvan de
// twee benen de wijzers van een klok zijn (met een as op het knikpunt), en vier uurstreepjes eromheen.
// Wijzig je de vorm, pas dan de maten hieronder én de twee SVG-bestanden aan; `node scripts/site-check.ts` vergelijkt ze.
// De "maskable" variant vult het hele vlak en houdt het beeld binnen de veilige zone, zodat Android er zelf een vorm
// uit mag snijden.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
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

/**
 * Tekent een vierkant beeld als rij van beeldpunten (RGBA, 4 bytes per punt).
 * @param {number} size breedte en hoogte in beeldpunten
 * @param {(x: number, y: number) => number[]} pixel kleur [r, g, b, a] (0-255) op een punt in een vlak van 512 x 512
 */
export function rasterize(size, pixel) {
  const SS = 4; // 4 x 4 meetpunten per beeldpunt voor gladde randen
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = pixel(((x + (sx + 0.5) / SS) * 512) / size, ((y + (sy + 0.5) / SS) * 512) / size);
          r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
        }
      }
      const o = (y * size + x) * 4;
      rgba[o] = a ? Math.round(r / a) : 0;
      rgba[o + 1] = a ? Math.round(g / a) : 0;
      rgba[o + 2] = a ? Math.round(b / a) : 0;
      rgba[o + 3] = Math.round(a / (SS * SS));
    }
  }
  return rgba;
}

/** Maakt van beeldpunten (RGBA) een PNG-bestand. */
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filtertype: geen
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits per kanaal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const png = (size, pixel) => encodePng(size, size, rasterize(size, pixel));

// ---------- het beeldmerk (maten in een vlak van 512 x 512, gelijk aan de SVG-bestanden) ----------

export const ACCENT = [15, 118, 110, 255]; // #0f766e, de accentkleur van de app (licht thema)
const WHITE = [255, 255, 255, 255];
const TICK = [94, 234, 212, 255]; // #5eead4, de lichte tint van dezelfde kleur
const CLEAR = [0, 0, 0, 0];

/** Hoekstraal van het afgeronde vlak. */
export const CORNER = 112;
/** De as: het knikpunt van het vinkje. */
export const PIVOT = [222, 326];
/** De korte wijzer (het korte been van het vinkje) en de lange wijzer (het lange been), elk vanaf de as. */
export const HOUR_TIP = [146, 250];
export const MINUTE_TIP = [370, 150];
export const HAND_WIDTH = 46;
/** De as zelf: een stip in de achtergrondkleur. */
export const HUB_RADIUS = 9;
/** Uurstreepjes op 12, 3, 6 en 9 uur: lijnstukken met ronde uiteinden. */
export const TICKS = [
  [[256, 54], [256, 82]],
  [[458, 256], [430, 256]],
  [[256, 458], [256, 430]],
  [[54, 256], [82, 256]],
];
export const TICK_WIDTH = 18;
/** Verkleining voor de maskable variant: alles blijft binnen de veilige zone (een cirkel met 40% van de breedte als straal). */
export const MASKABLE_SCALE = 0.8;

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

/**
 * @param {{ radius: number, scale?: number, ticks?: boolean, background?: number[] | null, ink?: number[] }} options
 *   radius: hoekstraal van het vlak (0 = het hele vlak vullen); scale: het beeld verkleinen rond het midden;
 *   background: null = doorzichtig (alleen het beeld, in de kleur `ink`).
 */
export function icon({ radius, scale = 1, ticks = true, background = ACCENT, ink = WHITE }) {
  const at = ([x, y]) => [256 + (x - 256) * scale, 256 + (y - 256) * scale];
  const pivot = at(PIVOT), hour = at(HOUR_TIP), minute = at(MINUTE_TIP);
  const marks = TICKS.map(([a, b]) => [at(a), at(b)]);
  const hub = background ?? CLEAR;
  return (x, y) => {
    if (background && radius > 0 && !inRoundedSquare(x, y, radius)) return CLEAR;
    if (Math.hypot(x - pivot[0], y - pivot[1]) <= HUB_RADIUS * scale) return hub;
    if (distToSegment(x, y, pivot, hour) <= (HAND_WIDTH / 2) * scale || distToSegment(x, y, pivot, minute) <= (HAND_WIDTH / 2) * scale) return ink;
    if (ticks) for (const [a, b] of marks) if (distToSegment(x, y, a, b) <= (TICK_WIDTH / 2) * scale) return background ? TICK : ink;
    return background ?? CLEAR;
  };
}

// ---------- proefblad: alle formaten naast elkaar, op een lichte en een donkere ondergrond ----------

/**
 * Eén afbeelding om het beeldmerk te beoordelen: boven op wit, onder op de donkere achtergrond van de app. Per helft
 * het pictogram op ware grootte (16 tot 192 punten), de kleine formaten daarnaast vergroot (zoals je ze van dichtbij
 * ziet), het losse beeldmerk zonder vlak en de maskable variant met de veilige zone erin getekend.
 */
function previewSheet() {
  const W = 1500, H = 720;
  const sheet = Buffer.alloc(W * H * 4);
  const fill = (x0, y0, w, h, [r, g, b]) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) sheet.set([r, g, b, 255], (y * W + x) * 4);
  };
  /** Zet een beeld op het blad, `zoom` keer vergroot zonder te vervagen. */
  const blit = (rgba, size, x0, y0, zoom = 1) => {
    for (let y = 0; y < size * zoom; y++) {
      for (let x = 0; x < size * zoom; x++) {
        const s = (Math.floor(y / zoom) * size + Math.floor(x / zoom)) * 4;
        const d = ((y0 + y) * W + x0 + x) * 4;
        const a = rgba[s + 3] / 255;
        for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(rgba[s + c] * a + sheet[d + c] * (1 - a));
      }
    }
  };
  const halves = [{ y: 0, bg: [255, 255, 255], ink: ACCENT }, { y: H / 2, bg: [22, 25, 28], ink: [45, 212, 191, 255] }];
  for (const half of halves) {
    fill(0, half.y, W, H / 2, half.bg);
    let x = 24;
    for (const size of [192, 96, 48, 32, 24, 16]) {
      blit(rasterize(size, icon({ radius: CORNER })), size, x, half.y + 24);
      x += size + 20;
    }
    x = 24;
    for (const [size, zoom] of [[16, 8], [24, 6], [32, 4]]) {
      blit(rasterize(size, icon({ radius: CORNER })), size, x, half.y + 228, zoom);
      x += size * zoom + 20;
    }
    blit(rasterize(256, icon({ radius: CORNER, background: null, ink: half.ink })), 256, 560, half.y + 60);
    blit(rasterize(64, icon({ radius: CORNER, background: null, ink: half.ink })), 64, 840, half.y + 60);
    blit(rasterize(24, icon({ radius: CORNER, background: null, ink: half.ink })), 24, 840, half.y + 150);
    // maskable, met een cirkel als uitsnede (de veilige zone is een cirkel met 40% van de breedte als straal)
    const mask = icon({ radius: 0, scale: MASKABLE_SCALE });
    blit(rasterize(256, (px, py) => (Math.hypot(px - 256, py - 256) <= 0.4 * 512 ? mask(px, py) : [...mask(px, py).slice(0, 3), 90])), 256, 960, half.y + 60);
    blit(rasterize(256, icon({ radius: CORNER })), 256, 1232, half.y + 60);
  }
  return encodePng(W, H, sheet);
}

// ---------- bestanden schrijven ----------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = new URL('../', import.meta.url);
  const out = (path) => fileURLToPath(new URL(path, root));
  const files = [
    ['client/icon-192.png', png(192, icon({ radius: CORNER }))],
    ['client/icon-512.png', png(512, icon({ radius: CORNER }))],
    ['client/icon-maskable-512.png', png(512, icon({ radius: 0, scale: MASKABLE_SCALE }))],
    // voor de website: een PNG-favicon voor browsers die geen SVG-favicon tonen, en het pictogram voor een iPhone-startscherm
    ['website/assets/favicon-32.png', png(32, icon({ radius: CORNER }))],
    ['website/assets/apple-touch-icon.png', png(180, icon({ radius: 0, scale: 0.86 }))],
  ];
  for (const [path, data] of files) {
    writeFileSync(out(path), data);
    console.log(`${path}: ${data.length} bytes`);
  }
  const previewAt = process.argv.indexOf('--preview');
  if (previewAt > 0 && process.argv[previewAt + 1]) {
    const dir = process.argv[previewAt + 1].replace(/[\\/]+$/, '');
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/sheet.png`, previewSheet());
    console.log(`proefblad: ${dir}/sheet.png`);
  }
}
