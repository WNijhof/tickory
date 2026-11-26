// Snel toevoegen op de server (quickadd.ts): dezelfde herkenning en dezelfde taak als in de web-app, idempotent op uuid, met de
// rechten en limieten van de sync, "morgen" vanaf het moment van intypen in de tijdzone van het apparaat, en een voorvertoning
// die niets aanmaakt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { AtomicFailure, handleSync, SyncError } from './sync.ts';
import type { Command } from './sync.ts';
import { addUser, freshDb } from './testutil.ts';
import type { UserRow } from './users.ts';
import { LIMITS } from './limits.ts';
import { derivedId, inZone, momentOf, quickAdd, QuickAddLimiter, readInput, zoneOf, TYPED_AT_FUTURE_MS, TYPED_AT_PAST_MS } from './quickadd.ts';
import { parseQuickAdd } from '../client/core/quickadd.js';
import { createActions } from '../client/core/actions.js';
import { emptyState } from '../client/core/reducer.js';
import { canEditProject } from '../client/core/access.js';

type Row = Record<string, any>;
let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `qa-test-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[]) => {
  const res = handleSync(db, { sync_token: '*', commands }, as.id);
  for (const c of commands) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`);
  return res;
};
const count = (db: DatabaseSync, table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE is_deleted = 0`).get() as Row).n);
const rev = (db: DatabaseSync): number => Number((db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as Row | undefined)?.value ?? 0);
const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof SyncError, `geen SyncError maar ${String(err)}`);
    return err.code;
  }
  return 'ok';
};

/** Anna met projecten Thuis (met sectie Klusjes) en Werk, labels, en een project van Bram waar ze alleen lezer is. */
function world() {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  run(db, anna, [
    cmd('project_add', { id: 'project-thuis-01', name: 'Thuis' }),
    cmd('project_add', { id: 'project-werk-001', name: 'Werk' }),
    cmd('project_add', { id: 'project-oud-0001', name: 'Oud', is_archived: true }),
    cmd('section_add', { id: 'section-klus-001', project_id: 'project-thuis-01', name: 'Klusjes' }),
    cmd('label_add', { id: 'label-bellen-01', name: 'bellen' }),
    cmd('label_add', { id: 'label-winkel-01', name: 'winkel' }),
    cmd('label_add', { id: 'label-uitgaan-1', name: 'Uitgaan met Zoë' }),
    cmd('task_add', { id: 'task-bestaand-1', project_id: 'project-thuis-01', content: 'Er staat al iets' }),
  ]);
  run(db, bram, [
    cmd('project_add', { id: 'project-gedeeld1', name: 'Gedeeld project' }),
    cmd('project_add', { id: 'project-bram-001', name: 'Geheim van Bram' }),
    cmd('label_add', { id: 'label-bram-0001', name: 'brams label' }),
    cmd('project_share', { project_id: 'project-gedeeld1', username: 'anna', role: 'viewer' }),
  ]);
  return { db, anna, bram };
}

/** Wat de web-app van Anna na een volledige sync weet, als view voor de herkenner (zoals client/core/store.js hem bijhoudt). */
function clientView(db: DatabaseSync, as: UserRow) {
  const full = handleSync(db, { sync_token: '*' }, as.id) as Row;
  const view = emptyState() as Record<string, Map<string, Row>>;
  for (const [resource, map] of Object.entries(view)) for (const row of (full[resource] ?? []) as Row[]) map.set(row.id, row);
  return { view, inbox: full.me.inbox_project_id as string };
}

/** Een eigen manier om de tijdzone te wisselen (niet die van quickadd.ts), zodat de test die niet blind overneemt. */
function zone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) Reflect.deleteProperty(process.env, 'TZ');
    else process.env.TZ = before;
  }
}

const NOW = Date.parse('2026-11-13T08:30:00Z'); // vrijdag 13 november 2026, 09:30 in Amsterdam

const INPUTS = [
  // Nederlands
  'Tandarts bellen morgen om 9 uur #Thuis @bellen p1',
  'Boodschappen doen vandaag @winkel @nieuw',
  'Vuilnis buiten zetten elke dinsdag om 20:00',
  'Verjaardag oma 25 december',
  'Rapport schrijven volgende week vrijdag {donderdag} p2 =1u30',
  'Bank bellen over 3 dagen !1u',
  'Afspraak overmorgen 14:00 !(een kwartier ervoor)',
  'Cadeaus kopen voor Sinterklaas #Thuis /Klusjes',
  'Fietsband plakken eind november',
  'Café “Zoë” reserveren za 19:30 @Uitgaan met Zoë',
  'e-mail naar jan@voorbeeld.nl en/of piet',
  'p5 is geen prioriteit maar !!3 wel',
  'Leeskring in #Gedeeld project', // daar is Anna lezer: geen project, de tekst blijft staan
  'Archief opruimen #Oud', // gearchiveerd: blijft staan
  'Notulen #Geheim van Bram', // niet van Anna: blijft staan
  'Vergadering elke tweede dinsdag van de maand om 10:00 #Werk',
  'Belastingaangifte 1 mei !2d',
  'Iets om 23:59 vandaag',
  'Opruimen  \t met   spaties ',
  'Boodschappen @groente @fruit @winkel', // twee nieuwe labels en een bestaand
  'Vergadering morgen om 10 uur !15m !1u', // twee herinneringen
  // Engels: met lang "en" (en zonder lang) worden Engelse datums herkend; met lang "nl" blijft het Engelse woord in de titel staan
  'Call mom tomorrow at 9',
  'Buy milk today p3 @shopping',
  'Pay rent every month on the 1st',
  'Meeting next friday #Werk',
  'Dentist !30m p4',
];

test('de herkenning is dezelfde als in de web-app, voor Nederlandse en Engelse invoer, in verschillende tijdzones en talen', async () => {
  for (const tz of ['Europe/Amsterdam', 'America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
    const { db, anna } = world();
    const { view, inbox } = clientView(db, anna);
    // de taal van het apparaat ("nl" of "en"); zonder lang (een oudere app) geldt "en", dat ook Nederlands leest
    for (const [lang, language] of [['nl', 'nl'], ['en', 'en'], [undefined, 'en']] as const) for (const text of INPUTS) {
      const web = zone(tz, () => parseQuickAdd(text, { view, now: new Date(NOW), defaultProjectId: inbox, canAddTo: (id: string) => canEditProject(view, id, anna.id), language }));
      const answer = await quickAdd(db, anna.id, { text, dry_run: true, tz, typed_at: new Date(NOW).toISOString(), ...(lang ? { lang } : {}) }, NOW);
      const p = answer.preview!;
      const where = `${tz} (${lang ?? 'geen lang'}): ${text}`;
      assert.equal(p.content, web.content, where);
      assert.deepEqual(p.due, web.due, where);
      assert.equal(p.deadline, web.deadline, where);
      assert.equal(p.duration, web.duration ?? null, where);
      assert.equal(p.project.id, web.project_id, where);
      assert.equal(p.section?.id ?? null, web.section_id, where);
      assert.deepEqual(p.labels, [...web.labels.map((id: string) => ({ name: view.labels.get(id)!.name, new: false })), ...web.newLabels.map((name: string) => ({ name, new: true }))], where);
      assert.equal(p.priority, web.priority, where);
    }
  }
});

test('de taak op de server is dezelfde als die de web-app zou maken: velden, labels en herinneringen', async () => {
  const tz = 'Europe/Amsterdam';
  for (const [i, text] of INPUTS.entries()) {
    // twee gelijke werelden: in de ene voegt de web-app toe (zijn commando's via de sync), in de andere snel toevoegen
    const a = world();
    const b = world();
    const { view, inbox } = clientView(a.db, a.anna);
    const web = zone(tz, () => parseQuickAdd(text, { view, now: new Date(NOW), defaultProjectId: inbox, canAddTo: (id: string) => canEditProject(view, id, a.anna.id), language: 'nl' }));
    if (!web.content) continue;
    let sent: Command[] = [];
    let k = 0;
    const actions = createActions({ view, userId: a.anna.id, now: () => new Date(NOW), enqueue: async (c: Command[]) => { sent = c; } }, { makeId: () => `web-id-${String(++k).padStart(8, '0')}`, makeUuid: () => `web-uuid-${String(++k).padStart(8, '0')}` });
    const webId = await actions.addTask({ ...web });
    run(a.db, a.anna, sent);
    const answer = await quickAdd(b.db, b.anna.id, { text, uuid: `tickory-q-test-${i}`, tz, typed_at: new Date(NOW).toISOString(), lang: 'nl' }, NOW);
    const mine = (db: DatabaseSync, id: string) => {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row;
      const labels = (JSON.parse(task.labels) as string[]).map((l) => (db.prepare('SELECT name FROM labels WHERE id = ?').get(l) as Row).name);
      const reminders = (db.prepare('SELECT type, minute_offset, due FROM reminders WHERE task_id = ? AND is_deleted = 0 ORDER BY minute_offset, due').all(id) as Row[]).map((r) => ({ ...r }));
      const inbox = (db.prepare('SELECT inbox_project_id FROM users WHERE id = ?').get(task.creator_id) as Row).inbox_project_id;
      return { content: task.content, project: task.project_id === inbox ? 'de Inbox' : task.project_id, section: task.section_id, due: task.due, deadline: task.deadline, duration: task.duration, priority: task.priority, labels, reminders, order: task.order_key };
    };
    assert.deepEqual(mine(b.db, answer.task!.id as string), mine(a.db, webId), text);
    assert.equal(count(b.db, 'labels'), count(a.db, 'labels'), `${text}: evenveel labels`);
  }
});

test('"morgen" telt vanaf het moment van intypen, in de tijdzone van het apparaat, ook als het pas dagen later aankomt', async () => {
  const { db, anna } = world();
  const later = Date.parse('2026-11-16T12:00:00Z'); // drie dagen later pas verbinding
  const typed = '2026-11-13T23:30:00+01:00'; // vrijdagavond laat in Amsterdam
  const a = await quickAdd(db, anna.id, { text: 'Melk halen morgen', uuid: 'tickory-q-morgen-1', typed_at: typed, tz: 'Europe/Amsterdam' }, later);
  assert.equal((a.task!.due as Row).date, '2026-11-14');
  assert.equal(a.typed_at, '2026-11-13T22:30:00.000Z');
  // hetzelfde moment, maar het apparaat staat in Auckland: daar is het al zaterdag 11:30
  const b = await quickAdd(db, anna.id, { text: 'Melk halen morgen', uuid: 'tickory-q-morgen-2', typed_at: typed, tz: 'Pacific/Auckland' }, later);
  assert.equal((b.task!.due as Row).date, '2026-11-15');
  // in Los Angeles is het nog vrijdag 14:30
  const c = await quickAdd(db, anna.id, { text: 'Melk halen morgen om 8 uur', uuid: 'tickory-q-morgen-3', typed_at: typed, tz: 'America/Los_Angeles' }, later);
  assert.equal((c.task!.due as Row).date, '2026-11-14T08:00');
  // zonder typed_at: nu (de klok van de server)
  const d = await quickAdd(db, anna.id, { text: 'Melk halen morgen', uuid: 'tickory-q-morgen-4', tz: 'Europe/Amsterdam' }, later);
  assert.equal((d.task!.due as Row).date, '2026-11-17');
  // een vreemde tijdzone telt niet; dan die uit de instellingen, anders UTC
  const e = await quickAdd(db, anna.id, { text: 'Melk halen vandaag', uuid: 'tickory-q-morgen-5', typed_at: '2026-11-13T23:30:00+01:00', tz: 'Mars/Olympus' }, later);
  assert.equal(e.tz, 'UTC');
  assert.equal((e.task!.due as Row).date, '2026-11-13');
  const settingsId = `settings-${anna.id}`;
  run(db, anna, [cmd('settings_update', { id: settingsId, timezone: 'Pacific/Auckland' })]);
  const f = await quickAdd(db, anna.id, { text: 'Melk halen vandaag', uuid: 'tickory-q-morgen-6', typed_at: '2026-11-13T23:30:00+01:00' }, later);
  assert.equal(f.tz, 'Pacific/Auckland');
  assert.equal((f.task!.due as Row).date, '2026-11-14');
  // de tijdzone van het proces is daarna weer wat hij was
  assert.equal(process.env.TZ, undefined);
});

test('zomer- en wintertijd: rond de nachten van 29 maart en 25 oktober 2026 in Amsterdam gelijk aan de web-app', async () => {
  const { db, anna } = world();
  const { view, inbox } = clientView(db, anna);
  const moments = ['2026-03-29T01:30:00+01:00', '2026-03-29T03:10:00+02:00', '2026-03-29T23:59:00+02:00', '2026-10-25T02:30:00+02:00', '2026-10-25T02:30:00+01:00', '2026-10-24T23:45:00+02:00'];
  const texts = ['Klok checken vandaag om 02:30', 'Klok checken vandaag om 3 uur', 'Uitslapen morgen', 'Bakker over 2 uur', 'Wekker morgen om 7:00', 'Elke dag om 2:30 medicijn'];
  for (const typed of moments) {
    for (const text of texts) {
      const web = zone('Europe/Amsterdam', () => parseQuickAdd(text, { view, now: new Date(Date.parse(typed)), defaultProjectId: inbox, language: 'nl' }));
      const a = await quickAdd(db, anna.id, { text, dry_run: true, typed_at: typed, tz: 'Europe/Amsterdam', lang: 'nl' }, Date.parse(typed));
      assert.deepEqual(a.preview!.due, web.due, `${typed}: ${text}`);
      assert.equal(a.preview!.content, web.content, `${typed}: ${text}`);
    }
  }
  const b = await quickAdd(db, anna.id, { text: 'Uitslapen morgen', dry_run: true, typed_at: '2026-03-29T23:59:00+02:00', tz: 'Europe/Amsterdam' }, Date.parse('2026-03-29T21:59:00Z'));
  assert.equal((b.preview!.due as Row).date, '2026-03-30');
});

test('typed_at: een verkeerde klok op het toestel telt als nu; de vorm wordt gecontroleerd', () => {
  const now = Date.parse('2026-11-13T08:30:00Z');
  assert.equal(momentOf(null, now), now);
  assert.equal(momentOf('2026-11-13T09:00:00+01:00', now), Date.parse('2026-11-13T08:00:00Z'));
  assert.equal(momentOf('2026-11-13T09:00+01:00', now), Date.parse('2026-11-13T08:00:00Z'), 'zonder seconden');
  assert.equal(momentOf('2026-11-13T08:00:00.123456789Z', now), Date.parse('2026-11-13T08:00:00Z'), 'met nanoseconden (Java)');
  assert.equal(momentOf(new Date(now - TYPED_AT_PAST_MS + 60_000).toISOString(), now), now - TYPED_AT_PAST_MS + 60_000);
  assert.equal(momentOf(new Date(now - TYPED_AT_PAST_MS - 60_000).toISOString(), now), now, 'te ver terug');
  assert.equal(momentOf(new Date(now + TYPED_AT_FUTURE_MS - 60_000).toISOString(), now), now + TYPED_AT_FUTURE_MS - 60_000);
  assert.equal(momentOf(new Date(now + TYPED_AT_FUTURE_MS + 60_000).toISOString(), now), now, 'te ver vooruit');
  for (const bad of ['gisteren', '2026-11-13', '2026-11-13T09:00:00', '2026-13-45T09:00:00Z', '2026-11-13T09:00:00+1:00', 5, true, {}]) {
    assert.throws(() => readInput({ text: 'x', uuid: 'tickory-q-0001', typed_at: bad }), (e: SyncError) => e.code === 'INVALID_ARG', String(bad));
  }
  // de datumtaal: "nl" of "en"; zonder lang "en"
  for (const bad of ['fr', 'NL', '', 1]) assert.throws(() => readInput({ text: 'x', uuid: 'tickory-q-0001', lang: bad }), (e: SyncError) => e.code === 'INVALID_ARG', String(bad));
  assert.equal(readInput({ text: 'x', uuid: 'tickory-q-0001' }).lang, 'en');
  assert.equal(readInput({ text: 'x', uuid: 'tickory-q-0001', lang: 'nl' }).lang, 'nl');
  assert.equal(zoneOf('Europe/Amsterdam', 'UTC'), 'Europe/Amsterdam');
  assert.equal(zoneOf(null, 'America/New_York'), 'America/New_York');
  assert.equal(zoneOf('GMT+01:00', null), 'UTC');
  assert.equal(zoneOf(null, 'onzin'), 'UTC');
});

test('inZone: rekent echt in de opgegeven zone en zet de zone terug, ook na een fout', () => {
  const at = Date.parse('2026-11-13T22:30:00Z');
  assert.equal(inZone('Pacific/Auckland', () => new Date(at).getHours()), 11);
  assert.equal(inZone('America/Los_Angeles', () => new Date(at).getHours()), 14);
  assert.equal(process.env.TZ, undefined);
  assert.throws(() => inZone('Asia/Tokyo', () => { throw new Error('stuk'); }));
  assert.equal(process.env.TZ, undefined);
  process.env.TZ = 'Europe/Amsterdam';
  try {
    assert.equal(inZone('Asia/Tokyo', () => new Date(at).getHours()), 7);
    assert.equal(process.env.TZ, 'Europe/Amsterdam');
    assert.equal(inZone('Europe/Amsterdam', () => new Date(at).getHours()), 23);
  } finally {
    Reflect.deleteProperty(process.env, 'TZ');
  }
});

test('hetzelfde uuid nog eens: dezelfde taak, niets dubbel (ook geen label of herinnering), en ook nadat het register is opgeruimd', async () => {
  const { db, anna } = world();
  const body = { text: 'Huur betalen morgen om 10 uur @geld !15m', uuid: 'tickory-q-dubbel-01', tz: 'Europe/Amsterdam', typed_at: '2026-11-13T09:30:00+01:00' };
  const first = await quickAdd(db, anna.id, body, NOW);
  assert.equal(first.repeated, false);
  assert.equal(first.task!.id, derivedId(anna.id, 'tickory-q-dubbel-01', 0));
  const tasks = count(db, 'tasks'), labels = count(db, 'labels'), reminders = count(db, 'reminders');
  const again = await quickAdd(db, anna.id, body, NOW + 60_000);
  assert.equal(again.repeated, true);
  assert.equal(again.task!.id, first.task!.id);
  assert.deepEqual([count(db, 'tasks'), count(db, 'labels'), count(db, 'reminders')], [tasks, labels, reminders]);
  // ook met andere tekst (een tweede poging na een wijziging op het toestel): het uuid beslist
  const changed = await quickAdd(db, anna.id, { ...body, text: 'Iets anders' }, NOW + 120_000);
  assert.equal(changed.task!.id, first.task!.id);
  assert.equal(changed.task!.content, 'Huur betalen');
  // het register van uitgevoerde commando's is na 30 dagen opgeruimd: de taak bestaat nog, dus geen tweede
  db.prepare('DELETE FROM command_log').run();
  const late = await quickAdd(db, anna.id, body, NOW + 31 * 86_400_000);
  assert.equal(late.repeated, true);
  assert.equal(late.task!.id, first.task!.id);
  assert.deepEqual([count(db, 'tasks'), count(db, 'labels'), count(db, 'reminders')], [tasks, labels, reminders]);
  // een ander uuid is een nieuwe taak
  const other = await quickAdd(db, anna.id, { ...body, uuid: 'tickory-q-dubbel-02' }, NOW);
  assert.notEqual(other.task!.id, first.task!.id);
  assert.equal(count(db, 'tasks'), tasks + 1);
  assert.equal(count(db, 'labels'), labels, 'het label @geld bestond nu al');
});

test('nog eens nadat je uit het project bent gehaald: geen taak terug (die zie je niet meer), en geen nieuwe', async () => {
  const { db, anna, bram } = world();
  run(db, bram, [cmd('member_update', { project_id: 'project-gedeeld1', user_id: anna.id, role: 'member' })]);
  const body = { text: 'In gedeeld', project_id: 'project-gedeeld1', uuid: 'tickory-q-weg-00001' };
  const first = await quickAdd(db, anna.id, body, NOW);
  assert.equal(first.task!.project_id, 'project-gedeeld1');
  run(db, bram, [cmd('project_unshare', { project_id: 'project-gedeeld1', user_id: anna.id })]);
  const tasks = count(db, 'tasks');
  const again = await quickAdd(db, anna.id, body, NOW);
  assert.equal(again.repeated, true);
  assert.equal(again.task, null);
  assert.equal(count(db, 'tasks'), tasks);
});

test('een uuid waarmee je al eerder iets liet weigeren: dezelfde weigering, niets nieuws', async () => {
  const { db, anna } = world();
  const res = handleSync(db, { commands: [{ type: 'task_add', uuid: 'tickory-q-al-gebruikt-t', args: { id: 'task-mislukt-001', project_id: 'project-weg-00001', content: 'x' } }] }, anna.id);
  assert.equal((res.sync_status['tickory-q-al-gebruikt-t'] as { error_code: string }).error_code, 'NOT_FOUND');
  const tasks = count(db, 'tasks');
  assert.equal(await errorCode(quickAdd(db, anna.id, { text: 'Iets', uuid: 'tickory-q-al-gebruikt' }, NOW)), 'NOT_FOUND');
  assert.equal(count(db, 'tasks'), tasks);
});

test('handleSync met atomic: één weigering (nu of eerder) draait alles terug, ook het register, en zegt welk commando', () => {
  const { db, anna } = world();
  const before = { labels: count(db, 'labels'), log: count2(db), rev: rev(db) };
  const good = { type: 'label_add', uuid: 'atomic-test-0001', args: { id: 'label-atomic-01', name: 'atomisch' } };
  const bad = { type: 'task_add', uuid: 'atomic-test-0002', args: { id: 'task-atomic-001', project_id: 'project-weg-00001', content: 'x' } };
  assert.throws(() => handleSync(db, { commands: [good, bad] }, anna.id, { atomic: true }), (e: AtomicFailure) => e instanceof AtomicFailure && e.code === 'NOT_FOUND' && e.uuid === 'atomic-test-0002');
  assert.deepEqual({ labels: count(db, 'labels'), log: count2(db), rev: rev(db) }, before);
  // zonder atomic: het goede commando gaat door, het slechte niet (zoals altijd)
  const res = handleSync(db, { commands: [good, bad] }, anna.id);
  assert.equal(res.sync_status['atomic-test-0001'], 'ok');
  // het slechte uuid staat nu als geweigerd in het register: met atomic weigert een herhaling het hele verzoek
  const other = { type: 'label_add', uuid: 'atomic-test-0003', args: { id: 'label-atomic-02', name: 'nog een' } };
  assert.throws(() => handleSync(db, { commands: [other, bad] }, anna.id, { atomic: true }), (e: AtomicFailure) => e instanceof AtomicFailure && e.uuid === 'atomic-test-0002');
  assert.equal(count(db, 'labels'), before.labels + 1, 'alleen het label van de gewone sync');
});

test('een uuid van een andere gebruiker botst niet: dezelfde tekst en hetzelfde uuid zijn voor Bram een eigen taak', async () => {
  const { db, anna, bram } = world();
  const body = { text: 'Zelfde', uuid: 'tickory-q-zelfde-1' };
  const a = await quickAdd(db, anna.id, body, NOW);
  const b = await quickAdd(db, bram.id, body, NOW);
  assert.notEqual(a.task!.id, b.task!.id);
  assert.equal(b.repeated, false);
  assert.equal(b.task!.project_id, (db.prepare('SELECT inbox_project_id FROM users WHERE id = ?').get(bram.id) as Row).inbox_project_id);
});

test('rechten: een lezer krijgt FORBIDDEN, een onbekend project NOT_FOUND, en er blijft niets achter (ook geen nieuw label)', async () => {
  const { db, anna, bram } = world();
  const before = { tasks: count(db, 'tasks'), labels: count(db, 'labels'), rev: rev(db) };
  assert.equal(await errorCode(quickAdd(db, anna.id, { text: 'Iets @heelnieuw', project_id: 'project-gedeeld1', uuid: 'tickory-q-rechten1' }, NOW)), 'FORBIDDEN');
  assert.equal(await errorCode(quickAdd(db, anna.id, { text: 'Iets @heelnieuw', project_id: 'project-gedeeld1', dry_run: true }, NOW)), 'FORBIDDEN');
  assert.equal(await errorCode(quickAdd(db, anna.id, { text: 'Iets', project_id: 'project-bram-001', uuid: 'tickory-q-rechten2' }, NOW)), 'NOT_FOUND', 'het project van een ander bestaat voor jou niet');
  assert.equal(await errorCode(quickAdd(db, anna.id, { text: 'Iets', project_id: 'project-weg-00001', uuid: 'tickory-q-rechten3' }, NOW)), 'NOT_FOUND');
  assert.equal(await errorCode(quickAdd(db, anna.id, { text: 'Iets', project_id: 'project-werk-001', section_id: 'section-klus-001', uuid: 'tickory-q-rechten4' }, NOW)), 'NOT_FOUND', 'de sectie hoort bij een ander project');
  assert.equal(count(db, 'tasks'), before.tasks);
  assert.equal(count(db, 'labels'), before.labels);
  // de weigering is ook niet onthouden als "uitgevoerd": wordt Anna lid, dan lukt hetzelfde uuid alsnog
  run(db, bram, [cmd('member_update', { project_id: 'project-gedeeld1', user_id: anna.id, role: 'member' })]);
  const ok = await quickAdd(db, anna.id, { text: 'Iets @heelnieuw', project_id: 'project-gedeeld1', uuid: 'tickory-q-rechten1' }, NOW);
  assert.equal(ok.task!.project_id, 'project-gedeeld1');
  assert.deepEqual(ok.preview!.labels, [{ name: 'heelnieuw', new: true }]);
});

test('een project dat je net alleen mag lezen, maar dat de herkenner nog had kunnen kiezen (#naam): de tekst blijft staan, de taak komt in de Inbox', async () => {
  const { db, anna } = world();
  const a = await quickAdd(db, anna.id, { text: 'Leeskring in #Gedeeld project', uuid: 'tickory-q-lezer-01' }, NOW);
  assert.equal(a.preview!.project.inbox, true);
  assert.equal(a.task!.content, 'Leeskring in #Gedeeld project');
});

test('limieten: een volle bak geeft LIMIT_REACHED en het nieuwe label blijft dan ook weg; een vol aantal labels houdt de taak tegen', async () => {
  const { db, anna } = world();
  const saved = { ...LIMITS };
  try {
    LIMITS.tasksPerProject = 1; // Thuis heeft er al één
    const labels = count(db, 'labels');
    assert.equal(await errorCode(quickAdd(db, anna.id, { text: 'Nog een @extra', project_id: 'project-thuis-01', uuid: 'tickory-q-vol-0001' }, NOW)), 'LIMIT_REACHED');
    assert.equal(count(db, 'labels'), labels);
    LIMITS.tasksPerProject = saved.tasksPerProject;
    LIMITS.labelsPerUser = labels - 1; // Anna heeft er al meer (haar eigen drie)
    const tasks = count(db, 'tasks');
    assert.equal(await errorCode(quickAdd(db, anna.id, { text: 'Met label @nogeen', uuid: 'tickory-q-vol-0002' }, NOW)), 'LIMIT_REACHED');
    assert.equal(count(db, 'tasks'), tasks, 'zonder het label geen taak');
    // zonder nieuw label lukt het wel
    assert.equal((await quickAdd(db, anna.id, { text: 'Met label @bellen', uuid: 'tickory-q-vol-0003' }, NOW)).task!.labels.length, 1);
  } finally {
    Object.assign(LIMITS, saved);
  }
});

test('voorvertoning (dry_run): maakt niets aan en verandert niets, heeft geen uuid nodig en zegt wat het wordt', async () => {
  const { db, anna } = world();
  const before = { tasks: count(db, 'tasks'), labels: count(db, 'labels'), reminders: count(db, 'reminders'), log: count2(db), rev: rev(db) };
  const a = await quickAdd(db, anna.id, { text: 'Tandarts bellen morgen om 9 uur #Thuis /Klusjes @bellen @nieuw p2', dry_run: true, tz: 'Europe/Amsterdam', typed_at: '2026-11-13T09:30:00+01:00' }, NOW);
  assert.equal(a.dry_run, true);
  assert.equal(a.task, null);
  assert.deepEqual(a.preview, {
    content: 'Tandarts bellen', due: { date: '2026-11-14T09:00', string: 'morgen om 9 uur', lang: 'nl' }, deadline: null, duration: null,
    project: { id: 'project-thuis-01', name: 'Thuis', inbox: false }, section: { id: 'section-klus-001', name: 'Klusjes' },
    labels: [{ name: 'bellen', new: false }, { name: 'nieuw', new: true }], priority: 2, reminders: [{ type: 'relative', minute_offset: 30 }], auto_reminder: true,
    // welke tekst herkend is: 'morgen om 9 uur', '#Thuis', '/Klusjes', '@bellen', '@nieuw' en 'p2'
    spans: [{ start: 16, end: 31, kind: 'date' }, { start: 32, end: 38, kind: 'project' }, { start: 39, end: 47, kind: 'section' }, { start: 48, end: 55, kind: 'label' }, { start: 56, end: 62, kind: 'label' }, { start: 63, end: 65, kind: 'priority' }],
  });
  assert.deepEqual({ tasks: count(db, 'tasks'), labels: count(db, 'labels'), reminders: count(db, 'reminders'), log: count2(db), rev: rev(db) }, before);
  // een voorvertoning met een uuid onthoudt dat uuid niet: daarna echt toevoegen werkt gewoon
  await quickAdd(db, anna.id, { text: 'Eerst kijken', dry_run: true, uuid: 'tickory-q-kijk-001' }, NOW);
  assert.equal((await quickAdd(db, anna.id, { text: 'Eerst kijken', uuid: 'tickory-q-kijk-001' }, NOW)).repeated, false);
});
const count2 = (db: DatabaseSync): number => Number((db.prepare('SELECT COUNT(*) AS n FROM command_log').get() as Row).n);

test('de knoppen Vandaag, Morgen en de prioriteit zijn een standaard: wat je typt gaat voor', async () => {
  const { db, anna } = world();
  const at = { tz: 'Europe/Amsterdam', typed_at: '2026-11-13T09:30:00+01:00', dry_run: true };
  const p = async (extra: Record<string, unknown>) => (await quickAdd(db, anna.id, { ...at, ...extra }, NOW)).preview!;
  assert.deepEqual((await p({ text: 'Afwas', due: 'today' })).due, { date: '2026-11-13', string: 'vandaag', lang: 'nl' });
  assert.deepEqual((await p({ text: 'Afwas', due: 'tomorrow' })).due, { date: '2026-11-14', string: 'morgen', lang: 'nl' });
  assert.equal((await p({ text: 'Afwas maandag', due: 'tomorrow' })).due!.date, '2026-11-16');
  assert.equal((await p({ text: 'Afwas', priority: 1 })).priority, 1);
  assert.equal((await p({ text: 'Afwas p3', priority: 1 })).priority, 3);
  assert.equal((await p({ text: 'Afwas' })).priority, 4);
  // "morgen" van de knop telt ook vanaf het moment van intypen (laat op de avond van de 31e)
  const eind = await quickAdd(db, anna.id, { text: 'Oud papier', due: 'tomorrow', typed_at: '2026-12-31T23:50:00+01:00', tz: 'Europe/Amsterdam', dry_run: true }, Date.parse('2027-01-02T10:00:00Z'));
  assert.equal(eind.preview!.due!.date, '2027-01-01');
});

test('herinneringen: !30m gaat voor, anders de automatische uit de instellingen bij een tijd; -1 is geen', async () => {
  const { db, anna } = world();
  const at = { tz: 'Europe/Amsterdam', typed_at: '2026-11-13T09:30:00+01:00', dry_run: true };
  const p = async (text: string) => (await quickAdd(db, anna.id, { ...at, text }, NOW)).preview!;
  assert.deepEqual((await p('Bellen morgen om 9 uur !10m')).reminders, [{ type: 'relative', minute_offset: 10 }]);
  assert.equal((await p('Bellen morgen om 9 uur !10m')).auto_reminder, false);
  assert.equal((await p('Bellen morgen om 9 uur')).auto_reminder, true);
  assert.deepEqual((await p('Bellen morgen om 9 uur')).reminders, [{ type: 'relative', minute_offset: 30 }]);
  assert.deepEqual((await p('Bellen morgen')).reminders, [], 'zonder tijd geen automatische');
  assert.deepEqual((await p('Bellen morgen !(morgen om 8 uur)')).reminders, [{ type: 'absolute', date: '2026-11-14T08:00' }]);
  run(db, anna, [cmd('settings_update', { id: `settings-${anna.id}`, auto_reminder: 45 })]);
  assert.deepEqual((await p('Bellen morgen om 9 uur')).reminders, [{ type: 'relative', minute_offset: 45 }]);
  run(db, anna, [cmd('settings_update', { id: `settings-${anna.id}`, auto_reminder: -1 })]);
  assert.deepEqual((await p('Bellen morgen om 9 uur')).reminders, []);
  // en echt aangemaakt: van Anna zelf
  const real = await quickAdd(db, anna.id, { tz: 'Europe/Amsterdam', typed_at: '2026-11-13T09:30:00+01:00', text: 'Bellen morgen om 9 uur !1u', uuid: 'tickory-q-herinn-1' }, NOW);
  const rows = db.prepare('SELECT owner_id, minute_offset FROM reminders WHERE task_id = ? AND is_deleted = 0').all(real.task!.id as string) as Row[];
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ owner_id: anna.id, minute_offset: 60 }]);
});

test('een tekst met alleen een datum of label heeft geen naam: INVALID_ARG, niets aangemaakt', async () => {
  const { db, anna } = world();
  const tasks = count(db, 'tasks');
  for (const text of ['p1', '@bellen', '#Thuis p2', '@bellen #Werk !!2','  \n\t ']) {
    assert.equal(await errorCode(quickAdd(db, anna.id, { text, uuid: 'tickory-q-leeg-001' }, NOW)), 'INVALID_ARG', text);
  }
  assert.equal(count(db, 'tasks'), tasks);
});

test('het verzoek wordt streng gecontroleerd; een vreemd verzoek maakt nooit iets aan en gooit nooit iets anders dan een SyncError', async () => {
  const { db, anna } = world();
  const good = { text: 'Iets', uuid: 'tickory-q-fuzz-001' };
  const cases: [Record<string, unknown>, string][] = [
    [{}, 'INVALID_ARG'],
    [{ text: 5, uuid: good.uuid }, 'INVALID_ARG'],
    [{ text: 'x'.repeat(4001), uuid: good.uuid }, 'INVALID_ARG'],
    [{ text: 'Iets' }, 'MISSING_ARG'],
    [{ ...good, uuid: 'kort' }, 'INVALID_ARG'],
    [{ ...good, uuid: 'x'.repeat(57) }, 'INVALID_ARG'],
    [{ ...good, uuid: 'mag geen spaties' }, 'INVALID_ARG'],
    [{ ...good, project_id: "x'; DROP TABLE tasks; --" }, 'INVALID_ARG'],
    [{ ...good, project_id: 12 }, 'INVALID_ARG'],
    [{ ...good, section_id: 'a/b' }, 'INVALID_ARG'],
    [{ ...good, due: 'overmorgen' }, 'INVALID_ARG'],
    [{ ...good, priority: 0 }, 'INVALID_ARG'],
    [{ ...good, priority: 1.5 }, 'INVALID_ARG'],
    [{ ...good, priority: '1' }, 'INVALID_ARG'],
    [{ ...good, dry_run: 'ja' }, 'INVALID_ARG'],
    [{ ...good, tz: 'x'.repeat(65) }, 'INVALID_ARG'],
    [{ ...good, tz: 3 }, 'INVALID_ARG'],
    [{ ...good, content: 'Iets' }, 'UNKNOWN_ARG'],
    [{ ...good, __proto__: { x: 1 } } as Record<string, unknown>, 'ok'],
  ];
  for (const [body, expected] of cases) assert.equal(await errorCode(quickAdd(db, anna.id, { ...body }, NOW)), expected, JSON.stringify(body));
  // ook een voorvertoning controleert alles (daar komt geen sync aan te pas die het alsnog zou weigeren)
  const dry = { text: 'Iets', dry_run: true };
  for (const [body, expected] of [
    [{ ...dry, text: 'x'.repeat(4001) }, 'INVALID_ARG'], [{ ...dry, text: 'x'.repeat(4000) }, 'ok'],
    [{ ...dry, priority: 5 }, 'INVALID_ARG'], [{ ...dry, priority: 1.5 }, 'INVALID_ARG'], [{ ...dry, priority: 4 }, 'ok'],
    [{ ...dry, text: 'p1' }, 'INVALID_ARG'], [{ ...dry, text: '@bellen' }, 'INVALID_ARG'],
  ] as [Record<string, unknown>, string][]) {
    assert.equal(await errorCode(quickAdd(db, anna.id, body, NOW)), expected, JSON.stringify(body).slice(0, 80));
  }
  await assert.rejects(quickAdd(db, anna.id, { ...dry, text: ' \t ' }, NOW), /geef de tekst van de taak/);
  await assert.rejects(quickAdd(db, anna.id, { ...dry, text: 'p1' }, NOW), /geen naam/);
  // willekeurige verzoeken
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const values = [null, undefined, '', 'x', 'Iets morgen #Thuis', '#Gedeeld project', 0, 1, 4, -1, true, false, [], {}, 'project-thuis-01', 'project-gedeeld1', 'project-bram-001', 'today', 'tomorrow', '2026-11-13T09:30:00+01:00', 'Europe/Amsterdam', 'tickory-q-random', '\u0000', '😀'.repeat(3000)];
  const keys = ['text', 'project_id', 'section_id', 'uuid', 'typed_at', 'tz', 'due', 'priority', 'dry_run', 'extra'];
  const tasksBefore = count(db, 'tasks');
  let created = 0;
  for (let i = 0; i < 400; i++) {
    const body: Record<string, unknown> = {};
    for (const k of keys) if (rnd() < 0.5) body[k] = values[Math.floor(rnd() * values.length)];
    const code = await errorCode(quickAdd(db, anna.id, body, NOW));
    if (code === 'ok' && body.dry_run !== true) created += 1;
  }
  const projects = (db.prepare('SELECT DISTINCT project_id FROM tasks WHERE is_deleted = 0').all() as Row[]).map((r) => r.project_id);
  assert.ok(!projects.includes('project-bram-001') && !projects.includes('project-gedeeld1'), 'nooit in een project van een ander of waar Anna lezer is');
  assert.ok(count(db, 'tasks') <= tasksBefore + created);
});

test('een geblokkeerde gebruiker kan niets toevoegen', async () => {
  const { db, anna } = world();
  db.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?').run(anna.id);
  assert.equal(await errorCode(quickAdd(db, anna.id, { text: 'Iets', uuid: 'tickory-q-blok-001' }, NOW)), 'UNAUTHORIZED');
});

test('de voorvertoning laat niets zien van een ander: geen projectnamen of labels van Bram', async () => {
  const { db, anna } = world();
  const a = await quickAdd(db, anna.id, { text: 'Kijken #Geheim van Bram @brams label', dry_run: true }, NOW);
  assert.equal(a.preview!.project.inbox, true);
  assert.equal(a.preview!.content, 'Kijken #Geheim van Bram label');
  assert.deepEqual(a.preview!.labels, [{ name: 'brams', new: true }], 'het label van Bram kent Anna niet; "brams" wordt een nieuw label van haarzelf');
});

test('de beperking per gebruiker: toevoegen en voorvertonen elk apart, per minuut', () => {
  let t = 0;
  const limiter = new QuickAddLimiter({ add: 2, preview: 3 }, 60_000, () => t);
  assert.equal(limiter.take('anna', 'add'), 0);
  assert.equal(limiter.take('anna', 'add'), 0);
  assert.equal(limiter.take('anna', 'add'), 60);
  assert.equal(limiter.take('bram', 'add'), 0, 'een ander heeft zijn eigen teller');
  for (let i = 0; i < 3; i++) assert.equal(limiter.take('anna', 'preview'), 0);
  assert.ok(limiter.take('anna', 'preview') > 0);
  t = 30_000;
  assert.equal(limiter.take('anna', 'add'), 30);
  t = 60_001;
  assert.equal(limiter.take('anna', 'add'), 0, 'na een minuut weer');
  const standard = new QuickAddLimiter();
  assert.deepEqual(standard.limits, { add: 60, preview: 240 });
});

test('met "datums herkennen" uit (Instellingen › Algemeen) herkent de server ook geen datums in gewone taal', async () => {
  const { db, anna } = world();
  run(db, anna, [cmd('settings_update', { id: `settings-${anna.id}`, general: { date_recognition: false } })]);
  const answer = await quickAdd(db, anna.id, { text: 'Tandarts morgen 9:00-10:30 {vrijdag}', dry_run: true, tz: 'Europe/Amsterdam', typed_at: new Date(NOW).toISOString() }, NOW);
  const p = answer.preview!;
  assert.equal(p.content, 'Tandarts morgen 9:00-10:30');
  assert.equal(p.due, null);
  assert.equal(p.duration, null);
  assert.ok(p.deadline, 'een {deadline} werkt wel');
  run(db, anna, [cmd('settings_update', { id: `settings-${anna.id}`, general: { date_recognition: true } })]);
  const again = await quickAdd(db, anna.id, { text: 'Tandarts morgen 9:00-10:30', dry_run: true, tz: 'Europe/Amsterdam', typed_at: new Date(NOW).toISOString() }, NOW);
  assert.equal(again.preview!.duration, 90);
});

test('de algemene voorkeuren worden gecontroleerd: een onbekende startpagina wordt geweigerd', () => {
  const { db, anna } = world();
  const res = handleSync(db, { commands: [cmd('settings_update', { id: `settings-${anna.id}`, general: { start_page: 'ergens' } })] }, anna.id);
  assert.notEqual(Object.values(res.sync_status)[0], 'ok');
});
