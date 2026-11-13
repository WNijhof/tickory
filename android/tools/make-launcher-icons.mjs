// Maakt het app-pictogram voor Android uit het pictogram van de web-app. Geen afhankelijkheden, alleen Node.
//
// Gebruik (vanuit de map van de repo):
//   node android/tools/make-launcher-icons.mjs                      leest client/icon-maskable-512.png
//   node android/tools/make-launcher-icons.mjs pad/naar/ander.png   leest een ander bestand
//
// Wat het doet:
//   Android toont een "adaptief" pictogram: een vlak van 108 x 108 dp waar het toestel zelf een vorm uit snijdt (rond,
//   afgerond vierkant). Alleen een cirkel van 66 dp in het midden is gegarandeerd zichtbaar. Het pictogram van de
//   web-app ("maskable", zie client/manifest.webmanifest) volgt een andere afspraak: daar is de veilige zone een cirkel
//   van 80% van de breedte. Dit script verkleint het beeld zo dat die twee veilige zones over elkaar vallen, en vult de
//   rand eromheen met de achtergrondkleur van het beeld (gemeten in de hoeken).
//
// Wat het schrijft (in android/app/src/main/res):
//   mipmap-mdpi … mipmap-xxxhdpi/ic_launcher_foreground.png   de voorgrond, in vijf scherpten
//   values/ic_launcher_background.xml                         de achtergrondkleur
//
// Wat het NIET doet: de twee vectortekeningen met alleen de vorm van het logo, drawable/ic_launcher_monochrome.xml
// (pictogram met thema, Android 13+) en drawable/ic_stat_reminder.xml (pictogram in een melding). Die zijn met de hand
// gemaakt van het pad in client/icon.svg. Zie android/README.md, "Pictogram vervangen".
//
// Eisen aan het bronbestand: een vierkante PNG, 8 bits per kanaal, niet "interlaced", die het hele vlak vult
// (geen doorzichtige hoeken). Zo schrijft scripts/make-icons.js hem ook.

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LAYER_DP = 108; // het hele vlak van een adaptief pictogram
const ANDROID_SAFE_DP = 66; // doorsnee van de cirkel die altijd zichtbaar is
const MASKABLE_SAFE = 0.8; // doorsnee van de veilige zone van een maskable-pictogram, als deel van de breedte
const IMAGE_FRACTION = ANDROID_SAFE_DP / LAYER_DP / MASKABLE_SAFE; // het beeld beslaat dit deel van het vlak (ruim 76%)
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const SAMPLES = 6; // 6 x 6 meetpunten per beeldpunt: gladde randen, ook bij sterk verkleinen

// ---------- PNG lezen ----------

