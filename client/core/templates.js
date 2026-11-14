// Sjablonen: een project of taak omzetten in een sjabloon, en een sjabloon omzetten in commando's. Alles hier is zuivere logica
// (geen scherm, geen opslag); de handelingen staan in core/actions.js en de vensters in ui/templateUi.js. Het formaat en de
// controle op de inhoud staan in shared/template.js, de uitleg in SPEC.md (hoofdstuk 5c).
//
// Aanmaken uit een sjabloon is één reeks commando's in de juiste volgorde (labels, project, secties, taken met hun subtaken,
// automatische herinneringen), met volgordesleutels, zodat het optimistisch en zonder verbinding werkt en in één keer in de
// wachtrij komt. Past het niet binnen de grenzen van de server (aantal projecten, taken, labels, ...), dan komt er vooraf een
// nette fout in plaats van een half aangemaakt project.

import { keyAfter, keysAfter } from '../../shared/orderKey.js';
import { isValidDate, nextOccurrence } from '../../shared/recurrence.js';
import { APPLY_LIMITS, TEMPLATE_LIMITS, TEMPLATE_VERSION, checkTemplateContent, templateStats } from '../../shared/template.js';
import { nameKey } from '../../shared/text.js';
import { DEFAULT_COLOR, colorName } from './colors.js';
import { addDays, daysBetween } from './format.js';
import { t } from './i18n.js';
import { maxKey, scopeOf } from './reducer.js';
import { byOrder } from './selectors.js';

const DEEPEST = TEMPLATE_LIMITS.depth;
const clean = (s) => String(s ?? '').trim();

// ---------- de tekst van een relatieve datum ----------

/**
 * Een relatieve dag als korte tekst: "dag 0", "+3 dagen", "+1 week", "+2 weken", "-1 dag". Hele weken (7, 14, ...) worden weken.
 * @param {number} day
 * @param {string} [time] 'HH:MM'
 */
export function relativeDayText(day, time = '') {
  const abs = Math.abs(day);
  let text;
  if (day === 0) text = t('template.dayZero');
  else if (abs % 7 === 0) text = day > 0 ? t('template.weekPlus', { count: abs / 7 }) : t('template.weekMinus', { count: abs / 7 });
  else text = day > 0 ? t('template.dayPlus', { count: abs }) : t('template.dayMinus', { count: abs });
  return time ? `${text} ${time}` : text;
}

// ---------- van project of taak naar sjabloon ----------

/** De open kinderen van een taak (of alle, als `all`), op volgorde. */
function childrenOf(view, parentId, all) {
  return [...view.tasks.values()].filter((x) => (x.parent_id ?? null) === parentId && (all || !x.checked)).sort(byOrder);
}

/** Bouwt de taken-bomen. Dieper dan het maximum worden de nakomelingen gewone broers en zussen op het diepste niveau. */
function convertTasks(view, tasks, ctx, depth = 1) {
  const out = [];
  for (const task of tasks) {
    const node = convertTask(view, task, ctx);
    out.push(node);
    const kids = childrenOf(view, task.id, ctx.all);
    if (kids.length === 0) continue;
    if (depth < DEEPEST) {
      node.subtasks = convertTasks(view, kids, ctx, depth + 1);
    } else {
      for (const x of flatten(view, kids, ctx.all)) out.push(convertTask(view, x, ctx));
    }
  }
  return out;
}

function flatten(view, tasks, all) {
  const out = [];
  for (const task of tasks) out.push(task, ...flatten(view, childrenOf(view, task.id, all), all));
  return out;
}

