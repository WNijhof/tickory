// Meerdere gebruikers: wie mag wat zien en doen, en wat krijgt iemand in de sync mee als dat verandert.
// Elke test begint met drie gebruikers: alice, bob en carol, elk met een eigen Inbox.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from './schema.ts';
import { handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { addUser, freshDb, mkdb, firstUser } from './testutil.ts';
import { keyAfter } from '../shared/orderKey.js';
import type { UserRow } from './users.ts';

type Row = Record<string, any>;

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `acc-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[], token = '*', resources?: string[]): SyncResponse =>
  handleSync(db, { sync_token: token, commands, ...(resources ? { resource_types: resources } : {}) }, as.id);
const ok = (res: SyncResponse, ...cs: Command[]) => { for (const c of cs) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`); };
const err = (res: SyncResponse, c: Command, code: string) => {
  const s = res.sync_status[c.uuid];
  assert.ok(typeof s === 'object' && s.error_code === code, `${c.type}: verwacht ${code}, kreeg ${JSON.stringify(s)}`);
};
const rows = (res: SyncResponse, k: string): Row[] => res[k] as Row[];
const ids = (res: SyncResponse, k: string): string[] => rows(res, k).map((r) => r.id).sort();
const live = (res: SyncResponse, k: string): string[] => rows(res, k).filter((r) => !r.is_deleted).map((r) => r.id).sort();
const dead = (res: SyncResponse, k: string): string[] => rows(res, k).filter((r) => r.is_deleted).map((r) => r.id).sort();
const find = (res: SyncResponse, k: string, id: string): Row | undefined => rows(res, k).find((r) => r.id === id);

function world() {
  const db = freshDb();
  const alice = addUser(db, 'alice', 'Alice');
  const bob = addUser(db, 'bob', 'Bob');
  const carol = addUser(db, 'carol', 'Carol');
  return { db, alice, bob, carol };
}

/** Alice heeft project P met sectie S, taak T en een opmerking C. */
function aliceProject(db: DatabaseSync, alice: UserRow) {
  const P = 'project-alice-01', S = 'section-alice-01', T = 'task-alice-0001', C = 'comment-alice-01';
  const cs = [
    cmd('project_add', { id: P, name: 'Gezin' }), cmd('section_add', { id: S, project_id: P, name: 'Deze week' }),
    cmd('task_add', { id: T, project_id: P, section_id: S, content: 'Boodschappen' }), cmd('comment_add', { id: C, task_id: T, content: 'Vergeet de melk niet' }),
  ];
  ok(run(db, alice, cs), ...cs);
  return { P, S, T, C };
}

test('elke gebruiker heeft een eigen Inbox en ziet alleen zijn eigen gegevens', () => {
  const { db, alice, bob } = world();
  assert.match(alice.inbox_project_id, /^inbox-/);
  assert.notEqual(alice.inbox_project_id, bob.inbox_project_id);
  const ra = run(db, alice, []);
  const rb = run(db, bob, []);
  assert.deepEqual(ids(ra, 'projects'), [alice.inbox_project_id]);
  assert.deepEqual(ids(rb, 'projects'), [bob.inbox_project_id]);
  assert.deepEqual(rows(ra, 'members').map((m) => [m.user_id, m.role]), [[alice.id, 'owner']]);
  assert.deepEqual((ra.users as Row[]).map((u) => u.username), ['alice'], 'bob is niet te zien: jullie delen niets');
  assert.equal((ra.me as Row).inbox_project_id, alice.inbox_project_id);
  const t = cmd('task_add', { project_id: alice.inbox_project_id, content: 'Geheim' });
  err(run(db, bob, [t]), t, 'NOT_FOUND');
});

test('ids die met "inbox-" beginnen zijn gereserveerd', () => {
  const { db, bob } = world();
  const a = cmd('project_add', { id: 'inbox-gekaapt-01', name: 'Nep' });
  const b = cmd('project_add', { id: 'inbox-project', name: 'Nep' });
  const res = run(db, bob, [a, b]);
  err(res, a, 'INVALID_ARG');
  err(res, b, 'INVALID_ARG');
});

