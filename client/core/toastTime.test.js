import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TOAST_MS, toastMs } from './toastTime.js';

test('meldingen onderin: zo lang als je kiest; een fout nooit korter, een korte status blijft kort, 0 blijft staan', () => {
  assert.equal(toastMs(null, 6), DEFAULT_TOAST_MS, 'de standaard');
  assert.equal(toastMs(undefined, 10), 10_000);
  assert.equal(toastMs(null, 4), 4000);
  assert.equal(toastMs(null, 0), 0, 'tot je hem wegklikt');
  assert.equal(toastMs(12_000, 4), 12_000, 'een foutmelding wordt niet korter');
  assert.equal(toastMs(10_000, 20), 20_000, 'wel langer als je dat kiest');
  assert.equal(toastMs(10_000, 0), 0);
  assert.equal(toastMs(3000, 0), 3000, 'een korte status (Luisteren…) blijft kort');
  assert.equal(toastMs(3000, 20), 3000);
  assert.equal(toastMs(0, 4), 0, 'een melding die altijd moet blijven staan');
  assert.equal(toastMs(null, Number.NaN), DEFAULT_TOAST_MS, 'een onzinwaarde: de standaard');
});
