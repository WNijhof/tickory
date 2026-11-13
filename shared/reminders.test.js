import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OFFSET, REMINDER_PRESETS, addMinutes, floatingToEpoch, hasTime, offsetParts, parseOffsetNl, reminderMoment } from './reminders.js';

const iso = (ms) => new Date(ms).toISOString();
const rel = (minute_offset) => ({ type: 'relative', minute_offset, due: null });
const abs = (date) => ({ type: 'absolute', minute_offset: null, due: { date } });
const task = (date, extra = {}) => ({ due: date ? { date } : null, checked: false, is_deleted: false, ...extra });

test('een datum heeft een tijd of niet', () => {
  assert.equal(hasTime('2026-12-01T09:00'), true);
  assert.equal(hasTime('2026-12-01T09:00:30'), true);
  for (const no of ['2026-12-01', '', null, undefined, 20261201, '2026-12-01T9:00', '2026-12-01 09:00', 'morgen']) assert.equal(hasTime(no), false, String(no));
});

test('minuten optellen en aftrekken is kalenderrekenen, ook over dag-, maand- en jaargrenzen', () => {
  assert.equal(addMinutes('2026-12-01T09:00', -30), '2026-12-01T08:30');
  assert.equal(addMinutes('2026-12-01T00:10', -30), '2026-11-30T23:40');
  assert.equal(addMinutes('2027-01-01T00:00', -1), '2026-12-31T23:59');
  assert.equal(addMinutes('2028-03-01T08:00', -1440), '2028-02-29T08:00', 'schrikkeljaar');
  assert.equal(addMinutes('2026-12-01T09:00:45', 0), '2026-12-01T09:00', 'seconden vallen weg');
  assert.equal(addMinutes('2026-12-01T09:00', 90), '2026-12-01T10:30');
  // ook rond de zomertijd: 02:30 min 60 minuten is gewoon 01:30 (de tijdzone komt pas later)
  assert.equal(addMinutes('2026-03-29T03:30', -60), '2026-03-29T02:30');
  assert.equal(addMinutes('geen datum', 5), null);
});

test('relatief: een aantal minuten vóór de tijd van de taak; zonder tijd doet ze niets', () => {
  assert.equal(reminderMoment(rel(30), task('2026-12-01T09:00')), '2026-12-01T08:30');
  assert.equal(reminderMoment(rel(0), task('2026-12-01T09:00')), '2026-12-01T09:00');
  assert.equal(reminderMoment(rel(1440), task('2026-12-01T09:00')), '2026-11-30T09:00');
  assert.equal(reminderMoment(rel(30), task('2026-12-01')), null, 'taak zonder tijd');
  assert.equal(reminderMoment(rel(30), task(null)), null, 'taak zonder datum');
  assert.equal(reminderMoment(rel(null), task('2026-12-01T09:00')), null);
  assert.equal(reminderMoment(rel(-5), task('2026-12-01T09:00')), null);
  assert.equal(reminderMoment(rel(1.5), task('2026-12-01T09:00')), null);
});

test('absoluut: een eigen tijdstip, los van de taak', () => {
  assert.equal(reminderMoment(abs('2026-11-20T18:15'), task('2026-12-01T09:00')), '2026-11-20T18:15');
  assert.equal(reminderMoment(abs('2026-11-20T18:15'), task(null)), '2026-11-20T18:15', 'ook bij een taak zonder datum');
  assert.equal(reminderMoment(abs('2026-11-20'), task(null)), null, 'zonder tijd is er niets om op af te gaan');
  assert.equal(reminderMoment({ type: 'absolute', due: null }, task(null)), null);
});

test('geen herinnering voor een afgevinkte of verwijderde taak, een verwijderde herinnering of een onbekend soort', () => {
  const t = '2026-12-01T09:00';
  assert.equal(reminderMoment(rel(30), task(t, { checked: true })), null);
  assert.equal(reminderMoment(rel(30), task(t, { is_deleted: true })), null);
  assert.equal(reminderMoment({ ...rel(30), is_deleted: true }, task(t)), null);
  assert.equal(reminderMoment(abs('2026-11-20T18:15'), task(t, { checked: true })), null);
  assert.equal(reminderMoment(rel(30), null), null);
  assert.equal(reminderMoment(rel(30), undefined), null);
  assert.equal(reminderMoment(null, task(t)), null);
  assert.equal(reminderMoment({ type: 'location' }, task(t)), null);
});