test('wat van een ander is, bestaat voor jou niet: niets te lezen, niets te wijzigen', () => {
  const { db, alice, bob } = world();
  const { P, S, T, C } = aliceProject(db, alice);
  const lab = cmd('label_add', { id: 'label-alice-001', name: 'privé' });
  const rem = cmd('reminder_add', { id: 'remind-alice-01', task_id: T, type: 'relative', minute_offset: 30 });
  ok(run(db, alice, [lab, rem]), lab, rem);
  const before = JSON.stringify(run(db, alice, []));

  const attempts = [
    cmd('project_update', { id: P, name: 'Van Bob' }), cmd('project_delete', { id: P }), cmd('section_add', { project_id: P, name: 'x' }),
    cmd('section_update', { id: S, name: 'x' }), cmd('section_delete', { id: S }), cmd('task_add', { project_id: P, content: 'x' }),
    cmd('task_update', { id: T, content: 'x' }), cmd('task_delete', { id: T }), cmd('task_complete', { id: T }), cmd('task_uncomplete', { id: T }),
    cmd('task_move', { id: T, project_id: bob.inbox_project_id }), cmd('comment_add', { task_id: T, content: 'x' }),
    cmd('comment_update', { id: C, content: 'x' }), cmd('comment_delete', { id: C }), cmd('label_update', { id: 'label-alice-001', name: 'mijn' }),
    cmd('label_delete', { id: 'label-alice-001' }), cmd('task_add', { project_id: bob.inbox_project_id, content: 'x', labels: ['label-alice-001'] }),
    cmd('reminder_update', { id: 'remind-alice-01', minute_offset: 5 }), cmd('reminder_delete', { id: 'remind-alice-01' }),
    cmd('reminder_add', { task_id: T, type: 'relative', minute_offset: 5 }), cmd('project_share', { project_id: P, username: 'bob' }),
    cmd('project_unshare', { project_id: P, user_id: alice.id }), cmd('project_leave', { project_id: P }),
    cmd('project_add', { name: 'Onder Alice', parent_id: P }),
  ];
  const res = run(db, bob, attempts);
  for (const a of attempts) err(res, a, 'NOT_FOUND');
  assert.equal(JSON.stringify(run(db, alice, [])), before, 'niets van Alice is veranderd');
  const rb = run(db, bob, []);
  assert.deepEqual(ids(rb, 'projects'), [bob.inbox_project_id]);
  for (const k of ['sections', 'tasks', 'comments', 'labels', 'reminders']) assert.deepEqual(rb[k], [], k);
  assert.ok(!JSON.stringify(rb).includes('Boodschappen'), 'ook nergens anders in het antwoord');
});

test('eerst delen, dan zie je alles: ook wat al lang bestond', () => {
  const { db, alice, bob } = world();
  const { P, S, T, C } = aliceProject(db, alice);
  const token0 = run(db, bob, []).sync_token; // bob kent het project nog niet
  const share = cmd('project_share', { project_id: P, username: 'BOB' }); // hoofdletters maken niet uit
  ok(run(db, alice, [share]), share);

  const delta = run(db, bob, [], token0);
  assert.equal(delta.full_sync, false);
  assert.deepEqual(live(delta, 'projects'), [P]);
  assert.deepEqual(live(delta, 'sections'), [S]);
  assert.deepEqual(live(delta, 'tasks'), [T]);
  assert.deepEqual(live(delta, 'comments'), [C]);
  assert.deepEqual(rows(delta, 'members').map((m) => [m.user_id, m.role]).sort(), [[alice.id, 'owner'], [bob.id, 'member']].sort());
  assert.deepEqual((delta.users as Row[]).map((u) => u.username), ['alice', 'bob']);
  // een volgende delta bevat dat niet nog eens
  const again = run(db, bob, [], delta.sync_token);
  for (const k of ['projects', 'sections', 'tasks', 'comments', 'members']) assert.deepEqual(again[k], [], k);
  // delen is idempotent
  const twice = cmd('project_share', { project_id: P, username: 'bob' });
  ok(run(db, alice, [twice]), twice);
  assert.equal(live(run(db, alice, []), 'members').length, 3, 'inbox + twee leden, geen dubbele');
});

test('leden werken samen in hetzelfde project; de maker wordt vastgelegd', () => {
  const { db, alice, bob } = world();
  const { P, T } = aliceProject(db, alice);
  ok(run(db, alice, [cmd('project_share', { project_id: P, username: 'bob' })]));
  let tokenA = run(db, alice, []).sync_token;
  const add = cmd('task_add', { id: 'task-bob-00001', project_id: P, content: 'Pannen kopen' });
  const edit = cmd('task_update', { id: T, content: 'Boodschappen doen', priority: 2 });
  const done = cmd('task_complete', { id: T });
  const comment = cmd('comment_add', { id: 'comment-bob-001', task_id: T, content: 'Doe ik wel' });
  ok(run(db, bob, [add, edit, done, comment]), add, edit, done, comment);
  const delta = run(db, alice, [], tokenA);
  assert.equal(find(delta, 'tasks', 'task-bob-00001')!.creator_id, bob.id);
  assert.equal(find(delta, 'tasks', T)!.content, 'Boodschappen doen');
  assert.equal(find(delta, 'tasks', T)!.checked, true);
  assert.equal(find(delta, 'comments', 'comment-bob-001')!.author_id, bob.id);
  const full = run(db, alice, []);
  assert.equal(find(full, 'tasks', T)!.creator_id, alice.id);
  tokenA = delta.sync_token;
  const mv = cmd('task_update', { id: T, creator_id: bob.id });
  err(run(db, bob, [mv]), mv, 'READONLY');
});

