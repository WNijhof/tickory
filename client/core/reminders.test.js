// Herinneringen in de client: de snelle invoer met "!", de automatische herinnering, de overzichten en de brug naar Android.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { INBOX_ID, settingsId } from '../../shared/schema.js';
import { emptyState } from './reducer.js';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { parseQuickAdd } from './quickadd.js';
import { hasReminder, mySettings, remindersOf } from './selectors.js';
import { androidBridge, reminderFingerprint, taskIdFromHash, watchReminders } from './android.js';

const NU = new Date(2026, 10, 11, 9, 0, 0); // woensdag 11 november 2026, 09:00

function quick(text) {
  const v = emptyState();
  v.projects.set(INBOX_ID, { id: INBOX_ID, name: 'Inbox', order_key: 'V', is_archived: false });
  return parseQuickAdd(text, { view: v, now: NU, defaultProjectId: INBOX_ID });
}
const rel = (minute_offset) => ({ type: 'relative', minute_offset });
const abs = (date) => ({ type: 'absolute', due: { date } });

// ---------- snelle invoer ----------

test('snelle invoer: korte codes voor "zoveel vooraf"', () => {
  const cases = {
    'Tandarts morgen om 9 uur !30m': [rel(30)], 'Tandarts morgen om 9 uur !30mv': [rel(30)], 'Tandarts morgen om 9 uur !30 min': [rel(30)],
    'Tandarts morgen om 9 uur !1u': [rel(60)], 'Tandarts morgen om 9 uur !2uv': [rel(120)], 'Tandarts morgen om 9 uur !3 uur': [rel(180)],
    'Tandarts morgen om 9 uur !1d': [rel(1440)], 'Tandarts morgen om 9 uur !2dv': [rel(2880)], 'Tandarts morgen om 9 uur !1 week': [rel(10080)],
    'Tandarts morgen om 9 uur !0': [rel(0)], 'Tandarts morgen om 9 uur !0mv': [rel(0)], '!45M Tandarts morgen om 9 uur': [rel(45)],
  };
  for (const [text, reminders] of Object.entries(cases)) {
    const r = quick(text);
    assert.deepEqual(r.reminders, reminders, text);
    assert.equal(r.content, 'Tandarts', text);
    assert.equal(r.due.date, '2026-11-12T09:00', text);
  }
});

test('snelle invoer: tussen haakjes in gewone taal, relatief of op een eigen datum en tijd', () => {
  assert.deepEqual(quick('Vergadering vrijdag om 14 uur !(een kwartier ervoor)').reminders, [rel(15)]);
  assert.deepEqual(quick('Vergadering vrijdag om 14 uur !(2 uur van tevoren)').reminders, [rel(120)]);
  assert.deepEqual(quick('Vergadering vrijdag om 14 uur !(op tijd)').reminders, [rel(0)]);
  const eigen = quick('Cadeau kopen !(morgen om 8 uur)');
  assert.deepEqual(eigen.reminders, [abs('2026-11-12T08:00')]);
  assert.equal(eigen.content, 'Cadeau kopen');
  assert.equal(eigen.due, null, 'de datum tussen de haakjes is van de herinnering, niet van de taak');
  const both = quick('Verjaardag Jan 5 december om 18 uur !(4 december om 20:00) !1u');
  assert.deepEqual(both.reminders, [abs('2026-12-04T20:00'), rel(60)]);
  assert.equal(both.due.date, '2026-12-05T18:00');
  assert.equal(both.content, 'Verjaardag Jan');
});

test('snelle invoer: meerdere herinneringen mag, dubbele tellen één keer', () => {
  assert.deepEqual(quick('Trein halen om 17:30 !10m !1u !10mv').reminders, [rel(10), rel(60)]);
});

test('snelle invoer: wat geen herinnering is, blijft in de titel staan', () => {
  for (const text of ['Let op! morgen bellen', 'Hoera!', 'Bel Jan ! nu', 'Kopen: brood!30m', '!(geen datum of tijd) regelen', '!(morgen) regelen', '!(elke dag om 9 uur) iets', 'Versie !30x testen', 'Code a!b']) {
    const r = quick(text);
    assert.deepEqual(r.reminders, [], text);
    assert.ok(r.content.includes('!'), `het uitroepteken blijft staan in: ${r.content}`);
  }
  // prioriteit met !! blijft prioriteit
  const p = quick('Aangifte doen !!2 !30m morgen om 9 uur');
  assert.equal(p.priority, 2);
  assert.deepEqual(p.reminders, [rel(30)]);
  assert.equal(p.content, 'Aangifte doen');
});

