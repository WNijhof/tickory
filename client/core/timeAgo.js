// Hoe lang geleden iets gebeurde, in woorden: "zojuist", "5 minuten geleden", "2 uur geleden", "3 dagen geleden", en daarna de datum.

import { t } from './i18n.js';
import { formatDate, todayString } from './format.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * @param {string} iso een tijdstip als ISO-tekst (zoals de server `created_at` meldt)
 * @param {number} [now] de huidige tijd in milliseconden
 * @returns {string} leeg als het tijdstip niet te lezen is
 */
export function timeAgo(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = now - then;
  if (diff < MINUTE) return t('ago.justNow'); // ook als de klok van het andere apparaat iets voorloopt
  if (diff < HOUR) return t('ago.minutes', { count: Math.floor(diff / MINUTE) });
  if (diff < DAY) return t('ago.hours', { count: Math.floor(diff / HOUR) });
  if (diff < 7 * DAY) return t('ago.days', { count: Math.floor(diff / DAY) });
  return formatDate(todayString(new Date(then)), todayString(new Date(now)));
}

/** De dag van een tijdstip als korte datum ("12 nov"), in de tijdzone van dit apparaat. */
export function dayOf(iso, now = Date.now()) {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? '' : formatDate(todayString(new Date(then)), todayString(new Date(now)));
}