test('alleen de eigenaar beheert het project; een lid mag erin werken en eruit gaan', () => {
  const { db, alice, bob, carol } = world();
  const { P } = aliceProject(db, alice);
  ok(run(db, alice, [cmd('project_share', { project_id: P, username: 'bob' })]));
  const asBob = [
    cmd('project_share', { project_id: P, username: 'carol' }), cmd('project_unshare', { project_id: P, user_id: alice.id }),
    cmd('project_delete', { id: P }), cmd('project_update', { id: P, parent_id: bob.inbox_project_id }),
  ];
  const res = run(db, bob, asBob);
  err(res, asBob[0], 'FORBIDDEN');
  err(res, asBob[1], 'FORBIDDEN');
  err(res, asBob[2], 'FORBIDDEN');
  err(res, asBob[3], 'FORBIDDEN');
  const rename = cmd('project_update', { id: P, name: 'Ons gezin', color: 'blue' });
  ok(run(db, bob, [rename]), rename);
  assert.equal(find(run(db, alice, []), 'projects', P)!.name, 'Ons gezin');
  // carol is nergens bij betrokken
  assert.ok(!live(run(db, carol, []), 'projects').includes(P));

  const aliceLeaves = cmd('project_leave', { project_id: P });
  err(run(db, alice, [aliceLeaves]), aliceLeaves, 'CONFLICT');
  const tokenB = run(db, bob, []).sync_token;
  const leave = cmd('project_leave', { project_id: P });
  ok(run(db, bob, [leave]), leave);
  const afterB = run(db, bob, [], tokenB);
  assert.deepEqual(dead(afterB, 'projects'), [P], 'bob krijgt te horen dat het project voor hem weg is');
  const nowAlice = run(db, alice, []);
  assert.deepEqual(rows(nowAlice, 'members').filter((m) => m.project_id === P).map((m) => m.user_id), [alice.id]);
  const late = cmd('task_add', { project_id: P, content: 'Te laat' });
  err(run(db, bob, [late]), late, 'NOT_FOUND');
  // en eruit zijn betekent ook: niets meer van dit project in volledige sync
  assert.ok(!JSON.stringify(run(db, bob, [])).includes('Boodschappen'));
});

test('iemand uit een project halen: weg voor die persoon, toewijzingen en herinneringen vervallen', () => {
  const { db, alice, bob } = world();
  const { P, T } = aliceProject(db, alice);
  ok(run(db, alice, [cmd('project_share', { project_id: P, username: 'bob' })]));
  const assign = cmd('task_update', { id: T, assignee_id: bob.id });
  const rem = cmd('reminder_add', { id: 'remind-bob-0001', task_id: T, type: 'relative', minute_offset: 10 });
  ok(run(db, alice, [assign]), assign);
  ok(run(db, bob, [rem]), rem);
  const tokenB = run(db, bob, []).sync_token;
  const tokenA = run(db, alice, []).sync_token;

  const self = cmd('project_unshare', { project_id: P, user_id: alice.id });
  const unknown = cmd('project_unshare', { project_id: P, user_id: 'gebruiker-xyz-1' });
  const kick = cmd('project_unshare', { project_id: P, user_id: bob.id });
  const res = run(db, alice, [self, unknown, kick]);
  err(res, self, 'CONFLICT');
  err(res, unknown, 'NOT_FOUND');
  ok(res, kick);

  assert.deepEqual(dead(run(db, bob, [], tokenB), 'projects'), [P]);
  const a = run(db, alice, [], tokenA);
  assert.equal(find(a, 'tasks', T)!.assignee_id, null, 'de toewijzing is vervallen');
  assert.equal((db.prepare('SELECT is_deleted FROM reminders WHERE id = ?').get('remind-bob-0001') as Row).is_deleted, 1, 'zijn herinnering voor deze taak ook');
  assert.deepEqual(find(a, 'members', rows(res as SyncResponse, 'members')[0]?.id) === undefined, true);
  assert.deepEqual(live(run(db, alice, []), 'members').length, 2, 'alleen de Inbox en alice zelf');
  // opnieuw uitnodigen kan, en geeft weer alles
  ok(run(db, alice, [cmd('project_share', { project_id: P, username: 'bob' })]));
  assert.deepEqual(live(run(db, bob, [], tokenB), 'tasks'), [T]);
});

test('delen met onbekende of geblokkeerde gebruikers, de Inbox en jezelf', () => {
  const { db, alice } = world();
  const { P } = aliceProject(db, alice);
  const none = cmd('project_share', { project_id: P, username: 'niemand' });
  const inbox = cmd('project_share', { project_id: alice.inbox_project_id, username: 'bob' });
  const self = cmd('project_share', { project_id: P, username: 'Alice' });
  const bad = cmd('project_share', { project_id: P, username: 42 });
  const extra = cmd('project_share', { project_id: P, username: 'bob', role: 'owner' });
  const res = run(db, alice, [none, inbox, self, bad, extra]);
  err(res, none, 'NOT_FOUND');
  err(res, inbox, 'CONFLICT');
  ok(res, self);
  err(res, bad, 'INVALID_ARG');
  err(res, extra, 'UNKNOWN_ARG');
  db.prepare("UPDATE users SET is_disabled = 1 WHERE username = 'carol'").run();
  const blocked = cmd('project_share', { project_id: P, username: 'carol' });
  const r2 = run(db, alice, [blocked]);
  err(r2, blocked, 'NOT_FOUND');
  assert.equal((r2.sync_status[blocked.uuid] as Row).error, (res.sync_status[none.uuid] as Row).error, 'geblokkeerd en onbekend zijn niet te onderscheiden');
});

