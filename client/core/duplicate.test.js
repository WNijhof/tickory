// Een taak dupliceren (core/duplicate.js): de kopie, de open subtaken, de plek en wat niet meegaat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DUPLICATE_LIMIT, planDuplicate, taskLink } from './duplicate.js';

const task = (id, extra = {}) => ({ id, project_id: 'p1', section_id: null, parent_id: null, content: id, priority: 4, labels: [], due: null, order_key: 'm', checked: false, ...extra });
const viewOf = (...tasks) => ({ tasks: new Map(tasks.map((x) => [x.id, x])) });
const ids = () => { let n = 0; return () => `kopie-${String(++n).padStart(4, '0')}`; };

test('de kopie heeft dezelfde velden en staat direct onder het origineel', () => {
  const view = viewOf(
    task('boodschappen', { order_key: 'b', content: 'Boodschappen doen', description: 'bij de markt', priority: 1, labels: ['l1'], due: { date: '2026-11-20T10:00', string: 'vrijdag om 10:00', lang: 'nl' }, deadline: '2026-11-21', duration: 30, assignee_id: 'u2', section_id: 's1' }),
    task('volgende', { order_key: 'd', section_id: 's1' }),
    task('andere-sectie', { order_key: 'c', section_id: 's2' }),
  );
  const plan = planDuplicate(view, 'boodschappen', { makeId: ids() });
  assert.equal(plan.ok, true);
  assert.equal(plan.commands.length, 1);
  const args = plan.commands[0].args;
  assert.equal(args.id, 'kopie-0001');
  assert.deepEqual([args.content, args.description, args.priority, args.labels, args.due.date, args.deadline, args.duration, args.assignee_id, args.section_id], ['Boodschappen doen', 'bij de markt', 1, ['l1'], '2026-11-20T10:00', '2026-11-21', 30, 'u2', 's1']);
  assert.ok(args.order_key > 'b' && args.order_key < 'd', `tussen het origineel en de volgende: ${args.order_key}`);
  assert.notEqual(args.labels, view.tasks.get('boodschappen').labels, 'een kopie, niet dezelfde lijst');
  assert.deepEqual(plan.copies, [{ id: 'kopie-0001', due: view.tasks.get('boodschappen').due }]);
});

test('de open subtaken gaan mee, in dezelfde boom; afgevinkte niet', () => {
  const view = viewOf(
    task('ouder', { order_key: 'b' }),
    task('kind-2', { parent_id: 'ouder', order_key: 'c' }),
    task('kind-1', { parent_id: 'ouder', order_key: 'b' }),
    task('kleinkind', { parent_id: 'kind-1', order_key: 'b' }),
    task('klaar', { parent_id: 'ouder', order_key: 'd', checked: true }),
    task('onder-klaar', { parent_id: 'klaar', order_key: 'b' }),
  );
  const plan = planDuplicate(view, 'ouder', { makeId: ids() });
  assert.deepEqual(plan.commands.map((c) => [c.args.content, c.args.parent_id ?? null]), [
    ['ouder', null], ['kind-1', 'kopie-0001'], ['kleinkind', 'kopie-0002'], ['kind-2', 'kopie-0001'],
  ]);
  assert.equal(plan.commands[0].args.order_key > 'b', true);
});

test('een subtaak dupliceren: de kopie hoort bij dezelfde ouder', () => {
  const view = viewOf(task('ouder'), task('kind', { parent_id: 'ouder', order_key: 'b' }));
  const plan = planDuplicate(view, 'kind', { makeId: ids() });
  assert.equal(plan.commands[0].args.parent_id, 'ouder');
  assert.equal(plan.commands[0].args.section_id, undefined);
});

test('niet bestaand of te groot', () => {
  assert.deepEqual(planDuplicate(viewOf(), 'weg', { makeId: ids() }), { ok: false, reason: 'missing' });
  const many = [task('groot')];
  for (let i = 0; i < DUPLICATE_LIMIT; i++) many.push(task(`sub-${i}`, { parent_id: 'groot', order_key: `b${String(i).padStart(4, '0')}` }));
  assert.deepEqual(planDuplicate(viewOf(...many), 'groot', { makeId: ids() }), { ok: false, reason: 'too_many' });
});

test('de link naar een taak', () => {
  assert.equal(taskLink('https://taken.example.org', 'abcdefgh1234'), 'https://taken.example.org/#task=abcdefgh1234');
});
