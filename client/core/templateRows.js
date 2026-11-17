// Een sjabloon als regels, voor het bewerkscherm (ui/templateEditor.js): eerst de taken zonder sectie, dan per sectie een kopregel
// met haar taken; een taak heeft een niveau (1 = bovenaan, 2 = subtaak, …). Zonder scherm, getest. De velden die het scherm niet
// toont (labels, beschrijving, duur, herhaling) blijven bij hun taak bewaard.

import { TEMPLATE_LIMITS, TEMPLATE_VERSION } from '../../shared/template.js';

/**
 * @typedef {{ kind: 'section', name: string } | { kind: 'task', depth: number, task: object }} TemplateRow
 */

/** Van inhoud naar regels. @returns {TemplateRow[]} */
export function templateToRows(content) {
  const rows = [];
  const add = (list, depth) => {
    for (const task of list ?? []) {
      const { subtasks, ...rest } = task;
      rows.push({ kind: 'task', depth, task: structuredClone(rest) });
      add(subtasks, depth + 1);
    }
  };
  add(content?.tasks, 1);
  for (const section of content?.sections ?? []) {
    rows.push({ kind: 'section', name: section.name });
    add(section.tasks, 1);
  }
  return rows;
}

/**
 * Van regels terug naar inhoud. Een niveau kan nooit meer dan één dieper zijn dan de regel erboven (en niet dieper dan het
 * maximum); een taak zonder tekst valt weg. Een tijd zonder dag krijgt dag 0, en zonder tijd vallen de herinneringen weg (die horen
 * bij een tijd).
 */
export function rowsToTemplate(rows) {
  const content = { v: TEMPLATE_VERSION, tasks: [], sections: [] };
  let top = content.tasks;
  let path = []; // path[i] = de laatste taak op niveau i + 1
  for (const row of rows) {
    if (row.kind === 'section') {
      const section = { name: String(row.name ?? '').trim(), tasks: [] };
      content.sections.push(section);
      top = section.tasks;
      path = [];
      continue;
    }
    const text = String(row.task?.content ?? '').trim();
    if (!text) continue;
    const depth = Math.max(1, Math.min(Number(row.depth) || 1, path.length + 1, TEMPLATE_LIMITS.depth));
    const node = { ...structuredClone(row.task), content: text };
    delete node.subtasks;
    if (node.time !== undefined && node.day === undefined) node.day = 0;
    if (node.time === undefined) delete node.reminders;
    if (Array.isArray(node.reminders) && node.reminders.length === 0) delete node.reminders;
    const list = depth === 1 ? top : (path[depth - 2].subtasks ??= []);
    list.push(node);
    path = path.slice(0, depth - 1);
    path[depth - 1] = node;
  }
  return content;
}

/** Een regel een niveau in of uit: niet dieper dan één onder de regel erboven, en niet ondieper dan 1. Geeft de nieuwe regels. */
export function shiftRow(rows, index, delta) {
  const row = rows[index];
  if (!row || row.kind !== 'task') return rows;
  const above = rows[index - 1];
  const max = above?.kind === 'task' ? Math.min(above.depth + 1, TEMPLATE_LIMITS.depth) : 1;
  const depth = Math.max(1, Math.min(row.depth + delta, max));
  if (depth === row.depth) return rows;
  return rows.map((r, i) => (i === index ? { ...r, depth } : r));
}

/** Een regel een plek omhoog (-1) of omlaag (+1). Geeft de nieuwe regels (of dezelfde als het niet kan). */
export function moveRow(rows, index, delta) {
  const to = index + delta;
  if (to < 0 || to >= rows.length) return rows;
  const out = [...rows];
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}
