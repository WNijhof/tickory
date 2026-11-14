import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidKey, keyAfter, keyBefore, keyBetween, keysAfter, keysEvenly } from './orderKey.js';

test('eerste sleutel in een lege lijst is geldig', () => {
  const k = keyBetween(null, null);
  assert.ok(isValidKey(k));
});

test('keyAfter en keyBefore geven de juiste volgorde', () => {
  const m = keyBetween(null, null);
  assert.ok(keyAfter(m) > m);
  assert.ok(keyBefore(m) < m);
});

test('tussen twee opeenvolgende sleutels bestaat altijd een nieuwe', () => {
  const a = '1';
  const b = '2';
  const m = keyBetween(a, b);
  assert.ok(a < m && m < b, `${a} < ${m} < ${b}`);
});

test('herhaald invoegen op dezelfde plek blijft kloppen (sleutels groeien lineair, niet exponentieel)', () => {
  let lo = keyBetween(null, null);
  const hi = keyAfter(lo);
  for (let i = 0; i < 200; i++) {
    const m = keyBetween(lo, hi);
    assert.ok(lo < m && m < hi);
    assert.ok(isValidKey(m));
    lo = m;
  }
  assert.ok(lo.length < 400, `lengte ${lo.length}`);
});

test('eigenschappentest: willekeurige invoegingen houden de lijst gesorteerd en uniek', () => {
  // eenvoudige, deterministische pseudo-random zodat een mislukking reproduceerbaar is
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const list = [];
  for (let i = 0; i < 2000; i++) {
    const pos = rnd(list.length + 1);
    const k = keyBetween(list[pos - 1] ?? null, list[pos] ?? null);
    assert.ok(isValidKey(k), `ongeldig: ${k}`);
    list.splice(pos, 0, k);
  }
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1] < list[i], `volgorde stuk bij ${i}`);
  assert.equal(new Set(list).size, list.length);
});

test('keysEvenly levert een oplopende reeks', () => {
  const k = keysEvenly(50);
  assert.equal(k.length, 50);
  for (let i = 1; i < k.length; i++) assert.ok(k[i - 1] < k[i]);
});

test('ongeldige invoer wordt geweigerd', () => {
  assert.throws(() => keyBetween('b', 'a'));
  assert.throws(() => keyBetween('a0', null));
  assert.equal(isValidKey('a0'), false);
  assert.equal(isValidKey(''), false);
  assert.equal(isValidKey('ab c'), false);
});

test('keysAfter: een hele reeks oplopende, geldige en korte sleutels achter een bestaande', () => {
  assert.deepEqual(keysAfter(null, 0), []);
  for (const [after, n] of [[null, 1], [null, 7], [null, 61], [null, 450], [null, 1000], ['V', 1], ['V', 300], ['zzV', 100], ['zzzzzzzzzzzzzzzzzzzzV', 50], [keyAfter(keyAfter('x')), 1000]]) {
    const keys = keysAfter(after, n);
    assert.equal(keys.length, n);
    assert.ok(keys.every(isValidKey), `${after}/${n}: ongeldige sleutel`);
    assert.deepEqual([...keys].sort(), keys, `${after}/${n}: niet oplopend`);
    assert.equal(new Set(keys).size, n, `${after}/${n}: dubbele sleutels`);
    if (after) assert.ok(keys[0] > after, `${after}/${n}: niet achter de bestaande sleutel`);
    assert.ok(keys.at(-1).length <= (after?.length ?? 0) + 4, `${after}/${n}: sleutels te lang (${keys.at(-1).length})`);
  }
  // tegenover keyAfter achter elkaar, dat na ruim 320 sleutels de grens van 64 tekens overschrijdt
  let k = null;
  for (let i = 0; i < 450; i++) k = keyAfter(k);
  assert.ok(!isValidKey(k));
  assert.ok(isValidKey(keysAfter(null, 450).at(-1)));
  // en er blijft altijd ruimte om tussen twee van de sleutels in te voegen
  const keys = keysAfter(null, 30);
  for (let i = 1; i < keys.length; i++) assert.ok(isValidKey(keyBetween(keys[i - 1], keys[i])));
});
