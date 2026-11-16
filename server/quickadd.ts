// Snel toevoegen voor apparaten zonder eigen herkenner: `POST /api/v1/quick-add` (het kleine venster "Taak toevoegen" van de
// Android-app, en wat er verder bij komt). Eén regel tekst wordt een taak, precies zoals in de web-app:
//
//   - de herkenning is dezelfde code als in de web-app (client/core/quickadd.js met dateNl.js), op de projecten, secties,
//     labels en rollen die de gebruiker zelf ziet (dezelfde volledige sync als de web-app krijgt);
//   - de commando's maakt dezelfde code als in de web-app (client/core/actions.js, `addTask`): nieuwe labels, de taak, en de
//     herinneringen (`!30m`, of de automatische herinnering uit de instellingen bij een taak met een tijd);
//   - de commando's gaan door de gewone sync (sync.ts), dus met dezelfde rechten (een lezer krijgt FORBIDDEN), limieten
//     (LIMIT_REACHED) en controles, maar als één geheel: weigert de server één commando, dan gebeurt er niets;
//   - "morgen" telt vanaf `typed_at` (het moment van intypen, met de UTC-afwijking van het apparaat) in tijdzone `tz`, anders
//     de tijdzone uit de instellingen, anders UTC. Een taak die offline is ingetypt en later verstuurd, krijgt zo de dag die de
//     gebruiker bedoelde;
//   - hetzelfde `uuid` nog eens geeft dezelfde taak terug (`repeated: true`) en maakt niets nieuws: de id's van de taak, de
//     labels en de herinneringen en de uuid's van de commando's zijn afgeleid van gebruiker en uuid;
//   - `dry_run: true` geeft alleen de voorvertoning (titel, datum, project, sectie, labels, prioriteit, herinneringen).
//
// De herkenner rekent in de tijdzone van het proces (net als in de browser). Daarom draait hij hier in een blok dat de
// tijdzone van het proces even op `tz` zet (process.env.TZ, wat Node direct overneemt) en daarna terugzet. Dat blok is
// synchroon: er kan in die tijd niets anders draaien.

import type { DatabaseSync } from 'node:sqlite';
import { generalOf } from '../shared/general.js';
import { createHash } from 'node:crypto';
import { parseQuickAdd } from '../client/core/quickadd.js';
import { createActions } from '../client/core/actions.js';
import { emptyState } from '../client/core/reducer.js';
import { canEditProject } from '../client/core/access.js';
import { isTimeZone } from '../shared/stats.js';
import { epochToFloating } from '../shared/reminders.js';
import { ENTITIES, ID_RE, toApi } from './schema.ts';
import { getRow } from './rows.ts';
import type { Row } from './rows.ts';
import { AtomicFailure, handleSync, SyncError } from './sync.ts';

/** Zit in elk antwoord van dit eindpunt, ook bij een weigering: zo ziet een app het verschil met een oudere server (die 404 geeft). */
export const QUICK_ADD_VERSION = 1;

/** Zoveel tekens mag de regel hooguit hebben (de titel van een taak ook). */
export const MAX_TEXT = 4000;

/** Een `typed_at` die verder van de klok van de server af ligt dan dit, telt als "nu" (een toestel met een verkeerde klok). */
export const TYPED_AT_PAST_MS = 30 * 86_400_000;
export const TYPED_AT_FUTURE_MS = 86_400_000;

const UUID_RE = /^[A-Za-z0-9_-]{8,56}$/; // ruimte voor "-t", "-l12" en "-r3" erachter (de sync staat 64 tekens toe)
const TYPED_AT_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const ALLOWED = new Set(['text', 'project_id', 'section_id', 'uuid', 'typed_at', 'tz', 'due', 'priority', 'dry_run']);

const fail = (code: string, message: string): never => { throw new SyncError(code, message); };

export interface QuickAddInput {
  text: string;
  projectId: string | null;
  sectionId: string | null;
  uuid: string | null;
  typedAt: string | null;
  tz: string | null;
  due: 'today' | 'tomorrow' | null;
  priority: number | null;
  dryRun: boolean;
}

