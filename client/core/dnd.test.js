// Tests voor de logica van slepen en verplaatsen (core/dnd.js): waar een taak of project terechtkomt en welke sleutel het krijgt.
// De plannen worden ook echt uitgevoerd op de optimistische toestand (reducer), zodat te zien is dat de lijst er daarna goed uitziet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyBetween } from '../../shared/orderKey.js';
import { applyCommand, emptyState } from './reducer.js';
import {
  canReorderProject, currentProjectPlan, currentTaskPlan, placeKey, planProjectDrop, planProjectDropToTop, planProjectKey, planTaskDrop,
  planTaskDropOnGroup, planTaskDropOnProject, planTaskKey, projectMoveCommands, taskMoveCommands, zoneAt,
} from './dnd.js';
import { byOrder } from './selectors.js';

const NOW = '2026-11-13T10:00:00.000Z';

/** Een kleine toestand: Inbox, project P met secties S1 en S2 en een paar taken, plus een tweede project Q. */
function world() {
  const state = emptyState();
  const run = (type, args, userId = null) => applyCommand(state, { type, args }, NOW, userId);
  const project = (id, order_key, extra = {}) => run('project_add', { id, name: id, order_key, ...extra });
  const section = (id, project_id, order_key) => run('section_add', { id, name: id, project_id, order_key });
  const task = (id, order_key, extra = {}) => run('task_add', { id, content: id, project_id: 'P', order_key, ...extra });
  project('inbox-me', 'a');
  project('P', 'b');
  project('Q', 'c');
  section('S1', 'P', 'a');
  section('S2', 'P', 'b');
  task('t1', 'a');
  task('t2', 'b');
  task('t3', 'c');
  task('t2a', 'a', { parent_id: 't2' });
  task('t2b', 'b', { parent_id: 't2' });
  task('s1a', 'a', { section_id: 'S1' });
  task('s1b', 'b', { section_id: 'S1' });
  task('s2a', 'a', { section_id: 'S2' });
  task('q1', 'a', { project_id: 'Q' });
  return { state, run };
}

/** De ids van de taken in één lijst, op volgorde. */
const list = (state, project_id, section_id = null, parent_id = null) =>
  [...state.tasks.values()].filter((t) => t.project_id === project_id && (t.section_id ?? null) === section_id && (t.parent_id ?? null) === parent_id).sort(byOrder).map((t) => t.id);

/** Voert een plan uit zoals actions.moveTask dat doet (dezelfde commando's, op de optimistische toestand). */
function perform(w, id, plan) {
  for (const cmd of taskMoveCommands(w.state, id, plan)) applyCommand(w.state, cmd, NOW, null);
}

test('zoneAt: boven, op en onder de regel; zonder nesten alleen boven of onder', () => {
  assert.equal(zoneAt(0), 'before');
  assert.equal(zoneAt(0.29), 'before');
  assert.equal(zoneAt(0.3), 'child');
  assert.equal(zoneAt(0.5), 'child');
  assert.equal(zoneAt(0.7), 'child');
  assert.equal(zoneAt(0.71), 'after');
  assert.equal(zoneAt(1), 'after');
  assert.equal(zoneAt(0.49, false), 'before');
  assert.equal(zoneAt(0.5, false), 'after');
});

// ---------- sleutels ----------

test('placeKey: begin, midden, einde en een onbekende plek (dan achteraan)', () => {
  const sibs = [{ id: 'a', order_key: 'a' }, { id: 'b', order_key: 'k' }, { id: 'c', order_key: 'z' }];
  const at = (beforeId) => placeKey(sibs, beforeId);
  assert.ok(at('a').order_key < 'a' && at('a').rekeys.length === 0);
  assert.ok(at('b').order_key > 'a' && at('b').order_key < 'k');
  assert.ok(at('c').order_key > 'k' && at('c').order_key < 'z');
  assert.ok(at(null).order_key > 'z');
  assert.ok(at('bestaat-niet').order_key > 'z');
  assert.ok(placeKey([], null).order_key.length > 0);
  // de lijst hoeft niet gesorteerd binnen te komen
  assert.ok(placeKey([sibs[2], sibs[0], sibs[1]], 'c').order_key > 'k');
});

