import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDate, isValidRecurrence, nextOccurrence } from './recurrence.js';

test('dagelijks, met interval', () => {
  assert.equal(nextOccurrence('2026-11-13', { freq: 'daily' }), '2026-11-14');
  assert.equal(nextOccurrence('2026-12-30', { freq: 'daily', interval: 3 }), '2027-01-02');
});

test('wekelijks zonder weekdagen = +7 dagen', () => {
  assert.equal(nextOccurrence('2026-11-13', { freq: 'weekly' }), '2026-11-20');
  assert.equal(nextOccurrence('2026-11-13', { freq: 'weekly', interval: 2 }), '2026-11-27');
});

test('wekelijks met weekdagen: binnen dezelfde week, daarna volgende periode', () => {
  // 2026-11-13 is een vrijdag (ISO 5)
  const r = { freq: 'weekly', byweekday: [1, 3, 5] }; // ma, wo, vr
  assert.equal(nextOccurrence('2026-11-09', r), '2026-11-11'); // ma -> wo
  assert.equal(nextOccurrence('2026-11-11', r), '2026-11-13'); // wo -> vr
  assert.equal(nextOccurrence('2026-11-13', r), '2026-11-16'); // vr -> ma erna
  // elke 2 weken op maandag en vrijdag: vrijdag springt twee weken door
  const r2 = { freq: 'weekly', interval: 2, byweekday: [1, 5] };
  assert.equal(nextOccurrence('2026-11-13', r2), '2026-11-23');
});

test('maandelijks: kort de dag in op kortere maanden', () => {
  assert.equal(nextOccurrence('2026-01-31', { freq: 'monthly' }), '2026-02-28');
  assert.equal(nextOccurrence('2028-01-31', { freq: 'monthly' }), '2028-02-29'); // schrikkeljaar
  assert.equal(nextOccurrence('2026-12-15', { freq: 'monthly' }), '2027-01-15');
  assert.equal(nextOccurrence('2026-11-30', { freq: 'monthly', interval: 3 }), '2027-02-28');
});

test('maandelijks met bymonthday: "elke 31e" blijft de 31e, ook na een korte maand', () => {
  const r = { freq: 'monthly', bymonthday: 31 };
  assert.equal(nextOccurrence('2026-01-31', r), '2026-02-28');
  assert.equal(nextOccurrence('2026-02-28', r), '2026-03-31', 'zonder bymonthday zou dit 28 maart zijn');
  assert.equal(nextOccurrence('2026-03-31', r), '2026-04-30');
  // zonder bymonthday: de dag blijft hangen op de ingekorte waarde (bekend gedrag)
  assert.equal(nextOccurrence('2026-02-28', { freq: 'monthly' }), '2026-03-28');
});

test('jaarlijks: 29 februari wordt 28 februari in een gewoon jaar, en met bymonthday weer 29 in een schrikkeljaar', () => {
  assert.equal(nextOccurrence('2028-02-29', { freq: 'yearly' }), '2029-02-28');
  assert.equal(nextOccurrence('2026-11-13', { freq: 'yearly' }), '2027-11-13');
  const r = { freq: 'yearly', bymonthday: 29 };
  assert.equal(nextOccurrence('2028-02-29', r), '2029-02-28');
  assert.equal(nextOccurrence('2031-02-28', r), '2032-02-29');
});

test('het tijdgedeelte blijft behouden', () => {
  assert.equal(nextOccurrence('2026-11-13T09:00:00', { freq: 'daily' }), '2026-11-14T09:00:00');
  assert.equal(nextOccurrence('2026-11-13T09:00', { freq: 'weekly' }), '2026-11-20T09:00');
});

test('validatie van datums en regels', () => {
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-11-13'), true);
  assert.equal(isValidDate('13-11-2026'), false);
  assert.equal(isValidDate('2026-11-13T25:00'), false);
  assert.equal(isValidDate('2026-11-13T09:61'), false);
  assert.equal(isValidDate('2026-11-13T09:30'), true);
  assert.equal(isValidRecurrence({ freq: 'weekly', byweekday: [1, 8] }), false);
  assert.equal(isValidRecurrence({ freq: 'daily', byweekday: [1] }), false);
  assert.equal(isValidRecurrence({ freq: 'monthly', interval: 0 }), false);
  assert.equal(isValidRecurrence({ freq: 'monthly', interval: 2 }), true);
  assert.equal(isValidRecurrence({ freq: 'monthly', bymonthday: 31 }), true);
  assert.equal(isValidRecurrence({ freq: 'monthly', bymonthday: 32 }), false);
  assert.equal(isValidRecurrence({ freq: 'weekly', bymonthday: 3 }), false);
  assert.equal(isValidRecurrence({ freq: 'daily', until: '2027-01-01' }), false, 'onbekende velden worden geweigerd');
  assert.equal(isValidRecurrence(null), false);
});
