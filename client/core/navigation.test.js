// De zijbalk en de takenlijst: projectenboom met in- en uitklappen, favorieten, archief, subtaken en de snelle datums.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { INBOX_ID } from '../../shared/schema.js';
import { emptyState } from './reducer.js';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { archivedList, favoriteProjects, foldRows, isArchivedProject, navProjects, projectDescendantIds, projectList, subtaskCounts, subtasksOf } from './selectors.js';
import { quickDates, reschedule } from './quickDates.js';

function sample() {
  const v = emptyState();
  const put = (res, row) => v[res].set(row.id, { is_archived: false, is_favorite: false, is_collapsed: false, checked: false, parent_id: null, ...row });
  put('projects', { id: INBOX_ID, name: 'Inbox', order_key: 'V' });
  put('projects', { id: 'p-a', name: 'A', order_key: 'a' });
  put('projects', { id: 'p-a1', name: 'A1', order_key: 'a', parent_id: 'p-a' });
  put('projects', { id: 'p-a1x', name: 'A1x', order_key: 'a', parent_id: 'p-a1' });
  put('projects', { id: 'p-a2', name: 'A2', order_key: 'b', parent_id: 'p-a' });
  put('projects', { id: 'p-b', name: 'B', order_key: 'b', is_favorite: true });
  put('projects', { id: 'p-c', name: 'C', order_key: 'c' });
  return { v, put };
}
const names = (rows) => rows.map((r) => `${' '.repeat(r.depth ?? 0)}${(r.project ?? r).name}`);

test('navProjects: de Inbox staat er niet in (die staat bovenaan), de rest als boom met inspringing', () => {
  const { v } = sample();
  assert.deepEqual(names(navProjects(v)), ['A', ' A1', '  A1x', ' A2', 'B', 'C']);
  assert.deepEqual(navProjects(v).map((r) => [r.project.id, r.hasChildren, r.collapsed]), [
    ['p-a', true, false], ['p-a1', true, false], ['p-a1x', false, false], ['p-a2', false, false], ['p-b', false, false], ['p-c', false, false],
  ]);
});

test('navProjects: ingeklapt (is_collapsed) verbergt alle niveaus eronder, en alleen als er iets is om te verbergen', () => {
  const { v, put } = sample();
  put('projects', { id: 'p-a', name: 'A', order_key: 'a', is_collapsed: true });
  assert.deepEqual(names(navProjects(v)), ['A', 'B', 'C']);
  assert.equal(navProjects(v)[0].collapsed, true);
  put('projects', { id: 'p-a', name: 'A', order_key: 'a', is_collapsed: false });
  put('projects', { id: 'p-a1', name: 'A1', order_key: 'a', parent_id: 'p-a', is_collapsed: true });
  assert.deepEqual(names(navProjects(v)), ['A', ' A1', ' A2', 'B', 'C'], 'alleen A1x is verborgen');
  put('projects', { id: 'p-c', name: 'C', order_key: 'c', is_collapsed: true });
  assert.equal(navProjects(v).find((r) => r.project.id === 'p-c').collapsed, false, 'zonder subprojecten valt er niets in te klappen');
});

test('favorieten: de favoriete projecten in de volgorde van de boom, zonder gearchiveerde', () => {
  const { v, put } = sample();
  assert.deepEqual(favoriteProjects(v).map((p) => p.name), ['B']);
  put('projects', { id: 'p-a2', name: 'A2', order_key: 'b', parent_id: 'p-a', is_favorite: true });
  assert.deepEqual(favoriteProjects(v).map((p) => p.name), ['A2', 'B'], 'een favoriet subproject staat in de volgorde van de boom');
  put('projects', { id: 'p-b', name: 'B', order_key: 'b', is_favorite: true, is_archived: true });
  assert.deepEqual(favoriteProjects(v).map((p) => p.name), ['A2']);
  put('projects', { id: INBOX_ID, name: 'Inbox', order_key: 'V', is_favorite: true });
  assert.deepEqual(favoriteProjects(v).map((p) => p.name), ['A2'], 'de Inbox staat al bovenaan');
});

