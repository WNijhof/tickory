// De keuzevensters bij een bulkactie (ui/selection.js): waarheen verplaatsen, welke datum, prioriteit, labels en toewijzen.
// Elk venster geeft de keuze terug of null bij sluiten; wat er daarna gebeurt, regelt ui/selection.js.

import { formatDate } from '../core/format.js';
import { foldText } from '../core/fold.js';
import { t } from '../core/i18n.js';
import { quickDates } from '../core/quickDates.js';
import { byOrder, projectList } from '../core/selectors.js';
import { colorClass } from '../core/colors.js';
import { h, menuDialog, openDialog, replace } from './dom.js';

/** Inspringen van een subproject: harde spaties (gewone spaties vallen weg). */
const INDENT = String.fromCharCode(160, 160);

/**
 * Een project, of een sectie ervan. Typen filtert op naam (hoofdletter- en accentongevoelig).
 * @returns {Promise<{ project_id: string, section_id: string | null, name: string } | null>}
 */
export function moveDialog({ view, count }) {
  const projects = projectList(view);
  const targets = [];
  for (const { project, depth } of projects) {
    targets.push({ project_id: project.id, section_id: null, name: project.name, title: project.name, depth, color: project.color, section: false });
    const sections = [...view.sections.values()].filter((s) => s.project_id === project.id && !s.is_archived).sort(byOrder);
    for (const s of sections) targets.push({ project_id: project.id, section_id: s.id, name: `${project.name} / ${s.name}`, title: s.name, depth: depth + 1, color: project.color, section: true });
  }
  return openDialog((finish, dialog) => {
    const list = h('ul', { class: 'bulk-targets' });
    const filter = h('input', { class: 'field', type: 'search', placeholder: t('bulk.moveFilter'), 'aria-label': t('bulk.moveFilter'), autocomplete: 'off' });
    const draw = () => {
      const q = foldText(filter.value.trim());
      const shown = targets.filter((x) => !q || foldText(x.name).includes(q));
      replace(list, shown.length > 0
        ? shown.map((x) => h('li', {}, h('button', {
          type: 'button', class: `menu-item bulk-target${x.section ? ' bulk-target-section' : ''}`, dataset: { projectId: x.project_id, sectionId: x.section_id ?? '' },
          onclick: () => finish({ project_id: x.project_id, section_id: x.section_id, name: x.name }),
        }, !x.section && h('span', { class: `dot ${colorClass(x.color)}`, 'aria-hidden': 'true' }), `${q ? '' : INDENT.repeat(x.depth)}${q ? x.name : x.title}`)))
        : [h('li', { class: 'hint' }, t('bulk.moveNothing'))]);
    };
    filter.addEventListener('input', draw);
    draw();
    queueMicrotask(() => { if (dialog.open) filter.focus(); });
    return h('div', { class: 'dialog-form' },
      h('h2', {}, t('bulk.moveTitle', { count })),
      filter,
      list,
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel'))));
  }, { className: 'dialog-bulk' });
}

/**
 * Een dag: vandaag, morgen, dit weekend, volgende week, geen datum, of een eigen datum.
 * @returns {Promise<{ date: string | null } | null>}
 */
export function dateDialog({ today, hasDue, count }) {
  const d = quickDates(today);
  return openDialog((finish) => {
    const item = (date, label) => h('button', { type: 'button', class: 'menu-item', dataset: { date: date ?? '' }, onclick: () => finish({ date }) }, date ? `${label} · ${formatDate(date, today)}` : label);
    const custom = h('input', { class: 'field', type: 'date', 'aria-label': t('bulk.dateCustom'), min: '1900-01-01', max: '9999-12-31' });
    return h('form', {
      class: 'dialog-form',
      onsubmit: (e) => {
        e.preventDefault();
        if (/^\d{4}-\d{2}-\d{2}$/.test(custom.value)) finish({ date: custom.value });
      },
    },
    h('h2', {}, t('bulk.dateTitle', { count })),
    h('div', { class: 'menu' },
      item(d.today, t('task.quickToday')), item(d.tomorrow, t('task.quickTomorrow')), item(d.weekend, t('task.quickWeekend')), item(d.nextWeek, t('task.quickNextWeek')),
      hasDue && item(null, t('task.quickNone'))),
    h('label', { class: 'field-label' }, t('bulk.dateCustom'), h('span', { class: 'bulk-custom-date' }, custom, h('button', { type: 'submit', class: 'button button-primary' }, t('bulk.dateApply')))),
    h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel'))));
  }, { className: 'dialog-bulk' });
}

/** Een prioriteit, 1 (hoogst) tot 4 (geen). @returns {Promise<number | null>} */
export function priorityDialog({ count }) {
  return menuDialog({
    title: t('bulk.priorityTitle', { count }),
    items: [{ value: 1, label: t('task.priorityHighest') }, { value: 2, label: 'P2' }, { value: 3, label: 'P3' }, { value: 4, label: t('task.priorityNone') }],
  });
}

/**
 * Labels toevoegen en weghalen. Elk label is een keuzevakje: aangevinkt = op alle gekozen taken, gedeeltelijk = op een deel (blijft
 * zoals het is tot je het aan- of uitzet), uit = op geen. Daarnaast kun je nieuwe labels op naam toevoegen.
 * @param {{ labels: { id: string, name: string, color: string }[], counts: Map<string, number>, total: number, count: number }} options
 * @returns {Promise<{ add: string[], remove: string[], names: string[] } | null>}
 */
export function labelsDialog({ labels, counts, total, count }) {
  return openDialog((finish) => {
    const boxes = new Map();
    const rows = labels.map((label) => {
      const on = counts.get(label.id) ?? 0;
      const input = h('input', { type: 'checkbox', checked: on === total && total > 0, dataset: { labelId: label.id } });
      if (on > 0 && on < total) input.indeterminate = true;
      boxes.set(label.id, { input, was: on === 0 ? 'none' : on === total ? 'all' : 'some' });
      return h('li', {}, h('label', { class: 'bulk-label-row' }, input, h('span', { class: `dot ${colorClass(label.color)}`, 'aria-hidden': 'true' }), h('span', {}, `@${label.name}`),
        on > 0 && on < total && h('span', { class: 'hint' }, t('bulk.labelsSome'))));
    });
    const fresh = h('input', { class: 'field', type: 'text', 'aria-label': t('bulk.labelsNew'), placeholder: t('bulk.labelsNew'), autocomplete: 'off', maxLength: 200 });
    return h('form', {
      class: 'dialog-form',
      onsubmit: (e) => {
        e.preventDefault();
        const add = [];
        const remove = [];
        for (const [id, { input, was }] of boxes) {
          if (was === 'some' && input.indeterminate) continue; // niet aangeraakt
          if (input.checked && was !== 'all') add.push(id);
          if (!input.checked && was !== 'none') remove.push(id);
        }
        const names = fresh.value.split(',').map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
        finish({ add, remove, names });
      },
    },
    h('h2', {}, t('bulk.labelsTitle', { count })),
    h('p', { class: 'hint' }, t('bulk.labelsHelp')),
    rows.length > 0 ? h('ul', { class: 'bulk-label-list' }, rows) : h('p', { class: 'hint' }, t('bulk.labelsNone')),
    h('label', { class: 'field-label' }, t('bulk.labelsNew'), fresh, h('span', { class: 'hint' }, t('bulk.labelsNewHint'))),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary' }, t('bulk.labelsApply'))));
  }, { className: 'dialog-bulk' });
}

/**
 * Aan wie? `people`: `{ userId, name, everywhere }` (everywhere false = niet lid van alle betrokken projecten).
 * @returns {Promise<{ userId: string | null } | null>}
 */
export async function assignDialog({ people, count }) {
  const choice = await menuDialog({
    title: t('bulk.assignTitle', { count }),
    items: [
      ...people.map((p) => ({ value: p.userId, label: p.everywhere ? p.name : `${p.name} (${t('bulk.assignSome')})` })),
      { value: '', label: t('bulk.assignNobody') },
    ],
  });
  if (choice === null || choice === undefined) return null;
  return { userId: choice === '' ? null : choice };
}
