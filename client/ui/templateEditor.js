// Een eigen sjabloon bewerken in de app: naam, beschrijving en de secties en taken als regels (core/templateRows.js). Per taak de
// tekst, in- en uitspringen, omhoog en omlaag, en onder "Meer" de dag (ten opzichte van de startdatum), het tijdstip, de prioriteit,
// de deadline (ook als dag) en een herinnering vooraf. Labels, beschrijving, duur en herhaling blijven zoals ze waren. Bewaren
// controleert alles met dezelfde regels als de server (shared/template.js) en stuurt één template_update.

import { t } from '../core/i18n.js';
import { offsetText, presetOptions } from '../core/reminderText.js';
import { moveRow, rowsToTemplate, shiftRow, templateToRows } from '../core/templateRows.js';
import { TEMPLATE_LIMITS, checkTemplateContent, templateDescriptionProblem, templateNameProblem, templateStats } from '../../shared/template.js';
import { h, openDialog, replace, toast } from './dom.js';
import { icon } from './icons.js';

const intOrUndefined = (text) => {
  const value = String(text ?? '').trim();
  if (value === '' || !/^-?\d+$/.test(value)) return undefined;
  return Number(value);
};

/**
 * @param {{ template: object, actions: { updateTemplate: (id: string, changes: object) => Promise<unknown> } }} options
 * @returns {Promise<boolean>} true als er is bewaard
 */
