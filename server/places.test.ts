// Plaatsen en herinneringen op een locatie: validatie, privacy (toegang), opruimen, limieten en migratie.
// Alle plaatsen en namen zijn verzonnen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema, SCHEMA_VERSION } from './schema.ts';
import { handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { LIMITS } from './limits.ts';
import { audienceSince } from './sync.ts';
import { addUser, freshDb } from './testutil.ts';
import type { UserRow } from './users.ts';

type Row = Record<string, any>;

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `geo-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[], token = '*'): SyncResponse => handleSync(db, { sync_token: token, commands }, as.id);
const code = (res: SyncResponse, c: Command): string => { const s = res.sync_status[c.uuid]; return s === 'ok' ? 'ok' : (s as Row).error_code; };
const ok = (res: SyncResponse, ...cs: Command[]) => { for (const c of cs) assert.equal(code(res, c), 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`); };
const err = (res: SyncResponse, c: Command, expected: string) => assert.equal(code(res, c), expected, `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`);
const rows = (res: SyncResponse, k: string): Row[] => res[k] as Row[];
const live = (res: SyncResponse, k: string): string[] => rows(res, k).filter((r) => !r.is_deleted).map((r) => r.id).sort();
const dead = (res: SyncResponse, k: string): string[] => rows(res, k).filter((r) => r.is_deleted).map((r) => r.id).sort();

function world() {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  return { db, anna, bram };
}

const HOME = { id: 'place-thuis-01', name: 'Thuis', lat: 52.37, lon: 4.89, radius: 150 };

/** Anna heeft de plaats Thuis, een taak en een locatieherinnering "bij aankomst". */
function annaSetup(db: DatabaseSync, anna: UserRow) {
  const cs = [
    cmd('place_add', HOME),
    cmd('task_add', { id: 'task-anna-0001', project_id: anna.inbox_project_id, content: 'Pakket ophalen' }),
    cmd('reminder_add', { id: 'remind-loc-001', task_id: 'task-anna-0001', type: 'location', place_id: HOME.id, trigger: 'enter' }),
  ];
  ok(run(db, anna, cs), ...cs);
}

test('een plaats toevoegen: standaardstraal 150, eigenaar is de gebruiker, getallen blijven getallen', () => {
  const { db, anna } = world();
  const c = cmd('place_add', { id: 'place-werk-0001', name: 'Werk', lat: 51.9244, lon: 4.4777 });
  const res = run(db, anna, [c]);
  ok(res, c);
  const p = rows(res, 'places')[0];
  assert.equal(p.name, 'Werk');
  assert.equal(p.lat, 51.9244);
  assert.equal(p.lon, 4.4777);
  assert.equal(p.radius, 150);
  assert.equal(p.owner_id, anna.id);
  assert.equal(p.is_deleted, false);
});

test('een plaats wijzigen: naam, positie en straal; het eigenaarsveld kan niet worden meegestuurd', () => {
  const { db, anna } = world();
  ok(run(db, anna, [cmd('place_add', HOME)]));
  const u = cmd('place_update', { id: HOME.id, name: 'Ons huis', radius: 300, lat: -33.8688, lon: 151.2093 });
  const res = run(db, anna, [u]);
  ok(res, u);
  const p = rows(res, 'places')[0];
  assert.deepEqual([p.name, p.radius, p.lat, p.lon], ['Ons huis', 300, -33.8688, 151.2093]);
  const steal = cmd('place_update', { id: HOME.id, owner_id: 'iemand-anders-1' });
  err(run(db, anna, [steal]), steal, 'READONLY');
});