test('placeKey: twee buren met dezelfde sleutel (twee apparaten die offline achteraan toevoegden) krijgen verschillende sleutels, in volgorde', () => {
  const sibs = [{ id: 'a', order_key: 'V' }, { id: 'b', order_key: 'V' }, { id: 'c', order_key: 'V' }, { id: 'd', order_key: 'z' }];
  const r = placeKey(sibs, 'b'); // tussen a en b
  assert.deepEqual(r.rekeys.map((x) => x.id), ['b', 'c']);
  const keys = new Map(sibs.map((s) => [s.id, s.order_key]));
  for (const x of r.rekeys) keys.set(x.id, x.order_key);
  keys.set('nieuw', r.order_key);
  const order = [...keys.entries()].sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : x[0] < y[0] ? -1 : 1)).map((x) => x[0]);
  assert.deepEqual(order, ['a', 'nieuw', 'b', 'c', 'd']);
  // achteraan een lijst met allemaal dezelfde sleutel: er past gewoon iets achter
  assert.deepEqual(placeKey([{ id: 'a', order_key: 'V' }, { id: 'b', order_key: 'V' }], null).rekeys, []);
});

test('placeKey (willekeurig): na het toepassen staat het nieuwe item precies waar het hoort, ook met veel gelijke sleutels', () => {
  let seed = 7;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 400; round++) {
    const n = 1 + rnd(7);
    const pool = ['A', 'V', 'V', 'k', 'z', 'zz'];
    const sibs = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, order_key: pool[rnd(pool.length)] }));
    const sorted = [...sibs].sort(byOrder);
    const at = rnd(n + 1);
    const beforeId = at < n ? sorted[at].id : null;
    const r = placeKey(sibs, beforeId);
    const keys = new Map(sibs.map((s) => [s.id, s.order_key]));
    for (const x of r.rekeys) keys.set(x.id, x.order_key);
    keys.set('nieuw', r.order_key);
    const result = [...keys.entries()].map(([id, order_key]) => ({ id, order_key })).sort(byOrder).map((x) => x.id);
    const expected = sorted.map((s) => s.id);
    expected.splice(at, 0, 'nieuw');
    assert.deepEqual(result, expected, `ronde ${round}: ${JSON.stringify(sibs)} vóór ${beforeId}`);
    // wat niet verplaatst hoefde, blijft in dezelfde onderlinge volgorde
    for (const x of r.rekeys) assert.ok(x.order_key > sorted[Math.max(0, at - 1)].order_key || at === 0);
  }
  assert.ok(keyBetween('a', 'b') > 'a');
});

// ---------- taken slepen ----------

test('planTaskDrop: vóór en na een taak in dezelfde lijst', () => {
  const w = world();
  assert.deepEqual(planTaskDrop(w.state, { dragId: 't3', overId: 't1', zone: 'before' }), { project_id: 'P', section_id: null, parent_id: null, beforeId: 't1' });
  assert.deepEqual(planTaskDrop(w.state, { dragId: 't3', overId: 't1', zone: 'after' }), { project_id: 'P', section_id: null, parent_id: null, beforeId: 't2' });
  assert.deepEqual(planTaskDrop(w.state, { dragId: 't1', overId: 't3', zone: 'after' }), { project_id: 'P', section_id: null, parent_id: null, beforeId: null });
  perform(w, 't3', planTaskDrop(w.state, { dragId: 't3', overId: 't1', zone: 'before' }));
  assert.deepEqual(list(w.state, 'P'), ['t3', 't1', 't2']);
  perform(w, 't3', planTaskDrop(w.state, { dragId: 't3', overId: 't2', zone: 'after' }));
  assert.deepEqual(list(w.state, 'P'), ['t1', 't2', 't3']);
});

test('planTaskDrop: loslaten waar de taak al staat verandert niets (null)', () => {
  const w = world();
  assert.equal(planTaskDrop(w.state, { dragId: 't2', overId: 't1', zone: 'after' }), null);
  assert.equal(planTaskDrop(w.state, { dragId: 't2', overId: 't3', zone: 'before' }), null);
  assert.equal(planTaskDrop(w.state, { dragId: 't3', overId: 't2', zone: 'after' }), null);
  assert.equal(planTaskDrop(w.state, { dragId: 't1', overId: 't1', zone: 'child' }), null, 'niet op jezelf');
  assert.equal(planTaskDrop(w.state, { dragId: 'bestaat-niet', overId: 't1', zone: 'before' }), null);
  assert.equal(planTaskDrop(w.state, { dragId: 't1', overId: 'bestaat-niet', zone: 'before' }), null);
});

