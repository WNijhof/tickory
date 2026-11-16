// Persoonlijke voorkeuren in een gedeeld project (projectPrefs.ts): favoriet, ingeklapt, weergave en volgorde zijn per persoon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from './schema.ts';
import { handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { addUser, freshDb } from './testutil.ts';
import { deleteAccount } from './accountDelete.ts';
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
