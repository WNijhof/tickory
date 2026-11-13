// Het venster om één taak te bewerken.

import { parseDateText } from '../core/dateNl.js';
import { dateLanguageNote } from '../core/dateHint.js';
import { formatDateInput, formatDueLong } from '../core/format.js';
import { t } from '../core/i18n.js';
import { byOrder, membersOf, projectList } from '../core/selectors.js';
import { confirmDialog, h, replace } from './dom.js';

const priorityLabel = (p) => (p === 1 ? t('task.priorityHighest') : p === 4 ? t('task.priorityNone') : `P${p}`);
/** Inspringen van een subproject in de keuzelijst: twee harde spaties (gewone spaties vallen in een keuzelijst weg). */
const INDENT = String.fromCharCode(160, 160);

/**
 * @param {{ task: object, store: import('../core/store.js').Store, actions: object, today: () => string }} options
 * @returns {Promise<void>} klaar zodra het venster gesloten is
 */
export function openTaskDialog({ task, store, actions, today }) {
  return new Promise((resolve) => {
    const view = store.view;
    const parent = task.parent_id ? view.tasks.get(task.parent_id) : null;
    const initialDue = formatDateInput(task.due);
    const initialLabels = (task.labels ?? []).map((id) => view.labels.get(id)?.name).filter(Boolean).join(', ');

    const content = h('textarea', { class: 'field', rows: 2, required: true, maxLength: 4000, value: task.content, 'aria-label': t('task.contentLabel') });
    const description = h('textarea', { class: 'field', rows: 3, maxLength: 16000, value: task.description ?? '', placeholder: t('task.description') });
    const due = h('input', { class: 'field', type: 'text', value: initialDue, placeholder: t('task.duePlaceholder'), autocomplete: 'off' });
    const dueHint = h('p', { class: 'hint', 'aria-live': 'polite' });
    const deadline = h('input', { class: 'field', type: 'date', value: task.deadline ?? '' });
    const priority = h('select', { class: 'field' }, [1, 2, 3, 4].map((p) => h('option', { value: String(p), selected: p === task.priority }, priorityLabel(p))));
    const project = h('select', { class: 'field' },
      projectList(view).map(({ project: p, depth }) => h('option', { value: p.id, selected: p.id === task.project_id }, `${INDENT.repeat(depth)}${p.name}`)));
    const section = h('select', { class: 'field' });
    const labels = h('input', { class: 'field', type: 'text', value: initialLabels, placeholder: t('task.labelsPlaceholder'), autocomplete: 'off' });
    const assignee = h('select', { class: 'field', 'aria-label': t('task.assignedTo') });
    const subtask = h('input', { class: 'field', type: 'text', placeholder: t('task.addSubtask'), autocomplete: 'off', maxLength: 4000 });
    const error = h('p', { class: 'error', role: 'alert' });

    const fillSections = (selected) => {
      const list = [...view.sections.values()].filter((s) => s.project_id === project.value && !s.is_archived).sort(byOrder);
      replace(section, h('option', { value: '' }, t('task.noSection')), list.map((s) => h('option', { value: s.id, selected: s.id === selected }, s.name)));
      section.disabled = list.length === 0;
    };
    fillSections(task.section_id);

    // Toewijzen kan aan de leden van het project; in een project dat je met niemand deelt is er niets te kiezen.
    const memberName = (id) => {
      const name = store.userName(id) ?? t('common.unknownUser');
      return id === store.userId ? t('task.memberYou', { name }) : name;
    };
    const fillAssignees = (projectId, selected) => {
      const members = membersOf(view, projectId);
      replace(assignee, h('option', { value: '' }, t('task.nobody')), members.map((m) => h('option', { value: m.user_id, selected: m.user_id === selected }, memberName(m.user_id))));
      assigneeField.hidden = members.length < 2;
    };
    project.addEventListener('change', () => {
      fillSections(null);
      fillAssignees(project.value, assignee.value || null); // wie ook in het nieuwe project zit, blijft toegewezen
    });

    // Onder het datumveld: wat er nu staat of wat het wordt. In een andere taal dan de datumtaal staat er bij een leeg
    // veld en bij een niet herkende datum bij welke notaties wel werken (dateLanguageNote is in het Nederlands leeg).
    const showDueHint = () => {
      const text = due.value.trim();
      if (!text || text === initialDue) {
        dueHint.textContent = task.due && text ? t('task.dueNow', { date: formatDueLong(task.due, today()) }) : text ? '' : dateLanguageNote();
        dueHint.classList.remove('hint-bad');
        return;
      }
      const parsed = parseDateText(text, new Date());
      dueHint.textContent = parsed ? t('task.dueBecomes', { date: formatDueLong(parsed, today()) }) : [t('task.dueUnknown'), dateLanguageNote()].filter(Boolean).join(' ');
      dueHint.classList.toggle('hint-bad', !parsed);
    };
    due.addEventListener('input', showDueHint);
    showDueHint();

    const close = () => dialog.close();

    const save = async () => {
      error.textContent = '';
      const changes = {};
      const newContent = content.value.trim();
      if (!newContent) {
        error.textContent = t('task.nameRequired');
        return;
      }
      if (newContent !== task.content) changes.content = newContent;
      if (description.value !== (task.description ?? '')) changes.description = description.value;
      if (Number(priority.value) !== task.priority) changes.priority = Number(priority.value);
      if (deadline.value !== (task.deadline ?? '')) changes.deadline = deadline.value || null;
      const dueText = due.value.trim();
      if (dueText !== initialDue) {
        if (!dueText) {
          changes.due = null;
        } else {
          const parsed = parseDateText(dueText, new Date());
          if (!parsed) {
            error.textContent = t('task.dueError');
            due.focus();
            return;
          }
          changes.due = parsed;
        }
      }
      // Verhuist de taak naar een ander project, dan wijzen we pas na de verhuizing toe: de server controleert of de persoon
      // lid is van het project waar de taak dán in staat.
      const projectChanges = !parent && project.value !== task.project_id;
      const assigneeValue = assignee.value || null;
      const assigneeChanged = !assigneeField.hidden && assigneeValue !== (task.assignee_id ?? null);
      if (assigneeChanged && !projectChanges) changes.assignee_id = assigneeValue;
      if (Object.keys(changes).length > 0) await actions.updateTask(task.id, changes);
      if (!parent && (projectChanges || (section.value || null) !== (task.section_id ?? null))) {
        await actions.moveTask(task.id, { project_id: project.value, section_id: section.value || null });
      }
      if (assigneeChanged && projectChanges) await actions.assignTask(task.id, assigneeValue);
      if (labels.value.trim() !== initialLabels) {
        await actions.setTaskLabels(task.id, labels.value.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean));
      }
      close();
    };

    const addSubtask = async () => {
      const text = subtask.value.trim();
      if (!text) return;
      await actions.addTask({ content: text, project_id: task.project_id, parent_id: task.id });
      subtask.value = '';
      subtask.focus();
      added.textContent = t('task.subtaskAdded', { name: text });
    };
    const added = h('p', { class: 'hint', 'aria-live': 'polite' });
    subtask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSubtask();
      }
    });

    const remove = async () => {
      const ok = await confirmDialog({ title: t('task.deleteTitle'), text: t('task.deleteText', { name: task.content }) });
      if (!ok) return;
      await actions.deleteTask(task.id);
      close();
    };

    const field = (label, control, extra = null) => h('label', { class: 'field-label' }, label, control, extra);
    const assigneeField = field(t('task.assignedTo'), assignee);
    fillAssignees(task.project_id, task.assignee_id ?? null);
    const dialog = h('dialog', { class: 'dialog dialog-wide', id: 'task-dialog' },
      h('form', { class: 'dialog-form', onsubmit: (e) => { e.preventDefault(); save(); } },
        h('h2', {}, parent ? t('task.subtaskOf', { name: parent.content }) : t('task.edit')),
        content,
        description,
        h('div', { class: 'field-grid' },
          field(t('task.due'), due, dueHint),
          field(t('task.deadline'), deadline),
          field(t('task.priority'), priority),
          assigneeField,
          field(t('task.labels'), labels),
          !parent && field(t('task.project'), project),
          !parent && field(t('task.section'), section),
        ),
        h('div', { class: 'subtask-row' }, subtask, h('button', { type: 'button', class: 'button', onclick: addSubtask }, t('common.add'))),
        added,
        error,
        h('div', { class: 'dialog-buttons' },
          h('button', { type: 'button', class: 'button button-danger button-left', onclick: remove }, t('common.delete')),
          h('button', { type: 'button', class: 'button', onclick: close }, t('common.cancel')),
          h('button', { type: 'submit', class: 'button button-primary' }, t('common.save')),
        ),
      ));
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
