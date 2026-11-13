// Grenzen en randgevallen van de sync-engine die uit de beveiligingsaudit kwamen:
//  - verwijderde rijen gaan nooit met hun inhoud naar iemand die er niet bij was;
//  - de limiet van SQLite voor gebonden waarden (32766) mag geen enkele beheeractie of sync laten mislukken;
//  - een taak die naar een ander project verhuist, brengt zijn opmerkingen en herinneringen mee voor bestaande leden;
//  - het verhuis-logboek wordt opgeruimd, en een te oud token dwingt een volledige sync af;
//  - een herhaling zonder volgende datum maakt geen taak die niet meer af te vinken is;
//  - een foute DEFAULT_TIMEZONE geeft bij het opstarten een duidelijke fout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { handleSync, pruneTaskMoves, TASK_MOVES_RETENTION_DAYS } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { createPush } from './push.ts';
import { addUser, freshDb } from './testutil.ts';
import type { UserRow } from './users.ts';
import { nextOccurrence } from '../shared/recurrence.js';

type Row = Record<string, any>;
let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `rb-${String(++n).padStart(10, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[], token = '*', resources?: string[]): SyncResponse =>
  handleSync(db, { sync_token: token, commands, ...(resources ? { resource_types: resources } : {}) }, as.id);
const ok = (res: SyncResponse, ...cs: Command[]) => { for (const c of cs) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`); };
const rows = (res: SyncResponse, k: string): Row[] => res[k] as Row[];

function world() {
  const db = freshDb();
  return { db, alice: addUser(db, 'alice'), bob: addUser(db, 'bob'), carol: addUser(db, 'carol') };
}

const NOW = '2026-01-01T00:00:00.000Z';
const idn = (p: string, i: number) => `${p}${String(i).padStart(10, '0')}`;
function bulkTasks(db: DatabaseSync, projectId: string, count: number, creator: string, labelsOf?: (i: number) => string[], prefix = 'bk'): void {
  const ins = db.prepare(
    `INSERT INTO tasks (id, project_id, section_id, parent_id, content, description, priority, labels, due, deadline, duration, assignee_id, creator_id, checked, completed_at, completed_count, is_collapsed, order_key, rev, is_deleted, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, 'x', '', 4, ?, NULL, NULL, NULL, NULL, ?, 0, NULL, 0, 0, ?, (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'rev'), 0, '${NOW}', '${NOW}')`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) ins.run(idn(prefix, i), projectId, JSON.stringify(labelsOf?.(i) ?? []), creator, `a${i.toString(36)}`);
  db.exec('COMMIT');
}

// ---------- verwijderde rijen ----------

test('een lid dat opnieuw wordt toegevoegd krijgt van verwijderde taken uit zijn afwezigheid alleen {id, is_deleted}, nooit de inhoud', () => {
  const { db, alice, carol } = world();
  const setup = [cmd('project_add', { id: 'projShared00001', name: 'Gedeeld' }), cmd('project_share', { project_id: 'projShared00001', username: 'carol' })];
  ok(run(db, alice, setup), ...setup);
  const token = run(db, carol, []).sync_token;
  const un = cmd('project_unshare', { project_id: 'projShared00001', user_id: carol.id });
  ok(run(db, alice, [un]), un);
  const away = [
    cmd('task_add', { id: 'taskSecret00001', project_id: 'projShared00001', content: 'GEHEIM-ONDERWERP', description: 'GEHEIM-BESCHRIJVING' }),
    cmd('comment_add', { id: 'commSecret00001', task_id: 'taskSecret00001', content: 'GEHEIM-OPMERKING' }),
    cmd('task_add', { id: 'taskStays000001', project_id: 'projShared00001', content: 'BLIJFT' }),
  ];
  ok(run(db, alice, away), ...away);
  const del = cmd('task_delete', { id: 'taskSecret00001' });
  ok(run(db, alice, [del]), del);
  const back = cmd('project_share', { project_id: 'projShared00001', username: 'carol' });
  ok(run(db, alice, [back]), back);

  const res = run(db, carol, [], token);
  assert.ok(!JSON.stringify(res).includes('GEHEIM'), 'geen inhoud van wat tijdens zijn afwezigheid is gemaakt en verwijderd');
  const secret = rows(res, 'tasks').find((t) => t.id === 'taskSecret00001');
  assert.deepEqual(secret, { id: 'taskSecret00001', is_deleted: true }, 'wel een tombstone, zodat een client die er nog iets van heeft het kan opruimen');
  assert.equal(rows(res, 'tasks').find((t) => t.id === 'taskStays000001')?.content, 'BLIJFT', 'wat bleef bestaan komt gewoon mee');
  assert.deepEqual(rows(res, 'comments').filter((c) => c.id === 'commSecret00001'), [{ id: 'commSecret00001', is_deleted: true }]);
});

