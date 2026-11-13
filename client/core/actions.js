// Handelingen van de gebruiker, vertaald naar commando's. Elk commando krijgt een eigen uuid (voor veilig
// herhalen) en nieuwe rijen krijgen hier al hun definitieve id en volgordesleutel, zodat alles offline werkt.

import { keyAfter, keyBetween } from '../../shared/orderKey.js';
import { maxKey, scopeOf } from './reducer.js';
import { deepNormalize, nameKey, normalizeText } from '../../shared/text.js';

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** Willekeurig id van 16 tekens (96 bits). */
export function newId() {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(16))) s += ID_ALPHABET[b % 64];
  return s;
}

const byOrder = (a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : 1);

/**
 * @param {import('./store.js').Store} store
 * @param {{ requestSync?: () => void, makeId?: () => string, makeUuid?: () => string }} [options]
 */
export function createActions(store, { requestSync = () => {}, makeId = newId, makeUuid = () => crypto.randomUUID() } = {}) {
  const send = async (commands) => {
    // Alle tekst in NFC (zie shared/text.js), zodat wat hier optimistisch wordt getoond exact gelijk is aan wat de server bewaart.
    await store.enqueue(commands.map((c) => ({ type: c.type, uuid: makeUuid(), args: deepNormalize(c.args) })));
    requestSync();
  };
  const endKey = (resource, entity, scope, exceptId = null) => keyAfter(maxKey(store.view[resource], scopeOf(entity, scope), exceptId));

  /** Volgordesleutel voor een plek vóór `beforeId` (of achteraan als die ontbreekt) binnen de doel-lijst. */
  const keyAt = (scope, beforeId, exceptId) => {
    if (!beforeId) return endKey('tasks', 'task', scope, exceptId);
    const pred = scopeOf('task', scope);
    const siblings = [...store.view.tasks.values()].filter((t) => t.id !== exceptId && pred(t)).sort(byOrder);
    const i = siblings.findIndex((t) => t.id === beforeId);
    if (i < 0) return endKey('tasks', 'task', scope, exceptId);
    return keyBetween(i > 0 ? siblings[i - 1].order_key : null, siblings[i].order_key);
  };

  /** Commando's om labels op naam te vinden of aan te maken. Geeft de id's terug in dezelfde volgorde. */
  const labelCommands = (names) => {
    const ids = [];
    const commands = [];
    let last = maxKey(store.view.labels, () => true);
    // Namen vergelijken via nameKey: hoofdletterongevoelig voor alle Unicode-letters ("Café" = "CAFÉ") en gelijk voor
    // de gewone en de ontleedde schrijfwijze van "é".
    const known = new Map([...store.view.labels.values()].map((l) => [nameKey(l.name), l.id]));
    for (const raw of names) {
      const name = normalizeText(raw).trim();
      if (!name) continue;
      let id = known.get(nameKey(name));
      if (!id) {
        id = makeId();
        last = keyAfter(last);
        commands.push({ type: 'label_add', args: { id, name, order_key: last } });
        known.set(nameKey(name), id);
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return { ids, commands };
  };

  return {
    // ---- taken ----
    async addTask({ content, project_id, section_id = null, parent_id = null, newLabels = [], labels = [], ...rest }) {
      const id = makeId();
      const parent = parent_id ? store.view.tasks.get(parent_id) : null;
      const scope = { project_id, section_id: parent ? parent.section_id ?? null : section_id, parent_id };
      const extra = labelCommands(newLabels);
      const args = { id, project_id, content: content.trim(), ...rest, order_key: endKey('tasks', 'task', scope) };
      if (parent_id) args.parent_id = parent_id;
      else if (section_id) args.section_id = section_id;
      const allLabels = [...new Set([...labels, ...extra.ids])];
      if (allLabels.length > 0) args.labels = allLabels;
      await send([...extra.commands, { type: 'task_add', args }]);
      return id;
    },
    updateTask: (id, changes) => send([{ type: 'task_update', args: { id, ...changes } }]),
    /** Zet de labels van een taak op basis van namen; onbekende namen worden als label aangemaakt. */
    async setTaskLabels(id, names) {
      const { ids, commands } = labelCommands(names);
      await send([...commands, { type: 'task_update', args: { id, labels: ids } }]);
    },
    /** Verplaatst een taak (met subtaken) naar een project, sectie of bovenliggende taak; optioneel vóór een andere taak. */
    moveTask(id, { project_id, section_id = null, parent_id = null, beforeId = null }) {
      const parent = parent_id ? store.view.tasks.get(parent_id) : null;
      const scope = { project_id, section_id: parent ? parent.section_id ?? null : section_id, parent_id };
      const args = { id, project_id, parent_id, order_key: keyAt(scope, beforeId, id) };
      if (!parent_id) args.section_id = section_id;
      return send([{ type: 'task_move', args }]);
    },
    completeTask: (id) => send([{ type: 'task_complete', args: { id } }]),
    uncompleteTask: (id) => send([{ type: 'task_uncomplete', args: { id } }]),
    deleteTask: (id) => send([{ type: 'task_delete', args: { id } }]),

    // ---- projecten en secties ----
    async addProject({ name, color, parent_id = null }) {
      const id = makeId();
      const args = { id, name: name.trim(), order_key: endKey('projects', 'project', { parent_id }) };
      if (color) args.color = color;
      if (parent_id) args.parent_id = parent_id;
      await send([{ type: 'project_add', args }]);
      return id;
    },
    updateProject: (id, changes) => send([{ type: 'project_update', args: { id, ...changes } }]),
    deleteProject: (id) => send([{ type: 'project_delete', args: { id } }]),
    async addSection(project_id, name) {
      const id = makeId();
      await send([{ type: 'section_add', args: { id, project_id, name: name.trim(), order_key: endKey('sections', 'section', { project_id }) } }]);
      return id;
    },
    updateSection: (id, changes) => send([{ type: 'section_update', args: { id, ...changes } }]),
    deleteSection: (id) => send([{ type: 'section_delete', args: { id } }]),

    // ---- labels ----
    async addLabel(name) {
      const { ids, commands } = labelCommands([name]);
      await send(commands);
      return ids[0];
    },
    updateLabel: (id, changes) => send([{ type: 'label_update', args: { id, ...changes } }]),
    deleteLabel: (id) => send([{ type: 'label_delete', args: { id } }]),
  };
}