function decodePng(file) {
  const buf = readFileSync(file);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${file} is geen PNG-bestand`);
  let header = null;
  let palette = null;
  let transparency = null;
  const data = [];
  for (let pos = 8; pos + 12 <= buf.length;) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  if (!header) throw new Error('de PNG heeft geen kop (IHDR)');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (header.depth !== 8 || header.interlace !== 0 || !channels) {
    throw new Error('sla het pictogram op als gewone PNG: 8 bits per kanaal, zonder interlacing');
  }
  const { width, height } = header;
  const stride = width * channels;
  const packed = inflateSync(Buffer.concat(data));
  if (packed.length < (stride + 1) * height) throw new Error('de PNG is afgekapt');

  // Elke regel is "gefilterd" opgeslagen (verschil met de buren); dat draaien we hier terug.
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)];
    const from = y * (stride + 1) + 1;
    const to = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? raw[to + x - channels] : 0;
      const up = y > 0 ? raw[to - stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? raw[to - stride + x - channels] : 0;
      let value = packed[from + x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const dl = Math.abs(p - left), du = Math.abs(p - up), dul = Math.abs(p - upLeft);
        value += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
      } else if (filter !== 0) throw new Error(`onbekend PNG-filter ${filter}`);
      raw[to + x] = value & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    let r, g, b, a = 255;
    if (header.colorType === 6) [r, g, b, a] = [raw[s], raw[s + 1], raw[s + 2], raw[s + 3]];
    else if (header.colorType === 2) [r, g, b] = [raw[s], raw[s + 1], raw[s + 2]];
    else if (header.colorType === 4) [r, g, b, a] = [raw[s], raw[s], raw[s], raw[s + 1]];
    else if (header.colorType === 0) [r, g, b] = [raw[s], raw[s], raw[s]];
    else {
      const index = raw[s];
      if (!palette || index * 3 + 2 >= palette.length) throw new Error('de PNG verwijst naar een kleur die niet in het palet staat');
      [r, g, b] = [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]];
      if (transparency && index < transparency.length) a = transparency[index];
    }
    rgba.set([r, g, b, a], i * 4);
  }
  return { width, height, rgba };
}

// ---------- PNG schrijven ----------

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
function chunk(type, body) {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), body.length + 8);
  return out;
}
function encodePng(size, rgba) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); // filter 0 per regel
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per kanaal
  header[9] = 6; // RGBA
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- van maskable naar adaptief ----------

/** Kleur op een punt van het bronbeeld (x en y van 0 tot 1), vloeiend tussen de beeldpunten in. */
function sample(image, u, v) {
  const fx = Math.min(image.width - 1, Math.max(0, u * image.width - 0.5));
  const fy = Math.min(image.height - 1, Math.max(0, v * image.height - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const out = [0, 0, 0, 0];
  for (const [x, y, weight] of [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]]) {
    const o = (y * image.width + x) * 4;
    for (let k = 0; k < 4; k++) out[k] += image.rgba[o + k] * weight;
  }
  return out;
}

/** De achtergrondkleur: het gemiddelde van de vier hoeken. Die moeten dekkend zijn en (ongeveer) dezelfde kleur hebben. */
function backgroundOf(image) {
  const inset = Math.max(1, Math.round(image.width * 0.01));
  const corners = [[inset, inset], [image.width - 1 - inset, inset], [inset, image.height - 1 - inset], [image.width - 1 - inset, image.height - 1 - inset]]
    .map(([x, y]) => [...image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]);
  if (corners.some((c) => c[3] < 250)) {
    throw new Error('de hoeken van het pictogram zijn doorzichtig; gebruik de "maskable" variant, die het hele vlak vult');
  }
  const mean = [0, 1, 2].map((k) => Math.round(corners.reduce((sum, c) => sum + c[k], 0) / corners.length));
  const spread = Math.max(...corners.map((c) => Math.max(...[0, 1, 2].map((k) => Math.abs(c[k] - mean[k])))));
  if (spread > 24) console.warn('Let op: de hoeken hebben niet dezelfde kleur (verloop?). De rand krijgt het gemiddelde; bij bewegende pictogrammen kan een overgang zichtbaar zijn.');
  return mean;
}

function foreground(image, background, size) {
  const out = Buffer.alloc(size * size * 4);
  const margin = (1 - IMAGE_FRACTION) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = ((x + (sx + 0.5) / SAMPLES) / size - margin) / IMAGE_FRACTION;
          const v = ((y + (sy + 0.5) / SAMPLES) / size - margin) / IMAGE_FRACTION;
          let color = background;
          if (u >= 0 && u < 1 && v >= 0 && v < 1) {
            const [r, g, b, a] = sample(image, u, v);
            const alpha = a / 255; // een enkel doorzichtig randje mengen we met de achtergrond
            color = [r * alpha + background[0] * (1 - alpha), g * alpha + background[1] * (1 - alpha), b * alpha + background[2] * (1 - alpha)];
          }
          for (let k = 0; k < 3; k++) sum[k] += color[k];
        }
      }
      const o = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = Math.round(sum[k] / (SAMPLES * SAMPLES));
      out[o + 3] = 255;
    }
  }
  return out;
}

// ---------- uitvoeren ----------

const source = process.argv[2] ?? fileURLToPath(new URL('../../client/icon-maskable-512.png', import.meta.url));
const resDir = fileURLToPath(new URL('../app/src/main/res/', import.meta.url));

try {
  const image = decodePng(source);
  if (image.width !== image.height) throw new Error(`het pictogram moet vierkant zijn (dit is ${image.width} x ${image.height})`);
  if (image.width < 432) console.warn(`Let op: het bronbestand is ${image.width} px breed; voor een scherp pictogram is 512 px of meer beter.`);
  const background = backgroundOf(image);
  const hex = '#' + background.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();
  console.log(`bron: ${source} (${image.width} x ${image.height}), achtergrondkleur ${hex}`);

  for (const [name, factor] of Object.entries(DENSITIES)) {
    const size = Math.round(LAYER_DP * factor);
    const dir = join(resDir, `mipmap-${name}`);
    mkdirSync(dir, { recursive: true });
    const png = encodePng(size, foreground(image, background, size));
    writeFileSync(join(dir, 'ic_launcher_foreground.png'), png);
    console.log(`mipmap-${name}/ic_launcher_foreground.png: ${size} x ${size}, ${png.length} bytes`);
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Gemaakt door tools/make-launcher-icons.mjs: de achtergrondkleur van het app-pictogram. Niet met de hand wijzigen. -->
<resources>
    <color name="ic_launcher_background">${hex}</color>
</resources>
`;
  writeFileSync(join(resDir, 'values', 'ic_launcher_background.xml'), xml);
  console.log('values/ic_launcher_background.xml');
} catch (err) {
  console.error(`Fout: ${err.message}`);
  process.exit(1);
}
