// Optimistische uitvoering van commando's op de lokale kopie, zodat de app direct (en offline) reageert.
// Dit spiegelt de regels van de server (server/sync.ts). De server blijft leidend: na elke sync wordt de
// bevestigde toestand overgenomen en worden alleen de nog niet bevestigde commando's opnieuw toegepast.
// Een test vergelijkt deze uitvoering commando voor commando met de echte server.
//
// Afspraak: `state` bevat per resource een Map (id -> rij) met alleen niet-verwijderde rijen. De Maps zijn een
// eigen kopie en mogen worden gewijzigd; rij-objecten worden altijd vervangen, nooit aangepast.

import { ENTITIES, ENTITY_LIST, isInboxId } from '../../shared/schema.js';
import { isValidKey, keyAfter } from '../../shared/orderKey.js';
import { nextDue, nextOccurrence } from '../../shared/recurrence.js';
import { canEditRole, SHARE_ROLES } from '../../shared/roles.js';

export const RESOURCES = ENTITY_LIST.map((e) => e.resource);

export function emptyState() {
  const s = {};
  for (const r of RESOURCES) s[r] = new Map();
  return s;
}

export function cloneState(state) {
  const s = {};
  for (const r of RESOURCES) s[r] = new Map(state[r]);
  return s;
}

const has = (o, k) => Object.hasOwn(o, k);
const copyDefault = (d) => (Array.isArray(d) ? [...d] : d);

/** Voorwaarde voor "dezelfde lijst" (broers/zussen), gelijk aan de server. */
export function scopeOf(entityName, v) {
  switch (entityName) {
    case 'project': return (r) => (r.parent_id ?? null) === (v.parent_id ?? null);
    case 'section': return (r) => r.project_id === v.project_id;
    case 'task':
      return (r) => r.project_id === v.project_id && (r.section_id ?? null) === (v.section_id ?? null) && (r.parent_id ?? null) === (v.parent_id ?? null);
    default: return () => true;
  }
}

/** Hoogste volgordesleutel in een lijst, of null als die leeg is. */
export function maxKey(rows, pred, exceptId = null) {
  let m = null;
  for (const r of rows.values()) {
    if (r.id !== exceptId && r.order_key && pred(r) && (m === null || r.order_key > m)) m = r.order_key;
  }
  return m;
}

/** Alle (klein)kinderen van de gegeven taken. */
export function descendantIds(state, rootIds) {
  const children = new Map();
  for (const t of state.tasks.values()) {
    if (!t.parent_id) continue;
    if (!children.has(t.parent_id)) children.set(t.parent_id, []);
    children.get(t.parent_id).push(t.id);
  }
  const seen = new Set(rootIds);
  const out = [];
  const todo = [...rootIds];
  while (todo.length > 0) {
    for (const kid of children.get(todo.pop()) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      out.push(kid);
      todo.push(kid);
    }
  }
  return out;
}

function patch(state, resource, id, changes, now) {
  const old = state[resource].get(id);
  if (old) state[resource].set(id, { ...old, ...changes, updated_at: now });
}

function removeWhere(state, resource, pred) {
  for (const r of [...state[resource].values()]) if (pred(r)) state[resource].delete(r.id);
}

function add(state, e, args, now, userId) {
  const id = args.id;
  if (typeof id !== 'string' || state[e.resource].has(id)) return;
  if (e.name === 'project' && isInboxId(id)) return; // gereserveerd, zoals op de server
  const row = { id };
  for (const c of e.cols) {
    // maker/eigenaar/auteur vult de server in met de gebruiker die het commando uitvoert; hier doen we alvast hetzelfde
    row[c.name] = c.stamp ? userId : has(args, c.name) ? args[c.name] : c.default !== undefined ? copyDefault(c.default) : null;
  }
  if (e.name === 'comment') {
    // precies één van task_id en project_id, en dat moet bestaan (de server weigert anders)
    if ((row.task_id === null) === (row.project_id === null)) return;
    if (row.task_id !== null ? !state.tasks.has(row.task_id) : !state.projects.has(row.project_id)) return;
    row.mentions = onlyMembers(state, row, row.mentions);
  }
  if (e.name === 'attachment') {
    // hoort bij een bestaande taak, en een taak heeft hooguit zoveel bijlagen (zoals de server; zie server/limits.ts)
    if (!state.tasks.has(row.task_id)) return;
    let count = 0;
    for (const a of state.attachments.values()) if (a.task_id === row.task_id) count += 1;
    if (count >= MAX_ATTACHMENTS_PER_TASK) return;
  }
  if (e.name === 'reminder') {
    // een locatieherinnering heeft een eigen plaats nodig en een trigger, de andere soorten niet (zoals op de server)
    if (row.type === 'location') {
      if (!row.place_id || !state.places.has(row.place_id) || !row.trigger || row.due || row.minute_offset !== null) return;
    } else if (row.place_id || row.trigger) return;
  }
  if (e.name === 'task' && row.parent_id) {
    const parent = state.tasks.get(row.parent_id);
    if (!parent) return;
    row.section_id = parent.section_id ?? null; // een subtaak volgt de sectie van de bovenliggende taak
  }
  if (e.cols.some((c) => c.orderKey) && !row.order_key) row.order_key = keyAfter(maxKey(state[e.resource], scopeOf(e.name, row)));
  row.is_deleted = false;
  row.created_at = now;
  row.updated_at = now;
  state[e.resource].set(id, row);
  if (e.name === 'project') addMembers(state, row, userId, now);
}