test('subprojecten: delen gaat mee, nieuwe subprojecten erven de leden, de maker is eigenaar', () => {
  const { db, alice, bob } = world();
  const mk = [
    cmd('project_add', { id: 'project-root-001', name: 'Huis' }), cmd('project_add', { id: 'project-kind-001', name: 'Tuin', parent_id: 'project-root-001' }),
    cmd('project_add', { id: 'project-kleinkind', name: 'Gras', parent_id: 'project-kind-001' }),
  ];
  ok(run(db, alice, mk), ...mk);
  ok(run(db, alice, [cmd('project_share', { project_id: 'project-root-001', username: 'bob' })]));
  const rb = run(db, bob, []);
  assert.deepEqual(live(rb, 'projects'), [bob.inbox_project_id, 'project-kind-001', 'project-kleinkind', 'project-root-001'].sort());
  const late = cmd('project_add', { id: 'project-nieuw-001', name: 'Schuur', parent_id: 'project-root-001' });
  ok(run(db, alice, [late]), late);
  assert.ok(live(run(db, bob, []), 'projects').includes('project-nieuw-001'));
  const byBob = cmd('project_add', { id: 'project-bob-0001', name: 'Garage', parent_id: 'project-root-001' });
  ok(run(db, bob, [byBob]), byBob);
  const members = rows(run(db, alice, []), 'members').filter((m) => m.project_id === 'project-bob-0001').map((m) => `${m.user_id === alice.id ? 'alice' : 'bob'}:${m.role}`).sort();
  assert.deepEqual(members, ['alice:owner', 'bob:owner']);
  // wie alleen lid is van het bovenliggende project, kan in een kind delen noch verwijderen
  const del = cmd('project_delete', { id: 'project-kind-001' });
  err(run(db, bob, [del]), del, 'FORBIDDEN');
  // onder de Inbox kunnen geen projecten
  const inboxChild = cmd('project_add', { name: 'Onder Inbox', parent_id: alice.inbox_project_id });
  err(run(db, alice, [inboxChild]), inboxChild, 'CONFLICT');
});

test('delen en iemand eruit halen raakt alleen subprojecten waar je zelf eigenaar van bent', () => {
  const { db, alice, bob, carol } = world();
  ok(run(db, alice, [cmd('project_add', { id: 'project-alice-p1', name: 'Gedeeld' })]));
  ok(run(db, alice, [cmd('project_share', { project_id: 'project-alice-p1', username: 'bob' })]));
  // bob hangt een privéproject onder het gedeelde project; alice is daar geen eigenaar van (en ziet het niet)
  const priv = cmd('project_add', { id: 'project-bob-priv', name: 'Privé van Bob' });
  const move = cmd('project_update', { id: 'project-bob-priv', parent_id: 'project-alice-p1' });
  const secret = cmd('task_add', { project_id: 'project-bob-priv', content: 'Cadeau voor Alice' });
  ok(run(db, bob, [priv, move, secret]), priv, move, secret);

  ok(run(db, alice, [cmd('project_share', { project_id: 'project-alice-p1', username: 'carol' })]));
  const rc = run(db, carol, []);
  assert.deepEqual(live(rc, 'projects').filter((p) => !p.startsWith('inbox-')), ['project-alice-p1'], 'carol krijgt het gedeelde project, niet het privéproject eronder');
  assert.ok(!JSON.stringify(rc).includes('Cadeau'));
  // bob deelt zijn privéproject zelf met carol; als alice carol uit het gedeelde project haalt, blijft carol daar lid van
  const shareOwn = cmd('project_share', { project_id: 'project-bob-priv', username: 'carol' });
  ok(run(db, bob, [shareOwn]), shareOwn);
  const kick = cmd('project_unshare', { project_id: 'project-alice-p1', user_id: carol.id });
  ok(run(db, alice, [kick]), kick);
  const afterKick = live(run(db, carol, []), 'projects');
  assert.ok(afterKick.includes('project-bob-priv') && !afterKick.includes('project-alice-p1'));
  assert.ok(live(run(db, bob, []), 'projects').includes('project-bob-priv'));
  const members = rows(run(db, bob, []), 'members').filter((m) => m.project_id === 'project-bob-priv');
  assert.deepEqual(members.map((m) => m.user_id).sort(), [bob.id, carol.id].sort());
});

