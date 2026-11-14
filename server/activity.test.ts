// Het activiteitenlogboek per project (activity.ts, SPEC.md hoofdstuk 5f): wat erin komt (en wat niet), wie het mag lezen,
// bladeren en filteren over HTTP, en opruimen.

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
import { capProjects, listActivity, pruneActivity } from './activity.ts';
import { ACTIVITY_KINDS, ACTIVITY_RETENTION_DAYS, MAX_ACTIVITY_PER_PROJECT, TITLE_MAX } from '../shared/activity.js';

type Row = Record<string, any>;
let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `act-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[]): SyncResponse => {
  const res = handleSync(db, { commands }, as.id);
  for (const c of commands) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`);
  return res;
};
const P = 'project-act-0001', Q = 'project-act-0002', S = 'section-act-001', T = 'task-act-000001';

function world() {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  const carol = addUser(db, 'carol', 'Carol');
  run(db, anna, [cmd('project_add', { id: P, name: 'Verbouwing' }), cmd('project_share', { project_id: P, username: 'bram' }), cmd('project_share', { project_id: P, username: 'carol', role: 'viewer' })]);
  return { db, anna, bram, carol };
}
const all = (db: DatabaseSync, as: UserRow, project = P) => listActivity(db, as.id, project, { limit: '100' }).entries.reverse(); // oudste eerst
const kinds = (db: DatabaseSync, as: UserRow, project = P) => all(db, as, project).map((e) => e.kind);

test('wat erin komt: taken, secties, opmerkingen, leden en het project, met wie en wanneer; de nieuwste eerst', () => {
  const { db, anna, bram, carol } = world();
  run(db, bram, [
    cmd('section_add', { id: S, project_id: P, name: 'Keuken' }),
    cmd('task_add', { id: T, project_id: P, section_id: S, content: 'Tegels kiezen' }),
    cmd('task_update', { id: T, content: 'Tegels uitzoeken', priority: 1, due: { date: '2030-01-07' }, description: 'Geheime notitie', is_collapsed: true }),
    cmd('task_update', { id: T, is_collapsed: false }), // alleen inklappen: geen nieuws
    cmd('task_update', { id: T, priority: 1 }), // dezelfde waarde: geen wijziging
    cmd('task_complete', { id: T }), cmd('task_uncomplete', { id: T }),
    cmd('section_update', { id: S, name: 'Keuken en bijkeuken' }),
    cmd('comment_add', { id: 'comment-act-001', task_id: T, content: 'Wat vind jij van wit?' }),
    cmd('comment_add', { id: 'comment-act-002', project_id: P, content: 'Begroting klopt niet' }),
    cmd('comment_delete', { id: 'comment-act-002' }),
    cmd('reminder_add', { id: 'remind-act-0001', task_id: T, type: 'absolute', due: { date: '2030-01-06T09:00' } }), // privé: niet in het logboek
    cmd('task_move', { id: T, section_id: null }),
  ]);
  run(db, carol, [cmd('comment_add', { id: 'comment-act-003', task_id: T, content: 'Wit!' })]);
  run(db, anna, [
    cmd('member_update', { project_id: P, user_id: carol.id, role: 'member' }),
    cmd('project_update', { id: P, name: 'Verbouwing 2030', color: 'red' }),
    cmd('project_update', { id: P, is_archived: true }), cmd('project_update', { id: P, is_archived: false }),
    cmd('project_unshare', { project_id: P, user_id: carol.id }),
    cmd('task_delete', { id: T }), cmd('section_delete', { id: S }),
  ]);
  run(db, bram, [cmd('project_leave', { project_id: P })]);
  const list = all(db, anna);
  assert.deepEqual(list.map((e) => e.kind), [
    'project_created', 'member_added', 'member_added',
    'section_added', 'task_added', 'task_updated', 'task_completed', 'task_uncompleted', 'section_renamed', 'comment_added', 'comment_added', 'comment_deleted', 'task_moved',
    'comment_added', 'member_role', 'project_renamed', 'project_archived', 'project_unarchived', 'member_removed', 'task_deleted', 'section_deleted', 'member_left',
  ]);
  const by = (kind: string) => list.filter((e) => e.kind === kind);
  assert.deepEqual(by('member_added').map((e) => [e.actor_id, e.user_id, e.extra]), [[anna.id, bram.id, { role: 'member' }], [anna.id, carol.id, { role: 'viewer' }]]);
  const upd = by('task_updated')[0];
  assert.deepEqual([upd.actor_id, upd.task_id, upd.title, upd.extra], [bram.id, T, 'Tegels uitzoeken', { fields: ['content', 'description', 'priority', 'due'] }]);
  assert.deepEqual(by('section_renamed')[0].extra, { from: 'Keuken' });
  assert.equal(by('section_renamed')[0].title, 'Keuken en bijkeuken');
  assert.deepEqual(by('task_moved')[0].extra, { from_section: S, to_section: null });
  assert.deepEqual(by('comment_added').map((e) => [e.actor_id, e.task_id, e.title]), [[bram.id, T, 'Tegels uitzoeken'], [bram.id, null, null], [carol.id, T, 'Tegels uitzoeken']], 'een lezer mag reageren, en dat staat erin');
  assert.deepEqual(by('member_role')[0].extra, { role: 'member', from: 'viewer' });
  assert.deepEqual([by('project_renamed')[0].title, by('project_renamed')[0].extra], ['Verbouwing 2030', { from: 'Verbouwing' }]);
  assert.deepEqual(by('member_left').map((e) => [e.actor_id, e.user_id]), [[bram.id, bram.id]]);
  assert.ok(list.every((e) => typeof e.at === 'string' && /^\d+$/.test(e.id)));
  // nooit de tekst van een opmerking of een beschrijving, nooit iets van een herinnering
  const raw = JSON.stringify(db.prepare('SELECT * FROM activity').all());
  for (const secret of ['Geheime notitie', 'Wat vind jij van wit', 'Begroting', 'Wit!', '2030-01-06T09:00', 'remind-act-0001']) assert.ok(!raw.includes(secret), `"${secret}" staat niet in het logboek`);
});

