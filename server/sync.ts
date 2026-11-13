// De sync-engine: voert commando's uit en levert de delta sinds een token.
//
// Eén verzoek = één transactie. Elk commando draait in een eigen savepoint: een mislukt commando laat niets achter
// en breekt de rest niet af. Elk commando-uuid wordt hooguit één keer uitgevoerd (idempotent), zodat een client
// na een verbroken verbinding veilig kan herhalen.
//
// sync_token = het hoogste versienummer (rev) dat de client kent. Elke wijziging krijgt een hoger rev; een delta is
// alles met rev > token. Verwijderingen blijven als rijen met is_deleted=true bestaan, zodat ze in de delta meekomen.

import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { ENTITIES, ENTITY_LIST, ID_RE, INBOX_ID, RESOURCE_NAMES, toApi, validateValue } from './schema.ts';
import type { Col, Entity, EntityName } from './schema.ts';
import { keyAfter, isValidKey } from '../shared/orderKey.js';
import { nextOccurrence } from '../shared/recurrence.js';

type Recurrence = { freq: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval?: number; byweekday?: number[]; bymonthday?: number };
type Row = Record<string, unknown>;
type Args = Record<string, unknown>;
interface Ctx { db: DatabaseSync; rev: number; now: string }

export class SyncError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new SyncError(code, message);
}

export const newId = (): string => randomBytes(12).toString('base64url');
const has = (o: object, k: string): boolean => Object.hasOwn(o, k);
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

// ---------- versienummers ----------

export function currentRev(db: DatabaseSync): number {
  return Number((db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as Row).value);
}
function bumpRev(db: DatabaseSync): number {
  const r = currentRev(db) + 1;
  db.prepare("UPDATE meta SET value = ? WHERE key = 'rev'").run(String(r));
  return r;
}

// ---------- rijen lezen en schrijven ----------

function toDb(c: Col, v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (c.type === 'bool') return v ? 1 : 0;
  if (c.type === 'json') return JSON.stringify(v);
  return v as string | number;
}

const getRow = (db: DatabaseSync, e: Entity, id: string): Row | undefined =>
  db.prepare(`SELECT * FROM ${e.table} WHERE id = ?`).get(id) as Row | undefined;

function requireLive(db: DatabaseSync, name: EntityName, id: unknown, what: string): Row {
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('INVALID_ARG', `${what}: ongeldig id`);
  const row = getRow(db, ENTITIES[name], id);
  if (!row || row.is_deleted === 1) fail('NOT_FOUND', `${what}: ${name} bestaat niet`);
  return row;
}

/** Valideert de meegestuurde argumenten en geeft de te bewaren kolomwaarden terug. */
function collect(ctx: Ctx, e: Entity, args: Args, mode: 'add' | 'update'): Row {
  const allowed = new Set(['id', ...e.cols.map((c) => c.name)]);
  for (const k of Object.keys(args)) if (!allowed.has(k)) fail('UNKNOWN_ARG', `onbekend argument "${k}"`);
  const out: Row = {};
  for (const c of e.cols) {
    const given = has(args, c.name);
    if (given && c.serverManaged) fail('READONLY', `"${c.name}" wordt door de server beheerd`);
    if (given && mode === 'update' && c.immutable) fail('IMMUTABLE', `"${c.name}" kan hiermee niet worden gewijzigd`);
    if (given) {
      const v = args[c.name];
      const err = validateValue(c, v);
      if (err) fail('INVALID_ARG', `${e.name}.${c.name}: ${err}`);
      if (c.ref && v !== null) requireLive(ctx.db, c.ref, v, `${e.name}.${c.name}`);
      out[c.name] = v;
    } else if (mode === 'add') {
      if (c.required) fail('MISSING_ARG', `${e.name}.${c.name} is verplicht`);
      if (c.default !== undefined) out[c.name] = c.default;
    }
  }
  return out;
}