test('een project verwijderen laat andermans projecten eronder staan', () => {
  const { db, alice, bob } = world();
  ok(run(db, alice, [cmd('project_add', { id: 'project-alice-p1', name: 'Gedeeld' })]));
  ok(run(db, alice, [cmd('project_share', { project_id: 'project-alice-p1', username: 'bob' })]));
  const priv = cmd('project_add', { id: 'project-bob-priv', name: 'Privé van Bob' });
  const move = cmd('project_update', { id: 'project-bob-priv', parent_id: 'project-alice-p1' });
  ok(run(db, bob, [priv, move]), priv, move);
  assert.equal(find(run(db, bob, []), 'projects', 'project-bob-priv')!.parent_id, 'project-alice-p1');
  const tokenB = run(db, bob, []).sync_token;
  const del = cmd('project_delete', { id: 'project-alice-p1' });
  ok(run(db, alice, [del]), del);
  const rb = run(db, bob, [], tokenB);
  assert.deepEqual(dead(rb, 'projects'), ['project-alice-p1']);
  const survivor = find(rb, 'projects', 'project-bob-priv')!;
  assert.equal(survivor.is_deleted, false);
  assert.equal(survivor.parent_id, null, 'het privéproject is op het hoogste niveau komen te staan');
  assert.ok(live(run(db, bob, []), 'projects').includes('project-bob-priv'));
});

test('labels zijn persoonlijk; op gedeelde taken zie je ze, wijzigen mag alleen de eigenaar', () => {
  const { db, alice, bob } = world();
  const { P, T } = aliceProject(db, alice);
  ok(run(db, alice, [cmd('project_share', { project_id: P, username: 'bob' })]));
  const la = cmd('label_add', { id: 'label-alice-001', name: 'Boodschappen' });
  const lb = cmd('label_add', { id: 'label-bob-0001', name: 'boodschappen' }); // zelfde naam mag, het zijn aparte lijsten
  const dup = cmd('label_add', { name: 'BOODSCHAPPEN' });
  ok(run(db, alice, [la]), la);
  const resB = run(db, bob, [lb, dup]);
  ok(resB, lb);
  err(resB, dup, 'DUPLICATE');
  assert.deepEqual(live(run(db, bob, []), 'labels'), ['label-bob-0001'], 'bob ziet het label van alice nog niet: het staat op geen enkele taak');
  const useUnseen = cmd('task_update', { id: T, labels: ['label-alice-001'] });
  err(run(db, bob, [useUnseen]), useUnseen, 'NOT_FOUND');

  const tokenB = run(db, bob, []).sync_token; // label van alice is oud, maar wordt zichtbaar zodra het op een taak komt
  const put = cmd('task_update', { id: T, labels: ['label-alice-001'] });
  ok(run(db, alice, [put]), put);
  const delta = run(db, bob, [], tokenB);
  assert.ok(live(delta, 'labels').includes('label-alice-001'), 'het label komt mee, ook al is het zelf niet veranderd');
  assert.equal(find(delta, 'tasks', T)!.labels[0], 'label-alice-001');

  const rename = cmd('label_update', { id: 'label-alice-001', name: 'van bob' });
  const remove = cmd('label_delete', { id: 'label-alice-001' });
  const res = run(db, bob, [rename, remove]);
  err(res, rename, 'FORBIDDEN');
  err(res, remove, 'FORBIDDEN');
  // bob mag het wel van de taak halen, en erbij laten staan bij een andere wijziging
  const keep = cmd('task_update', { id: T, content: 'Boodschappen doen' });
  ok(run(db, bob, [keep]), keep);
  assert.equal(find(run(db, alice, []), 'tasks', T)!.labels.length, 1);
  const drop = cmd('task_update', { id: T, labels: [] });
  ok(run(db, bob, [drop]), drop);
  assert.deepEqual(find(run(db, alice, []), 'tasks', T)!.labels, []);
  // alice verwijdert haar label: weg bij alle taken
  const gone = cmd('label_delete', { id: 'label-alice-001' });
  ok(run(db, alice, [gone]), gone);
});