test('ongeldige plaatsen worden geweigerd met een duidelijke fout', () => {
  const { db, anna } = world();
  const bad: [Record<string, unknown>, string][] = [
    [{ name: 'Te noord', lat: 90.0001, lon: 0 }, 'INVALID_ARG'],
    [{ name: 'Te zuid', lat: -91, lon: 0 }, 'INVALID_ARG'],
    [{ name: 'Te oost', lat: 0, lon: 180.5 }, 'INVALID_ARG'],
    [{ name: 'Te west', lat: 0, lon: -181 }, 'INVALID_ARG'],
    [{ name: 'Tekst', lat: '52', lon: 4 }, 'INVALID_ARG'],
    [{ name: 'Leeg', lat: null, lon: 4 }, 'INVALID_ARG'],
    [{ name: 'Smal', lat: 52, lon: 4, radius: 99 }, 'INVALID_ARG'],
    [{ name: 'Breed', lat: 52, lon: 4, radius: 5001 }, 'INVALID_ARG'],
    [{ name: 'Komma', lat: 52, lon: 4, radius: 150.5 }, 'INVALID_ARG'],
    [{ name: '   ', lat: 52, lon: 4 }, 'INVALID_ARG'],
    [{ name: 'x'.repeat(101), lat: 52, lon: 4 }, 'INVALID_ARG'],
    [{ lat: 52, lon: 4 }, 'MISSING_ARG'],
    [{ name: 'Zonder lat', lon: 4 }, 'MISSING_ARG'],
    [{ name: 'Zonder lon', lat: 52 }, 'MISSING_ARG'],
    [{ name: 'Extra', lat: 52, lon: 4, kleur: 'rood' }, 'UNKNOWN_ARG'],
    [{ name: 'Van een ander', lat: 52, lon: 4, owner_id: 'iemand-anders-1' }, 'READONLY'],
  ];
  for (const [args, expected] of bad) {
    const c = cmd('place_add', { id: `place-bad-${String(++n).padStart(5, '0')}`, ...args });
    err(run(db, anna, [c]), c, expected);
  }
  assert.deepEqual(rows(run(db, anna, []), 'places'), []);
  // de grenzen zelf zijn wel toegestaan
  for (const [lat, lon, radius] of [[90, 180, 100], [-90, -180, 5000], [0, 0, 150]]) {
    const c = cmd('place_add', { id: `place-ok-${String(++n).padStart(6, '0')}`, name: 'Rand', lat, lon, radius });
    ok(run(db, anna, [c]), c);
  }
});

test('de naam van een plaats wordt in NFC bewaard', () => {
  const { db, anna } = world();
  const c = cmd('place_add', { id: 'place-cafe-0001', name: 'Café de Zon', lat: 52, lon: 4 });
  const res = run(db, anna, [c]);
  ok(res, c);
  assert.equal(rows(res, 'places')[0].name, 'Café de Zon');
});

test('een locatieherinnering: plaats en trigger verplicht, geen tijd, en niet voor andere soorten', () => {
  const { db, anna } = world();
  ok(run(db, anna, [cmd('place_add', HOME), cmd('task_add', { id: 'task-anna-0001', project_id: anna.inbox_project_id, content: 'Taak' })]));
  const base = { task_id: 'task-anna-0001' };
  const cases: [Record<string, unknown>, string][] = [
    [{ ...base, type: 'location', trigger: 'enter' }, 'INVALID_ARG'], // geen plaats
    [{ ...base, type: 'location', place_id: HOME.id }, 'INVALID_ARG'], // geen trigger
    [{ ...base, type: 'location', place_id: HOME.id, trigger: 'binnen' }, 'INVALID_ARG'],
    [{ ...base, type: 'location', place_id: HOME.id, trigger: 'enter', minute_offset: 5 }, 'INVALID_ARG'],
    [{ ...base, type: 'location', place_id: HOME.id, trigger: 'enter', due: { date: '2026-12-01T09:00' } }, 'INVALID_ARG'],
    [{ ...base, type: 'location', place_id: 'place-bestaat-nt', trigger: 'enter' }, 'NOT_FOUND'],
    [{ ...base, type: 'relative', minute_offset: 5, place_id: HOME.id }, 'INVALID_ARG'],
    [{ ...base, type: 'relative', minute_offset: 5, trigger: 'enter' }, 'INVALID_ARG'],
    [{ ...base, type: 'absolute', due: { date: '2026-12-01T09:00' }, place_id: HOME.id }, 'INVALID_ARG'],
  ];
  for (const [args, expected] of cases) {
    const c = cmd('reminder_add', { id: `remind-bad-${String(++n).padStart(5, '0')}`, ...args });
    err(run(db, anna, [c]), c, expected);
  }
  for (const trigger of ['enter', 'leave']) {
    const c = cmd('reminder_add', { id: `remind-${trigger}-0001`, ...base, type: 'location', place_id: HOME.id, trigger });
    const res = run(db, anna, [c]);
    ok(res, c);
    const r = rows(res, 'reminders').find((x) => x.id === `remind-${trigger}-0001`)!;
    assert.deepEqual([r.type, r.place_id, r.trigger, r.minute_offset, r.due, r.owner_id], ['location', HOME.id, trigger, null, null, anna.id]);
  }
});

