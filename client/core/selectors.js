// Leest overzichten uit de lokale toestand: wat staat er in een project, wat is er vandaag, wat komt eraan.
// Alleen lezen, geen wijzigingen.

import { INBOX_ID } from '../../shared/schema.js';
import { addDays } from './format.js';

export const byOrder = (a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const dueDay = (t) => t.due.date.slice(0, 10);
/** Volgorde in datumoverzichten: eerst op tijdstip, dan op prioriteit (1 = hoogst), dan op eigen volgorde. */
const byDue = (a, b) => (a.due.date < b.due.date ? -1 : a.due.date > b.due.date ? 1 : a.priority - b.priority || byOrder(a, b));

/** Projecten als platte lijst met inspringniveau: de Inbox eerst, daarna op volgorde; gearchiveerde projecten niet. */
export function projectList(view) {
  const children = new Map();
  for (const p of view.projects.values()) {
    if (p.is_archived) continue;
    const key = p.parent_id && view.projects.has(p.parent_id) ? p.parent_id : null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(p);
  }
  const out = [];
  const walk = (parentId, depth) => {
    const list = (children.get(parentId) ?? []).sort((a, b) => (a.id === INBOX_ID ? -1 : b.id === INBOX_ID ? 1 : byOrder(a, b)));
    for (const p of list) {
      out.push({ project: p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

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
