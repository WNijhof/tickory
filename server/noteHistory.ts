// Versiegeschiedenis van notities (SPEC 5k), zoals in Anchor: de server bewaart een eerdere versie van titel en tekst,
//   - bij een wijziging na een pauze (de vorige bewaarde versie is ouder dan REVISION_GAP_MS, of er is er nog geen), en
//   - altijd vlak vóór het terugzetten van een eerdere versie (zodat dat terugzetten ongedaan te maken is).
// Per notitie hooguit REVISIONS_PER_NOTE; de oudste gaan eruit. Een definitief verwijderde notitie neemt haar versies mee.
// De versies zijn geen gesynchroniseerde rijen: de app haalt ze op als het venster "Versiegeschiedenis" open gaat
// (GET /api/v1/notes/<id>/revisions en …/revisions/<versie-id>), alleen voor de eigenaar.

import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { ENTITIES, ID_RE } from './schema.ts';
import { SyncError, getRow } from './rows.ts';
import type { Ctx, Row } from './rows.ts';
import { noteRole } from './noteAccess.ts';

export const REVISION_GAP_MS = 10 * 60 * 1000;
export const REVISIONS_PER_NOTE = 50;
const PAGE = 50;

export type RevisionCause = 'edit' | 'restore';

const nextSeq = (db: DatabaseSync, noteId: string): number =>
  Number((db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM note_revisions WHERE note_id = ?').get(noteId) as Row).n) + 1;

function store(ctx: Ctx, note: Row, cause: RevisionCause): string | null {
  const title = (note.title as string | null) ?? '';
  const content = (note.content as string | null) ?? '';
  if (!title && !content) return null; // een lege notitie is geen versie om naar terug te gaan
  const last = ctx.db.prepare('SELECT title, content FROM note_revisions WHERE note_id = ? ORDER BY seq DESC LIMIT 1').get(note.id as string) as Row | undefined;
  if (last && last.title === title && last.content === content) return null; // die stand is er al
  const id = `rev_${randomBytes(12).toString('base64url')}`;
  ctx.db.prepare(`INSERT INTO note_revisions (id, note_id, owner_id, author_id, title, content, cause, saved_at, created_at, seq)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, note.id as string, note.owner_id as string, ctx.userId, title, content, cause, note.updated_at as string, ctx.now, nextSeq(ctx.db, note.id as string));
  // de oudste weg, zodat een notitie die vaak wordt bewerkt niet onbeperkt groeit
  ctx.db.prepare(`DELETE FROM note_revisions WHERE note_id = ? AND seq <= (
                    SELECT seq FROM note_revisions WHERE note_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`)
    .run(note.id as string, note.id as string, REVISIONS_PER_NOTE);
  return id;
}

/**
 * Vóór een wijziging van titel of tekst: de huidige stand bewaren als de laatste bewaarde versie lang genoeg geleden is.
 * Wordt aangeroepen met de rij zoals die nu in de database staat en de nieuwe waarden.
 */
export function beforeNoteUpdate(ctx: Ctx, note: Row, changes: Row): void {
  const titleChanges = Object.hasOwn(changes, 'title') && changes.title !== note.title;
  const contentChanges = Object.hasOwn(changes, 'content') && changes.content !== note.content;
  if (!titleChanges && !contentChanges) return;
  const last = ctx.db.prepare('SELECT created_at FROM note_revisions WHERE note_id = ? ORDER BY seq DESC LIMIT 1').get(note.id as string) as Row | undefined;
  if (last && Date.parse(ctx.now) - Date.parse(last.created_at as string) < REVISION_GAP_MS) return;
  store(ctx, note, 'edit');
}

/** Een notitie is definitief weg: haar versies ook. */
export function forgetNoteRevisions(db: DatabaseSync, noteId: string): void {
  db.prepare('DELETE FROM note_revisions WHERE note_id = ?').run(noteId);
}

/** De notitie, als deze gebruiker haar ziet (eigenaar, of gedeeld); anders "bestaat niet". */
function ownNote(db: DatabaseSync, userId: string, noteId: unknown): Row {
  if (typeof noteId !== 'string' || !ID_RE.test(noteId) || noteRole(db, userId, noteId) === null) throw new SyncError('NOT_FOUND', 'deze notitie bestaat niet');
  const note = getRow(db, ENTITIES.note, noteId);
  if (!note) throw new SyncError('NOT_FOUND', 'deze notitie bestaat niet');
  return note;
}

const summary = (r: Row) => ({ id: r.id, version: r.seq, title: r.title, cause: r.cause, saved_at: r.saved_at, created_at: r.created_at, author_id: r.author_id ?? null });

/** De versies van een notitie, nieuwste eerst, zonder de tekst; `before` (een versienummer) voor de volgende bladzijde. */
export function listRevisions(db: DatabaseSync, userId: string, noteId: string, opts: { before?: string | null } = {}): { revisions: object[]; next: number | null } {
  ownNote(db, userId, noteId);
  const before = opts.before && /^\d{1,9}$/.test(opts.before) ? Number(opts.before) : null;
  const rows = db.prepare(`SELECT id, seq, title, cause, saved_at, created_at, author_id FROM note_revisions
                           WHERE note_id = ? ${before !== null ? 'AND seq < ?' : ''} ORDER BY seq DESC LIMIT ?`)
    .all(...(before !== null ? [noteId, before, PAGE + 1] : [noteId, PAGE + 1])) as Row[];
  const page = rows.slice(0, PAGE);
  return { revisions: page.map(summary), next: rows.length > PAGE ? Number(page[page.length - 1].seq) : null };
}

/** Eén versie met de tekst. */
export function getRevision(db: DatabaseSync, userId: string, noteId: string, revisionId: string): object {
  ownNote(db, userId, noteId);
  const r = typeof revisionId === 'string' && /^rev_[A-Za-z0-9_-]{8,40}$/.test(revisionId)
    ? db.prepare('SELECT * FROM note_revisions WHERE id = ? AND note_id = ?').get(revisionId, noteId) as Row | undefined
    : undefined;
  if (!r) throw new SyncError('NOT_FOUND', 'deze versie bestaat niet');
  return { ...summary(r), content: r.content };
}

/**
 * Het commando `note_restore` { id, revision_id } (de client stuurt ook title en content mee om het meteen te tonen; de server
 * gebruikt die van de versie zelf). Bewaart eerst de huidige stand (cause 'restore'), dan krijgt de notitie de oude titel en tekst.
 * Geeft de wijzigingen terug die de aanroeper op de notitie toepast, of null als er niets verandert.
 */
export function restoreChanges(ctx: Ctx, note: Row, revisionId: unknown): { title: string; content: string } | null {
  const r = typeof revisionId === 'string' && /^rev_[A-Za-z0-9_-]{8,40}$/.test(revisionId)
    ? ctx.db.prepare('SELECT title, content FROM note_revisions WHERE id = ? AND note_id = ?').get(revisionId, note.id as string) as Row | undefined
    : undefined;
  if (!r) throw new SyncError('NOT_FOUND', 'revision_id: deze versie bestaat niet');
  if (r.title === note.title && r.content === note.content) return null;
  store(ctx, note, 'restore');
  return { title: r.title as string, content: r.content as string };
}
