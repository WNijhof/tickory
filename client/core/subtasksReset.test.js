// Subtaken resetten (Instellingen › Algemeen): de voorspelling in de client doet hetzelfde als de server (server/sync.ts, taskComplete).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyState } from './reducer.js';

const NOW = '2026-11-13T10:00:00.000Z';
const me = 'user-anna-0001';

function setup(resetSubtasks) {
  const state = emptyState();
  const run = (type, args) => applyCommand(state, { type, uuid: `u-${Math.random()}`, args }, NOW, me);
  run('project_add', { id: 'project-aaaa1111', name: 'Werk' });
  if (resetSubtasks) state.settings.set(`settings-${me}`, { id: `settings-${me}`, owner_id: me, general: { reset_subtasks: true } }); // de rij komt van de server
  run('task_add', { id: 'rec-aaaaaaa11', project_id: 'project-aaaa1111', content: 'Boodschappen', due: { date: '2026-11-13', recurrence: { freq: 'weekly', byweekday: [5] } } });
  run('task_add', { id: 'kid-aaaaaaa11', project_id: 'project-aaaa1111', parent_id: 'rec-aaaaaaa11', content: 'Brood' });
  run('task_complete', { id: 'kid-aaaaaaa11' });
  return { state, run };
}

test('zonder de instelling blijft een afgevinkte subtaak af als de terugkerende taak doorschuift', () => {
  const { state, run } = setup(false);
  run('task_complete', { id: 'rec-aaaaaaa11' });
  assert.equal(state.tasks.get('rec-aaaaaaa11').due.date, '2026-11-20');
  assert.equal(state.tasks.get('kid-aaaaaaa11').checked, true);
});

test('met de instelling gaat de subtaak weer open', () => {
  const { state, run } = setup(true);
  assert.equal(state.tasks.get('kid-aaaaaaa11').checked, true);
  run('task_complete', { id: 'rec-aaaaaaa11' });
  assert.equal(state.tasks.get('rec-aaaaaaa11').due.date, '2026-11-20');
  assert.equal(state.tasks.get('kid-aaaaaaa11').checked, false);
  assert.equal(state.tasks.get('kid-aaaaaaa11').completed_at, null);
});
