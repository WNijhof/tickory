// Het venster om één taak te bekijken en te bewerken: links de titel, beschrijving, subtaken en opmerkingen, rechts de
// eigenschappen (project, datum, prioriteit, labels, toegewezen aan, deadline, herinneringen). Subtaken, opmerkingen en
// herinneringen gaan direct door; de rest wordt pas bewaard met "Opslaan" (Ctrl+Enter of Cmd+Enter), "Annuleren" verwerpt.

import { parseDateText } from '../core/dateNl.js';
import { dateLanguageNote } from '../core/dateHint.js';
import { dayOf } from '../core/timeAgo.js';
import { DURATION_CHOICES, formatDuration } from '../core/duration.js';
import { formatDateInput, formatDueLong } from '../core/format.js';
import { t } from '../core/i18n.js';
import { colorClass } from '../core/colors.js';
import { quickDates } from '../core/quickDates.js';
import { byOrder, membersOf, projectList, subtasksOf } from '../core/selectors.js';
import { nameKey } from '../../shared/text.js';
import { commentsSection } from './comments.js';
import { confirmDialog, h, replace } from './dom.js';
import { icon } from './icons.js';
import { reminderSection } from './reminderUi.js';

const priorityLabel = (p) => (p === 1 ? t('task.priorityHighest') : p === 4 ? t('task.priorityNone') : `P${p}`);
/** Inspringen van een subproject in de keuzelijst: twee harde spaties (gewone spaties vallen in een keuzelijst weg). */
const INDENT = String.fromCharCode(160, 160);

/**
 * @param {{
 *   task: object, store: import('../core/store.js').Store, actions: object, today: () => string,
 *   toggle?: (task: object) => Promise<void>,   // afvinken zoals in de lijst (met melding); zonder: de acties zelf
 * }} options
 * @returns {Promise<void>} klaar zodra het venster gesloten is
 */
