// Plaatsen en herinneringen op een locatie in de client: acties, overzichten, de brug naar Android, de huidige positie en
// het gedrag bij gegevens van een nieuwere versie. Plaatsen zijn verzonnen.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { setLanguage } from './i18n.js';
import { hasReminder, placeList, remindersOf, tasksWithReminder } from './selectors.js';
import { androidBridge, reminderFingerprint } from './android.js';
import { PositionError, currentPosition, formatCoordinates, locationAdvice, placeProblem, placeRows, remindersAtPlace, roundCoordinate } from './places.js';
import { locationLine, reminderLine } from './reminderText.js';
import { compileFilter } from './filter.js';
import { isLocationActive, reminderMoment } from '../../shared/reminders.js';

afterEach(() => setLanguage('nl'));

let counter = 0;
async function client(userName = 'anna') {
  const db = freshDb();
  const user = addUser(db, userName, userName);
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
  const settle = async (fn) => {
    const result = await fn();
    assert.equal(await sync.syncNow(), true);
    assert.deepEqual(errors, [], 'de server weigerde iets');
    return result;
  };
  return { db, user, store, sync, actions, errors, inbox: store.me.inbox_project_id, settle };
}

test('een plaats toevoegen, wijzigen en verwijderen: direct zichtbaar en door de server bevestigd', async () => {
  const c = await client();
  const id = await c.settle(() => c.actions.addPlace({ name: '  Thuis ', lat: 52.0907, lon: 5.1214 }));
  assert.deepEqual([...c.store.view.places.values()].map((p) => [p.name, p.lat, p.lon, p.radius, p.owner_id === c.store.userId]), [['Thuis', 52.0907, 5.1214, 150, true]]);
  await c.settle(() => c.actions.updatePlace(id, { name: 'Ons huis', radius: 300 }));
  assert.deepEqual([c.store.view.places.get(id).name, c.store.view.places.get(id).radius], ['Ons huis', 300]);
  await c.settle(() => c.actions.deletePlace(id));
  assert.equal(c.store.view.places.size, 0);
  assert.equal(c.store.base.places.size, 0);
});

test('plaatsen staan op naam, hoofdletters tellen niet mee', async () => {
  const c = await client();
  for (const name of ['werk', 'Thuis', 'Albert Heijn', 'zwembad']) await c.actions.addPlace({ name, lat: 52, lon: 5 });
  assert.deepEqual(placeList(c.store.view, c.store.userId).map((p) => p.name), ['Albert Heijn', 'Thuis', 'werk', 'zwembad']);
  assert.deepEqual(placeList(c.store.view, 'iemand-anders').map((p) => p.name), [], 'plaatsen van een ander tonen we niet');
});

test('een herinnering op een plek: toevoegen, niet dubbel, en een andere trigger of plaats wel', async () => {
  const c = await client();
  const home = await c.settle(() => c.actions.addPlace({ name: 'Thuis', lat: 52.0907, lon: 5.1214 }));
  const work = await c.settle(() => c.actions.addPlace({ name: 'Werk', lat: 52.2, lon: 5.3 }));
  const task = await c.settle(() => c.actions.addTask({ content: 'Pakket ophalen', project_id: c.inbox }));
  const a = await c.settle(() => c.actions.addReminder(task, { type: 'location', place_id: home, trigger: 'enter' }));
  const same = await c.settle(() => c.actions.addReminder(task, { type: 'location', place_id: home, trigger: 'enter' }));
  assert.equal(same, a);
  await c.settle(() => c.actions.addReminder(task, { type: 'location', place_id: home, trigger: 'leave' }));
  await c.settle(() => c.actions.addReminder(task, { type: 'location', place_id: work, trigger: 'enter' }));
  const mine = remindersOf(c.store.view, task, c.store.userId);
  assert.equal(mine.length, 3);
  assert.ok(mine.every((x) => x.moment === null && x.reminder.type === 'location'), 'een herinnering op een plek heeft geen tijdstip');
});

