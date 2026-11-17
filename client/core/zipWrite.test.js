// Tests voor de zip-schrijver (core/zipWrite.js): elke zip wordt teruggelezen met de strenge lezer uit core/zip.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip } from './zip.js';
import { buildZip, safeFileName, uniquePath, zipParts } from './zipWrite.js';

const text = (bytes) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

test('een zip met tekst en bytes, namen in UTF-8, terug te lezen en met de juiste inhoud', async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
  const zip = buildZip([
    { name: 'Café.csv', data: '\uFEFFTYPE,CONTENT\r\ntask,Crème kopen\r\n' },
    { name: 'Thuis/Foto’s/plaatje.bin', data: bytes },
    { name: 'leeg.txt', data: '' },
  ], new Date(2026, 10, 17, 9, 30, 12));
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  const back = await readZip(zip);
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.deepEqual(back.files.map((f) => f.name), ['Café.csv', 'Thuis/Foto’s/plaatje.bin', 'leeg.txt']);
  assert.equal(text(back.files[0].bytes), '\uFEFFTYPE,CONTENT\r\ntask,Crème kopen\r\n');
  assert.deepEqual([...back.files[1].bytes], [...bytes]);
  assert.equal(back.files[2].bytes.length, 0);
});

test('de stukken zijn samen precies de zip, en een lege zip kan ook', async () => {
  const files = [{ name: 'a.txt', data: 'een' }, { name: 'b.txt', data: 'twee' }];
  const now = new Date(2026, 0, 1);
  const parts = zipParts(files, now);
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { joined.set(p, at); at += p.length; }
  assert.deepEqual([...joined], [...buildZip(files, now)]);
  const empty = await readZip(buildZip([]));
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.files, []);
});

test('veilige namen: geen verboden tekens, niet leeg, niet te lang, geen punt aan het eind', () => {
  assert.equal(safeFileName('Werk / Thuis: "plan"?'), 'Werk _ Thuis_ _plan__');
  assert.equal(safeFileName('  boodschappen.  '), 'boodschappen');
  assert.equal(safeFileName(''), '_');
  assert.equal(safeFileName('..'), '_');
  assert.equal(safeFileName(null, 'taak'), 'taak');
  assert.equal(safeFileName('regel\neen\ttab'), 'regel_een_tab');
  assert.equal([...safeFileName('é'.repeat(300))].length, 100);
});

test('unieke paden: een nummer erbij, zonder op hoofdletters te letten, ook zonder extensie', () => {
  const taken = new Set();
  assert.equal(uniquePath(taken, 'Werk.csv'), 'Werk.csv');
  assert.equal(uniquePath(taken, 'werk.csv'), 'werk (2).csv');
  assert.equal(uniquePath(taken, 'Werk.csv'), 'Werk (3).csv');
  assert.equal(uniquePath(taken, 'map.d/bestand'), 'map.d/bestand');
  assert.equal(uniquePath(taken, 'map.d/bestand'), 'map.d/bestand (2)');
});
