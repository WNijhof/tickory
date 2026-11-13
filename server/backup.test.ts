import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createSchema } from './schema.ts';
import { handleSync } from './sync.ts';
import { backupTo } from './backup.ts';

function withDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'eigen-tool-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seeded(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  createSchema(db);
  handleSync(db, {
    commands: [
      { type: 'project_add', uuid: 'backup-test-0001', args: { id: 'project-backup-01', name: 'Thuis' } },
      { type: 'task_add', uuid: 'backup-test-0002', args: { id: 'task-backup-0001', project_id: 'project-backup-01', content: 'Belangrijk' } },
    ],
  });
  return db;
}

test('de kopie bevat alle gegevens, ook die nog in het WAL-bestand staan terwijl de server doorloopt', (t) => {
  const dir = withDir(t);
  const db = seeded(join(dir, 'todo.db')); // verbinding blijft open: net als een draaiende server
  backupTo(join(dir, 'todo.db'), join(dir, 'kopie', 'todo-1.db')); // submap wordt aangemaakt

  const copy = new DatabaseSync(join(dir, 'kopie', 'todo-1.db'), { readOnly: true });
  const names = (copy.prepare('SELECT content FROM tasks').all() as { content: string }[]).map((r) => r.content);
  assert.deepEqual(names, ['Belangrijk']);
  assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  copy.close();

  // de kopie is een zelfstandige database: de server kan ermee starten en kent de opdracht van vóór de back-up nog
  const restored = new DatabaseSync(join(dir, 'kopie', 'todo-1.db'));
  const res = handleSync(restored, { commands: [{ type: 'task_add', uuid: 'backup-test-0002', args: { project_id: 'project-backup-01', content: 'Dubbel?' } }] });
  assert.equal(res.sync_status['backup-test-0002'], 'ok');
  assert.equal((res.tasks as unknown[]).length, 1, 'het herhaalde uuid is herkend en niets is dubbel uitgevoerd');
  restored.close();
  db.close();
});

test('een bestaand doelbestand wordt nooit overschreven en ontbrekende bronnen geven een duidelijke fout', (t) => {
  const dir = withDir(t);
  seeded(join(dir, 'todo.db')).close();
  backupTo(join(dir, 'todo.db'), join(dir, 'a.db'));
  assert.throws(() => backupTo(join(dir, 'todo.db'), join(dir, 'a.db')), /bestaat al/);
  assert.throws(() => backupTo(join(dir, 'bestaat-niet.db'), join(dir, 'b.db')), /niet gevonden/);
  assert.throws(() => backupTo(join(dir, 'todo.db'), join(dir, 'c.txt')), /\.db/);
  assert.equal(existsSync(join(dir, 'b.db')), false);
  assert.equal(existsSync(join(dir, 'c.txt')), false);
});

test('een pad met een enkele aanhalingsteken of spatie werkt (het pad wordt als parameter doorgegeven, niet in SQL geplakt)', (t) => {
  const dir = withDir(t);
  seeded(join(dir, 'todo.db')).close();
  const dest = join(dir, "mijn map", "o'brien; DROP TABLE tasks.db");
  backupTo(join(dir, 'todo.db'), dest);
  const copy = new DatabaseSync(dest, { readOnly: true });
  assert.equal((copy.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 1);
  copy.close();
});

test('als opdrachtregel: maakt een kopie en meldt een fout met een afsluitcode', (t) => {
  const dir = withDir(t);
  seeded(join(dir, 'todo.db')).close();
  const env = { ...process.env, DB_PATH: join(dir, 'todo.db') };
  const script = fileURLToPath(new URL('./backup.ts', import.meta.url));
  const out = execFileSync(process.execPath, [script, join(dir, 'x.db')], { env, encoding: 'utf8' });
  assert.match(out, /Back-up gemaakt/);
  assert.equal(existsSync(join(dir, 'x.db')), true);
  assert.throws(() => execFileSync(process.execPath, [script, join(dir, 'x.db')], { env, encoding: 'utf8', stdio: 'pipe' }), (e: any) => e.status === 1 && /bestaat al/.test(String(e.stderr)));
  assert.throws(() => execFileSync(process.execPath, [script], { env, encoding: 'utf8', stdio: 'pipe' }), (e: any) => e.status === 2);
});
