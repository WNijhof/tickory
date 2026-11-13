// Sneltoetsen: wanneer ze werken, de combinatie g + t/u/i, en wat vrij blijft voor zoeken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHORD_MS, SHORTCUT_KEYS, createShortcuts, isTyping } from './shortcuts.js';

function setup({ blocked = false } = {}) {
  const calls = [];
  let clock = 1_000_000;
  const state = { blocked };
  const s = createShortcuts({
    addTask: () => calls.push('add'), goToday: () => calls.push('today'), goUpcoming: () => calls.push('upcoming'),
    goInbox: () => calls.push('inbox'), showHelp: () => calls.push('help'), blocked: () => state.blocked, now: () => clock,
  });
  const press = (key, extra = {}) => s.handle({ key, target: { tagName: 'BODY' }, ...extra });
  return { calls, press, state, wait: (ms) => { clock += ms; }, s };
}

test('q opent "Taak toevoegen", ? het overzicht; hoofdletters (caps lock) tellen mee', () => {
  const { calls, press } = setup();
  assert.equal(press('q'), true);
  assert.equal(press('Q'), true);
  assert.equal(press('?'), true);
  assert.deepEqual(calls, ['add', 'add', 'help']);
});

test('g en dan t, u of i gaat naar Vandaag, Binnenkort of de Inbox', () => {
  const { calls, press } = setup();
  for (const second of ['t', 'u', 'i']) {
    assert.equal(press('g'), true);
    assert.equal(press(second), true);
  }
  assert.deepEqual(calls, ['today', 'upcoming', 'inbox']);
});

test('g wacht maar even op de tweede toets, en een andere toets maakt er niets van', () => {
  const { calls, press, wait } = setup();
  press('g');
  wait(CHORD_MS + 1);
  assert.equal(press('t'), false, 'te laat: t alleen doet niets');
  press('g');
  wait(CHORD_MS - 1);
  assert.equal(press('t'), true, 'net op tijd');
  press('g');
  assert.equal(press('x'), false, 'g x is niets');
  assert.equal(press('t'), false, 'en de g is daarna vergeten');
  press('g');
  press('g');
  assert.equal(press('u'), true, 'een tweede g begint opnieuw');
  assert.deepEqual(calls, ['today', 'upcoming']);
});

test('g en dan q: de q telt gewoon als q', () => {
  const { calls, press } = setup();
  press('g');
  press('q');
  assert.deepEqual(calls, ['add']);
});

test('in een invoerveld, tekstvak of keuzelijst doen de toetsen niets (en vergeten ze een begonnen g)', () => {
  const { calls, press } = setup();
  for (const target of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT' }, { tagName: 'INPUT', type: 'search' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(isTyping(target), true, JSON.stringify(target));
    assert.equal(press('q', { target }), false);
    assert.equal(press('?', { target }), false);
  }
  press('g');
  press('t', { target: { tagName: 'INPUT', type: 'text' } });
  assert.equal(press('t'), false, 'de g is vergeten zodra je in een veld typte');
  assert.deepEqual(calls, []);
});

test('een selectievakje, keuzerondje of knop houdt de sneltoetsen niet tegen', () => {
  const { calls, press } = setup();
  for (const target of [{ tagName: 'INPUT', type: 'checkbox' }, { tagName: 'INPUT', type: 'radio' }, { tagName: 'BUTTON' }, { tagName: 'A' }]) {
    assert.equal(isTyping(target), false, JSON.stringify(target));
    assert.equal(press('q', { target }), true);
  }
  assert.equal(calls.length, 4);
  assert.equal(isTyping(null), false);
  assert.equal(isTyping(undefined), false);
});

test('met Ctrl, Cmd of Alt ingedrukt doen de toetsen niets: die zijn van de browser', () => {
  const { calls, press } = setup();
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(press('q', extra), false);
    assert.equal(press('g', extra), false);
  }
  assert.deepEqual(calls, []);
});

test('zolang er een venster open is, doen de toetsen niets', () => {
  const { calls, press, state } = setup({ blocked: true });
  assert.equal(press('q'), false);
  assert.equal(press('?'), false);
  state.blocked = false;
  press('g');
  state.blocked = true;
  assert.equal(press('t'), false);
  state.blocked = false;
  assert.equal(press('t'), false, 'een venster tussen g en t haalt de g weg');
  assert.deepEqual(calls, []);
});

test('/ en Ctrl+K blijven vrij voor zoeken: niet afgehandeld, dus ook geen preventDefault', () => {
  const { calls, press } = setup();
  assert.equal(press('/'), false);
  assert.equal(press('k', { ctrlKey: true }), false);
  assert.equal(press('k', { metaKey: true }), false);
  assert.equal(press('k'), false);
  assert.equal(press('Escape'), false);
  assert.equal(press('Enter'), false);
  assert.deepEqual(calls, []);
});

test('het overzicht noemt de toetsen die echt werken', () => {
  const { calls, press } = setup();
  const expected = { add: 'add', today: 'today', upcoming: 'upcoming', inbox: 'inbox', help: 'help' };
  for (const [name, keys] of Object.entries(SHORTCUT_KEYS)) {
    calls.length = 0;
    for (const key of keys) press(key);
    assert.deepEqual(calls, [expected[name]], name);
  }
  assert.deepEqual(Object.keys(SHORTCUT_KEYS), Object.keys(expected));
});
