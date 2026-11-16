// Uitnodigen via een link: de eigenaar van een project maakt een link (kan bewerken of alleen lezen, een paar dagen geldig) en stuurt
// die rond. Wie hem opent en een account op deze server heeft, ziet na het inloggen om welk project het gaat en komt erin met die rol.
// Er komen geen nieuwe accounts mee: een account maakt de beheerder (of inloggen via OIDC).
//
//   - Het token (256 bits, `tki_…`) staat alleen gehasht in de database en komt maar één keer terug: bij het maken.
//   - Accepteren is `project_share` namens de eigenaar (dezelfde regels: subprojecten, limieten, melding, logboek). Is wie de link
//     maakte geen eigenaar meer, of is het project weg, dan werkt de link niet meer.
//   - Een link geldt tot hij verloopt of de eigenaar hem intrekt; hooguit MAX_ACTIVE per project.
//
// Geen entiteit: de links gaan niet mee in de sync, de eigenaar haalt ze op met GET.

import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { handleSync } from './sync.ts';
import { getUserById } from './users.ts';
import { DEFAULT_SHARE_ROLE, shareRoleProblem } from '../shared/roles.js';

export const INVITE_DAYS = [1, 7, 30];
export const MAX_ACTIVE = 20;
const TOKEN = /^tki_[A-Za-z0-9_-]{43}$/;

type Row = Record<string, unknown>;

