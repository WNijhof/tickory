import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateText, parseDue } from './dateNl.js';

// Woensdag 11 november 2026, 09:00 lokale tijd
const NU = new Date(2026, 10, 11, 9, 0, 0);

// ---- eenmalige datums: de bestaande herkenner, omgezet naar "datum" of "datum met tijd" ----
const EENMALIG = [
  ['Boodschappen halen voor volgende week donderdag', 'Boodschappen halen', '2026-11-19', 'volgende week donderdag'],
  ['Boodschappen halen donderdag', 'Boodschappen halen', '2026-11-12', 'donderdag'],
  ['Tandarts bellen morgen', 'Tandarts bellen', '2026-11-12', 'morgen'],
  ['Overmorgen tandarts', 'Tandarts', '2026-11-13', 'Overmorgen'],
  ['Rapport afmaken over 3 dagen', 'Rapport afmaken', '2026-11-14', 'over 3 dagen'],
  ['Cadeau kopen voor 25 december', 'Cadeau kopen', '2026-12-25', '25 december'],
  ['Vandaag wasmachine repareren', 'Wasmachine repareren', '2026-11-11', 'Vandaag'],
  ['Huur betalen 31-12', 'Huur betalen', '2026-12-31', '31-12'],
  ['Auto APK volgende maand', 'Auto APK', '2026-12-11', 'volgende maand'],
  ['Vergadering voorbereiden vrijdag om 14:00', 'Vergadering voorbereiden', '2026-11-13T14:00', 'vrijdag om 14:00'],
  ['Afspraak maandag 9 uur', 'Afspraak', '2026-11-16T09:00', 'maandag 9 uur'],
  ['Sporten vanavond', 'Sporten', '2026-11-11T20:00', 'vanavond'],
  ['Bellen vandaag om 15:30', 'Bellen', '2026-11-11T15:30', 'vandaag om 15:30'],
  ['Overleg morgen om half 3', 'Overleg', '2026-11-12T14:30', 'morgen om half 3'],
];
for (const [invoer, titel, datum, tekst] of EENMALIG) {
  test(`eenmalig: ${invoer}`, () => {
    const r = parseDue(invoer, NU);
    assert.ok(r, 'er had een datum herkend moeten worden');
    assert.equal(r.content, titel);
    assert.deepEqual(r.due, { date: datum, string: tekst, lang: 'nl' });
    assert.equal(invoer.slice(...r.range), tekst);
  });
}

test('zonder tijd geeft alleen een datum, ook laat op de dag en vlak na middernacht', () => {
  for (const nu of [new Date(2026, 10, 11, 23, 58), new Date(2026, 10, 11, 0, 0, 20), new Date(2026, 10, 11, 12, 0)]) {
    assert.equal(parseDue('Was ophangen vandaag', nu).due.date, '2026-11-11');
    assert.equal(parseDue('Was ophangen morgen', nu).due.date, '2026-11-12');
    assert.equal(parseDue('Was ophangen morgen om 8:15', nu).due.date, '2026-11-12T08:15');
  }
});

for (const invoer of ['Zo snel mogelijk bellen', 'Ma bellen', 'Rapport schrijven', 'Hoofdstuk 2-3 lezen', '']) {
  test(`niet aanraken: "${invoer}"`, () => assert.equal(parseDue(invoer, NU), null));
}

test('~ zet de herkenning uit', () => {
  assert.deepEqual(parseDue('~Mei bellen', NU), { content: 'Mei bellen', due: null, range: null });
  assert.deepEqual(parseDue('Verhuizen ~zaterdag', NU), { content: 'Verhuizen zaterdag', due: null, range: null });
  assert.deepEqual(parseDue('Bellen ~elke maandag', NU), { content: 'Bellen elke maandag', due: null, range: null });
});

