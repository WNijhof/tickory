import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dueCounts } from './dueCounts.js';

test('dueCounts: open taken per dag; een tijd telt op haar dag; afgevinkt en zonder datum tellen niet', () => {
  const tasks = new Map([
    ['a', { due: { date: '2026-11-20' } }],
    ['b', { due: { date: '2026-11-20T09:00' } }],
    ['c', { due: { date: '2026-11-21' } }],
    ['d', { checked: true, due: { date: '2026-11-20' } }],
    ['e', { due: null }],
    ['f', {}],
  ]);
  assert.deepEqual([...dueCounts({ tasks })].sort(), [['2026-11-20', 2], ['2026-11-21', 1]]);
  assert.equal(dueCounts({ tasks: new Map() }).size, 0);
});
