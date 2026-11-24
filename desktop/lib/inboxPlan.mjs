// Meldingen bij samenwerken (iemand wees je een taak toe, reageerde, noemde je, vinkte jouw taak af, voegde je toe aan een project
// of deelde een notitie) als melding van Windows. Electron kent geen web-push, dus de app doet het zoals de Android-app: hij haalt de
// meldingen op die de server voor je heeft (`notifications` in de sync) en toont de nieuwe ongelezen zelf, met dezelfde keuze per
// soort als in de browser (Instellingen › Meldingen, `settings.notify_push`). Zuiver: te testen zonder Electron.
import { pushChoices } from '../shared/notifications.js';
import { noteHeadline } from '../shared/notes.js';

/** Ouder dan dit tonen we niet meer als melding (bijvoorbeeld na een week niet aan): de lijst in de app heeft ze wel. */
export const MAX_AGE_MS = 3 * 24 * 3600 * 1000;
/** Zoveel nieuwe meldingen tegelijk hooguit; de rest staat in de lijst in de app. */
export const MAX_AT_ONCE = 10;
/** Zoveel id's onthouden we (de server bewaart er per gebruiker hooguit 500). */
export const MAX_KNOWN = 600;

const ID = /^[A-Za-z0-9_-]{8,40}$/;
const EXCERPT = 200;

/** Tekst op één regel, hooguit [max] tekens (met … als er iets af ging). */
export function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * De meldingen uit de gegevens van de app, met de naam van de taak, het project of de notitie en het begin van de opmerking. Een
 * melding over iets wat er niet (meer) is of wat je niet meer ziet, valt weg, net als op de server.
 * @param {object | null} sync zie syncCache.mjs
 * @returns {{ account: string, push: Record<string, boolean>, items: object[] } | null} null zonder gegevens of zonder meldingen (een oudere server)
 */
export function inboxSnapshot(sync) {
  const me = sync?.me?.id;
  if (typeof me !== 'string' || !ID.test(me) || !Array.isArray(sync.notifications)) return null;
  const names = new Map((sync.users ?? []).filter((u) => u && typeof u.id === 'string').map((u) => [u.id, oneLine(u.name, 100)]));
  const tasks = new Map((sync.tasks ?? []).filter((x) => x && !x.is_deleted).map((x) => [x.id, x]));
  const projects = new Map((sync.projects ?? []).filter((x) => x && !x.is_deleted).map((x) => [x.id, x]));
  const notes = new Map((sync.notes ?? []).filter((x) => x && !x.is_deleted && !x.trashed_at).map((x) => [x.id, x]));
  const comments = new Map((sync.comments ?? []).filter((x) => x && !x.is_deleted).map((x) => [x.id, x]));
  const own = (sync.settings ?? []).find((s) => s && s.owner_id === me) ?? null;
  const items = [];
  for (const n of sync.notifications) {
    if (!n || n.is_deleted || n.owner_id !== me || !ID.test(n.id ?? '')) continue;
    const created = Date.parse(n.created_at ?? '');
    if (!Number.isFinite(created)) continue;
    let title;
    let project = null;
    if (n.note_id) {
      const note = notes.get(n.note_id);
      if (!note) continue; // de notitie is weg of niet meer gedeeld
      title = noteHeadline(note, 300);
    } else if (n.task_id) {
      const task = tasks.get(n.task_id);
      const p = task && projects.get(task.project_id);
      if (!task || !p) continue;
      title = task.content;
      project = oneLine(p.name, 200);
    } else {
      const p = projects.get(n.project_id);
      if (!p) continue;
      title = p.name;
    }
    let text = null;
    if (n.comment_id) {
      const c = comments.get(n.comment_id);
      if (!c) continue; // de opmerking is al weer weg
      text = oneLine(c.content, EXCERPT);
    }
    items.push({
      id: n.id, kind: String(n.kind ?? ''), actor: names.get(n.actor_id) ?? '', title: oneLine(title, 300), project, text,
      taskId: n.note_id ? null : n.task_id ?? null, noteId: n.note_id ?? null, isRead: n.is_read === true, createdAt: created,
    });
  }
  return { account: me, push: pushChoices(own), items };
}

/**
 * Wat er na een verversing moet gebeuren (zoals InboxPlan in de Android-app).
 * - Eerste keer voor deze gebruiker (geen [state], of van een ander account): alles wat er al is telt als bekend en er komt niets
 *   in beeld (geen stapel oude meldingen na het inloggen of na het bijwerken van de app).
 * - Daarna: een nieuwe ongelezen melding komt in beeld als de soort aan staat, hij niet te oud is en je niet net in Tickory zelf
 *   bezig bent (dan zie je hem daar). Elke melding hooguit één keer, ook na een herstart.
 * - Een melding die in beeld staat maar inmiddels gelezen is (hier of op een ander apparaat), of weg is, gaat weg.
 * @param {{ account: string, known: string[], shown: string[] } | null} state
 * @returns {{ show: object[], cancel: string[], next: { account: string, known: string[], shown: string[] } }}
 */
export function decideInbox(state, snapshot, now, appVisible) {
  const ids = snapshot.items.map((x) => x.id);
  if (!state || state.account !== snapshot.account) {
    return { show: [], cancel: state?.shown ?? [], next: { account: snapshot.account, known: ids.slice(-MAX_KNOWN), shown: [] } };
  }
  const byId = new Map(snapshot.items.map((x) => [x.id, x]));
  const known = new Set(state.known);
  const cancel = state.shown.filter((id) => byId.get(id)?.isRead !== false);
  const fresh = snapshot.items.filter((x) => !known.has(x.id) && !x.isRead).sort((a, b) => a.createdAt - b.createdAt);
  const show = appVisible ? [] : fresh.filter((x) => snapshot.push[x.kind] === true && now - x.createdAt <= MAX_AGE_MS).slice(-MAX_AT_ONCE);
  // alles wat er nu is, is vanaf nu bekend: ook een gelezen melding die later weer op ongelezen gaat, komt niet alsnog in beeld
  const shown = state.shown.filter((id) => !cancel.includes(id) && byId.has(id));
  for (const x of show) if (!shown.includes(x.id)) shown.push(x.id);
  return { show, cancel, next: { account: snapshot.account, known: ids.slice(-MAX_KNOWN), shown } };
}

/** Wat er in de melding staat: wie wat deed, dan de naam (met het project) en het begin van de opmerking. */
export function activityText(item, t) {
  const kinds = ['assigned', 'comment', 'mention', 'completed', 'shared'];
  const kind = kinds.includes(item.kind) ? item.kind : 'other';
  const key = kind === 'comment' && !item.taskId ? 'activity_commentProject' : kind === 'shared' && item.noteId ? 'activity_sharedNote' : `activity_${kind}`;
  const actor = item.actor || t('someone');
  const lines = [item.title + (item.project ? ` · ${item.project}` : ''), item.text ?? ''].filter(Boolean);
  return { title: t(key, { actor }), lines };
}

/** Een bewaarde stand terug (settings.json), of null als hij kapot is. */
export function inboxStateOf(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(raw.account ?? '')) return null;
  const ids = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && ID.test(x)).slice(-MAX_KNOWN) : []);
  return { account: raw.account, known: ids(raw.known), shown: ids(raw.shown) };
}