test('een locatieherinnering telt niet als tijdherinnering: de automatische herinnering komt er nog bij, en verdwijnt niet bij het wissen van de tijd', async () => {
  const c = await client();
  const home = await c.settle(() => c.actions.addPlace({ name: 'Thuis', lat: 52.0907, lon: 5.1214 }));
  const task = await c.settle(() => c.actions.addTask({ content: 'Bellen', project_id: c.inbox }));
  await c.settle(() => c.actions.addReminder(task, { type: 'location', place_id: home, trigger: 'enter' }));
  await c.settle(() => c.actions.updateTask(task, { due: { date: '2026-12-01T09:00' } }));
  assert.deepEqual(remindersOf(c.store.view, task, c.store.userId).map((x) => x.reminder.type).sort(), ['location', 'relative'], 'de automatische herinnering komt er tóch bij');
  await c.settle(() => c.actions.updateTask(task, { due: null }));
  assert.deepEqual(remindersOf(c.store.view, task, c.store.userId).map((x) => x.reminder.type), ['location'], 'zonder tijd vervalt alleen de herinnering vooraf');
});

test('een plaats verwijderen haalt de herinneringen erop weg, ook bij een tweede apparaat', async () => {
  const c = await client();
  const home = await c.settle(() => c.actions.addPlace({ name: 'Thuis', lat: 52.0907, lon: 5.1214 }));
  const task = await c.settle(() => c.actions.addTask({ content: 'Planten water geven', project_id: c.inbox }));
  await c.settle(() => c.actions.addReminder(task, { type: 'location', place_id: home, trigger: 'enter' }));
  await c.settle(() => c.actions.addReminder(task, { type: 'relative', minute_offset: 5 }));
  assert.equal(remindersAtPlace(c.store.view, home, c.store.userId), 1);
  // tweede apparaat
  const second = new Store(new MemoryAdapter(), { onPersistError: () => {} });
  const user = c.user;
  const sync2 = new SyncClient({ store: second, transport: async (b) => JSON.parse(JSON.stringify(handleSync(c.db, JSON.parse(JSON.stringify(b)), user.id))) });
  await second.init();
  await sync2.syncNow();
  assert.equal(second.view.places.size, 1);
  assert.equal(second.view.reminders.size, 2);
  await c.settle(() => c.actions.deletePlace(home));
  await sync2.syncNow();
  assert.equal(second.view.places.size, 0);
  assert.deepEqual([...second.view.reminders.values()].map((r) => r.type), ['relative'], 'de herinnering op de plaats is weg');
});

test('offline een plaats verwijderen: de herinneringen verdwijnen meteen en komen niet terug na het synchroniseren', async () => {
  const c = await client();
  const home = await c.settle(() => c.actions.addPlace({ name: 'Thuis', lat: 52.0907, lon: 5.1214 }));
  const task = await c.settle(() => c.actions.addTask({ content: 'Kaart sturen', project_id: c.inbox }));
  await c.settle(() => c.actions.addReminder(task, { type: 'location', place_id: home, trigger: 'enter' }));
  await c.actions.deletePlace(home);
  assert.equal(remindersOf(c.store.view, task, c.store.userId).length, 0, 'meteen weg');
  await c.settle(async () => {});
  assert.equal(remindersOf(c.store.view, task, c.store.userId).length, 0);
});

test('het belletje en het filter "heeft herinnering" tellen een open locatieherinnering mee, een afgevinkte taak niet', async () => {
  const c = await client();
  const home = await c.settle(() => c.actions.addPlace({ name: 'Thuis', lat: 52.0907, lon: 5.1214 }));
  const task = await c.settle(() => c.actions.addTask({ content: 'Sleutel meenemen', project_id: c.inbox }));
  assert.equal(hasReminder(c.store.view, task, c.store.userId), false);
  await c.settle(() => c.actions.addReminder(task, { type: 'location', place_id: home, trigger: 'leave' }));
  assert.equal(hasReminder(c.store.view, task, c.store.userId), true);
  assert.ok(tasksWithReminder(c.store.view, c.store.userId).has(task));
  const hit = () => compileFilter('heeft herinnering', { view: c.store.view, now: new Date(2026, 10, 14), userId: c.store.userId }).match(c.store.view.tasks.get(task));
  assert.equal(hit(), true);
  await c.settle(() => c.actions.completeTask(task));
  assert.equal(hit(), false);
  assert.equal(hasReminder(c.store.view, task, c.store.userId), false);
  assert.equal(tasksWithReminder(c.store.view, c.store.userId).has(task), false);
});

