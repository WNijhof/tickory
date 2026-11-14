// De meldingen bij samenwerken als lijst ("Meldingen" in de app): wat er gebeurde, door wie, wanneer, en waar het over gaat.
// Zonder scherm: ui/inbox.js tekent dit. Een melding bewaart alleen verwijzingen (zie server/notify.ts); titels, namen en het begin
// van een opmerking komen hier uit de gegevens die de app toch al heeft. Wat er niet (meer) is, of ouder is dan de bewaartermijn,
// staat er niet in: zo opent een melding nooit iets wat je niet (meer) mag zien.

import { NOTIFICATION_RETENTION_DAYS } from '../../shared/notifications.js';
import { t } from './i18n.js';

const EXCERPT = 160;

/**
 * @typedef {{
 *   id: string, kind: string, read: boolean, at: string, actor: string, title: string, project: string | null,
 *   excerpt: string | null, target: { type: 'task' | 'project', id: string }, onProject: boolean, comment: object | null,
 * }} InboxItem
 */

const oneLine = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
};

/**
 * De meldingen van deze gebruiker, nieuwste eerst.
 * @param {object} view de lokale toestand
 * @param {{ userId: string | null, userName: (id: string) => string | null, now?: number }} options
 * @returns {InboxItem[]}
 */
export function inboxItems(view, { userId, userName, now = Date.now() }) {
  const oldest = new Date(now - NOTIFICATION_RETENTION_DAYS * 86_400_000).toISOString();
  const out = [];
  for (const n of view.notifications?.values() ?? []) {
    if (userId && n.owner_id && n.owner_id !== userId) continue;
    if (n.created_at < oldest) continue;
    const task = n.task_id ? view.tasks.get(n.task_id) : null;
    const project = view.projects.get(task ? task.project_id : n.project_id);
    if ((n.task_id && !task) || !project) continue;
    const comment = n.comment_id ? view.comments.get(n.comment_id) ?? null : null;
    if (n.comment_id && !comment) continue;
    out.push({
      id: n.id, kind: n.kind, read: Boolean(n.is_read), at: n.created_at,
      actor: (n.actor_id && userName(n.actor_id)) || t('common.someone'),
      title: task ? task.content : project.name, project: task ? project.name : null,
      excerpt: comment ? oneLine(comment.content, EXCERPT) : null,
      target: task ? { type: 'task', id: task.id } : { type: 'project', id: project.id },
      onProject: !task, comment,
    });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
}

/** Hoeveel meldingen nog niet gelezen zijn (alleen wat ook in de lijst staat). */
export const unreadCount = (items) => items.filter((x) => !x.read).length;

/** Het tijdstip van de nieuwste melding in de lijst, voor "alles gelezen" (zie notification_read_all `up_to`). */
export const newestAt = (items) => items.reduce((max, x) => (x.at > max ? x.at : max), '');

/** Wat er gebeurde, als zin: "Anna heeft je een taak toegewezen". */
export function inboxSentence(item) {
  const actor = item.actor;
  switch (item.kind) {
    case 'assigned': return t('inbox.assigned', { actor });
    case 'comment': return item.onProject ? t('inbox.commentProject', { actor }) : t('inbox.comment', { actor });
    case 'mention': return t('inbox.mention', { actor });
    case 'completed': return t('inbox.completed', { actor });
    case 'shared': return t('inbox.shared', { actor });
    default: return t('inbox.other', { actor }); // een soort van een nieuwere server
  }
}

const KIND_LABEL = {
  assigned: () => t('inbox.kind.assigned'), comment: () => t('inbox.kind.comment'), mention: () => t('inbox.kind.mention'),
  completed: () => t('inbox.kind.completed'), shared: () => t('inbox.kind.shared'),
};
/** De naam van een soort, voor de instellingen. */
export const kindLabel = (kind) => (Object.hasOwn(KIND_LABEL, kind) ? KIND_LABEL[kind]() : kind);
