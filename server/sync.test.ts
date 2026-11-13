import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from './schema.ts';
import { addUser, firstUser, mkdb } from './testutil.ts';
import { COMMAND_TYPES, currentRev, handleSync, newId } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';

type Row = Record<string, any>;

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `cmd-${String(++n).padStart(6, '0')}`, args });
const run = (db: DatabaseSync, commands: Command[], sync_token = '*', resource_types?: string[], as: string = firstUser(db).id): SyncResponse =>
  handleSync(db, { sync_token, commands, ...(resource_types ? { resource_types } : {}) }, as);
const ok = (res: SyncResponse, c: Command) => assert.equal(res.sync_status[c.uuid], 'ok', JSON.stringify(res.sync_status[c.uuid]));
const err = (res: SyncResponse, c: Command, code: string) => {
  const s = res.sync_status[c.uuid];
  assert.ok(typeof s === 'object' && s.error_code === code, `verwacht ${code}, kreeg ${JSON.stringify(s)}`);
};
const rows = (res: SyncResponse, k: string): Row[] => res[k] as Row[];

/** Eén project met een sectie en een taak, met vaste ids. */
function seed(db: DatabaseSync) {
  const P = 'project-aaaa1111', S = 'section-aaaa1111', T = 'task-aaaa11111';
  const cs = [cmd('project_add', { id: P, name: 'Werk' }), cmd('section_add', { id: S, project_id: P, name: 'Nu' }), cmd('task_add', { id: T, project_id: P, section_id: S, content: 'Eerste' })];
  const res = run(db, cs);
  cs.forEach((c) => ok(res, c));
  return { P, S, T, token: res.sync_token };
}

test('een nieuwe database bevat alleen de Inbox van de gebruiker; de rest is leeg', () => {
  const db = mkdb();
  const res = run(db, []);
  assert.equal(res.full_sync, true);
  assert.equal(res.sync_token, '2'); // versie 1: de Inbox uit "versie 0.1"; versie 2: het account dat die overneemt
  assert.deepEqual(rows(res, 'projects').map((p) => [p.id, p.name]), [['inbox-project', 'Inbox']]);
  assert.deepEqual(rows(res, 'members').map((m) => [m.project_id, m.user_id, m.role]), [['inbox-project', firstUser(db).id, 'owner']]);
  for (const k of ['sections', 'tasks', 'labels', 'comments', 'reminders', 'filters']) assert.deepEqual(res[k], []);
  assert.deepEqual(res.me, { id: firstUser(db).id, username: 'tester', name: 'Tester', is_admin: true, inbox_project_id: 'inbox-project' });
  assert.deepEqual(res.users, [{ id: firstUser(db).id, username: 'tester', name: 'Tester' }]);
});

test('de Inbox wordt één keer aangemaakt en is beschermd', () => {
  const db = mkdb();
  createSchema(db); // opnieuw opstarten maakt geen tweede Inbox en verhoogt de versie niet
  assert.equal(currentRev(db), 2);
  const del = cmd('project_delete', { id: 'inbox-project' });
  const sub = cmd('project_add', { id: 'project-cccc3333', name: 'Ander' });
  const move = cmd('project_update', { id: 'inbox-project', parent_id: 'project-cccc3333' });
  const arch = cmd('project_update', { id: 'inbox-project', is_archived: true });
  const rename = cmd('project_update', { id: 'inbox-project', name: 'Postvak' });
  const res = run(db, [del, sub, move, arch, rename]);
  err(res, del, 'CONFLICT');
  ok(res, sub);
  err(res, move, 'CONFLICT');
  err(res, arch, 'CONFLICT');
  ok(res, rename);
  assert.equal(rows(res, 'projects').find((p) => p.id === 'inbox-project')!.name, 'Postvak');
});

test('prioriteit: standaard 4 (geen), 1 is de hoogste', () => {
  const db = mkdb();
  const a = cmd('task_add', { id: 'task-prio-0001', project_id: 'inbox-project', content: 'Zonder' });
  const b = cmd('task_add', { id: 'task-prio-0002', project_id: 'inbox-project', content: 'Hoog', priority: 1 });
  const res = run(db, [a, b]);
  ok(res, a);
  ok(res, b);
  assert.deepEqual(rows(res, 'tasks').map((t) => t.priority).sort(), [1, 4]);
});

test('aanmaken met door de client gekozen id werkt direct, zonder temp_id-omweg', () => {
  const db = mkdb();
  const { token } = seed(db);
  const res = run(db, [], '*');
  assert.equal(rows(res, 'tasks').length, 1);
  assert.equal(rows(res, 'tasks')[0].id, 'task-aaaa11111');
  assert.equal(res.sync_token, token);
});

