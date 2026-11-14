// Meldingen in de browser: het aan- en uitzetten (met een nagebootste browser) en wat de service worker met een bericht doet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { PushError, createPushClient } from './push.js';

const KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');

/** Een nagebootste browser met toestemming, service worker en pushdienst. */
function browser({ permission = 'default', answer = 'granted', subscribed = false, subscribedKey = KEY } = {}) {
  const log = [];
  const state = { permission, subscription: null };
  const makeSub = (key) => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/apparaat-1',
    options: { applicationServerKey: Uint8Array.from(Buffer.from(key, 'base64url')).buffer },
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/apparaat-1', keys: { p256dh: 'publiek', auth: 'geheim' } }),
    unsubscribe: async () => { log.push('browser:unsubscribe'); state.subscription = null; return true; },
  });
  if (subscribed) state.subscription = makeSub(subscribedKey);
  const registration = {
    pushManager: {
      getSubscription: async () => state.subscription,
      subscribe: async (options) => {
        log.push(`browser:subscribe userVisibleOnly=${options.userVisibleOnly} key=${Buffer.from(options.applicationServerKey).toString('base64url') === KEY}`);
        state.subscription = makeSub(KEY);
        return state.subscription;
      },
    },
  };
  const env = {
    navigator: { serviceWorker: { ready: Promise.resolve(registration) } },
    PushManager: function PushManager() {},
    Notification: { get permission() { return state.permission; }, requestPermission: async () => { log.push('browser:ask'); state.permission = answer; return answer; } },
  };
  const server = { status: 200, fail: false };
  const fetchFn = async (url, init) => {
    if (server.fail) throw new TypeError('Failed to fetch');
    log.push(`${init.method} ${url}${init.body ? ` ${init.body}` : ''}`);
    assert.equal(init.headers.Authorization, 'Bearer tky_token');
    const body = url.endsWith('/key') ? { public_key: KEY } : url.endsWith('/subscriptions') ? { subscriptions: [{ id: 's1', device: 'Laptop' }] } : url.endsWith('/test') ? { sent: 1, failed: 0, errors: [] } : { id: 's1' };
    return { ok: server.status < 400, status: server.status, json: async () => (server.status < 400 ? body : { error_code: 'INVALID_ARG', error: 'het adres van de pushdienst is niet toegestaan' }) };
  };
  const client = createPushClient({ getToken: () => 'tky_token', lang: () => 'en', fetch: fetchFn, env });
  return { client, log, state, server };
}

test('aanzetten: toestemming vragen, aanmelden bij de browser en doorgeven aan de server, met de taal van dit apparaat', async () => {
  const b = browser();
  assert.equal(b.client.supported, true);
  assert.equal(b.client.permission(), 'default');
  assert.equal(await b.client.enabled(), false);
  assert.equal(await b.client.enable(), true);
  assert.deepEqual(b.log, [
    'browser:ask', 'GET /api/v1/push/key', 'browser:subscribe userVisibleOnly=true key=true',
    'POST /api/v1/push/subscribe {"endpoint":"https://fcm.googleapis.com/fcm/send/apparaat-1","keys":{"p256dh":"publiek","auth":"geheim"},"lang":"en"}',
  ]);
  assert.equal(await b.client.enabled(), true);
  assert.equal(b.client.permission(), 'granted');
});

test('geweigerd of niet ondersteund: een duidelijke reden, en er wordt niets aangemeld', async () => {
  const denied = browser({ answer: 'denied' });
  await assert.rejects(denied.client.enable(), (e) => e instanceof PushError && e.code === 'denied');
  assert.deepEqual(denied.log, ['browser:ask']);
  assert.equal(await denied.client.enabled(), false);

  for (const env of [{}, { navigator: {} }, { navigator: { serviceWorker: {} }, Notification: {} }, { navigator: { serviceWorker: {} }, PushManager: {} }]) {
    const c = createPushClient({ getToken: () => 'x', env });
    assert.equal(c.supported, false);
    assert.equal(c.permission(), 'unsupported');
    assert.equal(await c.enabled(), false);
    assert.equal(await c.refresh(), false);
    await c.disable();
    await assert.rejects(c.enable(), (e) => e.code === 'unsupported');
  }
});

