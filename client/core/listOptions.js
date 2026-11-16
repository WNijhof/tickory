// Sorteren en groeperen van een lijst taken volgens de weergave-opties (shared/viewOptions.js). Geen scherm.
//
// - `comparator(options, ctx)` is de vergelijking voor de gekozen sortering; bij gelijk valt ze terug op de eigen volgorde.
//   Namen vergelijkt ze met de collator van de taal (hoofdletter- en accentvorm-ongevoelig, "taak 2" voor "taak 10").
//   Taken zonder waarde (geen datum, geen deadline, niemand toegewezen) staan altijd achteraan, ook bij aflopend.
// - `groupRows(rows, group, ctx)` verdeelt rijen `{ task, depth }` in groepen. Een taak met subtaken blijft samen met haar
//   subtaken: de groep volgt de taak van het hoogste niveau. Een taak met meerdere labels staat in de groep van haar eerste label.

import { byOrder } from './selectors.js';
import { formatDayHeading } from './format.js';
import { getLocale, t } from './i18n.js';
import { colorName } from './colors.js';

const day = (value) => (value ? String(value).slice(0, 10) : null);

/** Collator in de taal van de interface. */
export function collator() {
  try {
    return new Intl.Collator(getLocale(), { sensitivity: 'base', numeric: true });
  } catch {
    return new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  }
}

/** Naam van wie een taak moet doen, of null. */
function assigneeName(task, ctx) {
  if (!task.assignee_id) return null;
  if (task.assignee_id === ctx.me?.id) return ctx.me.name ?? ctx.userName?.(task.assignee_id) ?? '';
  return ctx.userName?.(task.assignee_id) ?? '';
}

/**
 * De vergelijkingsfunctie voor `{ sort, dir }`.
 * @param {{ sort: string, dir: string }} options
 * @param {{ me?: object | null, userName?: (id: string) => string | null }} ctx
 * @returns {(a: object, b: object) => number}
 */
export function comparator(options, ctx = {}) {
  const sign = options.dir === 'desc' ? -1 : 1;
  const col = collator();
  // `value` geeft null voor "geen waarde": die staat altijd achteraan
  const by = (value, compare) => (a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return byOrder(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * compare(x, y) || byOrder(a, b);
  };
  const text = (x, y) => col.compare(x, y);
  const plain = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  switch (options.sort) {
    case 'name': return by((tk) => tk.content ?? '', text);
    case 'date': return by((tk) => tk.due?.date ?? null, plain);
    case 'deadline': return by((tk) => tk.deadline ?? null, plain);
    case 'priority': return by((tk) => tk.priority ?? 4, plain);
    case 'added': return by((tk) => tk.created_at ?? '', plain);
    case 'assignee': return by((tk) => (tk.assignee_id ? assigneeName(tk, ctx) : null), text);
    default: return byOrder;
  }
}

/** Een groep: `key` is stabiel (voor inklappen en tests), `title` de kop, `rank` de plek (lager = eerder), `color` een projectkleur of labelkleur. */
function groupOf(task, group, ctx) {
  const { view, today } = ctx;
  switch (group) {
    case 'date':
    case 'deadline': {
      const d = day(group === 'date' ? task.due?.date : task.deadline);
      if (!d) return { key: 'none', title: group === 'date' ? t('listopt.noDate') : t('listopt.noDeadline'), rank: [2, ''] };
      if (group === 'date' && d < today) return { key: 'overdue', title: t('view.overdue'), rank: [0, ''] };
      return { key: d, title: formatDayHeading(d, today), rank: [1, d] };
    }
    case 'priority': {
      const p = Math.min(4, Math.max(1, task.priority ?? 4));
      return { key: `p${p}`, title: t('listopt.priority', { priority: p }), rank: [1, String(p)] };
    }
    case 'label': {
      const label = (task.labels ?? []).map((id) => view.labels.get(id)).find(Boolean);
      if (!label) return { key: 'none', title: t('listopt.noLabel'), rank: [2, ''] };
      return { key: label.id, title: label.name, rank: [1, label.name], color: colorName(label.color), byName: true };
    }
    case 'assignee': {
      if (!task.assignee_id) return { key: 'none', title: t('listopt.noAssignee'), rank: [2, ''] };
      const name = assigneeName(task, ctx) || t('common.someone');
      return { key: task.assignee_id, title: task.assignee_id === ctx.me?.id ? t('listopt.assigneeYou') : name, rank: [1, name], byName: true };
    }
    case 'project': {
      const p = view.projects.get(task.project_id);
      return { key: task.project_id, title: p?.name ?? t('view.projectTitle'), rank: [1, p?.name ?? ''], color: p ? colorName(p.color) : null, byName: true };
    }
    default:
      return { key: 'all', title: null, rank: [0, ''] };
  }
}

/**
 * Verdeelt rijen in groepen. Voor `group === 'default'` geeft ze `null` (de aanroeper houdt zijn eigen indeling).
 * @param {{ task: object, depth?: number }[]} rows rijen in boomvolgorde
 * @returns {{ key: string, title: string | null, color: string | null, rows: object[], tasks: number }[] | null}
 */
export function groupRows(rows, group, ctx) {
  if (!group || group === 'default') return null;
  const col = collator();
  const groups = new Map();
  let current = null;
  for (const row of rows) {
    if ((row.depth ?? 0) === 0 || current === null) {
      const g = groupOf(row.task, group, ctx);
      if (!groups.has(g.key)) groups.set(g.key, { ...g, color: g.color ?? null, rows: [], tasks: 0 });
      current = groups.get(g.key);
    }
    current.rows.push(row);
    current.tasks += 1;
  }
  const list = [...groups.values()];
  list.sort((a, b) => a.rank[0] - b.rank[0] || (a.byName ? col.compare(a.rank[1], b.rank[1]) : a.rank[1] < b.rank[1] ? -1 : a.rank[1] > b.rank[1] ? 1 : 0));
  return list.map(({ key, title, color, rows: r, tasks }) => ({ key, title, color, rows: r, tasks }));
}

/** Platte lijst taken sorteren (Vandaag, Binnenkort); bij de standaard (`manual`) blijft de volgorde zoals ze is. */
export function sortTasks(tasks, options, ctx = {}) {
  if (!options || options.sort === 'manual') return tasks;
  return [...tasks].sort(comparator(options, ctx));
}
