// Optimistische uitvoering van commando's op de lokale kopie, zodat de app direct (en offline) reageert.
// Dit spiegelt de regels van de server (server/sync.ts). De server blijft leidend: na elke sync wordt de
// bevestigde toestand overgenomen en worden alleen de nog niet bevestigde commando's opnieuw toegepast.
// Een test vergelijkt deze uitvoering commando voor commando met de echte server.
//
// Afspraak: `state` bevat per resource een Map (id -> rij) met alleen niet-verwijderde rijen. De Maps zijn een
// eigen kopie en mogen worden gewijzigd; rij-objecten worden altijd vervangen, nooit aangepast.

import { ENTITIES, ENTITY_LIST, INBOX_ID } from '../../shared/schema.js';
import { keyAfter } from '../../shared/orderKey.js';
import { nextOccurrence } from '../../shared/recurrence.js';

export const RESOURCES = ENTITY_LIST.map((e) => e.resource);

export function emptyState() {
  const s = {};
  for (const r of RESOURCES) s[r] = new Map();
  return s;
}

export function cloneState(state) {
  const s = {};
  for (const r of RESOURCES) s[r] = new Map(state[r]);
  return s;
}

const has = (o, k) => Object.hasOwn(o, k);
const copyDefault = (d) => (Array.isArray(d) ? [...d] : d);

/** Voorwaarde voor "dezelfde lijst" (broers/zussen), gelijk aan de server. */
export function scopeOf(entityName, v) {
  switch (entityName) {
    case 'project': return (r) => (r.parent_id ?? null) === (v.parent_id ?? null);
    case 'section': return (r) => r.project_id === v.project_id;
    case 'task':
      return (r) => r.project_id === v.project_id && (r.section_id ?? null) === (v.section_id ?? null) && (r.parent_id ?? null) === (v.parent_id ?? null);
    default: return () => true;
  }
}

/** Hoogste volgordesleutel in een lijst, of null als die leeg is. */
export function maxKey(rows, pred, exceptId = null) {
  let m = null;
  for (const r of rows.values()) {
    if (r.id !== exceptId && r.order_key && pred(r) && (m === null || r.order_key > m)) m = r.order_key;
  }
  return m;
}

/** Alle (klein)kinderen van de gegeven taken. */
export function descendantIds(state, rootIds) {
  const children = new Map();
  for (const t of state.tasks.values()) {
    if (!t.parent_id) continue;
    if (!children.has(t.parent_id)) children.set(t.parent_id, []);
    children.get(t.parent_id).push(t.id);
  }
  const seen = new Set(rootIds);
  const out = [];
  const todo = [...rootIds];
  while (todo.length > 0) {
    for (const kid of children.get(todo.pop()) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      out.push(kid);
      todo.push(kid);
    }
  }
  return out;
}

function patch(state, resource, id, changes, now) {
  const old = state[resource].get(id);
  if (old) state[resource].set(id, { ...old, ...changes, updated_at: now });
}

function removeWhere(state, resource, pred) {
  for (const r of [...state[resource].values()]) if (pred(r)) state[resource].delete(r.id);
}

function add(state, e, args, now) {
  const id = args.id;
  if (typeof id !== 'string' || state[e.resource].has(id)) return;
  const row = { id };
  for (const c of e.cols) row[c.name] = has(args, c.name) ? args[c.name] : c.default !== undefined ? copyDefault(c.default) : null;
  if (e.name === 'task' && row.parent_id) {
    const parent = state.tasks.get(row.parent_id);
    if (!parent) return;
    row.section_id = parent.section_id ?? null; // een subtaak volgt de sectie van de bovenliggende taak
  }
  if (e.cols.some((c) => c.orderKey) && !row.order_key) row.order_key = keyAfter(maxKey(state[e.resource], scopeOf(e.name, row)));
  row.is_deleted = false;
  row.created_at = now;
  row.updated_at = now;
  state[e.resource].set(id, row);
}

function update(state, e, args, now) {
  const changes = {};
  for (const c of e.cols) if (has(args, c.name) && !c.immutable && !c.serverManaged) changes[c.name] = args[c.name];
  patch(state, e.resource, args.id, changes, now);
}

function deleteTaskTree(state, rootIds) {
  if (rootIds.length === 0) return;
  const ids = new Set([...rootIds, ...descendantIds(state, rootIds)]);
  for (const id of ids) state.tasks.delete(id);
  removeWhere(state, 'comments', (c) => ids.has(c.task_id));
  removeWhere(state, 'reminders', (r) => ids.has(r.task_id));
}

