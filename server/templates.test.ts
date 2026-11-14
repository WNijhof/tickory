// Sjablonen op de server: toegang (privé per gebruiker), validatie van de inhoud, grenzen, verwijderen, migratie en oudere clients.
// Alle namen en teksten zijn verzonnen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { createSchema, SCHEMA_VERSION } from './schema.ts';
import { audienceSince, handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { LIMITS } from './limits.ts';
import { addUser, freshDb } from './testutil.ts';
import type { UserRow } from './users.ts';

type Row = Record<string, any>;

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `tpl-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[], token = '*', resource_types?: string[]): SyncResponse =>
  handleSync(db, { sync_token: token, commands, ...(resource_types ? { resource_types } : {}) }, as.id);
const code = (res: SyncResponse, c: Command): string => { const s = res.sync_status[c.uuid]; return s === 'ok' ? 'ok' : (s as Row).error_code; };
const ok = (res: SyncResponse, ...cs: Command[]) => { for (const c of cs) assert.equal(code(res, c), 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`); };
const err = (res: SyncResponse, c: Command, expected: string) => assert.equal(code(res, c), expected, `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`);
const rows = (res: SyncResponse): Row[] => res.templates as Row[];
const withLimit = (name: keyof typeof LIMITS, value: number, body: () => void) => {
  const before = LIMITS[name];
  LIMITS[name] = value;
  try { body(); } finally { LIMITS[name] = before; }
};

function world() {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  return { db, anna, bram };
}

const task = (content: string, more: Record<string, unknown> = {}) => ({ content, ...more });
const CONTENT = {
  v: 1,
  tasks: [task('Eerst dit', { day: 0 })],
  sections: [{ name: 'Voorbereiden', tasks: [
    task('Bellen', { priority: 1, day: 3, time: '09:30', labels: ['telefoon', 'Café'], duration: 15, description: 'Vraag naar de prijs', subtasks: [task('Nummer opzoeken')] }),
    task('Wekelijks', { day: 0, recurrence: { freq: 'weekly', byweekday: [5] }, repeat_text: 'elke vrijdag' }),
  ] }],
};
const TPL = { id: 'tpl-verbouwing-1', name: 'Verbouwing', kind: 'project', description: 'Een klus', color: 'brown', content: CONTENT };
const SMALL = { v: 1, tasks: [task('Alleen dit')], sections: [] };
const add = (over: Record<string, unknown> = {}) => cmd('template_add', { ...TPL, ...over });

test('een sjabloon toevoegen: eigenaar is de gebruiker, standaardwaarden, de inhoud komt ongewijzigd terug', () => {
  const { db, anna } = world();
  const c = cmd('template_add', { id: 'tpl-minimaal-001', name: 'Klein', kind: 'task', content: SMALL });
  const res = run(db, anna, [c]);
  ok(res, c);
  const t = rows(res)[0];
  assert.deepEqual([t.name, t.kind, t.description, t.color, t.owner_id, t.is_deleted], ['Klein', 'task', '', 'charcoal', anna.id, false]);
  assert.deepEqual(t.content, SMALL);
  const full = add();
  ok(run(db, anna, [full]), full);
  assert.deepEqual(rows(run(db, anna, [])).find((r) => r.id === TPL.id)!.content, CONTENT);
});

test('een sjabloon wijzigen: naam, omschrijving, kleur en inhoud; de soort, het eigenaarsveld en onbekende velden niet', () => {
  const { db, anna } = world();
  ok(run(db, anna, [add()]));
  const u = cmd('template_update', { id: TPL.id, name: 'Nieuwe naam', description: '', color: 'teal', content: { v: 1, tasks: [task('Een andere')], sections: [] } });
  const res = run(db, anna, [u]);
  ok(res, u);
  const t = rows(res)[0];
  assert.deepEqual([t.name, t.description, t.color, t.kind, t.content.tasks[0].content], ['Nieuwe naam', '', 'teal', 'project', 'Een andere']);
  const kind = cmd('template_update', { id: TPL.id, kind: 'task' });
  const owner = cmd('template_update', { id: TPL.id, owner_id: 'iemand-anders-1' });
  const unknown = cmd('template_update', { id: TPL.id, zin: 'x' });
  const res2 = run(db, anna, [kind, owner, unknown]);
  err(res2, kind, 'IMMUTABLE');
  err(res2, owner, 'READONLY');
  err(res2, unknown, 'UNKNOWN_ARG');
  const del = cmd('template_delete', { id: TPL.id, extra: 1 });
  err(run(db, anna, [del]), del, 'UNKNOWN_ARG');
});

