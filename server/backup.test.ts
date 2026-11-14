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
import { createUser } from './users.ts';
import { backupTo } from './backup.ts';

function withDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'tickory-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const userOf = (db: DatabaseSync): string => (db.prepare('SELECT id FROM users').get() as { id: string }).id;

function seeded(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  createSchema(db);
  const user = createUser(db, { username: 'back-up', name: 'Back-up', passwordHash: 'x' });
  handleSync(db, {
    commands: [
      { type: 'project_add', uuid: 'backup-test-0001', args: { id: 'project-backup-01', name: 'Thuis' } },
      { type: 'task_add', uuid: 'backup-test-0002', args: { id: 'task-backup-0001', project_id: 'project-backup-01', content: 'Belangrijk' } },
    ],
  }, user.id);
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
  const res = handleSync(restored, { commands: [{ type: 'task_add', uuid: 'backup-test-0002', args: { project_id: 'project-backup-01', content: 'Dubbel?' } }] }, userOf(restored));
  assert.equal(res.sync_status['backup-test-0002'], 'ok');
  assert.equal((res.tasks as unknown[]).length, 1, 'het herhaalde uuid is herkend en niets is dubbel uitgevoerd');
  assert.equal((res.users as unknown[]).length, 1, 'ook de gebruikers staan in de kopie');
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

test('de bijlagen gaan mee: alleen bestanden van bijlagen die in de kopie staan, en terugzetten werkt met de controle bij het opstarten', async (t) => {
  const dir = withDir(t);
  const db = seeded(join(dir, 'todo.db'));
  const user = userOf(db);
  const { createAttachments } = await import('./attachments.ts');
  const { Readable } = await import('node:stream');
  const attachments = createAttachments(db, { dir: join(dir, 'attachments'), maxUploadBytes: 1000, quotaBytes: 100_000 });
  const put = async (id: string, text: string, link: boolean) => {
    const body = Buffer.from(text);
    const req = Object.assign(Readable.from([body]), { headers: { 'content-length': String(body.length), 'content-type': 'text/plain' } });
    Object.defineProperty(req, 'complete', { get: () => req.readableEnded });
    const up = await attachments.upload(req as never, user, { id, taskId: 'task-backup-0001' });
    if (link) {
      const res = handleSync(db, { commands: [{ type: 'attachment_add', uuid: `backup-${id}`, args: { id, task_id: 'task-backup-0001', name: `${id}.txt`, size: up.size, mime: up.mime, sha256: up.sha256 } }] }, user);
      assert.equal(res.sync_status[`backup-${id}`], 'ok');
    }
  };
  await put('bijlage-een-001', 'eerste bijlage', true);
  await put('bijlage-twee-002', 'tweede bijlage', true);
  await put('bijlage-wees-003', 'nog niet gekoppeld', false); // een upload zonder bijlage hoort niet in de back-up
  const del = handleSync(db, { commands: [{ type: 'attachment_delete', uuid: 'backup-del-0001', args: { id: 'bijlage-twee-002' } }] }, user);
  assert.equal(del.sync_status['backup-del-0001'], 'ok');
  attachments.purgeDeleted();

  const report = backupTo(join(dir, 'todo.db'), join(dir, 'kopie', 'todo-1.db'), join(dir, 'attachments'));
  assert.deepEqual(report, { files: 1, bytes: 'eerste bijlage'.length, missing: 0 });
  assert.equal(existsSync(join(dir, 'kopie', 'todo-1.attachments')), true);
  assert.throws(() => {
    // een bestaande map voor de bijlagen wordt nooit overschreven, ook niet als het .db-bestand nieuw is
    backupTo(join(dir, 'todo.db'), join(dir, 'kopie', 'todo-1.db'), join(dir, 'attachments'));
  }, /bestaat al/);

  // terugzetten: de kopie als database en de map als bijlagen; de controle bij het opstarten vindt alles in orde
  const restored = new DatabaseSync(join(dir, 'kopie', 'todo-1.db'));
  const again = createAttachments(restored, { dir: join(dir, 'kopie', 'todo-1.attachments'), maxUploadBytes: 1000, quotaBytes: 100_000 });
  assert.deepEqual(again.check(), { strayFiles: 0, rowsRemoved: 1, missing: 0 }, 'alleen de regel van de upload zonder bijlage (hoort niet in de back-up) wordt opgeruimd');
  restored.close();

  // een bestand dat tussen de twee stappen verdween, wordt overgeslagen en gemeld
  const key = (db.prepare("SELECT key FROM attachment_files WHERE id = 'bijlage-een-001'").get() as { key: string }).key;
  rmSync(join(dir, 'attachments', key.slice(0, 2), key));
  const second = backupTo(join(dir, 'todo.db'), join(dir, 'kopie', 'todo-3.db'), join(dir, 'attachments'));
  assert.deepEqual(second, { files: 0, bytes: 0, missing: 1 });
  db.close();
});

test('zonder map met bijlagen maakt de back-up alleen de database', (t) => {
  const dir = withDir(t);
  seeded(join(dir, 'todo.db')).close();
  const report = backupTo(join(dir, 'todo.db'), join(dir, 'a.db'), join(dir, 'bestaat-niet'));
  assert.deepEqual(report, { files: 0, bytes: 0, missing: 0 });
  assert.equal(existsSync(join(dir, 'a.attachments')), false);
});
