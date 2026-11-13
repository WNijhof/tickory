// De sync-engine: voert commando's uit en levert de delta sinds een token.
//
// Eén verzoek = één transactie. Elk commando draait in een eigen savepoint: een mislukt commando laat niets achter
// en breekt de rest niet af. Elk commando-uuid wordt per gebruiker hooguit één keer uitgevoerd (idempotent), zodat
// een client na een verbroken verbinding veilig kan herhalen.
//
// sync_token = het hoogste versienummer (rev) dat de client kent. Elke wijziging krijgt een hoger rev; een delta is
// alles met rev > token dat de gebruiker mag zien. Verwijderingen blijven als rijen met is_deleted=true bestaan, zodat
// ze in de delta meekomen.
//
// Wie wat ziet (zie `visibility`):
//   - projecten, secties, taken, opmerkingen en leden: wie lid is van het project;
//   - labels, filters en herinneringen: de eigenaar (labels ook op taken in projecten waar je lid van bent: lezen mag, wijzigen niet).
// Verandert wat iemand mag zien (lid worden, verwijderd worden, een taak die naar een project van anderen verhuist), dan
// krijgt die persoon dat in de delta mee: alle inhoud van een nieuw project, of een verwijdering van wat verdween.

import type { DatabaseSync } from 'node:sqlite';
import { ENTITIES, ENTITY_LIST, ID_RE, INBOX_ID, isInboxId, RESOURCE_NAMES, toApi, validateValue } from './schema.ts';
import type { Col, Entity, EntityName } from './schema.ts';
import { keyAfter, isValidKey } from '../shared/orderKey.js';
import { nextOccurrence } from '../shared/recurrence.js';
import { deepNormalize, nameKey } from '../shared/text.js';
import { bumpRev, chunked, currentRev, fail, getRow, has, insertRow, mark, newId, placeholders, SyncError, updateRow } from './rows.ts';
import type { Ctx, Row } from './rows.ts';
import { ensureSettings, getUserById, getUserByName, peersOf, publicMe } from './users.ts';

export { currentRev, newId, SyncError, INBOX_ID };

type Recurrence = { freq: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval?: number; byweekday?: number[]; bymonthday?: number };
type Args = Record<string, unknown>;

// ---------- wie mag wat zien ----------

const MY_PROJECTS = 'SELECT project_id FROM project_members WHERE user_id = ? AND is_deleted = 0';

const roleOf = (db: DatabaseSync, userId: string, projectId: unknown): 'owner' | 'member' | null => {
  if (typeof projectId !== 'string') return null;
  const r = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND is_deleted = 0').get(projectId, userId) as Row | undefined;
  return (r?.role as 'owner' | 'member' | undefined) ?? null;
};
const isMember = (db: DatabaseSync, userId: string, projectId: unknown): boolean => roleOf(db, userId, projectId) !== null;

/** Een label is zichtbaar voor de eigenaar en voor wie het op een taak in een eigen project ziet staan. */
function labelVisible(db: DatabaseSync, userId: string, row: Row): boolean {
  if (row.owner_id === userId) return true;
  return db
    .prepare(`SELECT 1 FROM tasks t, json_each(t.labels) j WHERE j.value = ? AND t.is_deleted = 0 AND t.project_id IN (${MY_PROJECTS}) LIMIT 1`)
    .get(row.id as string, userId) !== undefined;
}

function canSee(db: DatabaseSync, userId: string, name: EntityName, row: Row): boolean {
  switch (name) {
    case 'project': return isMember(db, userId, row.id);
    case 'section': case 'task': case 'member': return isMember(db, userId, row.project_id);
    case 'comment': {
      if (row.task_id) {
        const t = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(row.task_id as string) as Row | undefined;
        return t !== undefined && isMember(db, userId, t.project_id);
      }
      return isMember(db, userId, row.project_id);
    }
    case 'label': return labelVisible(db, userId, row);
    case 'filter': case 'settings': return row.owner_id === userId;
    case 'reminder': {
      if (row.owner_id !== userId) return false;
      const t = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(row.task_id as string) as Row | undefined;
      return t !== undefined && isMember(db, userId, t.project_id);
    }
  }
}

/** Zoals getRow, maar alleen als het bestaat, niet verwijderd is en de gebruiker het mag zien. Anders "bestaat niet". */
function requireLive(ctx: Ctx, name: EntityName, id: unknown, what: string): Row {
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('INVALID_ARG', `${what}: ongeldig id`);
  const row = getRow(ctx.db, ENTITIES[name], id);
  if (!row || row.is_deleted === 1 || !canSee(ctx.db, ctx.userId, name, row)) fail('NOT_FOUND', `${what}: ${name} bestaat niet`);
  return row;
}

