// Een taak dupliceren (zoals in Todoist): een kopie direct onder het origineel, met dezelfde naam, beschrijving, prioriteit,
// labels, datum, deadline, duur en toewijzing, en met de open subtaken (in dezelfde volgorde en boomvorm). Niet mee: opmerkingen,
// bijlagen, voltooide subtaken en eigen herinneringen (de automatische herinnering bij een tijd komt er wel, zoals bij een nieuwe taak).

import { keyBetween } from '../../shared/orderKey.js';

/** Zoveel taken (de taak met zijn open subtaken) kopieert één keer dupliceren hooguit. */
export const DUPLICATE_LIMIT = 300;

const COPIED = ['content', 'description', 'priority', 'labels', 'due', 'deadline', 'duration', 'assignee_id'];

const byOrder = (a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : 0);

/** De open subtaken van een taak, in boomvolgorde (ouder voor kind, broers op volgorde). */
function openDescendants(view, rootId) {
  const children = new Map();
  for (const task of view.tasks.values()) {
    if (!task.parent_id || task.checked) continue;
    const list = children.get(task.parent_id) ?? [];
    list.push(task);
    children.set(task.parent_id, list);
  }
  const out = [];
  const walk = (id) => {
    for (const child of (children.get(id) ?? []).sort(byOrder)) {
      out.push(child);
      walk(child.id);
    }
  };
  walk(rootId);
  return out;
}

/**
 * De commando's om een taak te dupliceren.
 * @param {{ tasks: Map<string, any> }} view
 * @param {string} taskId
 * @param {{ makeId: () => string }} options
 * @returns {{ ok: true, id: string, commands: object[], copies: { id: string, due: any }[] } | { ok: false, reason: 'missing' | 'too_many' }}
 */
export function planDuplicate(view, taskId, { makeId }) {
  const task = view.tasks.get(taskId);
  if (!task) return { ok: false, reason: 'missing' };
  const subtree = openDescendants(view, taskId);
  if (subtree.length + 1 > DUPLICATE_LIMIT) return { ok: false, reason: 'too_many' };

  // direct onder het origineel: tussen zijn sleutel en die van de volgende taak op hetzelfde niveau
  const sameLevel = (x) => x.id !== task.id && x.project_id === task.project_id && (x.parent_id ?? null) === (task.parent_id ?? null)
    && (task.parent_id ? true : (x.section_id ?? null) === (task.section_id ?? null));
  const next = [...view.tasks.values()].filter((x) => sameLevel(x) && x.order_key > task.order_key).sort(byOrder)[0] ?? null;

  const newIds = new Map([[task.id, makeId()]]);
  for (const child of subtree) newIds.set(child.id, makeId());
  const copyOf = (source, extra) => {
    const args = { id: newIds.get(source.id), project_id: source.project_id };
    for (const field of COPIED) {
      const value = source[field];
      if (value === null || value === undefined) continue;
      if (field === 'labels' && value.length === 0) continue;
      if (field === 'priority' && value === 4) continue;
      if (field === 'description' && value === '') continue;
      args[field] = structuredClone(value);
    }
    return { type: 'task_add', args: { ...args, ...extra } };
  };
  const top = copyOf(task, {
    ...(task.parent_id ? { parent_id: task.parent_id } : task.section_id ? { section_id: task.section_id } : {}),
    order_key: keyBetween(task.order_key ?? null, next?.order_key ?? null),
  });
  const commands = [top, ...subtree.map((child) => copyOf(child, { parent_id: newIds.get(child.parent_id), order_key: child.order_key }))];
  const copies = [task, ...subtree].map((source) => ({ id: newIds.get(source.id), due: source.due ?? null }));
  return { ok: true, id: newIds.get(task.id), commands, copies };
}

/** Het adres dat een taak opent (voor "Link kopiëren"): werkt voor iedereen die de taak ziet, na inloggen. */
export function taskLink(origin, taskId) {
  return `${origin}/#task=${encodeURIComponent(taskId)}`;
}