/** Zoals op de server: de maker is eigenaar; een subproject krijgt dezelfde leden en rollen als het bovenliggende project. */
function addMembers(state, project, userId, now) {
  if (!userId) return;
  const roles = new Map();
  if (project.parent_id) for (const m of state.members.values()) if (m.project_id === project.parent_id) roles.set(m.user_id, m.role);
  roles.set(userId, 'owner');
  for (const [user_id, role] of roles) {
    const id = `local-member-${project.id}-${user_id}`.slice(0, 40);
    state.members.set(id, { id, project_id: project.id, user_id, role, is_deleted: false, created_at: now, updated_at: now });
  }
}

function update(state, e, args, now) {
  const changes = {};
  for (const c of e.cols) if (has(args, c.name) && !c.immutable && !c.serverManaged) changes[c.name] = args[c.name];
  if (e.name === 'comment' && has(changes, 'mentions') && state.comments.has(args.id)) changes.mentions = onlyMembers(state, state.comments.get(args.id), changes.mentions);
  patch(state, e.resource, args.id, changes, now);
}

/** Zoals de server: in een opmerking blijven alleen vermelde personen staan die lid zijn van het project (de rest valt weg). */
function onlyMembers(state, comment, mentions) {
  if (!Array.isArray(mentions)) return mentions;
  const projectId = comment.task_id ? state.tasks.get(comment.task_id)?.project_id : comment.project_id;
  const members = new Set([...state.members.values()].filter((m) => m.project_id === projectId).map((m) => m.user_id));
  return mentions.filter((id) => members.has(id));
}

/** Alle eigen meldingen gelezen (tot en met `up_to`, het tijdstip van de nieuwste die de afzender zag), zoals de server. */
function readAllNotifications(state, args, now, userId) {
  for (const n of [...(state.notifications?.values() ?? [])]) {
    if (n.is_read || (userId && n.owner_id !== userId)) continue;
    if (typeof args.up_to === 'string' && n.created_at > args.up_to) continue;
    patch(state, 'notifications', n.id, { is_read: true }, now);
  }
}

function deleteTaskTree(state, rootIds) {
  if (rootIds.length === 0) return;
  const ids = new Set([...rootIds, ...descendantIds(state, rootIds)]);
  for (const id of ids) state.tasks.delete(id);
  removeWhere(state, 'comments', (c) => ids.has(c.task_id));
  removeWhere(state, 'attachments', (a) => ids.has(a.task_id));
  removeWhere(state, 'reminders', (r) => ids.has(r.task_id));
  removeWhere(state, 'notifications', (n) => ids.has(n.task_id)); // zoals de server: een melding over een verdwenen taak gaat mee
}

/** De rol van een gebruiker in een project (`owner`, `member`, `viewer`), of null. */
function roleOf(state, userId, projectId) {
  for (const m of state.members.values()) if (m.project_id === projectId && m.user_id === userId) return m.role;
  return null;
}

/** Is deze gebruiker eigenaar van het project? Zonder bekende gebruiker (tests, vóór de eerste sync) tellen we het als ja. */
function isOwner(state, userId, projectId) {
  if (!userId) return true;
  return roleOf(state, userId, projectId) === 'owner';
}

/**
 * Mag deze gebruiker in het project wijzigen (taken, secties, bijlagen, het project zelf)? Een lezer niet (shared/roles.js), net als op de
 * server. Zonder bekende gebruiker tellen we het als ja.
 */
function mayEdit(state, userId, projectId) {
  if (!userId) return true;
  const role = roleOf(state, userId, projectId);
  if (role !== null) return canEditRole(role);
  // Kent de app de leden van het project (nog) niet, dan beslist de server; een lezer heeft altijd zijn eigen ledenrij.
  for (const m of state.members.values()) if (m.project_id === projectId) return false;
  return true;
}

