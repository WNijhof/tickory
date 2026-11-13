// Tests voor het controleren van labelnamen (core/labelManage.js) en de meldingen daarbij, in beide talen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from './reducer.js';
import { labelNameProblem, labelProblemText } from './labelManage.js';
import { setLanguage } from './i18n.js';

const ME = 'u-anna';
function world() {
  const v = emptyState();
  v.labels.set('l1', { id: 'l1', name: 'bellen', owner_id: ME, order_key: 'a' });
  v.labels.set('l2', { id: 'l2', name: 'Café-avond', owner_id: ME, order_key: 'b' });
  v.labels.set('l3', { id: 'l3', name: 'thuiswerk', owner_id: 'u-bob', order_key: 'c' }); // van iemand anders
  v.labels.set('l4', { id: 'l4', name: 'Zoë', order_key: 'd' }); // zonder eigenaar (offline gemaakt, nog niet gesynchroniseerd)
  return v;
}

test('labelnaam: een gewone naam kan, ook met accenten, spaties en hoofdletters', () => {
  const v = world();
  for (const name of ['uitgaan', 'Uitgaan met Zoë', 'één', 'IJs', 'a', 'x'.repeat(100), 'met-streep_en.punt', 'Ça va?', '日本語']) {
    assert.equal(labelNameProblem(v, ME, name), null, name);
  }
});

test('labelnaam: leeg, te lang, een komma of een stuurteken wordt geweigerd', () => {
  const v = world();
  assert.equal(labelNameProblem(v, ME, ''), 'empty');
  assert.equal(labelNameProblem(v, ME, '   '), 'empty');
  assert.equal(labelNameProblem(v, ME, null), 'empty');
  assert.equal(labelNameProblem(v, ME, undefined), 'empty');
  assert.equal(labelNameProblem(v, ME, 'x'.repeat(101)), 'too_long');
  assert.equal(labelNameProblem(v, ME, 'a, b'), 'invalid');
  assert.equal(labelNameProblem(v, ME, 'a\u0000b'), 'invalid');
  assert.equal(labelNameProblem(v, ME, 'a\nb'), 'invalid');
  assert.equal(labelNameProblem(v, ME, 'e\u0301'.repeat(60)), null, 'de lengte telt na normalisatie: 60 tekens, niet 120');
  assert.equal(labelNameProblem(v, ME, '  bellen  met spaties  '), null, 'omringende spaties worden weggehaald, het is dan een gewone naam');
});

test('labelnaam: een dubbele naam telt ongeacht hoofdletters, accenten-vorm en spaties, maar alleen binnen je eigen labels', () => {
  const v = world();
  assert.equal(labelNameProblem(v, ME, 'bellen'), 'duplicate');
  assert.equal(labelNameProblem(v, ME, 'BELLEN'), 'duplicate');
  assert.equal(labelNameProblem(v, ME, '  Bellen '), 'duplicate');
  assert.equal(labelNameProblem(v, ME, 'café-avond'), 'duplicate');
  assert.equal(labelNameProblem(v, ME, 'CAFÉ-AVOND'), 'duplicate');
  assert.equal(labelNameProblem(v, ME, 'Cafe\u0301-avond'), 'duplicate', 'e met een los accent is hetzelfde als é');
  assert.equal(labelNameProblem(v, ME, 'zoe'), null, 'zonder het accent is het een andere naam (accenten tellen bij namen wel mee)');
  assert.equal(labelNameProblem(v, ME, 'zoe\u0308'), 'duplicate', 'e met een los trema is hetzelfde als \u00eb');
  assert.equal(labelNameProblem(v, ME, 'ZOË'), 'duplicate', 'ook een label zonder eigenaar is van jou');
  assert.equal(labelNameProblem(v, ME, 'thuiswerk'), null, 'het label van iemand anders staat jou niet in de weg');
  // hernoemen: het label mag zijn eigen naam houden (ook in andere hoofdletters), maar niet de naam van een ander eigen label
  assert.equal(labelNameProblem(v, ME, 'bellen', 'l1'), null);
  assert.equal(labelNameProblem(v, ME, 'Bellen', 'l1'), null);
  assert.equal(labelNameProblem(v, ME, 'cafe-avond', 'l1'), null, 'zonder accent is dit een andere naam dan "Café-avond"');
  assert.equal(labelNameProblem(v, ME, 'café-avond', 'l1'), 'duplicate');
});

test('labelnaam: meldingen in het Nederlands en het Engels, voor elke reden en elke code van renameLabel', () => {
  const codes = ['empty', 'too_long', 'invalid', 'duplicate', 'READONLY', 'NOT_FOUND', 'INVALID_ARG', 'DUPLICATE'];
  const texts = new Map();
  for (const lang of ['nl', 'en']) {
    setLanguage(lang);
    for (const code of codes) {
      const text = labelProblemText(code);
      assert.ok(text.length > 10 && !/\{\w+\}/.test(text), `${lang} ${code}: "${text}"`);
      texts.set(`${lang}:${code}`, text);
    }
  }
  setLanguage('nl');
  for (const code of codes) assert.notEqual(texts.get(`nl:${code}`), texts.get(`en:${code}`), `${code}: Engels is gelijk aan Nederlands`);
  assert.equal(texts.get('nl:duplicate'), texts.get('nl:DUPLICATE'), 'dezelfde melding bij de reden en bij de code van de actie');
  assert.equal(texts.get('nl:invalid'), texts.get('nl:INVALID_ARG'));
  const different = ['empty', 'too_long', 'invalid', 'duplicate', 'READONLY', 'NOT_FOUND'].map((c) => texts.get(`nl:${c}`));
  assert.equal(new Set(different).size, different.length, 'elke reden heeft een eigen melding');
  assert.match(texts.get('nl:too_long'), /100/);
  assert.equal(labelProblemText('onbekend'), labelProblemText(undefined), 'een onbekende code geeft de algemene melding');
});
