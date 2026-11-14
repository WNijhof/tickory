// De demo-versie van client/core/backend.js: alles wat de app normaal aan de server vraagt, wordt hier in de browser
// zelf afgehandeld. Er is geen server, geen aanmelding en er gaat geen enkel verzoek het netwerk op.
//
// LET OP: scripts/build-site.ts zet dit bestand als `demo/core/backend.js` in de plaats van het echte backend.js.
// De imports hieronder kloppen dus vanaf die plek (naast reducer.js), niet vanaf website/demo/.
//
// De "server in de browser" volgt het sync-protocol uit SPEC.md: commando's uitvoeren (elk hooguit één keer per uuid),
// elke gewijzigde rij een oplopend versienummer, `sync_status` per commando, een delta vanaf het `sync_token`, en `me`
// en `users`. Commando's worden uitgevoerd met dezelfde `applyCommand` als waarmee de app zelf optimistisch rekent; wat
// alleen de echte server doet (invoer controleren, rechten, delen en verlaten), staat hier, met dezelfde foutcodes en
// meldingen als server/sync.ts. De toestand is die van één gebruiker (Anna): wat zij niet mag zien, bestaat hier niet.

import { ApiError, deviceName } from './auth.js';
import { getLanguage, t } from './i18n.js';
import { newId } from './actions.js';
import { HttpError } from './syncClient.js';
import { applyCommand, cloneState, descendantIds } from './reducer.js';
import { ENTITIES, ID_RE, isInboxId, RESOURCE_NAMES, validateValue } from '../../shared/schema.js';
import { isValidKey } from '../../shared/orderKey.js';
import { isValidDate } from '../../shared/recurrence.js';
import { deepNormalize, nameKey } from '../../shared/text.js';
import { addMember, createSeed } from './demoSeed.js';
import { AttachmentError } from './attachmentsApi.js';
import { DEFAULT_MIME, effectiveMime, isInlineMime } from '../../shared/attachments.js';
import { MAX_ATTACHMENTS_PER_TASK } from './reducer.js';
import { canEditRole, DEFAULT_SHARE_ROLE, shareRoleProblem } from '../../shared/roles.js';
import { changedTaskFields, parseActivityQuery, shortTitle } from '../../shared/activity.js';

const MAX_COMMANDS = 100;
/** Hoe lang na het verwijderen een taak of sectie nog kan worden teruggezet (gelijk aan RESTORE.windowMs op de server, server/limits.ts). */
const RESTORE_WINDOW_MS = 5 * 60_000;
const UUID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const USERNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{1,39}$/u;
const MIN_PASSWORD = 10;
// De melding volgt de taal van de app. (Een foutmelding van de echte server wordt door de app zelf vertaald; deze komt uit de demo.)
const notInDemo = () => (getLanguage() === 'en'
  ? "That isn't possible in the demo: there are no real accounts or passwords here."
  : 'Dat kan niet in de demo: hier bestaan geen echte accounts en wachtwoorden.');

class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => { throw new CommandError(code, message); };
const has = (o, k) => Object.hasOwn(o, k);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Een fout zoals de app die van de echte server krijgt (de melding staat dan direct in beeld). */
const apiError = (status, code, message) => new ApiError(capitalize(message), { status, code });

// ---------- wie hoort bij welk project ----------

const roleOf = (state, userId, projectId) => {
  for (const m of state.members.values()) if (m.project_id === projectId && m.user_id === userId) return m.role;
  return null;
};
const isMember = (state, userId, projectId) => roleOf(state, userId, projectId) !== null;
/** Het project waarvan de inhoud verandert bij een wijziging van deze rij; null voor wat ook een lezer mag (zoals server/sync.ts). */
const editedProject = (state, name, row) => (name === 'project' ? row.id : name === 'section' || name === 'task' ? row.project_id : name === 'attachment' ? state.tasks.get(row.task_id)?.project_id ?? null : null);

/** Het project en al zijn subprojecten (alle niveaus), de wortel eerst. */
function projectTree(state, rootId) {
  const projects = [rootId];
  for (let i = 0; i < projects.length; i++) {
    for (const p of state.projects.values()) if (p.parent_id === projects[i] && !projects.includes(p.id)) projects.push(p.id);
  }
  return projects;
}

function requireLive(state, name, id, what) {
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('INVALID_ARG', `${what}: ongeldig id`);
  const row = state[ENTITIES[name].resource].get(id);
  if (!row) fail('NOT_FOUND', `${what}: ${name} bestaat niet`);
  return row;
}
const exactArgs = (args, allowed) => {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) fail('UNKNOWN_ARG', `onbekend argument "${k}"`);
};
const replaceRow = (state, resource, id, changes, at) => state[resource].set(id, { ...state[resource].get(id), ...changes, updated_at: at });

function resolveResources(requested) {
  const list = requested === undefined ? ['all'] : requested;
  if (!Array.isArray(list) || list.length === 0 || list.length > 40 || !list.every((x) => typeof x === 'string')) {
    throw new HttpError(400, 'resource_types moet een niet-lege lijst met tekst zijn');
  }
  const include = new Set(list.includes('all') ? RESOURCE_NAMES : []);
  for (const n of list) {
    if (n === 'all') continue;
    const name = n.startsWith('-') ? n.slice(1) : n;
    if (!RESOURCE_NAMES.includes(name)) throw new HttpError(400, `onbekend resourcetype "${n}"`);
    if (n.startsWith('-')) include.delete(name);
    else include.add(name);
  }
  return { include, partial: include.size !== RESOURCE_NAMES.length };
}

const GENERIC = /^([a-z]+)_(add|update|delete)$/;

