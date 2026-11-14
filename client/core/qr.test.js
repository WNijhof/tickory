// De QR-code voor tweestapsverificatie: bekende waarden uit de standaard (formaat- en versie-informatie, Reed-Solomon van het
// voorbeeld "HELLO WORLD" 1-M), en een eigen lezer die de code terugleest zoals een telefoon dat doet: formaatinformatie,
// masker eraf, de bits in de zigzag, blokken uit elkaar, foutcorrectie controleren (syndromen nul) en de bytes teruglezen.
// De lezer gebruikt zijn eigen tabellen uit de standaard, niet die van qr.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBits, qrCode, qrPath, rsRemainder, versionBits, versionFor } from './qr.js';

// ---------- een onafhankelijke lezer ----------

const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]];
// niveau M: [EC per blok, [blokken, data per blok], ...]
const BLOCKS_M = [null, [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]], [30, [1, 50], [4, 51]], [22, [6, 36], [2, 37]], [22, [8, 37], [1, 38]], [24, [4, 40], [5, 41]],
  [24, [5, 41], [5, 42]], [28, [7, 45], [3, 46]], [28, [10, 46], [1, 47]], [26, [9, 43], [4, 44]], [26, [3, 44], [11, 45]], [26, [3, 41], [13, 42]]];
const FORMAT_M = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];

const gfExp = [];
const gfLog = [];
for (let i = 0, x = 1; i < 255; i++) { gfExp[i] = x; gfLog[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); x &= 0xff; }
const gfMul = (a, b) => (a && b ? gfExp[(gfLog[a] + gfLog[b]) % 255] : 0);

function read(code) {
  const m = code.modules;
  const n = m.length;
  const version = (n - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 20, `vreemde maat ${n}`);
  // vaste modules: zoekers met rand en formaatinformatie, tijdlijnen, uitlijnpatronen, versie-informatie
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false));
  const mark = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < n && y < n) fixed[y][x] = true; };
  mark(0, 0, 9, 9); mark(n - 8, 0, 8, 9); mark(0, n - 8, 9, 8);
  mark(6, 0, 1, n); mark(0, 6, n, 1);
  const a = ALIGN[version];
  for (const x of a) for (const y of a) if (!((x === 6 && y === 6) || (x === 6 && y === a.at(-1)) || (x === a.at(-1) && y === 6))) mark(x - 2, y - 2, 5, 5);
  if (version >= 7) { mark(n - 11, 0, 3, 6); mark(0, n - 11, 6, 3); }
  // zoekers op hun plek
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let d = -3; d <= 3; d++) assert.equal(m[cy - 3][cx + d] && m[cy + 3][cx + d] && m[cy + d][cx - 3] && m[cy + d][cx + 3], true, 'buitenrand van een zoeker');
    assert.equal(m[cy][cx], true);
    assert.equal(m[cy - 2][cx], false);
  }
  for (let i = 8; i < n - 8; i++) assert.equal(m[6][i], i % 2 === 0, 'tijdlijn');
  // formaatinformatie: beide kopieën gelijk en een geldige code voor niveau M
  let f1 = '';
  for (const [x, y] of [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]) f1 = (m[y][x] ? '1' : '0') + f1;
  let f2 = '';
  for (let i = 0; i < 8; i++) f2 = (m[8][n - 1 - i] ? '1' : '0') + f2;
  for (let i = 8; i < 15; i++) f2 = (m[n - 15 + i][8] ? '1' : '0') + f2;
  assert.equal(f1, f2, 'twee kopieën van de formaatinformatie');
  const mask = FORMAT_M.indexOf(f1);
  assert.ok(mask >= 0, `geen geldige formaatinformatie voor M: ${f1}`);
  assert.equal(m[n - 8][8], true, 'de vaste donkere module');
  const masks = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  // de bits in de zigzag
  const bits = [];
  let upward = true;
  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let k = 0; k < n; k++) {
      const y = upward ? n - 1 - k : k;
      for (const x of [right, right - 1]) if (!fixed[y][x]) bits.push(m[y][x] !== masks[mask](x, y) ? 1 : 0);
    }
    upward = !upward;
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  // blokken uit elkaar
  const [ec, ...groups] = BLOCKS_M[version];
  const sizes = groups.flatMap(([count, len]) => new Array(count).fill(len));
  const blocks = sizes.map(() => []);
  let p = 0;
  for (let i = 0; i < Math.max(...sizes); i++) for (let b = 0; b < sizes.length; b++) if (i < sizes[b]) blocks[b].push(bytes[p++]);
  for (let i = 0; i < ec; i++) for (const block of blocks) block.push(bytes[p++]);
  // foutcorrectie: de veelterm van elk blok is nul in α^0 … α^(ec-1)
  for (const block of blocks) {
    for (let r = 0; r < ec; r++) {
      let s = 0;
      for (const byte of block) s = gfMul(s, gfExp[r]) ^ byte;
      assert.equal(s, 0, `syndroom ${r} van een blok is niet nul`);
    }
  }
  const data = blocks.flatMap((block, b) => block.slice(0, sizes[b]));
  const dataBits = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >> i) & 1));
  const take = (count, from) => dataBits.slice(from, from + count).reduce((acc, b) => (acc << 1) | b, 0);
  assert.equal(take(4, 0), 0b0100, 'byte mode');
  const lenBits = version < 10 ? 8 : 16;
  const len = take(lenBits, 4);
  const out = [];
  for (let i = 0; i < len; i++) out.push(take(8, 4 + lenBits + 8 * i));
  return { text: new TextDecoder().decode(new Uint8Array(out)), version, mask };
}

