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