test('een herinnering wijzigen: van plek naar plek, en een soort kan niet half veranderen', () => {
  const { db, anna } = world();
  annaSetup(db, anna);
  ok(run(db, anna, [cmd('place_add', { id: 'place-werk-0001', name: 'Werk', lat: 52.1, lon: 5.1 })]));
  const toWork = cmd('reminder_update', { id: 'remind-loc-001', place_id: 'place-werk-0001', trigger: 'leave' });
  const res = run(db, anna, [toWork]);
  ok(res, toWork);
  const r = rows(res, 'reminders')[0];
  assert.deepEqual([r.place_id, r.trigger], ['place-werk-0001', 'leave']);
  // de soort wijzigen laat een halve herinnering achter: geweigerd
  const half = cmd('reminder_update', { id: 'remind-loc-001', type: 'relative' });
  err(run(db, anna, [half]), half, 'INVALID_ARG');
  const gone = cmd('reminder_update', { id: 'remind-loc-001', trigger: null });
  err(run(db, anna, [gone]), gone, 'INVALID_ARG');
});

test('privacy: een ander ziet je plaatsen niet en kan ze niet gebruiken, wijzigen of verwijderen (NOT_FOUND)', () => {
  const { db, anna, bram } = world();
  annaSetup(db, anna);
  // bram ziet niets van anna's plaatsen of herinneringen
  const rb = run(db, bram, []);
  assert.deepEqual(rb.places, []);
  assert.deepEqual(rb.reminders, []);
  // en ook niet in een gedeeld project
  const share = [cmd('project_add', { id: 'project-samen-01', name: 'Samen' }), cmd('project_share', { project_id: 'project-samen-01', username: 'bram' }),
    cmd('task_add', { id: 'task-samen-0001', project_id: 'project-samen-01', content: 'Samen doen' }),
    cmd('reminder_add', { id: 'remind-samen-01', task_id: 'task-samen-0001', type: 'location', place_id: HOME.id, trigger: 'leave' })];
  ok(run(db, anna, share), ...share);
  const rb2 = run(db, bram, []);
  assert.deepEqual(rb2.places, [], 'de plaats blijft privé, ook als het project gedeeld is');
  assert.deepEqual(rb2.reminders, [], 'en de herinnering ook');
  // bram probeert
  const attempts = [
    cmd('place_update', { id: HOME.id, name: 'Gekaapt' }),
    cmd('place_delete', { id: HOME.id }),
    cmd('reminder_add', { id: 'remind-bram-001', task_id: 'task-samen-0001', type: 'location', place_id: HOME.id, trigger: 'enter' }),
    cmd('reminder_update', { id: 'remind-samen-01', trigger: 'enter' }),
    cmd('reminder_delete', { id: 'remind-samen-01' }),
  ];
  const res = run(db, bram, attempts);
  for (const a of attempts) err(res, a, 'NOT_FOUND');
  const ra = run(db, anna, []);
  assert.equal(rows(ra, 'places')[0].name, 'Thuis');
  assert.equal(live(ra, 'reminders').length, 2);
  // bram kan een eigen plaats met hetzelfde id niet aanmaken (id bestaat al), en ziet niet waarom
  const clash = cmd('place_add', { ...HOME, name: 'Mijn thuis' });
  err(run(db, bram, [clash]), clash, 'ID_EXISTS');
});

