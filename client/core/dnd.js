// De logica van slepen en verplaatsen, zonder scherm: waar komt een taak of project terecht als je het ergens loslaat of met
// het toetsenbord verplaatst, en welke volgordesleutel krijgt het daar. De interface (ui/dragdrop.js) zoekt alleen uit boven
// welke regel en in welk deel van die regel de aanwijzer staat; alles wat daarna beslist wordt, staat hier en is getest.
//
// Een "plan" voor een taak is `{ project_id, section_id, parent_id, beforeId }`: de plek waar de taak komt, vóór de taak
// `beforeId` (null = achteraan) in die lijst. Voor een project is het `{ parent_id, beforeId }`. Een plan van `null` betekent
// dat loslaten hier niets verandert of niet mag.
//
// Volgordesleutels: tussen twee buren past altijd een nieuwe sleutel (shared/orderKey.js). Twee buren met precies dezelfde
// sleutel komen voor (twee apparaten die offline allebei achteraan toevoegden); daar past niets tussen, en `placeKey` geeft
// dan ook nieuwe sleutels aan de buren erna. Zo valt een verplaatsing nooit om.

import { keyBetween } from '../../shared/orderKey.js';
import { isInboxId } from '../../shared/schema.js';
import { descendantIds, scopeOf } from './reducer.js';
import { byOrder, isArchivedProject, projectDescendantIds, roleIn } from './selectors.js';
import { addDays } from './format.js';
import { reschedule } from './quickDates.js';

/** Welk deel van een regel de aanwijzer raakt: erboven, op de regel zelf (wordt subtaak) of eronder. */
export const ZONES = ['before', 'child', 'after'];

/**
 * Het deel van een regel bij een hoogte in de regel (0 = bovenrand, 1 = onderrand). Kan de regel iets "ouder" worden
 * (`canNest`), dan telt de bovenste 30% als erboven, de onderste 30% als eronder en het midden als eronder-in; anders
 * is het de bovenste of onderste helft.
 * @param {number} fraction
 * @param {boolean} [canNest]
 * @returns {'before' | 'child' | 'after'}
 */
export function zoneAt(fraction, canNest = true) {
  if (!canNest) return fraction < 0.5 ? 'before' : 'after';
  return fraction < 0.3 ? 'before' : fraction > 0.7 ? 'after' : 'child';
}

// ---------- volgordesleutels ----------

/**
 * De nieuwe volgordesleutel voor een plek vóór `beforeId` (of achteraan) tussen deze broers en zussen, en zo nodig nieuwe
 * sleutels voor buren die er nu dezelfde sleutel hebben als de plek ervoor.
 * @param {{ id: string, order_key: string }[]} siblings de lijst zonder het item dat verplaatst wordt
 * @param {string | null} [beforeId]
 * @returns {{ order_key: string, rekeys: { id: string, order_key: string }[] }}
 */
export function placeKey(siblings, beforeId = null) {
  const list = [...siblings].sort(byOrder);
  const found = beforeId ? list.findIndex((s) => s.id === beforeId) : -1;
  const at = found < 0 ? list.length : found;
  const prev = at > 0 ? list[at - 1].order_key : null;
  const next = at < list.length ? list[at].order_key : null;
  if (prev === null || next === null || prev < next) return { order_key: keyBetween(prev, next), rekeys: [] };
  // prev === next: alles vanaf de plek met dezelfde sleutel schuift naar een hogere sleutel, onder de eerstvolgende grotere
  let end = at;
  while (end < list.length && list[end].order_key === prev) end += 1;
  const limit = end < list.length ? list[end].order_key : null;
  const rekeys = [];
  let low = prev;
  for (let i = at; i < end; i++) {
    low = keyBetween(low, limit);
    rekeys.push({ id: list[i].id, order_key: low });
  }
  return { order_key: keyBetween(prev, rekeys[0].order_key), rekeys };
}

// ---------- taken ----------

/** Dezelfde lijst (broers en zussen) als de server en de reducer gebruiken, op volgorde, zonder `exceptId`. */
export function taskSiblings(view, scope, exceptId = null) {
  const pred = scopeOf('task', { project_id: scope.project_id, section_id: scope.section_id ?? null, parent_id: scope.parent_id ?? null });
  return [...view.tasks.values()].filter((t) => t.id !== exceptId && pred(t)).sort(byOrder);
}