export function openTaskDialog({ task, store, actions, today, toggle = null }) {
  return new Promise((resolve) => {
    const view = store.view;
    const current = () => store.view.tasks.get(task.id) ?? task;
    const parent = task.parent_id ? view.tasks.get(task.parent_id) : null;
    const initialDue = formatDateInput(task.due);
    const initialLabelNames = (task.labels ?? []).map((id) => view.labels.get(id)?.name).filter(Boolean);
    let labelNames = [...initialLabelNames];

    // ---- titel, beschrijving ----
    const content = h('textarea', { class: 'field task-title-input', rows: 1, required: true, maxLength: 4000, value: task.content, 'aria-label': t('task.contentLabel'), autofocus: globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true });
    const grow = (el) => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
    const description = h('textarea', { class: 'field task-description', rows: 3, maxLength: 16000, value: task.description ?? '', placeholder: t('task.description'), 'aria-label': t('task.descriptionLabel') });
    const check = h('button', { class: `check check-large prio-${task.priority}`, type: 'button', onclick: () => completeFromDialog() });
    const drawCheck = () => {
      const done = Boolean(current().checked);
      check.setAttribute('aria-pressed', String(done));
      check.setAttribute('aria-label', done ? t('task.reopenLabel', { name: task.content }) : t('task.completeLabel', { name: task.content }));
      check.classList.toggle('task-done', done);
    };

    // ---- datum ----
    const due = h('input', { class: 'field', type: 'text', value: initialDue, placeholder: t('task.duePlaceholder'), autocomplete: 'off' });
    const dueHint = h('p', { class: 'hint', 'aria-live': 'polite' });
    const deadline = h('input', { class: 'field', type: 'date', value: task.deadline ?? '' });
    // duur: een keuze uit de gewone lengtes, plus de huidige als die er niet bij hoort (bijvoorbeeld =1u20 in snel toevoegen)
    const durationChoices = [...new Set([...DURATION_CHOICES, ...(task.duration ? [task.duration] : [])])].sort((a, b) => a - b);
    const duration = h('select', { class: 'field', 'aria-label': t('task.duration') },
      h('option', { value: '' }, t('task.durationNone')),
      durationChoices.map((m) => h('option', { value: String(m), selected: m === task.duration }, formatDuration(m))));
    const quick = (label, date) => h('button', {
      class: 'chip-button', type: 'button',
      onclick: () => {
        const time = task.due?.date.length > 10 ? task.due.date.slice(10) : '';
        due.value = date ? formatDateInput({ date: `${date}${time}` }) : '';
        due.dispatchEvent(new Event('input', { bubbles: true }));
      },
    }, label);
    const dates = quickDates(today());
    const quickRow = h('div', { class: 'quick-dates', role: 'group', 'aria-label': t('task.quickDates') },
      quick(t('task.quickToday'), dates.today), quick(t('task.quickTomorrow'), dates.tomorrow), quick(t('task.quickWeekend'), dates.weekend),
      quick(t('task.quickNextWeek'), dates.nextWeek), quick(t('task.quickNone'), null));

    // ---- prioriteit ----
    let priorityValue = task.priority;
    const priorityGroup = h('div', { class: 'prio-group', role: 'radiogroup', 'aria-label': t('task.priority') },
      [1, 2, 3, 4].map((p) => h('label', { class: `prio-option prio-${p}`, title: priorityLabel(p) },
        h('input', {
          type: 'radio', name: 'priority', value: String(p), checked: p === task.priority,
          onchange: () => { priorityValue = p; check.className = `check check-large prio-${p}${check.classList.contains('task-done') ? ' task-done' : ''}`; },
        }),
        h('span', {}, icon('check'), `P${p}`))));

    // ---- project, sectie, toegewezen aan ----
    const project = h('select', { class: 'field' },
      projectList(view).map(({ project: p, depth }) => h('option', { value: p.id, selected: p.id === task.project_id }, `${INDENT.repeat(depth)}${p.name}`)));
    const section = h('select', { class: 'field' });
    const assignee = h('select', { class: 'field', 'aria-label': t('task.assignedTo') });
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

    // ---- labels als chips ----
    const labelBox = h('div', { class: 'label-chips' });
    const labelInput = h('input', { class: 'label-input', type: 'text', list: 'task-dialog-labels', placeholder: t('task.labelsPlaceholder'), autocomplete: 'off', 'aria-label': t('task.labels'), maxLength: 100 });
    const labelOptions = h('datalist', { id: 'task-dialog-labels' }, [...view.labels.values()].filter((l) => !l.owner_id || l.owner_id === store.userId).map((l) => h('option', { value: l.name })));
    const drawLabels = () => replace(labelBox,
      labelNames.map((name) => h('span', { class: `chip chip-label chip-removable ${colorClass([...view.labels.values()].find((l) => nameKey(l.name) === nameKey(name))?.color)}` },
        `@${name}`,
        h('button', { class: 'chip-x', type: 'button', 'aria-label': t('task.removeLabel', { name }), onclick: () => { labelNames = labelNames.filter((x) => x !== name); drawLabels(); labelInput.focus(); } }, icon('close')))),
      labelInput);
    const addLabels = () => {
      for (const raw of labelInput.value.split(',')) {
        const name = raw.trim().replace(/^@/, '').trim();
        if (name && !labelNames.some((x) => nameKey(x) === nameKey(name))) labelNames.push(name);
      }
      labelInput.value = '';
      drawLabels();
    };
    labelInput.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) || e.key === ',') {
        e.preventDefault();
        e.stopPropagation();
        if (labelInput.value.trim()) {
          addLabels();
          labelInput.focus();
        }
      } else if (e.key === 'Backspace' && !labelInput.value && labelNames.length > 0) {
        labelNames.pop();
        drawLabels();
        labelInput.focus();
      }
    });
    labelInput.addEventListener('change', () => { if (labelInput.value.trim()) addLabels(); });
    drawLabels();

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

    const error = h('p', { class: 'error', role: 'alert' });
    const close = () => dialog.close();

    /** Bewaart de wijzigingen. Geeft true terug als het gelukt is (en het venster dicht is). */
    const save = async () => {
      error.textContent = '';
      const changes = {};
      const newContent = content.value.trim();
      if (!newContent) {
        error.textContent = t('task.nameRequired');
        content.focus();
        return false;
      }
      if (newContent !== task.content) changes.content = newContent;
      if (description.value !== (task.description ?? '')) changes.description = description.value;
      if (priorityValue !== task.priority) changes.priority = priorityValue;
      if (deadline.value !== (task.deadline ?? '')) changes.deadline = deadline.value || null;
      if (duration.value !== (task.duration ? String(task.duration) : '')) changes.duration = duration.value ? Number(duration.value) : null;
      const dueText = due.value.trim();
      if (dueText !== initialDue) {
        if (!dueText) {
          changes.due = null;
        } else {
          const parsed = parseDateText(dueText, new Date());
          if (!parsed) {
            error.textContent = t('task.dueError');
            due.focus();
            return false;
          }
          changes.due = parsed;
        }
      }
      // Een label dat nog in het invoerveld staat, telt mee.
      if (labelInput.value.trim()) addLabels();
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
      if (JSON.stringify(labelNames) !== JSON.stringify(initialLabelNames)) await actions.setTaskLabels(task.id, labelNames);
      close();
      return true;
    };

    async function completeFromDialog() {
      const wasDone = Boolean(current().checked);
      if (!wasDone && !(await save())) return; // eerst bewaren wat je hebt gewijzigd; het venster sluit daarbij
      const now = current();
      if (toggle) await toggle(now);
      else if (wasDone) await actions.uncompleteTask(task.id);
      else await actions.completeTask(task.id);
    }

    // ---- subtaken ----
    const subtaskList = h('ul', { class: 'subtask-list' });
    const subtaskTitle = h('h3', { class: 'subheading' });
    const subtask = h('input', { class: 'field', type: 'text', placeholder: t('task.addSubtask'), autocomplete: 'off', maxLength: 4000, 'aria-label': t('task.addSubtask') });
    const added = h('p', { class: 'sr-only', 'aria-live': 'polite' });
    let drawnSubtasks = null;
    const drawSubtasks = () => {
      const subs = subtasksOf(store.view, task.id);
      const signature = JSON.stringify(subs.map((s) => [s.id, s.content, s.checked]));
      if (signature === drawnSubtasks) return;
      drawnSubtasks = signature;
      const done = subs.filter((s) => s.checked).length;
      subtaskTitle.textContent = subs.length > 0 ? t('task.subtasksHeadingCount', { done, total: subs.length }) : t('task.subtasksHeading');
      replace(subtaskList, subs.map((s) => {
        const title = h('input', { class: 'subtask-title', type: 'text', value: s.content, maxLength: 4000, 'aria-label': t('task.subtaskTitleLabel'), autocomplete: 'off' });
        const saveTitle = async () => {
          const text = title.value.trim();
          if (!text) title.value = s.content;
          else if (text !== s.content) await actions.updateTask(s.id, { content: text });
        };
        title.addEventListener('blur', saveTitle);
        title.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            title.blur();
          } else if (e.key === 'Escape' && title.value !== s.content) {
            e.preventDefault();
            e.stopPropagation();
            title.value = s.content;
          }
        });
        return h('li', { class: `subtask prio-${s.priority}${s.checked ? ' task-done' : ''}` },
          h('button', {
            class: 'check', type: 'button', 'aria-pressed': String(Boolean(s.checked)),
            'aria-label': s.checked ? t('task.reopenLabel', { name: s.content }) : t('task.completeLabel', { name: s.content }),
            onclick: () => (s.checked ? actions.uncompleteTask(s.id) : actions.completeTask(s.id)),
          }),
          title,
          h('button', { class: 'icon-button', type: 'button', 'aria-label': t('task.subtaskDelete', { name: s.content }), title: t('common.delete'), onclick: () => actions.deleteTask(s.id) }, icon('trash')));
      }));
    };
    const addSubtask = async () => {
      const text = subtask.value.trim();
      if (!text) return;
      await actions.addTask({ content: text, project_id: task.project_id, parent_id: task.id });
      subtask.value = '';
      subtask.focus();
      added.textContent = t('task.subtaskAdded', { name: text });
    };
    subtask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) {
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

    const field = (label, control, extra = null) => h('label', { class: 'field-label prop', dataset: { prop: label } }, h('span', { class: 'prop-label' }, label), control, extra);
    const assigneeField = field(t('task.assignedTo'), assignee);
    fillAssignees(task.project_id, task.assignee_id ?? null);
    const reminders = reminderSection({ task, store, actions, today });
    const comments = commentsSection({ target: { taskId: task.id }, store, actions });

    // wie maakte de taak en wanneer
    const creator = task.creator_id ? (task.creator_id === store.userId ? store.me?.name : store.userName(task.creator_id)) ?? t('common.unknownUser') : null;
    const created = task.created_at ? dayOf(task.created_at) : '';
    const createdLine = created && (creator ? t('task.createdBy', { name: creator, date: created }) : t('task.createdOn', { date: created }));

    const startProject = view.projects.get(task.project_id);
    const heading = h('h2', { id: 'task-dialog-heading' }, parent ? t('task.subtaskOf', { name: parent.content }) : t('task.edit'));
    const dialog = h('dialog', { class: 'dialog dialog-wide dialog-task', id: 'task-dialog', 'aria-labelledby': 'task-dialog-heading' },
      h('form', { class: 'task-form', onsubmit: (e) => { e.preventDefault(); save(); } },
        h('header', { class: 'task-top' },
          h('div', { class: 'task-crumb' },
            startProject && h('span', { class: `dot ${colorClass(startProject.color)}`, 'aria-hidden': 'true' }),
            heading),
          h('button', { class: 'icon-button', type: 'button', 'aria-label': t('common.close'), title: t('common.close'), onclick: close }, icon('close'))),
        h('div', { class: 'task-columns' },
          h('div', { class: 'task-col task-col-main' },
            h('div', { class: 'task-title-row' }, check, content),
            description),
          h('aside', { class: 'task-col task-col-side', 'aria-label': t('task.properties') },
            !parent && field(t('task.project'), project),
            !parent && field(t('task.section'), section),
            field(t('task.due'), due, dueHint),
            quickRow,
            h('div', { class: 'prop' }, h('span', { class: 'prop-label' }, t('task.priority')), priorityGroup),
            h('div', { class: 'prop' }, h('span', { class: 'prop-label' }, t('task.labels')), h('div', { class: 'label-field' }, labelBox, labelOptions)),
            assigneeField,
            field(t('task.duration'), duration),
            field(t('task.deadline'), deadline),
            reminders.node,
            createdLine && h('p', { class: 'task-created' }, createdLine)),
          h('div', { class: 'task-col task-col-extra' },
            h('section', { class: 'subtasks', 'aria-label': t('task.subtasksHeading') },
              subtaskTitle,
              subtaskList,
              h('div', { class: 'subtask-row' }, subtask, h('button', { type: 'button', class: 'button', onclick: addSubtask }, t('common.add'))),
              added),
            comments.node)),
        error,
        h('div', { class: 'dialog-buttons' },
          h('button', { type: 'button', class: 'button button-danger button-left', onclick: remove }, t('common.delete')),
          h('span', { class: 'save-tip' }, t('task.saveTip')),
          h('button', { type: 'button', class: 'button', onclick: close }, t('common.cancel')),
          h('button', { type: 'submit', class: 'button button-primary' }, t('common.save')),
        ),
      ));
    // Ctrl+Enter of Cmd+Enter bewaart de taak (in het opmerkingenveld plaatst het de opmerking; zie comments.js)
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.defaultPrevented) {
        e.preventDefault();
        save();
      }
    });
    content.addEventListener('input', () => grow(content));
    // Enter in de titel bewaart niet en voegt geen regel toe (een titel is één regel)
    content.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) e.preventDefault();
    });
    const unsubscribe = store.subscribe(() => {
      drawCheck();
      drawSubtasks();
    });
    dialog.addEventListener('close', () => {
      unsubscribe();
      reminders.dispose();
      comments.dispose();
      dialog.remove();
      resolve();
    });
    drawCheck();
    drawSubtasks();
    document.body.append(dialog);
    dialog.showModal();
    grow(content);
    // de titel staat in een tekstvak dat met de inhoud meegroeit; de cursor aan het eind
    content.setSelectionRange(content.value.length, content.value.length);
  });
}
