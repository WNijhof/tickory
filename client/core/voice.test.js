import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserErrorCode, startVoice, voiceSupport, VOICE_EVENT } from './voice.js';

class FakeEvents {
  handlers = new Map();
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  removeEventListener(name, fn) { if (this.handlers.get(name) === fn) this.handlers.delete(name); }
  fire(name, detail) { this.handlers.get(name)?.({ detail }); }
}

function fakeBrowser(behaviour) {
  const env = new FakeEvents();
  env.instances = [];
  env.SpeechRecognition = class {
    constructor() { env.instances.push(this); }
    start() { this.started = true; behaviour?.(this); }
    stop() { this.stopped = true; this.onend?.(); }
  };
  return env;
}

function fakeAndroid({ available = true } = {}) {
  const env = new FakeEvents();
  env.calls = [];
  env.TickoryAndroid = { voiceAvailable: () => available, startVoiceInput: (lang) => env.calls.push(lang) };
  return env;
}

const collect = () => {
  const log = [];
  return { log, onResult: (t) => log.push(['result', t]), onError: (c) => log.push(['error', c]), onEnd: () => log.push(['end']) };
};

test('ondersteuning: Android-brug, browser, of niets', () => {
  assert.equal(voiceSupport(fakeAndroid()), 'android');
  assert.equal(voiceSupport(fakeAndroid({ available: false })), null, 'in de app zonder herkenner geen knop, ook al heeft de WebView de browser-API');
  assert.equal(voiceSupport({ ...fakeBrowser(), TickoryAndroid: { voiceAvailable: () => false } }), null);
  assert.equal(voiceSupport(fakeBrowser()), 'browser');
  assert.equal(voiceSupport({ webkitSpeechRecognition: class {} }), 'browser');
  assert.equal(voiceSupport({}), null);
  assert.equal(voiceSupport({ TickoryAndroid: { voiceAvailable: () => { throw new Error('x'); } } }), null);
  assert.equal(voiceSupport({ TickoryAndroid: {} }), null);
});

test('browser: de herkende tekst komt terug, in de taal van de app', () => {
  const env = fakeBrowser((r) => r.onresult({ results: [[{ transcript: '  Bel de tandarts morgen  ' }]] }));
  const c = collect();
  startVoice({ lang: 'nl', env, ...c });
  assert.deepEqual(c.log, [['result', 'Bel de tandarts morgen'], ['end']]);
  assert.equal(env.instances[0].lang, 'nl-NL');
  assert.equal(env.instances[0].continuous, false);
  assert.equal(env.instances[0].interimResults, false);
  const e = fakeBrowser();
  startVoice({ lang: 'en', env: e, ...collect() });
  assert.equal(e.instances[0].lang, 'en-US');
});

test('browser: foutmeldingen, en eindigen zonder resultaat is "niets verstaan"; maar één uitkomst', () => {
  for (const [name, code] of [['not-allowed', 'denied'], ['service-not-allowed', 'denied'], ['no-speech', 'no-speech'], ['network', 'network'], ['aborted', 'cancelled'], ['audio-capture', 'unavailable'], ['iets-anders', 'error'], [undefined, 'error']]) {
    const env = fakeBrowser((r) => { r.onerror({ error: name }); r.onend(); });
    const c = collect();
    startVoice({ lang: 'nl', env, ...c });
    assert.deepEqual(c.log, [['error', code], ['end']], String(name));
    assert.equal(browserErrorCode(name), code);
  }
  const env = fakeBrowser((r) => r.onend());
  const c = collect();
  startVoice({ lang: 'nl', env, ...c });
  assert.deepEqual(c.log, [['error', 'no-speech'], ['end']]);
  const empty = fakeBrowser((r) => { r.onresult({ results: [[{ transcript: '   ' }]] }); });
  const c2 = collect();
  startVoice({ lang: 'nl', env: empty, ...c2 });
  assert.deepEqual(c2.log, [['error', 'no-speech'], ['end']]);
});

test('browser: stoppen geeft een einde zonder tekst; starten dat misgaat is "niet beschikbaar"', () => {
  const env = fakeBrowser();
  const c = collect();
  const handle = startVoice({ lang: 'nl', env, ...c });
  handle.stop();
  assert.equal(env.instances[0].stopped, true);
  assert.deepEqual(c.log, [['error', 'no-speech'], ['end']]);
  const broken = new FakeEvents();
  broken.SpeechRecognition = class { start() { throw new Error('geen microfoon'); } };
  const c2 = collect();
  assert.equal(startVoice({ lang: 'nl', env: broken, ...c2 }), null);
  assert.deepEqual(c2.log, [['error', 'unavailable'], ['end']]);
});

test('Android: opent het spraakscherm en wacht op de gebeurtenis; daarna wordt er niet meer geluisterd', () => {
  const env = fakeAndroid();
  const c = collect();
  startVoice({ lang: 'en', env, ...c });
  assert.deepEqual(env.calls, ['en']);
  env.fire(VOICE_EVENT, { text: ' koop melk ' });
  assert.deepEqual(c.log, [['result', 'koop melk'], ['end']]);
  assert.equal(env.handlers.has(VOICE_EVENT), false, 'de luisteraar is weg');
  env.fire(VOICE_EVENT, { text: 'nog een keer' });
  assert.equal(c.log.length, 2, 'een late gebeurtenis doet niets');
  const e2 = fakeAndroid();
  startVoice({ lang: 'iets', env: e2, ...collect() });
  assert.deepEqual(e2.calls, ['nl'], 'onbekende taal valt terug op Nederlands');
});

test('Android: fouten uit de app, onbekende codes worden "error"; geannuleerd en stoppen', () => {
  for (const [detail, code] of [[{ error: 'no-speech' }, 'no-speech'], [{ error: 'unavailable' }, 'unavailable'], [{ error: 'cancelled' }, 'cancelled'], [{ error: 'alert(1)' }, 'error'], [{}, 'error'], [{ text: '   ' }, 'error'], [undefined, 'error']]) {
    const env = fakeAndroid();
    const c = collect();
    startVoice({ lang: 'nl', env, ...c });
    env.fire(VOICE_EVENT, detail);
    assert.deepEqual(c.log, [['error', code], ['end']], JSON.stringify(detail));
  }
  const env = fakeAndroid();
  const c = collect();
  const handle = startVoice({ lang: 'nl', env, ...c });
  handle.stop();
  assert.deepEqual(c.log, [['error', 'cancelled'], ['end']]);
  assert.equal(env.handlers.has(VOICE_EVENT), false);
  const throwing = fakeAndroid();
  throwing.TickoryAndroid.startVoiceInput = () => { throw new Error('x'); };
  const c2 = collect();
  startVoice({ lang: 'nl', env: throwing, ...c2 });
  assert.deepEqual(c2.log, [['error', 'unavailable'], ['end']]);
});

test('zonder ondersteuning: meteen "niet beschikbaar"', () => {
  const c = collect();
  assert.equal(startVoice({ lang: 'nl', env: {}, ...c }), null);
  assert.deepEqual(c.log, [['error', 'unavailable'], ['end']]);
});