test('de server weigert of is onbereikbaar: de reden komt door', async () => {
  const b = browser();
  b.server.status = 400;
  await assert.rejects(b.client.enable(), (e) => e.code === 'server' && e.message === 'het adres van de pushdienst is niet toegestaan');
  b.server.fail = true;
  await assert.rejects(b.client.test(), (e) => e.code === 'offline');
});

test('bij het starten: staat het aan, dan wordt de aanmelding ververst zonder om toestemming te vragen', async () => {
  const off = browser({ permission: 'granted' });
  assert.equal(await off.client.refresh(), false, 'toestemming maar niet aangemeld: niets doen');
  const never = browser({ permission: 'default', subscribed: true });
  assert.equal(await never.client.refresh(), false, 'zonder toestemming nooit zelf vragen');
  assert.deepEqual([...off.log, ...never.log], []);

  const on = browser({ permission: 'granted', subscribed: true });
  assert.equal(await on.client.refresh(), true);
  assert.deepEqual(on.log.map((l) => l.split(' {')[0]), ['GET /api/v1/push/key', 'POST /api/v1/push/subscribe'], 'geen nieuwe aanmelding bij de browser, wel doorgeven aan de server');
});

test('de server heeft een andere sleutel gekregen: de oude aanmelding wordt vervangen', async () => {
  const other = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString('base64url');
  const b = browser({ permission: 'granted', subscribed: true, subscribedKey: other });
  assert.equal(await b.client.refresh(), true);
  assert.deepEqual(b.log.map((l) => l.split(' {')[0]), ['GET /api/v1/push/key', 'browser:unsubscribe', 'browser:subscribe userVisibleOnly=true key=true', 'POST /api/v1/push/subscribe']);
});

test('uitzetten: afmelden bij de server en bij de browser, ook als de server niet bereikbaar is', async () => {
  const b = browser({ permission: 'granted', subscribed: true });
  await b.client.disable();
  assert.deepEqual(b.log, ['POST /api/v1/push/unsubscribe {"endpoint":"https://fcm.googleapis.com/fcm/send/apparaat-1"}', 'browser:unsubscribe']);
  assert.equal(await b.client.enabled(), false);
  await b.client.disable();
  assert.equal(b.log.length, 2, 'een tweede keer doet niets');
  const offline = browser({ permission: 'granted', subscribed: true });
  offline.server.fail = true;
  await offline.client.disable();
  assert.deepEqual(offline.log, ['browser:unsubscribe'], 'de browser stopt hoe dan ook');
});

test('toestemming later ingetrokken in de browser: dan staat het uit, ook al bestaat de aanmelding nog', async () => {
  const b = browser({ permission: 'denied', subscribed: true });
  assert.equal(await b.client.enabled(), false);
  assert.equal(await b.client.refresh(), false);
  assert.deepEqual(b.log, []);
});

test('proefmelding en het overzicht van apparaten', async () => {
  const b = browser({ permission: 'granted', subscribed: true });
  assert.deepEqual(await b.client.test(), { sent: 1, failed: 0, errors: [] });
  assert.deepEqual(await b.client.devices(), [{ id: 's1', device: 'Laptop' }]);
});

// ---------- de service worker ----------

