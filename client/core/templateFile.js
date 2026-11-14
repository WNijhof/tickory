// Sjablonen delen via een bestand: exporteren als JSON en importeren van JSON (het formaat van Tickory) of van het CSV-sjabloon van
// Todoist. Een bestand komt van buiten en is onbetrouwbare invoer: het wordt streng gelezen en gecontroleerd (grootte, structuur,
// lengtes, diepte, onbekende velden), er wordt niets uitgevoerd of opgehaald, en tekst blijft tekst (nooit HTML).
// Zie SPEC.md, hoofdstuk 5c.

import { TEMPLATE_KINDS, TEMPLATE_LIMITS, TEMPLATE_VERSION, checkTemplateContent, templateDescriptionProblem, templateNameProblem, templateStats } from '../../shared/template.js';
import { deepNormalize, nameKey, normalizeText } from '../../shared/text.js';
import { DEFAULT_COLOR, colorName } from './colors.js';

export const FILE_FORMAT = 'tickory-template';
const FILE_KEYS = ['format', 'version', 'name', 'kind', 'description', 'color', 'content'];
const MAX_CSV_ROWS = 5000;

/** De bestandsnaam bij het bewaren: "tickory-template-verhuizen.json" (zonder accenten, spaties en vreemde tekens). */
export function templateFileName(name) {
  const slug = normalizeText(String(name ?? '')).normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `tickory-template-${slug || 'sjabloon'}.json`;
}