test('planTaskDrop: op een taak laten vallen maakt een subtaak (achteraan); met sectie van de ouder', () => {
  const w = world();
  assert.deepEqual(planTaskDrop(w.state, { dragId: 't3', overId: 't1', zone: 'child' }), { project_id: 'P', section_id: null, parent_id: 't1', beforeId: null });
  assert.deepEqual(planTaskDrop(w.state, { dragId: 't3', overId: 's1a', zone: 'child' }), { project_id: 'P', section_id: 'S1', parent_id: 's1a', beforeId: null });
  perform(w, 't3', planTaskDrop(w.state, { dragId: 't3', overId: 't2', zone: 'child' }));
  assert.deepEqual(list(w.state, 'P', null, 't2'), ['t2a', 't2b', 't3']);
  assert.deepEqual(list(w.state, 'P'), ['t1', 't2']);
  // naar een taak in een sectie: de taak en haar subtaken volgen die sectie
  perform(w, 't2', planTaskDrop(w.state, { dragId: 't2', overId: 's1b', zone: 'child' }));
  assert.equal(w.state.tasks.get('t2').section_id, 'S1');
  assert.equal(w.state.tasks.get('t3').section_id, 'S1', 'ook de subtaak van een subtaak');
  assert.equal(w.state.tasks.get('t2a').section_id, 'S1');
});

test('planTaskDrop: een taak kan niet onder zichzelf of een eigen subtaak', () => {
  const w = world();
  assert.equal(planTaskDrop(w.state, { dragId: 't2', overId: 't2a', zone: 'child' }), null);
  assert.equal(planTaskDrop(w.state, { dragId: 't2', overId: 't2a', zone: 'before' }), null, 'ook niet ervoor of erna: dat staat ín de taak zelf');
  assert.equal(planTaskDrop(w.state, { dragId: 't2', overId: 't2b', zone: 'after' }), null);
  w.run('task_add', { id: 'diep', content: 'diep', project_id: 'P', parent_id: 't2a', order_key: 'a' });
  assert.equal(planTaskDrop(w.state, { dragId: 't2', overId: 'diep', zone: 'child' }), null, 'ook niet onder een kleinkind');
});

test('planTaskDrop: een subtaak eruit slepen (naast de ouder) en tussen subtaken zetten', () => {
  const w = world();
  assert.deepEqual(planTaskDrop(w.state, { dragId: 't2a', overId: 't2', zone: 'after' }), { project_id: 'P', section_id: null, parent_id: null, beforeId: 't3' });
  perform(w, 't2a', planTaskDrop(w.state, { dragId: 't2a', overId: 't2', zone: 'before' }));
  assert.deepEqual(list(w.state, 'P'), ['t1', 't2a', 't2', 't3']);
  assert.equal(w.state.tasks.get('t2a').parent_id, null);
  perform(w, 't3', planTaskDrop(w.state, { dragId: 't3', overId: 't2b', zone: 'before' }));
  assert.deepEqual(list(w.state, 'P', null, 't2'), ['t3', 't2b']);
});

test('planTaskDrop: "eronder" bij een taak met zichtbare subtaken wordt de eerste subtaak', () => {
  const w = world();
  assert.deepEqual(planTaskDrop(w.state, { dragId: 't3', overId: 't2', zone: 'after', overExpanded: true }), { project_id: 'P', section_id: null, parent_id: 't2', beforeId: 't2a' });
  assert.deepEqual(planTaskDrop(w.state, { dragId: 't1', overId: 't2', zone: 'after', overExpanded: false }), { project_id: 'P', section_id: null, parent_id: null, beforeId: 't3' }, 'ingeklapt: gewoon eronder');
  // zonder subtaken is "uitgeklapt" betekenisloos
  assert.deepEqual(planTaskDrop(w.state, { dragId: 't3', overId: 't1', zone: 'after', overExpanded: true }), { project_id: 'P', section_id: null, parent_id: 't1', beforeId: null });
});

test('planTaskDrop: naar een andere sectie, met de sectie van de buur', () => {
  const w = world();
  const plan = planTaskDrop(w.state, { dragId: 't1', overId: 's1b', zone: 'before' });
  assert.deepEqual(plan, { project_id: 'P', section_id: 'S1', parent_id: null, beforeId: 's1b' });
  perform(w, 't1', plan);
  assert.deepEqual(list(w.state, 'P', 'S1'), ['s1a', 't1', 's1b']);
  assert.deepEqual(list(w.state, 'P'), ['t2', 't3']);
});