/** Staat `taskId` onder `ancestorId` (op elk niveau)? Dan mag `ancestorId` er niet onder terechtkomen. */
export const isTaskDescendant = (view, taskId, ancestorId) => descendantIds(view, [ancestorId]).includes(taskId);

const sameTarget = (task, target) => task.project_id === target.project_id && (task.section_id ?? null) === (target.section_id ?? null) && (task.parent_id ?? null) === (target.parent_id ?? null);

/** Zet een plek om in een plan; geeft null als de taak er al staat. */
function finishTask(view, task, target) {
  if (sameTarget(task, target)) {
    const all = taskSiblings(view, target);
    const at = all.findIndex((t) => t.id === task.id);
    if ((all[at + 1]?.id ?? null) === target.beforeId) return null;
  }
  return target;
}

/**
 * Waar komt `dragId` terecht als je het loslaat op het deel `zone` van de taak `overId`?
 * `overExpanded`: de taak heeft zichtbare subtaken; "eronder" betekent dan als eerste subtaak, want de lijn staat tussen de taak
 * en haar subtaken.
 * @returns {{ project_id: string, section_id: string | null, parent_id: string | null, beforeId: string | null } | null}
 */
export function planTaskDrop(view, { dragId, overId, zone, overExpanded = false }) {
  const drag = view.tasks.get(dragId);
  const over = view.tasks.get(overId);
  if (!drag || !over || dragId === overId || isTaskDescendant(view, overId, dragId)) return null;
  const section_id = over.section_id ?? null;
  if (zone === 'child' || (zone === 'after' && overExpanded)) {
    const first = zone === 'after' ? taskSiblings(view, { project_id: over.project_id, section_id, parent_id: over.id }, dragId)[0] : undefined;
    return finishTask(view, drag, { project_id: over.project_id, section_id, parent_id: over.id, beforeId: first?.id ?? null });
  }
  const scope = { project_id: over.project_id, section_id, parent_id: over.parent_id ?? null };
  const siblings = taskSiblings(view, scope, dragId);
  const i = siblings.findIndex((t) => t.id === over.id);
  return finishTask(view, drag, { ...scope, beforeId: zone === 'before' ? over.id : siblings[i + 1]?.id ?? null });
}

/** Loslaten op de kop van een sectie (`edge: 'start'`: bovenaan) of in de ruimte onder haar taken (`'end'`): op het hoogste niveau. */
export function planTaskDropOnGroup(view, { dragId, projectId, sectionId = null, edge = 'end' }) {
  const drag = view.tasks.get(dragId);
  if (!drag || !view.projects.has(projectId)) return null;
  if (sectionId && view.sections.get(sectionId)?.project_id !== projectId) return null;
  const scope = { project_id: projectId, section_id: sectionId ?? null, parent_id: null };
  const first = edge === 'start' ? taskSiblings(view, scope, dragId)[0] : undefined;
  return finishTask(view, drag, { ...scope, beforeId: first?.id ?? null });
}

/** Loslaten op een project in de zijbalk: achteraan het hoogste niveau van dat project. Het eigen project telt niet. */
export function planTaskDropOnProject(view, { dragId, projectId }) {
  const drag = view.tasks.get(dragId);
  if (!drag || !view.projects.has(projectId) || drag.project_id === projectId) return null;
  return { project_id: projectId, section_id: null, parent_id: null, beforeId: null };
}

/**
 * Het plan met de sleutels erbij, klaar voor `actions.moveTask`: wat er daarna in de lijst staat en welke nieuwe sleutels nodig zijn.
 * (Handig voor tests: dit is precies wat `moveTask` verstuurt.)
 */
export function taskMoveCommands(view, id, plan) {
  const { order_key, rekeys } = placeKey(taskSiblings(view, plan, id), plan.beforeId);
  const args = { id, project_id: plan.project_id, parent_id: plan.parent_id ?? null, order_key };
  if (!plan.parent_id) args.section_id = plan.section_id ?? null;
  return [...rekeys.map((r) => ({ type: 'task_update', args: { id: r.id, order_key: r.order_key } })), { type: 'task_move', args }];
}

/** Waar staat een taak nu? Als plan, om een verplaatsing ongedaan te maken. */
export function currentTaskPlan(view, id) {
  const task = view.tasks.get(id);
  if (!task) return null;
  const scope = { project_id: task.project_id, section_id: task.section_id ?? null, parent_id: task.parent_id ?? null };
  const all = taskSiblings(view, scope);
  const at = all.findIndex((t) => t.id === id);
  return { ...scope, beforeId: all[at + 1]?.id ?? null };
}

