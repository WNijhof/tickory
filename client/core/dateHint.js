// Een hulpje bij datums in het Engels. De interface en de datumherkenning volgen dezelfde taal (core/dateInput.js); typt iemand
// in het Engels iets dat op een datum lijkt maar niet wordt herkend ("Dinner tonight"), dan staan er voorbeelden die wel werken.
// In het Nederlands is die uitleg er niet: het voorbeeld in het invoerveld zegt daar genoeg.

import { getLanguage, t } from './i18n.js';

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

/** Voorbeelden van datums die werken ("tomorrow at 9am", "every monday"); leeg als de interface Nederlands is. */
export function dateExamplesNote() {
  return getLanguage() === 'en' ? t('date.examples') : '';
}