test('planTaskDropOnGroup: bovenaan of onderaan een sectie, ook als die leeg is; een sectie van een ander project niet', () => {
  const w = world();
  w.run('section_add', { id: 'S3', name: 'S3', project_id: 'P', order_key: 'c' });
  assert.deepEqual(planTaskDropOnGroup(w.state, { dragId: 't1', projectId: 'P', sectionId: 'S1', edge: 'start' }), { project_id: 'P', section_id: 'S1', parent_id: null, beforeId: 's1a' });
  assert.deepEqual(planTaskDropOnGroup(w.state, { dragId: 't1', projectId: 'P', sectionId: 'S1', edge: 'end' }), { project_id: 'P', section_id: 'S1', parent_id: null, beforeId: null });
  perform(w, 't1', planTaskDropOnGroup(w.state, { dragId: 't1', projectId: 'P', sectionId: 'S3' }));
  assert.deepEqual(list(w.state, 'P', 'S3'), ['t1']);
  assert.equal(planTaskDropOnGroup(w.state, { dragId: 't1', projectId: 'Q', sectionId: 'S1' }), null, 'S1 hoort bij P');
  assert.equal(planTaskDropOnGroup(w.state, { dragId: 't3', projectId: 'P', sectionId: null, edge: 'end' }), null, 'staat al onderaan');
  // een subtaak die op het begin van de lijst valt, wordt gewoon een taak op het hoogste niveau
  perform(w, 't2a', planTaskDropOnGroup(w.state, { dragId: 't2a', projectId: 'P', sectionId: null, edge: 'start' }));
  assert.equal(w.state.tasks.get('t2a').parent_id, null);
  assert.equal(list(w.state, 'P')[0], 't2a');
});

test('planTaskDropOnProject: naar een ander project, achteraan, zonder sectie en ouder; het eigen project telt niet', () => {
  const w = world();
  assert.deepEqual(planTaskDropOnProject(w.state, { dragId: 's1a', projectId: 'Q' }), { project_id: 'Q', section_id: null, parent_id: null, beforeId: null });
  assert.equal(planTaskDropOnProject(w.state, { dragId: 's1a', projectId: 'P' }), null);
  assert.equal(planTaskDropOnProject(w.state, { dragId: 's1a', projectId: 'weg' }), null);
  perform(w, 't2', planTaskDropOnProject(w.state, { dragId: 't2', projectId: 'Q' }));
  assert.deepEqual(list(w.state, 'Q'), ['q1', 't2']);
  assert.equal(w.state.tasks.get('t2a').project_id, 'Q', 'subtaken gaan mee');
  assert.equal(w.state.tasks.get('t2a').parent_id, 't2');
});

test('taskMoveCommands: een subtaak krijgt geen section_id; gelijke sleutels geven task_update-commando\'s vooraf', () => {
  const w = world();
  const sub = taskMoveCommands(w.state, 't3', { project_id: 'P', section_id: null, parent_id: 't1', beforeId: null });
  assert.equal(sub.length, 1);
  assert.deepEqual(Object.keys(sub[0].args).sort(), ['id', 'order_key', 'parent_id', 'project_id']);
  const top = taskMoveCommands(w.state, 't3', { project_id: 'P', section_id: 'S1', parent_id: null, beforeId: null });
  assert.equal(top[0].args.section_id, 'S1');
  // twee buren met gelijke sleutel
  w.run('task_add', { id: 'x1', content: 'x1', project_id: 'Q', order_key: 'm' });
  w.run('task_add', { id: 'x2', content: 'x2', project_id: 'Q', order_key: 'm' });
  const tie = taskMoveCommands(w.state, 't3', { project_id: 'Q', section_id: null, parent_id: null, beforeId: 'x2' });
  assert.deepEqual(tie.map((c) => c.type), ['task_update', 'task_move']);
  for (const c of tie) applyCommand(w.state, c, NOW, null);
  assert.deepEqual(list(w.state, 'Q').filter((id) => id !== 'q1'), ['x1', 't3', 'x2']);
});

test('currentTaskPlan: de plek van nu, om terug te zetten', () => {
  const w = world();
  assert.deepEqual(currentTaskPlan(w.state, 't2'), { project_id: 'P', section_id: null, parent_id: null, beforeId: 't3' });
  assert.deepEqual(currentTaskPlan(w.state, 't2b'), { project_id: 'P', section_id: null, parent_id: 't2', beforeId: null });
  assert.equal(currentTaskPlan(w.state, 'weg'), null);
  const before = currentTaskPlan(w.state, 't2');
  perform(w, 't2', planTaskDropOnProject(w.state, { dragId: 't2', projectId: 'Q' }));
  perform(w, 't2', before);
  assert.deepEqual(list(w.state, 'P'), ['t1', 't2', 't3']);
});

// ---------- taken met het toetsenbord ----------

