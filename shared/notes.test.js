// Tests voor de gedeelde regels van notities (shared/notes.js): achtergronden en voorkeuren.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NOTE_PREFS, NOTE_BACKGROUNDS, NOTE_COLORS, NOTE_PATTERNS, notePrefsCheck, notePrefsOf } from './notes.js';
import { ENTITIES } from './schema.js';

test('achtergronden: tien kleuren en acht patronen, zonder dubbele namen', () => {
  assert.equal(NOTE_COLORS.length, 10);
  assert.equal(NOTE_PATTERNS.length, 8);
  assert.equal(new Set(NOTE_BACKGROUNDS).size, 18);
  const col = ENTITIES.note.cols.find((c) => c.name === 'background');
  assert.deepEqual([col.nullable, col.default], [true, null]);
});

test('voorkeuren: controle', () => {
  assert.equal(notePrefsCheck({}), null);
  assert.equal(notePrefsCheck({ layout: 'list', sort: 'title', order: 'asc', checked_bottom: false }), null);
  for (const bad of [null, [], 'x']) assert.match(notePrefsCheck(bad), /object/);
  assert.match(notePrefsCheck({ layout: 'tegels' }), /layout/);
  assert.match(notePrefsCheck({ sort: 'kleur' }), /sort/);
  assert.match(notePrefsCheck({ order: 'op' }), /order/);
  assert.match(notePrefsCheck({ checked_bottom: 'ja' }), /checked_bottom/);
  assert.match(notePrefsCheck({ iets: 1 }), /onbekend veld/);
  const col = ENTITIES.settings.cols.find((c) => c.name === 'note_prefs');
  assert.equal(col.check({ layout: 'x' }) !== null, true);
});

test('voorkeuren: de standaard vult aan, onbekende waarden tellen niet', () => {
  assert.deepEqual(notePrefsOf(null), { ...DEFAULT_NOTE_PREFS });
  assert.deepEqual(notePrefsOf({ note_prefs: { layout: 'grid', sort: 'nieuw' } }), { ...DEFAULT_NOTE_PREFS, layout: 'grid' });
  assert.deepEqual(notePrefsOf({ note_prefs: { checked_bottom: false } }).checked_bottom, false);
  assert.deepEqual(DEFAULT_NOTE_PREFS, { layout: 'masonry', sort: 'updated', order: 'desc', checked_bottom: true });
});

import { lastNoteReminder, nextNoteReminder, noteHeadline, noteReminderAt, noteRemindCheck } from './notes.js';

test('herinnering: alleen een bestaande datum met tijd', () => {
  assert.equal(noteRemindCheck('2026-11-16T09:30'), null);
  for (const bad of ['2026-11-16', '2026-11-16T25:00', '2026-02-30T09:00', '2026-11-16 09:30', '2026-11-16T09:30:00', 'morgen', '1999-01-01T00:00']) {
    assert.notEqual(noteRemindCheck(bad), null, bad);
  }
});

test('herhaling: dagen, weken, maanden (31e wordt de laatste dag) en jaren (29 februari)', () => {
  assert.equal(noteReminderAt('2026-01-31T09:00', 'daily', 1), '2026-02-01T09:00');
  assert.equal(noteReminderAt('2026-12-28T09:00', 'weekly', 1), '2027-01-04T09:00');
  assert.equal(noteReminderAt('2026-01-31T09:00', 'monthly', 1), '2026-02-28T09:00');
  assert.equal(noteReminderAt('2026-01-31T09:00', 'monthly', 2), '2026-03-31T09:00', 'de maand erna weer de 31e');
  assert.equal(noteReminderAt('2028-02-29T08:00', 'yearly', 1), '2029-02-28T08:00');
  assert.equal(noteReminderAt('2028-02-29T08:00', 'yearly', 4), '2032-02-29T08:00');
  assert.equal(noteReminderAt('2026-11-30T09:00', 'monthly', 3), '2027-02-28T09:00');
});

test('de volgende keer: eenmalig voorbij geeft null; een herhaling vindt de eerstvolgende, ook na lange tijd', () => {
  assert.equal(nextNoteReminder('2026-11-16T09:00', null, '2026-11-16T08:59'), '2026-11-16T09:00');
  assert.equal(nextNoteReminder('2026-11-16T09:00', null, '2026-11-16T09:01'), null);
  assert.equal(nextNoteReminder('2026-11-16T09:00', 'daily', '2026-11-16T09:01'), '2026-11-17T09:00');
  assert.equal(nextNoteReminder('2020-01-06T09:00', 'weekly', '2026-11-18T10:00'), '2026-11-23T09:00', 'maandagen sinds 2020');
  assert.equal(nextNoteReminder('2026-01-31T09:00', 'monthly', '2026-04-15T00:00'), '2026-04-30T09:00');
  assert.equal(nextNoteReminder('2000-02-29T09:00', 'yearly', '2026-03-01T00:00'), '2027-02-28T09:00');
  assert.equal(nextNoteReminder(null, 'daily', '2026-01-01T00:00'), null);
  assert.equal(nextNoteReminder('kapot', 'daily', '2026-01-01T00:00'), null);
});

test('de laatste keer tot nu: voor de server die net op tijd moet melden', () => {
  assert.equal(lastNoteReminder('2026-11-16T09:00', null, '2026-11-16T09:30'), '2026-11-16T09:00');
  assert.equal(lastNoteReminder('2026-11-16T09:00', null, '2026-11-16T08:59'), null, 'nog niet');
  assert.equal(lastNoteReminder('2020-01-06T09:00', 'weekly', '2026-11-23T09:05'), '2026-11-23T09:00');
  assert.equal(lastNoteReminder('2020-01-06T09:00', 'weekly', '2026-11-23T08:59'), '2026-11-16T09:00');
  assert.equal(lastNoteReminder('2026-01-31T09:00', 'monthly', '2026-02-28T09:00'), '2026-02-28T09:00');
  assert.equal(lastNoteReminder('2026-11-16T09:00', 'daily', '2026-11-16T09:00'), '2026-11-16T09:00', 'precies op tijd telt');
});

test('de kop van een melding: titel, anders de eerste regel zonder opmaaktekens', () => {
  assert.equal(noteHeadline({ title: '  Plan ', content: 'x' }), 'Plan');
  assert.equal(noteHeadline({ title: '', content: '\n- [ ] **melk** halen\nmeer' }), 'melk halen');
  assert.equal(noteHeadline({ title: '', content: '## =={green}Let op== [link](https://x.nl)' }), 'Let op link');
  assert.equal(noteHeadline({ title: '', content: '' }), '');
  assert.equal(noteHeadline({ title: 'x'.repeat(500) }, 120).length, 120);
});

test('de herinnering staat in het schema met dezelfde controle', () => {
  const at = ENTITIES.note.cols.find((c) => c.name === 'remind_at');
  const repeat = ENTITIES.note.cols.find((c) => c.name === 'remind_repeat');
  assert.deepEqual([at.nullable, at.default, repeat.nullable, repeat.oneOf], [true, null, true, ['daily', 'weekly', 'monthly', 'yearly']]);
  assert.notEqual(at.check('2026-02-30T09:00'), null);
});