function scope(e: Entity, v: Row): { where: string; params: (string | null)[] } {
  switch (e.name) {
    case 'project': return { where: 'parent_id IS ?', params: [(v.parent_id as string | null) ?? null] };
    case 'section': return { where: 'project_id = ?', params: [v.project_id as string] };
    case 'task':
      return {
        where: 'project_id = ? AND section_id IS ? AND parent_id IS ?',
        params: [v.project_id as string, (v.section_id as string | null) ?? null, (v.parent_id as string | null) ?? null],
      };
    default: return { where: '1 = 1', params: [] };
  }
}

/** Een sleutel die achter de laatste broer/zus in dezelfde lijst komt. */
function nextKey(ctx: Ctx, e: Entity, v: Row): string {
  const s = scope(e, v);
  const r = ctx.db.prepare(`SELECT MAX(order_key) AS k FROM ${e.table} WHERE is_deleted = 0 AND ${s.where}`).get(...s.params) as Row;
  return keyAfter((r.k as string | null) ?? null);
}

function insertRow(ctx: Ctx, e: Entity, id: string, v: Row): void {
  const names = e.cols.map((c) => c.name);
  ctx.db
    .prepare(`INSERT INTO ${e.table} (id, ${names.join(', ')}, rev, is_deleted, created_at, updated_at) VALUES (?, ${placeholders(names.length)}, ?, 0, ?, ?)`)
    .run(id, ...e.cols.map((c) => toDb(c, v[c.name])), ctx.rev, ctx.now, ctx.now);
}