test('de delta bevat alleen wat na het token veranderde', () => {
  const db = mkdb();
  const { T, token } = seed(db);
  const c = cmd('task_update', { id: T, content: 'Aangepast' });
  const res = run(db, [c], token);
  ok(res, c);
  assert.equal(res.full_sync, false);
  assert.equal(rows(res, 'tasks').length, 1);
  assert.equal(rows(res, 'tasks')[0].content, 'Aangepast');
  assert.equal(rows(res, 'projects').length, 0);
  assert.equal(rows(res, 'sections').length, 0);
  // opnieuw met het nieuwe token: niets meer
  const again = run(db, [], res.sync_token);
  assert.equal(rows(again, 'tasks').length, 0);
});

test('idempotent: hetzelfde commando-uuid wordt maar één keer uitgevoerd', () => {
  const db = mkdb();
  const { P } = seed(db);
  const c = cmd('task_add', { project_id: P, content: 'Twee' });
  const first = run(db, [c]);
  const rev = currentRev(db);
  const second = run(db, [c]);
  ok(first, c);
  ok(second, c);
  assert.equal(currentRev(db), rev, 'herhaling mag geen nieuwe wijziging maken');
  assert.equal(rows(second, 'tasks').filter((t) => t.content === 'Twee').length, 1);
});

test('een herhaalde mislukking geeft dezelfde fout terug', () => {
  const db = mkdb();
  const c = cmd('task_update', { id: 'bestaat-niet-1234', content: 'x' });
  err(run(db, [c]), c, 'NOT_FOUND');
  err(run(db, [c]), c, 'NOT_FOUND');
});

test('een mislukt commando laat niets achter en breekt de rest niet af', () => {
  const db = mkdb();
  const { P } = seed(db);
  const before = currentRev(db);
  const bad = cmd('task_add', { project_id: P, content: 'x', priority: 9 });
  const good = cmd('task_add', { project_id: P, content: 'goed' });
  const res = run(db, [bad, good]);
  err(res, bad, 'INVALID_ARG');
  ok(res, good);
  assert.equal(currentRev(db), before + 1, 'alleen het geslaagde commando verhoogt het versienummer');
  assert.deepEqual(rows(res, 'tasks').map((t) => t.content).sort(), ['Eerste', 'goed']);
});

test('validatie: onbekende argumenten, ontbrekende velden, server-beheerde velden', () => {
  const db = mkdb();
  const { P } = seed(db);
  const a = cmd('task_add', { project_id: P, content: 'x', kleur: 'rood' });
  const b = cmd('task_add', { project_id: P });
  const c = cmd('task_add', { project_id: P, content: 'x', checked: true });
  const d = cmd('task_add', { project_id: P, content: '   ' });
  const e = cmd('task_add', { project_id: P, content: 'x', due: { date: '2026-02-30' } });
  const f = cmd('bestaat_niet', {});
  const res = run(db, [a, b, c, d, e, f]);
  err(res, a, 'UNKNOWN_ARG');
  err(res, b, 'MISSING_ARG');
  err(res, c, 'READONLY');
  err(res, d, 'INVALID_ARG');
  err(res, e, 'INVALID_ARG');
  err(res, f, 'UNKNOWN_COMMAND');
});

test('ongeldige verzoeken worden als geheel geweigerd', () => {
  const db = mkdb();
  assert.throws(() => handleSync(db, null, firstUser(db).id), /JSON-object/);
  assert.throws(() => handleSync(db, { sync_token: 'abc' }, firstUser(db).id), /sync_token/);
  assert.throws(() => handleSync(db, { commands: [{ type: 'x', uuid: 'kort' }] }, firstUser(db).id), /uuid/);
  assert.throws(() => handleSync(db, { resource_types: ['tasks', 'bestaat-niet'] }, firstUser(db).id), /onbekend resourcetype/);
  assert.throws(() => handleSync(db, { commands: Array.from({ length: 101 }, () => cmd('task_add')) }, firstUser(db).id), /maximaal 100/);
});

