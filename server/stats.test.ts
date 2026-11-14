// Het productiviteitsoverzicht (stats.ts, SPEC.md hoofdstuk 5g): alleen je eigen afvinkingen, uit projecten die je nu ziet, per
// dag in je tijdzone; de doelen in de instellingen; en het eindpunt over HTTP (wie het mag lezen, en wat het weigert).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { addUser, freshDb } from './testutil.ts';
import { createSession } from './users.ts';
import type { UserRow } from './users.ts';
import { createApp } from './main.ts';
import { createSchema } from './schema.ts';
import { myStats } from './stats.ts';
import { goalsOf } from '../shared/stats.js';

type Row = Record<string, any>;
let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `stat-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[]): SyncResponse => {
  const res = handleSync(db, { commands }, as.id);
  for (const c of commands) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`);
  return res;
};
const P = 'project-stat-001', Q = 'project-stat-002', R = 'project-stat-003';
const task = (i: number) => `task-stat-${String(i).padStart(5, '0')}`;

/** Anna en Bram delen Verbouwing (P); Anna heeft ook Tuin (Q, alleen van haar); Bram heeft Werk (R) waar Anna lezer is. */
function world() {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  run(db, anna, [cmd('project_add', { id: P, name: 'Verbouwing' }), cmd('project_share', { project_id: P, username: 'bram' }), cmd('project_add', { id: Q, name: 'Tuin' })]);
  run(db, bram, [cmd('project_add', { id: R, name: 'Werk' }), cmd('project_share', { project_id: R, username: 'anna', role: 'viewer' })]);
  return { db, anna, bram };
}
/** Alle regels van het logboek krijgen dit tijdstip (de tests rekenen met een vaste "nu"). */
const stamp = (db: DatabaseSync, iso: string) => db.prepare('UPDATE activity SET at = ?').run(iso);
const NOW = Date.parse('2026-11-14T12:00:00Z');
const totals = (s: ReturnType<typeof myStats>) => Object.fromEntries(s.per_day.map((d) => [d.date, d.count]));
const byProject = (s: ReturnType<typeof myStats>) => {
  const out: Record<string, number> = {};
  for (const d of s.per_day) for (const [p, c] of Object.entries(d.projects)) out[p] = (out[p] ?? 0) + c;
  return out;
};

test('alleen je eigen afvinkingen tellen: ook elke keer van een terugkerende taak, en je Inbox; die van een ander niet', () => {
  const { db, anna, bram } = world();
  run(db, anna, [
    cmd('task_add', { id: task(1), project_id: P, content: 'Tegels kiezen' }),
    cmd('task_add', { id: task(2), project_id: anna.inbox_project_id, content: 'Bellen' }),
    cmd('task_add', { id: task(3), project_id: Q, content: 'Gras maaien', due: { date: '2026-11-10', recurrence: { freq: 'weekly' } } }),
    cmd('task_add', { id: task(4), project_id: P, content: 'Kast' }), cmd('task_add', { id: task(5), project_id: P, parent_id: task(4), content: 'Planken' }),
    cmd('task_complete', { id: task(1) }), cmd('task_complete', { id: task(2) }),
    cmd('task_complete', { id: task(3) }), cmd('task_complete', { id: task(3) }), cmd('task_complete', { id: task(3) }), // drie keer doorgeschoven
    cmd('task_complete', { id: task(1) }), // al afgevinkt: niets
    cmd('task_complete', { id: task(4) }), // de subtaak gaat mee, maar telt niet apart (zoals in Voltooid)
  ]);
  run(db, bram, [
    cmd('task_add', { id: task(6), project_id: P, content: 'Verf' }), cmd('task_complete', { id: task(6) }),
    cmd('task_add', { id: task(7), project_id: bram.inbox_project_id, content: 'Van Bram' }), cmd('task_complete', { id: task(7) }),
  ]);
  stamp(db, '2026-11-14T09:00:00Z');
  const a = myStats(db, anna.id, { tz: 'Europe/Amsterdam' }, NOW);
  assert.deepEqual(totals(a), { '2026-11-14': 6 });
  assert.deepEqual(byProject(a), { [P]: 2, [anna.inbox_project_id]: 1, [Q]: 3 }, 'per project alleen wat jij afvinkte');
  assert.deepEqual(byProject(myStats(db, bram.id, { tz: 'Europe/Amsterdam' }, NOW)), { [P]: 1, [bram.inbox_project_id]: 1 }, 'Bram ziet alleen het zijne');
  assert.equal(a.tz, 'Europe/Amsterdam');
  assert.equal(a.today, '2026-11-14');
  assert.equal(a.from, '2026-05-19');
  assert.equal(a.days, 180);
  assert.equal(a.retention_days, 180);
});