test('verhuizen naar een ander project staat in beide logboeken; een mislukt commando laat niets achter', () => {
  const { db, anna, bram } = world();
  run(db, anna, [cmd('project_add', { id: Q, name: 'Tuin' }), cmd('task_add', { id: T, project_id: P, content: 'Schuur verven' })]);
  run(db, anna, [cmd('task_move', { id: T, project_id: Q })]);
  const there = all(db, anna, Q).filter((e) => e.kind === 'task_moved');
  const here = all(db, anna, P).filter((e) => e.kind === 'task_moved');
  assert.deepEqual(there.map((e) => e.extra), [{ from_project: P, to_project: Q }]);
  assert.deepEqual(here.map((e) => e.extra), [{ from_project: P, to_project: Q }]);
  assert.throws(() => listActivity(db, bram.id, Q, {}), /bestaat niet/, 'bram ziet Tuin niet, en het logboek dus ook niet');
  const before = kinds(db, anna).length;
  const bad = cmd('task_update', { id: T, priority: 9 });
  const res = handleSync(db, { commands: [cmd('section_add', { project_id: P, name: 'x', kleur: 1 }), bad] }, anna.id);
  assert.ok(Object.values(res.sync_status).every((s) => s !== 'ok'));
  assert.equal(kinds(db, anna).length, before);
});

