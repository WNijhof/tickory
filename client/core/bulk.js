// Bulkacties op meerdere gekozen taken, zonder scherm: wat wordt er verstuurd (bestaande commando's, in één reeks) en welke taken
// slaan we vooraf over en waarom. De regels zijn die van een enkele taak: een subtaak gaat mee met zijn ouder bij afvinken,
// verplaatsen en verwijderen (dus niet apart als de ouder ook gekozen is); datum, prioriteit, labels en toewijzing gelden voor
// elke gekozen taak zelf. Wat de server pas bij het uitvoeren weigert (iemand verwijderde de taak intussen, geen rechten),
// komt via `summarizeErrors` als één melding terug in plaats van één per taak.

import { applyCommand, cloneState, descendantIds } from './reducer.js';
import { taskMoveCommands, taskSiblings } from './dnd.js';
import { MAX_DRAG_GROUP } from './selection.js';
import { reschedule } from './quickDates.js';
import { isShared, membersOf } from './selectors.js';
import { t } from './i18n.js';

/** Welke acties er zijn, voor meldingen en voor het ongedaan maken (`bulk.done.<naam>` in de woordenlijst). */
export const BULK_ACTIONS = ['complete', 'reopen', 'move', 'date', 'priority', 'labels', 'assign', 'delete'];

/** De gekozen taken die nog bestaan, in de volgorde van `ids`. */
export const existing = (view, ids) => ids.filter((id) => view.tasks.has(id));

/** Zonder taken waarvan een bovenliggende taak ook gekozen is: die gaan vanzelf mee (afvinken, verplaatsen, verwijderen). */
export function topLevel(view, ids) {
  const set = new Set(ids);
  const hasChosenAncestor = (task) => {
    for (let p = task.parent_id ? view.tasks.get(task.parent_id) : null, i = 0; p && i < 1000; i++) {
      if (set.has(p.id)) return true;
      p = p.parent_id ? view.tasks.get(p.parent_id) : null;
    }
    return false;
  };
  return existing(view, ids).filter((id) => !hasChosenAncestor(view.tasks.get(id)));
}

/**
 * Wat is er over de gekozen taken te zeggen, om de knoppen mee te bepalen: of er open en afgevinkte taken bij zijn, of er een
 * gedeeld project bij is (dan kan toewijzen), en welke datum-, label- en prioriteitswaarden ze al hebben.
 */
export function selectionInfo(view, ids) {
  const tasks = existing(view, ids).map((id) => view.tasks.get(id));
  const projects = new Set(tasks.map((x) => x.project_id));
  const labelCount = new Map();
  for (const task of tasks) for (const l of task.labels ?? []) labelCount.set(l, (labelCount.get(l) ?? 0) + 1);
  return {
    count: tasks.length,
    open: tasks.filter((x) => !x.checked).length,
    done: tasks.filter((x) => x.checked).length,
    withDue: tasks.filter((x) => x.due).length,
    projects: [...projects],
    shared: [...projects].some((p) => isShared(view, p)),
    /** Per label: op hoeveel gekozen taken het staat. */
    labelCount,
  };
}

/** De personen die je aan (alle) gekozen taken kunt toewijzen: leden van elk betrokken project, alleen wie in alle projecten lid is eerst. */
export function assignChoices(view, ids) {
  const projects = [...new Set(existing(view, ids).map((id) => view.tasks.get(id).project_id))];
  const byUser = new Map();
  for (const p of projects) for (const m of membersOf(view, p)) byUser.set(m.user_id, (byUser.get(m.user_id) ?? 0) + 1);
  return [...byUser.entries()].map(([userId, inProjects]) => ({ userId, everywhere: inProjects === projects.length }))
    .sort((a, b) => Number(b.everywhere) - Number(a.everywhere));
}

// ---------- afvinken ----------

/** Afvinken: de open taken van het hoogste niveau. `plan(id)` geeft het commando voor één taak (actions.planComplete). */
export function planComplete(view, ids, plan) {
  const roots = topLevel(view, ids).filter((id) => !view.tasks.get(id).checked);
  return { commands: roots.map(plan), count: roots.length };
}

/** Heropenen: de afgevinkte taken van het hoogste niveau, en de subtaken die bij hun afvinken mee waren gegaan blijven zoals ze zijn. */
export function planReopen(view, ids) {
  const roots = topLevel(view, ids).filter((id) => view.tasks.get(id).checked);
  return { commands: roots.map((id) => ({ type: 'task_uncomplete', args: { id } })), count: roots.length };
}

