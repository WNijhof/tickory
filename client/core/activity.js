// Het scherm "Activiteit" van een project, zonder scherm: de geladen pagina's van het logboek (per project en filter), en wat één
// regel zegt. De gegevens komen van de server (`GET /api/v1/projects/<id>/activity`, zie server/activity.ts en SPEC.md, 5f); de demo
// heeft een eigen lijst in het geheugen. Het logboek gaat niet mee in de sync: wat geladen is, blijft in het geheugen van deze
// pagina staan (ook zonder verbinding), en verdwijnt zodra je het project niet meer ziet.

import { ACTIVITY_GROUPS, ACTIVITY_PAGE } from '../../shared/activity.js';
import { t } from './i18n.js';
import { todayString } from './format.js';

/** De filterkeuzes, in de volgorde van het scherm: alles, en dan per groep. */
export const ACTIVITY_FILTERS = ['all', ...Object.keys(ACTIVITY_GROUPS)];

/** De soorten bij een filter, of null (alles). */
export const kindsFor = (filter) => (filter !== 'all' && Object.hasOwn(ACTIVITY_GROUPS, filter) ? ACTIVITY_GROUPS[filter] : null);

/**
 * De geladen pagina's van het logboek. `fetchPage(projectId, { before, limit, kinds })` geeft `{ entries, next }` (de nieuwste
 * eerst) of gooit een fout met `code` ('OFFLINE', 'NOT_FOUND', …).
 * @param {{ fetchPage: (projectId: string, q: object) => Promise<{ entries: object[], next: string | null }>, onChange?: () => void, pageSize?: number }} options
 */
export function createActivityFeed({ fetchPage, onChange = () => {}, pageSize = ACTIVITY_PAGE }) {
  /** `${projectId}|${filter}` -> { entries, next, loaded, loading, error } */
  const lists = new Map();
  const key = (projectId, filter) => `${projectId}|${filter}`;
  const fresh = () => ({ entries: [], next: null, loaded: false, loading: false, error: null });

  function get(projectId, filter = 'all') {
    const k = key(projectId, filter);
    if (!lists.has(k)) lists.set(k, fresh());
    return lists.get(k);
  }

  /** Een fout onthouden: zonder verbinding blijft wat er al was; is het project weg (NOT_FOUND), dan ook alles wat geladen was. */
  function failed(projectId, list, err) {
    const code = err?.code ?? 'UNKNOWN';
    if (code === 'NOT_FOUND') {
      forget(projectId);
      const again = get(projectId);
      again.error = 'NOT_FOUND';
      return;
    }
    list.error = code === 'OFFLINE' ? 'OFFLINE' : 'FAILED';
  }

  async function fetchInto(projectId, filter, before) {
    const list = get(projectId, filter);
    if (list.loading) return list;
    list.loading = true;
    onChange();
    try {
      const page = await fetchPage(projectId, { before, limit: pageSize, kinds: kindsFor(filter) });
      const known = new Set(list.entries.map((e) => e.id));
      if (before === null) {
        // de nieuwste pagina: wat nieuw is komt bovenaan; sluit ze niet aan op wat er al was (meer dan een pagina nieuw), dan opnieuw beginnen
        const fresher = page.entries.filter((e) => !known.has(e.id));
        const overlaps = list.loaded && fresher.length < page.entries.length;
        if (overlaps) list.entries = [...fresher, ...list.entries];
        else {
          list.entries = page.entries;
          list.next = page.next;
        }
      } else {
        list.entries = [...list.entries, ...page.entries.filter((e) => !known.has(e.id))];
        list.next = page.next;
      }
      list.loaded = true;
      list.error = null;
    } catch (err) {
      failed(projectId, list, err);
    } finally {
      list.loading = false;
      onChange();
    }
    return get(projectId, filter);
  }

  /** De nieuwste pagina laden, of bijwerken wat er al staat. */
  const refresh = (projectId, filter = 'all') => fetchInto(projectId, filter, null);
  /** De volgende (oudere) pagina. */
  const more = (projectId, filter = 'all') => {
    const list = get(projectId, filter);
    return list.next ? fetchInto(projectId, filter, list.next) : Promise.resolve(list);
  };
  /** Vergeet alles van een project (je ziet het niet meer, of je bent afgemeld). */
  function forget(projectId) {
    for (const k of [...lists.keys()]) if (k.startsWith(`${projectId}|`)) lists.delete(k);
  }
  const clear = () => lists.clear();

  return { get, refresh, more, forget, clear, projects: () => [...new Set([...lists.keys()].map((k) => k.split('|')[0]))] };
}

// ---------- wat een regel zegt ----------

const FIELD = {
  content: () => t('activity.field.content'), description: () => t('activity.field.description'), priority: () => t('activity.field.priority'),
  labels: () => t('activity.field.labels'), due: () => t('activity.field.due'), deadline: () => t('activity.field.deadline'),
  duration: () => t('activity.field.duration'), assignee_id: () => t('activity.field.assignee'),
};
const ROLE = { owner: () => t('role.owner'), member: () => t('role.member'), viewer: () => t('role.viewer') };
const roleName = (role) => (Object.hasOwn(ROLE, role ?? '') ? ROLE[role]() : t('role.member'));

