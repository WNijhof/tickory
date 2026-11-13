// Meldingen in de browser: aanmelden van apparaten, de klok die herinneringen verstuurt, en de knoppen in een melding.
// De pushdienst is nagebootst; de berichten worden ontsleuteld zoals een echte browser dat doet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LATE_WINDOW_MS, createPush } from './push.ts';
import { handleSync } from './sync.ts';
import type { Command } from './sync.ts';
import { addUser, freshDb, pushDevice } from './testutil.ts';
import { createSession, revokeSession, updateUser } from './users.ts';
import type { UserRow } from './users.ts';

type Row = Record<string, any>;
const AMS = 'Europe/Amsterdam';
const at = (iso: string) => Date.parse(iso);
let n = 0;
const cmd = (type: string, args: Record<string, unknown>): Command => ({ type, uuid: `push-test-${String(++n).padStart(7, '0')}`, args });

function world() {
  const db = freshDb();
  const alice = addUser(db, 'alice', 'Alice');
  const bob = addUser(db, 'bob', 'Bob');
  const state = { clock: at('2026-12-01T06:00:00Z'), respond: (_url: string): number | Error => 201 };
  const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    const r = state.respond(url);
    if (r instanceof Error) throw r;
    if (r >= 200 && r < 300) sent.push({ url, headers: init.headers, body: init.body }); // alleen wat de pushdienst aanneemt, komt bij het apparaat
    return new Response(null, { status: r });
  }) as unknown as typeof fetch;
  const push = createPush({ db, fetch: fetchFn, now: () => state.clock, defaultTimeZone: AMS });
  const run = (as: UserRow, commands: Command[]) => {
    const res = handleSync(db, { commands }, as.id);
    for (const c of commands) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`);
    return res;
  };
  /** Meldt een nagebootst apparaat aan voor een gebruiker; geeft het apparaat en wat het ontvangen heeft. */
  const device = (user: UserRow, name: string, lang?: string) => {
    const d = pushDevice(name);
    const session = createSession(db, user.id, name);
    push.subscribe(user.id, session.id, { ...d.subscription, ...(lang ? { lang } : {}) });
    const received = () => sent.filter((s) => s.url === d.subscription.endpoint).map((s) => JSON.parse(d.decrypt(s.body)) as Row);
    return { ...d, session, received };
  };
  /** Een taak in de Inbox met een herinnering "zoveel minuten vooraf". */
  const taskWithReminder = (user: UserRow, id: string, due: string, offset = 30) => {
    run(user, [
      cmd('task_add', { id: `task-${id}`, project_id: user.inbox_project_id, content: `Taak ${id}`, due: { date: due } }),
      cmd('reminder_add', { id: `remind-${id}`, task_id: `task-${id}`, type: 'relative', minute_offset: offset }),
    ]);
  };
  return { db, alice, bob, push, state, sent, run, device, taskWithReminder };
}

test('de sleutels van de server blijven bewaard; een beschadigde sleutel wordt vervangen en oude aanmeldingen vervallen', () => {
  const w = world();
  assert.equal(Buffer.from(w.push.publicKey, 'base64url').length, 65);
  assert.equal(createPush({ db: w.db }).publicKey, w.push.publicKey, 'na een herstart dezelfde sleutel');
  w.device(w.alice, 'telefoon');
  w.db.prepare("UPDATE meta SET value = 'kapot' WHERE key = 'vapid_private'").run();
  const again = createPush({ db: w.db });
  assert.notEqual(again.publicKey, w.push.publicKey);
  assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as Row).n, 0);
  assert.equal(createPush({ db: w.db }).publicKey, again.publicKey);
});

test('aanmelden: alleen bekende pushdiensten en geldige sleutels; hetzelfde apparaat opnieuw vervangt de oude aanmelding', () => {
  const w = world();
  const session = createSession(w.db, w.alice.id, 'Laptop');
  const d = pushDevice('laptop');
  for (const bad of [
    { ...d.subscription, endpoint: 'https://192.168.1.10/push' }, { ...d.subscription, endpoint: 'http://fcm.googleapis.com/x' },
    { ...d.subscription, endpoint: 'https://evil.example.com/x' }, { ...d.subscription, endpoint: 5 }, { keys: d.subscription.keys },
    { endpoint: d.subscription.endpoint }, { endpoint: d.subscription.endpoint, keys: { p256dh: 'kort', auth: d.subscription.keys.auth } },
    { endpoint: d.subscription.endpoint, keys: { p256dh: d.subscription.keys.p256dh, auth: 'kort' } },
    { endpoint: `https://fcm.googleapis.com/${'x'.repeat(2000)}`, keys: d.subscription.keys },
  ]) {
    assert.throws(() => w.push.subscribe(w.alice.id, session.id, bad as any), /pushdienst|sleutels/, JSON.stringify(bad).slice(0, 80));
  }
  w.push.subscribe(w.alice.id, session.id, d.subscription);
  w.push.subscribe(w.alice.id, session.id, d.subscription);
  const list = w.push.list(w.alice.id, session.id);
  assert.equal(list.length, 1, 'geen dubbele aanmelding');
  assert.deepEqual([list[0].device, list[0].current, list[0].last_success_at, list[0].last_error], ['Laptop', true, null, null]);
  assert.equal(w.push.list(w.alice.id, 'andere-sessie')[0].current, false);
  assert.ok(!JSON.stringify(list).includes(d.subscription.keys.auth), 'sleutels en adressen komen niet in het overzicht');

  // dezelfde browser, nu ingelogd als bob: de aanmelding gaat over naar bob
  const bobSession = createSession(w.db, w.bob.id, 'Laptop');
  w.push.subscribe(w.bob.id, bobSession.id, d.subscription);
  assert.equal(w.push.list(w.alice.id, session.id).length, 0);
  assert.equal(w.push.list(w.bob.id, bobSession.id).length, 1);
  // afmelden kan alleen je eigen apparaat
  assert.equal(w.push.unsubscribe(w.alice.id, d.subscription.endpoint), false);
  assert.equal(w.push.unsubscribe(w.bob.id, d.subscription.endpoint), true);
  assert.equal(w.push.unsubscribe(w.bob.id, d.subscription.endpoint), false);
  assert.equal(w.push.unsubscribe(w.bob.id, 42), false);
});

