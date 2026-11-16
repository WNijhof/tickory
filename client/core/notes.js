// Notities lezen uit de lokale toestand: de lijst met zoeken, labels, archief en prullenbak, aantallen, een voorbeeldtekst en wat
// opgeruimd mag worden. Alleen lezen, geen wijzigingen (die staan in core/actions.js). Geen scherm.
//
// Een notitie is privé en van jou (SPEC 5k). Volgorde: zoals gekozen in de voorkeuren (laatst bewerkt, aangemaakt of titel; een notitie
// zonder titel staat bij "titel" altijd achteraan); de vastgepinde staan apart (groepen Vastgepind en Overige, zoals in Anchor).
// Zoeken werkt zoals het zoekveld voor taken: hoofdletters, accenten en spaties tellen niet mee, alle woorden moeten voorkomen in
// willekeurige volgorde, en een woord is ook een stuk van een woord; er wordt gezocht in de titel, de tekst (zonder opmaaktekens) en
// de labelnamen. Bij "Alle notities" zoekt het ook in het archief (zoals Anchor), niet in de prullenbak.

import { foldMap, foldText, foldWords, occurrences } from './fold.js';
import { plainText } from './markdown.js';
import { getLocale, t } from './i18n.js';
import { addDays, formatDue, nowString, timeFormatOptions, todayString } from './format.js';
import { nextNoteReminder } from '../../shared/notes.js';

/**
 * De herinnering van een notitie om te tonen: de volgende keer (bij een herhaling), of de eenmalige die al voorbij is (`past`).
 * @returns {{ at: string, past: boolean, repeat: string | null, text: string } | null}
 */
export function noteReminderInfo(note, now = new Date(), userId = null) {
  if (!note?.remind_at || !isMyNote(note, userId)) return null; // de herinnering van een gedeelde notitie is van de eigenaar
  const next = nextNoteReminder(note.remind_at, note.remind_repeat ?? null, nowString(now));
  const at = next ?? note.remind_at;
  return { at, past: !next, repeat: note.remind_repeat ?? null, text: formatDue({ date: at }, todayString(now)) };
}

/** De snelle keuzes voor een herinnering: later vandaag (18:00, of over drie uur als het al laat is), morgen 9:00, maandag 9:00. */
export function reminderPresets(now = new Date()) {
  const today = todayString(now);
  const out = [];
  const hour = now.getHours();
  if (hour < 17) out.push({ id: 'later', at: `${today}T18:00` });
  else if (hour < 21) out.push({ id: 'later', at: `${today}T${String(hour + 3).padStart(2, '0')}:00` });
  out.push({ id: 'tomorrow', at: `${addDays(today, 1)}T09:00` });
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = zondag
  const monday = `${addDays(today, ((8 - weekday) % 7) || 7)}T09:00`;
  if (!out.some((p) => p.at === monday)) out.push({ id: 'nextWeek', at: monday }); // op zondag is dat al "morgen"
  return out;
}

/** Zoveel dagen blijft een notitie in de prullenbak; daarna ruimt de app haar op (definitief verwijderen). */
export const NOTE_TRASH_DAYS = 30;
/** Zoveel tekens heeft een voorbeeldtekst in de lijst. */
export const SNIPPET_CHARS = 220;

export const NOTE_SCOPES = ['all', 'archive', 'trash'];

const byRecent = (a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.id < b.id ? -1 : 1);