/** "titel, datum en prioriteit" in de taal van de interface. */
function listOf(parts) {
  if (parts.length <= 1) return parts[0] ?? '';
  return t('common.listAnd', { first: parts.slice(0, -1).join(', '), last: parts[parts.length - 1] });
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Wat één regel van het logboek zegt, als gewone gegevens.
 * @param {object} entry een regel van de server
 * @param {{ view: object, projectId: string, userName: (id: string) => string | null }} ctx
 * @returns {{ id: string, actor: string, sentence: string, title: string | null, taskId: string | null, gone: boolean, day: string, time: string, at: string }}
 */
export function describeEntry(entry, { view, projectId, userName }) {
  const name = (id) => (id ? userName(id) ?? t('activity.formerMember') : t('common.someone'));
  const actor = name(entry.actor_id);
  const x = entry.extra ?? {};
  const projectName = (id) => (id === projectId ? null : view.projects.get(id)?.name ?? t('activity.otherProject'));
  const sectionName = (id) => (id ? view.sections.get(id)?.name ?? t('activity.goneSection') : t('activity.noSection'));
  let sentence;
  switch (entry.kind) {
    case 'task_added': sentence = t('activity.taskAdded', { actor }); break;
    case 'task_updated': {
      const fields = (Array.isArray(x.fields) ? x.fields : []).filter((f) => Object.hasOwn(FIELD, f));
      const parts = fields.filter((f) => f !== 'assignee_id').map((f) => FIELD[f]());
      if (fields.includes('assignee_id')) parts.push(x.assignee_id ? t('activity.assignedTo', { name: name(x.assignee_id) }) : t('activity.unassigned'));
      sentence = parts.length > 0 ? t('activity.taskUpdated', { actor, fields: listOf(parts) }) : t('activity.taskUpdatedPlain', { actor });
      break;
    }
    case 'task_completed': sentence = x.recurring ? t('activity.taskCompletedRecurring', { actor }) : t('activity.taskCompleted', { actor }); break;
    case 'task_uncompleted': sentence = t('activity.taskUncompleted', { actor }); break;
    case 'task_moved':
      if (x.from_project || x.to_project) {
        sentence = x.to_project === projectId
          ? t('activity.taskMovedHere', { actor, project: projectName(x.from_project) ?? t('activity.otherProject') })
          : t('activity.taskMovedAway', { actor, project: projectName(x.to_project) ?? t('activity.otherProject') });
      } else sentence = t('activity.taskMovedSection', { actor, section: sectionName(x.to_section ?? null) });
      break;
    case 'task_deleted': sentence = t('activity.taskDeleted', { actor }); break;
    case 'task_restored': sentence = t('activity.taskRestored', { actor }); break;
    case 'section_added': sentence = t('activity.sectionAdded', { actor }); break;
    case 'section_renamed': sentence = t('activity.sectionRenamed', { actor, from: String(x.from ?? '') }); break;
    case 'section_deleted': sentence = t('activity.sectionDeleted', { actor }); break;
    case 'section_restored': sentence = t('activity.sectionRestored', { actor }); break;
    case 'comment_added': sentence = entry.task_id ? t('activity.commentAdded', { actor }) : t('activity.commentAddedProject', { actor }); break;
    case 'comment_deleted': sentence = t('activity.commentDeleted', { actor }); break;
    case 'attachment_added': sentence = t('activity.attachmentAdded', { actor }); break;
    case 'attachment_deleted': sentence = t('activity.attachmentDeleted', { actor }); break;
    case 'member_added': sentence = t('activity.memberAdded', { actor, name: name(entry.user_id), role: roleName(x.role) }); break;
    case 'member_role': sentence = t('activity.memberRole', { actor, name: name(entry.user_id), role: roleName(x.role) }); break;
    case 'member_removed': sentence = t('activity.memberRemoved', { actor, name: name(entry.user_id) }); break;
    case 'member_left': sentence = t('activity.memberLeft', { actor }); break;
    case 'project_created': sentence = t('activity.projectCreated', { actor }); break;
    case 'project_renamed': sentence = t('activity.projectRenamed', { actor, from: String(x.from ?? '') }); break;
    case 'project_archived': sentence = t('activity.projectArchived', { actor }); break;
    case 'project_unarchived': sentence = t('activity.projectUnarchived', { actor }); break;
    default: sentence = t('activity.other', { actor });
  }
  const task = entry.task_id ? view.tasks.get(entry.task_id) : null;
  const taskHere = Boolean(task && task.project_id === projectId);
  const at = new Date(entry.at);
  const valid = !Number.isNaN(at.getTime());
  const isTaskEntry = Boolean(entry.task_id) && !entry.kind.startsWith('member_');
  return {
    id: entry.id, at: entry.at, actor, sentence,
    // de titel op het moment van de handeling; bij een opmerking of bijlage die van de taak of het bestand
    title: entry.title ?? null,
    taskId: isTaskEntry && taskHere ? entry.task_id : null,
    gone: isTaskEntry && !taskHere,
    day: valid ? todayString(at) : '',
    time: valid ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : '',
  };
}

/** De regels per dag (in de tijdzone van dit apparaat), de nieuwste dag eerst, de volgorde binnen een dag zoals ze kwamen. */
export function groupByDay(items) {
  const out = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && last.day === item.day) last.items.push(item);
    else out.push({ day: item.day, items: [item] });
  }
  return out;
}
