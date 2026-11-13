// Tekst in een vaste Unicode-vorm, zodat Nederlands met accenten overal hetzelfde werkt.
//
// Probleem: "é" kan op twee manieren bestaan: als één teken (NFC) of als "e" plus een los accent (NFD, zoals toetsenborden
// op de Mac het soms opleveren). Voor het oog zijn ze gelijk, voor een computer niet: "Café" en "Café" zouden anders
// vergelijken. Daarom slaan server en client alle tekst op in NFC, en vergelijken ze namen via nameKey().
// Gedeeld door server en client.

/** Tekst in NFC-vorm. */
export const normalizeText = (s) => s.normalize('NFC');

/**
 * Sleutel om namen te vergelijken: NFC, zonder omringende of dubbele spaties en hoofdletterongevoelig voor álle
 * Unicode-letters (é/É, ï/Ï, ë/Ë, ij/IJ). SQLite's lower() doet alleen ASCII; daarom gebeurt het vergelijken in JavaScript.
 */
export const nameKey = (s) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Hoe diep een waarde mag nesten. De diepste echte waarde (due.recurrence.byweekday) zit op niveau 3. */
export const MAX_DEPTH = 16;

/**
 * NFC op alle tekst in een waarde (tekst, lijsten en objecten); getallen, booleans en null blijven zoals ze zijn.
 * Is de waarde dieper genest dan MAX_DEPTH, dan gooit dit een RangeError("te diep genest"): een verzoek van een megabyte
 * kan honderdduizenden niveaus bevatten en daarmee de stapel laten overlopen.
 */
export function deepNormalize(value, depth = 0) {
  if (typeof value === 'string') return value.normalize('NFC');
  if (value && typeof value === 'object') {
    if (depth >= MAX_DEPTH) throw new RangeError('te diep genest');
    if (Array.isArray(value)) return value.map((v) => deepNormalize(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepNormalize(v, depth + 1);
    return out;
  }
  return value;
}