test('niet meer dan twintig apparaten per gebruiker: de oudste vervallen', () => {
  const w = world();
  for (let i = 0; i < 23; i++) {
    w.state.clock += 1000;
    w.device(w.alice, `apparaat${i}`);
  }
  const names = w.push.list(w.alice.id, '').map((s) => s.device);
  assert.equal(names.length, 20);
  assert.ok(names.includes('apparaat22') && !names.includes('apparaat0') && !names.includes('apparaat2') && names.includes('apparaat3'));
});

test('een ingetrokken sessie of geblokkeerd account krijgt geen meldingen meer', async () => {
  const w = world();
  addUser(w.db, 'reserve');
  updateUser(w.db, (w.db.prepare("SELECT id FROM users WHERE username = 'reserve'").get() as Row).id, { is_admin: true });
  const phone = w.device(w.alice, 'telefoon');
  const laptop = w.device(w.alice, 'laptop');
  const bobPhone = w.device(w.bob, 'bob-telefoon');
  w.taskWithReminder(w.alice, 'aaa1', '2026-12-01T09:00');
  w.taskWithReminder(w.bob, 'bbb1', '2026-12-01T09:00');
  revokeSession(w.db, w.alice.id, laptop.session.id);
  w.db.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?').run(w.bob.id);
  w.state.clock = at('2026-12-01T07:30:00Z'); // 08:30 in Amsterdam
  const r = await w.push.tick();
  assert.equal(r.removed, 2);
  assert.equal(phone.received().length, 1);
  assert.equal(laptop.received().length, 0);
  assert.equal(bobPhone.received().length, 0);
});

