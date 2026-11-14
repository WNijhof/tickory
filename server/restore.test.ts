// Verwijderen ongedaan maken: task_restore en section_restore. Rechten (in de stijl van access.test.ts), de termijn, herhalen,
// wat andere leden in de sync zien, de grenzen, en de bestanden van bijlagen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { addUser, freshDb } from './testutil.ts';
import { LIMITS, RESTORE } from './limits.ts';
import { createAttachments } from './attachments.ts';
import type { UserRow } from './users.ts';

type Row = Record<string, any>;

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `rst-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[], token = '*'): SyncResponse => handleSync(db, { sync_token: token, commands }, as.id);
const ok = (res: SyncResponse, ...cs: Command[]) => { for (const c of cs) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`); };
const err = (res: SyncResponse, c: Command, code: string) => {
  const s = res.sync_status[c.uuid];
  assert.ok(typeof s === 'object' && s.error_code === code, `${c.type}: verwacht ${code}, kreeg ${JSON.stringify(s)}`);
};
const rows = (res: SyncResponse, k: string): Row[] => res[k] as Row[];
const live = (res: SyncResponse, k: string): string[] => rows(res, k).filter((r) => !r.is_deleted).map((r) => r.id).sort();
const dead = (res: SyncResponse, k: string): string[] => rows(res, k).filter((r) => r.is_deleted).map((r) => r.id).sort();
const find = (res: SyncResponse, k: string, id: string): Row | undefined => rows(res, k).find((r) => r.id === id);

/** Alice is eigenaar van P (met sectie S), Bob is lid, Carol kent het project niet. */
function world() {
  const db = freshDb();
  const alice = addUser(db, 'alice', 'Alice');
  const bob = addUser(db, 'bob', 'Bob');
  const carol = addUser(db, 'carol', 'Carol');
  const P = 'project-gezin-01', S = 'section-week-001';
  const setup = [
    cmd('project_add', { id: P, name: 'Gezin' }), cmd('section_add', { id: S, project_id: P, name: 'Deze week' }),
    cmd('project_share', { project_id: P, username: 'bob' }),
  ];
  ok(run(db, alice, setup), ...setup);
  return { db, alice, bob, carol, P, S };
}

/** Een taak met subtaak, opmerking en herinneringen van beide leden. */
function bigTask(w: ReturnType<typeof world>) {
  const T = 'task-groot-0001', K = 'task-kind-00001', K2 = 'task-kind-00002', C = 'comment-groot-1', R = 'remind-alice-01', RB = 'remind-bob-001';
  const cs = [
    cmd('task_add', { id: T, project_id: w.P, section_id: w.S, content: 'Café reserveren: crème & ijsjes', priority: 2, due: { date: '2026-12-05T10:00' }, deadline: '2026-12-06' }),
    cmd('task_add', { id: K, project_id: w.P, parent_id: T, content: 'Bellen' }),
    cmd('task_add', { id: K2, project_id: w.P, parent_id: T, content: 'Mailen' }),
    cmd('comment_add', { id: C, task_id: T, content: 'Niet vergeten' }),
    cmd('reminder_add', { id: R, task_id: T, type: 'relative', minute_offset: 30 }),
  ];
  ok(run(w.db, w.alice, cs), ...cs);
  const rb = cmd('reminder_add', { id: RB, task_id: T, type: 'relative', minute_offset: 60 });
  ok(run(w.db, w.bob, [rb]), rb);
  return { T, K, K2, C, R, RB };
}

const ageDeleted = (db: DatabaseSync, minutes: number) => {
  const at = new Date(Date.now() - minutes * 60_000).toISOString();
  for (const t of ['tasks', 'sections', 'comments', 'attachments', 'reminders']) db.prepare(`UPDATE ${t} SET updated_at = ? WHERE is_deleted = 1`).run(at);
};