/** Het project waarvan de inhoud verandert bij een wijziging van deze rij; null voor wat ook een lezer mag (zoals de server). */
function editedProject(state, entityName, row) {
  switch (entityName) {
    case 'project': return row.id;
    case 'section': case 'task': return row.project_id;
    case 'attachment': return state.tasks.get(row.task_id)?.project_id ?? null;
    default: return null;
  }
}

/** Toewijzen kan alleen aan wie in het project kan bewerken (een lezer niet), zoals de server (die geeft anders INVALID_ARG). */
function mayAssign(state, userId, projectId, assigneeId) {
  if (!userId || assigneeId === null || assigneeId === undefined) return true;
  return canEditRole(roleOf(state, assigneeId, projectId));
}

/**
 * De rol van een lid wijzigen (`member_update`), zoals de server: alleen de eigenaar, niet van jezelf of een eigenaar; ook in de
 * subprojecten waar je eigenaar bent. Wie lezer wordt, verliest zijn toewijzingen daar.
 */
function updateMemberRole(state, args, now, userId) {
  const { project_id: projectId, user_id: target, role } = args;
  if (!state.projects.has(projectId) || !SHARE_ROLES.includes(role) || target === userId) return;
  if (!isOwner(state, userId, projectId)) return;
  const current = roleOf(state, target, projectId);
  if (current === null || current === 'owner') return;
  const tree = [projectId];
  for (let i = 0; i < tree.length; i++) for (const p of state.projects.values()) if (p.parent_id === tree[i] && !tree.includes(p.id)) tree.push(p.id);
  for (const p of tree) {
    const before = roleOf(state, target, p);
    if (!isOwner(state, userId, p) || before === null || before === 'owner' || before === role) continue;
    for (const m of [...state.members.values()]) if (m.project_id === p && m.user_id === target) patch(state, 'members', m.id, { role }, now);
    if (!canEditRole(role)) {
      for (const t of [...state.tasks.values()]) if (t.project_id === p && t.assignee_id === target) patch(state, 'tasks', t.id, { assignee_id: null }, now);
    }
  }
}

/**
 * Mag dit project zo worden gewijzigd? Alleen een nieuwe bovenliggende (verplaatsen) kent regels, net als op de server: alleen
 * de eigenaar, het bovenliggende project moet bestaan, de Inbox kan niet verplaatst worden of subprojecten hebben, en geen cirkels.
 */
function mayUpdateProject(state, args, userId) {
  const row = state.projects.get(args.id);
  if (!row) return true; // niet te vinden: update() doet zelf niets
  const parentId = has(args, 'parent_id') ? args.parent_id ?? null : row.parent_id ?? null;
  if (isInboxId(args.id) && parentId !== null) return false;
  if (!has(args, 'parent_id') || parentId === (row.parent_id ?? null)) return true;
  if (userId && !isOwner(state, userId, args.id)) return false;
  if (parentId === null) return true;
  if (!state.projects.has(parentId) || isInboxId(parentId)) return false;
  for (let p = parentId, i = 0; p && i < 1000; i++) {
    if (p === args.id) return false;
    p = state.projects.get(p)?.parent_id ?? null;
  }
  return true;
}

function remove(state, e, args, now, userId) {
  const id = args.id;
  if (!state[e.resource].has(id)) return;
  switch (e.name) {
    case 'project': {
      if (isInboxId(id)) return;
      if (userId && !isOwner(state, userId, id)) return; // alleen de eigenaar kan een project verwijderen
      // Subprojecten gaan alleen mee als je er zelf eigenaar van bent; andermans projecten komen op het hoogste niveau te staan.
      const projects = [id];
      for (let i = 0; i < projects.length; i++) {
        for (const p of [...state.projects.values()]) {
          if (p.parent_id !== projects[i] || projects.includes(p.id)) continue;
          if (isOwner(state, userId, p.id)) projects.push(p.id);
          else patch(state, 'projects', p.id, { parent_id: null }, now);
        }
      }
      const gone = new Set(projects);
      deleteTaskTree(state, [...state.tasks.values()].filter((t) => gone.has(t.project_id)).map((t) => t.id));
      removeWhere(state, 'sections', (s) => gone.has(s.project_id));
      removeWhere(state, 'comments', (c) => gone.has(c.project_id));
      removeWhere(state, 'members', (m) => gone.has(m.project_id));
      removeWhere(state, 'notifications', (n) => gone.has(n.project_id));
      for (const p of projects) state.projects.delete(p);
      break;
    }
    case 'section':
      deleteTaskTree(state, [...state.tasks.values()].filter((t) => t.section_id === id).map((t) => t.id));
      state.sections.delete(id);
      break;
    case 'task':
      deleteTaskTree(state, [id]);
      break;
    case 'comment':
      state.comments.delete(id);
      removeWhere(state, 'notifications', (n) => n.comment_id === id);
      break;
    case 'place':
      // de herinneringen op deze plaats gaan mee, zoals op de server
      removeWhere(state, 'reminders', (r) => r.place_id === id);
      state.places.delete(id);
      break;
    case 'label':
      state.labels.delete(id);
      for (const t of [...state.tasks.values()]) {
        if (t.labels.includes(id)) patch(state, 'tasks', t.id, { labels: t.labels.filter((l) => l !== id) }, now);
      }
      break;
    default:
      state[e.resource].delete(id);
  }
}