test('isLocationActive en reminderMoment: een locatieherinnering heeft nooit een tijdstip', () => {
  const r = { type: 'location', place_id: 'p', trigger: 'enter' };
  assert.equal(reminderMoment(r, { due: { date: '2026-12-01T09:00' } }), null);
  assert.equal(isLocationActive(r, { checked: false }), true);
  assert.equal(isLocationActive(r, { checked: true }), false);
  assert.equal(isLocationActive(r, { is_deleted: true }), false);
  assert.equal(isLocationActive({ ...r, is_deleted: true }, { checked: false }), false);
  assert.equal(isLocationActive({ type: 'relative' }, { checked: false }), false);
  assert.equal(isLocationActive(r, undefined), false);
});

test('de tekst van een locatieherinnering, in beide talen; een onbekende soort geeft geen fout', async () => {
  const places = new Map([['p1', { id: 'p1', name: 'Thuis' }]]);
  setLanguage('nl');
  assert.equal(reminderLine({ type: 'location', place_id: 'p1', trigger: 'enter' }, null, '2026-12-01', places), 'Bij aankomst: Thuis');
  assert.equal(reminderLine({ type: 'location', place_id: 'p1', trigger: 'leave' }, null, '2026-12-01', places), 'Bij vertrek: Thuis');
  assert.equal(locationLine({ place_id: 'weg', trigger: 'enter' }, places), 'Bij aankomst: …');
  setLanguage('en');
  assert.equal(reminderLine({ type: 'location', place_id: 'p1', trigger: 'enter' }, null, '2026-12-01', places), 'On arrival: Thuis');
  assert.equal(reminderLine({ type: 'location', place_id: 'p1', trigger: 'leave' }, null, '2026-12-01', places), 'On leaving: Thuis');
  // een soort die een nieuwere versie kent
  assert.equal(reminderLine({ type: 'toekomst', minute_offset: null }, null, '2026-12-01', places), 'Reminder from a newer version');
});

test('gegevens van een nieuwere of oudere versie: onbekende soorten en onbekende velden verstoren de client niet', async () => {
  const c = await client();
  const task = await c.settle(() => c.actions.addTask({ content: 'Iets', project_id: c.inbox }));
  // een sync-antwoord met een resource en een herinneringssoort die deze client niet kent
  await c.store.applyResponse({
    sync_token: '99', full_sync: false, partial: false, sync_status: {},
    toekomst: [{ id: 'abc12345', x: 1 }],
    reminders: [{ id: 'remind-nieuw-1', task_id: task, type: 'toekomst', minute_offset: null, due: null, owner_id: c.store.userId, is_deleted: false, extra_veld: 1 }],
  });
  const items = remindersOf(c.store.view, task, c.store.userId);
  assert.equal(items.length, 1);
  assert.equal(items[0].moment, null);
  assert.ok(reminderLine(items[0].reminder, null, '2026-12-01', c.store.view.places).length > 0);
  assert.notEqual(reminderFingerprint(c.store.view, c.store.userId), '');
  assert.equal(hasReminder(c.store.view, task, c.store.userId), false, 'een onbekende soort doet niets');
});

test('een locatieherinnering zonder plaats (de plaats is al weg) wordt bij het synchroniseren opgeruimd', async () => {
  const c = await client();
  const task = await c.settle(() => c.actions.addTask({ content: 'Iets', project_id: c.inbox }));
  await c.store.applyResponse({
    sync_token: '100', full_sync: false, partial: false, sync_status: {},
    reminders: [{ id: 'remind-wees-01', task_id: task, type: 'location', place_id: 'plaats-weg-01', trigger: 'enter', owner_id: c.store.userId, is_deleted: false }],
  });
  assert.equal(c.store.view.reminders.has('remind-wees-01'), false);
});