test('een verwijderde taak komt volledig terug: subtaken, opmerking en herinneringen, met dezelfde inhoud', () => {
  const w = world();
  const { T, K, K2, C, R, RB } = bigTask(w);
  const before = run(w.db, w.alice, []);
  const del = cmd('task_delete', { id: T });
  ok(run(w.db, w.alice, [del]), del);
  const gone = run(w.db, w.alice, []);
  assert.deepEqual(live(gone, 'tasks'), []);
  const restore = cmd('task_restore', { id: T });
  ok(run(w.db, w.alice, [restore]), restore);
  const after = run(w.db, w.alice, []);
  const strip = (r: Row) => { const { rev, updated_at, ...rest } = r; return rest; };
  for (const k of ['tasks', 'comments', 'reminders', 'sections']) {
    assert.deepEqual(rows(after, k).map(strip).sort((a, b) => (a.id < b.id ? -1 : 1)), rows(before, k).map(strip).sort((a, b) => (a.id < b.id ? -1 : 1)), k);
  }
  assert.deepEqual(live(after, 'tasks'), [K, K2, T].sort());
  assert.deepEqual(live(after, 'comments'), [C]);
  assert.deepEqual(live(after, 'reminders'), [R], 'alice ziet alleen haar eigen herinnering');
  const bob = run(w.db, w.bob, []);
  assert.deepEqual(live(bob, 'reminders'), [RB], 'bob krijgt zijn eigen herinnering ook terug');
  assert.equal(find(after, 'tasks', T)!.content, 'Café reserveren: crème & ijsjes');
});

test('andere leden horen de verwijdering en daarna het herstel als gewone wijziging, ook als ze het token van vóór het verwijderen hebben', () => {
  const w = world();
  const { T, K, C } = bigTask(w);
  const tokenBefore = run(w.db, w.bob, []).sync_token;
  const del = cmd('task_delete', { id: T });
  ok(run(w.db, w.alice, [del]), del);
  const mid = run(w.db, w.bob, [], tokenBefore);
  assert.deepEqual(dead(mid, 'tasks'), [K, T, 'task-kind-00002'].sort());
  assert.deepEqual(find(mid, 'tasks', T), { id: T, is_deleted: true }, 'een verwijderde taak komt zonder inhoud mee');
  const restore = cmd('task_restore', { id: T });
  ok(run(w.db, w.alice, [restore]), restore);
  const delta = run(w.db, w.bob, [], mid.sync_token);
  assert.deepEqual(live(delta, 'tasks'), [K, T, 'task-kind-00002'].sort());
  assert.equal(find(delta, 'tasks', T)!.content, 'Café reserveren: crème & ijsjes');
  assert.deepEqual(live(delta, 'comments'), [C]);
  // iemand die tussen verwijderen en herstellen niet synchroniseerde, ziet alleen het eindresultaat
  const lateral = run(w.db, w.bob, [], tokenBefore);
  assert.deepEqual(live(lateral, 'tasks'), [K, T, 'task-kind-00002'].sort());
  assert.deepEqual(dead(lateral, 'tasks'), []);
  // een nieuw apparaat (volledige sync) krijgt de taak
  assert.ok(live(run(w.db, w.bob, []), 'tasks').includes(T));
  // een gewone client die van niets wist, ziet geen spoor van tussentijdse verwijderingen van een ander project
  const carol = run(w.db, w.carol, []);
  assert.deepEqual(rows(carol, 'tasks'), []);
});

