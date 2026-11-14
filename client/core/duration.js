// De duur van een taak ("45 min", "1,5 uur"): het veld `duration` (minuten) bestaat al in het datamodel. Hier staat het lezen van
// wat je typt (`=45m`, `=1u30`, `=1,5u`) en het tonen ervan.

import { t } from './i18n.js';

export const MAX_DURATION = 60 * 24 * 7; // gelijk aan de grens van het veld
/** De keuzes in het taakvenster, in minuten. */
export const DURATION_CHOICES = [15, 30, 45, 60, 90, 120, 180, 240];

const HOURS = '(?:u|uur|h|hr|hrs|hour|hours)';
const MINS = '(?:m|min|mins|minuut|minuten|minute|minutes)';
const WITH_HOURS = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*${HOURS}(?:\\s*(\\d{1,2})\\s*${MINS}?)?$`, 'iu');
const ONLY_MINS = new RegExp(`^(\\d{1,5})\\s*${MINS}?$`, 'iu');

/**
 * Leest een duur: "45", "45m", "45 min", "1u", "1,5 uur", "1u30", "1u 30 min", "1h30m". Een getal zonder eenheid zijn minuten.
 * @param {string} text
 * @returns {number | null} minuten (1 tot en met een week), anders null
 */
export function parseDuration(text) {
  const s = String(text ?? '').trim();
  let minutes = null;
  const h = WITH_HOURS.exec(s);
  if (h) {
    const hours = Number(h[1].replace(',', '.'));
    const extra = h[2] === undefined ? 0 : Number(h[2]);
    if (h[2] !== undefined && /[.,]/.test(h[1])) return null; // "1,5u30" is dubbelop
    if (extra > 59) return null;
    minutes = Math.round(hours * 60) + extra;
  } else {
    const m = ONLY_MINS.exec(s);
    if (m) minutes = Number(m[1]);
  }
  return minutes !== null && Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_DURATION ? minutes : null;
}

/** "45 min", "1 u", "1 u 30 min", "2 d" (in minuten, in de taal van de interface). */
export function formatDuration(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < 1) return '';
  if (n >= 60 * 24 && n % (60 * 24) === 0) return t('duration.days', { n: n / (60 * 24) });
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h === 0) return t('duration.min', { n: m });
  return m === 0 ? t('duration.hour', { n: h }) : t('duration.hourMin', { h, m });
}

/** Eindtijd ("HH:MM") van een taak die om `start` ("HH:MM") begint en `minutes` duurt; null als het over middernacht gaat of niet klopt. */
export function endTime(start, minutes) {
  const m = /^(\d{2}):(\d{2})$/.exec(start ?? '');
  if (!m || !Number.isInteger(minutes) || minutes < 1) return null;
  const total = Number(m[1]) * 60 + Number(m[2]) + minutes;
  if (total >= 24 * 60) return null;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