test('privé: een ander ziet het sjabloon niet, kan het niet wijzigen of verwijderen (NOT_FOUND), en krijgt geen signaal', () => {
  const { db, anna, bram } = world();
  const mine = add();
  ok(run(db, anna, [mine]), mine);
  const since = Number(run(db, anna, []).sync_token);
  assert.deepEqual(rows(run(db, bram, [])), [], 'Bram ziet het niet');
  const steal = [cmd('template_update', { id: TPL.id, name: 'Van Bram' }), cmd('template_delete', { id: TPL.id }), add({ id: TPL.id })];
  const res = run(db, bram, steal);
  err(res, steal[0], 'NOT_FOUND');
  err(res, steal[1], 'NOT_FOUND');
  err(res, steal[2], 'ID_EXISTS');
  assert.equal(rows(run(db, anna, []))[0].name, 'Verbouwing', 'ongewijzigd');
  const change = cmd('template_update', { id: TPL.id, name: 'Aangepast' });
  ok(run(db, anna, [change]), change);
  const audience = audienceSince(db, since, anna.id);
  assert.deepEqual([...audience], [anna.id], 'alleen de eigenaar hoort dat er iets veranderde');
  assert.deepEqual(rows(run(db, bram, [], '0')), [], 'ook niet in een delta');
});

test('twee gebruikers kunnen allebei een sjabloon met dezelfde naam hebben', () => {
  const { db, anna, bram } = world();
  const a = add({ id: 'tpl-anna-000001' });
  const b = add({ id: 'tpl-bram-000001' });
  ok(run(db, anna, [a]), a);
  ok(run(db, bram, [b]), b);
  assert.deepEqual(rows(run(db, anna, [])).map((r) => r.id), ['tpl-anna-000001']);
  assert.deepEqual(rows(run(db, bram, [])).map((r) => r.id), ['tpl-bram-000001']);
});

test('verwijderen: een grafsteen in de delta, niets meer in een volledige sync; een ander krijgt niets', () => {
  const { db, anna, bram } = world();
  ok(run(db, anna, [add()]));
  const token = run(db, anna, []).sync_token;
  ok(run(db, bram, [], '*'));
  const del = cmd('template_delete', { id: TPL.id });
  const res = run(db, anna, [del], token);
  ok(res, del);
  assert.deepEqual(rows(res), [{ id: TPL.id, is_deleted: true }], 'alleen het id, nooit de inhoud');
  assert.deepEqual(rows(run(db, anna, [])), [], 'volledige sync: weggelaten');
  assert.deepEqual(rows(run(db, bram, [], token)), []);
  const again = cmd('template_delete', { id: TPL.id });
  err(run(db, anna, [again]), again, 'NOT_FOUND');
  const rev = cmd('template_update', { id: TPL.id, name: 'Terug' });
  err(run(db, anna, [rev]), rev, 'NOT_FOUND');
});

test('een commando met hetzelfde uuid wordt maar één keer uitgevoerd', () => {
  const { db, anna } = world();
  const c = add();
  ok(run(db, anna, [c, c]), c);
  assert.equal(rows(run(db, anna, [])).length, 1);
  assert.equal(code(run(db, anna, [c]), c), 'ok', 'een herhaling krijgt dezelfde uitkomst');
  assert.equal(rows(run(db, anna, [])).length, 1);
});

