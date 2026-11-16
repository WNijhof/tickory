// De herhalingskiezer in het taakvenster: van een keuze met knoppen naar de Nederlandse tekst die het datumveld leest
// (dateNl.js), en terug van een bestaande herhaling naar een keuze. De tekst is de enige bron: het datumveld, de uitleg eronder
// ("wordt: …"), bewaren en ongedaan maken werken er al mee. repeat.test.js controleert dat elke keuze precies de bedoelde
// regel oplevert.
//
// Een keuze:
//   { unit: 'day' | 'workday' | 'week' | 'month' | 'year', interval?: 1..999,
//     weekdays?: [1..7] (week; 1 = maandag), monthDay?: 1..31 | 'last' (month), nth?: { n: 1..4 | -1, weekday: 1..7 } (month),
//     yearDate?: { day, month } (year), time?: 'HH:MM' | null, fromCompletion?: boolean }

import { getLocale, t } from './i18n.js';

export const MAX_INTERVAL = 999;

const WEEKDAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
const SHORT = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const ORDINALS = { 1: 'eerste', 2: 'tweede', 3: 'derde', 4: 'vierde', '-1': 'laatste' };

const clampInterval = (n) => (Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_INTERVAL) : 1);
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "ma, wo en vr" of, bij één dag, "maandag". */
function dayList(days) {
  const list = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (list.length === 1) return WEEKDAYS[list[0] - 1];
  const names = list.map((d) => SHORT[d - 1]);
  return `${names.slice(0, -1).join(', ')} en ${names[names.length - 1]}`;
}

/** De tekst voor het datumveld, of null als de keuze niet compleet is (een week zonder dagen mag: dan de dag van de start). */
export function repeatText(choice) {
  if (!choice) return null;
  const n = clampInterval(choice.interval ?? 1);
  let text;
  switch (choice.unit) {
    case 'day':
      text = n === 1 ? 'elke dag' : `elke ${n} dagen`;
      break;
    case 'workday':
      text = 'elke werkdag';
      break;
    case 'week': {
      const days = (choice.weekdays ?? []).filter((d) => d >= 1 && d <= 7);
      if (days.length === 0) text = n === 1 ? 'elke week' : `elke ${n} weken`;
      else text = n === 1 ? `elke ${dayList(days)}` : `elke ${n} ${dayList(days)}`;
      break;
    }
    case 'month':
      if (choice.nth) {
        const ord = ORDINALS[String(choice.nth.n)];
        const wd = WEEKDAYS[choice.nth.weekday - 1];
        if (!ord || !wd) return null;
        text = `elke ${ord} ${wd}`; // de n-de weekdag kent geen "om de zoveel maanden"
      } else if (choice.monthDay === 'last') {
        text = n === 1 ? 'elke laatste dag van de maand' : `elke ${n} maanden op de laatste dag`;
      } else {
        const d = Number(choice.monthDay);
        if (!Number.isInteger(d) || d < 1 || d > 31) return null;
        text = n === 1 ? `elke maand op de ${d}e` : `elke ${n} maanden op de ${d}e`;
      }
      break;
    case 'year': {
      const { day, month } = choice.yearDate ?? {};
      if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12 || day < 1 || day > 31) return null;
      text = n === 1 ? `elk jaar op ${day} ${MONTHS[month - 1]}` : `elke ${n} jaar op ${day} ${MONTHS[month - 1]}`;
      break;
    }
    default:
      return null;
  }
  if (choice.fromCompletion) text = text.replace(/^(elke|elk)\b/u, '$1!');
  const time = typeof choice.time === 'string' ? TIME.exec(choice.time) : null;
  if (time) text += ` om ${Number(time[1])}:${time[2]}`;
  return text;
}

const isoWeekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay() || 7;

/** Is dit de laatste dag van de maand? */
const isLastDay = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.getUTCDate() === 1;
};

/**
 * De vaste keuzes bij een dag (de gekozen datum, of vandaag): elke dag, elke werkdag, elke week op die weekdag, elke maand op
 * die dag (of de laatste dag), elk jaar op die datum. `time` gaat mee (een tijdstip dat de taak al had).
 * @returns {{ key: string, choice: object, weekday?: number, monthDay?: number | 'last', day?: number, month?: number }[]}
 */
export function repeatPresets(day, time = null) {
  const [, m, d] = day.split('-').map(Number);
  const weekday = isoWeekday(day);
  const monthDay = isLastDay(day) && d >= 29 ? 'last' : d;
  return [
    { key: 'daily', choice: { unit: 'day', time } },
    { key: 'workdays', choice: { unit: 'workday', time } },
    { key: 'weekly', choice: { unit: 'week', weekdays: [weekday], time }, weekday },
    { key: 'monthly', choice: { unit: 'month', monthDay, time }, monthDay },
    { key: 'yearly', choice: { unit: 'year', yearDate: { day: d, month: m }, time }, day: d, month: m },
  ];
}