function convertTask(view, task, ctx) {
  const node = { content: task.content };
  if (task.description) node.description = task.description;
  if (task.priority >= 1 && task.priority < 4) node.priority = task.priority;
  const names = [];
  const seen = new Set();
  for (const id of task.labels ?? []) {
    const label = view.labels.get(id);
    if (!label) continue;
    if (!seen.has(nameKey(label.name))) {
      seen.add(nameKey(label.name));
      names.push(label.name);
    }
  }
  if (names.length > 0) node.labels = names;
  if (task.duration) node.duration = task.duration;
  const due = task.due;
  if (due) {
    const time = due.date.length > 10 ? due.date.slice(11, 16) : null;
    const day = ctx.base ? daysBetween(ctx.base, due.date.slice(0, 10)) : null;
    const inRange = day !== null && day >= TEMPLATE_LIMITS.dayMin && day <= TEMPLATE_LIMITS.dayMax;
    if (ctx.dates && inRange) {
      node.day = day;
      if (time) node.time = time;
    }
    if (due.recurrence) {
      // een herhaling blijft altijd bewaard, ook zonder datums: ze krijgt dan dag 0 (de startdag, of vandaag zonder startdatum)
      if (node.day === undefined) {
        node.day = 0;
        if (time) node.time = time;
      }
      node.recurrence = structuredClone(due.recurrence);
      if (due.string && due.string.length <= TEMPLATE_LIMITS.repeatText && !/[\u0000-\u001f\u007f]/u.test(due.string)) node.repeat_text = due.string;
    }
  }
  return node;
}

/** De vroegste datum onder de taken (liefst van een taak die niet terugkeert: die zegt waar het project "begint"). */
function earliestDate(tasks) {
  const dates = (list) => list.map((x) => x.due?.date.slice(0, 10)).filter(Boolean).sort();
  return dates(tasks.filter((x) => !x.due?.recurrence))[0] ?? dates(tasks)[0] ?? null;
}

/** Controleert een nieuw sjabloon en geeft `{ template }` of `{ problem: { code, detail } }`. */
function finish(template) {
  const stats = templateStats(template.content);
  if (stats.tasks === 0) return { problem: { code: 'empty' } };
  if (stats.tasks > TEMPLATE_LIMITS.tasks) return { problem: { code: 'tooMany', count: stats.tasks, limit: TEMPLATE_LIMITS.tasks } };
  const invalid = checkTemplateContent(template.content);
  if (invalid) return { problem: { code: invalid.startsWith('te groot') ? 'tooBig' : 'invalid', detail: invalid } };
  return { template };
}

/**
 * Maakt een sjabloon van een project: de secties, open taken en subtaken. Afgevinkte taken, herinneringen, opmerkingen,
 * toewijzingen en deadlines gaan niet mee; herhalingsregels wel. Met `dates` worden datums relatieve dagen: de vroegste datum
 * is dag 0.
 * @param {object} view
 * @param {string} projectId
 * @param {{ name: string, description?: string, dates?: boolean, userId?: string | null }} options
 * @returns {{ template: object } | { problem: { code: string, [k: string]: unknown } }}
 */
export function templateFromProject(view, projectId, { name, description = '', dates = true, userId = null }) {
  const project = view.projects.get(projectId);
  if (!project) return { problem: { code: 'gone' } };
  const sections = [...view.sections.values()].filter((s) => s.project_id === projectId && !s.is_archived).sort(byOrder);
  const open = (x) => !x.checked && x.project_id === projectId;
  const inScope = [...view.tasks.values()].filter((x) => open(x) && (!x.section_id || sections.some((s) => s.id === x.section_id)));
  const ctx = { dates, userId, all: false, base: earliestDate(inScope) };
  const top = (sectionId) => [...view.tasks.values()].filter((x) => open(x) && !x.parent_id && (x.section_id ?? null) === sectionId).sort(byOrder);
  const content = {
    v: TEMPLATE_VERSION,
    tasks: convertTasks(view, top(null), ctx),
    sections: sections.map((s) => ({ name: s.name, tasks: convertTasks(view, top(s.id), ctx) })),
  };
  return finish({ name: clean(name), kind: 'project', description: clean(description), color: colorName(project.color), content });
}

/**
 * Maakt een sjabloon van één taak met haar subtaken. Met `withSection` neemt het de naam van de sectie mee waar de taak in staat.
 * Dag 0 is de datum van de taak zelf (of anders de vroegste datum onder haar subtaken).
 * @returns {{ template: object } | { problem: { code: string, [k: string]: unknown } }}
 */