test('de klok: een herinnering gaat op het juiste moment naar alle apparaten van die gebruiker, één keer', async () => {
  const w = world();
  const phone = w.device(w.alice, 'telefoon');
  const laptop = w.device(w.alice, 'laptop', 'en');
  const bobPhone = w.device(w.bob, 'bob-telefoon');
  w.taskWithReminder(w.alice, 'aaa1', '2026-12-01T09:00', 30); // 08:30 Amsterdam = 07:30 UTC

  w.state.clock = at('2026-12-01T07:29:59Z');
  assert.deepEqual(await w.push.tick(), { due: 0, sent: 0, failed: 0, removed: 0 });
  w.state.clock = at('2026-12-01T07:30:00Z');
  assert.deepEqual(await w.push.tick(), { due: 1, sent: 2, failed: 0, removed: 0 });
  assert.deepEqual(await w.push.tick(), { due: 0, sent: 0, failed: 0, removed: 0 }, 'niet nog een keer');

  const [m] = phone.received();
  assert.deepEqual([m.v, m.type, m.id, m.task_id, m.title, m.time, m.moment, m.lang], [1, 'reminder', 'remind-aaa1', 'task-aaa1', 'Taak aaa1', '2026-12-01T09:00', '2026-12-01T08:30', 'nl']);
  assert.equal(laptop.received()[0].lang, 'en', 'elk apparaat in zijn eigen taal');
  assert.equal(bobPhone.received().length, 0, 'niet naar andermans apparaat');
  const h = w.sent[0].headers;
  assert.equal(h.Urgency, 'high');
  assert.equal(h.TTL, String(LATE_WINDOW_MS / 1000));
  assert.equal(h.Topic.length, 32);
  assert.match(h.Authorization, /^vapid t=.+, k=.+$/);
  const claims = (auth: string) => JSON.parse(Buffer.from(/t=[\w-]+\.([\w-]+)\./.exec(auth)![1], 'base64url').toString());
  assert.equal(claims(h.Authorization).sub, undefined, 'zonder ingesteld contactadres gaat er geen mee');
  assert.ok(!JSON.stringify(claims(h.Authorization)).includes('github'), 'en zeker niet het adres van het project');
  assert.ok(w.push.list(w.alice.id, phone.session.id).every((s) => s.last_success_at === '2026-12-01T07:30:00.000Z'));
});