/** Controleert het verzoek. Onbekende velden en verkeerde soorten zijn INVALID_ARG of UNKNOWN_ARG (HTTP 400). */
export function readInput(body: Record<string, unknown>): QuickAddInput {
  for (const k of Object.keys(body)) if (!ALLOWED.has(k)) fail('UNKNOWN_ARG', `onbekend argument "${k}"`);
  const optionalId = (k: string): string | null => {
    const v = body[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || !ID_RE.test(v)) fail('INVALID_ARG', `${k}: ongeldig id`);
    return v as string;
  };
  const text = body.text;
  if (typeof text !== 'string' || !text.trim()) fail('INVALID_ARG', 'text: geef de tekst van de taak');
  if ((text as string).length > MAX_TEXT) fail('INVALID_ARG', `text: hooguit ${MAX_TEXT} tekens`);
  const dryRun = body.dry_run === undefined ? false : body.dry_run;
  if (typeof dryRun !== 'boolean') fail('INVALID_ARG', 'dry_run: true of false');
  const uuid = body.uuid === undefined || body.uuid === null ? null : body.uuid;
  if (uuid !== null && (typeof uuid !== 'string' || !UUID_RE.test(uuid))) fail('INVALID_ARG', 'uuid: 8 tot 56 tekens uit [A-Za-z0-9_-]');
  if (uuid === null && !dryRun) fail('MISSING_ARG', 'uuid is verplicht (zo wordt een herhaald verzoek niet twee keer uitgevoerd)');
  const typedAt = body.typed_at === undefined || body.typed_at === null ? null : body.typed_at;
  if (typedAt !== null && (typeof typedAt !== 'string' || !Number.isFinite(typedAtMs(typedAt)))) {
    fail('INVALID_ARG', 'typed_at: een tijdstip als 2026-11-13T09:30:00+01:00');
  }
  const tz = body.tz === undefined || body.tz === null ? null : body.tz;
  if (tz !== null && (typeof tz !== 'string' || tz.length > 64)) fail('INVALID_ARG', 'tz: de naam van een tijdzone, zoals Europe/Amsterdam');
  const due = body.due === undefined || body.due === null ? null : body.due;
  if (due !== null && due !== 'today' && due !== 'tomorrow') fail('INVALID_ARG', 'due: "today" of "tomorrow"');
  const priority = body.priority === undefined || body.priority === null ? null : body.priority;
  if (priority !== null && (!Number.isInteger(priority) || (priority as number) < 1 || (priority as number) > 4)) fail('INVALID_ARG', 'priority: 1 tot en met 4');
  return {
    text: text as string, projectId: optionalId('project_id'), sectionId: optionalId('section_id'), uuid: uuid as string | null,
    typedAt: typedAt as string | null, tz: tz as string | null, due: due as QuickAddInput['due'], priority: priority as number | null, dryRun: dryRun as boolean,
  };
}

/** `typed_at` als milliseconden, of NaN als het geen tijdstip met UTC-afwijking is; de fractie van seconden valt weg (Date.parse kent niet overal meer dan drie cijfers). */
function typedAtMs(value: string): number {
  const m = TYPED_AT_RE.exec(value);
  return m ? Date.parse(`${m[1]}${m[2]}`) : Number.NaN;
}

/** Het moment waarop de tekst is ingetypt; ontbreekt het of ligt het onwaarschijnlijk ver weg, dan nu. */
export function momentOf(typedAt: string | null, nowMs: number): number {
  if (typedAt === null) return nowMs;
  const ms = typedAtMs(typedAt);
  return ms < nowMs - TYPED_AT_PAST_MS || ms > nowMs + TYPED_AT_FUTURE_MS ? nowMs : ms;
}

/** De tijdzone waarin "vandaag" en "morgen" tellen: die van het apparaat, anders die uit de instellingen, anders UTC. */
export function zoneOf(given: string | null, settingsZone: unknown): string {
  if (given && isTimeZone(given)) return given;
  if (typeof settingsZone === 'string' && isTimeZone(settingsZone)) return settingsZone;
  return 'UTC';
}

/** Voert `fn` uit alsof het proces in tijdzone `tz` draait (zie bovenaan). */
export function inZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  if (before === tz) return fn();
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) Reflect.deleteProperty(process.env, 'TZ');
    else process.env.TZ = before;
  }
}

/** Een id van 16 tekens uit [A-Za-z0-9_-], vast voor deze gebruiker, dit uuid en dit volgnummer. */
export function derivedId(userId: string, uuid: string, n: number): string {
  return createHash('sha256').update(`tickory-quick-add|${userId}|${uuid}|${n}`).digest('base64url').slice(0, 16);
}

/** De volgende dag na 'YYYY-MM-DD' (kalenderrekenen, zonder tijdzone). */
const nextDay = (ymd: string): string => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

interface Captured { type: string; uuid: string; args: Record<string, unknown> }