test('verwijderen cascadeert en komt als is_deleted in de delta; een volledige sync toont het niet meer', () => {
  const db = mkdb();
  const { P, S, T, token } = seed(db);
  const sub = cmd('task_add', { id: 'subtask-aaaa111', project_id: P, parent_id: T, content: 'Sub' });
  const com = cmd('comment_add', { task_id: T, content: 'Notitie' });
  const rem = cmd('reminder_add', { task_id: T, type: 'relative', minute_offset: 30 });
  const setup = run(db, [sub, com, rem], token);
  [sub, com, rem].forEach((c) => ok(setup, c));

  const del = cmd('section_delete', { id: S });
  const res = run(db, [del], setup.sync_token);
  ok(res, del);
  assert.deepEqual(rows(res, 'sections').map((s) => s.is_deleted), [true]);
  assert.equal(rows(res, 'tasks').length, 2);
  assert.ok(rows(res, 'tasks').every((t) => t.is_deleted === true));
  assert.ok(rows(res, 'comments').every((x) => x.is_deleted === true));
  assert.ok(rows(res, 'reminders').every((x) => x.is_deleted === true));

  const full = run(db, [], '*');
  assert.equal(rows(full, 'tasks').length, 0);
  assert.equal(rows(full, 'sections').length, 0);
  assert.deepEqual(rows(full, 'projects').map((p) => p.name).sort(), ['Inbox', 'Werk']);
});

test('een project verwijderen neemt subprojecten, secties en taken mee', () => {
  const db = mkdb();
  const { P } = seed(db);
  const sp = cmd('project_add', { id: 'subproj-aaaa111', name: 'Sub', parent_id: P });
  const st = cmd('task_add', { project_id: 'subproj-aaaa111', content: 'In sub' });
  run(db, [sp, st]);
  const del = cmd('project_delete', { id: P });
  ok(run(db, [del]), del);
  const full = run(db, []);
  for (const k of ['sections', 'tasks']) assert.equal(rows(full, k).length, 0, k);
  assert.deepEqual(rows(full, 'projects').map((p) => p.id), ['inbox-project'], 'alleen de Inbox blijft over');
});

test('nieuwe taken komen achteraan; expliciete volgordesleutels worden gecontroleerd', () => {
  const db = mkdb();
  const { P, S } = seed(db);
  const a = cmd('task_add', { project_id: P, section_id: S, content: 'A' });
  const b = cmd('task_add', { project_id: P, section_id: S, content: 'B' });
  const bad = cmd('task_add', { project_id: P, content: 'X', order_key: 'a0' });
  const res = run(db, [a, b, bad]);
  err(res, bad, 'INVALID_ARG');
  const sorted = rows(res, 'tasks').filter((t) => t.section_id === S).sort((x, y) => (x.order_key < y.order_key ? -1 : 1)).map((t) => t.content);
  assert.deepEqual(sorted, ['Eerste', 'A', 'B']);
});

test('een verplaatsing wijzigt één taak plus haar subtaken, niet de broers', () => {
  const db = mkdb();
  const { P, T, token } = seed(db);
  const other = cmd('project_add', { id: 'project-bbbb2222', name: 'Privé' });
  const sub = cmd('task_add', { id: 'subtask-aaaa111', project_id: P, parent_id: T, content: 'Sub' });
  const sib = cmd('task_add', { id: 'sibling-aaaa111', project_id: P, content: 'Broer' });
  run(db, [other, sub, sib]);
  const t2 = run(db, [], '*').sync_token;
  const mv = cmd('task_move', { id: T, project_id: 'project-bbbb2222' });
  const res = run(db, [mv], t2);
  ok(res, mv);
  const changed = rows(res, 'tasks').map((t) => t.id).sort();
  assert.deepEqual(changed, ['subtask-aaaa111', 'task-aaaa11111']);
  assert.ok(rows(res, 'tasks').every((t) => t.project_id === 'project-bbbb2222'));
  assert.equal(rows(res, 'tasks').find((t) => t.id === T)!.section_id, null, 'sectie hoort bij het oude project');
  assert.ok(token); // gebruikt
});

test('verplaatsen: geen cirkels, sectie moet bij het project horen, subtaak volgt de ouder', () => {
  const db = mkdb();
  const { P, S, T } = seed(db);
  const other = cmd('project_add', { id: 'project-bbbb2222', name: 'Privé' });
  const os = cmd('section_add', { id: 'section-bbbb2222', project_id: 'project-bbbb2222', name: 'X' });
  const sub = cmd('task_add', { id: 'subtask-aaaa111', project_id: P, parent_id: T, content: 'Sub' });
  run(db, [other, os, sub]);
  const cycle = cmd('task_move', { id: T, parent_id: 'subtask-aaaa111' });
  const self = cmd('task_move', { id: T, parent_id: T });
  const wrongSection = cmd('task_move', { id: T, section_id: 'section-bbbb2222' });
  const subSection = cmd('task_move', { id: 'subtask-aaaa111', section_id: null });
  const nothing = cmd('task_move', { id: T });
  const res = run(db, [cycle, self, wrongSection, subSection, nothing]);
  err(res, cycle, 'CYCLE');
  err(res, self, 'CYCLE');
  err(res, wrongSection, 'CONFLICT');
  err(res, subSection, 'CONFLICT');
  err(res, nothing, 'MISSING_ARG');
  assert.ok(S);
});

