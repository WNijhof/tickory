import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDateEn, parseDueEn } from './dateEn.js';

// zaterdag 14 november 2026, 10:00
const NOW = new Date(2026, 10, 14, 10, 0);
const date = (text) => parseDateEn(text, NOW)?.date ?? null;
const rec = (text) => parseDateEn(text, NOW)?.recurrence ?? null;

test('parseDateEn: vandaag, morgen, weekdagen en "in 3 days"', () => {
  assert.equal(date('today'), '2026-11-14');
  assert.equal(date('Today'), '2026-11-14');
  assert.equal(date('tod'), '2026-11-14');
  assert.equal(date('tomorrow'), '2026-11-15');
  assert.equal(date('tom'), '2026-11-15');
  assert.equal(date('yesterday'), '2026-11-13');
  assert.equal(date('monday'), '2026-11-16');
  assert.equal(date('Mon'), '2026-11-16');
  assert.equal(date('next fri'), '2026-11-20');
  assert.equal(date('saturday'), '2026-11-21', 'de eerstvolgende zaterdag, niet vandaag');
  assert.equal(date('in 3 days'), '2026-11-17');
  assert.equal(date('in two weeks'), '2026-11-28');
  assert.equal(date('in 1 month'), '2026-12-14');
  assert.equal(date('in a year'), '2027-11-14');
  assert.equal(date('next week'), '2026-11-16');
  assert.equal(date('next month'), '2026-12-01');
});

test('parseDateEn: maand en dag, met en zonder jaar (zonder jaar de dichtstbijzijnde)', () => {
  assert.equal(date('Jan 12'), '2027-01-12', 'over twee maanden, niet tien maanden geleden');
  assert.equal(date('Nov 10'), '2026-11-10', 'een taak die al over tijd is');
  assert.equal(date('May 14'), '2027-05-14', 'precies een half jaar: liever vooruit');
  assert.equal(date('January 12th'), '2027-01-12');
  assert.equal(date('12 Jan'), '2027-01-12');
  assert.equal(date('12th of January'), '2027-01-12');
  assert.equal(date('12 Jan 2027'), '2027-01-12');
  assert.equal(date('Jan 12, 2028'), '2028-01-12');
  assert.equal(date('Dec. 3'), '2026-12-03');
  assert.equal(date('on Dec 3'), '2026-12-03');
  assert.equal(date('Feb 30'), null);
  assert.equal(date('Feb 29'), null, 'geen schrikkeljaar in de buurt');
  assert.equal(date('31 Apr 2027'), null);
});

test('parseDateEn: ISO-datums, en tijden', () => {
  assert.equal(date('2026-12-01'), '2026-12-01');
  assert.equal(date('2026-12-01T09:30'), '2026-12-01T09:30');
  assert.equal(date('2026-12-01 09:30:15'), '2026-12-01T09:30');
  assert.equal(date('2026-02-30'), null);
  assert.equal(date('tomorrow at 9am'), '2026-11-15T09:00');
  assert.equal(date('tomorrow 9:30'), '2026-11-15T09:30');
  assert.equal(date('9:30pm'), '2026-11-14T21:30', 'alleen een tijd: vandaag');
  assert.equal(date('at 14:00'), '2026-11-14T14:00');
  assert.equal(date('Jan 12 at 12am'), '2027-01-12T00:00');
  assert.equal(date('Jan 12 at 12pm'), '2027-01-12T12:00');
  assert.equal(date('Jan 12 at noon'), '2027-01-12T12:00');
  assert.equal(date('friday 5 p.m.'), '2026-11-20T17:00');
  assert.equal(date('12 Jan 2027 08:15'), '2027-01-12T08:15');
  for (const bad of ['at 25:00', '13pm', '0am', '9am 10am', 'at 9:75', 'tomorrow at noon 9am']) assert.equal(date(bad), null, bad);
});

