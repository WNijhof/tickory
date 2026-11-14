// Tests voor de weergavekeuze van een project en de kolommen van het bord.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES } from '../../shared/schema.js';
import { applyCommand, emptyState } from './reducer.js';
import { NO_SECTION, VIEW_STYLES, boardColumns, moveTargets, viewStyleOf } from './projectViews.js';

function sample() {
  const v = emptyState();
  const put = (res, row) => v[res].set(row.id, { is_archived: false, checked: false, labels: [], due: null, parent_id: null, section_id: null, priority: 4, ...row });
  put('projects', { id: 'p-thuis', name: 'Thuis', order_key: 'k' });
  put('projects', { id: 'p-werk', name: 'Werk', order_key: 'm' });
  put('sections', { id: 's-keuken', project_id: 'p-thuis', name: 'Keuken', order_key: 'V' });
  put('sections', { id: 's-bad', project_id: 'p-thuis', name: 'Badkamer', order_key: 'k' });
  put('sections', { id: 's-oud', project_id: 'p-thuis', name: 'Oude sectie', order_key: 'z', is_archived: true });
  put('sections', { id: 's-werk', project_id: 'p-werk', name: 'Planning', order_key: 'V' });
  put('tasks', { id: 't-melk', project_id: 'p-thuis', content: 'Melk halen', order_key: 'b' });
  put('tasks', { id: 't-brood', project_id: 'p-thuis', content: 'Brood halen', order_key: 'a' });
  put('tasks', { id: 't-tegel', project_id: 'p-thuis', section_id: 's-bad', content: 'Tegels vervangen', order_key: 'a' });
  put('tasks', { id: 't-sub', project_id: 'p-thuis', section_id: 's-bad', parent_id: 't-tegel', content: 'Voegen kopen', order_key: 'a' });
  put('tasks', { id: 't-klaar', project_id: 'p-thuis', section_id: 's-keuken', content: 'Afwas', order_key: 'a', checked: true });
  put('tasks', { id: 't-oud', project_id: 'p-thuis', section_id: 's-oud', content: 'In oude sectie', order_key: 'a' });
  put('tasks', { id: 't-werk', project_id: 'p-werk', section_id: 's-werk', content: 'Vergadering', order_key: 'a' });
  return v;
}

test('weergave van een project: lijst, bord of kalender; al het andere is een lijst', () => {
  assert.deepEqual(VIEW_STYLES, ['list', 'board', 'calendar']);
  assert.equal(viewStyleOf({ view_style: 'board' }), 'board');
  assert.equal(viewStyleOf({ view_style: 'calendar' }), 'calendar');
  assert.equal(viewStyleOf({ view_style: 'list' }), 'list');
  assert.equal(viewStyleOf({}), 'list', 'een project van vóór deze versie, of uit de demo');
  assert.equal(viewStyleOf({ view_style: 'gantt' }), 'list', 'een onbekende waarde (van een nieuwere versie)');
  assert.equal(viewStyleOf(null), 'list');
  assert.equal(viewStyleOf({ view_style: null }), 'list');
});

test('de keuze wordt in het project bewaard via project_update; een onbekende waarde toont de lijst', () => {
  const column = ENTITIES.project.cols.find((c) => c.name === 'view_style');
  assert.deepEqual(column.oneOf, VIEW_STYLES, 'het datamodel kent precies deze weergaven');
  const v = sample();
  applyCommand(v, { type: 'project_update', args: { id: 'p-thuis', view_style: 'board' } }, '2026-11-13T10:00:00.000Z');
  assert.equal(viewStyleOf(v.projects.get('p-thuis')), 'board');
  assert.equal(viewStyleOf(v.projects.get('p-werk')), 'list', 'een ander project verandert niet');
  applyCommand(v, { type: 'project_update', args: { id: 'p-thuis', view_style: 'gantt' } }, '2026-11-13T10:01:00.000Z');
  // (de server weigert zo'n waarde met INVALID_ARG; de optimistische kopie hier valideert niet, en de weergave valt dan terug op de lijst)
  assert.equal(viewStyleOf(v.projects.get('p-thuis')), 'list', 'een onbekende waarde toont de lijst');
});

