// Importeren uit Todoist (en uit de eigen export): bestanden lezen en omzetten in een tussenvorm van projecten met secties, taken,
// subtaken en opmerkingen, met per project wat er wel en niet mee kon. Het omzetten in commando's staat in core/importPlan.js,
// het venster in ui/importDialog.js; zie SPEC.md, hoofdstuk 5h.
//
// Wat binnenkomt:
// - de back-up van Todoist (een zip met per project een CSV in het sjabloonformaat), gelezen met core/zip.js;
// - losse CSV-bestanden in dat formaat (ook een CSV-sjabloon van Todoist), meerdere tegelijk;
// - de eigen export: de CSV met een kolom PROJECT (alle projecten in één bestand) en de JSON (`tickory-export`).
//
// Het CSV-formaat van Todoist (https://www.todoist.com/help/articles/format-a-csv-file-to-import-into-todoist-UVUXTmm6): een
// kopregel en dan per regel TYPE (task, section, note, meta), CONTENT, DESCRIPTION, PRIORITY, INDENT, AUTHOR, RESPONSIBLE, DATE,
// DATE_LANG, TIMEZONE, en in nieuwere versies DURATION, DURATION_UNIT, DEADLINE, DEADLINE_LANG (en IS_COLLAPSED bij secties).
// De kolommen worden op naam uit de kopregel gelezen, in elke volgorde; wat ontbreekt is leeg. Aannames, nagezocht:
// - PRIORITY gebruikt de schaal van het scherm van Todoist: 1 = p1 (hoogst) … 4 = p4 (geen). Dat zegt de documentatie
//   hierboven, en een echte export van Todoist zet 4 bij een gewone taak. Dat is dezelfde schaal als in Tickory, dus er wordt
//   niets omgedraaid. (De API van Todoist telt andersom, 4 = p1; dat getal komt niet in de CSV.) Een lege cel is hier "geen
//   prioriteit"; de documentatie zegt dat Todoist dan p1 geeft, maar andere programma's laten de cel leeg voor een gewone taak.
// - Een opmerking (note) hoort bij de taak erboven; staat er geen taak boven (direct na de kop of een sectie), dan bij het project.
//   Een bijlage in een opmerking staat er als `[[file {json}]]`: alleen de bestandsnaam komt mee, het bestand niet.
// - Labels staan als `@naam` in CONTENT. Een taak die met "* " begint kan in Todoist niet worden afgevinkt; dat teken valt weg.
// - DATE is vrije tekst in de taal van DATE_LANG: "nl" gaat via de Nederlandse herkenner, "en" (of leeg) via core/dateEn.js,
//   een ISO-datum werkt altijd. Wat niet herkend wordt komt als regel in de beschrijving ("Datum uit Todoist: …").
// - DURATION is een aantal in DURATION_UNIT ("minute" of "day"; "None" of leeg is geen duur).
// - AUTHOR en RESPONSIBLE ("Anna (1234567)") worden alleen getoond in de samenvatting, niet aan gebruikers gekoppeld.
// - De projectnaam komt uit de bestandsnaam (zonder map, uitgang en een id als " [2203306141]"). Heet een bestand "Werk - Klanten"
//   en is er precies één ander bestand "Werk", dan wordt het een subproject "Klanten" van "Werk"; anders blijft de naam zoals hij is.
//
// Alles is onbetrouwbare invoer: strikte controle, grenzen aan grootte, aantal, lengte en diepte, tekst blijft tekst (nooit HTML),
// er wordt niets opgehaald. De formule-bescherming van de eigen CSV-export (een ' voor = + - @) wordt bij het lezen weer weggehaald.

import { isValidDate, isValidRecurrence } from '../../shared/recurrence.js';
import { isInboxId } from '../../shared/schema.js';
import { nameKey, normalizeText } from '../../shared/text.js';
import { isColorName } from './colors.js';
import { parseDateEn } from './dateEn.js';
import { parseDateText } from './dateNl.js';
import { MAX_DURATION } from './duration.js';
import { getLanguage, t } from './i18n.js';
import { csvRows } from './templateFile.js';
import { looksLikeZip, readZip } from './zip.js';

