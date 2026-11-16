// Automatische back-ups (autoBackup.ts): één kopie per dag na het ingestelde tijdstip, inhalen na een stilstand, en opruimen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { autoBackupConfig, createAutoBackup } from './autoBackup.ts';
import { createSchema } from './schema.ts';
import { createUser } from './users.ts';
import { handleSync } from './sync.ts';

function withDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'tickory-auto-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows houdt soms nog iets vast */ } });
  return dir;
}

/** Een database met één taak, open zoals bij een draaiende server. */
function live(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  createSchema(db);
  const user = createUser(db, { username: 'auto', name: 'Auto', passwordHash: 'x' });
  handleSync(db, { commands: [{ type: 'task_add', uuid: 'auto-backup-0001', args: { project_id: user.inbox_project_id, content: 'Belangrijk' } }] }, user.id);
  return db;
}

/** Een moment in Amsterdam: at('2026-11-17T03:05'). */
const at = (local: string): number => {
  // november: UTC+1
  return Date.parse(`${local}:00+01:00`);
};

test('instellingen: uit zonder BACKUP_DIR; standaard 03:00 en 14 dagen; onzin geeft een duidelijke fout', () => {
  assert.equal(autoBackupConfig({}), null);
  assert.equal(autoBackupConfig({ BACKUP_DIR: '  ' }), null);
  const c = autoBackupConfig({ BACKUP_DIR: '/data/backups' })!;
  assert.deepEqual([c.time, c.keep, c.timeZone], ['03:00', 14, null]);
  assert.deepEqual([autoBackupConfig({ BACKUP_DIR: 'x', BACKUP_TIME: '23:30', BACKUP_KEEP: '7', DEFAULT_TIMEZONE: 'Europe/Amsterdam' })!.time, autoBackupConfig({ BACKUP_DIR: 'x', BACKUP_KEEP: '7' })!.keep], ['23:30', 7]);
  for (const env of [{ BACKUP_TIME: '3:00' }, { BACKUP_TIME: '24:00' }, { BACKUP_TIME: 'nacht' }, { BACKUP_KEEP: '0' }, { BACKUP_KEEP: '-1' }, { BACKUP_KEEP: 'veel' }, { BACKUP_KEEP: '3651' }, { DEFAULT_TIMEZONE: 'Mars/Olympus' }]) {
    assert.throws(() => autoBackupConfig({ BACKUP_DIR: 'x', ...env }), JSON.stringify(env));
  }
});

test('één kopie per dag, pas na het tijdstip; stond de server uit, dan alsnog bij de eerste ronde daarna', (t) => {
  const dir = withDir(t);
  const db = live(join(dir, 'todo.db'));
  t.after(() => db.close());
  let now = at('2026-11-17T02:59');
  const lines: string[] = [];
  const auto = createAutoBackup({ dir: join(dir, 'backups'), time: '03:00', keep: 14, timeZone: 'Europe/Amsterdam' }, { dbPath: join(dir, 'todo.db'), attachmentsDir: null, now: () => now, log: (l) => lines.push(l) });
  assert.equal(auto.tick(), null, 'nog niet');
  assert.equal(existsSync(join(dir, 'backups')), false);
  now = at('2026-11-17T03:00');
  assert.equal(auto.tick(), 'todo-2026-11-17.db');
  assert.equal(auto.tick(), null, 'niet twee keer op een dag');
  now = at('2026-11-17T23:59');
  assert.equal(auto.tick(), null);
  // de kopie is een echte, leesbare database met de taak erin
  const copy = new DatabaseSync(join(dir, 'backups', 'todo-2026-11-17.db'), { readOnly: true });
  assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM tasks WHERE content = 'Belangrijk'").get() as { n: number }).n, 1);
  copy.close();
  // de server stond twee dagen uit en start om 14:12: de kopie van vandaag komt er meteen
  now = at('2026-11-20T14:12');
  assert.equal(auto.tick(), 'todo-2026-11-20.db');
  assert.deepEqual(readdirSync(join(dir, 'backups')).sort(), ['todo-2026-11-17.db', 'todo-2026-11-20.db']);
  assert.ok(lines.some((l) => l.includes('todo-2026-11-20.db gemaakt')));
  const s = auto.status();
  assert.equal(s.enabled, true);
  assert.equal(s.last?.name, 'todo-2026-11-20.db');
  assert.equal(s.error, null);
});

test('opruimen: alleen de eigen kopieën (met hun bijlagen), de nieuwste blijven; wat je er zelf neerzet blijft staan', (t) => {
  const dir = withDir(t);
  const db = live(join(dir, 'todo.db'));
  t.after(() => db.close());
  const backups = join(dir, 'backups');
  mkdirSync(backups);
  for (const day of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) {
    writeFileSync(join(backups, `todo-${day}.db`), 'oud');
    mkdirSync(join(backups, `todo-${day}.attachments`));
  }
  mkdirSync(join(backups, 'todo-2026-11-01.attachments')); // een losse map van lang geleden
  writeFileSync(join(backups, 'mijn-eigen-kopie.db'), 'van mij');
  writeFileSync(join(backups, 'todo-2026-11-09.db.bak'), 'van mij');
  const attachments = join(dir, 'attachments');
  mkdirSync(attachments);
  let now = at('2026-11-14T03:30');
  const auto = createAutoBackup({ dir: backups, time: '03:00', keep: 3, timeZone: 'Europe/Amsterdam' }, { dbPath: join(dir, 'todo.db'), attachmentsDir: attachments, now: () => now, log: () => {} });
  assert.equal(auto.tick(), 'todo-2026-11-14.db');
  assert.deepEqual(readdirSync(backups).sort(), [
    'mijn-eigen-kopie.db', 'todo-2026-11-09.db.bak',
    'todo-2026-11-12.attachments', 'todo-2026-11-12.db', 'todo-2026-11-13.attachments', 'todo-2026-11-13.db', 'todo-2026-11-14.attachments', 'todo-2026-11-14.db',
  ]);
});

test('een mislukte poging: geen halve kopie, de fout in de status, en de volgende ronde probeert het opnieuw', (t) => {
  const dir = withDir(t);
  let now = at('2026-11-17T04:00');
  const backups = join(dir, 'backups');
  const auto = createAutoBackup({ dir: backups, time: '03:00', keep: 14, timeZone: 'Europe/Amsterdam' }, { dbPath: join(dir, 'bestaat-niet.db'), attachmentsDir: null, now: () => now, log: () => {} });
  assert.equal(auto.tick(), null);
  assert.ok(auto.status().error?.message, 'de fout staat in de status');
  assert.deepEqual(readdirSync(backups), [], 'geen halve kopie');
  // de database is er weer: de volgende ronde lukt het
  const db = live(join(dir, 'bestaat-niet.db'));
  t.after(() => db.close());
  now = at('2026-11-17T04:05');
  assert.equal(auto.tick(), 'todo-2026-11-17.db');
  assert.equal(auto.status().error, null);
});