test('privacy: een deltasync (met en zonder token) lekt geen plaatsen, ook niet als verwijderd', () => {
  const { db, anna, bram } = world();
  annaSetup(db, anna);
  const first = run(db, bram, []);
  const del = cmd('place_delete', { id: HOME.id });
  ok(run(db, anna, [del]), del);
  const after = run(db, bram, [], first.sync_token);
  assert.deepEqual(after.places, []);
  assert.deepEqual(after.reminders, []);
  const full = run(db, bram, []);
  assert.deepEqual(full.places, []);
});

test('toegangsfuzz: wat bram ook doet met id\'s van anna, zijn eigen gegevens en die van anna veranderen niet', () => {
  const { db, anna, bram } = world();
  annaSetup(db, anna);
  const before = JSON.stringify([rows(run(db, anna, []), 'places'), rows(run(db, anna, []), 'reminders')]);
  const targets = [HOME.id, 'remind-loc-001', 'task-anna-0001'];
  const fields: Record<string, unknown>[] = [{ name: 'x' }, { lat: 1 }, { radius: 500 }, { place_id: HOME.id }, { trigger: 'leave' }, { type: 'location' }, {}];
  const commands: Command[] = [];
  for (const id of targets) {
    for (const f of fields) {
      commands.push(cmd('place_update', { id, ...f }), cmd('reminder_update', { id, ...f }));
    }
    commands.push(cmd('place_delete', { id }), cmd('reminder_delete', { id }));
  }
  commands.push(cmd('place_add', { id: HOME.id, name: 'a', lat: 0, lon: 0 }));
  for (const f of fields) commands.push(cmd('reminder_add', { id: `remind-fuzz-${String(++n).padStart(4, '0')}`, task_id: 'task-anna-0001', type: 'location', place_id: HOME.id, trigger: 'enter', ...f }));
  const res = run(db, bram, commands);
  for (const c of commands) assert.notEqual(code(res, c), 'ok', `${c.type} ${JSON.stringify(c.args)} mag niet lukken`);
  assert.equal(JSON.stringify([rows(run(db, anna, []), 'places'), rows(run(db, anna, []), 'reminders')]), before);
  assert.deepEqual(run(db, bram, []).places, []);
});

test('een plaats verwijderen ruimt de herinneringen erop op; die van andere soorten blijven', () => {
  const { db, anna } = world();
  annaSetup(db, anna);
  const extra = [
    cmd('reminder_add', { id: 'remind-rel-0001', task_id: 'task-anna-0001', type: 'relative', minute_offset: 30 }),
    cmd('place_add', { id: 'place-werk-0001', name: 'Werk', lat: 52.1, lon: 5.1 }),
    cmd('reminder_add', { id: 'remind-werk-001', task_id: 'task-anna-0001', type: 'location', place_id: 'place-werk-0001', trigger: 'enter' }),
  ];
  ok(run(db, anna, extra), ...extra);
  const token = run(db, anna, []).sync_token;
  const del = cmd('place_delete', { id: HOME.id });
  const res = run(db, anna, [del], token);
  ok(res, del);
  assert.deepEqual(dead(res, 'places'), [HOME.id]);
  assert.deepEqual(dead(res, 'reminders'), ['remind-loc-001']);
  assert.deepEqual(rows(res, 'places')[0], { id: HOME.id, is_deleted: true }, 'een verwijderde plaats komt zonder inhoud mee');
  const full = run(db, anna, []);
  assert.deepEqual(live(full, 'places'), ['place-werk-0001']);
  assert.deepEqual(live(full, 'reminders'), ['remind-rel-0001', 'remind-werk-001']);
  // een herinnering op een verwijderde plaats kan niet meer
  const again = cmd('reminder_add', { id: 'remind-nieuw-01', task_id: 'task-anna-0001', type: 'location', place_id: HOME.id, trigger: 'leave' });
  err(run(db, anna, [again]), again, 'NOT_FOUND');
});

