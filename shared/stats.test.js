// De rekenkern van het productiviteitsoverzicht die server, demo en app delen (shared/stats.js): doelen en hun grenzen, dagen in
// een tijdzone (ook rond zomer- en wintertijd en bij tijdzones met een half of driekwart uur), en de telling uit het logboek.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENTITIES, validateValue } from './schema.js';
import { ACTIVITY_RETENTION_DAYS } from './activity.js';
import { DAYS_OFF_DEFAULT, GOALS, STATS_MAX_DAYS, dayIn, daysOffCheck, goalsOf, isTimeZone, parseStatsQuery, shiftDay, statsSince, tallyCompletions } from './stats.js';

const col = (name) => ENTITIES.settings.cols.find((c) => c.name === name);

test('doelen: standaard 5 per dag, 25 per week en het weekend vrij; null, ontbrekend of ongeldig geeft de standaard', () => {
  assert.deepEqual(goalsOf(null), { daily: 5, weekly: 25, daysOff: [6, 7] });
  assert.deepEqual(goalsOf({}), { daily: 5, weekly: 25, daysOff: [6, 7] });
  assert.deepEqual(goalsOf({ goal_daily: null, goal_weekly: null, days_off: null }), { daily: 5, weekly: 25, daysOff: [6, 7] });
  assert.deepEqual(goalsOf({ goal_daily: 0, goal_weekly: 0, days_off: [] }), { daily: 0, weekly: 0, daysOff: [] }, '0 is uit, een lege lijst is geen vrije dag');
  assert.deepEqual(goalsOf({ goal_daily: 100, goal_weekly: 700, days_off: [7, 3] }), { daily: 100, weekly: 700, daysOff: [3, 7] }, 'de grenzen zelf mogen; gesorteerd');
  assert.deepEqual(goalsOf({ goal_daily: 101, goal_weekly: 701, days_off: [8] }), { daily: 5, weekly: 25, daysOff: [6, 7] });
  assert.deepEqual(goalsOf({ goal_daily: -1, goal_weekly: 2.5, days_off: 'za' }), { daily: 5, weekly: 25, daysOff: [6, 7] });
  const given = [5, 1];
  goalsOf({ days_off: given });
  assert.deepEqual(given, [5, 1], 'de lijst van de instellingen blijft ongemoeid');
  const standard = goalsOf({});
  standard.daysOff.push(1);
  assert.deepEqual(goalsOf({}).daysOff, [6, 7], 'de standaard is niet te wijzigen via een antwoord');
  assert.deepEqual(DAYS_OFF_DEFAULT, [6, 7]);
  assert.equal(GOALS.daily.default, 5);
  assert.equal(GOALS.weekly.default, 25);
});

test('instellingen: de nieuwe velden hebben grenzen in het schema (server, demo en app gebruiken hetzelfde)', () => {
  for (const [name, ok, bad] of [['goal_daily', [0, 5, 100, null], [-1, 101, 2.5, '5', true]], ['goal_weekly', [0, 25, 700, null], [-1, 701, 1.5, '25']]]) {
    for (const v of ok) assert.equal(validateValue(col(name), v), null, `${name} = ${v}`);
    for (const v of bad) assert.notEqual(validateValue(col(name), v), null, `${name} = ${JSON.stringify(v)}`);
  }
  for (const v of [null, [], [6, 7], [1, 2, 3, 4, 5, 6], [7]]) assert.equal(validateValue(col('days_off'), v), null, JSON.stringify(v));
  for (const v of [[1, 2, 3, 4, 5, 6, 7], [0], [8], [1, 1], [1.5], ['ma'], 'za', 6, {}]) assert.notEqual(validateValue(col('days_off'), v), null, JSON.stringify(v));
  assert.match(daysOffCheck([1, 2, 3, 4, 5, 6, 7]), /hooguit 6/);
  assert.match(daysOffCheck([2, 2]), /dubbele/);
  assert.match(daysOffCheck([0]), /1 \(maandag\) tot 7/);
  assert.match(daysOffCheck(null), /lijst/);
  for (const name of ['goal_daily', 'goal_weekly', 'days_off']) assert.equal(col(name).default, null, `${name}: null is de standaard`);
});

