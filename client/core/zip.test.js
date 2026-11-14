import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 as fixtureCrc, deflateRaw, makeZip } from '../../scripts/zipFixture.ts';
import { crc32, isSafeZipName, looksLikeZip, readZip } from './zip.js';

const text = (bytes) => new TextDecoder().decode(bytes);
const csv = 'TYPE,CONTENT\r\ntask,Brood halen\r\n';

test('crc32: gelijk aan de bekende waarde en aan de schrijver van de tests', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  const data = new TextEncoder().encode('Boodschappen voor het weekend: brood, kaas, appels');
  assert.equal(crc32(data), fixtureCrc(data));
});

test('readZip: opgeslagen en "deflate", met en zonder data descriptor, in volgorde', async () => {
  const long = `${'Taak met een lange beschrijving die goed comprimeert. '.repeat(400)}einde`;
  const zip = await makeZip([
    { name: 'Thuis.csv', data: csv, method: 0 },
    { name: 'Werk.csv', data: long, method: 8 },
    { name: 'Hobby.csv', data: long, method: 8, descriptor: true },
    { name: 'Leeg.csv', data: '', method: 8 },
  ], { comment: 'back-up' });
  assert.ok(looksLikeZip(zip));
  const r = await readZip(zip);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => f.name), ['Thuis.csv', 'Werk.csv', 'Hobby.csv', 'Leeg.csv']);
  assert.equal(text(r.files[0].bytes), csv);
  assert.equal(text(r.files[1].bytes), long);
  assert.equal(text(r.files[2].bytes), long, 'data descriptor: de grootte komt uit het register');
  assert.equal(r.files[3].bytes.length, 0);
  assert.deepEqual(r.skipped, []);
});

test('readZip: alleen wat accept goedkeurt wordt uitgepakt; mappen en macOS-rommel stil overgeslagen', async () => {
  const zip = await makeZip([
    { name: 'backup/', data: '', method: 0 },
    { name: 'backup/Thuis.csv', data: csv },
    { name: 'backup/foto.png', data: 'geen foto' },
    { name: '__MACOSX/backup/._Thuis.csv', data: 'x' },
    { name: 'backup/._Werk.csv', data: 'x' },
    { name: 'backup/.DS_Store', data: 'x' },
  ]);
  const r = await readZip(zip, { accept: (name) => name.toLowerCase().endsWith('.csv') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => f.name), ['backup/Thuis.csv']);
  assert.deepEqual(r.skipped, [{ name: 'backup/foto.png', reason: 'type' }]);
});

test('readZip: namen met .., een / of \\ vooraan, een stationsletter of stuurtekens worden overgeslagen', async () => {
  const zip = await makeZip([
    { name: '../buiten.csv', data: csv },
    { name: 'map/../../buiten.csv', data: csv },
    { name: '/etc/passwd.csv', data: csv },
    { name: '\\windows\\x.csv', data: csv },
    { name: 'C:/x.csv', data: csv },
    { name: 'naam\u0001.csv', data: csv },
    { name: 'map\\..\\x.csv', data: csv },
    { name: 'goed..csv', data: csv },
  ]);
  const r = await readZip(zip);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => f.name), ['goed..csv'], 'twee punten midden in een naam zijn gewoon een naam');
  assert.equal(r.skipped.length, 7);
  assert.ok(r.skipped.every((s) => s.reason === 'unsafe'));
  assert.ok(r.skipped.every((s) => !/[\u0000-\u001f]/u.test(s.name)), 'een overgeslagen naam bevat geen stuurtekens meer');
  for (const bad of ['', '..', 'a/../b', '/a', 'D:x', 'a\u0000b', 'x'.repeat(1025)]) assert.equal(isSafeZipName(bad), false, bad);
  for (const good of ['a.csv', 'map/a.csv', 'a..b', '...csv', 'Thuis [123].csv']) assert.equal(isSafeZipName(good), true, good);
});

