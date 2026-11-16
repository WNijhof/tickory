import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDateText } from './dateNl.js';
import { choiceFromDue, MAX_INTERVAL, repeatPresets, repeatText } from './repeat.js';

const NOW = new Date(2026, 10, 17, 9, 41); // dinsdag 17 november 2026

/** De regel die de datumherkenner bij een keuze hoort te geven. */
function expectedRule(c) {
  const n = c.interval ?? 1;
  const iv = (rule) => (n > 1 ? { ...rule, interval: n } : rule);
  let rule;
  if (c.unit === 'day') rule = iv({ freq: 'daily' });
  else if (c.unit === 'workday') rule = { freq: 'weekly', byweekday: [1, 2, 3, 4, 5] };
  else if (c.unit === 'week') rule = c.weekdays?.length ? iv({ freq: 'weekly', byweekday: [...new Set(c.weekdays)].sort((a, b) => a - b) }) : iv({ freq: 'weekly' });
  else if (c.unit === 'month' && c.nth) rule = { freq: 'monthly', byweekday: [c.nth.weekday], nth: c.nth.n };
  else if (c.unit === 'month') rule = iv({ freq: 'monthly', bymonthday: c.monthDay === 'last' ? 31 : c.monthDay });
  else rule = iv({ freq: 'yearly', bymonthday: c.yearDate.day });
  return c.fromCompletion ? { ...rule, fromCompletion: true } : rule;
}

const sortKeys = (o) => JSON.stringify(o, Object.keys(o).sort());

function roundTrip(choice) {
  const text = repeatText(choice);
  assert.ok(text, JSON.stringify(choice));
  const due = parseDateText(text, NOW);
  assert.ok(due, `niet herkend: "${text}"`);
  const want = expectedRule(choice);
  assert.equal(sortKeys(due.recurrence), sortKeys(want), `"${text}"`);
  if (choice.time) assert.equal(due.date.slice(11), choice.time.padStart(5, '0'), `tijd in "${text}"`);
  else assert.equal(due.date.length, 10, `geen tijd in "${text}"`);
  if (choice.unit === 'year') assert.equal(Number(due.date.slice(5, 7)), choice.yearDate.month, `maand in "${text}"`);
  return text;
}

test('elke keuze geeft precies de bedoelde herhaling: eenheden, aantallen, weekdagen, tijd en vanaf afvinken', () => {
  const units = [
    { unit: 'day' }, { unit: 'workday' }, { unit: 'week' }, { unit: 'week', weekdays: [1] }, { unit: 'week', weekdays: [7] },
    { unit: 'week', weekdays: [5, 1, 3] }, { unit: 'week', weekdays: [1, 2, 3, 4, 5, 6, 7] }, { unit: 'week', weekdays: [6, 7] },
    { unit: 'month', monthDay: 1 }, { unit: 'month', monthDay: 15 }, { unit: 'month', monthDay: 31 }, { unit: 'month', monthDay: 'last' },
    { unit: 'month', nth: { n: 1, weekday: 1 } }, { unit: 'month', nth: { n: 2, weekday: 2 } }, { unit: 'month', nth: { n: 4, weekday: 6 } },
    { unit: 'month', nth: { n: -1, weekday: 5 } },
    { unit: 'year', yearDate: { day: 5, month: 12 } }, { unit: 'year', yearDate: { day: 1, month: 1 } }, { unit: 'year', yearDate: { day: 29, month: 2 } },
  ];
  let count = 0;
  for (const u of units) {
    for (const interval of u.unit === 'workday' || u.nth ? [1] : [1, 2, 3, 12]) {
      for (const time of [null, '9:00', '18:15', '0:05', '23:59']) {
        for (const fromCompletion of [false, true]) {
          roundTrip({ ...u, interval, time, fromCompletion });
          count++;
        }
      }
    }
  }
  assert.ok(count > 500);
});