// ---------- verplaatsen ----------

/**
 * Naar een project, en eventueel een sectie ervan, achteraan, in de volgorde van de lijst. Een taak die er al staat (hoogste
 * niveau van dat project en die sectie) blijft liggen. Subtaken gaan met hun ouder mee; een subtaak die alleen gekozen is,
 * komt als gewone taak in het doel te staan (zoals bij slepen naar een ander project).
 * `order` is de zichtbare volgorde; de verplaatste taken komen in die volgorde achter elkaar.
 */
export function planMove(view, ids, { project_id, section_id = null }, order = []) {
  if (!view.projects.has(project_id)) return { commands: [], count: 0, skipped: [] };
  const rank = new Map(order.map((id, i) => [id, i]));
  const roots = topLevel(view, ids).sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
  const sim = cloneState(view);
  const commands = [];
  const skipped = [];
  for (const id of roots) {
    const task = sim.tasks.get(id);
    if (task.project_id === project_id && (task.section_id ?? null) === (section_id ?? null) && !task.parent_id) {
      skipped.push({ id, reason: 'already' });
      continue;
    }
    // elke taak komt achter de vorige: de sleutels worden steeds op de bijgewerkte kopie berekend
    const cmds = taskMoveCommands(sim, id, { project_id, section_id, parent_id: null, beforeId: null });
    for (const c of cmds) applyCommand(sim, c, new Date().toISOString());
    commands.push(...cmds);
  }
  return { commands, count: roots.length - skipped.length, skipped };
}

// ---------- datum, prioriteit, labels, toewijzen ----------

/** Een andere dag (`date` 'YYYY-MM-DD', of null voor geen datum): tijdstip en herhaling blijven, zoals bij één taak. Taken die al op die dag staan, blijven zoals ze zijn. */
export function planDate(view, ids, date, planUpdate) {
  const commands = [];
  let count = 0;
  for (const id of existing(view, ids)) {
    const task = view.tasks.get(id);
    if ((task.due?.date?.slice(0, 10) ?? null) === (date ?? null)) continue;
    if (!task.due && date === null) continue;
    commands.push(...planUpdate(id, { due: reschedule(task.due, date) }));
    count += 1;
  }
  return { commands, count };
}

export function planPriority(view, ids, priority) {
  const todo = existing(view, ids).filter((id) => view.tasks.get(id).priority !== priority);
  return { commands: todo.map((id) => ({ type: 'task_update', args: { id, priority } })), count: todo.length };
}

/** Labels toevoegen (`add`) en weghalen (`remove`), per taak één wijziging. Alleen taken waar echt iets verandert krijgen een commando. */
export function planLabels(view, ids, { add = [], remove = [] }) {
  const commands = [];
  for (const id of existing(view, ids)) {
    const before = view.tasks.get(id).labels ?? [];
    const after = [...before.filter((l) => !remove.includes(l)), ...add.filter((l) => !before.includes(l) || remove.includes(l))];
    const unique = [...new Set(after)];
    if (unique.length === before.length && unique.every((l, i) => l === before[i])) continue;
    commands.push({ type: 'task_update', args: { id, labels: unique } });
  }
  return { commands, count: commands.length };
}

/**
 * Toewijzen aan een lid (of aan niemand, `userId` null). Alleen leden van het project van de taak kunnen een taak krijgen: voor de
 * andere taken staat er in `skipped` waarom ze niet meedoen (`notMember`), de rest gaat door.
 */
export function planAssign(view, ids, userId) {
  const commands = [];
  const skipped = [];
  for (const id of existing(view, ids)) {
    const task = view.tasks.get(id);
    if ((task.assignee_id ?? null) === (userId ?? null)) continue;
    if (userId !== null && !membersOf(view, task.project_id).some((m) => m.user_id === userId)) {
      skipped.push({ id, reason: 'notMember' });
      continue;
    }
    commands.push({ type: 'task_update', args: { id, assignee_id: userId } });
  }
  return { commands, count: commands.length, skipped };
}

// ---------- verwijderen ----------

/** Verwijderen: de taken van het hoogste niveau; subtaken gaan mee. `subtasks` is het aantal subtaken dat daarbij verdwijnt (voor de vraag). */
export function planDelete(view, ids) {
  const roots = topLevel(view, ids);
  const kids = new Set(descendantIds(view, roots));
  return { commands: roots.map((id) => ({ type: 'task_delete', args: { id } })), count: roots.length, subtasks: kids.size };
}


// ---------- slepen van meerdere taken tegelijk ----------