test('de vingerafdruk voor Android verandert bij een andere plaats of straal, niet bij een andere naam van de taak zonder herinnering', async () => {
  const c = await client();
  const home = await c.settle(() => c.actions.addPlace({ name: 'Thuis', lat: 52.0907, lon: 5.1214 }));
  const task = await c.settle(() => c.actions.addTask({ content: 'Water', project_id: c.inbox }));
  await c.settle(() => c.actions.addReminder(task, { type: 'location', place_id: home, trigger: 'enter' }));
  const base = reminderFingerprint(c.store.view, c.store.userId);
  await c.settle(() => c.actions.updatePlace(home, { radius: 400 }));
  const radius = reminderFingerprint(c.store.view, c.store.userId);
  assert.notEqual(radius, base);
  await c.settle(() => c.actions.updatePlace(home, { lat: 52.1 }));
  assert.notEqual(reminderFingerprint(c.store.view, c.store.userId), radius);
  const before = reminderFingerprint(c.store.view, c.store.userId);
  await c.settle(() => c.actions.updateTask(task, { description: 'alleen een notitie' }));
  assert.equal(reminderFingerprint(c.store.view, c.store.userId), before);
});

test('de brug: de status van de locatiecontrole en de aanroepen', () => {
  const none = androidBridge(undefined);
  assert.equal(none.locationStatus(), null);
  assert.equal(none.requestLocationPermission(), undefined);
  const calls = [];
  const host = {
    locationStatus: () => '{"enabled":true,"precise":true,"background":false,"servicesOn":true,"running":false,"needed":true}',
    requestLocationPermission() { calls.push('request'); },
    setLocationEnabled(on) { calls.push(`enabled:${on}`); },
    checkLocationNow() { calls.push('check'); },
    openLocationSettings() { calls.push('settings'); },
    requestCurrentPosition() { calls.push('position'); },
  };
  const bridge = androidBridge(host);
  assert.equal(bridge.locationStatus().background, false);
  bridge.requestLocationPermission();
  bridge.setLocationEnabled(1);
  bridge.setLocationEnabled(false);
  bridge.checkLocationNow();
  bridge.openLocationSettings();
  bridge.requestCurrentPosition();
  assert.deepEqual(calls, ['request', 'enabled:true', 'enabled:false', 'check', 'settings', 'position']);
  for (const bad of ['geen json', '5', '[]', '{}', 'null']) assert.equal(androidBridge({ locationStatus: () => bad }).locationStatus(), null, bad);
  assert.equal(androidBridge({ locationStatus: () => { throw new Error('kapot'); } }).locationStatus(), null);
});

test('wat er nog nodig is voor de locatiecontrole, in volgorde van belang', () => {
  const good = { enabled: true, precise: true, approximate: false, background: true, servicesOn: true, running: true, needed: true };
  assert.equal(locationAdvice(null), 'off');
  assert.equal(locationAdvice({ ...good, enabled: false }), 'off');
  assert.equal(locationAdvice({ ...good, servicesOn: false, precise: false }), 'services');
  assert.equal(locationAdvice({ ...good, precise: false, approximate: true }), 'permission');
  assert.equal(locationAdvice({ ...good, background: false }), 'background');
  assert.equal(locationAdvice(good), 'ok');
});

test('een plaats controleren vóór het versturen', () => {
  const ok = { name: 'Thuis', lat: 52, lon: 5, radius: 150 };
  assert.equal(placeProblem(ok), null);
  assert.equal(placeProblem({ ...ok, name: '   ' }), 'name');
  assert.equal(placeProblem({ ...ok, lat: NaN }), 'coordinates');
  assert.equal(placeProblem({ ...ok, lat: 91 }), 'coordinates');
  assert.equal(placeProblem({ ...ok, lon: -181 }), 'coordinates');
  assert.equal(placeProblem({ ...ok, radius: 99 }), 'radius');
  assert.equal(placeProblem({ ...ok, radius: 5001 }), 'radius');
  assert.equal(placeProblem({ ...ok, radius: 150.5 }), 'radius');
  assert.equal(formatCoordinates(52.0907, 5.1214), '52.09070, 5.12140');
  assert.equal(roundCoordinate(52.123456789), 52.12346);
});

