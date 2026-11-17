// Het venster "Weergave" van een lijst: sorteren, richting en groeperen. Elke keuze geldt meteen en wordt bewaard in je instellingen
// (`settings.view_options`, shared/viewOptions.js), dus op al je apparaten; een gedeeld project kan voor een ander anders staan.

import { DIRECTIONS, SORTS, groupChoices, optionsFor, viewKey, withOptions } from '../../shared/viewOptions.js';
import { mySettings } from '../core/selectors.js';
import { t } from '../core/i18n.js';
import { h, openDialog } from './dom.js';

// De teksten staan als letterlijke sleutels, zodat de controle op ongebruikte en ontbrekende teksten ze kan vinden.
const SORT_TEXT = {
  manual: (isProject) => (isProject ? t('listopt.sort.manual') : t('listopt.sort.standard')),
  name: () => t('listopt.sort.name'), date: () => t('listopt.sort.date'), priority: () => t('listopt.sort.priority'),
  deadline: () => t('listopt.sort.deadline'), added: () => t('listopt.sort.added'), assignee: () => t('listopt.sort.assignee'),
};
const GROUP_TEXT = {
  default: (isProject, type) => (isProject ? t('listopt.group.sections') : type === 'upcoming' ? t('listopt.group.days') : t('listopt.group.standard')),
  date: () => t('listopt.group.date'), priority: () => t('listopt.group.priority'), label: () => t('listopt.group.label'),
  assignee: () => t('listopt.group.assignee'), project: () => t('listopt.group.project'), deadline: () => t('listopt.group.deadline'),
};
const DIR_TEXT = { asc: () => t('listopt.dir.asc'), desc: () => t('listopt.dir.desc') };

/**
 * @param {{ route: { type: string, id?: string }, view: any, userId: string | null, update: (viewOptions: object) => Promise<unknown> | void,
 *   clearDayOrder?: (() => Promise<unknown> | void) | null }} options
 * `clearDayOrder`: alleen in Vandaag; een knop die je eigen volgorde (slepen, `settings.day_order`) weer weghaalt.
 */
export function listOptionsDialog({ route, view, userId, update, clearDayOrder = null }) {
  const key = viewKey(route);
  const isProject = route.type === 'project';
  // de laatst bewaarde stand houden we zelf bij: `view` is de toestand van het moment van openen, en een tweede keuze mag de eerste niet ongedaan maken
  let stored = mySettings(view, userId).view_options ?? null;
  const state = { ...optionsFor({ view_options: stored }, key) };
  const dayOrder = mySettings(view, userId).day_order;
  const hasDayOrder = Boolean(clearDayOrder) && Array.isArray(dayOrder) && dayOrder.length > 0;
  const save = (change) => {
    stored = withOptions(stored, key, change);
    update(stored);
  };

  return openDialog((finish) => {
    const select = (name, values, label, labelOf, onchange) => h('label', { class: 'field-label' }, label,
      h('select', { class: 'field', dataset: { fk: `listopt:${name}` }, onchange: (e) => onchange(e.target.value) },
        values.map((v) => h('option', { value: v, selected: v === state[name] }, labelOf(v)))));
    const sortLabel = (v) => SORT_TEXT[v](isProject);
    const groupLabel = (v) => GROUP_TEXT[v](isProject, route.type);
    const apply = (change) => {
      Object.assign(state, change);
      if (state.sort === 'manual') state.dir = 'asc';
      save(change);
      dir.disabled = state.sort === 'manual';
    };
    const dirSelect = select('dir', [...DIRECTIONS], t('listopt.dir'), (v) => DIR_TEXT[v](), (v) => apply({ dir: v }));
    const dir = dirSelect.querySelector('select');
    dir.disabled = state.sort === 'manual';
    return h('div', { class: 'dialog-form' },
      h('h2', {}, t('listopt.title')),
      h('div', { class: 'options-grid' },
        select('sort', [...SORTS], t('listopt.sort'), sortLabel, (v) => {
          apply({ sort: v });
          dir.value = state.dir;
        }),
        dirSelect,
        select('group', groupChoices(route.type), t('listopt.group'), groupLabel, (v) => apply({ group: v }))),
      h('p', { class: 'hint' }, t('listopt.hint')),
      hasDayOrder && h('p', { class: 'hint' }, t('listopt.dayOrderHint')),
      h('div', { class: 'dialog-buttons' },
        hasDayOrder && h('button', { type: 'button', class: 'button', dataset: { fk: 'listopt:clear-day-order' }, onclick: () => { clearDayOrder(); finish(null); } }, t('listopt.clearDayOrder')),
        h('button', { type: 'button', class: 'button', dataset: { fk: 'listopt:reset' }, onclick: () => { save({ sort: 'manual', group: 'default' }); finish(null); } }, t('listopt.reset')),
        h('button', { type: 'button', class: 'button button-primary', onclick: () => finish(null) }, t('common.close'))));
  });
}