test('rechten: wie het niet mag zien krijgt NOT_FOUND, een lid alleen voor wat het zelf verwijderde, de eigenaar voor alles', () => {
  const w = world();
  const { T } = bigTask(w);
  const T2 = 'task-bobs-00001', T3 = 'task-bobs-00002';
  const add = [cmd('task_add', { id: T2, project_id: w.P, content: 'Van Bob' }), cmd('task_add', { id: T3, project_id: w.P, content: 'Ook van Bob' })];
  ok(run(w.db, w.bob, add), ...add);
  const d1 = cmd('task_delete', { id: T }), d2 = cmd('task_delete', { id: T2 }), d3 = cmd('task_delete', { id: T3 });
  ok(run(w.db, w.alice, [d1]), d1);
  ok(run(w.db, w.bob, [d2, d3]), d2, d3);
  const before = JSON.stringify(run(w.db, w.alice, []));

  // Carol is geen lid, en een onbekend id geeft hetzelfde antwoord (geen bestaansorakel)
  const c1 = cmd('task_restore', { id: T }), c2 = cmd('task_restore', { id: 'task-bestaat-niet' }), c3 = cmd('section_restore', { id: w.S });
  const rc = run(w.db, w.carol, [c1, c2, c3]);
  err(rc, c1, 'NOT_FOUND'); err(rc, c2, 'NOT_FOUND'); err(rc, c3, 'NOT_FOUND');
  assert.equal(JSON.stringify(run(w.db, w.alice, [])), before, 'niets veranderd door Carol');

  // ook een taak die niet verwijderd is, bestaat voor Carol niet (anders zou "ok" verraden dat ze bestaat)
  const liveTask = 'task-live-00001';
  ok(run(w.db, w.alice, [cmd('task_add', { id: liveTask, project_id: w.P, content: 'Nog gewoon aanwezig' })]));
  const cl = cmd('task_restore', { id: liveTask }), cs = cmd('section_restore', { id: w.S });
  const rl = run(w.db, w.carol, [cl, cs]);
  err(rl, cl, 'NOT_FOUND'); err(rl, cs, 'NOT_FOUND');

  // Bob verwijderde T2 en T3 zelf, T niet
  const b1 = cmd('task_restore', { id: T });
  err(run(w.db, w.bob, [b1]), b1, 'FORBIDDEN');
  const b2 = cmd('task_restore', { id: T2 });
  ok(run(w.db, w.bob, [b2]), b2);
  // Alice (eigenaar) mag wat Bob verwijderde terugzetten
  const a1 = cmd('task_restore', { id: T3 }), a2 = cmd('task_restore', { id: T });
  ok(run(w.db, w.alice, [a1, a2]), a1, a2);
  assert.deepEqual(live(run(w.db, w.alice, []), 'tasks').filter((x) => [T, T2, T3].includes(x)), [T, T2, T3].sort());
});

test('een taak die al terug is of nooit weg was: geen wijziging en geen fout; herhalen met hetzelfde uuid geeft dezelfde uitkomst', () => {
  const w = world();
  const { T } = bigTask(w);
  const live1 = cmd('task_restore', { id: T });
  const r0 = run(w.db, w.alice, [live1]);
  ok(r0, live1);
  assert.equal(r0.sync_token, run(w.db, w.alice, []).sync_token, 'er is niets gewijzigd (alleen het logboek)');
  const del = cmd('task_delete', { id: T });
  ok(run(w.db, w.alice, [del]), del);
  const a = cmd('task_restore', { id: T });
  const r1 = run(w.db, w.alice, [a]);
  ok(r1, a);
  const revAfter = r1.sync_token;
  const again = cmd('task_restore', { id: T });
  ok(run(w.db, w.alice, [again, a]), again, a);
  const state = JSON.stringify(rows(run(w.db, w.alice, []), 'tasks'));
  ok(run(w.db, w.alice, [cmd('task_restore', { id: T })]));
  assert.equal(JSON.stringify(rows(run(w.db, w.alice, []), 'tasks')), state);
  assert.ok(Number(revAfter) > 0);
  // en verwijderen kan daarna gewoon weer, en terugzetten ook
  const del2 = cmd('task_delete', { id: T }), back2 = cmd('task_restore', { id: T });
  ok(run(w.db, w.alice, [del2, back2]), del2, back2);
  assert.ok(live(run(w.db, w.alice, []), 'tasks').includes(T));
});

