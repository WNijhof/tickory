// Notities delen (note_share, noteAccess.ts): delen op gebruikersnaam als lezer of bewerker, wat elk mag, wat de sync stuurt als je
// een notitie krijgt of kwijtraakt, bestanden en versies van een gedeelde notitie, en wie het live-signaal krijgt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceSince, currentRev, handleSync } from './sync.ts';
import type { Command } from './sync.ts';
import { addUser, freshDb } from './testutil.ts';
import { getRevision, listRevisions } from './noteHistory.ts';
import { noteRole } from './noteAccess.ts';
import { LIMITS } from './limits.ts';
import { peersOf, updateUser } from './users.ts';

type Row = Record<string, any>;
let n = 0;
const cmd = (type: string, args: Record<string, unknown>): Command => ({ type, uuid: `share-${String(++n).padStart(8, '0')}`, args });

function world() {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  const cas = addUser(db, 'cas', 'Cas');
  const users: Record<string, typeof anna> = { anna, bram, cas };
  const run = (as: string, commands: Command[], token = '*') => handleSync(db, { sync_token: token, commands }, users[as].id);
  const ok = (as: string, commands: Command[]) => {
    const r = run(as, commands);
    for (const c of commands) assert.equal(r.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(r.sync_status[c.uuid])}`);
    return r;
  };
  const code = (as: string, c: Command) => (run(as, [c]).sync_status[c.uuid] as Row)?.error_code ?? 'ok';
  ok('anna', [cmd('label_add', { id: 'label-anna-001', name: 'Thuis' }), cmd('note_add', { id: 'note-anna-0001', title: 'Boodschappen', content: '- [ ] melk', labels: ['label-anna-001'] })]);
  return { db, users, run, ok, code };
}

test('delen op gebruikersnaam: alleen de eigenaar, een onbekende of geblokkeerde gebruiker is "bestaat niet", met jezelf doet niets', () => {
  const w = world();
  assert.equal(w.code('bram', cmd('note_share', { note_id: 'note-anna-0001', username: 'cas' })), 'NOT_FOUND', 'Bram ziet de notitie niet eens');
  assert.equal(w.code('anna', cmd('note_share', { note_id: 'note-anna-0001', username: 'niemand' })), 'NOT_FOUND');
  updateUser(w.db, w.users.cas.id, { is_disabled: true });
  assert.equal(w.code('anna', cmd('note_share', { note_id: 'note-anna-0001', username: 'cas' })), 'NOT_FOUND', 'geblokkeerd: dezelfde melding');
  assert.equal(w.code('anna', cmd('note_share', { note_id: 'note-anna-0001', username: 'bram', role: 'owner' })), 'INVALID_ARG');
  assert.equal(w.code('anna', cmd('note_share', { note_id: 'note-anna-0001', username: 'anna' })), 'ok');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM note_shares').get()!.n, 0);
  w.ok('anna', [cmd('note_share', { note_id: 'note-anna-0001', username: 'BRAM', role: 'viewer' })]);
  assert.equal(noteRole(w.db, w.users.bram.id, 'note-anna-0001'), 'viewer');
  // nog eens, met een andere rol: dezelfde deling, nu bewerker
  w.ok('anna', [cmd('note_share', { note_id: 'note-anna-0001', username: 'bram', role: 'editor' })]);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM note_shares WHERE is_deleted = 0').get()!.n, 1);
  assert.equal(noteRole(w.db, w.users.bram.id, 'note-anna-0001'), 'editor');
});

test('de ander krijgt de notitie in de sync (ook als die oud is), en kent dan de naam van de eigenaar; een derde ziet niets', () => {
  const w = world();
  const before = w.run('bram', []);
  assert.equal(before.notes.length, 0);
  const token = before.sync_token as string;
  w.ok('anna', [cmd('note_share', { note_id: 'note-anna-0001', username: 'bram', role: 'viewer' })]);
  const delta = w.run('bram', [], token);
  assert.deepEqual(delta.notes.map((x: Row) => [x.id, x.title, x.owner_id]), [['note-anna-0001', 'Boodschappen', w.users.anna.id]], 'de notitie zelf veranderde niet, toch komt ze mee');
  assert.deepEqual(delta.note_shares.map((s: Row) => [s.user_id, s.role]), [[w.users.bram.id, 'viewer']]);
  assert.ok(peersOf(w.db, w.users.bram.id).some((p) => p.id === w.users.anna.id), 'Bram kent Anna');
  assert.ok(peersOf(w.db, w.users.anna.id).some((p) => p.id === w.users.bram.id), 'en andersom');
  assert.equal(w.run('cas', []).notes.length, 0);
  assert.equal(w.run('bram', []).labels.some((l: Row) => l.id === 'label-anna-001'), false, 'de labels van Anna blijven van Anna');
});

test('een lezer leest alleen; een bewerker wijzigt titel en tekst, maar niet labels, kleur, archief, prullenbak of herinnering', () => {
  const w = world();
  w.ok('anna', [cmd('note_share', { note_id: 'note-anna-0001', username: 'bram', role: 'viewer' })]);
  assert.equal(w.code('bram', cmd('note_update', { id: 'note-anna-0001', content: 'van Bram' })), 'FORBIDDEN');
  w.ok('anna', [cmd('note_share', { note_id: 'note-anna-0001', username: 'bram', role: 'editor' })]);
  w.ok('bram', [cmd('note_update', { id: 'note-anna-0001', title: 'Boodschappen zaterdag', content: '- [ ] melk\n- [ ] eieren' })]);
  const note = w.run('anna', []).notes.find((x: Row) => x.id === 'note-anna-0001');
  assert.deepEqual([note.title, note.content, note.labels], ['Boodschappen zaterdag', '- [ ] melk\n- [ ] eieren', ['label-anna-001']], 'de labels bleven staan');
  for (const change of [{ labels: [] }, { background: 'red' }, { is_archived: true }, { is_pinned: true }, { trashed_at: '2026-11-16T10:00:00.000Z' }, { remind_at: '2026-12-01T09:00' }]) {
    assert.equal(w.code('bram', cmd('note_update', { id: 'note-anna-0001', ...change })), 'FORBIDDEN', JSON.stringify(change));
  }
  assert.equal(w.code('bram', cmd('note_delete', { id: 'note-anna-0001' })), 'FORBIDDEN');
  assert.equal(w.code('bram', cmd('note_share', { note_id: 'note-anna-0001', username: 'cas' })), 'FORBIDDEN', 'verder delen kan alleen de eigenaar');
  const share = w.run('bram', []).note_shares[0];
  assert.equal(w.code('bram', cmd('note_share_update', { id: share.id, role: 'editor' })), 'FORBIDDEN', 'de eigen rol wijzigen niet');
});

test('weghalen: de eigenaar haalt de deling weg, of de ander "uit mijn notities"; de sync van de ander verwijdert de notitie en haar bestanden', () => {
  const w = world();
  w.ok('anna', [cmd('note_share', { note_id: 'note-anna-0001', username: 'bram', role: 'editor' }), cmd('note_share', { note_id: 'note-anna-0001', username: 'cas', role: 'viewer' })]);
  // een bestand bij de notitie (rechtstreeks in de tabellen: de upload zelf staat in notes.files.test.ts)
  w.db.prepare("INSERT INTO attachment_files (id, user_id, task_id, note_id, size, sha256, mime, key, linked, created_at) VALUES ('file-anna-0001', ?, '', 'note-anna-0001', 3, ?, 'image/png', 'aa00000000000000000000000000000a', 0, '2026-11-16T10:00:00Z')").run(w.users.anna.id, 'a'.repeat(64));
  w.ok('anna', [cmd('note_file_add', { id: 'file-anna-0001', note_id: 'note-anna-0001', name: 'a.png', size: 3, mime: 'image/png', sha256: 'a'.repeat(64) })]);
  const bramToken = w.run('bram', []).sync_token as string;
  const casToken = w.run('cas', []).sync_token as string;
  assert.equal(w.run('bram', []).note_files.length, 1, 'Bram ziet het bestand');
  // Bram haalt de notitie uit zijn eigen lijst
  const bramShare = w.run('bram', []).note_shares[0];
  w.ok('bram', [cmd('note_share_delete', { id: bramShare.id })]);
  const delta = w.run('bram', [], bramToken);
  assert.deepEqual(delta.notes, [{ id: 'note-anna-0001', is_deleted: true }]);
  assert.deepEqual(delta.note_files, [{ id: 'file-anna-0001', is_deleted: true }]);
  assert.equal(noteRole(w.db, w.users.anna.id, 'note-anna-0001'), 'owner', 'de notitie zelf bestaat nog');
  // Cas kan Brams deling niet weghalen, en Anna haalt die van Cas weg
  const casShare = w.run('anna', []).note_shares.find((s: Row) => s.user_id === w.users.cas.id);
  assert.equal(w.code('bram', cmd('note_share_delete', { id: casShare.id })), 'NOT_FOUND');
  w.ok('anna', [cmd('note_share_delete', { id: casShare.id })]);
  assert.deepEqual(w.run('cas', [], casToken).notes, [{ id: 'note-anna-0001', is_deleted: true }]);
});

test('de eigenaar verwijdert de notitie: de delingen gaan mee en de ander krijgt de verwijdering; versies ziet wie de notitie ziet', () => {
  const w = world();
  w.ok('anna', [cmd('note_share', { note_id: 'note-anna-0001', username: 'bram', role: 'viewer' })]);
  // een versie (de eerste wijziging bewaart de stand ervoor)
  w.ok('anna', [cmd('note_update', { id: 'note-anna-0001', content: '- [ ] melk\n- [ ] brood' })]);
  const [rev] = listRevisions(w.db, w.users.bram.id, 'note-anna-0001').revisions as Row[];
  assert.equal((getRevision(w.db, w.users.bram.id, 'note-anna-0001', rev.id) as Row).content, '- [ ] melk', 'een lezer mag de versies zien');
  assert.equal(w.code('bram', cmd('note_restore', { id: 'note-anna-0001', revision_id: rev.id })), 'FORBIDDEN', 'maar niet terugzetten');
  assert.throws(() => listRevisions(w.db, w.users.cas.id, 'note-anna-0001'), /bestaat niet/);
  const token = w.run('bram', []).sync_token as string;
  w.ok('anna', [cmd('note_delete', { id: 'note-anna-0001' })]);
  assert.deepEqual(w.run('bram', [], token).notes, [{ id: 'note-anna-0001', is_deleted: true }]);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM note_shares WHERE is_deleted = 0').get()!.n, 0);
});

test('het live-signaal: wie een notitie gedeeld kreeg, hoort van wijzigingen en van het weghalen; een ander niet', () => {
  const w = world();
  let since = currentRev(w.db);
  w.ok('anna', [cmd('note_share', { note_id: 'note-anna-0001', username: 'bram', role: 'editor' })]);
  assert.deepEqual([...audienceSince(w.db, since, w.users.anna.id)].sort(), [w.users.anna.id, w.users.bram.id].sort());
  since = currentRev(w.db);
  w.ok('bram', [cmd('note_update', { id: 'note-anna-0001', content: 'nieuw' })]);
  const who = audienceSince(w.db, since, w.users.bram.id);
  assert.ok(who.has(w.users.anna.id) && who.has(w.users.bram.id) && !who.has(w.users.cas.id));
  since = currentRev(w.db);
  const share = w.run('anna', []).note_shares[0];
  w.ok('anna', [cmd('note_share_delete', { id: share.id })]);
  assert.ok(audienceSince(w.db, since, w.users.anna.id).has(w.users.bram.id), 'Bram hoort dat hij haar kwijt is');
});

test('hooguit vijftig delingen per notitie', () => {
  const w = world();
  for (let i = 0; i < LIMITS.sharesPerNote; i++) addUser(w.db, `lid${String(i).padStart(2, '0')}`);
  const cmds = Array.from({ length: LIMITS.sharesPerNote }, (_, i) => cmd('note_share', { note_id: 'note-anna-0001', username: `lid${String(i).padStart(2, '0')}` }));
  w.ok('anna', cmds);
  assert.equal(w.code('anna', cmd('note_share', { note_id: 'note-anna-0001', username: 'bram' })), 'LIMIT_REACHED');
});
