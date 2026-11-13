// Voorkeuren voor de weergaven die alleen bij dit apparaat horen (Binnenkort als lijst of kalender, de kalender per maand of per week).
// Ze staan in localStorage, behalve in de demo op de website: die bewaart niets (app.js zet dan `viewPrefs.persist` uit), dus daar
// gelden ze alleen zolang de pagina openstaat.

const memory = new Map();

export const viewPrefs = { persist: true };

/** De bewaarde waarde, of null. */
export function readPref(key) {
  if (!viewPrefs.persist) return memory.get(key) ?? null;
  try {
    return globalThis.localStorage?.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null; // opslag geblokkeerd
  }
}

export function writePref(key, value) {
  memory.set(key, value);
  if (!viewPrefs.persist) return;
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch { /* de keuze geldt dan niet langer dan deze pagina */ }
}