test('dagen: een tijdstip hoort bij de kalenderdag in de tijdzone, ook rond middernacht', () => {
  const ams = dayIn('Europe/Amsterdam');
  assert.equal(ams(Date.parse('2026-11-13T22:59:59Z')), '2026-11-13');
  assert.equal(ams(Date.parse('2026-11-13T23:00:00Z')), '2026-11-14', 'middernacht in de winter is 23:00 UTC');
  assert.equal(ams(Date.parse('2026-07-01T21:59:00Z')), '2026-07-01');
  assert.equal(ams(Date.parse('2026-07-01T22:00:00Z')), '2026-07-02', 'en in de zomer 22:00 UTC');
  const utc = dayIn('UTC');
  assert.equal(utc(Date.parse('2026-11-13T23:59:59.999Z')), '2026-11-13');
  assert.equal(utc(Date.parse('2026-11-14T00:00:00Z')), '2026-11-14');
  assert.equal(dayIn('Asia/Kolkata')(Date.parse('2026-11-13T18:29:00Z')), '2026-11-13', 'een half uur verschuiving (+5:30)');
  assert.equal(dayIn('Asia/Kolkata')(Date.parse('2026-11-13T18:30:00Z')), '2026-11-14');
  assert.equal(dayIn('Asia/Kathmandu')(Date.parse('2026-11-13T18:14:00Z')), '2026-11-13', 'driekwart uur (+5:45)');
  assert.equal(dayIn('Asia/Kathmandu')(Date.parse('2026-11-13T18:15:00Z')), '2026-11-14');
  assert.equal(dayIn('Pacific/Kiritimati')(Date.parse('2026-11-13T10:00:00Z')), '2026-11-14', '+14: al morgen');
  assert.equal(dayIn('Pacific/Pago_Pago')(Date.parse('2026-11-14T10:00:00Z')), '2026-11-13', '-11: nog gisteren');
  assert.equal(dayIn('America/Los_Angeles')(Date.parse('2027-01-01T07:59:00Z')), '2026-12-31', 'over de jaargrens');
  assert.equal(dayIn('America/Los_Angeles')(Date.parse('2027-01-01T08:00:00Z')), '2027-01-01');
  assert.throws(() => dayIn('Mars/Olympus'), RangeError);
});

test('dagen: zomer- en wintertijd (een dag van 23 en van 25 uur) en een tijdstip dat twee keer voorkomt', () => {
  const ams = dayIn('Europe/Amsterdam');
  // 29 maart 2026: om 02:00 gaat de klok naar 03:00; de dag loopt van 28 mrt 23:00 UTC tot 29 mrt 22:00 UTC
  assert.equal(ams(Date.parse('2026-03-28T22:59:00Z')), '2026-03-28');
  assert.equal(ams(Date.parse('2026-03-28T23:00:00Z')), '2026-03-29');
  assert.equal(ams(Date.parse('2026-03-29T21:59:00Z')), '2026-03-29');
  assert.equal(ams(Date.parse('2026-03-29T22:00:00Z')), '2026-03-30');
  // 25 oktober 2026: om 03:00 terug naar 02:00; de dag loopt van 24 okt 22:00 UTC tot 25 okt 23:00 UTC
  assert.equal(ams(Date.parse('2026-10-24T21:59:00Z')), '2026-10-24');
  assert.equal(ams(Date.parse('2026-10-24T22:00:00Z')), '2026-10-25');
  assert.equal(ams(Date.parse('2026-10-25T00:30:00Z')), '2026-10-25', '02:30 de eerste keer');
  assert.equal(ams(Date.parse('2026-10-25T01:30:00Z')), '2026-10-25', '02:30 de tweede keer');
  assert.equal(ams(Date.parse('2026-10-25T22:59:00Z')), '2026-10-25');
  assert.equal(ams(Date.parse('2026-10-25T23:00:00Z')), '2026-10-26');
  // het zuidelijk halfrond: Auckland gaat op 27 september 2026 naar de zomertijd (+13)
  const akl = dayIn('Pacific/Auckland');
  assert.equal(akl(Date.parse('2026-09-26T11:59:00Z')), '2026-09-26');
  assert.equal(akl(Date.parse('2026-09-26T12:00:00Z')), '2026-09-27', '+12: middernacht is 12:00 UTC');
  assert.equal(akl(Date.parse('2026-09-27T10:59:00Z')), '2026-09-27');
  assert.equal(akl(Date.parse('2026-09-27T11:00:00Z')), '2026-09-28', 'en een dag later +13: 11:00 UTC');
});