// ---- herhalingen ----
const HERHALING = [
  ['Planten water geven elke vrijdag', 'Planten water geven', '2026-11-13', { freq: 'weekly', byweekday: [5] }, 'elke vrijdag'],
  ['Elke dag vitamines', 'Vitamines', '2026-11-11', { freq: 'daily' }, 'Elke dag'],
  ['Iedere woensdag zwemmen', 'Zwemmen', '2026-11-11', { freq: 'weekly', byweekday: [3] }, 'Iedere woensdag'],
  ['Vuilnis buiten zetten elke ma en do', 'Vuilnis buiten zetten', '2026-11-12', { freq: 'weekly', byweekday: [1, 4] }, 'elke ma en do'],
  ['Sporten elke maandag, woensdag en vrijdag om 7:30', 'Sporten', '2026-11-13T07:30', { freq: 'weekly', byweekday: [1, 3, 5] }, 'elke maandag, woensdag en vrijdag om 7:30'],
  ['Stand-up elke werkdag om 9:30', 'Stand-up', '2026-11-11T09:30', { freq: 'weekly', byweekday: [1, 2, 3, 4, 5] }, 'elke werkdag om 9:30'],
  ['Elke dag om 8 uur opstaan', 'Opstaan', '2026-11-12T08:00', { freq: 'daily' }, 'Elke dag om 8 uur'],
  ['Medicijn innemen elke dag om half 10', 'Medicijn innemen', '2026-11-11T09:30', { freq: 'daily' }, 'elke dag om half 10'],
  ['Elke 2 weken ramen lappen', 'Ramen lappen', '2026-11-11', { freq: 'weekly', interval: 2 }, 'Elke 2 weken'],
  ['Backup maken om de week', 'Backup maken', '2026-11-11', { freq: 'weekly', interval: 2 }, 'om de week'],
  ['Kuur om de 3 dagen', 'Kuur', '2026-11-11', { freq: 'daily', interval: 3 }, 'om de 3 dagen'],
  ['Elke andere vrijdag oud papier', 'Oud papier', '2026-11-13', { freq: 'weekly', interval: 2, byweekday: [5] }, 'Elke andere vrijdag'],
  ['Huur betalen elke 1e', 'Huur betalen', '2026-12-01', { freq: 'monthly', bymonthday: 1 }, 'elke 1e'],
  ['Salaris controleren elke 25e van de maand', 'Salaris controleren', '2026-11-25', { freq: 'monthly', bymonthday: 25 }, 'elke 25e van de maand'],
  ['Urenstaat elke laatste dag van de maand', 'Urenstaat', '2026-11-30', { freq: 'monthly', bymonthday: 31 }, 'elke laatste dag van de maand'],
  ['Afschriften nalopen elke maand', 'Afschriften nalopen', '2026-11-11', { freq: 'monthly', bymonthday: 11 }, 'elke maand'],
  ['Btw-aangifte elk kwartaal', 'Btw-aangifte', '2026-11-11', { freq: 'monthly', interval: 3, bymonthday: 11 }, 'elk kwartaal'],
  ['Abonnement checken elk jaar', 'Abonnement checken', '2026-11-11', { freq: 'yearly', bymonthday: 11 }, 'elk jaar'],
  ['Dagelijks journaal schrijven', 'Journaal schrijven', '2026-11-11', { freq: 'daily' }, 'Dagelijks'],
  ['Team bellen wekelijks', 'Team bellen', '2026-11-11', { freq: 'weekly' }, 'wekelijks'],
  ['Jaarlijks APK', 'APK', '2026-11-11', { freq: 'yearly', bymonthday: 11 }, 'Jaarlijks'],
  ['Elk weekend boodschappen', 'Boodschappen', '2026-11-14', { freq: 'weekly', byweekday: [6] }, 'Elk weekend'],
  // dagdelen en doordeweeks
  ['Vitamines elke ochtend', 'Vitamines', '2026-11-12T09:00', { freq: 'daily' }, 'elke ochtend'], // 09:00 is vandaag al geweest
  ['Elke morgen vitamines', 'Vitamines', '2026-11-12T09:00', { freq: 'daily' }, 'Elke morgen'],
  ['Hond uitlaten elke avond', 'Hond uitlaten', '2026-11-11T20:00', { freq: 'daily' }, 'elke avond'],
  ['Kind ophalen elke middag', 'Kind ophalen', '2026-11-11T15:00', { freq: 'daily' }, 'elke middag'],
  ['Hardlopen elke ochtend om 7 uur', 'Hardlopen', '2026-11-12T07:00', { freq: 'daily' }, 'elke ochtend om 7 uur'],
  ['Sporten doordeweeks', 'Sporten', '2026-11-11', { freq: 'weekly', byweekday: [1, 2, 3, 4, 5] }, 'doordeweeks'],
  // een vaste dag van de maand of een vaste datum in het jaar: de dag hoort bij de herhaling, niet in de titel
  ['Huur betalen elke maand op de 1e', 'Huur betalen', '2026-12-01', { freq: 'monthly', bymonthday: 1 }, 'elke maand op de 1e'],
  ['Salaris controleren elke maand op de 25e', 'Salaris controleren', '2026-11-25', { freq: 'monthly', bymonthday: 25 }, 'elke maand op de 25e'],
  ['Urenstaat elke maand op de laatste dag', 'Urenstaat', '2026-11-30', { freq: 'monthly', bymonthday: 31 }, 'elke maand op de laatste dag'],
  ['Verjaardag Jan elk jaar op 5 december', 'Verjaardag Jan', '2026-12-05', { freq: 'yearly', bymonthday: 5 }, 'elk jaar op 5 december'],
  ['Verjaardag oma jaarlijks 5 december', 'Verjaardag oma', '2026-12-05', { freq: 'yearly', bymonthday: 5 }, 'jaarlijks 5 december'],
  ['Verjaardag Anna elk jaar op 3 maart', 'Verjaardag Anna', '2027-03-03', { freq: 'yearly', bymonthday: 3 }, 'elk jaar op 3 maart'],
  // de n-de weekdag van de maand: afvalkalender, overleggen
  ['Elke eerste maandag van de maand overleg', 'Overleg', '2026-12-07', { freq: 'monthly', byweekday: [1], nth: 1 }, 'Elke eerste maandag van de maand'],
  ['Oud papier elke tweede dinsdag', 'Oud papier', '2026-12-08', { freq: 'monthly', byweekday: [2], nth: 2 }, 'elke tweede dinsdag'],
  ['Elke derde donderdag teamlunch', 'Teamlunch', '2026-11-19', { freq: 'monthly', byweekday: [4], nth: 3 }, 'Elke derde donderdag'],
  ['Kasboek elke laatste vrijdag', 'Kasboek', '2026-11-27', { freq: 'monthly', byweekday: [5], nth: -1 }, 'elke laatste vrijdag'],
  ['Bijeenkomst elke 1e woensdag van de maand', 'Bijeenkomst', '2026-12-02', { freq: 'monthly', byweekday: [3], nth: 1 }, 'elke 1e woensdag van de maand'],
  // vandaag (woensdag 11 november) is zelf de tweede woensdag van de maand en telt dus mee
  ['Afval elke maand op de tweede woensdag', 'Afval', '2026-11-11', { freq: 'monthly', byweekday: [3], nth: 2 }, 'elke maand op de tweede woensdag'],
  // het dagdeel bepaalt wat "7" of "8" is
  ['Elke avond om 8 uur de hond uitlaten', 'De hond uitlaten', '2026-11-11T20:00', { freq: 'daily' }, 'Elke avond om 8 uur'],
  ['Elke avond om 9:30 de planten water geven', 'De planten water geven', '2026-11-11T21:30', { freq: 'daily' }, 'Elke avond om 9:30'],
  ['Medicijnen elke ochtend om 8:30', 'Medicijnen', '2026-11-12T08:30', { freq: 'daily' }, 'elke ochtend om 8:30'],
  ['Zwemmen elke middag om 14:00', 'Zwemmen', '2026-11-11T14:00', { freq: 'daily' }, 'elke middag om 14:00'],
  ['Elke middag om 4 uur theedrinken', 'Theedrinken', '2026-11-11T16:00', { freq: 'daily' }, 'Elke middag om 4 uur'],
];
for (const [invoer, titel, datum, regel, tekst] of HERHALING) {
  test(`herhaling: ${invoer}`, () => {
    const r = parseDue(invoer, NU);
    assert.ok(r?.due, 'er had een herhaling herkend moeten worden');
    assert.equal(r.content, titel);
    assert.deepEqual(r.due, { date: datum, string: tekst, lang: 'nl', recurrence: regel });
  });
}