// ---------- taken met het toetsenbord ----------

/** De groepen van een project, zoals de lijst ze toont: eerst de taken zonder sectie, dan elke sectie op volgorde. */
function taskGroups(view, projectId) {
  const sections = [...view.sections.values()].filter((s) => s.project_id === projectId && !s.is_archived).sort(byOrder);
  return [{ id: null, name: view.projects.get(projectId)?.name ?? '' }, ...sections.map((s) => ({ id: s.id, name: s.name }))];
}

/** De plek in een lijst, voor de aankondiging: "positie 2 van 5". Telt alleen wat zichtbaar is (`isVisible`). */
function positionIn(view, plan, taskId, isVisible) {
  const all = taskSiblings(view, plan, taskId);
  const found = plan.beforeId ? all.findIndex((t) => t.id === plan.beforeId) : -1;
  const at = found < 0 ? all.length : found;
  return { position: all.slice(0, at).filter(isVisible).length + 1, count: all.filter(isVisible).length + 1 };
}

/**
 * Een taak met het toetsenbord verplaatsen: 'up' en 'down' (een plek hoger of lager in dezelfde lijst; aan de rand naar de
 * vorige of volgende sectie), 'indent' (subtaak van de taak erboven) en 'outdent' (weer een niveau terug).
 * Geeft `{ plan, kind, ... }` voor de aankondiging, of `{ blocked }` als het niet kan ('first', 'last', 'noPrevious', 'noParent').
 * @param {{ isVisible?: (task: object) => boolean }} [options] wat de lijst nu toont (standaard: wat niet is afgevinkt)
 */
export function planTaskKey(view, taskId, command, { isVisible = (t) => !t.checked } = {}) {
  const task = view.tasks.get(taskId);
  if (!task) return { blocked: 'gone' };
  const scope = { project_id: task.project_id, section_id: task.section_id ?? null, parent_id: task.parent_id ?? null };
  const all = taskSiblings(view, scope, taskId);
  const shown = all.filter(isVisible);
  const before = shown.filter((t) => byOrder(t, task) < 0);
  const prev = before.at(-1);
  const next = shown.find((t) => !before.includes(t));
  const containerName = () => (scope.section_id ? view.sections.get(scope.section_id)?.name : view.projects.get(scope.project_id)?.name) ?? '';
  const done = (plan, extra) => ({ plan, ...extra, ...positionIn(view, plan, taskId, isVisible) });

  if (command === 'up') {
    if (prev) return done({ ...scope, beforeId: prev.id }, { kind: 'moved', container: containerName() });
    if (scope.parent_id) return { blocked: 'first' };
    const groups = taskGroups(view, scope.project_id);
    const g = groups.findIndex((x) => x.id === scope.section_id);
    if (g <= 0) return { blocked: 'first' };
    return done({ project_id: scope.project_id, section_id: groups[g - 1].id, parent_id: null, beforeId: null }, { kind: 'moved', container: groups[g - 1].name });
  }
  if (command === 'down') {
    if (next) {
      const after = all.filter((t) => byOrder(t, next) > 0)[0];
      return done({ ...scope, beforeId: after?.id ?? null }, { kind: 'moved', container: containerName() });
    }
    if (scope.parent_id) return { blocked: 'last' };
    const groups = taskGroups(view, scope.project_id);
    const g = groups.findIndex((x) => x.id === scope.section_id);
    if (g < 0 || g >= groups.length - 1) return { blocked: 'last' };
    const target = { project_id: scope.project_id, section_id: groups[g + 1].id, parent_id: null };
    return done({ ...target, beforeId: taskSiblings(view, target, taskId)[0]?.id ?? null }, { kind: 'moved', container: groups[g + 1].name });
  }
  if (command === 'indent') {
    if (!prev) return { blocked: 'noPrevious' };
    return done({ ...scope, parent_id: prev.id, beforeId: null }, { kind: 'indented', parent: prev.content });
  }
  if (command === 'outdent') {
    const parent = scope.parent_id ? view.tasks.get(scope.parent_id) : null;
    if (!parent) return { blocked: 'noParent' };
    const target = { project_id: parent.project_id, section_id: parent.section_id ?? null, parent_id: parent.parent_id ?? null };
    const aunts = taskSiblings(view, target, taskId);
    const i = aunts.findIndex((t) => t.id === parent.id);
    return done({ ...target, beforeId: aunts[i + 1]?.id ?? null }, { kind: 'outdented', parent: parent.content });
  }
  return { blocked: 'unknown' };
}

