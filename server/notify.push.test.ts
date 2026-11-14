// Meldingen bij samenwerken als pushbericht in de browser (push.ts: flushNotifications). De pushdienst is nagebootst; de berichten
// worden ontsleuteld zoals een echte browser dat doet, zodat te zien is wat er (versleuteld) over de lijn gaat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPush } from './push.ts';
import { handleSync } from './sync.ts';
import type { Command } from './sync.ts';
import { addUser, freshDb, pushDevice } from './testutil.ts';
import { createSession } from './users.ts';
import type { UserRow } from './users.ts';

type Row = Record<string, any>;
let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `npush-${String(++n).padStart(8, '0')}`, args });
const P = 'project-push-0001', T = 'task-push-000001';

function world() {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  const state = { clock: Date.now(), respond: (_url: string): number | Error => 201 };
  const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    const r = state.respond(url);
    if (r instanceof Error) throw r;
    if (r >= 200 && r < 300) sent.push({ url, headers: init.headers, body: init.body });
    return new Response(null, { status: r });
  }) as unknown as typeof fetch;
  const push = createPush({ db, fetch: fetchFn, now: () => state.clock });
  const run = (as: UserRow, commands: Command[]) => {
    const res = handleSync(db, { commands }, as.id);
    for (const c of commands) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`);
    return res;
  };
  const device = (user: UserRow, name: string, lang?: string) => {
    const d = pushDevice(name);
    const session = createSession(db, user.id, name);
    push.subscribe(user.id, session.id, { ...d.subscription, ...(lang ? { lang } : {}) });
    const received = () => sent.filter((s) => s.url === d.subscription.endpoint).map((s) => ({ headers: s.headers, body: JSON.parse(d.decrypt(s.body)) as Row }));
    return { ...d, session, received };
  };
  run(anna, [cmd('project_add', { id: P, name: 'Verbouwing' }), cmd('project_share', { project_id: P, username: 'bram' }), cmd('task_add', { id: T, project_id: P, content: 'Tegels kiezen' })]);
  return { db, anna, bram, push, state, sent, run, device };
}

test('een toewijzing komt versleuteld bij de apparaten van de ontvanger, in hun taal, met alleen wat die mag zien', async () => {
  const w = world();
  const phone = w.device(w.bram, 'telefoon');
  const laptop = w.device(w.bram, 'laptop', 'en');
  const own = w.device(w.anna, 'anna-laptop');
  w.run(w.anna, [cmd('task_update', { id: T, assignee_id: w.bram.id })]);
  const r = await w.push.flushNotifications();
  assert.deepEqual(r, { sent: 2, failed: 0 });
  const [msg] = phone.received();
  assert.deepEqual(Object.keys(msg.body).sort(), ['actor', 'id', 'kind', 'lang', 'project', 'project_id', 'task_id', 'text', 'title', 'type', 'v']);
  assert.deepEqual([msg.body.type, msg.body.kind, msg.body.actor, msg.body.title, msg.body.project, msg.body.task_id, msg.body.text, msg.body.lang], ['activity', 'assigned', 'Anna', 'Tegels kiezen', 'Verbouwing', T, null, 'nl']);
  assert.equal(laptop.received()[0].body.lang, 'en');
  assert.equal(own.received().length, 0, 'wie het deed, krijgt niets');
  assert.ok(msg.headers.TTL && Number(msg.headers.TTL) >= 3600, 'een bericht mag een tijd bij de pushdienst wachten');
  assert.match(msg.headers.Topic, /^[A-Za-z0-9_-]{1,32}$/);
  assert.ok(!w.sent.some((s) => s.body.includes(Buffer.from('Tegels'))), 'de inhoud gaat alleen versleuteld over de lijn');
  assert.deepEqual(await w.push.flushNotifications(), { sent: 0, failed: 0 }, 'één keer versturen');
});

test('opmerking met vermelding: het begin van de tekst gaat mee (op één regel, ingekort); de projectopmerking noemt het project', async () => {
  const w = world();
  const phone = w.device(w.bram, 'telefoon');
  const long = `@Bram kun je\nmorgen ${'heel '.repeat(80)}vroeg komen?`;
  w.run(w.anna, [cmd('comment_add', { id: 'comment-push-001', task_id: T, content: long, mentions: [w.bram.id] }), cmd('comment_add', { id: 'comment-push-002', project_id: P, content: 'Wie heeft de sleutel?' })]);
  await w.push.flushNotifications();
  // de twee berichten gaan tegelijk de deur uit; in welke volgorde ze aankomen, ligt niet vast
  const got = phone.received().map((m) => m.body).sort((a, b) => (a.kind === 'mention' ? -1 : b.kind === 'mention' ? 1 : 0));
  assert.deepEqual(got.map((b) => b.kind), ['mention', 'comment']);
  assert.ok(got[0].text.startsWith('@Bram kun je morgen heel'));
  assert.ok([...got[0].text].length <= 200 && got[0].text.endsWith('…'));
  assert.deepEqual([got[1].title, got[1].project, got[1].project_id, got[1].task_id, got[1].text], ['Verbouwing', null, P, null, 'Wie heeft de sleutel?']);
});

test('niet als push: een soort die uit staat ("afgevinkt" standaard uit), een al gelezen melding, en wie geen lid meer is', async () => {
  const w = world();
  const phone = w.device(w.bram, 'telefoon');
  w.run(w.anna, [cmd('task_update', { id: T, assignee_id: w.bram.id }), cmd('task_complete', { id: T })]);
  await w.push.flushNotifications();
  assert.deepEqual(phone.received().map((m) => m.body.kind), ['assigned'], 'afvinken staat standaard uit');
  // aanzetten, en "opmerkingen" uitzetten
  w.run(w.bram, [cmd('settings_update', { id: `settings-${w.bram.id}`, notify_push: { completed: true, comment: false } })]);
  w.run(w.anna, [cmd('task_uncomplete', { id: T }), cmd('task_complete', { id: T }), cmd('comment_add', { id: 'comment-push-003', task_id: T, content: 'stil' })]);
  await w.push.flushNotifications();
  assert.deepEqual(phone.received().map((m) => m.body.kind), ['assigned', 'completed']);
  // gelezen voordat het bericht weg kon: niet meer sturen
  w.run(w.anna, [cmd('task_add', { id: 'task-push-000002', project_id: P, content: 'Nog een', assignee_id: w.bram.id })]);
  w.run(w.bram, [cmd('notification_read_all')]);
  await w.push.flushNotifications();
  assert.equal(phone.received().length, 2);
  // uit het project gehaald voordat het bericht weg kon: niets
  w.run(w.anna, [cmd('task_add', { id: 'task-push-000003', project_id: P, content: 'Geheim na vertrek', assignee_id: w.bram.id }), cmd('project_unshare', { project_id: P, user_id: w.bram.id })]);
  await w.push.flushNotifications();
  assert.equal(phone.received().length, 2);
  assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as Row).n, 0, 'de wachtrij is leeg');
});

test('zonder browser met meldingen komt er niets in de wachtrij; bij een tijdelijke fout volgt een nieuwe poging, tot een uur later', async () => {
  const w = world();
  w.run(w.anna, [cmd('task_update', { id: T, assignee_id: w.bram.id })]);
  assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as Row).n, 0);
  const phone = w.device(w.bram, 'telefoon');
  w.state.respond = () => 503;
  w.run(w.anna, [cmd('comment_add', { id: 'comment-push-010', task_id: T, content: 'Eerste poging mislukt' })]);
  assert.deepEqual(await w.push.flushNotifications(), { sent: 0, failed: 1 });
  w.state.respond = () => 201;
  assert.deepEqual(await w.push.flushNotifications(), { sent: 1, failed: 0 });
  assert.equal(phone.received().length, 1);
  w.state.respond = () => 503;
  w.run(w.anna, [cmd('comment_add', { id: 'comment-push-011', task_id: T, content: 'Blijft mislukken' })]);
  await w.push.flushNotifications();
  w.state.clock += 61 * 60_000;
  await w.push.flushNotifications();
  assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get() as Row).n, 0, 'na een uur opgegeven');
  // de klok verstuurt ook wat er nog wacht
  w.state.respond = () => 201;
  w.state.clock = Date.now();
  w.run(w.anna, [cmd('comment_add', { id: 'comment-push-012', task_id: T, content: 'Via de klok' })]);
  const tick = await w.push.tick();
  assert.equal(tick.sent, 1);
  assert.equal(phone.received().at(-1)!.body.text, 'Via de klok');
});

test('twee rondes tegelijk sturen een bericht niet twee keer', async () => {
  const w = world();
  const phone = w.device(w.bram, 'telefoon');
  w.run(w.anna, [cmd('task_update', { id: T, assignee_id: w.bram.id })]);
  await Promise.all([w.push.flushNotifications(), w.push.flushNotifications(), w.push.flushNotifications()]);
  assert.equal(phone.received().length, 1);
});
