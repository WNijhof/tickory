// Weergave-opties per lijst (SPEC hoofdstuk 5h): hoe de taken van een project, Vandaag of Binnenkort gesorteerd en gegroepeerd worden.
// Ze staan per gebruiker in `settings.view_options` (één object, de sleutel is de lijst), dus op al je apparaten gelijk, en gelden
// alleen voor jou: een gedeeld project kan voor een ander anders gesorteerd zijn. Gedeeld door server, reducer, demo en web-app.
//
// De sleutel van een lijst: `project:<id>`, `today` of `upcoming`. Een lijst zonder keuze (of een onbekende waarde, bijvoorbeeld
// van een nieuwere client) valt terug op de standaard: eigen volgorde en de indeling van de lijst zelf (secties, "Te laat"/vandaag,
// dagen). Een oudere client kent de keuze niet en toont dus gewoon de standaard.

export const SORTS = Object.freeze(['manual', 'name', 'date', 'priority', 'deadline', 'added', 'assignee']);
export const GROUPS = Object.freeze(['default', 'date', 'priority', 'label', 'assignee', 'project', 'deadline']);
export const DIRECTIONS = Object.freeze(['asc', 'desc']);

/** Zoveel lijsten kunnen een eigen keuze hebben; meer dan je projecten is er niet nodig. */
export const MAX_VIEW_OPTIONS = 500;
const MAX_KEY = 100;

export const DEFAULT_OPTIONS = Object.freeze({ sort: 'manual', dir: 'asc', group: 'default' });

/** Sleutel van de lijst waar de keuze bij hoort. */
export const viewKey = (route) => (route.type === 'project' ? `project:${route.id}` : route.type);

const KEY_PATTERN = /^(today|upcoming|project:.+)$/;

/** Controle van `settings.view_options`: een object `{ [lijst]: { sort, dir, group } }`. Geeft een melding of null. */
export function viewOptionsCheck(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'moet een object zijn met een keuze per lijst';
  const keys = Object.keys(v);
  if (keys.length > MAX_VIEW_OPTIONS) return `hooguit ${MAX_VIEW_OPTIONS} lijsten met een eigen keuze`;
  for (const key of keys) {
    if (key.length > MAX_KEY || !KEY_PATTERN.test(key)) return `onbekende lijst "${key.slice(0, 40)}"`;
    const o = v[key];
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return `de keuze voor "${key.slice(0, 40)}" moet een object zijn`;
    for (const name of Object.keys(o)) if (!['sort', 'dir', 'group'].includes(name)) return `onbekend veld "${name.slice(0, 20)}" bij "${key.slice(0, 40)}"`;
    if (o.sort !== undefined && !SORTS.includes(o.sort)) return `sorteren: kies uit ${SORTS.join(', ')}`;
    if (o.dir !== undefined && !DIRECTIONS.includes(o.dir)) return `richting: kies uit ${DIRECTIONS.join(', ')}`;
    if (o.group !== undefined && !GROUPS.includes(o.group)) return `groeperen: kies uit ${GROUPS.join(', ')}`;
  }
  return null;
}

/** De keuze voor een lijst, aangevuld met de standaard waar iets ontbreekt of niet geldt. */
export function optionsFor(settings, key) {
  const o = settings?.view_options?.[key];
  if (!o || typeof o !== 'object') return { ...DEFAULT_OPTIONS };
  return {
    sort: SORTS.includes(o.sort) ? o.sort : DEFAULT_OPTIONS.sort,
    dir: DIRECTIONS.includes(o.dir) ? o.dir : DEFAULT_OPTIONS.dir,
    group: GROUPS.includes(o.group) ? o.group : DEFAULT_OPTIONS.group,
  };
}

/** Is dit de standaard (eigen volgorde, eigen indeling)? Dan werkt slepen binnen de lijst. */
export const isDefaultOptions = (o) => o.sort === 'manual' && o.group === 'default';

/**
 * Het nieuwe `view_options` na een wijziging voor één lijst. Een keuze die gelijk is aan de standaard verdwijnt (zo blijft het object
 * klein); is de lijst vol, dan blijft het ongewijzigd.
 * @returns {Record<string, object>}
 */
export function withOptions(current, key, change) {
  const next = { ...(current ?? {}) };
  const merged = { ...optionsFor({ view_options: next }, key), ...change };
  if (merged.sort === 'manual') merged.dir = 'asc'; // de richting hoort alleen bij een sortering
  const isDefault = merged.sort === DEFAULT_OPTIONS.sort && merged.dir === DEFAULT_OPTIONS.dir && merged.group === DEFAULT_OPTIONS.group;
  if (isDefault) delete next[key];
  else if (Object.keys(next).length < MAX_VIEW_OPTIONS || key in next) next[key] = merged;
  return next;
}

/** Welke indelingen een lijst heeft: Vandaag en Binnenkort kennen geen secties, een project geen "project". */
export function groupChoices(routeType) {
  if (routeType === 'project') return GROUPS.filter((g) => g !== 'project');
  if (routeType === 'upcoming') return GROUPS.filter((g) => g !== 'date');
  return [...GROUPS];
}
