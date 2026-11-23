import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busy, watchAppUpdate } from './appUpdate.js';

function target() {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
    fire: (type) => (listeners.get(type) ?? []).forEach((fn) => fn()),
    count: (type) => (listeners.get(type) ?? []).length,
  };
}

function setup({ controller = {}, dialog = false, active = null } = {}) {
  let clock = 0;
  const timers = [];
  const updates = [];
  const sw = { ...target(), controller, getRegistration: async () => ({ update: () => updates.push(clock) }) };
  const body = { tagName: 'BODY' };
  const doc = { ...target(), body, visibilityState: 'visible', activeElement: active ?? body, open: dialog, querySelector: (s) => (s === 'dialog[open]' && doc.open ? {} : null) };
  const win = {
    ...target(),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
  let reloads = 0;
  const stop = watchAppUpdate({ sw, win, doc, reload: () => { reloads += 1; }, now: () => clock });
  return { sw, doc, win, timers, updates, stop, reloads: () => reloads, tick: (ms) => { clock += ms; } };
}

test('busy: een open venster of typen in een veld, niet een knop of niets', () => {
  const doc = (open, el) => ({ body: { tagName: 'BODY' }, activeElement: el, querySelector: () => (open ? {} : null) });
  assert.equal(busy(doc(true, null)), true);
  assert.equal(busy(doc(false, { tagName: 'INPUT' })), true);
  assert.equal(busy(doc(false, { tagName: 'TEXTAREA' })), true);
  assert.equal(busy(doc(false, { tagName: 'DIV', isContentEditable: true })), true);
  assert.equal(busy(doc(false, { tagName: 'BUTTON' })), false);
  assert.equal(busy(doc(false, null)), false);
});

test('een nieuwe versie neemt het over: herladen als je niets aan het doen bent', () => {
  const s = setup();
  s.sw.fire('controllerchange');
  assert.equal(s.reloads(), 1);
});

test('de eerste service worker op een nieuwe pagina is geen nieuwe versie; de volgende wel', () => {
  const s = setup({ controller: null });
  s.sw.fire('controllerchange');
  assert.equal(s.reloads(), 0);
  s.sw.fire('controllerchange');
  assert.equal(s.reloads(), 1);
});

test('met een venster open: wachten, en herladen zodra het dicht is', () => {
  const s = setup({ dialog: true });
  s.sw.fire('controllerchange');
  assert.equal(s.reloads(), 0);
  assert.equal(s.timers.at(-1).ms, 30_000);
  s.timers.at(-1).fn(); // nog open
  assert.equal(s.reloads(), 0);
  s.doc.open = false;
  s.timers.at(-1).fn();
  assert.equal(s.reloads(), 1);
  s.win.fire('focus'); // niet nog een keer
  assert.equal(s.reloads(), 1);
});

test('terug in het venster: kijken of er een nieuwe versie is, hooguit eens per vijf minuten', async () => {
  const s = setup();
  s.win.fire('focus');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.updates.length, 0, 'net gestart: al gekeken bij het laden');
  s.tick(5 * 60 * 1000);
  s.win.fire('focus');
  s.doc.fire('visibilitychange');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.updates.length, 1);
});

test('stoppen haalt alles weg; zonder service worker gebeurt er niets', () => {
  const s = setup();
  s.stop();
  assert.equal(s.sw.count('controllerchange'), 0);
  assert.equal(s.win.count('focus'), 0);
  assert.equal(typeof watchAppUpdate({ sw: undefined }), 'function');
});