export function templateFromTask(view, taskId, { name, description = '', dates = true, withSection = true, userId = null }) {
  const root = view.tasks.get(taskId);
  if (!root) return { problem: { code: 'gone' } };
  const all = Boolean(root.checked); // een afgevinkte taak neemt haar (ook afgevinkte) subtaken mee, anders zou er niets overblijven
  const ctx = { dates, userId, all, base: null };
  const subtree = [root, ...flatten(view, childrenOf(view, root.id, all), all)];
  ctx.base = root.due ? root.due.date.slice(0, 10) : earliestDate(subtree);
  const tasks = convertTasks(view, [root], ctx);
  const section = withSection && root.section_id ? view.sections.get(root.section_id) : null;
  const content = section ? { v: TEMPLATE_VERSION, tasks: [], sections: [{ name: section.name, tasks }] } : { v: TEMPLATE_VERSION, tasks, sections: [] };
  return finish({ name: clean(name), kind: 'task', description: clean(description), color: DEFAULT_COLOR, content });
}

// ---------- van sjabloon naar commando's ----------

/** Zet een datum van een herhaling op de eerste dag die bij de regel past (bij "elke vrijdag" is dat een vrijdag). */
function alignedDate(date, recurrence) {
  const weekdays = recurrence.freq === 'weekly' && recurrence.byweekday;
  const nthWeekday = recurrence.freq === 'monthly' && recurrence.nth !== undefined;
  if (!weekdays && !nthWeekday) return date;
  return nextOccurrence(addDays(date, -1), recurrence) ?? date;
}

/** De datum van een taak uit het sjabloon, of null. Zonder startdatum krijgen alleen herhalende taken een datum (van vandaag af). */
export function taskDate(task, { startDate, today }) {
  if (task.day === undefined) return null;
  const base = startDate ?? (task.recurrence ? today : null);
  if (!base) return null;
  let date = addDays(base, task.day);
  if (!isValidDate(date)) return null;
  if (task.recurrence) date = alignedDate(date, task.recurrence);
  return task.time ? `${date}T${task.time}` : date;
}

/**
 * De grenzen van de server die dit aanmaken zou overschrijden, of null als het past. Telt wat de app lokaal weet: wat de server
 * er verder bij heeft (andere apparaten die nog niet gesynchroniseerd zijn) kan de server alsnog weigeren.
 * @returns {{ code: string, limit: number, have: number, need: number } | null}
 */
export function quotaProblem(view, userId, { newProject, projectId, sections, tasks, labels, reminders, templates = 0 }) {
  const mine = (row) => !userId || !row.owner_id || row.owner_id === userId;
  const over = (code, limit, have, need) => (have + need > limit ? { code, limit, have, need } : null);
  if (newProject) {
    const owned = [...view.members.values()].filter((m) => m.role === 'owner' && (!userId || m.user_id === userId)).length;
    const problem = over('projects', APPLY_LIMITS.projectsPerUser, owned, 1);
    if (problem) return problem;
  }
  const inProject = (map) => (projectId ? [...map.values()].filter((x) => x.project_id === projectId).length : 0);
  const created = userId ? [...view.tasks.values()].filter((x) => x.creator_id === userId).length : view.tasks.size;
  return over('sections', APPLY_LIMITS.sectionsPerProject, inProject(view.sections), sections)
    ?? over('tasksPerProject', APPLY_LIMITS.tasksPerProject, inProject(view.tasks), tasks)
    ?? over('tasksPerUser', APPLY_LIMITS.tasksPerUser, created, tasks)
    ?? over('labels', APPLY_LIMITS.labelsPerUser, [...view.labels.values()].filter(mine).length, labels)
    ?? over('reminders', APPLY_LIMITS.remindersPerUser, [...view.reminders.values()].filter(mine).length, reminders)
    ?? over('templates', APPLY_LIMITS.templatesPerUser, [...view.templates.values()].filter(mine).length, templates);
}