test('zwevende tijd naar een echt tijdstip in een tijdzone: winter, zomer en andere zones', () => {
  assert.equal(iso(floatingToEpoch('2026-12-01T09:00', 'Europe/Amsterdam')), '2026-12-01T08:00:00.000Z');
  assert.equal(iso(floatingToEpoch('2026-07-01T09:00', 'Europe/Amsterdam')), '2026-07-01T07:00:00.000Z');
  assert.equal(iso(floatingToEpoch('2026-12-01T09:00', 'UTC')), '2026-12-01T09:00:00.000Z');
  assert.equal(iso(floatingToEpoch('2026-12-01T09:00', 'America/New_York')), '2026-12-01T14:00:00.000Z');
  assert.equal(iso(floatingToEpoch('2026-12-01T09:00', 'Asia/Kolkata')), '2026-12-01T03:30:00.000Z', 'halve uren');
  assert.equal(iso(floatingToEpoch('2026-12-01T09:00', 'Pacific/Auckland')), '2026-11-30T20:00:00.000Z', 'zomertijd op het zuidelijk halfrond');
  assert.equal(iso(floatingToEpoch('2026-12-01T09:00:30', 'Europe/Amsterdam')), '2026-12-01T08:00:30.000Z');
  assert.equal(floatingToEpoch('2026-12-01', 'Europe/Amsterdam'), null);
  assert.equal(floatingToEpoch('onzin', null), null);
});

test('overgang naar zomertijd (29 maart 2026): het uur dat niet bestaat schuift naar voren', () => {
  const z = 'Europe/Amsterdam';
  assert.equal(iso(floatingToEpoch('2026-03-29T01:59', z)), '2026-03-29T00:59:00.000Z', 'vlak ervoor: wintertijd');
  assert.equal(iso(floatingToEpoch('2026-03-29T02:30', z)), '2026-03-29T01:30:00.000Z', '02:30 bestaat niet en wordt 03:30 zomertijd');
  assert.equal(iso(floatingToEpoch('2026-03-29T03:00', z)), '2026-03-29T01:00:00.000Z', 'vlak erna: zomertijd');
  assert.equal(iso(floatingToEpoch('2026-03-29T03:30', z)), '2026-03-29T01:30:00.000Z');
  assert.equal(iso(floatingToEpoch('2026-03-28T02:30', z)), '2026-03-28T01:30:00.000Z', 'de dag ervoor gewoon');
  assert.equal(iso(floatingToEpoch('2026-03-30T02:30', z)), '2026-03-30T00:30:00.000Z', 'de dag erna gewoon');
});

test('overgang naar wintertijd (25 oktober 2026): van het uur dat twee keer bestaat telt de eerste', () => {
  const z = 'Europe/Amsterdam';
  assert.equal(iso(floatingToEpoch('2026-10-25T01:59', z)), '2026-10-24T23:59:00.000Z');
  assert.equal(iso(floatingToEpoch('2026-10-25T02:30', z)), '2026-10-25T00:30:00.000Z', 'de eerste 02:30 (nog zomertijd)');
  assert.equal(iso(floatingToEpoch('2026-10-25T03:00', z)), '2026-10-25T02:00:00.000Z', 'daarna wintertijd');
  assert.equal(iso(floatingToEpoch('2026-10-26T02:30', z)), '2026-10-26T01:30:00.000Z');
});

test('zonder tijdzone geldt die van het apparaat, en dat geeft hetzelfde als de zone bij naam noemen', () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const f of ['2026-12-01T09:00', '2026-07-01T23:59', '2026-03-29T02:30', '2026-10-25T02:30', '2026-03-29T12:00', '2027-01-01T00:00']) {
    assert.equal(floatingToEpoch(f), floatingToEpoch(f, zone), `${f} in ${zone}`);
    assert.equal(floatingToEpoch(f), new Date(Number(f.slice(0, 4)), Number(f.slice(5, 7)) - 1, Number(f.slice(8, 10)), Number(f.slice(11, 13)), Number(f.slice(14, 16))).getTime());
  }
});

test('een herinnering van begin tot eind: taak om 9 uur in Amsterdam, een half uur vooraf', () => {
  const moment = reminderMoment(rel(30), task('2026-07-01T09:00'));
  assert.equal(iso(floatingToEpoch(moment, 'Europe/Amsterdam')), '2026-07-01T06:30:00.000Z');
  // een dag vooraf over de zomertijdgrens heen: blijft 9 uur lokale tijd (niet 24 uur eerder op de klok van UTC)
  const dayBefore = reminderMoment(rel(1440), task('2026-03-29T09:00'));
  assert.equal(dayBefore, '2026-03-28T09:00');
  assert.equal(iso(floatingToEpoch(dayBefore, 'Europe/Amsterdam')), '2026-03-28T08:00:00.000Z');
});

