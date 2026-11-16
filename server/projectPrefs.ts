// Persoonlijke voorkeuren in een gedeeld project: favoriet, ingeklapt (de subprojecten in de zijbalk), de weergave (lijst, bord,
// kalender) en de plek in de zijbalk (order_key). Die horen bij één persoon, niet bij het project: zet Bram een gedeeld project bij
// zijn favorieten of op het bord, dan verandert er voor Anna niets.
//
//   - De eigenaar houdt ze, zoals altijd, in het project zelf. Voor hem verandert er niets.
//   - Een ander lid (ook een lezer: het verandert niets voor anderen) bewaart ze in `project_prefs`. Zijn wijziging van een van
//     deze velden gaat daarheen in plaats van naar het project (zie updateEntity in sync.ts).
//   - De sync legt ze bij het verzenden over het project heen (personalize). Zonder eigen keuze: geen favoriet, niet ingeklapt, en
//     de weergave en volgorde van de eigenaar.
//   - Een eigen wijziging krijgt een nieuw versienummer in `project_prefs`; alleen die persoon krijgt het project dan opnieuw.
//
// Geen entiteit: de tabel gaat niet zelf mee in de sync, alleen via het project.

import type { DatabaseSync } from 'node:sqlite';
import { ENTITIES } from './schema.ts';
import { toDb } from './rows.ts';
import type { Ctx, Row } from './rows.ts';

export const PERSONAL_FIELDS = ['is_favorite', 'is_collapsed', 'view_style', 'order_key'] as const;
type Personal = (typeof PERSONAL_FIELDS)[number];
const isPersonal = (k: string): k is Personal => (PERSONAL_FIELDS as readonly string[]).includes(k);
const col = (name: Personal) => ENTITIES.project.cols.find((c) => c.name === name)!;

/** De wijzigingen gesplitst in persoonlijke velden en de rest. */
export function splitPersonal(changes: Row): { personal: Row; shared: Row } {
  const personal: Row = {};
  const shared: Row = {};
  for (const [k, v] of Object.entries(changes)) (isPersonal(k) ? personal : shared)[k] = v;
  return { personal, shared };
}

/** Bewaart de eigen voorkeuren van de gebruiker voor dit project (alleen de meegegeven velden). */
export function savePrefs(ctx: Ctx, projectId: string, personal: Row): void {
  const names = PERSONAL_FIELDS.filter((k) => Object.hasOwn(personal, k));
  if (names.length === 0) return;
  const values = names.map((k) => toDb(col(k), personal[k]));
  ctx.db.prepare(
    `INSERT INTO project_prefs (project_id, user_id, ${names.join(', ')}, rev, updated_at) VALUES (?, ?, ${names.map(() => '?').join(', ')}, ?, ?)
     ON CONFLICT (project_id, user_id) DO UPDATE SET ${names.map((k) => `${k} = excluded.${k}`).join(', ')}, rev = excluded.rev, updated_at = excluded.updated_at`,
  ).run(projectId, ctx.userId, ...values, ctx.rev, ctx.now);
}

/** Weg met de voorkeuren van een persoon in een project (die is geen lid meer), of van iedereen (zonder `userId`). */
export function forgetPrefs(db: DatabaseSync, projectId: string, userId?: string): void {
  if (userId) db.prepare('DELETE FROM project_prefs WHERE project_id = ? AND user_id = ?').run(projectId, userId);
  else db.prepare('DELETE FROM project_prefs WHERE project_id = ?').run(projectId);
}

/** Wat de sync voor één gebruiker nodig heeft: zijn rol per project en zijn eigen voorkeuren. Eén keer per verzoek. */
export function prefsOf(db: DatabaseSync, userId: string): { owner: Set<string>; prefs: Map<string, Row> } {
  const owner = new Set((db.prepare("SELECT project_id FROM project_members WHERE user_id = ? AND is_deleted = 0 AND role = 'owner'").all(userId) as Row[]).map((r) => r.project_id as string));
  const prefs = new Map((db.prepare('SELECT * FROM project_prefs WHERE user_id = ?').all(userId) as Row[]).map((r) => [r.project_id as string, r]));
  return { owner, prefs };
}

/**
 * Een project (in API-vorm) zoals deze gebruiker het ziet: voor de eigenaar ongewijzigd, voor een ander lid met zijn eigen
 * favoriet, ingeklapt, weergave en volgorde.
 */
export function personalize(project: Row, mine: { owner: Set<string>; prefs: Map<string, Row> }): Row {
  if (project.is_deleted === true || mine.owner.has(project.id as string)) return project;
  const p = mine.prefs.get(project.id as string);
  return {
    ...project,
    is_favorite: p?.is_favorite == null ? false : p.is_favorite === 1,
    is_collapsed: p?.is_collapsed == null ? false : p.is_collapsed === 1,
    view_style: (p?.view_style as string | null) ?? project.view_style,
    order_key: (p?.order_key as string | null) ?? project.order_key,
  };
}

/** De projecten waarvan de eigen voorkeuren van deze gebruiker sinds `since` veranderden (voor de delta), als subquery. */
export const PREFS_CHANGED = 'SELECT project_id FROM project_prefs WHERE user_id = ? AND rev > ?';
