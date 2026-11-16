// Notities lezen uit de lokale toestand: de lijst met zoeken, labels, archief en prullenbak, aantallen, een voorbeeldtekst en wat
// opgeruimd mag worden. Alleen lezen, geen wijzigingen (die staan in core/actions.js). Geen scherm.
//
// Een notitie is privé en van jou (SPEC 5k). Volgorde: vastgepinde notities eerst, dan de laatst gewijzigde. Zoeken werkt zoals het
// zoekveld voor taken: hoofdletters, accenten en spaties tellen niet mee, alle woorden moeten voorkomen in willekeurige volgorde,
// en een woord is ook een stuk van een woord; er wordt gezocht in de titel, de tekst (zonder opmaaktekens) en de labelnamen.

import { foldMap, foldText, foldWords, occurrences } from './fold.js';
import { plainText } from './markdown.js';

/** Zoveel dagen blijft een notitie in de prullenbak; daarna ruimt de app haar op (definitief verwijderen). */
export const NOTE_TRASH_DAYS = 30;
/** Zoveel tekens heeft een voorbeeldtekst in de lijst. */
export const SNIPPET_CHARS = 220;

export const NOTE_SCOPES = ['all', 'archive', 'trash'];

const byRecent = (a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.id < b.id ? -1 : 1);

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

/** Een notitie die niet meer bestaat of in de prullenbak ligt, hoort niet bij "Alle notities". */
const inScope = (n, scope) => {
  const trashed = Boolean(n.trashed_at);
  if (scope === 'trash') return trashed;
  if (trashed) return false;
  return scope === 'archive' ? Boolean(n.is_archived) : !n.is_archived;
};

/**
 * @param {{ notes: Map<string, object>, labels: Map<string, object> }} view
 * @param {{ scope?: 'all' | 'archive' | 'trash', labelId?: string | null, query?: string }} [options]
 * @returns {object[]} de notities, vastgepind eerst (niet in het archief of de prullenbak) en dan de laatst gewijzigde;
 *   bij een zoekterm eerst de notities waarvan de titel alle woorden bevat
 */
export function noteList(view, { scope = 'all', labelId = null, query = '' } = {}) {
  const words = foldWords(String(query ?? '').slice(0, 200));
  const out = [];
  for (const n of view.notes.values()) {
    if (!inScope(n, scope)) continue;
    if (labelId && !(n.labels ?? []).includes(labelId)) continue;
    if (words.length > 0) {
      const title = foldText(noteTitle(n));
      const labelNames = (n.labels ?? []).map((id) => view.labels.get(id)?.name ?? '').join(' ');
      const hay = foldText(`${n.title ?? ''} ${plainOf(n)} ${labelNames}`);
      if (!words.every((w) => hay.includes(w))) continue;
      out.push({ n, rank: words.every((w) => title.includes(w)) ? 0 : 1 });
    } else {
      out.push({ n, rank: 0 });
    }
  }
  out.sort((a, b) => a.rank - b.rank || (scope === 'all' ? Number(Boolean(b.n.is_pinned)) - Number(Boolean(a.n.is_pinned)) : 0) || byRecent(a.n, b.n));
  return out.map((x) => x.n);
}

/** Aantallen voor de zijbalk en de filters: alle, archief, prullenbak en per label (alleen notities die niet in de prullenbak liggen). */
export function noteCounts(view) {
  const out = { all: 0, archive: 0, trash: 0, perLabel: new Map() };
  for (const n of view.notes.values()) {
    if (n.trashed_at) { out.trash++; continue; }
    if (n.is_archived) out.archive++;
    else out.all++;
    for (const id of n.labels ?? []) out.perLabel.set(id, (out.perLabel.get(id) ?? 0) + 1);
  }
  return out;
}

/** Labels die op minstens één notitie staan (niet in de prullenbak), met hun aantal, op naam. */
export function noteLabels(view) {
  const counts = noteCounts(view).perLabel;
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
export function expiredNotes(view, nowMs = Date.now(), days = NOTE_TRASH_DAYS) {
  const limit = nowMs - days * 86_400_000;
  return [...view.notes.values()].filter((n) => n.trashed_at && Date.parse(n.trashed_at) < limit);
}

/** Het aantal dagen dat een notitie nog in de prullenbak ligt (hooguit `NOTE_TRASH_DAYS`, minstens 0). */
export function trashDaysLeft(note, nowMs = Date.now(), days = NOTE_TRASH_DAYS) {
  const end = Date.parse(note.trashed_at ?? '') + days * 86_400_000;
  return Number.isNaN(end) ? days : Math.max(0, Math.min(days, Math.ceil((end - nowMs) / 86_400_000)));
}