test('een lid dat voor het eerst wordt toegevoegd hoort niets over verwijderde rijen van vóór zijn komst, ook geen id', () => {
  const { db, alice, bob, carol } = world();
  ok(run(db, alice, [cmd('project_add', { id: 'projShared00001', name: 'Gedeeld' })]));
  const token = run(db, bob, []).sync_token; // bob heeft een token van vóór er iets in het project gebeurde en vóór hij lid werd
  const early = [cmd('task_add', { id: 'taskGone0000001', project_id: 'projShared00001', content: 'GEHEIM-WEG' }), cmd('comment_add', { id: 'commGone0000001', task_id: 'taskGone0000001', content: 'GEHEIM-OPM' })];
  ok(run(db, alice, early), ...early);
  const del = cmd('task_delete', { id: 'taskGone0000001' });
  ok(run(db, alice, [del]), del);
  const share = cmd('project_share', { project_id: 'projShared00001', username: 'bob' });
  ok(run(db, alice, [share]), share);
  const res = run(db, bob, [], token);
  assert.ok(!JSON.stringify(res).includes('taskGone'), 'geen spoor van wat al was verwijderd voor bob lid werd');
  assert.ok(!JSON.stringify(res).includes('GEHEIM'));
  assert.ok(rows(res, 'projects').some((p) => p.id === 'projShared00001'), 'het project zelf wel');
  void carol;
});

test('een verwijdering die een lid wél mag zien, komt als {id, is_deleted} mee in de delta', () => {
  const { db, alice, bob } = world();
  const setup = [cmd('project_add', { id: 'projShared00001', name: 'Gedeeld' }), cmd('project_share', { project_id: 'projShared00001', username: 'bob' }), cmd('task_add', { id: 'taskDel00000001', project_id: 'projShared00001', content: 'GEHEIM-INHOUD' })];
  ok(run(db, alice, setup), ...setup);
  const token = run(db, bob, []).sync_token;
  const del = cmd('task_delete', { id: 'taskDel00000001' });
  ok(run(db, alice, [del]), del);
  const res = run(db, bob, [], token);
  assert.deepEqual(rows(res, 'tasks'), [{ id: 'taskDel00000001', is_deleted: true }]);
  assert.ok(!JSON.stringify(res).includes('GEHEIM'));
});

// ---------- de limiet van gebonden waarden ----------

test('een project met meer dan 32766 taken: lid eruit halen, verlaten en verwijderen werken nog', () => {
  const { db, alice, bob } = world();
  const setup = [cmd('project_add', { id: 'projBig00000001', name: 'Groot' }), cmd('project_share', { project_id: 'projBig00000001', username: 'bob' }), cmd('project_add', { id: 'projBig00000002', name: 'Groot 2' }), cmd('project_share', { project_id: 'projBig00000002', username: 'bob' })];
  ok(run(db, alice, setup), ...setup);
  bulkTasks(db, 'projBig00000001', 33_000, bob.id);
  bulkTasks(db, 'projBig00000002', 33_000, bob.id, undefined, 'bl');
  const un = cmd('project_unshare', { project_id: 'projBig00000001', user_id: bob.id });
  ok(run(db, alice, [un], '*', ['settings']), un);
  const leave = cmd('project_leave', { project_id: 'projBig00000002' });
  ok(run(db, bob, [leave], '*', ['settings']), leave);
  const del = cmd('project_delete', { id: 'projBig00000001' });
  ok(run(db, alice, [del], '*', ['settings']), del);
  const left = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'projBig00000001' AND is_deleted = 0").get() as Row;
  assert.equal(left.n, 0, 'alle taken zijn verwijderd');
});

