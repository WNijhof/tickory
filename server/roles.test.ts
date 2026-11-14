// Rollen in een gedeeld project: eigenaar, lid (kan bewerken) en lezer (alleen lezen). Zie shared/roles.js en SPEC.md, hoofdstuk 5.
// Elke test begint met drie gebruikers: anna (eigenaar van project P), bram (lid) en carol (lezer).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { addUser, freshDb, pushDevice } from './testutil.ts';
import { createSession } from './users.ts';
import type { UserRow } from './users.ts';
import { createPush } from './push.ts';
import { createAttachments } from './attachments.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

type Row = Record<string, any>;
let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `role-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[], token = '*'): SyncResponse => handleSync(db, { sync_token: token, commands }, as.id);
const status = (res: SyncResponse, c: Command): string => {
  const s = res.sync_status[c.uuid];
  return s === 'ok' ? 'ok' : (s as { error_code: string }).error_code;
};
const ok = (res: SyncResponse, ...cs: Command[]) => { for (const c of cs) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`); };
const rows = (res: SyncResponse, k: string): Row[] => res[k] as Row[];
const find = (res: SyncResponse, k: string, id: string): Row | undefined => rows(res, k).find((r) => r.id === id);
const roleOf = (res: SyncResponse, project: string, user: UserRow) => rows(res, 'members').find((m) => m.project_id === project && m.user_id === user.id && !m.is_deleted)?.role ?? null;

const P = 'project-rol-0001', S = 'section-rol-001', T = 'task-rol-000001', T2 = 'task-rol-000002', C = 'comment-rol-001', SUB = 'project-rol-sub1';

function world() {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  const carol = addUser(db, 'carol', 'Carol');
  const setup = [
    cmd('project_add', { id: P, name: 'Gezin' }), cmd('project_add', { id: SUB, name: 'Tuin', parent_id: P }),
    cmd('section_add', { id: S, project_id: P, name: 'Deze week' }),
    cmd('task_add', { id: T, project_id: P, section_id: S, content: 'Boodschappen', due: { date: '2030-01-07', recurrence: { freq: 'weekly', byweekday: [1] } } }),
    cmd('task_add', { id: T2, project_id: P, content: 'Afwassen', assignee_id: null }),
    cmd('comment_add', { id: C, task_id: T, content: 'Vergeet de melk niet' }),
    cmd('project_share', { project_id: P, username: 'bram' }),
    cmd('project_share', { project_id: P, username: 'carol', role: 'viewer' }),
  ];
  ok(run(db, anna, setup), ...setup);
  return { db, anna, bram, carol };
}

/** Alles wat een gebruiker van de server ziet, zonder het (oplopende) token: om te vergelijken voor en na. */
const snapshot = (db: DatabaseSync, as: UserRow) => {
  const { sync_token: _t, ...rest } = run(db, as, []);
  return JSON.stringify(rest);
};
const activityCount = (db: DatabaseSync) => Number((db.prepare('SELECT COUNT(*) AS n FROM activity').get() as Row).n);

test('delen met een rol: standaard kan het nieuwe lid bewerken, als lezer alleen lezen; ook in de subprojecten; eigenaar maken kan niet', () => {
  const { db, anna, bram, carol } = world();
  const a = run(db, anna, []);
  assert.equal(roleOf(a, P, bram), 'member', 'zonder rol: kan bewerken, zoals vóór er rollen waren');
  assert.equal(roleOf(a, P, carol), 'viewer');
  assert.equal(roleOf(a, SUB, carol), 'viewer', 'het subproject waar anna eigenaar van is, krijgt dezelfde rol');
  const bad = [cmd('project_share', { project_id: P, username: 'carol', role: 'owner' }), cmd('project_share', { project_id: P, username: 'carol', role: 'lezer' }), cmd('project_share', { project_id: P, username: 'carol', role: 3 })];
  const res = run(db, anna, bad);
  for (const c of bad) assert.equal(status(res, c), 'INVALID_ARG');
  // al lid: geen wijziging (een rol wijzigen gaat met member_update)
  const again = cmd('project_share', { project_id: P, username: 'carol', role: 'member' });
  ok(run(db, anna, [again]), again);
  assert.equal(roleOf(run(db, anna, []), P, carol), 'viewer');
  // carol ziet alles van het project, en haar eigen rol
  const c = run(db, carol, []);
  assert.ok(find(c, 'projects', P) && find(c, 'sections', S) && find(c, 'tasks', T) && find(c, 'comments', C));
  assert.equal(roleOf(c, P, carol), 'viewer');
});