for (const invoer of ['Elke keer weer', 'Elk jaargetijde iets leuks', 'Elke maart opruimen', 'elke dag', 'Elke zomer zwemmen', 'Elk kwartier pauze', 'Elke vijfde dinsdag iets']) {
  test(`geen herhaling: "${invoer}"`, () => {
    const r = parseDue(invoer, NU);
    assert.ok(r === null || !r.due?.recurrence, JSON.stringify(r));
  });
}

test('de herhaling kiest de eerstvolgende dag, vandaag inbegrepen', () => {
  const vrijdag = new Date(2026, 10, 13, 9, 0);
  assert.equal(parseDue('Papier elke vrijdag', vrijdag).due.date, '2026-11-13');
  assert.equal(parseDue('Papier elke vrijdag om 8:30', vrijdag).due.date, '2026-11-20T08:30', 'dat tijdstip is vandaag al geweest');
  assert.equal(parseDue('Papier elke 31e', new Date(2026, 1, 10)).due.date, '2026-02-28', 'februari heeft geen 31e');
});

// ---- Nederlands zonder Engelse terugval: datums die de herkenner liet liggen omdat ze ook Engels kunnen zijn ----
const AANVULLING = [
  ['Kerst 25 december diner', 'Kerst diner', '2026-12-25', '25 december'],
  ['Oud en nieuw 31 december', 'Oud en nieuw', '2026-12-31', '31 december'],
  ['Koningsdag 27 april vlag ophangen', 'Koningsdag vlag ophangen', '2027-04-27', '27 april'],
  ['Verjaardag oma 3 september', 'Verjaardag oma', '2027-09-03', '3 september'],
  ['Cadeau kopen 10 november', 'Cadeau kopen', '2027-11-10', '10 november'], // 10 november is dit jaar al voorbij
  ['Afspraak 12 november', 'Afspraak', '2026-11-12', '12 november'],
  ['Afspraak 11 november', 'Afspraak', '2026-11-11', '11 november'], // vandaag telt mee
  ['Afspraak 3 mrt', 'Afspraak', '2027-03-03', '3 mrt'],
  ['Afspraak 5 dec.', 'Afspraak', '2026-12-05', '5 dec.'],
  ['Afspraak 3 maart 2027', 'Afspraak', '2027-03-03', '3 maart 2027'],
  ['Diner 25 december om 18:30', 'Diner', '2026-12-25T18:30', '25 december om 18:30'],
  ['Begin december kerstkaarten schrijven', 'Kerstkaarten schrijven', '2026-12-01', 'Begin december'],
  ['Belasting regelen eind januari', 'Belasting regelen', '2027-01-31', 'eind januari'],
  ['Offerte versturen voor eind november', 'Offerte versturen', '2026-11-30', 'voor eind november'],
  ['Evaluatie midden mei', 'Evaluatie', '2027-05-15', 'midden mei'],
  ['Eind februari budget afronden', 'Budget afronden', '2027-02-28', 'Eind februari'],
  ['Verjaardag 29 februari', 'Verjaardag', '2028-02-29', '29 februari'], // het eerstvolgende schrikkeljaar
];
for (const [invoer, titel, datum, tekst] of AANVULLING) {
  test(`aanvulling: ${invoer}`, () => {
    const r = parseDue(invoer, NU);
    assert.ok(r?.due, 'er had een datum herkend moeten worden');
    assert.equal(r.content, titel);
    assert.deepEqual(r.due, { date: datum, string: tekst, lang: 'nl' });
    assert.equal(r.due.recurrence, undefined);
    assert.equal(invoer.slice(...r.range), tekst);
  });
}

