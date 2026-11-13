import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from './i18n.js';
import { needsTimeNote, offsetText, presetOptions, reminderLine } from './reminderText.js';

afterEach(() => setLanguage('nl'));
const TODAY = '2026-12-01';

test('Nederlands: elke keuze als zin, met enkelvoud en meervoud', () => {
  setLanguage('nl');
  assert.deepEqual(presetOptions().map((o) => o.label), [
    'Op het tijdstip van de taak', '10 minuten vooraf', '30 minuten vooraf', '45 minuten vooraf',
    '1 uur vooraf', '2 uur vooraf', '3 uur vooraf', '1 dag vooraf', '2 dagen vooraf', '3 dagen vooraf',
  ]);
  assert.deepEqual([1, 90, 1500, 10080].map(offsetText), ['1 minuut vooraf', '90 minuten vooraf', '25 uur vooraf', '7 dagen vooraf']);
});

test('Engels: dezelfde keuzes, met eigen meervoud', () => {
  setLanguage('en');
  assert.deepEqual(presetOptions().map((o) => o.label), [
    'At the time of the task', '10 minutes before', '30 minutes before', '45 minutes before',
    '1 hour before', '2 hours before', '3 hours before', '1 day before', '2 days before', '3 days before',
  ]);
  assert.equal(offsetText(1), '1 minute before');
});

test('een herinnering als regel: wat het is en wanneer ze afgaat', () => {
  const rel = { type: 'relative', minute_offset: 30 };
  const abs = { type: 'absolute', due: { date: '2026-12-02T08:00' } };
  setLanguage('nl');
  assert.equal(reminderLine(rel, '2026-12-01T08:30', TODAY), '30 minuten vooraf · vandaag 08:30');
  assert.equal(reminderLine(abs, '2026-12-02T08:00', TODAY), 'Op een vast tijdstip · morgen 08:00');
  assert.equal(reminderLine(rel, null, TODAY), '30 minuten vooraf · gaat af zodra de taak een tijd heeft');
  setLanguage('en');
  assert.equal(reminderLine(rel, '2026-12-01T08:30', TODAY), '30 minutes before · today 08:30');
  assert.equal(reminderLine(abs, '2026-12-02T08:00', TODAY), 'At a set time · tomorrow 08:00');
  assert.equal(reminderLine(rel, null, TODAY), '30 minutes before · goes off once the task has a time');
});

test('de uitleg bij een taak zonder tijd gebruikt in het Engels een notatie die de datumherkenner leest', () => {
  setLanguage('nl');
  assert.match(needsTimeNote(), /"morgen om 14 uur"/);
  setLanguage('en');
  assert.match(needsTimeNote(), /2026-12-31T14:30/);
  assert.ok(!/\b(morgen|uur|taak)\b/.test(needsTimeNote()), 'geen Nederlands in de Engelse uitleg');
});