const TASK_MOVE_ARGS = ['id', 'project_id', 'section_id', 'parent_id', 'order_key'];

function taskMove(state, args, now, userId) {
  // Net als de server: wat niet kan (onbekend argument, cirkel, sectie van een ander project, ongeldige sleutel, een project dat je
  // alleen leest) doet niets.
  if (Object.keys(args).some((k) => !TASK_MOVE_ARGS.includes(k))) return;
  const row = state.tasks.get(args.id);
  if (!row || !mayEdit(state, userId, row.project_id)) return;
  if (has(args, 'project_id') && !mayEdit(state, userId, args.project_id)) return;
  if (!has(args, 'project_id') && !has(args, 'section_id') && !has(args, 'parent_id')) return;
  const projectChanges = has(args, 'project_id') && args.project_id !== row.project_id;
  if (has(args, 'project_id') && !state.projects.has(args.project_id)) return;
  const projectId = has(args, 'project_id') ? args.project_id : row.project_id;
  const parentId = (has(args, 'parent_id') ? args.parent_id : projectChanges ? null : row.parent_id) ?? null;
  let sectionId = (has(args, 'section_id') ? args.section_id : projectChanges ? null : row.section_id) ?? null;
  if (parentId !== null) {
    const parent = state.tasks.get(parentId);
    if (!parent || parent.project_id !== projectId) return;
    for (let p = parent, i = 0; p && i < 1000; i++) {
      if (p.id === row.id) return; // een taak kan niet onder zichzelf of een eigen subtaak staan
      p = p.parent_id ? state.tasks.get(p.parent_id) : undefined;
    }
    if (has(args, 'section_id') && args.section_id !== (parent.section_id ?? null)) return;
    sectionId = parent.section_id ?? null;
  } else if (sectionId !== null) {
    const section = state.sections.get(sectionId);
    if (!section || section.project_id !== projectId) return;
  }
  if (has(args, 'order_key') && !isValidKey(args.order_key)) return;
  const target = { project_id: projectId, section_id: sectionId, parent_id: parentId };
  const orderKey = has(args, 'order_key') ? args.order_key : keyAfter(maxKey(state.tasks, scopeOf('task', target)));
  const kids = descendantIds(state, [row.id]);
  patch(state, 'tasks', row.id, { ...target, order_key: orderKey }, now);
  for (const kid of kids) patch(state, 'tasks', kid, { project_id: projectId, section_id: sectionId }, now);
  if (projectChanges) {
    // een toegewezen persoon die in het nieuwe project niet kan bewerken (geen lid, of lezer), blijft niet toegewezen
    const members = new Set([...state.members.values()].filter((m) => m.project_id === projectId && canEditRole(m.role)).map((m) => m.user_id));
    for (const id of [row.id, ...kids]) {
      const moved = state.tasks.get(id);
      if (moved.assignee_id && !members.has(moved.assignee_id)) patch(state, 'tasks', id, { assignee_id: null }, now);
    }
  }
}

function taskComplete(state, args, now) {
  const row = state.tasks.get(args.id);
  if (!row || row.checked) return;
  // zoals de server: een terugkerende taak die al is doorgeschoven sinds de afzender hem zag, schuift niet nog eens door
  if (row.due?.recurrence && args.if_due !== undefined && args.if_due !== row.due.date) return;
  const count = (row.completed_count ?? 0) + 1;
  const next = row.due?.recurrence ? nextDue(row.due.date, row.due.recurrence, args.completed_on) : null;
  if (next) {
    // terugkerend: door naar de volgende datum, de taak blijft open
    patch(state, 'tasks', row.id, { due: { ...row.due, date: next }, completed_count: count }, now);
    return;
  }
  // niet terugkerend, of geen volgende keer meer (na 9999-12-31): gewoon afvinken, zoals de server
  patch(state, 'tasks', row.id, { checked: true, completed_at: now, completed_count: count }, now);
  for (const kid of descendantIds(state, [row.id])) {
    if (!state.tasks.get(kid).checked) patch(state, 'tasks', kid, { checked: true, completed_at: now }, now);
  }
}

