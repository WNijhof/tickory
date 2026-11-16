// Wie mag wat met een notitie (SPEC 5k, delen). Een notitie is van haar eigenaar; die kan haar delen met iemand anders als lezer
// (`viewer`: alleen lezen) of bewerker (`editor`: titel, tekst, foto's en geluid). Alles wat de eigenaar zelf ordent (labels,
// achtergrond, vastpinnen, archief, prullenbak, herinnering) blijft van de eigenaar. Eén plek voor sync.ts, attachments.ts en
// noteHistory.ts, zodat die regels overal gelijk zijn.

import type { DatabaseSync } from 'node:sqlite';

export type NoteRole = 'owner' | 'editor' | 'viewer';

/** Wat een bewerker aan een gedeelde notitie mag veranderen. */
export const EDITOR_FIELDS = Object.freeze(['title', 'content']);

/** De rol van deze gebruiker bij deze notitie, of null (geen toegang, verwijderd of onbekend). */
export function noteRole(db: DatabaseSync, userId: string, noteId: unknown): NoteRole | null {
  if (typeof noteId !== 'string') return null;
  const note = db.prepare('SELECT owner_id FROM notes WHERE id = ? AND is_deleted = 0').get(noteId) as { owner_id: string } | undefined;
  if (!note) return null;
  if (note.owner_id === userId) return 'owner';
  const share = db.prepare('SELECT role FROM note_shares WHERE note_id = ? AND user_id = ? AND is_deleted = 0').get(noteId, userId) as { role: string } | undefined;
  return share ? (share.role === 'editor' ? 'editor' : 'viewer') : null;
}

export const canEditNote = (role: NoteRole | null): boolean => role === 'owner' || role === 'editor';

/** Als subquery: de id's van de notities die met deze gebruiker gedeeld zijn (één parameter: de gebruiker). */
export const NOTES_SHARED_WITH = 'SELECT note_id FROM note_shares WHERE user_id = ? AND is_deleted = 0';
/** Als subquery: de id's van alle notities die deze gebruiker ziet (twee parameters: de gebruiker, twee keer). */
export const NOTES_I_SEE = `SELECT id FROM notes WHERE owner_id = ? UNION ${NOTES_SHARED_WITH}`;
