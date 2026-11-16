// Afvinkingen van terugkerende taken voor Voltooid (stats.ts, recurringCompletions): elke keer, nieuwste eerst, alleen uit je
// eigen projecten, en geen gewone afvinkingen (die staan al als afgevinkte taak in Voltooid).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from './sync.ts';
import type { Command } from './sync.ts';
import { recurringCompletions } from './stats.ts';
import { addUser, freshDb } from './testutil.ts';

let n = 0;
const cmd = (type: string, args: Record<string, unknown>): Command => ({ type, uuid: `rec-${String(++n).padStart(8, '0')}`, args });

test('elke afvinking van een terugkerende taak, nieuwste eerst; een gewone taak niet; niet uit andermans project', () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  const ok = (who: typeof anna, commands: Command[]) => {
    const r = handleSync(db, { commands }, who.id);
    for (const c of commands) assert.equal(r.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(r.sync_status[c.uuid])}`);
  };
  ok(anna, [
    cmd('task_add', { id: 'task-herhaal01', project_id: anna.inbox_project_id, content: 'Planten water geven', due: { date: '2026-11-10', recurrence: { freq: 'daily' } } }),
    cmd('task_add', { id: 'task-gewoon001', project_id: anna.inbox_project_id, content: 'Eenmalig', due: { date: '2026-11-10' } }),
  ]);
  ok(anna, [cmd('task_complete', { id: 'task-herhaal01' })]);
  ok(anna, [cmd('task_complete', { id: 'task-herhaal01' })]);
  ok(anna, [cmd('task_complete', { id: 'task-gewoon001' })]);
  ok(bram, [cmd('task_add', { id: 'task-bram00001', project_id: bram.inbox_project_id, content: 'Van Bram', due: { date: '2026-11-10', recurrence: { freq: 'daily' } } })]);
  ok(bram, [cmd('task_complete', { id: 'task-bram00001' })]);
  const { entries } = recurringCompletions(db, anna.id, {});
  assert.deepEqual(entries.map((e) => [e.task_id, e.title]), [['task-herhaal01', 'Planten water geven'], ['task-herhaal01', 'Planten water geven']], 'elke keer; de gewone taak niet');
  assert.ok(Number(entries[0].id) > Number(entries[1].id), 'nieuwste eerst');
  assert.equal(recurringCompletions(db, bram.id, {}).entries.length, 1);
  assert.throws(() => recurringCompletions(db, anna.id, { days: '999' }), /days/);
});