/** Laadt client/sw.js in een nagebootste service-worker-omgeving en geeft de luisteraars en wat er gebeurde terug. */
function serviceWorker({ fetchStatus = 200, fetchFails = false, windows = [] } = {}) {
  const listeners = {};
  const shown = [];
  const calls = [];
  const self = {
    location: { origin: 'https://taken.example.nl' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => {},
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url) => { calls.push(`open ${url}`); },
    },
  };
  const context = {
    self, URL, JSON, Promise, Error, console,
    caches: { open: async () => ({ addAll: async () => {}, keys: async () => [], match: async () => undefined, put: async () => {} }), keys: async () => [], delete: async () => true },
    fetch: async (url, init) => {
      calls.push(`fetch ${url} ${init?.body ?? ''}`);
      if (fetchFails) throw new TypeError('geen verbinding');
      return { ok: fetchStatus < 400, status: fetchStatus };
    },
  };
  vm.runInNewContext(readFileSync(fileURLToPath(new URL('../sw.js', import.meta.url)), 'utf8'), context, { filename: 'sw.js' });
  /** Stuurt een gebeurtenis en wacht tot alles wat de worker wilde afmaken klaar is. */
  const dispatch = async (type, event) => {
    const waits = [];
    listeners[type]({ ...event, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { shown, calls, dispatch };
}
const REMINDER = { v: 1, type: 'reminder', id: 'remind-1', task_id: 'task-aaaa11111', title: 'Tandarts bellen', time: '2026-12-01T09:00', moment: '2026-12-01T08:30', lang: 'nl', complete: 'tok-c', snooze: 'tok-s' };
const pushEvent = (data) => ({ data: data === undefined ? null : { json: () => { if (data === 'kapot') throw new Error('geen json'); return data; } } });

test('service worker: een herinnering wordt een melding met de taak als titel, de tijd en twee knoppen', async () => {
  const sw = serviceWorker();
  await sw.dispatch('push', pushEvent(REMINDER));
  assert.equal(sw.shown.length, 1);
  const { title, options } = sw.shown[0];
  assert.equal(title, 'Tandarts bellen');
  assert.equal(options.body, 'Herinnering · 09:00');
  assert.deepEqual(JSON.parse(JSON.stringify(options.actions)), [{ action: 'complete', title: 'Voltooien' }, { action: 'snooze', title: 'Over 10 minuten' }]);
  assert.equal(options.tag, 'tickory-remind-1-2026-12-01T08:30');
  assert.equal(options.icon, '/icon-192.png');
  assert.equal(options.data.taskId, 'task-aaaa11111');

  await sw.dispatch('push', pushEvent({ ...REMINDER, lang: 'en', time: null }));
  assert.equal(sw.shown[1].options.body, 'Reminder');
  assert.deepEqual(JSON.parse(JSON.stringify(sw.shown[1].options.actions)).map((a) => a.title), ['Complete', 'In 10 minutes']);
});

test('service worker: een proefmelding, en bij een onleesbaar of onbekend bericht toch een nette melding', async () => {
  const sw = serviceWorker();
  await sw.dispatch('push', pushEvent({ v: 1, type: 'test', lang: 'nl' }));
  await sw.dispatch('push', pushEvent({ v: 1, type: 'test', lang: 'en' }));
  await sw.dispatch('push', pushEvent('kapot'));
  await sw.dispatch('push', pushEvent(undefined));
  await sw.dispatch('push', pushEvent({ type: 'reminder' }));
  await sw.dispatch('push', pushEvent({ type: 'iets-nieuws', lang: 'fr' }));
  assert.deepEqual(sw.shown.map((n) => n.title), ['Meldingen werken', 'Notifications work', 'Meldingen werken', 'Meldingen werken', 'Meldingen werken', 'Meldingen werken']);
  assert.ok(sw.shown.every((n) => n.options.body && !n.options.actions), 'altijd een tekst, nooit knoppen zonder taak');
});

test('service worker: de knoppen sturen het bewijsje uit de melding naar de server, zonder de app te openen', async () => {
  const sw = serviceWorker();
  await sw.dispatch('push', pushEvent(REMINDER));
  const notification = { data: sw.shown[0].options.data, closed: 0, close() { this.closed += 1; } };
  await sw.dispatch('notificationclick', { action: 'complete', notification });
  await sw.dispatch('notificationclick', { action: 'snooze', notification });
  assert.deepEqual(sw.calls, ['fetch /api/v1/push/action {"token":"tok-c"}', 'fetch /api/v1/push/action {"token":"tok-s"}']);
  assert.equal(notification.closed, 2);
  assert.equal(sw.shown.length, 1, 'geen nieuwe melding als het gelukt is');
});

test('service worker: lukt de knop niet (geen verbinding of een storing), dan komt de melding terug; een geweigerde knop niet', async () => {
  for (const [options, back] of [[{ fetchFails: true }, 1], [{ fetchStatus: 503 }, 1], [{ fetchStatus: 400 }, 0]]) {
    const sw = serviceWorker(options);
    await sw.dispatch('push', pushEvent(REMINDER));
    await sw.dispatch('notificationclick', { action: 'complete', notification: { data: sw.shown[0].options.data, close() {} } });
    assert.equal(sw.shown.length, 1 + back, JSON.stringify(options));
    if (back) assert.equal(sw.shown[1].title, 'Tandarts bellen');
  }
});

test('service worker: tikken op de melding haalt de app naar voren bij de taak, of opent hem', async () => {
  const messages = [];
  const win = { url: 'https://taken.example.nl/', focused: 0, focus: async () => { win.focused += 1; }, postMessage: (m) => messages.push(m) };
  const elsewhere = { url: 'https://andere-site.example/', focus: async () => { throw new Error('verkeerd venster'); }, postMessage: () => {} };
  const open = serviceWorker({ windows: [elsewhere, win] });
  const data = { taskId: 'task-aaaa11111' };
  await open.dispatch('notificationclick', { action: '', notification: { data, close() {} } });
  assert.equal(win.focused, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'open-task', id: 'task-aaaa11111' }]);
  assert.deepEqual(open.calls, []);

  const closed = serviceWorker({ windows: [] });
  await closed.dispatch('notificationclick', { action: '', notification: { data, close() {} } });
  await closed.dispatch('notificationclick', { action: '', notification: { data: null, close() {} } });
  assert.deepEqual(closed.calls, ['open /#task=task-aaaa11111', 'open /']);
});

