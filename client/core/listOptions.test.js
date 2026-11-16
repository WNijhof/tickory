// Tests voor sorteren en groeperen van lijsten (core/listOptions.js), met Nederlandse namen en lege waarden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INBOX_ID } from '../../shared/schema.js';
import { emptyState } from './reducer.js';
import { comparator, groupRows, sortTasks } from './listOptions.js';
import { projectView, todayView } from './selectors.js';

const TODAY = '2026-11-11';

function sample() {
  const v = emptyState();
  const put = (res, row) => {
    const full = { is_archived: false, checked: false, labels: [], due: null, deadline: null, parent_id: null, section_id: null, priority: 4, created_at: '2026-11-01T10:00:00Z', ...row };
    v[res].set(full.id, full);
    return full;
  };
  put('projects', { id: INBOX_ID, name: 'Inbox', order_key: 'V' });
  put('projects', { id: 'p1', name: 'Thuis', order_key: 'k' });
  put('projects', { id: 'p2', name: 'Werk', order_key: 'm' });
  put('sections', { id: 's1', project_id: 'p1', name: 'Keuken', order_key: 'V' });
  put('labels', { id: 'l-spoed', name: 'spoed', order_key: 'V' });
  put('labels', { id: 'l-bellen', name: 'bellen', order_key: 'k' });
  return { v, put };
}
const names = (tasks) => tasks.map((x) => x.content ?? x.task?.content);
const ctx = (v, extra = {}) => ({
  view: v, today: TODAY, me: { id: 'u-ik', name: 'Ik' },
  userName: (id) => ({ 'u-eva': 'Éva', 'u-bas': 'bas', 'u-ik': 'Ik' })[id] ?? null, ...extra,
});

test('sorteren op naam: hoofdletters en accenten tellen niet mee, getallen gaan op waarde', () => {
  const { v, put } = sample();
  const list = ['taak 10', 'Taak 2', 'éclair kopen', 'Ezel', 'appel', 'Zebra'].map((c, i) => put('tasks', { id: `t${i}`, project_id: 'p1', content: c, order_key: String(i) }));
  assert.deepEqual(names(sortTasks(list, { sort: 'name', dir: 'asc' }, ctx(v))), ['appel', 'éclair kopen', 'Ezel', 'Taak 2', 'taak 10', 'Zebra']);
  assert.deepEqual(names(sortTasks(list, { sort: 'name', dir: 'desc' }, ctx(v))), ['Zebra', 'taak 10', 'Taak 2', 'Ezel', 'éclair kopen', 'appel']);
});

test('sorteren op datum: zonder datum altijd achteraan, ook bij aflopend; bij gelijke datum telt de eigen volgorde', () => {
  const { v, put } = sample();
  const a = put('tasks', { id: 'a', project_id: 'p1', content: 'a', order_key: 'c', due: { date: '2026-11-14' } });
  const b = put('tasks', { id: 'b', project_id: 'p1', content: 'b', order_key: 'a' });
  const c = put('tasks', { id: 'c', project_id: 'p1', content: 'c', order_key: 'b', due: { date: '2026-11-12T09:00' } });
  const d = put('tasks', { id: 'd', project_id: 'p1', content: 'd', order_key: 'a', due: { date: '2026-11-14' } });
  assert.deepEqual(names(sortTasks([a, b, c, d], { sort: 'date', dir: 'asc' }, ctx(v))), ['c', 'd', 'a', 'b']);
  // aflopend: de latere datum eerst; 14 nov is bij beide gelijk dus d (sleutel "a") voor a (sleutel "c"); zonder datum blijft achteraan
  assert.deepEqual(names(sortTasks([a, b, c, d], { sort: 'date', dir: 'desc' }, ctx(v))), ['d', 'a', 'c', 'b']);
});

