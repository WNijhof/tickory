// De teksten bij de filtertaal in de taal van de interface: de foutmeldingen van filter.js (die zelf Nederlands zijn), de
// plek van een fout in de getypte tekst, en de voorbeelden en termen voor de hulp. De taal van het filter zelf is altijd
// Nederlands én Engels tegelijk; de interfacetaal bepaalt alleen welke vorm als eerste wordt getoond.

import { getLanguage, t } from './i18n.js';

/** Foutcode van filter.js naar de tekst in de taal van de interface. Elke code staat hier letterlijk, zodat de i18n-test ze ziet. */
const ERRORS = {
  empty_query: () => t('filter.err.emptyQuery'),
  empty_term: () => t('filter.err.emptyTerm'),
  empty_name: (p) => t('filter.err.emptyName', { prefix: p.prefix }),
  unknown_term: (p) => t('filter.err.unknownTerm', { term: p.term }),
  unclosed_paren: () => t('filter.err.unclosedParen'),
  unexpected_paren: () => t('filter.err.unexpectedParen'),
  unclosed_quote: () => t('filter.err.unclosedQuote'),
  expected_operator: () => t('filter.err.expectedOperator'),
  comma_in_parens: () => t('filter.err.commaInParens'),
  unknown_project: (p) => t('filter.err.unknownProject', { name: p.name }),
  unknown_section: (p) => t('filter.err.unknownSection', { name: p.name }),
  unknown_label: (p) => t('filter.err.unknownLabel', { name: p.name }),
  unknown_user: (p) => t('filter.err.unknownUser', { name: p.name }),
  no_user: (p) => t('filter.err.noUser', { term: p.term }),
  invalid_date: (p) => t('filter.err.invalidDate', { term: p.term }),
  bad_number: (p) => t('filter.err.badNumber', { term: p.term }),
  too_deep: () => t('filter.err.tooDeep'),
  too_long: (p) => t('filter.err.tooLong', { max: p.max }),
  internal: () => t('filter.err.internal'),
};

/** De codes waarvoor een vertaling bestaat (de test vergelijkt ze met die van filter.js). */
export const ERROR_CODES = Object.keys(ERRORS);

/** De melding bij een fout uit `compileFilter` of `evaluateFilter` ({ code, params, … }), in de taal van de interface. */
export function filterErrorText(error) {
  const make = ERRORS[error?.code] ?? ERRORS.internal;
  return make(error?.params ?? {});
}

/**
 * Splitst de getypte tekst rond de plek van een fout, om die te kunnen markeren: { before, bad, after }. Een plek buiten de
 * tekst (bijvoorbeeld een ontbrekende term aan het einde) geeft een lege `bad` achteraan.
 */
export function errorParts(query, error) {
  const text = String(query ?? '');
  const start = Math.min(Math.max(Number(error?.position) || 0, 0), text.length);
  const end = Math.min(start + Math.max(Number(error?.length) || 0, 0), text.length);
  return { before: text.slice(0, start), bad: text.slice(start, end), after: text.slice(end) };
}

// ---------- hulp: voorbeelden en termen ----------

/**
 * Voorbeelden, met de woorden van het Nederlands en van het Engels. `key` is de uitleg (i18n: filter.ex.<naam>).
 * Alle voorbeelden moeten kloppen; de test compileert ze tegen een voorbeeldlijst met project Werk/Work/Thuis/Home,
 * sectie Planning en de labels bellen/calls.
 */
export const FILTER_EXAMPLES = [
  { key: 'now', nl: 'vandaag | te laat', en: 'today | overdue', text: () => t('filter.ex.now') },
  { key: 'urgent', nl: 'p1 & !subtaak', en: 'p1 & !subtask', text: () => t('filter.ex.urgent') },
  { key: 'week', nl: '#Werk & deze week', en: '#Work & this week', text: () => t('filter.ex.week') },
  { key: 'calls', nl: '(vandaag | morgen) & @bellen', en: '(today | tomorrow) & @calls', text: () => t('filter.ex.calls') },
  { key: 'search', nl: 'zoek: tandarts & 7 dagen', en: 'search: dentist & 7 days', text: () => t('filter.ex.search') },
  { key: 'mine', nl: 'toegewezen aan mij & te laat', en: 'assigned to me & overdue', text: () => t('filter.ex.mine') },
  { key: 'plain', nl: 'geen datum & zonder label', en: 'no date & no labels', text: () => t('filter.ex.plain') },
  { key: 'lists', nl: 'Werk: #Werk & vandaag, Thuis: #Thuis & vandaag', en: 'Work: #Work & today, Home: #Home & today', text: () => t('filter.ex.lists') },
  { key: 'done', nl: 'afgevinkt & vorige week', en: 'completed & last week', text: () => t('filter.ex.done') },
];

