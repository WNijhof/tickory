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

const MAX_COMMANDS = 100;
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
    for (const r of RESOURCE_NAMES) for (const id of this.state[r].keys()) this.revs.set(`${r}/${id}`, 1);
    /** Uitkomst per uuid: een herhaald commando wordt niet opnieuw uitgevoerd. */
    this.seen = new Map();
    const nowMs = now().getTime();
    const ago = (minutes) => new Date(nowMs - minutes * 60_000).toISOString();
    this.sessions = [
      { id: 'demo-session-1', name: deviceName(), created_at: ago(0), last_used_at: ago(0), current: true },
      { id: 'demo-session-2', name: t('device.browserOn', { browser: 'Chrome', os: 'Android' }), created_at: ago(60 * 24 * 41), last_used_at: ago(95), current: false },
      { id: 'demo-session-3', name: t('device.browserOn', { browser: 'Firefox', os: 'Windows' }), created_at: ago(60 * 24 * 120), last_used_at: ago(60 * 24 * 6), current: false },
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
    this.state = next;
    return 'ok';
  }

  run(state, type, args, at) {
    const me = this.me.id;
    const apply = (a = args) => applyCommand(state, { type, args: a }, at, me);
    switch (type) {
      case 'task_move': this.checkTaskMove(state, args); apply(); return this.dropStrangers(state, args.id, at);
      case 'task_complete':
        // zoals de server: `if_due` is de datum die de afzender zag (de reducer doet er hetzelfde mee)
        exactArgs(args, ['id', 'if_due']);
        if (args.if_due !== undefined && !isValidDate(args.if_due)) fail('INVALID_ARG', 'if_due moet een geldige datum zijn');
        requireLive(state, 'task', args.id, 'task.id');
        return apply();
      case 'task_uncomplete': exactArgs(args, ['id']); requireLive(state, 'task', args.id, 'task.id'); return apply();
      case 'project_share': return this.projectShare(state, args, at);
      case 'project_unshare': return this.projectUnshare(state, args, at);
      case 'project_leave': return this.projectLeave(state, args, at);
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
      this.verify(state, e, id, v, 'add', v);
      return apply({ ...args, id });
    }
    if (m[2] === 'update') {
      const row = requireLive(state, e.name, args.id, `${e.name}.id`);
      this.requireMayWrite(e, row);
      const changes = this.collect(state, e, args, 'update');
      if (e.name === 'project' && has(changes, 'parent_id') && changes.parent_id !== row.parent_id) this.requireOwner(state, row.id, 'alleen de eigenaar kan een project verplaatsen');
      this.verify(state, e, row.id, { ...row, ...changes }, 'update', changes);
      return apply();
    }
    exactArgs(args, ['id']);
    const row = requireLive(state, e.name, args.id, `${e.name}.id`);
    this.requireMayWrite(e, row);
    if (e.name === 'project') {
      if (isInboxId(row.id)) fail('CONFLICT', 'de Inbox kan niet worden verwijderd');
      this.requireOwner(state, row.id, 'alleen de eigenaar kan een project verwijderen; gebruik "verlaten" om er zelf uit te gaan');
    }
    return apply();
  }

  // ---------- controles, gelijk aan de server ----------

  requireOwner(state, projectId, what) {
    if (roleOf(state, this.me.id, projectId) !== 'owner') fail('FORBIDDEN', what);
  }

  /** Iets zien is niet altijd genoeg om het te wijzigen: een label van een ander lees je alleen. */
  requireMayWrite(e, row) {
    if ((e.name === 'label' || e.name === 'filter') && row.owner_id !== this.me.id) {
      fail('FORBIDDEN', e.name === 'label' ? 'dit label is van iemand anders; je kunt het alleen lezen' : 'dit filter is van iemand anders');
    }
    if (e.name === 'comment' && row.author_id !== null && row.author_id !== this.me.id) fail('FORBIDDEN', 'je kunt alleen je eigen opmerkingen wijzigen of verwijderen');
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
        if (v.assignee_id && has(given, 'assignee_id') && !isMember(state, v.assignee_id, v.project_id)) fail('INVALID_ARG', 'de toegewezen persoon is geen lid van dit project');
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
    const projectChanges = has(args, 'project_id') && args.project_id !== row.project_id;
    if (has(args, 'project_id')) requireLive(state, 'project', args.project_id, 'task.project_id');
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
      if (t?.assignee_id && !isMember(state, t.assignee_id, t.project_id)) replaceRow(state, 'tasks', id, { assignee_id: null }, at);
    }
  }

  // ---------- delen ----------

  projectShare(state, args, at) {
    exactArgs(args, ['project_id', 'username']);
    const id = requireLive(state, 'project', args.project_id, 'project_id').id;
    if (isInboxId(id)) fail('CONFLICT', 'de Inbox kan niet worden gedeeld');
    this.requireOwner(state, id, 'alleen de eigenaar kan een project delen');
    if (typeof args.username !== 'string') fail('INVALID_ARG', 'username moet tekst zijn');
    const target = this.accounts.find((u) => nameKey(u.username) === nameKey(args.username));
    // zelfde melding voor "bestaat niet" en "geblokkeerd", net als de echte server
    if (!target || target.is_disabled) fail('NOT_FOUND', 'deze gebruiker bestaat niet');
    if (target.id === this.me.id) return;
    for (const p of projectTree(state, id)) {
      if (roleOf(state, this.me.id, p) !== 'owner' || isMember(state, target.id, p)) continue;
      addMember(state, p, target.id, 'member', at, newId());
    }
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
      if (roleOf(state, this.me.id, p) === 'owner' && roleOf(state, userId, p) === 'member') this.removeMember(state, p, userId, at);
    }
  }

  projectLeave(state, args, at) {
    exactArgs(args, ['project_id']);
    const id = requireLive(state, 'project', args.project_id, 'project_id').id;
    if (isInboxId(id)) fail('CONFLICT', 'de Inbox kan niet worden verlaten');
    const me = this.me.id;
    if (roleOf(state, me, id) === 'owner') fail('CONFLICT', 'de eigenaar kan het project niet verlaten; verwijder het project of laat het door iemand anders overnemen');
    const left = new Set(projectTree(state, id).filter((p) => roleOf(state, me, p) === 'member'));
    for (const p of left) this.removeMember(state, p, me, at);
    // Wat je niet meer mag zien, bestaat voor jou niet meer: het project verdwijnt met alles erin.
    const tasks = new Set([...state.tasks.values()].filter((t) => left.has(t.project_id)).map((t) => t.id));
    const drop = (resource, pred) => { for (const row of [...state[resource].values()]) if (pred(row)) state[resource].delete(row.id); };
    drop('tasks', (t) => tasks.has(t.id));
    drop('sections', (s) => left.has(s.project_id));
    drop('members', (m) => left.has(m.project_id));
    drop('comments', (c) => left.has(c.project_id) || tasks.has(c.task_id));
    drop('reminders', (r) => tasks.has(r.task_id));
    drop('projects', (p) => left.has(p.id));
  }

  // ---------- account, apparaten en beheer (wat de app buiten de sync om vraagt) ----------

  api() {
    const view = (u) => ({ id: u.id, username: u.username, name: u.name, is_admin: u.is_admin, inbox_project_id: u.inbox_project_id, is_disabled: u.is_disabled, created_at: u.created_at });
    const account = (id) => {
      const u = this.accounts.find((a) => a.id === id);
      if (!u) throw apiError(404, 'NOT_FOUND', 'gebruiker bestaat niet');
      return u;
    };
    const otherAdmins = (id) => this.accounts.filter((a) => a.is_admin && !a.is_disabled && a.id !== id).length;
    return {
      login: async () => { throw apiError(403, 'DEMO', notInDemo()); },
      logout: async () => ({ ok: true }),
      me: async () => ({ me: { ...this.me } }),
      changePassword: async () => { throw apiError(403, 'DEMO', notInDemo()); },
      sessions: async () => ({ sessions: this.sessions.map((s) => ({ ...s })) }),
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
    listen: () => ({ stop() {}, restart() {} }),
  };
}