/**
 * Meerdere gekozen taken samen neerzetten waar de gesleepte taak (volgens `plan`, zie core/dnd.js) terechtkomt: allemaal op die plek,
 * in de volgorde van de lijst. Dit is goedkoop (een verplaatsing per taak, sleutels op een kopie berekend) tot `MAX_DRAG_GROUP` taken;
 * daarboven, of als de plek een gekozen taak zelf of een van haar subtaken is, doet het niet mee: de aanroeper verplaatst dan alleen de
 * gesleepte taak en zegt waarom (`reason`: 'many' of 'here').
 * @returns {{ ok: true, commands: object[], count: number } | { ok: false, reason: 'many' | 'here' }}
 */
export function planGroupDrop(view, ids, plan, order = []) {
  const roots = topLevel(view, ids);
  if (roots.length > MAX_DRAG_GROUP) return { ok: false, reason: 'many' };
  const set = new Set(roots);
  for (let p = plan.parent_id ? view.tasks.get(plan.parent_id) : null, i = 0; p && i < 1000; i++) {
    if (set.has(p.id)) return { ok: false, reason: 'here' }; // onder zichzelf of een eigen subtaak kan niet
    p = p.parent_id ? view.tasks.get(p.parent_id) : null;
  }
  // "vóór een taak die zelf meegaat" wordt vóór de eerstvolgende taak die blijft staan
  let before = plan.beforeId ?? null;
  if (before && set.has(before)) {
    const siblings = taskSiblings(view, plan);
    let i = siblings.findIndex((s) => s.id === before);
    while (i >= 0 && i < siblings.length && set.has(siblings[i].id)) i += 1;
    before = i >= 0 ? siblings[i]?.id ?? null : null;
  }
  const rank = new Map(order.map((id, i) => [id, i]));
  roots.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
  const sim = cloneState(view);
  const commands = [];
  for (const id of roots) {
    const cmds = taskMoveCommands(sim, id, { project_id: plan.project_id, section_id: plan.section_id ?? null, parent_id: plan.parent_id ?? null, beforeId: before });
    for (const c of cmds) applyCommand(sim, c, new Date().toISOString());
    commands.push(...cmds);
  }
  return { ok: true, commands, count: roots.length };
}

// ---------- meldingen ----------

/** De naam van een taak voor een melding: de titel, ingekort. */
const shortName = (text) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);

/** "«A», «B» en 2 andere", voor een lijst taaknamen in een melding (hooguit drie met naam). */
export function nameList(names) {
  const shown = names.slice(0, 3).map((n) => `“${shortName(n)}”`);
  const rest = names.length - shown.length;
  if (names.length === 0) return '';
  if (rest > 0) return t('bulk.namesMore', { names: shown.join(', '), count: rest });
  if (shown.length === 1) return shown[0];
  return t('common.listAnd', { first: shown.slice(0, -1).join(', '), last: shown.at(-1) });
}

/**
 * Eén melding voor alles wat de server van een bulkactie weigerde: hoeveel van hoeveel, welke taken (namen uit `nameOf`) en waarom
 * (`describe(error)` geeft de reden per fout; gelijke redenen komen één keer voor). Zonder fouten: null.
 * @param {{ cmd: { args?: { id?: string } }, error_code: string, error: string }[]} errors
 * @param {{ total: number, nameOf: (id: string) => string | null, describe: (e: object) => string }} options
 */
export function summarizeErrors(errors, { total, nameOf, describe }) {
  if (errors.length === 0) return null;
  const names = [...new Set(errors.map((e) => nameOf(e.cmd.args?.id)).filter(Boolean))];
  const reasons = [...new Set(errors.map(describe))];
  const head = t('bulk.failedCount', { failed: errors.length, total });
  return [head, names.length > 0 ? `${nameList(names)}.` : '', reasons.join(' ')].filter(Boolean).join(' ');
}

/** Voor meldingen na het uitvoeren: wat is overgeslagen en waarom (`skipped` komt uit planMove en planAssign). */
export function skippedText(skipped, nameOf) {
  const by = new Map();
  for (const s of skipped) {
    if (!by.has(s.reason)) by.set(s.reason, []);
    by.get(s.reason).push(nameOf(s.id) ?? '');
  }
  const out = [];
  for (const [reason, names] of by) {
    const list = nameList(names.filter(Boolean));
    out.push(reason === 'notMember' ? t('bulk.skipNotMember', { count: names.length, names: list }) : t('bulk.skipAlready', { count: names.length, names: list }));
  }
  return out.join(' ');
}