test('planTaskKey: omhoog en omlaag verplaatsen binnen de lijst, met positie voor de aankondiging', () => {
  const w = world();
  const up = planTaskKey(w.state, 't2', 'up');
  assert.deepEqual(up.plan, { project_id: 'P', section_id: null, parent_id: null, beforeId: 't1' });
  assert.equal(up.position, 1);
  assert.equal(up.count, 3);
  assert.equal(up.kind, 'moved');
  const down = planTaskKey(w.state, 't2', 'down');
  assert.deepEqual(down.plan, { project_id: 'P', section_id: null, parent_id: null, beforeId: null });
  assert.equal(down.position, 3);
  perform(w, 't2', down.plan);
  assert.deepEqual(list(w.state, 'P'), ['t1', 't3', 't2']);
  assert.equal(planTaskKey(w.state, 't1', 'up').blocked, 'first');
  assert.equal(planTaskKey(w.state, 't2a', 'up').blocked, 'first', 'een subtaak blijft bij haar ouder');
  assert.equal(planTaskKey(w.state, 't2b', 'down').blocked, 'last');
  assert.equal(planTaskKey(w.state, 'weg', 'up').blocked, 'gone');
  assert.equal(planTaskKey(w.state, 't2', 'sideways').blocked, 'unknown');
});

test('planTaskKey: aan de rand van een sectie naar de vorige of volgende sectie', () => {
  const w = world();
  const toS1 = planTaskKey(w.state, 't1', 'down'); // t1 is niet de laatste: gewoon een plek lager
  assert.equal(toS1.plan.section_id, null);
  const last = planTaskKey(w.state, 't3', 'down');
  assert.deepEqual(last.plan, { project_id: 'P', section_id: 'S1', parent_id: null, beforeId: 's1a' });
  assert.equal(last.container, 'S1');
  assert.equal(last.position, 1);
  perform(w, 't3', last.plan);
  assert.deepEqual(list(w.state, 'P', 'S1'), ['t3', 's1a', 's1b']);
  const back = planTaskKey(w.state, 't3', 'up');
  assert.deepEqual(back.plan, { project_id: 'P', section_id: null, parent_id: null, beforeId: null }, 'naar het einde van de taken zonder sectie');
  assert.equal(planTaskKey(w.state, 's2a', 'down').blocked, 'last');
  assert.equal(planTaskKey(w.state, 't1', 'up').blocked, 'first');
});

test('planTaskKey: afgevinkte taken (verborgen) tellen niet mee als buur, maar wel als de lijst ze toont', () => {
  const w = world();
  w.run('task_complete', { id: 't2' });
  assert.equal(planTaskKey(w.state, 't3', 'up').plan.beforeId, 't1', 'springt over de verborgen taak');
  assert.equal(planTaskKey(w.state, 't3', 'up').count, 2, 'telt alleen wat te zien is: t1 en t3');
  const shown = planTaskKey(w.state, 't3', 'up', { isVisible: () => true });
  assert.equal(shown.plan.beforeId, 't2');
});

test('planTaskKey: inspringen (subtaak van de taak erboven) en uitspringen', () => {
  const w = world();
  const indent = planTaskKey(w.state, 't3', 'indent');
  assert.deepEqual(indent.plan, { project_id: 'P', section_id: null, parent_id: 't2', beforeId: null });
  assert.equal(indent.kind, 'indented');
  assert.equal(indent.parent, 't2');
  perform(w, 't3', indent.plan);
  assert.deepEqual(list(w.state, 'P', null, 't2'), ['t2a', 't2b', 't3']);
  assert.equal(planTaskKey(w.state, 't1', 'indent').blocked, 'noPrevious');
  assert.equal(planTaskKey(w.state, 't2a', 'indent').blocked, 'noPrevious');
  const out = planTaskKey(w.state, 't3', 'outdent');
  assert.deepEqual(out.plan, { project_id: 'P', section_id: null, parent_id: null, beforeId: null }, 'direct onder de ouder (t2 was de laatste)');
  assert.equal(out.kind, 'outdented');
  const outMid = planTaskKey(w.state, 't2a', 'outdent');
  assert.equal(outMid.plan.beforeId, null, 't2 is nu de laatste (t3 hangt eronder)');
  perform(w, 't2a', outMid.plan);
  assert.deepEqual(list(w.state, 'P'), ['t1', 't2', 't2a']);
  assert.equal(planTaskKey(w.state, 't1', 'outdent').blocked, 'noParent');
});