test('de tekst leest als gewoon Nederlands', () => {
  assert.equal(repeatText({ unit: 'day' }), 'elke dag');
  assert.equal(repeatText({ unit: 'day', interval: 3 }), 'elke 3 dagen');
  assert.equal(repeatText({ unit: 'workday', time: '8:30' }), 'elke werkdag om 8:30');
  assert.equal(repeatText({ unit: 'week', weekdays: [1] }), 'elke maandag');
  assert.equal(repeatText({ unit: 'week', weekdays: [5, 1, 3] }), 'elke ma, wo en vr');
  assert.equal(repeatText({ unit: 'week', interval: 2, weekdays: [4] }), 'elke 2 donderdag');
  assert.equal(repeatText({ unit: 'week', interval: 2 }), 'elke 2 weken');
  assert.equal(repeatText({ unit: 'month', monthDay: 15 }), 'elke maand op de 15e');
  assert.equal(repeatText({ unit: 'month', monthDay: 'last', interval: 3 }), 'elke 3 maanden op de laatste dag');
  assert.equal(repeatText({ unit: 'month', nth: { n: -1, weekday: 5 } }), 'elke laatste vrijdag');
  assert.equal(repeatText({ unit: 'year', yearDate: { day: 5, month: 12 } }), 'elk jaar op 5 december');
  assert.equal(repeatText({ unit: 'day', interval: 3, fromCompletion: true }), 'elke! 3 dagen');
  assert.equal(repeatText({ unit: 'year', yearDate: { day: 5, month: 12 }, fromCompletion: true, time: '09:00' }), 'elk! jaar op 5 december om 9:00');
});

test('een onvolledige of vreemde keuze geeft geen tekst, en een te groot aantal wordt begrensd', () => {
  assert.equal(repeatText(null), null);
  assert.equal(repeatText({ unit: 'eeuw' }), null);
  assert.equal(repeatText({ unit: 'month' }), null);
  assert.equal(repeatText({ unit: 'month', monthDay: 32 }), null);
  assert.equal(repeatText({ unit: 'year', yearDate: { day: 5, month: 13 } }), null);
  assert.equal(repeatText({ unit: 'month', nth: { n: 5, weekday: 1 } }), null);
  assert.equal(repeatText({ unit: 'day', interval: 5000 }), `elke ${MAX_INTERVAL} dagen`);
  assert.equal(repeatText({ unit: 'day', interval: 0 }), 'elke dag');
  assert.equal(repeatText({ unit: 'day', time: '25:00' }), 'elke dag'); // geen geldig tijdstip: zonder tijd
});

test('vaste keuzes bij een dag: de weekdag, de dag van de maand (of de laatste) en de datum', () => {
  const tue = repeatPresets('2026-11-17');
  assert.deepEqual(tue.map((p) => p.key), ['daily', 'workdays', 'weekly', 'monthly', 'yearly']);
  assert.equal(tue[2].weekday, 2);
  assert.equal(repeatText(tue[2].choice), 'elke dinsdag');
  assert.equal(repeatText(tue[3].choice), 'elke maand op de 17e');
  assert.equal(repeatText(tue[4].choice), 'elk jaar op 17 november');
  assert.equal(repeatPresets('2026-11-30')[3].monthDay, 'last');
  assert.equal(repeatPresets('2026-12-31')[3].monthDay, 'last');
  assert.equal(repeatPresets('2027-02-28')[3].monthDay, 28); // 28 februari: gewoon de 28e
  assert.equal(repeatText(repeatPresets('2026-11-22', '21:00')[2].choice), 'elke zondag om 21:00');
  for (const p of repeatPresets('2026-11-17', '7:45')) roundTrip(p.choice);
});

test('een bestaande herhaling als keuze, en weer terug', () => {
  const cases = [
    'elke dag', 'elke 3 dagen om 9:00', 'elke werkdag', 'elke ma, wo en vr', 'elke 2 donderdag', 'elke 2 weken', 'elke maand op de 15e',
    'elke laatste dag van de maand', 'elke 3 maanden op de laatste dag', 'elke eerste maandag', 'elke laatste vrijdag om 17:00',
    'elk jaar op 5 december', 'elke 2 jaar op 1 januari', 'elke! 3 dagen', 'elk! jaar op 29 februari',
  ];
  for (const text of cases) {
    const due = parseDateText(text, NOW);
    const choice = choiceFromDue(due);
    assert.ok(choice, text);
    const again = parseDateText(repeatText(choice), NOW);
    assert.equal(sortKeys(again.recurrence), sortKeys(due.recurrence), `${text} → ${repeatText(choice)}`);
    assert.equal(again.date, due.date, `${text} → ${repeatText(choice)}`);
  }
  assert.equal(choiceFromDue({ date: '2026-11-17' }), null);
  assert.equal(choiceFromDue(null), null);
});
