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
//   - next_week en weekend: welke weekdag (ISO 1-7) "Volgende week" en "Weekend" in de datumkiezer zijn (standaard maandag en zaterdag);
//   - swipe_right en swipe_left: wat vegen naar rechts of links met een taak doet (SWIPE_ACTIONS; standaard afvinken en een datum kiezen);
//   - completion_sound: een korte toon bij het afvinken; goal_celebrations: het halen van een doel vieren;
//   - morning_overview en evening_review: de tijd ("UU:MM") van het ochtendoverzicht en de avondreview in de Android-app, of null (uit);
//   - reset_subtasks: bij het afvinken van een terugkerende taak gaan de afgevinkte subtaken weer open (standaard uit);
//   - snooze_minutes: hoe lang een herinnering uitgesteld wordt als je op Uitstellen tikt (SNOOZE_MINUTES; standaard 10);
//   - vacations: vakantieperiodes ({ from, to }, to = null: loopt nog): een dag in een vakantie breekt je reeks niet.
// Ze gelden op al je apparaten. Een ontbrekend veld (of `general` = null) is de standaard.

export const START_PAGES = Object.freeze(['last', 'inbox', 'today', 'upcoming', 'notes']);
export const TIME_FORMATS = Object.freeze(['24h', '12h']);
export const SIDEBAR_ITEMS = Object.freeze(['upcoming', 'completed', 'notifications', 'notes', 'filters', 'labels']);
export const WEEK_STARTS = Object.freeze([1, 6, 7]);
export const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
/** Wat een veeg doet, zoals in Todoist: niets, de taak kiezen, afvinken, een datum kiezen, herinneringen, verwijderen. */
export const SWIPE_ACTIONS = Object.freeze(['none', 'select', 'complete', 'schedule', 'reminders', 'delete']);
/** De duur van uitstel van een herinnering, in minuten (de lijst van Todoist, met onze 10 minuten erbij). */
export const SNOOZE_MINUTES = Object.freeze([5, 10, 15, 30, 60, 360, 720, 1440]);
export const VACATIONS_MAX = 50;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Wat er op de balk onderaan kan staan (core/bottomNav.js), en hoeveel knoppen je kiest (Bladeren komt er altijd bij). */
export const BOTTOM_TAB_CHOICES = Object.freeze(['inbox', 'today', 'upcoming', 'notes', 'notifications', 'completed', 'filters', 'labels']);
/** Het aantal knoppen dat je kiest; een oudere keuze had er drie (BOTTOM_TAB_LEGACY_COUNT). */
export const BOTTOM_TAB_COUNT = 4;
export const BOTTOM_TAB_LEGACY_COUNT = 3;
export const DEFAULT_GENERAL = Object.freeze({
  start_page: 'last', time_format: '24h', date_recognition: true, sidebar_hidden: Object.freeze([]), week_start: 1,
  bottom_tabs: Object.freeze(['inbox', 'today', 'upcoming', 'notes']), productivity: true,
  next_week: 1, weekend: 6, swipe_right: 'complete', swipe_left: 'schedule', completion_sound: false, goal_celebrations: true,
  snooze_minutes: 10, vacations: Object.freeze([]), reset_subtasks: false,
  morning_overview: null, evening_review: null,
});

/** Controle van `general.vacations`: een lijst van { from, to } (datums; to = null voor een lopende vakantie, alleen de laatste), op volgorde. */
export function vacationsCheck(v) {
  if (!Array.isArray(v) || v.length > VACATIONS_MAX) return `vacations moet een lijst van hooguit ${VACATIONS_MAX} perioden zijn`;
  let previous = '';
  for (let i = 0; i < v.length; i++) {
    const p = v[i];
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some((k) => k !== 'from' && k !== 'to')) return 'een vakantie heeft alleen from en to';
    if (typeof p.from !== 'string' || !DATE_RE.test(p.from)) return 'from moet een datum JJJJ-MM-DD zijn';
    if (p.to !== null && (typeof p.to !== 'string' || !DATE_RE.test(p.to))) return 'to moet een datum of null zijn';
    if (p.to === null && i !== v.length - 1) return 'alleen de laatste vakantie mag nog lopen';
    if (p.to !== null && p.to < p.from) return 'een vakantie eindigt niet voor ze begint';
    if (p.from <= previous) return 'vakanties staan op volgorde en overlappen niet';
    previous = p.to ?? '9999-12-31';
  }
  return null;
}

/** Valt deze dag ('JJJJ-MM-DD') in een vakantie? */
export const inVacation = (vacations, day) => vacations.some((p) => day >= p.from && (p.to === null || day <= p.to));

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
  for (const key of ['next_week', 'weekend']) if (v[key] !== undefined && !WEEKDAYS.includes(v[key])) return `${key} moet een weekdag van 1 tot 7 zijn`;
  for (const key of ['swipe_right', 'swipe_left']) if (v[key] !== undefined && !SWIPE_ACTIONS.includes(v[key])) return `${key} moet een van ${SWIPE_ACTIONS.join(', ')} zijn`;
  for (const key of ['completion_sound', 'goal_celebrations', 'reset_subtasks']) if (v[key] !== undefined && typeof v[key] !== 'boolean') return `${key} moet true of false zijn`;
  if (v.snooze_minutes !== undefined && !SNOOZE_MINUTES.includes(v.snooze_minutes)) return `snooze_minutes moet een van ${SNOOZE_MINUTES.join(', ')} zijn`;
  for (const key of ['morning_overview', 'evening_review']) if (v[key] !== undefined && v[key] !== null && !(typeof v[key] === 'string' && TIME_RE.test(v[key]))) return `${key} moet een tijd UU:MM of null zijn`;
  if (v.vacations !== undefined) { const bad = vacationsCheck(v.vacations); if (bad) return bad; }
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
  if (!v || typeof v !== 'object' || generalCheck(v) !== null) return { ...DEFAULT_GENERAL, sidebar_hidden: [], bottom_tabs: [...DEFAULT_GENERAL.bottom_tabs], vacations: [] };
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
    next_week: v.next_week ?? DEFAULT_GENERAL.next_week,
    weekend: v.weekend ?? DEFAULT_GENERAL.weekend,
    swipe_right: v.swipe_right ?? DEFAULT_GENERAL.swipe_right,
    swipe_left: v.swipe_left ?? DEFAULT_GENERAL.swipe_left,
    completion_sound: v.completion_sound ?? DEFAULT_GENERAL.completion_sound,
    goal_celebrations: v.goal_celebrations ?? DEFAULT_GENERAL.goal_celebrations,
    snooze_minutes: v.snooze_minutes ?? DEFAULT_GENERAL.snooze_minutes,
    reset_subtasks: v.reset_subtasks ?? DEFAULT_GENERAL.reset_subtasks,
    morning_overview: v.morning_overview ?? DEFAULT_GENERAL.morning_overview,
    evening_review: v.evening_review ?? DEFAULT_GENERAL.evening_review,
    vacations: (v.vacations ?? []).map((p) => ({ ...p })),
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