test('snelle invoer: een herinnering "vooraf" bij een taak zonder tijd wordt bewaard (ze werkt zodra er een tijd is)', () => {
  const r = quick('Boek terugbrengen vrijdag !1u');
  assert.deepEqual(r.reminders, [rel(60)]);
  assert.equal(r.due.date, '2026-11-13');
});

// ---------- acties tegen de echte server ----------

let counter = 0;
async function client() {
  const db = freshDb();
  const user = addUser(db, 'anna', 'Anna');
  const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
  const errors = [];
  const transport = async (body) => JSON.parse(JSON.stringify(handleSync(db, JSON.parse(JSON.stringify(body)), user.id)));
  const sync = new SyncClient({ store, transport, onCommandErrors: (e) => errors.push(...e) });
  const actions = createActions(store, {
    makeId: () => `id${String(++counter).padStart(10, '0')}`,
    makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}`,
  });
  await store.init();
  await sync.syncNow();
  const inbox = store.me.inbox_project_id;
  const mine = (taskId) => remindersOf(store.view, taskId, store.userId).map((x) => [x.reminder.type, x.reminder.minute_offset ?? x.reminder.due.date, x.moment]);
  /** Voert iets uit en controleert dat wat direct te zien was ook is wat de server bevestigt, zonder geweigerde commando's. */
  const settle = async (fn) => {
    const result = await fn();
    const before = JSON.stringify([...store.view.reminders.values()].map(({ created_at, updated_at, ...r }) => r).sort((a, b) => (a.id < b.id ? -1 : 1)));
    assert.equal(await sync.syncNow(), true);
    assert.deepEqual(errors, [], 'de server weigerde iets');
    const after = JSON.stringify([...store.view.reminders.values()].map(({ created_at, updated_at, ...r }) => r).sort((a, b) => (a.id < b.id ? -1 : 1)));
    assert.equal(after, before, 'de server bevestigt wat direct te zien was');
    return result;
  };
  return { db, user, store, sync, actions, errors, inbox, mine, settle };
}

test('automatische herinnering: een taak met een tijd krijgt er een, 30 minuten vooraf; zonder tijd niet', async () => {
  const c = await client();
  assert.deepEqual(mySettings(c.store.view, c.store.userId).auto_reminder, 30);
  const met = await c.settle(() => c.actions.addTask({ content: 'Tandarts', project_id: c.inbox, due: { date: '2026-12-01T09:00' } }));
  const zonder = await c.settle(() => c.actions.addTask({ content: 'Ooit', project_id: c.inbox, due: { date: '2026-12-01' } }));
  const geen = await c.settle(() => c.actions.addTask({ content: 'Geen datum', project_id: c.inbox }));
  assert.deepEqual(c.mine(met), [['relative', 30, '2026-12-01T08:30']]);
  assert.deepEqual(c.mine(zonder), []);
  assert.deepEqual(c.mine(geen), []);
  assert.equal(hasReminder(c.store.view, met, c.store.userId), true);
  assert.equal(hasReminder(c.store.view, zonder, c.store.userId), false);
  assert.equal(c.store.view.reminders.get([...c.store.view.reminders.keys()][0]).owner_id, c.user.id, 'de herinnering is van jou');
});

test('automatische herinnering: je eigen keuze gaat voor, en de instelling bepaalt hoeveel vooraf (of geen)', async () => {
  const c = await client();
  const eigen = await c.settle(() => c.actions.addTask({ content: 'Eigen', project_id: c.inbox, due: { date: '2026-12-01T09:00' }, reminders: [{ type: 'relative', minute_offset: 120 }, { type: 'absolute', due: { date: '2026-11-30T20:00' } }] }));
  assert.deepEqual(c.mine(eigen), [['absolute', '2026-11-30T20:00', '2026-11-30T20:00'], ['relative', 120, '2026-12-01T07:00']]);

  await c.settle(() => c.actions.updateSettings({ auto_reminder: 10 }));
  assert.equal(c.store.view.settings.get(settingsId(c.user.id)).auto_reminder, 10);
  const tien = await c.settle(() => c.actions.addTask({ content: 'Tien', project_id: c.inbox, due: { date: '2026-12-01T09:00' } }));
  assert.deepEqual(c.mine(tien), [['relative', 10, '2026-12-01T08:50']]);

  await c.settle(() => c.actions.updateSettings({ auto_reminder: 0 }));
  const opTijd = await c.settle(() => c.actions.addTask({ content: 'Op tijd', project_id: c.inbox, due: { date: '2026-12-01T09:00' } }));
  assert.deepEqual(c.mine(opTijd), [['relative', 0, '2026-12-01T09:00']]);

  await c.settle(() => c.actions.updateSettings({ auto_reminder: -1 }));
  const geen = await c.settle(() => c.actions.addTask({ content: 'Geen', project_id: c.inbox, due: { date: '2026-12-01T09:00' } }));
  assert.deepEqual(c.mine(geen), []);
});

test('datum wijzigen: krijgt de taak een tijd, dan komt de herinnering erbij; verdwijnt de tijd, dan vervalt ze', async () => {
  const c = await client();
  const id = await c.settle(() => c.actions.addTask({ content: 'Bellen', project_id: c.inbox, due: { date: '2026-12-01' } }));
  assert.deepEqual(c.mine(id), []);
  await c.settle(() => c.actions.updateTask(id, { due: { date: '2026-12-01T14:00' } }));
  assert.deepEqual(c.mine(id), [['relative', 30, '2026-12-01T13:30']]);
  // een andere tijd: dezelfde herinnering schuift mee, er komt er geen bij
  await c.settle(() => c.actions.updateTask(id, { due: { date: '2026-12-02T10:00' } }));
  assert.deepEqual(c.mine(id), [['relative', 30, '2026-12-02T09:30']]);
  // een eigen datum en tijd blijft staan als de tijd van de taak verdwijnt; "vooraf" vervalt
  await c.settle(() => c.actions.addReminder(id, { type: 'absolute', due: { date: '2026-12-01T08:00' } }));
  await c.settle(() => c.actions.updateTask(id, { due: { date: '2026-12-02' } }));
  assert.deepEqual(c.mine(id), [['absolute', '2026-12-01T08:00', '2026-12-01T08:00']]);
  // de datum helemaal weg, en weer een tijd erbij: je hebt al een herinnering, dus geen automatische
  await c.settle(() => c.actions.updateTask(id, { due: null }));
  await c.settle(() => c.actions.updateTask(id, { due: { date: '2026-12-05T09:00' } }));
  assert.deepEqual(c.mine(id), [['absolute', '2026-12-01T08:00', '2026-12-01T08:00']]);
  // een andere wijziging dan de datum raakt de herinneringen niet
  await c.settle(() => c.actions.updateTask(id, { content: 'Bellen met Jan', priority: 1 }));
  assert.equal(c.mine(id).length, 1);
});

test('herinneringen toevoegen en verwijderen; dezelfde twee keer telt één keer', async () => {
  const c = await client();
  await c.settle(() => c.actions.updateSettings({ auto_reminder: -1 }));
  const id = await c.settle(() => c.actions.addTask({ content: 'Afspraak', project_id: c.inbox, due: { date: '2026-12-01T09:00' } }));
  const a = await c.settle(() => c.actions.addReminder(id, { type: 'relative', minute_offset: 60 }));
  const again = await c.settle(() => c.actions.addReminder(id, { type: 'relative', minute_offset: 60 }));
  assert.equal(again, a, 'dezelfde herinnering wordt niet dubbel aangemaakt');
  const b = await c.settle(() => c.actions.addReminder(id, { type: 'relative', minute_offset: 0 }));
  assert.deepEqual(c.mine(id), [['relative', 60, '2026-12-01T08:00'], ['relative', 0, '2026-12-01T09:00']]);
  await c.settle(() => c.actions.deleteReminder(a));
  assert.deepEqual(c.mine(id), [['relative', 0, '2026-12-01T09:00']]);
  // afgevinkt: de herinnering blijft bestaan maar doet niets meer; heropenen maakt haar weer actief
  await c.settle(() => c.actions.completeTask(id));
  assert.deepEqual(c.mine(id), [['relative', 0, null]]);
  assert.equal(hasReminder(c.store.view, id, c.store.userId), false);
  await c.settle(() => c.actions.uncompleteTask(id));
  assert.deepEqual(c.mine(id), [['relative', 0, '2026-12-01T09:00']]);
  // de taak verwijderen neemt de herinnering mee
  await c.settle(() => c.actions.deleteTask(id));
  assert.equal(c.store.view.reminders.size, 0);
  assert.ok(b);
});

test('een terugkerende taak afvinken: de herinnering schuift mee naar de volgende keer', async () => {
  const c = await client();
  const id = await c.settle(() => c.actions.addTask({ content: 'Medicijnen', project_id: c.inbox, due: { date: '2026-12-01T08:00', string: 'elke dag om 8 uur', lang: 'nl', recurrence: { freq: 'daily' } } }));
  assert.deepEqual(c.mine(id), [['relative', 30, '2026-12-01T07:30']]);
  await c.settle(() => c.actions.completeTask(id));
  assert.deepEqual(c.mine(id), [['relative', 30, '2026-12-02T07:30']]);
});

test('snelle invoer en acties samen: wat je typt komt als taak met herinneringen op de server', async () => {
  const c = await client();
  const v = c.store.view;
  const p = parseQuickAdd('Trein halen morgen om 17:30 !10m !(morgen om 12 uur)', { view: v, now: NU, defaultProjectId: c.inbox });
  const id = await c.settle(() => c.actions.addTask(p));
  assert.deepEqual(c.mine(id), [['absolute', '2026-11-12T12:00', '2026-11-12T12:00'], ['relative', 10, '2026-11-12T17:20']]);
  assert.equal(c.store.view.tasks.get(id).content, 'Trein halen');
  const server = handleSync(c.db, { sync_token: '*' }, c.user.id);
  assert.equal(server.reminders.length, 2);
  assert.ok(!Object.hasOwn(server.tasks[0], 'reminders'), 'herinneringen zijn eigen rijen, geen veld van de taak');
});

// ---------- de brug naar Android ----------

test('de brug naar Android: buiten de app gebeurt er niets, in de app komen de aanroepen aan', () => {
  const none = androidBridge(undefined);
  assert.equal(none.available, false);
  assert.equal(none.setSession('tky_x'), undefined);
  assert.equal(none.status(), null);
  none.remindersChanged();

  const calls = [];
  const host = {
    marker: 'android',
    setSession(token) { calls.push(['setSession', token, this.marker]); },
    remindersChanged() { calls.push(['remindersChanged', this.marker]); },
    notificationStatus: () => '{"notifications":true,"exactAlarms":false,"batteryOptimized":true,"appVersion":"0.3.0"}',
    requestNotificationPermission() { throw new Error('kapot'); },
  };
  const bridge = androidBridge(host);
  assert.equal(bridge.available, true);
  bridge.setSession('tky_abc');
  bridge.setSession(null);
  bridge.remindersChanged();
  assert.deepEqual(calls, [['setSession', 'tky_abc', 'android'], ['setSession', '', 'android'], ['remindersChanged', 'android']], 'aangeroepen op het object van Android zelf');
  assert.deepEqual(bridge.status(), { notifications: true, exactAlarms: false, batteryOptimized: true, appVersion: '0.3.0' });
  assert.equal(bridge.requestNotificationPermission(), undefined, 'een fout in de brug breekt de web-app niet');
  assert.equal(bridge.openBatterySettings(), undefined, 'een methode die de app (nog) niet heeft');
  assert.equal(androidBridge({ notificationStatus: () => 'geen json' }).status(), null);
  assert.equal(androidBridge({ notificationStatus: () => '5' }).status(), null);
});

test('een taak openen vanuit een melding: alleen een geldig taak-id uit de URL', () => {
  assert.equal(taskIdFromHash('#task=AbCd1234efGH5678'), 'AbCd1234efGH5678');
  assert.equal(taskIdFromHash('#task=task-aaaa11111'), 'task-aaaa11111');
  for (const no of ['', '#', '#task=', '#task=kort', '#task=<script>alert(1)</script>', '#taak=AbCd1234efGH5678', '#task=AbCd1234efGH5678&x=1', 'task=AbCd1234efGH5678', null, undefined, `#task=${'a'.repeat(41)}`]) {
    assert.equal(taskIdFromHash(no), null, String(no));
  }
});

