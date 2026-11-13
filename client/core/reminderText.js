// Herinneringen als tekst, in de taal van de interface.

import { REMINDER_PRESETS, offsetParts } from '../../shared/reminders.js';
import { formatDue } from './format.js';
import { getLanguage, t } from './i18n.js';

/** "Op het tijdstip van de taak", "30 minuten vooraf", "1 uur vooraf", "2 dagen vooraf". */
export function offsetText(minutes) {
  const { unit, n } = offsetParts(minutes);
  if (unit === 'at') return t('reminder.atTime');
  if (unit === 'minutes') return t('reminder.minutesBefore', { count: n });
  if (unit === 'hours') return t('reminder.hoursBefore', { count: n });
  return t('reminder.daysBefore', { count: n });
}

/** De keuzes voor een herinnering vooraf, als { minutes, label }. */
export const presetOptions = () => REMINDER_PRESETS.map((minutes) => ({ minutes, label: offsetText(minutes) }));

/**
 * Eén herinnering als regel: wat het is en wanneer ze afgaat ("30 minuten vooraf · morgen 08:30").
 * `moment` is het zwevende tijdstip waarop ze afgaat, of null als ze nu niets doet (taak zonder tijd).
 */
export function reminderLine(reminder, moment, today) {
  const what = reminder.type === 'absolute' ? t('reminder.fixed') : offsetText(reminder.minute_offset);
  const when = moment ? formatDue({ date: moment }, today) : t('reminder.waiting');
  return t('reminder.line', { what, when });
}

/** De uitleg bij een taak zonder tijd. In het Engels met een notatie die de datumherkenner wel leest. */
export const needsTimeNote = () => (getLanguage() === 'en' ? t('reminder.needsTimeEn') : t('reminder.needsTime'));
