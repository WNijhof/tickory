// Algemene voorkeuren (shared/general.js): de controle, de standaard en de startpagina.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GENERAL, SNOOZE_MINUTES, SWIPE_ACTIONS, generalCheck, generalOf, inVacation, placeFromHash, startRoute, vacationsCheck, viewFromHash } from './general.js';

test('controle: alleen bekende velden met geldige waarden', () => {
  assert.equal(generalCheck(null), null);
  assert.equal(generalCheck({}), null);
  assert.equal(generalCheck({ start_page: 'today', time_format: '12h', date_recognition: false, sidebar_hidden: ['notes', 'labels'] }), null);
  for (const bad of [[], 'x', { start_page: 'calendar' }, { time_format: '13h' }, { date_recognition: 'nee' }, { sidebar_hidden: ['inbox'] }, { sidebar_hidden: ['notes', 'notes'] }, { iets: 1 }, { week_start: 2 }, { week_start: '1' }, { bottom_tabs: ['inbox', 'today'] }, { bottom_tabs: ['inbox', 'inbox', 'today'] }, { bottom_tabs: ['inbox', 'today', 'browse'] }, { bottom_tabs: ['inbox', 'today', 'upcoming', 'notes', 'labels'] }, { productivity: 'nee' }]) {
    assert.notEqual(generalCheck(bad), null, JSON.stringify(bad));
  }
});

test('de voorkeuren met de standaard aangevuld; iets kapots wordt de standaard', () => {
  assert.deepEqual(generalOf(null), { ...DEFAULT_GENERAL, sidebar_hidden: [], bottom_tabs: ['inbox', 'today', 'upcoming', 'notes'] });
  assert.deepEqual(generalOf({ general: { time_format: '12h' } }), { ...generalOf(null), time_format: '12h' });
  assert.equal(generalOf({ general: { productivity: false } }).productivity, false);
  // een oudere keuze van drie knoppen krijgt Notities erbij, tenzij die er al in staat
  assert.deepEqual(generalOf({ general: { bottom_tabs: ['inbox', 'today', 'upcoming'] } }).bottom_tabs, ['inbox', 'today', 'upcoming', 'notes']);
  assert.deepEqual(generalOf({ general: { bottom_tabs: ['inbox', 'today', 'upcoming', 'labels'] } }).bottom_tabs, ['inbox', 'today', 'upcoming', 'labels']);
  assert.deepEqual(generalOf({ general: { bottom_tabs: ['notes', 'today', 'inbox'] } }).bottom_tabs, ['notes', 'today', 'inbox']);
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
  assert.equal(viewFromHash('#view=productivity'), 'productivity');
  assert.equal(viewFromHash('#view=completed'), 'completed'); // Voltooid in het systeemvak van de desktop-app
  assert.deepEqual(startRoute('completed'), { type: 'completed' });
  for (const bad of ['', null, '#view=', '#view=last', '#view=today&x', '#task=abc', '#view=TODAY']) assert.equal(viewFromHash(bad), null, String(bad));
});

test('een project, label of filter uit het adres (een lijstwidget van de Android-app)', () => {
  assert.deepEqual(placeFromHash('#project=p_boodschappen-1'), { type: 'project', id: 'p_boodschappen-1' });
  assert.deepEqual(placeFromHash('#label=l1'), { type: 'label', id: 'l1' });
  assert.deepEqual(placeFromHash('#filter=f1'), { type: 'filter', id: 'f1' });
  for (const bad of ['', null, '#project=', '#project=a/b', '#project=a&x', '#section=s1', '#view=today', `#project=${'a'.repeat(65)}`, '#PROJECT=p1']) {
    assert.equal(placeFromHash(bad), null, String(bad));
  }
});