/** De vergelijking voor een sortering uit de voorkeuren (shared/notes.js). */
export function noteComparator(sort = 'updated', order = 'desc') {
  const sign = order === 'asc' ? 1 : -1;
  let col = null;
  return (a, b) => {
    let c = 0;
    if (sort === 'title') {
      const ta = (a.title ?? '').trim();
      const tb = (b.title ?? '').trim();
      if (!ta !== !tb) return ta ? -1 : 1; // zonder titel altijd achteraan
      col ??= new Intl.Collator(getLocale(), { sensitivity: 'base', numeric: true });
      c = col.compare(ta, tb) * (order === 'desc' ? -1 : 1);
    } else {
      const key = sort === 'created' ? 'created_at' : 'updated_at';
      c = (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * sign; // asc: oud eerst; desc: nieuw eerst
    }
    return c || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  };
}

// de tekst zonder opmaak per notitie bewaren zolang de rij dezelfde is (bij elke wijziging komt er een nieuwe rij)
const plainCache = new WeakMap();
function plainOf(note) {
  let p = plainCache.get(note);
  if (p === undefined) {
    p = plainText(note.content ?? '');
    plainCache.set(note, p);
  }
  return p;
}

/** De titel om te tonen: de eigen titel, anders de eerste regel van de tekst, anders `fallback`. */
export function noteTitle(note, fallback = '') {
  const own = (note.title ?? '').trim();
  if (own) return own;
  const line = plainText((note.content ?? '').split('\n').find((l) => l.trim()) ?? '');
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line || fallback;
}

/**
 * Is de notitie van deze gebruiker? Zonder gebruiker (oude aanroepen, tests): ja. Een notitie van een ander (met jou gedeeld) staat
 * bij "Alle notities", nooit in je archief of prullenbak; vastpinnen, archief en labels zijn van de eigenaar.
 */
export const isMyNote = (n, userId = null) => !userId || !n.owner_id || n.owner_id === userId;

/** Een notitie die niet meer bestaat of in de prullenbak ligt, hoort niet bij "Alle notities". */
const inScope = (n, scope, searching = false, mine = true) => {
  if (!mine) return scope === 'all' && !n.trashed_at; // gedeeld met jou: alleen bij alle notities, en niet als de eigenaar haar weggooide
  const trashed = Boolean(n.trashed_at);
  if (scope === 'trash') return trashed;
  if (trashed) return false;
  if (scope === 'archive') return Boolean(n.is_archived);
  return !n.is_archived || searching; // zoeken bij "Alle notities" vindt ook wat in het archief staat
};

/**
 * @param {{ notes: Map<string, object>, labels: Map<string, object> }} view
 * @param {{ scope?: 'all' | 'archive' | 'trash', labelId?: string | null, query?: string, sort?: string, order?: string }} [options]
 * @returns {object[]} de notities, vastgepind eerst (alleen bij "Alle notities") en dan in de gekozen volgorde (standaard: laatst
 *   bewerkt eerst); bij een zoekterm eerst de notities waarvan de titel alle woorden bevat
 */
export function noteList(view, { scope = 'all', labelId = null, query = '', sort = 'updated', order = 'desc', userId = null } = {}) {
  const words = foldWords(String(query ?? '').slice(0, 200));
  const compare = noteComparator(sort, order);
  const out = [];
  for (const n of view.notes.values()) {
    const mine = isMyNote(n, userId);
    if (!inScope(n, scope, words.length > 0, mine)) continue;
    if (labelId && (!mine || !(n.labels ?? []).includes(labelId))) continue;
    if (words.length > 0) {
      const title = foldText(noteTitle(n));
      const labelNames = mine ? (n.labels ?? []).map((id) => view.labels.get(id)?.name ?? '').join(' ') : '';
      const hay = foldText(`${n.title ?? ''} ${plainOf(n)} ${labelNames}`);
      if (!words.every((w) => hay.includes(w))) continue;
      out.push({ n, rank: words.every((w) => title.includes(w)) ? 0 : 1 });
    } else {
      out.push({ n, rank: 0 });
    }
  }
  const pinned = (n) => (scope === 'all' && n.is_pinned && isMyNote(n, userId) ? 1 : 0);
  out.sort((a, b) => a.rank - b.rank || pinned(b.n) - pinned(a.n) || compare(a.n, b.n));
  return out.map((x) => x.n);
}

/** Vastgepind en overige (bij "Alle notities"; in het archief en de prullenbak is alles "overige"). */
export function noteGroups(list, scope = 'all', userId = null) {
  if (scope !== 'all') return { pinned: [], others: list };
  const isPinned = (n) => n.is_pinned && !n.is_archived && isMyNote(n, userId);
  return { pinned: list.filter(isPinned), others: list.filter((n) => !isPinned(n)) };
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysAgo = (date, now) => Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

/** De datum op een kaart: "Vandaag", "Gisteren", "22 sep", of "22 sep 2025" in een ander jaar (zoals Anchor). */
export function cardDate(iso, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const ago = daysAgo(date, now);
  if (ago === 0) return t('note.today');
  if (ago === 1) return t('note.yesterday');
  const opts = date.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat(getLocale(), opts).format(date).replace(/\.$/, '');
}

/** "Bewerkt vandaag om 14:03", "Bewerkt gisteren om 09:15" of "Bewerkt 22 okt". */
export function editedText(iso, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = new Intl.DateTimeFormat(getLocale(), timeFormatOptions()).format(date);
  const ago = daysAgo(date, now);
  if (ago === 0) return t('note.editedToday', { time });
  if (ago === 1) return t('note.editedYesterday', { time });
  return t('note.editedOn', { date: cardDate(iso, now) });
}

/** Aantallen voor de zijbalk en de filters: alle, archief, prullenbak en per label (alleen notities die niet in de prullenbak liggen). */
export function noteCounts(view, userId = null) {
  const out = { all: 0, archive: 0, trash: 0, perLabel: new Map() };
  for (const n of view.notes.values()) {
    if (!isMyNote(n, userId)) { if (!n.trashed_at) out.all++; continue; }
    if (n.trashed_at) { out.trash++; continue; }
    if (n.is_archived) out.archive++;
    else out.all++;
    for (const id of n.labels ?? []) out.perLabel.set(id, (out.perLabel.get(id) ?? 0) + 1);
  }
  return out;
}

/** Labels die op minstens één notitie staan (niet in de prullenbak), met hun aantal, op naam. */
export function noteLabels(view, userId = null) {
  const counts = noteCounts(view, userId).perLabel;
  return [...counts].map(([id, count]) => ({ label: view.labels.get(id), count })).filter((x) => x.label)
    .sort((a, b) => a.label.name.localeCompare(b.label.name, undefined, { sensitivity: 'base' }));
}

/**
 * Een korte voorbeeldtekst van de inhoud (zonder opmaaktekens). Met zoekwoorden: een stuk rond de eerste treffer, met `marks`
 * (plekken in de tekst) om te markeren. Zonder: het begin.
 * @returns {{ text: string, marks: { start: number, length: number }[] }}
 */
export function noteSnippet(note, query = '', max = SNIPPET_CHARS) {
  const text = plainOf(note);
  const words = foldWords(String(query ?? '').slice(0, 200));
  const fm = foldMap(text);
  const hits = [];
  for (const w of words) for (const [a, b] of occurrences(fm.text, w)) hits.push([fm.starts[a], fm.ends[b - 1]]);
  hits.sort((x, y) => x[0] - y[0]);
  let from = 0;
  if (hits.length > 0 && hits[0][0] > max / 3) from = Math.max(0, hits[0][0] - Math.floor(max / 4));
  const cut = text.slice(from, from + max);
  const lead = from > 0 ? '…' : '';
  const trail = from + max < text.length ? '…' : '';
  const marks = hits.filter(([s, e]) => s >= from && e <= from + max).map(([s, e]) => ({ start: s - from + lead.length, length: e - s }));
  return { text: `${lead}${cut}${trail}`, marks };
}

/** Notities die langer dan `NOTE_TRASH_DAYS` dagen in de prullenbak liggen en dus opgeruimd mogen worden. */
export function expiredNotes(view, nowMs = Date.now(), days = NOTE_TRASH_DAYS, userId = null) {
  const limit = nowMs - days * 86_400_000;
  // alleen eigen notities: een notitie van een ander ruimt de eigenaar zelf op
  return [...view.notes.values()].filter((n) => isMyNote(n, userId) && n.trashed_at && Date.parse(n.trashed_at) < limit);
}

/** Het aantal dagen dat een notitie nog in de prullenbak ligt (hooguit `NOTE_TRASH_DAYS`, minstens 0). */
export function trashDaysLeft(note, nowMs = Date.now(), days = NOTE_TRASH_DAYS) {
  const end = Date.parse(note.trashed_at ?? '') + days * 86_400_000;
  return Number.isNaN(end) ? days : Math.max(0, Math.min(days, Math.ceil((end - nowMs) / 86_400_000)));
}