test('archief: een gearchiveerd project verdwijnt met zijn subprojecten uit de lijst en staat in het archief', () => {
  const { v, put } = sample();
  put('projects', { id: 'p-a', name: 'A', order_key: 'a', is_archived: true });
  assert.equal(isArchivedProject(v, 'p-a'), true);
  assert.equal(isArchivedProject(v, 'p-a1x'), true, 'onder een gearchiveerd project');
  assert.equal(isArchivedProject(v, 'p-b'), false);
  assert.equal(isArchivedProject(v, 'bestaat-niet'), false);
  assert.deepEqual(names(projectList(v)), ['Inbox', 'B', 'C']);
  assert.deepEqual(names(navProjects(v)), ['B', 'C']);
  assert.deepEqual(names(archivedList(v)), ['A', ' A1', '  A1x', ' A2']);
  put('projects', { id: 'p-b', name: 'B', order_key: 'b', is_archived: true });
  assert.deepEqual(names(archivedList(v)), ['A', ' A1', '  A1x', ' A2', 'B']);
  put('projects', { id: INBOX_ID, name: 'Inbox', order_key: 'V', is_archived: true });
  assert.deepEqual(names(archivedList(v)), ['A', ' A1', '  A1x', ' A2', 'B'], 'de Inbox staat nooit in het archief');
  assert.deepEqual(archivedList(emptyState()), []);
});

test('projectDescendantIds: alle niveaus, zonder het project zelf', () => {
  const { v } = sample();
  assert.deepEqual(projectDescendantIds(v, 'p-a').sort(), ['p-a1', 'p-a1x', 'p-a2']);
  assert.deepEqual(projectDescendantIds(v, 'p-a1x'), []);
  assert.deepEqual(projectDescendantIds(v, 'bestaat-niet'), []);
});

test('subtaken: tellers per taak (afgerond / totaal) en de lijst van subtaken', () => {
  const v = emptyState();
  const put = (id, parent_id, checked = false, order_key = id) => v.tasks.set(id, { id, parent_id, checked, order_key, project_id: 'p' });
  put('t1', null);
  put('t1a', 't1', true);
  put('t1b', 't1');
  put('t1c', 't1');
  put('t1c1', 't1c', true);
  put('t2', null);
  const counts = subtaskCounts(v);
  assert.deepEqual(counts.get('t1'), { done: 1, total: 3 }, 'alleen de directe subtaken');
  assert.deepEqual(counts.get('t1c'), { done: 1, total: 1 });
  assert.equal(counts.get('t2'), undefined);
  assert.deepEqual(subtasksOf(v, 't1').map((t) => t.id), ['t1a', 't1b', 't1c']);
  assert.deepEqual(subtasksOf(v, 't2'), []);
  put('t3', null);
  put('t3b', 't3', false, 'b');
  put('t3a', 't3', false, 'a');
  assert.deepEqual(subtasksOf(v, 't3').map((t) => t.id), ['t3a', 't3b'], 'op volgorde, niet op de volgorde van binnenkomst');
});

test('foldRows: de subtaken van een ingeklapte taak verdwijnen, de rest blijft', () => {
  const row = (id, depth, collapsed = false) => ({ task: { id, is_collapsed: collapsed }, depth });
  const rows = [row('a', 0, true), row('a1', 1), row('a1x', 2), row('b', 0), row('b1', 1, true), row('b1x', 2), row('c', 0, true)];
  const out = foldRows(rows);
  assert.deepEqual(out.map((r) => r.task.id), ['a', 'b', 'b1', 'c']);
  assert.deepEqual(out.map((r) => [r.hasChildren, r.collapsed]), [[true, true], [true, false], [true, true], [false, false]]);
  assert.deepEqual(foldRows([]), []);
  assert.deepEqual(foldRows([row('x', 0)]).map((r) => r.task.id), ['x']);
});

// ---------- archiveren tegen de echte server ----------

