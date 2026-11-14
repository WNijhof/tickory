// Handelingen van de gebruiker, vertaald naar commando's. Elk commando krijgt een eigen uuid (voor veilig
// herhalen) en nieuwe rijen krijgen hier al hun definitieve id en volgordesleutel, zodat alles offline werkt.

import { keyAfter } from '../../shared/orderKey.js';
import { maxKey, scopeOf } from './reducer.js';
import { deepNormalize, nameKey, normalizeText } from '../../shared/text.js';
import { hasTime } from '../../shared/reminders.js';
import { PLACE_RADIUS_DEFAULT } from '../../shared/places.js';
import { settingsId } from '../../shared/schema.js';
import { ENTITIES, validateValue } from '../../shared/schema.js';
import { todayString } from './format.js';
import { projectDescendantIds } from './selectors.js';
import { projectMoveCommands, taskMoveCommands } from './dnd.js';

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** Willekeurig id van 16 tekens (96 bits). */
export function newId() {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(16))) s += ID_ALPHABET[b % 64];
  return s;
}

const isOwnLabel = (label, me) => !label.owner_id || !me || label.owner_id === me;
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

  /** Commando's om labels op naam te vinden of aan te maken. Geeft de id's terug in dezelfde volgorde. */
  const labelCommands = (names) => {
    const ids = [];
    const commands = [];
    let last = maxKey(store.view.labels, (l) => isOwnLabel(l, store.userId));
    // Namen vergelijken via nameKey: hoofdletterongevoelig voor alle Unicode-letters ("Café" = "CAFÉ") en gelijk voor
    // de gewone en de ontleedde schrijfwijze van "é".
    // Een eigen label gaat voor; bestaat alleen het label van iemand anders (op een gedeelde taak), dan gebruiken we dat.
    const known = new Map();
    const me = store.userId;
    for (const l of [...store.view.labels.values()].sort((a, b) => Number(isOwnLabel(a, me)) - Number(isOwnLabel(b, me)))) known.set(nameKey(l.name), l.id);
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

  // ---- herinneringen ----
  /** De instelling "automatische herinnering": zoveel minuten vóór een taak met een tijd; -1 = geen. */
  const autoReminder = () => store.view.settings.get(settingsId(store.userId))?.auto_reminder ?? 30;
  const isMine = (row) => !row.owner_id || !store.userId || row.owner_id === store.userId;
  const myReminders = (taskId) => [...store.view.reminders.values()].filter((r) => r.task_id === taskId && isMine(r));
  const sameReminder = (r, spec) => r.type === spec.type
    && (spec.type === 'location' ? r.place_id === spec.place_id && r.trigger === spec.trigger
      : spec.type === 'absolute' ? r.due?.date === spec.due.date : r.minute_offset === spec.minute_offset);
  const reminderCommand = (taskId, spec) => ({
    type: 'reminder_add',
    args: spec.type === 'location'
      ? { id: makeId(), task_id: taskId, type: 'location', place_id: spec.place_id, trigger: spec.trigger }
      : spec.type === 'absolute'
        ? { id: makeId(), task_id: taskId, type: 'absolute', due: { date: spec.due.date } }
        : { id: makeId(), task_id: taskId, type: 'relative', minute_offset: spec.minute_offset },
  });
  /** Bij een nieuwe taak: de herinneringen die zijn opgegeven, en anders de automatische als de taak een tijd heeft. */
  const remindersForNewTask = (taskId, due, given) => {
    if (given && given.length > 0) return given.map((spec) => reminderCommand(taskId, spec));
    const auto = autoReminder();
    return hasTime(due?.date) && auto >= 0 ? [reminderCommand(taskId, { type: 'relative', minute_offset: auto })] : [];
  };

  return {
    // ---- taken ----
    async addTask({ content, project_id, section_id = null, parent_id = null, newLabels = [], labels = [], reminders = null, ...rest }) {
      const id = makeId();
      const parent = parent_id ? store.view.tasks.get(parent_id) : null;
      const scope = { project_id, section_id: parent ? parent.section_id ?? null : section_id, parent_id };
      const extra = labelCommands(newLabels);
      const args = { id, project_id, content: content.trim(), ...rest, order_key: endKey('tasks', 'task', scope) };
      if (parent_id) args.parent_id = parent_id;
      else if (section_id) args.section_id = section_id;
      const allLabels = [...new Set([...labels, ...extra.ids])];
      if (allLabels.length > 0) args.labels = allLabels;
      await send([...extra.commands, { type: 'task_add', args }, ...remindersForNewTask(id, args.due ?? null, reminders)]);
      return id;
    },
    /**
     * Wijzigt een taak. Verandert de datum, dan volgen de herinneringen zoals in Todoist: krijgt de taak een tijd en heb
     * je er nog geen herinnering bij, dan komt de automatische erbij; verdwijnt de tijd, dan vervallen je herinneringen
     * "vooraf" (een herinnering op een eigen datum en tijd blijft staan).
     */
    async updateTask(id, changes) {
      const commands = [{ type: 'task_update', args: { id, ...changes } }];
      if (Object.hasOwn(changes, 'due')) {
        const before = hasTime(store.view.tasks.get(id)?.due?.date);
        const after = hasTime(changes.due?.date);
        const mine = myReminders(id).filter((r) => r.type !== 'location'); // een herinnering op een plek telt niet als tijdherinnering
        const auto = autoReminder();
        if (!before && after && mine.length === 0 && auto >= 0) commands.push(reminderCommand(id, { type: 'relative', minute_offset: auto }));
        if (before && !after) for (const r of mine) if (r.type === 'relative') commands.push({ type: 'reminder_delete', args: { id: r.id } });
      }
      await send(commands);
    },
    /**
     * Voegt een herinnering toe: `{ type: 'relative', minute_offset }`, `{ type: 'absolute', due: { date } }` of
     * `{ type: 'location', place_id, trigger: 'enter' | 'leave' }`.
     * Bestaat precies dezelfde al, dan gebeurt er niets. Geeft het id terug.
     */
    async addReminder(taskId, spec) {
      const existing = myReminders(taskId).find((r) => sameReminder(r, spec));
      if (existing) return existing.id;
      const command = reminderCommand(taskId, spec);
      await send([command]);
      return command.args.id;
    },
    deleteReminder: (id) => send([{ type: 'reminder_delete', args: { id } }]),

    // ---- plaatsen (herinneringen op een locatie) ----
    /** Voegt een plaats toe (naam, lat, lon en straal in meters). Geeft het id terug. */
    async addPlace({ name, lat, lon, radius = PLACE_RADIUS_DEFAULT }) {
      const id = makeId();
      await send([{ type: 'place_add', args: { id, name: normalizeText(String(name ?? '')).trim(), lat, lon, radius } }]);
      return id;
    },
    updatePlace: (id, changes) => send([{ type: 'place_update', args: { id, ...(Object.hasOwn(changes, 'name') ? { ...changes, name: normalizeText(String(changes.name ?? '')).trim() } : changes) } }]),
    /** Verwijdert een plaats; de herinneringen op die plaats gaan mee. */
    deletePlace: (id) => send([{ type: 'place_delete', args: { id } }]),
    /** Wijzigt je persoonlijke instellingen, bijvoorbeeld `{ auto_reminder: 10 }` (-1 = geen automatische herinnering). */
    updateSettings: (changes) => send([{ type: 'settings_update', args: { id: settingsId(store.userId), ...changes } }]),
    /** Zet de labels van een taak op basis van namen; onbekende namen worden als label aangemaakt. */
    async setTaskLabels(id, names) {
      const { ids, commands } = labelCommands(names);
      await send([...commands, { type: 'task_update', args: { id, labels: ids } }]);
    },
    /**
     * Verplaatst een taak (met subtaken) naar een project, sectie of bovenliggende taak; optioneel vóór een andere taak
     * (anders achteraan). Is er geen plek tussen twee buren met dezelfde sleutel, dan krijgen de buren erna een nieuwe sleutel
     * in dezelfde reeks (zie core/dnd.js).
     */
    moveTask(id, { project_id, section_id = null, parent_id = null, beforeId = null }) {
      const parent = parent_id ? store.view.tasks.get(parent_id) : null;
      return send(taskMoveCommands(store.view, id, { project_id, section_id: parent ? parent.section_id ?? null : section_id, parent_id, beforeId }));
    },
    completeTask(id) {
      // Een terugkerende taak sturen we mee met de datum die we zagen (if_due): zo schuift hij niet twee keer door als de
      // widget van de Android-app of een ander apparaat hem tegelijk afvinkt.
      const due = store.view.tasks.get(id)?.due;
      // bij "elke!" telt de volgende keer vanaf vandaag: de afzender geeft zijn eigen datum mee (zijn tijdzone)
      return send([{ type: 'task_complete', args: due?.recurrence ? { id, if_due: due.date, ...(due.recurrence.fromCompletion ? { completed_on: todayString() } : {}) } : { id } }]);
    },
    uncompleteTask: (id) => send([{ type: 'task_uncomplete', args: { id } }]),
    deleteTask: (id) => send([{ type: 'task_delete', args: { id } }]),

    // ---- projecten en secties ----
    async addProject({ name, color, parent_id = null, is_favorite = false }) {
      const id = makeId();
      const args = { id, name: name.trim(), order_key: endKey('projects', 'project', { parent_id }) };
      if (color) args.color = color;
      if (parent_id) args.parent_id = parent_id;
      if (is_favorite) args.is_favorite = true;
      await send([{ type: 'project_add', args }]);
      return id;
    },
    updateProject: (id, changes) => send([{ type: 'project_update', args: { id, ...changes } }]),
    /**
     * Zet een project op een andere plek in de zijbalk: onder een ander project (`parent_id`, null = hoogste niveau) en vóór
     * `beforeId` (anders achteraan). Alleen de eigenaar mag een project verplaatsen; de server weigert het anders.
     */
    moveProject: (id, { parent_id = null, beforeId = null }) => send(projectMoveCommands(store.view, id, { parent_id, beforeId })),
    /** Archiveert een project met al zijn subprojecten (de zijbalk laat een subproject van een gearchiveerd project toch niet zien). */
    archiveProject: (id) => send([id, ...projectDescendantIds(store.view, id)].map((x) => ({ type: 'project_update', args: { id: x, is_archived: true } }))),
    /** Zet een gearchiveerd project terug, met de subprojecten die mee zijn gearchiveerd. */
    unarchiveProject: (id) => send([id, ...projectDescendantIds(store.view, id)]
      .filter((x) => store.view.projects.get(x)?.is_archived)
      .map((x) => ({ type: 'project_update', args: { id: x, is_archived: false } }))),
    deleteProject: (id) => send([{ type: 'project_delete', args: { id } }]),
    async addSection(project_id, name) {
      const id = makeId();
      await send([{ type: 'section_add', args: { id, project_id, name: name.trim(), order_key: endKey('sections', 'section', { project_id }) } }]);
      return id;
    },
    updateSection: (id, changes) => send([{ type: 'section_update', args: { id, ...changes } }]),
    deleteSection: (id) => send([{ type: 'section_delete', args: { id } }]),

    // ---- delen en samenwerken ----
    /** Deelt een project met iemand, op gebruikersnaam. De server meldt het als die niet bestaat. */
    shareProject: (project_id, username) => send([{ type: 'project_share', args: { project_id, username: username.trim() } }]),
    unshareProject: (project_id, user_id) => send([{ type: 'project_unshare', args: { project_id, user_id } }]),
    leaveProject: (project_id) => send([{ type: 'project_leave', args: { project_id } }]),
    /** Wijst een taak toe aan een lid van het project, of aan niemand (null). */
    assignTask: (id, assignee_id) => send([{ type: 'task_update', args: { id, assignee_id } }]),

    // ---- opmerkingen ----
    /**
     * Zet een opmerking bij een taak (`{ taskId }`) of een project (`{ projectId }`). Wie de schrijver is, vult de server in.
     * Geeft het id terug.
     */
    async addComment({ taskId = null, projectId = null }, content) {
      const id = makeId();
      const args = { id, content: content.trim() };
      if (taskId) args.task_id = taskId;
      else args.project_id = projectId;
      await send([{ type: 'comment_add', args }]);
      return id;
    },
    /** Wijzigt de tekst van een opmerking. Alleen de schrijver mag dat; de server weigert het anders. */
    updateComment: (id, content) => send([{ type: 'comment_update', args: { id, content: content.trim() } }]),
    deleteComment: (id) => send([{ type: 'comment_delete', args: { id } }]),

    // ---- labels ----
    async addLabel(name) {
      const { ids, commands } = labelCommands([name]);
      await send(commands);
      return ids[0];
    },
    updateLabel: (id, changes) => send([{ type: 'label_update', args: { id, ...changes } }]),
    deleteLabel: (id) => send([{ type: 'label_delete', args: { id } }]),
    /**
     * Hernoemt een label. Labelnamen zijn uniek per eigenaar en niet hoofdlettergevoelig; de server weigert een dubbele naam
     * met DUPLICATE. Hier wordt dat vooraf gecontroleerd: dan komt er een fout terug en wordt er niets verstuurd.
     * @returns {Promise<{ ok: true } | { ok: false, code: 'NOT_FOUND' | 'READONLY' | 'INVALID_ARG' | 'DUPLICATE', message: string }>}
     */
    async renameLabel(id, name) {
      const label = store.view.labels.get(id);
      if (!label) return { ok: false, code: 'NOT_FOUND', message: 'Dit label bestaat niet meer.' };
      if (!isOwnLabel(label, store.userId)) return { ok: false, code: 'READONLY', message: 'Dit label is van iemand anders; je kunt het alleen lezen.' };
      const clean = normalizeText(String(name ?? '')).trim();
      const problem = validateValue(ENTITIES.label.cols.find((c) => c.name === 'name'), clean);
      if (problem) return { ok: false, code: 'INVALID_ARG', message: `Deze naam kan niet: ${problem}.` };
      const key = nameKey(clean);
      for (const other of store.view.labels.values()) {
        if (other.id !== id && isOwnLabel(other, store.userId) && nameKey(other.name) === key) {
          return { ok: false, code: 'DUPLICATE', message: 'Er bestaat al een label met die naam.' };
        }
      }
      if (clean !== label.name) await send([{ type: 'label_update', args: { id, name: clean } }]);
      return { ok: true };
    },

    // ---- filters ----
    // Een filter wordt bewaard zoals het is getypt, ook als de filtertekst nog niet klopt: de gebruiker kan er later aan
    // verder werken. Of de tekst te lezen is, blijkt pas bij het tonen (compileFilter / evaluateFilter in filter.js).
    async addFilter({ name, query, color }) {
      const id = makeId();
      const args = { id, name: name.trim(), query: query.trim(), order_key: endKey('filters', 'filter', {}) };
      if (color) args.color = color;
      await send([{ type: 'filter_add', args }]);
      return id;
    },
    updateFilter: (id, changes) => send([{
      type: 'filter_update',
      args: { id, ...changes, ...(typeof changes.name === 'string' ? { name: changes.name.trim() } : {}), ...(typeof changes.query === 'string' ? { query: changes.query.trim() } : {}) },
    }]),
    deleteFilter: (id) => send([{ type: 'filter_delete', args: { id } }]),
  };
}