// ---------- projecten ----------

/** Alleen de eigenaar verplaatst een project; de Inbox en een gearchiveerd project helemaal niet. Zonder bekende gebruiker (voor de eerste sync) telt iedereen als eigenaar. */
export function canReorderProject(view, projectId, userId) {
  const project = view.projects.get(projectId);
  if (!project || isInboxId(projectId) || isArchivedProject(view, projectId)) return false;
  return !userId || roleIn(view, projectId, userId) === 'owner';
}

/** De broers en zussen van een project op volgorde (dezelfde lijst als op de server), zonder `exceptId`. */
export function projectSiblings(view, parentId, exceptId = null) {
  const pred = scopeOf('project', { parent_id: parentId ?? null });
  return [...view.projects.values()].filter((p) => p.id !== exceptId && pred(p)).sort(byOrder);
}

const sameProjectTarget = (p, target) => (p.parent_id ?? null) === (target.parent_id ?? null);

function finishProject(view, project, target) {
  if (sameProjectTarget(project, target)) {
    const all = projectSiblings(view, target.parent_id);
    const at = all.findIndex((p) => p.id === project.id);
    if ((all[at + 1]?.id ?? null) === target.beforeId) return null;
  }
  return target;
}

/** Mag `projectId` onder `parentId` komen te staan? Niet onder zichzelf of een eigen subproject, en niet onder de Inbox. */
function validParent(view, projectId, parentId) {
  if (!parentId) return true;
  if (!view.projects.has(parentId) || isInboxId(parentId) || parentId === projectId) return false;
  return !projectDescendantIds(view, projectId).includes(parentId);
}

/**
 * Waar komt het project terecht bij loslaten op het deel `zone` van het project `overId` in de zijbalk?
 * Met `favoritesOnly` (de lijst Favorieten) kan alleen vóór of na een favoriet met dezelfde bovenliggende: die lijst heeft geen niveaus.
 * @returns {{ parent_id: string | null, beforeId: string | null } | null}
 */
export function planProjectDrop(view, { dragId, overId, zone, userId = null, overExpanded = false, favoritesOnly = false }) {
  const drag = view.projects.get(dragId);
  const over = view.projects.get(overId);
  if (!drag || !over || dragId === overId || !canReorderProject(view, dragId, userId)) return null;
  if (isInboxId(overId) || projectDescendantIds(view, dragId).includes(overId)) return null;
  if (favoritesOnly) {
    if (zone === 'child' || (over.parent_id ?? null) !== (drag.parent_id ?? null)) return null;
  }
  const nested = zone === 'child' || (zone === 'after' && overExpanded && !favoritesOnly);
  if (nested) {
    if (!validParent(view, dragId, over.id) || isArchivedProject(view, over.id)) return null;
    const first = zone === 'after' ? projectSiblings(view, over.id, dragId)[0] : undefined;
    return finishProject(view, drag, { parent_id: over.id, beforeId: first?.id ?? null });
  }
  const parent_id = over.parent_id ?? null;
  if (!validParent(view, dragId, parent_id)) return null;
  const siblings = projectSiblings(view, parent_id, dragId);
  const i = siblings.findIndex((p) => p.id === over.id);
  return finishProject(view, drag, { parent_id, beforeId: zone === 'before' ? over.id : siblings[i + 1]?.id ?? null });
}

/** Loslaten op de kop "Projecten": het project wordt een gewoon project op het hoogste niveau, bovenaan (maar onder de Inbox). */
export function planProjectDropToTop(view, { dragId, userId = null }) {
  const drag = view.projects.get(dragId);
  if (!drag || !canReorderProject(view, dragId, userId)) return null;
  const first = projectSiblings(view, null, dragId).find((p) => !isInboxId(p.id));
  return finishProject(view, drag, { parent_id: null, beforeId: first?.id ?? null });
}

/** Het project en de plek van nu, als plan (om ongedaan te maken). */
export function currentProjectPlan(view, id) {
  const project = view.projects.get(id);
  if (!project) return null;
  const all = projectSiblings(view, project.parent_id ?? null);
  const at = all.findIndex((p) => p.id === id);
  return { parent_id: project.parent_id ?? null, beforeId: all[at + 1]?.id ?? null };
}

