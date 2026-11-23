// Hoe lang een melding onderin de app blijft staan (Instellingen › Algemeen, `toast_seconds` in shared/general.js).
//
// - Een gewone melding: zo lang als je kiest (standaard 6 seconden), of tot je hem wegklikt (0).
// - Een melding die bewust langer duurt (een fout, Ongedaan maken na een bulkactie): nooit korter dan bedoeld, wel langer als je dat kiest.
// - Een korte statusmelding (korter dan de standaard, zoals "Luisteren…"): blijft kort, ook als je "tot je hem wegklikt" kiest.
// - Een melding die altijd moet blijven staan (timeout 0): blijft staan.

export const DEFAULT_TOAST_MS = 6000;

/**
 * @param {number | null | undefined} requested de duur die de melding zelf vraagt (ms), null/undefined = de standaard
 * @param {number} seconds de keuze van de gebruiker (0 = tot je hem wegklikt)
 * @returns {number} ms; 0 = blijft staan
 */
export function toastMs(requested, seconds) {
  if (requested === 0) return 0;
  const asked = requested ?? null;
  if (asked !== null && asked < DEFAULT_TOAST_MS) return asked;
  if (seconds === 0) return 0;
  const chosen = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TOAST_MS;
  return Math.max(asked ?? 0, chosen);
}
