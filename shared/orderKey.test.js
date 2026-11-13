import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidKey, keyAfter, keyBefore, keyBetween, keysEvenly } from './orderKey.js';

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