test('herinneringen en filters zijn persoonlijk', () => {
  const { db, alice, bob } = world();
  const { P, T } = aliceProject(db, alice);
  ok(run(db, alice, [cmd('project_share', { project_id: P, username: 'bob' })]));
  const ra = cmd('reminder_add', { id: 'remind-alice-01', task_id: T, type: 'relative', minute_offset: 30 });
  const rb = cmd('reminder_add', { id: 'remind-bob-0001', task_id: T, type: 'absolute', due: { date: '2026-12-01T09:00:00' } });
  const fa = cmd('filter_add', { id: 'filter-alice-01', name: 'Mijn', query: 'vandaag' });
  ok(run(db, alice, [ra, fa]), ra, fa);
  ok(run(db, bob, [rb]), rb);
  const a = run(db, alice, []);
  const b = run(db, bob, []);
  assert.deepEqual(ids(a, 'reminders'), ['remind-alice-01']);
  assert.deepEqual(ids(b, 'reminders'), ['remind-bob-0001']);
  assert.equal(find(a, 'reminders', 'remind-alice-01')!.owner_id, alice.id);
  assert.deepEqual(ids(a, 'filters'), ['filter-alice-01']);
  assert.deepEqual(b.filters, []);
  const other = [cmd('reminder_update', { id: 'remind-alice-01', minute_offset: 1 }), cmd('reminder_delete', { id: 'remind-alice-01' }), cmd('filter_update', { id: 'filter-alice-01', name: 'x' }), cmd('filter_delete', { id: 'filter-alice-01' })];
  const res = run(db, bob, other);
  for (const c of other) err(res, c, 'NOT_FOUND');
  const forged = cmd('reminder_add', { task_id: T, type: 'relative', minute_offset: 5, owner_id: alice.id });
  err(run(db, bob, [forged]), forged, 'READONLY');
  // verwijdert alice de taak, dan verdwijnt ook de herinnering van bob
  const tokenB = b.sync_token;
  ok(run(db, alice, [cmd('task_delete', { id: T })]));
  const after = run(db, bob, [], tokenB);
  assert.deepEqual(dead(after, 'tasks'), [T]);
  assert.deepEqual(dead(after, 'reminders'), ['remind-bob-0001'], 'bob hoort ook dat zijn eigen herinnering vervalt');
  assert.equal((db.prepare('SELECT is_deleted FROM reminders WHERE id = ?').get('remind-bob-0001') as Row).is_deleted, 1);
});

test('toewijzen kan alleen aan een lid; verhuist de taak, dan vervalt een toewijzing aan wie niet mee kan', () => {
  const { db, alice, bob, carol } = world();
  const { P, T } = aliceProject(db, alice);
  ok(run(db, alice, [cmd('project_share', { project_id: P, username: 'bob' })]));
  const toCarol = cmd('task_update', { id: T, assignee_id: carol.id });
  const toBob = cmd('task_update', { id: T, assignee_id: bob.id });
  const res = run(db, alice, [toCarol, toBob]);
  err(res, toCarol, 'INVALID_ARG');
  ok(res, toBob);
  const addToCarol = cmd('task_add', { project_id: P, content: 'x', assignee_id: carol.id });
  err(run(db, alice, [addToCarol]), addToCarol, 'INVALID_ARG');
  // verhuizen naar de eigen Inbox van alice: bob kan daar niet bij
  const tokenB = run(db, bob, []).sync_token;
  const mv = cmd('task_move', { id: T, project_id: alice.inbox_project_id });
  ok(run(db, alice, [mv]), mv);
  assert.equal(find(run(db, alice, []), 'tasks', T)!.assignee_id, null);
  assert.deepEqual(dead(run(db, bob, [], tokenB), 'tasks'), [T], 'bob hoort dat de taak voor hem weg is, en houdt geen spooktaak over');
  // bob kan haar niet meer aanraken
  const touch = cmd('task_update', { id: T, content: 'x' });
  err(run(db, bob, [touch]), touch, 'NOT_FOUND');
});

test('een taak naar een project verplaatsen waar je geen lid van bent kan niet', () => {
  const { db, alice, bob } = world();
  const { P, T } = aliceProject(db, alice);
  ok(run(db, alice, [cmd('project_share', { project_id: P, username: 'bob' })]));
  const mv = cmd('task_move', { id: T, project_id: 'project-onbekend' });
  const mine = cmd('task_move', { id: T, project_id: bob.inbox_project_id }); // bob mag zijn eigen Inbox gebruiken
  const res = run(db, bob, [mv, mine]);
  err(res, mv, 'NOT_FOUND');
  ok(res, mine);
  assert.equal(find(run(db, bob, []), 'tasks', T)!.project_id, bob.inbox_project_id);
  assert.deepEqual(dead(run(db, alice, [], '0'), 'tasks'), [T], 'alice hoort dat de taak uit haar project is verdwenen');
  assert.deepEqual(live(run(db, alice, [], '0'), 'tasks'), []);
  assert.ok(!live(run(db, alice, []), 'tasks').includes(T));
});

test('opmerkingen: iedereen in het project leest ze, alleen de schrijver wijzigt of verwijdert', () => {
  const { db, alice, bob } = world();
  const { P, C } = aliceProject(db, alice);
  ok(run(db, alice, [cmd('project_share', { project_id: P, username: 'bob' })]));
  assert.deepEqual(live(run(db, bob, []), 'comments'), [C]);
  const edit = cmd('comment_update', { id: C, content: 'x' });
  const del = cmd('comment_delete', { id: C });
  const res = run(db, bob, [edit, del]);
  err(res, edit, 'FORBIDDEN');
  err(res, del, 'FORBIDDEN');
  const mine = cmd('comment_add', { id: 'comment-bob-001', project_id: P, content: 'Hoi' });
  const mineEdit = cmd('comment_update', { id: 'comment-bob-001', content: 'Hoi allemaal' });
  ok(run(db, bob, [mine, mineEdit]), mine, mineEdit);
  const forged = cmd('comment_add', { project_id: P, content: 'x', author_id: alice.id });
  err(run(db, bob, [forged]), forged, 'READONLY');
});