test('parseDateEn: herhalingen per dag, week, maand en jaar', () => {
  assert.deepEqual(parseDateEn('every day', NOW), { date: '2026-11-14', string: 'every day', lang: 'en', recurrence: { freq: 'daily' } });
  assert.deepEqual(parseDateEn('Every day at 9am', NOW), { date: '2026-11-15T09:00', string: 'Every day at 9am', lang: 'en', recurrence: { freq: 'daily' } }, 'negen uur is vandaag al voorbij');
  assert.equal(date('every day at 11am'), '2026-11-14T11:00');
  assert.deepEqual(rec('daily'), { freq: 'daily' });
  assert.deepEqual(rec('every 3 days'), { freq: 'daily', interval: 3 });
  assert.deepEqual(rec('every other day'), { freq: 'daily', interval: 2 });
  assert.deepEqual(rec('every week'), { freq: 'weekly' });
  assert.deepEqual(rec('weekly'), { freq: 'weekly' });
  assert.deepEqual(rec('every 2 weeks'), { freq: 'weekly', interval: 2 });
  assert.deepEqual(rec('every other week'), { freq: 'weekly', interval: 2 });
  assert.deepEqual(parseDateEn('every monday', NOW), { date: '2026-11-16', string: 'every monday', lang: 'en', recurrence: { freq: 'weekly', byweekday: [1] } });
  assert.deepEqual(rec('every mon, wed and fri'), { freq: 'weekly', byweekday: [1, 3, 5] });
  assert.deepEqual(rec('every friday & monday'), { freq: 'weekly', byweekday: [1, 5] });
  assert.deepEqual(rec('every other monday'), { freq: 'weekly', interval: 2, byweekday: [1] });
  assert.deepEqual(parseDateEn('every weekday', NOW)?.recurrence, { freq: 'weekly', byweekday: [1, 2, 3, 4, 5] });
  assert.equal(date('every weekday'), '2026-11-16');
  assert.equal(date('every workday'), '2026-11-16');
  assert.deepEqual(rec('every weekend'), { freq: 'weekly', byweekday: [6, 7] });
  assert.equal(date('every weekend'), '2026-11-14', 'vandaag is zaterdag');
  assert.deepEqual(rec('every month'), { freq: 'monthly', bymonthday: 14 });
  assert.deepEqual(parseDateEn('every month on the 15th', NOW), { date: '2026-11-15', string: 'every month on the 15th', lang: 'en', recurrence: { freq: 'monthly', bymonthday: 15 } });
  assert.deepEqual(rec('every 15th'), { freq: 'monthly', bymonthday: 15 });
  assert.equal(date('every 1st'), '2026-12-01');
  assert.deepEqual(rec('every 3 months on the 1st'), { freq: 'monthly', interval: 3, bymonthday: 1 });
  assert.deepEqual(rec('every last day'), { freq: 'monthly', bymonthday: 31 });
  assert.equal(date('every last day of the month'), '2026-11-30');
  assert.deepEqual(rec('every first monday'), { freq: 'monthly', byweekday: [1], nth: 1 });
  assert.equal(date('every first monday'), '2026-12-07', 'de eerste maandag van november is al geweest');
  assert.deepEqual(rec('every last friday of the month'), { freq: 'monthly', byweekday: [5], nth: -1 });
  assert.equal(date('every last friday'), '2026-11-27');
  assert.deepEqual(rec('every 2nd tue'), { freq: 'monthly', byweekday: [2], nth: 2 });
  assert.deepEqual(parseDateEn('every jan 12', NOW), { date: '2027-01-12', string: 'every jan 12', lang: 'en', recurrence: { freq: 'yearly', bymonthday: 12 } });
  assert.equal(date('every 12 January'), '2027-01-12');
  assert.equal(date('every year on jan 12 at 8:00'), '2027-01-12T08:00');
  assert.equal(date('every nov 14'), '2026-11-14', 'vandaag telt mee');
  assert.deepEqual(rec('every year'), { freq: 'yearly', bymonthday: 14 });
  assert.deepEqual(rec('yearly'), { freq: 'yearly', bymonthday: 14 });
  assert.deepEqual(rec('ev monday'), { freq: 'weekly', byweekday: [1] });
});

test('parseDateEn: "every!" telt vanaf het afvinken', () => {
  assert.deepEqual(rec('every! 3 days'), { freq: 'daily', interval: 3, fromCompletion: true });
  assert.deepEqual(rec('ev! week'), { freq: 'weekly', fromCompletion: true });
  assert.equal(date('every! 3 days'), '2026-11-14');
});

test('parseDateEn: wat niet herkend wordt geeft null (dan komt de tekst in de beschrijving)', () => {
  for (const bad of ['', '   ', 'every 3rd workday', 'every hour', 'every monday starting jan 5', 'every day until dec 1', 'after 3 days',
    '12/01/2026', 'someday', 'every 0 days', 'every 1001 days', 'every 32nd', 'every feb 30', 'morgen', 'elke maandag', 'x'.repeat(201), 'every']) {
    assert.equal(parseDateEn(bad, NOW), null, bad);
  }
  assert.equal(parseDateEn(null, NOW), null);
  assert.equal(parseDateEn(12, NOW), null);
});