/** Wijzigen of verwijderen mag niet altijd als je iets mag zien: een label van een ander lees je alleen. */
function requireMayWrite(ctx: Ctx, e: Entity, row: Row): void {
  switch (e.name) {
    case 'label': case 'filter':
      if (row.owner_id !== ctx.userId) fail('FORBIDDEN', e.name === 'label' ? 'dit label is van iemand anders; je kunt het alleen lezen' : 'dit filter is van iemand anders');
      break;
    case 'comment':
      if (row.author_id !== null && row.author_id !== ctx.userId) fail('FORBIDDEN', 'je kunt alleen je eigen opmerkingen wijzigen of verwijderen');
      break;
    default:
      break;
  }
}

function requireOwner(ctx: Ctx, projectId: string, what: string): void {
  if (roleOf(ctx.db, ctx.userId, projectId) !== 'owner') fail('FORBIDDEN', what);
}

// ---------- rijen lezen en schrijven ----------

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
      // Alle tekst in NFC: een ontleed getypte "é" (e + los accent) wordt dezelfde "é" als elke andere (zie shared/text.js).
      const v = deepNormalize(args[c.name]);
      const err = validateValue(c, v);
      if (err) fail('INVALID_ARG', `${e.name}.${c.name}: ${err}`);
      if (c.ref && v !== null) requireLive(ctx, c.ref, v, `${e.name}.${c.name}`);
      out[c.name] = v;
    } else if (mode === 'add') {
      if (c.required) fail('MISSING_ARG', `${e.name}.${c.name} is verplicht`);
      if (c.stamp) out[c.name] = ctx.userId;
      else if (c.default !== undefined) out[c.name] = c.default;
    }
  }
  return out;
}

function scope(ctx: Ctx, e: Entity, v: Row): { where: string; params: (string | null)[] } {
  switch (e.name) {
    case 'project': return { where: `parent_id IS ? AND id IN (${MY_PROJECTS})`, params: [(v.parent_id as string | null) ?? null, ctx.userId] };
    case 'section': return { where: 'project_id = ?', params: [v.project_id as string] };
    case 'task':
      return {
        where: 'project_id = ? AND section_id IS ? AND parent_id IS ?',
        params: [v.project_id as string, (v.section_id as string | null) ?? null, (v.parent_id as string | null) ?? null],
      };
    case 'label': case 'filter': return { where: 'owner_id = ?', params: [ctx.userId] };
    default: return { where: '1 = 1', params: [] };
  }
}

/** Een sleutel die achter de laatste broer/zus in dezelfde lijst komt. */
function nextKey(ctx: Ctx, e: Entity, v: Row): string {
  const s = scope(ctx, e, v);
  const r = ctx.db.prepare(`SELECT MAX(order_key) AS k FROM ${e.table} WHERE is_deleted = 0 AND ${s.where}`).get(...s.params) as Row;
  return keyAfter((r.k as string | null) ?? null);
}

// ---------- afspraken per entiteit (cross-field controles) ----------

function descendantIds(db: DatabaseSync, rootIds: string[]): string[] {
  const all = new Set<string>();
  const roots = new Set(rootIds);
  let frontier = rootIds;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const part of chunked(frontier)) {
      const kids = db.prepare(`SELECT id FROM tasks WHERE is_deleted = 0 AND parent_id IN (${placeholders(part.length)})`).all(...part) as Row[];
      for (const k of kids) {
        const id = k.id as string;
        if (all.has(id) || roots.has(id)) continue;
        all.add(id);
        next.push(id);
      }
    }
    frontier = next;
  }
  return [...all];
}

/** Het project en al zijn subprojecten (alle niveaus), de wortel eerst. */
function projectTree(db: DatabaseSync, rootId: string): string[] {
  const projects = [rootId];
  for (let i = 0; i < projects.length; i++) {
    const kids = db.prepare('SELECT id FROM projects WHERE is_deleted = 0 AND parent_id = ?').all(projects[i]) as Row[];
    for (const k of kids) if (!projects.includes(k.id as string)) projects.push(k.id as string);
  }
  return projects;
}