export const IMPORT_LIMITS = Object.freeze({
  /** Bestanden (CSV en JSON, ook die uit een zip). */
  files: 1000,
  /** Grootte van één CSV- of JSON-bestand, en van alles samen. */
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  /** Regels in één CSV-bestand. */
  rows: 60_000,
  /** Projecten en taken in één import (de server staat er ook niet meer toe, zie server/limits.ts). */
  projects: 500,
  tasks: 50_000,
  /** Niveaus van taken: een taak met vier niveaus subtaken eronder, zoals in Todoist. Dieper wordt een broer op het diepste niveau. */
  depth: 5,
  /** Tekens, gelijk aan de velden op de server (shared/schema.js). */
  content: 4000,
  description: 16_000,
  projectName: 200,
  sectionName: 200,
  comment: 16_000,
  labelName: 100,
  labelsPerTask: 50,
  /** Opmerkingen per taak en per project (server/limits.ts: commentsPerParent). */
  comments: 500,
  /** Secties per project bij het lezen (de grens van de server, 200, bewaakt het plan). */
  sections: 1000,
  /** Namen van makers en verantwoordelijken die de samenvatting per project noemt. */
  people: 20,
});

const ZIP_ACCEPT = (name) => /\.(csv|json)$/i.test(name);

// ---------- tekst ----------

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
/** Unicode-vorm NFC, regeleinden als \n, stuurtekens eruit (vervangen door een spatie), halve tekens vervangen. */
function tidy(value) {
  const s = normalizeText(String(value ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, ' '));
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s;
}
/** Eén regel: geen regeleinden, enkele spaties. */
const line = (value) => tidy(value).replace(/\s+/g, ' ').trim();
/** Meerdere regels: spaties aan het eind van een regel en lege regels aan het begin en eind weg. */
const block = (value) => tidy(value).split('\n').map((l) => l.trimEnd()).join('\n').replace(/^\n+|\n+$/g, '');

/** Kort af tot `max` tekens, zonder een emoji doormidden te breken; geeft [tekst, ingekort?]. */
function cut(text, max) {
  if (text.length <= max) return [text, false];
  let s = text.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
  return [`${s.trimEnd()}…`, true];
}

/** "Anna (1234567)" wordt "Anna"; leeg blijft leeg. */
const personName = (value) => cut(line(value).replace(/\s*\(\d+\)\s*$/, ''), 100)[0];

// ---------- datums ----------

const DUTCH_DAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
const DUTCH_MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const DUTCH_NTH = { 1: 'eerste', 2: 'tweede', 3: 'derde', 4: 'vierde', '-1': 'laatste' };