test('heropenen door jezelf schrapt je afvinking; door een ander niet; een geweigerde afvinking (lezer) telt niet', () => {
  const { db, anna, bram } = world();
  run(db, bram, [cmd('task_add', { id: task(10), project_id: R, content: 'Rapport' })]);
  assert.equal(handleSync(db, { commands: [cmd('task_complete', { id: task(10) })] }, anna.id).sync_status[`stat-${String(n).padStart(8, '0')}`].error_code, 'FORBIDDEN');
  run(db, anna, [
    cmd('task_add', { id: task(11), project_id: P, content: 'Per ongeluk' }), cmd('task_complete', { id: task(11) }), cmd('task_uncomplete', { id: task(11) }),
    cmd('task_add', { id: task(12), project_id: P, content: 'Echt klaar' }), cmd('task_complete', { id: task(12) }),
  ]);
  run(db, bram, [cmd('task_uncomplete', { id: task(12) })]); // Bram heropent Anna's taak: haar werk blijft geteld
  run(db, bram, [cmd('task_complete', { id: task(10) })]);
  stamp(db, '2026-11-14T09:00:00Z');
  assert.deepEqual(totals(myStats(db, anna.id, { tz: 'UTC' }, NOW)), { '2026-11-14': 1 });
  assert.deepEqual(totals(myStats(db, bram.id, { tz: 'UTC' }, NOW)), { '2026-11-14': 1 }, 'Brams heropening telt niet als afvinking van Bram');
});

test('alleen projecten die je nu ziet: na vertrekken, eruit gehaald worden of verwijderen telt het niet meer; na verhuizen wel', () => {
  const { db, anna, bram } = world();
  run(db, anna, [
    cmd('task_add', { id: task(20), project_id: P, content: 'In Verbouwing' }), cmd('task_complete', { id: task(20) }),
    cmd('task_add', { id: task(21), project_id: Q, content: 'In Tuin' }), cmd('task_complete', { id: task(21) }),
    cmd('task_add', { id: task(22), project_id: Q, content: 'Verhuist' }), cmd('task_complete', { id: task(22) }), cmd('task_uncomplete', { id: task(22) }),
    cmd('task_complete', { id: task(22) }), cmd('task_move', { id: task(22), project_id: anna.inbox_project_id }),
  ]);
  stamp(db, '2026-11-14T09:00:00Z');
  assert.deepEqual(byProject(myStats(db, anna.id, { tz: 'UTC' }, NOW)), { [P]: 1, [Q]: 2 }, 'een afvinking blijft bij het project waar ze gebeurde');
  run(db, anna, [cmd('project_unshare', { project_id: P, user_id: bram.id })]);
  assert.deepEqual(byProject(myStats(db, bram.id, { tz: 'UTC' }, NOW)), {}, 'Bram is eruit gehaald');
  run(db, anna, [cmd('project_delete', { id: Q })]);
  assert.deepEqual(byProject(myStats(db, anna.id, { tz: 'UTC' }, NOW)), { [P]: 1 }, 'het logboek van een verwijderd project is weg');
  run(db, bram, [cmd('task_add', { id: task(23), project_id: R, content: 'Werk' }), cmd('task_complete', { id: task(23) })]);
  stamp(db, '2026-11-14T09:00:00Z');
  run(db, bram, [cmd('member_update', { project_id: R, user_id: anna.id, role: 'member' })]); // kan nu bewerken: Brams werk telt niet voor Anna
  assert.deepEqual(byProject(myStats(db, anna.id, { tz: 'UTC' }, NOW)), { [P]: 1 });
  run(db, anna, [cmd('task_add', { id: task(24), project_id: R, content: 'Ook werk' }), cmd('task_complete', { id: task(24) })]);
  stamp(db, '2026-11-14T09:00:00Z');
  assert.deepEqual(byProject(myStats(db, anna.id, { tz: 'UTC' }, NOW)), { [P]: 1, [R]: 1 });
  run(db, anna, [cmd('project_leave', { project_id: R })]);
  assert.deepEqual(byProject(myStats(db, anna.id, { tz: 'UTC' }, NOW)), { [P]: 1 }, 'na vertrekken telt het niet meer');
});