test('een lezer wijzigt niets aan taken, secties of het project: FORBIDDEN, en er verandert niets (ook niet in het logboek)', () => {
  const { db, anna, carol } = world();
  const before = { anna: snapshot(db, anna), carol: snapshot(db, carol), log: activityCount(db) };
  const attempts = [
    cmd('task_add', { project_id: P, content: 'Van Carol' }), cmd('task_add', { project_id: P, section_id: S, content: 'x' }),
    cmd('task_add', { project_id: P, parent_id: T, content: 'Subtaak van Carol' }),
    cmd('task_update', { id: T, content: 'x' }), cmd('task_update', { id: T, is_collapsed: true }), cmd('task_update', { id: T, assignee_id: carol.id }),
    cmd('task_delete', { id: T }), cmd('task_complete', { id: T }), cmd('task_complete', { id: T, if_due: '2030-01-07' }), cmd('task_uncomplete', { id: T }),
    cmd('task_move', { id: T, project_id: carol.inbox_project_id }), cmd('task_move', { id: T, section_id: null }), cmd('task_move', { id: T2, parent_id: T }),
    cmd('section_add', { project_id: P, name: 'Van Carol' }), cmd('section_update', { id: S, name: 'x' }), cmd('section_update', { id: S, is_collapsed: true }), cmd('section_delete', { id: S }),
    cmd('project_update', { id: P, name: 'Van Carol' }), cmd('project_update', { id: P, is_favorite: true }), cmd('project_update', { id: P, view_style: 'board' }),
    cmd('project_update', { id: P, is_archived: true }), cmd('project_update', { id: SUB, is_collapsed: true }),
    cmd('project_add', { name: 'Onder het project van Anna', parent_id: P }),
    cmd('project_delete', { id: P }), cmd('project_share', { project_id: P, username: 'bram' }), cmd('project_unshare', { project_id: P, user_id: anna.id }),
    cmd('member_update', { project_id: P, user_id: carol.id, role: 'member' }),
  ];
  const res = run(db, carol, attempts);
  for (const c of attempts) assert.equal(status(res, c), 'FORBIDDEN', `${c.type} ${JSON.stringify(c.args)}`);
  assert.equal(snapshot(db, anna), before.anna, 'anna ziet precies hetzelfde als ervoor');
  assert.equal(snapshot(db, carol), before.carol, 'carol ook');
  assert.equal(activityCount(db), before.log, 'en het logboek is niet gegroeid');
  // een eigen taak naar het project van anna verplaatsen of een eigen project eronder hangen kan ook niet
  const own = [cmd('task_add', { id: 'task-carol-0001', project_id: carol.inbox_project_id, content: 'Eigen taak' }), cmd('project_add', { id: 'project-carol-01', name: 'Eigen project' })];
  ok(run(db, carol, own), ...own);
  const before2 = { anna: snapshot(db, anna), log: activityCount(db) };
  const into = [cmd('task_move', { id: 'task-carol-0001', project_id: P }), cmd('project_update', { id: 'project-carol-01', parent_id: P })];
  const r2 = run(db, carol, into);
  for (const c of into) assert.equal(status(r2, c), 'FORBIDDEN', c.type);
  assert.equal(snapshot(db, anna), before2.anna, 'niets van anna is veranderd');
  assert.equal(activityCount(db), before2.log, 'en ook hier groeide het logboek niet');
});