test('het contactadres voor de pushdienst komt uit de instelling van de beheerder, en alleen in een geldige vorm', async () => {
  const sub = async (subject: string | undefined) => {
    const db = freshDb();
    const user = addUser(db, 'anna');
    const seen: string[] = [];
    const fetchFn = (async (_url: string, init: any) => { seen.push(init.headers.Authorization); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    const p = createPush({ db, fetch: fetchFn, subject });
    const d = pushDevice('telefoon');
    p.subscribe(user.id, createSession(db, user.id, 'telefoon').id, d.subscription);
    await p.sendTest(user.id);
    return JSON.parse(Buffer.from(/t=[\w-]+\.([\w-]+)\./.exec(seen[0])![1], 'base64url').toString()).sub;
  };
  assert.equal(await sub('mailto:beheer@voorbeeld.nl'), 'mailto:beheer@voorbeeld.nl');
  assert.equal(await sub('https://taken.voorbeeld.nl/contact'), 'https://taken.voorbeeld.nl/contact');
  for (const bad of [undefined, '', 'beheer@voorbeeld.nl', 'http://onveilig.voorbeeld.nl', 'mailto:geen-adres', 'zomaar tekst']) {
    assert.equal(await sub(bad), undefined, String(bad));
  }
});

test('de tijdzone uit de instellingen bepaalt het moment; zonder instelling geldt die van de server', async () => {
  const w = world();
  const a = w.device(w.alice, 'amsterdam');
  const b = w.device(w.bob, 'new-york');
  w.run(w.bob, [cmd('settings_update', { id: `settings-${w.bob.id}`, timezone: 'America/New_York' })]);
  w.taskWithReminder(w.alice, 'aaa1', '2026-12-01T09:00', 0);
  w.taskWithReminder(w.bob, 'bbb1', '2026-12-01T09:00', 0);
  w.state.clock = at('2026-12-01T08:00:00Z'); // 09:00 in Amsterdam, 03:00 in New York
  await w.push.tick();
  assert.deepEqual([a.received().length, b.received().length], [1, 0]);
  w.state.clock = at('2026-12-01T14:00:00Z'); // 09:00 in New York
  await w.push.tick();
  assert.deepEqual([a.received().length, b.received().length], [1, 1]);
});

test('te laat (bijvoorbeeld na een herstart): binnen een uur gaat het alsnog, daarna niet meer', async () => {
  const w = world();
  const d = w.device(w.alice, 'telefoon');
  w.taskWithReminder(w.alice, 'op-tijd', '2026-12-01T09:00', 0); // 08:00 UTC
  w.taskWithReminder(w.alice, 'te-laat', '2026-12-01T08:59', 0); // 07:59 UTC
  w.state.clock = at('2026-12-01T09:00:00Z');
  await w.push.tick();
  assert.deepEqual(d.received().map((m) => m.id), ['remind-op-tijd'], 'precies een uur te laat gaat nog; een uur en een minuut niet');
  w.state.clock = at('2026-12-01T12:00:00Z');
  await w.push.tick();
  assert.equal(d.received().length, 1);
});

test('geen melding voor wat niet meer speelt', async () => {
  const w = world();
  const d = w.device(w.alice, 'telefoon');
  const bobDevice = w.device(w.bob, 'bob-telefoon');
  for (const id of ['afgevinkt', 'taak-weg', 'herinn-weg', 'geen-tijd', 'goed']) w.taskWithReminder(w.alice, id, id === 'geen-tijd' ? '2026-12-01' : '2026-12-01T09:00', 0);
  w.run(w.alice, [cmd('task_complete', { id: 'task-afgevinkt' }), cmd('task_delete', { id: 'task-taak-weg' }), cmd('reminder_delete', { id: 'remind-herinn-weg' })]);
  // bob had een herinnering bij een gedeelde taak, maar is uit het project gehaald
  w.run(w.alice, [cmd('project_add', { id: 'project-gedeeld1', name: 'Samen' }), cmd('project_share', { project_id: 'project-gedeeld1', username: 'bob' }),
    cmd('task_add', { id: 'task-gedeeld-01', project_id: 'project-gedeeld1', content: 'Gedeeld', due: { date: '2026-12-01T09:00' } })]);
  w.run(w.bob, [cmd('reminder_add', { id: 'remind-bob-0001', task_id: 'task-gedeeld-01', type: 'relative', minute_offset: 0 })]);
  w.db.prepare("UPDATE project_members SET is_deleted = 1 WHERE project_id = 'project-gedeeld1' AND user_id = ?").run(w.bob.id); // zonder de opruiming van project_unshare
  // een verwijderde taak waarvan de herinnering (door een fout elders) is blijven staan
  w.taskWithReminder(w.alice, 'half-weg', '2026-12-01T09:00', 0);
  w.db.prepare("UPDATE tasks SET is_deleted = 1 WHERE id = 'task-half-weg'").run();
  // carol heeft een herinnering maar geen apparaat
  const carol = addUser(w.db, 'carol');
  w.taskWithReminder(carol, 'carol', '2026-12-01T09:00', 0);

  w.state.clock = at('2026-12-01T08:00:00Z');
  const r = await w.push.tick();
  assert.deepEqual(d.received().map((m) => m.id), ['remind-goed']);
  assert.equal(bobDevice.received().length, 0, 'geen melding over een taak die je niet meer mag zien');
  assert.equal(r.due, 1);
  assert.equal(w.sent.length, 1);
});

test('een terugkerende taak: na het afvinken komt de herinnering de volgende keer opnieuw', async () => {
  const w = world();
  const d = w.device(w.alice, 'telefoon');
  w.run(w.alice, [
    cmd('task_add', { id: 'task-medicijn-1', project_id: w.alice.inbox_project_id, content: 'Medicijnen', due: { date: '2026-12-01T08:00', recurrence: { freq: 'daily' } } }),
    cmd('reminder_add', { id: 'remind-medicijn', task_id: 'task-medicijn-1', type: 'relative', minute_offset: 0 }),
  ]);
  w.state.clock = at('2026-12-01T07:00:00Z');
  await w.push.tick();
  w.run(w.alice, [cmd('task_complete', { id: 'task-medicijn-1' })]);
  w.state.clock = at('2026-12-01T07:20:00Z');
  await w.push.tick();
  assert.equal(d.received().length, 1, 'vandaag niet opnieuw');
  w.state.clock = at('2026-12-02T07:00:00Z');
  await w.push.tick();
  assert.deepEqual(d.received().map((m) => m.moment), ['2026-12-01T08:00', '2026-12-02T08:00']);
});

test('lukt het versturen even niet, dan volgt een nieuwe poging; een blijvende fout wordt niet eindeloos herhaald', async () => {
  const w = world();
  const d = w.device(w.alice, 'telefoon');
  w.taskWithReminder(w.alice, 'aaa1', '2026-12-01T09:00', 0);
  w.state.clock = at('2026-12-01T08:00:00Z');
  w.state.respond = () => 503;
  assert.deepEqual(await w.push.tick(), { due: 1, sent: 0, failed: 1, removed: 0 });
  assert.match(w.push.list(w.alice.id, '')[0].last_error!, /503/);
  w.state.respond = () => new TypeError('fetch failed');
  w.state.clock += 20_000;
  assert.equal((await w.push.tick()).failed, 1);
  assert.match(w.push.list(w.alice.id, '')[0].last_error!, /geen verbinding/);
  w.state.respond = () => 201;
  w.state.clock += 20_000;
  assert.deepEqual(await w.push.tick(), { due: 1, sent: 1, failed: 0, removed: 0 });
  assert.equal(d.received().length, 1);
  assert.equal(w.push.list(w.alice.id, '')[0].last_error, null, 'na succes is de fout weg');
  assert.equal((await w.push.tick()).due, 0);

  // een blijvende weigering (400): één poging, daarna klaar
  w.taskWithReminder(w.alice, 'aaa2', '2026-12-01T10:00', 0);
  w.state.clock = at('2026-12-01T09:00:00Z');
  w.state.respond = () => 400;
  assert.equal((await w.push.tick()).failed, 1);
  w.state.clock += 20_000;
  assert.equal((await w.push.tick()).due, 0);
});

test('een apparaat dat niet meer bestaat (410) wordt vergeten', async () => {
  const w = world();
  w.device(w.alice, 'oud');
  const fresh = w.device(w.alice, 'nieuw');
  w.taskWithReminder(w.alice, 'aaa1', '2026-12-01T09:00', 0);
  w.state.clock = at('2026-12-01T08:00:00Z');
  w.state.respond = (url) => (url.includes('/oud-') ? 410 : 201);
  await w.push.tick();
  assert.deepEqual(w.push.list(w.alice.id, '').map((s) => s.device), ['nieuw']);
  assert.equal(fresh.received().length, 1);
});

test('twee rondes tegelijk: de tweede doet niets, zodat niets dubbel wordt verstuurd', async () => {
  const w = world();
  const d = w.device(w.alice, 'telefoon');
  w.taskWithReminder(w.alice, 'aaa1', '2026-12-01T09:00', 0);
  w.state.clock = at('2026-12-01T08:00:00Z');
  const [a, b] = await Promise.all([w.push.tick(), w.push.tick()]);
  assert.deepEqual([a.sent + b.sent, d.received().length], [1, 1]);
});

test('de knoppen in een melding: "Voltooien" vinkt af, "Over 10 minuten" stelt uit, elk één keer', async () => {
  const w = world();
  const d = w.device(w.alice, 'telefoon');
  w.taskWithReminder(w.alice, 'aaa1', '2026-12-01T09:00', 0);
  w.taskWithReminder(w.alice, 'aaa2', '2026-12-01T09:00', 0);
  w.state.clock = at('2026-12-01T08:00:00Z');
  await w.push.tick();
  const [m1, m2] = d.received().sort((x, y) => (x.id < y.id ? -1 : 1));
  const task = (id: string) => (handleSync(w.db, {}, w.alice.id).tasks as Row[]).find((t) => t.id === id)!;

  assert.deepEqual(w.push.handleAction(m1.complete), { ok: true, userId: w.alice.id });
  assert.equal(task('task-aaa1').checked, true);
  assert.equal(task('task-aaa2').checked, false, 'alleen de taak van deze melding');
  assert.deepEqual(w.push.handleAction(m1.complete), { ok: true, userId: w.alice.id }, 'twee keer drukken is geen fout');
  assert.equal(task('task-aaa1').completed_count, 1, 'en vinkt maar één keer af');

  w.state.clock = at('2026-12-01T08:05:00Z');
  assert.equal(w.push.handleAction(m2.snooze).ok, true);
  w.push.handleAction(m2.snooze);
  const reminders = (handleSync(w.db, {}, w.alice.id).reminders as Row[]).filter((r) => r.task_id === 'task-aaa2' && r.type === 'absolute');
  assert.deepEqual(reminders.map((r) => r.due.date), ['2026-12-01T09:15'], 'tien minuten later, in de tijd van de gebruiker, één keer');
  w.state.clock = at('2026-12-01T08:14:59Z');
  await w.push.tick();
  assert.equal(d.received().length, 2);
  w.state.clock = at('2026-12-01T08:15:00Z');
  await w.push.tick();
  assert.deepEqual(d.received().map((m) => m.task_id), ['task-aaa1', 'task-aaa2', 'task-aaa2'], 'de uitgestelde melding komt opnieuw');
});

test('een knop werkt alleen met een echt, niet verlopen bewijsje, en alleen voor wat de gebruiker nog mag', async () => {
  const w = world();
  const d = w.device(w.alice, 'telefoon');
  w.taskWithReminder(w.alice, 'aaa1', '2026-12-01T09:00', 0);
  w.state.clock = at('2026-12-01T08:00:00Z');
  await w.push.tick();
  const token: string = d.received()[0].complete;
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), t: 'task-van-iemand-anders' })).toString('base64url');
  for (const bad of [`${forged}.${mac}`, `${body}.${mac.slice(0, -2)}xx`, `${body}`, `${body}.${mac}.extra`, '', 'x.y', null, 42, 'a'.repeat(2000)]) {
    assert.equal(w.push.handleAction(bad).ok, false, String(bad).slice(0, 40));
  }
  assert.equal((handleSync(w.db, {}, w.alice.id).tasks as Row[])[0].checked, false, 'er is niets afgevinkt');
  // een bewijsje van een andere server (ander geheim) werkt hier niet
  const other = createPush({ db: freshDb() });
  assert.equal(w.push.handleAction(other.sign({ a: 'complete', u: w.alice.id, t: 'task-aaa1', e: 9_999_999_999 })).ok, false);
  // verlopen na een dag
  w.state.clock += 24 * 3600_000 + 1000;
  assert.equal(w.push.handleAction(token).ok, false);
  w.state.clock -= 2000;
  // de taak is intussen weg: de knop meldt dat het niet lukte
  w.run(w.alice, [cmd('task_delete', { id: 'task-aaa1' })]);
  const gone = w.push.handleAction(token);
  assert.deepEqual([gone.ok, gone.userId], [false, w.alice.id]);
  // geblokkeerd account
  addUser(w.db, 'reserve');
  w.db.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?').run(w.alice.id);
  assert.equal(w.push.handleAction(token).ok, false);
});

