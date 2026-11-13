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
];
for (const [invoer, titel, datum, regel, tekst] of HERHALING) {
  test(`herhaling: ${invoer}`, () => {
    const r = parseDue(invoer, NU);
    assert.ok(r?.due, 'er had een herhaling herkend moeten worden');
    assert.equal(r.content, titel);
    assert.deepEqual(r.due, { date: datum, string: tekst, lang: 'nl', recurrence: regel });
  });
}

for (const invoer of ['Elke keer weer', 'Elk jaargetijde iets leuks', 'Elke maart opruimen', 'elke dag', 'Vergaderen elke eerste maandag van de maand', 'Elke tweede dinsdag van de maand overleg', 'Elke zomer zwemmen']) {
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