/** `v` is in API-vorm (booleans, JSON uitgepakt). `given` zijn de kolommen die de client in dit commando meestuurde. */
function verify(ctx: Ctx, e: Entity, id: string, v: Row, mode: 'add' | 'update', given: Row): void {
  const db = ctx.db;
  switch (e.name) {
    case 'project': {
      if (isInboxId(id) && (v.parent_id !== null || v.is_archived === true)) fail('CONFLICT', 'de Inbox kan niet worden verplaatst of gearchiveerd');
      if (v.parent_id && isInboxId(v.parent_id)) fail('CONFLICT', 'de Inbox kan geen subprojecten hebben');
      let p = v.parent_id as string | null;
      for (let i = 0; p && i < 1000; i++) {
        if (p === id) fail('CYCLE', 'een project kan niet in zichzelf of een eigen subproject staan');
        p = (getRow(db, ENTITIES.project, p)?.parent_id as string | null) ?? null;
      }
      break;
    }
    case 'label': {
      // Vergelijken in JavaScript, niet met SQLite's lower(): dat kent alleen ASCII, dus "Café" en "CAFÉ" waren twee labels.
      // Alleen onder je eigen labels: een ander mag best dezelfde naam gebruiken.
      const key = nameKey(v.name as string);
      const others = db.prepare('SELECT name FROM labels WHERE is_deleted = 0 AND owner_id = ? AND id <> ?').all(ctx.userId, id) as Row[];
      if (others.some((o) => nameKey(o.name as string) === key)) fail('DUPLICATE', 'er bestaat al een label met deze naam');
      break;
    }
    case 'task': {
      for (const l of (v.labels as string[]) ?? []) requireLive(ctx, 'label', l, 'task.labels');
      if (v.assignee_id && has(given, 'assignee_id') && !isMember(db, v.assignee_id as string, v.project_id)) {
        fail('INVALID_ARG', 'de toegewezen persoon is geen lid van dit project');
      }
      if (mode === 'add') {
        const sectionId = v.section_id as string | null;
        const parentId = v.parent_id as string | null;
        if (parentId) {
          const parent = requireLive(ctx, 'task', parentId, 'task.parent_id');
          if (parent.project_id !== v.project_id) fail('CONFLICT', 'een subtaak hoort in hetzelfde project als de bovenliggende taak');
          if (sectionId && sectionId !== parent.section_id) fail('CONFLICT', 'een subtaak volgt de sectie van de bovenliggende taak');
          v.section_id = parent.section_id ?? null;
        } else if (sectionId) {
          const s = requireLive(ctx, 'section', sectionId, 'task.section_id');
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

/**
 * Een nieuw project: de maker wordt eigenaar. Een subproject krijgt dezelfde leden en rollen als het bovenliggende
 * project, en de maker is daar altijd eigenaar van (ook als hij in het bovenliggende project gewoon lid is).
 */
function addMembersForNewProject(ctx: Ctx, projectId: string, parentId: string | null): void {
  const members = new Map<string, string>();
  if (parentId) {
    const rows = ctx.db.prepare('SELECT user_id, role FROM project_members WHERE project_id = ? AND is_deleted = 0').all(parentId) as { user_id: string; role: string }[];
    for (const r of rows) members.set(r.user_id, r.role);
  }
  members.set(ctx.userId, 'owner');
  for (const [user_id, role] of members) insertRow(ctx, ENTITIES.member, newId(), { project_id: projectId, user_id, role });
}

function addEntity(ctx: Ctx, e: Entity, args: Args): void {
  const id = args.id === undefined ? newId() : args.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('INVALID_ARG', 'id moet 8-40 tekens uit [A-Za-z0-9_-] zijn');
  if (e.name === 'project' && isInboxId(id)) fail('INVALID_ARG', 'ids die met "inbox-" beginnen zijn gereserveerd');
  if (getRow(ctx.db, e, id)) fail('ID_EXISTS', `${e.name} met dit id bestaat al`);
  const v = collect(ctx, e, args, 'add');
  verify(ctx, e, id, v, 'add', v);
  const oc = e.cols.find((c) => c.orderKey);
  if (oc && v[oc.name] === undefined) v[oc.name] = nextKey(ctx, e, v);
  insertRow(ctx, e, id, v);
  if (e.name === 'project') addMembersForNewProject(ctx, id, (v.parent_id as string | null) ?? null);
}

function updateEntity(ctx: Ctx, e: Entity, args: Args): void {
  const row = requireLive(ctx, e.name, args.id, `${e.name}.id`);
  requireMayWrite(ctx, e, row);
  const changes = collect(ctx, e, args, 'update');
  if (e.name === 'project' && has(changes, 'parent_id') && changes.parent_id !== row.parent_id) {
    requireOwner(ctx, row.id as string, 'alleen de eigenaar kan een project verplaatsen');
  }
  verify(ctx, e, row.id as string, { ...toApi(e, row), ...changes }, 'update', changes);
  updateRow(ctx, e, row.id as string, changes);
}

function onlyId(args: Args): string {
  for (const k of Object.keys(args)) if (k !== 'id') fail('UNKNOWN_ARG', `onbekend argument "${k}"`);
  return args.id as string;
}

function deleteTaskTree(ctx: Ctx, rootIds: string[]): void {
  if (rootIds.length === 0) return;
  const ids = [...rootIds, ...descendantIds(ctx.db, rootIds)];
  for (const part of chunked(ids)) {
    const ph = placeholders(part.length);
    mark(ctx, 'tasks', `id IN (${ph})`, part);
    mark(ctx, 'comments', `task_id IN (${ph})`, part);
    mark(ctx, 'reminders', `task_id IN (${ph})`, part);
  }
}

/**
 * Verwijdert een project met alles erin. Subprojecten gaan alleen mee als de gebruiker daar ook eigenaar van is:
 * een subproject van iemand anders (bijvoorbeeld een privéproject dat onder dit project is gehangen) blijft bestaan
 * en komt op het hoogste niveau te staan, zodat verwijderen nooit andermans gegevens meeneemt.
 */
function deleteProject(ctx: Ctx, rootId: string): void {
  const projects = [rootId];
  for (let i = 0; i < projects.length; i++) {
    const kids = ctx.db.prepare('SELECT id FROM projects WHERE is_deleted = 0 AND parent_id = ?').all(projects[i]) as Row[];
    for (const k of kids) {
      const kid = k.id as string;
      if (roleOf(ctx.db, ctx.userId, kid) === 'owner') projects.push(kid);
      else updateRow(ctx, ENTITIES.project, kid, { parent_id: null });
    }
  }
  for (const p of projects) {
    const tasks = (ctx.db.prepare('SELECT id FROM tasks WHERE is_deleted = 0 AND project_id = ?').all(p) as Row[]).map((r) => r.id as string);
    deleteTaskTree(ctx, tasks);
    mark(ctx, 'sections', 'project_id = ?', [p]);
    mark(ctx, 'comments', 'project_id = ?', [p]);
    mark(ctx, 'projects', 'id = ?', [p]);
    mark(ctx, 'project_members', 'project_id = ?', [p]);
  }
}

function deleteEntity(ctx: Ctx, e: Entity, args: Args): void {
  const id = onlyId(args);
  const row = requireLive(ctx, e.name, id, `${e.name}.id`);
  requireMayWrite(ctx, e, row);
  switch (e.name) {
    case 'project':
      if (isInboxId(id)) fail('CONFLICT', 'de Inbox kan niet worden verwijderd');
      requireOwner(ctx, id, 'alleen de eigenaar kan een project verwijderen; gebruik "verlaten" om er zelf uit te gaan');
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
  const row = requireLive(ctx, 'task', args.id, 'task.id');
  const id = row.id as string;
  if (!has(args, 'project_id') && !has(args, 'section_id') && !has(args, 'parent_id')) fail('MISSING_ARG', 'geef project_id, section_id of parent_id op');

  const projectChanges = has(args, 'project_id') && args.project_id !== row.project_id;
  if (has(args, 'project_id')) requireLive(ctx, 'project', args.project_id, 'task.project_id');
  const projectId = (has(args, 'project_id') ? args.project_id : row.project_id) as string;
  let parentId = (has(args, 'parent_id') ? args.parent_id : projectChanges ? null : row.parent_id) as string | null;
  let sectionId = (has(args, 'section_id') ? args.section_id : projectChanges ? null : row.section_id) as string | null;

  if (parentId !== null) {
    const parent = requireLive(ctx, 'task', parentId, 'task.parent_id');
    if (parent.project_id !== projectId) fail('CONFLICT', 'de bovenliggende taak staat in een ander project');
    for (let p: Row | undefined = parent, i = 0; p && i < 1000; i++) {
      if (p.id === id) fail('CYCLE', 'een taak kan niet onder zichzelf of een eigen subtaak staan');
      p = p.parent_id ? getRow(ctx.db, ENTITIES.task, p.parent_id as string) : undefined;
    }
    if (has(args, 'section_id') && args.section_id !== (parent.section_id ?? null)) fail('CONFLICT', 'een subtaak volgt de sectie van de bovenliggende taak');
    sectionId = (parent.section_id as string | null) ?? null;
  } else if (sectionId !== null) {
    const s = requireLive(ctx, 'section', sectionId, 'task.section_id');
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
  const kids = descendantIds(ctx.db, [id]);
  if (projectChanges) {
    // Leden van het oude project die het nieuwe niet zien, krijgen via deze lijst te horen dat de taak (en subtaken) weg is.
    // Leden van het nieuwe project krijgen via dezelfde lijst ook de opmerkingen en herinneringen die bij de taak horen.
    const log = ctx.db.prepare('INSERT INTO task_moves (task_id, from_project_id, rev, at) VALUES (?, ?, ?, ?)');
    for (const t of [id, ...kids]) log.run(t, row.project_id as string, ctx.rev, ctx.now);
  }
  updateRow(ctx, ENTITIES.task, id, { project_id: projectId, section_id: sectionId, parent_id: parentId, order_key: orderKey });

  // subtaken gaan mee naar hetzelfde project en dezelfde sectie
  for (const part of chunked(kids)) {
    ctx.db
      .prepare(`UPDATE tasks SET project_id = ?, section_id = ?, rev = ?, updated_at = ? WHERE id IN (${placeholders(part.length)})`)
      .run(projectId, sectionId, ctx.rev, ctx.now, ...part);
  }
  if (projectChanges) {
    // een toegewezen persoon die geen lid is van het nieuwe project, blijft niet toegewezen
    for (const part of chunked([id, ...kids])) {
      const stale = (ctx.db.prepare(`SELECT id, assignee_id FROM tasks WHERE assignee_id IS NOT NULL AND id IN (${placeholders(part.length)})`).all(...part) as Row[])
        .filter((t) => !isMember(ctx.db, t.assignee_id as string, projectId));
      for (const t of stale) updateRow(ctx, ENTITIES.task, t.id as string, { assignee_id: null });
    }
  }
}

function taskComplete(ctx: Ctx, args: Args): void {
  const id = onlyId(args);
  const row = requireLive(ctx, 'task', id, 'task.id');
  if (row.checked === 1) return; // al afgevinkt: herhaling is een no-op
  const due = row.due ? (JSON.parse(row.due as string) as { date: string; recurrence?: Recurrence }) : null;
  const count = (row.completed_count as number) + 1;
  const next = due?.recurrence ? nextOccurrence(due.date, due.recurrence) : null;
  if (due && next) {
    // terugkerend: naar de volgende datum, blijft open
    updateRow(ctx, ENTITIES.task, id, { due: { ...due, date: next }, completed_count: count });
    return;
  }
  // Niet terugkerend, of er is geen volgende keer meer (de volgende datum valt na 9999-12-31): gewoon afvinken.
  updateRow(ctx, ENTITIES.task, id, { checked: true, completed_at: ctx.now, completed_count: count });
  for (const part of chunked(descendantIds(ctx.db, [id]))) {
    ctx.db
      .prepare(`UPDATE tasks SET checked = 1, completed_at = ?, rev = ?, updated_at = ? WHERE checked = 0 AND id IN (${placeholders(part.length)})`)
      .run(ctx.now, ctx.rev, ctx.now, ...part);
  }
}

function taskUncomplete(ctx: Ctx, args: Args): void {
  const id = onlyId(args);
  const row = requireLive(ctx, 'task', id, 'task.id');
  if (row.checked === 0) return;
  updateRow(ctx, ENTITIES.task, id, { checked: false, completed_at: null });
}

// ---------- delen ----------

function exactArgs(args: Args, allowed: string[]): void {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) fail('UNKNOWN_ARG', `onbekend argument "${k}"`);
}

/** Een persoon uit een project en de bijbehorende gegevens halen: hun toewijzingen en herinneringen voor die taken. */
function removeMember(ctx: Ctx, projectId: string, userId: string): void {
  mark(ctx, 'project_members', 'project_id = ? AND user_id = ?', [projectId, userId]);
  const tasks = (ctx.db.prepare('SELECT id FROM tasks WHERE project_id = ? AND is_deleted = 0').all(projectId) as Row[]).map((r) => r.id as string);
  for (const part of chunked(tasks)) {
    const ph = placeholders(part.length);
    mark(ctx, 'reminders', `owner_id = ? AND task_id IN (${ph})`, [userId, ...part]);
    const assigned = ctx.db.prepare(`SELECT id FROM tasks WHERE is_deleted = 0 AND assignee_id = ? AND id IN (${ph})`).all(userId, ...part) as Row[];
    for (const t of assigned) updateRow(ctx, ENTITIES.task, t.id as string, { assignee_id: null });
  }
}

function projectShare(ctx: Ctx, args: Args): void {
  exactArgs(args, ['project_id', 'username']);
  const project = requireLive(ctx, 'project', args.project_id, 'project_id');
  const id = project.id as string;
  if (isInboxId(id)) fail('CONFLICT', 'de Inbox kan niet worden gedeeld');
  requireOwner(ctx, id, 'alleen de eigenaar kan een project delen');
  if (typeof args.username !== 'string') fail('INVALID_ARG', 'username moet tekst zijn');
  const target = getUserByName(ctx.db, args.username);
  // zelfde melding voor "bestaat niet" en "geblokkeerd": zo is de lijst met gebruikers niet af te tasten
  if (!target || target.is_disabled) fail('NOT_FOUND', 'deze gebruiker bestaat niet');
  if (target.id === ctx.userId) return;
  // het project en de subprojecten waar de eigenaar ook eigenaar van is
  for (const p of projectTree(ctx.db, id)) {
    if (roleOf(ctx.db, ctx.userId, p) !== 'owner' || isMember(ctx.db, target.id, p)) continue;
    insertRow(ctx, ENTITIES.member, newId(), { project_id: p, user_id: target.id, role: 'member' });
  }
}

function projectUnshare(ctx: Ctx, args: Args): void {
  exactArgs(args, ['project_id', 'user_id']);
  const project = requireLive(ctx, 'project', args.project_id, 'project_id');
  const id = project.id as string;
  requireOwner(ctx, id, 'alleen de eigenaar kan iemand uit een project halen');
  const userId = args.user_id;
  if (typeof userId !== 'string' || !ID_RE.test(userId)) fail('INVALID_ARG', 'ongeldig gebruikers-id');
  if (userId === ctx.userId) fail('CONFLICT', 'gebruik "verlaten" om er zelf uit te gaan');
  const role = roleOf(ctx.db, userId, id);
  if (role === null) fail('NOT_FOUND', 'deze persoon is geen lid van het project');
  if (role === 'owner') fail('CONFLICT', 'een eigenaar kan niet uit het project worden gehaald');
  for (const p of projectTree(ctx.db, id)) {
    if (roleOf(ctx.db, ctx.userId, p) === 'owner' && roleOf(ctx.db, userId, p) === 'member') removeMember(ctx, p, userId);
  }
}

function projectLeave(ctx: Ctx, args: Args): void {
  exactArgs(args, ['project_id']);
  const project = requireLive(ctx, 'project', args.project_id, 'project_id');
  const id = project.id as string;
  if (isInboxId(id)) fail('CONFLICT', 'de Inbox kan niet worden verlaten');
  if (roleOf(ctx.db, ctx.userId, id) === 'owner') fail('CONFLICT', 'de eigenaar kan het project niet verlaten; verwijder het project of laat het door iemand anders overnemen');
  for (const p of projectTree(ctx.db, id)) if (roleOf(ctx.db, ctx.userId, p) === 'member') removeMember(ctx, p, ctx.userId);
}

// ---------- commandoregister ----------

type Handler = (ctx: Ctx, args: Args) => void;
const HANDLERS: Record<string, Handler> = {};
for (const e of ENTITY_LIST) {
  // welke algemene commando's een entiteit heeft, staat in de definitie (zie shared/schema.js)
  const verbs = e.commands === false ? [] : e.commands ?? ['add', 'update', 'delete'];
  if (verbs.includes('add')) HANDLERS[`${e.name}_add`] = (ctx, args) => addEntity(ctx, e, args);
  if (verbs.includes('update')) HANDLERS[`${e.name}_update`] = (ctx, args) => updateEntity(ctx, e, args);
  if (verbs.includes('delete')) HANDLERS[`${e.name}_delete`] = (ctx, args) => deleteEntity(ctx, e, args);
}
HANDLERS.task_move = taskMove;
HANDLERS.task_complete = taskComplete;
HANDLERS.task_uncomplete = taskUncomplete;
HANDLERS.project_share = projectShare;
HANDLERS.project_unshare = projectUnshare;
HANDLERS.project_leave = projectLeave;
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
  me: ReturnType<typeof publicMe>;
  /** De gebruiker zelf en iedereen met wie een project wordt gedeeld (alleen om namen te tonen). */
  users: { id: string; username: string; name: string }[];
  [resource: string]: unknown;
}

const UUID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_COMMANDS = 100;
const COMMAND_RETENTION_DAYS = 30;
/** Hoe lang de sync onthoudt welke taken naar een ander project zijn verhuisd (voor wie die taak kende en het nieuwe project niet ziet). */
export const TASK_MOVES_RETENTION_DAYS = 90;

/** Het hoogste versienummer waarvan het verhuis-logboek is opgeruimd; wie een ouder token heeft, moet opnieuw beginnen. */
function taskMovesFloor(db: DatabaseSync): number {
  return Number((db.prepare("SELECT value FROM meta WHERE key = 'task_moves_floor'").get() as Row | undefined)?.value ?? 0);
}

/** Ruimt verhuis-regels op die ouder zijn dan de bewaartermijn, en onthoudt tot welk versienummer dat is gebeurd. */
export function pruneTaskMoves(db: DatabaseSync, nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs - TASK_MOVES_RETENTION_DAYS * 86_400_000).toISOString();
  const oldest = (db.prepare('SELECT MAX(rev) AS r FROM task_moves WHERE at < ?').get(cutoff) as Row).r;
  if (oldest === null || oldest === undefined) return 0;
  const floor = Math.max(taskMovesFloor(db), Number(oldest));
  db.prepare("INSERT INTO meta (key, value) VALUES ('task_moves_floor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(floor));
  return Number(db.prepare('DELETE FROM task_moves WHERE at < ?').run(cutoff).changes);
}

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

/** De voorwaarde (SQL) die bepaalt welke rijen van een entiteit deze gebruiker nu mag zien. */
function visibility(name: EntityName, uid: string): { sql: string; params: string[] } {
  const tasksOfMine = `SELECT id FROM tasks WHERE project_id IN (${MY_PROJECTS})`;
  switch (name) {
    case 'project': return { sql: `id IN (${MY_PROJECTS})`, params: [uid] };
    case 'section': case 'task': case 'member': return { sql: `project_id IN (${MY_PROJECTS})`, params: [uid] };
    case 'comment': return { sql: `(project_id IN (${MY_PROJECTS}) OR task_id IN (${tasksOfMine}))`, params: [uid, uid] };
    case 'label':
      return {
        sql: `(owner_id = ? OR id IN (SELECT j.value FROM tasks t, json_each(t.labels) j WHERE t.is_deleted = 0 AND t.project_id IN (${MY_PROJECTS})))`,
        params: [uid, uid],
      };
    case 'filter': case 'settings': return { sql: 'owner_id = ?', params: [uid] };
    case 'reminder': return { sql: `(owner_id = ? AND task_id IN (${tasksOfMine}))`, params: [uid, uid] };
  }
}

// Projecten die de gebruiker sinds het token erbij kreeg (en dus nog helemaal niet kent), als subquery. Een subquery in plaats
// van een lijst met waarden: een lijst groeit met de gegevens mee en SQLite staat er hooguit 32766 in één query toe.
const GAINED = 'SELECT project_id FROM project_members WHERE user_id = ? AND is_deleted = 0 AND rev > ?';
// Het deel daarvan dat de gebruiker nooit eerder had: wie al eens lid was en tussendoor is verwijderd, kan er nog gegevens van
// hebben, en moet dus ook horen wat er in de tussentijd is verwijderd (alleen als {id, is_deleted}, zonder inhoud).
const GAINED_NEW = `${GAINED} AND project_id NOT IN (SELECT project_id FROM project_members WHERE user_id = ? AND is_deleted = 1)`;
const MOVED_SINCE = 'SELECT task_id FROM task_moves WHERE rev > ?';

/** Alles van de projecten in `projects` (een subquery met zijn waarden), ook als het oud is (rev ≤ token). */
function inProjects(name: EntityName, uid: string, projects: string, params: (string | number)[]): { sql: string; params: (string | number)[] } | null {
  const tasksIn = `SELECT id FROM tasks WHERE project_id IN (${projects})`;
  switch (name) {
    case 'project': return { sql: `id IN (${projects})`, params: [...params] };
    case 'section': case 'task': case 'member': return { sql: `project_id IN (${projects})`, params: [...params] };
    case 'comment': return { sql: `(project_id IN (${projects}) OR task_id IN (${tasksIn}))`, params: [...params, ...params] };
    case 'reminder': return { sql: `(owner_id = ? AND task_id IN (${tasksIn}))`, params: [uid, ...params] };
    default: return null;
  }
}

function collectResources(db: DatabaseSync, uid: string, include: Set<string>, since: number, full: boolean, response: SyncResponse): void {
  // Projecten waar de gebruiker uit is gehaald.
  const lost = full
    ? []
    : (db
        .prepare(`SELECT DISTINCT project_id FROM project_members WHERE user_id = ? AND is_deleted = 1 AND rev > ? AND project_id NOT IN (${MY_PROJECTS})`)
        .all(uid, since, uid) as Row[]).map((r) => r.project_id as string);
  // Taken die naar een project verhuisden dat deze gebruiker niet ziet, terwijl die ze wel kende.
  const moved = full
    ? []
    : (db
        .prepare(
          `SELECT DISTINCT m.task_id FROM task_moves m JOIN tasks t ON t.id = m.task_id
           WHERE m.rev > ? AND m.from_project_id IN (${MY_PROJECTS}) AND t.project_id NOT IN (${MY_PROJECTS})`,
        )
        .all(since, uid, uid) as Row[]).map((r) => r.task_id as string);
  for (const e of ENTITY_LIST) {
    if (!include.has(e.resource)) continue;
    const vis = visibility(e.name, uid);
    let where = vis.sql;
    const params: (string | number)[] = [...vis.params];
    if (full) {
      where += ' AND is_deleted = 0';
    } else {
      // Wat de gebruiker sinds het token wel mag zien maar niet kent, ook als het zelf oud is (rev ≤ token):
      //  - alles van een project waar hij net lid van werd;
      //  - de opmerkingen en herinneringen van een taak die naar een project van hem is verhuisd;
      //  - labels van anderen die op een taak in zijn projecten zijn gekomen.
      const extra: string[] = [];
      const extraParams: (string | number)[] = [];
      const np = inProjects(e.name, uid, GAINED, [uid, since]);
      if (np) { extra.push(np.sql); extraParams.push(...np.params); }
      if (e.name === 'comment') { extra.push(`task_id IN (${MOVED_SINCE})`); extraParams.push(since); }
      if (e.name === 'reminder') { extra.push(`(owner_id = ? AND task_id IN (${MOVED_SINCE}))`); extraParams.push(uid, since); }
      if (e.name === 'label') {
        extra.push(`id IN (SELECT j.value FROM tasks t, json_each(t.labels) j WHERE t.is_deleted = 0 AND t.project_id IN (${MY_PROJECTS}) AND (t.rev > ? OR t.project_id IN (${GAINED})))`);
        extraParams.push(uid, since, uid, since);
      }
      where += ` AND (rev > ?${extra.length ? ` OR (is_deleted = 0 AND (${extra.join(' OR ')}))` : ''})`;
      params.push(since, ...extraParams);
      // Verwijderde rijen van een project dat de gebruiker nooit eerder had, zijn voor hem niet bestaand: niets sturen.
      const fresh = inProjects(e.name, uid, GAINED_NEW, [uid, since, uid]);
      if (fresh) { where += ` AND NOT (is_deleted = 1 AND (${fresh.sql}))`; params.push(...fresh.params); }
    }
    // Een verwijderde rij gaat nooit met zijn inhoud mee, alleen als {id, is_deleted}: dat is wat een client nodig heeft om
    // hem op te ruimen. De inhoud van wat is verwijderd, hoort niet bij iemand te komen die er nooit bij was.
    const out = (db.prepare(`SELECT * FROM ${e.table} WHERE ${where} ORDER BY rev, id`).all(...params) as Row[])
      .map((row) => (row.is_deleted === 1 ? { id: row.id, is_deleted: true } : toApi(e, row)));
    // verdwenen toegang: de client verwijdert het project met alles erin
    if (e.name === 'project') for (const p of lost) out.push({ id: p, is_deleted: true });
    if (e.name === 'task') for (const t of moved) out.push({ id: t, is_deleted: true });
    response[e.resource] = out;
  }
}

export function handleSync(db: DatabaseSync, req: unknown, userId: string): SyncResponse {
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
    const me = getUserById(db, userId);
    if (!me || me.is_disabled) fail('UNAUTHORIZED', 'gebruiker bestaat niet of is geblokkeerd');
    const now = new Date().toISOString();
    // een account van vóór de persoonlijke instellingen krijgt ze hier alsnog (eenmalig, met een eigen versienummer)
    if (!db.prepare('SELECT 1 FROM user_settings WHERE owner_id = ?').get(userId)) ensureSettings({ db, rev: bumpRev(db), now, userId });
    if (commands.length > 0) {
      const cutoff = new Date(Date.now() - COMMAND_RETENTION_DAYS * 86_400_000).toISOString();
      db.prepare('DELETE FROM command_log WHERE at < ?').run(cutoff);
      pruneTaskMoves(db);
    }
    for (const cmd of commands) {
      const seen = db.prepare('SELECT status, error_code, error FROM command_log WHERE user_id = ? AND uuid = ?').get(userId, cmd.uuid) as Row | undefined;
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
        handler({ db, rev, now, userId }, cmd.args ?? {});
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
      db.prepare('INSERT INTO command_log (user_id, uuid, type, status, error_code, error, rev, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        userId, cmd.uuid, cmd.type.slice(0, 64), result === 'ok' ? 'ok' : 'error', result === 'ok' ? null : result.error_code, result === 'ok' ? null : result.error, rev, now,
      );
      status[cmd.uuid] = result;
    }

    const cur = currentRev(db);
    let since = token === '*' ? 0 : Number(token);
    let full = token === '*';
    if (since > cur) { since = 0; full = true; } // de server is teruggezet: de client moet opnieuw beginnen
    // Een token van vóór het opgeruimde deel van het verhuis-logboek: de server weet niet meer welke taken er sindsdien
    // uit zijn projecten zijn verhuisd, dus de client moet opnieuw beginnen.
    if (!full && since < taskMovesFloor(db)) { since = 0; full = true; }
    const response: SyncResponse = { sync_token: String(cur), full_sync: full, partial, sync_status: status, me: publicMe(me), users: peersOf(db, userId) };
    collectResources(db, userId, include, since, full, response);
    db.exec('COMMIT');
    return response;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* transactie was al afgesloten */ }
    throw err;
  }
}
