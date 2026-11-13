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

/** NFC op alle tekst in een waarde (tekst, lijsten en objecten); getallen, booleans en null blijven zoals ze zijn. */
export function deepNormalize(value) {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(deepNormalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepNormalize(v);
    return out;
  }
  return value;
}
