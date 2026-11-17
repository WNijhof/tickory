// Slepen en Alt + pijl in Vandaag (ui/dragdrop.js): de nieuwe volgorde van een groep ("Te laat" of vandaag) en de nieuwe waarde van
// `settings.day_order` (shared/dayOrder.js). Zonder scherm, getest. Een groep is de lijst taak-id's zoals ze nu op het scherm staan.

import { MAX_DAY_ORDER } from '../../shared/dayOrder.js';

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Loslaten boven (`zone` 'before') of onder ('after') de taak `overId` in dezelfde groep. Geeft de nieuwe volgorde van de groep, of
 * null als er niets verandert of het niet kan (een taak uit een andere groep).
 * @param {string[]} ids
 * @returns {string[] | null}
 */
export function planDayOrderDrop(ids, { dragId, overId, zone }) {
  if (dragId === overId || !ids.includes(dragId) || !ids.includes(overId)) return null;
  const rest = ids.filter((id) => id !== dragId);
  const at = rest.indexOf(overId) + (zone === 'after' ? 1 : 0);
  const next = [...rest.slice(0, at), dragId, ...rest.slice(at)];
  return same(next, ids) ? null : next;
}

/**
 * Met het toetsenbord een plek omhoog of omlaag. Geeft `{ ids, position, count }` of `{ blocked }` ('first', 'last', 'gone', 'unknown').
 * @param {string[]} ids
 */
export function planDayOrderKey(ids, id, command) {
  const i = ids.indexOf(id);
  if (i < 0) return { blocked: 'gone' };
  let j;
  if (command === 'up') j = i - 1;
  else if (command === 'down') j = i + 1;
  else return { blocked: 'unknown' };
  if (j < 0) return { blocked: 'first' };
  if (j >= ids.length) return { blocked: 'last' };
  const next = [...ids];
  [next[i], next[j]] = [next[j], next[i]];
  return { ids: next, position: j + 1, count: ids.length };
}

/**
 * De nieuwe `day_order`: deze groep in de nieuwe volgorde, daarna wat er al stond voor de andere groep. Taken die er niet meer toe doen
 * (verwijderd, afgevinkt of zonder datum) vallen eruit, zodat de lijst klein blijft.
 * @param {{ tasks: Map<string, any> }} view
 * @param {unknown} stored de huidige `settings.day_order`
 * @param {string[]} groupIds
 * @returns {string[]}
 */
export function nextDayOrder(view, stored, groupIds) {
  const keep = (id) => {
    const task = view.tasks.get(id);
    return Boolean(task && !task.checked && task.due);
  };
  const group = [...new Set(groupIds)];
  const inGroup = new Set(group);
  const rest = (Array.isArray(stored) ? stored : []).filter((id) => typeof id === 'string' && !inGroup.has(id) && keep(id));
  return [...group, ...new Set(rest)].slice(0, MAX_DAY_ORDER);
}