test('tekst wordt in NFC bewaard: de ontleedde "é" in naam, inhoud en labels', () => {
  const { db, anna } = world();
  const cafe = 'Cafe\u0301';
  const c = cmd('template_add', { id: 'tpl-nfc-000001', name: cafe, kind: 'task', content: { v: 1, tasks: [task(`${cafe} bezoeken`, { labels: [cafe] })], sections: [{ name: `${cafe}-sectie`, tasks: [task('x')] }] } });
  ok(run(db, anna, [c]), c);
  const t = rows(run(db, anna, []))[0];
  assert.equal(t.name, 'Café');
  assert.equal(t.content.tasks[0].content, 'Café bezoeken');
  assert.deepEqual(t.content.tasks[0].labels, ['Café']);
  assert.equal(t.content.sections[0].name, 'Café-sectie');
});

test('ongeldige velden: naam, soort, kleur te lang, ontbrekende inhoud', () => {
  const { db, anna } = world();
  const bad: [Record<string, unknown>, string][] = [
    [{ name: '' }, 'INVALID_ARG'],
    [{ name: '   ' }, 'INVALID_ARG'],
    [{ name: 'x'.repeat(201) }, 'INVALID_ARG'],
    [{ name: 5 }, 'INVALID_ARG'],
    [{ kind: 'filter' }, 'INVALID_ARG'],
    [{ kind: null }, 'INVALID_ARG'],
    [{ description: 'x'.repeat(501) }, 'INVALID_ARG'],
    [{ color: 'x'.repeat(33) }, 'INVALID_ARG'],
    [{ content: null }, 'INVALID_ARG'],
    [{ owner_id: 'iemand-anders-1' }, 'READONLY'],
    [{ naam: 'x' }, 'UNKNOWN_ARG'],
  ];
  for (const [over, expected] of bad) {
    const c = add({ id: `tpl-bad-${String(++n).padStart(6, '0')}`, ...over });
    err(run(db, anna, [c]), c, expected);
  }
  const noName = cmd('template_add', { id: 'tpl-geennaam-01', kind: 'task', content: SMALL });
  const noKind = cmd('template_add', { id: 'tpl-geensoort-1', name: 'x', content: SMALL });
  const noContent = cmd('template_add', { id: 'tpl-geeninh-001', name: 'x', kind: 'task' });
  const res = run(db, anna, [noName, noKind, noContent]);
  err(res, noName, 'MISSING_ARG');
  err(res, noKind, 'MISSING_ARG');
  err(res, noContent, 'MISSING_ARG');
  assert.deepEqual(rows(run(db, anna, [])), [], 'niets bewaard');
});

