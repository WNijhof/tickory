import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidRecurrence, nextDue, nextOccurrence } from './recurrence.js';

test('fromCompletion is een geldig veld, maar alleen true', () => {
  assert.equal(isValidRecurrence({ freq: 'daily', interval: 3, fromCompletion: true }), true);
  for (const bad of [false, 1, 'ja', null, {}]) assert.equal(isValidRecurrence({ freq: 'daily', fromCompletion: bad }), false, JSON.stringify(bad));
});

test('zonder fromCompletion telt de oude datum, ook als er een afvinkdag wordt meegegeven', () => {
  const rec = { freq: 'daily', interval: 3 };
  assert.equal(nextDue('2026-11-10', rec, '2026-11-20'), '2026-11-13');
  assert.equal(nextDue('2026-11-10', rec), nextOccurrence('2026-11-10', rec));
});

test('met fromCompletion telt de afvinkdag: te laat afvinken schuift verder op, het tijdstip blijft', () => {
  const rec = { freq: 'daily', interval: 3, fromCompletion: true };
  assert.equal(nextDue('2026-11-10', rec, '2026-11-20'), '2026-11-23');
  assert.equal(nextDue('2026-11-10T09:30', rec, '2026-11-20'), '2026-11-23T09:30');
  assert.equal(nextDue('2026-11-10', rec, '2026-11-10'), '2026-11-13', 'op de dag zelf: gelijk aan een vaste herhaling');
  assert.equal(nextDue('2026-11-10', rec, '2026-11-08'), '2026-11-11', 'te vroeg afvinken telt ook vanaf de afvinkdag');
});

test('met fromCompletion en een weekdag: de eerstvolgende die weekdag na het afvinken', () => {
  const rec = { freq: 'weekly', byweekday: [1], fromCompletion: true }; // elke! maandag
  assert.equal(nextDue('2026-11-09', rec, '2026-11-12'), '2026-11-16'); // donderdag afgevinkt: de maandag erna
  assert.equal(nextDue('2026-11-09', rec, '2026-11-16'), '2026-11-23'); // op een maandag: de volgende
});

test('met fromCompletion: maanden en jaren, en schrikkeljaar', () => {
  assert.equal(nextDue('2026-01-31', { freq: 'monthly', fromCompletion: true }, '2026-03-05'), '2026-04-05');
  // een vaste dag van de maand telt vanaf de maand van het afvinken: de volgende maand erna, ingekort waar de maand korter is
  assert.equal(nextDue('2026-01-31', { freq: 'monthly', bymonthday: 31, fromCompletion: true }, '2026-02-10'), '2026-03-31');
  assert.equal(nextDue('2026-01-31', { freq: 'monthly', bymonthday: 31, fromCompletion: true }, '2026-01-31'), '2026-02-28');
  assert.equal(nextDue('2028-02-29', { freq: 'yearly', fromCompletion: true }, '2028-03-01'), '2029-03-01');
});

test('een ontbrekende of ongeldige afvinkdag valt terug op de oude datum', () => {
  const rec = { freq: 'daily', interval: 3, fromCompletion: true };
  for (const bad of [undefined, null, '', 'vandaag', '2026-13-01', '2026-02-30', '2026-11-20T10:00', 20261120, {}]) {
    assert.equal(nextDue('2026-11-10', rec, bad), '2026-11-13', String(JSON.stringify(bad)));
  }
});

test('na het einde van het bereik is er geen volgende keer', () => {
  assert.equal(nextDue('2026-11-10', { freq: 'daily', fromCompletion: true }, '9999-12-31'), null);
});