test('na de termijn is terugzetten niet meer mogelijk (CONFLICT), net binnen de termijn nog wel', () => {
  const w = world();
  const { T } = bigTask(w);
  const del = cmd('task_delete', { id: T });
  ok(run(w.db, w.alice, [del]), del);
  ageDeleted(w.db, 4);
  const early = cmd('task_restore', { id: T });
  ok(run(w.db, w.alice, [early]), early);
  const del2 = cmd('task_delete', { id: T });
  ok(run(w.db, w.alice, [del2]), del2);
  ageDeleted(w.db, 6);
  const late = cmd('task_restore', { id: T });
  err(run(w.db, w.alice, [late]), late, 'CONFLICT');
  assert.deepEqual(live(run(w.db, w.alice, []), 'tasks'), []);
  // de termijn is instelbaar (tests, beheerders)
  const keep = RESTORE.windowMs;
  try {
    RESTORE.windowMs = 10 * 60_000;
    const longer = cmd('task_restore', { id: T });
    ok(run(w.db, w.alice, [longer]), longer);
  } finally { RESTORE.windowMs = keep; }
});

test('de plek moet er nog zijn: bovenliggende taak, sectie en project', () => {
  const w = world();
  const { T, K } = bigTask(w);
  // subtaak los verwijderen en dan de hele ouder: de subtaak apart terugzetten kan niet zolang de ouder weg is
  const delT = cmd('task_delete', { id: T });
  ok(run(w.db, w.alice, [delT]), delT);
  const kid = cmd('task_restore', { id: K });
  err(run(w.db, w.alice, [kid]), kid, 'CONFLICT');
  // de sectie is intussen weg
  const delS = cmd('section_delete', { id: w.S });
  ok(run(w.db, w.alice, [delS]), delS);
  const top = cmd('task_restore', { id: T });
  err(run(w.db, w.alice, [top]), top, 'CONFLICT');
  // sectie eerst terug (de taak was al weg en blijft dat), dan de taak
  const sec = cmd('section_restore', { id: w.S }), top2 = cmd('task_restore', { id: T });
  ok(run(w.db, w.alice, [sec]), sec);
  assert.ok(!live(run(w.db, w.alice, []), 'tasks').includes(T), 'een eerder los verwijderde taak komt niet mee met de sectie');
  ok(run(w.db, w.alice, [top2]), top2);
  // het project is weg: voor niemand nog zichtbaar
  const delP = cmd('project_delete', { id: w.P });
  ok(run(w.db, w.alice, [delP]), delP);
  const gone = cmd('task_restore', { id: T }), goneS = cmd('section_restore', { id: w.S });
  const res = run(w.db, w.alice, [gone, goneS]);
  err(res, gone, 'NOT_FOUND'); err(res, goneS, 'NOT_FOUND');
});

test('wat tussentijds los werd verwijderd blijft verwijderd; wat er intussen niet meer klopt wordt rechtgezet', () => {
  const w = world();
  const { T, K, K2, C } = bigTask(w);
  const lab = cmd('label_add', { id: 'label-alice-001', name: 'thuis' }), lab2 = cmd('label_add', { id: 'label-alice-002', name: 'werk' });
  const tag = cmd('task_update', { id: T, labels: ['label-alice-001', 'label-alice-002'], assignee_id: w.bob.id });
  ok(run(w.db, w.alice, [lab, lab2, tag]), lab, lab2, tag);
  const single = cmd('task_delete', { id: K }), oneComment = cmd('comment_delete', { id: C });
  ok(run(w.db, w.alice, [single, oneComment]), single, oneComment);
  const del = cmd('task_delete', { id: T });
  ok(run(w.db, w.alice, [del]), del);
  const dropLabel = cmd('label_delete', { id: 'label-alice-002' }), unshare = cmd('project_unshare', { project_id: w.P, user_id: w.bob.id });
  ok(run(w.db, w.alice, [dropLabel, unshare]), dropLabel, unshare);
  const restore = cmd('task_restore', { id: T });
  ok(run(w.db, w.alice, [restore]), restore);
  const after = run(w.db, w.alice, []);
  assert.deepEqual(live(after, 'tasks').filter((x) => [T, K, K2].includes(x)), [K2, T].sort(), 'de los verwijderde subtaak blijft weg');
  assert.deepEqual(live(after, 'comments'), [], 'de los verwijderde opmerking blijft weg');
  assert.deepEqual(find(after, 'tasks', T)!.labels, ['label-alice-001'], 'een intussen verwijderd label komt niet terug');
  assert.equal(find(after, 'tasks', T)!.assignee_id, null, 'wie intussen uit het project is, is niet meer toegewezen');
  // de herinnering van Bob komt niet terug (hij is geen lid meer); die van Alice wel
  assert.deepEqual(live(after, 'reminders'), ['remind-alice-01']);
  const row = w.db.prepare('SELECT is_deleted FROM reminders WHERE id = ?').get('remind-bob-001') as Row;
  assert.equal(row.is_deleted, 1);
});