test('de inhoud wordt streng gecontroleerd: structuur, lengtes, diepte, herhalingen en onbekende velden', () => {
  const { db, anna } = world();
  const deep = (levels: number) => { let node: Record<string, unknown> = task('onderste'); for (let i = 1; i < levels; i++) node = task(`niveau ${levels - i}`, { subtasks: [node] }); return node; };
  const bad: [string, unknown][] = [
    ['geen object', 'tekst'],
    ['taak is null', { v: 1, tasks: [null], sections: [] }],
    ['taak is tekst', { v: 1, tasks: ['x'], sections: [] }],
    ['taak is een lijst', { v: 1, tasks: [[]], sections: [] }],
    ['sectie is null', { v: 1, tasks: [task('x')], sections: [null] }],
    ['sectie is tekst', { v: 1, tasks: [task('x')], sections: ['x'] }],
    ['een lijst', []],
    ['onbekende versie', { v: 2, tasks: [task('x')], sections: [] }],
    ['onbekend veld', { v: 1, tasks: [task('x')], sections: [], extra: 1 }],
    ['geen taken', { v: 1, tasks: [], sections: [] }],
    ['geen taken in een sectie', { v: 1, tasks: [], sections: [{ name: 's', tasks: [] }] }],
    ['tasks geen lijst', { v: 1, tasks: 'x', sections: [] }],
    ['sections ontbreekt', { v: 1, tasks: [task('x')] }],
    ['lege titel', { v: 1, tasks: [task('')], sections: [] }],
    ['titel te lang', { v: 1, tasks: [task('x'.repeat(4001))], sections: [] }],
    ['beschrijving te lang', { v: 1, tasks: [task('x', { description: 'y'.repeat(16001) })], sections: [] }],
    ['stuurteken in titel', { v: 1, tasks: [task('a\u0000b')], sections: [] }],
    ['prioriteit 5', { v: 1, tasks: [task('x', { priority: 5 })], sections: [] }],
    ['prioriteit als tekst', { v: 1, tasks: [task('x', { priority: '1' })], sections: [] }],
    ['dag niet geheel', { v: 1, tasks: [task('x', { day: 0.5 })], sections: [] }],
    ['dag te ver', { v: 1, tasks: [task('x', { day: 3651 })], sections: [] }],
    ['tijd zonder dag', { v: 1, tasks: [task('x', { time: '09:00' })], sections: [] }],
    ['tijd ongeldig', { v: 1, tasks: [task('x', { day: 0, time: '24:00' })], sections: [] }],
    ['herhaling zonder dag', { v: 1, tasks: [task('x', { recurrence: { freq: 'daily' } })], sections: [] }],
    ['herhaling ongeldig', { v: 1, tasks: [task('x', { day: 0, recurrence: { freq: 'hourly' } })], sections: [] }],
    ['herhalingstekst zonder herhaling', { v: 1, tasks: [task('x', { day: 0, repeat_text: 'elke dag' })], sections: [] }],
    ['label met komma', { v: 1, tasks: [task('x', { labels: ['a,b'] })], sections: [] }],
    ['label met omringende spatie', { v: 1, tasks: [task('x', { labels: [' a'] })], sections: [] }],
    ['dubbele labels', { v: 1, tasks: [task('x', { labels: ['Café', 'CAFÉ'] })], sections: [] }],
    ['te veel labels', { v: 1, tasks: [task('x', { labels: Array.from({ length: 51 }, (_, i) => `l${i}`) })], sections: [] }],
    ['duur 0', { v: 1, tasks: [task('x', { duration: 0 })], sections: [] }],
    ['toewijzing', { v: 1, tasks: [task('x', { assignee_id: 'user-anna' })], sections: [] }],
    ['herinnering', { v: 1, tasks: [task('x', { reminders: [] })], sections: [] }],
    ['id', { v: 1, tasks: [task('x', { id: 'abcdefgh' })], sections: [] }],
    ['html-veld', { v: 1, tasks: [task('x', { html: '<b>' })], sections: [] }],
    ['subtaken geen lijst', { v: 1, tasks: [task('x', { subtasks: {} })], sections: [] }],
    ['vijf niveaus diep', { v: 1, tasks: [deep(5)], sections: [] }],
    ['sectie zonder naam', { v: 1, tasks: [task('x')], sections: [{ name: '', tasks: [task('y')] }] }],
    ['sectie met extra veld', { v: 1, tasks: [task('x')], sections: [{ name: 's', tasks: [task('y')], id: 'abcdefgh' }] }],
    ['dezelfde sectienaam twee keer', { v: 1, tasks: [task('x')], sections: [{ name: 'Klus', tasks: [task('y')] }, { name: 'KLUS', tasks: [task('z')] }] }],
    ['te veel secties', { v: 1, tasks: [task('x')], sections: Array.from({ length: 101 }, (_, i) => ({ name: `s${i}`, tasks: [task('y')] })) }],
    ['te groot', { v: 1, tasks: Array.from({ length: 70 }, (_, i) => task(`${i}${'a'.repeat(3990)}`)), sections: [] }],
  ];
  for (const [what, content] of bad) {
    const c = add({ id: `tpl-inh-${String(++n).padStart(7, '0')}`, content });
    err(run(db, anna, [c]), c, 'INVALID_ARG');
    void what;
  }
  assert.deepEqual(rows(run(db, anna, [])), [], 'niets bewaard');
  // wat wel mag: vier niveaus, alle velden, een grote maar geldige inhoud
  const fine: [string, unknown][] = [
    ['vier niveaus', { v: 1, tasks: [deep(4)], sections: [] }],
    ['alle velden', CONTENT],
    ['prioriteit 4 en dag negatief', { v: 1, tasks: [task('x', { priority: 4, day: -14 })], sections: [] }],
    ['honderd secties', { v: 1, tasks: [task('x')], sections: Array.from({ length: 100 }, (_, i) => ({ name: `s${i}`, tasks: [task('y')] })) }],
    ['tekst met html blijft tekst', { v: 1, tasks: [task('<img src=x onerror=alert(1)>', { description: '<script>x</script>' })], sections: [] }],
    ['regeleinden in de beschrijving', { v: 1, tasks: [task('x', { description: 'a\nb\r\nc\td' })], sections: [] }],
    ['bijna te groot', { v: 1, tasks: Array.from({ length: 60 }, (_, i) => task(`${i}${'a'.repeat(4000 - String(i).length - 1)}`)), sections: [] }],
  ];
  for (const [what, content] of fine) {
    const c = add({ id: `tpl-ok-${String(++n).padStart(8, '0')}`, content });
    ok(run(db, anna, [c]), c);
    void what;
  }
});

