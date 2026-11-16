// Tests voor de weergave-opties per lijst (shared/viewOptions.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPTIONS, groupChoices, isDefaultOptions, optionsFor, viewKey, viewOptionsCheck, withOptions } from './viewOptions.js';
import { ENTITIES } from './schema.js';

test('de sleutel van een lijst: project:<id>, today of upcoming', () => {
  assert.equal(viewKey({ type: 'project', id: 'p1' }), 'project:p1');
  assert.equal(viewKey({ type: 'today' }), 'today');
  assert.equal(viewKey({ type: 'upcoming' }), 'upcoming');
});

test('controle: geldige keuzes, ook een lege', () => {
  assert.equal(viewOptionsCheck({}), null);
  assert.equal(viewOptionsCheck({ today: { sort: 'priority', dir: 'desc', group: 'label' }, 'project:abc': { sort: 'name' } }), null);
});

test('controle: afgekeurd wat geen object is, een onbekende lijst, sortering, richting of indeling', () => {
  for (const bad of [null, [], 'x', 5]) assert.match(viewOptionsCheck(bad), /object/);
  assert.match(viewOptionsCheck({ inbox: {} }), /onbekende lijst/);
  assert.match(viewOptionsCheck({ today: 'x' }), /object/);
  assert.match(viewOptionsCheck({ today: { sort: 'kleur' } }), /sorteren/);
  assert.match(viewOptionsCheck({ today: { dir: 'zijwaarts' } }), /richting/);
  assert.match(viewOptionsCheck({ today: { group: 'maand' } }), /groeperen/);
  assert.match(viewOptionsCheck({ today: { sorteer: 'name' } }), /onbekend veld/);
  assert.match(viewOptionsCheck({ ['project:' + 'x'.repeat(100)]: {} }), /onbekende lijst/); // een te lange sleutel
});

test('controle: hooguit 500 lijsten', () => {
  const many = {};
  for (let i = 0; i < 501; i++) many[`project:p${i}`] = { sort: 'name' };
  assert.match(viewOptionsCheck(many), /hooguit 500/);
  delete many['project:p0'];
  assert.equal(viewOptionsCheck(many), null);
});

test('de instellingen kennen het veld en keuren het met dezelfde controle', () => {
  const col = ENTITIES.settings.cols.find((c) => c.name === 'view_options');
  assert.equal(col.type, 'json');
  assert.equal(col.nullable, true);
  assert.equal(col.default, null);
  assert.equal(col.check({ today: { group: 'nee' } }) !== null, true);
});

test('zonder keuze (of met rommel) geldt de standaard', () => {
  assert.deepEqual(optionsFor(null, 'today'), DEFAULT_OPTIONS);
  assert.deepEqual(optionsFor({ view_options: null }, 'today'), DEFAULT_OPTIONS);
  assert.deepEqual(optionsFor({ view_options: { today: 'x' } }, 'today'), DEFAULT_OPTIONS);
  // een waarde van een nieuwere versie wordt genegeerd, de rest blijft
  assert.deepEqual(optionsFor({ view_options: { today: { sort: 'kleur', dir: 'desc', group: 'label' } } }, 'today'), { sort: 'manual', dir: 'desc', group: 'label' });
});

test('withOptions: een keuze erbij, per lijst apart, zonder het origineel te wijzigen', () => {
  const start = { today: { sort: 'name', dir: 'asc', group: 'default' } };
  const next = withOptions(start, 'upcoming', { group: 'priority' });
  assert.deepEqual(next, { today: { sort: 'name', dir: 'asc', group: 'default' }, upcoming: { sort: 'manual', dir: 'asc', group: 'priority' } });
  assert.deepEqual(start, { today: { sort: 'name', dir: 'asc', group: 'default' } });
});

test('withOptions: de standaard verdwijnt uit het object; de richting hoort bij een sortering', () => {
  const a = withOptions({}, 'today', { sort: 'date', dir: 'desc' });
  assert.deepEqual(a.today, { sort: 'date', dir: 'desc', group: 'default' });
  assert.deepEqual(withOptions(a, 'today', { sort: 'manual' }), {}, 'terug naar eigen volgorde: de richting telt niet meer mee');
  assert.deepEqual(withOptions(null, 'today', { sort: 'manual' }), {});
});

test('withOptions: de uitkomst voldoet altijd aan de controle', () => {
  let o = null;
  for (const change of [{ sort: 'assignee' }, { dir: 'desc' }, { group: 'deadline' }, { sort: 'manual' }, { group: 'default' }]) {
    o = withOptions(o, 'project:p1', change);
    assert.equal(viewOptionsCheck(o), null);
  }
  assert.deepEqual(o, {});
});

test('withOptions: een vol object krijgt geen nieuwe lijst erbij, een bestaande lijst wel een wijziging', () => {
  const full = {};
  for (let i = 0; i < 500; i++) full[`project:p${i}`] = { sort: 'name', dir: 'asc', group: 'default' };
  assert.equal(Object.keys(withOptions(full, 'project:nieuw', { sort: 'date' })).length, 500);
  assert.equal(withOptions(full, 'project:nieuw', { sort: 'date' })['project:nieuw'], undefined);
  assert.equal(withOptions(full, 'project:p3', { sort: 'date' })['project:p3'].sort, 'date');
});

test('slepen kan alleen bij de eigen volgorde en eigen indeling', () => {
  assert.equal(isDefaultOptions({ sort: 'manual', dir: 'asc', group: 'default' }), true);
  assert.equal(isDefaultOptions({ sort: 'name', dir: 'asc', group: 'default' }), false);
  assert.equal(isDefaultOptions({ sort: 'manual', dir: 'asc', group: 'label' }), false);
});

test('indelingen per soort lijst: een project kent geen "project", Binnenkort geen "datum"', () => {
  assert.equal(groupChoices('project').includes('project'), false);
  assert.equal(groupChoices('project').includes('date'), true);
  assert.equal(groupChoices('upcoming').includes('date'), false);
  assert.equal(groupChoices('upcoming').includes('project'), true);
  assert.equal(groupChoices('today').length, 7);
});