/**
 * Een bestaande herhaling (due.recurrence met due.date) als keuze, om de eigen keuze mee te beginnen. Null als er geen is.
 */
export function choiceFromDue(due) {
  const rule = due?.recurrence;
  if (!rule || typeof due.date !== 'string') return null;
  const time = due.date.length > 10 ? due.date.slice(11, 16) : null;
  const interval = clampInterval(rule.interval ?? 1);
  const base = { interval, time, fromCompletion: Boolean(rule.fromCompletion) };
  const [, m, d] = due.date.slice(0, 10).split('-').map(Number);
  switch (rule.freq) {
    case 'daily':
      return { ...base, unit: 'day' };
    case 'weekly': {
      const days = Array.isArray(rule.byweekday) ? rule.byweekday : [];
      if (interval === 1 && days.join() === '1,2,3,4,5') return { ...base, unit: 'workday' };
      return { ...base, unit: 'week', weekdays: days };
    }
    case 'monthly':
      if (rule.nth !== undefined && Array.isArray(rule.byweekday)) return { ...base, interval: 1, unit: 'month', nth: { n: rule.nth, weekday: rule.byweekday[0] } };
      return { ...base, unit: 'month', monthDay: rule.bymonthday === 31 ? 'last' : (rule.bymonthday ?? d) };
    case 'yearly':
      return { ...base, unit: 'year', yearDate: { day: rule.bymonthday ?? d, month: m } };
    default:
      return null;
  }
}

// ---------- in woorden, in de taal van de interface ----------

const utcDay = (iso) => new Date(Date.UTC(2026, 10, 15 + iso)); // 16 november 2026 is een maandag
/** De naam van een weekdag (1 = maandag) in de taal van de interface: 'long' of 'short'. */
export const weekdayName = (iso, style = 'long') => new Intl.DateTimeFormat(getLocale(), { weekday: style, timeZone: 'UTC' }).format(utcDay(iso));
/** De naam van een maand (1 = januari) in de taal van de interface. */
export const monthName = (month) => new Intl.DateTimeFormat(getLocale(), { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, month - 1, 1)));
const dayMonth = (day, month) => new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, month - 1, day)));
const listOf = (items) => new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(items);

const ORDINAL_WORDS = {
  1: () => t('repeat.ordFirst'), 2: () => t('repeat.ordSecond'), 3: () => t('repeat.ordThird'), 4: () => t('repeat.ordFourth'), '-1': () => t('repeat.ordLast'),
};
/** "eerste", "tweede", …, "laatste" in de taal van de interface. */
export const ordinalWord = (n) => ORDINAL_WORDS[String(n)]?.() ?? '';

/**
 * Een keuze in woorden, voor de knoppen en het voorbeeld in de kiezer: "Om de 2 weken op maandag en donderdag om 9:00".
 * Null als de keuze niet compleet is.
 */
export function repeatSummary(choice) {
  if (!repeatText(choice)) return null;
  const n = clampInterval(choice.interval ?? 1);
  let rule;
  switch (choice.unit) {
    case 'day':
      rule = n === 1 ? t('repeat.sumDay') : t('repeat.sumDays', { n });
      break;
    case 'workday':
      rule = t('repeat.sumWorkday');
      break;
    case 'week': {
      const days = [...new Set(choice.weekdays ?? [])].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
      if (days.length === 0) rule = n === 1 ? t('repeat.sumWeek') : t('repeat.sumWeeks', { n });
      else {
        const names = listOf(days.map((d) => weekdayName(d, days.length > 2 ? 'short' : 'long')));
        rule = n === 1 ? t('repeat.sumWeekOn', { days: names }) : t('repeat.sumWeeksOn', { n, days: names });
      }
      break;
    }
    case 'month':
      if (choice.nth) rule = t('repeat.sumNth', { ordinal: ordinalWord(choice.nth.n), weekday: weekdayName(choice.nth.weekday) });
      else if (choice.monthDay === 'last') rule = n === 1 ? t('repeat.sumMonthLast') : t('repeat.sumMonthsLast', { n });
      else rule = n === 1 ? t('repeat.sumMonthDay', { day: choice.monthDay }) : t('repeat.sumMonthsDay', { n, day: choice.monthDay });
      break;
    case 'year': {
      const date = dayMonth(choice.yearDate.day, choice.yearDate.month);
      rule = n === 1 ? t('repeat.sumYear', { date }) : t('repeat.sumYears', { n, date });
      break;
    }
    default:
      return null;
  }
  const time = typeof choice.time === 'string' ? TIME.exec(choice.time) : null;
  if (time) rule = t('repeat.sumTime', { rule, time: `${Number(time[1])}:${time[2]}` });
  if (choice.fromCompletion) rule = t('repeat.sumFromCompletion', { rule });
  return rule;
}
