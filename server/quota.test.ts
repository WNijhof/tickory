// Limieten per gebruiker en per project (limits.ts), het aantal apparaten, en dat toevoegen niet trager wordt naarmate een lijst groeit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { LIMITS } from './limits.ts';
import { addUser, freshDb } from './testutil.ts';
import { createSession, findSession } from './users.ts';
import type { UserRow } from './users.ts';

type Row = Record<string, any>;
let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `qt-${String(++n).padStart(10, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[], resources: string[] = ['settings']): SyncResponse =>
  handleSync(db, { sync_token: '*', commands, resource_types: resources }, as.id);
const code = (res: SyncResponse, c: Command): string => { const s = res.sync_status[c.uuid]; return s === 'ok' ? 'ok' : (s as Row).error_code; };
const ok = (res: SyncResponse, ...cs: Command[]) => { for (const c of cs) assert.equal(code(res, c), 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`); };
const idn = (p: string, i: number) => `${p}${String(i).padStart(8, '0')}`;

/** Zet een grens tijdelijk lager en herstelt hem daarna. */
function withLimit<K extends keyof typeof LIMITS>(name: K, value: number, body: () => void): void {
  const before = LIMITS[name];
  LIMITS[name] = value;
  try { body(); } finally { LIMITS[name] = before; }
}

test('de standaardgrenzen staan vast en zijn ruim genoeg voor persoonlijk gebruik', () => {
  assert.deepEqual(LIMITS, {
    projectsPerUser: 500, sectionsPerProject: 200, tasksPerProject: 10_000, tasksPerUser: 50_000, labelsPerUser: 500, filtersPerUser: 200,
    commentsPerParent: 500, attachmentsPerTask: 20, remindersPerTask: 20, remindersPerUser: 5_000, membersPerProject: 100, placesPerUser: 100, templatesPerUser: 100, tasksPerTemplate: 1_000, sessionsPerUser: 20, sseConnectionsPerUser: 20,
  });
});

test('taken: per project en per gebruiker; andere projecten en andere gebruikers blijven ongemoeid; verwijderen geeft ruimte terug', () => {
  const db = freshDb();
  const alice = addUser(db, 'alice'); const bob = addUser(db, 'bob');
  const setup = [cmd('project_add', { id: 'projectOne0001', name: 'Een' }), cmd('project_add', { id: 'projectTwo0001', name: 'Twee' }), cmd('project_share', { project_id: 'projectOne0001', username: 'bob' })];
  ok(run(db, alice, setup), ...setup);
  withLimit('tasksPerProject', 3, () => {
    const adds = Array.from({ length: 5 }, (_, i) => cmd('task_add', { id: idn('taskA', i), project_id: 'projectOne0001', content: `t${i}` }));
    const res = run(db, alice, adds);
    assert.deepEqual(adds.map((c) => code(res, c)), ['ok', 'ok', 'ok', 'LIMIT_REACHED', 'LIMIT_REACHED'], 'binnen één verzoek tellen de toevoegingen mee');
    assert.match(((res.sync_status[adds[3].uuid] as Row).error as string), /taken per project/);
    const other = cmd('task_add', { id: 'taskOther0001', project_id: 'projectTwo0001', content: 'ander project' });
    ok(run(db, alice, [other]), other);
    const member = cmd('task_add', { id: 'taskBobs00001', project_id: 'projectOne0001', content: 'van bob' });
    assert.equal(code(run(db, bob, [member]), member), 'LIMIT_REACHED', 'de grens geldt voor het project, ook voor een lid');
    const del = cmd('task_delete', { id: idn('taskA', 0) });
    const again = cmd('task_add', { id: 'taskAgain0001', project_id: 'projectOne0001', content: 'weer ruimte' });
    ok(run(db, alice, [del, again]), del, again);
  });
  withLimit('tasksPerUser', 2, () => {
    const mine = Array.from({ length: 4 }, (_, i) => cmd('task_add', { id: idn('taskU', i), project_id: alice.inbox_project_id, content: `u${i}` }));
    const res = run(db, alice, mine);
    assert.ok(mine.some((c) => code(res, c) === 'LIMIT_REACHED'));
    const bobs = cmd('task_add', { id: 'taskBobOwn001', project_id: bob.inbox_project_id, content: 'bob heeft eigen ruimte' });
    ok(run(db, bob, [bobs]), bobs);
  });
});