test('sorteren op prioriteit: P1 eerst bij oplopend', () => {
  const { v, put } = sample();
  const list = [4, 1, 3, 2].map((p, i) => put('tasks', { id: `t${i}`, project_id: 'p1', content: `p${p}`, priority: p, order_key: String(i) }));
  assert.deepEqual(names(sortTasks(list, { sort: 'priority', dir: 'asc' }, ctx(v))), ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(names(sortTasks(list, { sort: 'priority', dir: 'desc' }, ctx(v))), ['p4', 'p3', 'p2', 'p1']);
});

test('sorteren op deadline en op datum toegevoegd', () => {
  const { v, put } = sample();
  const x = put('tasks', { id: 'x', project_id: 'p1', content: 'x', order_key: 'a', deadline: '2026-12-01', created_at: '2026-11-03T08:00:00Z' });
  const y = put('tasks', { id: 'y', project_id: 'p1', content: 'y', order_key: 'b', deadline: '2026-11-20', created_at: '2026-11-02T08:00:00Z' });
  const z = put('tasks', { id: 'z', project_id: 'p1', content: 'z', order_key: 'c', created_at: '2026-11-04T08:00:00Z' });
  assert.deepEqual(names(sortTasks([x, y, z], { sort: 'deadline', dir: 'asc' }, ctx(v))), ['y', 'x', 'z']);
  assert.deepEqual(names(sortTasks([x, y, z], { sort: 'deadline', dir: 'desc' }, ctx(v))), ['x', 'y', 'z']);
  assert.deepEqual(names(sortTasks([x, y, z], { sort: 'added', dir: 'asc' }, ctx(v))), ['y', 'x', 'z']);
  assert.deepEqual(names(sortTasks([x, y, z], { sort: 'added', dir: 'desc' }, ctx(v))), ['z', 'x', 'y']);
});

test('sorteren op toegewezen: op naam zonder letterhoofdtelling, niet toegewezen achteraan', () => {
  const { v, put } = sample();
  const list = [
    put('tasks', { id: '1', project_id: 'p1', content: 'eva', assignee_id: 'u-eva', order_key: 'a' }),
    put('tasks', { id: '2', project_id: 'p1', content: 'niemand', order_key: 'b' }),
    put('tasks', { id: '3', project_id: 'p1', content: 'bas', assignee_id: 'u-bas', order_key: 'c' }),
    put('tasks', { id: '4', project_id: 'p1', content: 'ik', assignee_id: 'u-ik', order_key: 'd' }),
  ];
  assert.deepEqual(names(sortTasks(list, { sort: 'assignee', dir: 'asc' }, ctx(v))), ['bas', 'eva', 'ik', 'niemand']);
  assert.deepEqual(names(sortTasks(list, { sort: 'assignee', dir: 'desc' }, ctx(v))), ['ik', 'eva', 'bas', 'niemand']);
});

test('de eigen volgorde (manual) laat de lijst ongemoeid', () => {
  const list = [{ id: 'b', order_key: 'b', content: 'b' }, { id: 'a', order_key: 'a', content: 'a' }];
  assert.equal(sortTasks(list, { sort: 'manual', dir: 'desc' }), list);
  assert.deepEqual(names([...list].sort(comparator({ sort: 'manual', dir: 'desc' }))), ['a', 'b']);
});

test('een project sorteert ook de subtaken onder hun ouder en houdt ze erbij', () => {
  const { v, put } = sample();
  put('tasks', { id: 'o1', project_id: 'p1', content: 'Zebra', order_key: 'a' });
  put('tasks', { id: 'o2', project_id: 'p1', content: 'Appel', order_key: 'b' });
  put('tasks', { id: 'k1', project_id: 'p1', content: 'y-sub', order_key: 'a', parent_id: 'o2' });
  put('tasks', { id: 'k2', project_id: 'p1', content: 'b-sub', order_key: 'b', parent_id: 'o2' });
  const pv = projectView(v, 'p1', { compare: comparator({ sort: 'name', dir: 'asc' }, ctx(v)) });
  assert.deepEqual(pv.groups[0].tasks.map((r) => [r.task.content, r.depth]), [['Appel', 0], ['b-sub', 1], ['y-sub', 1], ['Zebra', 0]]);
  const standaard = projectView(v, 'p1');
  assert.deepEqual(standaard.groups[0].tasks.map((r) => r.task.content), ['Zebra', 'Appel', 'y-sub', 'b-sub']);
});

test('groeperen op prioriteit: P1 tot P4, lege groepen bestaan niet', () => {
  const { v, put } = sample();
  const rows = [3, 1, 3, 4].map((p, i) => ({ task: put('tasks', { id: `t${i}`, project_id: 'p1', content: `t${i}`, priority: p, order_key: String(i) }) }));
  const g = groupRows(rows, 'priority', ctx(v));
  assert.deepEqual(g.map((x) => [x.key, x.tasks]), [['p1', 1], ['p3', 2], ['p4', 1]]);
  assert.equal(g[0].title, 'Prioriteit 1');
});

test('groeperen op datum: te laat, dan de dagen oplopend, dan zonder datum', () => {
  const { v, put } = sample();
  const mk = (id, date) => ({ task: put('tasks', { id, project_id: 'p1', content: id, order_key: id, due: date ? { date } : null }) });
  const g = groupRows([mk('a', '2026-11-13'), mk('b', null), mk('c', '2026-11-09T08:00'), mk('d', '2026-11-11T10:00'), mk('e', '2026-11-13T08:00')], 'date', ctx(v));
  assert.deepEqual(g.map((x) => [x.key, x.tasks]), [['overdue', 1], ['2026-11-11', 1], ['2026-11-13', 2], ['none', 1]]);
  assert.equal(g[0].title, 'Te laat');
  assert.equal(g[1].title, 'Vandaag · wo 11 nov');
  assert.equal(g[3].title, 'Geen datum');
});

test('groeperen op deadline kent geen "te laat"', () => {
  const { v, put } = sample();
  const rows = [{ task: put('tasks', { id: 'a', project_id: 'p1', content: 'a', order_key: 'a', deadline: '2026-11-01' }) }, { task: put('tasks', { id: 'b', project_id: 'p1', content: 'b', order_key: 'b' }) }];
  const g = groupRows(rows, 'deadline', ctx(v));
  assert.deepEqual(g.map((x) => x.key), ['2026-11-01', 'none']);
  assert.equal(g[1].title, 'Geen deadline');
});

test('groeperen op label: het eerste bestaande label bepaalt de groep, de groepen staan op labelnaam', () => {
  const { v, put } = sample();
  const rows = [
    { task: put('tasks', { id: 'a', project_id: 'p1', content: 'a', order_key: 'a', labels: ['l-spoed', 'l-bellen'] }) },
    { task: put('tasks', { id: 'b', project_id: 'p1', content: 'b', order_key: 'b', labels: ['l-bellen'] }) },
    { task: put('tasks', { id: 'c', project_id: 'p1', content: 'c', order_key: 'c', labels: ['l-weg'] }) }, // een label dat niet (meer) bestaat
    { task: put('tasks', { id: 'd', project_id: 'p1', content: 'd', order_key: 'd' }) },
  ];
  const g = groupRows(rows, 'label', ctx(v));
  assert.deepEqual(g.map((x) => [x.title, x.tasks]), [['bellen', 1], ['spoed', 1], ['Zonder label', 2]]);
});

test('groeperen op toegewezen en op project', () => {
  const { v, put } = sample();
  const rows = [
    { task: put('tasks', { id: 'a', project_id: 'p2', content: 'a', order_key: 'a', assignee_id: 'u-ik' }) },
    { task: put('tasks', { id: 'b', project_id: 'p1', content: 'b', order_key: 'b', assignee_id: 'u-eva' }) },
    { task: put('tasks', { id: 'c', project_id: 'p1', content: 'c', order_key: 'c' }) },
  ];
  // gesorteerd op naam (Éva voor Ik), de eigen groep heet "Aan mij toegewezen", niet toegewezen staat achteraan
  assert.deepEqual(groupRows(rows, 'assignee', ctx(v)).map((x) => x.title), ['Éva', 'Aan mij toegewezen', 'Niet toegewezen']);
  assert.deepEqual(groupRows(rows, 'project', ctx(v)).map((x) => [x.title, x.tasks]), [['Thuis', 2], ['Werk', 1]]);
});

test('groeperen houdt een taak bij haar subtaken: de groep volgt de taak van het hoogste niveau', () => {
  const { v, put } = sample();
  const rows = [
    { task: put('tasks', { id: 'o', project_id: 'p1', content: 'ouder', order_key: 'a', priority: 1 }), depth: 0 },
    { task: put('tasks', { id: 'k', project_id: 'p1', content: 'kind', order_key: 'a', priority: 4, parent_id: 'o' }), depth: 1 },
    { task: put('tasks', { id: 'x', project_id: 'p1', content: 'los', order_key: 'b', priority: 4 }), depth: 0 },
  ];
  const g = groupRows(rows, 'priority', ctx(v));
  assert.deepEqual(g.map((x) => [x.key, x.rows.map((r) => r.task.content)]), [['p1', ['ouder', 'kind']], ['p4', ['los']]]);
});

test('de standaardindeling geeft null: de lijst houdt zijn eigen groepen', () => {
  assert.equal(groupRows([], 'default', {}), null);
  assert.equal(groupRows([], undefined, {}), null);
});

test('Vandaag: sorteren binnen de dag', () => {
  const { v, put } = sample();
  put('tasks', { id: 'a', project_id: 'p1', content: 'Boodschappen', order_key: 'a', due: { date: '2026-11-11' }, priority: 4 });
  put('tasks', { id: 'b', project_id: 'p1', content: 'Auto wassen', order_key: 'b', due: { date: '2026-11-11' }, priority: 2 });
  const list = todayView(v, TODAY);
  assert.deepEqual(names(list.today), ['Auto wassen', 'Boodschappen']); // de standaard: prioriteit
  assert.deepEqual(names(sortTasks(list.today, { sort: 'name', dir: 'desc' }, ctx(v))), ['Boodschappen', 'Auto wassen']);
});

test('sorteren op naam: een accent maakt geen verschil, dan beslist de eigen volgorde', () => {
  const { v, put } = sample();
  const a = put('tasks', { id: 'a', project_id: 'p1', content: 'Éva bellen', order_key: 'a' });
  const b = put('tasks', { id: 'b', project_id: 'p1', content: 'Eva bellen', order_key: 'b' });
  const c = put('tasks', { id: 'c', project_id: 'p1', content: 'eva bellen', order_key: '0' });
  assert.deepEqual(names(sortTasks([a, b, c], { sort: 'name', dir: 'asc' }, ctx(v))), ['eva bellen', 'Éva bellen', 'Eva bellen']);
});

test('groeperen op prioriteit: een onbekende waarde valt in de dichtstbijzijnde groep', () => {
  const { v, put } = sample();
  const rows = [9, 0].map((p, i) => ({ task: put('tasks', { id: `t${i}`, project_id: 'p1', content: `t${i}`, priority: p, order_key: String(i) }) }));
  assert.deepEqual(groupRows(rows, 'priority', ctx(v)).map((x) => x.key), ['p1', 'p4']);
});
