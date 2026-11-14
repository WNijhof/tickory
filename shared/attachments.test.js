import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFileName, DEFAULT_MIME, effectiveMime, extensionOf, fileNameProblem, formatBytes, isInlineMime, isPreviewMime, MAX_NAME_LENGTH, normalizeMime, sniffMime } from './attachments.js';

test('gewone namen blijven zoals ze zijn, ook met accenten, spaties en leestekens', () => {
  for (const name of ['foto.png', 'Rekening maart – Nijhof & Zn.pdf', 'café.txt', 'ĳsvogel.docx', '日本語.txt', 'foto (1).jpeg', 'a.b.c.tar.gz', 'Ça va?'.replace('?', '')]) {
    assert.equal(cleanFileName(name), name);
    assert.equal(fileNameProblem(name), null);
  }
});

test('padtekens en padtraversal worden onschadelijk', () => {
  assert.equal(cleanFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(cleanFileName('C:\\Windows\\system32\\cmd.exe'), 'C__Windows_system32_cmd.exe');
  assert.equal(cleanFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(cleanFileName('..'), 'bijlage');
  assert.equal(cleanFileName('.'), 'bijlage');
  assert.equal(cleanFileName('...hidden'), 'hidden');
  assert.equal(cleanFileName('naam.'), 'naam');
  assert.equal(cleanFileName('  naam  '), 'naam');
});

test('stuurtekens, onzichtbare tekens en tekens die de leesrichting omdraaien verdwijnen', () => {
  assert.equal(cleanFileName('a\u0000b\u001fc\u007fd\u0085e'), 'abcde');
  assert.equal(cleanFileName('foto\u202egnp.exe'), 'fotognp.exe', 'geen omgekeerde uitgang');
  assert.equal(cleanFileName('a\u200bb\u200fc\ufeffd\u2066e\u2069f'), 'abcdef');
  assert.equal(cleanFileName('regel\neen\r\ntwee\tdrie'), 'regel een twee drie');
  assert.equal(cleanFileName('dubbele    spaties'), 'dubbele spaties');
  assert.equal(cleanFileName('\u00a0niet\u00a0breed\u00a0'), 'niet breed');
});

test('de Unicode-vorm is NFC: een los accent wordt samengevoegd', () => {
  const ontleed = 'cafe\u0301.txt';
  assert.notEqual(ontleed, 'café.txt');
  assert.equal(cleanFileName(ontleed), 'café.txt');
  assert.equal(cleanFileName('Zoe\u0308'), 'Zoë');
});

test('Windows-apparaatnamen krijgen een streepje ervoor, ook met een uitgang', () => {
  for (const name of ['CON', 'con.txt', 'NUL', 'aux.tar.gz', 'COM1', 'lpt9.log', 'PRN']) assert.equal(cleanFileName(name), `_${name}`);
  for (const name of ['console.txt', 'COM10', 'con tent', 'xcon']) assert.equal(cleanFileName(name), name);
});

test('lange namen worden ingekort met behoud van de uitgang, en tellen in tekens, niet in bytes', () => {
  const long = `${'a'.repeat(500)}.pdf`;
  const cut = cleanFileName(long);
  assert.equal([...cut].length, MAX_NAME_LENGTH);
  assert.ok(cut.endsWith('.pdf'));
  const emoji = `${'😀'.repeat(300)}.jpeg`;
  const e = cleanFileName(emoji);
  assert.equal([...e].length, MAX_NAME_LENGTH);
  assert.ok(e.endsWith('.jpeg'));
  assert.ok(!/[\ud800-\udbff]$/.test(e), 'nooit in een surrogaatpaar afgebroken');
  // een gigantische uitgang is geen uitgang
  const weird = cleanFileName(`x.${'y'.repeat(400)}`);
  assert.equal([...weird].length, MAX_NAME_LENGTH);
  assert.equal(cleanFileName('a'.repeat(MAX_NAME_LENGTH)), 'a'.repeat(MAX_NAME_LENGTH));
});

test('leeg, geen tekst of alleen rommel geeft de standaardnaam', () => {
  for (const v of ['', ' ', '\u0000', '///', '...', null, undefined, 42, {}, [], '\u202e\u200b']) {
    assert.equal(cleanFileName(v), v === '///' ? '___' : 'bijlage', String(v));
  }
});

test('schoonmaken is idempotent: een schone naam blijft gelijk (fuzz)', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alphabet = ['a', 'B', '.', '.', ' ', '/', '\\', ':', '\u0000', '\u202e', '\u200b', 'é', 'e\u0301', '😀', '日', '_', '-', '"', '*', 'C', 'O', 'N', 'u', 'l', '\n', '\u00a0', '\ud800', 'ï'];
  for (let i = 0; i < 3000; i++) {
    let s = '';
    for (let k = rnd(60); k > 0; k--) s += alphabet[rnd(alphabet.length)];
    if (rnd(5) === 0) s = s.repeat(1 + rnd(8));
    const once = cleanFileName(s);
    assert.equal(cleanFileName(once), once, JSON.stringify(s));
    assert.ok(once.length > 0 && [...once].length <= MAX_NAME_LENGTH);
    assert.ok(!/[\\/:*?"<>|\u0000-\u001f]/.test(once), JSON.stringify(once));
    assert.ok(!/^[.\s]|[.\s]$/.test(once), JSON.stringify(once));
    assert.equal(once, once.normalize('NFC'));
  }
});

test('fileNameProblem: geen tekst of een niet-schone naam is een fout', () => {
  assert.equal(fileNameProblem('goed.txt'), null);
  for (const v of ['../x', 'a/b', ' x', 'x.', '', 5, null]) assert.ok(fileNameProblem(v), String(v));
});

test('normalizeMime: kleine letters, geen parameters, onzin wordt octet-stream', () => {
  assert.equal(normalizeMime('IMAGE/PNG'), 'image/png');
  assert.equal(normalizeMime('text/plain; charset=utf-8'), 'text/plain');
  assert.equal(normalizeMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(normalizeMime('image/svg+xml'), 'image/svg+xml');
  for (const v of ['', 'png', 'a/b/c', '/x', 'x/', 'text/pl ain', 'text/<script>', null, undefined, 3, `a/${'b'.repeat(200)}`, 'text/plain\r\nX: y']) {
    assert.equal(normalizeMime(v), DEFAULT_MIME, String(v));
  }
});

const bytes = (...b) => Uint8Array.from(b);
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

test('sniffMime herkent alleen de lijst veilige typen, aan de eerste bytes', () => {
  assert.equal(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'image/png');
  assert.equal(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffMime(ascii('GIF89a....')), 'image/gif');
  assert.equal(sniffMime(ascii('GIF87a....')), 'image/gif');
  assert.equal(sniffMime(Uint8Array.from([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBPVP8 ')])), 'image/webp');
  assert.equal(sniffMime(ascii('%PDF-1.4\n')), 'application/pdf');
  for (const text of ['<svg xmlns="http://www.w3.org/2000/svg">', '<!doctype html>', '<html>', '<?xml version="1.0"?>', 'GIF9', 'RIFF....WAVEfmt ', '%PDF', 'PK\u0003\u0004']) {
    assert.equal(sniffMime(ascii(text)), null, text);
  }
  assert.equal(sniffMime(bytes()), null);
  assert.equal(sniffMime(bytes(0x89, 0x50)), null, 'te kort');
});

test('effectiveMime: de bytes gaan voor; een beloofd veilig type zonder bevestiging wordt octet-stream', () => {
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  assert.equal(effectiveMime('application/octet-stream', png), 'image/png');
  assert.equal(effectiveMime('image/jpeg', png), 'image/png');
  assert.equal(effectiveMime('image/png', ascii('<html>')), DEFAULT_MIME);
  assert.equal(effectiveMime('application/pdf', ascii('niet pdf')), DEFAULT_MIME);
  assert.equal(effectiveMime('image/svg+xml', ascii('<svg/>')), 'image/svg+xml');
  assert.equal(effectiveMime('text/html', ascii('<html>')), 'text/html');
  assert.equal(effectiveMime('Text/Plain; charset=x', ascii('hallo')), 'text/plain');
  assert.equal(effectiveMime(undefined, ascii('hallo')), DEFAULT_MIME);
});

test('inline-typen: png, jpeg, gif, webp en pdf; nooit svg of html; voorbeeld alleen voor afbeeldingen', () => {
  for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']) assert.ok(isInlineMime(m));
  for (const m of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'image/svg', 'image/x-icon', 'image/bmp']) assert.ok(!isInlineMime(m), m);
  assert.ok(isPreviewMime('image/webp'));
  assert.ok(!isPreviewMime('application/pdf'));
});

test('extensionOf en formatBytes', () => {
  assert.equal(extensionOf('Foto.JPEG'), 'jpeg');
  assert.equal(extensionOf('archief.tar.gz'), 'gz');
  assert.equal(extensionOf('zonder'), '');
  assert.equal(extensionOf('.verborgen'), '');
  assert.equal(extensionOf('x.een-lange-uitgang'), '');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1500, 'nl'), '1,5 kB');
  assert.equal(formatBytes(1500, 'en'), '1.5 kB');
  assert.equal(formatBytes(25_000_000, 'nl'), '25 MB');
  assert.equal(formatBytes(2_400_000, 'nl'), '2,4 MB');
  assert.equal(formatBytes(150_000, 'nl'), '150 kB');
});
