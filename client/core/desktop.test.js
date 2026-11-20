// De brug naar de desktop-app (core/desktop.js): veilig zonder app, het aantal voor de badge, en het losse venster Taak toevoegen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopBridge, isDesktopQuickAdd, todayCount, watchBadge } from './desktop.js';
import { voiceSupport } from './voice.js';

test('de brug: zonder desktop-app doet hij niets, en een fout in de app breekt de web-app niet', () => {
  assert.equal(desktopBridge(undefined).available, false);
  assert.equal(desktopBridge(undefined).setSession('x'), undefined);
  assert.equal(desktopBridge({ setBadge() { throw new Error('stuk'); } }).setBadge(3), undefined);
  const calls = [];
  const host = { setSession(t) { calls.push(['setSession', t, this === host]); }, takeQuickAddRequest: () => true };
  const b = desktopBridge(host);
  b.setSession(null);
  assert.deepEqual(calls, [['setSession', '', true]], 'aangeroepen op het object van de app zelf, null wordt leeg');
  assert.equal(b.takeQuickAddRequest(), true);
  assert.equal(desktopBridge({ takeQuickAddRequest: () => 'ja' }).takeQuickAddRequest(), false, 'alleen echt true');
});

test('het losse venster Taak toevoegen herkent zichzelf aan ?desktop=quickadd', () => {
  assert.equal(isDesktopQuickAdd('?desktop=quickadd'), true);
  assert.equal(isDesktopQuickAdd('?desktop=iets'), false);
  assert.equal(isDesktopQuickAdd(''), false);
});

test('de badge: open taken van vandaag en te laat, alleen opnieuw als het aantal verandert', () => {
  const tasks = new Map([
    ['a', { due: { date: '2026-11-20T14:00' } }], ['b', { due: { date: '2026-11-19' } }],
    ['c', { due: { date: '2026-11-20' }, checked: true }], ['d', { due: { date: '2026-11-21' } }], ['e', {}],
  ]);
  assert.equal(todayCount({ tasks }, '2026-11-20'), 2);
  const listeners = [];
  const store = { ready: true, me: { id: 'u' }, view: { tasks }, subscribe: (fn) => { listeners.push(fn); return () => {}; } };
  const sent = [];
  watchBadge({ store, bridge: { available: true, setBadge: (n) => sent.push(n) }, today: () => '2026-11-20' });
  listeners[0]();
  tasks.set('f', { due: { date: '2026-11-20' } });
  listeners[0]();
  assert.deepEqual(sent, [2, 3]);
  assert.equal(typeof watchBadge({ store, bridge: { available: false } }), 'function', 'zonder app: niets');
});

test('spraak: in de desktop-app geen microfoon (Electron heeft geen spraakdienst)', () => {
  assert.equal(voiceSupport({ webkitSpeechRecognition: function x() {} }), 'browser');
  assert.equal(voiceSupport({ webkitSpeechRecognition: function x() {}, TickoryDesktop: {} }), null);
});
