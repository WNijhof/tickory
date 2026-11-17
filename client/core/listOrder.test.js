// Tests voor de eigen volgorde van filters en labels (core/listOrder.js). De plannen worden ook uitgevoerd op de optimistische
// toestand (reducer), zodat te zien is dat de zijbalk er daarna goed uitziet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyState } from './reducer.js';
import { currentListPlan, listMoveCommands, listPosition, orderedItems, planListDrop, planListKey } from './listOrder.js';

const NOW = '2026-11-17T10:00:00.000Z';

/** Filters a..e (b en d favoriet) en labels x, y, z (z van iemand anders). */
function world() {
  const state = emptyState();
  const run = (type, args, userId = 'me') => applyCommand(state, { type, args }, NOW, userId);
  const filter = (id, order_key, extra = {}) => run('filter_add', { id, name: id, query: 'vandaag', order_key, ...extra });
  filter('a', 'a');
  filter('b', 'b', { is_favorite: true });
  filter('c', 'c');
  filter('d', 'd', { is_favorite: true });
  filter('e', 'e');
  run('label_add', { id: 'x', name: 'x', order_key: 'a' });
  run('label_add', { id: 'y', name: 'y', order_key: 'b' });
  run('label_add', { id: 'z', name: 'z', order_key: 'c' }, 'someone');
  return { state, run };
}

const ids = (state, kind = 'filter') => orderedItems(state, kind, 'me').map((x) => x.id);
const apply = (w, kind, id, plan) => { for (const c of listMoveCommands(w.state, kind, id, plan, 'me')) w.run(c.type, c.args); };

test('de volgorde van de zijbalk: eerst de favorieten, dan de rest, elk op sleutel; labels van anderen niet', () => {
  const { state } = world();
  assert.deepEqual(ids(state), ['b', 'd', 'a', 'c', 'e']);
  assert.deepEqual(ids(state, 'label'), ['x', 'y']);
  assert.deepEqual(orderedItems(state, 'iets', 'me'), []);
});

test('slepen binnen de rest: boven of onder een ander, en de sleutels kloppen daarna', () => {
  const w = world();
  const plan = planListDrop(w.state, { kind: 'filter', dragId: 'e', overId: 'a', zone: 'before', userId: 'me' });
  assert.deepEqual(plan, { beforeId: 'a' });
  apply(w, 'filter', 'e', plan);
  assert.deepEqual(ids(w.state), ['b', 'd', 'e', 'a', 'c']);
  const down = planListDrop(w.state, { kind: 'filter', dragId: 'e', overId: 'c', zone: 'after', userId: 'me' });
  assert.deepEqual(down, { beforeId: null });
  apply(w, 'filter', 'e', down);
  assert.deepEqual(ids(w.state), ['b', 'd', 'a', 'c', 'e']);
});

test('slepen binnen de favorieten', () => {
  const w = world();
  const plan = planListDrop(w.state, { kind: 'filter', dragId: 'd', overId: 'b', zone: 'before', userId: 'me' });
  assert.deepEqual(plan, { beforeId: 'b' });
  apply(w, 'filter', 'd', plan);
  assert.deepEqual(ids(w.state), ['d', 'b', 'a', 'c', 'e']);
});

test('boven de andere groep: een gewoon filter komt vooraan bij de rest, een favoriet achteraan bij de favorieten', () => {
  const w = world();
  assert.deepEqual(planListDrop(w.state, { kind: 'filter', dragId: 'c', overId: 'b', zone: 'before', userId: 'me' }), { beforeId: 'a' });
  assert.deepEqual(planListDrop(w.state, { kind: 'filter', dragId: 'b', overId: 'e', zone: 'after', userId: 'me' }), { beforeId: null });
  apply(w, 'filter', 'b', { beforeId: null });
  assert.deepEqual(ids(w.state), ['d', 'b', 'a', 'c', 'e']);
  // het eerste gewone filter boven een favoriet: staat er al, er verandert niets
  assert.equal(planListDrop(w.state, { kind: 'filter', dragId: 'a', overId: 'd', zone: 'before', userId: 'me' }), null);
});

test('niets te doen: op zichzelf, op dezelfde plek, een onbekend item of een label van een ander', () => {
  const { state } = world();
  assert.equal(planListDrop(state, { kind: 'filter', dragId: 'a', overId: 'a', zone: 'before', userId: 'me' }), null);
  assert.equal(planListDrop(state, { kind: 'filter', dragId: 'a', overId: 'c', zone: 'before', userId: 'me' }), null); // a staat al vóór c
  assert.equal(planListDrop(state, { kind: 'filter', dragId: 'c', overId: 'a', zone: 'after', userId: 'me' }), null); // c staat al na a
  assert.equal(planListDrop(state, { kind: 'filter', dragId: 'q', overId: 'a', zone: 'before', userId: 'me' }), null);
  assert.equal(planListDrop(state, { kind: 'label', dragId: 'z', overId: 'x', zone: 'before', userId: 'me' }), null);
  assert.equal(planListDrop(state, { kind: 'label', dragId: 'y', overId: 'z', zone: 'before', userId: 'me' }), null);
  assert.equal(planListDrop(state, { kind: 'label', dragId: 'a', overId: 'x', zone: 'before', userId: 'me' }), null); // een filter is geen label
  assert.deepEqual(listMoveCommands(state, 'label', 'z', { beforeId: null }, 'me'), []);
  assert.deepEqual(listMoveCommands(state, 'iets', 'a', { beforeId: null }, 'me'), []);
});