test('hetzelfde commando-uuid van twee gebruikers wordt voor allebei uitgevoerd', () => {
  const { db, alice, bob } = world();
  const c = { type: 'project_add', uuid: 'zelfde-uuid-0001', args: { name: 'Mijn project' } };
  const ra = handleSync(db, { commands: [c] }, alice.id);
  const rb = handleSync(db, { commands: [c] }, bob.id);
  assert.equal(ra.sync_status[c.uuid], 'ok');
  assert.equal(rb.sync_status[c.uuid], 'ok');
  assert.equal(live(run(db, alice, []), 'projects').length, 2);
  assert.equal(live(run(db, bob, []), 'projects').length, 2);
  // en bij een herhaling per gebruiker niet dubbel
  handleSync(db, { commands: [c] }, alice.id);
  assert.equal(live(run(db, alice, []), 'projects').length, 2);
});

test('volgordesleutels van projecten tellen alleen je eigen projecten', () => {
  const { db, alice, bob } = world();
  const five = Array.from({ length: 5 }, (_, i) => cmd('project_add', { name: `A${i}` }));
  ok(run(db, alice, five), ...five);
  const mine = cmd('project_add', { id: 'project-bob-0001', name: 'B' });
  ok(run(db, bob, [mine]), mine);
  const inboxKey = find(run(db, bob, []), 'projects', bob.inbox_project_id)!.order_key;
  assert.equal(find(run(db, bob, []), 'projects', 'project-bob-0001')!.order_key, keyAfter(inboxKey));
});

test('een geblokkeerde of onbekende gebruiker kan niet synchroniseren', () => {
  const { db, bob } = world();
  assert.throws(() => handleSync(db, {}, 'bestaat-niet-id'), /bestaat niet of is geblokkeerd/);
  db.prepare("UPDATE users SET is_disabled = 1 WHERE id = ?").run(bob.id);
  assert.throws(() => handleSync(db, {}, bob.id), /bestaat niet of is geblokkeerd/);
});

test('migratie van een database uit versie 0.1: het eerste account neemt alles over, een volgend account ziet niets', () => {
  const db = mkdb(); // Inbox "inbox-project", overgenomen door "tester"
  const owner = firstUser(db);
  assert.equal(owner.is_admin, true);
  assert.equal(owner.inbox_project_id, 'inbox-project');
  const second = addUser(db, 'tweede');
  assert.deepEqual(live(run(db, second, []), 'projects'), [second.inbox_project_id]);
  assert.deepEqual(live(run(db, owner, []), 'projects'), ['inbox-project']);

  // een echte oude database: projecten, labels, filters en herinneringen zonder eigenaar
  const old = new DatabaseSync(':memory:');
  createSchema(old);
  const rawInsert = (sql: string, ...p: any[]) => old.prepare(sql).run(...p);
  rawInsert("INSERT INTO projects (id, name, description, color, is_favorite, is_archived, is_collapsed, view_style, order_key, rev, is_deleted, created_at, updated_at) VALUES ('inbox-project','Inbox','','charcoal',0,0,0,'list','a0',1,0,'t','t')");
  rawInsert("INSERT INTO projects (id, name, description, color, is_favorite, is_archived, is_collapsed, view_style, order_key, rev, is_deleted, created_at, updated_at) VALUES ('project-oud-0001','Oud','','charcoal',0,0,0,'list','a1',2,0,'t','t')");
  rawInsert("INSERT INTO labels (id, name, color, order_key, is_favorite, rev, is_deleted, created_at, updated_at) VALUES ('label-oud-00001','werk','charcoal','a0',0,3,0,'t','t')");
  rawInsert("INSERT INTO filters (id, name, query, color, order_key, is_favorite, rev, is_deleted, created_at, updated_at) VALUES ('filter-oud-0001','Vandaag','vandaag','charcoal','a0',0,4,0,'t','t')");
  rawInsert("INSERT INTO meta (key, value) VALUES ('x','y') ON CONFLICT DO NOTHING");
  old.prepare("UPDATE meta SET value = '4' WHERE key = 'rev'").run();
  const claimant = addUser(old, 'anna', 'Anna');
  assert.equal(claimant.is_admin, true, 'het eerste account is altijd beheerder');
  assert.equal(claimant.inbox_project_id, 'inbox-project');
  const r = run(old, claimant, []);
  assert.deepEqual(live(r, 'projects'), ['inbox-project', 'project-oud-0001']);
  assert.deepEqual(live(r, 'labels'), ['label-oud-00001']);
  assert.deepEqual(live(r, 'filters'), ['filter-oud-0001']);
  assert.equal(find(r, 'labels', 'label-oud-00001')!.owner_id, claimant.id);
  const next = addUser(old, 'ben', 'Ben');
  assert.equal(next.is_admin, false);
  const rn = run(old, next, []);
  assert.deepEqual(live(rn, 'projects'), [next.inbox_project_id]);
  assert.deepEqual(rn.labels, []);
  assert.deepEqual(rn.filters, []);
});

