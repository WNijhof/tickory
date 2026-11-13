// Tests voor de rekenkant van de kalender: maandgrenzen, schrikkeljaar, weeknummers rond de jaarwisseling, zomertijdwissels,
// herhalingen in een bereik en de namen in beide talen. De hele suite draait ook onder andere tijdzones (zie CONTRIBUTING):
// TZ=America/Los_Angeles en TZ=Pacific/Auckland; de uitkomsten mogen daar nergens van afhangen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_OCCURRENCE_STEPS, addMonths, calendarModel, dayLabel, endOfMonth, isoWeek, isoWeekday, monthGrid, monthName, occurrences, periodTitle, shiftPeriod,
  startOfMonth, startOfWeek, visibleRange, weekDays, weekdayNames,
} from './calendar.js';

const flat = (grid) => grid.weeks.flatMap((w) => w.days);

// ---------- dagen en maanden ----------

test('weekdag volgens ISO en de maandag van een week', () => {
  assert.equal(isoWeekday('2026-11-09'), 1, 'maandag');
  assert.equal(isoWeekday('2026-11-15'), 7, 'zondag is 7, niet 0');
  assert.equal(startOfWeek('2026-11-11'), '2026-11-09', 'woensdag');
  assert.equal(startOfWeek('2026-11-09'), '2026-11-09', 'een maandag blijft staan');
  assert.equal(startOfWeek('2026-11-15'), '2026-11-09', 'een zondag hoort bij de week ervoor');
  assert.equal(startOfWeek('2027-01-01'), '2026-12-28', 'over de jaargrens');
  assert.equal(startOfWeek('2026-11-11T09:30'), '2026-11-09', 'een tijd erachter telt niet mee');
});

test('einde van de maand, ook in een schrikkeljaar en de eeuwwissel', () => {
  assert.equal(startOfMonth('2026-11-17'), '2026-11-01');
  assert.equal(endOfMonth('2026-11-17'), '2026-11-30');
  assert.equal(endOfMonth('2026-12-01'), '2026-12-31');
  assert.equal(endOfMonth('2026-04-10'), '2026-04-30');
  assert.equal(endOfMonth('2024-02-10'), '2024-02-29', 'schrikkeljaar');
  assert.equal(endOfMonth('2023-02-10'), '2023-02-28');
  assert.equal(endOfMonth('2100-02-10'), '2100-02-28', '2100 is geen schrikkeljaar (deelbaar door 100)');
  assert.equal(endOfMonth('2000-02-10'), '2000-02-29', '2000 wel (deelbaar door 400)');
});

test('maanden verder of terug: de dag wordt ingekort op een korte maand en het jaar rolt mee', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonths('2026-11-13', 0), '2026-11-13');
  assert.equal(addMonths('2026-11-13', 14), '2028-01-13');
  assert.equal(addMonths('2026-11-13', -23), '2024-12-13');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
});

// ---------- weeknummers ----------

test('ISO-weeknummers rond de jaarwisseling', () => {
  const week = (day) => { const { year, week: w } = isoWeek(day); return `${year}-W${w}`; };
  assert.equal(week('2026-01-01'), '2026-W1', '1 januari 2026 is een donderdag: week 1');
  assert.equal(week('2026-11-13'), '2026-W46');
  assert.equal(week('2026-12-31'), '2026-W53', '2026 heeft 53 weken');
  assert.equal(week('2027-01-01'), '2026-W53', 'vrijdag 1 januari 2027 hoort nog bij het vorige jaar');
  assert.equal(week('2027-01-03'), '2026-W53');
  assert.equal(week('2027-01-04'), '2027-W1');
  assert.equal(week('2024-12-29'), '2024-W52');
  assert.equal(week('2024-12-30'), '2025-W1', 'maandag 30 december 2024 is al week 1 van 2025');
  assert.equal(week('2024-12-31'), '2025-W1');
  assert.equal(week('2021-01-03'), '2020-W53');
  assert.equal(week('2021-01-04'), '2021-W1');
  assert.equal(week('2020-12-31'), '2020-W53');
  assert.equal(week('2016-01-03'), '2015-W53');
  assert.equal(week('2025-12-29'), '2026-W1');
  assert.equal(week('2024-03-01'), '2024-W9', 'na een schrikkeldag');
  assert.equal(week('2026-11-13T23:59'), '2026-W46');
});