test('labels slepen geeft label_update', () => {
  const w = world();
  const plan = planListDrop(w.state, { kind: 'label', dragId: 'y', overId: 'x', zone: 'before', userId: 'me' });
  const commands = listMoveCommands(w.state, 'label', 'y', plan, 'me');
  assert.deepEqual(commands.map((c) => c.type), ['label_update']);
  assert.equal(commands[0].args.id, 'y');
  assert.ok(commands[0].args.order_key < 'a');
  apply(w, 'label', 'y', plan);
  assert.deepEqual(ids(w.state, 'label'), ['y', 'x']);
});

test('toetsenbord: omhoog en omlaag binnen de groep, met plek en totaal', () => {
  const w = world();
  const up = planListKey(w.state, 'filter', 'c', 'up', { userId: 'me' });
  assert.deepEqual(up, { plan: { beforeId: 'a' }, position: 3, count: 5 });
  apply(w, 'filter', 'c', up.plan);
  assert.deepEqual(ids(w.state), ['b', 'd', 'c', 'a', 'e']);
  const down = planListKey(w.state, 'filter', 'c', 'down', { userId: 'me' });
  assert.deepEqual(down, { plan: { beforeId: 'e' }, position: 4, count: 5 });
  apply(w, 'filter', 'c', down.plan);
  const last = planListKey(w.state, 'filter', 'c', 'down', { userId: 'me' });
  assert.deepEqual(last, { plan: { beforeId: null }, position: 5, count: 5 });
  apply(w, 'filter', 'c', last.plan);
  assert.deepEqual(ids(w.state), ['b', 'd', 'a', 'e', 'c']);
  const fav = planListKey(w.state, 'filter', 'b', 'down', { userId: 'me' });
  assert.deepEqual(fav, { plan: { beforeId: null }, position: 2, count: 5 });
});

test('toetsenbord: de randen van de groepen', () => {
  const { state } = world();
  assert.deepEqual(planListKey(state, 'filter', 'b', 'up', { userId: 'me' }), { blocked: 'first' });
  assert.deepEqual(planListKey(state, 'filter', 'd', 'down', { userId: 'me' }), { blocked: 'favorites' });
  assert.deepEqual(planListKey(state, 'filter', 'a', 'up', { userId: 'me' }), { blocked: 'favorites' });
  assert.deepEqual(planListKey(state, 'filter', 'e', 'down', { userId: 'me' }), { blocked: 'last' });
  assert.deepEqual(planListKey(state, 'label', 'x', 'up', { userId: 'me' }), { blocked: 'first' });
  assert.deepEqual(planListKey(state, 'label', 'y', 'down', { userId: 'me' }), { blocked: 'last' });
  assert.deepEqual(planListKey(state, 'label', 'z', 'up', { userId: 'me' }), { blocked: 'gone' });
  assert.deepEqual(planListKey(state, 'filter', 'a', 'indent', { userId: 'me' }), { blocked: 'unknown' });
});

test('zonder favorieten is bovenaan gewoon bovenaan', () => {
  const w = world();
  w.run('filter_update', { id: 'b', is_favorite: false });
  w.run('filter_update', { id: 'd', is_favorite: false });
  assert.deepEqual(planListKey(w.state, 'filter', 'a', 'up', { userId: 'me' }), { blocked: 'first' });
  assert.deepEqual(planListKey(w.state, 'filter', 'e', 'down', { userId: 'me' }), { blocked: 'last' });
});

test('twee filters met dezelfde sleutel: de buren krijgen nieuwe sleutels en de volgorde klopt', () => {
  const w = world();
  w.run('filter_add', { id: 'f', name: 'f', query: 'p1', order_key: 'c' }); // zelfde sleutel als c (twee apparaten offline)
  assert.deepEqual(ids(w.state), ['b', 'd', 'a', 'c', 'f', 'e']);
  const plan = planListDrop(w.state, { kind: 'filter', dragId: 'e', overId: 'f', zone: 'before', userId: 'me' });
  assert.deepEqual(plan, { beforeId: 'f' });
  const commands = listMoveCommands(w.state, 'filter', 'e', plan, 'me');
  assert.ok(commands.length >= 2, 'een nieuwe sleutel voor de buur');
  apply(w, 'filter', 'e', plan);
  assert.deepEqual(ids(w.state), ['b', 'd', 'a', 'c', 'e', 'f']);
});

test('de plek van nu en de plek na een plan', () => {
  const { state } = world();
  assert.deepEqual(currentListPlan(state, 'filter', 'a', 'me'), { beforeId: 'c' });
  assert.deepEqual(currentListPlan(state, 'filter', 'e', 'me'), { beforeId: null });
  assert.deepEqual(currentListPlan(state, 'filter', 'd', 'me'), { beforeId: null });
  assert.equal(currentListPlan(state, 'filter', 'q', 'me'), null);
  assert.deepEqual(listPosition(state, 'filter', 'e', { beforeId: 'a' }, 'me'), { position: 3, count: 5 });
  assert.deepEqual(listPosition(state, 'filter', 'd', { beforeId: 'b' }, 'me'), { position: 1, count: 5 });
  assert.equal(listPosition(state, 'filter', 'q', { beforeId: null }, 'me'), null);
});
