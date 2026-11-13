// De taal van de interface. Alle zichtbare tekst loopt via t('sleutel', { invulveld: waarde }); de teksten zelf staan in
// client/i18n/nl.js en client/i18n/en.js. Nederlands is de hoofdtaal en de terugval.
//
// Regels voor wie tekst toevoegt:
//   - Roep t() aan op het moment dat je de tekst toont, nooit bij het laden van een module (geen `const X = t(...)`
//     bovenaan een bestand): na het wisselen van taal zou die tekst in de oude taal blijven staan.
//   - Geef de sleutel als letterlijke tekst mee, t('taak.naam'), niet als variabele: een test controleert daarmee dat
//     elke gebruikte sleutel bestaat, dat er geen ongebruikte sleutels zijn en dat de invulvelden kloppen.
//   - Een meervoud is een object { one, other } en kiest op het invulveld `count`.
//
// Dit gaat alleen over de interface. De datumtaal (wat je intypt: "morgen om 9 uur") is een ander onderwerp; zie dateNl.js.

import nl from '../i18n/nl.js';
import en from '../i18n/en.js';

/** De hoofdtaal: de standaard zonder browser (in tests) en de terugval voor een ontbrekende sleutel. */
export const DEFAULT_LANGUAGE = 'nl';

/**
 * De talen van de interface. `name` is de naam in de taal zelf (zo vindt iedereen de eigen taal terug) en `locale`
 * bepaalt hoe de browser een datum met tijd schrijft. Engels gebruikt de Britse vorm ("13 Nov 2026, 14:05"): dag voor
 * maand en een 24-uursklok, net als de rest van de app.
 */
export const LANGUAGES = [
  { code: 'nl', name: 'Nederlands', locale: 'nl-NL' },
  { code: 'en', name: 'English', locale: 'en-GB' },
];

/** Onder deze sleutel staat de gekozen taal in localStorage. */
export const LANGUAGE_KEY = 'tickory.lang';

const DICTIONARIES = { nl, en };
// Nederlands en Engels hebben elk twee vormen: enkelvoud voor precies 1, anders meervoud (ook bij 0).
const PLURAL = { nl: (n) => (n === 1 ? 'one' : 'other'), en: (n) => (n === 1 ? 'one' : 'other') };

const isSupported = (code) => typeof code === 'string' && Object.hasOwn(DICTIONARIES, code);
// Node kent sinds enige tijd ook een `navigator` (met de taal van het systeem); een document is er alleen in een browser.
const inBrowser = () => typeof document !== 'undefined';

/**
 * Kiest de taal: eerst de opgeslagen voorkeur, dan de talen van de browser (begint er één met "nl", dan Nederlands;
 * anders Engels), en zonder browser de hoofdtaal.
 * @param {{ stored?: string | null, browserLanguages?: readonly string[] | null }} [input]
 * @returns {'nl' | 'en'}
 */
export function detectLanguage({ stored = null, browserLanguages = null } = {}) {
  if (isSupported(stored)) return stored;
  const list = (browserLanguages ?? []).filter((l) => typeof l === 'string' && l.trim());
  if (list.length === 0) return DEFAULT_LANGUAGE;
  return list.some((l) => /^nl(?:[-_]|$)/i.test(l.trim())) ? 'nl' : 'en';
}

function readStored() {
  if (!inBrowser()) return null;
  try {
    return globalThis.localStorage?.getItem(LANGUAGE_KEY) ?? null;
  } catch {
    return null; // opslag geblokkeerd (privémodus, ingesloten pagina): dan beslist de browsertaal
  }
}

function readBrowserLanguages() {
  if (!inBrowser()) return null;
  const nav = globalThis.navigator;
  if (Array.isArray(nav?.languages) && nav.languages.length > 0) return nav.languages;
  return nav?.language ? [nav.language] : null;
}

let current = null;

/** De taal van de interface: 'nl' of 'en'. */
export function getLanguage() {
  current ??= detectLanguage({ stored: readStored(), browserLanguages: readBrowserLanguages() });
  return current;
}

/**
 * Zet de taal en bewaart de keuze op dit apparaat. Een onbekende taal verandert niets.
 * Teken het scherm daarna opnieuw; tekst die al in beeld staat verandert niet vanzelf.
 * @returns {'nl' | 'en'} de taal die nu geldt
 */
export function setLanguage(code) {
  if (!isSupported(code)) return getLanguage();
  current = code;
  if (inBrowser()) {
    try {
      globalThis.localStorage?.setItem(LANGUAGE_KEY, code);
    } catch { /* opslag geblokkeerd: de keuze geldt dan tot de pagina sluit */ }
  }
  return current;
}

/** De locale voor datum- en tijdweergave door de browser, passend bij de gekozen taal ('nl-NL' of 'en-GB'). */
export function getLocale() {
  return LANGUAGES.find((l) => l.code === getLanguage()).locale;
}

const usable = (value) => (typeof value === 'string' ? value !== '' : Boolean(value) && typeof value === 'object');

function lookup(key) {
  for (const code of [getLanguage(), DEFAULT_LANGUAGE]) {
    const dictionary = DICTIONARIES[code];
    const value = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
    if (usable(value)) return { value, code };
  }
  return null;
}

/**
 * De tekst bij een sleutel in de gekozen taal, met `{naam}` vervangen door `params.naam`.
 * Een meervoud ({ one, other }) kiest op `params.count`. Ontbreekt de sleutel in de gekozen taal, dan volgt de
 * Nederlandse tekst; ontbreekt hij ook daar, dan de sleutel zelf (nooit een lege tekst, nooit een fout).
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function t(key, params = {}) {
  const found = lookup(key);
  if (!found) return String(key);
  let text = found.value;
  if (typeof text !== 'string') {
    const form = PLURAL[found.code](Number(params.count));
    text = usable(text[form]) ? text[form] : text.other;
    if (typeof text !== 'string' || text === '') return String(key);
  }
  // Eén keer vervangen, van links naar rechts: een ingevulde waarde (bijvoorbeeld een taaknaam met accolades) wordt
  // zelf niet opnieuw als invulveld gelezen.
  return text.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) && params[name] !== undefined && params[name] !== null ? String(params[name]) : whole));
}
