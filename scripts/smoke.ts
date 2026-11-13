// Rooktest tegen een draaiende server (los proces).
// Gebruik: SMOKE_USER=<gebruikersnaam> SMOKE_PASSWORD=<wachtwoord> node scripts/smoke.ts [basis-url]
// Maakt een project "Rooktest" aan en ruimt dat aan het eind weer op; je andere gegevens blijven ongemoeid.
import assert from 'node:assert/strict';

const [, , base = 'http://127.0.0.1:8787'] = process.argv;
const { SMOKE_USER: username, SMOKE_PASSWORD: password } = process.env;
if (!username || !password) throw new Error('zet SMOKE_USER en SMOKE_PASSWORD');

console.log('health:', await (await fetch(`${base}/health`)).json());
const login = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, device_name: 'Rooktest' }),
});
assert.equal(login.status, 200, 'inloggen mislukt');
const { token, me } = await login.json();
console.log('ingelogd als', me.username);

async function sync(body: unknown, auth = true): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}/api/v1/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}`, 'X-Client-Id': 'smoke-1' } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

assert.equal((await sync({}, false)).status, 401);
console.log('zonder aanmelding: 401 ✓');

const run = Date.now().toString(36);
const P = `project-smoke-${run}`.slice(0, 40);
const T = `task-smoke-${run}`.slice(0, 40);
const first = await sync({
  sync_token: '*',
  commands: [
    { type: 'project_add', uuid: `smoke-${run}-0001`, args: { id: P, name: 'Rooktest' } },
    { type: 'task_add', uuid: `smoke-${run}-0002`, args: {
      id: T, project_id: P, content: 'Planten water geven', priority: 2,
      due: { date: '2026-11-13', string: 'elke vrijdag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [5] } } } },
  ],
});
assert.equal(first.status, 200);
assert.equal(first.json.sync_status[`smoke-${run}-0001`], 'ok');
assert.equal(first.json.sync_status[`smoke-${run}-0002`], 'ok');
console.log('aanmaken: token', first.json.sync_token);

const done = await sync({ sync_token: first.json.sync_token, commands: [{ type: 'task_complete', uuid: `smoke-${run}-0003`, args: { id: T } }] });
const t = done.json.tasks.find((x: any) => x.id === T);
assert.equal(t.checked, false);
assert.equal(t.due.date, '2026-11-20');
console.log('afvinken terugkerende taak: nieuwe datum', t.due.date, '| nog open:', !t.checked, '| keer voltooid:', t.completed_count);

const rev = done.json.sync_token;
const again = await sync({ sync_token: rev, commands: [{ type: 'task_complete', uuid: `smoke-${run}-0003`, args: { id: T } }] });
assert.equal(again.json.sync_status[`smoke-${run}-0003`], 'ok');
assert.equal(again.json.tasks.length, 0, 'herhaald commando verandert niets');
console.log('herhaald commando (zelfde uuid): idempotent ✓');

const bad = await sync({ sync_token: rev, commands: [{ type: 'task_add', uuid: `smoke-${run}-0004`, args: { project_id: P, content: 'x', priority: 9 } }] });
assert.equal(bad.json.sync_status[`smoke-${run}-0004`].error_code, 'INVALID_ARG');
console.log('ongeldig commando geweigerd ✓');

const del = await sync({ sync_token: rev, commands: [{ type: 'project_delete', uuid: `smoke-${run}-0005`, args: { id: P } }] });
assert.equal(del.json.sync_status[`smoke-${run}-0005`], 'ok');
const full = await sync({ sync_token: '*' });
assert.ok(!full.json.projects.some((p: any) => p.id === P) && !full.json.tasks.some((x: any) => x.id === T));
console.log('opgeruimd ✓');

await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
assert.equal((await sync({})).status, 401, 'na uitloggen werkt het token niet meer');
console.log('uitgelogd ✓\n\nROOKTEST GESLAAGD');