/**
 * De labelnamen in een sjabloon, zonder dubbelen (hoofdletterongevoelig), in volgorde van voorkomen.
 * @returns {string[]}
 */
export function labelNamesOf(content) {
  return templateStats(content).labels;
}

/**
 * De commando's om een sjabloon toe te passen, als gewone gegevens (zonder uuid; die geeft `send` in core/actions.js).
 *
 * - `mode: 'project'`: een nieuw project (`projectName`, kleur van het sjabloon) met alle secties en taken.
 * - `mode: 'insert'`: de taken in een bestaand project (`projectId`). Secties met dezelfde naam als in het sjabloon worden
 *   hergebruikt (hoofdletterongevoelig), andere worden nieuw aangemaakt; taken zonder sectie komen in `sectionId` (of zonder sectie).
 *
 * @param {object} view de lokale toestand
 * @param {{ kind: string, name: string, color?: string, content: object }} template
 * @param {{
 *   mode: 'project' | 'insert', projectName?: string, projectId?: string, sectionId?: string | null,
 *   startDate: string | null, today: string, userId: string | null, autoReminder: number,
 *   makeId: () => string, labels: { byName: Map<string, string>, commands: object[] },
 * }} options `labels`: het resultaat van `labelCommands` voor `labelNamesOf(template.content)` (core/actions.js)
 * @returns {{ commands: object[], projectId: string, rootTaskIds: string[] (de taken van het hoogste niveau buiten nieuwe secties), newSectionIds: string[], counts: { tasks: number, sections: number, newSections: number, newLabels: number, reminders: number } }}
 */
export function planTemplate(view, template, options) {
  const { mode, startDate, today, userId, autoReminder, makeId, labels } = options;
  const commands = [...labels.commands];
  const content = template.content;
  const projectId = mode === 'project' ? makeId() : options.projectId;

  if (mode === 'project') {
    const args = {
      id: projectId, name: clean(options.projectName) || template.name,
      order_key: keyAfter(maxKey(view.projects, scopeOf('project', { parent_id: null }))),
    };
    const color = colorName(template.color);
    if (color !== DEFAULT_COLOR) args.color = color;
    commands.push({ type: 'project_add', args });
  }

  // secties: nieuw, of (bij invoegen) een bestaande met dezelfde naam
  const existing = mode === 'insert' ? [...view.sections.values()].filter((s) => s.project_id === projectId && !s.is_archived) : [];
  const found = new Map(content.sections.map((section) => [section, existing.find((s) => nameKey(s.name) === nameKey(section.name))]));
  const fresh = content.sections.filter((section) => !found.get(section));
  const sectionKeys = keysAfter(mode === 'insert' ? maxKey(view.sections, (s) => s.project_id === projectId) : null, fresh.length);
  const sectionIds = new Map();
  const newSectionIds = [];
  for (const section of content.sections) {
    if (found.get(section)) {
      sectionIds.set(section, found.get(section).id);
      continue;
    }
    const id = makeId();
    commands.push({ type: 'section_add', args: { id, project_id: projectId, name: section.name, order_key: sectionKeys[newSectionIds.length] } });
    sectionIds.set(section, id);
    newSectionIds.push(id);
  }

  // taken: elke lijst (project, sectie, bovenliggende taak) krijgt in één keer een reeks korte sleutels, na wat er al in staat
  // (keyAfter steeds op de vorige laat de sleutels bij een lange lijst boven de 64 tekens uitkomen)
  const lastKey = new Map();
  const keysFor = (sectionId, parentId, n) => {
    const slot = `${sectionId ?? ''}|${parentId ?? ''}`;
    if (!lastKey.has(slot)) {
      const empty = mode === 'project' || newSectionIds.includes(sectionId) || parentId;
      lastKey.set(slot, empty ? null : maxKey(view.tasks, scopeOf('task', { project_id: projectId, section_id: sectionId, parent_id: null })));
    }
    const keys = keysAfter(lastKey.get(slot), n);
    if (n > 0) lastKey.set(slot, keys[n - 1]);
    return keys;
  };

  const rootTaskIds = [];
  let tasks = 0;
  let reminders = 0;
  const addTasks = (list, sectionId, parentId) => {
    const keys = keysFor(sectionId, parentId, list.length);
    for (const [index, task] of list.entries()) {
      const id = makeId();
      const args = { id, project_id: projectId, content: task.content, order_key: keys[index] };
      if (parentId) args.parent_id = parentId;
      else if (sectionId) args.section_id = sectionId;
      if (task.description) args.description = task.description;
      if (task.priority && task.priority < 4) args.priority = task.priority;
      const ids = (task.labels ?? []).map((name) => labels.byName.get(nameKey(name))).filter(Boolean);
      if (ids.length > 0) args.labels = [...new Set(ids)];
      if (task.duration) args.duration = task.duration;
      const date = taskDate(task, { startDate, today });
      if (date) {
        args.due = { date };
        if (task.recurrence) {
          args.due.recurrence = structuredClone(task.recurrence);
          if (task.repeat_text) Object.assign(args.due, { string: task.repeat_text, lang: 'nl' });
        }
      }
      commands.push({ type: 'task_add', args });
      tasks += 1;
      if (!parentId && !newSectionIds.includes(sectionId)) rootTaskIds.push(id); // wat in een nieuwe sectie staat, verdwijnt met die sectie
      // zoals bij een los toegevoegde taak: een taak met een tijd krijgt de automatische herinnering
      if (date && date.length > 10 && autoReminder >= 0) {
        commands.push({ type: 'reminder_add', args: { id: makeId(), task_id: id, type: 'relative', minute_offset: autoReminder } });
        reminders += 1;
      }
      if (task.subtasks) addTasks(task.subtasks, null, id);
    }
  };
  addTasks(content.tasks, mode === 'insert' ? options.sectionId ?? null : null, null);
  for (const section of content.sections) addTasks(section.tasks, sectionIds.get(section), null);

  const newLabels = labels.commands.length;
  return { commands, projectId, rootTaskIds, newSectionIds, counts: { tasks, sections: content.sections.length, newSections: newSectionIds.length, newLabels, reminders } };
}