test('planTaskKey: elke plek, stap voor stap, geeft een lijst zonder verlies of dubbelen', () => {
  const w = world();
  const before = [...w.state.tasks.keys()].sort();
  let seed = 3;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 300; i++) {
    const ids = [...w.state.tasks.values()].filter((t) => t.project_id === 'P').map((t) => t.id).sort();
    const id = ids[rnd(ids.length)];
    const r = planTaskKey(w.state, id, ['up', 'down', 'indent', 'outdent'][rnd(4)]);
    if (r.blocked) continue;
    perform(w, id, r.plan);
    const t = w.state.tasks.get(id);
    assert.equal(t.parent_id ?? null, r.plan.parent_id, 'staat waar het plan zei');
    const sibs = list(w.state, 'P', t.section_id ?? null, t.parent_id ?? null);
    assert.equal(sibs.indexOf(id) + 1, r.position, `positie in de aankondiging klopt (stap ${i})`);
    assert.equal(sibs.length, r.count);
  }
  assert.deepEqual([...w.state.tasks.keys()].sort(), before);
});

// ---------- projecten ----------

/** Een toestand met projecten: A (Alice eigenaar) met B en C eronder, D, E (van Bob, Alice is lid) en F (archief). */
function projects() {
  const state = emptyState();
  const run = (type, args, userId = 'alice') => applyCommand(state, { type, args }, NOW, userId);
  const add = (id, order_key, extra = {}, who = 'alice') => run('project_add', { id, name: id, order_key, ...extra }, who);
  add('A', 'a');
  add('B', 'a', { parent_id: 'A' });
  add('C', 'b', { parent_id: 'A' });
  add('D', 'c');
  add('E', 'd', {}, 'bob');
  state.members.set('m1', { id: 'm1', project_id: 'E', user_id: 'alice', role: 'member', is_deleted: false });
  add('F', 'e', { is_archived: true });
  state.projects.set('inbox-alice', { id: 'inbox-alice', name: 'Inbox', parent_id: null, order_key: 'A', is_deleted: false });
  state.members.set('m2', { id: 'm2', project_id: 'inbox-alice', user_id: 'alice', role: 'owner', is_deleted: false });
  return { state, run };
}
const kids = (state, parent) => [...state.projects.values()].filter((p) => (p.parent_id ?? null) === parent && p.id !== 'inbox-alice').sort(byOrder).map((p) => p.id);
const performProject = (w, id, plan) => { for (const c of projectMoveCommands(w.state, id, plan)) applyCommand(w.state, c, NOW, 'alice'); };

test('canReorderProject: alleen de eigenaar; de Inbox en een gearchiveerd project niet; zonder bekende gebruiker wel', () => {
  const w = projects();
  assert.equal(canReorderProject(w.state, 'A', 'alice'), true);
  assert.equal(canReorderProject(w.state, 'B', 'alice'), true);
  assert.equal(canReorderProject(w.state, 'E', 'alice'), false, 'lid, geen eigenaar');
  assert.equal(canReorderProject(w.state, 'inbox-alice', 'alice'), false);
  assert.equal(canReorderProject(w.state, 'F', 'alice'), false);
  assert.equal(canReorderProject(w.state, 'weg', 'alice'), false);
  assert.equal(canReorderProject(w.state, 'E', null), true);
});

test('planProjectDrop: volgorde wijzigen op het hoogste niveau', () => {
  const w = projects();
  assert.deepEqual(planProjectDrop(w.state, { dragId: 'D', overId: 'A', zone: 'before', userId: 'alice' }), { parent_id: null, beforeId: 'A' });
  assert.equal(planProjectDrop(w.state, { dragId: 'A', overId: 'D', zone: 'before', userId: 'alice' }), null, 'staat al voor D');
  assert.deepEqual(planProjectDrop(w.state, { dragId: 'A', overId: 'D', zone: 'after', userId: 'alice' }), { parent_id: null, beforeId: 'E' });
  performProject(w, 'D', planProjectDrop(w.state, { dragId: 'D', overId: 'A', zone: 'before', userId: 'alice' }));
  assert.deepEqual(kids(w.state, null), ['D', 'A', 'E', 'F']);
  assert.equal(w.state.projects.get('D').parent_id, null);
});

