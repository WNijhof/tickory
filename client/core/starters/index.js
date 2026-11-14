// De meegeleverde sjablonen: ingebouwd in de app, dus ook zonder verbinding en in de demo. Ze staan per taal in nl.js en en.js
// (gewone gegevens, geen vertaalsleutels: een sjabloon is lopende tekst die je daarna zelf aanpast). Ze zijn alleen te lezen en
// worden pas een eigen sjabloon of project als je ze gebruikt.

import { getLanguage } from '../i18n.js';
import en from './en.js';
import nl from './nl.js';

/** De talen waarin meegeleverde sjablonen bestaan. */
export const STARTER_LANGUAGES = { nl, en };

/** De meegeleverde sjablonen in de taal van de interface; `id` is gelijk in elke taal ("moving"), het sjabloon-id begint met "starter:". */
export function starterTemplates(language = getLanguage()) {
  const list = Object.hasOwn(STARTER_LANGUAGES, language) ? STARTER_LANGUAGES[language] : nl;
  return list.map((tpl) => ({ ...tpl, id: `starter:${tpl.id}` }));
}
