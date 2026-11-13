import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepNormalize, nameKey, normalizeText } from './text.js';

const NFD_CAFE = 'Café'; // "Café" met een los accent, zoals sommige toetsenborden het opleveren
const NFC_CAFE = 'Café';

test('de ontleedde en de gewone schrijfwijze zijn voor het oog gelijk maar niet voor een computer, tot normalisatie', () => {
  assert.notEqual(NFD_CAFE, NFC_CAFE);
  assert.equal(NFD_CAFE.length, 5);
  assert.equal(normalizeText(NFD_CAFE), NFC_CAFE);
  assert.equal(normalizeText(NFD_CAFE).length, 4);
});

test('nameKey: hoofdletters, accenten en spaties', () => {
  const same = (a, b) => assert.equal(nameKey(a), nameKey(b), `${JSON.stringify(a)} en ${JSON.stringify(b)} horen gelijk te zijn`);
  same('Café', 'CAFÉ');
  same(NFD_CAFE, 'café');
  same('één', 'ÉÉN');
  same('Zoë', 'ZOË');
  same('Noël', 'noël');
  same('Ömer', 'ömer');
  same('IJsselmeer', 'ijsselmeer');
  same('  Boodschappen   doen ', 'boodschappen doen');
  assert.notEqual(nameKey('Cafe'), nameKey('Café'), 'met en zonder accent zijn verschillende namen');
  assert.notEqual(nameKey('één'), nameKey('een'), '"één" (getal) en "een" (lidwoord) blijven verschillend');
});

test('deepNormalize: alle tekst in lijsten en objecten, de rest ongemoeid', () => {
  const input = { name: NFD_CAFE, nested: { list: [NFD_CAFE, 3, true, null], n: 7 }, due: { string: `voor ${NFD_CAFE}` }, ok: null };
  const out = deepNormalize(input);
  assert.deepEqual(out, { name: NFC_CAFE, nested: { list: [NFC_CAFE, 3, true, null], n: 7 }, due: { string: `voor ${NFC_CAFE}` }, ok: null });
  assert.equal(input.name, NFD_CAFE, 'het origineel blijft ongewijzigd');
  assert.equal(deepNormalize(undefined), undefined);
  assert.equal(deepNormalize(42), 42);
});