test('readZip: een naam zonder UTF-8-vlag in de oude codering wordt toch leesbaar', async () => {
  const zip = await makeZip([{ name: '', rawName: Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x2e, 0x63, 0x73, 0x76]), data: csv }]);
  const r = await readZip(zip);
  assert.deepEqual(r.files.map((f) => f.name), ['Café.csv']);
  const utf = await makeZip([{ name: '', rawName: new TextEncoder().encode('Zoë.csv'), data: csv }]);
  assert.deepEqual((await readZip(utf)).files.map((f) => f.name), ['Zoë.csv'], 'zonder vlag maar wel UTF-8');
});

test('readZip: versleuteld, ZIP64 en geen zip worden geweigerd', async () => {
  assert.equal((await readZip(await makeZip([{ name: 'a.csv', data: csv, flags: 1 }]))).code, 'encrypted');
  assert.equal((await readZip(await makeZip([{ name: 'a.csv', data: csv }], { zip64Locator: true }))).code, 'zip64');
  const z64 = await makeZip([{ name: 'a.csv', data: csv }]);
  new DataView(z64.buffer).setUint32(z64.length - 22 + 16, 0xffffffff, true);
  assert.equal((await readZip(z64)).code, 'zip64', 'een register op 0xFFFFFFFF is ZIP64');
  const z64size = await makeZip([{ name: 'a.csv', data: csv }]);
  const cdStart = new DataView(z64size.buffer).getUint32(z64size.length - 22 + 16, true);
  new DataView(z64size.buffer).setUint32(cdStart + 24, 0xffffffff, true);
  assert.equal((await readZip(z64size)).code, 'zip64', 'een grootte van 0xFFFFFFFF is ZIP64');
  assert.equal((await readZip(new TextEncoder().encode(csv.repeat(3)))).code, 'notZip');
  assert.equal((await readZip(new Uint8Array(3))).code, 'notZip');
  assert.equal((await readZip('PK')).code, 'notZip');
  assert.equal(looksLikeZip(new TextEncoder().encode(csv)), false);
});

test('readZip: afgekapt of kapot geeft een fout, nooit een half resultaat', async () => {
  const zip = await makeZip([{ name: 'a.csv', data: csv.repeat(50) }, { name: 'b.csv', data: csv.repeat(50) }]);
  for (const cut of [zip.length - 1, zip.length - 30, Math.floor(zip.length / 2), 30, 4]) {
    const r = await readZip(zip.slice(0, cut));
    assert.equal(r.ok, false, `afgekapt op ${cut}`);
    assert.ok(['corrupt', 'notZip'].includes(r.code), r.code);
  }
  const badCrc = await makeZip([{ name: 'a.csv', data: csv, crc: 12345 }]);
  assert.equal((await readZip(badCrc)).code, 'corrupt', 'verkeerde CRC');
  const badSize = await makeZip([{ name: 'a.csv', data: csv, method: 0, size: 3 }]);
  assert.equal((await readZip(badSize)).code, 'corrupt', 'opgeslagen met een verkeerde grootte');
  const smaller = await makeZip([{ name: 'a.csv', data: csv.repeat(10), size: 5 }]);
  assert.equal((await readZip(smaller)).code, 'corrupt', 'deflate geeft meer dan het register zegt');
  const bigger = await makeZip([{ name: 'a.csv', data: csv, size: csv.length + 10 }]);
  assert.equal((await readZip(bigger)).code, 'corrupt', 'deflate geeft minder dan het register zegt');
  // rommel in plaats van deflate-gegevens
  const junk = await makeZip([{ name: 'a.csv', data: Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256), method: 0 }]);
  const view = new DataView(junk.buffer);
  view.setUint16(8, 8, true); // lokale kop: deflate
  const cd = view.getUint32(junk.length - 22 + 16, true);
  view.setUint16(cd + 10, 8, true);
  assert.equal((await readZip(junk)).code, 'corrupt', 'onzin als deflate');
  // het register wijst naar een plek zonder lokale kop
  const moved = await makeZip([{ name: 'a.csv', data: csv }]);
  const mv = new DataView(moved.buffer);
  mv.setUint32(mv.getUint32(moved.length - 22 + 16, true) + 42, 3, true);
  assert.equal((await readZip(moved)).code, 'corrupt');
  // het aantal records klopt niet met het register
  const count = await makeZip([{ name: 'a.csv', data: csv }]);
  new DataView(count.buffer).setUint16(count.length - 22 + 8, 2, true);
  new DataView(count.buffer).setUint16(count.length - 22 + 10, 2, true);
  assert.equal((await readZip(count)).code, 'corrupt');
  // meerdere schijven
  const disks = await makeZip([{ name: 'a.csv', data: csv }]);
  new DataView(disks.buffer).setUint16(disks.length - 22 + 4, 1, true);
  assert.equal((await readZip(disks)).code, 'corrupt');
});

