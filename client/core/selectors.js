// Leest overzichten uit de lokale toestand: wat staat er in een project, wat is er vandaag, wat komt eraan.
// Alleen lezen, geen wijzigingen.

import { isInboxId } from '../../shared/schema.js';
import { settingsId } from '../../shared/schema.js';
import { isLocationActive, reminderMoment } from '../../shared/reminders.js';
import { addDays } from './format.js';

export const byOrder = (a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const dueDay = (t) => t.due.date.slice(0, 10);
/** Volgorde in datumoverzichten: eerst op tijdstip, dan op prioriteit (1 = hoogst), dan op eigen volgorde. */
const byDue = (a, b) => (a.due.date < b.due.date ? -1 : a.due.date > b.due.date ? 1 : a.priority - b.priority || byOrder(a, b));

/**
 * Is dit project gearchiveerd, of staat het onder een gearchiveerd project? Zo'n project verdwijnt uit de zijbalk
 * (bij archiveren gaat de hele tak mee; dit vangt ook een subproject af dat op een ander apparaat is gemaakt).
 */
export function isArchivedProject(view, projectId) {
  let p = view.projects.get(projectId);
  for (let i = 0; p && i < 1000; i++) {
    if (p.is_archived) return true;
    p = p.parent_id ? view.projects.get(p.parent_id) : undefined;
  }
  return false;
}

/** Projecten als boom, platgeslagen met inspringniveau: de Inbox eerst, daarna op volgorde. `include` kiest welke projecten meedoen. */
function projectTreeList(view, include) {
  const children = new Map();
  for (const p of view.projects.values()) {
    if (!include(p)) continue;
    const key = p.parent_id && view.projects.has(p.parent_id) && include(view.projects.get(p.parent_id)) ? p.parent_id : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(p);
  }
  const out = [];
  const walk = (parentId, depth) => {
    const list = (children.get(parentId) ?? []).sort((a, b) => (isInboxId(a.id) ? -1 : isInboxId(b.id) ? 1 : byOrder(a, b)));
    for (const p of list) {
      out.push({ project: p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Projecten als platte lijst met inspringniveau: de Inbox eerst, daarna op volgorde; gearchiveerde projecten (met hun subprojecten) niet. */
export function projectList(view) {
  const memo = new Map();
  const hidden = (p) => {
    if (!memo.has(p.id)) memo.set(p.id, isArchivedProject(view, p.id));
    return memo.get(p.id);
  };
  return projectTreeList(view, (p) => !hidden(p));
}

/** De gearchiveerde projecten (en wat eronder hangt) als lijst met inspringniveau, om terug te zetten. */
export function archivedList(view) {
  return projectTreeList(view, (p) => isArchivedProject(view, p.id)).filter(({ project }) => !isInboxId(project.id));
}

/** Alle subprojecten (alle niveaus) van een project, zonder het project zelf. */
export function projectDescendantIds(view, projectId) {
  const out = [];
  const todo = [projectId];
  while (todo.length > 0) {
    const id = todo.pop();
    for (const p of view.projects.values()) {
      if (p.parent_id === id && p.id !== projectId && !out.includes(p.id)) {
        out.push(p.id);
        todo.push(p.id);
      }
    }
  }
  return out;
}

/**
 * De projecten voor de zijbalk onder "Projecten": zonder de Inbox (die staat bovenaan), met per project of er subprojecten
 * zijn en of die ingeklapt zijn (`is_collapsed`); de subprojecten van een ingeklapt project staan er niet in.
 * @returns {{ project: object, depth: number, hasChildren: boolean, collapsed: boolean }[]}
 */
export function navProjects(view) {
  const all = projectList(view).filter(({ project }) => !isInboxId(project.id));
  const out = [];
  let hideBelow = null; // zolang gezet: rijen dieper dan dit niveau zijn verborgen
  for (let i = 0; i < all.length; i++) {
    const { project, depth } = all[i];
    if (hideBelow !== null && depth > hideBelow) continue;
    hideBelow = null;
    const hasChildren = (all[i + 1]?.depth ?? 0) > depth;
    const collapsed = hasChildren && Boolean(project.is_collapsed);
    out.push({ project, depth, hasChildren, collapsed });
    if (collapsed) hideBelow = depth;
  }
  return out;
}

/** Favoriete projecten (niet gearchiveerd) in de volgorde van de projectenboom. */
export const favoriteProjects = (view) => projectList(view).map((x) => x.project).filter((p) => p.is_favorite && !isInboxId(p.id));

/** Taken als boom, platgeslagen met inspringniveau. Een taak zonder zichtbare ouder in de lijst staat op het hoogste niveau. */
function tree(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map();
  for (const t of tasks) {
    const key = t.parent_id && ids.has(t.parent_id) ? t.parent_id : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(t);
  }
  const out = [];
  const walk = (parentId, depth) => {
    for (const t of (children.get(parentId) ?? []).sort(byOrder)) {
      out.push({ task: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * Eén project: de taken zonder sectie, gevolgd door elke sectie met haar taken.
 * @returns {{ project: object, groups: { section: object | null, tasks: { task: object, depth: number }[] }[], completedCount: number } | null}
 */
export function projectView(view, projectId, { showCompleted = false } = {}) {
  const project = view.projects.get(projectId);
  if (!project) return null;
  const all = [...view.tasks.values()].filter((t) => t.project_id === projectId);
  const visible = showCompleted ? all : all.filter((t) => !t.checked);
  const sections = [...view.sections.values()].filter((s) => s.project_id === projectId && !s.is_archived).sort(byOrder);
  const known = new Set(sections.map((s) => s.id));
  const inSection = (id) => visible.filter((t) => (known.has(t.section_id) ? t.section_id : null) === id);
  const groups = [{ section: null, tasks: tree(inSection(null)) }, ...sections.map((s) => ({ section: s, tasks: tree(inSection(s.id)) }))];
  return { project, groups, completedCount: all.filter((t) => t.checked).length };
}

/** Vandaag: wat te laat is en wat vandaag moet. */
export function todayView(view, today) {
  const open = [...view.tasks.values()].filter((t) => !t.checked && t.due);
  return {
    overdue: open.filter((t) => dueDay(t) < today).sort(byDue),
    today: open.filter((t) => dueDay(t) === today).sort(byDue),
  };
}

/** Binnenkort: de komende `days` dagen (vanaf morgen), per dag; dagen zonder taken worden overgeslagen. */
export function upcomingView(view, today, days = 14) {
  const last = addDays(today, days);
  const perDay = new Map();
  for (const t of view.tasks.values()) {
    if (t.checked || !t.due) continue;
    const day = dueDay(t);
    if (day <= today || day > last) continue;
    if (!perDay.has(day)) perDay.set(day, []);
    perDay.get(day).push(t);
  }
  return [...perDay.keys()].sort().map((date) => ({ date, tasks: perDay.get(date).sort(byDue) }));
}

/** Aantallen openstaande taken voor de zijbalk. */
export function counts(view, today) {
  const perProject = new Map();
  let dueToday = 0;
  for (const t of view.tasks.values()) {
    if (t.checked) continue;
    perProject.set(t.project_id, (perProject.get(t.project_id) ?? 0) + 1);
    if (t.due && dueDay(t) <= today) dueToday += 1;
  }
  return { today: dueToday, perProject };
}

// ---- opmerkingen en subtaken ----

/** Oudste eerst; bij gelijke tijd op id, zodat de volgorde overal gelijk is. */
const byCreated = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** De opmerkingen bij een taak (`{ taskId }`) of een project (`{ projectId }`), oudste eerst. */
export function commentsOf(view, { taskId = null, projectId = null }) {
  if (!taskId && !projectId) return [];
  return [...view.comments.values()].filter((c) => (taskId ? c.task_id === taskId : c.project_id === projectId)).sort(byCreated);
}

/** Het aantal opmerkingen per taak, voor de tellers in de lijst. Taken zonder opmerkingen staan er niet in. */
export function commentCounts(view) {
  const out = new Map();
  for (const c of view.comments.values()) if (c.task_id) out.set(c.task_id, (out.get(c.task_id) ?? 0) + 1);
  return out;
}

/** De bijlagen bij een taak, oudste eerst. */
export function attachmentsOf(view, taskId) {
  return [...(view.attachments?.values() ?? [])].filter((a) => a.task_id === taskId).sort(byCreated);
}

/** Het aantal bijlagen per taak, voor de tellers in de lijst. Taken zonder bijlagen staan er niet in. */
export function attachmentCounts(view) {
  const out = new Map();
  for (const a of view.attachments?.values() ?? []) out.set(a.task_id, (out.get(a.task_id) ?? 0) + 1);
  return out;
}

/** Het aantal opmerkingen bij een project. */
export const projectCommentCount = (view, projectId) => commentsOf(view, { projectId }).length;

/** Per taak met subtaken: hoeveel directe subtaken er zijn en hoeveel daarvan af zijn (voor "1/3"). */
export function subtaskCounts(view) {
  const out = new Map();
  for (const t of view.tasks.values()) {
    if (!t.parent_id) continue;
    const c = out.get(t.parent_id) ?? { done: 0, total: 0 };
    c.total += 1;
    if (t.checked) c.done += 1;
    out.set(t.parent_id, c);
  }
  return out;
}

/** De directe subtaken van een taak, op volgorde (ook de afgeronde). */
export const subtasksOf = (view, taskId) => [...view.tasks.values()].filter((t) => t.parent_id === taskId).sort(byOrder);

/**
 * Past het in- en uitklappen van taken toe op een lijst `{ task, depth }` (zoals projectView die geeft): de subtaken van een
 * ingeklapte taak (`is_collapsed`) verdwijnen. Elke rij weet of ze subtaken heeft en of ze ingeklapt is.
 * @template {{ task: object, depth: number }} T
 * @param {T[]} rows
 * @returns {(T & { hasChildren: boolean, collapsed: boolean })[]}
 */
export function foldRows(rows) {
  const out = [];
  let hideBelow = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (hideBelow !== null && row.depth > hideBelow) continue;
    hideBelow = null;
    const hasChildren = (rows[i + 1]?.depth ?? 0) > row.depth;
    const collapsed = hasChildren && Boolean(row.task.is_collapsed);
    out.push({ ...row, hasChildren, collapsed });
    if (collapsed) hideBelow = row.depth;
  }
  return out;
}

// ---- delen ----

/** De leden van een project (rijen uit `members`), eigenaren eerst. */
export function membersOf(view, projectId) {
  return [...view.members.values()]
    .filter((m) => m.project_id === projectId)
    .sort((a, b) => (a.role === b.role ? (a.user_id < b.user_id ? -1 : 1) : a.role === 'owner' ? -1 : 1));
}

/** 'owner', 'member', of null als de gebruiker er geen lid van is. */
export const roleIn = (view, projectId, userId) => membersOf(view, projectId).find((m) => m.user_id === userId)?.role ?? null;

/** Een project met meer dan één lid is gedeeld. */
export const isShared = (view, projectId) => membersOf(view, projectId).length > 1;

/** Een label van iemand anders (je ziet het omdat het op een taak in een gedeeld project staat). */
export const isForeignLabel = (label, userId) => Boolean(userId && label.owner_id && label.owner_id !== userId);

// ---- herinneringen en instellingen ----

/** Je persoonlijke instellingen; standaardwaarden zolang de server ze nog niet heeft gestuurd. */
/** Je eigen plaatsen, op naam (zonder hoofdletters). */
export function placeList(view, userId) {
  return [...view.places.values()]
    .filter((p) => !p.owner_id || !userId || p.owner_id === userId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));
}

export const mySettings = (view, userId) => view.settings.get(settingsId(userId)) ?? { auto_reminder: 30, timezone: null };

/**
 * Je eigen herinneringen bij een taak, met het (zwevende) tijdstip waarop ze afgaan; `moment` is null als een herinnering
 * nu niets doet (bijvoorbeeld "30 minuten vooraf" bij een taak zonder tijd). Op volgorde van afgaan, slapende achteraan.
 * @returns {{ reminder: object, moment: string | null }[]}
 */
export function remindersOf(view, taskId, userId) {
  const task = view.tasks.get(taskId);
  return [...view.reminders.values()]
    .filter((r) => r.task_id === taskId && (!r.owner_id || !userId || r.owner_id === userId))
    .map((reminder) => ({ reminder, moment: reminderMoment(reminder, task) }))
    .sort((a, b) => (a.moment === b.moment ? (a.reminder.id < b.reminder.id ? -1 : 1) : a.moment === null ? 1 : b.moment === null ? -1 : a.moment < b.moment ? -1 : 1));
}

/** Heeft deze taak een herinnering van jou die nog gaat afgaan of kan afgaan? (voor het belletje in de lijst) */
export const hasReminder = (view, taskId, userId) => remindersOf(view, taskId, userId).some((x) => x.moment !== null || isLocationActive(x.reminder, view.tasks.get(taskId)));

/** De taken waar je een herinnering voor hebt die nog kan afgaan, in één keer voor de hele lijst (zelfde uitkomst als hasReminder, veel sneller). */
export function tasksWithReminder(view, userId) {
  const out = new Set();
  for (const r of view.reminders.values()) {
    if ((r.owner_id && userId && r.owner_id !== userId) || out.has(r.task_id)) continue;
    const task = view.tasks.get(r.task_id);
    if (reminderMoment(r, task) !== null || isLocationActive(r, task)) out.add(r.task_id);
  }
  return out;
}

// ---- filters en labels beheren ----

/** Je eigen filters, op volgorde. (Een filter van iemand anders zie je niet; dit is voor de zekerheid.) */
export function filterList(view, userId) {
  return [...view.filters.values()].filter((f) => !isForeignLabel(f, userId)).sort(byOrder);
}

/**
 * Labels met het aantal open taken waar ze op staan: je eigen labels (op volgorde) en apart de labels van anderen die je
 * ziet omdat ze op een taak in een gedeeld project staan (alleen lezen).
 * @returns {{ own: { label: object, openCount: number }[], others: { label: object, openCount: number }[] }}
 */
export function labelList(view, userId) {
  const open = new Map();
  for (const t of view.tasks.values()) {
    if (t.checked) continue;
    for (const id of t.labels ?? []) open.set(id, (open.get(id) ?? 0) + 1);
  }
  const out = { own: [], others: [] };
  for (const label of [...view.labels.values()].sort(byOrder)) {
    (isForeignLabel(label, userId) ? out.others : out.own).push({ label, openCount: open.get(label.id) ?? 0 });
  }
  return out;
}