test('de keuzes uit de app, en hoe een aantal minuten wordt uitgesplitst', () => {
  assert.deepEqual(REMINDER_PRESETS, [0, 10, 30, 45, 60, 120, 180, 1440, 2880, 4320]);
  assert.deepEqual(REMINDER_PRESETS.map((m) => { const p = offsetParts(m); return `${p.n}${p.unit}`; }),
    ['0at', '10minutes', '30minutes', '45minutes', '1hours', '2hours', '3hours', '1days', '2days', '3days']);
  assert.deepEqual(offsetParts(90), { unit: 'minutes', n: 90 });
  assert.deepEqual(offsetParts(1500), { unit: 'hours', n: 25 });
  assert.deepEqual(offsetParts(10080), { unit: 'days', n: 7 });
});

test('Nederlands: een relatieve herinnering in gewone taal of als korte code', () => {
  const cases = {
    '30mv': 30, '30m': 30, '30 min': 30, '30 minuten': 30, '30 minuten ervoor': 30, '30 minuten van tevoren': 30, '45 minuten vooraf': 45,
    '1uv': 60, '1u': 60, '1 uur': 60, '2 uur van tevoren': 120, '3 uur ervoor': 180, 'een uur ervoor': 60, 'twee uur vooraf': 120,
    '1dv': 1440, '1d': 1440, '1 dag': 1440, '2 dagen ervoor': 2880, 'een dag van tevoren': 1440, 'één dag ervoor': 1440,
    '1 week': 10080, '2 weken ervoor': 20160,
    '0mv': 0, '0': 0, 'op tijd': 0, 'Op het tijdstip van de taak': 0, 'op tijdstip van taak': 0,
    'een kwartier': 15, 'kwartier vooraf': 15, 'een half uur ervoor': 30, 'half uur': 30,
    '10 MINUTEN ERVOOR': 10, '  5   min  ': 5, '1 minuut': 1, 'tien minuten': 10,
  };
  for (const [text, minutes] of Object.entries(cases)) assert.equal(parseOffsetNl(text), minutes, text);
  assert.equal(parseOffsetNl('één dag ervoor'.normalize('NFD')), 1440, 'ook met een los getypt accent');
});

test('Nederlands: wat geen relatieve herinnering is, wordt niet geraden', () => {
  for (const no of ['', 'morgen', 'morgen om 9 uur', 'om 9 uur', '9:00', '30', 'm', 'ervoor', '30 appels', 'half', '3 jaar', '1.5 uur', '-5 min', 'vijftig minuten', '12345 min', null, undefined, 30]) {
    assert.equal(parseOffsetNl(no), null, String(no));
  }
  // Los gelezen is "9 uur" negen uur vooraf; of het een tijdstip is ("om 9 uur") bepaalt de plek waar het staat.
  assert.equal(parseOffsetNl('9 uur'), 540);
  assert.equal(parseOffsetNl(`${MAX_OFFSET} min`), null, 'vijf cijfers lezen we niet');
  assert.equal(parseOffsetNl('9999 min'), 9999);
  assert.equal(parseOffsetNl('9999 dagen'), null, 'meer dan een jaar');
  assert.equal(parseOffsetNl('365 dagen'), MAX_OFFSET);
});

test('een echt tijdstip terug naar zwevende tijd, in een tijdzone en op dit apparaat', async () => {
  const { epochToFloating } = await import('./reminders.js');
  assert.equal(epochToFloating(Date.parse('2026-12-01T08:00:00Z'), 'Europe/Amsterdam'), '2026-12-01T09:00');
  assert.equal(epochToFloating(Date.parse('2026-07-01T07:00:59Z'), 'Europe/Amsterdam'), '2026-07-01T09:00', 'seconden vallen weg');
  assert.equal(epochToFloating(Date.parse('2026-12-31T23:30:00Z'), 'Europe/Amsterdam'), '2027-01-01T00:30', 'over de jaargrens');
  assert.equal(epochToFloating(Date.parse('2026-12-01T03:30:00Z'), 'Asia/Kolkata'), '2026-12-01T09:00');
  assert.equal(epochToFloating(Date.parse('2026-12-01T09:00:00Z'), 'UTC'), '2026-12-01T09:00');
  // heen en terug: in elke zone hetzelfde, ook rond de overgangen (voor tijden die bestaan)
  for (const zone of ['Europe/Amsterdam', 'America/New_York', 'Pacific/Auckland', 'Asia/Kolkata', 'UTC', null]) {
    for (const f of ['2026-12-01T09:00', '2026-03-29T01:59', '2026-03-29T03:00', '2026-10-25T03:30', '2026-07-15T23:59', '2027-01-01T00:00']) {
      assert.equal(epochToFloating(floatingToEpoch(f, zone), zone), f, `${f} in ${zone ?? 'de zone van dit apparaat'}`);
    }
  }
  // tien minuten na het uur dat niet bestaat komt in de zomertijd uit
  assert.equal(epochToFloating(floatingToEpoch('2026-03-29T01:55', 'Europe/Amsterdam') + 10 * 60_000, 'Europe/Amsterdam'), '2026-03-29T03:05');
});