test('archiveren en terugzetten: de hele tak, en de server is het ermee eens', async () => {
  const db = freshDb();
  const user = addUser(db, 'alice', 'Alice');
  const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
  const errors = [];
  const sync = new SyncClient({ store, transport: async (b) => JSON.parse(JSON.stringify(handleSync(db, JSON.parse(JSON.stringify(b)), user.id))), onCommandErrors: (e) => errors.push(...e) });
  let n = 0;
  const actions = createActions(store, { makeId: () => `id${String(++n).padStart(10, '0')}`, makeUuid: () => `uuid-${String(++n).padStart(10, '0')}` });
  await store.init();
  await sync.syncNow();
  const parent = await actions.addProject({ name: 'Ouder', color: 'blue', is_favorite: true });
  const kid = await actions.addProject({ name: 'Kind', parent_id: parent, color: 'rose' });
  const grandKid = await actions.addProject({ name: 'Kleinkind', parent_id: kid });
  const other = await actions.addProject({ name: 'Los' });
  assert.equal(await sync.syncNow(), true);
  assert.deepEqual(errors, []);
  assert.equal(store.view.projects.get(parent).color, 'blue');
  assert.equal(store.view.projects.get(parent).is_favorite, true);
  assert.equal(store.view.projects.get(kid).color, 'rose');
  assert.equal(store.view.projects.get(grandKid).color, 'charcoal', 'standaardkleur van de server');

  await actions.archiveProject(parent);
  for (const id of [parent, kid, grandKid]) assert.equal(store.view.projects.get(id).is_archived, true, id);
  assert.equal(store.view.projects.get(other).is_archived, false);
  assert.deepEqual(projectList(store.view).map((r) => r.project.name), ['Inbox', 'Los']);
  assert.equal(await sync.syncNow(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(archivedList(store.view).map((r) => r.project.name), ['Ouder', 'Kind', 'Kleinkind']);

  await actions.unarchiveProject(grandKid); // alleen dit ene project; het blijft verborgen zolang de ouder gearchiveerd is
  assert.equal(store.queueLength, 1);
  assert.equal(isArchivedProject(store.view, grandKid), true);
  await actions.unarchiveProject(parent);
  assert.equal(store.queueLength, 3, 'het al teruggezette kleinkind krijgt geen overbodig commando mee');
  assert.deepEqual(projectList(store.view).map((r) => r.project.name), ['Inbox', 'Ouder', 'Kind', 'Kleinkind', 'Los']);
  assert.equal(await sync.syncNow(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(archivedList(store.view), []);

  // de Inbox archiveren weigert de server (de zijbalk biedt het niet aan)
  await actions.archiveProject(store.me.inbox_project_id);
  assert.equal(await sync.syncNow(), true);
  assert.deepEqual(errors.map((e) => e.error_code), ['CONFLICT']);
  assert.equal(store.view.projects.get(store.me.inbox_project_id).is_archived, false);
});

// ---------- snelle datums ----------

test('quickDates: vandaag, morgen, dit weekend en volgende week, voor elke dag van de week', () => {
  // 2026-11-09 is een maandag
  const expected = {
    '2026-11-09': { weekend: '2026-11-14', nextWeek: '2026-11-16' }, // ma
    '2026-11-10': { weekend: '2026-11-14', nextWeek: '2026-11-16' },
    '2026-11-11': { weekend: '2026-11-14', nextWeek: '2026-11-16' },
    '2026-11-12': { weekend: '2026-11-14', nextWeek: '2026-11-16' },
    '2026-11-13': { weekend: '2026-11-14', nextWeek: '2026-11-16' }, // vr
    '2026-11-14': { weekend: '2026-11-14', nextWeek: '2026-11-16' }, // za: dit weekend is nu
    '2026-11-15': { weekend: '2026-11-21', nextWeek: '2026-11-16' }, // zo: het volgende weekend
  };
  for (const [today, want] of Object.entries(expected)) {
    const q = quickDates(today);
    assert.equal(q.today, today);
    assert.equal(q.weekend, want.weekend, `weekend vanaf ${today}`);
    assert.equal(q.nextWeek, want.nextWeek, `volgende week vanaf ${today}`);
  }
  assert.equal(quickDates('2026-11-09').tomorrow, '2026-11-10');
  assert.equal(quickDates('2026-12-31').tomorrow, '2027-01-01', 'over de jaargrens');
  assert.equal(quickDates('2026-03-28').nextWeek, '2026-03-30', 'over de zomertijd heen');
  assert.equal(quickDates('2026-10-25').tomorrow, '2026-10-26', 'over het einde van de zomertijd');
});

test('reschedule: het tijdstip blijft, een herhaling blijft herhalen, de oude tekst vervalt', () => {
  assert.equal(reschedule({ date: '2026-11-12' }, null), null);
  assert.equal(reschedule(null, null), null);
  assert.deepEqual(reschedule(null, '2026-11-13'), { date: '2026-11-13' });
  assert.deepEqual(reschedule({ date: '2026-11-12', string: 'morgen', lang: 'nl' }, '2026-11-13'), { date: '2026-11-13' });
  assert.deepEqual(reschedule({ date: '2026-11-12T09:30', string: 'morgen om half 10', lang: 'nl' }, '2026-11-14'), { date: '2026-11-14T09:30' });
  const weekly = { date: '2026-11-13', string: 'elke vrijdag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [5] } };
  assert.deepEqual(reschedule(weekly, '2026-11-20'), { date: '2026-11-20', string: 'elke vrijdag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [5] } });
});
