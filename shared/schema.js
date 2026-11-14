// Datamodel als declaratieve entiteitsdefinities: de ene bron van waarheid voor server én client.
// De server maakt hieruit tabellen en valideert commando's; de client haalt er standaardwaarden uit
// en kan vóór het versturen dezelfde controles doen.

import { isValidKey } from './orderKey.js';
import { isValidDate, isValidRecurrence } from './recurrence.js';
import { MAX_OFFSET } from './reminders.js';
import { fileNameProblem, MAX_NAME_LENGTH } from './attachments.js';
import { PLACE_RADIUS_DEFAULT, PLACE_RADIUS_MAX, PLACE_RADIUS_MIN } from './places.js';
import { TEMPLATE_KINDS, TEMPLATE_LIMITS, contentCheck } from './template.js';
import { NOTIFICATION_KINDS, mentionsCheck, notifyPushCheck } from './notifications.js';
import { ROLES } from './roles.js';
import { GOALS, daysOffCheck } from './stats.js';

/**
 * @typedef {'project' | 'section' | 'task' | 'label' | 'comment' | 'attachment' | 'reminder' | 'filter' | 'member' | 'settings' | 'place' | 'template' | 'notification'} EntityName
 * @typedef {{
 *   name: string,
 *   type: 'text' | 'int' | 'real' | 'bool' | 'json',
 *   required?: boolean,
 *   nullable?: boolean,
 *   default?: unknown,
 *   maxLen?: number, min?: number, max?: number,
 *   oneOf?: readonly (string | number)[],
 *   ref?: EntityName,          // verwijst naar een andere entiteit (moet bestaan en niet verwijderd zijn)
 *   orderKey?: boolean,        // volgordesleutel (fractional indexing)
 *   immutable?: boolean,       // alleen bij aanmaken te zetten; wijzigen gaat via een eigen commando
 *   serverManaged?: boolean,   // door de server beheerd; clients sturen het nooit mee (bijv. `checked`)
 *   stamp?: boolean,           // bij aanmaken door de server gevuld met het id van de gebruiker die het commando uitvoert
 *   check?: (v: unknown) => string | null,
 * }} Col
 * @typedef {{ name: EntityName, table: string, resource: string, cols: Col[], commands?: false | readonly ('add' | 'update' | 'delete')[] }} Entity
 *   commands: welke algemene commando's er zijn. Weggelaten = alle drie (*_add, *_update, *_delete); false = geen
 *   (alleen eigen commando's); een lijst = alleen die.
 */

export const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

/**
 * Elke gebruiker heeft een eigen Inbox; de server maakt die aan bij het aanmaken van het account. Het id begint altijd
 * met "inbox-" en die voorvoegsels zijn gereserveerd: een gebruiker kan zelf geen project met zo'n id aanmaken.
 * INBOX_ID is de Inbox van het allereerste account (en van een database uit versie 0.1, zodat die intact blijft).
 */
export const INBOX_ID = 'inbox-project';
export const INBOX_PREFIX = 'inbox-';
export const isInboxId = (id) => typeof id === 'string' && id.startsWith(INBOX_PREFIX);

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

/** Het vaste id van de instellingen van een gebruiker. De server maakt die rij zelf aan; er is er precies één per gebruiker. */
export const settingsId = (userId) => `settings-${userId}`;

