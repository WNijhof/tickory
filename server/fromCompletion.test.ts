import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstUser, mkdb } from './testutil.ts';
import { handleSync } from './sync.ts';
import type { Command } from './sync.ts';

type Row = Record<string, any>;

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `fc-${String(++n).padStart(6, '0')}`, args });
const run = (db: ReturnType<typeof mkdb>, commands: Command[]) => handleSync(db, { sync_token: '*', commands }, firstUser(db).id);
const status = (res: any, c: Command) => res.sync_status[c.uuid];
const task = (db: ReturnType<typeof mkdb>, id: string): Row => (run(db, []).tasks as Row[]).find((t) => t.id === id)!;

function setup(rec: Record<string, unknown>, date = '2026-11-10T09:30') {
  const db = mkdb();
  const add = cmd('task_add', { id: 'fromdone-aaaa1', project_id: 'inbox-project', content: 'Planten water geven', due: { date, recurrence: rec } });
  assert.equal(status(run(db, [add]), add), 'ok');
  return db;
}
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d: string, days: number) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

test('"elke!": de volgende datum telt vanaf de afvinkdag die de afzender meegeeft, het tijdstip blijft', () => {
  const db = setup({ freq: 'daily', interval: 3, fromCompletion: true });
  const c = cmd('task_complete', { id: 'fromdone-aaaa1', if_due: '2026-11-10T09:30', completed_on: '2026-11-20' });
  assert.equal(status(run(db, [c]), c), 'ok');
  const t = task(db, 'fromdone-aaaa1');
  assert.equal(t.due.date, '2026-11-23T09:30');
  assert.equal(t.due.recurrence.fromCompletion, true, 'de regel blijft bewaard');
  assert.equal(t.completed_count, 1);
  assert.equal(t.checked, false);
});

test('een gewone herhaling negeert completed_on', () => {
  const db = setup({ freq: 'daily', interval: 3 });
  const c = cmd('task_complete', { id: 'fromdone-aaaa1', completed_on: '2026-11-20' });
  assert.equal(status(run(db, [c]), c), 'ok');
  assert.equal(task(db, 'fromdone-aaaa1').due.date, '2026-11-13T09:30');
});

test('zonder completed_on (widget of melding van de Android-app) telt vandaag in de tijdzone van de gebruiker', () => {
  const db = setup({ freq: 'daily', interval: 3, fromCompletion: true }, '2020-01-01');
  const c = cmd('task_complete', { id: 'fromdone-aaaa1' });
  assert.equal(status(run(db, [c]), c), 'ok');
  const got = task(db, 'fromdone-aaaa1').due.date;
  // vandaag in UTC of een dag ernaast (afhankelijk van de tijdzone van de gebruiker) plus drie dagen
  assert.ok([plusDays(today(), 2), plusDays(today(), 3), plusDays(today(), 4)].includes(got), got);
  // met een ingestelde tijdzone telt de dag daar
  const db2 = setup({ freq: 'daily', fromCompletion: true }, '2020-01-01');
  const s = cmd('settings_update', { id: `settings-${firstUser(db2).id}`, timezone: 'Pacific/Kiritimati' });
  assert.equal(status(run(db2, [s]), s), 'ok');
  const c2 = cmd('task_complete', { id: 'fromdone-aaaa1' });
  assert.equal(status(run(db2, [c2]), c2), 'ok');
  const zoneToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Pacific/Kiritimati' }).format(new Date());
  assert.equal(task(db2, 'fromdone-aaaa1').due.date, plusDays(zoneToday, 1));
});

test('een ongeldige completed_on wordt geweigerd', () => {
  const db = setup({ freq: 'daily', fromCompletion: true });
  for (const bad of ['morgen', '2026-02-30', '2026-11-20T10:00', 20261120, null]) {
    const c = cmd('task_complete', { id: 'fromdone-aaaa1', completed_on: bad });
    const s = status(run(db, [c]), c);
    assert.ok(typeof s === 'object' && s.error_code === 'INVALID_ARG', JSON.stringify([bad, s]));
  }
  assert.equal(task(db, 'fromdone-aaaa1').due.date, '2026-11-10T09:30', 'niets is veranderd');
});

test('fromCompletion: alleen true is een geldige regel; false en andere waarden worden geweigerd', () => {
  const db = mkdb();
  for (const bad of [false, 1, 'ja']) {
    const c = cmd('task_add', { id: `bad-${String(n)}-aaaa`, project_id: 'inbox-project', content: 'x', due: { date: '2026-11-10', recurrence: { freq: 'daily', fromCompletion: bad } } });
    const s = status(run(db, [c]), c);
    assert.ok(typeof s === 'object' && s.error_code === 'INVALID_ARG', JSON.stringify([bad, s]));
  }
});
