// Bijlagen in de sync: wie ze te zien krijgt, wat een nieuw lid erbij krijgt, en wie een signaal krijgt. De gegevens van een bijlage
// volgen dezelfde regels als de opmerkingen bij een taak (zie access.test.ts); hier de uitkomsten die voor bijlagen gelden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { audienceSince, currentRev, handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { addUser, freshDb } from './testutil.ts';
import type { UserRow } from './users.ts';

type Row = Record<string, any>;
let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `vis-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[], token = '*'): SyncResponse => handleSync(db, { sync_token: token, commands }, as.id);
const sha = 'b'.repeat(64);
/** Een geüploade bestand zonder echte inhoud (alleen de regel in de database): genoeg voor de regels van de sync. */
function fakeUpload(db: DatabaseSync, user: UserRow, id: string, task: string): void {
  db.prepare('INSERT INTO attachment_files (id, user_id, task_id, size, sha256, mime, key, linked, created_at) VALUES (?, ?, ?, 5, ?, ?, ?, 0, ?)')
    .run(id, user.id, task, sha, 'text/plain', `${id}-sleutel`.padEnd(32, '0'), new Date().toISOString());
}
const attach = (db: DatabaseSync, as: UserRow, id: string, task: string): Command => {
  fakeUpload(db, as, id, task);
  const c = cmd('attachment_add', { id, task_id: task, name: `${id}.txt`, size: 5, mime: 'text/plain', sha256: sha });
  assert.equal(run(db, as, [c]).sync_status[c.uuid], 'ok');
  return c;
};

function world() {
  const db = freshDb();
  const alice = addUser(db, 'alice');
  const bob = addUser(db, 'bob');
  const carol = addUser(db, 'carol');
  const setup = [cmd('project_add', { id: 'project-alice-01', name: 'Gezin' }), cmd('task_add', { id: 'task-alice-0001', project_id: 'project-alice-01', content: 'Boodschappen' })];
  run(db, alice, setup);
  return { db, alice, bob, carol };
}

test('wie geen lid is, krijgt de bijlagen van een project nooit, ook niet als verwijderde rij', () => {
  const { db, alice, bob } = world();
  const start = run(db, alice, []).sync_token;
  attach(db, alice, 'bijlage-een-001', 'task-alice-0001');
  attach(db, alice, 'bijlage-twee-002', 'task-alice-0001');
  const del = cmd('attachment_delete', { id: 'bijlage-twee-002' });
  assert.equal(run(db, alice, [del]).sync_status[del.uuid], 'ok');
  assert.deepEqual((run(db, bob, []).attachments as Row[]), [], 'volledige sync');
  assert.deepEqual((run(db, bob, [], '0').attachments as Row[]), [], 'delta vanaf het begin');
  assert.deepEqual((run(db, alice, []).attachments as Row[]).map((a) => a.id), ['bijlage-een-001']);
  assert.deepEqual((run(db, alice, [], start).attachments as Row[]).map((a) => [a.id, a.is_deleted === true]).sort(), [['bijlage-een-001', false], ['bijlage-twee-002', true]]);
});

test('een nieuw lid krijgt alle bijlagen van het project, ook die ouder zijn dan zijn token', () => {
  const { db, alice, bob } = world();
  attach(db, alice, 'bijlage-oud-0001', 'task-alice-0001');
  const token = run(db, bob, []).sync_token; // bob kent het project nog niet; zijn token is nieuwer dan de bijlage
  const share = cmd('project_share', { project_id: 'project-alice-01', username: 'bob' });
  assert.equal(run(db, alice, [share]).sync_status[share.uuid], 'ok');
  const delta = run(db, bob, [], token);
  assert.deepEqual((delta.attachments as Row[]).map((a) => a.id), ['bijlage-oud-0001']);
  assert.equal(delta.full_sync, false);
  // en een volgende delta bevat het niet nog eens
  assert.deepEqual(run(db, bob, [], delta.sync_token).attachments, []);
  // iemand die uit het project wordt gehaald, houdt geen bijlagen over in zijn volgende delta (het project is voor hem verdwenen)
  const unshare = cmd('project_unshare', { project_id: 'project-alice-01', user_id: bob.id });
  run(db, alice, [unshare]);
  assert.ok((run(db, bob, [], delta.sync_token).projects as Row[]).some((p) => p.is_deleted === true));
});

test('een bijlage die een lid toevoegt, geeft een signaal aan de andere leden, en alleen aan hen', () => {
  const { db, alice, bob, carol } = world();
  run(db, alice, [cmd('project_share', { project_id: 'project-alice-01', username: 'bob' })]);
  const before = currentRev(db);
  attach(db, bob, 'bijlage-bob-0001', 'task-alice-0001');
  const audience = audienceSince(db, before, bob.id);
  assert.deepEqual([...audience].sort(), [alice.id, bob.id].sort(), 'alice (lid) hoort het te horen, carol niet');
  assert.ok(!audience.has(carol.id));
  // verwijderen geeft ook een signaal
  const mid = currentRev(db);
  const del = cmd('attachment_delete', { id: 'bijlage-bob-0001' });
  run(db, bob, [del]);
  assert.ok(audienceSince(db, mid, bob.id).has(alice.id));
});

test('een taak naar een ander project: de bijlagen verhuizen mee naar wie dat project ziet, en verdwijnen voor wie het niet ziet', () => {
  const { db, alice, bob } = world();
  run(db, alice, [cmd('project_add', { id: 'project-alice-02', name: 'Werk' }), cmd('project_share', { project_id: 'project-alice-02', username: 'bob' })]);
  attach(db, alice, 'bijlage-verh-0001', 'task-alice-0001');
  const token = run(db, bob, []).sync_token;
  const move = cmd('task_move', { id: 'task-alice-0001', project_id: 'project-alice-02' });
  assert.equal(run(db, alice, [move]).sync_status[move.uuid], 'ok');
  assert.deepEqual((run(db, bob, [], token).attachments as Row[]).map((a) => a.id), ['bijlage-verh-0001']);
});