test('volgende week, weekend, veegacties, geluid, vieren en uitstel: controle en standaard', () => {
  const d = generalOf(null);
  assert.deepEqual([d.next_week, d.weekend, d.swipe_right, d.swipe_left, d.completion_sound, d.goal_celebrations, d.snooze_minutes], [1, 6, 'complete', 'schedule', false, true, 10]);
  assert.equal(generalCheck({ next_week: 7, weekend: 5, swipe_right: 'none', swipe_left: 'delete', completion_sound: true, goal_celebrations: false, snooze_minutes: 1440 }), null);
  for (const bad of [{ next_week: 0 }, { weekend: 8 }, { swipe_right: 'archive' }, { swipe_left: 1 }, { completion_sound: 'ja' }, { goal_celebrations: 1 }, { snooze_minutes: 7 }]) assert.notEqual(generalCheck(bad), null, JSON.stringify(bad));
  for (const a of SWIPE_ACTIONS) assert.equal(generalCheck({ swipe_right: a }), null);
  for (const m of SNOOZE_MINUTES) assert.equal(generalCheck({ snooze_minutes: m }), null);
  assert.equal(generalOf({ general: { weekend: 7, swipe_left: 'select' } }).weekend, 7);
  assert.equal(generalOf({ general: { weekend: 99 } }).weekend, 6, 'iets kapots wordt de standaard');
});

test('vakanties: op volgorde, een lopende alleen als laatste, en welke dag erin valt', () => {
  assert.equal(vacationsCheck([]), null);
  assert.equal(vacationsCheck([{ from: '2026-07-01', to: '2026-07-14' }, { from: '2026-12-20', to: null }]), null);
  for (const bad of [
    [{ from: '2026-07-14', to: '2026-07-01' }], [{ from: '2026-07-01', to: null }, { from: '2026-08-01', to: null }],
    [{ from: '2026-08-01', to: '2026-08-05' }, { from: '2026-07-01', to: '2026-07-14' }], [{ from: 'morgen', to: null }], [{ from: '2026-07-01' }], 'x', [{ from: '2026-07-01', to: null, x: 1 }],
  ]) assert.notEqual(vacationsCheck(bad), null, JSON.stringify(bad));
  assert.notEqual(generalCheck({ vacations: [{ from: 'x', to: null }] }), null);
  const v = [{ from: '2026-07-01', to: '2026-07-14' }, { from: '2026-12-20', to: null }];
  assert.equal(inVacation(v, '2026-07-01'), true);
  assert.equal(inVacation(v, '2026-07-14'), true);
  assert.equal(inVacation(v, '2026-07-15'), false);
  assert.equal(inVacation(v, '2027-03-01'), true, 'een lopende vakantie duurt voort');
  assert.equal(inVacation([], '2026-07-01'), false);
});

test('ochtendoverzicht en avondreview: een tijd UU:MM of null', () => {
  assert.deepEqual([generalOf(null).morning_overview, generalOf(null).evening_review], [null, null]);
  assert.equal(generalCheck({ morning_overview: '08:00', evening_review: null }), null);
  assert.equal(generalOf({ general: { evening_review: '18:30' } }).evening_review, '18:30');
  for (const bad of ['8:00', '24:00', '12:60', 'ochtend', 800, true]) assert.notEqual(generalCheck({ morning_overview: bad }), null, String(bad));
});

test('toast_seconds: 4, 6, 10, 20 of 0 (tot je hem wegklikt); standaard 6', async () => {
  const { DEFAULT_GENERAL, TOAST_SECONDS, generalCheck, generalOf } = await import('./general.js');
  assert.equal(DEFAULT_GENERAL.toast_seconds, 6);
  assert.equal(generalOf(null).toast_seconds, 6);
  for (const s of TOAST_SECONDS) assert.equal(generalCheck({ toast_seconds: s }), null, String(s));
  for (const bad of [5, -1, '6', 3.5, null]) assert.match(generalCheck({ toast_seconds: bad }) ?? '', /toast_seconds/, String(bad));
});
