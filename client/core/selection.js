// De selectie van meerdere taken, zonder scherm: welke taken zijn gekozen, het ankerpunt voor een bereik (Shift-klik), en wat
// er van over blijft als taken verdwijnen. De interface (ui/selection.js) vertaalt klikken en toetsen naar deze handelingen en
// tekent de uitkomst; wat de gekozen taken krijgen als je een actie kiest, staat in core/bulk.js.

/** Het bereik van `from` tot en met `to` in de volgorde `order` (de zichtbare taken van boven naar beneden), ongeacht de richting. */
export function rangeBetween(order, from, to) {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (b < 0) return [];
  if (a < 0) return [order[b]];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Meer dan dit aantal taken tegelijk verplaatsen door te slepen doen we niet (alleen de gesleepte taak); zie ui/dragdrop.js. */
export const MAX_DRAG_GROUP = 100;

/**
 * @param {{ onChange?: () => void }} [options]
 */
export function createSelection({ onChange = () => {} } = {}) {
  /** @type {Set<string>} */
  let ids = new Set();
  let anchor = null;
  /** De knop "Selecteren": vakjes bij elke regel, ook als er (nog) niets gekozen is. */
  let mode = false;
  const changed = () => onChange();
  return {
    get size() { return ids.size; },
    /** Zijn de vakjes zichtbaar en hoort de actiebalk erbij? Met de knop "Selecteren", of zodra er iets gekozen is. */
    get active() { return mode || ids.size > 0; },
    get mode() { return mode; },
    get anchor() { return anchor; },
    has: (id) => ids.has(id),
    /** De gekozen taken, in de volgorde van `order` (de zichtbare volgorde) en daarna de rest. */
    list(order = []) {
      const first = order.filter((id) => ids.has(id));
      const seen = new Set(first);
      return [...first, ...[...ids].filter((id) => !seen.has(id))];
    },
    setMode(on) {
      if (mode === on) return;
      mode = on;
      changed();
    },
    toggle(id) {
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      anchor = id;
      changed();
      return ids.has(id);
    },
    add(id) {
      if (ids.has(id)) { anchor = id; return; }
      ids.add(id);
      anchor = id;
      changed();
    },
    /** Shift-klik: alles van het anker tot `id` erbij (het anker blijft staan). Zonder anker telt het als gewoon kiezen. */
    extendTo(order, id) {
      if (anchor === null || !order.includes(anchor)) { this.add(id); return; }
      for (const x of rangeBetween(order, anchor, id)) ids.add(x);
      changed();
    },
    selectAll(order) {
      ids = new Set(order);
      anchor = order.at(-1) ?? null;
      changed();
    },
    /** Alles loslaten en de selectiemodus verlaten. Geeft true als er iets te stoppen viel. */
    clear() {
      const was = ids.size > 0 || mode;
      ids = new Set();
      anchor = null;
      mode = false;
      if (was) changed();
      return was;
    },
    /** Alleen de keuze wissen; de modus (vakjes) blijft. */
    deselect() {
      if (ids.size === 0) return;
      ids = new Set();
      anchor = null;
      changed();
    },
    /** Laat alleen over wat nog bestaat (en in beeld is): `keep(id)`. Geeft het aantal dat verdween. */
    prune(keep) {
      let gone = 0;
      for (const id of [...ids]) if (!keep(id)) { ids.delete(id); gone += 1; }
      if (anchor !== null && !keep(anchor)) anchor = null;
      if (gone > 0) changed();
      return gone;
    },
  };
}