test('de grens aan het aantal taken per sjabloon (LIMIT_REACHED), bij toevoegen en bij wijzigen', () => {
  const { db, anna } = world();
  const many = (count: number) => ({ v: 1, tasks: Array.from({ length: count }, (_, i) => task(`t${i}`)), sections: [] });
  withLimit('tasksPerTemplate', 5, () => {
    const fits = cmd('template_add', { id: 'tpl-vijf-000001', name: 'vijf', kind: 'task', content: many(5) });
    const over = cmd('template_add', { id: 'tpl-zes-0000001', name: 'zes', kind: 'task', content: many(6) });
    const res = run(db, anna, [fits, over]);
    ok(res, fits);
    err(res, over, 'LIMIT_REACHED');
    assert.match(((res.sync_status[over.uuid] as Row).error as string), /taken per sjabloon/);
    const grow = cmd('template_update', { id: 'tpl-vijf-000001', content: many(6) });
    err(run(db, anna, [grow]), grow, 'LIMIT_REACHED');
    const shrink = cmd('template_update', { id: 'tpl-vijf-000001', content: many(2) });
    ok(run(db, anna, [shrink]), shrink);
    const rename = cmd('template_update', { id: 'tpl-vijf-000001', name: 'nieuw' });
    ok(run(db, anna, [rename]), rename);
  });
  // subtaken en taken in secties tellen mee
  withLimit('tasksPerTemplate', 4, () => {
    const counted = cmd('template_add', { id: 'tpl-geteld-00001', name: 'geteld', kind: 'project', content: { v: 1, tasks: [task('a', { subtasks: [task('b'), task('c')] })], sections: [{ name: 's', tasks: [task('d'), task('e')] }] } });
    err(run(db, anna, [counted]), counted, 'LIMIT_REACHED');
  });
  const exact = cmd('template_add', { id: 'tpl-duizend-0001', name: 'duizend', kind: 'task', content: many(1000) });
  ok(run(db, anna, [exact]), exact);
  const over = cmd('template_add', { id: 'tpl-duizend-0002', name: 'duizend en een', kind: 'task', content: many(1001) });
  err(run(db, anna, [over]), over, 'LIMIT_REACHED');
});

test('de grens aan het aantal sjablonen per gebruiker: binnen één verzoek, per gebruiker, en verwijderen geeft ruimte terug', () => {
  const { db, anna, bram } = world();
  withLimit('templatesPerUser', 3, () => {
    const adds = Array.from({ length: 5 }, (_, i) => add({ id: `tpl-lim-${String(i).padStart(7, '0')}`, name: `Sjabloon ${i}` }));
    const res = run(db, anna, adds);
    assert.deepEqual(adds.map((c) => code(res, c)), ['ok', 'ok', 'ok', 'LIMIT_REACHED', 'LIMIT_REACHED']);
    assert.match(((res.sync_status[adds[3].uuid] as Row).error as string), /sjablonen per gebruiker/);
    const other = add({ id: 'tpl-bram-000002' });
    ok(run(db, bram, [other]), other);
    const del = cmd('template_delete', { id: 'tpl-lim-0000000' });
    ok(run(db, anna, [del]), del);
    const again = add({ id: 'tpl-lim-0000009' });
    ok(run(db, anna, [again]), again);
  });
});

