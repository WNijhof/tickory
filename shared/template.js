// Sjablonen voor projecten en taken: het formaat van de inhoud en de controle erop. Gedeeld door de server (die de inhoud bij
// elk `template_add` en `template_update` controleert), de web-app en de demo. Zie SPEC.md, hoofdstuk 5c.
//
// Een sjabloon is een boom van secties, taken en subtaken zonder id's, eigenaren, toewijzingen, herinneringen en opmerkingen.
// Datums zijn relatief: `day` is het aantal dagen na de startdatum die je kiest bij het gebruiken (0 = de startdatum zelf).
//
//   inhoud  = { v: 1, tasks: [taak], sections: [{ name, tasks: [taak] }] }
//   taak    = { content, description?, priority? (1-3; 4 = geen), labels? (namen), duration? (minuten),
//               day? (gehele dagen), time? ("HH:MM", alleen met day), recurrence? (alleen met day), repeat_text?, subtasks? }
//
// De inhoud kan van buiten komen (een geïmporteerd bestand, een commando van een willekeurige client): alles wordt streng gecontroleerd,
// onbekende velden zijn een fout, en er is een bovengrens aan diepte, lengtes en grootte. De controle gebruikt geen netwerk, geen HTML
// en geen eval; tekst blijft tekst.

import { isValidRecurrence } from './recurrence.js';
import { nameKey } from './text.js';

export const TEMPLATE_VERSION = 1;
export const TEMPLATE_KINDS = ['project', 'task'];

/**
 * Harde grenzen aan één sjabloon. `tasks` (inclusief subtaken) staat ook in server/limits.ts (`tasksPerTemplate`, daar met
 * LIMIT_REACHED); de rest wordt hier als ongeldige invoer geweigerd.
 */
export const TEMPLATE_LIMITS = Object.freeze({
  tasks: 1000,
  sections: 100,
  /** Niveaus van taken: een taak, haar subtaak, daarvan een subtaak, enzovoort. */
  depth: 4,
  /** Tekens in titel (taak, sectie) en in de beschrijving, gelijk aan de grenzen van een taak. */
  title: 4000,
  sectionName: 200,
  description: 16000,
  labelsPerTask: 50,
  labelName: 100,
  repeatText: 200,
  templateName: 200,
  templateDescription: 500,
  /** Grootte van de inhoud als JSON, in bytes (UTF-8). */
  bytes: 256 * 1024,
  /** Grootte van een bestand dat geïmporteerd wordt (zowel JSON als CSV). */
  fileBytes: 512 * 1024,
  /** Bereik van `day`: ruim tien jaar vooruit en achteruit. */
  dayMin: -3650,
  dayMax: 3650,
  durationMax: 60 * 24 * 7,
});

/**
 * De grenzen van de server die bepalen of een sjabloon toegepast kan worden (een kopie van server/limits.ts: een test bewaakt dat
 * ze gelijk zijn). De app controleert ze vooraf, zodat een sjabloon nooit half wordt aangemaakt.
 */
export const APPLY_LIMITS = Object.freeze({
  projectsPerUser: 500,
  sectionsPerProject: 200,
  tasksPerProject: 10_000,
  tasksPerUser: 50_000,
  labelsPerUser: 500,
  remindersPerUser: 5_000,
  templatesPerUser: 100,
});