test('dagen in de gevraagde tijdzone, anders die uit de instellingen, anders UTC; het venster is `days` dagen tot en met vandaag', () => {
  const { db, anna } = world();
  const at = ['2026-11-13T22:30:00Z', '2026-11-13T23:30:00Z', '2026-11-08T23:30:00Z', '2026-11-07T23:30:00Z', '2026-05-18T12:00:00Z', '2026-11-14T20:00:00Z'];
  run(db, anna, at.map((_, i) => cmd('task_add', { id: task(30 + i), project_id: Q, content: `Taak ${i}` })));
  run(db, anna, at.map((_, i) => cmd('task_complete', { id: task(30 + i) })));
  for (const [i, iso] of at.entries()) db.prepare("UPDATE activity SET at = ? WHERE task_id = ? AND kind = 'task_completed'").run(iso, task(30 + i));
  // Amsterdam (+1): 13 nov 23:30, 14 nov 00:30, 9 nov 00:30, 8 nov 00:30 en 14 nov 21:00 (na "nu", een klok die voorloopt: nog vandaag)
  assert.deepEqual(totals(myStats(db, anna.id, { tz: 'Europe/Amsterdam', days: '7' }, NOW)), { '2026-11-08': 1, '2026-11-09': 1, '2026-11-13': 1, '2026-11-14': 2 }, 'een week: 8 tot en met 14 november');
  assert.deepEqual(totals(myStats(db, anna.id, { tz: 'Europe/Amsterdam', days: '6' }, NOW)), { '2026-11-09': 1, '2026-11-13': 1, '2026-11-14': 2 });
  assert.deepEqual(totals(myStats(db, anna.id, { tz: 'Europe/Amsterdam', days: '1' }, NOW)), { '2026-11-14': 2 });
  assert.deepEqual(totals(myStats(db, anna.id, { tz: 'UTC', days: '7' }, NOW)), { '2026-11-08': 1, '2026-11-13': 2, '2026-11-14': 1 });
  // Tokio (+9): 14 nov 07:30 en 08:30, 9 nov, 8 nov; 14 nov 20:00 UTC is daar al morgen en telt (nog) niet
  assert.deepEqual(totals(myStats(db, anna.id, { tz: 'Asia/Tokyo', days: '7' }, NOW)), { '2026-11-08': 1, '2026-11-09': 1, '2026-11-14': 2 });
  const half = myStats(db, anna.id, { tz: 'UTC' }, NOW);
  assert.equal(half.from, '2026-05-19');
  assert.equal(totals(half)['2026-05-18'], undefined, 'ouder dan 180 dagen telt niet, ook als het logboek nog niet is opgeruimd');
  // zonder tz: settings.timezone, en zonder (of met een onbekende) UTC
  assert.equal(myStats(db, anna.id, {}, NOW).tz, 'UTC');
  run(db, anna, [cmd('settings_update', { id: `settings-${anna.id}`, timezone: 'America/New_York' })]);
  assert.equal(myStats(db, anna.id, {}, NOW).tz, 'America/New_York');
  assert.equal(myStats(db, anna.id, { tz: 'Asia/Tokyo' }, NOW).tz, 'Asia/Tokyo', 'de gevraagde tijdzone gaat voor');
  db.prepare("UPDATE user_settings SET timezone = 'Verdwenen/Zone' WHERE owner_id = ?").run(anna.id); // een zone die een nieuwere Intl niet meer kent
  assert.equal(myStats(db, anna.id, {}, NOW).tz, 'UTC');
  assert.throws(() => myStats(db, anna.id, { days: '181' }, NOW), (e: any) => e.code === 'INVALID_ARG');
  assert.throws(() => myStats(db, anna.id, { tz: 'Mars/Olympus' }, NOW), (e: any) => e.code === 'INVALID_ARG');
});