function timeZoneCheck(v) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return null;
  } catch {
    return 'onbekende tijdzone';
  }
}
const userIdCheck = (v) => (typeof v === 'string' && ID_RE.test(v) ? null : 'ongeldig gebruikers-id');
const owner = () => ({ name: 'owner_id', type: 'text', nullable: true, default: null, serverManaged: true, stamp: true });
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
      // wie de taak moet doen: moet lid van het project zijn (de server controleert dat)
      { name: 'assignee_id', type: 'text', nullable: true, default: null, check: userIdCheck },
      { name: 'creator_id', type: 'text', nullable: true, default: null, serverManaged: true, stamp: true },
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
    // Labels zijn persoonlijk (van de gebruiker die ze maakte). Je ziet ook de labels die op taken in je gedeelde
    // projecten staan, zodat je ze daar kunt lezen; wijzigen of verwijderen kan alleen de eigenaar.
    cols: [{ name: 'name', type: 'text', required: true, maxLen: 100, check: labelName }, color(), key(), fav(), owner()],
  },
  comment: {
    name: 'comment', table: 'comments', resource: 'comments',
    cols: [
      { name: 'task_id', type: 'text', nullable: true, default: null, ref: 'task', immutable: true },
      { name: 'project_id', type: 'text', nullable: true, default: null, ref: 'project', immutable: true },
      { name: 'content', type: 'text', required: true, maxLen: 16000 },
      { name: 'author_id', type: 'text', nullable: true, default: null, serverManaged: true, stamp: true },
      // wie er in de tekst wordt genoemd (@Naam): gebruikers-id's; de server bewaart alleen leden van het project (zie shared/notifications.js)
      { name: 'mentions', type: 'json', default: [], check: mentionsCheck },
    ],
  },
  // Bijlagen horen bij een taak en zien en wijzigen dezelfde mensen als de opmerkingen. De inhoud staat niet in de database maar
  // als bestand op de server (server/attachments.ts); dit zijn alleen de gegevens erover. Eerst wordt het bestand geüpload
  // (POST /api/v1/attachments), daarna volgt attachment_add; size, sha256 en mime moeten overeenkomen met wat de server bij de
  // upload zag. Er is geen attachment_update: een bijlage vervangen is verwijderen en opnieuw toevoegen.
  attachment: {
    name: 'attachment', table: 'attachments', resource: 'attachments', commands: ['add', 'delete'],
    cols: [
      { name: 'task_id', type: 'text', required: true, ref: 'task', immutable: true },
      { name: 'name', type: 'text', required: true, maxLen: MAX_NAME_LENGTH * 2, check: fileNameProblem },
      { name: 'size', type: 'int', required: true, min: 0, max: 2 ** 40 },
      { name: 'mime', type: 'text', required: true, maxLen: 255 },
      { name: 'sha256', type: 'text', required: true, maxLen: 64, check: (v) => (/^[0-9a-f]{64}$/.test(v) ? null : 'moet 64 hexadecimale tekens zijn') },
      { name: 'creator_id', type: 'text', nullable: true, default: null, serverManaged: true, stamp: true },
    ],
  },
  // Herinneringen zijn persoonlijk: ieder lid van een gedeeld project stelt zijn eigen herinneringen in.
  // Type `location`: bij aankomst op of vertrek van een eigen plaats (`place_id`, `trigger` enter | leave). Of je er bent,
  // bepaalt alleen het toestel zelf (Android-app); de server kent alleen de plaats, nooit waar je bent.
  reminder: {
    name: 'reminder', table: 'reminders', resource: 'reminders',
    cols: [
      { name: 'task_id', type: 'text', required: true, ref: 'task', immutable: true },
      { name: 'type', type: 'text', required: true, oneOf: ['relative', 'absolute', 'location'] },
      { name: 'minute_offset', type: 'int', nullable: true, default: null, min: 0, max: 60 * 24 * 365 },
      { name: 'due', type: 'json', nullable: true, default: null, check: dueCheck },
      { name: 'place_id', type: 'text', nullable: true, default: null, ref: 'place' },
      { name: 'trigger', type: 'text', nullable: true, default: null, oneOf: ['enter', 'leave'] },
      owner(),
    ],
  },
  // Een plaats van één gebruiker (privé): naam, positie en straal. Alleen de eigenaar ziet haar.
  place: {
    name: 'place', table: 'places', resource: 'places',
    cols: [
      { name: 'name', type: 'text', required: true, maxLen: 100 },
      { name: 'lat', type: 'real', required: true, min: -90, max: 90 },
      { name: 'lon', type: 'real', required: true, min: -180, max: 180 },
      { name: 'radius', type: 'int', default: PLACE_RADIUS_DEFAULT, min: PLACE_RADIUS_MIN, max: PLACE_RADIUS_MAX },
      owner(),
    ],
  },
  // Een sjabloon van één gebruiker (privé): de secties, taken en subtaken van een project of van een taak, met relatieve datums.
  // De inhoud (shared/template.js) wordt bij elk commando streng gecontroleerd; de soort (`kind`) kies je bij het maken.
  template: {
    name: 'template', table: 'templates', resource: 'templates',
    cols: [
      { name: 'name', type: 'text', required: true, maxLen: TEMPLATE_LIMITS.templateName },
      { name: 'kind', type: 'text', required: true, oneOf: TEMPLATE_KINDS, immutable: true },
      { name: 'description', type: 'text', default: '', maxLen: TEMPLATE_LIMITS.templateDescription },
      color(),
      { name: 'content', type: 'json', required: true, check: contentCheck },
      owner(),
    ],
  },
  filter: {
    name: 'filter', table: 'filters', resource: 'filters',
    cols: [{ name: 'name', type: 'text', required: true, maxLen: 200 }, { name: 'query', type: 'text', required: true, maxLen: 2000 }, color(), key(), fav(), owner()],
  },
  // De persoonlijke instellingen van een gebruiker: één rij per gebruiker (id: settingsId), alleen te wijzigen.
  settings: {
    name: 'settings', table: 'user_settings', resource: 'settings', commands: ['update'],
    cols: [
      // Automatische herinnering: zoveel minuten vóór een taak met een tijd, als je zelf geen herinnering opgeeft. -1 = geen.
      { name: 'auto_reminder', type: 'int', default: 30, min: -1, max: MAX_OFFSET },
      // Tijdzone voor meldingen die de server verstuurt; null = nog niet ingesteld (apparaten gebruiken hun eigen tijdzone).
      { name: 'timezone', type: 'text', nullable: true, default: null, maxLen: 64, check: timeZoneCheck },
      // Welke soorten meldingen bij samenwerken ook als pushmelding komen: { assigned, comment, mention, completed, shared };
      // een ontbrekende soort (of null) volgt de standaard (alles behalve "completed"). Zie pushChoices in shared/notifications.js.
      { name: 'notify_push', type: 'json', nullable: true, default: null, check: notifyPushCheck },
      // Het productiviteitsoverzicht (shared/stats.js): een dag- en weekdoel (aantal afgevinkte taken; 0 = geen doel) en de vrije
      // dagen die een reeks niet breken (ISO-weekdagen). null = de standaard (5, 25 en het weekend); zo heeft een rij van vóór deze
      // velden vanzelf de standaard.
      { name: 'goal_daily', type: 'int', nullable: true, default: null, min: GOALS.daily.min, max: GOALS.daily.max },
      { name: 'goal_weekly', type: 'int', nullable: true, default: null, min: GOALS.weekly.min, max: GOALS.weekly.max },
      { name: 'days_off', type: 'json', nullable: true, default: null, check: daysOffCheck },
      owner(),
    ],
  },
  // Een melding bij samenwerken voor één gebruiker (owner_id): iemand wees je een taak toe, reageerde, noemde je, vinkte jouw
  // taak af of voegde je toe aan een project. Alleen de server maakt ze; de ontvanger kan alleen `is_read` wijzigen
  // (notification_update) of alles gelezen zetten (notification_read_all). Precies één van task_id en project_id.
  notification: {
    name: 'notification', table: 'notifications', resource: 'notifications', commands: ['update'],
    cols: [
      { name: 'kind', type: 'text', required: true, oneOf: NOTIFICATION_KINDS, serverManaged: true },
      { name: 'actor_id', type: 'text', nullable: true, default: null, serverManaged: true },
      { name: 'task_id', type: 'text', nullable: true, default: null, serverManaged: true },
      { name: 'project_id', type: 'text', nullable: true, default: null, serverManaged: true },
      { name: 'comment_id', type: 'text', nullable: true, default: null, serverManaged: true },
      { name: 'is_read', type: 'bool', default: false },
      owner(),
    ],
  },
  // Wie bij een project hoort, met welke rol (shared/roles.js). Alleen te wijzigen met project_share, member_update,
  // project_unshare en project_leave.
  member: {
    name: 'member', table: 'project_members', resource: 'members', commands: false,
    cols: [
      { name: 'project_id', type: 'text', required: true, ref: 'project', immutable: true },
      { name: 'user_id', type: 'text', required: true, immutable: true, check: userIdCheck },
      { name: 'role', type: 'text', required: true, oneOf: ROLES },
    ],
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
    case 'real':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'moet een getal zijn';
      if (col.min !== undefined && v < col.min) return `minimaal ${col.min}`;
      if (col.max !== undefined && v > col.max) return `maximaal ${col.max}`;
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
