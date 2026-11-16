// Algemene voorkeuren (shared/general.js): de controle, de standaard en de startpagina.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GENERAL, generalCheck, generalOf, startRoute, viewFromHash } from './general.js';

test('controle: alleen bekende velden met geldige waarden', () => {
  assert.equal(generalCheck(null), null);
  assert.equal(generalCheck({}), null);
  assert.equal(generalCheck({ start_page: 'today', time_format: '12h', date_recognition: false, sidebar_hidden: ['notes', 'labels'] }), null);
  for (const bad of [[], 'x', { start_page: 'calendar' }, { time_format: '13h' }, { date_recognition: 'nee' }, { sidebar_hidden: ['inbox'] }, { sidebar_hidden: ['notes', 'notes'] }, { iets: 1 }, { week_start: 2 }, { week_start: '1' }]) {
    assert.notEqual(generalCheck(bad), null, JSON.stringify(bad));
  }
});

test('de voorkeuren met de standaard aangevuld; iets kapots wordt de standaard', () => {
  assert.deepEqual(generalOf(null), { ...DEFAULT_GENERAL, sidebar_hidden: [] });
  assert.deepEqual(generalOf({ general: { time_format: '12h' } }), { start_page: 'last', time_format: '12h', date_recognition: true, sidebar_hidden: [], week_start: 1 });
  assert.equal(generalOf({ general: { week_start: 7 } }).week_start, 7);
  assert.deepEqual(generalOf({ general: { start_page: 'nergens' } }).start_page, 'last');
});

test('startpagina: een route, of null voor waar je was', () => {
  assert.deepEqual(startRoute('today'), { type: 'today' });
  assert.deepEqual(startRoute('inbox', 'inbox-anna'), { type: 'project', id: 'inbox-anna' });
  assert.equal(startRoute('inbox'), null);
  assert.equal(startRoute('last'), null);
});

test('een plek uit het adres: alleen de vaste namen', () => {
  assert.equal(viewFromHash('#view=today'), 'today');
  assert.equal(viewFromHash('#view=notes'), 'notes');
  for (const bad of ['', null, '#view=', '#view=last', '#view=today&x', '#task=abc', '#view=TODAY']) assert.equal(viewFromHash(bad), null, String(bad));
});
