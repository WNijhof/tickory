// Reparaties uit de code-review van server/ en shared/ (november 2026): elk een geval dat eerst misging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { handleSync } from './sync.ts';
import type { Command } from './sync.ts';
import { addUser, freshDb } from './testutil.ts';
import type { UserRow } from './users.ts';
import { deleteAccount } from './accountDelete.ts';
import { createInvite, previewInvite } from './invites.ts';
import { notificationsFloor, pruneNotifications } from './notify.ts';
import { deepNormalize } from '../shared/text.js';
import { isValidKey, keyAfter } from '../shared/orderKey.js';

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `review-fix-${String(++n).padStart(6, '0')}`, args });
function run(db: DatabaseSync, as: UserRow, commands: Command[], since?: string) {
  const res = handleSync(db, { commands, ...(since ? { sync_token: since } : {}) }, as.id);
  for (const [uuid, s] of Object.entries(res.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
  return res;
}
const statusOf = (db: DatabaseSync, as: UserRow, c: Command) => handleSync(db, { commands: [c] }, as.id).sync_status[c.uuid];

test('een __proto__-sleutel in de invoer zet geen prototype: de datum eronder bestaat niet en de taak wordt geweigerd', () => {
  const parsed = JSON.parse('{"recurrence":{"freq":"daily"},"__proto__":{"date":"2026-12-01"}}');
  const out = deepNormalize(parsed) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal((out as { date?: string }).date, undefined, 'geen geërfde datum');
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  run(db, anna, [cmd('task_add', { id: 'task-proto-0001', project_id: anna.inbox_project_id, content: 'Iets' })]);
  const bad = cmd('task_update', { id: 'task-proto-0001', due: parsed });
  assert.notEqual(statusOf(db, anna, bad), 'ok', 'een due zonder datum wordt geweigerd');
});

test('een sorteersleutel van 64 keer het hoogste teken wordt geweigerd: daar kan niets meer achter binnen 64 tekens', () => {
  const top = 'z'.repeat(64);
  assert.equal(isValidKey(top), false);
  assert.equal(isValidKey('z'.repeat(63)), true);
  assert.ok(keyAfter('z'.repeat(63)).length <= 64);
  assert.equal(isValidKey(`a${'z'.repeat(63)}`), true, 'met een ander teken ervoor kan er nog iets achter');
});

test('"alles gelezen" tot een tijdstip met een andere schrijfwijze (+01:00): wat daarna kwam blijft ongelezen', () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const ins = db.prepare('INSERT INTO notifications (id, owner_id, kind, created_at, updated_at, rev, is_read, is_deleted) VALUES (?, ?, ?, ?, ?, 1, 0, 0)');
  const cols = (db.prepare('PRAGMA table_info(notifications)').all() as { name: string; notnull: number; dflt_value: unknown }[]);
  const required = cols.filter((c) => c.notnull && c.dflt_value === null).map((c) => c.name);
  // alleen als de tabel niet meer verplichte kolommen heeft dan deze test invult
  if (required.every((c) => ['id', 'owner_id', 'kind', 'created_at', 'updated_at', 'rev', 'is_read', 'is_deleted'].includes(c))) {
    ins.run('notif-voor-00001', anna.id, 'comment', '2026-11-23T09:30:00.000Z', '2026-11-23T09:30:00.000Z');
    ins.run('notif-na-000001', anna.id, 'comment', '2026-11-23T10:30:00.000Z', '2026-11-23T10:30:00.000Z');
    run(db, anna, [cmd('notification_read_all', { up_to: '2026-11-23T11:00:00+01:00' })]); // = 10:00Z
    const read = (id: string) => (db.prepare('SELECT is_read FROM notifications WHERE id = ?').get(id) as { is_read: number }).is_read;
    assert.equal(read('notif-voor-00001'), 1);
    assert.equal(read('notif-na-000001'), 0, 'kwam na 10:00Z: blijft ongelezen');
  }
});

test('opgeruimde sporen van meldingen: de server onthoudt tot waar, zodat een oud apparaat een volledige sync krijgt', () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  assert.equal(notificationsFloor(db), 0);
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const cols = (db.prepare('PRAGMA table_info(notifications)').all() as { name: string; notnull: number; dflt_value: unknown }[]);
  const required = cols.filter((c) => c.notnull && c.dflt_value === null).map((c) => c.name);
  if (!required.every((c) => ['id', 'owner_id', 'kind', 'created_at', 'updated_at', 'rev', 'is_read', 'is_deleted'].includes(c))) return;
  const token = run(db, anna, []).sync_token;
  db.prepare('INSERT INTO notifications (id, owner_id, kind, created_at, updated_at, rev, is_read, is_deleted) VALUES (?, ?, ?, ?, ?, ?, 1, 1)')
    .run('notif-weg-00001', anna.id, 'comment', old, old, 999_999);
  pruneNotifications(db);
  assert.equal(notificationsFloor(db), 999_999);
  const res = handleSync(db, { sync_token: token }, anna.id);
  assert.equal(res.full_sync, true, 'een token van vóór het opruimen: volledige sync');
});