test('planProjectDrop: een subproject maken, eruit slepen en binnen de ouder ordenen', () => {
  const w = projects();
  const sub = planProjectDrop(w.state, { dragId: 'D', overId: 'B', zone: 'child', userId: 'alice' });
  assert.deepEqual(sub, { parent_id: 'B', beforeId: null });
  performProject(w, 'D', sub);
  assert.equal(w.state.projects.get('D').parent_id, 'B');
  // eruit: naast de ouder
  const out = planProjectDrop(w.state, { dragId: 'D', overId: 'A', zone: 'after', userId: 'alice' });
  assert.equal(out.parent_id, null);
  performProject(w, 'D', out);
  assert.deepEqual(kids(w.state, null), ['A', 'D', 'E', 'F']);
  assert.deepEqual(projectMoveCommands(w.state, 'D', { parent_id: null, beforeId: 'E' }).at(-1).args.parent_id, undefined, 'parent_id alleen meesturen als die verandert');
  // binnen de ouder
  performProject(w, 'C', planProjectDrop(w.state, { dragId: 'C', overId: 'B', zone: 'before', userId: 'alice' }));
  assert.deepEqual(kids(w.state, 'A'), ['C', 'B']);
});

test('planProjectDrop: "eronder" bij een uitgeklapt project met subprojecten wordt het eerste subproject', () => {
  const w = projects();
  assert.deepEqual(planProjectDrop(w.state, { dragId: 'D', overId: 'A', zone: 'after', overExpanded: true, userId: 'alice' }), { parent_id: 'A', beforeId: 'B' });
  assert.deepEqual(planProjectDrop(w.state, { dragId: 'C', overId: 'A', zone: 'after', overExpanded: false, userId: 'alice' }), { parent_id: null, beforeId: 'D' });
});

test('planProjectDrop: geen cirkels, niet onder de Inbox, niet op jezelf, niet onder een gearchiveerd project', () => {
  const w = projects();
  assert.equal(planProjectDrop(w.state, { dragId: 'A', overId: 'B', zone: 'child', userId: 'alice' }), null, 'onder een eigen subproject');
  assert.equal(planProjectDrop(w.state, { dragId: 'A', overId: 'B', zone: 'after', userId: 'alice' }), null, 'naast een eigen subproject = erin');
  assert.equal(planProjectDrop(w.state, { dragId: 'A', overId: 'A', zone: 'child', userId: 'alice' }), null);
  assert.equal(planProjectDrop(w.state, { dragId: 'D', overId: 'inbox-alice', zone: 'child', userId: 'alice' }), null);
  assert.equal(planProjectDrop(w.state, { dragId: 'D', overId: 'F', zone: 'child', userId: 'alice' }), null);
  w.run('project_add', { id: 'diep', name: 'diep', parent_id: 'C', order_key: 'a' });
  assert.equal(planProjectDrop(w.state, { dragId: 'A', overId: 'diep', zone: 'child', userId: 'alice' }), null, 'ook niet onder een kleinkind');
});

test('planProjectDrop: een lid (geen eigenaar) kan niets verplaatsen, en de Inbox ook niet', () => {
  const w = projects();
  assert.equal(planProjectDrop(w.state, { dragId: 'E', overId: 'A', zone: 'before', userId: 'alice' }), null);
  assert.equal(planProjectDrop(w.state, { dragId: 'E', overId: 'A', zone: 'child', userId: 'alice' }), null);
  assert.equal(planProjectDrop(w.state, { dragId: 'inbox-alice', overId: 'A', zone: 'after', userId: 'alice' }), null);
  assert.equal(planProjectDropToTop(w.state, { dragId: 'E', userId: 'alice' }), null);
  assert.equal(planProjectKey(w.state, 'E', 'up', { userId: 'alice' }).blocked, 'denied');
  // maar je kunt wel een project van jou onder een project van iemand anders... (de server staat het toe) of ernaast zetten
  assert.ok(planProjectDrop(w.state, { dragId: 'D', overId: 'E', zone: 'after', userId: 'alice' }));
});

test('planProjectDropToTop: van een subproject een gewoon project maken, bovenaan (onder de Inbox)', () => {
  const w = projects();
  const plan = planProjectDropToTop(w.state, { dragId: 'C', userId: 'alice' });
  assert.deepEqual(plan, { parent_id: null, beforeId: 'A' });
  performProject(w, 'C', plan);
  assert.deepEqual(kids(w.state, null), ['C', 'A', 'D', 'E', 'F']);
  assert.equal(planProjectDropToTop(w.state, { dragId: 'C', userId: 'alice' }), null, 'staat al bovenaan');
  assert.equal(currentProjectPlan(w.state, 'A').beforeId, 'D');
});