export interface QuickAddPreview {
  content: string;
  due: Record<string, unknown> | null;
  deadline: string | null;
  duration: number | null;
  project: { id: string; name: string; inbox: boolean };
  section: { id: string; name: string } | null;
  labels: { name: string; new: boolean }[];
  priority: number;
  reminders: ({ type: 'relative'; minute_offset: number } | { type: 'absolute'; date: string })[];
  /** De herinnering is de automatische uit de instellingen (er stond geen `!…` in de tekst). */
  auto_reminder: boolean;
}

export interface QuickAddAnswer {
  quick_add: number;
  dry_run: boolean;
  repeated: boolean;
  task: Record<string, unknown> | null;
  preview: QuickAddPreview | null;
  tz: string | null;
  typed_at: string | null;
}

/** De taak zoals de server hem nu heeft, als de gebruiker hem nog ziet. */
function visibleTask(db: DatabaseSync, userId: string, id: string): Record<string, unknown> | null {
  const row = getRow(db, ENTITIES.task, id);
  if (!row || row.is_deleted === 1) return null;
  const member = db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND is_deleted = 0').get(row.project_id as string, userId);
  return member ? toApi(ENTITIES.task, row) : null;
}

const taskUuid = (uuid: string): string => `${uuid}-t`;

/**
 * Voert een snelle toevoeging uit (of alleen de voorvertoning). Gooit een SyncError bij een weigering: INVALID_ARG,
 * NOT_FOUND (het project of de sectie bestaat niet of is niet van jou), FORBIDDEN (je kunt het project alleen lezen),
 * LIMIT_REACHED en wat de sync verder kan weigeren.
 */