test('dagen: verschuiven op de tekst, zonder zomertijd, over maand-, jaar- en schrikkelgrenzen', () => {
  assert.equal(shiftDay('2026-11-14', 0), '2026-11-14');
  assert.equal(shiftDay('2026-11-14', -1), '2026-11-13');
  assert.equal(shiftDay('2026-03-29', 1), '2026-03-30', 'de dag van de zomertijd is gewoon een dag');
  assert.equal(shiftDay('2026-10-25', -1), '2026-10-24');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDay('2028-02-28', 1), '2028-02-29');
  assert.equal(shiftDay('2027-02-28', 1), '2027-03-01');
  assert.equal(shiftDay('2026-11-14', -179), '2026-05-19');
});

test('vraag: days 1 tot 180 (standaard 180) en een bekende tijdzone', () => {
  assert.equal(STATS_MAX_DAYS, ACTIVITY_RETENTION_DAYS, 'zo ver gaat het logboek terug');
  assert.deepEqual(parseStatsQuery({}), { days: 180, tz: null });
  assert.deepEqual(parseStatsQuery({ days: '', tz: '' }), { days: 180, tz: null });
  assert.deepEqual(parseStatsQuery({ days: '1', tz: 'UTC' }), { days: 1, tz: 'UTC' });
  assert.deepEqual(parseStatsQuery({ days: '180', tz: 'Europe/Amsterdam' }), { days: 180, tz: 'Europe/Amsterdam' });
  assert.deepEqual(parseStatsQuery({ days: '007' }), { days: 7, tz: null });
  for (const days of ['0', '181', '-1', '1.5', 'x', '1000', ' 7']) assert.match(parseStatsQuery({ days }).error ?? '', /days moet 1 tot 180/, days);
  for (const tz of ['Mars/Olympus', 'x'.repeat(65), 'Europe/Amsterdam ']) assert.match(parseStatsQuery({ tz }).error ?? '', /tz moet/, tz);
  assert.equal(isTimeZone('Asia/Kathmandu'), true);
  assert.equal(isTimeZone(''), false);
  assert.equal(isTimeZone(null), false);
  assert.equal(isTimeZone(`Europe/${'a'.repeat(57)}`), false, 'langer dan 64 tekens');
  assert.equal(statsSince(Date.parse('2026-11-14T12:00:00Z'), 7), '2026-11-06T12:00:00.000Z', 'een dag speling voor de tijdzone');
});

const done = (at, task, project = 'proj-a', kind = 'task_completed') => ({ at, kind, task_id: task, project_id: project });
const undone = (at, task, project = 'proj-a') => done(at, task, project, 'task_uncompleted');

