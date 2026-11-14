// De stapel met te herstellen handelingen. Elke bewuste wijziging van de gebruiker (verplaatsen, datum, prioriteit, labels,
// bulkacties, verwijderen) legt hier de omgekeerde commando's neer (zie core/inverse.js, berekend uit de toestand vóór de
// handeling). "Ongedaan maken" (de knop in de melding, of Ctrl/Cmd+Z) haalt de laatste weg en voert hem uit.
//
// Kort bewust: een handvol stappen, en niet langer dan de server een verwijdering nog terug kan zetten (5 minuten, zie
// server/limits.ts). Alleen in het geheugen: na het herladen van de pagina is er niets meer om terug te draaien.

export const UNDO_MAX = 10;
export const UNDO_TTL_MS = 5 * 60_000;

/** @param {{ max?: number, ttlMs?: number, now?: () => number, onChange?: () => void }} [options] */
export function createUndo({ max = UNDO_MAX, ttlMs = UNDO_TTL_MS, now = () => Date.now(), onChange = () => {} } = {}) {
  /** @type {{ label: string, commands: object[], at: number }[]} */
  let stack = [];
  const prune = () => { stack = stack.filter((e) => now() - e.at <= ttlMs); };
  return {
    /** Legt een stap neer; geeft het item terug (voor de knop in de melding). */
    push(entry) {
      prune();
      const item = { label: entry.label, commands: entry.commands, at: now() };
      stack.push(item);
      if (stack.length > max) stack.shift();
      onChange();
      return item;
    },
    /** De laatste stap (nog niet weggehaald), of null. */
    peek() { prune(); return stack.at(-1) ?? null; },
    /** Haalt de laatste stap weg en geeft hem terug, of null als er niets (meer) is. */
    take() {
      prune();
      const item = stack.pop() ?? null;
      if (item) onChange();
      return item;
    },
    /** Haalt een bepaalde stap weg (de knop in een melding van eerder); false als hij er niet meer is. */
    takeItem(item) {
      prune();
      const i = stack.indexOf(item);
      if (i < 0) return false;
      stack.splice(i, 1);
      onChange();
      return true;
    },
    clear() { stack = []; onChange(); },
    get size() { prune(); return stack.length; },
  };
}
