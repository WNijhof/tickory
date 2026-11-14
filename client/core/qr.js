// Een QR-code (ISO/IEC 18004) maken, zonder bibliotheek: voor het otpauth://-adres bij het aanzetten van tweestapsverificatie.
// Alleen wat daarvoor nodig is: tekst als bytes (UTF-8, "byte mode"), foutcorrectie M (15%), versie 1 tot en met 20
// (tot 666 bytes; een otpauth-adres is er ruim 100). De stappen:
//   1. de bits: modus, lengte, de bytes, afsluiter en opvulling tot de capaciteit van de kleinste versie die past;
//   2. per blok Reed-Solomon-foutcorrectie (GF(256), veelterm 0x11D), dan de blokken door elkaar (interleaving);
//   3. de vaste patronen (zoekers, tijdlijnen, uitlijnpatronen, versie-informatie), de gegevens in de zigzag van de standaard;
//   4. de acht maskers proberen en het masker met de laagste strafpunten nemen, met de bijbehorende formaatinformatie.
// Het resultaat is een matrix van true (donker) en false (licht); qrPath maakt er een SVG-pad van.

/** Per versie (index) voor niveau M: [foutcorrectie-codewoorden per blok, blokken in groep 1, datacodewoorden per blok in groep 1, blokken in groep 2, datacodewoorden per blok in groep 2]. */
const ECC_M = [
  null,
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
];
export const MAX_VERSION = 20;
const LEVEL_M = 0b00; // de bits van foutcorrectieniveau M in de formaatinformatie

/** Het aantal modules (bits) voor gegevens en foutcorrectie in een versie: alles behalve de vaste patronen. */
export function rawDataModules(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

/** De datacodewoorden van een versie (niveau M). */
export const dataCodewords = (version) => {
  const [, b1, d1, b2, d2] = ECC_M[version];
  return b1 * d1 + b2 * d2;
};

/** De middens van de uitlijnpatronen in één richting. */
export function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ---------- Reed-Solomon in GF(256) ----------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** De generatorveelterm van graad `degree` (zonder de leidende 1), hoogste macht eerst. */
export function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly.slice(1);
}

/** De foutcorrectie-codewoorden bij `data` (de rest van de deling door de generator). */
export function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i], factor);
  }
  return rem;
}

// ---------- de bits ----------

const utf8 = (text) => [...new TextEncoder().encode(text)];

/** De kleinste versie waarin `bytes` bytes passen (byte mode, niveau M), of 0 als het niet past. */
export function versionFor(bytes) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const bits = 4 + (v < 10 ? 8 : 16) + 8 * bytes;
    if (bits <= dataCodewords(v) * 8) return v;
  }
  return 0;
}

function encodeData(bytes, version) {
  const bits = [];
  const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length)); // afsluiter
  put(0, (8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  for (let pad = 0xec; out.length < capacity / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** De datacodewoorden met foutcorrectie, per blok, en daarna door elkaar zoals de standaard het wil. */
export function interleave(data, version) {
  const [ec, b1, d1, b2, d2] = ECC_M[version];
  const blocks = [];
  let pos = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    const part = data.slice(pos, pos + len);
    pos += len;
    blocks.push({ data: part, ec: rsRemainder(part, ec) });
  }
  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ---------- de matrix ----------

/** De 15 bits formaatinformatie voor niveau M en masker `mask` (BCH(15,5), met het vaste XOR-patroon). */
export function formatBits(mask) {
  const data = (LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** De 18 bits versie-informatie (vanaf versie 7; BCH(18,6)). */
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

export const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function build(version, codewords) {
  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, on) => { dark[y][x] = on; fixed[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // tijdlijnen
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) { // zoekers met hun lichte rand
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0);
      if (corner) continue; // daar staat een zoeker
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (mask) => {
    const bits = formatBits(mask);
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true); // de vaste donkere module
  };
  drawFormat(0); // de plaatsen reserveren
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }

  // de gegevens: in kolomparen van rechts naar links, afwisselend omhoog en omlaag, de kolom met de tijdlijn overslaan
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < codewords.length * 8) {
          dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) dark[y][x] = !dark[y][x];
  };
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty(dark);
    if (score < bestScore) { best = mask; bestScore = score; }
    applyMask(mask); // terug (XOR)
  }
  applyMask(best);
  drawFormat(best);
  return { size, version, mask: best, modules: dark };
}

/** Strafpunten volgens de vier regels van de standaard: lange rijen, blokken, zoekerachtige patronen en de verhouding donker/licht. */
export function penalty(m) {
  const size = m.length;
  let score = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) { run++; continue; }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    const pattern = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= size; i++) {
      if (!pattern.every((p, k) => get(i + k) === p)) continue;
      const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !get(i - k));
      const lightAfter = i + 11 <= size && [0, 1, 2, 3].every((k) => !get(i + 7 + k));
      if (lightBefore || lightAfter) score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((x) => m[y][x]);
  for (let x = 0; x < size; x++) line((y) => m[y][x]);
  let darkCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) darkCount++;
      if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }
  score += 10 * Math.floor(Math.abs((darkCount * 100) / (size * size) - 50) / 5);
  return score;
}

/**
 * De QR-code van `text`: `{ size, version, mask, modules }` met `modules[y][x]` true voor donker. Gooit als de tekst te lang is
 * (meer dan 666 bytes); dan toont de app alleen de sleutel als tekst.
 */
export function qrCode(text) {
  const bytes = utf8(String(text));
  const version = versionFor(bytes.length);
  if (!version) throw new RangeError('te lang voor een QR-code');
  return build(version, interleave(encodeData(bytes, version), version));
}

/** Een SVG-pad voor de donkere modules (een rij aaneengesloten modules is één rechthoek), met `margin` modules lichte rand. */
export function qrPath(code, margin = 4) {
  const parts = [];
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y][x]) continue;
      let end = x;
      while (end + 1 < code.size && code.modules[y][end + 1]) end++;
      parts.push(`M${x + margin} ${y + margin}h${end - x + 1}v1h-${end - x + 1}z`);
      x = end;
    }
  }
  return parts.join('');
}
