// Meldingen bij samenwerken: wie hoort wat als iemand anders iets doet (zie shared/notifications.js voor de soorten).
//
// De sync-engine (sync.ts) roept deze functies aan in hetzelfde savepoint als het commando zelf: mislukt het commando, dan is er
// ook geen melding. Regels:
//   - nooit een melding voor je eigen handeling;
//   - alleen voor wie het nu mag zien (lid van het project) en een actief account heeft;
//   - een melding bewaart alleen verwijzingen (soort, wie, taak of project, opmerking), geen kopie van de inhoud: wat de ontvanger
//     ziet, komt uit de gegevens die hij toch al mag zien, en wat verdwijnt (taak, opmerking, project, lidmaatschap) neemt de
//     melding mee;
//   - per gebruiker hooguit MAX_NOTIFICATIONS_PER_USER; de oudste vallen eraf. Na NOTIFICATION_RETENTION_DAYS ruimt
//     pruneNotifications ze op.
// Een nieuwe melding voor iemand met een browser met meldingen komt ook in `notification_outbox`; push.ts verstuurt die.

import type { DatabaseSync } from 'node:sqlite';
import { ENTITIES } from './schema.ts';
import { bumpRev, chunked, insertRow, mark, newId, placeholders } from './rows.ts';
import type { Ctx, Row } from './rows.ts';
import { MAX_NOTIFICATIONS_PER_USER, NOTIFICATION_RETENTION_DAYS, newMentions } from '../shared/notifications.js';

export type NotificationKind = 'assigned' | 'comment' | 'mention' | 'completed' | 'shared';
interface Target { task_id?: string | null; project_id?: string | null; comment_id?: string | null }

/** Hoe lang een verwijderde melding nog als {id, is_deleted} in de database blijft, zodat apparaten de verwijdering horen. */
export const NOTIFICATION_TOMBSTONE_DAYS = 30;

const isMember = (db: DatabaseSync, userId: string, projectId: string): boolean =>
  db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND is_deleted = 0').get(projectId, userId) !== undefined;

const isActive = (db: DatabaseSync, userId: string): boolean => db.prepare('SELECT 1 FROM users WHERE id = ? AND is_disabled = 0').get(userId) !== undefined;

/** Het project waar een melding over gaat: dat van de taak (zoals die nu is), of het project zelf. */
function projectOf(db: DatabaseSync, target: Target): string | null {
  if (target.task_id) {
    const t = db.prepare('SELECT project_id FROM tasks WHERE id = ? AND is_deleted = 0').get(target.task_id) as Row | undefined;
    return (t?.project_id as string | undefined) ?? null;
  }
  return target.project_id ?? null;
}

/** Eén melding voor `userId`, als die het mag zien en het niet zelf deed. */
function send(ctx: Ctx, userId: unknown, kind: NotificationKind, target: Target): void {
  if (typeof userId !== 'string' || userId === ctx.userId) return;
  const project = projectOf(ctx.db, target);
  if (!project || !isMember(ctx.db, userId, project) || !isActive(ctx.db, userId)) return;
  const id = newId();
  insertRow(ctx, ENTITIES.notification, id, {
    kind, actor_id: ctx.userId, task_id: target.task_id ?? null, project_id: target.task_id ? null : project,
    comment_id: target.comment_id ?? null, is_read: false, owner_id: userId,
  });
  // De grens per gebruiker: wat er boven valt (de oudste), gaat weg zoals elke verwijderde rij (de apparaten horen het).
  ctx.db.prepare(
    `UPDATE notifications SET is_deleted = 1, rev = ?, updated_at = ? WHERE id IN (
       SELECT id FROM notifications WHERE owner_id = ? AND is_deleted = 0 ORDER BY rev DESC, rowid DESC LIMIT -1 OFFSET ?)`,
  ).run(ctx.rev, ctx.now, userId, MAX_NOTIFICATIONS_PER_USER);
  // Alleen wie een browser met meldingen heeft, krijgt hem ook als pushbericht (de Android-app haalt ze zelf op).
  if (ctx.db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1').get(userId)) {
    ctx.db.prepare('INSERT OR IGNORE INTO notification_outbox (notification_id, user_id, created_at) VALUES (?, ?, ?)').run(id, userId, ctx.now);
  }
}

/** Iemand wees `assignee` een taak toe (bij toevoegen of wijzigen). */
export function taskAssigned(ctx: Ctx, taskId: string, assignee: unknown): void {
  send(ctx, assignee, 'assigned', { task_id: taskId });
}

/** Iemand vinkte een taak af: de persoon aan wie hij is toegewezen hoort het. */
export function taskCompleted(ctx: Ctx, task: Row): void {
  send(ctx, task.assignee_id, 'completed', { task_id: task.id as string });
}

/** Iemand werd lid van een project (alleen het project dat gedeeld werd, niet elk subproject apart). */
export function projectShared(ctx: Ctx, projectId: string, userId: string): void {
  send(ctx, userId, 'shared', { project_id: projectId });
}

/**
 * Een nieuwe opmerking. Bij een taak: wie hem moet doen, wie hem maakte en wie er eerder op reageerde; bij een project: alle leden.
 * Wie vermeld is, krijgt een melding "vermeld" in plaats van "opmerking". Iedereen hooguit één melding per opmerking.
 */