function updateRow(ctx: Ctx, e: Entity, id: string, changes: Row): void {
  const cols = e.cols.filter((c) => has(changes, c.name));
  if (cols.length === 0) return;
  ctx.db
    .prepare(`UPDATE ${e.table} SET ${cols.map((c) => `${c.name} = ?`).join(', ')}, rev = ?, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => toDb(c, changes[c.name])), ctx.rev, ctx.now, id);
}

function mark(ctx: Ctx, table: string, where: string, params: (string | number)[]): void {
  ctx.db.prepare(`UPDATE ${table} SET is_deleted = 1, rev = ?, updated_at = ? WHERE is_deleted = 0 AND (${where})`).run(ctx.rev, ctx.now, ...params);
}

// ---------- afspraken per entiteit (cross-field controles) ----------

function descendantIds(db: DatabaseSync, rootIds: string[]): string[] {
  const all = new Set<string>();
  let frontier = rootIds;
  while (frontier.length > 0) {
    const kids = db.prepare(`SELECT id FROM tasks WHERE is_deleted = 0 AND parent_id IN (${placeholders(frontier.length)})`).all(...frontier) as Row[];
    frontier = kids.map((k) => k.id as string).filter((i) => !all.has(i) && !rootIds.includes(i));
    frontier.forEach((i) => all.add(i));
  }
  return [...all];
}

/** `v` is in API-vorm (booleans, JSON uitgepakt). Bij 'add' mag verify standaardwaarden in `v` aanvullen. */
function verify(ctx: Ctx, e: Entity, id: string, v: Row, mode: 'add' | 'update'): void {
  const db = ctx.db;
  switch (e.name) {
    case 'project': {
      if (id === INBOX_ID && (v.parent_id !== null || v.is_archived === true)) fail('CONFLICT', 'de Inbox kan niet worden verplaatst of gearchiveerd');
      let p = v.parent_id as string | null;
      for (let i = 0; p && i < 1000; i++) {
        if (p === id) fail('CYCLE', 'een project kan niet in zichzelf of een eigen subproject staan');
        p = (getRow(db, ENTITIES.project, p)?.parent_id as string | null) ?? null;
      }
      break;
    }
    case 'label': {
      const dup = db.prepare('SELECT 1 FROM labels WHERE is_deleted = 0 AND lower(name) = lower(?) AND id <> ?').get(v.name as string, id);
      if (dup) fail('DUPLICATE', 'er bestaat al een label met deze naam');
      break;
    }
    case 'task': {
      for (const l of (v.labels as string[]) ?? []) requireLive(db, 'label', l, 'task.labels');
      if (mode === 'add') {
        const sectionId = v.section_id as string | null;
        const parentId = v.parent_id as string | null;
        if (parentId) {
          const parent = requireLive(db, 'task', parentId, 'task.parent_id');
          if (parent.project_id !== v.project_id) fail('CONFLICT', 'een subtaak hoort in hetzelfde project als de bovenliggende taak');
          if (sectionId && sectionId !== parent.section_id) fail('CONFLICT', 'een subtaak volgt de sectie van de bovenliggende taak');
          v.section_id = parent.section_id ?? null;
        } else if (sectionId) {
          const s = requireLive(db, 'section', sectionId, 'task.section_id');
          if (s.project_id !== v.project_id) fail('CONFLICT', 'de sectie hoort bij een ander project');
        }
      }
      break;
    }
    case 'comment':
      if ((v.task_id === null) === (v.project_id === null)) fail('INVALID_ARG', 'geef precies één van task_id of project_id');
      break;
    case 'reminder': {
      const due = v.due as { date: string } | null;
      if (v.type === 'relative') {
        if (v.minute_offset === null || v.minute_offset === undefined) fail('INVALID_ARG', 'een relatieve herinnering heeft minute_offset nodig');
        if (due) fail('INVALID_ARG', 'een relatieve herinnering heeft geen due');
      } else {
        if (!due || !due.date.includes('T')) fail('INVALID_ARG', 'een absolute herinnering heeft een due met tijdstip nodig');
        if (v.minute_offset !== null && v.minute_offset !== undefined) fail('INVALID_ARG', 'een absolute herinnering heeft geen minute_offset');
      }
      break;
    }
    default:
      break;
  }
}

// ---------- generieke commando's ----------

function addEntity(ctx: Ctx, e: Entity, args: Args): void {
  const id = args.id === undefined ? newId() : args.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('INVALID_ARG', 'id moet 8-40 tekens uit [A-Za-z0-9_-] zijn');
  if (getRow(ctx.db, e, id)) fail('ID_EXISTS', `${e.name} met dit id bestaat al`);
  const v = collect(ctx, e, args, 'add');
  verify(ctx, e, id, v, 'add');
  const oc = e.cols.find((c) => c.orderKey);
  if (oc && v[oc.name] === undefined) v[oc.name] = nextKey(ctx, e, v);
  insertRow(ctx, e, id, v);
}

function updateEntity(ctx: Ctx, e: Entity, args: Args): void {
  const row = requireLive(ctx.db, e.name, args.id, `${e.name}.id`);
  const changes = collect(ctx, e, args, 'update');
  verify(ctx, e, row.id as string, { ...toApi(e, row), ...changes }, 'update');
  updateRow(ctx, e, row.id as string, changes);
}

function onlyId(args: Args): string {
  for (const k of Object.keys(args)) if (k !== 'id') fail('UNKNOWN_ARG', `onbekend argument "${k}"`);
  return args.id as string;
}

function deleteTaskTree(ctx: Ctx, rootIds: string[]): void {
  if (rootIds.length === 0) return;
  const ids = [...rootIds, ...descendantIds(ctx.db, rootIds)];
  const ph = placeholders(ids.length);
  mark(ctx, 'tasks', `id IN (${ph})`, ids);
  mark(ctx, 'comments', `task_id IN (${ph})`, ids);
  mark(ctx, 'reminders', `task_id IN (${ph})`, ids);
}

function deleteProject(ctx: Ctx, rootId: string): void {
  const projects = [rootId];
  for (let i = 0; i < projects.length; i++) {
    const kids = ctx.db.prepare('SELECT id FROM projects WHERE is_deleted = 0 AND parent_id = ?').all(projects[i]) as Row[];
    for (const k of kids) if (!projects.includes(k.id as string)) projects.push(k.id as string);
  }
  for (const p of projects) {
    const tasks = (ctx.db.prepare('SELECT id FROM tasks WHERE is_deleted = 0 AND project_id = ?').all(p) as Row[]).map((r) => r.id as string);
    deleteTaskTree(ctx, tasks);
    mark(ctx, 'sections', 'project_id = ?', [p]);
    mark(ctx, 'comments', 'project_id = ?', [p]);
    mark(ctx, 'projects', 'id = ?', [p]);
  }
}

function deleteEntity(ctx: Ctx, e: Entity, args: Args): void {
  const id = onlyId(args);
  requireLive(ctx.db, e.name, id, `${e.name}.id`);
  switch (e.name) {
    case 'project':
      if (id === INBOX_ID) fail('CONFLICT', 'de Inbox kan niet worden verwijderd');
      deleteProject(ctx, id);
      break;
    case 'section': {
      const tasks = (ctx.db.prepare('SELECT id FROM tasks WHERE is_deleted = 0 AND section_id = ?').all(id) as Row[]).map((r) => r.id as string);
      deleteTaskTree(ctx, tasks);
      mark(ctx, 'sections', 'id = ?', [id]);
      break;
    }
    case 'task': deleteTaskTree(ctx, [id]); break;
    case 'label': {
      mark(ctx, 'labels', 'id = ?', [id]);
      // het label ook van alle taken halen; labels staan als id-lijst op de taak
      const tasks = ctx.db.prepare('SELECT id, labels FROM tasks WHERE is_deleted = 0 AND labels LIKE ?').all(`%${id}%`) as Row[];
      for (const t of tasks) {
        const before = JSON.parse(t.labels as string) as string[];
        const labels = before.filter((l) => l !== id);
        if (labels.length !== before.length) updateRow(ctx, ENTITIES.task, t.id as string, { labels });
      }
      break;
    }
    default: mark(ctx, e.table, 'id = ?', [id]);
  }
}

// ---------- taakspecifieke commando's ----------

function taskMove(ctx: Ctx, args: Args): void {
  const allowed = ['id', 'project_id', 'section_id', 'parent_id', 'order_key'];
  for (const k of Object.keys(args)) if (!allowed.includes(k)) fail('UNKNOWN_ARG', `onbekend argument "${k}"`);
  const row = requireLive(ctx.db, 'task', args.id, 'task.id');
  const id = row.id as string;
  if (!has(args, 'project_id') && !has(args, 'section_id') && !has(args, 'parent_id')) fail('MISSING_ARG', 'geef project_id, section_id of parent_id op');

  const projectChanges = has(args, 'project_id') && args.project_id !== row.project_id;
  if (has(args, 'project_id')) requireLive(ctx.db, 'project', args.project_id, 'task.project_id');
  const projectId = (has(args, 'project_id') ? args.project_id : row.project_id) as string;
  let parentId = (has(args, 'parent_id') ? args.parent_id : projectChanges ? null : row.parent_id) as string | null;
  let sectionId = (has(args, 'section_id') ? args.section_id : projectChanges ? null : row.section_id) as string | null;

  if (parentId !== null) {
    const parent = requireLive(ctx.db, 'task', parentId, 'task.parent_id');
    if (parent.project_id !== projectId) fail('CONFLICT', 'de bovenliggende taak staat in een ander project');
    for (let p: Row | undefined = parent, i = 0; p && i < 1000; i++) {
      if (p.id === id) fail('CYCLE', 'een taak kan niet onder zichzelf of een eigen subtaak staan');
      p = p.parent_id ? getRow(ctx.db, ENTITIES.task, p.parent_id as string) : undefined;
    }
    if (has(args, 'section_id') && args.section_id !== (parent.section_id ?? null)) fail('CONFLICT', 'een subtaak volgt de sectie van de bovenliggende taak');
    sectionId = (parent.section_id as string | null) ?? null;
  } else if (sectionId !== null) {
    const s = requireLive(ctx.db, 'section', sectionId, 'task.section_id');
    if (s.project_id !== projectId) fail('CONFLICT', 'de sectie hoort bij een ander project');
  }
  parentId = parentId ?? null;

  let orderKey: string;
  if (has(args, 'order_key')) {
    if (!isValidKey(args.order_key)) fail('INVALID_ARG', 'task.order_key: ongeldige volgordesleutel');
    orderKey = args.order_key as string;
  } else {
    orderKey = nextKey(ctx, ENTITIES.task, { project_id: projectId, section_id: sectionId, parent_id: parentId });
  }
  updateRow(ctx, ENTITIES.task, id, { project_id: projectId, section_id: sectionId, parent_id: parentId, order_key: orderKey });

  // subtaken gaan mee naar hetzelfde project en dezelfde sectie
  const kids = descendantIds(ctx.db, [id]);
  if (kids.length > 0) {
    ctx.db
      .prepare(`UPDATE tasks SET project_id = ?, section_id = ?, rev = ?, updated_at = ? WHERE id IN (${placeholders(kids.length)})`)
      .run(projectId, sectionId, ctx.rev, ctx.now, ...kids);
  }
}

function taskComplete(ctx: Ctx, args: Args): void {
  const id = onlyId(args);
  const row = requireLive(ctx.db, 'task', id, 'task.id');
  if (row.checked === 1) return; // al afgevinkt: herhaling is een no-op
  const due = row.due ? (JSON.parse(row.due as string) as { date: string; recurrence?: Recurrence }) : null;
  const count = (row.completed_count as number) + 1;
  if (due?.recurrence) {
    // terugkerend: naar de volgende datum, blijft open
    updateRow(ctx, ENTITIES.task, id, { due: { ...due, date: nextOccurrence(due.date, due.recurrence) }, completed_count: count });
    return;
  }
  updateRow(ctx, ENTITIES.task, id, { checked: true, completed_at: ctx.now, completed_count: count });
  const kids = descendantIds(ctx.db, [id]);
  if (kids.length > 0) {
    ctx.db
      .prepare(`UPDATE tasks SET checked = 1, completed_at = ?, rev = ?, updated_at = ? WHERE checked = 0 AND id IN (${placeholders(kids.length)})`)
      .run(ctx.now, ctx.rev, ctx.now, ...kids);
  }
}

function taskUncomplete(ctx: Ctx, args: Args): void {
  const id = onlyId(args);
  const row = requireLive(ctx.db, 'task', id, 'task.id');
  if (row.checked === 0) return;
  updateRow(ctx, ENTITIES.task, id, { checked: false, completed_at: null });
}

// ---------- commandoregister ----------

type Handler = (ctx: Ctx, args: Args) => void;
const HANDLERS: Record<string, Handler> = {};
for (const e of ENTITY_LIST) {
  HANDLERS[`${e.name}_add`] = (ctx, args) => addEntity(ctx, e, args);
  HANDLERS[`${e.name}_update`] = (ctx, args) => updateEntity(ctx, e, args);
  HANDLERS[`${e.name}_delete`] = (ctx, args) => deleteEntity(ctx, e, args);
}
HANDLERS.task_move = taskMove;
HANDLERS.task_complete = taskComplete;
HANDLERS.task_uncomplete = taskUncomplete;
export const COMMAND_TYPES: string[] = Object.keys(HANDLERS).sort();

// ---------- het sync-verzoek ----------

export interface Command { type: string; uuid: string; args?: Args }
export interface SyncRequest { sync_token?: string; resource_types?: string[]; commands?: Command[] }
export type CommandStatus = 'ok' | { error_code: string; error: string };
export interface SyncResponse {
  sync_token: string;
  full_sync: boolean;
  /** true als niet alle resourcetypen zijn opgevraagd; sla dan het nieuwe token niet op. */
  partial: boolean;
  sync_status: Record<string, CommandStatus>;
  [resource: string]: unknown;
}

const UUID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_COMMANDS = 100;
const COMMAND_RETENTION_DAYS = 30;

function resolveResources(requested: unknown): { include: Set<string>; partial: boolean } {
  const list = requested === undefined ? ['all'] : requested;
  if (!Array.isArray(list) || list.length === 0 || list.length > 40 || !list.every((x) => typeof x === 'string')) {
    fail('INVALID_REQUEST', 'resource_types moet een niet-lege lijst met tekst zijn');
  }
  const names = list as string[];
  const include = new Set<string>(names.includes('all') ? RESOURCE_NAMES : []);
  for (const n of names) {
    if (n === 'all') continue;
    const neg = n.startsWith('-');
    const name = neg ? n.slice(1) : n;
    if (!RESOURCE_NAMES.includes(name)) fail('INVALID_REQUEST', `onbekend resourcetype "${n}"`);
    if (neg) include.delete(name);
    else include.add(name);
  }
  return { include, partial: include.size !== RESOURCE_NAMES.length };
}

export function handleSync(db: DatabaseSync, req: unknown): SyncResponse {
  if (!req || typeof req !== 'object' || Array.isArray(req)) fail('INVALID_REQUEST', 'verzoek moet een JSON-object zijn');
  const r = req as SyncRequest;
  const token = r.sync_token ?? '*';
  if (typeof token !== 'string' || !/^(\*|\d{1,15})$/.test(token)) fail('INVALID_REQUEST', 'sync_token moet "*" of een getal zijn');
  const commands = r.commands ?? [];
  if (!Array.isArray(commands) || commands.length > MAX_COMMANDS) fail('INVALID_REQUEST', `commands moet een lijst van maximaal ${MAX_COMMANDS} zijn`);
  const { include, partial } = resolveResources(r.resource_types);
  for (const c of commands) {
    if (!c || typeof c !== 'object' || typeof c.type !== 'string' || typeof c.uuid !== 'string' || !UUID_RE.test(c.uuid)) {
      fail('INVALID_REQUEST', 'elk commando heeft een type en een uuid (8-64 tekens uit [A-Za-z0-9_-]) nodig');
    }
    if (c.args !== undefined && (typeof c.args !== 'object' || c.args === null || Array.isArray(c.args))) fail('INVALID_REQUEST', 'args moet een object zijn');
  }

  const status: Record<string, CommandStatus> = {};
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = new Date().toISOString();
    if (commands.length > 0) {
      const cutoff = new Date(Date.now() - COMMAND_RETENTION_DAYS * 86_400_000).toISOString();
      db.prepare('DELETE FROM commands WHERE at < ?').run(cutoff);
    }
    for (const cmd of commands) {
      const seen = db.prepare('SELECT status, error_code, error FROM commands WHERE uuid = ?').get(cmd.uuid) as Row | undefined;
      if (seen) {
        status[cmd.uuid] = seen.status === 'ok' ? 'ok' : { error_code: seen.error_code as string, error: seen.error as string };
        continue;
      }
      db.exec('SAVEPOINT cmd');
      let rev = 0;
      let result: CommandStatus;
      try {
        const handler = Object.hasOwn(HANDLERS, cmd.type) ? HANDLERS[cmd.type] : undefined;
        if (!handler) fail('UNKNOWN_COMMAND', `onbekend commando "${cmd.type}"`);
        rev = bumpRev(db);
        handler({ db, rev, now }, cmd.args ?? {});
        result = 'ok';
        db.exec('RELEASE cmd');
      } catch (err) {
        db.exec('ROLLBACK TO cmd');
        db.exec('RELEASE cmd');
        if (!(err instanceof SyncError)) console.error('onverwachte fout in commando', cmd.type, err);
        const se = err instanceof SyncError ? err : new SyncError('INTERNAL', 'interne fout');
        result = { error_code: se.code, error: se.message };
        rev = currentRev(db);
      }
      db.prepare('INSERT INTO commands (uuid, type, status, error_code, error, rev, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        cmd.uuid, cmd.type.slice(0, 64), result === 'ok' ? 'ok' : 'error', result === 'ok' ? null : result.error_code, result === 'ok' ? null : result.error, rev, now,
      );
      status[cmd.uuid] = result;
    }

    const cur = currentRev(db);
    let since = token === '*' ? 0 : Number(token);
    let full = token === '*';
    if (since > cur) { since = 0; full = true; } // de server is teruggezet: de client moet opnieuw beginnen
    const response: SyncResponse = { sync_token: String(cur), full_sync: full, partial, sync_status: status };
    for (const e of ENTITY_LIST) {
      if (!include.has(e.resource)) continue;
      const rows = db
        .prepare(`SELECT * FROM ${e.table} WHERE rev > ?${full ? ' AND is_deleted = 0' : ''} ORDER BY rev, id`)
        .all(since) as Row[];
      response[e.resource] = rows.map((row) => toApi(e, row));
    }
    db.exec('COMMIT');
    return response;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* transactie was al afgesloten */ }
    throw err;
  }
}
