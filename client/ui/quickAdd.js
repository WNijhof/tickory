// Snel toevoegen: de voorvertoning onder het invoerveld (voor de balk bovenaan en voor het venster "Taak toevoegen"),
// en dat venster zelf.

import { dateLanguageNote, mentionsEnglishDate } from '../core/dateHint.js';
import { formatDate, formatDue, todayString } from '../core/format.js';
import { t } from '../core/i18n.js';
import { offsetText } from '../core/reminderText.js';
import { parseQuickAdd } from '../core/quickadd.js';
import { projectList } from '../core/selectors.js';
import { h, openDialog, replace, toast } from './dom.js';

const INDENT = String.fromCharCode(160, 160);

/**
 * Wat een regel tekst wordt: de taak met datum, project, labels en prioriteit, als chips. Geeft de chips terug (leeg bij lege tekst).
 * @param {string} text
 * @param {{ view: object, context: { defaultProjectId: string, defaultSectionId?: string | null, defaultDue?: object | null } }} options
 */
export function previewChips(text, { view, context }) {
  if (!text.trim() || !context.defaultProjectId) return [];
  const p = parseQuickAdd(text, { view, now: new Date(), ...context });
  const today = todayString();
  const chip = (kind, label) => h('span', { class: `chip chip-${kind}` }, label);
  // Typt iemand een Engelse datum ("tomorrow") die niet is herkend, dan zeggen we erbij dat datums in gewone taal nu alleen
  // in het Nederlands werken. In het Nederlands is die uitleg leeg en verandert er niets.
  const dateNote = (!p.due || p.due === context.defaultDue) && mentionsEnglishDate(p.content) ? dateLanguageNote() : '';
  return [
    chip('title', p.content || t('quick.noName')),
    p.due && p.due !== context.defaultDue && chip('due', formatDue(p.due, today)),
    p.deadline && chip('deadline', t('task.deadlineChip', { date: formatDate(p.deadline, today) })),
    p.project_id !== context.defaultProjectId && chip('project', `#${view.projects.get(p.project_id)?.name ?? ''}`),
    p.section_id && p.section_id !== context.defaultSectionId && chip('project', `/${view.sections.get(p.section_id)?.name ?? ''}`),
    p.labels.map((id) => chip('label', `@${view.labels.get(id)?.name ?? ''}`)),
    p.newLabels.map((name) => chip('label', t('quick.newLabel', { name }))),
    p.priority < 4 && chip(`prio prio-${p.priority}`, `P${p.priority}`),
    p.reminders.map((r) => chip('bell', `🔔 ${r.type === 'absolute' ? formatDue({ date: r.due.date }, today) : offsetText(r.minute_offset)}`)),
    dateNote && h('p', { class: 'hint preview-note' }, dateNote),
  ].flat().filter(Boolean);
}

/**
 * Het venster "Taak toevoegen": dezelfde invoer als de balk bovenaan, groter, met beschrijving en een keuze voor het project.
 * @param {{ store: import('../core/store.js').Store, actions: object, context: { projectId?: string | null, sectionId?: string | null, due?: 'today' | null } }} options
 * @returns {Promise<string | null>} het id van de nieuwe taak, of null bij annuleren
 */
export function openQuickAddDialog({ store, actions, context = {} }) {
  const view = store.view;
  const inbox = store.me?.inbox_project_id ?? null;
  const startProject = context.projectId && view.projects.has(context.projectId) ? context.projectId : inbox;
  return openDialog((finish) => {
    const input = h('input', {
      class: 'field quick-big', type: 'text', maxLength: 4000, placeholder: t('quick.placeholder'), 'aria-label': t('quick.label'), autocomplete: 'off', enterkeyhint: 'done', autofocus: true,
    });
    const description = h('textarea', { class: 'field', rows: 2, maxLength: 16000, placeholder: t('task.description'), 'aria-label': t('task.descriptionLabel') });
    const project = h('select', { class: 'field', 'aria-label': t('task.project') },
      projectList(view).map(({ project: p, depth }) => h('option', { value: p.id, selected: p.id === startProject }, `${INDENT.repeat(depth)}${p.name}`)));
    const preview = h('div', { class: 'chips preview', 'aria-live': 'polite' });
    const sectionFor = () => (project.value === startProject && context.sectionId ? context.sectionId : null);
    const dueFor = () => (context.due === 'today' ? { date: todayString(), string: 'vandaag', lang: 'nl' } : null);
    const parseContext = () => ({ defaultProjectId: project.value, defaultSectionId: sectionFor(), defaultDue: dueFor() });
    const draw = () => replace(preview, previewChips(input.value, { view, context: parseContext() }));
    input.addEventListener('input', draw);
    project.addEventListener('change', draw);
    return h('form', {
      class: 'dialog-form quick-form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!project.value) {
          toast(t('quick.signInFirst'));
          return;
        }
        const p = parseQuickAdd(input.value, { view, now: new Date(), ...parseContext() });
        if (!p.content) {
          toast(t('task.nameRequired'));
          input.focus();
          return;
        }
        const text = description.value.trim();
        finish(await actions.addTask({ ...p, ...(text ? { description: text } : {}) }));
      },
    },
    h('h2', {}, t('quick.addTask')),
    input,
    description,
    preview,
    h('div', { class: 'quick-options' }, h('label', { class: 'field-label' }, t('task.project'), project)),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary' }, t('common.add'))));
  }, { wide: true, className: 'dialog-quick' });
}
