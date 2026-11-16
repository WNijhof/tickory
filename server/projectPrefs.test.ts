// Persoonlijke voorkeuren in een gedeeld project (projectPrefs.ts): favoriet, ingeklapt, weergave en volgorde zijn per persoon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from './schema.ts';
import { handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { addUser, freshDb } from './testutil.ts';
import { accountBlockers, deleteAccount } from './accountDelete.ts';
import type { UserRow } from './users.ts';

type Row = Record<string, any>;

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `prf-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[], token = '*'): SyncResponse => handleSync(db, { sync_token: token, commands }, as.id);
const ok = (res: SyncResponse, ...cs: Command[]) => { for (const c of cs) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`); };
const err = (res: SyncResponse, c: Command, code: string) => {
  const s = res.sync_status[c.uuid];
  assert.ok(typeof s === 'object' && s.error_code === code, `${c.type}: verwacht ${code}, kreeg ${JSON.stringify(s)}`);
};
const project = (res: SyncResponse, id: string): Row | undefined => (res.projects as Row[]).find((p) => p.id === id);
const prefs = (p: Row | undefined) => p && { is_favorite: p.is_favorite, is_collapsed: p.is_collapsed, view_style: p.view_style, order_key: p.order_key };

const P = 'project-gezin-01';

/** Alice deelt project P met Bob (kan bewerken) en Carol (alleen lezen); Alice heeft het als favoriet op het bord. */
function world() {
  const db = freshDb();
  const alice = addUser(db, 'alice', 'Alice');
  const bob = addUser(db, 'bob', 'Bob');
  const carol = addUser(db, 'carol', 'Carol');
  const cs = [
    cmd('project_add', { id: P, name: 'Gezin', is_favorite: true, view_style: 'board' }),
    cmd('project_share', { project_id: P, username: 'bob', role: 'member' }),
    cmd('project_share', { project_id: P, username: 'carol', role: 'viewer' }),
  ];
  ok(run(db, alice, cs), ...cs);
  return { db, alice, bob, carol };
}

test('een lid ziet niet de favoriet en inklapstand van de eigenaar, wel diens weergave en volgorde tot hij zelf kiest', () => {
  const { db, alice, bob } = world();
  const mine = prefs(project(run(db, alice, []), P));
  assert.equal(mine.is_favorite, true);
  assert.equal(mine.view_style, 'board');
  const his = prefs(project(run(db, bob, []), P));
  assert.deepEqual(his, { is_favorite: false, is_collapsed: false, view_style: 'board', order_key: mine.order_key });
});

test('Bob zet het project bij zijn favorieten, klapt het in, kiest de lijst en een eigen plek: voor Alice verandert niets', () => {
  const { db, alice, bob } = world();
  const before = run(db, alice, []);
  const aliceToken = before.sync_token;
  const bobToken = run(db, bob, []).sync_token;
  const c = cmd('project_update', { id: P, is_favorite: true, is_collapsed: true, view_style: 'list', order_key: 'zz' });
  ok(run(db, bob, [c]), c);
  // Bob krijgt zijn eigen waarden terug, ook in de delta
  assert.deepEqual(prefs(project(run(db, bob, [], bobToken), P)), { is_favorite: true, is_collapsed: true, view_style: 'list', order_key: 'zz' });
  assert.deepEqual(prefs(project(run(db, bob, []), P)), { is_favorite: true, is_collapsed: true, view_style: 'list', order_key: 'zz' });
  // Alice: niets nieuws in haar delta, en haar project is onveranderd
  assert.equal(project(run(db, alice, [], aliceToken), P), undefined, 'geen nieuwe versie van het project voor Alice');
  assert.deepEqual(prefs(project(run(db, alice, []), P)), prefs(project(before, P)));
  // en de rij zelf (de waarden van de eigenaar) is niet aangeraakt
  const row = db.prepare('SELECT is_favorite, is_collapsed, view_style FROM projects WHERE id = ?').get(P) as Row;
  assert.deepEqual({ ...row }, { is_favorite: 1, is_collapsed: 0, view_style: 'board' });
});

test('de eigenaar wijzigt zijn eigen waarden in het project; een lid zonder eigen keuze volgt de weergave, niet de favoriet', () => {
  const { db, alice, bob } = world();
  const bobToken = run(db, bob, []).sync_token;
  const c = cmd('project_update', { id: P, is_favorite: false, view_style: 'calendar' });
  ok(run(db, alice, [c]), c);
  assert.equal(project(run(db, alice, []), P).view_style, 'calendar');
  const seen = project(run(db, bob, [], bobToken), P);
  assert.equal(seen.view_style, 'calendar', 'de weergave van de eigenaar is de standaard');
  assert.equal(seen.is_favorite, false);
  // heeft Bob zelf gekozen, dan blijft zijn keuze staan
  const b = cmd('project_update', { id: P, view_style: 'list' });
  ok(run(db, bob, [b]), b);
  const d = cmd('project_update', { id: P, view_style: 'board' });
  ok(run(db, alice, [d]), d);
  assert.equal(project(run(db, bob, []), P).view_style, 'list');
});