test('planProjectDrop in Favorieten: alleen vóór of na een favoriet met dezelfde bovenliggende; niet erin', () => {
  const w = projects();
  w.run('project_update', { id: 'A', is_favorite: true });
  w.run('project_update', { id: 'D', is_favorite: true });
  const opts = { userId: 'alice', favoritesOnly: true };
  assert.deepEqual(planProjectDrop(w.state, { dragId: 'D', overId: 'A', zone: 'before', ...opts }), { parent_id: null, beforeId: 'A' });
  assert.equal(planProjectDrop(w.state, { dragId: 'D', overId: 'A', zone: 'child', ...opts }), null);
  assert.equal(planProjectDrop(w.state, { dragId: 'D', overId: 'A', zone: 'after', overExpanded: true, ...opts })?.parent_id ?? null, null, 'geen nesten in de favorietenlijst');
  w.run('project_update', { id: 'B', is_favorite: true });
  assert.equal(planProjectDrop(w.state, { dragId: 'D', overId: 'B', zone: 'before', ...opts }), null, 'andere bovenliggende: geen plek in de favorieten');
});

test('planProjectKey: omhoog en omlaag, inspringen en uitspringen; de Inbox en het archief tellen niet', () => {
  const w = projects();
  const up = planProjectKey(w.state, 'D', 'up', { userId: 'alice' });
  assert.deepEqual(up.plan, { parent_id: null, beforeId: 'A' });
  assert.equal(up.position, 1);
  assert.equal(up.count, 3, 'A, D en E');
  assert.equal(planProjectKey(w.state, 'A', 'up', { userId: 'alice' }).blocked, 'first', 'boven A staat alleen de Inbox');
  const down = planProjectKey(w.state, 'A', 'down', { userId: 'alice' });
  assert.deepEqual(down.plan, { parent_id: null, beforeId: 'E' });
  assert.equal(down.position, 2);
  assert.equal(planProjectKey(w.state, 'D', 'down', { userId: 'alice' }).plan.beforeId, 'F', 'E is van Bob maar wel zichtbaar; D gaat erachter, vóór het verborgen archief');
  assert.equal(planProjectKey(w.state, 'B', 'up', { userId: 'alice' }).blocked, 'first');
  const indent = planProjectKey(w.state, 'D', 'indent', { userId: 'alice' });
  assert.deepEqual(indent.plan, { parent_id: 'A', beforeId: null });
  assert.equal(indent.kind, 'indented');
  assert.equal(indent.parent, 'A');
  performProject(w, 'D', indent.plan);
  assert.deepEqual(kids(w.state, 'A'), ['B', 'C', 'D']);
  const out = planProjectKey(w.state, 'D', 'outdent', { userId: 'alice' });
  assert.deepEqual(out.plan, { parent_id: null, beforeId: 'E' });
  assert.equal(planProjectKey(w.state, 'A', 'outdent', { userId: 'alice' }).blocked, 'noParent');
  assert.equal(planProjectKey(w.state, 'A', 'indent', { userId: 'alice' }).blocked, 'noPrevious', 'de Inbox is geen plek om onder te hangen');
  assert.equal(planProjectKey(w.state, 'weg', 'up', { userId: 'alice' }).blocked, 'gone');
});

test('planProjectKey in Favorieten: alleen omhoog en omlaag, langs andere favorieten met dezelfde bovenliggende', () => {
  const w = projects();
  for (const id of ['A', 'D']) w.run('project_update', { id, is_favorite: true });
  const opts = { userId: 'alice', favoritesOnly: true };
  assert.deepEqual(planProjectKey(w.state, 'D', 'up', opts).plan, { parent_id: null, beforeId: 'A' });
  assert.equal(planProjectKey(w.state, 'D', 'down', opts).blocked, 'last', 'E is geen favoriet');
  assert.equal(planProjectKey(w.state, 'D', 'indent', opts).blocked, 'unknown');
});

test('een project verplaatsen met twee buren met dezelfde sleutel gaat goed (geen uitzondering, juiste volgorde)', () => {
  const w = projects();
  w.run('project_add', { id: 'G', name: 'G', order_key: 'c' }); // zelfde sleutel als D
  const plan = planProjectDrop(w.state, { dragId: 'A', overId: 'G', zone: 'before', userId: 'alice' });
  assert.ok(plan);
  performProject(w, 'A', plan);
  assert.deepEqual(kids(w.state, null), ['D', 'A', 'G', 'E', 'F']);
});

test('een plan uitvoeren verandert alleen wat moet: de rest van de lijst houdt zijn sleutels', () => {
  const w = world();
  const before = new Map([...w.state.tasks].map(([id, t]) => [id, t.order_key]));
  perform(w, 't3', planTaskDrop(w.state, { dragId: 't3', overId: 't1', zone: 'before' }));
  const changed = [...w.state.tasks].filter(([id, t]) => t.order_key !== before.get(id)).map(([id]) => id);
  assert.deepEqual(changed, ['t3']);
});