test('een knop is een handeling: een vervormde maar gelijkwaardige tekst van hetzelfde bewijsje telt niet als een nieuwe', async () => {
  const w = world();
  const d = w.device(w.alice, 'telefoon');
  w.run(w.alice, [cmd('task_add', { id: 'task-herhaal1', project_id: w.alice.inbox_project_id, content: 'Dagelijks', due: { date: '2026-12-01T09:00', recurrence: { freq: 'daily' } } }),
    cmd('reminder_add', { id: 'remind-herhaal1', task_id: 'task-herhaal1', type: 'relative', minute_offset: 0 })]);
  w.state.clock = at('2026-12-01T08:00:00Z');
  await w.push.tick();
  const [message] = d.received();
  const due = () => ((handleSync(w.db, {}, w.alice.id).tasks as Row[]).find((t) => t.id === 'task-herhaal1')!.due as Row).date;
  const token: string = message.complete;
  assert.equal(w.push.handleAction(token).ok, true);
  assert.equal(due(), '2026-12-02T09:00');
  const [body, mac] = token.split('.');
  // alles wat een tolerante base64-lezer zou negeren of toestaan: spaties, regeleinden, '=', een ander laatste teken (staartbits)
  const lastIndex = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(mac.slice(-1));
  const tailVariants = Array.from({ length: 4 }, (_, i) => `${mac.slice(0, -1)}${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[(lastIndex & ~3) | i]}`).filter((m) => m !== mac);
  const variants = [`${token} `, ` ${token}`, `${token}\n`, `${body}.${mac}=`, `${body}=.${mac}`, `${body}.${mac.slice(0, 10)}\n${mac.slice(10)}`, `${body}\n.${mac}`, ...tailVariants.map((m) => `${body}.${m}`)];
  for (const v of variants) {
    assert.equal(w.push.handleAction(v).ok, false, JSON.stringify(v).slice(0, 60));
  }
  assert.equal(due(), '2026-12-02T09:00', 'geen enkele variant heeft de taak verder geschoven');
  assert.equal(w.push.handleAction(token).ok, true, 'het echte bewijsje blijft gewoon werken (en doet niets nieuws)');
  assert.equal(due(), '2026-12-02T09:00');
  // het uitstellen: één bewijsje maakt één herinnering, ook als het vaak (en vervormd) wordt aangeboden
  const snooze: string = message.snooze;
  for (const v of [snooze, snooze, `${snooze} `, `${snooze}\n`, `${snooze}=`]) w.push.handleAction(v);
  const extra = (handleSync(w.db, {}, w.alice.id).reminders as Row[]).filter((r) => r.task_id === 'task-herhaal1' && r.type === 'absolute');
  assert.equal(extra.length, 1);
});