for (const invoer of ['Afspraak 31 april', 'Afspraak 3 maart 2020', 'Van 5 december tot 10 december vakantie', 'Kamer 3 november schoonmaken', 'Pagina 12 april bekijken', 'Kerst inkopen doen', 'Pasen vieren met familie', 'Sinterklaas surprises maken', 'Mei bellen over de factuur', 'Maart was een drukke maand']) {
  test(`aanvulling raakt dit niet aan: "${invoer}"`, () => assert.equal(parseDue(invoer, NU), null));
}

test('een feestdag met een weekdag in de naam ("Goede Vrijdag") is geen gewone vrijdag, en twee datums raken we niet aan', () => {
  const jan2026 = new Date(2026, 0, 2, 9, 0); // een vrijdag
  const r = parseDue('Dienst bijwonen op Goede Vrijdag', jan2026);
  assert.equal(r.due.date, '2026-04-03');
  assert.equal(r.content, 'Dienst bijwonen');
  assert.equal(parseDue('Morgen vrij voor Pasen', NU), null, 'twee datums: te onduidelijk');
  assert.equal(parseDue('Vrijdag eieren verven voor Pasen', NU), null, 'idem');
  assert.equal(parseDue('Eieren verven voor Pasen', NU).due.date, '2027-03-28');
  assert.deepEqual(parseDue('~Eieren verven voor Pasen', NU), { content: 'Eieren verven voor Pasen', due: null, range: null });
});