export function editTemplateDialog({ template, actions }) {
  return openDialog((finish) => {
    let rows = templateToRows(template.content);
    const name = h('input', { type: 'text', class: 'field', maxLength: TEMPLATE_LIMITS.templateName, value: template.name, autocomplete: 'off', dataset: { fk: 'tpl-edit-name' } });
    const description = h('textarea', { class: 'field', rows: 2, maxLength: TEMPLATE_LIMITS.templateDescription, dataset: { fk: 'tpl-edit-description' } });
    description.value = template.description ?? '';
    const list = h('ol', { class: 'tpl-rows', 'aria-label': t('template.edit.rowsLabel') });
    const error = h('p', { class: 'error', role: 'alert' });

    const set = (next, focus = null) => {
      rows = next;
      draw();
      if (focus) list.querySelector(`[data-fk="${focus}"]`)?.focus();
    };
    const update = (index, change) => {
      rows = rows.map((r, i) => (i === index ? { ...r, task: { ...r.task, ...change } } : r));
    };
    const clearKey = (index, key) => {
      const task = { ...rows[index].task };
      delete task[key];
      rows = rows.map((r, i) => (i === index ? { ...r, task } : r));
    };
    const iconButton = (fk, iconName, label, onclick, disabled = false) => h('button', {
      type: 'button', class: 'icon-button', 'aria-label': label, title: label, dataset: { fk }, disabled, onclick,
    }, icon(iconName));

    const taskRow = (row, index) => {
      const task = row.task;
      const label = task.content || t('template.edit.untitled');
      const content = h('input', {
        type: 'text', class: 'field tpl-row-text', value: task.content ?? '', maxLength: TEMPLATE_LIMITS.title, autocomplete: 'off',
        'aria-label': t('template.edit.taskLabel', { level: row.depth }), dataset: { fk: `tplrow:${index}:text` },
        oninput: (e) => update(index, { content: e.target.value }),
      });
      const day = h('input', {
        type: 'number', class: 'field field-small', min: TEMPLATE_LIMITS.dayMin, max: TEMPLATE_LIMITS.dayMax, step: 1, value: task.day ?? '',
        dataset: { fk: `tplrow:${index}:day` }, onchange: (e) => { const v = intOrUndefined(e.target.value); if (v === undefined) clearKey(index, 'day'); else update(index, { day: v }); },
      });
      const time = h('input', {
        type: 'time', class: 'field field-small', value: task.time ?? '', dataset: { fk: `tplrow:${index}:time` },
        onchange: (e) => { if (e.target.value) update(index, { time: e.target.value }); else clearKey(index, 'time'); },
      });
      const priority = h('select', {
        class: 'field field-small', dataset: { fk: `tplrow:${index}:priority` },
        onchange: (e) => { const v = Number(e.target.value); if (v >= 4) clearKey(index, 'priority'); else update(index, { priority: v }); },
      }, [1, 2, 3, 4].map((p) => h('option', { value: String(p), selected: (task.priority ?? 4) === p }, p === 4 ? t('task.priorityNone') : `P${p}`)));
      const deadline = h('input', {
        type: 'number', class: 'field field-small', min: TEMPLATE_LIMITS.dayMin, max: TEMPLATE_LIMITS.dayMax, step: 1, value: task.deadline_day ?? '',
        dataset: { fk: `tplrow:${index}:deadline` }, onchange: (e) => { const v = intOrUndefined(e.target.value); if (v === undefined) clearKey(index, 'deadline_day'); else update(index, { deadline_day: v }); },
      });
      const current = Array.isArray(task.reminders) && task.reminders.length > 0 ? task.reminders : null;
      const reminder = h('select', {
        class: 'field field-small', dataset: { fk: `tplrow:${index}:reminder` },
        onchange: (e) => { if (e.target.value === '' ) clearKey(index, 'reminders'); else if (e.target.value !== 'keep') update(index, { reminders: [Number(e.target.value)] }); },
      },
      h('option', { value: '' }, t('template.edit.reminderNone')),
      current && current.length > 1 && h('option', { value: 'keep', selected: true }, current.map(offsetText).join(', ')),
      presetOptions().map((o) => h('option', { value: String(o.minutes), selected: current?.length === 1 && current[0] === o.minutes }, o.label)));
      const field = (text, input, hint = '') => h('label', { class: 'field-label tpl-row-field' }, text, input, hint && h('span', { class: 'hint' }, hint));
      const hasMore = ['day', 'time', 'priority', 'deadline_day', 'reminders'].some((k) => task[k] !== undefined);
      return h('li', { class: 'tpl-row', dataset: { depth: String(row.depth) } },
        h('div', { class: 'tpl-row-main' },
          iconButton(`tplrow:${index}:out`, 'chevronLeft', t('template.edit.outdent', { name: label }), () => set(shiftRow(rows, index, -1), `tplrow:${index}:out`), row.depth <= 1),
          iconButton(`tplrow:${index}:in`, 'chevronRight', t('template.edit.indent', { name: label }), () => set(shiftRow(rows, index, 1), `tplrow:${index}:in`)),
          content,
          iconButton(`tplrow:${index}:up`, 'arrowUp', t('template.edit.up', { name: label }), () => set(moveRow(rows, index, -1), `tplrow:${index - 1}:up`), index === 0),
          iconButton(`tplrow:${index}:down`, 'arrowDown', t('template.edit.down', { name: label }), () => set(moveRow(rows, index, 1), `tplrow:${index + 1}:down`), index === rows.length - 1),
          iconButton(`tplrow:${index}:delete`, 'trash', t('template.edit.delete', { name: label }), () => set(rows.filter((_, i) => i !== index)))),
        h('details', { class: 'tpl-row-more', open: hasMore },
          h('summary', {}, t('template.edit.more')),
          h('div', { class: 'tpl-row-fields' },
            field(t('template.edit.day'), day, t('template.edit.dayHint')),
            field(t('template.edit.time'), time),
            field(t('task.priority'), priority),
            field(t('template.edit.deadline'), deadline, t('template.edit.dayHint')),
            field(t('template.edit.reminder'), reminder, t('template.edit.reminderHint')))));
    };
    const sectionRow = (row, index) => h('li', { class: 'tpl-row tpl-row-section' },
      h('div', { class: 'tpl-row-main' },
        h('input', {
          type: 'text', class: 'field tpl-row-text', value: row.name, maxLength: TEMPLATE_LIMITS.sectionName, autocomplete: 'off',
          'aria-label': t('template.edit.sectionLabel'), dataset: { fk: `tplrow:${index}:text` },
          oninput: (e) => { rows = rows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)); },
        }),
        iconButton(`tplrow:${index}:up`, 'arrowUp', t('template.edit.up', { name: row.name }), () => set(moveRow(rows, index, -1), `tplrow:${index - 1}:up`), index === 0),
        iconButton(`tplrow:${index}:down`, 'arrowDown', t('template.edit.down', { name: row.name }), () => set(moveRow(rows, index, 1), `tplrow:${index + 1}:down`), index === rows.length - 1),
        iconButton(`tplrow:${index}:delete`, 'trash', t('template.edit.delete', { name: row.name }), () => set(rows.filter((_, i) => i !== index)))));
    const draw = () => replace(list, rows.map((row, i) => (row.kind === 'section' ? sectionRow(row, i) : taskRow(row, i))));
    draw();

    const add = (kind) => {
      const last = rows.at(-1);
      const row = kind === 'section' ? { kind: 'section', name: '' } : { kind: 'task', depth: last?.kind === 'task' ? last.depth : 1, task: { content: '' } };
      set([...rows, row], `tplrow:${rows.length}:text`);
    };

    return h('form', {
      class: 'dialog-form tpl-editor',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        const label = name.value.trim();
        const problem = templateNameProblem(label) ?? templateDescriptionProblem(description.value);
        if (problem || !label) {
          error.textContent = t('template.edit.nameProblem');
          name.focus();
          return;
        }
        if (rows.some((r) => r.kind === 'section' && !String(r.name).trim())) {
          error.textContent = t('template.edit.sectionEmpty');
          return;
        }
        const content = rowsToTemplate(rows);
        if (templateStats(content).tasks === 0) {
          error.textContent = t('template.edit.empty');
          return;
        }
        const invalid = checkTemplateContent(content);
        if (invalid) {
          error.textContent = t('template.edit.invalid', { detail: invalid });
          return;
        }
        await actions.updateTemplate(template.id, { name: label, description: description.value.trim(), content });
        toast(t('template.edit.saved', { name: label }));
        finish(true);
      },
    },
    h('h2', {}, t('template.edit.title')),
    h('label', { class: 'field-label' }, t('common.name'), name),
    h('label', { class: 'field-label' }, t('template.edit.description'), description),
    h('p', { class: 'hint' }, t('template.edit.intro')),
    list,
    h('div', { class: 'tpl-row-add' },
      h('button', { type: 'button', class: 'button button-small', dataset: { fk: 'tpl-add-task' }, onclick: () => add('task') }, icon('plus'), t('template.edit.addTask')),
      h('button', { type: 'button', class: 'button button-small', dataset: { fk: 'tpl-add-section' }, onclick: () => add('section') }, icon('plus'), t('template.edit.addSection'))),
    error,
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(false) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary' }, t('common.save'))));
  }, { wide: true });
}
