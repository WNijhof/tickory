// Labels met spaties of leestekens in de naam ("Uitgaan met Zoë") in snel toevoegen: ze worden op naam gevonden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from './reducer.js';
import { parseQuickAdd } from './quickadd.js';

const NOW = new Date(2026, 10, 11, 9, 30);
function view() {
  const v = emptyState();
  const label = (id, name) => v.labels.set(id, { id, name, order_key: id });
  label('l-bellen', 'bellen');
  label('l-uitgaan', 'Uitgaan met Zoë');
  label('l-uitgaan-kort', 'Uitgaan');
  label('l-punt', 'a.b');
  label('l-vraag', 'Ça va?');
  v.projects.set('p-thuis', { id: 'p-thuis', name: 'Thuis', order_key: 'a' });
  return v;
}
const parse = (text) => parseQuickAdd(text, { view: view(), now: NOW, defaultProjectId: 'p-thuis' });

test('een label met spaties wordt op naam gevonden, de langste passende naam wint boven een korter label', () => {
  const r = parse('Taxi bellen @Uitgaan met Zoë vandaag');
  assert.deepEqual([r.labels, r.newLabels, r.content], [['l-uitgaan'], [], 'Taxi bellen']);
  assert.equal(r.due?.date, '2026-11-11');
  // het korte label blijft werken als de rest van de naam er niet achter staat
  const kort = parse('Taxi bellen @Uitgaan');
  assert.deepEqual([kort.labels, kort.newLabels], [['l-uitgaan-kort'], []]);
});

test('hoofdletters en een los trema maken niet uit bij een label met spaties', () => {
  assert.deepEqual(parse('Plannen @uitgaan MET zoë').labels, ['l-uitgaan']);
  assert.deepEqual(parse('Plannen @uitgaan met zoe\u0308').labels, ['l-uitgaan'], 'e met een los trema');
});

test('een label met leestekens in de naam wordt volledig gevonden, ook midden in de tekst', () => {
  const r = parse('Rekening @a.b betalen');
  assert.deepEqual([r.labels, r.newLabels, r.content], [['l-punt'], [], 'Rekening betalen']);
  assert.deepEqual(parse('Eten @Ça va?').labels, ['l-vraag']);
  assert.deepEqual(parse('Eten @Ça va? en @bellen').labels, ['l-vraag', 'l-bellen'], 'gewone labels werken er naast');
});

test('gewone labels, nieuwe labels en e-mailadressen gaan zoals voorheen', () => {
  const r = parse('Mail jan@voorbeeld.nl en @bellen @nieuw');
  assert.deepEqual([r.labels, r.newLabels, r.content], [['l-bellen'], ['nieuw'], 'Mail jan@voorbeeld.nl en']);
  // een naam met spaties zonder dat het label bestaat: het eerste woord wordt een nieuw label, zoals altijd
  const onbekend = parse('Iets @Onbekend label doen');
  assert.deepEqual([onbekend.labels, onbekend.newLabels, onbekend.content], [[], ['Onbekend'], 'Iets label doen']);
  // het label twee keer noemen geeft het één keer
  assert.deepEqual(parse('Iets @Uitgaan met Zoë en @Uitgaan met Zoë').labels, ['l-uitgaan']);
});