/** De commando's voor een verplaatst project: de nieuwe sleutels van buren en de update zelf (`parent_id` alleen als die verandert). */
export function projectMoveCommands(view, id, plan) {
  const project = view.projects.get(id);
  const { order_key, rekeys } = placeKey(projectSiblings(view, plan.parent_id ?? null, id), plan.beforeId);
  const args = { id, order_key };
  if ((project?.parent_id ?? null) !== (plan.parent_id ?? null)) args.parent_id = plan.parent_id ?? null;
  return [...rekeys.map((r) => ({ type: 'project_update', args: { id: r.id, order_key: r.order_key } })), { type: 'project_update', args }];
}

/**
 * Een project met het toetsenbord verplaatsen in de zijbalk, zoals `planTaskKey` voor taken. `favoritesOnly`: in de lijst
 * Favorieten, waar alleen favorieten met dezelfde bovenliggende telen en indrukken en terug niet bestaan.
 * Geeft `{ plan, kind, position, count, ... }` of `{ blocked }` ('first', 'last', 'noPrevious', 'noParent', 'denied').
 */
export function planProjectKey(view, projectId, command, { userId = null, favoritesOnly = false } = {}) {
  const project = view.projects.get(projectId);
  if (!project) return { blocked: 'gone' };
  if (!canReorderProject(view, projectId, userId)) return { blocked: 'denied' };
  const parent_id = project.parent_id ?? null;
  const all = projectSiblings(view, parent_id, projectId);
  const shown = all.filter((p) => !isInboxId(p.id) && !isArchivedProject(view, p.id) && (!favoritesOnly || p.is_favorite));
  const before = shown.filter((p) => byOrder(p, project) < 0);
  const prev = before.at(-1);
  const next = shown.find((p) => !before.includes(p));
  const place = (plan) => {
    const list = projectSiblings(view, plan.parent_id ?? null, projectId);
    const visible = list.filter((p) => !isInboxId(p.id) && !isArchivedProject(view, p.id) && (!favoritesOnly || p.is_favorite));
    const found = plan.beforeId ? list.findIndex((p) => p.id === plan.beforeId) : -1;
    const at = found < 0 ? list.length : found;
    return { position: list.slice(0, at).filter((p) => visible.includes(p)).length + 1, count: visible.length + 1 };
  };
  const done = (plan, extra) => ({ plan, ...extra, ...place(plan) });

  if (command === 'up') return prev ? done({ parent_id, beforeId: prev.id }, { kind: 'moved' }) : { blocked: 'first' };
  if (command === 'down') {
    if (!next) return { blocked: 'last' };
    const after = all.filter((p) => byOrder(p, next) > 0)[0];
    return done({ parent_id, beforeId: after?.id ?? null }, { kind: 'moved' });
  }
  if (favoritesOnly) return { blocked: 'unknown' };
  if (command === 'indent') {
    if (!prev || !validParent(view, projectId, prev.id)) return { blocked: 'noPrevious' };
    return done({ parent_id: prev.id, beforeId: null }, { kind: 'indented', parent: prev.name });
  }
  if (command === 'outdent') {
    const parent = parent_id ? view.projects.get(parent_id) : null;
    if (!parent) return { blocked: 'noParent' };
    const target = parent.parent_id ?? null;
    const aunts = projectSiblings(view, target, projectId);
    const i = aunts.findIndex((p) => p.id === parent.id);
    return done({ parent_id: target, beforeId: aunts[i + 1]?.id ?? null }, { kind: 'outdented', parent: parent.name });
  }
  return { blocked: 'unknown' };
}

// ---------- bord: kaarten tussen kolommen ----------

/** Een kolom van het bord is een sectie (of "zonder sectie"); `columnScope` controleert dat sectie en project bij elkaar horen. */
function columnScope(view, projectId, sectionId) {
  if (!view.projects.has(projectId)) return null;
  if (sectionId && view.sections.get(sectionId)?.project_id !== projectId) return null;
  return { project_id: projectId, section_id: sectionId ?? null, parent_id: null };
}

/**
 * Loslaten op een kaart in een kolom van het bord: erboven of eronder (`zone`), altijd op het hoogste niveau van die kolom. Een
 * kaart kan geen subtaak van een andere kaart worden (daar is de lijst voor), anders dan bij `planTaskDrop`.
 * @returns {{ project_id: string, section_id: string | null, parent_id: null, beforeId: string | null } | null}
 */
