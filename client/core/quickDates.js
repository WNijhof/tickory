// De snelle datumkeuzes in het taakvenster en de lijst: vandaag, morgen, dit weekend, volgende week en geen datum.

import { addDays } from './format.js';

/** Weekdag van een datum 'YYYY-MM-DD': 0 = zondag … 6 = zaterdag (rekenen in UTC, zodat zomertijd niets uitmaakt). */
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

/**
 * De data achter de snelle keuzes, vanaf `today` ('YYYY-MM-DD'):
 * - vandaag en morgen spreken voor zich;
 * - dit weekend is de zaterdag van deze week (op zaterdag zelf: vandaag; op zondag: de zaterdag over zes dagen);
 * - volgende week is de eerstvolgende maandag (op maandag zelf: over een week).
 * @returns {{ today: string, tomorrow: string, weekend: string, nextWeek: string }}
 */
export function quickDates(today) {
  const dow = weekday(today);
  return {
    today,
    tomorrow: addDays(today, 1),
    weekend: addDays(today, 6 - dow), // zaterdag: 0 dagen; zondag (dow 0): 6 dagen, dus de volgende zaterdag
    nextWeek: addDays(today, ((1 - dow + 7) % 7) || 7),
  };
}

/**
 * De nieuwe `due` als je een taak naar een andere dag zet: het tijdstip blijft, een herhaling blijft herhalen, en de
 * oorspronkelijke tekst ("morgen") vervalt omdat die niet meer klopt. `date` null haalt de datum weg.
 * @param {{ date: string, string?: string, lang?: string, recurrence?: object } | null} due de huidige datum van de taak
 * @param {string | null} date de nieuwe dag, 'YYYY-MM-DD'
 */
export function reschedule(due, date) {
  if (!date) return null;
  const time = due?.date.length > 10 ? due.date.slice(10) : '';
  const next = { date: `${date}${time}` };
  if (due?.recurrence) {
    next.recurrence = due.recurrence;
    if (due.string) next.string = due.string;
    if (due.lang) next.lang = due.lang;
  }
  return next;
}
