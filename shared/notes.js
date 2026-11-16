// Notities (SPEC 5k): de achtergronden en de persoonlijke voorkeuren voor de lijst. Gedeeld door server, reducer, demo en web-app.
//
// Een achtergrond is een kleur of een patroon (een patroon heeft zijn eigen tint); null is de gewone achtergrond van de app.
// De voorkeuren staan in `settings.note_prefs` (dus op al je apparaten gelijk): de indeling van de lijst, de sortering en of
// afgevinkte punten in een checklist vanzelf naar onderen gaan.

export const NOTE_COLORS = Object.freeze(['yellow', 'orange', 'brown', 'red', 'pink', 'purple', 'indigo', 'blue', 'teal', 'green']);
export const NOTE_PATTERNS = Object.freeze(['dots', 'grid', 'lines', 'waves', 'groceries', 'music', 'travel', 'code']);
export const NOTE_BACKGROUNDS = Object.freeze([...NOTE_COLORS, ...NOTE_PATTERNS]);

export const NOTE_LAYOUTS = Object.freeze(['masonry', 'grid', 'list']);
export const NOTE_SORTS = Object.freeze(['updated', 'created', 'title']);
export const NOTE_ORDERS = Object.freeze(['asc', 'desc']);

export const DEFAULT_NOTE_PREFS = Object.freeze({ layout: 'masonry', sort: 'updated', order: 'desc', checked_bottom: true });

/** Controle van `settings.note_prefs`: `{ layout?, sort?, order?, checked_bottom? }`. Geeft een melding of null. */
export function notePrefsCheck(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'moet een object zijn';
  for (const key of Object.keys(v)) if (!['layout', 'sort', 'order', 'checked_bottom'].includes(key)) return `onbekend veld "${key.slice(0, 30)}"`;
  if (v.layout !== undefined && !NOTE_LAYOUTS.includes(v.layout)) return `layout: kies uit ${NOTE_LAYOUTS.join(', ')}`;
  if (v.sort !== undefined && !NOTE_SORTS.includes(v.sort)) return `sort: kies uit ${NOTE_SORTS.join(', ')}`;
  if (v.order !== undefined && !NOTE_ORDERS.includes(v.order)) return `order: kies uit ${NOTE_ORDERS.join(', ')}`;
  if (v.checked_bottom !== undefined && typeof v.checked_bottom !== 'boolean') return 'checked_bottom moet true of false zijn';
  return null;
}

/** De voorkeuren uit de instellingen, aangevuld met de standaard (een onbekende waarde, van een nieuwere versie, telt niet). */
export function notePrefsOf(settings) {
  const v = settings?.note_prefs;
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return {
    layout: NOTE_LAYOUTS.includes(o.layout) ? o.layout : DEFAULT_NOTE_PREFS.layout,
    sort: NOTE_SORTS.includes(o.sort) ? o.sort : DEFAULT_NOTE_PREFS.sort,
    order: NOTE_ORDERS.includes(o.order) ? o.order : DEFAULT_NOTE_PREFS.order,
    checked_bottom: typeof o.checked_bottom === 'boolean' ? o.checked_bottom : DEFAULT_NOTE_PREFS.checked_bottom,
  };
}