export function planCardDrop(view, { dragId, overId, zone, projectId, sectionId = null }) {
  const drag = view.tasks.get(dragId);
  const scope = columnScope(view, projectId, sectionId);
  if (!drag || !scope || dragId === overId || !view.tasks.has(overId) || (zone !== 'before' && zone !== 'after')) return null;
  const siblings = taskSiblings(view, scope, dragId);
  const i = siblings.findIndex((t) => t.id === overId);
  if (i < 0) return null;
  return finishTask(view, drag, { ...scope, beforeId: zone === 'before' ? overId : siblings[i + 1]?.id ?? null });
}

/**
 * Een kaart met het toetsenbord verplaatsen: 'up' en 'down' binnen de kolom (aan de rand gebeurt niets, anders dan in de lijst: een
 * andere kolom kiest je met links en rechts), 'outdent' (pijl links) en 'indent' (pijl rechts) naar de kolom ernaast, op dezelfde
 * hoogte als de kaart nu staat (of onderaan als die kolom korter is).
 * Geeft `{ plan, kind: 'moved', container, position, count }`, of `{ blocked }`: 'first', 'last', 'noColumnBefore', 'noColumnAfter', 'gone'.
 */
export function planCardKey(view, taskId, command, { isVisible = (t) => !t.checked } = {}) {
  const task = view.tasks.get(taskId);
  if (!task || task.parent_id) return { blocked: 'gone' };
  const groups = taskGroups(view, task.project_id);
  const sectionId = view.sections.has(task.section_id) && !view.sections.get(task.section_id).is_archived ? task.section_id : null;
  const g = groups.findIndex((x) => x.id === sectionId);
  const scope = { project_id: task.project_id, section_id: sectionId, parent_id: null };
  const all = taskSiblings(view, scope, taskId);
  const shown = all.filter(isVisible);
  const before = shown.filter((t) => byOrder(t, task) < 0);
  const done = (plan, container) => ({ plan, kind: 'moved', container, ...positionIn(view, plan, taskId, isVisible) });

  if (command === 'up') {
    const prev = before.at(-1);
    return prev ? done({ ...scope, beforeId: prev.id }, groups[g].name) : { blocked: 'first' };
  }
  if (command === 'down') {
    const next = shown.find((t) => !before.includes(t));
    if (!next) return { blocked: 'last' };
    const after = all.filter((t) => byOrder(t, next) > 0)[0];
    return done({ ...scope, beforeId: after?.id ?? null }, groups[g].name);
  }
  if (command === 'outdent' || command === 'indent') {
    const to = groups[g + (command === 'indent' ? 1 : -1)];
    if (!to) return { blocked: command === 'indent' ? 'noColumnAfter' : 'noColumnBefore' };
    const target = { project_id: task.project_id, section_id: to.id, parent_id: null };
    const there = taskSiblings(view, target, taskId).filter(isVisible);
    return done({ ...target, beforeId: there[before.length]?.id ?? null }, to.name);
  }
  return { blocked: 'unknown' };
}

// ---------- kalender: een taak naar een andere dag ----------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Loslaten van een taak op een dag van de kalender: de datum wordt die dag. Het tijdstip blijft, en bij een herhaling schuift alleen
 * de huidige datum (de herhaling zelf blijft zoals ze was; zie `reschedule`). Geen datum, een afgevinkte taak, of dezelfde dag geven null.
 * @returns {{ date: string, due: object } | null}
 */
export function planDayDrop(view, { dragId, date }) {
  const task = view.tasks.get(dragId);
  if (!task || task.checked || !task.due || !DAY_RE.test(date) || task.due.date.slice(0, 10) === date) return null;
  return { date, due: reschedule(task.due, date) };
}

/** Een taak met het toetsenbord een dag of week verzetten: pijl links en rechts (een dag), omhoog en omlaag (een week). */
export function planDayKey(view, taskId, command) {
  const task = view.tasks.get(taskId);
  const days = { outdent: -1, indent: 1, up: -7, down: 7 }[command];
  if (!task || !task.due || task.checked || !days) return { blocked: 'gone' };
  const date = addDays(task.due.date.slice(0, 10), days);
  return { plan: { date, due: reschedule(task.due, date) }, kind: 'day', date };
}