test('readZip: twee records met dezelfde gegevens (overlap, een zip-bom-truc) worden geweigerd', async () => {
  const zip = await makeZip([{ name: 'a.csv', data: csv }, { name: 'b.csv', data: csv }]);
  const view = new DataView(zip.buffer);
  const cd = view.getUint32(zip.length - 22 + 16, true);
  const second = cd + 46 + 'a.csv'.length;
  view.setUint32(second + 42, 0, true); // b.csv wijst ook naar a.csv
  assert.equal((await readZip(zip)).code, 'corrupt');
});

test('readZip: grenzen aan grootte en aantal; een zip-bom stopt tijdens het uitpakken', async () => {
  const zeros = new Uint8Array(4 * 1024 * 1024); // 4 MiB nullen: comprimeert tot een paar KiB
  const bomb = await makeZip([{ name: 'bom.csv', data: zeros }]);
  assert.ok(bomb.length < 10_000, `klein archief (${bomb.length} bytes)`);
  const small = { fileBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024 };
  const r = await readZip(bomb, { limits: small });
  assert.equal(r.ok, true);
  assert.deepEqual(r.skipped, [{ name: 'bom.csv', reason: 'tooBig' }], 'de grootte in het register is al te groot');
  // het register liegt: zegt 100 bytes, maar er komt 4 MiB uit
  const liar = await makeZip([{ name: 'bom.csv', data: zeros, size: 100 }]);
  const started = Date.now();
  assert.equal((await readZip(liar, { limits: small })).code, 'corrupt');
  assert.ok(Date.now() - started < 5000, 'stopt meteen');
  // samen te groot: het tweede bestand past niet meer
  const two = await makeZip([{ name: 'a.csv', data: new Uint8Array(700_000) }, { name: 'b.csv', data: new Uint8Array(700_000) }, { name: 'c.csv', data: csv }]);
  const t2 = await readZip(two, { limits: { fileBytes: 1_000_000, totalBytes: 1_000_000 } });
  assert.deepEqual(t2.files.map((f) => f.name), ['a.csv', 'c.csv']);
  assert.deepEqual(t2.skipped, [{ name: 'b.csv', reason: 'tooBig' }]);
  // te veel records, te veel bestanden, te groot archief
  const many = await makeZip(Array.from({ length: 12 }, (_, i) => ({ name: `p${i}.csv`, data: csv, method: 0 })));
  assert.equal((await readZip(many, { limits: { entries: 10 } })).code, 'tooMany');
  const capped = await readZip(many, { limits: { files: 10 } });
  assert.equal(capped.files.length, 10);
  assert.deepEqual(capped.skipped.map((s) => s.reason), ['tooMany', 'tooMany']);
  assert.equal((await readZip(many, { limits: { archiveBytes: 100 } })).code, 'tooBig');
});

test('readZip: een onbekende compressiemethode wordt overgeslagen, niet geraden', async () => {
  const zip = await makeZip([{ name: 'a.csv', data: csv, method: 0 }, { name: 'b.csv', data: csv, method: 0 }]);
  const view = new DataView(zip.buffer);
  const cd = view.getUint32(zip.length - 22 + 16, true);
  view.setUint16(cd + 10, 12, true); // bzip2
  const r = await readZip(zip);
  assert.deepEqual(r.files.map((f) => f.name), ['b.csv']);
  assert.deepEqual(r.skipped, [{ name: 'a.csv', reason: 'method' }]);
});

test('readZip: een lege zip en het meest compacte geval', async () => {
  const empty = await makeZip([]);
  assert.equal(empty.length, 22);
  assert.deepEqual(await readZip(empty), { ok: true, files: [], skipped: [] });
  const deflated = await deflateRaw(new TextEncoder().encode('x'));
  assert.ok(deflated.length > 0);
});