test('secties, projecten, labels, filters, opmerkingen, herinneringen en leden hebben een grens', () => {
  const db = freshDb();
  const alice = addUser(db, 'alice'); addUser(db, 'bob'); addUser(db, 'carol');
  const setup = [cmd('project_add', { id: 'projectOne0001', name: 'Een' }), cmd('task_add', { id: 'taskOne000001', project_id: 'projectOne0001', content: 't' })];
  ok(run(db, alice, setup), ...setup);
  const limited = (name: keyof typeof LIMITS, value: number, make: (i: number) => Command) => withLimit(name, value, () => {
    const cs = Array.from({ length: value + 2 }, (_, i) => make(i));
    const res = run(db, alice, cs);
    const codes = cs.map((c) => code(res, c));
    assert.equal(codes.filter((c) => c === 'ok').length <= value, true, `${name}: ${codes.join(',')}`);
    assert.ok(codes.includes('LIMIT_REACHED'), `${name}: ${codes.join(',')}`);
    assert.equal(codes.at(-1), 'LIMIT_REACHED', name);
  });
  limited('sectionsPerProject', 2, (i) => cmd('section_add', { id: idn('sect', i), project_id: 'projectOne0001', name: `s${i}` }));
  limited('projectsPerUser', 3, (i) => cmd('project_add', { id: idn('proj', i), name: `p${i}` })); // de Inbox en project Een tellen mee
  limited('labelsPerUser', 2, (i) => cmd('label_add', { id: idn('labl', i), name: `l${i}` }));
  limited('filtersPerUser', 2, (i) => cmd('filter_add', { id: idn('filt', i), name: `f${i}`, query: 'p1' }));
  limited('commentsPerParent', 2, (i) => cmd('comment_add', { id: idn('comm', i), task_id: 'taskOne000001', content: `c${i}` }));
  limited('commentsPerParent', 2, (i) => cmd('comment_add', { id: idn('cmpr', i), project_id: 'projectOne0001', content: `c${i}` }));
  limited('remindersPerTask', 2, (i) => cmd('reminder_add', { id: idn('remt', i), task_id: 'taskOne000001', type: 'relative', minute_offset: i }));
  withLimit('remindersPerUser', 3, () => {
    const t2 = cmd('task_add', { id: 'taskTwo000001', project_id: 'projectOne0001', content: 'twee' });
    ok(run(db, alice, [t2]), t2);
    const cs = Array.from({ length: 4 }, (_, i) => cmd('reminder_add', { id: idn('remu', i), task_id: 'taskTwo000001', type: 'relative', minute_offset: 100 + i }));
    assert.equal(code(run(db, alice, cs), cs[3]), 'LIMIT_REACHED');
  });
  withLimit('membersPerProject', 2, () => {
    const a = cmd('project_share', { project_id: 'projectOne0001', username: 'bob' });
    const b = cmd('project_share', { project_id: 'projectOne0001', username: 'carol' });
    const res = run(db, alice, [a, b]);
    assert.deepEqual([code(res, a), code(res, b)], ['ok', 'LIMIT_REACHED'], 'eigenaar en bob zijn twee leden');
  });
});

test('herinneringen van een ander tellen niet mee voor jouw grens', () => {
  const db = freshDb();
  const alice = addUser(db, 'alice'); const bob = addUser(db, 'bob');
  const setup = [cmd('project_add', { id: 'projectOne0001', name: 'Een' }), cmd('project_share', { project_id: 'projectOne0001', username: 'bob' }), cmd('task_add', { id: 'taskOne000001', project_id: 'projectOne0001', content: 't' })];
  ok(run(db, alice, setup), ...setup);
  withLimit('remindersPerTask', 1, () => {
    const a = cmd('reminder_add', { id: 'remAlice00001', task_id: 'taskOne000001', type: 'relative', minute_offset: 5 });
    const b = cmd('reminder_add', { id: 'remBob0000001', task_id: 'taskOne000001', type: 'relative', minute_offset: 5 });
    ok(run(db, alice, [a]), a);
    ok(run(db, bob, [b]), b);
  });
});