// ---------- voorbeeldweergave ----------

/**
 * De eerste regels van een sjabloon om te laten zien voor het aanmaken: secties en taken (en subtaken) in volgorde, hoogstens
 * `limit` taken. `more` is het aantal taken dat er niet bij staat.
 * @returns {{ lines: { kind: 'section' | 'task', depth: number, text: string, day?: number, time?: string, recurring?: boolean }[], more: number }}
 */
export function previewLines(content, limit = 10) {
  const lines = [];
  let shown = 0;
  const total = templateStats(content).tasks;
  const walk = (list, depth) => {
    for (const task of list) {
      if (shown >= limit) return;
      shown += 1;
      lines.push({ kind: 'task', depth, text: task.content, day: task.day, time: task.time, recurring: Boolean(task.recurrence) });
      if (task.subtasks) walk(task.subtasks, depth + 1);
    }
  };
  walk(content.tasks, 1);
  for (const section of content.sections) {
    if (shown >= limit) break;
    lines.push({ kind: 'section', depth: 0, text: section.name });
    walk(section.tasks, 1);
  }
  return { lines, more: Math.max(0, total - shown) };
}

/** Van wanneer tot wanneer lopen de datums, bij deze startdatum? Of null als het sjabloon geen datums heeft. */
export function dateSpan(content, startDate) {
  const stats = templateStats(content);
  if (!startDate || stats.minDay === null) return null;
  const from = addDays(startDate, stats.minDay);
  const to = addDays(startDate, stats.maxDay);
  return isValidDate(from) && isValidDate(to) ? { from, to } : null;
}

// ---------- lijst ----------

/** Je eigen sjablonen (een sjabloon van iemand anders zie je nooit; dit is voor de zekerheid), op naam. */
export function templateList(view, userId, kind = null) {
  return [...view.templates.values()]
    .filter((x) => (!x.owner_id || !userId || x.owner_id === userId) && (!kind || x.kind === kind))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));
}