test('~ zet ook de aanvullingen uit', () => {
  assert.deepEqual(parseDue('Kerst ~25 december diner', NU), { content: 'Kerst 25 december diner', due: null, range: null });
  assert.equal(parseDue('~Afspraak 25 december', NU)?.due ?? null, null);
});

// ---- feestdagen: alleen met een voorzetsel, en Pasen volgt de kalender ----
const FEESTDAGEN = [
  ['Cadeau kopen voor Sinterklaas', 'Cadeau kopen', '2026-12-05'],
  ['Surprise maken voor pakjesavond', 'Surprise maken', '2026-12-05'],
  ['Kaarten sturen voor Kerst', 'Kaarten sturen', '2026-12-25'],
  ['Menu bedenken voor de eerste kerstdag', 'Menu bedenken', '2026-12-25'],
  ['Spelletjes uitzoeken voor tweede kerstdag', 'Spelletjes uitzoeken', '2026-12-26'],
  ['Vuurwerk halen voor oud en nieuw', 'Vuurwerk halen', '2026-12-31'],
  ['Champagne koelen tegen oudejaarsavond', 'Champagne koelen tegen oudejaarsavond', null], // niet in de lijst: niets aanraken
  ['Vlag ophangen op Koningsdag', 'Vlag ophangen', '2027-04-27'],
  ['Kaarsje branden op dodenherdenking', 'Kaarsje branden', '2027-05-04'],
  ['Paaseieren verstoppen voor Pasen', 'Paaseieren verstoppen', '2027-03-28'],
  ['Brunch regelen op tweede paasdag', 'Brunch regelen', '2027-03-29'],
  ['Tent opzetten tegen Hemelvaart', 'Tent opzetten', '2027-05-06'],
  ['Camping boeken voor Pinksteren', 'Camping boeken', '2027-05-16'],
  ['Uitstapje plannen op tweede pinksterdag', 'Uitstapje plannen', '2027-05-17'],
];
for (const [invoer, titel, datum] of FEESTDAGEN) {
  test(`feestdag: ${invoer}`, () => {
    const r = parseDue(invoer, NU);
    if (datum === null) return assert.equal(r, null);
    assert.ok(r?.due, 'er had een datum herkend moeten worden');
    assert.equal(r.content, titel);
    assert.equal(r.due.date, datum);
    assert.equal(r.due.lang, 'nl');
  });
}

test('Pasen en wat ervan afhangt volgen de kalender (onafhankelijke feiten, niet dezelfde berekening herhaald)', () => {
  // eerste Paasdag: 2025-04-20, 2026-04-05, 2027-03-28, 2028-04-16, 2029-04-01, 2030-04-21
  const pasen = { 2025: '2025-04-20', 2026: '2026-04-05', 2027: '2027-03-28', 2028: '2028-04-16', 2029: '2029-04-01', 2030: '2030-04-21' };
  for (const [jaar, datum] of Object.entries(pasen)) {
    const januari = new Date(Number(jaar), 0, 2, 9, 0);
    assert.equal(parseDue('Eieren zoeken voor Pasen', januari).due.date, datum, `Pasen ${jaar}`);
  }
  const jan2026 = new Date(2026, 0, 2, 9, 0);
  assert.equal(parseDue('Dienst bijwonen op Goede Vrijdag', jan2026).due.date, '2026-04-03');
  assert.equal(parseDue('Brunch op tweede paasdag', jan2026).due.date, '2026-04-06');
  assert.equal(parseDue('Vrij op Hemelvaart', jan2026).due.date, '2026-05-14');
  assert.equal(parseDue('Vrij op Pinksteren', jan2026).due.date, '2026-05-24');
  assert.equal(parseDue('Vrij op tweede pinksterdag', jan2026).due.date, '2026-05-25');
  // na Pasen springt het naar het jaar erna
  assert.equal(parseDue('Eieren zoeken voor Pasen', new Date(2026, 3, 6, 9, 0)).due.date, '2027-03-28');
  assert.equal(parseDue('Eieren zoeken voor Pasen', new Date(2026, 3, 5, 9, 0)).due.date, '2026-04-05', 'op Paasdag zelf telt vandaag');
});