/** Het sjabloon als tekst voor een bestand (JSON, leesbaar ingesprongen). */
export function exportTemplate(template) {
  const out = {
    format: FILE_FORMAT, version: TEMPLATE_VERSION, name: template.name, kind: template.kind,
    description: template.description ?? '', color: colorName(template.color), content: template.content,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Fout bij het lezen: `code` voor de interface, `detail` is de technische reden (Nederlands, zonder de inhoud te herhalen). */
const fail = (code, detail = '') => ({ ok: false, code, detail });

/**
 * Leest de tekst van een bestand als sjabloon.
 * @param {string} text de inhoud van het bestand
 * @param {{ fallbackName?: string }} [options] de naam voor een bestand zonder eigen naam (bijvoorbeeld de bestandsnaam bij CSV)
 * @returns {{ ok: true, template: { name: string, kind: string, description: string, color: string, content: object }, notes: { dates?: number, comments?: number, skipped?: number } }
 *   | { ok: false, code: 'empty' | 'tooBig' | 'notJson' | 'unsupported' | 'invalid' | 'tooMany', detail: string }}
 */
export function parseTemplateFile(text, { fallbackName = '' } = {}) {
  if (typeof text !== 'string') return fail('invalid', 'geen tekst');
  const body = text.replace(/^\uFEFF/, '');
  if (body.trim() === '') return fail('empty');
  if (new TextEncoder().encode(body).length > TEMPLATE_LIMITS.fileBytes) return fail('tooBig');
  return body.trimStart().startsWith('{') ? parseJson(body) : parseCsv(body, fallbackName);
}

// ---------- JSON ----------

function parseJson(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return fail('notJson');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return fail('invalid', 'het bestand moet een object zijn');
  for (const k of Object.keys(data)) if (!FILE_KEYS.includes(k)) return fail('invalid', `onbekend veld "${k}"`);
  if (data.format !== FILE_FORMAT) return fail('invalid', 'dit is geen sjabloon van Tickory');
  if (data.version !== TEMPLATE_VERSION) return fail('unsupported', `versie ${String(data.version).slice(0, 20)}`);
  if (!TEMPLATE_KINDS.includes(data.kind)) return fail('invalid', 'kind moet project of task zijn');
  if (data.color !== undefined && typeof data.color !== 'string') return fail('invalid', 'color moet tekst zijn');
  const name = typeof data.name === 'string' ? normalizeText(data.name).trim() : data.name;
  const nameProblem = templateNameProblem(name);
  if (nameProblem) return fail('invalid', `name: ${nameProblem}`);
  const description = data.description === undefined ? '' : data.description;
  const descriptionProblem = templateDescriptionProblem(description);
  if (descriptionProblem) return fail('invalid', `description: ${descriptionProblem}`);
  // eerst op de ruwe inhoud controleren (dan zijn onbekende velden nog te zien), daarna in NFC zetten en nog eens
  const raw = checkTemplateContent(data.content);
  if (raw) return fail(raw.startsWith('te groot') ? 'tooBig' : 'invalid', `content: ${raw}`);
  let content;
  try {
    content = deepNormalize(data.content);
  } catch {
    return fail('invalid', 'content: te diep genest');
  }
  const again = checkTemplateContent(content);
  if (again) return fail('invalid', `content: ${again}`);
  if (templateStats(content).tasks > TEMPLATE_LIMITS.tasks) return fail('tooMany', String(TEMPLATE_LIMITS.tasks));
  return { ok: true, template: { name, kind: data.kind, description: normalizeText(description), color: colorName(data.color), content }, notes: {} };
}

// ---------- CSV (het sjabloon van Todoist) ----------

/** Splitst CSV in rijen van velden (aanhalingstekens, "" als aanhalingsteken, regeleinden binnen een veld). Geeft null bij te veel rijen. */
function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_CSV_ROWS) return null;
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows.length > MAX_CSV_ROWS ? null : rows;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const tidy = (s) => normalizeText(String(s ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, ' '));

/**
 * Het CSV-sjabloon van Todoist: kolommen TYPE, CONTENT, DESCRIPTION, PRIORITY, INDENT, AUTHOR, RESPONSIBLE, DATE, DATE_LANG, TIMEZONE.
 * Regels `task` en `section` komen mee (INDENT geeft de subtaken, PRIORITY 1 tot 4 zoals in Todoist). Opmerkingen (`note`),
 * auteurs, verantwoordelijken en datums niet: een datum is daar vrije tekst in de taal van DATE_LANG, en wordt niet geraden.
 */
function parseCsv(body, fallbackName) {
  const rows = csvRows(body);
  if (rows === null) return fail('tooMany', String(MAX_CSV_ROWS));
  const header = (rows[0] ?? []).map((x) => x.trim().toUpperCase());
  const col = (name) => header.indexOf(name);
  if (col('TYPE') < 0 || col('CONTENT') < 0) return fail('invalid', 'dit is geen JSON-sjabloon van Tickory en geen CSV met de kolommen TYPE en CONTENT');
  const at = (row, name) => (col(name) < 0 ? '' : row[col(name)] ?? '');
  const notes = { dates: 0, comments: 0, skipped: 0 };
  const top = [];
  const sections = [];
  let current = top;
  let stack = []; // de laatste taak per niveau, voor de subtaken
  let tasks = 0;
  for (const row of rows.slice(1)) {
    const type = at(row, 'TYPE').trim().toLowerCase();
    if (type === 'section') {
      const name = tidy(at(row, 'CONTENT')).replace(/\n/g, ' ').trim();
      if (!name) { notes.skipped++; continue; }
      let section = sections.find((x) => nameKey(x.name) === nameKey(name)); // dezelfde sectienaam twee keer: één sectie
      if (!section) {
        section = { name, tasks: [] };
        sections.push(section);
      }
      current = section.tasks;
      stack = [];
    } else if (type === 'task') {
      const content = tidy(at(row, 'CONTENT')).replace(/\n/g, ' ').trim();
      if (!content) { notes.skipped++; continue; }
      const task = { content };
      const description = tidy(at(row, 'DESCRIPTION')).trim();
      if (description) task.description = description;
      const priority = Number(at(row, 'PRIORITY').trim());
      if (Number.isInteger(priority) && priority >= 1 && priority < 4) task.priority = priority;
      if (at(row, 'DATE').trim()) notes.dates++;
      const indent = Math.max(1, Math.min(TEMPLATE_LIMITS.depth, Math.floor(Number(at(row, 'INDENT').trim())) || 1));
      const level = Math.min(indent, stack.length + 1); // een sprong van 1 naar 3 wordt een subtaak op niveau 2
      const list = level === 1 ? current : (stack[level - 2].subtasks ??= []);
      list.push(task);
      stack = [...stack.slice(0, level - 1), task];
      tasks++;
    } else if (type === 'note') notes.comments++;
    else notes.skipped++;
  }
  if (tasks === 0) return fail('invalid', 'het bestand bevat geen taken');
  if (tasks > TEMPLATE_LIMITS.tasks) return fail('tooMany', String(TEMPLATE_LIMITS.tasks));
  const content = { v: TEMPLATE_VERSION, tasks: top, sections };
  const problem = checkTemplateContent(content);
  if (problem) return fail(problem.startsWith('te groot') ? 'tooBig' : 'invalid', problem);
  const name = tidy(fallbackName).replace(/\n/g, ' ').trim().slice(0, TEMPLATE_LIMITS.templateName);
  return { ok: true, template: { name: name || 'Todoist', kind: 'project', description: '', color: DEFAULT_COLOR, content }, notes };
}
