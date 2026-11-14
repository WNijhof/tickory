// @-vermeldingen: herkennen, kiezen (met Nederlandse namen en accenten), invoegen, terugvinden en tonen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertMention, mentionAt, mentionCandidates, mentionIds, mentionParts } from './mentions.js';

const PEOPLE = [
  { id: 'user-anna-0001', name: 'Anna de Vries', username: 'anna' },
  { id: 'user-jose-0001', name: 'José Martínez', username: 'jose' },
  { id: 'user-ijs-00001', name: 'IJsbrand Ölçer', username: 'ijsbrand' },
  { id: 'user-bram-0001', name: 'Bram', username: 'b.jansen' },
  { id: 'user-mila-0001', name: 'Mila van Dam', username: 'mila' },
];

test('mentionAt: alleen een @ aan het begin of na een spatie of haakje, tot de cursor, zonder regeleinde', () => {
  assert.deepEqual(mentionAt('@', 1), { start: 0, query: '' });
  assert.deepEqual(mentionAt('Hoi @an', 7), { start: 4, query: 'an' });
  assert.deepEqual(mentionAt('Hoi (@Jo', 8), { start: 5, query: 'Jo' });
  assert.deepEqual(mentionAt('Hoi @Anna de', 12), { start: 4, query: 'Anna de' }, 'een naam met spaties');
  assert.equal(mentionAt('mail@voorbeeld.nl', 17), null, 'geen e-mailadres');
  assert.equal(mentionAt('Hoi @an\nverder', 14), null, 'na een regeleinde niet meer');
  assert.equal(mentionAt('Hoi @ an', 8), null, 'niet direct een spatie na de @');
  assert.equal(mentionAt('Hoi @Anna  de', 13), null, 'twee spaties: klaar');
  assert.equal(mentionAt('geen apenstaart', 5), null);
  assert.equal(mentionAt(`@${'x'.repeat(41)}`, 42), null, 'te lang');
  assert.deepEqual(mentionAt('@an en meer', 3), { start: 0, query: 'an' }, 'alleen tot de cursor');
});

test('mentionCandidates: hoofdletter- en accentongevoelig, ook IJ; beste treffer eerst; jezelf niet', () => {
  const names = (q, me = null) => mentionCandidates(PEOPLE, q, { me }).map((p) => p.name);
  assert.deepEqual(names('jose'), ['José Martínez']);
  assert.deepEqual(names('JOSÉ'), ['José Martínez']);
  assert.deepEqual(names('marti'), ['José Martínez'], 'een woord verderop in de naam');
  assert.deepEqual(names('ijsb'), ['IJsbrand Ölçer']);
  assert.deepEqual(names('olc'), ['IJsbrand Ölçer']);
  assert.deepEqual(names('b.ja'), ['Bram'], 'de gebruikersnaam telt ook');
  assert.deepEqual(names('va'), ['Mila van Dam'], 'begin van een woord in de naam');
  assert.deepEqual(names('vr'), ['Anna de Vries']);
  assert.deepEqual(names('an'), ['Anna de Vries', 'Bram', 'IJsbrand Ölçer', 'Mila van Dam'], 'begin van de naam gaat voor ergens in de naam of gebruikersnaam');
  assert.deepEqual(names(''), ['Anna de Vries', 'Bram', 'IJsbrand Ölçer', 'José Martínez', 'Mila van Dam'], 'zonder tekst: iedereen op naam');
  assert.deepEqual(names('', 'user-bram-0001'), ['Anna de Vries', 'IJsbrand Ölçer', 'José Martínez', 'Mila van Dam']);
  assert.deepEqual(names('zzz'), []);
  assert.equal(mentionCandidates(PEOPLE, '', { limit: 2 }).length, 2);
});