test('een sjabloon van bijna 256 KiB gaat door een sync-verzoek; daarboven wordt het geweigerd', () => {
  const { db, anna } = world();
  const big = (kib: number) => ({ v: 1, tasks: Array.from({ length: Math.ceil(kib / 4) }, (_, i) => task(`${i}`.padEnd(4000, 'é'))), sections: [] });
  const sizeOf = (c: unknown) => Buffer.byteLength(JSON.stringify(c));
  assert.ok(sizeOf(big(250)) > 250 * 1024 && sizeOf(big(250)) < 1024 * 1024);
  const fits = cmd('template_add', { id: 'tpl-groot-000001', name: 'groot', kind: 'task', content: { ...big(120), tasks: big(120).tasks.slice(0, 60) } });
  ok(run(db, anna, [fits]), fits);
  const over = cmd('template_add', { id: 'tpl-groot-000002', name: 'te groot', kind: 'task', content: big(300) });
  err(run(db, anna, [over]), over, 'INVALID_ARG');
});

test('oudere clients: een verzoek zonder sjablonen krijgt ze niet en weet dat het gedeeltelijk is; "-templates" werkt', () => {
  const { db, anna } = world();
  ok(run(db, anna, [add()]));
  const old = run(db, anna, [], '*', ['tasks', 'projects', 'sections', 'labels', 'comments', 'reminders', 'filters', 'places', 'settings', 'members']);
  assert.equal(old.partial, true, 'een client die de sjablonen niet kent, slaat het nieuwe token niet op');
  assert.equal(old.templates, undefined);
  const minus = run(db, anna, [], '*', ['all', '-templates']);
  assert.equal(minus.templates, undefined);
  assert.equal(minus.partial, true);
  assert.equal(rows(run(db, anna, [], '*', ['templates'])).length, 1);
  assert.equal(run(db, anna, []).partial, false);
});

test('migratie: een database van vóór de sjablonen krijgt de tabel, behoudt de rest en werkt het versienummer bij', () => {
  const { db, anna } = world();
  const c = cmd('task_add', { id: 'task-oud-000001', project_id: anna.inbox_project_id, content: 'Oud' });
  ok(run(db, anna, [c]), c);
  db.exec('DROP INDEX IF EXISTS templates_rev; DROP TABLE templates');
  db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
  createSchema(db);
  createSchema(db); // tweemaal: idempotent
  const cols = (db.prepare('PRAGMA table_info(templates)').all() as Row[]).map((r) => r.name).sort();
  assert.deepEqual(cols, ['color', 'content', 'created_at', 'description', 'id', 'is_deleted', 'kind', 'name', 'owner_id', 'rev', 'updated_at']);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row).value, String(SCHEMA_VERSION));
  const res = run(db, anna, []);
  assert.deepEqual((res.tasks as Row[]).map((t) => t.content), ['Oud']);
  assert.deepEqual(rows(res), []);
  const t = add();
  ok(run(db, anna, [t]), t);
});

test('de sjabloon-id\'s en de volgorde van binnenkomst: een sjabloon zonder order_key heeft er ook geen nodig', () => {
  const { db, anna } = world();
  const c = add({ order_key: 'V' });
  err(run(db, anna, [c]), c, 'UNKNOWN_ARG');
  const ids = ['kort', 'bevat een spatie', 'x'.repeat(41)];
  for (const id of ids) {
    const bad = add({ id });
    err(run(db, anna, [bad]), bad, 'INVALID_ARG');
  }
});