test('een verwijderde bijlage verliest haar naam, ook in het logboek; een titel is kort; een verwijderd project neemt zijn logboek mee', () => {
  const { db, anna, bram } = world();
  run(db, anna, [cmd('task_add', { id: T, project_id: P, content: 'é'.repeat(TITLE_MAX + 50) })]);
  db.prepare("INSERT INTO attachment_files (id, user_id, task_id, size, sha256, mime, key, linked, created_at) VALUES ('attach-act-0001', ?, ?, 5, ?, 'text/plain', 'sleutel-act-000000000000000000000', 0, ?)").run(anna.id, T, 'e'.repeat(64), new Date().toISOString());
  run(db, anna, [cmd('attachment_add', { id: 'attach-act-0001', task_id: T, name: 'offerte-geheim.pdf', size: 5, mime: 'text/plain', sha256: 'e'.repeat(64) })]);
  const added = all(db, anna).find((e) => e.kind === 'attachment_added')!;
  assert.equal(added.title, 'offerte-geheim.pdf');
  assert.equal([...all(db, anna).find((e) => e.kind === 'task_added')!.title!].length, TITLE_MAX, 'een lange titel wordt ingekort, op hele tekens');
  run(db, anna, [cmd('attachment_delete', { id: 'attach-act-0001' })]);
  const after = all(db, anna).filter((e) => e.attachment_id === 'attach-act-0001');
  assert.deepEqual(after.map((e) => [e.kind, e.title]), [['attachment_added', null], ['attachment_deleted', null]]);
  run(db, anna, [cmd('project_add', { id: 'project-act-sub1', name: 'Kind', parent_id: P }), cmd('project_delete', { id: P })]);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM activity WHERE project_id IN (?, ?)').get(P, 'project-act-sub1') as Row).n), 0);
  assert.throws(() => listActivity(db, anna.id, P, {}), /bestaat niet/);
  assert.throws(() => listActivity(db, bram.id, P, {}), /bestaat niet/);
});

test('geen nieuws: dezelfde naam opnieuw; wel nieuws: een terugkerende taak die doorschuift, met die vermelding', () => {
  const { db, anna } = world();
  const before = kinds(db, anna).length;
  run(db, anna, [cmd('project_update', { id: P, name: 'Verbouwing' }), cmd('section_add', { id: S, project_id: P, name: 'Keuken' })]);
  run(db, anna, [cmd('section_update', { id: S, name: 'Keuken' })]);
  assert.deepEqual(kinds(db, anna).slice(before), ['section_added'], 'hernoemen naar dezelfde naam staat er niet in');
  run(db, anna, [cmd('task_add', { id: T, project_id: P, content: 'Planten water geven', due: { date: '2030-01-07', recurrence: { freq: 'weekly', byweekday: [1] } } }), cmd('task_complete', { id: T })]);
  const done = all(db, anna).filter((e) => e.kind === 'task_completed');
  assert.deepEqual(done.map((e) => e.extra), [{ recurring: true }]);
  run(db, anna, [cmd('task_add', { id: 'task-act-000009', project_id: P, content: 'Eenmalig' }), cmd('task_complete', { id: 'task-act-000009' })]);
  assert.equal(all(db, anna).filter((e) => e.kind === 'task_completed').at(-1)!.extra, null);
});

test('een sync met commando\'s ruimt regels op die ouder zijn dan de bewaartermijn', () => {
  const { db, anna } = world();
  const old = new Date(Date.now() - (ACTIVITY_RETENTION_DAYS + 2) * 86_400_000).toISOString();
  db.prepare("INSERT INTO activity (project_id, at, actor_id, kind) VALUES (?, ?, ?, 'task_added')").run(P, old, anna.id);
  handleSync(db, {}, anna.id); // zonder commando's: niets opgeruimd
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM activity WHERE at = ?').get(old) as Row).n), 1);
  run(db, anna, [cmd('task_add', { project_id: anna.inbox_project_id, content: 'iets' })]);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM activity WHERE at = ?').get(old) as Row).n), 0);
});

test('opruimen: ouder dan de bewaartermijn weg, en per project hooguit het maximum (de oudste eerst)', () => {
  const { db, anna } = world();
  const ins = db.prepare("INSERT INTO activity (project_id, at, actor_id, kind) VALUES (?, ?, ?, 'task_added')");
  const old = new Date(Date.now() - (ACTIVITY_RETENTION_DAYS + 1) * 86_400_000).toISOString();
  ins.run(P, old, anna.id);
  assert.equal(pruneActivity(db), 1);
  db.exec('BEGIN');
  for (let i = 0; i < MAX_ACTIVITY_PER_PROJECT + 5; i++) ins.run(P, new Date().toISOString(), anna.id);
  db.exec('COMMIT');
  const count = () => Number((db.prepare('SELECT COUNT(*) AS n FROM activity WHERE project_id = ?').get(P) as Row).n);
  const oldest = () => Number((db.prepare('SELECT MIN(seq) AS s FROM activity WHERE project_id = ?').get(P) as Row).s);
  const firstBefore = oldest();
  run(db, anna, [cmd('task_add', { project_id: P, content: 'Nog één' })]); // een verzoek dat het logboek laat groeien, ruimt daarna op
  assert.equal(count(), MAX_ACTIVITY_PER_PROJECT);
  assert.ok(oldest() > firstBefore, 'de oudste regels gingen weg');
  assert.equal(capProjects(db, [P], 10), MAX_ACTIVITY_PER_PROJECT - 10);
  assert.equal(count(), 10);
});