test('een knop werkt niet meer zodra het apparaat is afgemeld of de sessie is ingetrokken', async () => {
  const w = world();
  const d = w.device(w.alice, 'telefoon');
  w.taskWithReminder(w.alice, 'aaa1', '2026-12-01T09:00', 0);
  w.state.clock = at('2026-12-01T08:00:00Z');
  await w.push.tick();
  const token: string = d.received()[0].complete;
  revokeSession(w.db, w.alice.id, d.session.id); // uitgelogd, of het wachtwoord is gewijzigd
  assert.equal(w.push.handleAction(token).ok, false);
  assert.equal((handleSync(w.db, {}, w.alice.id).tasks as Row[])[0].checked, false, 'er is niets afgevinkt');
});

test('een proefmelding gaat naar alle eigen apparaten en meldt wat niet lukte', async () => {
  const w = world();
  const a = w.device(w.alice, 'telefoon');
  const b = w.device(w.alice, 'laptop', 'en');
  const other = w.device(w.bob, 'bob-telefoon');
  w.state.respond = (url) => (url.includes('/laptop-') ? 403 : 201);
  const r = await w.push.sendTest(w.alice.id);
  assert.deepEqual([r.sent, r.failed], [1, 1]);
  assert.match(r.errors[0], /403/);
  assert.deepEqual(a.received(), [{ v: 1, type: 'test', lang: 'nl' }]);
  assert.equal(b.received().length, 0);
  assert.equal(other.received().length, 0);
  assert.deepEqual(await w.push.sendTest(addUser(w.db, 'zonder').id), { sent: 0, failed: 0, errors: [] });
  // een apparaat waarvan de sessie is ingetrokken krijgt ook geen proefmelding meer
  w.state.respond = () => 201;
  revokeSession(w.db, w.alice.id, a.session.id);
  const after = await w.push.sendTest(w.alice.id);
  assert.deepEqual([after.sent, a.received().length, b.received().length], [1, 1, 1]);
});
