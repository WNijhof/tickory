// Het activiteitenlogboek per project (zie SPEC.md, hoofdstuk 5f): wie deed wat en wanneer. Gedeeld door de server
// (server/activity.ts, die het vastlegt), de demo (die hetzelfde in het geheugen doet) en de web-app (die het toont).
//
// Een regel bewaart wie het deed (`actor_id`), wanneer (`at`), de soort (`kind`), verwijzingen (`task_id`, `section_id`,
// `comment_id`, `attachment_id`, `user_id` voor een lid) en `title`: de naam van de taak, sectie, bijlage of het project op dat
// moment (hooguit TITLE_MAX tekens). Nooit de tekst van een beschrijving of opmerking, en nooit iets privés: herinneringen,
// plaatsen, labels, filters en sjablonen komen er niet in (bij een gewijzigde taak staat alleen dát de labels veranderden).

/** Alle soorten, per groep (de groepen zijn de filterkeuzes in de app). */
export const ACTIVITY_GROUPS = {
  tasks: ['task_added', 'task_updated', 'task_completed', 'task_uncompleted', 'task_moved', 'task_deleted', 'task_restored'],
  sections: ['section_added', 'section_renamed', 'section_deleted', 'section_restored'],
  comments: ['comment_added', 'comment_deleted'],
  attachments: ['attachment_added', 'attachment_deleted'],
  members: ['member_added', 'member_role', 'member_removed', 'member_left'],
  project: ['project_created', 'project_renamed', 'project_archived', 'project_unarchived'],
};
export const ACTIVITY_KINDS = Object.values(ACTIVITY_GROUPS).flat();

/** De velden van een taak waarvan een wijziging in het logboek komt; inklappen en de volgorde zijn geen nieuws. */
export const LOGGED_TASK_FIELDS = ['content', 'description', 'priority', 'labels', 'due', 'deadline', 'duration', 'assignee_id'];

/** Zo lang blijft een regel bewaard, en zoveel regels per project (de oudste gaan eraf). */
export const ACTIVITY_RETENTION_DAYS = 180;
export const MAX_ACTIVITY_PER_PROJECT = 10_000;

/** Een pagina: standaard zoveel regels, hooguit zoveel. */
export const ACTIVITY_PAGE = 50;
export const ACTIVITY_PAGE_MAX = 100;

/** Zoveel tekens van een naam of titel bewaart een regel. */
export const TITLE_MAX = 200;

/** Een naam of titel ingekort tot TITLE_MAX tekens (op hele tekens, niet op halve). */
export function shortTitle(text) {
  if (typeof text !== 'string') return null;
  const chars = [...text];
  return chars.length <= TITLE_MAX ? text : `${chars.slice(0, TITLE_MAX - 1).join('')}…`;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Welke gelogde velden van een taak echt veranderen (een client mag een veld met dezelfde waarde meesturen: dat is geen wijziging).
 * @param {Record<string, unknown>} before de taak vóór de wijziging (in API-vorm)
 * @param {Record<string, unknown>} changes de meegestuurde velden
 * @returns {string[]} in de volgorde van LOGGED_TASK_FIELDS
 */
export function changedTaskFields(before, changes) {
  return LOGGED_TASK_FIELDS.filter((f) => Object.hasOwn(changes, f) && !same(before[f], changes[f]));
}

/**
 * Controleert de vraag naar een pagina (`?before=<cursor>&limit=<n>&kinds=a,b`). Geeft `{ before, limit, kinds }` of `{ error }`.
 * @param {{ before?: string | null, limit?: string | null, kinds?: string | null }} q
 */
export function parseActivityQuery(q) {
  const out = { before: null, limit: ACTIVITY_PAGE, kinds: null };
  if (q.before !== null && q.before !== undefined && q.before !== '') {
    if (!/^\d{1,15}$/.test(q.before)) return { error: 'before moet een cursor uit een eerder antwoord zijn' };
    out.before = Number(q.before);
  }
  if (q.limit !== null && q.limit !== undefined && q.limit !== '') {
    if (!/^\d{1,3}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > ACTIVITY_PAGE_MAX) return { error: `limit moet 1 tot ${ACTIVITY_PAGE_MAX} zijn` };
    out.limit = Number(q.limit);
  }
  if (q.kinds !== null && q.kinds !== undefined && q.kinds !== '') {
    const kinds = q.kinds.split(',');
    if (kinds.length > ACTIVITY_KINDS.length || kinds.some((k) => !ACTIVITY_KINDS.includes(k))) return { error: 'kinds: onbekende soort' };
    out.kinds = [...new Set(kinds)];
  }
  return out;
}
