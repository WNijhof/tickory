// Algemene voorkeuren van een gebruiker (`settings.general`, SPEC 5m), zoals in Todoist onder Instellingen › Algemeen:
//   - start_page: wat de app opent ('last' = waar je was, of 'inbox', 'today', 'upcoming', 'notes');
//   - time_format: '24h' (14:05) of '12h' (2:05 p.m.);
//   - date_recognition: false = snel toevoegen herkent geen datums in gewone taal (een expliciete {deadline} en !herinnering wel);
//   - sidebar_hidden: onderdelen van de zijbalk die je niet wilt zien;
//   - bottom_tabs: de vier knoppen van de balk onderaan op een telefoon (Bladeren staat er altijd rechts naast); een oudere
//     bewaarde keuze van drie knoppen krijgt Notities erbij (zie generalOf);
//   - productivity: false = het productiviteitsoverzicht (de kop boven Voltooid en Vandaag, het scherm Productiviteit) staat uit;
//   - week_start: de eerste dag van de week in de kalender (ISO: 1 = maandag, 6 = zaterdag, 7 = zondag). Weekdoelen en
//     weeknummers blijven ISO-weken (maandag tot zondag), zoals op de server.
// Ze gelden op al je apparaten. Een ontbrekend veld (of `general` = null) is de standaard.

export const START_PAGES = Object.freeze(['last', 'inbox', 'today', 'upcoming', 'notes']);
export const TIME_FORMATS = Object.freeze(['24h', '12h']);
export const SIDEBAR_ITEMS = Object.freeze(['upcoming', 'completed', 'notifications', 'notes', 'filters', 'labels']);
export const WEEK_STARTS = Object.freeze([1, 6, 7]);
/** Wat er op de balk onderaan kan staan (core/bottomNav.js), en hoeveel knoppen je kiest (Bladeren komt er altijd bij). */
export const BOTTOM_TAB_CHOICES = Object.freeze(['inbox', 'today', 'upcoming', 'notes', 'notifications', 'completed', 'filters', 'labels']);
/** Het aantal knoppen dat je kiest; een oudere keuze had er drie (BOTTOM_TAB_LEGACY_COUNT). */
export const BOTTOM_TAB_COUNT = 4;
export const BOTTOM_TAB_LEGACY_COUNT = 3;
export const DEFAULT_GENERAL = Object.freeze({
  start_page: 'last', time_format: '24h', date_recognition: true, sidebar_hidden: Object.freeze([]), week_start: 1,
  bottom_tabs: Object.freeze(['inbox', 'today', 'upcoming', 'notes']), productivity: true,
});

/** Controle van `settings.general`: een object met alleen bekende velden en geldige waarden. Geeft een melding of null. */
export function generalCheck(v) {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return 'moet een object zijn';
  for (const key of Object.keys(v)) if (!Object.hasOwn(DEFAULT_GENERAL, key)) return `onbekend veld "${key}"`;
  if (v.start_page !== undefined && !START_PAGES.includes(v.start_page)) return `start_page moet een van ${START_PAGES.join(', ')} zijn`;
  if (v.time_format !== undefined && !TIME_FORMATS.includes(v.time_format)) return `time_format moet ${TIME_FORMATS.join(' of ')} zijn`;
  if (v.date_recognition !== undefined && typeof v.date_recognition !== 'boolean') return 'date_recognition moet true of false zijn';
  if (v.week_start !== undefined && !WEEK_STARTS.includes(v.week_start)) return `week_start moet ${WEEK_STARTS.join(', ')} zijn`;
  if (v.bottom_tabs !== undefined) {
    if (!Array.isArray(v.bottom_tabs) || ![BOTTOM_TAB_LEGACY_COUNT, BOTTOM_TAB_COUNT].includes(v.bottom_tabs.length)) return `bottom_tabs moet ${BOTTOM_TAB_COUNT} knoppen hebben`;
    if (v.bottom_tabs.some((x) => !BOTTOM_TAB_CHOICES.includes(x))) return `bottom_tabs mag alleen ${BOTTOM_TAB_CHOICES.join(', ')} bevatten`;
    if (new Set(v.bottom_tabs).size !== v.bottom_tabs.length) return 'bottom_tabs mag niets dubbel bevatten';
  }
  if (v.productivity !== undefined && typeof v.productivity !== 'boolean') return 'productivity moet true of false zijn';
  if (v.sidebar_hidden !== undefined) {
    if (!Array.isArray(v.sidebar_hidden) || v.sidebar_hidden.length > SIDEBAR_ITEMS.length) return 'sidebar_hidden moet een korte lijst zijn';
    if (v.sidebar_hidden.some((x) => !SIDEBAR_ITEMS.includes(x))) return `sidebar_hidden mag alleen ${SIDEBAR_ITEMS.join(', ')} bevatten`;
    if (new Set(v.sidebar_hidden).size !== v.sidebar_hidden.length) return 'sidebar_hidden mag niets dubbel bevatten';
  }
  return null;
}

/** De voorkeuren uit een instellingenrij, aangevuld met de standaard (ook bij een onbekende of kapotte waarde). */
export function generalOf(settings) {
  const v = settings?.general;
  if (!v || typeof v !== 'object' || generalCheck(v) !== null) return { ...DEFAULT_GENERAL, sidebar_hidden: [], bottom_tabs: [...DEFAULT_GENERAL.bottom_tabs] };
  // een bewaarde keuze van drie knoppen (van vóór de vierde): Notities komt erbij, tenzij die er al in staat
  const saved = v.bottom_tabs && v.bottom_tabs.length === BOTTOM_TAB_LEGACY_COUNT && !v.bottom_tabs.includes('notes') ? [...v.bottom_tabs, 'notes'] : v.bottom_tabs;
  return {
    start_page: v.start_page ?? DEFAULT_GENERAL.start_page,
    time_format: v.time_format ?? DEFAULT_GENERAL.time_format,
    date_recognition: v.date_recognition ?? DEFAULT_GENERAL.date_recognition,
    sidebar_hidden: [...(v.sidebar_hidden ?? [])],
    week_start: v.week_start ?? DEFAULT_GENERAL.week_start,
    bottom_tabs: [...(saved ?? DEFAULT_GENERAL.bottom_tabs)],
    productivity: v.productivity ?? DEFAULT_GENERAL.productivity,
  };
}

/**
 * Een vaste plek uit het adres: `#view=today` (of upcoming, inbox, notes), van een snelkoppeling onder het app-icoon op
 * Android of een bladwijzer. Geeft de naam (zoals bij START_PAGES) of null.
 */
export function viewFromHash(hash) {
  const m = /^#view=(inbox|today|upcoming|notes|productivity)$/.exec(hash ?? '');
  return m ? m[1] : null;
}

/** De route bij een startpagina, of null voor 'last' (dan waar je was). De Inbox is een project: `inboxId` is dat van jou. */
export function startRoute(page, inboxId = null) {
  switch (page) {
    case 'inbox': return inboxId ? { type: 'project', id: inboxId } : null;
    case 'today': return { type: 'today' };
    case 'upcoming': return { type: 'upcoming' };
    case 'notes': return { type: 'notes' };
    case 'productivity': return { type: 'productivity' }; // alleen via een link (#view=productivity, de widget Productiviteit), geen startpagina
    default: return null;
  }
}