export async function quickAdd(db: DatabaseSync, userId: string, body: Record<string, unknown>, nowMs: number = Date.now()): Promise<QuickAddAnswer> {
  const input = readInput(body);

  // Al eens gelukt met dit uuid: dezelfde taak terug, niets opnieuw.
  if (input.uuid !== null && !input.dryRun) {
    const seen = db.prepare('SELECT status, error_code, error FROM command_log WHERE user_id = ? AND uuid = ?').get(userId, taskUuid(input.uuid)) as Row | undefined;
    if (seen && seen.status !== 'ok') fail(seen.error_code as string, seen.error as string);
    if (seen) return { quick_add: QUICK_ADD_VERSION, dry_run: false, repeated: true, task: visibleTask(db, userId, derivedId(userId, input.uuid, 0)), preview: null, tz: null, typed_at: null };
  }

  // Wat de gebruiker ziet, zoals de web-app het na een volledige sync heeft.
  const snap = handleSync(db, { sync_token: '*', resource_types: ['projects', 'sections', 'labels', 'members', 'settings'] }, userId);
  const view = emptyState() as Record<string, Map<string, Row>>;
  for (const resource of ['projects', 'sections', 'labels', 'members', 'settings']) {
    for (const row of snap[resource] as Row[]) view[resource].set(row.id as string, row);
  }
  const inbox = snap.me.inbox_project_id as string | null;
  const settings = view.settings.get(`settings-${userId}`);
  const canAddTo = (id: string): boolean => canEditProject(view, id, userId);

  const projectId = input.projectId ?? inbox;
  if (!projectId || !view.projects.has(projectId)) fail('NOT_FOUND', 'dit project bestaat niet (meer), of je bent er geen lid meer van');
  if (!canAddTo(projectId as string)) fail('FORBIDDEN', 'je kunt dit project alleen lezen');
  if (input.sectionId !== null) {
    const s = view.sections.get(input.sectionId);
    if (!s || s.project_id !== projectId) fail('NOT_FOUND', 'deze sectie bestaat niet (meer)');
  }

  const moment = momentOf(input.typedAt, nowMs);
  const tz = zoneOf(input.tz, settings?.timezone);
  const today = epochToFloating(moment, tz).slice(0, 10);
  // de knoppen Vandaag en Morgen werken zoals "vandaag" in het overzicht Vandaag van de web-app: een standaard die getypte tekst verslaat
  const defaultDue = input.due === 'today' ? { date: today, string: 'vandaag', lang: 'nl' } : input.due === 'tomorrow' ? { date: nextDay(today), string: 'morgen', lang: 'nl' } : null;
  // de voorkeur "datums herkennen" van de gebruiker (shared/general.js), zoals in de web-app
  const dates = generalOf(settings).date_recognition;
  const parsed = inZone(tz, () => parseQuickAdd(input.text, { view, now: new Date(moment), defaultProjectId: projectId as string, defaultSectionId: input.sectionId, defaultDue, canAddTo, dates }));
  if (input.priority !== null && parsed.priority === 4) parsed.priority = input.priority; // getypt (p1 … p4) gaat voor
  if (!parsed.content) fail('INVALID_ARG', 'de taak heeft geen naam (alleen een datum, project of label)');

  // De commando's zoals de web-app ze maakt, met id's en uuid's die vastliggen voor dit uuid.
  const base = input.uuid ?? 'voorvertoning';
  let n = 0;
  let captured: Captured[] = [];
  const store = { view, userId, now: () => new Date(moment), enqueue: async (commands: Captured[]) => { captured = commands; } };
  const actions = createActions(store, { makeId: () => derivedId(userId, base, n++), makeUuid: () => 'nog-geen-uuid' });
  const taskId = await actions.addTask({ ...parsed });
  let labelNo = 0;
  let reminderNo = 0;
  const commands = captured.map((c) => {
    if (c.type === 'task_add') {
      // de volgorde in de lijst bepaalt de server zelf (dezelfde regel als de web-app: achteraan in dezelfde lijst)
      const { order_key: _ignored, ...args } = c.args;
      return { type: c.type, uuid: taskUuid(base), args };
    }
    return { ...c, uuid: c.type === 'label_add' ? `${base}-l${labelNo++}` : `${base}-r${reminderNo++}` };
  });

  const project = view.projects.get(parsed.project_id) as Row;
  const section = parsed.section_id ? view.sections.get(parsed.section_id) ?? null : null;
  const preview: QuickAddPreview = {
    content: parsed.content,
    due: parsed.due ?? null,
    deadline: parsed.deadline ?? null,
    duration: parsed.duration ?? null,
    project: { id: parsed.project_id, name: project.name as string, inbox: parsed.project_id === inbox },
    section: section ? { id: section.id as string, name: section.name as string } : null,
    labels: [...parsed.labels.map((id: string) => ({ name: (view.labels.get(id)?.name as string) ?? '', new: false })), ...parsed.newLabels.map((name: string) => ({ name, new: true }))],
    priority: parsed.priority,
    reminders: commands.filter((c) => c.type === 'reminder_add').map((c) => (c.args.type === 'absolute'
      ? { type: 'absolute' as const, date: (c.args.due as { date: string }).date }
      : { type: 'relative' as const, minute_offset: c.args.minute_offset as number })),
    auto_reminder: parsed.reminders.length === 0 && commands.some((c) => c.type === 'reminder_add'),
  };
  const answer = { quick_add: QUICK_ADD_VERSION, repeated: false, preview, tz, typed_at: new Date(moment).toISOString() };
  if (input.dryRun) return { ...answer, dry_run: true, task: null };

  try {
    handleSync(db, { sync_token: '*', resource_types: ['settings'], commands }, userId, { atomic: true });
  } catch (err) {
    // De taak bestaat al (het register van uitgevoerde commando's is na 30 dagen opgeruimd): dezelfde taak terug.
    if (err instanceof AtomicFailure && err.code === 'ID_EXISTS' && err.uuid === taskUuid(base)) {
      const existing = getRow(db, ENTITIES.task, taskId);
      if (existing && existing.creator_id === userId) return { ...answer, dry_run: false, repeated: true, task: visibleTask(db, userId, taskId), preview: null };
    }
    throw err;
  }
  return { ...answer, dry_run: false, task: visibleTask(db, userId, taskId) };
}

// ---------- hoe vaak ----------

/**
 * Hoe vaak iemand dit eindpunt mag aanroepen, per gebruiker en per minuut: toevoegen en voorvertonen elk apart (de
 * voorvertoning komt tijdens het typen, met een korte pauze ertussen). Daarboven: TOO_MANY_REQUESTS (429) met Retry-After.
 */
export class QuickAddLimiter {
  hits = new Map<string, number[]>();
  limits: { add: number; preview: number };
  windowMs: number;
  now: () => number;

  constructor(limits: Partial<{ add: number; preview: number }> = {}, windowMs = 60_000, now: () => number = Date.now) {
    this.limits = { add: 60, preview: 240, ...limits };
    this.windowMs = windowMs;
    this.now = now;
  }

  /** @returns 0 als het mag (en telt het mee), anders het aantal seconden tot het weer kan */
  take(userId: string, kind: 'add' | 'preview'): number {
    const key = `${kind}:${userId}`;
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => at > t - this.windowMs);
    if (recent.length >= this.limits[kind]) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + this.windowMs - t) / 1000));
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.every((at) => at <= t - this.windowMs)) this.hits.delete(k);
    return 0;
  }
}