test('Android wordt alleen gewaarschuwd als er echt iets aan de meldingen verandert, en één keer per reeks', async () => {
  const c = await client();
  await c.actions.updateSettings({ auto_reminder: -1 });
  await c.sync.syncNow();
  let now = 0;
  const pending = [];
  const timers = { setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; pending.push(t); return t; }, clearTimeout: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); } };
  const advance = (ms) => { now += ms; for (const t of [...pending]) if (t.at <= now) { pending.splice(pending.indexOf(t), 1); t.fn(); } };
  let pings = 0;
  const stop = watchReminders({ store: c.store, bridge: { available: true, remindersChanged: () => { pings += 1; } }, delayMs: 1000, timers });

  const id = await c.actions.addTask({ content: 'Zonder herinnering', project_id: c.inbox, due: { date: '2026-12-01T09:00' } });
  await c.sync.syncNow();
  advance(5000);
  assert.equal(pings, 0, 'een taak zonder herinnering verandert niets aan de meldingen');

  await c.actions.addReminder(id, { type: 'relative', minute_offset: 30 });
  await c.actions.addReminder(id, { type: 'relative', minute_offset: 60 });
  await c.sync.syncNow();
  advance(999);
  assert.equal(pings, 0, 'nog even wachten');
  advance(1);
  assert.equal(pings, 1, 'één waarschuwing voor de hele reeks');

  await c.actions.updateTask(id, { due: { date: '2026-12-02T09:00' } });
  advance(1000);
  assert.equal(pings, 2, 'een andere tijd van de taak');
  await c.actions.updateTask(id, { content: 'Andere titel' });
  advance(1000);
  assert.equal(pings, 3, 'de titel staat in de melding');
  await c.actions.updateTask(id, { description: 'alleen een notitie' });
  advance(1000);
  assert.equal(pings, 3, 'een notitie verandert niets aan de melding');
  await c.actions.completeTask(id);
  advance(1000);
  assert.equal(pings, 4, 'afgevinkt: de melding hoeft niet meer');

  stop();
  await c.actions.uncompleteTask(id);
  advance(5000);
  assert.equal(pings, 4, 'na stoppen komt er niets meer');
  // buiten de Android-app wordt er niet eens geluisterd
  const listeners = c.store.listeners.size;
  const stopNothing = watchReminders({ store: c.store, bridge: androidBridge(undefined) });
  assert.equal(c.store.listeners.size, listeners, 'geen luisteraar erbij');
  stopNothing();
  assert.notEqual(reminderFingerprint(c.store.view, c.store.userId), '');
});