const TASK_KEYS = ['content', 'description', 'priority', 'labels', 'duration', 'day', 'time', 'recurrence', 'repeat_text', 'subtasks'];
const SECTION_KEYS = ['name', 'tasks'];
const CONTENT_KEYS = ['v', 'tasks', 'sections'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const CONTROL_NO_NEWLINE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/** Is dit een nette tekst? Geen losse halve tekens (die zouden op de server anders worden), en geen stuurtekens. */
function textProblem(v, { max, multiline = false, required = false }) {
  if (typeof v !== 'string') return 'moet tekst zijn';
  if (v.length > max) return `maximaal ${max} tekens`;
  if (required && v.trim().length === 0) return 'mag niet leeg zijn';
  if (typeof v.isWellFormed === 'function' && !v.isWellFormed()) return 'bevat een ongeldig teken';
  if ((multiline ? CONTROL_NO_NEWLINE_RE : CONTROL_RE).test(v)) return 'bevat stuurtekens';
  return null;
}

/** Een labelnaam zoals de server ze toestaat (geen komma, geen omringende spaties, geen stuurtekens). */
export function labelNameProblem(v) {
  const base = textProblem(v, { max: TEMPLATE_LIMITS.labelName, required: true });
  if (base) return base;
  if (v.includes(',') || /^\s|\s$/u.test(v)) return 'mag geen komma of omringende spaties bevatten';
  return null;
}

function checkTask(task, depth, where, tally) {
  if (!isObject(task)) return `${where}: moet een object zijn`;
  for (const k of Object.keys(task)) if (!TASK_KEYS.includes(k)) return `${where}: onbekend veld "${k}"`;
  if (depth > TEMPLATE_LIMITS.depth) return `${where}: taken zitten maximaal ${TEMPLATE_LIMITS.depth} niveaus diep`;
  tally.tasks += 1;
  let p = textProblem(task.content, { max: TEMPLATE_LIMITS.title, required: true });
  if (p) return `${where}.content: ${p}`;
  if (task.description !== undefined) {
    p = textProblem(task.description, { max: TEMPLATE_LIMITS.description, multiline: true });
    if (p) return `${where}.description: ${p}`;
  }
  if (task.priority !== undefined && ![1, 2, 3, 4].includes(task.priority)) return `${where}.priority: moet 1, 2, 3 of 4 zijn`;
  if (task.labels !== undefined) {
    if (!Array.isArray(task.labels) || task.labels.length > TEMPLATE_LIMITS.labelsPerTask) return `${where}.labels: een lijst van maximaal ${TEMPLATE_LIMITS.labelsPerTask} namen`;
    const seen = new Set();
    for (const name of task.labels) {
      p = labelNameProblem(name);
      if (p) return `${where}.labels: ${p}`;
      const key = nameKey(name);
      if (seen.has(key)) return `${where}.labels: bevat dubbele namen`;
      seen.add(key);
    }
  }
  if (task.duration !== undefined && !(Number.isInteger(task.duration) && task.duration >= 1 && task.duration <= TEMPLATE_LIMITS.durationMax)) return `${where}.duration: een geheel aantal minuten`;
  if (task.day !== undefined && !(Number.isInteger(task.day) && task.day >= TEMPLATE_LIMITS.dayMin && task.day <= TEMPLATE_LIMITS.dayMax)) return `${where}.day: een geheel aantal dagen`;
  if (task.time !== undefined) {
    if (task.day === undefined) return `${where}.time: heeft day nodig`;
    if (typeof task.time !== 'string' || !TIME_RE.test(task.time)) return `${where}.time: moet UU:MM zijn`;
  }
  if (task.recurrence !== undefined) {
    if (task.day === undefined) return `${where}.recurrence: heeft day nodig`;
    if (!isValidRecurrence(task.recurrence)) return `${where}.recurrence: ongeldige herhaling`;
  }
  if (task.repeat_text !== undefined) {
    if (task.recurrence === undefined) return `${where}.repeat_text: hoort bij een herhaling`;
    p = textProblem(task.repeat_text, { max: TEMPLATE_LIMITS.repeatText });
    if (p) return `${where}.repeat_text: ${p}`;
  }
  if (task.subtasks !== undefined) {
    if (!Array.isArray(task.subtasks)) return `${where}.subtasks: moet een lijst zijn`;
    for (const [i, sub] of task.subtasks.entries()) {
      const problem = checkTask(sub, depth + 1, `${where}.subtasks[${i}]`, tally);
      if (problem) return problem;
    }
  }
  return null;
}

function checkTaskList(list, where, tally) {
  if (!Array.isArray(list)) return `${where}: moet een lijst zijn`;
  for (const [i, task] of list.entries()) {
    const problem = checkTask(task, 1, `${where}[${i}]`, tally);
    if (problem) return problem;
  }
  return null;
}

/**
 * Controleert de inhoud van een sjabloon. Geeft een foutmelding (Nederlands, zonder de inhoud te herhalen) of null.
 * Het aantal taken per sjabloon is hier niet begrensd (dat doet de server met `LIMITS.tasksPerTemplate`); wel de rest.
 * @param {unknown} content
 * @returns {string | null}
 */
export function checkTemplateContent(content) {
  if (!isObject(content)) return 'moet een object zijn';
  for (const k of Object.keys(content)) if (!CONTENT_KEYS.includes(k)) return `onbekend veld "${k}"`;
  if (content.v !== TEMPLATE_VERSION) return `v moet ${TEMPLATE_VERSION} zijn`;
  const tally = { tasks: 0 };
  let problem = checkTaskList(content.tasks, 'tasks', tally);
  if (problem) return problem;
  if (!Array.isArray(content.sections) || content.sections.length > TEMPLATE_LIMITS.sections) return `sections: een lijst van maximaal ${TEMPLATE_LIMITS.sections} secties`;
  const names = new Set();
  for (const [i, section] of content.sections.entries()) {
    const where = `sections[${i}]`;
    if (!isObject(section)) return `${where}: moet een object zijn`;
    for (const k of Object.keys(section)) if (!SECTION_KEYS.includes(k)) return `${where}: onbekend veld "${k}"`;
    problem = textProblem(section.name, { max: TEMPLATE_LIMITS.sectionName, required: true });
    if (problem) return `${where}.name: ${problem}`;
    const key = nameKey(section.name);
    if (names.has(key)) return `${where}.name: bevat een naam die al voorkomt`;
    names.add(key);
    problem = checkTaskList(section.tasks, `${where}.tasks`, tally);
    if (problem) return problem;
  }
  if (tally.tasks === 0) return 'bevat geen taken';
  // een JSON-string telt tekens als 1 tot 3 bytes in UTF-8; de lengte in UTF-8 is wat de database en het verzoek kosten
  if (new TextEncoder().encode(JSON.stringify(content)).length > TEMPLATE_LIMITS.bytes) return `te groot (maximaal ${Math.round(TEMPLATE_LIMITS.bytes / 1024)} KiB)`;
  return null;
}

/** De controle voor de kolom `content` van de entiteit `template` (zie shared/schema.js). */
export const contentCheck = (v) => checkTemplateContent(v);

/** Naam en omschrijving van een sjabloon als apart te controleren stukken (voor een geïmporteerd bestand). */
export function templateNameProblem(name) {
  return textProblem(name, { max: TEMPLATE_LIMITS.templateName, required: true });
}
export function templateDescriptionProblem(description) {
  return textProblem(description, { max: TEMPLATE_LIMITS.templateDescription, multiline: true });
}

/** Alle taken (platgeslagen) van een sjabloon, met diepte en sectie, in volgorde van tonen: eerst zonder sectie, dan per sectie. */
export function* walkTemplate(content) {
  function* walk(list, depth, section) {
    for (const task of list) {
      yield { task, depth, section };
      if (task.subtasks) yield* walk(task.subtasks, depth + 1, section);
    }
  }
  yield* walk(content.tasks, 1, null);
  for (const section of content.sections) yield* walk(section.tasks, 1, section);
}

/** Hoeveel taken (met subtaken) en secties er in een sjabloon zitten, en welke labels en herhalingen. */
export function templateStats(content) {
  const labels = new Map();
  let tasks = 0;
  let subtasks = 0;
  let dated = 0;
  let recurring = 0;
  let timed = 0;
  let maxDay = null;
  let minDay = null;
  for (const { task, depth } of walkTemplate(content)) {
    tasks += 1;
    if (depth > 1) subtasks += 1;
    if (task.day !== undefined) {
      dated += 1;
      maxDay = maxDay === null ? task.day : Math.max(maxDay, task.day);
      minDay = minDay === null ? task.day : Math.min(minDay, task.day);
    }
    if (task.recurrence) recurring += 1;
    if (task.time) timed += 1;
    for (const name of task.labels ?? []) if (!labels.has(nameKey(name))) labels.set(nameKey(name), name);
  }
  return { tasks, sections: content.sections.length, subtasks, dated, recurring, timed, labels: [...labels.values()], minDay, maxDay };
}