test('apparaten: bij het inloggen op een volgend apparaat wordt het langst ongebruikte afgemeld', () => {
  const db = freshDb();
  const alice = addUser(db, 'alice'); const bob = addUser(db, 'bob');
  const bobs = createSession(db, bob.id, 'bob');
  withLimit('sessionsPerUser', 3, () => {
    const tokens = Array.from({ length: 5 }, (_, i) => createSession(db, alice.id, `apparaat${i}`).token);
    const alive = tokens.map((t) => findSession(db, t) !== null);
    assert.deepEqual(alive, [false, false, true, true, true], 'de twee oudste zijn afgemeld');
    assert.ok(findSession(db, bobs.token), 'sessies van een ander blijven');
  });
});

test('een nieuwe taak toevoegen wordt niet trager naarmate de lijst groeit (index op de volgorde)', () => {
  const db = freshDb();
  const alice = addUser(db, 'alice');
  ok(run(db, alice, [cmd('project_add', { id: 'projectBig0001', name: 'Groot' })]));
  const ins = db.prepare(
    `INSERT INTO tasks (id, project_id, section_id, parent_id, content, description, priority, labels, due, deadline, duration, assignee_id, creator_id, checked, completed_at, completed_count, is_collapsed, order_key, rev, is_deleted, created_at, updated_at)
     VALUES (?, 'projectBig0001', NULL, NULL, 'x', '', 4, '[]', NULL, NULL, NULL, NULL, NULL, 0, NULL, 0, 0, ?, 1, 0, 't', 't')`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < 30_000; i++) ins.run(idn('bulk', i), `a${i.toString(36).padStart(5, '0')}`);
  db.exec('COMMIT');
  const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT MAX(order_key) AS k FROM tasks WHERE is_deleted = 0 AND project_id = ? AND section_id IS ? AND parent_id IS ?").all('projectBig0001', null, null) as Row[]).map((r) => r.detail).join(' | ');
  assert.match(plan, /USING (COVERING )?INDEX tasks_order/, plan);
  assert.doesNotMatch(plan, /SCAN tasks/, plan);
  const adds = Array.from({ length: 100 }, (_, i) => cmd('task_add', { id: idn('newt', i), project_id: 'projectBig0001', content: `nieuw ${i}` }));
  withLimit('tasksPerProject', 1_000_000, () => { // 30000 taken is boven de echte grens; hier gaat het om de snelheid
    const t0 = performance.now();
    const res = run(db, alice, adds);
    const ms = performance.now() - t0;
    ok(res, ...adds);
    assert.ok(ms < 1500, `100 taken toevoegen aan een project met 30000 taken kostte ${ms.toFixed(0)} ms`);
  });
});

test('te diep genest JSON in een argument geeft INVALID_ARG in plaats van een interne fout', () => {
  const db = freshDb();
  const alice = addUser(db, 'alice');
  let deep: unknown = 1;
  for (let i = 0; i < 100_000; i++) deep = { a: deep };
  const bad = cmd('task_add', { id: 'taskDeep000001', project_id: alice.inbox_project_id, content: 'x', due: deep });
  const res = run(db, alice, [bad]);
  assert.equal(code(res, bad), 'INVALID_ARG');
  assert.match((res.sync_status[bad.uuid] as Row).error, /te diep genest/);
  let nested: unknown = 'x';
  for (let i = 0; i < 20_000; i++) nested = [nested];
  const arr = cmd('task_add', { id: 'taskDeep000002', project_id: alice.inbox_project_id, content: 'x', labels: nested });
  assert.equal(code(run(db, alice, [arr]), arr), 'INVALID_ARG');
  const fine = cmd('task_add', { id: 'taskDeep000003', project_id: alice.inbox_project_id, content: 'x', due: { date: '2030-01-01', recurrence: { freq: 'weekly', byweekday: [1, 3] } } });
  ok(run(db, alice, [fine]), fine);
});
