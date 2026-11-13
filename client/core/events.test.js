// Het realtime-kanaal: berichten lezen, eigen berichten negeren, en een doodgevallen verbinding herkennen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listenForChanges } from './events.js';

/** Zorgt dat een luisteraar na de test altijd stopt, ook als de test faalt; anders houdt zijn timer het proces in leven. */
function track(t, listener) {
  t.after(() => listener.stop());
  return listener;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 1500) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('voorwaarde niet bereikt');
    await sleep(5);
  }
};

/** Een nagebootste server: elke verbinding krijgt een stuurbare stroom. Breekt af als het verzoek wordt afgebroken. */
function fakeServer({ status = 200 } = {}) {
  const connections = [];
  const fetchFn = async (url, { headers, signal }) => {
    let controller;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        controller = c;
        signal.addEventListener('abort', () => c.error(new DOMException('afgebroken', 'AbortError')));
      },
    });
    const conn = { url, headers, send: (text) => controller.enqueue(encoder.encode(text)), end: () => controller.close(), aborted: () => signal.aborted };
    connections.push(conn);
    return new Response(status === 200 ? body : null, { status });
  };
  return { connections, fetchFn };
}

const options = (server, extra = {}) => ({ getToken: () => 'geheim', clientId: 'ik', fetch: server.fetchFn, stallMs: 80, retryBaseMs: 5, ...extra });

test('hello meldt verbonden; sync_needed van een ander meldt een wijziging; het eigen client_id wordt genegeerd', async (t) => {
  const server = fakeServer();
  const log = [];
  const l = track(t, listenForChanges({ ...options(server), onConnected: () => log.push('verbonden'), onSyncNeeded: () => log.push('wijziging') }));
  await until(() => server.connections.length === 1);
  assert.equal(server.connections[0].headers.Authorization, 'Bearer geheim');
  assert.ok(!server.connections[0].url.includes('geheim'), 'het token staat niet in de URL');
  server.connections[0].send('event: hello\ndata: {"rev":3}\n\n');
  server.connections[0].send('event: sync_needed\ndata: {"client_id":"ander","rev":4}\n\n');
  server.connections[0].send('event: sync_needed\ndata: {"client_id":"ik","rev":5}\n\n');
  server.connections[0].send(': ping\n\n');
  await until(() => log.length >= 2);
  await sleep(20);
  assert.deepEqual(log, ['verbonden', 'wijziging']);
  l.stop();
});

test('berichten die over meerdere stukken verdeeld aankomen worden goed samengevoegd', async (t) => {
  const server = fakeServer();
  const log = [];
  const l = track(t, listenForChanges({ ...options(server, { stallMs: 5000 }), onSyncNeeded: () => log.push('wijziging') }));
  await until(() => server.connections.length === 1);
  for (const part of ['event: sync_ne', 'eded\ndata: {"client_', 'id":"ander"}\n', '\n']) {
    server.connections[0].send(part);
    await sleep(5);
  }
  await until(() => log.length === 1);
  l.stop();
});

test('een verbinding zonder berichten (ook geen ping) wordt afgebroken en opnieuw opgezet', async (t) => {
  const server = fakeServer();
  const log = [];
  const l = track(t, listenForChanges({ ...options(server), onConnected: () => log.push('verbonden') }));
  await until(() => server.connections.length === 1);
  server.connections[0].send('event: hello\ndata: {"rev":1}\n\n');
  await until(() => log.length === 1);
  // vanaf nu blijft het stil: de watchdog moet ingrijpen
  await until(() => server.connections.length === 2, 2000);
  assert.equal(server.connections[0].aborted(), true, 'de doodgevallen verbinding is afgebroken');
  server.connections[1].send('event: hello\ndata: {"rev":1}\n\n');
  await until(() => log.length === 2);
  l.stop();
});

test('pings houden een verbinding levend', async (t) => {
  const server = fakeServer();
  const l = track(t, listenForChanges(options(server)));
  await until(() => server.connections.length === 1);
  for (let i = 0; i < 8; i++) {
    server.connections[0].send(': ping\n\n');
    await sleep(30); // samen ruim drie keer de stilteperiode
  }
  assert.equal(server.connections.length, 1);
  assert.equal(server.connections[0].aborted(), false);
  l.stop();
});

test('de server sluit de stroom: opnieuw verbinden; stoppen plant daarna niets meer in', async (t) => {
  const server = fakeServer();
  const l = track(t, listenForChanges(options(server, { stallMs: 5000 })));
  await until(() => server.connections.length === 1);
  server.connections[0].end();
  await until(() => server.connections.length === 2);
  l.stop();
  assert.equal(server.connections[1].aborted(), true, 'stop() breekt de lopende verbinding af');
  await sleep(60);
  assert.equal(server.connections.length, 2, 'na stop() komt er geen nieuwe verbinding');
});

test('401: niet blijven proberen; restart() probeert het opnieuw', async (t) => {
  const server = fakeServer({ status: 401 });
  let token = 'fout';
  const l = track(t, listenForChanges({ ...options(server, { stallMs: 5000 }), getToken: () => token }));
  await until(() => server.connections.length === 1);
  await sleep(60);
  assert.equal(server.connections.length, 1, 'geen herhaalde pogingen met een afgewezen token');
  token = 'goed';
  l.restart();
  await until(() => server.connections.length === 2);
  assert.equal(server.connections[1].headers.Authorization, 'Bearer goed');
  l.stop();
});

test('zonder token wordt er niet verbonden', async (t) => {
  const server = fakeServer();
  const l = track(t, listenForChanges({ ...options(server), getToken: () => null }));
  await sleep(40);
  assert.equal(server.connections.length, 0);
  l.stop();
});