test('een taak verwijderen of afvinken: de herinnering op de plaats verdwijnt resp. blijft in de gegevens', () => {
  const { db, anna } = world();
  annaSetup(db, anna);
  const complete = cmd('task_complete', { id: 'task-anna-0001' });
  const res = run(db, anna, [complete]);
  ok(res, complete);
  assert.deepEqual(live(res, 'reminders'), ['remind-loc-001'], 'afvinken wist niets; de app toont ze niet meer af te gaan');
  assert.equal(rows(res, 'tasks')[0].checked, true);
  const del = cmd('task_delete', { id: 'task-anna-0001' });
  const r2 = run(db, anna, [del]);
  ok(r2, del);
  assert.deepEqual(live(r2, 'reminders'), []);
  assert.deepEqual(live(r2, 'places'), [HOME.id], 'de plaats zelf blijft');
});

test('uit een gedeeld project vertrekken ruimt je locatieherinneringen daar op, de plaats blijft', () => {
  const { db, anna, bram } = world();
  const setup = [cmd('project_add', { id: 'project-samen-01', name: 'Samen' }), cmd('project_share', { project_id: 'project-samen-01', username: 'bram' }),
    cmd('task_add', { id: 'task-samen-0001', project_id: 'project-samen-01', content: 'Samen doen' })];
  ok(run(db, anna, setup), ...setup);
  const mine = [cmd('place_add', { id: 'place-bram-0001', name: 'Bram thuis', lat: 52.0, lon: 5.0 }),
    cmd('reminder_add', { id: 'remind-bram-001', task_id: 'task-samen-0001', type: 'location', place_id: 'place-bram-0001', trigger: 'enter' })];
  ok(run(db, bram, mine), ...mine);
  const leave = cmd('project_leave', { project_id: 'project-samen-01' });
  const res = run(db, bram, [leave]);
  ok(res, leave);
  assert.deepEqual(live(res, 'reminders'), []);
  assert.deepEqual(live(res, 'places'), ['place-bram-0001']);
});

test('limiet: plaatsen per gebruiker (LIMIT_REACHED), per gebruiker apart, verwijderen geeft ruimte terug', () => {
  const { db, anna, bram } = world();
  const before = LIMITS.placesPerUser;
  LIMITS.placesPerUser = 3;
  try {
    const adds = Array.from({ length: 5 }, (_, i) => cmd('place_add', { id: `place-lim-${String(i).padStart(5, '0')}`, name: `Plaats ${i}`, lat: 50 + i, lon: 5 }));
    const res = run(db, anna, adds);
    assert.deepEqual(adds.map((c) => code(res, c)), ['ok', 'ok', 'ok', 'LIMIT_REACHED', 'LIMIT_REACHED']);
    assert.match((res.sync_status[adds[3].uuid] as Row).error, /plaatsen per gebruiker/);
    const other = cmd('place_add', { id: 'place-bram-0001', name: 'Bram', lat: 1, lon: 1 });
    ok(run(db, bram, [other]), other);
    const del = cmd('place_delete', { id: 'place-lim-00000' });
    const again = cmd('place_add', { id: 'place-lim-00009', name: 'Weer ruimte', lat: 1, lon: 1 });
    ok(run(db, anna, [del, again]), del, again);
  } finally {
    LIMITS.placesPerUser = before;
  }
});

