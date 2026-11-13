// Eerlijk zijn over de datumtaal. De interface kan Engels zijn, maar wat je intypt ("morgen om 9 uur", "elke maandag")
// wordt voorlopig alleen in het Nederlands herkend (core/dateNl.js). Deze module zegt wanneer de app dat moet melden.
// Komt er Engelse datumherkenning, dan kan dit bestand weg.

import { DEFAULT_LANGUAGE, getLanguage, t } from './i18n.js';

/** De taal die de datumherkenner begrijpt. */
const DATE_LANGUAGE = DEFAULT_LANGUAGE;

// Woorden waarmee iemand in het Engels een datum, tijd of herhaling aangeeft. Bewust alleen duidelijke gevallen
// ("may", "march", "sat" en "sun" zijn ook gewone woorden; die staan er niet bij). Een enkele onterechte hint is onschuldig.
const WORDS = [
  'today', 'tonight', 'tomorrow', 'yesterday', 'noon', 'midnight',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'daily', 'weekly', 'monthly', 'yearly', 'annually', 'weekdays', 'weekend',
].join('|');
const ENGLISH_DATE = new RegExp([
  `\\b(?:${WORDS})\\b`,
  '\\b(?:every|each|next|this)\\s+(?:other\\s+|\\d+\\s+)?(?:day|week|month|year|quarter|morning|afternoon|evening|night|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)s?\\b',
  '\\bin\\s+(?:a|an|\\d+)\\s+(?:minute|hour|day|week|month|year)s?\\b',
  '\\b\\d{1,2}(?::\\d{2})?\\s?(?:am|pm)\\b',
  '\\bat\\s+\\d{1,2}(?::\\d{2})?\\b',
].join('|'), 'i');

/** Lijkt deze tekst een Engelse datum, tijd of herhaling in gewone taal te bevatten ("tomorrow at 9", "every monday")? */
export function mentionsEnglishDate(text) {
  return ENGLISH_DATE.test(String(text ?? ''));
}

/** De uitleg dat datums in gewone taal alleen in het Nederlands worden herkend; leeg als de interface zelf Nederlands is. */
export function dateLanguageNote() {
  return getLanguage() === DATE_LANGUAGE ? '' : t('date.dutchOnly');
}