export class DemoServer {
  /**
   * @param {{ now?: () => Date, strict?: boolean }} [options] strict: zie createSeed (alleen voor de controle van de website)
   */
  constructor({ now = () => new Date(), strict = false } = {}) {
    this.now = now;
    const seed = createSeed(now(), { strict });
    /** De toestand zoals de ingelogde gebruiker die mag zien: per resource een Map met alleen niet-verwijderde rijen. */
    this.state = seed.state;
    this.me = seed.me;
    /** Alle accounts op deze denkbeeldige server (ook wie niets met je deelt). */
    this.accounts = seed.users;
    /** Het versienummer van de laatste wijziging; elke rij onthoudt het nummer van haar laatste wijziging. */
    this.rev = 1;
    this.revs = new Map();
    this.gone = new Map(); // verwijderde rijen: "resource/id" -> versienummer van het verwijderen
    /** Wat er verwijderd is, met inhoud, zodat `task_restore` en `section_restore` het kunnen terugzetten: "resource/id" -> { row, rev, at }. */
    this.trash = new Map();
    /** Het activiteitenlogboek (zoals server/activity.ts): de regels van alle projecten, de oudste eerst. */
    this.activity = seed.activity ?? [];
    this.activitySeq = this.activity.length;
    for (const r of RESOURCE_NAMES) for (const id of this.state[r].keys()) this.revs.set(`${r}/${id}`, 1);
    /** Uitkomst per uuid: een herhaald commando wordt niet opnieuw uitgevoerd. */
    this.seen = new Map();
    /**
     * De bestanden van bijlagen, in het geheugen van deze pagina (ze verdwijnen bij herladen, net als de rest van de demo). De
     * grenzen zijn kleiner dan op een echte server (daar standaard 25 MB per bestand en 1 GB per gebruiker), de regels dezelfde.
     */
    this.files = new Map();
    this.maxUploadBytes = 5_000_000;
    this.quotaBytes = 20_000_000;
    const nowMs = now().getTime();
    const ago = (minutes) => new Date(nowMs - minutes * 60_000).toISOString();
    this.sessions = [
      { id: 'demo-session-1', name: deviceName(), created_at: ago(0), last_used_at: ago(0), current: true, device: { kind: 'browser', browser: null, os: null } },
      { id: 'demo-session-2', name: t('device.browserOn', { browser: 'Chrome', os: 'Android' }), created_at: ago(60 * 24 * 41), last_used_at: ago(95), current: false, device: { kind: 'browser', browser: 'Chrome', os: 'Android' } },
      { id: 'demo-session-3', name: t('device.browserOn', { browser: 'Firefox', os: 'Windows' }), created_at: ago(60 * 24 * 120), last_used_at: ago(60 * 24 * 6), current: false, device: { kind: 'browser', browser: 'Firefox', os: 'Windows' } },
    ];
  }

  // ---------- het sync-verzoek ----------

  /** Wat `POST /api/v1/sync` op de echte server doet. */
  sync(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'verzoek moet een JSON-object zijn');
    const token = body.sync_token ?? '*';
    if (typeof token !== 'string' || !/^(\*|\d{1,15})$/.test(token)) throw new HttpError(400, 'sync_token moet "*" of een getal zijn');
    const commands = body.commands ?? [];
    if (!Array.isArray(commands) || commands.length > MAX_COMMANDS) throw new HttpError(400, `commands moet een lijst van maximaal ${MAX_COMMANDS} zijn`);
    const { include, partial } = resolveResources(body.resource_types);
    for (const c of commands) {
      if (!c || typeof c !== 'object' || typeof c.type !== 'string' || typeof c.uuid !== 'string' || !UUID_RE.test(c.uuid)) {
        throw new HttpError(400, 'elk commando heeft een type en een uuid (8-64 tekens uit [A-Za-z0-9_-]) nodig');
      }
      if (c.args !== undefined && (typeof c.args !== 'object' || c.args === null || Array.isArray(c.args))) throw new HttpError(400, 'args moet een object zijn');
    }

    const status = {};
    const at = this.now().toISOString();
    for (const cmd of commands) {
      if (!this.seen.has(cmd.uuid)) this.seen.set(cmd.uuid, this.execute(cmd, at));
      status[cmd.uuid] = this.seen.get(cmd.uuid);
    }