test('herinneringen op een plaats tellen mee bij de grenzen voor herinneringen per taak', () => {
  const { db, anna } = world();
  annaSetup(db, anna);
  const before = LIMITS.remindersPerTask;
  LIMITS.remindersPerTask = 2;
  try {
    const more = [cmd('reminder_add', { id: 'remind-loc-002', task_id: 'task-anna-0001', type: 'location', place_id: HOME.id, trigger: 'leave' }),
      cmd('reminder_add', { id: 'remind-rel-0002', task_id: 'task-anna-0001', type: 'relative', minute_offset: 10 })];
    const res = run(db, anna, more);
    assert.deepEqual(more.map((c) => code(res, c)), ['ok', 'LIMIT_REACHED']);
  } finally {
    LIMITS.remindersPerTask = before;
  }
});

test('hetzelfde commando twee keer (zelfde uuid) maakt één plaats', () => {
  const { db, anna } = world();
  const c = cmd('place_add', HOME);
  ok(run(db, anna, [c]), c);
  ok(run(db, anna, [c]), c);
  assert.equal(live(run(db, anna, []), 'places').length, 1);
});

test('het live-signaal gaat alleen naar de eigenaar van een gewijzigde plaats', () => {
  const { db, anna, bram } = world();
  const rev = Number(run(db, anna, []).sync_token);
  ok(run(db, anna, [cmd('place_add', HOME)]));
  const who = audienceSince(db, rev, anna.id);
  assert.ok(who.has(anna.id));
  assert.ok(!who.has(bram.id), 'bram hoort niet eens dat er iets gebeurde');
  // ook als de wijziging van "iemand anders" komt (een ander commando in dezelfde ronde), hoort de eigenaar het
  assert.ok(audienceSince(db, rev, bram.id).has(anna.id), 'de eigenaar van de plaats krijgt het signaal');
});

test('migratie: een database van vóór de locatieherinneringen krijgt de kolommen en de tabel, en oude herinneringen blijven werken', () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const setup = [cmd('task_add', { id: 'task-anna-0001', project_id: anna.inbox_project_id, content: 'Oud' }),
    cmd('reminder_add', { id: 'remind-oud-0001', task_id: 'task-anna-0001', type: 'relative', minute_offset: 30 })];
  ok(run(db, anna, setup), ...setup);
  // zo zag de database eruit: geen plaatsen, geen place_id en trigger
  db.exec('DROP INDEX reminders_place; DROP INDEX places_owner; DROP TABLE places; ALTER TABLE reminders DROP COLUMN place_id; ALTER TABLE reminders DROP COLUMN trigger');
  db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  createSchema(db);
  createSchema(db);
  const names = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Row[]).map((r) => r.name);
  assert.ok(names('reminders').includes('place_id') && names('reminders').includes('trigger'));
  assert.deepEqual(names('places').sort(), ['created_at', 'id', 'is_deleted', 'lat', 'lon', 'name', 'owner_id', 'radius', 'rev', 'updated_at']);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row).value, String(SCHEMA_VERSION));
  const r = run(db, anna, []);
  assert.deepEqual(live(r, 'reminders'), ['remind-oud-0001']);
  assert.deepEqual([rows(r, 'reminders')[0].place_id, rows(r, 'reminders')[0].trigger], [null, null], 'oude rijen krijgen null, niet een fout');
  const c = cmd('place_add', HOME);
  ok(run(db, anna, [c]), c);
});

test('een oude client die alleen de bekende typen vraagt, krijgt geen plaatsen en blijft werken', () => {
  const { db, anna } = world();
  annaSetup(db, anna);
  const res = handleSync(db, { sync_token: '*', resource_types: ['all', '-places'] }, anna.id);
  assert.equal(res.places, undefined);
  assert.equal(res.partial, true, 'wie een typen weglaat, hoort dat het deelantwoord is');
  assert.deepEqual(live(res, 'reminders'), ['remind-loc-001']);
});
