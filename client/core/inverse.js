// Ongedaan maken: bij een reeks commando's de omgekeerde reeks berekenen, uit de toestand vóór de handeling (dus niet door te
// gokken wat de server deed). `inverseCommands(view, commands)` loopt de commando's één voor één na op een kopie van de
// weergave, bepaalt per commando hoe het terug moet, en geeft de omgekeerde commando's in omgekeerde volgorde terug.
//
// Wat niet te herstellen is (een label of project verwijderen, delen, bijlagen), geeft `null`: dan is er geen "Ongedaan maken"
// en toont de app dat ook niet. Een verwijdering wordt hersteld met `task_restore` of `section_restore`; de rijen die weggingen
// reizen als `local.rows` mee, zodat de client ze meteen optimistisch terugzet (de server heeft ze zelf nog, zie server/restore.ts).

import { ENTITIES } from '../../shared/schema.js';
import { applyCommand, cloneState, descendantIds } from './reducer.js';

const GENERIC = /^([a-z]+)_(add|update|delete)$/;
const clone = (v) => (v === null || typeof v !== 'object' ? v : structuredClone(v));
/** Rijen die in deze resources door verwijderen verdwijnen, en dus mee moeten voor terugzetten. */
const RESTORABLE = ['tasks', 'comments', 'attachments', 'reminders', 'sections'];

/** De rijen die een commando uit `state` haalt (vergelijking voor en na). */
function removedRows(before, after) {
  const out = {};
  for (const r of RESTORABLE) {
    const gone = [];
    for (const row of before[r].values()) if (!after[r].has(row.id)) gone.push(clone(row));
    if (gone.length > 0) out[r] = gone;
  }
  return out;
}

/**
 * @param {ReturnType<typeof import('./reducer.js').emptyState>} view de toestand vóór de handeling (wordt niet gewijzigd)
 * @param {{ type: string, args?: Record<string, any> }[]} commands
 * @param {{ userId?: string | null, now?: string, makeId?: () => string, makeUuid?: () => string }} [options]
 * @returns {{ type: string, uuid?: string, args: Record<string, any>, local?: object }[] | null} de omgekeerde reeks, of null als iets niet terug kan
 */
export function inverseCommands(view, commands, { userId = null, now = new Date().toISOString(), makeId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20), makeUuid } = {}) {
  const state = cloneState(view);
  const parts = [];
  for (const cmd of commands) {
    const inv = inverseOne(state, cmd, { userId, now, makeId, makeUuid });
    if (inv === null) return null;
    parts.unshift(inv);
  }
  return parts.flat();
}

function inverseOne(state, cmd, { userId, now, makeId }) {
  const args = cmd.args ?? {};
  const apply = () => applyCommand(state, cmd, now, userId);
  switch (cmd.type) {
    case 'task_move': {
      const row = state.tasks.get(args.id);
      if (!row) { apply(); return []; }
      const ids = [row.id, ...descendantIds(state, [row.id])];
      const assignees = ids.map((id) => [id, state.tasks.get(id).assignee_id ?? null]);
      const prev = { project_id: row.project_id, parent_id: row.parent_id ?? null, section_id: row.section_id ?? null, order_key: row.order_key };
      apply();
      const back = { id: row.id, project_id: prev.project_id, parent_id: prev.parent_id, order_key: prev.order_key };
      if (!prev.parent_id) back.section_id = prev.section_id;
      const out = [{ type: 'task_move', args: back }];
      // wie bij een verhuizing naar een ander project niet meer toegewezen bleef, weer toewijzen
      for (const [id, was] of assignees) if (was && (state.tasks.get(id)?.assignee_id ?? null) !== was) out.push({ type: 'task_update', args: { id, assignee_id: was } });
      return out;
    }
    case 'task_complete': {
      const row = state.tasks.get(args.id);
      if (!row || row.checked) { apply(); return []; }
      const open = descendantIds(state, [row.id]).filter((id) => !state.tasks.get(id).checked);
      const due = row.due ? clone(row.due) : null;
      apply();
      const after = state.tasks.get(row.id);
      if (after && !after.checked) return [{ type: 'task_update', args: { id: row.id, due } }]; // terugkerend: de datum terug (de teller loopt door)
      return [{ type: 'task_uncomplete', args: { id: row.id } }, ...open.map((id) => ({ type: 'task_uncomplete', args: { id } }))];
    }
    case 'task_uncomplete': {
      const row = state.tasks.get(args.id);
      apply();
      return row && row.checked ? [{ type: 'task_complete', args: { id: row.id } }] : [];
    }
    case 'task_delete': case 'section_delete': {
      const resource = cmd.type === 'task_delete' ? 'tasks' : 'sections';
      if (!state[resource].has(args.id)) { apply(); return []; }
      const before = cloneState(state);
      apply();
      return [{ type: cmd.type === 'task_delete' ? 'task_restore' : 'section_restore', args: { id: args.id }, local: { rows: removedRows(before, state) } }];
    }
    case 'reminder_delete': {
      const row = state.reminders.get(args.id);
      apply();
      if (!row) return [];
      const a = { id: makeId(), task_id: row.task_id, type: row.type };
      if (row.type === 'location') { a.place_id = row.place_id; a.trigger = row.trigger; } else if (row.type === 'absolute') a.due = clone(row.due); else a.minute_offset = row.minute_offset;
      return [{ type: 'reminder_add', args: a }];
    }
    default: break;
  }
  const m = GENERIC.exec(cmd.type);
  const e = m && Object.hasOwn(ENTITIES, m[1]) ? ENTITIES[m[1]] : null;
  if (!e) return null;
  if (m[2] === 'add') {
    if (typeof args.id !== 'string' || e.name === 'attachment' || e.name === 'comment') { apply(); return typeof args.id === 'string' && e.name === 'comment' ? [{ type: 'comment_delete', args: { id: args.id } }] : null; }
    apply();
    return [{ type: `${e.name}_delete`, args: { id: args.id } }];
  }
  if (m[2] === 'update') {
    const row = state[e.resource].get(args.id);
    if (!row) { apply(); return []; }
    const back = { id: row.id };
    for (const c of e.cols) if (Object.hasOwn(args, c.name) && !c.immutable && !c.serverManaged) back[c.name] = clone(row[c.name] ?? null);
    apply();
    return Object.keys(back).length > 1 ? [{ type: cmd.type, args: back }] : [];
  }
  return null; // project, label, bijlage verwijderen e.d.: niet terug te zetten
}