test('mentionCandidates: het begin van de naam gaat voor het begin van een woord, en dat voor ergens in de naam', () => {
  const people = [
    { id: 'user-emil-0001', name: 'Emil', username: 'emil' },
    { id: 'user-mila-0001', name: 'Mila van Dam', username: 'mila' },
    { id: 'user-anda-0001', name: 'Andaluz', username: 'andaluz' },
    { id: 'user-dani-0001', name: 'Daniëlle', username: 'dani' },
  ];
  const names = (q) => mentionCandidates(people, q).map((p) => p.name);
  assert.deepEqual(names('mi'), ['Mila van Dam', 'Emil'], 'Mila begint ermee, Emil heeft het ergens');
  assert.deepEqual(names('da'), ['Daniëlle', 'Mila van Dam', 'Andaluz'], 'naam, dan woord, dan ergens');
});

test('insertMention: de naam komt op de plek van wat je typte, met een spatie erachter; de rest van de tekst blijft', () => {
  assert.deepEqual(insertMention('Hoi @jo', 4, 7, PEOPLE[1]), { text: 'Hoi @José Martínez ', caret: 19 });
  assert.deepEqual(insertMention('Hoi @jo kom je?', 4, 7, PEOPLE[1]), { text: 'Hoi @José Martínez kom je?', caret: 19 });
  assert.deepEqual(insertMention('@joXY verder', 0, 3, PEOPLE[1]), { text: '@José Martínez verder', caret: 15 }, 'een half woord achter de cursor valt weg');
});

test('mentionIds: alleen wie nog met @Naam in de tekst staat, zonder dubbelen, hooguit 20', () => {
  const chosen = new Map([['user-anna-0001', 'Anna de Vries'], ['user-bram-0001', 'Bram']]);
  assert.deepEqual(mentionIds('Hoi @Anna de Vries en @Bram', chosen), ['user-anna-0001', 'user-bram-0001']);
  assert.deepEqual(mentionIds('Hoi @Anna de Vries', chosen), ['user-anna-0001'], 'Bram is weer weggehaald');
  assert.deepEqual(mentionIds('Hoi @Brammetje', chosen), [], 'geen begin van een langer woord');
  assert.deepEqual(mentionIds('Hoi Bram', chosen), [], 'zonder @ geen vermelding');
  assert.deepEqual(mentionIds('(@Bram)', chosen), ['user-bram-0001'], 'leestekens eromheen mogen');
  const many = new Map(Array.from({ length: 25 }, (_, i) => [`user-${String(i).padStart(9, '0')}`, `Naam${i}`]));
  assert.equal(mentionIds([...many.values()].map((n) => `@${n}`).join(' '), many).length, 20);
});

test('mentionParts: gewone tekst en vermeldingen; de langste naam gaat voor; zonder bekende naam alleen tekst', () => {
  const names = { 'user-anna-0001': 'Anna', 'user-avri-0001': 'Anna de Vries', 'user-bram-0001': 'Bram' };
  const nameOf = (id) => names[id] ?? null;
  assert.deepEqual(mentionParts('Hoi @Anna de Vries en @Bram!', ['user-anna-0001', 'user-avri-0001', 'user-bram-0001'], nameOf), [
    { text: 'Hoi ' }, { text: '@Anna de Vries', mention: 'user-avri-0001' }, { text: ' en ' }, { text: '@Bram', mention: 'user-bram-0001' }, { text: '!' },
  ]);
  assert.deepEqual(mentionParts('@Anna', ['user-anna-0001'], nameOf), [{ text: '@Anna', mention: 'user-anna-0001' }]);
  assert.deepEqual(mentionParts('<b>@Bram</b>', ['user-bram-0001'], nameOf), [{ text: '<b>' }, { text: '@Bram', mention: 'user-bram-0001' }, { text: '</b>' }], 'HTML blijft gewone tekst');
  assert.deepEqual(mentionParts('Hoi @Bram', [], nameOf), [{ text: 'Hoi @Bram' }], 'niet in mentions: niet gemarkeerd');
  assert.deepEqual(mentionParts('Hoi @Onbekend', ['user-geen-0001'], nameOf), [{ text: 'Hoi @Onbekend' }]);
  assert.deepEqual(mentionParts('', null, nameOf), [{ text: '' }]);
});