test('een lezer mag zijn eigen voorkeuren kiezen, maar niets aan het project zelf', () => {
  const { db, carol } = world();
  const mine = cmd('project_update', { id: P, is_favorite: true, view_style: 'calendar' });
  ok(run(db, carol, [mine]), mine);
  assert.deepEqual(prefs(project(run(db, carol, []), P)).view_style, 'calendar');
  const rename = cmd('project_update', { id: P, name: 'Van mij', is_favorite: false });
  err(run(db, carol, [rename]), rename, 'FORBIDDEN');
  assert.equal(project(run(db, carol, []), P).is_favorite, true, 'het hele commando is teruggedraaid');
  const color = cmd('project_update', { id: P, color: 'red' });
  err(run(db, carol, [color]), color, 'FORBIDDEN');
});

test('een lid dat ook de naam wijzigt: de naam gaat naar het project, de favoriet blijft van hem', () => {
  const { db, alice, bob } = world();
  const c = cmd('project_update', { id: P, name: 'Gezin en vrienden', is_favorite: true, parent_id: null });
  ok(run(db, bob, [c]), c);
  const a = project(run(db, alice, []), P);
  assert.equal(a.name, 'Gezin en vrienden');
  assert.equal(a.is_favorite, true, 'Alice had hem al als favoriet: onveranderd');
  const off = cmd('project_update', { id: P, is_favorite: false });
  ok(run(db, alice, [off]), off);
  assert.equal(project(run(db, bob, []), P).is_favorite, true, 'Bob houdt zijn eigen favoriet');
});

test('een ongeldige eigen volgorde of weergave wordt geweigerd', () => {
  const { db, bob } = world();
  const a = cmd('project_update', { id: P, order_key: '' });
  err(run(db, bob, [a]), a, 'INVALID_ARG');
  const b = cmd('project_update', { id: P, view_style: 'tabel' });
  err(run(db, bob, [b]), b, 'INVALID_ARG');
});

test('wie het project verlaat of eruit wordt gehaald, verliest zijn voorkeuren; een account verwijderen ruimt ze op', () => {
  const { db, alice, bob, carol } = world();
  for (const who of [bob, carol]) {
    const c = cmd('project_update', { id: P, is_favorite: true });
    ok(run(db, who, [c]), c);
  }
  const count = (uid: string) => Number((db.prepare('SELECT COUNT(*) AS n FROM project_prefs WHERE user_id = ?').get(uid) as Row).n);
  assert.equal(count(bob.id), 1);
  const leave = cmd('project_leave', { project_id: P });
  ok(run(db, bob, [leave]), leave);
  assert.equal(count(bob.id), 0);
  // opnieuw gedeeld: weer zonder eigen keuze
  const share = cmd('project_share', { project_id: P, username: 'bob', role: 'member' });
  ok(run(db, alice, [share]), share);
  assert.equal(project(run(db, bob, []), P).is_favorite, false);
  deleteAccount(db, carol.id, () => {});
  assert.equal(count(carol.id), 0);
});

test('een database van vóór de voorkeuren: elk gedeeld project krijgt een nieuwe versie, zodat de leden hun eigen waarden ophalen', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const alice = addUser(db, 'alice', 'Alice');
  const bob = addUser(db, 'bob', 'Bob');
  const cs = [cmd('project_add', { id: P, name: 'Gezin', is_favorite: true }), cmd('project_add', { id: 'project-alleen-1', name: 'Alleen' }),
    cmd('project_share', { project_id: P, username: 'bob', role: 'member' })];
  ok(run(db, alice, cs), ...cs);
  const bobToken = run(db, bob, []).sync_token;
  // zoals een oudere versie: zonder de tabel
  db.exec('DROP TABLE project_prefs');
  createSchema(db);
  const delta = run(db, bob, [], bobToken);
  assert.deepEqual((delta.projects as Row[]).map((p) => p.id), [P], 'alleen het gedeelde project opnieuw');
  assert.equal(project(delta, P).is_favorite, false);
  // een tweede start verandert niets meer
  const token = delta.sync_token;
  createSchema(db);
  assert.deepEqual(run(db, bob, [], token).projects, []);
});

// ---------- het eigendom overdragen (project_transfer) ----------

