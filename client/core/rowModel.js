// Wat er in één regel van de takenlijst te zien is, als gewone gegevens (geen scherm). De interface (ui/render.js) tekent
// er de regel bij, en bewaart de getekende regel zolang deze gegevens gelijk blijven: een lijst van tweeduizend taken
// hoeft dan na een wijziging alleen de regels opnieuw te tekenen die echt anders zijn.

import { formatDuration } from './duration.js';
import { dueStatus, formatDate, formatDue } from './format.js';
import { t } from './i18n.js';
import { colorName } from './colors.js';

/** Hoeveel tekens van de beschrijving onder de titel staan; CSS kapt daarna nog af op de breedte. */
export const DESCRIPTION_CHARS = 160;

/** De eerste regel met tekst van een beschrijving, met samengevouwen witruimte en zo nodig afgekapt met een beletselteken. */
export function descriptionLine(text) {
  const line = String(text ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return line.length > DESCRIPTION_CHARS ? `${line.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…` : line;
}

/** Initialen voor het rondje bij een naam: de eerste letter van de eerste en de laatste naam ("Anna de Vries" wordt "AV"). */
export function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words.at(-1)][0] : '';
  return `${first}${last}`.toLocaleUpperCase();
}

/**
 * @param {object} task
 * @param {{
 *   view: { projects: Map<string, object>, sections: Map<string, object>, labels: Map<string, object> },
 *   today: string, now: string,
 *   depth?: number, showProject?: boolean, hasChildren?: boolean, collapsed?: boolean,
 *   subtasks?: Map<string, { done: number, total: number }>, comments?: Map<string, number>, attachments?: Map<string, number>,
 *   reminder?: boolean, me?: { id: string, name?: string } | null, userName?: (id: string) => string | null,
 *   readOnly?: boolean,   // de taak staat in een project dat je alleen leest (core/access.js): geen afvinken, slepen of snelle knoppen
 * }} ctx
 */
export function rowModel(task, { view, today, now, depth = 0, showProject = false, hasChildren = false, collapsed = false, subtasks = new Map(), comments = new Map(), attachments = new Map(), reminder = false, me = null, userName = () => null, readOnly = false }) {
  const sub = subtasks.get(task.id);
  const labels = [];
  for (const id of task.labels ?? []) {
    const label = view.labels.get(id);
    if (label) labels.push({ id: label.id, name: label.name, color: colorName(label.color) });
  }
  let assignee = null;
  if (task.assignee_id) {
    const mine = task.assignee_id === me?.id;
    const name = mine ? t('task.assigneeYou') : userName(task.assignee_id) ?? t('common.someone');
    assignee = { mine, text: t('task.assigneeChip', { name }), title: t('task.assigneeTitle', { name }), initials: initials(mine ? me?.name ?? name : name) };
  }
  let project = null;
  if (showProject) {
    const p = view.projects.get(task.project_id);
    const section = task.section_id ? view.sections.get(task.section_id) : null;
    if (p) project = { name: section ? `${p.name} / ${section.name}` : p.name, color: colorName(p.color) };
  }
  return {
    id: task.id,
    content: task.content,
    description: descriptionLine(task.description),
    priority: task.priority,
    done: Boolean(task.checked),
    depth: Math.min(depth, 4),
    hasChildren,
    collapsed,
    due: task.due ? { text: formatDue(task.due, today), status: dueStatus(task.due, today, now), repeats: Boolean(task.due.recurrence) } : null,
    duration: task.duration ? { text: formatDuration(task.duration), minutes: task.duration } : null,
    deadline: task.deadline ? { text: t('task.deadlineChip', { date: formatDate(task.deadline, today) }), overdue: task.deadline < today } : null,
    subtasks: sub ? { done: sub.done, total: sub.total, text: `${sub.done}/${sub.total}`, label: t('task.subtasksLabel', { done: sub.done, total: sub.total }) } : null,
    comments: comments.get(task.id) ? { count: comments.get(task.id), label: t('task.commentsLabel', { count: comments.get(task.id) }) } : null,
    attachments: attachments.get(task.id) ? { count: attachments.get(task.id), label: t('task.attachmentsLabel', { count: attachments.get(task.id) }) } : null,
    labels,
    bell: Boolean(reminder),
    assignee,
    project,
    ...(readOnly ? { readOnly: true } : {}),
  };
}