test('bord: eerst "zonder sectie", dan de secties op volgorde; alleen taken van het hoogste niveau; voltooide taken verborgen', () => {
  const b = boardColumns(sample(), 'p-thuis');
  assert.deepEqual(b.columns.map((c) => c.id), [NO_SECTION, 's-keuken', 's-bad'], 'een gearchiveerde sectie is geen kolom');
  assert.equal(b.columns[0].section, null);
  assert.deepEqual(b.columns[0].tasks.map((t) => t.id), ['t-brood', 't-oud', 't-melk'], 'op volgorde van order_key; de taak uit de gearchiveerde sectie staat hier ook');
  assert.deepEqual(b.columns[1].tasks.map((t) => t.id), [], 'de voltooide taak is niet te zien');
  assert.deepEqual(b.columns[2].tasks.map((t) => t.id), ['t-tegel'], 'de subtaak is geen eigen kaart');
  assert.equal(b.completedCount, 1);
  assert.equal(b.project.id, 'p-thuis');
});

test('bord: met voltooide taken erbij, en een taak in een gearchiveerde of onbekende sectie valt in "zonder sectie"', () => {
  const b = boardColumns(sample(), 'p-thuis', { showCompleted: true });
  assert.deepEqual(b.columns[1].tasks.map((t) => t.id), ['t-klaar']);
  assert.ok(b.columns[0].tasks.some((t) => t.id === 't-oud'), 'de taak uit de gearchiveerde sectie gaat niet verloren');
});

test('bord: een project dat niet bestaat, en kolommen van een ander project komen er niet in', () => {
  const v = sample();
  assert.equal(boardColumns(v, 'p-weg'), null);
  assert.deepEqual(boardColumns(v, 'p-werk').columns.map((c) => c.id), [NO_SECTION, 's-werk']);
  assert.deepEqual(boardColumns(v, 'p-werk').columns[1].tasks.map((t) => t.id), ['t-werk']);
});

test('verplaatsen: alle kolommen van het project, met de plek waar de kaart nu staat', () => {
  const v = sample();
  assert.deepEqual(moveTargets(v, v.tasks.get('t-tegel')), [
    { id: NO_SECTION, sectionId: null, name: null, current: false },
    { id: 's-keuken', sectionId: 's-keuken', name: 'Keuken', current: false },
    { id: 's-bad', sectionId: 's-bad', name: 'Badkamer', current: true },
  ]);
  assert.equal(moveTargets(v, v.tasks.get('t-melk')).find((x) => x.current).id, NO_SECTION);
  assert.equal(moveTargets(v, v.tasks.get('t-oud')).find((x) => x.current).id, NO_SECTION, 'een gearchiveerde sectie telt als "zonder sectie"');
  assert.deepEqual(moveTargets(v, { id: 'x', project_id: 'p-weg', section_id: null }), []);
});

test('de kaart verplaatsen gaat met task_move; de subtaak gaat mee en de volgorde blijft kloppen', () => {
  const v = sample();
  applyCommand(v, { type: 'task_move', args: { id: 't-tegel', project_id: 'p-thuis', section_id: 's-keuken', parent_id: null, order_key: 'zz' } }, '2026-11-13T10:00:00.000Z');
  const b = boardColumns(v, 'p-thuis');
  assert.deepEqual(b.columns.find((c) => c.id === 's-keuken').tasks.map((t) => t.id), ['t-tegel']);
  assert.deepEqual(b.columns.find((c) => c.id === 's-bad').tasks.map((t) => t.id), []);
  assert.equal(v.tasks.get('t-sub').section_id, 's-keuken', 'de subtaak volgt haar ouder');
});
