// Het venster om een project te maken of te bewerken: naam, kleur, favoriet, en bij een nieuw project "subproject van".

import { COLOR_NAMES, DEFAULT_COLOR, colorClass, colorName } from '../core/colors.js';
import { t } from '../core/i18n.js';
import { projectList } from '../core/selectors.js';
import { isInboxId } from '../../shared/schema.js';
import { h, openDialog } from './dom.js';
import { icon } from './icons.js';

/** De naam van een kleur in de taal van de interface (voor schermlezers en tooltips). */
const COLOR_LABELS = {
  charcoal: () => t('color.charcoal'), red: () => t('color.red'), orange: () => t('color.orange'), amber: () => t('color.amber'),
  olive: () => t('color.olive'), green: () => t('color.green'), mint: () => t('color.mint'), teal: () => t('color.teal'),
  sky: () => t('color.sky'), blue: () => t('color.blue'), indigo: () => t('color.indigo'), violet: () => t('color.violet'),
  magenta: () => t('color.magenta'), rose: () => t('color.rose'), brown: () => t('color.brown'), grey: () => t('color.grey'),
};
export const colorLabel = (name) => COLOR_LABELS[colorName(name)]();

/** Inspringen in een keuzelijst: harde spaties (gewone spaties vallen weg). */
const INDENT = String.fromCharCode(160, 160);

/**
 * @param {{ view: object, project?: object | null, parentId?: string | null }} options
 *   `project`: een bestaand project bewerken; anders een nieuw project, eventueel als subproject van `parentId`.
 * @returns {Promise<{ name: string, color: string, is_favorite: boolean, parent_id: string | null } | null>} null bij annuleren
 */
export function openProjectDialog({ view, project = null, parentId = null }) {
  return openDialog((finish) => {
    const editing = Boolean(project);
    const name = h('input', { type: 'text', value: project?.name ?? '', required: true, class: 'field', 'aria-label': t('common.name'), autocomplete: 'off', maxLength: 200, autofocus: true });
    let color = colorName(project?.color ?? DEFAULT_COLOR);
    const swatches = COLOR_NAMES.map((c) => h('label', { class: `swatch ${colorClass(c)}`, title: colorLabel(c) },
      h('input', { type: 'radio', name: 'project-color', value: c, checked: c === color, 'aria-label': colorLabel(c), onchange: () => { color = c; } }),
      h('span', { class: 'swatch-dot' }, icon('check'))));
    const favorite = h('input', { type: 'checkbox', checked: Boolean(project?.is_favorite) });
    // Een nieuw project kan een subproject worden; een bestaand project verhuizen doet alleen de eigenaar en hoort hier niet bij.
    const parent = h('select', { class: 'field' },
      h('option', { value: '' }, t('project.noParent')),
      projectList(view).filter(({ project: p }) => !isInboxId(p.id)).map(({ project: p, depth }) => h('option', { value: p.id, selected: p.id === parentId }, `${INDENT.repeat(depth)}${p.name}`)));
    return h('form', {
      class: 'dialog-form',
      onsubmit: (e) => {
        e.preventDefault();
        const text = name.value.trim();
        if (text) finish({ name: text, color, is_favorite: favorite.checked, parent_id: editing ? null : parent.value || null });
      },
    },
    h('h2', {}, editing ? t('project.edit') : parentId ? t('project.newSub') : t('project.new')),
    h('label', { class: 'field-label' }, t('common.name'), name),
    h('fieldset', { class: 'color-field' }, h('legend', {}, t('project.color')), h('div', { class: 'swatches' }, swatches)),
    h('label', { class: 'check-row' }, favorite, t('project.favorite')),
    !editing && h('label', { class: 'field-label' }, t('project.parent'), parent),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary' }, editing ? t('common.save') : t('common.add'))));
  });
}