function remove(state, e, args, now) {
  const id = args.id;
  if (!state[e.resource].has(id)) return;
  switch (e.name) {
    case 'project': {
      if (id === INBOX_ID) return;
      const projects = [id];
      for (let i = 0; i < projects.length; i++) {
        for (const p of state.projects.values()) if (p.parent_id === projects[i] && !projects.includes(p.id)) projects.push(p.id);
      }
      const gone = new Set(projects);
      deleteTaskTree(state, [...state.tasks.values()].filter((t) => gone.has(t.project_id)).map((t) => t.id));
      removeWhere(state, 'sections', (s) => gone.has(s.project_id));
      removeWhere(state, 'comments', (c) => gone.has(c.project_id));
      for (const p of projects) state.projects.delete(p);
      break;
    }
    case 'section':
      deleteTaskTree(state, [...state.tasks.values()].filter((t) => t.section_id === id).map((t) => t.id));
      state.sections.delete(id);
      break;
    case 'task':
      deleteTaskTree(state, [id]);
      break;
    case 'label':
      state.labels.delete(id);
      for (const t of [...state.tasks.values()]) {
        if (t.labels.includes(id)) patch(state, 'tasks', t.id, { labels: t.labels.filter((l) => l !== id) }, now);
      }
      break;
    default:
      state[e.resource].delete(id);
  }
}

function taskMove(state, args, now) {
  const row = state.tasks.get(args.id);
  if (!row) return;
  const projectChanges = has(args, 'project_id') && args.project_id !== row.project_id;
  const projectId = has(args, 'project_id') ? args.project_id : row.project_id;
  let parentId = (has(args, 'parent_id') ? args.parent_id : projectChanges ? null : row.parent_id) ?? null;
  let sectionId = (has(args, 'section_id') ? args.section_id : projectChanges ? null : row.section_id) ?? null;
  if (parentId !== null) {
    const parent = state.tasks.get(parentId);
    if (!parent) return;
    sectionId = parent.section_id ?? null;
  }
  const target = { project_id: projectId, section_id: sectionId, parent_id: parentId };
  const orderKey = has(args, 'order_key') ? args.order_key : keyAfter(maxKey(state.tasks, scopeOf('task', target)));
  patch(state, 'tasks', row.id, { ...target, order_key: orderKey }, now);
  for (const kid of descendantIds(state, [row.id])) patch(state, 'tasks', kid, { project_id: projectId, section_id: sectionId }, now);
}

function taskComplete(state, args, now) {
  const row = state.tasks.get(args.id);
  if (!row || row.checked) return;
  const count = (row.completed_count ?? 0) + 1;
  if (row.due?.recurrence) {
    // terugkerend: door naar de volgende datum, de taak blijft open
    patch(state, 'tasks', row.id, { due: { ...row.due, date: nextOccurrence(row.due.date, row.due.recurrence) }, completed_count: count }, now);
    return;
  }
  patch(state, 'tasks', row.id, { checked: true, completed_at: now, completed_count: count }, now);
  for (const kid of descendantIds(state, [row.id])) {
    if (!state.tasks.get(kid).checked) patch(state, 'tasks', kid, { checked: true, completed_at: now }, now);
  }
}

function taskUncomplete(state, args, now) {
  const row = state.tasks.get(args.id);
  if (!row || !row.checked) return;
  patch(state, 'tasks', row.id, { checked: false, completed_at: null }, now);
}

const GENERIC = /^([a-z]+)_(add|update|delete)$/;

/**
 * Past één commando toe op `state`. Onbekende of onuitvoerbare commando's doen niets:
 * de server meldt de fout bij de eerstvolgende sync.
 * @param {ReturnType<typeof emptyState>} state
 * @param {{ type: string, args?: Record<string, unknown> }} cmd
 * @param {string} now ISO-tijdstip waarop het commando is gemaakt
 */
export function applyCommand(state, cmd, now) {
  const args = cmd.args ?? {};
  switch (cmd.type) {
    case 'task_move': return taskMove(state, args, now);
    case 'task_complete': return taskComplete(state, args, now);
    case 'task_uncomplete': return taskUncomplete(state, args, now);
    default: {
      const m = GENERIC.exec(cmd.type);
      const e = m && has(ENTITIES, m[1]) ? ENTITIES[m[1]] : null;
      if (!e) return undefined;
      if (m[2] === 'add') return add(state, e, args, now);
      if (m[2] === 'update') return update(state, e, args, now);
      return remove(state, e, args, now);
    }
  }
}