test('een taak met meer dan 32766 subtaken: afvinken en verhuizen werken nog', () => {
  const { db, alice } = world();
  const setup = [cmd('project_add', { id: 'projBig00000001', name: 'Groot' }), cmd('project_add', { id: 'projBig00000002', name: 'Doel' }), cmd('task_add', { id: 'taskParent00001', project_id: 'projBig00000001', content: 'ouder' })];
  ok(run(db, alice, setup), ...setup);
  const ins = db.prepare(
    `INSERT INTO tasks (id, project_id, section_id, parent_id, content, description, priority, labels, due, deadline, duration, assignee_id, creator_id, checked, completed_at, completed_count, is_collapsed, order_key, rev, is_deleted, created_at, updated_at)
     VALUES (?, 'projBig00000001', NULL, 'taskParent00001', 'x', '', 4, '[]', NULL, NULL, NULL, NULL, ?, 0, NULL, 0, 0, ?, 1, 0, '${NOW}', '${NOW}')`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < 33_000; i++) ins.run(idn('sub', i), alice.id, `a${i.toString(36)}`);
  db.exec('COMMIT');
  const mv = cmd('task_move', { id: 'taskParent00001', project_id: 'projBig00000002' });
  ok(run(db, alice, [mv], '*', ['settings']), mv);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'projBig00000002'").get() as Row).n, 33_001);
  const done = cmd('task_complete', { id: 'taskParent00001' });
  ok(run(db, alice, [done], '*', ['settings']), done);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'projBig00000002' AND checked = 1").get() as Row).n, 33_001);
});

test('meer dan 32766 verschillende labels op gewijzigde taken in een gedeeld project: de incrementele sync van een ander lid werkt', () => {
  const { db, alice, bob } = world();
  const setup = [cmd('project_add', { id: 'projShared00001', name: 'Gedeeld' }), cmd('project_share', { project_id: 'projShared00001', username: 'bob' })];
  ok(run(db, alice, setup), ...setup);
  const token = run(db, alice, []).sync_token;
  const L = 33_000;
  db.exec("UPDATE meta SET value = CAST(value AS INTEGER) + 5 WHERE key = 'rev'"); // alles hieronder krijgt een versienummer na het token
  const insL = db.prepare(`INSERT INTO labels (id, name, color, order_key, is_favorite, owner_id, rev, is_deleted, created_at, updated_at) VALUES (?, ?, 'charcoal', ?, 0, ?, (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'rev'), 0, '${NOW}', '${NOW}')`);
  db.exec('BEGIN');
  for (let i = 0; i < L; i++) insL.run(idn('lb', i), `l${i}`, `a${i.toString(36)}`, bob.id);
  db.exec('COMMIT');
  bulkTasks(db, 'projShared00001', Math.ceil(L / 50), bob.id, (j) => Array.from({ length: 50 }, (_, k) => j * 50 + k).filter((x) => x < L).map((x) => idn('lb', x)));
  const res = run(db, alice, [], token);
  assert.equal(res.full_sync, false);
  assert.equal(rows(res, 'labels').length, L, 'alle labels van de gewijzigde taken zijn zichtbaar voor alice');
  assert.equal(rows(res, 'tasks').length, Math.ceil(L / 50));
});

// ---------- verhuizen ----------

test('een taak die naar een project van een bestaand lid verhuist, brengt zijn opmerkingen en eigen herinneringen mee in de delta', () => {
  const { db, alice, carol } = world();
  const setup = [cmd('project_add', { id: 'projShared00001', name: 'Gedeeld' }), cmd('project_share', { project_id: 'projShared00001', username: 'carol' })];
  ok(run(db, alice, setup), ...setup);
  const mine = [
    cmd('project_add', { id: 'projCarol000001', name: 'Prive' }),
    cmd('task_add', { id: 'taskCarol000001', project_id: 'projCarol000001', content: 't', due: { date: '2030-01-01T10:00' } }),
    cmd('comment_add', { id: 'commCarol000001', task_id: 'taskCarol000001', content: 'opmerking' }),
    cmd('reminder_add', { id: 'remCarol000001', task_id: 'taskCarol000001', type: 'relative', minute_offset: 5 }),
  ];
  ok(run(db, carol, mine), ...mine);
  const tokenAlice = run(db, alice, []).sync_token;
  const tokenCarol = run(db, carol, []).sync_token;
  const mv = cmd('task_move', { id: 'taskCarol000001', project_id: 'projShared00001' });
  ok(run(db, carol, [mv]), mv);
  const a = run(db, alice, [], tokenAlice);
  assert.deepEqual(rows(a, 'tasks').map((t) => t.id), ['taskCarol000001']);
  assert.deepEqual(rows(a, 'comments').map((c) => c.id), ['commCarol000001'], 'de opmerking bij de verhuisde taak komt mee');
  assert.deepEqual(rows(a, 'reminders'), [], 'de herinnering van carol is van carol, niet van alice');
  const c = run(db, carol, [], tokenCarol);
  assert.deepEqual(rows(c, 'reminders').map((r) => r.id), ['remCarol000001'], 'carol zelf krijgt haar herinnering mee');
  // en een lid van het oude project dat het nieuwe niet ziet, hoort dat de taak weg is
  const back = cmd('task_move', { id: 'taskCarol000001', project_id: 'projCarol000001' });
  ok(run(db, carol, [back]), back);
  const gone = run(db, alice, [], a.sync_token);
  assert.deepEqual(rows(gone, 'tasks'), [{ id: 'taskCarol000001', is_deleted: true }]);
});