test('een subtaak volgt bij het terugzetten de sectie van haar ouder', () => {
  const w = world();
  const { T, K } = bigTask(w);
  const delK = cmd('task_delete', { id: K });
  ok(run(w.db, w.alice, [delK]), delK);
  const mv = cmd('task_move', { id: T, project_id: w.P, section_id: null });
  ok(run(w.db, w.alice, [mv]), mv);
  const back = cmd('task_restore', { id: K });
  ok(run(w.db, w.alice, [back]), back);
  const res = run(w.db, w.alice, []);
  assert.equal(find(res, 'tasks', K)!.section_id, null);
  assert.equal(find(res, 'tasks', K)!.parent_id, T);
});

test('een sectie komt terug met de taken die erin stonden', () => {
  const w = world();
  const { T, K, C } = bigTask(w);
  const outside = cmd('task_add', { id: 'task-buiten-0001', project_id: w.P, content: 'Buiten de sectie' });
  ok(run(w.db, w.alice, [outside]), outside);
  const del = cmd('section_delete', { id: w.S });
  ok(run(w.db, w.alice, [del]), del);
  assert.deepEqual(live(run(w.db, w.alice, []), 'tasks'), ['task-buiten-0001']);
  const bad = cmd('section_restore', { id: w.S });
  err(run(w.db, w.bob, [bad]), bad, 'FORBIDDEN');
  const back = cmd('section_restore', { id: w.S });
  ok(run(w.db, w.alice, [back]), back);
  const res = run(w.db, w.alice, []);
  assert.deepEqual(live(res, 'sections'), [w.S]);
  assert.deepEqual(live(res, 'tasks'), [K, 'task-buiten-0001', 'task-kind-00002', T].sort());
  assert.deepEqual(live(res, 'comments'), [C]);
  assert.equal(find(res, 'tasks', T)!.section_id, w.S);
});

test('de grenzen tellen mee: een volle lijst zet niets terug en laat niets half achter', () => {
  const w = world();
  const { T } = bigTask(w);
  const del = cmd('task_delete', { id: T });
  ok(run(w.db, w.alice, [del]), del);
  const keep = LIMITS.tasksPerProject;
  try {
    LIMITS.tasksPerProject = 2; // de taak met twee subtaken past niet meer (3 nodig)
    const restore = cmd('task_restore', { id: T });
    err(run(w.db, w.alice, [restore]), restore, 'LIMIT_REACHED');
    assert.deepEqual(live(run(w.db, w.alice, []), 'tasks'), [], 'niets half teruggezet');
    LIMITS.tasksPerProject = 3;
    const fits = cmd('task_restore', { id: T });
    ok(run(w.db, w.alice, [fits]), fits);
    assert.equal(live(run(w.db, w.alice, []), 'tasks').length, 3);
  } finally { LIMITS.tasksPerProject = keep; }
});

