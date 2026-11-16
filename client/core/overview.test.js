// Subtaken uitklappen in een overzicht (ui/render.js, withSubtasks) en de kleur van een taak in de kalender (ui/calendar.js,
// calendarColorOf). Zonder browser: beide rekenen alleen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSubtasks } from '../ui/render.js';
import { CALENDAR_COLORS, calendarColorOf } from '../ui/calendar.js';
import { emptyState } from './reducer.js';

function world() {
  const view = emptyState();
  const task = (id, extra = {}) => view.tasks.set(id, { id, content: id, project_id: 'proj-0001', parent_id: null, checked: false, order_key: id, labels: [], ...extra });
  task('ouder-00001');
  task('kind-000001', { parent_id: 'ouder-00001', order_key: 'b' });
  task('kind-000002', { parent_id: 'ouder-00001', order_key: 'a' });
  task('kind-000003', { parent_id: 'ouder-00001', checked: true });
  task('kleinkind01', { parent_id: 'kind-000002' });
  task('los-0000001');
  return view;
}
const shape = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.task.id}${r.peek ? (r.collapsed ? ' ▸' : ' ▾') : ''}`);

test('ingeklapt: een taak met open subtaken krijgt een pijltje; zonder subtaken niets', () => {
  const view = world();
  const rows = withSubtasks([{ task: view.tasks.get('ouder-00001') }, { task: view.tasks.get('los-0000001') }], view, new Set());
  assert.deepEqual(shape(rows), ['ouder-00001 ▸', 'los-0000001']);
});

test('uitgeklapt: de open subtaken eronder in hun volgorde, een niveau dieper; afgevinkte niet; dieper ook uit te klappen', () => {
  const view = world();
  const open = new Set(['ouder-00001']);
  assert.deepEqual(shape(withSubtasks([{ task: view.tasks.get('ouder-00001') }], view, open)), ['ouder-00001 ▾', '  kind-000002 ▸', '  kind-000001']);
  open.add('kind-000002');
  assert.deepEqual(shape(withSubtasks([{ task: view.tasks.get('ouder-00001') }], view, open)), ['ouder-00001 ▾', '  kind-000002 ▾', '    kleinkind01', '  kind-000001']);
});

test('een subtaak die zelf al in het overzicht staat, komt er niet nog eens bij', () => {
  const view = world();
  const rows = withSubtasks([{ task: view.tasks.get('ouder-00001') }, { task: view.tasks.get('kind-000001') }], view, new Set(['ouder-00001']));
  assert.deepEqual(shape(rows), ['ouder-00001 ▾', '  kind-000002 ▸', 'kind-000001']);
});

test('kalenderkleur: project, het eerste label met een kleur, of geen (dan de prioriteit)', () => {
  const view = world();
  view.projects.set('proj-0001', { id: 'proj-0001', name: 'Thuis', color: 'teal' });
  view.labels.set('label-0001', { id: 'label-0001', name: 'zonder', color: null });
  view.labels.set('label-0002', { id: 'label-0002', name: 'rood', color: 'red' });
  const task = { ...view.tasks.get('los-0000001'), labels: ['label-0001', 'label-0002'] };
  assert.deepEqual(CALENDAR_COLORS, ['priority', 'project', 'label']);
  assert.equal(calendarColorOf(task, view, 'priority'), null);
  assert.equal(calendarColorOf(task, view, 'project'), 'teal');
  assert.equal(calendarColorOf(task, view, 'label'), 'red');
  assert.equal(calendarColorOf({ ...task, labels: [] }, view, 'label'), null);
});