test('createSchema voegt ontbrekende kolommen toe aan een oudere database en verandert verder niets', () => {
  const db = freshDb();
  db.exec('DROP INDEX labels_owner; DROP INDEX filters_owner; DROP INDEX reminders_owner; DROP INDEX labels_order; DROP INDEX filters_order; DROP INDEX tasks_creator');
  for (const [t, c] of [['tasks', 'assignee_id'], ['tasks', 'creator_id'], ['comments', 'author_id'], ['labels', 'owner_id'], ['filters', 'owner_id'], ['reminders', 'owner_id']]) {
    db.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
  }
  const names = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((r) => r.name);
  assert.ok(!names('tasks').includes('assignee_id'));
  createSchema(db);
  createSchema(db); // tweede keer: niets te doen
  assert.ok(names('tasks').includes('assignee_id') && names('tasks').includes('creator_id'));
  assert.ok(names('comments').includes('author_id') && names('labels').includes('owner_id') && names('reminders').includes('owner_id'));
  const u = addUser(db, 'iemand');
  const t = cmd('task_add', { project_id: u.inbox_project_id, content: 'werkt', assignee_id: u.id });
  ok(run(db, u, [t]), t);
});

test('instellingen: één rij per gebruiker, alleen van jezelf en alleen te wijzigen', () => {
  const { db, alice, bob } = world();
  const mine = `settings-${alice.id}`;
  const ra = run(db, alice, []);
  assert.deepEqual(rows(ra, 'settings').map((s) => [s.id, s.auto_reminder, s.timezone, s.owner_id]), [[mine, 30, null, alice.id]]);
  assert.deepEqual(ids(run(db, bob, []), 'settings'), [`settings-${bob.id}`]);

  const good = cmd('settings_update', { id: mine, auto_reminder: 10, timezone: 'Europe/Amsterdam' });
  const off = cmd('settings_update', { id: mine, auto_reminder: -1 });
  ok(run(db, alice, [good]), good);
  assert.deepEqual(rows(run(db, alice, []), 'settings').map((s) => [s.auto_reminder, s.timezone]), [[10, 'Europe/Amsterdam']]);
  ok(run(db, alice, [off]), off);
  assert.equal(rows(run(db, alice, []), 'settings')[0].auto_reminder, -1);

  const bad = [
    cmd('settings_update', { id: mine, auto_reminder: -2 }), cmd('settings_update', { id: mine, auto_reminder: 60 * 24 * 365 + 1 }),
    cmd('settings_update', { id: mine, auto_reminder: 1.5 }), cmd('settings_update', { id: mine, timezone: 'Mars/Olympus' }),
    cmd('settings_update', { id: mine, timezone: 'x'.repeat(65) }), cmd('settings_update', { id: mine, timezone: 5 }),
  ];
  const rb = run(db, alice, bad);
  for (const c of bad) err(rb, c, 'INVALID_ARG');
  const forged = cmd('settings_update', { id: mine, owner_id: bob.id });
  err(run(db, alice, [forged]), forged, 'READONLY');
  // aanmaken en verwijderen bestaan niet; die van een ander bestaat voor jou niet
  const add = cmd('settings_add', { id: 'settings-extra-01', auto_reminder: 5 });
  const del = cmd('settings_delete', { id: mine });
  const other = cmd('settings_update', { id: mine, auto_reminder: 5 });
  const r2 = run(db, alice, [add, del]);
  err(r2, add, 'UNKNOWN_COMMAND');
  err(r2, del, 'UNKNOWN_COMMAND');
  err(run(db, bob, [other]), other, 'NOT_FOUND');
  assert.equal(rows(run(db, alice, []), 'settings')[0].auto_reminder, -1, 'ongewijzigd');
});

test('instellingen: een account van vóór de instellingen krijgt ze bij de eerstvolgende sync, één keer', () => {
  const { db, alice } = world();
  db.prepare('DELETE FROM user_settings WHERE owner_id = ?').run(alice.id); // zoals een account uit een eerdere versie
  const token = run(db, alice, []).sync_token;
  assert.deepEqual(ids(run(db, alice, []), 'settings'), [`settings-${alice.id}`]);
  assert.equal(run(db, alice, []).sync_token, token, 'daarna verandert er niets meer');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM user_settings WHERE owner_id = ?').get(alice.id) as Row).n, 1);
  // ook het eerste account van een database uit versie 0.1 heeft ze
  const legacy = mkdb();
  assert.deepEqual(ids(run(legacy, firstUser(legacy), []), 'settings'), [`settings-${firstUser(legacy).id}`]);
});