test('"deze week" is het einde van de werkweek', () => {
  assert.equal(parseDue('Deze week nog bellen', NU).due.date, '2026-11-13'); // woensdag -> vrijdag
  assert.equal(parseDue('Deze week nog bellen', NU).content, 'Nog bellen');
  assert.equal(parseDue('Deze week nog bellen', new Date(2026, 10, 13, 9)).due.date, '2026-11-13', 'op vrijdag zelf: vandaag');
  assert.equal(parseDue('Deze week nog bellen', new Date(2026, 10, 14, 9)).due.date, '2026-11-20', 'zaterdag: de vrijdag erna');
  assert.equal(parseDue('Deze week nog bellen', new Date(2026, 10, 15, 9)).due.date, '2026-11-20', 'zondag: de vrijdag erna');
  assert.equal(parseDue('Deze week donderdag bellen', NU).due.date, '2026-11-12', 'een genoemde dag gaat voor');
});

// ---- typografie en tekens ----
test('in het Nederlands is IJ één letter: "ijs" wordt "IJs", ook na het weghalen van de datum', () => {
  assert.equal(parseDue('Morgen ijs kopen', NU).content, 'IJs kopen');
  assert.equal(parseDue('Vrijdag ijsbaan reserveren', NU).content, 'IJsbaan reserveren');
  assert.equal(parseDue('Overmorgen IJsselmeer bezoeken', NU).content, 'IJsselmeer bezoeken');
  assert.equal(parseDue('IJs halen morgen', NU).content, 'IJs halen');
  assert.equal(parseDue('ijsje eten morgen', NU).content, 'ijsje eten', 'kleine letter blijft klein');
  assert.equal(parseDue('Vitamines elke ochtend', NU).content, 'Vitamines');
  assert.equal(parseDue('Elke ochtend ijskoffie maken', NU).content, 'IJskoffie maken');
  assert.equal(parseDue('Eind januari ijsbaan boeken', NU).content, 'IJsbaan boeken');
  assert.equal(parseDue('Morgen Ijaz bellen', NU).content, 'Ijaz bellen', 'een naam die zo gespeld is, blijft zoals getypt');
});

test('accenten en trema blijven behouden, en de ontleedde schrijfwijze wordt gewoon', () => {
  assert.equal(parseDue('Morgen café reserveren', NU).content, 'Café reserveren');
  assert.equal(parseDue('Vrijdag Zoë bellen', NU).content, 'Zoë bellen');
  assert.equal(parseDue('Maandag Ömer mailen', NU).content, 'Ömer mailen');
  assert.equal(parseDue('Morgen coördinatie overleg', NU).content, 'Coördinatie overleg');
  const ontleed = parseDue('Morgen café reserveren', NU);
  assert.equal(ontleed.content, 'Café reserveren', 'NFC');
  assert.equal(ontleed.content.length, 'Café reserveren'.length);
  assert.equal(parseDateText('Morgen', NU).date, '2026-11-12');
});

test('parseDateText: alleen een datum (voor het datumveld)', () => {
  assert.deepEqual(parseDateText('morgen', NU), { date: '2026-11-12', string: 'morgen', lang: 'nl' });
  assert.equal(parseDateText('volgende week donderdag', NU).date, '2026-11-19');
  assert.equal(parseDateText('vrijdag om 14:00', NU).date, '2026-11-13T14:00');
  assert.deepEqual(parseDateText('elke maandag', NU).recurrence, { freq: 'weekly', byweekday: [1] });
  assert.deepEqual(parseDateText('2026-12-01', NU), { date: '2026-12-01', string: '2026-12-01', lang: 'nl' });
  assert.equal(parseDateText('2026-02-30', NU), null);
  assert.equal(parseDateText('morgen misschien', NU), null, 'er blijft tekst over, dus niet volledig een datum');
  assert.equal(parseDateText('blabla', NU), null);
  assert.equal(parseDateText('', NU), null);
});
