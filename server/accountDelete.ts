// Je eigen account verwijderen (SPEC 5n): alles van jou gaat weg, wat je in projecten van anderen schreef blijft daar.
//
// Eerst de controles (`accountBlockers`): je bent geen eigenaar van een gedeeld project waar nog anderen in zitten (dat zou hun
// werk wissen; verwijder het project zelf of haal de leden eruit), en je bent niet de laatste actieve beheerder (dan kan niemand
// de server meer beheren).
//
// Dan in twee stappen (`deleteAccount`):
//   1. Wat anderen zien, gaat via de gewone commando's, zodat hun apparaten het in de sync meekrijgen: je verlaat de projecten
//      van anderen (je toewijzingen vervallen daarmee), je verlaat notities die met je gedeeld zijn, je gedeelde notities en al je
//      labels worden verwijderd (een label verdwijnt dan ook van taken in gedeelde projecten).
//   2. Wat alleen van jou is, gaat met SQL helemaal weg (geen sporen in de database): je eigen projecten met hun secties, taken,
//      opmerkingen, bijlagen en logboek, je notities, filters, plaatsen, sjablonen, herinneringen, meldingen en instellingen, je
//      sessies, pushaanmeldingen, tweestapsgegevens, SSO-koppelingen en ten slotte je account zelf. Alleen sporen zonder inhoud
//      blijven (je verwijderde lidmaatschap van een project van een ander, de verwijderde deling van een notitie): die heeft de
//      sync nodig om het de anderen te laten weten. De bestanden van je bijlagen,
//      foto's en opnames gaan meteen van schijf (geen wachttijd zoals bij een gewone verwijdering).
// Blijft staan: taken, opmerkingen en bijlagen die je in projecten van anderen maakte, en hun logboek (daar heet je dan "iemand").

import type { DatabaseSync } from 'node:sqlite';
import { handleSync } from './sync.ts';
import type { Command } from './sync.ts';
import { newId } from './rows.ts';

type Row = Record<string, unknown>;

export interface AccountBlockers {
  /** Gedeelde projecten waarvan jij eigenaar bent en waar nog anderen lid van zijn. */
  shared_projects: { id: string; name: string; members: number }[];
  /** Jij bent de enige actieve beheerder. */
  last_admin: boolean;
}