export function commentAdded(ctx: Ctx, comment: { id: string; task_id: string | null; project_id: string | null; mentions: string[] }): void {
  const db = ctx.db;
  const kinds = new Map<string, NotificationKind>();
  if (comment.task_id) {
    const t = db.prepare('SELECT assignee_id, creator_id FROM tasks WHERE id = ?').get(comment.task_id) as Row | undefined;
    for (const u of [t?.assignee_id, t?.creator_id]) if (typeof u === 'string') kinds.set(u, 'comment');
    const earlier = db.prepare('SELECT DISTINCT author_id FROM comments WHERE task_id = ? AND is_deleted = 0 AND id <> ? AND author_id IS NOT NULL').all(comment.task_id, comment.id) as Row[];
    for (const r of earlier) kinds.set(r.author_id as string, 'comment');
  } else if (comment.project_id) {
    const members = db.prepare('SELECT user_id FROM project_members WHERE project_id = ? AND is_deleted = 0').all(comment.project_id) as Row[];
    for (const m of members) kinds.set(m.user_id as string, 'comment');
  }
  for (const u of comment.mentions) kinds.set(u, 'mention');
  const target = { task_id: comment.task_id, project_id: comment.project_id, comment_id: comment.id };
  for (const [user, kind] of kinds) send(ctx, user, kind, target);
}

/** Een gewijzigde opmerking: alleen wie er nieuw in vermeld is, krijgt een melding. */
export function commentEdited(ctx: Ctx, comment: Row, before: unknown, after: unknown): void {
  const target = { task_id: (comment.task_id as string | null) ?? null, project_id: (comment.project_id as string | null) ?? null, comment_id: comment.id as string };
  for (const u of newMentions(before as string[] | null, after as string[] | null)) send(ctx, u, 'mention', target);
}

/**
 * De vermelde personen die het project van de opmerking zien. Wie geen lid is (meer), wordt stilzwijgend weggelaten in plaats van
 * de opmerking te weigeren: een opmerking die offline is geschreven, gaat zo niet verloren als iemand intussen uit het project is gehaald.
 */
export function onlyMembers(db: DatabaseSync, projectId: string | null, mentions: string[]): string[] {
  if (!projectId) return [];
  return mentions.filter((u) => isMember(db, u, projectId));
}

/** Het project van een opmerking (via de taak of rechtstreeks). */
export function commentProject(db: DatabaseSync, v: Row): string | null {
  return projectOf(db, { task_id: (v.task_id as string | null) ?? null, project_id: (v.project_id as string | null) ?? null });
}

/** Meldingen over iets dat verdwijnt, gaan mee (taken, een opmerking, een project). */
export function forgetTasks(ctx: Ctx, taskIds: string[]): void {
  for (const part of chunked(taskIds)) mark(ctx, 'notifications', `task_id IN (${placeholders(part.length)})`, part);
}
export function forgetComment(ctx: Ctx, commentId: string): void {
  mark(ctx, 'notifications', 'comment_id = ?', [commentId]);
}
export function forgetProject(ctx: Ctx, projectId: string): void {
  mark(ctx, 'notifications', 'project_id = ?', [projectId]);
}
/** Wie uit een project gaat, verliest ook zijn meldingen daarover (ook als hij later opnieuw lid wordt). */
export function forgetMember(ctx: Ctx, userId: string, projectId: string, taskIds: string[]): void {
  mark(ctx, 'notifications', 'owner_id = ? AND project_id = ?', [userId, projectId]);
  for (const part of chunked(taskIds)) mark(ctx, 'notifications', `owner_id = ? AND task_id IN (${placeholders(part.length)})`, [userId, ...part]);
}

/**
 * Opruimen: meldingen ouder dan de bewaartermijn worden verwijderd (de apparaten horen het, zoals bij elke verwijdering), en wat al
 * een maand verwijderd is, gaat helemaal uit de database. Ook pushberichten die na een dag nog niet weg zijn, vervallen.
 * @returns het aantal meldingen dat nu als verwijderd is gemarkeerd
 */
export function pruneNotifications(db: DatabaseSync, nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs - NOTIFICATION_RETENTION_DAYS * 86_400_000).toISOString();
  const now = new Date(nowMs).toISOString();
  let marked = 0;
  if (db.prepare('SELECT 1 FROM notifications WHERE is_deleted = 0 AND created_at < ? LIMIT 1').get(cutoff)) {
    const rev = bumpRev(db);
    marked = Number(db.prepare('UPDATE notifications SET is_deleted = 1, rev = ?, updated_at = ? WHERE is_deleted = 0 AND created_at < ?').run(rev, now, cutoff).changes);
  }
  db.prepare('DELETE FROM notifications WHERE is_deleted = 1 AND updated_at < ?').run(new Date(nowMs - NOTIFICATION_TOMBSTONE_DAYS * 86_400_000).toISOString());
  db.prepare('DELETE FROM notification_outbox WHERE created_at < ?').run(new Date(nowMs - 86_400_000).toISOString());
  return marked;
}