test('ongeldige argumenten', () => {
  const w = world();
  const a = cmd('task_restore', {}), b = cmd('task_restore', { id: 'a b' }), c = cmd('task_restore', { id: 'task-abcdef01', extra: 1 }), d = cmd('section_restore', { id: 5 });
  const res = run(w.db, w.alice, [a, b, c, d]);
  err(res, a, 'INVALID_ARG'); err(res, b, 'INVALID_ARG'); err(res, c, 'UNKNOWN_ARG'); err(res, d, 'INVALID_ARG');
});

test('een taak die van project is verhuisd en verwijderd wordt, kan alleen worden teruggezet door wie het nieuwe project ziet', () => {
  const w = world();
  const { T } = bigTask(w);
  const inbox = w.alice.inbox_project_id;
  const mv = cmd('task_move', { id: T, project_id: inbox }), del = cmd('task_delete', { id: T });
  ok(run(w.db, w.alice, [mv, del]), mv, del);
  const bobTry = cmd('task_restore', { id: T });
  err(run(w.db, w.bob, [bobTry]), bobTry, 'NOT_FOUND');
  const back = cmd('task_restore', { id: T });
  ok(run(w.db, w.alice, [back]), back);
  assert.equal(find(run(w.db, w.alice, []), 'tasks', T)!.project_id, inbox);
});

// ---------- bijlagen ----------