/** Een herhaling als Nederlandse tekst die de herkenner van de app weer leest, of null als dat niet goed te zeggen is. */
export function dutchRepeatText(rec, date) {
  const bang = rec.fromCompletion ? '!' : '';
  const n = rec.interval ?? 1;
  const list = (days) => {
    const names = days.map((d) => DUTCH_DAYS[d - 1]);
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} en ${names.at(-1)}`;
  };
  let text = null;
  if (rec.freq === 'daily') text = n > 1 ? `elke${bang} ${n} dagen` : `elke${bang} dag`;
  else if (rec.freq === 'weekly' && !rec.byweekday) text = n > 1 ? `elke${bang} ${n} weken` : `elke${bang} week`;
  else if (rec.freq === 'weekly' && n === 1) text = rec.byweekday.join() === '1,2,3,4,5' ? `elke${bang} werkdag` : `elke${bang} ${list(rec.byweekday)}`;
  else if (rec.freq === 'monthly' && rec.nth !== undefined && n === 1) text = `elke${bang} ${DUTCH_NTH[rec.nth]} ${DUTCH_DAYS[rec.byweekday[0] - 1]}`;
  else if (rec.freq === 'monthly' && rec.bymonthday !== undefined) text = n > 1 ? `elke${bang} ${n} maanden op de ${rec.bymonthday}e` : `elke${bang} maand op de ${rec.bymonthday}e`;
  else if (rec.freq === 'yearly' && rec.bymonthday !== undefined && n === 1) text = `elk${bang} jaar op ${rec.bymonthday} ${DUTCH_MONTHS[Number(date.slice(5, 7)) - 1]}`;
  if (text && date.length > 10) text += ` om ${date.slice(11, 16)}`;
  return text;
}

const sameRule = (a, b) => {
  const keys = (r) => Object.keys(r).filter((k) => r[k] !== undefined).sort();
  return JSON.stringify(keys(a).map((k) => [k, a[k]])) === JSON.stringify(keys(b).map((k) => [k, b[k]]));
};

/**
 * Een datum uit de kolom DATE (of DEADLINE) als `due`, of null als die niet te lezen is. Is de app Engels, dan blijft een Engelse
 * herhaling Engels (het datumveld leest die zelf). In de Nederlandse app krijgt ze een Nederlandse tekst (zodat het datumveld hem
 * weer leest), maar alleen als de Nederlandse herkenner daar precies dezelfde regel uit haalt; anders blijft de Engelse tekst staan.
 * @returns {{ date: string, string?: string, lang?: string, recurrence?: object } | null}
 */
export function readDate(text, lang, now, appLanguage = getLanguage()) {
  // een back-up herhaalt dezelfde teksten ("every monday", "Jan 12") vaak: één keer uitrekenen per import (zelfde `now`)
  const key = JSON.stringify([now.getTime(), lang, text, appLanguage]);
  if (!dateCache.has(key)) {
    if (dateCache.size >= 5000) dateCache.clear();
    dateCache.set(key, readDateOnce(text, lang, now, appLanguage));
  }
  const due = dateCache.get(key);
  return due && structuredClone(due);
}
const dateCache = new Map();

function readDateOnce(text, lang, now, appLanguage) {
  const value = line(text);
  if (!value) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?Z?)?$/.exec(value);
  if (iso) {
    const date = iso[2] ? `${iso[1]}T${iso[2]}` : iso[1];
    return isValidDate(date) ? { date } : null;
  }
  const language = String(lang ?? '').trim().toLowerCase();
  let due = null;
  if (language === 'nl') due = parseDateText(value, now);
  else if (language === 'en' || language === '') due = parseDateEn(value, now) ?? (language === '' ? parseDateText(value, now) : null);
  if (!due || !isValidDate(due.date) || (due.recurrence && !isValidRecurrence(due.recurrence))) return null;
  if (!due.recurrence) return { date: due.date }; // een vaste datum: de tekst ("morgen") zegt later iets anders
  if (due.lang === 'nl') return { date: due.date, string: due.string.slice(0, 200), lang: 'nl', recurrence: due.recurrence };
  if (appLanguage === 'en') return { date: due.date, string: due.string.slice(0, 200), lang: 'en', recurrence: due.recurrence };
  const dutch = dutchRepeatText(due.recurrence, due.date);
  const check = dutch ? parseDateText(dutch, now) : null;
  if (check?.recurrence && sameRule(check.recurrence, due.recurrence) && check.date.slice(10) === due.date.slice(10)) {
    return { date: due.date, string: dutch, lang: 'nl', recurrence: due.recurrence };
  }
  return { date: due.date, string: due.string.slice(0, 200), lang: 'en', recurrence: due.recurrence };
}

// ---------- labels ----------

const LABEL_RE = /(?<![^\s])@([^\s@]+)/gu;

/** Haalt de labels (`@naam`) uit de titel. Een ongeldige naam blijft gewoon tekst. */
export function extractLabels(text) {
  const labels = [];
  const rest = text.replace(LABEL_RE, (whole, raw) => {
    const name = raw.replace(/[.,;:!?)\]}]+$/u, '');
    if (!name || name.length > IMPORT_LIMITS.labelName || name.includes(',') || labels.length >= IMPORT_LIMITS.labelsPerTask) return whole;
    if (!labels.some((l) => nameKey(l) === nameKey(name))) labels.push(name);
    return raw.slice(name.length);
  }).replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
  return { text: rest, labels };
}

// ---------- de tussenvorm ----------

let keyCounter = 0;
const newKey = () => `p${++keyCounter}`;

function newProject(name, source, fileName) {
  return {
    key: newKey(), name, parentKey: null, source, fileName, color: null, viewStyle: null, description: '',
    sections: [], tasks: [], comments: [],
    people: { authors: [], responsible: [] },
    stats: { tasks: 0, sections: 0, comments: 0, labels: [], dates: 0, deadlines: 0, durations: 0, attachments: 0, truncated: 0, flattened: 0, skippedRows: 0, commentsDropped: 0, completed: 0 },
  };
}

/** Telt een labelnaam bij het project (zonder dubbelen, hoofdletterongevoelig); de sleutels apart, zodat dat ook bij veel taken snel gaat. */
const labelKeys = new WeakMap();
function noteLabel(project, name) {
  if (!labelKeys.has(project)) labelKeys.set(project, new Set());
  const keys = labelKeys.get(project);
  if (keys.has(nameKey(name))) return;
  keys.add(nameKey(name));
  project.stats.labels.push(name);
}

function addPerson(list, name) {
  if (name && list.length < IMPORT_LIMITS.people && !list.some((x) => nameKey(x) === nameKey(name))) list.push(name);
}

/** Een regel achter de beschrijving ("Datum uit Todoist: …"), binnen de grens van het veld. */
function withNotes(description, notes) {
  if (notes.length === 0) return description;
  const extra = notes.join('\n');
  const room = IMPORT_LIMITS.description - extra.length - 2;
  if (room <= 0) return cut(extra, IMPORT_LIMITS.description)[0];
  const base = cut(description, room)[0];
  return base ? `${base}\n\n${extra}` : extra;
}

// ---------- CSV ----------

/** Een puntkomma als scheidingsteken (Excel in het Nederlands) als de kopregel daarmee is gemaakt. */
function delimiterOf(text) {
  const end = text.search(/[\r\n]/);
  const first = end < 0 ? text : text.slice(0, end);
  return (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
}

const OWN_ESCAPE = /^'[=+\-@\t\r]/;

/**
 * Zet de regels van één project om. `cell(row, naam)` geeft een cel (al ontdaan van de formule-bescherming bij de eigen export).
 */
function buildProject(project, rows, cell, now) {
  const stats = project.stats;
  let list = project.tasks;
  let stack = [];
  let lastTask = null;
  for (const row of rows) {
    const type = cell(row, 'TYPE').trim().toLowerCase();
    if (type === 'section') {
      const [name, long] = cut(line(cell(row, 'CONTENT')), IMPORT_LIMITS.sectionName);
      if (!name || project.sections.length >= IMPORT_LIMITS.sections) { stats.skippedRows++; continue; }
      if (long) stats.truncated++;
      let section = project.sections.find((s) => nameKey(s.name) === nameKey(name));
      if (!section) {
        section = { name, description: cut(block(cell(row, 'DESCRIPTION')), IMPORT_LIMITS.description)[0], collapsed: /^true$/i.test(cell(row, 'IS_COLLAPSED').trim()), tasks: [] };
        project.sections.push(section);
      }
      list = section.tasks;
      stack = [];
      lastTask = null;
    } else if (type === 'task') {
      const task = readTask(row, cell, project, now);
      if (!task) { stats.skippedRows++; continue; }
      const indent = Math.max(1, Math.floor(Number(cell(row, 'INDENT').trim())) || 1);
      let level = Math.min(indent, stack.length + 1); // een sprong van 1 naar 3 wordt een subtaak op niveau 2
      if (level > IMPORT_LIMITS.depth) {
        level = IMPORT_LIMITS.depth;
        stats.flattened++;
      }
      const target = level === 1 ? list : (stack[level - 2].subtasks ??= []);
      target.push(task);
      stack = [...stack.slice(0, level - 1), task];
      lastTask = task;
      stats.tasks++;
    } else if (type === 'note') {
      const text = noteText(cell(row, 'CONTENT'), stats);
      if (!text) { stats.skippedRows++; continue; }
      addPerson(project.people.authors, personName(cell(row, 'AUTHOR')));
      const target = lastTask ? lastTask.comments : project.comments;
      if (target.length >= IMPORT_LIMITS.comments) { stats.commentsDropped++; continue; }
      target.push(text);
      stats.comments++;
    } else if (type === 'meta') {
      const m = /^view_style\s*=\s*(list|board|calendar)$/i.exec(line(cell(row, 'CONTENT')));
      if (m) project.viewStyle = m[1].toLowerCase();
    } else if (type !== '' || row.some((x) => x.trim() !== '')) {
      stats.skippedRows++;
    }
  }
  stats.sections = project.sections.length;
  return project;
}

/** De tekst van een opmerking; een bijlage (`[[file {…}]]`) wordt "[Bijlage: naam]". */
function noteText(raw, stats) {
  const text = block(raw).replace(/\[\[file\s+(\{[\s\S]*?\})\]\]/g, (_, json) => {
    stats.attachments++;
    let name = '';
    try {
      const data = JSON.parse(json);
      if (typeof data?.file_name === 'string') name = line(data.file_name).slice(0, 200);
    } catch { /* een kapotte beschrijving van een bijlage: alleen "Bijlage" */ }
    return name ? t('import.attachment', { name }) : t('import.attachmentUnnamed');
  }).trim();
  const [out, long] = cut(text, IMPORT_LIMITS.comment);
  if (long) stats.truncated++;
  return out;
}

function readTask(row, cell, project, now) {
  const stats = project.stats;
  const raw = line(cell(row, 'CONTENT')).replace(/^\*\s+/, '');
  if (!raw) return null;
  const { text, labels } = extractLabels(raw);
  let [content, long] = cut(text || raw, IMPORT_LIMITS.content);
  if (long) stats.truncated++;
  const task = { content, description: '', priority: 4, labels: text ? labels : [], due: null, deadline: null, duration: null, comments: [] };
  for (const name of task.labels) noteLabel(project, name);
  const priority = Number(cell(row, 'PRIORITY').trim());
  if ([1, 2, 3, 4].includes(priority)) task.priority = priority; // dezelfde schaal als in Todoist: 1 = p1 (hoogst), 4 = geen
  const notes = [];
  const dateText = line(cell(row, 'DATE'));
  if (dateText) {
    const due = readDate(dateText, cell(row, 'DATE_LANG'), now);
    if (due) task.due = due;
    else {
      notes.push(t('import.note.date', { text: cut(dateText, 200)[0] }));
      stats.dates++;
    }
  }
  const deadlineText = line(cell(row, 'DEADLINE'));
  if (deadlineText) {
    const due = readDate(deadlineText, cell(row, 'DEADLINE_LANG'), now);
    if (due && !due.recurrence) task.deadline = due.date.slice(0, 10);
    else {
      notes.push(t('import.note.deadline', { text: cut(deadlineText, 200)[0] }));
      stats.deadlines++;
    }
  }
  const amount = cell(row, 'DURATION').trim();
  const unit = cell(row, 'DURATION_UNIT').trim().toLowerCase();
  if (amount && unit !== 'none') {
    const n = Number(amount);
    const minutes = Number.isInteger(n) && n > 0 ? (unit === 'day' || unit === 'days' ? n * 24 * 60 : unit === '' || unit === 'minute' || unit === 'minutes' ? n : null) : null;
    if (minutes !== null && minutes <= MAX_DURATION) task.duration = minutes;
    else {
      notes.push(t('import.note.duration', { text: cut(`${amount} ${unit}`.trim(), 100)[0] }));
      stats.durations++;
    }
  }
  task.description = withNotes(block(cell(row, 'DESCRIPTION')), notes);
  if (task.description.length > IMPORT_LIMITS.description) task.description = cut(task.description, IMPORT_LIMITS.description)[0];
  addPerson(project.people.authors, personName(cell(row, 'AUTHOR')));
  addPerson(project.people.responsible, personName(cell(row, 'RESPONSIBLE')));
  return task;
}

/** De naam van een project uit de bestandsnaam: zonder map, uitgang en het id van Todoist ("Werk [2203306141].csv"). */
export function projectNameFromFile(fileName) {
  const base = String(fileName ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  return cut(line(base.replace(/\.(csv|json)$/i, '').replace(/\s*\[\d+\]\s*$/, '')), IMPORT_LIMITS.projectName)[0];
}

/**
 * Leest een CSV-bestand: het sjabloonformaat van Todoist (één project) of de eigen export (kolom PROJECT: een project per pad).
 * @returns {{ ok: true, projects: object[] } | { ok: false, code: string }}
 */
export function parseCsvFile(text, fileName, now = new Date()) {
  const rows = csvRows(text, { maxRows: IMPORT_LIMITS.rows, delimiter: delimiterOf(text) });
  if (rows === null) return { ok: false, code: 'tooManyRows' };
  if (rows.length === 0) return { ok: false, code: 'empty' };
  const header = rows[0].map((x) => x.replace(/^﻿/, '').trim().toUpperCase());
  const columns = new Map(header.map((name, i) => [name, i]).reverse()); // bij een dubbele kolom telt de eerste
  if (!columns.has('TYPE') || !columns.has('CONTENT')) return { ok: false, code: 'notTodoist' };
  const own = columns.has('PROJECT') || /^tickory-/i.test(String(fileName).replace(/\\/g, '/').split('/').pop() ?? '');
  const cell = (row, name) => {
    const i = columns.get(name);
    const value = i === undefined ? '' : row[i] ?? '';
    return own && OWN_ESCAPE.test(value) ? value.slice(1) : value;
  };
  const body = rows.slice(1);
  if (!columns.has('PROJECT')) {
    const project = newProject(projectNameFromFile(fileName) || 'Todoist', own ? 'tickory-csv' : 'todoist', fileName);
    return { ok: true, projects: [buildProject(project, body, cell, now)] };
  }
  // de eigen export met alle projecten: "Ouder / Kind" in de kolom PROJECT; ontbrekende ouders worden lege projecten
  const byPath = new Map();
  const ensure = (path) => {
    if (byPath.has(path)) return byPath.get(path);
    const parts = path.split(' / ');
    const parent = parts.length > 1 ? ensure(parts.slice(0, -1).join(' / ')) : null; // de ouder eerst, zoals in de zijbalk
    const project = newProject(cut(parts.at(-1), IMPORT_LIMITS.projectName)[0] || 'Todoist', 'tickory-csv', fileName);
    if (parent) project.parentKey = parent.key;
    byPath.set(path, project);
    return project;
  };
  const groups = new Map();
  for (const row of body) {
    const path = line(cell(row, 'PROJECT')).split(' / ').map((x) => x.trim()).filter(Boolean).slice(0, 10).join(' / ') || 'Todoist';
    if (!groups.has(path)) groups.set(path, []);
    groups.get(path).push(row);
    ensure(path);
    if (byPath.size > IMPORT_LIMITS.projects) return { ok: false, code: 'tooManyProjects' };
  }
  for (const [path, list] of groups) buildProject(byPath.get(path), list, cell, now);
  return { ok: true, projects: [...byPath.values()] };
}

// ---------- JSON (de eigen export) ----------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const byOrderKey = (a, b) => (str(a.order_key) < str(b.order_key) ? -1 : str(a.order_key) > str(b.order_key) ? 1 : str(a.id) < str(b.id) ? -1 : 1);

/** Een `due` uit de eigen export, opnieuw gecontroleerd (alleen de bekende velden). */
function ownDue(due) {
  if (!isObject(due) || !isValidDate(due.date)) return null;
  const out = { date: due.date.slice(0, 16) };
  if (!isValidDate(out.date)) return null;
  if (due.recurrence !== undefined) {
    if (!isValidRecurrence(due.recurrence)) return null;
    out.recurrence = structuredClone(due.recurrence);
    if (typeof due.string === 'string' && due.string.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(due.string)) out.string = line(due.string);
    if (typeof due.lang === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(due.lang)) out.lang = due.lang;
  }
  return out;
}

/**
 * Leest de JSON-export van Tickory (`tickory-export`, versie 1): projecten, secties, open taken met subtaken, labels op naam en
 * opmerkingen. Afgevinkte taken, gearchiveerde projecten en secties, herinneringen, bijlagen, leden en toewijzingen niet.
 * @returns {{ ok: true, projects: object[] } | { ok: false, code: string }}
 */
export function parseOwnJson(text, fileName) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, code: 'notJson' };
  }
  if (!isObject(data)) return { ok: false, code: 'notJson' };
  if (data.format === 'tickory-template') return { ok: false, code: 'template' };
  if (data.format !== 'tickory-export') return { ok: false, code: 'notJson' };
  if (data.version !== 1) return { ok: false, code: 'unsupported' };
  const rows = (name) => (Array.isArray(data[name]) ? data[name].filter((r) => isObject(r) && typeof r.id === 'string' && r.id.length <= 64 && !r.is_deleted) : []);
  const labelNames = new Map(rows('labels').filter((l) => typeof l.name === 'string').map((l) => [l.id, cut(line(l.name), IMPORT_LIMITS.labelName)[0]]));
  const allProjects = rows('projects').filter((p) => typeof p.name === 'string');
  const projects = allProjects.filter((p) => !p.is_archived).slice(0, IMPORT_LIMITS.projects);
  const out = new Map();
  for (const p of [...projects].sort(byOrderKey)) {
    const name = isInboxId(p.id) ? 'Inbox' : cut(line(p.name), IMPORT_LIMITS.projectName)[0] || 'Tickory';
    const project = newProject(name, 'tickory-json', fileName);
    if (isColorName(p.color)) project.color = p.color;
    if (['list', 'board', 'calendar'].includes(p.view_style)) project.viewStyle = p.view_style;
    project.description = cut(block(str(p.description)), IMPORT_LIMITS.description)[0];
    out.set(p.id, project);
  }
  for (const p of projects) {
    // een ouder die er niet bij is (gearchiveerd, verwijderd) laat het project op het hoogste niveau
    if (typeof p.parent_id === 'string' && out.has(p.parent_id) && p.parent_id !== p.id) out.get(p.id).parentKey = out.get(p.parent_id).key;
  }
  // een kring van ouders (kan alleen in een bewerkt bestand) doorbreken
  for (const project of out.values()) {
    const seen = new Set([project.key]);
    let cur = project;
    while (cur.parentKey) {
      if (seen.has(cur.parentKey)) { cur.parentKey = null; break; }
      seen.add(cur.parentKey);
      cur = [...out.values()].find((x) => x.key === cur.parentKey);
    }
  }
  const sections = new Map();
  for (const s of rows('sections').filter((x) => out.has(x.project_id) && !x.is_archived && typeof x.name === 'string').sort(byOrderKey)) {
    const project = out.get(s.project_id);
    const [name, long] = cut(line(s.name), IMPORT_LIMITS.sectionName);
    if (!name || project.sections.length >= IMPORT_LIMITS.sections) continue;
    if (long) project.stats.truncated++;
    const section = { name, description: cut(block(str(s.description)), IMPORT_LIMITS.description)[0], collapsed: s.is_collapsed === true, tasks: [] };
    project.sections.push(section);
    sections.set(s.id, Object.defineProperty(section, 'projectId', { value: s.project_id, enumerable: false }));
  }
  const allTasks = rows('tasks').filter((x) => out.has(x.project_id) && typeof x.content === 'string');
  const open = new Map();
  for (const x of allTasks) {
    if (x.checked) out.get(x.project_id).stats.completed++;
    else open.set(x.id, x);
  }
  const converted = new Map();
  const convert = (x) => {
    const project = out.get(x.project_id);
    const [content, long] = cut(line(x.content), IMPORT_LIMITS.content);
    if (long) project.stats.truncated++;
    const labels = [];
    for (const id of Array.isArray(x.labels) ? x.labels.slice(0, IMPORT_LIMITS.labelsPerTask) : []) {
      const name = labelNames.get(id);
      if (name && !labels.some((l) => nameKey(l) === nameKey(name))) labels.push(name);
    }
    for (const name of labels) noteLabel(project, name);
    const task = {
      content: content || '…', description: cut(block(str(x.description)), IMPORT_LIMITS.description)[0],
      priority: [1, 2, 3, 4].includes(x.priority) ? x.priority : 4, labels, due: ownDue(x.due),
      deadline: typeof x.deadline === 'string' && x.deadline.length === 10 && isValidDate(x.deadline) ? x.deadline : null,
      duration: Number.isInteger(x.duration) && x.duration >= 1 && x.duration <= MAX_DURATION ? x.duration : null,
      comments: [],
    };
    converted.set(x.id, task);
    project.stats.tasks++;
    return task;
  };
  // de voorouders van een taak (de bovenste eerst), binnen hetzelfde project; een kring (alleen in een bewerkt bestand) telt als geen ouder
  const parentOf = (x) => {
    const p = typeof x.parent_id === 'string' ? open.get(x.parent_id) : null;
    return p && p.project_id === x.project_id ? p : null;
  };
  const chains = new Map();
  for (const x of open.values()) {
    const chain = [];
    for (let cur = parentOf(x); cur && chain.length <= 100; cur = parentOf(cur)) {
      if (cur === x || chain.includes(cur)) { chain.length = 0; break; }
      chain.unshift(cur);
    }
    chains.set(x, chain.length > 100 ? [] : chain);
  }
  // ouders vóór kinderen, en binnen een lijst op volgorde
  const sorted = [...open.values()].sort((a, b) => chains.get(a).length - chains.get(b).length || byOrderKey(a, b));
  let count = 0;
  for (const x of sorted) {
    if (count >= IMPORT_LIMITS.tasks) break;
    const project = out.get(x.project_id);
    const chain = chains.get(x);
    // dieper dan het maximum: een broer op het diepste niveau (onder de voorouder één niveau hoger)
    if (chain.length >= IMPORT_LIMITS.depth) project.stats.flattened++;
    const parent = chain.length === 0 ? null : chain[Math.min(chain.length, IMPORT_LIMITS.depth - 1) - 1];
    if (parent && !converted.has(parent.id)) continue; // de ouder viel weg (grens bereikt)
    const task = convert(x);
    count++;
    const section = sections.get(x.section_id);
    if (parent) (converted.get(parent.id).subtasks ??= []).push(task);
    else if (section && section.projectId === x.project_id) section.tasks.push(task);
    else project.tasks.push(task);
  }
  const comments = rows('comments').filter((c) => typeof c.content === 'string').sort((a, b) => str(a.created_at).localeCompare(str(b.created_at)) || (a.id < b.id ? -1 : 1));
  for (const c of comments) {
    const task = typeof c.task_id === 'string' ? converted.get(c.task_id) : null;
    const project = task ? out.get(open.get(c.task_id).project_id) : typeof c.project_id === 'string' ? out.get(c.project_id) : null;
    if (!project) continue;
    const target = task ? task.comments : project.comments;
    const [text, long] = cut(block(c.content), IMPORT_LIMITS.comment);
    if (!text) continue;
    if (target.length >= IMPORT_LIMITS.comments) { project.stats.commentsDropped++; continue; }
    if (long) project.stats.truncated++;
    target.push(text);
    project.stats.comments++;
  }
  for (const project of out.values()) project.stats.sections = project.sections.length;
  // in de volgorde van de zijbalk: elk project met daaronder zijn subprojecten
  const ordered = [];
  const visit = (parentKey) => {
    for (const p of [...projects].sort(byOrderKey)) {
      const project = out.get(p.id);
      if (project.parentKey !== parentKey || ordered.includes(project)) continue;
      ordered.push(project);
      visit(project.key);
    }
  };
  visit(null);
  return { ok: true, projects: ordered };
}

// ---------- mappen uit bestandsnamen ----------

/**
 * "Werk - Klanten" wordt een subproject "Klanten" van "Werk", alleen als er precies één ander project "Werk" is (uit dezelfde
 * import, uit een CSV van Todoist). Het langste passende begin wint, zodat "Werk - Klanten - Acme" onder "Werk - Klanten" komt.
 */
export function nestByName(projects) {
  const candidates = projects.filter((p) => p.source === 'todoist' && !p.parentKey);
  const names = new Map(candidates.map((p) => [p, p.name]));
  for (const p of candidates) {
    const parts = names.get(p).split(' - ');
    for (let i = parts.length - 1; i >= 1; i--) {
      const parentName = parts.slice(0, i).join(' - ');
      const child = parts.slice(i).join(' - ').trim();
      const matches = candidates.filter((q) => q !== p && nameKey(names.get(q)) === nameKey(parentName));
      if (matches.length > 1 || !child) break; // twee mogelijke ouders: niet raden
      if (matches.length === 1) {
        p.parentKey = matches[0].key;
        p.name = child;
        break;
      }
    }
  }
  return projects;
}

// ---------- alles samen ----------

/** Bytes als tekst: UTF-8 (met of zonder BOM), of anders de West-Europese codering van Windows (Excel). */
export function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * Is dit (bijvoorbeeld vanuit een andere app gedeelde) bestand iets om te importeren: een zip, een CSV met de kolommen TYPE en
 * CONTENT, of de JSON-export van Tickory? Kijkt alleen naar het begin (`bytes` mag de eerste paar KiB zijn).
 */
export function isImportFile(bytes) {
  if (!(bytes instanceof Uint8Array)) return false;
  if (looksLikeZip(bytes)) return true;
  const head = decodeText(bytes.subarray(0, 4096));
  if (/^\s*\{/.test(head)) return /^\s*\{\s*"format"\s*:\s*"tickory-export"/.test(head);
  const columns = head.split(/\r?\n|\r/, 1)[0].toUpperCase().replace(/"/g, '').split(/[,;]/).map((c) => c.trim());
  return columns.includes('TYPE') && columns.includes('CONTENT');
}

/**
 * Leest de gekozen bestanden. Elk bestand dat niet te lezen is geeft een melding; de rest gaat gewoon door.
 * @param {{ name: string, bytes: Uint8Array }[]} inputs
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ projects: object[], problems: { name: string, code: string, detail?: string }[], skipped: { name: string, reason: string }[] }>}
 */
export async function readImport(inputs, { now = new Date() } = {}) {
  const projects = [];
  const problems = [];
  const skipped = [];
  let files = 0;
  let total = 0;
  const one = (name, bytes) => {
    files += 1;
    total += bytes.length;
    if (files > IMPORT_LIMITS.files) return problems.push({ name, code: 'tooManyFiles' });
    if (bytes.length > IMPORT_LIMITS.fileBytes || total > IMPORT_LIMITS.totalBytes) return problems.push({ name, code: 'tooBig' });
    const text = decodeText(bytes);
    if (text.trim() === '') return problems.push({ name, code: 'empty' });
    const result = text.trimStart().startsWith('{') ? parseOwnJson(text, name) : parseCsvFile(text, name, now);
    if (!result.ok) return problems.push({ name, code: result.code });
    if (result.projects.every((p) => p.stats.tasks === 0 && p.sections.length === 0 && p.comments.length === 0) && result.projects.length === 1) {
      return problems.push({ name, code: 'noTasks' });
    }
    projects.push(...result.projects);
    if (projects.length > IMPORT_LIMITS.projects) problems.push({ name, code: 'tooManyProjects' });
    return null;
  };
  for (const input of inputs) {
    const name = String(input.name ?? '').slice(0, 300);
    const bytes = input.bytes;
    if (!(bytes instanceof Uint8Array)) { problems.push({ name, code: 'unreadable' }); continue; }
    if (looksLikeZip(bytes) || /\.zip$/i.test(name)) {
      const zip = await readZip(bytes, { accept: ZIP_ACCEPT });
      if (!zip.ok) { problems.push({ name, code: `zip.${zip.code}` }); continue; }
      if (zip.files.length === 0) problems.push({ name, code: 'zip.noCsv' });
      skipped.push(...zip.skipped.map((s) => ({ name: `${name}: ${s.name}`, reason: s.reason })));
      for (const f of zip.files) one(f.name.split('/').pop(), f.bytes);
    } else {
      one(name, bytes);
    }
  }
  if (projects.length > IMPORT_LIMITS.projects) projects.length = IMPORT_LIMITS.projects;
  return { projects: nestByName(projects), problems, skipped };
}

// ---------- samenvatting ----------

/** Alle taken van een project, ook de subtaken, in volgorde. */
export function* allTasks(project) {
  const walk = function* (list) {
    for (const task of list) {
      yield task;
      if (task.subtasks) yield* walk(task.subtasks);
    }
  };
  yield* walk(project.tasks);
  for (const s of project.sections) yield* walk(s.tasks);
}

/** De labelnamen van een reeks projecten, zonder dubbelen (hoofdletterongevoelig), in volgorde van voorkomen. */
export function labelNamesOfProjects(projects) {
  const out = [];
  for (const p of projects) for (const name of p.stats.labels) if (!out.some((x) => nameKey(x) === nameKey(name))) out.push(name);
  return out;
}
