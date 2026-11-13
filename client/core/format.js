// Datums tonen in de taal van de interface. Datums zijn zwevend ('YYYY-MM-DD' of 'YYYY-MM-DDTHH:MM'); rekenen gaat in UTC
// zodat zomer- en wintertijd geen rol spelen.

import { t } from './i18n.js';

// Elke naam wordt pas opgezocht op het moment van tonen, zodat de taal tussentijds kan wisselen.
const DAYS = [
  () => t('date.weekday.sunday'), () => t('date.weekday.monday'), () => t('date.weekday.tuesday'), () => t('date.weekday.wednesday'),
  () => t('date.weekday.thursday'), () => t('date.weekday.friday'), () => t('date.weekday.saturday'),
];
const DAYS_SHORT = [
  () => t('date.weekdayShort.sunday'), () => t('date.weekdayShort.monday'), () => t('date.weekdayShort.tuesday'), () => t('date.weekdayShort.wednesday'),
  () => t('date.weekdayShort.thursday'), () => t('date.weekdayShort.friday'), () => t('date.weekdayShort.saturday'),
];
const MONTHS = [
  () => t('date.month.jan'), () => t('date.month.feb'), () => t('date.month.mar'), () => t('date.month.apr'),
  () => t('date.month.may'), () => t('date.month.jun'), () => t('date.month.jul'), () => t('date.month.aug'),
  () => t('date.month.sep'), () => t('date.month.oct'), () => t('date.month.nov'), () => t('date.month.dec'),
];
/** De weekdag voluit ("donderdag"), kort ("do") en de maand kort ("nov") van een UTC-datum. */
const dayName = (d) => DAYS[d.getUTCDay()]();
const dayShort = (d) => DAYS_SHORT[d.getUTCDay()]();
const monthShort = (d) => MONTHS[d.getUTCMonth()]();

const pad = (n) => String(n).padStart(2, '0');
const utc = (dateStr) => new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);

/** Vandaag als 'YYYY-MM-DD' in de tijdzone van het apparaat. */
export function todayString(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Het tijdstip van nu als 'YYYY-MM-DDTHH:MM' in de tijdzone van het apparaat. */
export function nowString(now = new Date()) {
  return `${todayString(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function addDays(dateStr, n) {
  const d = utc(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Aantal dagen van `today` tot `dateStr` (negatief = verleden). */
export function daysBetween(today, dateStr) {
  return Math.round((utc(dateStr) - utc(today)) / 86_400_000);
}

/** Korte datum: vandaag, morgen, gisteren, de weekdag (binnen een week), anders "do 19 nov" of "19 nov 2027". */
export function formatDate(dateStr, today) {
  const diff = daysBetween(today, dateStr);
  if (diff === 0) return t('date.today');
  if (diff === 1) return t('date.tomorrow');
  if (diff === -1) return t('date.yesterday');
  const d = utc(dateStr);
  if (diff > 1 && diff < 7) return dayName(d);
  const base = `${d.getUTCDate()} ${monthShort(d)}`;
  return dateStr.slice(0, 4) === today.slice(0, 4) ? `${dayShort(d)} ${base}` : `${base} ${d.getUTCFullYear()}`;
}

/**
 * Een `due` met de volledige datum ("do 19 nov", "wo 1 jan 2027 14:30"), voor bevestiging bij het invullen. De korte vorm
 * ("donderdag") is in een lijst prettig, maar bij "volgende week donderdag" te vaag om op te vertrouwen.
 */
export function formatDueLong(due, today) {
  if (!due) return '';
  const d = utc(due.date);
  const year = due.date.slice(0, 4) === today.slice(0, 4) ? '' : ` ${d.getUTCFullYear()}`;
  const time = due.date.length > 10 ? ` ${due.date.slice(11, 16)}` : '';
  return `${due.recurrence ? '↻ ' : ''}${dayShort(d)} ${d.getUTCDate()} ${monthShort(d)}${year}${time}`;
}

/** Kop boven een dag in een overzicht: "Vandaag · wo 11 nov". */
export function formatDayHeading(dateStr, today) {
  const d = utc(dateStr);
  const full = `${dayShort(d)} ${d.getUTCDate()} ${monthShort(d)}`;
  const diff = daysBetween(today, dateStr);
  if (diff === 0) return t('date.headingToday', { date: full });
  if (diff === 1) return t('date.headingTomorrow', { date: full });
  const day = dayName(d);
  return `${day[0].toUpperCase()}${day.slice(1)} · ${d.getUTCDate()} ${monthShort(d)}`;
}

/** Een `due` als korte tekst: "morgen 09:00", "↻ vrijdag". */
export function formatDue(due, today) {
  if (!due) return '';
  const time = due.date.length > 10 ? ` ${due.date.slice(11, 16)}` : '';
  return `${due.recurrence ? '↻ ' : ''}${formatDate(due.date, today)}${time}`;
}

/**
 * Een `due` als tekst voor een invoerveld, in een vorm die de datumherkenner weer kan lezen:
 * een herhaling zoals ze is getypt ("elke vrijdag"), anders "12-11-2026" of "12-11-2026 om 09:00".
 * (Niet de oorspronkelijke tekst: "morgen" van drie dagen geleden zou vandaag iets anders betekenen.)
 * In het Engels is het de ISO-vorm ("2026-11-12", "2026-11-12T09:00"): die leest de herkenner ook, zonder het woord "om".
 */
export function formatDateInput(due) {
  if (!due) return '';
  if (due.recurrence && due.string) return due.string;
  const [y, m, d] = due.date.slice(0, 10).split('-');
  return due.date.length > 10 ? t('date.inputDateTime', { d, m, y, time: due.date.slice(11, 16) }) : t('date.inputDate', { d, m, y });
}

/**
 * @returns {'none' | 'overdue' | 'today' | 'future'}
 *   Een taak met tijdstip is pas te laat als dat tijdstip voorbij is; zonder tijdstip pas de dag erna.
 */
export function dueStatus(due, today, now = null) {
  if (!due) return 'none';
  const day = due.date.slice(0, 10);
  if (day < today) return 'overdue';
  if (day > today) return 'future';
  if (now && due.date.length > 10 && due.date.slice(0, 16) < now) return 'overdue';
  return 'today';
}

/** Een tijdstip als "2026-12-01T09:00" in lokale tijd: de waarde die een invoerveld van het type datetime-local verwacht. */
export function formatDateTimeLocal(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}
