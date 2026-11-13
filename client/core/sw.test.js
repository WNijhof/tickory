// Gedrag van de service worker (client/sw.js), nagebootst met een nep-omgeving: caches, fetch en gebeurtenissen.
// Er draait hier geen browser; wat getest wordt is de logica van sw.js zelf: wat wordt bewaard, waarvoor, onder welke sleutel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://tickory.example';

/** Een nep-server: pad -> { body, type, status }. Elk antwoord is "basic", zoals een antwoord van de eigen oorsprong. */
function makeSw(server) {
  const stores = new Map();
  const handlers = {};
  const fetched = [];
  const cachesImpl = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      const keyOf = (k) => (typeof k === 'string' ? k : new URL(k.url).pathname);
      return {
        match: async (k) => m.get(keyOf(k))?.clone(),
        put: async (k, r) => { m.set(keyOf(k), r); },
        keys: async () => [...m.keys()].map((p) => ({ url: `${ORIGIN}${p}` })),
        addAll: async () => {},
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete() { return true; },
  };
  const fetchImpl = async (input) => {
    const path = typeof input === 'string' ? input : new URL(input.url).pathname;
    fetched.push(path);
    const f = server[path];
    if (!f) return new Response('niet gevonden', { status: 404 });
    const res = new Response(f.body, { status: f.status ?? 200, headers: { 'Content-Type': f.type } });
    Object.defineProperty(res, 'type', { value: 'basic' });
    return res;
  };
  const self = { location: { origin: ORIGIN }, addEventListener: (t, h) => { (handlers[t] ??= []).push(h); }, clients: { claim: async () => {} }, registration: {}, skipWaiting: async () => {} };
  vm.runInContext(SOURCE, vm.createContext({ self, caches: cachesImpl, fetch: fetchImpl, URL, Response, Promise, console, setTimeout }));
  return { stores, handlers, fetched };
}

/** Laat de service worker een verzoek afhandelen. `handled` is false als hij het aan het netwerk liet. */
async function request(sw, path, mode = 'cors') {
  const waits = [];
  let responded = null;
  const event = {
    request: { method: 'GET', url: `${ORIGIN}${path}`, mode },
    respondWith: (p) => { responded = p; },
    waitUntil: (p) => { waits.push(p); },
  };
  for (const h of sw.handlers.fetch) h(event);
  if (responded === null) return { handled: false };
  const res = await responded;
  const text = await res.clone().text();
  await Promise.allSettled(waits);
  return { handled: true, text, type: res.headers.get('content-type') };
}
const CACHE_NAME = /const CACHE = '([^']+)'/.exec(SOURCE)[1];
const cached = async (sw, path) => sw.stores.get(CACHE_NAME)?.get(path)?.clone().text();

const APP = { '/': { body: '<!doctype html><title>Tickory</title>APP', type: 'text/html; charset=utf-8' }, '/app.css': { body: 'body{color:red}', type: 'text/css' }, '/ui/app.js': { body: 'export {}', type: 'text/javascript' } };

test('de app-pagina "/" wordt bewaard en bij elke navigatie op de achtergrond ververst', async () => {
  const sw = makeSw({ ...APP });
  const first = await request(sw, '/', 'navigate');
  assert.equal(first.text.includes('APP'), true);
  assert.equal((await cached(sw, '/')).includes('APP'), true);
  APP['/'].body = '<!doctype html><title>Tickory</title>NIEUW';
  const second = await request(sw, '/', 'navigate');
  assert.equal(second.text.includes('APP') && !second.text.includes('NIEUW'), true, 'meteen de bewaarde kopie');
  assert.equal((await cached(sw, '/')).includes('NIEUW'), true, 'en de nieuwe versie voor de volgende keer');
  APP['/'].body = '<!doctype html><title>Tickory</title>APP';
});

test('een navigatie naar een ander bestand van de eigen server laat de bewaarde app-pagina met rust', async () => {
  const sw = makeSw({ ...APP });
  await request(sw, '/', 'navigate');
  for (const path of ['/app.css', '/ui/app.js', '/shared/schema.js', '/index.html', '/nergens', '/health']) {
    const r = await request(sw, path, 'navigate');
    assert.equal(r.handled, false, `${path}: gaat naar het netwerk`);
    assert.equal((await cached(sw, '/')).includes('APP'), true, `${path}: de bewaarde app-pagina is ongewijzigd`);
  }
});

test('de zoekopdracht achter "/" komt niet in de bewaarde kopie', async () => {
  const sw = makeSw({ ...APP });
  const r = await request(sw, '/?doorsturen=https://evil.example', 'navigate');
  assert.equal(r.handled, true);
  assert.ok(sw.fetched.includes('/'), 'de app-pagina is opgehaald');
  assert.ok(sw.fetched.every((p) => !p.includes('evil') && !p.includes('?')), 'er wordt alleen "/" opgehaald, nooit met het zoekdeel');
});

test('alleen bestanden uit de lijst worden bewaard; andere paden, de API en andere herkomsten niet', async () => {
  const sw = makeSw({ ...APP, '/geheim.js': { body: 'x', type: 'text/javascript' } });
  assert.equal((await request(sw, '/ui/app.js')).handled, true);
  assert.equal(await cached(sw, '/ui/app.js'), 'export {}');
  for (const path of ['/geheim.js', '/api/v1/sync', '/health', '/sw.js', '/ui/onbekend.js']) {
    assert.equal((await request(sw, path)).handled, false, path);
    assert.equal(await cached(sw, path), undefined, `${path} is niet bewaard`);
  }
  const foreign = { request: { method: 'GET', url: 'https://ander.example/ui/app.js', mode: 'cors' }, respondWith: () => assert.fail('mag niet'), waitUntil: () => {} };
  for (const h of sw.handlers.fetch) h(foreign);
  const post = { request: { method: 'POST', url: `${ORIGIN}/ui/app.js`, mode: 'cors' }, respondWith: () => assert.fail('mag niet'), waitUntil: () => {} };
  for (const h of sw.handlers.fetch) h(post);
});

test('een antwoord dat geen HTML is, komt niet als app-pagina in de bewaarde kopie', async () => {
  const sw = makeSw({ '/': { body: '{"fout":"proxy"}', type: 'application/json' } });
  await request(sw, '/', 'navigate');
  assert.equal(await cached(sw, '/'), undefined, 'JSON van een tussenliggende dienst wordt niet bewaard');
  const down = makeSw({ '/': { body: 'oeps', type: 'text/html', status: 502 } });
  await request(down, '/', 'navigate');
  assert.equal(await cached(down, '/'), undefined, 'een foutpagina evenmin');
});