/**
 * De termen van de filtertaal, in groepen. Elke term heeft een vorm in het Nederlands en in het Engels (beide werken
 * altijd) en een uitleg (i18n: filter.term.<naam>). De vormen zijn echte, werkende voorbeelden.
 */
export const FILTER_TERM_GROUPS = [
  { key: 'dates', title: () => t('filter.group.dates'), terms: [
    { key: 'today', nl: 'vandaag', en: 'today', text: () => t('filter.term.today') },
    { key: 'tomorrow', nl: 'morgen', en: 'tomorrow', text: () => t('filter.term.tomorrow') },
    { key: 'overdue', nl: 'te laat', en: 'overdue', text: () => t('filter.term.overdue') },
    { key: 'nodate', nl: 'geen datum', en: 'no date', text: () => t('filter.term.nodate') },
    { key: 'days', nl: '7 dagen', en: '7 days', text: () => t('filter.term.days') },
    { key: 'week', nl: 'deze week', en: 'this week', text: () => t('filter.term.week') },
    { key: 'day', nl: '31-12', en: 'dec 31', text: () => t('filter.term.day') },
    { key: 'before', nl: 'vóór: 1-12', en: 'before: 1 dec', text: () => t('filter.term.before') },
    { key: 'after', nl: 'na: 1-12', en: 'after: 1 dec', text: () => t('filter.term.after') },
    { key: 'time', nl: 'heeft tijd', en: 'has time', text: () => t('filter.term.time') },
    { key: 'recurring', nl: 'terugkerend', en: 'recurring', text: () => t('filter.term.recurring') },
    { key: 'deadline', nl: 'deadline', en: 'has deadline', text: () => t('filter.term.deadline') },
  ] },
  { key: 'what', title: () => t('filter.group.what'), terms: [
    { key: 'priority', nl: 'p1', en: 'p1', text: () => t('filter.term.priority') },
    { key: 'project', nl: '#Werk', en: '#Work', text: () => t('filter.term.project') },
    { key: 'subprojects', nl: '##Werk', en: '##Work', text: () => t('filter.term.subprojects') },
    { key: 'section', nl: '/Planning', en: '/Planning', text: () => t('filter.term.section') },
    { key: 'label', nl: '@bellen', en: '@calls', text: () => t('filter.term.label') },
    { key: 'nolabel', nl: 'zonder label', en: 'no labels', text: () => t('filter.term.nolabel') },
    { key: 'subtask', nl: 'subtaak', en: 'subtask', text: () => t('filter.term.subtask') },
    { key: 'search', nl: 'zoek: café', en: 'search: café', text: () => t('filter.term.search') },
    { key: 'reminder', nl: 'heeft herinnering', en: 'has reminder', text: () => t('filter.term.reminder') },
  ] },
  { key: 'people', title: () => t('filter.group.people'), terms: [
    { key: 'me', nl: 'toegewezen aan mij', en: 'assigned to me', text: () => t('filter.term.me') },
    { key: 'others', nl: 'toegewezen aan anderen', en: 'assigned to others', text: () => t('filter.term.others') },
    { key: 'unassigned', nl: 'niet toegewezen', en: 'unassigned', text: () => t('filter.term.unassigned') },
  ] },
  { key: 'more', title: () => t('filter.group.more'), terms: [
    { key: 'completed', nl: 'afgevinkt', en: 'completed', text: () => t('filter.term.completed') },
    { key: 'all', nl: 'alles', en: 'all', text: () => t('filter.term.all') },
  ] },
];

/** De vorm van een term of voorbeeld in de taal van de interface, en (als die verschilt) de vorm in de andere taal. */
export function formsOf(item) {
  const own = getLanguage() === 'en' ? 'en' : 'nl';
  const other = own === 'en' ? 'nl' : 'en';
  return { main: item[own], other: item[other] === item[own] ? null : item[other] };
}