const tableExists = (db: DatabaseSync, name: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** Wat het verwijderen nog tegenhoudt; leeg (geen projecten, geen laatste beheerder) = het mag. */
export function accountBlockers(db: DatabaseSync, userId: string): AccountBlockers {
  const shared = db.prepare(
    `SELECT p.id, p.name, (SELECT COUNT(*) FROM project_members o WHERE o.project_id = p.id AND o.is_deleted = 0 AND o.user_id <> ?) AS others
     FROM project_members m JOIN projects p ON p.id = m.project_id
     WHERE m.user_id = ? AND m.role = 'owner' AND m.is_deleted = 0 AND p.is_deleted = 0
     ORDER BY p.name`).all(userId, userId) as Row[];
  const me = db.prepare('SELECT is_admin, is_disabled FROM users WHERE id = ?').get(userId) as Row | undefined;
  const admins = (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND is_disabled = 0').get() as Row).n as number;
  return {
    shared_projects: shared.filter((r) => Number(r.others) > 0).map((r) => ({ id: r.id as string, name: r.name as string, members: Number(r.others) })),
    last_admin: me?.is_admin === 1 && me.is_disabled === 0 && admins <= 1,
  };
}

export const isBlocked = (b: AccountBlockers): boolean => b.shared_projects.length > 0 || b.last_admin;

/**
 * Verwijdert het account met alles wat erbij hoort. Roep eerst `accountBlockers` aan: dit controleert het opnieuw en weigert
 * (een Error met `code = 'BLOCKED'`) als er iets in de weg staat.
 * @param removeFiles haalt de bestanden van deze bijlagen en notitiebestanden meteen weg (attachments.ts `removeNow`)
 * @returns het versienummer van vóór de eerste stap (voor wie er iets van moet horen: zie audienceSince in sync.ts)
 */
export function deleteAccount(db: DatabaseSync, userId: string, removeFiles: (ids: string[]) => void = () => {}): number {
  if (isBlocked(accountBlockers(db, userId))) throw Object.assign(new Error('het account kan nog niet worden verwijderd'), { code: 'BLOCKED' });
  const before = Number((db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as Row).value);
  const run = (type: string, args: Record<string, unknown>): void => {
    const command: Command = { type, uuid: `account-delete-${newId()}`, args } as Command;
    const res = handleSync(db, { commands: [command] }, userId);
    const status = Object.values(res.sync_status ?? {})[0] as unknown;
    // al weg (een subproject dat met zijn ouder meeging): goed; iets anders is een echte fout
    if (status !== 'ok' && (status as { error_code?: string })?.error_code !== 'NOT_FOUND') {
      throw new Error(`${type} mislukte: ${JSON.stringify(status)}`);
    }
  };

  // ---- 1. wat anderen zien: via de commando's ----
  const memberships = db.prepare(
    `SELECT m.project_id FROM project_members m JOIN projects p ON p.id = m.project_id
     WHERE m.user_id = ? AND m.role <> 'owner' AND m.is_deleted = 0 AND p.is_deleted = 0`).all(userId) as Row[];
  for (const m of memberships) {
    const still = db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND is_deleted = 0').get(m.project_id as string, userId);
    if (still) run('project_leave', { project_id: m.project_id });
  }
  for (const s of db.prepare('SELECT id FROM note_shares WHERE user_id = ? AND is_deleted = 0').all(userId) as Row[]) run('note_share_delete', { id: s.id });
  const sharedNotes = db.prepare(
    `SELECT DISTINCT n.id FROM notes n JOIN note_shares s ON s.note_id = n.id
     WHERE n.owner_id = ? AND n.is_deleted = 0 AND s.is_deleted = 0`).all(userId) as Row[];
  for (const n of sharedNotes) run('note_delete', { id: n.id });
  for (const l of db.prepare('SELECT id FROM labels WHERE owner_id = ? AND is_deleted = 0').all(userId) as Row[]) run('label_delete', { id: l.id });

  // ---- 2. wat alleen van jou is: helemaal weg ----
  db.exec('BEGIN IMMEDIATE');
  try {
    const own = (db.prepare("SELECT project_id FROM project_members WHERE user_id = ? AND role = 'owner'").all(userId) as Row[]).map((r) => r.project_id as string);
    const inbox = (db.prepare('SELECT inbox_project_id FROM users WHERE id = ?').get(userId) as Row | undefined)?.inbox_project_id as string | undefined;
    const projects = [...new Set([...own, ...(inbox ? [inbox] : [])])];
    const inList = (ids: string[]) => ids.map(() => '?').join(', ') || "''";
    const tasks = projects.length === 0 ? [] : (db.prepare(`SELECT id FROM tasks WHERE project_id IN (${inList(projects)})`).all(...projects) as Row[]).map((r) => r.id as string);
    const notes = (db.prepare('SELECT id FROM notes WHERE owner_id = ?').all(userId) as Row[]).map((r) => r.id as string);

    // de bestanden eerst (de rijen in attachment_files wijzen ernaar)
    const fileIds = [
      ...(tasks.length === 0 ? [] : (db.prepare(`SELECT id FROM attachments WHERE task_id IN (${inList(tasks)})`).all(...tasks) as Row[]).map((r) => r.id as string)),
      ...(notes.length === 0 ? [] : (db.prepare(`SELECT id FROM note_files WHERE note_id IN (${inList(notes)})`).all(...notes) as Row[]).map((r) => r.id as string)),
      ...(db.prepare('SELECT id FROM attachment_files WHERE user_id = ? AND linked = 0').all(userId) as Row[]).map((r) => r.id as string),
    ];
    removeFiles(fileIds);

    const del = (sql: string, ...params: string[]) => db.prepare(sql).run(...params);
    const inChunks = (ids: string[], fn: (part: string[]) => void) => { for (let i = 0; i < ids.length; i += 500) fn(ids.slice(i, i + 500)); };
    inChunks(tasks, (part) => {
      del(`DELETE FROM attachments WHERE task_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM reminders WHERE task_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM comments WHERE task_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM notifications WHERE task_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM task_moves WHERE task_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM attachment_files WHERE task_id IN (${inList(part)})`, ...part);
    });
    inChunks(projects, (part) => {
      del(`DELETE FROM tasks WHERE project_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM sections WHERE project_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM comments WHERE project_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM notifications WHERE project_id IN (${inList(part)})`, ...part);
      // alleen je eigen lidmaatschap: de sporen van oud-leden blijven, zodat hun apparaten nog horen dat het project weg is
      del(`DELETE FROM project_members WHERE project_id IN (${inList(part)}) AND user_id = ?`, ...part, userId);
      if (tableExists(db, 'project_prefs')) del(`DELETE FROM project_prefs WHERE project_id IN (${inList(part)})`, ...part);
      if (tableExists(db, 'project_invites')) del(`DELETE FROM project_invites WHERE project_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM activity WHERE project_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM projects WHERE id IN (${inList(part)})`, ...part);
    });
    inChunks(notes, (part) => {
      del(`DELETE FROM note_files WHERE note_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM attachment_files WHERE note_id IN (${inList(part)})`, ...part);
      if (tableExists(db, 'note_revisions')) del(`DELETE FROM note_revisions WHERE note_id IN (${inList(part)})`, ...part);
      del(`DELETE FROM notes WHERE id IN (${inList(part)})`, ...part);
    });
    // wat alleen de eigenaar ziet (labels zijn in stap 1 al overal van de taken gehaald)
    for (const table of ['labels', 'filters', 'places', 'templates', 'reminders', 'notifications', 'user_settings', 'note_files']) {
      if (tableExists(db, table)) del(`DELETE FROM ${table} WHERE owner_id = ?`, userId);
    }
    // Blijven als spoor (alleen id's, geen inhoud): je lidmaatschappen van projecten van anderen en de delingen van je notities.
    // Daaraan zien de apparaten van de anderen bij hun volgende sync dat je weg bent en dat de notitie verdween.
    for (const table of ['reminder_deliveries', 'push_subscriptions', 'sessions', 'recovery_codes', 'oidc_identities', 'login_codes', 'command_log', 'notification_outbox', 'project_prefs']) {
      if (tableExists(db, table)) del(`DELETE FROM ${table} WHERE user_id = ?`, userId);
    }
    if (tableExists(db, 'project_invites')) del('DELETE FROM project_invites WHERE created_by = ?', userId);
    del('DELETE FROM attachment_files WHERE user_id = ? AND linked = 0', userId);
    del('DELETE FROM users WHERE id = ?', userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return before;
}