function taskUncomplete(state, args, now) {
  const row = state.tasks.get(args.id);
  if (!row || !row.checked) return;
  patch(state, 'tasks', row.id, { checked: false, completed_at: null }, now);
}

const GENERIC = /^([a-z]+)_(add|update|delete)$/;
/** Zoveel bijlagen kan een taak hebben (gelijk aan LIMITS.attachmentsPerTask op de server). */
export const MAX_ATTACHMENTS_PER_TASK = 20;
const CAN_WRITE_FOREIGN = new Set(['label', 'filter']); // alleen de eigenaar wijzigt of verwijdert deze

/**
 * Past één commando toe op `state`. Onbekende of onuitvoerbare commando's doen niets:
 * de server meldt de fout bij de eerstvolgende sync.
 * @param {ReturnType<typeof emptyState>} state
 * @param {{ type: string, args?: Record<string, unknown> }} cmd
 * @param {string} now ISO-tijdstip waarop het commando is gemaakt
 * @param {string | null} [userId] de ingelogde gebruiker (voor eigenaar, maker en auteur van nieuwe rijen)
 */
export function applyCommand(state, cmd, now, userId = null) {
  const args = cmd.args ?? {};
  switch (cmd.type) {
    case 'task_move': return taskMove(state, args, now, userId);
    case 'task_complete': case 'task_uncomplete': {
      // een taak in een project dat je alleen leest, vink je niet af (zoals de server)
      const task = state.tasks.get(args.id);
      if (task && !mayEdit(state, userId, task.project_id)) return undefined;
      return cmd.type === 'task_complete' ? taskComplete(state, args, now) : taskUncomplete(state, args, now);
    }
    case 'notification_read_all': return readAllNotifications(state, args, now, userId);
    case 'member_update': return updateMemberRole(state, args, now, userId);
    default: {
      const m = GENERIC.exec(cmd.type);
      const e = m && has(ENTITIES, m[1]) ? ENTITIES[m[1]] : null;
      // welke algemene commando's een entiteit heeft, staat in de definitie (leden: geen; instellingen: alleen wijzigen)
      if (!e || e.commands === false || (Array.isArray(e.commands) && !e.commands.includes(m[2]))) return undefined;
      if (m[2] === 'add') {
        // in een project dat je alleen leest voeg je niets toe (een opmerking en een eigen herinnering wel), zoals de server
        const edited = e.name === 'project' ? args.parent_id ?? null : editedProject(state, e.name, args);
        if (edited !== null && !mayEdit(state, userId, edited)) return undefined;
        if (e.name === 'task' && !mayAssign(state, userId, args.project_id, args.assignee_id)) return undefined;
        return add(state, e, args, now, userId);
      }
      const existing = state[e.resource].get(args.id);
      if (existing) {
        const edited = editedProject(state, e.name, existing);
        if (edited !== null && !mayEdit(state, userId, edited)) return undefined;
        if (e.name === 'project' && m[2] === 'update' && has(args, 'parent_id') && args.parent_id && args.parent_id !== (existing.parent_id ?? null) && !mayEdit(state, userId, args.parent_id)) return undefined;
        if (e.name === 'task' && m[2] === 'update' && has(args, 'assignee_id') && !mayAssign(state, userId, existing.project_id, args.assignee_id)) return undefined;
      }
      // een label of filter van iemand anders lees je alleen
      if (CAN_WRITE_FOREIGN.has(e.name) && userId) {
        const row = state[e.resource].get(args.id);
        if (row && row.owner_id && row.owner_id !== userId) return undefined;
      }
      // een opmerking wijzig of verwijder je alleen als je de schrijver bent
      if (e.name === 'comment' && userId) {
        const row = state.comments.get(args.id);
        if (row && row.author_id && row.author_id !== userId) return undefined;
      }
      // een bijlage verwijdert alleen de maker, of de eigenaar van het project
      if (e.name === 'attachment' && userId) {
        const row = state.attachments.get(args.id);
        const task = row ? state.tasks.get(row.task_id) : null;
        if (row && row.creator_id && row.creator_id !== userId && !(task && isOwner(state, userId, task.project_id))) return undefined;
      }
      if (m[2] === 'update') return e.name === 'project' && !mayUpdateProject(state, args, userId) ? undefined : update(state, e, args, now);
      return remove(state, e, args, now, userId);
    }
  }
}
