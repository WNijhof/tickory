// Rooktest tegen een draaiende server (los proces). Gebruik: node scripts/smoke.ts <basis-url> <tokenbestand>
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const [, , base = 'http://127.0.0.1:8799', tokenFile = '.smoke-token'] = process.argv;
const token = readFileSync(tokenFile, 'utf8').trim();

async function sync(body: unknown, auth = true): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}/api/v1/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}`, 'X-Client-Id': 'smoke-1' } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

console.log('health:', (await (await fetch(`${base}/health`)).json()));
assert.equal((await sync({}, false)).status, 401);
console.log('zonder token: 401 ✓');

const first = await sync({
  sync_token: '*',
  commands: [
    { type: 'project_add', uuid: 'smoke-cmd-0001', args: { id: 'project-smoke-01', name: 'Rooktest' } },
    { type: 'task_add', uuid: 'smoke-cmd-0002', args: {
      id: 'task-smoke-0001', project_id: 'project-smoke-01', content: 'Planten water geven', priority: 2,
      due: { date: '2026-11-13', string: 'elke vrijdag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [5] } } } },
  ],
});
assert.equal(first.status, 200);
assert.equal(first.json.sync_status['smoke-cmd-0001'], 'ok');
assert.equal(first.json.sync_status['smoke-cmd-0002'], 'ok');
console.log('aanmaken: token', first.json.sync_token, '| taken:', first.json.tasks.map((t: any) => `${t.content} (sleutel ${t.order_key})`));

const done = await sync({ sync_token: first.json.sync_token, commands: [{ type: 'task_complete', uuid: 'smoke-cmd-0003', args: { id: 'task-smoke-0001' } }] });
const t = done.json.tasks[0];
assert.equal(t.checked, false);
assert.equal(t.due.date, '2026-11-20');
assert.equal(done.json.projects.length, 0, 'delta bevat het ongewijzigde project niet');
console.log('afvinken terugkerende taak: nieuwe datum', t.due.date, '| nog open:', !t.checked, '| keer voltooid:', t.completed_count);

const rev = done.json.sync_token;
const again = await sync({ sync_token: rev, commands: [{ type: 'task_complete', uuid: 'smoke-cmd-0003', args: { id: 'task-smoke-0001' } }] });
assert.equal(again.json.sync_status['smoke-cmd-0003'], 'ok');
assert.equal(again.json.sync_token, rev, 'herhaald commando verandert niets');
assert.equal(again.json.tasks.length, 0);
console.log('herhaald commando (zelfde uuid): idempotent ✓, token ongewijzigd', again.json.sync_token);

const bad = await sync({ sync_token: rev, commands: [{ type: 'task_add', uuid: 'smoke-cmd-0004', args: { project_id: 'project-smoke-01', content: 'x', priority: 9 } }] });
console.log('ongeldig commando:', JSON.stringify(bad.json.sync_status['smoke-cmd-0004']));
assert.equal(bad.json.sync_status['smoke-cmd-0004'].error_code, 'INVALID_ARG');

const del = await sync({ sync_token: rev, commands: [{ type: 'project_delete', uuid: 'smoke-cmd-0005', args: { id: 'project-smoke-01' } }] });
console.log('project verwijderen: delta bevat', del.json.projects.length, 'project en', del.json.tasks.length, 'taak als is_deleted =', del.json.tasks.every((x: any) => x.is_deleted));
const full = await sync({ sync_token: '*' });
assert.equal(full.json.tasks.length + full.json.projects.length, 0);
console.log('volledige sync daarna: leeg ✓');
console.log('\nROOKTEST GESLAAGD');