// ---------- de tests ----------

test('bekende waarden uit de standaard: formaatinformatie voor M, versie-informatie, Reed-Solomon van "HELLO WORLD" (1-M)', () => {
  FORMAT_M.forEach((bits, mask) => assert.equal(formatBits(mask).toString(2).padStart(15, '0'), bits, `masker ${mask}`));
  assert.equal(versionBits(7).toString(2).padStart(18, '0'), '000111110010010100');
  assert.equal(versionBits(8).toString(2).padStart(18, '0'), '001000010110111100');
  assert.equal(versionBits(20).toString(2).padStart(18, '0'), '010100100110100110');
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('een otpauth-adres als QR-code: terug te lezen, met de juiste versie', () => {
  const uri = 'otpauth://totp/Tickory:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Tickory&algorithm=SHA1&digits=6&period=30';
  const code = qrCode(uri);
  assert.equal(code.version, 7, '106 bytes passen in versie 7 bij niveau M');
  assert.equal(code.size, 45);
  assert.equal(read(code).text, uri);
  // ook met een naam met accenten (procentgecodeerd) en de tekens zelf
  const accent = `otpauth://totp/Tickory:${encodeURIComponent('Zoë.van-der-Velde')}?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Tickory`;
  assert.equal(read(qrCode(accent)).text, accent);
  assert.equal(read(qrCode('ĳsje, café en één')).text, 'ĳsje, café en één', 'UTF-8');
});

test('alle versies van 1 tot en met 20: de kleinste en grootste tekst die past, terug te lezen; groter gaat niet', () => {
  const base = 'Tickory-0123456789-abcdefghijklmnopqrstuvwxyz-'.repeat(20);
  const masks = new Set();
  for (let v = 1; v <= 20; v++) {
    const lengths = [];
    for (let len = 1; len <= 700; len++) if (versionFor(len) === v) lengths.push(len);
    assert.ok(lengths.length > 0, `versie ${v}`);
    for (const len of [lengths[0], lengths.at(-1)]) {
      const code = qrCode(base.slice(0, len));
      const back = read(code);
      assert.equal(back.text, base.slice(0, len), `versie ${v}, ${len} bytes`);
      assert.equal(back.version, v);
      assert.equal(back.mask, code.mask);
      masks.add(code.mask);
    }
  }
  assert.equal(versionFor(666), 20);
  assert.equal(versionFor(667), 0);
  assert.throws(() => qrCode('x'.repeat(667)), RangeError);
  assert.ok(masks.size >= 4, 'het gekozen masker hangt af van de inhoud');
});

test('het SVG-pad: alleen donkere modules, aaneengesloten modules in een rij als één rechthoek, met een lichte rand', () => {
  const code = { size: 3, modules: [[true, true, false], [false, false, false], [true, false, true]] };
  assert.equal(qrPath(code, 4), 'M4 4h2v1h-2zM4 6h1v1h-1zM6 6h1v1h-1z');
  assert.equal(qrPath(code, 0).startsWith('M0 0h2'), true);
  const real = qrCode('test');
  const dark = real.modules.flat().filter(Boolean).length;
  const covered = [...qrPath(real).matchAll(/h(\d+)v1/g)].reduce((s, m) => s + Number(m[1]), 0);
  assert.equal(covered, dark);
});