test('het verhuis-logboek wordt opgeruimd; een token van vóór het opgeruimde deel dwingt een volledige sync af', () => {
  const { db, alice, bob } = world();
  const setup = [
    cmd('project_add', { id: 'projShared00001', name: 'Gedeeld' }), cmd('project_share', { project_id: 'projShared00001', username: 'bob' }),
    cmd('project_add', { id: 'projAlice000001', name: 'Prive' }), cmd('task_add', { id: 'taskMoved000001', project_id: 'projShared00001', content: 't' }),
  ];
  ok(run(db, alice, setup), ...setup);
  const oldToken = run(db, bob, []).sync_token;
  const mv = cmd('task_move', { id: 'taskMoved000001', project_id: 'projAlice000001' });
  ok(run(db, alice, [mv]), mv);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM task_moves').get() as Row).n, 1);
  assert.equal(pruneTaskMoves(db), 0, 'een verse regel blijft staan');
  const t = Date.now() + (TASK_MOVES_RETENTION_DAYS + 1) * 86_400_000;
  assert.equal(pruneTaskMoves(db, t), 1, 'na de bewaartermijn gaat de regel weg');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM task_moves').get() as Row).n, 0);
  const res = run(db, bob, [], oldToken);
  assert.equal(res.full_sync, true, 'bob kan niet meer weten dat de taak is verhuisd: opnieuw beginnen');
  assert.ok(!rows(res, 'tasks').some((x) => x.id === 'taskMoved000001'), 'en de volledige sync toont de taak niet meer');
  const fresh = run(db, bob, [], res.sync_token);
  assert.equal(fresh.full_sync, false, 'een actueel token werkt daarna gewoon');
});

// ---------- herhalingen en tijdzone ----------

test('nextOccurrence geeft null als de volgende datum buiten het bereik valt; de taak wordt dan gewoon afgevinkt', () => {
  assert.equal(nextOccurrence('9999-12-31', { freq: 'daily' }), null);
  assert.equal(nextOccurrence('9999-06-01', { freq: 'yearly' }), null);
  assert.equal(nextOccurrence('9999-12-31T10:00', { freq: 'monthly' }), null);
  assert.equal(nextOccurrence('9999-12-25', { freq: 'weekly' }), null);
  assert.equal(nextOccurrence('9999-12-30', { freq: 'daily' }), '9999-12-31', 'tot en met 9999-12-31 gewoon');
  const { db, alice } = world();
  const cs = [cmd('task_add', { id: 'taskLimit00001', project_id: alice.inbox_project_id, content: 'laatste keer', due: { date: '9999-12-31', recurrence: { freq: 'daily' } } })];
  ok(run(db, alice, cs), ...cs);
  const done = cmd('task_complete', { id: 'taskLimit00001' });
  ok(run(db, alice, [done], '*', ['tasks']), done);
  const task = rows(run(db, alice, [], '*', ['tasks']), 'tasks').find((x) => x.id === 'taskLimit00001')!;
  assert.equal(task.checked, true, 'afgevinkt in plaats van een ongeldige datum');
  assert.equal(task.due.date, '9999-12-31');
  assert.equal(task.completed_count, 1);
  const again = cmd('task_uncomplete', { id: 'taskLimit00001' });
  ok(run(db, alice, [again]), again);
});

test('een foute DEFAULT_TIMEZONE geeft bij het opstarten een duidelijke fout', () => {
  const db = freshDb();
  assert.throws(() => createPush({ db, defaultTimeZone: 'Europa/Amsterdam' }), /DEFAULT_TIMEZONE "Europa\/Amsterdam"/);
  assert.doesNotThrow(() => createPush({ db, defaultTimeZone: 'Europe/Amsterdam' }));
  assert.doesNotThrow(() => createPush({ db }));
  const main = fileURLToPath(new URL('./main.ts', import.meta.url));
  const r = spawnSync(process.execPath, [main], { env: { ...process.env, DB_PATH: ':memory:', PORT: '0', DEFAULT_TIMEZONE: 'Europa/Amsterdam' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /DEFAULT_TIMEZONE "Europa\/Amsterdam" is geen bekende tijdzone/);
});