test('een lezer mag wel: opmerkingen plaatsen en zijn eigen opmerkingen bewerken, eigen herinneringen zetten, en vertrekken', () => {
  const { db, anna, carol } = world();
  const mine = [
    cmd('comment_add', { id: 'comment-carol-01', task_id: T, content: 'Ik kan helaas niet' }), cmd('comment_add', { id: 'comment-carol-02', project_id: P, content: 'Leuk project' }),
    cmd('comment_update', { id: 'comment-carol-01', content: 'Ik kan toch' }), cmd('comment_delete', { id: 'comment-carol-02' }),
    cmd('reminder_add', { id: 'remind-carol-001', task_id: T, type: 'relative', minute_offset: 30 }), cmd('reminder_update', { id: 'remind-carol-001', minute_offset: 10 }),
  ];
  ok(run(db, carol, mine), ...mine);
  const others = [cmd('comment_update', { id: C, content: 'x' }), cmd('comment_delete', { id: C })];
  const r = run(db, carol, others);
  for (const c of others) assert.equal(status(r, c), 'FORBIDDEN', 'een opmerking van een ander blijft van de schrijver');
  assert.equal(find(run(db, anna, []), 'comments', 'comment-carol-01')!.content, 'Ik kan toch');
  const leave = cmd('project_leave', { project_id: P });
  ok(run(db, carol, [leave]), leave);
  const after = run(db, carol, []);
  assert.ok(!find(after, 'projects', P) && !find(after, 'projects', SUB), 'weg, ook het subproject');
  assert.equal(roleOf(run(db, anna, []), P, carol), null);
  assert.equal((db.prepare('SELECT is_deleted FROM reminders WHERE id = ?').get('remind-carol-001') as Row).is_deleted, 1, 'haar herinnering vervalt');
});

test('de eigenaar haalt een lezer eruit; een lid kan de rol van een ander niet wijzigen', () => {
  const { db, anna, bram, carol } = world();
  const asBram = [cmd('member_update', { project_id: P, user_id: carol.id, role: 'member' }), cmd('project_unshare', { project_id: P, user_id: carol.id })];
  const r = run(db, bram, asBram);
  for (const c of asBram) assert.equal(status(r, c), 'FORBIDDEN');
  const kick = cmd('project_unshare', { project_id: P, user_id: carol.id });
  ok(run(db, anna, [kick]), kick);
  const a = run(db, anna, []);
  assert.equal(roleOf(a, P, carol), null);
  assert.equal(roleOf(a, SUB, carol), null, 'ook uit het subproject');
});

test('member_update: alleen de eigenaar, niet van jezelf of een eigenaar, alleen bekende rollen; geldt ook in de subprojecten', () => {
  const { db, anna, bram, carol } = world();
  const dave = addUser(db, 'dave', 'Dave');
  const bad: [Command, string][] = [
    [cmd('member_update', { project_id: P, user_id: anna.id, role: 'viewer' }), 'CONFLICT'],
    [cmd('member_update', { project_id: P, user_id: dave.id, role: 'viewer' }), 'NOT_FOUND'],
    [cmd('member_update', { project_id: P, user_id: bram.id, role: 'owner' }), 'INVALID_ARG'],
    [cmd('member_update', { project_id: P, user_id: bram.id }), 'INVALID_ARG'],
    [cmd('member_update', { project_id: P, user_id: 'x', role: 'viewer' }), 'INVALID_ARG'],
    [cmd('member_update', { project_id: P, user_id: bram.id, role: 'viewer', kleur: 'rood' }), 'UNKNOWN_ARG'],
    [cmd('member_update', { project_id: 'project-bestaat-niet', user_id: bram.id, role: 'viewer' }), 'NOT_FOUND'],
    [cmd('member_update', { project_id: anna.inbox_project_id, user_id: bram.id, role: 'viewer' }), 'NOT_FOUND'],
  ];
  const res = run(db, anna, bad.map(([c]) => c));
  for (const [c, code] of bad) assert.equal(status(res, c), code, JSON.stringify(c.args));
  // dave ziet het project niet: voor hem bestaat het niet
  const foreign = cmd('member_update', { project_id: P, user_id: carol.id, role: 'member' });
  assert.equal(status(run(db, dave, [foreign]), foreign), 'NOT_FOUND');

  const tokenCarol = run(db, carol, []).sync_token;
  const up = cmd('member_update', { project_id: P, user_id: carol.id, role: 'member' });
  ok(run(db, anna, [up]), up);
  const a = run(db, anna, []);
  assert.equal(roleOf(a, P, carol), 'member');
  assert.equal(roleOf(a, SUB, carol), 'member', 'ook in het subproject van anna');
  const delta = run(db, carol, [], tokenCarol);
  assert.equal(roleOf(delta, P, carol), 'member', 'carol hoort het in haar volgende delta');
  const now = cmd('task_add', { id: 'task-carol-0002', project_id: P, content: 'Nu wel' });
  ok(run(db, carol, [now]), now);
  // dezelfde rol nog eens: niets te doen
  const same = cmd('member_update', { project_id: P, user_id: carol.id, role: 'member' });
  const revBefore = run(db, anna, []).sync_token;
  ok(run(db, anna, [same]), same);
  assert.equal(rows(run(db, anna, [], revBefore), 'members').length, 0, 'geen gewijzigde ledenrij');
});

