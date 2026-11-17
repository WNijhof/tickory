// Datums in gewone taal lezen, in de taal van de interface.
//   Nederlands: core/dateNl.js ("morgen om 9 uur", "elke maandag").
//   Engels:     core/dateEn.js ("tomorrow at 9am", "every monday"), en daarnaast ook het Nederlands: cijfers als "31-12" en
//               "31-12-2026" lezen alleen de Nederlandse regels, en wie Nederlands typt in de Engelse app wordt ook begrepen.
// De taal is die van de interface (getLanguage), tenzij je hem meegeeft.

import { getLanguage } from './i18n.js';
import { parseDateText as parseDateTextNl, parseDue as parseDueNl } from './dateNl.js';
import { parseDateEn, parseDueEn } from './dateEn.js';

const span = (r) => (r?.range ? r.range[1] - r.range[0] : 0);

/**
 * Zoekt een datum of herhaling in de titel van een taak. In het Engels wint van de twee herkenners het langste stuk:
 * in "elke maandag om 9:30" leest het Engels alleen "9:30", het Nederlands alles; bij gelijke lengte het Engels.
 * @returns {{ content: string, due: object | null, range: [number, number] | null } | null}
 */
export function parseDue(text, now = new Date(), language = getLanguage()) {
  if (language !== 'en') return parseDueNl(text, now);
  const english = parseDueEn(text, now);
  if (english && !english.due) return english; // een tilde: bewust geen datum
  const dutch = parseDueNl(text, now);
  if (!dutch?.due) return english ?? dutch;
  if (!english) return dutch;
  return span(dutch) > span(english) ? dutch : english;
}

/**
 * Leest een tekst die alleen een datum bevat, bijvoorbeeld uit het datumveld.
 * @returns {object | null} een `due`, of null
 */
export function parseDateText(text, now = new Date(), language = getLanguage()) {
  if (language === 'en') return parseDateEn(String(text ?? ''), now) ?? parseDateTextNl(text, now);
  return parseDateTextNl(text, now);
}
