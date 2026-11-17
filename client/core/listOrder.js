// Een eigen volgorde voor filters en labels: slepen in de zijbalk of op de beheerpagina's, of Alt + pijl omhoog/omlaag
// (ui/dragdrop.js). Hier staat zonder scherm wat dat betekent; de interface zoekt alleen uit boven welke regel de aanwijzer staat.
//
// De volgorde is die van de zijbalk: eerst de favorieten, daarna de rest, elk op volgordesleutel. Een favoriet blijft dus bij de
// favorieten en de rest bij de rest; wie een gewoon filter boven een favoriet loslaat, zet het bovenaan de rest. Labels van anderen
// (die je ziet omdat ze op een taak in een gedeeld project staan) verplaats je niet.
//
// Een plan is `{ beforeId }`: vóór dat filter of label in dezelfde groep (null = achteraan in de groep). `null` als plan betekent
// dat loslaten niets verandert.

import { placeKey } from './dnd.js';
import { filterList, labelList } from './selectors.js';

/** De soorten met een eigen volgorde, en het commando om de sleutel te wijzigen. */
export const ORDER_KINDS = Object.freeze({ filter: 'filter_update', label: 'label_update' });

const isFavorite = (x) => Boolean(x.is_favorite);

/** De filters of je eigen labels in de volgorde van de zijbalk: eerst de favorieten, daarna de rest, elk op volgorde. */
export function orderedItems(view, kind, userId) {
  const list = kind === 'filter' ? filterList(view, userId) : kind === 'label' ? labelList(view, userId).own.map((x) => x.label) : [];
  return [...list.filter(isFavorite), ...list.filter((x) => !isFavorite(x))];
}

/** De groep (favorieten of de rest) waar dit item in staat, op volgorde; met of zonder het item zelf. */
function groupOf(items, item, { without = false } = {}) {
  return items.filter((x) => isFavorite(x) === isFavorite(item) && !(without && x.id === item.id));
}

/** De plek van nu, als plan. */
export function currentListPlan(view, kind, id, userId) {
  const items = orderedItems(view, kind, userId);
  const item = items.find((x) => x.id === id);
  if (!item) return null;
  const group = groupOf(items, item);
  return { beforeId: group[group.indexOf(item) + 1]?.id ?? null };
}

/** Plek 1, 2, ... in de hele lijst zoals de zijbalk hem toont, als het item volgens dit plan staat. */
function positionAfter(items, item, plan) {
  const group = groupOf(items, item, { without: true });
  const found = plan.beforeId ? group.findIndex((x) => x.id === plan.beforeId) : -1;
  const at = found < 0 ? group.length : found;
  const favoritesBefore = isFavorite(item) ? 0 : items.filter(isFavorite).length;
  return { position: favoritesBefore + at + 1, count: items.length };
}

/**
 * Loslaten boven (`zone` 'before') of onder ('after') het item `overId`. Geeft `{ beforeId }`, of null als er niets verandert of het
 * niet kan (een ander soort, een label van iemand anders).
 */
export function planListDrop(view, { kind, dragId, overId, zone, userId = null }) {
  const items = orderedItems(view, kind, userId);
  const drag = items.find((x) => x.id === dragId);
  const over = items.find((x) => x.id === overId);
  if (!drag || !over || dragId === overId) return null;
  const others = groupOf(items, drag, { without: true });
  let beforeId;
  if (isFavorite(over) !== isFavorite(drag)) {
    // boven de andere groep: een favoriet komt achteraan bij de favorieten, een gewoon item vooraan bij de rest
    beforeId = isFavorite(drag) ? null : others[0]?.id ?? null;
  } else {
    const i = others.findIndex((x) => x.id === overId);
    beforeId = zone === 'before' ? overId : others[i + 1]?.id ?? null;
  }
  if (beforeId === currentListPlan(view, kind, dragId, userId).beforeId) return null;
  return { beforeId };
}

/**
 * Met het toetsenbord een plek omhoog of omlaag. Geeft `{ plan, position, count }` of `{ blocked }`: 'first', 'last',
 * 'favorites' (een favoriet kan niet onder de rest, een gewoon item niet boven de favorieten), 'gone' of 'unknown'.
 */
export function planListKey(view, kind, id, command, { userId = null } = {}) {
  const items = orderedItems(view, kind, userId);
  const item = items.find((x) => x.id === id);
  if (!item) return { blocked: 'gone' };
  const group = groupOf(items, item);
  const i = group.indexOf(item);
  const otherGroup = items.length > group.length;
  let plan;
  if (command === 'up') {
    if (i === 0) return { blocked: otherGroup && !isFavorite(item) ? 'favorites' : 'first' };
    plan = { beforeId: group[i - 1].id };
  } else if (command === 'down') {
    if (i === group.length - 1) return { blocked: otherGroup && isFavorite(item) ? 'favorites' : 'last' };
    plan = { beforeId: group[i + 2]?.id ?? null };
  } else {
    return { blocked: 'unknown' };
  }
  return { plan, ...positionAfter(items, item, plan) };
}

/** Waar het item volgens het plan komt te staan (plek en totaal), voor de aankondiging na slepen. */
export function listPosition(view, kind, id, plan, userId = null) {
  const items = orderedItems(view, kind, userId);
  const item = items.find((x) => x.id === id);
  return item ? positionAfter(items, item, plan) : null;
}

/** De commando's: zo nodig nieuwe sleutels voor buren met dezelfde sleutel, en de nieuwe sleutel van het item zelf. */
export function listMoveCommands(view, kind, id, plan, userId = null) {
  const type = ORDER_KINDS[kind];
  const items = orderedItems(view, kind, userId);
  const item = items.find((x) => x.id === id);
  if (!type || !item) return [];
  const { order_key, rekeys } = placeKey(groupOf(items, item, { without: true }), plan.beforeId);
  return [...rekeys.map((r) => ({ type, args: { id: r.id, order_key: r.order_key } })), { type, args: { id, order_key } }];
}