test('telling: per dag en per project, elke afvinking van een terugkerende taak telt, de oudste dag eerst', () => {
  const now = Date.parse('2026-11-14T15:00:00Z');
  const r = tallyCompletions([
    done('2026-11-12T08:00:00Z', 't1'), done('2026-11-12T09:00:00Z', 't2', 'proj-b'),
    done('2026-11-13T08:00:00Z', 'rec'), done('2026-11-13T09:00:00Z', 'rec'), done('2026-11-14T08:00:00Z', 'rec', 'inbox-anna'),
  ], { tz: 'Europe/Amsterdam', nowMs: now, days: 7 });
  assert.deepEqual(r, {
    tz: 'Europe/Amsterdam', today: '2026-11-14', from: '2026-11-08', days: 7, retention_days: 180,
    per_day: [
      { date: '2026-11-12', count: 2, projects: Object.assign(Object.create(null), { 'proj-a': 1, 'proj-b': 1 }) },
      { date: '2026-11-13', count: 2, projects: Object.assign(Object.create(null), { 'proj-a': 2 }) },
      { date: '2026-11-14', count: 1, projects: Object.assign(Object.create(null), { 'inbox-anna': 1 }) },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(r.per_day[0])), { date: '2026-11-12', count: 2, projects: { 'proj-a': 1, 'proj-b': 1 } }, 'zo gaat het over het netwerk');
});

test('telling: heropenen schrapt de laatste afvinking van die taak, ook na een verhuizing; een tweede heropening de vorige', () => {
  const now = Date.parse('2026-11-14T15:00:00Z');
  const tally = (entries) => Object.fromEntries(tallyCompletions(entries, { tz: 'UTC', nowMs: now, days: 7 }).per_day.map((d) => [d.date, d.count]));
  assert.deepEqual(tally([done('2026-11-13T08:00:00Z', 't1'), undone('2026-11-13T08:01:00Z', 't1')]), {}, 'per ongeluk afgevinkt en teruggezet: niets');
  assert.deepEqual(tally([done('2026-11-12T08:00:00Z', 't1'), undone('2026-11-13T08:00:00Z', 't1'), done('2026-11-14T08:00:00Z', 't1')]), { '2026-11-14': 1 }, 'de dag waarop het echt klaar was');
  assert.deepEqual(tally([done('2026-11-12T08:00:00Z', 't1'), done('2026-11-13T08:00:00Z', 't1'), undone('2026-11-13T09:00:00Z', 't1')]), { '2026-11-12': 1 }, 'de laatste gaat eraf');
  assert.deepEqual(tally([done('2026-11-12T08:00:00Z', 't1'), done('2026-11-13T08:00:00Z', 't1'), undone('2026-11-13T09:00:00Z', 't1'), undone('2026-11-13T10:00:00Z', 't1')]), {}, 'en dan de vorige');
  assert.deepEqual(tally([undone('2026-11-12T08:00:00Z', 't1'), done('2026-11-13T08:00:00Z', 't1')]), { '2026-11-13': 1 }, 'een heropening vóór de afvinking schrapt niets');
  assert.deepEqual(tally([done('2026-11-13T08:00:00Z', 't1', 'proj-a'), undone('2026-11-13T09:00:00Z', 't1', 'proj-b')]), {}, 'de taak verhuisde tussendoor naar een ander project');
  assert.deepEqual(tally([done('2026-11-13T08:00:00Z', 't1'), undone('2026-11-13T09:00:00Z', 't2')]), { '2026-11-13': 1 }, 'een andere taak');
  assert.deepEqual(tally([done('2026-11-13T08:00:00Z', null), undone('2026-11-13T09:00:00Z', null)]), { '2026-11-13': 1 }, 'zonder taak-id valt er niets te schrappen');
  assert.deepEqual(tally([done('geen tijd', 't1'), done('2026-11-13T08:00:00Z', 't2')]), { '2026-11-13': 1 }, 'een regel zonder geldig tijdstip telt niet');
});

test('telling: alleen de gevraagde dagen, in de tijdzone; wat in de toekomst ligt telt niet', () => {
  const now = Date.parse('2026-11-14T10:00:00Z'); // in Auckland al 23:00 op 14 november, in Los Angeles 02:00 op 14 november
  const entries = [
    done('2026-11-07T10:59:00Z', 'a'), // Auckland 7 nov 23:59, LA 7 nov 02:59
    done('2026-11-07T11:00:00Z', 'b'), // Auckland 8 nov 00:00
    done('2026-11-14T09:59:00Z', 'c'), // Auckland 14 nov 22:59, LA 14 nov 01:59
    done('2026-11-14T10:30:00Z', 'd'), // na nu: een klok die voorloopt; Auckland 14 nov 23:30 (vandaag) en LA ook vandaag
    done('2026-11-14T11:00:00Z', 'e'), // Auckland 15 nov 00:00: morgen
  ];
  const auckland = tallyCompletions(entries, { tz: 'Pacific/Auckland', nowMs: now, days: 7 });
  assert.equal(auckland.today, '2026-11-14');
  assert.equal(auckland.from, '2026-11-08');
  assert.deepEqual(auckland.per_day.map((d) => [d.date, d.count]), [['2026-11-08', 1], ['2026-11-14', 2]], 'de dag vóór het venster en morgen vallen weg');
  const la = tallyCompletions(entries, { tz: 'America/Los_Angeles', nowMs: now, days: 8 });
  assert.equal(la.today, '2026-11-14');
  assert.equal(la.from, '2026-11-07');
  assert.deepEqual(la.per_day.map((d) => [d.date, d.count]), [['2026-11-07', 2], ['2026-11-14', 3]]);
  const one = tallyCompletions(entries, { tz: 'Pacific/Auckland', nowMs: now, days: 1 });
  assert.equal(one.from, one.today, 'days=1 is alleen vandaag');
  assert.deepEqual(one.per_day.map((d) => d.count), [2]);
});

test('telling: een project-id als "__proto__" is gewoon een sleutel', () => {
  const r = tallyCompletions([done('2026-11-13T08:00:00Z', 't1', '__proto__'), done('2026-11-13T09:00:00Z', 't2', '__proto__')], { tz: 'UTC', nowMs: Date.parse('2026-11-14T00:00:00Z'), days: 2 });
  assert.equal(r.per_day[0].projects.__proto__, 2);
  assert.equal(JSON.stringify(r.per_day[0].projects), '{"__proto__":2}');
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
});