export class InviteError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const fail = (code: string, message: string): never => { throw new InviteError(code, message); };

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
const roleOf = (db: DatabaseSync, userId: string, projectId: string): string | null =>
  ((db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND is_deleted = 0').get(projectId, userId) as Row | undefined)?.role as string | undefined) ?? null;
const liveProject = (db: DatabaseSync, id: string): Row | undefined =>
  db.prepare('SELECT id, name, is_archived FROM projects WHERE id = ? AND is_deleted = 0').get(id) as Row | undefined;

function requireOwner(db: DatabaseSync, userId: string, projectId: string): Row {
  const project = liveProject(db, projectId);
  // wie het project niet ziet, hoort niet te weten dat het bestaat
  if (!project || roleOf(db, userId, projectId) === null) fail('NOT_FOUND', 'dit project bestaat niet');
  if (roleOf(db, userId, projectId) !== 'owner') fail('FORBIDDEN', 'alleen de eigenaar kan uitnodigen met een link');
  if (projectId.startsWith('inbox-')) fail('CONFLICT', 'de Inbox kan niet worden gedeeld');
  return project!;
}

const view = (r: Row) => ({ id: r.id as string, role: r.role as string, created_at: r.created_at as string, expires_at: r.expires_at as string, uses: Number(r.uses) });

/** De links van een project die nog werken (alleen de eigenaar). */
export function listInvites(db: DatabaseSync, userId: string, projectId: string, nowMs: number) {
  requireOwner(db, userId, projectId);
  const rows = db.prepare('SELECT * FROM project_invites WHERE project_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at').all(projectId, new Date(nowMs).toISOString()) as Row[];
  // `now`: de tijd van de server, zodat de app "nog zoveel dagen" goed uitrekent, ook met een scheve klok op het apparaat
  return { invites: rows.map(view), now: new Date(nowMs).toISOString() };
}

/** Een nieuwe link: `token` komt alleen hier terug (de database kent alleen de hash). */
export function createInvite(db: DatabaseSync, userId: string, projectId: string, body: Row, nowMs: number) {
  requireOwner(db, userId, projectId);
  const role = body.role === undefined ? DEFAULT_SHARE_ROLE : body.role;
  const problem = shareRoleProblem(role);
  if (problem) fail('INVALID_ARG', problem);
  const days = body.days === undefined ? 7 : body.days;
  if (!INVITE_DAYS.includes(days as number)) fail('INVALID_ARG', `days moet een van ${INVITE_DAYS.join(', ')} zijn`);
  const now = new Date(nowMs).toISOString();
  const active = Number((db.prepare('SELECT COUNT(*) AS n FROM project_invites WHERE project_id = ? AND revoked = 0 AND expires_at > ?').get(projectId, now) as Row).n);
  if (active >= MAX_ACTIVE) fail('LIMIT_REACHED', `hooguit ${MAX_ACTIVE} links per project tegelijk; trek er eerst een in`);
  const token = `tki_${randomBytes(32).toString('base64url')}`;
  const id = randomBytes(9).toString('base64url');
  const expires = new Date(nowMs + (days as number) * 86_400_000).toISOString();
  db.prepare('INSERT INTO project_invites (id, token_hash, project_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, hash(token), projectId, role as string, userId, now, expires);
  return { ...view({ id, role, created_at: now, expires_at: expires, uses: 0 }), token };
}

/** Een link intrekken (alleen de eigenaar). */
export function revokeInvite(db: DatabaseSync, userId: string, projectId: string, inviteId: string) {
  requireOwner(db, userId, projectId);
  const r = db.prepare('UPDATE project_invites SET revoked = 1 WHERE id = ? AND project_id = ?').run(inviteId, projectId);
  if (Number(r.changes) === 0) fail('NOT_FOUND', 'deze link bestaat niet');
  return { ok: true };
}

/** De link achter een token, als hij nog werkt; anders één en dezelfde fout (verlopen, ingetrokken of onbekend). */
function usable(db: DatabaseSync, token: unknown, nowMs: number): Row {
  const gone = () => fail('NOT_FOUND', 'deze link werkt niet (meer): verlopen, ingetrokken of onbekend');
  if (typeof token !== 'string' || !TOKEN.test(token)) return gone();
  const r = db.prepare('SELECT * FROM project_invites WHERE token_hash = ?').get(hash(token)) as Row | undefined;
  if (!r || r.revoked === 1 || (r.expires_at as string) <= new Date(nowMs).toISOString()) return gone();
  const project = liveProject(db, r.project_id as string);
  if (!project || roleOf(db, r.created_by as string, r.project_id as string) !== 'owner') return gone();
  return { ...r, project_name: project.name };
}

/** Wat de link is, voordat je hem aanneemt: het project, wie uitnodigt, de rol, en of je er al in zit. */
export function previewInvite(db: DatabaseSync, userId: string, token: unknown, nowMs: number) {
  const r = usable(db, token, nowMs);
  const owner = getUserById(db, r.created_by as string);
  return { project_id: r.project_id, project_name: r.project_name, owner_name: owner?.name ?? '', role: r.role, member: roleOf(db, userId, r.project_id as string) !== null };
}

/**
 * De link aannemen: lid worden met de rol van de link (`project_share` namens de eigenaar). Zit je er al in, dan verandert er niets.
 * @returns het project en of je er nu (nieuw) in zit
 */
export function acceptInvite(db: DatabaseSync, userId: string, token: unknown, nowMs: number) {
  const r = usable(db, token, nowMs);
  const projectId = r.project_id as string;
  if (roleOf(db, userId, projectId) !== null) return { project_id: projectId, joined: false };
  const me = getUserById(db, userId);
  if (!me || me.is_disabled) fail('NOT_FOUND', 'onbekende gebruiker');
  const uuid = `invite-${randomBytes(12).toString('hex')}`;
  const res = handleSync(db, { sync_token: '*', resource_types: ['settings'], commands: [{ type: 'project_share', uuid, args: { project_id: projectId, username: me!.username, role: r.role } }] }, r.created_by as string);
  const status = res.sync_status[uuid];
  if (status !== 'ok') {
    const s = status as { error_code?: string; error?: string };
    fail(s.error_code ?? 'CONFLICT', s.error ?? 'aannemen lukte niet');
  }
  db.prepare('UPDATE project_invites SET uses = uses + 1 WHERE id = ?').run(r.id as string);
  return { project_id: projectId, joined: true };
}
