// Het venster om één taak te bewerken.

import { parseDateText } from '../core/dateNl.js';
import { formatDateInput, formatDueLong } from '../core/format.js';
import { byOrder, projectList } from '../core/selectors.js';
import { confirmDialog, h, replace } from './dom.js';

const PRIORITY_LABELS = { 1: 'P1 – hoogste', 2: 'P2', 3: 'P3', 4: 'P4 – geen' };

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

    const content = h('textarea', { class: 'field', rows: 2, required: true, maxLength: 4000, value: task.content, 'aria-label': 'Taak' });
    const description = h('textarea', { class: 'field', rows: 3, maxLength: 16000, value: task.description ?? '', placeholder: 'Beschrijving' });
    const due = h('input', { class: 'field', type: 'text', value: initialDue, placeholder: 'bv. morgen om 9 uur, elke maandag', autocomplete: 'off' });
    const dueHint = h('p', { class: 'hint', 'aria-live': 'polite' });
    const deadline = h('input', { class: 'field', type: 'date', value: task.deadline ?? '' });
    const priority = h('select', { class: 'field' }, [1, 2, 3, 4].map((p) => h('option', { value: String(p), selected: p === task.priority }, PRIORITY_LABELS[p])));
    const project = h('select', { class: 'field' },
      projectList(view).map(({ project: p, depth }) => h('option', { value: p.id, selected: p.id === task.project_id }, `${'  '.repeat(depth)}${p.name}`)));
    const section = h('select', { class: 'field' });
    const labels = h('input', { class: 'field', type: 'text', value: initialLabels, placeholder: 'bv. bellen, thuis', autocomplete: 'off' });
    const subtask = h('input', { class: 'field', type: 'text', placeholder: 'Subtaak toevoegen', autocomplete: 'off', maxLength: 4000 });
    const error = h('p', { class: 'error', role: 'alert' });

    const fillSections = (selected) => {
      const list = [...view.sections.values()].filter((s) => s.project_id === project.value && !s.is_archived).sort(byOrder);
      replace(section, h('option', { value: '' }, '(geen sectie)'), list.map((s) => h('option', { value: s.id, selected: s.id === selected }, s.name)));
      section.disabled = list.length === 0;
    };
    fillSections(task.section_id);
    project.addEventListener('change', () => fillSections(null));

    const showDueHint = () => {
      const text = due.value.trim();
      if (!text || text === initialDue) {
        dueHint.textContent = task.due && text ? `Nu: ${formatDueLong(task.due, today())}` : '';
        dueHint.classList.remove('hint-bad');
        return;
      }
      const parsed = parseDateText(text, new Date());
      dueHint.textContent = parsed ? `Wordt: ${formatDueLong(parsed, today())}` : 'Deze datum herken ik niet.';
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
        error.textContent = 'Geef de taak een naam.';
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
            error.textContent = 'De datum is niet herkend. Probeer bijvoorbeeld "morgen", "vrijdag om 14:00" of "31-12".';
            due.focus();
            return;
          }
          changes.due = parsed;
        }
      }
      if (Object.keys(changes).length > 0) await actions.updateTask(task.id, changes);
      if (!parent && (project.value !== task.project_id || (section.value || null) !== (task.section_id ?? null))) {
        await actions.moveTask(task.id, { project_id: project.value, section_id: section.value || null });
      }
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
      added.textContent = `Subtaak toegevoegd: ${text}`;
    };
    const added = h('p', { class: 'hint', 'aria-live': 'polite' });
    subtask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSubtask();
      }
    });

    const remove = async () => {
      const ok = await confirmDialog({ title: 'Taak verwijderen?', text: `"${task.content}" en eventuele subtaken worden verwijderd.` });
      if (!ok) return;
      await actions.deleteTask(task.id);
      close();
    };

    const field = (label, control, extra = null) => h('label', { class: 'field-label' }, label, control, extra);
    const dialog = h('dialog', { class: 'dialog dialog-wide', id: 'task-dialog' },
      h('form', { class: 'dialog-form', onsubmit: (e) => { e.preventDefault(); save(); } },
        h('h2', {}, parent ? `Subtaak van: ${parent.content}` : 'Taak bewerken'),
        content,
        description,
        h('div', { class: 'field-grid' },
          field('Datum', due, dueHint),
          field('Deadline', deadline),
          field('Prioriteit', priority),
          field('Labels', labels),
          !parent && field('Project', project),
          !parent && field('Sectie', section),
        ),
        h('div', { class: 'subtask-row' }, subtask, h('button', { type: 'button', class: 'button', onclick: addSubtask }, 'Toevoegen')),
        added,
        error,
        h('div', { class: 'dialog-buttons' },
          h('button', { type: 'button', class: 'button button-danger button-left', onclick: remove }, 'Verwijderen'),
          h('button', { type: 'button', class: 'button', onclick: close }, 'Annuleren'),
          h('button', { type: 'submit', class: 'button button-primary' }, 'Opslaan'),
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