test('placeRows voegt afstand en "binnen" toe uit de status van de app', async () => {
  const c = await client();
  const home = await c.actions.addPlace({ name: 'Thuis', lat: 52, lon: 5 });
  const work = await c.actions.addPlace({ name: 'Werk', lat: 52.1, lon: 5.1 });
  const rows = placeRows(c.store.view, c.store.userId, { places: [{ id: home, name: 'Thuis', distance: 42, inside: true }] });
  assert.deepEqual(rows.map((r) => [r.place.id, r.distance, r.inside]), [[home, 42, true], [work, null, null]]);
  assert.deepEqual(placeRows(c.store.view, c.store.userId, null).map((r) => r.distance), [null, null]);
});

// ---------- de huidige positie ----------

test('positie via de browser: coördinaten en nauwkeurigheid; weigeren, geen positie en te traag worden duidelijke fouten', async () => {
  const geo = (result) => ({ getCurrentPosition: (ok, bad, options) => { geo.options = options; result.error ? bad(result.error) : ok(result); } });
  const good = geo({ coords: { latitude: 52.0907, longitude: 5.1214, accuracy: 18.5 } });
  assert.deepEqual(await currentPosition({ geolocation: good }), { lat: 52.0907, lon: 5.1214, accuracy: 18.5 });
  assert.equal(good.getCurrentPosition.length, 3);
  const codes = async (error) => { try { await currentPosition({ geolocation: geo({ error }) }); } catch (e) { return [e.name, e.code]; } return null; };
  assert.deepEqual(await codes({ code: 1 }), ['PositionError', 'denied']);
  assert.deepEqual(await codes({ code: 2 }), ['PositionError', 'unavailable']);
  assert.deepEqual(await codes({ code: 3 }), ['PositionError', 'timeout']);
  await assert.rejects(currentPosition({ geolocation: null }), (e) => e instanceof PositionError && e.code === 'unsupported');
});

test('positie via de Android-app: het antwoord komt als voorval, en een fout of stilte wordt een fout', async () => {
  const listeners = new Set();
  const win = {
    addEventListener: (name, fn) => { if (name === 'tickory-position') listeners.add(fn); },
    removeEventListener: (name, fn) => { if (name === 'tickory-position') listeners.delete(fn); },
  };
  const send = (detail) => { for (const fn of [...listeners]) fn({ detail }); };
  let asked = 0;
  const bridge = { available: true, requestCurrentPosition: () => { asked += 1; } };

  const first = currentPosition({ bridge, win, geolocation: null });
  assert.equal(asked, 1);
  send({ lat: 52.0907, lon: 5.1214, accuracy: 12 });
  assert.deepEqual(await first, { lat: 52.0907, lon: 5.1214, accuracy: 12 });
  assert.equal(listeners.size, 0, 'de luisteraar is opgeruimd');

  const denied = currentPosition({ bridge, win });
  send({ error: 'denied' });
  await assert.rejects(denied, (e) => e.code === 'denied');
  const odd = currentPosition({ bridge, win });
  send({ error: 'onzin' });
  await assert.rejects(odd, (e) => e.code === 'unavailable');
  const wrong = currentPosition({ bridge, win });
  send({ lat: 95, lon: 5 });
  await assert.rejects(wrong, (e) => e.code === 'unavailable', 'een onmogelijke positie wordt niet overgenomen');

  const silent = currentPosition({ bridge, win, timeoutMs: 20 });
  await assert.rejects(silent, (e) => e.code === 'timeout');
  assert.equal(listeners.size, 0);
});
