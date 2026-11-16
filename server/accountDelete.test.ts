// Je eigen account verwijderen (accountDelete.ts): wat weg moet, wat bij anderen blijft, en wanneer het (nog) niet mag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { accountBlockers, deleteAccount, isBlocked } from './accountDelete.ts';
import { handleSync } from './sync.ts';
import type { Command } from './sync.ts';
import { addUser, freshDb } from './testutil.ts';
import type { UserRow } from './users.ts';
import { createSession } from './users.ts';

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `acc-del-test-${String(++n).padStart(6, '0')}`, args });
function run(db: DatabaseSync, as: UserRow, commands: Command[]) {
  const res = handleSync(db, { commands }, as.id);
  for (const [uuid, s] of Object.entries(res.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
}
const count = (db: DatabaseSync, sql: string, ...params: string[]) => Number((db.prepare(sql).get(...params) as { n: number }).n);

function world() {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(bram.id); // twee beheerders: Anna is niet de laatste
  // Anna: een eigen project met sectie, taak, subtaak, opmerking, herinnering; een label, filter, plaats, notitie
  run(db, anna, [
    cmd('project_add', { id: 'project-anna-001', name: 'Verbouwing' }),
    cmd('section_add', { id: 'section-anna-01', project_id: 'project-anna-001', name: 'Keuken' }),
    cmd('label_add', { id: 'label-anna-0001', name: 'dringend' }),
    cmd('task_add', { id: 'task-anna-00001', project_id: 'project-anna-001', content: 'Tegels kiezen', labels: ['label-anna-0001'], due: { date: '2026-12-01T10:00', string: '1 dec om 10:00', lang: 'nl' } }),
    cmd('task_add', { id: 'task-anna-00002', project_id: 'project-anna-001', parent_id: 'task-anna-00001', content: 'Stalen ophalen' }),
    cmd('task_add', { id: 'task-anna-inbox', project_id: anna.inbox_project_id, content: 'Iets in de Inbox' }),
    cmd('comment_add', { id: 'comment-anna-01', task_id: 'task-anna-00001', content: 'Wit of grijs?' }),
    cmd('reminder_add', { id: 'remind-anna-001', task_id: 'task-anna-00001', type: 'relative', minute_offset: 30 }),
    cmd('filter_add', { id: 'filter-anna-001', name: 'Vandaag dringend', query: 'vandaag & @dringend' }),
    cmd('note_add', { id: 'note-anna-00001', title: 'Maten', content: 'Keuken 3 bij 4 meter' }),
    cmd('note_add', { id: 'note-anna-00002', title: 'Gedeeld lijstje', content: '- [ ] verf' }),
  ]);
  // Bram deelt een project met Anna; Anna schrijft daarin een taak en een opmerking en zet haar label op Brams taak
  run(db, bram, [
    cmd('project_add', { id: 'project-bram-001', name: 'Samen' }),
    cmd('task_add', { id: 'task-bram-00001', project_id: 'project-bram-001', content: 'Boodschappen' }),
    cmd('project_share', { project_id: 'project-bram-001', username: 'anna', role: 'member' }),
    cmd('note_add', { id: 'note-bram-00001', title: 'Van Bram', content: 'tekst' }),
    cmd('note_share', { note_id: 'note-bram-00001', username: 'anna', role: 'viewer' }),
  ]);
  run(db, anna, [
    cmd('task_add', { id: 'task-anna-insam', project_id: 'project-bram-001', content: 'Door Anna in Samen' }),
    cmd('comment_add', { id: 'comment-anna-02', task_id: 'task-bram-00001', content: 'Melk ook' }),
    cmd('task_update', { id: 'task-bram-00001', labels: ['label-anna-0001'], assignee_id: anna.id }),
    cmd('note_share', { note_id: 'note-anna-00002', username: 'bram', role: 'editor' }),
  ]);
  return { db, anna, bram };
}

test('alles van Anna gaat weg; wat ze bij Bram schreef blijft, haar label en toewijzing niet', () => {
  const { db, anna, bram } = world();
  createSession(db, anna.id, 'telefoon');
  assert.equal(isBlocked(accountBlockers(db, anna.id)), false, 'Anna is geen eigenaar van een gedeeld project en geen laatste beheerder');
  const removed: string[] = [];
  deleteAccount(db, anna.id, (ids) => removed.push(...ids));

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM users WHERE id = ?', anna.id), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', anna.id), 0);
  for (const [table, col] of [['projects', 'id'], ['sections', 'project_id'], ['tasks', 'project_id']] as const) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, 'project-anna-001'), 0, table);
  }
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM projects WHERE id = ?', anna.inbox_project_id), 0, 'de Inbox ook');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM tasks WHERE id = ?', 'task-anna-inbox'), 0);
  for (const table of ['labels', 'filters', 'reminders', 'notes', 'user_settings']) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE owner_id = ?`, anna.id), 0, table);
  }
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM comments WHERE id = ?', 'comment-anna-01'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM project_members WHERE user_id = ? AND is_deleted = 0', anna.id), 0, 'ook geen lidmaatschap meer');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?', 'project-anna-001'), 0);

  // bij Bram
  const bramState = handleSync(db, { sync_token: '*' }, bram.id) as any;
  const tasks = bramState.tasks as any[];
  assert.ok(tasks.some((t) => t.id === 'task-anna-insam'), 'haar taak in Samen blijft');
  assert.ok((bramState.comments as any[]).some((c) => c.id === 'comment-anna-02'), 'haar opmerking blijft');
  const shopping = tasks.find((t) => t.id === 'task-bram-00001');
  assert.deepEqual(shopping.labels, [], 'haar label is van Brams taak gehaald');
  assert.equal(shopping.assignee_id ?? null, null, 'de toewijzing aan Anna vervalt');
  assert.ok(!(bramState.notes as any[]).some((x) => x.id === 'note-anna-00002'), 'haar gedeelde notitie is weg bij Bram');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM note_shares WHERE note_id = ? AND is_deleted = 0', 'note-bram-00001'), 0, 'Brams notitie is niet meer met haar gedeeld');
  assert.ok((bramState.notes as any[]).some((x) => x.id === 'note-bram-00001'), 'Brams notitie zelf blijft');
  assert.ok(!(bramState.members as any[]).some((m) => m.user_id === anna.id && !m.is_deleted), 'Anna is geen lid meer van Samen');
});

test('bram ziet in een delta dat Anna wegging (geen verouderde gegevens op zijn apparaten)', () => {
  const { db, anna, bram } = world();
  const full = handleSync(db, { sync_token: '*' }, bram.id) as any;
  const membership = (full.members as any[]).find((m) => m.user_id === anna.id && m.project_id === 'project-bram-001').id;
  deleteAccount(db, anna.id);
  const delta = handleSync(db, { sync_token: full.sync_token }, bram.id) as any;
  assert.ok((delta.members as any[]).some((m) => m.id === membership && m.is_deleted), 'haar lidmaatschap als verwijderd');
  assert.ok((delta.labels ?? []).some((l: any) => l.id === 'label-anna-0001' && l.is_deleted) || !(delta.tasks as any[]).find((t) => t.id === 'task-bram-00001')?.labels?.length, 'het label is weg');
  assert.ok((delta.notes as any[]).some((x) => x.id === 'note-anna-00002' && x.is_deleted), 'haar gedeelde notitie als verwijderd');
});

test('eigenaar van een gedeeld project met leden, of de laatste beheerder: weigeren, met de reden', () => {
  const { db, bram, anna } = world();
  const b = accountBlockers(db, bram.id);
  assert.deepEqual(b.shared_projects, [{ id: 'project-bram-001', name: 'Samen', members: 1 }]);
  assert.throws(() => deleteAccount(db, bram.id), (err: any) => err.code === 'BLOCKED');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM users WHERE id = ?', bram.id), 1, 'niets verwijderd');
  // na het delen stoppen mag het wel
  run(db, bram, [cmd('project_unshare', { project_id: 'project-bram-001', user_id: anna.id })]);
  assert.equal(isBlocked(accountBlockers(db, bram.id)), false);

  const solo = freshDb();
  const admin = addUser(solo, 'beheer', 'Beheer');
  solo.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
  assert.equal(accountBlockers(solo, admin.id).last_admin, true);
  const second = addUser(solo, 'tweede', 'Tweede');
  solo.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(second.id);
  assert.equal(accountBlockers(solo, admin.id).last_admin, false, 'met een tweede beheerder mag het');
});

test('de bestanden van eigen bijlagen worden meteen weggehaald; die bij anderen niet', () => {
  const { db, anna } = world();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO attachment_files (id, user_id, task_id, key, size, sha256, mime, created_at, linked) VALUES (?, ?, ?, ?, 10, ?, 'image/jpeg', ?, 0)").run('file-anna-own01', anna.id, 'task-anna-00001', 'k1', 'a'.repeat(64), now);
  run(db, anna, [
    cmd('attachment_add', { id: 'file-anna-own01', task_id: 'task-anna-00001', name: 'tegel.jpg', size: 10, mime: 'image/jpeg', sha256: 'a'.repeat(64) }),
  ]);
  db.prepare("INSERT INTO attachment_files (id, user_id, task_id, key, size, sha256, mime, created_at, linked) VALUES (?, ?, ?, ?, 10, 'x', 'image/jpeg', ?, 1)").run('file-anna-bij-b', anna.id, 'task-bram-00001', 'k2', now);
  const removed: string[] = [];
  deleteAccount(db, anna.id, (ids) => removed.push(...ids));
  assert.ok(removed.includes('file-anna-own01'));
  assert.ok(!removed.includes('file-anna-bij-b'), 'een bestand in een project van een ander blijft');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM attachment_files WHERE id = ?', 'file-anna-bij-b'), 1);
});
