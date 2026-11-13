// Tests voor wat de schermen voor labels en filters tonen (core/filterViews.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from './reducer.js';
import { filterOutcome, labelCounts, labelTasks } from './filterViews.js';
import { filterList, labelList } from './selectors.js';

const ME = 'u-anna';
const NOW = new Date(2026, 10, 11, 9, 30);

function world() {
  const v = emptyState();
  const put = (res, row) => v[res].set(row.id, { order_key: row.id, ...row });
  put('projects', { id: 'p-a', name: 'Alfa' });
  put('projects', { id: 'p-b', name: 'Beta' });
  put('projects', { id: 'p-oud', name: 'Oud', is_archived: true });
  put('labels', { id: 'l-1', name: 'bellen', owner_id: ME });
  put('labels', { id: 'l-2', name: 'thuis', owner_id: ME });
  put('labels', { id: 'l-3', name: 'van-bob', owner_id: 'u-bob' });
  put('filters', { id: 'f-1', name: 'Dringend', query: 'p1', owner_id: ME });
  put('filters', { id: 'f-2', name: 'Kapot', query: '#Verdwenen', owner_id: ME });
  put('filters', { id: 'f-3', name: 'Van Bob', query: 'p1', owner_id: 'u-bob' });
  const base = { project_id: 'p-a', section_id: null, parent_id: null, description: '', priority: 4, labels: [], due: null, checked: false };
  const tasks = [
    { id: 't1', content: 'Eerste', labels: ['l-1'], due: { date: '2026-11-13' }, priority: 2 },
    { id: 't2', content: 'Tweede', labels: ['l-1', 'l-2'], due: { date: '2026-11-12' }, priority: 1 },
    { id: 't3', content: 'Derde', labels: ['l-1'], project_id: 'p-b' }, // zonder datum: achteraan
    { id: 't4', content: 'Klaar', labels: ['l-1'], checked: true, due: { date: '2026-11-01' } },
    { id: 't5', content: 'In archief', labels: ['l-1'], project_id: 'p-oud', due: { date: '2026-11-11' } },
    { id: 't6', content: 'Weg', labels: ['l-1'], is_deleted: true, due: { date: '2026-11-10' } },
    { id: 't7', content: 'Prio', priority: 1, project_id: 'p-b' },
    { id: 't8', content: 'Van Bob', labels: ['l-3'] },
  ];
  for (const t of tasks) put('tasks', { ...base, ...t });
  return v;
}

test('labelTasks: open taken met dat label in de volgorde van de overzichten; archief, verwijderd en afgevinkt niet', () => {
  const v = world();
  const { tasks, completedCount } = labelTasks(v, 'l-1');
  assert.deepEqual(tasks.map((t) => t.id), ['t2', 't1', 't3'], 'eerst op datum, zonder datum achteraan');
  assert.equal(completedCount, 1);
  assert.deepEqual(labelTasks(v, 'l-2').tasks.map((t) => t.id), ['t2']);
  assert.deepEqual(labelTasks(v, 'l-bestaat-niet').tasks, []);
});

test('labelTasks: met "afgevinkt tonen" komen de afgevinkte taken erbij, het archief nog steeds niet', () => {
  const v = world();
  const { tasks } = labelTasks(v, 'l-1', { showCompleted: true });
  assert.deepEqual(tasks.map((t) => t.id).sort(), ['t1', 't2', 't3', 't4']);
  assert.ok(!tasks.some((t) => t.id === 't5' || t.id === 't6'));
});

test('labelTasks: een label van iemand anders toont de taken waar het op staat', () => {
  assert.deepEqual(labelTasks(world(), 'l-3').tasks.map((t) => t.id), ['t8']);
});

test('filterOutcome: de taken en het aantal, of de fout met zijn plek', () => {
  const v = world();
  const ctx = { view: v, now: NOW, userId: ME, users: [] };
  const ok = filterOutcome(v.filters.get('f-1'), ctx);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.tasks.map((t) => t.id), ['t2', 't7']);
  assert.equal(ok.count, 2);
  const broken = filterOutcome(v.filters.get('f-2'), ctx);
  assert.equal(broken.ok, false);
  assert.equal(broken.error.code, 'unknown_project');
  assert.deepEqual([broken.error.position, broken.error.length], [0, '#Verdwenen'.length]);
  assert.equal(filterOutcome({ query: '' }, ctx).error.code, 'empty_query');
});

test('de lijsten voor de zijbalk: eigen filters en labels, met het aantal open taken; labels van anderen apart', () => {
  const v = world();
  assert.deepEqual(filterList(v, ME).map((f) => f.id), ['f-1', 'f-2'], 'een filter van een ander zie je niet');
  const { own, others } = labelList(v, ME);
  assert.deepEqual(own.map((x) => x.label.id), ['l-1', 'l-2']);
  assert.deepEqual(others.map((x) => x.label.id), ['l-3'], 'een label van iemand anders staat apart');
  // het aantal is dat van het scherm van het label: open taken, zonder het archief en zonder verwijderde taken
  const counts = labelCounts(v);
  assert.deepEqual([...counts.entries()].sort(), [['l-1', 3], ['l-2', 1], ['l-3', 1]]);
  for (const id of ['l-1', 'l-2', 'l-3']) assert.equal(counts.get(id), labelTasks(v, id).tasks.length, `het aantal bij ${id} is gelijk aan wat het label toont`);
  assert.equal(counts.get('l-bestaat-niet'), undefined);
});
