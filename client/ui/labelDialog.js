// Het venster om een label te maken of te bewerken: naam (met controle op dubbele en ongeldige namen, in de taal van de
// interface), kleur en favoriet. Ook de kleurkiezer is hier te vinden voor andere vensters (het filtervenster gebruikt hem).

import { COLOR_NAMES, DEFAULT_COLOR, colorClass, colorName } from '../core/colors.js';
import { t } from '../core/i18n.js';
import { labelNameProblem, labelProblemText } from '../core/labelManage.js';
import { h, openDialog } from './dom.js';
import { icon } from './icons.js';
import { colorLabel } from './projectDialog.js';

let groupNo = 0;

/**
 * De kleurkiezer: zestien rondjes (keuzerondjes onder de motorkap, dus met pijltjestoetsen te bedienen).
 * @returns {{ node: HTMLElement, value: () => string }}
 */
export function colorField(initial) {
  let color = colorName(initial ?? DEFAULT_COLOR);
  const group = `color-${++groupNo}`;
  const swatches = COLOR_NAMES.map((c) => h('label', { class: `swatch ${colorClass(c)}`, title: colorLabel(c) },
    h('input', { type: 'radio', name: group, value: c, checked: c === color, 'aria-label': colorLabel(c), onchange: () => { color = c; } }),
    h('span', { class: 'swatch-dot' }, icon('check'))));
  return {
    node: h('fieldset', { class: 'color-field' }, h('legend', {}, t('project.color')), h('div', { class: 'swatches' }, swatches)),
    value: () => color,
  };
}

/**
 * @param {{ view: object, userId: string | null, label?: object | null }} options  `label`: een bestaand label bewerken; anders een nieuw label
 * @returns {Promise<{ name: string, color: string, is_favorite: boolean } | null>} null bij annuleren
 */
export function openLabelDialog({ view, userId, label = null }) {
  return openDialog((finish) => {
    const editing = Boolean(label);
    const error = h('p', { class: 'error', id: 'label-dialog-error', role: 'alert' });
    const name = h('input', {
      type: 'text', value: label?.name ?? '', class: 'field', 'aria-label': t('common.name'), autocomplete: 'off', maxLength: 100, autofocus: true,
      'aria-describedby': 'label-dialog-error',
    });
    const color = colorField(label?.color);
    const favorite = h('input', { type: 'checkbox', checked: Boolean(label?.is_favorite) });
    const check = () => {
      const problem = labelNameProblem(view, userId, name.value, label?.id ?? null);
      error.textContent = problem ? labelProblemText(problem) : '';
      name.setAttribute('aria-invalid', String(Boolean(problem)));
      return problem;
    };
    let touched = false;
    name.addEventListener('input', () => { if (touched) check(); });
    return h('form', {
      class: 'dialog-form',
      onsubmit: (e) => {
        e.preventDefault();
        touched = true;
        if (check()) {
          name.focus();
          return;
        }
        finish({ name: name.value.trim(), color: color.value(), is_favorite: favorite.checked });
      },
    },
    h('h2', {}, editing ? t('label.edit') : t('label.new')),
    h('label', { class: 'field-label' }, t('common.name'), name),
    error,
    color.node,
    h('label', { class: 'check-row' }, favorite, t('label.favorite')),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary' }, editing ? t('common.save') : t('common.add'))));
  });
}