const role = (db: DatabaseSync, project: string, user: string) =>
  (db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND is_deleted = 0').get(project, user) as Row | undefined)?.role ?? null;

test('eigendom overdragen: Bob wordt eigenaar, Alice lid; ieder ziet het project nog net zo', () => {
  const { db, alice, bob, carol } = world();
  const sub = cmd('project_add', { id: 'project-gezin-sub', name: 'Vakantie', parent_id: P });
  const bobPrefs = cmd('project_update', { id: P, is_favorite: true, view_style: 'calendar', order_key: 'zz' });
  ok(run(db, alice, [sub]), sub);
  ok(run(db, bob, [bobPrefs]), bobPrefs);
  const before = { alice: prefs(project(run(db, alice, []), P)), bob: prefs(project(run(db, bob, []), P)), carol: prefs(project(run(db, carol, []), P)) };
  const t = cmd('project_transfer', { project_id: P, user_id: bob.id });
  ok(run(db, alice, [t]), t);
  assert.deepEqual([role(db, P, bob.id), role(db, P, alice.id), role(db, P, carol.id)], ['owner', 'member', 'viewer']);
  assert.deepEqual([role(db, 'project-gezin-sub', bob.id), role(db, 'project-gezin-sub', alice.id)], ['owner', 'member'], 'ook het subproject');
  // ieder ziet het project zoals ervoor; Carol (zonder eigen keuze) volgt nu de weergave van Bob
  assert.deepEqual(prefs(project(run(db, alice, []), P)), before.alice);
  assert.deepEqual(prefs(project(run(db, bob, []), P)), before.bob);
  assert.equal(project(run(db, carol, []), P).view_style, 'calendar');
  assert.equal(project(run(db, carol, []), P).is_favorite, before.carol.is_favorite);
  // Bob's voorkeuren staan nu in het project zelf, die van Alice in haar eigen voorkeuren
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM project_prefs WHERE project_id = ? AND user_id = ?').get(P, bob.id) as Row).n), 0);
  assert.equal((db.prepare('SELECT is_favorite FROM project_prefs WHERE project_id = ? AND user_id = ?').get(P, alice.id) as Row).is_favorite, 1);
  // en de nieuwe rechten gelden meteen
  const del = cmd('project_delete', { id: P });
  err(run(db, alice, [del]), del, 'FORBIDDEN');
  const rename = cmd('project_update', { id: P, name: 'Gezin (Alice bewerkt nog)' });
  ok(run(db, alice, [rename]), rename);
  const back = cmd('project_transfer', { project_id: P, user_id: alice.id });
  ok(run(db, bob, [back]), back);
  assert.deepEqual([role(db, P, alice.id), role(db, P, bob.id)], ['owner', 'member']);
  assert.deepEqual(prefs(project(run(db, alice, []), P)), before.alice, 'ook heen en terug');
  assert.deepEqual(prefs(project(run(db, bob, []), P)), before.bob);
});

test('eigendom overdragen: alleen de eigenaar, aan een lid; een lezer kan het ook krijgen; het staat in het logboek', () => {
  const { db, alice, bob, carol } = world();
  const byBob = cmd('project_transfer', { project_id: P, user_id: carol.id });
  err(run(db, bob, [byBob]), byBob, 'FORBIDDEN');
  const self = cmd('project_transfer', { project_id: P, user_id: alice.id });
  err(run(db, alice, [self]), self, 'CONFLICT');
  const dave = addUser(db, 'dave', 'Dave');
  const stranger = cmd('project_transfer', { project_id: P, user_id: dave.id });
  err(run(db, alice, [stranger]), stranger, 'NOT_FOUND');
  const extra = cmd('project_transfer', { project_id: P, user_id: carol.id, role: 'owner' });
  err(run(db, alice, [extra]), extra, 'UNKNOWN_ARG');
  const inbox = cmd('project_transfer', { project_id: alice.inbox_project_id, user_id: bob.id });
  err(run(db, alice, [inbox]), inbox, 'NOT_FOUND');
  const toViewer = cmd('project_transfer', { project_id: P, user_id: carol.id });
  ok(run(db, alice, [toViewer]), toViewer);
  assert.deepEqual([role(db, P, carol.id), role(db, P, alice.id)], ['owner', 'member']);
  const log = db.prepare("SELECT actor_id, user_id FROM activity WHERE project_id = ? AND kind = 'owner_changed'").all(P) as Row[];
  assert.deepEqual(log.map((r) => [r.actor_id, r.user_id]), [[alice.id, carol.id]]);
});

test('na het overdragen blokkeert het gedeelde project het verwijderen van het account niet meer; het blijft voor de anderen', () => {
  const { db, alice, bob } = world();
  assert.deepEqual(accountBlockers(db, alice.id).shared_projects.map((p) => p.id), [P]);
  const t = cmd('project_transfer', { project_id: P, user_id: bob.id });
  ok(run(db, alice, [t]), t);
  assert.deepEqual(accountBlockers(db, alice.id).shared_projects, []);
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(bob.id); // Alice is niet meer de enige beheerder
  deleteAccount(db, alice.id, () => {});
  assert.ok(project(run(db, bob, []), P), 'Bob heeft het project nog');
  assert.equal(role(db, P, bob.id), 'owner');
});