test('een project van een ander onder het gedeelde project blijft buiten een rolwijziging; een nieuw subproject erft de rollen', () => {
  const { db, anna, bram, carol } = world();
  const mk = cmd('project_add', { id: 'project-bram-sub', name: 'Garage', parent_id: P });
  ok(run(db, bram, [mk]), mk);
  assert.equal(roleOf(run(db, bram, []), 'project-bram-sub', carol), 'viewer', 'een nieuw subproject krijgt de leden en rollen van het bovenliggende');
  // bram hangt een eigen project (gedeeld met carol als lezer) onder P: daar is anna geen eigenaar van
  const own = [cmd('project_add', { id: 'project-bram-eig', name: 'Fietsen' }), cmd('project_share', { project_id: 'project-bram-eig', username: 'carol', role: 'viewer' }), cmd('project_update', { id: 'project-bram-eig', parent_id: P })];
  ok(run(db, bram, own), ...own);
  const up = cmd('member_update', { project_id: P, user_id: carol.id, role: 'member' });
  ok(run(db, anna, [up]), up);
  const b = run(db, bram, []);
  assert.equal(roleOf(b, P, carol), 'member');
  assert.equal(roleOf(b, 'project-bram-sub', carol), 'member', 'anna is ook eigenaar van het subproject dat bram maakte');
  assert.equal(roleOf(b, 'project-bram-eig', carol), 'viewer', 'maar niet van het eigen project van bram');
});

test('toewijzen kan niet aan een lezer; wordt iemand lezer, dan vervallen zijn toewijzingen; een verhuisde taak verliest een toewijzing aan een lezer', () => {
  const { db, anna, bram, carol } = world();
  const toCarol = [cmd('task_update', { id: T, assignee_id: carol.id }), cmd('task_add', { project_id: P, content: 'x', assignee_id: carol.id })];
  const r = run(db, anna, toCarol);
  for (const c of toCarol) assert.equal(status(r, c), 'INVALID_ARG');
  assert.match((r.sync_status[toCarol[0].uuid] as Row).error, /alleen lezen/);
  const toBram = [cmd('task_update', { id: T, assignee_id: bram.id }), cmd('task_update', { id: T2, assignee_id: bram.id })];
  ok(run(db, anna, toBram), ...toBram);
  const tokenBram = run(db, bram, []).sync_token;
  const down = cmd('member_update', { project_id: P, user_id: bram.id, role: 'viewer' });
  ok(run(db, anna, [down]), down);
  const a = run(db, anna, []);
  assert.deepEqual([find(a, 'tasks', T)!.assignee_id, find(a, 'tasks', T2)!.assignee_id], [null, null]);
  assert.ok(rows(run(db, bram, [], tokenBram), 'tasks').some((t) => t.id === T && t.assignee_id === null), 'bram hoort het');
  // een taak die naar een project verhuist waar de toegewezene alleen leest, verliest de toewijzing
  const Q = 'project-rol-0002';
  const setup = [cmd('project_add', { id: Q, name: 'Werk' }), cmd('project_share', { project_id: Q, username: 'carol' }), cmd('task_add', { id: 'task-rol-000003', project_id: Q, content: 'Verslag', assignee_id: carol.id })];
  ok(run(db, anna, setup), ...setup);
  const mv = cmd('task_move', { id: 'task-rol-000003', project_id: P });
  ok(run(db, anna, [mv]), mv);
  assert.equal(find(run(db, anna, []), 'tasks', 'task-rol-000003')!.assignee_id, null);
});