// ---------- weken en maandrasters ----------

test('een week loopt van maandag tot zondag, ook over de jaargrens', () => {
  assert.deepEqual(weekDays('2026-11-11'), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
  assert.deepEqual(weekDays('2026-12-31'), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
});

test('maandraster: hele weken, de juiste rijen, schrikkeldag erin', () => {
  const nov = monthGrid('2026-11-17'); // 1 november 2026 is een zondag, 30 november een maandag
  assert.equal(nov.month, '2026-11');
  assert.equal(nov.weeks.length, 6);
  assert.equal(nov.weeks[0].days[0], '2026-10-26');
  assert.equal(nov.weeks[0].days[6], '2026-11-01');
  assert.equal(nov.weeks[5].days[0], '2026-11-30');
  assert.equal(nov.weeks[5].days[6], '2026-12-06');
  assert.deepEqual(nov.weeks.map((w) => w.week), [44, 45, 46, 47, 48, 49]);

  const feb27 = monthGrid('2027-02-01'); // precies vier weken: 1 februari is een maandag, 28 februari een zondag
  assert.equal(feb27.weeks.length, 4);
  assert.equal(feb27.weeks[0].days[0], '2027-02-01');
  assert.equal(feb27.weeks[3].days[6], '2027-02-28');

  const feb24 = flat(monthGrid('2024-02-10')); // schrikkeljaar
  assert.ok(feb24.includes('2024-02-29'));
  assert.ok(!feb24.includes('2024-02-30'));
  assert.equal(feb24.length, 35);

  const jan = monthGrid('2027-01-15'); // de eerste rij begint in december en hoort bij week 53 van 2026
  assert.equal(jan.weeks[0].days[0], '2026-12-28');
  assert.deepEqual([jan.weeks[0].year, jan.weeks[0].week], [2026, 53]);
  assert.deepEqual([jan.weeks[1].year, jan.weeks[1].week], [2027, 1]);
});

test('elk raster is aaneengesloten, start op maandag en dekt de hele maand, voor elke maand van enkele jaren', () => {
  for (let year = 2023; year <= 2028; year++) {
    for (let m = 1; m <= 12; m++) {
      const anchor = `${year}-${String(m).padStart(2, '0')}-15`;
      const days = flat(monthGrid(anchor));
      assert.equal(days.length % 7, 0, anchor);
      assert.equal(isoWeekday(days[0]), 1, `${anchor}: begint op maandag`);
      assert.equal(isoWeekday(days.at(-1)), 7, `${anchor}: eindigt op zondag`);
      assert.ok(days.includes(startOfMonth(anchor)) && days.includes(endOfMonth(anchor)), anchor);
      for (let i = 1; i < days.length; i++) {
        const gap = (Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`)) / 86_400_000;
        assert.equal(gap, 1, `${anchor}: ${days[i - 1]} -> ${days[i]}`);
      }
    }
  }
});

test('zomertijdwissels: geen dag valt weg of komt dubbel voor, in Nederland, Amerika en Nieuw-Zeeland', () => {
  const cases = [
    ['2026-03-29', ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29']], // Europa naar zomertijd
    ['2026-10-25', ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']], // Europa naar wintertijd
    ['2026-03-08', ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']], // Amerika naar zomertijd
    ['2026-11-01', ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']], // Amerika naar wintertijd
    ['2026-09-27', ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']], // Nieuw-Zeeland naar zomertijd
    ['2026-04-05', ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05']], // Nieuw-Zeeland naar wintertijd
  ];
  for (const [day, expected] of cases) assert.deepEqual(weekDays(day), expected, day);
  for (const month of ['2026-03-10', '2026-10-10', '2026-11-10', '2026-09-10', '2026-04-10']) {
    const days = flat(monthGrid(month));
    assert.equal(new Set(days).size, days.length, `${month}: dubbele dag`);
    assert.equal(days.length % 7, 0);
  }
  // het tijdstip blijft zwevend: 02:30 op de dag dat de klok verspringt blijft 02:30
  const daily = { due: { date: '2026-03-28T02:30', recurrence: { freq: 'daily' } } };
  assert.deepEqual(occurrences(daily, '2026-03-28', '2026-03-30').map((o) => `${o.date} ${o.time}`), ['2026-03-28 02:30', '2026-03-29 02:30', '2026-03-30 02:30']);
});

test('bereik en bladeren: maand met de randdagen, week van maandag tot zondag', () => {
  assert.deepEqual(visibleRange('month', '2026-11-17'), { from: '2026-10-26', to: '2026-12-06' });
  assert.deepEqual(visibleRange('week', '2026-11-17'), { from: '2026-11-16', to: '2026-11-22' });
  assert.equal(shiftPeriod('month', '2026-11-30', 1), '2026-12-30');
  assert.equal(shiftPeriod('month', '2026-12-31', 1), '2027-01-31');
  assert.equal(shiftPeriod('month', '2027-03-31', -1), '2027-02-28');
  assert.equal(shiftPeriod('week', '2026-12-30', 1), '2027-01-06');
  assert.equal(shiftPeriod('week', '2027-01-02', -1), '2026-12-26');
});

// ---------- taken op dagen ----------

test('een taak zonder herhaling staat alleen op zijn eigen dag, en alleen als die in het bereik valt', () => {
  const task = { due: { date: '2026-11-12' } };
  assert.deepEqual(occurrences(task, '2026-11-09', '2026-11-15'), [{ date: '2026-11-12', time: null, real: true }]);
  assert.deepEqual(occurrences(task, '2026-11-13', '2026-11-20'), []);
  assert.deepEqual(occurrences(task, '2026-11-12', '2026-11-12'), [{ date: '2026-11-12', time: null, real: true }], 'de grenzen horen erbij');
  assert.deepEqual(occurrences({ due: null }, '2026-11-01', '2026-11-30'), []);
  assert.deepEqual(occurrences({}, '2026-11-01', '2026-11-30'), []);
  assert.deepEqual(occurrences({ due: { date: '2026-11-12T09:30' } }, '2026-11-09', '2026-11-15'), [{ date: '2026-11-12', time: '09:30', real: true }]);
});

test('herhaling in een bereik: de eerste is echt, de volgende voorkomens zijn alleen getoond', () => {
  const dates = (task, from, to) => occurrences(task, from, to).map((o) => `${o.date}${o.real ? '' : '~'}`);
  assert.deepEqual(dates({ due: { date: '2026-11-10', recurrence: { freq: 'daily' } } }, '2026-11-09', '2026-11-13'), ['2026-11-10', '2026-11-11~', '2026-11-12~', '2026-11-13~']);
  assert.deepEqual(dates({ due: { date: '2026-11-09', recurrence: { freq: 'weekly', byweekday: [1, 3] } } }, '2026-11-09', '2026-11-22'), ['2026-11-09', '2026-11-11~', '2026-11-16~', '2026-11-18~']);
  assert.deepEqual(dates({ due: { date: '2026-11-03', recurrence: { freq: 'daily', interval: 3 } } }, '2026-11-09', '2026-11-20'), ['2026-11-09~', '2026-11-12~', '2026-11-15~', '2026-11-18~']);
  // de eigen datum ligt vóór het bereik: de volgende voorkomens zijn er wel
  assert.deepEqual(dates({ due: { date: '2026-10-05', recurrence: { freq: 'weekly' } } }, '2026-11-09', '2026-11-22'), ['2026-11-09~', '2026-11-16~']);
  // een maand met een vaste dag: elke 31e blijft de 31e na een korte maand, en februari is korter in een schrikkeljaar
  assert.deepEqual(dates({ due: { date: '2026-01-31', recurrence: { freq: 'monthly', bymonthday: 31 } } }, '2026-02-01', '2026-04-30'), ['2026-02-28~', '2026-03-31~', '2026-04-30~']);
  assert.deepEqual(dates({ due: { date: '2028-01-31', recurrence: { freq: 'monthly', bymonthday: 31 } } }, '2028-02-01', '2028-03-31'), ['2028-02-29~', '2028-03-31~']);
  assert.deepEqual(dates({ due: { date: '2024-02-29', recurrence: { freq: 'yearly', bymonthday: 29 } } }, '2025-01-01', '2028-12-31'), ['2025-02-28~', '2026-02-28~', '2027-02-28~', '2028-02-29~']);
  // de tweede dinsdag van de maand
  assert.deepEqual(dates({ due: { date: '2026-10-13', recurrence: { freq: 'monthly', nth: 2, byweekday: [2] } } }, '2026-11-01', '2027-01-31'), ['2026-11-10~', '2026-12-08~', '2027-01-12~']);
  // het tijdstip blijft bij elk voorkomen
  const timed = occurrences({ due: { date: '2026-11-10T09:30', recurrence: { freq: 'daily' } } }, '2026-11-10', '2026-11-12');
  assert.deepEqual(timed.map((o) => o.time), ['09:30', '09:30', '09:30']);
});

test('een herhaling die niet te lezen is, of eindeloos lang geleden begon, geeft geen fout en geen eindeloze lus', () => {
  assert.deepEqual(occurrences({ due: { date: '2026-11-10', recurrence: { freq: 'bogus' } } }, '2026-11-09', '2026-11-20').map((o) => o.date), ['2026-11-10']);
  const started = Date.now();
  const old = occurrences({ due: { date: '1990-01-01', recurrence: { freq: 'daily' } } }, '2026-11-01', '2026-11-30');
  assert.ok(Date.now() - started < 2000, 'begrensd aantal stappen');
  assert.ok(old.length === 0, 'voorbij de grens van de stappen houdt het op');
  assert.ok(MAX_OCCURRENCE_STEPS >= 3650, 'tien jaar dagelijks moet nog lukken');
  const tenYears = occurrences({ due: { date: '2016-11-20', recurrence: { freq: 'daily' } } }, '2026-11-10', '2026-11-12');
  assert.deepEqual(tenYears.map((o) => o.date), ['2026-11-10', '2026-11-11', '2026-11-12']);
});

const task = (id, due, extra = {}) => ({ id, content: id, due, checked: false, priority: 4, order_key: id, ...extra });

test('kalendermodel: alleen openstaande taken, te late taken apart, vandaag en later in de dagen', () => {
  const today = '2026-11-13';
  const m = calendarModel({
    mode: 'month', anchor: today, today,
    tasks: [
      task('a-tandarts', { date: '2026-11-13T14:00' }),
      task('b-vroeg', { date: '2026-11-13T08:30' }, { priority: 3 }),
      task('c-heledag', { date: '2026-11-13' }),
      task('d-te-laat', { date: '2026-11-10' }),
      task('e-eerder', { date: '2026-11-02' }),
      task('f-klaar', { date: '2026-11-14' }, { checked: true }),
      task('g-zonder', null),
      task('h-later', { date: '2026-11-25' }),
      task('i-andere-maand', { date: '2027-03-01' }),
      task('j-wekelijks-te-laat', { date: '2026-11-09', recurrence: { freq: 'weekly' } }),
    ],
  });
  assert.equal(m.from, '2026-10-26');
  assert.equal(m.to, '2026-12-06');
  assert.equal(m.days.length, 42);
  const ids = (date) => m.days.find((d) => d.date === date).entries.map((e) => `${e.task.id}${e.real ? '' : '~'}`);
  assert.deepEqual(ids('2026-11-13'), ['c-heledag', 'b-vroeg', 'a-tandarts'], 'dag zonder tijd eerst, dan op tijd');
  assert.deepEqual(ids('2026-11-10'), [], 'wat te laat is staat niet op zijn oude dag');
  assert.deepEqual(m.overdue.map((x) => x.id), ['e-eerder', 'j-wekelijks-te-laat', 'd-te-laat'], 'oudste eerst');
  assert.deepEqual(ids('2026-11-16'), ['j-wekelijks-te-laat~'], 'een te late herhaling staat ook op haar komende voorkomens');
  assert.deepEqual(ids('2026-11-14'), [], 'een afgevinkte taak staat er niet');
  assert.deepEqual(ids('2026-11-25'), ['h-later']);
  assert.equal(m.days.flatMap((d) => d.entries).filter((e) => e.task.id === 'i-andere-maand').length, 0);
  assert.equal(m.total, m.days.reduce((n, d) => n + d.entries.length, 0));
});

test('kalendermodel: in een volgende maand komen de voorkomens van een herhaling zonder dat er iets bewaard wordt', () => {
  const today = '2026-11-13';
  const tasks = [task('afval', { date: '2026-11-17', recurrence: { freq: 'weekly', byweekday: [2] } })];
  const before = JSON.stringify(tasks);
  const dec = calendarModel({ tasks, mode: 'month', anchor: '2026-12-10', today });
  const tuesdays = dec.days.filter((d) => d.entries.length > 0).map((d) => d.date);
  assert.deepEqual(tuesdays, ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29']);
  assert.ok(dec.days.flatMap((d) => d.entries).every((e) => !e.real));
  assert.equal(JSON.stringify(tasks), before, 'de taak zelf is niet veranderd');
  // het verleden in bladeren: geen voorkomens vóór vandaag
  const oct = calendarModel({ tasks, mode: 'month', anchor: '2026-10-10', today });
  assert.equal(oct.total, 0);
  assert.deepEqual(oct.overdue, []);
  // weekweergave
  const week = calendarModel({ tasks, mode: 'week', anchor: '2026-11-17', today });
  assert.equal(week.days.length, 7);
  assert.deepEqual(week.days.filter((d) => d.entries.length).map((d) => d.date), ['2026-11-17']);
});

test('kalendermodel: dezelfde uitkomst als vandaag een andere dag is (alleen `today` bepaalt wat te laat is)', () => {
  const tasks = [task('x', { date: '2026-11-13' })];
  assert.equal(calendarModel({ tasks, mode: 'week', anchor: '2026-11-13', today: '2026-11-13' }).overdue.length, 0);
  assert.equal(calendarModel({ tasks, mode: 'week', anchor: '2026-11-13', today: '2026-11-14' }).overdue.length, 1);
});

// ---------- namen en titels ----------

test('Nederlandse dag- en maandnamen, week begint op maandag', () => {
  assert.deepEqual(weekdayNames('nl-NL', 'short'), ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']);
  assert.deepEqual(weekdayNames('nl-NL', 'long'), ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag']);
  assert.equal(monthName('nl-NL', 3), 'maart');
  assert.equal(monthName('nl-NL', 11), 'november');
  assert.equal(dayLabel('nl-NL', '2026-11-19', 'full'), 'donderdag 19 november 2026');
  assert.equal(dayLabel('nl-NL', '2026-11-19', 'long'), 'donderdag 19 november');
  assert.match(dayLabel('nl-NL', '2026-03-01', 'dm'), /^1 mrt\.?$/);
  assert.equal(periodTitle('month', '2026-11-13', 'nl-NL'), 'November 2026');
  assert.equal(periodTitle('month', '2027-03-31', 'nl-NL'), 'Maart 2027');
  assert.match(periodTitle('week', '2026-11-13', 'nl-NL'), /^9\s*[–-]\s*15 nov\.? 2026$/);
  assert.match(periodTitle('week', '2026-12-31', 'nl-NL'), /^28 dec\.? 2026\s*[–-]\s*3 jan\.? 2027$/, 'een week over de jaargrens noemt beide jaren');
});

test('Engelse namen volgen de taal van de interface', () => {
  assert.deepEqual(weekdayNames('en-GB', 'short'), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(monthName('en-GB', 3), 'March');
  assert.match(dayLabel('en-GB', '2026-11-19', 'full'), /^Thursday,? 19 November 2026$/);
  assert.equal(periodTitle('month', '2026-11-13', 'en-GB'), 'November 2026');
  assert.equal(periodTitle('month', '2027-03-31', 'en-GB'), 'March 2027');
});
