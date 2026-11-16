// Suggesties in snel toevoegen (core/quickSuggest.js): welk teken je typt, wat erbij past, en het invullen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySuggestion, suggestions, tokenAt } from './quickSuggest.js';
import { setLanguage } from './i18n.js';

const projects = [{ id: 'p1', name: 'Thuis' }, { id: 'p2', name: 'Werk' }, { id: 'p3', name: 'Huis en tuin' }, { id: 'p4', name: 'Café' }];
const sections = [{ id: 's1', name: 'Keuken', project_id: 'p1' }, { id: 's2', name: 'Kelder', project_id: 'p1' }, { id: 's3', name: 'Overleg', project_id: 'p2' }];
const labels = [{ id: 'l1', name: 'bellen' }, { id: 'l2', name: 'boodschappen' }, { id: 'l3', name: 'Uit eten met Zoë' }];

test('tokenAt: het teken aan het begin of na een spatie, met wat je erna typte; niet midden in een woord', () => {
  assert.deepEqual(tokenAt('Melk #Th', 8), { trigger: '#', start: 5, query: 'Th' });
  assert.deepEqual(tokenAt('@', 1), { trigger: '@', start: 0, query: '' });
  assert.deepEqual(tokenAt('Bel @Uit eten', 13), { trigger: '@', start: 4, query: 'Uit eten' }, 'een naam met spaties');
  assert.equal(tokenAt('mail@voorbeeld', 14), null, 'een @ midden in een woord niet');
  assert.equal(tokenAt('kosten 3/4', 10), null);
  assert.deepEqual(tokenAt('Aangifte {vrij', 14), { trigger: '{', start: 9, query: 'vrij' });
  assert.equal(tokenAt('Aangifte {vrijdag} ', 19), null, 'een afgesloten deadline niet');
  assert.equal(tokenAt('#Thuis  verder', 14), null, 'na twee spaties is het gewone tekst');
});

test('suggesties: wat met de query begint eerst, zonder op hoofdletters of accenten te letten', () => {
  assert.deepEqual(suggestions({ trigger: '#', query: 'h' }, { projects }).map((s) => s.label), ['Huis en tuin', 'Thuis']);
  assert.deepEqual(suggestions({ trigger: '#', query: 'cafe' }, { projects }).map((s) => s.insert), ['#Café ']);
  assert.deepEqual(suggestions({ trigger: '@', query: 'ZOE' }, { labels }).map((s) => s.label), ['Uit eten met Zoë']);
  assert.equal(suggestions({ trigger: '@', query: '' }, { labels }).length, 3);
  assert.deepEqual(suggestions({ trigger: '#', query: 'xyz' }, { projects }), []);
});

test('secties: van het project dat al in de tekst staat, anders van het project waarin je toevoegt', () => {
  const tok = (text) => tokenAt(text, text.length);
  assert.deepEqual(suggestions(tok('Afwassen #Thuis /K'), { projects, sections, text: 'Afwassen #Thuis /K' }).map((s) => s.label), ['Kelder', 'Keuken']);
  assert.deepEqual(suggestions(tok('Agenda /'), { projects, sections, text: 'Agenda /', defaultProjectId: 'p2' }).map((s) => s.label), ['Overleg']);
  assert.deepEqual(suggestions(tok('Agenda /'), { projects, sections, text: 'Agenda /' }), []);
});

test('deadline: vandaag, morgen, vrijdag, volgende week, over een maand; wat erin komt is Nederlands', () => {
  setLanguage('en');
  const items = suggestions({ trigger: '{', query: '' }, { now: new Date(2026, 10, 16, 10, 0) }); // een maandag
  assert.deepEqual(items.map((s) => [s.label, s.insert, s.hint ?? null]), [
    ['Today', '{vandaag} ', '2026-11-16'], ['Tomorrow', '{morgen} ', '2026-11-17'], ['Friday', '{vrijdag} ', '2026-11-20'],
    ['Next week', '{volgende week} ', '2026-11-23'], ['In a month', '{over een maand} ', '2026-12-16'],
  ]);
  assert.deepEqual(suggestions({ trigger: '{', query: 'mor' }, { now: new Date(2026, 10, 16, 10, 0) }).map((s) => s.id), ['tomorrow']);
  setLanguage('nl');
  assert.equal(suggestions({ trigger: '{', query: '' }, { now: new Date(2026, 10, 20, 10, 0) })[2].hint, '2026-11-20', 'op vrijdag is "vrijdag" vandaag, zoals de datumherkenning');
});

test('invullen: het teken met de query wordt vervangen, de rest blijft, de cursor erachter', () => {
  const text = 'Melk #Th morgen';
  const token = tokenAt(text, 8);
  const r = applySuggestion(text, token, 8, { insert: '#Thuis ' });
  assert.deepEqual(r, { text: 'Melk #Thuis morgen', caret: 12 });
});
