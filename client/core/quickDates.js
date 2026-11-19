// De snelle datumkeuzes in het taakvenster en de lijst: vandaag, morgen, dit weekend, volgende week en geen datum.

import { getDayPrefs, setDayPrefs } from '../../shared/dayPrefs.js';
import { addDays } from './format.js';

/** Weekdag van een datum 'YYYY-MM-DD': 0 = zondag … 6 = zaterdag (rekenen in UTC, zodat zomertijd niets uitmaakt). */
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Welke weekdag "Volgende week" en "Weekend" zijn (Instellingen › Algemeen); zie shared/dayPrefs.js. */
export const setQuickDayPrefs = setDayPrefs;

/**
 * De data achter de snelle keuzes, vanaf `today` ('YYYY-MM-DD'):
 * - vandaag en morgen spreken voor zich;
 * - dit weekend is de gekozen weekdag (standaard zaterdag; op die dag zelf: vandaag, anders de eerstvolgende);
 * - volgende week is de gekozen weekdag (standaard maandag; de eerstvolgende, op die dag zelf over een week).
 * @returns {{ today: string, tomorrow: string, weekend: string, nextWeek: string }}
 */
export function quickDates(today) {
  const iso = weekday(today) || 7; // 1 = maandag … 7 = zondag
  const { nextWeek, weekend } = getDayPrefs();
  return {
    today,
    tomorrow: addDays(today, 1),
    weekend: addDays(today, (weekend - iso + 7) % 7), // op de dag zelf: vandaag
    nextWeek: addDays(today, ((nextWeek - iso + 7) % 7) || 7),
  };
}

/**
 * De nieuwe `due` als je een taak naar een andere dag zet: het tijdstip blijft, een herhaling blijft herhalen, en de
 * oorspronkelijke tekst ("morgen") vervalt omdat die niet meer klopt. `date` null haalt de datum weg.
 * @param {{ date: string, string?: string, lang?: string, recurrence?: object } | null} due de huidige datum van de taak
 * @param {string | null} date de nieuwe dag, 'YYYY-MM-DD'
 * @param {string} [newTime] het tijdstip 'HH:MM' ('' = geen tijdstip); weggelaten blijft het huidige tijdstip staan
 */
export function reschedule(due, date, newTime) {
  if (!date) return null;
  const time = newTime === undefined ? (due?.date.length > 10 ? due.date.slice(10) : '') : (newTime ? `T${newTime}` : '');
  const next = { date: `${date}${time}` };
  if (due?.recurrence) {
    next.recurrence = due.recurrence;
    if (due.string) next.string = due.string;
    if (due.lang) next.lang = due.lang;
  }
  return next;
}
