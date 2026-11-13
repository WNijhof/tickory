// Datamodel als declaratieve entiteitsdefinities: de ene bron van waarheid voor server én client.
// De server maakt hieruit tabellen en valideert commando's; de client haalt er standaardwaarden uit
// en kan vóór het versturen dezelfde controles doen.

import { isValidKey } from './orderKey.js';
import { isValidDate, isValidRecurrence } from './recurrence.js';

/**
 * @typedef {'project' | 'section' | 'task' | 'label' | 'comment' | 'reminder' | 'filter'} EntityName
 * @typedef {{
 *   name: string,
 *   type: 'text' | 'int' | 'bool' | 'json',
 *   required?: boolean,
 *   nullable?: boolean,
 *   default?: unknown,
 *   maxLen?: number, min?: number, max?: number,
 *   oneOf?: readonly (string | number)[],
 *   ref?: EntityName,          // verwijst naar een andere entiteit (moet bestaan en niet verwijderd zijn)
 *   orderKey?: boolean,        // volgordesleutel (fractional indexing)
 *   immutable?: boolean,       // alleen bij aanmaken te zetten; wijzigen gaat via een eigen commando
 *   serverManaged?: boolean,   // door de server beheerd; clients sturen het nooit mee (bijv. `checked`)
 *   check?: (v: unknown) => string | null,
 * }} Col
 * @typedef {{ name: EntityName, table: string, resource: string, cols: Col[] }} Entity
 */

export const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

/** Het vaste id van de Inbox. De server maakt dit project zelf aan; het kan niet worden verwijderd. */
export const INBOX_ID = 'inbox-project';

/** Prioriteit: 1 = hoogst … 4 = geen (standaard). Het getal is gelijk aan het label in de app (P1–P4). */
export const PRIORITIES = [1, 2, 3, 4];

function idList(v) {
  if (!Array.isArray(v) || v.length > 50) return "moet een lijst van maximaal 50 id's zijn";
  if (new Set(v).size !== v.length) return 'bevat dubbele waarden';
  return v.every((x) => typeof x === 'string' && ID_RE.test(x)) ? null : 'bevat een ongeldig id';
}

function dueCheck(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'moet een object zijn';
  for (const k of Object.keys(v)) if (!['date', 'string', 'lang', 'recurrence'].includes(k)) return `onbekend veld "${k}"`;
  if (!isValidDate(v.date)) return 'date moet YYYY-MM-DD of YYYY-MM-DDTHH:MM(:SS) zijn';
  if (v.string !== undefined && (typeof v.string !== 'string' || v.string.length > 200)) return 'string is ongeldig';
  if (v.lang !== undefined && (typeof v.lang !== 'string' || !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(v.lang))) return 'lang is ongeldig';
  if (v.recurrence !== undefined && !isValidRecurrence(v.recurrence)) return 'recurrence is ongeldig';
  return null;
}

const labelName = (v) => (/[,\u0000-\u001f]|^\s|\s$/u.test(v) ? 'mag geen komma, omringende spaties of stuurtekens bevatten' : null);
const dateOnly = (v) => (isValidDate(v) && String(v).length === 10 ? null : 'moet YYYY-MM-DD zijn');
const key = () => ({ name: 'order_key', type: 'text', orderKey: true, check: (v) => (isValidKey(v) ? null : 'ongeldige volgordesleutel') });
const color = () => ({ name: 'color', type: 'text', default: 'charcoal', maxLen: 32 });
const fav = () => ({ name: 'is_favorite', type: 'bool', default: false });

