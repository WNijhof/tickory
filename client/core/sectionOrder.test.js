// Tests voor het verplaatsen van secties (core/sectionOrder.js). De plannen worden ook uitgevoerd op de optimistische toestand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyState } from './reducer.js';
import {
  canMoveSection, currentSectionPlan, planSectionDrop, planSectionKey, projectSections, sectionMoveCommands, sectionPosition,
} from './sectionOrder.js';

const NOW = '2026-11-17T10:00:00.000Z';

/** Project P met secties a, b, c, d (c gearchiveerd) en project Q met sectie q. */
function world() {
  const state = emptyState();
  const run = (type, args) => applyCommand(state, { type, args }, NOW, 'me');
  run('project_add', { id: 'P', name: 'P', order_key: 'a' });
  run('project_add', { id: 'Q', name: 'Q', order_key: 'b' });
  for (const [id, key] of [['a', 'a'], ['b', 'b'], ['c', 'c'], ['d', 'd']]) run('section_add', { id, name: id, project_id: 'P', order_key: key });
  run('section_update', { id: 'c', is_archived: true });
  run('section_add', { id: 'q', name: 'q', project_id: 'Q', order_key: 'a' });
  return { state, run };
}

const order = (state, project = 'P') => projectSections(state, project).map((s) => s.id);
const apply = (w, id, plan) => { for (const c of sectionMoveCommands(w.state, id, plan)) w.run(c.type, c.args); };

test('de volgorde van de lijst en het bord: zonder gearchiveerde', () => {
  const { state } = world();
  assert.deepEqual(order(state), ['a', 'b', 'd']);
  assert.deepEqual(order(state, 'Q'), ['q']);
});

test('slepen: vóór of na een andere sectie, en de sleutels kloppen daarna', () => {
  const w = world();
  const plan = planSectionDrop(w.state, { dragId: 'd', overId: 'a', zone: 'before' });
  assert.deepEqual(plan, { beforeId: 'a' });
  const commands = sectionMoveCommands(w.state, 'd', plan);
  assert.deepEqual(commands.map((c) => c.type), ['section_update']);
  apply(w, 'd', plan);
  assert.deepEqual(order(w.state), ['d', 'a', 'b']);
  const back = planSectionDrop(w.state, { dragId: 'd', overId: 'b', zone: 'after' });
  assert.deepEqual(back, { beforeId: null });
  apply(w, 'd', back);
  assert.deepEqual(order(w.state), ['a', 'b', 'd']);
});

test('slepen: niets te doen op dezelfde plek, op zichzelf, in een ander project of op een gearchiveerde', () => {
  const { state } = world();
  assert.equal(planSectionDrop(state, { dragId: 'a', overId: 'a', zone: 'before' }), null);
  assert.equal(planSectionDrop(state, { dragId: 'a', overId: 'b', zone: 'before' }), null);
  assert.equal(planSectionDrop(state, { dragId: 'b', overId: 'a', zone: 'after' }), null);
  assert.equal(planSectionDrop(state, { dragId: 'a', overId: 'q', zone: 'before' }), null);
  assert.equal(planSectionDrop(state, { dragId: 'a', overId: 'c', zone: 'before' }), null);
  assert.equal(planSectionDrop(state, { dragId: 'x', overId: 'a', zone: 'before' }), null);
});

test('toetsenbord en menu: een plek eerder of later, ook links en rechts op het bord', () => {
  const w = world();
  assert.deepEqual(planSectionKey(w.state, 'b', 'up'), { plan: { beforeId: 'a' }, position: 1, count: 3 });
  assert.deepEqual(planSectionKey(w.state, 'b', 'left'), { plan: { beforeId: 'a' }, position: 1, count: 3 });
  assert.deepEqual(planSectionKey(w.state, 'a', 'down'), { plan: { beforeId: 'd' }, position: 2, count: 3 });
  assert.deepEqual(planSectionKey(w.state, 'b', 'right'), { plan: { beforeId: null }, position: 3, count: 3 });
  apply(w, 'b', { beforeId: null });
  assert.deepEqual(order(w.state), ['a', 'd', 'b']);
  assert.deepEqual(planSectionKey(w.state, 'a', 'up'), { blocked: 'first' });
  assert.deepEqual(planSectionKey(w.state, 'b', 'down'), { blocked: 'last' });
  assert.deepEqual(planSectionKey(w.state, 'c', 'up'), { blocked: 'gone' });
  assert.deepEqual(planSectionKey(w.state, 'x', 'up'), { blocked: 'gone' });
  assert.deepEqual(planSectionKey(w.state, 'a', 'indent'), { blocked: 'unknown' });
});

test('rechten: een lezer en een gearchiveerd project verplaatsen niets', () => {
  const w = world();
  // het project is door "me" gemaakt (eigenaar); maak er een project van een ander van waar "me" lezer is
  for (const [key, m] of w.state.members) if (m.project_id === 'P') w.state.members.delete(key);
  w.state.members.set('m-me', { id: 'm-me', project_id: 'P', user_id: 'me', role: 'viewer' });
  w.state.members.set('m-o', { id: 'm-o', project_id: 'P', user_id: 'owner', role: 'owner' });
  assert.equal(canMoveSection(w.state, 'b', 'me'), false);
  assert.equal(planSectionDrop(w.state, { dragId: 'd', overId: 'a', zone: 'before', userId: 'me' }), null);
  assert.deepEqual(planSectionKey(w.state, 'b', 'up', { userId: 'me' }), { blocked: 'denied' });
  assert.equal(canMoveSection(w.state, 'b', 'owner'), true);
  const v = world();
  v.run('project_update', { id: 'P', is_archived: true });
  assert.equal(canMoveSection(v.state, 'b', null), false);
  assert.equal(canMoveSection(v.state, 'c', null), false, 'een gearchiveerde sectie');
});

test('twee secties met dezelfde sleutel: de buren krijgen nieuwe sleutels', () => {
  const w = world();
  w.run('section_add', { id: 'e', name: 'e', project_id: 'P', order_key: 'b' }); // dezelfde sleutel als b
  assert.deepEqual(order(w.state), ['a', 'b', 'e', 'd']);
  const plan = planSectionDrop(w.state, { dragId: 'd', overId: 'e', zone: 'before' });
  assert.deepEqual(plan, { beforeId: 'e' });
  assert.ok(sectionMoveCommands(w.state, 'd', plan).length >= 2);
  apply(w, 'd', plan);
  assert.deepEqual(order(w.state), ['a', 'b', 'd', 'e']);
});

test('de plek van nu en de plek na een plan', () => {
  const { state } = world();
  assert.deepEqual(currentSectionPlan(state, 'a'), { beforeId: 'b' });
  assert.deepEqual(currentSectionPlan(state, 'd'), { beforeId: null });
  assert.equal(currentSectionPlan(state, 'x'), null);
  assert.deepEqual(sectionPosition(state, 'd', { beforeId: 'a' }), { position: 1, count: 3 });
  assert.equal(sectionPosition(state, 'x', { beforeId: null }), null);
  assert.deepEqual(sectionMoveCommands(state, 'x', { beforeId: null }), []);
});
