// Twee lijsten of notities naast elkaar (op een breed scherm, in de browser en de desktop-app): de regels, zonder scherm.
//
// De toestand is `{ main, side, active }`: de route van de linker kolom (het gewone scherm), die van de rechter kolom (of null: niet
// gesplitst) en welke kolom actief is ('main' of 'side'). De zijbalk werkt op de actieve kolom: een klik op een project zet dat
// project in de kolom waar je het laatst in klikte, zoals de tabbladgroepen van een code-editor. Alleen lijsten en notities kunnen
// rechts staan (SIDE_TYPES); de rest (zoeken, instellingen, Productiviteit, de handleiding …) gaat altijd links open.
//
// Een open notitie in een kolom is de route `{ type: 'note', id, from }`: `from` is de lijst van notities waar je vandaan kwam
// (de id van de route Notities: '', 'archive', 'trash' of 'label:<id>'), zodat terug daar weer uitkomt.

/** Wat er in de rechter kolom kan staan. */
export const SIDE_TYPES = ['today', 'upcoming', 'project', 'filter', 'label', 'notes', 'note'];

/** Zo breed moet het venster minstens zijn (CSS-pixels) voor twee kolommen naast elkaar; smaller is er één kolom. */
export const SPLIT_MIN_WIDTH = 1100;

const ID = /^[A-Za-z0-9_:-]{1,80}$/;

/** Kan deze route in de rechter kolom staan? */
export function canShowBeside(route) {
  if (!route || typeof route !== 'object' || !SIDE_TYPES.includes(route.type)) return false;
  if (route.type === 'today' || route.type === 'upcoming') return true;
  if (route.type === 'notes') return route.id === undefined || route.id === null || route.id === '' || ID.test(String(route.id));
  return typeof route.id === 'string' && ID.test(route.id);
}

/** Een open notitie als route, met de lijst waar je vandaan kwam. */
export function noteRoute(id, from = null) {
  const back = from?.type === 'notes' && typeof from.id === 'string' ? from.id : '';
  return { type: 'note', id, from: back };
}

/** Terug uit een open notitie: de lijst van notities waar je vandaan kwam. */
export function backFromNote(route) {
  const from = typeof route?.from === 'string' && route.from ? route.from : null;
  return from ? { type: 'notes', id: from } : { type: 'notes' };
}

/** Een bewaarde rechter kolom (localStorage) lezen; wat niet klopt, is geen rechter kolom. */
export function parseSide(text) {
  try {
    const r = JSON.parse(text ?? 'null');
    if (!canShowBeside(r)) return null;
    const out = { type: r.type };
    if (r.id !== undefined && r.id !== null) out.id = String(r.id);
    if (r.type === 'note') out.from = typeof r.from === 'string' && (r.from === '' || ID.test(r.from)) ? r.from : '';
    return out;
  } catch {
    return null;
  }
}

/** De route van de actieve kolom (die de zijbalk als "hier ben je" toont). */
export const activeRoute = (state) => (state.side && state.active === 'side' ? state.side : state.main);

/**
 * Ergens heen vanuit de zijbalk, een snelkoppeling of een link: naar de actieve kolom. Kan de route niet rechts staan, dan gaat hij
 * links open en wordt links actief.
 */
export function navigateIn(state, route) {
  if (state.side && state.active === 'side' && canShowBeside(route)) return { ...state, side: route };
  return { ...state, main: route, active: 'main' };
}

/**
 * Naast elkaar openen: `route` in de rechter kolom (zonder route: hetzelfde als links, of Vandaag als dat rechts niet kan). De
 * rechter kolom wordt actief, zodat de volgende klik in de zijbalk daar landt.
 */
export function openBeside(state, route = null) {
  const wanted = route ?? state.main;
  const side = canShowBeside(wanted) ? wanted : { type: 'today' };
  return { ...state, side, active: 'side' };
}

/** Een kolom sluiten: rechts sluiten laat links staan; links sluiten zet wat rechts stond links. */
export function closePane(state, pane = 'side') {
  if (!state.side) return state;
  if (pane === 'main') return { main: state.side, side: null, active: 'main' };
  return { ...state, side: null, active: 'main' };
}

/** De kolommen omwisselen. */
export function swapPanes(state) {
  if (!state.side || !canShowBeside(state.main)) return state;
  return { main: state.side, side: state.main, active: state.active === 'side' ? 'main' : 'side' };
}

/** Een kolom actief maken (een klik of de focus erin). */
export function activate(state, pane) {
  const next = pane === 'side' && state.side ? 'side' : 'main';
  return next === state.active ? state : { ...state, active: next };
}

/**
 * Wat er van de gegevens af nog klopt: een verwijderd project of filter, een label of notitie die weg is. Links wordt het Vandaag
 * (zoals altijd), rechts gaat de kolom dicht; een open notitie die weg is, wordt de lijst van notities.
 * @param {(route: object) => boolean} exists bestaat het project, filter, label of de notitie van deze route nog?
 */
export function settle(state, exists) {
  const fix = (route, fallback) => {
    if (!route) return route;
    if (route.type === 'note') return exists(route) ? route : backFromNote(route);
    if (['project', 'filter', 'label'].includes(route.type) && !exists(route)) return fallback;
    return route;
  };
  const main = fix(state.main, { type: 'today' });
  const side = fix(state.side, null);
  const out = { main, side, active: side ? state.active : 'main' };
  return out.main === state.main && out.side === state.side && out.active === state.active ? state : out;
}