test('instellingen: dag- en weekdoel en vrije dagen, met grenzen; null is de standaard, ook voor een database van vóór deze velden', () => {
  const { db, anna } = world();
  const id = `settings-${anna.id}`;
  const settings = () => (handleSync(db, { sync_token: '*', resource_types: ['settings'] }, anna.id).settings as Row[])[0];
  assert.deepEqual([settings().goal_daily, settings().goal_weekly, settings().days_off], [null, null, null]);
  assert.deepEqual(goalsOf(settings()), { daily: 5, weekly: 25, daysOff: [6, 7] });
  run(db, anna, [cmd('settings_update', { id, goal_daily: 8, goal_weekly: 0, days_off: [7, 3] })]);
  assert.deepEqual([settings().goal_daily, settings().goal_weekly, settings().days_off], [8, 0, [7, 3]]);
  const status = (args: Record<string, unknown>) => {
    const c = cmd('settings_update', { id, ...args });
    const s = handleSync(db, { commands: [c] }, anna.id).sync_status[c.uuid];
    return s === 'ok' ? 'ok' : (s as Row).error_code;
  };
  assert.equal(status({ goal_daily: 101 }), 'INVALID_ARG');
  assert.equal(status({ goal_daily: -1 }), 'INVALID_ARG');
  assert.equal(status({ goal_weekly: 701 }), 'INVALID_ARG');
  assert.equal(status({ goal_weekly: 2.5 }), 'INVALID_ARG');
  assert.equal(status({ days_off: [1, 2, 3, 4, 5, 6, 7] }), 'INVALID_ARG');
  assert.equal(status({ days_off: [0] }), 'INVALID_ARG');
  assert.equal(status({ days_off: [6, 6] }), 'INVALID_ARG');
  assert.deepEqual([settings().goal_daily, settings().goal_weekly, settings().days_off], [8, 0, [7, 3]], 'een geweigerde wijziging laat niets achter');
  assert.equal(status({ goal_daily: null, goal_weekly: null, days_off: null }), 'ok');
  assert.deepEqual(goalsOf(settings()), { daily: 5, weekly: 25, daysOff: [6, 7] }, 'null zet de standaard terug');
  // een database van vóór deze velden: createSchema voegt de kolommen toe, de bestaande rij heeft dan de standaard
  for (const c of ['goal_daily', 'goal_weekly', 'days_off']) db.exec(`ALTER TABLE user_settings DROP COLUMN ${c}`);
  createSchema(db);
  assert.deepEqual(goalsOf(settings()), { daily: 5, weekly: 25, daysOff: [6, 7] });
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'activity_actor'").get(), 'een index voor de eigen afvinkingen');
});

test('HTTP: GET /api/v1/stats alleen aangemeld en alleen voor jezelf; days en tz worden gecontroleerd', async () => {
  const { db, anna, bram } = world();
  run(db, anna, [cmd('task_add', { id: task(40), project_id: P, content: 'Klaar' }), cmd('task_complete', { id: task(40) })]);
  const app = createApp({ db });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const token = (u: UserRow) => createSession(db, u.id, 'test').token;
  const get = async (path: string, u: UserRow | null, method = 'GET') => {
    const res = await fetch(`${base}${path}`, { method, headers: u ? { Authorization: `Bearer ${token(u)}` } : {} });
    return { status: res.status, body: (await res.json()) as Row };
  };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const mine = await get('/api/v1/stats?days=7&tz=UTC', anna);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.per_day, [{ date: today, count: 1, projects: { [P]: 1 } }]);
    assert.equal(mine.body.days, 7);
    assert.deepEqual((await get('/api/v1/stats?tz=UTC', bram)).body.per_day, [], 'Bram ziet het project, maar niet wat Anna deed');
    assert.equal((await get('/api/v1/stats', anna)).body.days, 180, 'standaard zo ver als het logboek gaat');
    assert.equal((await get('/api/v1/stats', null)).status, 401);
    const bad = await get('/api/v1/stats?days=0', anna);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error_code, 'INVALID_ARG');
    assert.equal((await get('/api/v1/stats?tz=Nergens%2FLand', anna)).body.error_code, 'INVALID_ARG');
    assert.equal((await get('/api/v1/stats', anna, 'POST')).status, 405);
    assert.equal((await get('/api/v1/stats/extra', anna)).status, 404);
    assert.equal((await get(`/api/v1/stats?user=${bram.id}&tz=UTC`, anna)).body.per_day.length, 1, 'een andere gebruiker vragen kan niet: het blijft je eigen overzicht');
  } finally {
    await app.close();
  }
});