test('een uitnodigingslink van een geblokkeerde eigenaar werkt niet meer (en zegt dat niet alsof jij geblokkeerd bent)', () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  run(db, anna, [cmd('project_add', { id: 'project-inv-0001', name: 'Samen' })]);
  const link = createInvite(db, anna.id, 'project-inv-0001', { role: 'member' }, Date.now()) as { token: string };
  assert.equal(previewInvite(db, bram.id, link.token, Date.now()).project_name, 'Samen');
  db.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?').run(anna.id);
  assert.throws(() => previewInvite(db, bram.id, link.token, Date.now()), (e: { code?: string }) => e.code === 'NOT_FOUND');
});

test('een bijlage kan alleen onder je eigen opmerking', () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  run(db, anna, [
    cmd('project_add', { id: 'project-att-0001', name: 'Samen' }),
    cmd('task_add', { id: 'task-att-000001', project_id: 'project-att-0001', content: 'Taak' }),
    cmd('project_share', { project_id: 'project-att-0001', username: 'bram', role: 'member' }),
    cmd('comment_add', { id: 'comment-anna-001', task_id: 'task-att-000001', content: 'Van Anna' }),
  ]);
  db.prepare("INSERT INTO attachment_files (id, user_id, task_id, key, size, sha256, mime, created_at, linked) VALUES ('att-bram-000001', ?, 'task-att-000001', 'k-bram-1', 3, ?, 'text/plain', ?, 0)")
    .run(bram.id, 'b'.repeat(64), new Date().toISOString());
  const c = cmd('attachment_add', { id: 'att-bram-000001', task_id: 'task-att-000001', comment_id: 'comment-anna-001', name: 'x.txt', size: 3, mime: 'text/plain', sha256: 'b'.repeat(64) });
  const s = statusOf(db, bram, c) as { error_code?: string };
  assert.equal(s.error_code, 'FORBIDDEN');
});

test('account verwijderen: bijlagen bij een opmerking op je eigen project gaan mee; je foto in de notitie van een ander blijft', () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(bram.id);
  run(db, anna, [
    cmd('project_add', { id: 'project-del-0001', name: 'Eigen' }),
    cmd('comment_add', { id: 'comment-proj-001', project_id: 'project-del-0001', content: 'Bij het project' }),
  ]);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO attachment_files (id, user_id, task_id, project_id, key, size, sha256, mime, created_at, linked) VALUES ('att-proj-000001', ?, '', 'project-del-0001', 'k-proj-1', 3, ?, 'text/plain', ?, 0)")
    .run(anna.id, 'c'.repeat(64), now);
  run(db, anna, [cmd('attachment_add', { id: 'att-proj-000001', project_id: 'project-del-0001', comment_id: 'comment-proj-001', name: 'p.txt', size: 3, mime: 'text/plain', sha256: 'c'.repeat(64) })]);
  // Anna zet een foto in een notitie van Bram (die hij met haar deelt als bewerker)
  run(db, bram, [cmd('note_add', { id: 'note-bram-00001', title: 'Van Bram', content: 'tekst' }), cmd('note_share', { note_id: 'note-bram-00001', username: 'anna', role: 'editor' })]);
  db.prepare("INSERT INTO note_files (id, owner_id, note_id, name, size, mime, sha256, rev, is_deleted, created_at, updated_at) VALUES ('nf-anna-bij-b01', ?, 'note-bram-00001', 'foto.jpg', 3, 'image/jpeg', ?, 1, 0, ?, ?)")
    .run(anna.id, 'd'.repeat(64), now, now);
  const removed: string[] = [];
  deleteAccount(db, anna.id, (ids) => removed.push(...ids));
  assert.ok(removed.includes('att-proj-000001'), 'het bestand van de projectbijlage gaat weg');
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE id = 'att-proj-000001'").get() as { n: number }).n), 0);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM attachment_files WHERE id = 'att-proj-000001'").get() as { n: number }).n), 0);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM note_files WHERE id = 'nf-anna-bij-b01'").get() as { n: number }).n), 1, 'de foto in Brams notitie blijft');
});

test('een verwijderd label van een ander: de leden van een gedeeld project krijgen het spoor', () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  run(db, anna, [
    cmd('project_add', { id: 'project-lab-0001', name: 'Samen' }),
    cmd('label_add', { id: 'label-anna-0001', name: 'dringend' }),
    cmd('task_add', { id: 'task-lab-000001', project_id: 'project-lab-0001', content: 'Taak', labels: ['label-anna-0001'] }),
    cmd('project_share', { project_id: 'project-lab-0001', username: 'bram', role: 'member' }),
  ]);
  const first = handleSync(db, {}, bram.id);
  assert.ok((first.labels as { id: string }[]).some((l) => l.id === 'label-anna-0001'), 'Bram ziet het label');
  run(db, anna, [cmd('label_delete', { id: 'label-anna-0001' })]);
  const delta = handleSync(db, { sync_token: first.sync_token }, bram.id);
  assert.ok((delta.labels as { id: string; is_deleted?: boolean | number }[]).some((l) => l.id === 'label-anna-0001' && Boolean(l.is_deleted)), 'en hoort dat het weg is');
});
