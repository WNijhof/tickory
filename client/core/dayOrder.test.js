// Tests voor de eigen volgorde in Vandaag: de controle en het toepassen (shared/dayOrder.js) en slepen en Alt + pijl (core/dayOrder.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DAY_ORDER, applyDayOrder, dayOrderCheck } from '../../shared/dayOrder.js';
import { nextDayOrder, planDayOrderDrop, planDayOrderKey } from './dayOrder.js';

const tasks = (...ids) => ids.map((id) => ({ id }));
const ids = (list) => list.map((t) => t.id);

test('controle: een lijst van verschillende id\'s, niet te lang', () => {
  assert.equal(dayOrderCheck([]), null);
  assert.equal(dayOrderCheck(['a', 'b']), null);
  assert.equal(dayOrderCheck(Array.from({ length: MAX_DAY_ORDER }, (_, i) => `t${i}`)), null);
  assert.match(dayOrderCheck(Array.from({ length: MAX_DAY_ORDER + 1 }, (_, i) => `t${i}`)), /hooguit 500/);
  assert.match(dayOrderCheck('a'), /lijst/);
  assert.match(dayOrderCheck({ a: 1 }), /lijst/);
  assert.match(dayOrderCheck(['a', 'a']), /twee keer/);
  assert.match(dayOrderCheck(['a', 3]), /tekst/);
  assert.match(dayOrderCheck(['']), /tekst/);
  assert.match(dayOrderCheck(['x'.repeat(65)]), /tekst/);
  assert.equal(dayOrderCheck(['x'.repeat(64)]), null);
});

test('toepassen: eerst de taken uit de volgorde, dan de rest zoals ze binnenkwamen', () => {
  assert.deepEqual(ids(applyDayOrder(tasks('a', 'b', 'c', 'd'), ['c', 'a'])), ['c', 'a', 'b', 'd']);
  assert.deepEqual(ids(applyDayOrder(tasks('a', 'b', 'c'), ['x', 'b', 'y'])), ['b', 'a', 'c'], 'onbekende id\'s doen niets');
  assert.deepEqual(ids(applyDayOrder(tasks('a', 'b'), null)), ['a', 'b']);
  assert.deepEqual(ids(applyDayOrder(tasks('a', 'b'), [])), ['a', 'b']);
  assert.deepEqual(ids(applyDayOrder(tasks('a', 'b'), 'ab')), ['a', 'b'], 'geen lijst: de gewone volgorde');
  assert.deepEqual(ids(applyDayOrder(tasks('a', 'b', 'c'), ['c', 'c', 'b', 7])), ['c', 'b', 'a'], 'dubbel of geen tekst: de eerste telt');
  const input = tasks('a', 'b');
  applyDayOrder(input, ['b', 'a']);
  assert.deepEqual(ids(input), ['a', 'b'], 'de invoer blijft zoals hij was');
});

test('slepen: boven of onder een andere taak in dezelfde groep', () => {
  const g = ['a', 'b', 'c', 'd'];
  assert.deepEqual(planDayOrderDrop(g, { dragId: 'd', overId: 'a', zone: 'before' }), ['d', 'a', 'b', 'c']);
  assert.deepEqual(planDayOrderDrop(g, { dragId: 'a', overId: 'c', zone: 'after' }), ['b', 'c', 'a', 'd']);
  assert.deepEqual(planDayOrderDrop(g, { dragId: 'a', overId: 'd', zone: 'after' }), ['b', 'c', 'd', 'a']);
  assert.deepEqual(planDayOrderDrop(g, { dragId: 'c', overId: 'b', zone: 'before' }), ['a', 'c', 'b', 'd']);
});

test('slepen: niets te doen op dezelfde plek, op zichzelf of buiten de groep', () => {
  const g = ['a', 'b', 'c'];
  assert.equal(planDayOrderDrop(g, { dragId: 'a', overId: 'a', zone: 'before' }), null);
  assert.equal(planDayOrderDrop(g, { dragId: 'a', overId: 'b', zone: 'before' }), null);
  assert.equal(planDayOrderDrop(g, { dragId: 'b', overId: 'a', zone: 'after' }), null);
  assert.equal(planDayOrderDrop(g, { dragId: 'x', overId: 'a', zone: 'before' }), null);
  assert.equal(planDayOrderDrop(g, { dragId: 'a', overId: 'x', zone: 'before' }), null);
});

test('toetsenbord: een plek omhoog of omlaag, met plek en totaal, en de randen', () => {
  const g = ['a', 'b', 'c'];
  assert.deepEqual(planDayOrderKey(g, 'b', 'up'), { ids: ['b', 'a', 'c'], position: 1, count: 3 });
  assert.deepEqual(planDayOrderKey(g, 'b', 'down'), { ids: ['a', 'c', 'b'], position: 3, count: 3 });
  assert.deepEqual(planDayOrderKey(g, 'a', 'up'), { blocked: 'first' });
  assert.deepEqual(planDayOrderKey(g, 'c', 'down'), { blocked: 'last' });
  assert.deepEqual(planDayOrderKey(g, 'x', 'up'), { blocked: 'gone' });
  assert.deepEqual(planDayOrderKey(g, 'a', 'indent'), { blocked: 'unknown' });
  assert.deepEqual(g, ['a', 'b', 'c'], 'de invoer blijft zoals hij was');
});

test('de nieuwe day_order: de groep vooraan, de rest blijft, oude taken vallen eruit', () => {
  const view = {
    tasks: new Map([
      ['a', { id: 'a', due: { date: '2026-11-17' } }], ['b', { id: 'b', due: { date: '2026-11-17' } }],
      ['o1', { id: 'o1', due: { date: '2026-11-10' } }], ['o2', { id: 'o2', due: { date: '2026-11-11' } }],
      ['done', { id: 'done', checked: true, due: { date: '2026-11-17' } }], ['nodate', { id: 'nodate', due: null }],
    ]),
  };
  assert.deepEqual(nextDayOrder(view, ['o2', 'a', 'gone', 'done', 'nodate', 'o1'], ['b', 'a']), ['b', 'a', 'o2', 'o1']);
  assert.deepEqual(nextDayOrder(view, null, ['a', 'b']), ['a', 'b']);
  assert.deepEqual(nextDayOrder(view, 'rommel', ['a']), ['a']);
  assert.deepEqual(nextDayOrder(view, ['o1', 'o1', 7], ['a', 'a']), ['a', 'o1'], 'geen dubbele en geen rommel');
  const many = { tasks: new Map(Array.from({ length: 600 }, (_, i) => [`t${i}`, { id: `t${i}`, due: { date: '2026-11-17' } }])) };
  const out = nextDayOrder(many, Array.from({ length: 600 }, (_, i) => `t${i}`), ['t599']);
  assert.equal(out.length, MAX_DAY_ORDER);
  assert.equal(out[0], 't599');
  assert.equal(dayOrderCheck(out), null, 'blijft altijd geldig voor de server');
});