test('over HTTP: alleen voor wie het project nu ziet (ook een lezer), bladeren met before en limit, filteren op soort', async () => {
  const { db, anna, bram, carol } = world();
  const dave = addUser(db, 'dave', 'Dave');
  for (let i = 0; i < 7; i++) run(db, bram, [cmd('task_add', { id: `task-act-${String(i).padStart(6, '0')}`, project_id: P, content: `Taak ${i}` })]);
  run(db, bram, [cmd('comment_add', { task_id: 'task-act-000000', content: 'x' })]);
  const app = createApp({ db });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const token = (u: UserRow) => createSession(db, u.id, 'test').token;
  const get = async (u: UserRow | null, path: string, method = 'GET') => {
    const res = await fetch(`${base}${path}`, { method, headers: u ? { Authorization: `Bearer ${token(u)}` } : {} });
    return { status: res.status, body: await res.json() as Row, cache: res.headers.get('cache-control') };
  };
  try {
    const first = await get(carol, `/api/v1/projects/${P}/activity?limit=3`);
    assert.equal(first.status, 200, 'een lezer leest het logboek');
    assert.equal(first.cache, 'no-store');
    assert.deepEqual(first.body.entries.map((e: Row) => e.kind), ['comment_added', 'task_added', 'task_added']);
    assert.equal(first.body.next, first.body.entries[2].id);
    const second = await get(anna, `/api/v1/projects/${P}/activity?limit=3&before=${first.body.next}`);
    assert.deepEqual(second.body.entries.map((e: Row) => e.title), ['Taak 4', 'Taak 3', 'Taak 2']);
    const rest = await get(anna, `/api/v1/projects/${P}/activity?before=${second.body.next}`);
    assert.deepEqual(rest.body.entries.map((e: Row) => e.kind), ['task_added', 'task_added', 'member_added', 'member_added', 'project_created']);
    assert.equal(rest.body.next, null, 'het einde');
    const filtered = await get(anna, `/api/v1/projects/${P}/activity?kinds=member_added,project_created`);
    assert.deepEqual(filtered.body.entries.map((e: Row) => e.kind), ['member_added', 'member_added', 'project_created']);
    for (const [u, path, code] of [
      [null, `/api/v1/projects/${P}/activity`, 401], [dave, `/api/v1/projects/${P}/activity`, 404], [anna, '/api/v1/projects/project-bestaat-niet/activity', 404],
      [anna, '/api/v1/projects/%2e%2e/activity', 404], [anna, `/api/v1/projects/${P}`, 404], [anna, `/api/v1/projects/${P}/activity/extra`, 404],
      [anna, `/api/v1/projects/${P}/activity?limit=0`, 400], [anna, `/api/v1/projects/${P}/activity?limit=101`, 400], [anna, `/api/v1/projects/${P}/activity?before=abc`, 400],
      [anna, `/api/v1/projects/${P}/activity?kinds=task_added,iets`, 400],
    ] as [UserRow | null, string, number][]) {
      assert.equal((await get(u, path)).status, code, path);
    }
    assert.equal((await get(anna, `/api/v1/projects/${P}/activity`, 'POST')).status, 405);
    // een oud-lid ziet het niet meer
    run(db, carol, [cmd('project_leave', { project_id: P })]);
    const gone = await get(carol, `/api/v1/projects/${P}/activity`);
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error_code, 'NOT_FOUND');
    assert.ok(ACTIVITY_KINDS.includes('member_left'));
  } finally {
    await app.close();
  }
});
