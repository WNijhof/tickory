// Foto's en geluid bij notities (note_file): uploaden met note_id, alleen afbeeldingen en geluid, privé voor de eigenaar, de grens
// per notitie, meeverwijderd met de notitie, en veilig voor het opruimen bij het opstarten en voor de back-up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './main.ts';
import { createAttachments } from './attachments.ts';
import { liveFileKeysSql } from './backupArchive.ts';
import { createSession, setPasswordCostForTests } from './users.ts';
import { handleSync } from './sync.ts';
import type { Command } from './sync.ts';
import { LIMITS } from './limits.ts';
import { addUser, freshDb } from './testutil.ts';
import { MAX_FILES_PER_NOTE } from '../shared/notes.js';

setPasswordCostForTests(1024);

type Row = Record<string, any>;
const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(40)]);
const OGG = () => Buffer.concat([Buffer.from('OggS'), randomBytes(60)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `nf-${String(++n).padStart(8, '0')}`, args });

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'tickory-notefile-test-'));
  const db = freshDb();
  const alice = addUser(db, 'alice', 'Alice');
  const bob = addUser(db, 'bob', 'Bob');
  const tokens: Record<string, string> = { alice: createSession(db, alice.id, 't').token, bob: createSession(db, bob.id, 't').token };
  const attachments = createAttachments(db, { dir, maxUploadBytes: 1_000_000, quotaBytes: 10_000_000, restoreGraceMs: 0 });
  const app = createApp({ db, attachments, attachmentSweepMs: 0 });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const users: Record<string, typeof alice> = { alice, bob };
  const sync = (as: string, commands: Command[]) => {
    const r = handleSync(db, { sync_token: '*', commands }, users[as].id);
    attachments.purgeDeleted();
    return r;
  };
  const ok = (as: string, commands: Command[]) => {
    const r = sync(as, commands);
    for (const c of commands) assert.equal(r.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(r.sync_status[c.uuid])}`);
    return r;
  };
  const upload = async (as: string, query: string, body: Buffer, type: string) => {
    const res = await fetch(`${base}/api/v1/attachments?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[as]}`, 'Content-Type': type }, body });
    return { status: res.status, json: await res.json() as Row };
  };
  const get = (as: string, id: string) => fetch(`${base}/api/v1/attachments/${id}`, { headers: { Authorization: `Bearer ${tokens[as]}` } });
  /** Uploaden en koppelen: een foto of geluid bij een notitie. */
  const attach = async (as: string, noteId: string, id: string, body: Buffer, type: string, name = 'foto.png') => {
    const up = await upload(as, `id=${id}&note_id=${noteId}`, body, type);
    assert.equal(up.status, 200, JSON.stringify(up.json));
    return sync(as, [cmd('note_file_add', { id, note_id: noteId, name, size: up.json.size, mime: up.json.mime, sha256: up.json.sha256 })]);
  };
  const filesOnDisk = () => readdirSync(dir).filter((d) => /^[0-9a-f]{2}$/.test(d)).flatMap((d) => readdirSync(join(dir, d)));
  ok('alice', [cmd('note_add', { id: 'note-alice-0001', title: 'Vakantie' }), cmd('project_add', { id: 'project-alice-01', name: 'Thuis' }), cmd('task_add', { id: 'task-alice-0001', project_id: 'project-alice-01', content: 'Taak' })]);
  ok('bob', [cmd('note_add', { id: 'note-bob-00001', title: 'Van Bob' })]);
  return { db, dir, attachments, app, sync, ok, upload, get, attach, filesOnDisk, close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('een foto en een geluidsfragment bij je eigen notitie: uploaden, koppelen, ophalen; een ander ziet niets', async () => {
  const w = await world();
  try {
    const png = PNG();
    const r = await w.attach('alice', 'note-alice-0001', 'file-alice-0001', png, 'image/png', 'strand.png');
    assert.equal(r.sync_status[Object.keys(r.sync_status)[0]], 'ok');
    const ogg = OGG();
    await w.attach('alice', 'note-alice-0001', 'file-alice-0002', ogg, 'audio/ogg', 'golven.ogg');
    const own = await w.get('alice', 'file-alice-0001');
    assert.equal(own.status, 200);
    assert.deepEqual(Buffer.from(await own.arrayBuffer()), png);
    assert.equal(own.headers.get('content-type'), 'image/png');
    assert.equal((await w.get('alice', 'file-alice-0002')).status, 200);
    // Bob: geen toegang tot het bestand, en de rij komt niet in zijn sync
    assert.equal((await w.get('bob', 'file-alice-0001')).status, 404);
    assert.equal(w.sync('bob', []).note_files.length, 0);
    const mine = w.sync('alice', []).note_files.map((f: Row) => [f.id, f.note_id, f.name, f.mime, f.owner_id === undefined]);
    assert.deepEqual(mine.sort(), [['file-alice-0001', 'note-alice-0001', 'strand.png', 'image/png', false], ['file-alice-0002', 'note-alice-0001', 'golven.ogg', 'audio/ogg', false]]);
  } finally { await w.close(); }
});

test('uploaden bij een notitie: alleen je eigen, alleen afbeeldingen en geluid (een nep-png ook niet), niet task_id en note_id samen', async () => {
  const w = await world();
  try {
    assert.equal((await w.upload('bob', 'id=file-bob-00001&note_id=note-alice-0001', PNG(), 'image/png')).status, 404, 'andermans notitie bestaat niet');
    assert.equal((await w.upload('alice', 'id=file-alice-0003&note_id=note-onbekend1', PNG(), 'image/png')).status, 404);
    const pdf = await w.upload('alice', 'id=file-alice-0004&note_id=note-alice-0001', Buffer.from('%PDF-1.7\nxx'), 'application/pdf');
    assert.deepEqual([pdf.status, pdf.json.error_code], [400, 'INVALID_ARG']);
    const fake = await w.upload('alice', 'id=file-alice-0005&note_id=note-alice-0001', Buffer.from('<svg onload=alert(1)>'), 'image/png');
    assert.deepEqual([fake.status, fake.json.error_code], [400, 'INVALID_ARG'], 'een "png" die geen png is');
    const both = await w.upload('alice', 'id=file-alice-0006&note_id=note-alice-0001&task_id=task-alice-0001', PNG(), 'image/png');
    assert.deepEqual([both.status, both.json.error_code], [400, 'INVALID_ARG']);
    assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM attachment_files').get() as Row).n, 0, 'niets bewaard');
    assert.equal(w.filesOnDisk().length, 0);
  } finally { await w.close(); }
});

test('koppelen: alleen wat je zelf bij deze notitie uploadde, met dezelfde gegevens; een taakbijlage is geen notitiebestand', async () => {
  const w = await world();
  try {
    const png = PNG();
    const up = await w.upload('alice', 'id=file-alice-0010&note_id=note-alice-0001', png, 'image/png');
    const base = { id: 'file-alice-0010', name: 'a.png', size: up.json.size, mime: up.json.mime, sha256: up.json.sha256 };
    const tries: [Record<string, unknown>, string][] = [
      [{ ...base, note_id: 'note-bob-00001' }, 'NOT_FOUND'], // andermans notitie
      [{ ...base, note_id: 'note-alice-0001', sha256: sha(Buffer.from('x')) }, 'CONFLICT'],
      [{ ...base, note_id: 'note-alice-0001', mime: 'application/pdf' }, 'INVALID_ARG'],
    ];
    for (const [args, code] of tries) {
      const c = cmd('note_file_add', args);
      assert.equal((w.sync('alice', [c]).sync_status[c.uuid] as Row).error_code, code, JSON.stringify(args));
    }
    // een bijlage van een taak kan niet als notitiebestand worden gekoppeld, en andersom niet
    const task = await w.upload('alice', 'id=file-alice-0011&task_id=task-alice-0001', PNG(), 'image/png');
    const c1 = cmd('note_file_add', { id: 'file-alice-0011', note_id: 'note-alice-0001', name: 'b.png', size: task.json.size, mime: task.json.mime, sha256: task.json.sha256 });
    assert.equal((w.sync('alice', [c1]).sync_status[c1.uuid] as Row).error_code, 'NOT_FOUND');
    const c2 = cmd('attachment_add', { ...base, task_id: 'task-alice-0001' });
    assert.equal((w.sync('alice', [c2]).sync_status[c2.uuid] as Row).error_code, 'NOT_FOUND');
    // Bob kan het niet koppelen aan zijn eigen notitie
    const c3 = cmd('note_file_add', { ...base, note_id: 'note-bob-00001' });
    assert.equal((w.sync('bob', [c3]).sync_status[c3.uuid] as Row).error_code, 'NOT_FOUND');
    const good = cmd('note_file_add', { ...base, note_id: 'note-alice-0001' });
    assert.equal(w.sync('alice', [good]).sync_status[good.uuid], 'ok');
    const again = cmd('note_file_add', { ...base, id: 'file-alice-0010', note_id: 'note-alice-0001' });
    assert.notEqual(w.sync('alice', [again]).sync_status[again.uuid], 'ok', 'twee keer koppelen gaat niet');
  } finally { await w.close(); }
});

test('hooguit twintig bestanden per notitie (ook wachtende uploads tellen); de grens is gelijk aan die van de client', async () => {
  const w = await world();
  try {
    assert.equal(LIMITS.filesPerNote, MAX_FILES_PER_NOTE);
    for (let i = 0; i < LIMITS.filesPerNote; i++) {
      const up = await w.upload('alice', `id=file-many-${String(i).padStart(4, '0')}&note_id=note-alice-0001`, PNG(), 'image/png');
      assert.equal(up.status, 200);
    }
    const over = await w.upload('alice', 'id=file-many-9999&note_id=note-alice-0001', PNG(), 'image/png');
    assert.deepEqual([over.status, over.json.error_code], [409, 'LIMIT_REACHED']);
  } finally { await w.close(); }
});

test('een notitie verwijderen neemt haar bestanden mee (ook van schijf); de prullenbak niet', async () => {
  const w = await world();
  try {
    await w.attach('alice', 'note-alice-0001', 'file-alice-0020', PNG(), 'image/png');
    w.ok('alice', [cmd('note_update', { id: 'note-alice-0001', trashed_at: '2026-11-16T10:00:00.000Z' })]);
    assert.equal((await w.get('alice', 'file-alice-0020')).status, 200, 'in de prullenbak blijft alles');
    assert.equal(w.filesOnDisk().length, 1);
    w.ok('alice', [cmd('note_delete', { id: 'note-alice-0001' })]);
    assert.equal((await w.get('alice', 'file-alice-0020')).status, 404);
    assert.equal(w.filesOnDisk().length, 0, 'het bestand is weg');
    const row = w.sync('alice', []).note_files.find((f: Row) => f.id === 'file-alice-0020');
    assert.equal(row, undefined, 'een volledige sync geeft geen verwijderde rijen');
    assert.deepEqual({ ...w.db.prepare('SELECT is_deleted, name, sha256 FROM note_files WHERE id = ?').get('file-alice-0020') }, { is_deleted: 1, name: '', sha256: '' });
    // los verwijderen kan ook
    w.ok('alice', [cmd('note_add', { id: 'note-alice-0002', title: 'Nog een' })]);
    await w.attach('alice', 'note-alice-0002', 'file-alice-0021', OGG(), 'audio/ogg', 'opname.ogg');
    w.ok('alice', [cmd('note_file_delete', { id: 'file-alice-0021' })]);
    assert.equal(w.filesOnDisk().length, 0);
    // Bob kan Alice's bestand niet verwijderen
    await w.attach('alice', 'note-alice-0002', 'file-alice-0022', PNG(), 'image/png');
    const c = cmd('note_file_delete', { id: 'file-alice-0022' });
    assert.equal((w.sync('bob', [c]).sync_status[c.uuid] as Row).error_code, 'NOT_FOUND');
  } finally { await w.close(); }
});

test('het opruimen bij het opstarten laat notitiebestanden staan, en de back-up neemt ze mee', async () => {
  const w = await world();
  try {
    await w.attach('alice', 'note-alice-0001', 'file-alice-0030', PNG(), 'image/png');
    const keyOf = (id: string) => (w.db.prepare('SELECT key FROM attachment_files WHERE id = ?').get(id) as Row).key as string;
    const key = keyOf('file-alice-0030');
    const report = w.attachments.check();
    assert.deepEqual([report.rowsRemoved, report.strayFiles], [0, 0]);
    assert.ok(existsSync(join(w.dir, key.slice(0, 2), key)), 'het bestand staat er nog');
    assert.equal((await w.get('alice', 'file-alice-0030')).status, 200);
    const keys = (w.db.prepare(liveFileKeysSql(w.db)).all() as Row[]).map((r) => r.key);
    assert.deepEqual(keys, [key]);
    // een database van vóór de notitiebestanden: alleen de bijlagen van taken
    const old = new DatabaseSync(':memory:');
    old.exec('CREATE TABLE attachment_files (id TEXT, key TEXT, linked INTEGER); CREATE TABLE attachments (id TEXT, is_deleted INTEGER)');
    assert.deepEqual(old.prepare(liveFileKeysSql(old)).all(), []);
  } finally { await w.close(); }
});