/** @type {Record<EntityName, Entity>} */
export const ENTITIES = {
  project: {
    name: 'project', table: 'projects', resource: 'projects',
    cols: [
      { name: 'name', type: 'text', required: true, maxLen: 200 },
      { name: 'description', type: 'text', default: '', maxLen: 16000 },
      color(),
      { name: 'parent_id', type: 'text', nullable: true, default: null, ref: 'project' },
      key(), fav(),
      { name: 'is_archived', type: 'bool', default: false },
      { name: 'is_collapsed', type: 'bool', default: false },
      { name: 'view_style', type: 'text', default: 'list', oneOf: ['list', 'board', 'calendar'] },
    ],
  },
  section: {
    name: 'section', table: 'sections', resource: 'sections',
    cols: [
      { name: 'project_id', type: 'text', required: true, ref: 'project', immutable: true },
      { name: 'name', type: 'text', required: true, maxLen: 200 },
      { name: 'description', type: 'text', default: '', maxLen: 16000 },
      key(),
      { name: 'is_archived', type: 'bool', default: false },
      { name: 'is_collapsed', type: 'bool', default: false },
    ],
  },
  task: {
    name: 'task', table: 'tasks', resource: 'tasks',
    cols: [
      { name: 'project_id', type: 'text', required: true, ref: 'project', immutable: true },
      { name: 'section_id', type: 'text', nullable: true, default: null, ref: 'section', immutable: true },
      { name: 'parent_id', type: 'text', nullable: true, default: null, ref: 'task', immutable: true },
      { name: 'content', type: 'text', required: true, maxLen: 4000 },
      { name: 'description', type: 'text', default: '', maxLen: 16000 },
      { name: 'priority', type: 'int', default: 4, oneOf: PRIORITIES },
      { name: 'labels', type: 'json', default: [], check: idList },
      { name: 'due', type: 'json', nullable: true, default: null, check: dueCheck },
      { name: 'deadline', type: 'text', nullable: true, default: null, check: dateOnly },
      { name: 'duration', type: 'int', nullable: true, default: null, min: 1, max: 60 * 24 * 7 },
      { name: 'checked', type: 'bool', default: false, serverManaged: true },
      { name: 'completed_at', type: 'text', nullable: true, default: null, serverManaged: true },
      { name: 'completed_count', type: 'int', default: 0, serverManaged: true },
      { name: 'is_collapsed', type: 'bool', default: false },
      key(),
    ],
  },
  label: {
    name: 'label', table: 'labels', resource: 'labels',
    // geen komma (in het bewerkvenster scheidt een komma labels), geen omringende spaties en geen stuurtekens
    cols: [{ name: 'name', type: 'text', required: true, maxLen: 100, check: labelName }, color(), key(), fav()],
  },
  comment: {
    name: 'comment', table: 'comments', resource: 'comments',
    cols: [
      { name: 'task_id', type: 'text', nullable: true, default: null, ref: 'task', immutable: true },
      { name: 'project_id', type: 'text', nullable: true, default: null, ref: 'project', immutable: true },
      { name: 'content', type: 'text', required: true, maxLen: 16000 },
    ],
  },
  reminder: {
    name: 'reminder', table: 'reminders', resource: 'reminders',
    cols: [
      { name: 'task_id', type: 'text', required: true, ref: 'task', immutable: true },
      { name: 'type', type: 'text', required: true, oneOf: ['relative', 'absolute'] },
      { name: 'minute_offset', type: 'int', nullable: true, default: null, min: 0, max: 60 * 24 * 365 },
      { name: 'due', type: 'json', nullable: true, default: null, check: dueCheck },
    ],
  },
  filter: {
    name: 'filter', table: 'filters', resource: 'filters',
    cols: [{ name: 'name', type: 'text', required: true, maxLen: 200 }, { name: 'query', type: 'text', required: true, maxLen: 2000 }, color(), key(), fav()],
  },
};

/** @type {Entity[]} */
export const ENTITY_LIST = Object.values(ENTITIES);
/** @type {string[]} */
export const RESOURCE_NAMES = ENTITY_LIST.map((e) => e.resource);

/**
 * Controleert één waarde tegen de kolomdefinitie. Geeft een foutmelding of null.
 * @param {Col} col
 * @param {unknown} v
 * @returns {string | null}
 */
export function validateValue(col, v) {
  if (v === null) return col.nullable ? null : 'mag niet null zijn';
  switch (col.type) {
    case 'text':
      if (typeof v !== 'string') return 'moet tekst zijn';
      if (col.maxLen !== undefined && v.length > col.maxLen) return `maximaal ${col.maxLen} tekens`;
      if (col.required && v.trim().length === 0) return 'mag niet leeg zijn';
      if (col.ref && !ID_RE.test(v)) return 'ongeldig id';
      if (col.oneOf && !col.oneOf.includes(v)) return `moet een van ${col.oneOf.join(', ')} zijn`;
      break;
    case 'int':
      if (!Number.isInteger(v)) return 'moet een geheel getal zijn';
      if (col.min !== undefined && v < col.min) return `minimaal ${col.min}`;
      if (col.max !== undefined && v > col.max) return `maximaal ${col.max}`;
      if (col.oneOf && !col.oneOf.includes(v)) return `moet een van ${col.oneOf.join(', ')} zijn`;
      break;
    case 'bool':
      if (typeof v !== 'boolean') return 'moet true of false zijn';
      break;
    case 'json':
      break;
    default:
      return 'onbekend kolomtype';
  }
  return col.check ? col.check(v) : null;
}