test('de bestanden van bijlagen blijven na het verwijderen van een taak nog even bewaard, en komen met de taak terug', () => {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), 'tickory-restore-'));
  try {
    const att = createAttachments(w.db, { dir, maxUploadBytes: 1000, quotaBytes: 10_000 });
    const T = 'task-bijlage-001', A = 'bijlage-restore1';
    ok(run(w.db, w.alice, [cmd('task_add', { id: T, project_id: w.P, content: 'Met bijlage' })]));
    // een geüpload en gekoppeld bestand, zoals de upload-stap het zou achterlaten
    const key = 'ab' + 'c'.repeat(30);
    mkdirSync(join(dir, 'ab'), { recursive: true });
    writeFileSync(join(dir, 'ab', key), 'inhoud');
    w.db.prepare('INSERT INTO attachment_files (id, user_id, task_id, size, sha256, mime, key, linked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
      .run(A, w.alice.id, T, 6, 'a'.repeat(64), 'text/plain', key, new Date().toISOString());
    const add = cmd('attachment_add', { id: A, task_id: T, name: 'notitie.txt', size: 6, mime: 'text/plain', sha256: 'a'.repeat(64) });
    ok(run(w.db, w.alice, [add]), add);
    const del = cmd('task_delete', { id: T });
    ok(run(w.db, w.alice, [del]), del);

    att.purgeDeleted();
    assert.ok(existsSync(join(dir, 'ab', key)), 'het bestand staat er nog');
    assert.equal((w.db.prepare('SELECT name FROM attachments WHERE id = ?').get(A) as Row).name, 'notitie.txt', 'en de gegevens ook');
    const back = cmd('task_restore', { id: T });
    ok(run(w.db, w.alice, [back]), back);
    const res = run(w.db, w.alice, []);
    assert.equal(find(res, 'attachments', A)!.name, 'notitie.txt');
    att.purgeDeleted();
    assert.ok(existsSync(join(dir, 'ab', key)), 'een teruggezette taak houdt zijn bestand');

    // verwijderen en de termijn laten verlopen: dan ruimt de eerstvolgende ronde alles op
    const del2 = cmd('task_delete', { id: T });
    ok(run(w.db, w.alice, [del2]), del2);
    att.purgeDeleted();
    assert.ok(existsSync(join(dir, 'ab', key)));
    ageDeleted(w.db, 10);
    att.purgeDeleted();
    assert.ok(!existsSync(join(dir, 'ab', key)), 'na de termijn is het bestand weg');
    assert.equal((w.db.prepare('SELECT name FROM attachments WHERE id = ?').get(A) as Row).name, '');
    const late = cmd('task_restore', { id: T });
    err(run(w.db, w.alice, [late]), late, 'CONFLICT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('een los verwijderde bijlage (taak is er nog) wordt wel meteen opgeruimd', () => {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), 'tickory-restore-'));
  try {
    const att = createAttachments(w.db, { dir, maxUploadBytes: 1000, quotaBytes: 10_000 });
    const T = 'task-bijlage-002', A = 'bijlage-restore2';
    ok(run(w.db, w.alice, [cmd('task_add', { id: T, project_id: w.P, content: 'Met bijlage' })]));
    const key = 'cd' + 'e'.repeat(30);
    mkdirSync(join(dir, 'cd'), { recursive: true });
    writeFileSync(join(dir, 'cd', key), 'inhoud');
    w.db.prepare('INSERT INTO attachment_files (id, user_id, task_id, size, sha256, mime, key, linked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
      .run(A, w.alice.id, T, 6, 'b'.repeat(64), 'text/plain', key, new Date().toISOString());
    const add = cmd('attachment_add', { id: A, task_id: T, name: 'a.txt', size: 6, mime: 'text/plain', sha256: 'b'.repeat(64) });
    const del = cmd('attachment_delete', { id: A });
    ok(run(w.db, w.alice, [add, del]), add, del);
    att.purgeDeleted();
    assert.ok(!existsSync(join(dir, 'cd', key)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('de controle bij het opstarten laat de bestanden van een zojuist verwijderde taak staan, en ruimt ze daarna wel op', () => {
  const w = world();
  const dir = mkdtempSync(join(tmpdir(), 'tickory-restore-'));
  try {
    const att = createAttachments(w.db, { dir, maxUploadBytes: 1000, quotaBytes: 10_000 });
    const T = 'task-bijlage-003', A = 'bijlage-restore3';
    ok(run(w.db, w.alice, [cmd('task_add', { id: T, project_id: w.P, content: 'Met bijlage' })]));
    const key = 'ef' + 'a'.repeat(30);
    mkdirSync(join(dir, 'ef'), { recursive: true });
    writeFileSync(join(dir, 'ef', key), 'inhoud');
    w.db.prepare('INSERT INTO attachment_files (id, user_id, task_id, size, sha256, mime, key, linked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
      .run(A, w.alice.id, T, 6, 'c'.repeat(64), 'text/plain', key, new Date().toISOString());
    const add = cmd('attachment_add', { id: A, task_id: T, name: 'c.txt', size: 6, mime: 'text/plain', sha256: 'c'.repeat(64) });
    const del = cmd('task_delete', { id: T });
    ok(run(w.db, w.alice, [add, del]), add, del);
    att.check(); // zoals bij het opstarten van de server
    assert.ok(existsSync(join(dir, 'ef', key)), 'het bestand blijft staan binnen de termijn');
    const back = cmd('task_restore', { id: T });
    ok(run(w.db, w.alice, [back]), back);
    assert.equal(find(run(w.db, w.alice, []), 'attachments', A)!.name, 'c.txt');
    const del2 = cmd('task_delete', { id: T });
    ok(run(w.db, w.alice, [del2]), del2);
    ageDeleted(w.db, 10);
    att.check();
    assert.ok(!existsSync(join(dir, 'ef', key)), 'na de termijn ruimt de controle het op');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('de grens van secties telt ook bij het terugzetten van een sectie', () => {
  const w = world();
  const del = cmd('section_delete', { id: w.S });
  ok(run(w.db, w.alice, [del]), del);
  const keep = LIMITS.sectionsPerProject;
  try {
    const fill = [cmd('section_add', { id: 'section-vul-0001', project_id: w.P, name: 'Vul' })];
    ok(run(w.db, w.alice, fill), ...fill);
    LIMITS.sectionsPerProject = 1;
    const restore = cmd('section_restore', { id: w.S });
    err(run(w.db, w.alice, [restore]), restore, 'LIMIT_REACHED');
    LIMITS.sectionsPerProject = 2;
    const fits = cmd('section_restore', { id: w.S });
    ok(run(w.db, w.alice, [fits]), fits);
  } finally { LIMITS.sectionsPerProject = keep; }
});