    let since = token === '*' ? 0 : Number(token);
    let full = token === '*';
    if (since > this.rev) { since = 0; full = true; } // het token loopt voor op de server: de client moet opnieuw beginnen
    const response = { sync_token: String(this.rev), full_sync: full, partial, sync_status: status, me: this.me, users: this.peers() };
    for (const r of RESOURCE_NAMES) {
      if (!include.has(r)) continue;
      const rows = [...this.state[r].values()].filter((row) => full || this.revs.get(`${r}/${row.id}`) > since);
      if (!full) for (const [key, rev] of this.gone) if (rev > since && key.startsWith(`${r}/`)) rows.push({ id: key.slice(r.length + 1), is_deleted: true });
      response[r] = rows;
    }
    return structuredClone(response); // een eigen kopie, zoals een antwoord over het netwerk dat ook is
  }

  /** De gebruiker zelf en iedereen met wie een project wordt gedeeld (alleen om namen te tonen). */
  peers() {
    const ids = new Set([this.me.id, ...[...this.state.members.values()].map((m) => m.user_id)]);
    return this.accounts
      .filter((u) => ids.has(u.id))
      .sort((a, b) => (nameKey(a.username) < nameKey(b.username) ? -1 : 1))
      .map((u) => ({ id: u.id, username: u.username, name: u.name }));
  }

  /** Voert één commando uit: alles of niets. Geeft 'ok' of de fout zoals de server die zou melden. */
  execute(cmd, at) {
    const next = cloneState(this.state);
    try {
      this.run(next, cmd.type, deepNormalize(cmd.args ?? {}), at);
    } catch (err) {
      if (err instanceof CommandError) return { error_code: err.code, error: err.message };
      console.error('onverwachte fout in commando', cmd.type, err);
      return { error_code: 'INTERNAL', error: 'interne fout' };
    }
    this.rev += 1;
    // wat dit commando verwijderde, bewaren we even (inhoud, versienummer, tijdstip) om het terug te kunnen zetten
    for (const r of RESOURCE_NAMES) {
      for (const [id, row] of this.state[r]) if (!next[r].has(id)) this.trash.set(`${r}/${id}`, { row, rev: this.rev, at });
      for (const id of next[r].keys()) this.trash.delete(`${r}/${id}`);
    }
    const nowMs = Date.parse(at);
    for (const [key, entry] of this.trash) {
      if (nowMs - Date.parse(entry.at) <= RESTORE_WINDOW_MS) continue;
      this.trash.delete(key);
      if (key.startsWith('attachments/')) this.files.delete(key.slice('attachments/'.length));
    }
    for (const r of RESOURCE_NAMES) {
      for (const [id, row] of next[r]) {
        if (this.state[r].get(id) === row) continue; // rij-objecten worden altijd vervangen, nooit aangepast
        this.revs.set(`${r}/${id}`, this.rev);
        this.gone.delete(`${r}/${id}`);
      }
      for (const id of this.state[r].keys()) {
        if (next[r].has(id)) continue;
        this.revs.delete(`${r}/${id}`);
        this.gone.set(`${r}/${id}`, this.rev);
      }
    }
    this.logActivity(cmd.type, deepNormalize(cmd.args ?? {}), this.state, next, at);
    this.state = next;
    // bestanden van bijlagen die er niet meer zijn (verwijderd, of met hun taak of project verdwenen)
    for (const [id, f] of this.files) if (f.linked && !next.attachments.has(id) && !this.trash.has(`attachments/${id}`)) this.files.delete(id);
    return 'ok';
  }

  run(state, type, args, at) {
    const me = this.me.id;
    const apply = (a = args) => applyCommand(state, { type, args: a }, at, me);
    switch (type) {
      case 'task_move': this.checkTaskMove(state, args); apply(); return this.dropStrangers(state, args.id, at);
      case 'task_complete':
        // zoals de server: `if_due` is de datum die de afzender zag (de reducer doet er hetzelfde mee)
        exactArgs(args, ['id', 'if_due', 'completed_on']);
        if (args.if_due !== undefined && !isValidDate(args.if_due)) fail('INVALID_ARG', 'if_due moet een geldige datum zijn');
        if (args.completed_on !== undefined && !(typeof args.completed_on === 'string' && args.completed_on.length === 10 && isValidDate(args.completed_on))) fail('INVALID_ARG', 'completed_on moet een datum zijn (JJJJ-MM-DD)');
        this.requireEditor(state, requireLive(state, 'task', args.id, 'task.id').project_id);
        return apply();
      case 'task_uncomplete': exactArgs(args, ['id']); this.requireEditor(state, requireLive(state, 'task', args.id, 'task.id').project_id); return apply();
      case 'member_update': return this.memberUpdate(state, args, at);
      case 'task_restore': case 'section_restore': return this.restore(state, type, args, at);
      case 'project_share': return this.projectShare(state, args, at);
      case 'project_unshare': return this.projectUnshare(state, args, at);
      case 'project_leave': return this.projectLeave(state, args, at);
      case 'notification_read_all':
        // zoals de server: alle eigen meldingen gelezen, met `up_to` alleen wat de afzender al zag
        exactArgs(args, ['up_to']);
        if (args.up_to !== undefined && (typeof args.up_to !== 'string' || args.up_to.length > 40 || !Number.isFinite(Date.parse(args.up_to)))) fail('INVALID_ARG', 'up_to moet een tijdstip zijn');
        return apply();
      default: break;
    }
    const m = GENERIC.exec(type);
    const e = m && has(ENTITIES, m[1]) ? ENTITIES[m[1]] : null;
    // welke algemene commando's een entiteit heeft, staat in shared/schema.js (leden: geen; instellingen: alleen wijzigen)
    if (!e || e.commands === false || (Array.isArray(e.commands) && !e.commands.includes(m[2]))) fail('UNKNOWN_COMMAND', `onbekend commando "${type}"`);
    if (m[2] === 'add') {
      const id = args.id === undefined ? newId() : args.id;
      if (typeof id !== 'string' || !ID_RE.test(id)) fail('INVALID_ARG', 'id moet 8-40 tekens uit [A-Za-z0-9_-] zijn');
      if (e.name === 'project' && isInboxId(id)) fail('INVALID_ARG', 'ids die met "inbox-" beginnen zijn gereserveerd');
      if (state[e.resource].has(id) || this.gone.has(`${e.resource}/${id}`)) fail('ID_EXISTS', `${e.name} met dit id bestaat al`);
      const v = this.collect(state, e, args, 'add');
      const edited = e.name === 'project' ? v.parent_id ?? null : editedProject(state, e.name, v);
      if (edited !== null) this.requireEditor(state, edited);
      this.verify(state, e, id, v, 'add', v);
      return apply({ ...args, id });
    }
    if (m[2] === 'update') {
      const row = requireLive(state, e.name, args.id, `${e.name}.id`);
      this.requireMayWrite(e, row, state);
      const edited = editedProject(state, e.name, row);
      if (edited !== null) this.requireEditor(state, edited);
      const changes = this.collect(state, e, args, 'update');
      if (e.name === 'project' && has(changes, 'parent_id') && changes.parent_id !== row.parent_id) {
        this.requireOwner(state, row.id, 'alleen de eigenaar kan een project verplaatsen');
        if (changes.parent_id !== null) this.requireEditor(state, changes.parent_id);
      }
      this.verify(state, e, row.id, { ...row, ...changes }, 'update', changes);
      return apply();
    }
    exactArgs(args, ['id']);
    const row = requireLive(state, e.name, args.id, `${e.name}.id`);
    this.requireMayWrite(e, row, state);
    const edited = editedProject(state, e.name, row);
    if (edited !== null) this.requireEditor(state, edited);
    if (e.name === 'project') {
      if (isInboxId(row.id)) fail('CONFLICT', 'de Inbox kan niet worden verwijderd');
      this.requireOwner(state, row.id, 'alleen de eigenaar kan een project verwijderen; gebruik "verlaten" om er zelf uit te gaan');
    }
    return apply();
  }

  // ---------- het activiteitenlogboek (zoals server/activity.ts; alleen in het geheugen) ----------

  record(projectId, kind, at, ref = {}) {
    this.activity.push({
      id: String(++this.activitySeq), project_id: projectId, at, actor_id: this.me.id, kind, task_id: ref.task_id ?? null, section_id: ref.section_id ?? null,
      comment_id: ref.comment_id ?? null, attachment_id: ref.attachment_id ?? null, user_id: ref.user_id ?? null, title: shortTitle(ref.title) ?? null, extra: ref.extra ?? null,
    });
  }

  /** Na een geslaagd commando: wat het deed, vergeleken tussen de toestand ervoor (`a`) en erna (`b`), met dezelfde regels als de server. */
  logActivity(type, args, a, b, at) {
    const taskProject = (state, taskId) => state.tasks.get(taskId)?.project_id ?? null;
    const commentProject = (state, c) => (c.task_id ? taskProject(state, c.task_id) : c.project_id);
    switch (type) {
      case 'project_add': if (b.projects.has(args.id)) this.record(args.id, 'project_created', at, { title: b.projects.get(args.id).name }); return;
      case 'project_update': {
        const before = a.projects.get(args.id);
        const after = b.projects.get(args.id);
        if (!before || !after) return;
        if (has(args, 'name') && after.name !== before.name) this.record(after.id, 'project_renamed', at, { title: after.name, extra: { from: before.name } });
        if (has(args, 'is_archived') && Boolean(after.is_archived) !== Boolean(before.is_archived)) this.record(after.id, after.is_archived ? 'project_archived' : 'project_unarchived', at, { title: after.name });
        return;
      }
      case 'project_delete': this.activity = this.activity.filter((x) => b.projects.has(x.project_id)); return; // een verwijderd project neemt zijn logboek mee
      case 'section_add': { const s = b.sections.get(args.id); if (s) this.record(s.project_id, 'section_added', at, { section_id: s.id, title: s.name }); return; }
      case 'section_update': {
        const before = a.sections.get(args.id);
        const after = b.sections.get(args.id);
        if (before && after && has(args, 'name') && after.name !== before.name) this.record(after.project_id, 'section_renamed', at, { section_id: after.id, title: after.name, extra: { from: before.name } });
        return;
      }
      case 'section_delete': { const s = a.sections.get(args.id); if (s) this.record(s.project_id, 'section_deleted', at, { section_id: s.id, title: s.name }); return; }
      case 'section_restore': { const s = b.sections.get(args.id); if (s && !a.sections.has(args.id)) this.record(s.project_id, 'section_restored', at, { section_id: s.id, title: s.name }); return; }
      case 'task_add': { const x = b.tasks.get(args.id); if (x) this.record(x.project_id, 'task_added', at, { task_id: x.id, title: x.content }); return; }
      case 'task_update': {
        const before = a.tasks.get(args.id);
        const after = b.tasks.get(args.id);
        if (!before || !after) return;
        const { id: _id, ...changes } = args;
        const fields = changedTaskFields(before, changes);
        if (fields.length > 0) this.record(after.project_id, 'task_updated', at, { task_id: after.id, title: after.content, extra: { fields, ...(fields.includes('assignee_id') ? { assignee_id: changes.assignee_id ?? null } : {}) } });
        return;
      }
      case 'task_complete': case 'task_uncomplete': {
        const before = a.tasks.get(args.id);
        const after = b.tasks.get(args.id);
        if (!before || !after || before === after) return; // niets gedaan (al afgevinkt, of al doorgeschoven)
        if (type === 'task_uncomplete') this.record(after.project_id, 'task_uncompleted', at, { task_id: after.id, title: before.content });
        else this.record(after.project_id, 'task_completed', at, { task_id: after.id, title: before.content, extra: after.checked ? null : { recurring: true } });
        return;
      }
      case 'task_move': {
        const before = a.tasks.get(args.id);
        const after = b.tasks.get(args.id);
        if (!before || !after) return;
        if (before.project_id !== after.project_id) {
          const ref = { task_id: after.id, title: before.content, extra: { from_project: before.project_id, to_project: after.project_id } };
          this.record(before.project_id, 'task_moved', at, ref);
          this.record(after.project_id, 'task_moved', at, ref);
        } else if ((before.section_id ?? null) !== (after.section_id ?? null)) {
          this.record(after.project_id, 'task_moved', at, { task_id: after.id, title: before.content, extra: { from_section: before.section_id ?? null, to_section: after.section_id ?? null } });
        }
        return;
      }
      case 'task_delete': { const x = a.tasks.get(args.id); if (x) this.record(x.project_id, 'task_deleted', at, { task_id: x.id, title: x.content }); return; }
      case 'task_restore': { const x = b.tasks.get(args.id); if (x && !a.tasks.has(args.id)) this.record(x.project_id, 'task_restored', at, { task_id: x.id, title: x.content }); return; }
      case 'comment_add': {
        const c = b.comments.get(args.id);
        const p = c ? commentProject(b, c) : null;
        if (p) this.record(p, 'comment_added', at, { comment_id: c.id, task_id: c.task_id ?? null, title: c.task_id ? b.tasks.get(c.task_id)?.content : null });
        return;
      }
      case 'comment_delete': {
        const c = a.comments.get(args.id);
        const p = c ? commentProject(a, c) : null;
        if (p) this.record(p, 'comment_deleted', at, { comment_id: c.id, task_id: c.task_id ?? null, title: c.task_id ? a.tasks.get(c.task_id)?.content : null });
        return;
      }
      case 'attachment_add': { const x = b.attachments.get(args.id); if (x) this.record(taskProject(b, x.task_id), 'attachment_added', at, { attachment_id: x.id, task_id: x.task_id, title: x.name }); return; }
      case 'attachment_delete': {
        const x = a.attachments.get(args.id);
        if (!x) return;
        for (const e of this.activity) if (e.attachment_id === x.id) e.title = null; // de naam van een verwijderde bijlage verdwijnt
        this.record(taskProject(a, x.task_id), 'attachment_deleted', at, { attachment_id: x.id, task_id: x.task_id });
        return;
      }
      case 'project_share': case 'member_update': case 'project_unshare': case 'project_leave': {
        const key = (m) => `${m.project_id}/${m.user_id}`;
        const before = new Map([...a.members.values()].map((m) => [key(m), m]));
        const after = new Map([...b.members.values()].map((m) => [key(m), m]));
        for (const [k, m] of after) {
          const old = before.get(k);
          if (!old) this.record(m.project_id, 'member_added', at, { user_id: m.user_id, extra: { role: m.role } });
          else if (old.role !== m.role) this.record(m.project_id, 'member_role', at, { user_id: m.user_id, extra: { role: m.role, from: old.role } });
        }
        for (const [k, m] of before) {
          if (after.has(k) || (type === 'project_leave' && m.user_id !== this.me.id)) continue; // bij verlaten verdwijnen voor jou alle leden; alleen jij vertrok
          this.record(m.project_id, type === 'project_leave' ? 'member_left' : 'member_removed', at, { user_id: m.user_id });
        }
        return;
      }
      default:
    }
  }

  /** Wat `GET /api/v1/projects/<id>/activity` doet: een pagina, de nieuwste eerst, alleen voor een project dat je (nog) ziet. */
  activityPage(projectId, { before = null, limit = null, kinds = null } = {}) {
    if (!this.state.projects.has(projectId)) throw apiError(404, 'NOT_FOUND', 'dit project bestaat niet');
    const q = parseActivityQuery({ before: before ?? null, limit: limit === null ? null : String(limit), kinds: kinds?.length ? kinds.join(',') : null });
    if (q.error) throw apiError(400, 'INVALID_ARG', q.error);
    const list = this.activity.filter((e) => e.project_id === projectId && (q.before === null || Number(e.id) < q.before) && (!q.kinds || q.kinds.includes(e.kind))).reverse();
    const page = list.slice(0, q.limit).map(({ project_id: _p, ...e }) => structuredClone(e));
    return { entries: page, next: list.length > q.limit ? page[page.length - 1].id : null };
  }

  // ---------- terugzetten (zoals server/restore.ts) ----------

  /** Zet een zojuist verwijderde taak (met alles eraan) of sectie terug, met dezelfde controles en meldingen als de server. */
  restore(state, type, args, at) {
    exactArgs(args, ['id']);
    if (typeof args.id !== 'string' || !ID_RE.test(args.id)) fail('INVALID_ARG', 'ongeldig id');
    const task = type === 'task_restore';
    const resource = task ? 'tasks' : 'sections';
    const what = task ? 'de taak' : 'de sectie';
    if (state[resource].has(args.id)) return undefined; // al terug (of nooit weg)
    const entry = this.trash.get(`${resource}/${args.id}`);
    if (!entry || !state.projects.has(entry.row.project_id)) fail('NOT_FOUND', task ? 'task.id: taak bestaat niet' : 'section.id: sectie bestaat niet');
    this.requireEditor(state, entry.row.project_id);
    if (Date.parse(at) - Date.parse(entry.at) > RESTORE_WINDOW_MS) {
      fail('CONFLICT', `${task ? 'task.id' : 'section.id'}: ${what} is te lang geleden verwijderd om terug te zetten (binnen ${Math.round(RESTORE_WINDOW_MS / 60_000)} minuten kan het nog)`);
    }
    const same = (resourceName, pred) => [...this.trash].filter(([key, e]) => key.startsWith(`${resourceName}/`) && e.rev === entry.rev && pred(e.row)).map(([, e]) => e.row);
    const rows = { tasks: [], comments: [], attachments: [], reminders: [] };
    if (task) {
      const row = entry.row;
      if (row.parent_id) {
        const parent = state.tasks.get(row.parent_id);
        if (!parent) fail('CONFLICT', 'de bovenliggende taak is verwijderd; zet die eerst terug');
        if (parent.project_id !== row.project_id) fail('CONFLICT', 'de bovenliggende taak staat intussen in een ander project');
      } else if (row.section_id && !state.sections.has(row.section_id)) fail('CONFLICT', 'de sectie van deze taak is verwijderd; zet die eerst terug');
      const ids = new Set([row.id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const t of same('tasks', (x) => x.parent_id && ids.has(x.parent_id))) if (!ids.has(t.id)) { ids.add(t.id); grew = true; }
      }
      rows.tasks = same('tasks', (x) => ids.has(x.id));
    } else {
      rows.sections = [entry.row];
      rows.tasks = same('tasks', (x) => x.section_id === entry.row.id);
    }
    const taskIds = new Set(rows.tasks.map((x) => x.id));
    rows.comments = same('comments', (x) => taskIds.has(x.task_id));
    rows.attachments = same('attachments', (x) => taskIds.has(x.task_id) && x.name !== '');
    rows.reminders = same('reminders', (x) => taskIds.has(x.task_id));
    if (task && rows.tasks.length + [...state.tasks.values()].filter((x) => x.project_id === entry.row.project_id).length > 10_000) fail('LIMIT_REACHED', 'taken per project: de grens van 10000 is bereikt');
    return applyCommand(state, { type, args, local: { rows } }, at, this.me.id);
  }

  // ---------- controles, gelijk aan de server ----------

  requireOwner(state, projectId, what) {
    if (roleOf(state, this.me.id, projectId) !== 'owner') fail('FORBIDDEN', what);
  }

  /** Een lezer (shared/roles.js) wijzigt niets aan taken, secties of het project. */
  requireEditor(state, projectId) {
    if (!canEditRole(roleOf(state, this.me.id, projectId))) fail('FORBIDDEN', 'je kunt dit project alleen lezen');
  }

  /** Iets zien is niet altijd genoeg om het te wijzigen: een label van een ander lees je alleen. */
  requireMayWrite(e, row, state) {
    if ((e.name === 'label' || e.name === 'filter') && row.owner_id !== this.me.id) {
      fail('FORBIDDEN', e.name === 'label' ? 'dit label is van iemand anders; je kunt het alleen lezen' : 'dit filter is van iemand anders');
    }
    if (e.name === 'comment' && row.author_id !== null && row.author_id !== this.me.id) fail('FORBIDDEN', 'je kunt alleen je eigen opmerkingen wijzigen of verwijderen');
    if (e.name === 'attachment' && row.creator_id !== this.me.id) {
      const task = state.tasks.get(row.task_id);
      if (!task || roleOf(state, this.me.id, task.project_id) !== 'owner') fail('FORBIDDEN', 'alleen de maker of de eigenaar van het project kan een bijlage verwijderen');
    }
  }

  /** Controleert de meegestuurde argumenten tegen het datamodel (shared/schema.js) en geeft de waarden terug. */
  collect(state, e, args, mode) {
    exactArgs(args, ['id', ...e.cols.map((c) => c.name)]);
    const out = {};
    for (const c of e.cols) {
      const given = has(args, c.name);
      if (given && c.serverManaged) fail('READONLY', `"${c.name}" wordt door de server beheerd`);
      if (given && mode === 'update' && c.immutable) fail('IMMUTABLE', `"${c.name}" kan hiermee niet worden gewijzigd`);
      if (given) {
        const err = validateValue(c, args[c.name]);
        if (err) fail('INVALID_ARG', `${e.name}.${c.name}: ${err}`);
        if (c.ref && args[c.name] !== null) requireLive(state, c.ref, args[c.name], `${e.name}.${c.name}`);
        out[c.name] = args[c.name];
      } else if (mode === 'add') {
        if (c.required) fail('MISSING_ARG', `${e.name}.${c.name} is verplicht`);
        if (c.stamp) out[c.name] = this.me.id;
        else if (c.default !== undefined) out[c.name] = c.default;
      }
    }
    return out;
  }

  /** Afspraken tussen velden onderling. `v` is de rij zoals ze wordt; `given` zijn de velden uit dit commando. */
  verify(state, e, id, v, mode, given) {
    switch (e.name) {
      case 'project': {
        if (isInboxId(id) && ((v.parent_id ?? null) !== null || v.is_archived === true)) fail('CONFLICT', 'de Inbox kan niet worden verplaatst of gearchiveerd');
        if (v.parent_id && isInboxId(v.parent_id)) fail('CONFLICT', 'de Inbox kan geen subprojecten hebben');
        for (let p = v.parent_id ?? null, i = 0; p && i < 1000; i++) {
          if (p === id) fail('CYCLE', 'een project kan niet in zichzelf of een eigen subproject staan');
          p = state.projects.get(p)?.parent_id ?? null;
        }
        break;
      }
      case 'label': {
        const key = nameKey(v.name);
        for (const l of state.labels.values()) {
          if (l.id !== id && l.owner_id === this.me.id && nameKey(l.name) === key) fail('DUPLICATE', 'er bestaat al een label met deze naam');
        }
        break;
      }
      case 'task': {
        for (const l of v.labels ?? []) requireLive(state, 'label', l, 'task.labels');
        if (v.assignee_id && has(given, 'assignee_id')) {
          const role = roleOf(state, v.assignee_id, v.project_id);
          if (role === null) fail('INVALID_ARG', 'de toegewezen persoon is geen lid van dit project');
          if (!canEditRole(role)) fail('INVALID_ARG', 'de toegewezen persoon kan dit project alleen lezen');
        }
        if (mode === 'add') {
          if (v.parent_id) {
            const parent = requireLive(state, 'task', v.parent_id, 'task.parent_id');
            if (parent.project_id !== v.project_id) fail('CONFLICT', 'een subtaak hoort in hetzelfde project als de bovenliggende taak');
            if (v.section_id && v.section_id !== parent.section_id) fail('CONFLICT', 'een subtaak volgt de sectie van de bovenliggende taak');
          } else if (v.section_id) {
            if (requireLive(state, 'section', v.section_id, 'task.section_id').project_id !== v.project_id) fail('CONFLICT', 'de sectie hoort bij een ander project');
          }
        }
        break;
      }
      case 'comment':
        if (((v.task_id ?? null) === null) === ((v.project_id ?? null) === null)) fail('INVALID_ARG', 'geef precies één van task_id of project_id');
        break;
      case 'attachment': {
        // zoals de server: het bestand moet eerst zijn geüpload en moet kloppen met wat hier wordt opgegeven
        const f = this.files.get(id);
        if (!f || f.task_id !== v.task_id || f.linked) fail('NOT_FOUND', 'attachment.id: het bestand is niet geüpload (of hoort al bij een bijlage)');
        if (f.size !== v.size || f.sha256 !== v.sha256 || f.mime !== v.mime) fail('CONFLICT', 'grootte, type of controlegetal komt niet overeen met het geüploade bestand');
        let count = 0;
        for (const a of state.attachments.values()) if (a.task_id === v.task_id) count += 1;
        if (count >= MAX_ATTACHMENTS_PER_TASK) fail('LIMIT_REACHED', `bijlagen per taak: de grens van ${MAX_ATTACHMENTS_PER_TASK} is bereikt`);
        f.linked = true;
        break;
      }
      case 'reminder': {
        const none = (x) => x === null || x === undefined;
        if (v.type === 'location') {
          // bij aankomst of vertrek van een eigen plaats; in de demo gaat zo'n herinnering nooit af (er is geen toestel dat positie bepaalt)
          if (none(v.place_id)) fail('INVALID_ARG', 'een locatieherinnering heeft place_id nodig');
          if (none(v.trigger)) fail('INVALID_ARG', 'een locatieherinnering heeft trigger nodig (enter of leave)');
          if (v.due) fail('INVALID_ARG', 'een locatieherinnering heeft geen due');
          if (!none(v.minute_offset)) fail('INVALID_ARG', 'een locatieherinnering heeft geen minute_offset');
          break;
        }
        if (!none(v.place_id) || !none(v.trigger)) fail('INVALID_ARG', 'place_id en trigger horen alleen bij een locatieherinnering');
        if (v.type === 'relative') {
          if (none(v.minute_offset)) fail('INVALID_ARG', 'een relatieve herinnering heeft minute_offset nodig');
          if (v.due) fail('INVALID_ARG', 'een relatieve herinnering heeft geen due');
        } else {
          if (!v.due || !v.due.date.includes('T')) fail('INVALID_ARG', 'een absolute herinnering heeft een due met tijdstip nodig');
          if (!none(v.minute_offset)) fail('INVALID_ARG', 'een absolute herinnering heeft geen minute_offset');
        }
        break;
      }
      default: break;
    }
  }

  checkTaskMove(state, args) {
    exactArgs(args, ['id', 'project_id', 'section_id', 'parent_id', 'order_key']);
    const row = requireLive(state, 'task', args.id, 'task.id');
    if (!has(args, 'project_id') && !has(args, 'section_id') && !has(args, 'parent_id')) fail('MISSING_ARG', 'geef project_id, section_id of parent_id op');
    this.requireEditor(state, row.project_id);
    const projectChanges = has(args, 'project_id') && args.project_id !== row.project_id;
    if (has(args, 'project_id')) {
      requireLive(state, 'project', args.project_id, 'task.project_id');
      this.requireEditor(state, args.project_id);
    }
    const projectId = has(args, 'project_id') ? args.project_id : row.project_id;
    const parentId = (has(args, 'parent_id') ? args.parent_id : projectChanges ? null : row.parent_id) ?? null;
    const sectionId = (has(args, 'section_id') ? args.section_id : projectChanges ? null : row.section_id) ?? null;
    if (parentId !== null) {
      const parent = requireLive(state, 'task', parentId, 'task.parent_id');
      if (parent.project_id !== projectId) fail('CONFLICT', 'de bovenliggende taak staat in een ander project');
      for (let p = parent, i = 0; p && i < 1000; i++) {
        if (p.id === row.id) fail('CYCLE', 'een taak kan niet onder zichzelf of een eigen subtaak staan');
        p = p.parent_id ? state.tasks.get(p.parent_id) : undefined;
      }
      if (has(args, 'section_id') && args.section_id !== (parent.section_id ?? null)) fail('CONFLICT', 'een subtaak volgt de sectie van de bovenliggende taak');
    } else if (sectionId !== null) {
      if (requireLive(state, 'section', sectionId, 'task.section_id').project_id !== projectId) fail('CONFLICT', 'de sectie hoort bij een ander project');
    }
    if (has(args, 'order_key') && !isValidKey(args.order_key)) fail('INVALID_ARG', 'task.order_key: ongeldige volgordesleutel');
  }

  /** Na een verhuizing: wie geen lid is van het nieuwe project, blijft niet toegewezen (de app zelf rekent dit niet vooruit). */
  dropStrangers(state, taskId, at) {
    for (const id of [taskId, ...descendantIds(state, [taskId])]) {
      const t = state.tasks.get(id);
      if (t?.assignee_id && !canEditRole(roleOf(state, t.assignee_id, t.project_id))) replaceRow(state, 'tasks', id, { assignee_id: null }, at);
    }
  }

  // ---------- delen ----------

  projectShare(state, args, at) {
    exactArgs(args, ['project_id', 'username', 'role']);
    const id = requireLive(state, 'project', args.project_id, 'project_id').id;
    if (isInboxId(id)) fail('CONFLICT', 'de Inbox kan niet worden gedeeld');
    this.requireOwner(state, id, 'alleen de eigenaar kan een project delen');
    if (typeof args.username !== 'string') fail('INVALID_ARG', 'username moet tekst zijn');
    const role = args.role === undefined ? DEFAULT_SHARE_ROLE : args.role;
    const roleProblem = shareRoleProblem(role);
    if (roleProblem) fail('INVALID_ARG', roleProblem);
    const target = this.accounts.find((u) => nameKey(u.username) === nameKey(args.username));
    // zelfde melding voor "bestaat niet" en "geblokkeerd", net als de echte server
    if (!target || target.is_disabled) fail('NOT_FOUND', 'deze gebruiker bestaat niet');
    if (target.id === this.me.id) return;
    for (const p of projectTree(state, id)) {
      if (roleOf(state, this.me.id, p) !== 'owner' || isMember(state, target.id, p)) continue;
      addMember(state, p, target.id, role, at, newId());
    }
  }

  /** De rol van een lid wijzigen, zoals `memberUpdate` in server/sync.ts (de app rekent het zelf ook vooruit, core/reducer.js). */
  memberUpdate(state, args, at) {
    exactArgs(args, ['project_id', 'user_id', 'role']);
    const id = requireLive(state, 'project', args.project_id, 'project_id').id;
    this.requireOwner(state, id, 'alleen de eigenaar kan de rol van een lid wijzigen');
    if (typeof args.user_id !== 'string' || !ID_RE.test(args.user_id)) fail('INVALID_ARG', 'ongeldig gebruikers-id');
    const roleProblem = shareRoleProblem(args.role);
    if (roleProblem) fail('INVALID_ARG', roleProblem);
    if (args.user_id === this.me.id) fail('CONFLICT', 'je eigen rol kun je niet wijzigen');
    const current = roleOf(state, args.user_id, id);
    if (current === null) fail('NOT_FOUND', 'deze persoon is geen lid van het project');
    if (current === 'owner') fail('CONFLICT', 'de rol van een eigenaar kan niet worden gewijzigd');
    return applyCommand(state, { type: 'member_update', args }, at, this.me.id);
  }

  /** Haalt iemand uit één project: het lidmaatschap, diens toewijzingen en diens herinneringen bij die taken. */
  removeMember(state, projectId, userId, at) {
    for (const m of [...state.members.values()]) if (m.project_id === projectId && m.user_id === userId) state.members.delete(m.id);
    const tasks = new Set([...state.tasks.values()].filter((t) => t.project_id === projectId).map((t) => t.id));
    for (const r of [...state.reminders.values()]) if (r.owner_id === userId && tasks.has(r.task_id)) state.reminders.delete(r.id);
    for (const id of tasks) if (state.tasks.get(id).assignee_id === userId) replaceRow(state, 'tasks', id, { assignee_id: null }, at);
  }

  projectUnshare(state, args, at) {
    exactArgs(args, ['project_id', 'user_id']);
    const id = requireLive(state, 'project', args.project_id, 'project_id').id;
    this.requireOwner(state, id, 'alleen de eigenaar kan iemand uit een project halen');
    const userId = args.user_id;
    if (typeof userId !== 'string' || !ID_RE.test(userId)) fail('INVALID_ARG', 'ongeldig gebruikers-id');
    if (userId === this.me.id) fail('CONFLICT', 'gebruik "verlaten" om er zelf uit te gaan');
    const role = roleOf(state, userId, id);
    if (role === null) fail('NOT_FOUND', 'deze persoon is geen lid van het project');
    if (role === 'owner') fail('CONFLICT', 'een eigenaar kan niet uit het project worden gehaald');
    for (const p of projectTree(state, id)) {
      const theirs = roleOf(state, userId, p);
      if (roleOf(state, this.me.id, p) === 'owner' && theirs !== null && theirs !== 'owner') this.removeMember(state, p, userId, at);
    }
  }

  projectLeave(state, args, at) {
    exactArgs(args, ['project_id']);
    const id = requireLive(state, 'project', args.project_id, 'project_id').id;
    if (isInboxId(id)) fail('CONFLICT', 'de Inbox kan niet worden verlaten');
    const me = this.me.id;
    if (roleOf(state, me, id) === 'owner') fail('CONFLICT', 'de eigenaar kan het project niet verlaten; verwijder het project of laat het door iemand anders overnemen');
    const left = new Set(projectTree(state, id).filter((p) => { const mine = roleOf(state, me, p); return mine !== null && mine !== 'owner'; }));
    for (const p of left) this.removeMember(state, p, me, at);
    // Wat je niet meer mag zien, bestaat voor jou niet meer: het project verdwijnt met alles erin.
    const tasks = new Set([...state.tasks.values()].filter((t) => left.has(t.project_id)).map((t) => t.id));
    const drop = (resource, pred) => { for (const row of [...state[resource].values()]) if (pred(row)) state[resource].delete(row.id); };
    drop('tasks', (t) => tasks.has(t.id));
    drop('sections', (s) => left.has(s.project_id));
    drop('members', (m) => left.has(m.project_id));
    drop('comments', (c) => left.has(c.project_id) || tasks.has(c.task_id));
    drop('attachments', (a) => tasks.has(a.task_id));
    drop('reminders', (r) => tasks.has(r.task_id));
    drop('notifications', (n) => left.has(n.project_id) || tasks.has(n.task_id)); // en de meldingen erover (zie server/notify.ts)
    drop('projects', (p) => left.has(p.id));
  }

  // ---------- bijlagen: dezelfde regels als server/attachments.ts, met de bestanden in het geheugen ----------

  attachmentsApi() {
    const used = () => [...this.files.values()].reduce((sum, f) => sum + f.size, 0);
    const sha256 = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const refuse = (status, code, message, retryable = false) => new AttachmentError(capitalize(message), { status, code, retryable });
    return {
      limits: async () => ({ max_upload_bytes: this.maxUploadBytes, quota_bytes: this.quotaBytes, used_bytes: used(), per_task: MAX_ATTACHMENTS_PER_TASK }),
      upload: async ({ id, taskId, blob, mime, onProgress = () => {} }) => {
        if (typeof id !== 'string' || !ID_RE.test(id)) throw refuse(400, 'INVALID_ARG', 'id moet 8-40 tekens uit [A-Za-z0-9_-] zijn');
        if (!this.state.tasks.has(taskId)) throw refuse(404, 'NOT_FOUND', 'deze taak bestaat niet');
        if (blob.size === 0) throw refuse(400, 'INVALID_ARG', 'het bestand is leeg');
        if (blob.size > this.maxUploadBytes) throw refuse(413, 'TOO_LARGE', `het bestand is te groot (maximaal ${Math.floor(this.maxUploadBytes / 1_000_000)} MB)`);
        const hash = await sha256(blob);
        const have = this.files.get(id);
        if (have) {
          if (have.task_id === taskId && have.sha256 === hash && have.size === blob.size) return { id, size: have.size, sha256: hash, mime: have.mime };
          throw refuse(409, 'CONFLICT', 'er is al een ander bestand met dit id geüpload');
        }
        if (used() + blob.size > this.quotaBytes) throw refuse(409, 'LIMIT_REACHED', 'je opslagruimte voor bijlagen is vol; verwijder eerst een bijlage');
        // zoals de server, in dezelfde stap als het vastleggen (na het wachten op de hash): hooguit 20 bijlagen en nog niet gekoppelde uploads per taak
        let attached = 0;
        for (const a of this.state.attachments.values()) if (a.task_id === taskId) attached += 1;
        const waiting = [...this.files.values()].filter((f) => f.task_id === taskId && !f.linked).length;
        if (attached + waiting >= MAX_ATTACHMENTS_PER_TASK) throw refuse(409, 'LIMIT_REACHED', `een taak kan hooguit ${MAX_ATTACHMENTS_PER_TASK} bijlagen hebben`);
        const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
        const effective = effectiveMime(mime, head);
        this.files.set(id, { blob, task_id: taskId, size: blob.size, sha256: hash, mime: effective, linked: false });
        onProgress(1);
        return { id, size: blob.size, sha256: hash, mime: effective };
      },
      download: async (id) => {
        const f = this.files.get(id);
        if (!f) throw refuse(404, 'NOT_FOUND', 'deze bijlage bestaat niet');
        return new Blob([f.blob], { type: isInlineMime(f.mime) ? f.mime : DEFAULT_MIME });
      },
    };
  }

  // ---------- account, apparaten en beheer (wat de app buiten de sync om vraagt) ----------

  api() {
    const view = (u) => ({ id: u.id, username: u.username, name: u.name, is_admin: u.is_admin, inbox_project_id: u.inbox_project_id, is_disabled: u.is_disabled, created_at: u.created_at, two_factor: false });
    const demoOnly = async () => { throw apiError(403, 'DEMO', notInDemo()); };
    const account = (id) => {
      const u = this.accounts.find((a) => a.id === id);
      if (!u) throw apiError(404, 'NOT_FOUND', 'gebruiker bestaat niet');
      return u;
    };
    const otherAdmins = (id) => this.accounts.filter((a) => a.is_admin && !a.is_disabled && a.id !== id).length;
    return {
      login: async () => { throw apiError(403, 'DEMO', notInDemo()); },
      loginCode: demoOnly,
      logout: async () => ({ ok: true }),
      me: async () => ({ me: { ...this.me } }),
      changePassword: async () => { throw apiError(403, 'DEMO', notInDemo()); },
      sessions: async () => ({ sessions: this.sessions.map((s) => ({ ...s, device: { ...s.device } })), policy: { idle_days: 90, max_days: 365 } }),
      revokeOtherSessions: async () => {
        const before = this.sessions.length;
        this.sessions = this.sessions.filter((s) => s.current);
        return { ok: true, revoked: before - this.sessions.length };
      },
      // Tweestapsverificatie en back-ups vragen een echt wachtwoord en een echte server: in de demo staat het uit en zegt de app dat.
      twoFactor: {
        status: async () => ({ enabled: false, enabled_at: null, recovery_codes_left: 0 }),
        setup: demoOnly,
        enable: demoOnly,
        disable: demoOnly,
        newRecoveryCodes: demoOnly,
      },
      activity: async (projectId, q) => this.activityPage(projectId, q),
      revokeSession: async (id) => {
        const i = this.sessions.findIndex((s) => s.id === id && !s.current);
        if (i < 0) throw apiError(404, 'NOT_FOUND', 'deze sessie bestaat niet');
        this.sessions.splice(i, 1);
        return { ok: true };
      },
      admin: {
        users: async () => ({ users: [...this.accounts].sort((a, b) => (nameKey(a.username) < nameKey(b.username) ? -1 : 1)).map(view) }),
        // Een account uit de demo heeft geen wachtwoord en kan nergens inloggen; je kunt er wel een project mee delen.
        createUser: async ({ username, name, password, is_admin: isAdmin } = {}) => {
          const u = typeof username === 'string' ? username.normalize('NFC').trim() : '';
          if (!USERNAME_RE.test(u)) throw apiError(400, 'INVALID_ARG', 'gebruikersnaam: 2 tot 40 tekens, letters, cijfers, punt, streepje of underscore, beginnend met een letter of cijfer');
          const n = (typeof name === 'string' && name.trim() ? name : u).normalize('NFC').trim().replace(/\s+/g, ' ');
          if (n.length > 100) throw apiError(400, 'INVALID_ARG', 'naam: 1 tot 100 tekens, zonder stuurtekens');
          if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) throw apiError(400, 'INVALID_ARG', `wachtwoord: minimaal ${MIN_PASSWORD} tekens`);
          if (nameKey(password) === nameKey(u)) throw apiError(400, 'INVALID_ARG', 'het wachtwoord mag niet gelijk zijn aan de gebruikersnaam');
          if (this.accounts.some((a) => nameKey(a.username) === nameKey(u))) throw apiError(409, 'DUPLICATE', 'deze gebruikersnaam is al in gebruik');
          const id = newId();
          const user = { id, username: u, name: n, is_admin: isAdmin === true, is_disabled: false, inbox_project_id: `inbox-${id}`, created_at: this.now().toISOString() };
          this.accounts.push(user);
          return { user: view(user) };
        },
        updateUser: async (id, changes = {}) => {
          const u = account(id);
          if (id === this.me.id && (changes.is_disabled === true || changes.is_admin === false)) {
            throw apiError(409, 'CONFLICT', 'je kunt jezelf niet blokkeren of de beheerdersrechten afnemen');
          }
          const willBeAdmin = changes.is_admin === undefined ? u.is_admin : changes.is_admin === true;
          const willBeEnabled = changes.is_disabled === undefined ? !u.is_disabled : changes.is_disabled !== true;
          if (u.is_admin && !u.is_disabled && !(willBeAdmin && willBeEnabled) && otherAdmins(id) === 0) throw apiError(409, 'CONFLICT', 'er moet minstens één actieve beheerder blijven');
          u.is_admin = willBeAdmin;
          u.is_disabled = !willBeEnabled;
          return { user: view(u) };
        },
        resetPassword: async (id) => {
          account(id);
          throw apiError(403, 'DEMO', notInDemo());
        },
        resetTwoFactor: async (id) => {
          account(id);
          throw apiError(403, 'DEMO', notInDemo());
        },
        backupTicket: demoOnly,
        backupUrl: () => '#',
      },
    };
  }
}

/**
 * Dezelfde vorm als het echte `createBackend` (zie client/core/backend.js), maar zonder server. Elke keer dat de pagina
 * laadt, begint de demo opnieuw met verse voorbeeldgegevens.
 */
export function createBackend() {
  const server = new DemoServer();
  return {
    /** true: de app start zonder inlogscherm, bewaart niets en registreert geen service worker. */
    demo: true,
    getToken: () => 'demo',
    setToken: () => {},
    clearToken: () => {},
    api: server.api(),
    transport: async (body) => server.sync(body),
    attachments: server.attachmentsApi(),
    listen: () => ({ stop() {}, restart() {} }),
  };
}