test('afvinken: gewone taak sluit zichzelf en subtaken; ongedaan maken heropent', () => {
  const db = mkdb();
  const { P, T } = seed(db);
  const sub = cmd('task_add', { id: 'subtask-aaaa111', project_id: P, parent_id: T, content: 'Sub' });
  const base = run(db, [sub]).sync_token;
  const done = cmd('task_complete', { id: T });
  const res = run(db, [done], base);
  ok(res, done);
  assert.ok(rows(res, 'tasks').every((t) => t.checked === true && t.completed_at));
  assert.equal(rows(res, 'tasks').find((t) => t.id === T)!.completed_count, 1);
  const again = cmd('task_complete', { id: T });
  const before = currentRev(db);
  ok(run(db, [again]), again);
  assert.equal(currentRev(db), before + 1, 'tweede afvinken is een no-op, het commando zelf telt wel');
  const undo = cmd('task_uncomplete', { id: T });
  const res2 = run(db, [undo], res.sync_token);
  ok(res2, undo);
  assert.equal(rows(res2, 'tasks')[0].checked, false);
  assert.equal(rows(res2, 'tasks')[0].completed_at, null);
});

test('afvinken van een terugkerende taak schuift de datum door en houdt hem open', () => {
  const db = mkdb();
  const { P } = seed(db);
  const add = cmd('task_add', {
    id: 'recurring-aaaa11', project_id: P, content: 'Planten water geven',
    due: { date: '2026-11-13', string: 'elke vrijdag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [5] } },
  });
  const base = run(db, [add]).sync_token;
  const done = cmd('task_complete', { id: 'recurring-aaaa11' });
  const res = run(db, [done], base);
  ok(res, done);
  const t = rows(res, 'tasks')[0];
  assert.equal(t.checked, false);
  assert.equal(t.due.date, '2026-11-20');
  assert.equal(t.due.string, 'elke vrijdag');
  assert.equal(t.completed_count, 1);
});

test('labels: unieke naam, taak koppelt via id, verwijderen haalt het label van taken', () => {
  const db = mkdb();
  const { P, T } = seed(db);
  const l1 = cmd('label_add', { id: 'label-aaaa11111', name: 'Werk' });
  const dup = cmd('label_add', { name: 'werk' });
  const res1 = run(db, [l1, dup]);
  ok(res1, l1);
  err(res1, dup, 'DUPLICATE');
  const tag = cmd('task_update', { id: T, labels: ['label-aaaa11111'] });
  const ghost = cmd('task_add', { project_id: P, content: 'x', labels: ['label-bestaatniet'] });
  const res2 = run(db, [tag, ghost], res1.sync_token);
  ok(res2, tag);
  err(res2, ghost, 'NOT_FOUND');
  const del = cmd('label_delete', { id: 'label-aaaa11111' });
  const res3 = run(db, [del], res2.sync_token);
  ok(res3, del);
  assert.deepEqual(rows(res3, 'tasks').find((t) => t.id === T)!.labels, []);
  assert.equal(rows(res3, 'labels')[0].is_deleted, true);
});

test('Nederlands: labelnamen zijn uniek ongeacht hoofdletters, accenten-vorm en spaties', () => {
  const db = mkdb();
  const l1 = cmd('label_add', { id: 'label-nl-000001', name: 'Café' });
  const res1 = run(db, [l1]);
  ok(res1, l1);
  const variants = ['CAFÉ', 'café', 'Café', 'CAFÉ']; // hoofdletters, kleine letters en de ontleedde schrijfwijze
  const cmds = variants.map((name) => cmd('label_add', { name }));
  const res2 = run(db, cmds, res1.sync_token);
  cmds.forEach((c, i) => err(res2, c, 'DUPLICATE'));
  // zonder accent is het een andere naam, en "één" en "een" blijven verschillend
  const other = [cmd('label_add', { name: 'Cafe' }), cmd('label_add', { name: 'één' }), cmd('label_add', { name: 'een' }), cmd('label_add', { name: 'Zoë' })];
  const res3 = run(db, other, res2.sync_token);
  other.forEach((c) => ok(res3, c));
  const dup = cmd('label_add', { name: 'ZOË' });
  err(run(db, [dup], res3.sync_token), dup, 'DUPLICATE');
  // hernoemen naar een bestaande naam in andere hoofdletters mag niet; naar de eigen naam in andere hoofdletters wel
  const rename = cmd('label_update', { id: 'label-nl-000001', name: 'ZOË' });
  const own = cmd('label_update', { id: 'label-nl-000001', name: 'CAFÉ' });
  const res4 = run(db, [rename, own], res3.sync_token);
  err(res4, rename, 'DUPLICATE');
  ok(res4, own);
});

test('Nederlands: alle tekst wordt als NFC opgeslagen, ook in het JSON-veld due', () => {
  const db = mkdb();
  const NFD = 'Café reserveren';
  const add = cmd('task_add', {
    id: 'task-nl-0000001', project_id: 'inbox-project', content: NFD, description: 'Zoë komt ook',
    due: { date: '2026-12-05', string: 'voor Sinterklaas Café', lang: 'nl' },
  });
  const res = run(db, [add]);
  ok(res, add);
  const t = rows(res, 'tasks')[0];
  assert.equal(t.content, 'Café reserveren');
  assert.equal(t.content.length, 'Café reserveren'.length);
  assert.equal(t.description, 'Zoë komt ook');
  assert.equal(t.due.string, 'voor Sinterklaas Café');
});

test('labelnamen: geen komma, geen omringende spaties, geen stuurtekens', () => {
  const db = mkdb();
  const bad = ['a,b', ' spatie voor', 'spatie na ', 'tab\there'].map((name) => cmd('label_add', { name }));
  const res = run(db, bad);
  bad.forEach((c) => err(res, c, 'INVALID_ARG'));
  const good = cmd('label_add', { name: 'boodschappen doen' }); // spaties binnenin zijn gewoon toegestaan
  ok(run(db, [good], res.sync_token), good);
});

test('herinneringen en opmerkingen: kruisvelden worden gecontroleerd', () => {
  const db = mkdb();
  const { P, T } = seed(db);
  const r1 = cmd('reminder_add', { task_id: T, type: 'relative' });
  const r2 = cmd('reminder_add', { task_id: T, type: 'absolute', due: { date: '2026-11-14' } });
  const r3 = cmd('reminder_add', { task_id: T, type: 'absolute', due: { date: '2026-11-14T09:00' } });
  const c1 = cmd('comment_add', { content: 'zonder doel' });
  const c2 = cmd('comment_add', { task_id: T, project_id: P, content: 'twee doelen' });
  const c3 = cmd('comment_add', { project_id: P, content: 'ok' });
  const res = run(db, [r1, r2, r3, c1, c2, c3]);
  err(res, r1, 'INVALID_ARG');
  err(res, r2, 'INVALID_ARG');
  ok(res, r3);
  err(res, c1, 'INVALID_ARG');
  err(res, c2, 'INVALID_ARG');
  ok(res, c3);
});

test('resource_types beperkt de delta en markeert hem als gedeeltelijk', () => {
  const db = mkdb();
  seed(db);
  const only = run(db, [], '*', ['tasks']);
  assert.equal(only.partial, true);
  assert.ok('tasks' in only);
  assert.ok(!('projects' in only));
  const minus = run(db, [], '*', ['all', '-tasks']);
  assert.equal(minus.partial, true);
  assert.ok(!('tasks' in minus));
  assert.ok('projects' in minus);
  assert.equal(run(db, []).partial, false);
});

test('een token vooruit op de server (database teruggezet) dwingt een volledige sync af', () => {
  const db = mkdb();
  seed(db);
  const res = run(db, [], '99999');
  assert.equal(res.full_sync, true);
  assert.equal(rows(res, 'tasks').length, 1);
});

test('twee clients: wijzigingen van de een komen via de delta bij de ander (laatste schrijver wint per veld-set)', () => {
  const db = mkdb();
  const { T, token } = seed(db);
  const a = cmd('task_update', { id: T, content: 'Van A' });
  const b = cmd('task_update', { id: T, priority: 4 });
  run(db, [a], token); // client A schrijft
  const resB = run(db, [b], token); // client B kende A's wijziging nog niet
  ok(resB, b);
  const t = rows(resB, 'tasks').find((x) => x.id === T)!;
  assert.equal(t.content, 'Van A', 'A\'s inhoud blijft behouden, B wijzigde alleen prioriteit');
  assert.equal(t.priority, 4);
});

test('alle commandonamen zijn aanwezig', () => {
  for (const c of ['project_add', 'section_update', 'task_move', 'task_complete', 'task_uncomplete', 'label_delete', 'comment_add', 'reminder_delete', 'filter_add']) {
    assert.ok(COMMAND_TYPES.includes(c), c);
  }
  assert.equal(newId().length, 16);
});