// ---------- meldingen bij samenwerken ----------

const ACTIVITY = { v: 1, type: 'activity', id: 'notif-aaaa11111', kind: 'assigned', actor: 'Bram', title: 'Tegels kiezen', project: 'Verbouwing', text: null, task_id: 'task-aaaa11111', project_id: null, lang: 'nl' };

test('service worker: een melding bij samenwerken in de taal van het apparaat, met de taak, het project en de knop Openen', async () => {
  const sw = serviceWorker();
  await sw.dispatch('push', pushEvent(ACTIVITY));
  await sw.dispatch('push', pushEvent({ ...ACTIVITY, id: 'notif-bbbb22222', kind: 'mention', text: '@Anna kun jij dit doen?', lang: 'en' }));
  await sw.dispatch('push', pushEvent({ ...ACTIVITY, id: 'notif-cccc33333', kind: 'comment', task_id: null, project_id: 'proj-aaaa11111', title: 'Verbouwing', project: null, text: 'Wie heeft de sleutel?' }));
  await sw.dispatch('push', pushEvent({ ...ACTIVITY, id: 'notif-dddd44444', kind: 'iets-nieuws', actor: '' }));
  await sw.dispatch('push', pushEvent({ ...ACTIVITY, id: '<img src=x>', kind: 'shared', task_id: '../x' }));
  assert.deepEqual(sw.shown.map((n) => n.title), [
    'Bram heeft je een taak toegewezen', 'Bram mentioned you in a comment', 'Bram schreef een opmerking bij het project', 'Iemand deed iets in een gedeeld project', 'Bram heeft je toegevoegd aan een project',
  ]);
  assert.deepEqual(sw.shown.map((n) => n.options.body), ['Tegels kiezen · Verbouwing', 'Tegels kiezen · Verbouwing\n@Anna kun jij dit doen?', 'Verbouwing\nWie heeft de sleutel?', 'Tegels kiezen · Verbouwing', 'Tegels kiezen · Verbouwing']);
  assert.deepEqual(JSON.parse(JSON.stringify(sw.shown[0].options.actions)), [{ action: 'open', title: 'Openen' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(sw.shown[1].options.actions)), [{ action: 'open', title: 'Open' }]);
  assert.equal(sw.shown[0].options.tag, 'tickory-n-notif-aaaa11111', 'dezelfde melding twee keer is één melding');
  assert.deepEqual(JSON.parse(JSON.stringify(sw.shown[4].options.data)), { notificationId: null, taskId: null }, 'een vreemd id gaat nergens heen');
});

test('service worker: tikken op een melding bij samenwerken (of op Openen) opent hem in de app, die hem dan op gelezen zet', async () => {
  const messages = [];
  const win = { url: 'https://taken.example.nl/', focus: async () => {}, postMessage: (m) => messages.push(m) };
  const sw = serviceWorker({ windows: [win] });
  await sw.dispatch('push', pushEvent(ACTIVITY));
  for (const action of ['', 'open']) await sw.dispatch('notificationclick', { action, notification: { data: sw.shown[0].options.data, close() {} } });
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'open-notification', id: 'notif-aaaa11111' }, { type: 'open-notification', id: 'notif-aaaa11111' }]);
  assert.deepEqual(sw.calls, [], 'geen verzoek naar de server: de app doet het zelf');
  const closed = serviceWorker({ windows: [] });
  await closed.dispatch('notificationclick', { action: 'open', notification: { data: sw.shown[0].options.data, close() {} } });
  assert.deepEqual(closed.calls, ['open /#notification=notif-aaaa11111']);
});