test('parseDateEn: de oorspronkelijke tekst blijft bewaard (NFC, zonder dubbele spaties)', () => {
  assert.equal(parseDateEn('  every   Monday  ', NOW).string, 'every Monday');
  assert.equal(parseDateEn('Jan 12', NOW).lang, 'en');
});

test('parseDateEn: om de zoveel maanden op de laatste dag, en om de zoveel jaar op een datum', () => {
  assert.deepEqual(rec('every 2 months on the last day'), { freq: 'monthly', bymonthday: 31, interval: 2 });
  assert.deepEqual(rec('every 3 years on 5 december'), { freq: 'yearly', bymonthday: 5, interval: 3 });
  assert.equal(date('every 3 years on 5 december'), '2026-12-05');
  assert.deepEqual(rec('every year on jan 12'), { freq: 'yearly', bymonthday: 12 });
});

const inTitle = (text) => {
  const r = parseDueEn(text, NOW);
  return r ? { content: r.content, date: r.due?.date ?? null, string: r.due?.string ?? null, rec: r.due?.recurrence ?? null } : null;
};

test('parseDueEn: een datum in de titel van een taak, met tijd en herhaling', () => {
  assert.deepEqual(inTitle('Call mom tomorrow at 6pm'), { content: 'Call mom', date: '2026-11-15T18:00', string: 'tomorrow at 6pm', rec: null });
  assert.deepEqual(inTitle('Meeting at 9 tomorrow'), { content: 'Meeting', date: '2026-11-15T09:00', string: 'at 9 tomorrow', rec: null });
  assert.deepEqual(inTitle('Report next friday'), { content: 'Report', date: '2026-11-20', string: 'next friday', rec: null });
  assert.deepEqual(inTitle('Dentist Jan 12 at 2:30pm'), { content: 'Dentist', date: '2027-01-12T14:30', string: 'Jan 12 at 2:30pm', rec: null });
  assert.deepEqual(inTitle('Finish in 2 weeks'), { content: 'Finish', date: '2026-11-28', string: 'in 2 weeks', rec: null });
  assert.deepEqual(inTitle('Call dentist tomorrow.'), { content: 'Call dentist', date: '2026-11-15', string: 'tomorrow', rec: null });
  assert.deepEqual(inTitle('Call mom, tomorrow'), { content: 'Call mom', date: '2026-11-15', string: 'tomorrow', rec: null });
  const gym = inTitle('Gym every mon, wed and fri at 7am');
  assert.deepEqual([gym.content, gym.date, gym.rec], ['Gym', '2026-11-16T07:00', { freq: 'weekly', byweekday: [1, 3, 5] }]);
  assert.deepEqual(inTitle('Standup daily').rec, { freq: 'daily' });
  assert.deepEqual(inTitle('Pay rent every 1st').rec, { freq: 'monthly', bymonthday: 1 });
  assert.deepEqual(inTitle('Review every! 3 days').rec, { freq: 'daily', interval: 3, fromCompletion: true });
  assert.equal(inTitle('Water plants every day at 8am in the garden').content, 'Water plants in the garden', 'ook midden in de titel');
});

test('parseDueEn: gewone woorden en namen blijven tekst; een tilde voorkomt een datum', () => {
  for (const text of ['Buy sun cream', 'Call Tom', 'Plan next steps', 'Read 1984', 'Pay rent 31-12', 'Email sat@example.com', 'Wed photos', 'March for science', 'May I ask', '', '   ']) {
    assert.equal(parseDueEn(text, NOW), null, `"${text}" is geen datum`);
  }
  assert.deepEqual(inTitle('Call Tom at 9'), { content: 'Call Tom', date: '2026-11-14T09:00', string: 'at 9', rec: null }, '"Tom" is een naam, geen morgen');
  assert.equal(inTitle('Meet on sat').date, '2026-11-21', 'een afgekorte weekdag na "on"');
  assert.deepEqual(parseDueEn('Watch ~Tomorrow', NOW), { content: 'Watch Tomorrow', due: null, range: null });
  assert.deepEqual(parseDueEn('~Call tomorrow', NOW), { content: 'Call tomorrow', due: null, range: null }, 'een tilde aan het begin: de hele regel');
  assert.deepEqual(parseDueEn('Prepare the meeting ~every monday', NOW), { content: 'Prepare the meeting every monday', due: null, range: null });
  assert.equal(parseDueEn(null, NOW), null);
  const r = parseDueEn('Call mom tomorrow at 6pm', NOW);
  assert.deepEqual(r.range, [9, 24]);
  assert.equal(r.due.lang, 'en');
});