test('dezelfde herinnering op een eigen datum en tijd wordt niet dubbel aangemaakt; een andere wel', async () => {
  const c = await client();
  await c.settle(() => c.actions.updateSettings({ auto_reminder: -1 }));
  const id = await c.settle(() => c.actions.addTask({ content: 'Feest', project_id: c.inbox }));
  const a = await c.settle(() => c.actions.addReminder(id, { type: 'absolute', due: { date: '2026-12-05T18:00' } }));
  const same = await c.settle(() => c.actions.addReminder(id, { type: 'absolute', due: { date: '2026-12-05T18:00' } }));
  const other = await c.settle(() => c.actions.addReminder(id, { type: 'absolute', due: { date: '2026-12-05T19:00' } }));
  assert.equal(same, a);
  assert.notEqual(other, a);
  assert.deepEqual(c.mine(id).map((x) => x[1]), ['2026-12-05T18:00', '2026-12-05T19:00']);
});

test('nog vóór de eerste sync (de instellingen zijn er nog niet): de automatische herinnering is 30 minuten', async () => {
  const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
  await store.init();
  assert.equal(store.view.settings.size, 0);
  assert.equal(mySettings(store.view, null).auto_reminder, 30);
  const actions = createActions(store, { makeId: () => `id${String(++counter).padStart(10, '0')}`, makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}` });
  await actions.addTask({ content: 'Offline bedacht', project_id: 'inbox-project', due: { date: '2026-12-01T09:00' } });
  assert.deepEqual(store.queue.map((q) => [q.cmd.type, q.cmd.args.minute_offset]), [['task_add', undefined], ['reminder_add', 30]]);
});

test('herinneringen van een ander tellen nooit mee, ook niet als ze toch in de lokale gegevens zouden staan', () => {
  const v = emptyState();
  v.tasks.set('taak-gedeeld-01', { id: 'taak-gedeeld-01', content: 'Samen', due: { date: '2026-12-01T09:00' }, checked: false });
  v.reminders.set('herinn-van-mij1', { id: 'herinn-van-mij1', task_id: 'taak-gedeeld-01', type: 'relative', minute_offset: 30, owner_id: 'ik' });
  v.reminders.set('herinn-van-jou1', { id: 'herinn-van-jou1', task_id: 'taak-gedeeld-01', type: 'relative', minute_offset: 5, owner_id: 'jij' });
  assert.deepEqual(remindersOf(v, 'taak-gedeeld-01', 'ik').map((x) => x.reminder.id), ['herinn-van-mij1']);
  assert.deepEqual(remindersOf(v, 'taak-gedeeld-01', 'jij').map((x) => x.reminder.id), ['herinn-van-jou1']);
  const mine = reminderFingerprint(v, 'ik');
  v.reminders.set('herinn-van-jou1', { ...v.reminders.get('herinn-van-jou1'), minute_offset: 99 });
  assert.equal(reminderFingerprint(v, 'ik'), mine, 'een wijziging in andermans herinnering verandert niets aan mijn meldingen');
  v.reminders.set('herinn-van-mij1', { ...v.reminders.get('herinn-van-mij1'), minute_offset: 10 });
  assert.notEqual(reminderFingerprint(v, 'ik'), mine);
});