test('bijlagen: een lezer ziet en downloadt ze, maar uploadt niet (FORBIDDEN) en koppelt of verwijdert niets', async () => {
  const { db, anna, carol } = world();
  const dir = mkdtempSync(join(tmpdir(), 'tickory-roles-'));
  try {
    const store = createAttachments(db, { dir, maxUploadBytes: 1000, quotaBytes: 5000 });
    const upload = async (as: UserRow, id: string) => {
      const body = Buffer.from('inhoud');
      const req = Object.assign(Readable.from([body]), { headers: { 'content-length': String(body.length), 'content-type': 'text/plain' } });
      Object.defineProperty(req, 'complete', { get: () => req.readableEnded });
      try { return { code: 'ok', out: await store.upload(req as never, as.id, { id, taskId: T }) }; } catch (err: any) { return { code: err.code as string, out: null }; }
    };
    const up = await upload(anna, 'attach-anna-0001');
    assert.equal(up.code, 'ok');
    const add = cmd('attachment_add', { id: 'attach-anna-0001', task_id: T, name: 'lijst.txt', size: up.out!.size, mime: up.out!.mime, sha256: up.out!.sha256 });
    ok(run(db, anna, [add]), add);
    assert.equal((await upload(carol, 'attach-carol-001')).code, 'FORBIDDEN');
    assert.ok(find(run(db, carol, []), 'attachments', 'attach-anna-0001'), 'carol ziet de bijlage');
    const del = cmd('attachment_delete', { id: 'attach-anna-0001' });
    assert.equal(status(run(db, carol, [del]), del), 'FORBIDDEN');
    // een bestand dat carol als lid had geüpload, kan ze als lezer niet meer koppelen
    db.prepare("INSERT INTO attachment_files (id, user_id, task_id, size, sha256, mime, key, linked, created_at) VALUES ('attach-carol-002', ?, ?, 5, ?, 'text/plain', 'sleutel-carol-0000000000000000000', 0, ?)")
      .run(carol.id, T, 'c'.repeat(64), new Date().toISOString());
    const link = cmd('attachment_add', { id: 'attach-carol-002', task_id: T, name: 'x.txt', size: 5, mime: 'text/plain', sha256: 'c'.repeat(64) });
    assert.equal(status(run(db, carol, [link]), link), 'FORBIDDEN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('een herinnering van een lezer komt als melding zonder de knop "Voltooien"; de knop "Over 10 minuten" werkt', async () => {
  const { db, anna, carol } = world();
  const sent: { url: string; body: Buffer }[] = [];
  const clock = { now: Date.parse('2030-01-07T07:00:00Z') };
  const fetchFn = (async (url: string, init: any) => { sent.push({ url, body: init.body }); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
  const push = createPush({ db, fetch: fetchFn, now: () => clock.now, defaultTimeZone: 'UTC' });
  const device = (user: UserRow) => {
    const d = pushDevice(user.username);
    push.subscribe(user.id, createSession(db, user.id, 'telefoon').id, d.subscription);
    return () => sent.filter((s) => s.url === d.subscription.endpoint).map((s) => JSON.parse(d.decrypt(s.body)) as Row);
  };
  const forCarol = device(carol);
  const forAnna = device(anna);
  const due = cmd('task_update', { id: T2, due: { date: '2030-01-07T08:00' } });
  ok(run(db, anna, [due]), due);
  const rc = cmd('reminder_add', { id: 'remind-carol-001', task_id: T2, type: 'relative', minute_offset: 60 });
  const ra = cmd('reminder_add', { id: 'remind-anna-0001', task_id: T2, type: 'relative', minute_offset: 60 });
  ok(run(db, carol, [rc]), rc);
  ok(run(db, anna, [ra]), ra);
  await push.tick();
  const [c] = forCarol().filter((m) => m.type === 'reminder');
  const [a] = forAnna().filter((m) => m.type === 'reminder');
  assert.equal(c.complete, null, 'een lezer krijgt geen knop om af te vinken');
  assert.equal(typeof c.snooze, 'string');
  assert.equal(typeof a.complete, 'string', 'de eigenaar wel');
  assert.deepEqual(push.handleAction(c.snooze), { ok: true, userId: carol.id });
});

test('terugzetten: een lid dat lezer werd, zet niets meer terug; een toewijzing aan wie intussen lezer is, komt niet terug', () => {
  const { db, anna, bram, carol } = world();
  // bram (lid) verwijdert een taak en een sectie; daarna maakt anna hem lezer: terugzetten kan dan niet meer
  const assign = cmd('task_update', { id: T2, assignee_id: bram.id });
  ok(run(db, anna, [assign]), assign);
  const del = [cmd('task_delete', { id: T2 }), cmd('section_delete', { id: S })];
  ok(run(db, bram, del), ...del);
  const down = cmd('member_update', { project_id: P, user_id: bram.id, role: 'viewer' });
  ok(run(db, anna, [down]), down);
  const tries = [cmd('task_restore', { id: T2 }), cmd('section_restore', { id: S })];
  const res = run(db, bram, tries);
  for (const c of tries) assert.equal(status(res, c), 'FORBIDDEN', c.type);
  const byCarol = cmd('task_restore', { id: T2 });
  assert.equal(status(run(db, carol, [byCarol]), byCarol), 'FORBIDDEN', 'een lezer zet ook niets terug');
  // de eigenaar zet de taak terug: bram is lezer en blijft dus niet toegewezen; het logboek zegt wie het terugzette
  const back = cmd('task_restore', { id: T2 });
  ok(run(db, anna, [back]), back);
  assert.equal(find(run(db, anna, []), 'tasks', T2)!.assignee_id, null);
  const last = db.prepare("SELECT kind, actor_id, task_id FROM activity WHERE project_id = ? ORDER BY seq DESC LIMIT 1").get(P) as Row;
  assert.deepEqual([last.kind, last.actor_id, last.task_id], ['task_restored', anna.id, T2]);
  const sec = cmd('section_restore', { id: S });
  ok(run(db, anna, [sec]), sec);
  assert.equal((db.prepare("SELECT kind FROM activity WHERE project_id = ? ORDER BY seq DESC LIMIT 1").get(P) as Row).kind, 'section_restored');
});

// ---------- toegangsfuzz: willekeurige wijzigingen van een lezer ----------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('toegangsfuzz: wat een lezer ook probeert aan taken, secties, bijlagen en het project, het geeft FORBIDDEN en er verandert niets', () => {
  const { db, anna, bram, carol } = world();
  // een rijker project: meer taken, subtaken, secties en een bijlage van anna
  const more: Command[] = [];
  for (let i = 0; i < 6; i++) more.push(cmd('task_add', { id: `task-fuzz-${String(i).padStart(5, '0')}`, project_id: P, content: `Taak ${i}`, ...(i > 2 ? { parent_id: 'task-fuzz-00000' } : i % 2 ? { section_id: S } : {}) }));
  more.push(cmd('section_add', { id: 'section-fuzz-02', project_id: P, name: 'Later' }));
  db.prepare("INSERT INTO attachment_files (id, user_id, task_id, size, sha256, mime, key, linked, created_at) VALUES ('attach-fuzz-0001', ?, ?, 5, ?, 'text/plain', 'sleutel-fuzz-00000000000000000000', 0, ?)").run(anna.id, T, 'd'.repeat(64), new Date().toISOString());
  more.push(cmd('attachment_add', { id: 'attach-fuzz-0001', task_id: T, name: 'a.txt', size: 5, mime: 'text/plain', sha256: 'd'.repeat(64) }));
  ok(run(db, anna, more), ...more);
  const tasks = [T, T2, ...Array.from({ length: 6 }, (_, i) => `task-fuzz-${String(i).padStart(5, '0')}`)];
  const sections = [S, 'section-fuzz-02'];
  const projects = [P, SUB];
  const before = { anna: snapshot(db, anna), bram: snapshot(db, bram), log: activityCount(db) };
  const random = rng(20261114);
  const pick = <T,>(list: T[]): T => list[Math.floor(random() * list.length)];
  const dues = [null, { date: '2030-02-01' }, { date: '2030-02-01T09:00' }];
  const builders: (() => Command)[] = [
    () => cmd('task_add', { project_id: pick(projects), content: 'x', ...(random() < 0.3 ? { section_id: S } : {}) }),
    () => cmd('task_add', { project_id: P, parent_id: pick(tasks), content: 'sub' }),
    () => cmd('task_update', { id: pick(tasks), ...pick([{ content: 'x' }, { priority: 1 }, { due: pick(dues) }, { is_collapsed: true }, { description: 'y' }, { labels: [] }, { deadline: '2030-03-01' }, { duration: 30 }, { assignee_id: pick([null, anna.id, bram.id]) }]) }),
    () => cmd('task_delete', { id: pick(tasks) }),
    () => cmd('task_complete', { id: pick(tasks) }),
    () => cmd('task_uncomplete', { id: pick(tasks) }),
    () => cmd('task_move', { id: pick(tasks), ...pick([{ project_id: pick([carol.inbox_project_id, SUB, P]) }, { section_id: pick([...sections, null]) }, { parent_id: pick([...tasks, null]) }]) }),
    () => cmd('section_add', { project_id: pick(projects), name: 'x' }),
    () => cmd('section_update', { id: pick(sections), ...pick([{ name: 'x' }, { is_collapsed: true }, { is_archived: true }]) }),
    () => cmd('section_delete', { id: pick(sections) }),
    () => cmd('project_update', { id: pick(projects), ...pick([{ name: 'x' }, { color: 'red' }, { is_favorite: true }, { is_archived: true }, { is_collapsed: true }, { view_style: 'calendar' }, { parent_id: null }]) }),
    () => cmd('project_add', { name: 'x', parent_id: pick(projects) }),
    () => cmd('project_delete', { id: pick(projects) }),
    () => cmd('attachment_delete', { id: 'attach-fuzz-0001' }),
    () => cmd('project_share', { project_id: pick(projects), username: pick(['bram', 'anna', 'carol']), ...(random() < 0.5 ? { role: pick(['member', 'viewer']) } : {}) }),
    () => cmd('project_unshare', { project_id: pick(projects), user_id: pick([anna.id, bram.id]) }),
    () => cmd('member_update', { project_id: pick(projects), user_id: pick([anna.id, bram.id, carol.id]), role: pick(['member', 'viewer']) }),
  ];
  const seen = new Set<string>();
  for (let round = 0; round < 12; round++) {
    const batch = Array.from({ length: 50 }, () => pick(builders)());
    const res = run(db, carol, batch);
    for (const c of batch) {
      seen.add(c.type);
      assert.equal(status(res, c), 'FORBIDDEN', `${c.type} ${JSON.stringify(c.args)}`);
    }
  }
  assert.equal(seen.size, 16, 'elke soort commando kwam voor');
  assert.equal(snapshot(db, anna), before.anna, 'de eigenaar ziet precies hetzelfde als vóór de pogingen');
  assert.equal(snapshot(db, bram), before.bram, 'het lid ook');
  assert.equal(activityCount(db), before.log, 'het logboek is niet gegroeid');
});
