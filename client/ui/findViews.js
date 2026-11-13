// De schermen voor filters en labels: één filter met zijn taken (of de fout), één label met zijn taken, en de overzichten
// waar je ze beheert. Elke functie krijgt de gegevens van `mainView` (ui/render.js, via `viewHooks`) en geeft hetzelfde terug:
// { title, count, lead, actions, nodes }. Wat een knop doet, zit in `api` (ui/find.js).

import { filterErrorText } from '../core/filterText.js';
import { filterOutcome, labelCounts, labelTasks } from '../core/filterViews.js';
import { t } from '../core/i18n.js';
import { filterList, isForeignLabel, labelList } from '../core/selectors.js';
import { h } from './dom.js';
import { errorBlock, filterContext } from './filterDialog.js';
import { icon } from './icons.js';
import { dot } from './render.js';

const headButton = (cls, iconName, label, onclick, extra = {}) => h('button', { class: `button button-small button-ghost find-action ${cls}`, type: 'button', onclick, ...extra },
  icon(iconName), h('span', { class: 'btn-label' }, label));

const gone = (ctx, title) => ({ title, count: null, lead: null, actions: [], nodes: [ctx.emptyState({ title })] });

// ---------- één filter ----------

export function filterView(ctx, api) {
  const { view, route, rows, group, emptyState } = ctx;
  const filter = view.filters.get(route.id);
  if (!filter) return gone(ctx, t('filter.gone'));
  const outcome = filterOutcome(filter, filterContext(api.store));
  const actions = [
    headButton('btn-edit', 'pencil', t('filter.editButton'), () => api.editFilter(filter)),
    headButton('btn-menu', 'more', t('filter.more'), () => api.filterMenu(filter)),
  ];
  const summary = h('p', { class: 'filter-summary' }, icon('funnel'), h('code', { class: 'filter-query' }, filter.query));
  const lead = dot(filter.color, 'dot-large');
  if (!outcome.ok) {
    return {
      title: filter.name, count: null, lead, actions,
      nodes: [
        h('div', { class: 'filter-broken' },
          h('h2', { class: 'filter-broken-title' }, t('filter.brokenTitle')),
          errorBlock(filter.query, outcome.error),
          h('p', { class: 'hint' }, t('filter.brokenText')),
          h('div', { class: 'filter-broken-buttons' },
            h('button', { class: 'button button-primary', type: 'button', onclick: () => api.editFilter(filter) }, t('filter.editButton')),
            h('button', { class: 'button', type: 'button', onclick: () => api.filterHelp() }, t('filter.helpButton')))),
      ],
    };
  }
  const lists = outcome.groups.length > 1 ? outcome.groups : [{ name: null, tasks: outcome.tasks }];
  const nodes = lists.map((g) => group({ title: g.name, rows: rows(g.tasks.map((task) => ({ task })), true), total: g.tasks.length }));
  return {
    title: filter.name, count: outcome.count, lead, actions,
    nodes: [
      summary,
      ...nodes,
      outcome.count === 0 && emptyState({ title: t('filter.emptyTitle'), text: t('filter.empty') }),
    ],
  };
}

// ---------- één label ----------

export function labelView(ctx, api) {
  const { view, route, rows, group, emptyState, me, handlers } = ctx;
  const label = view.labels.get(route.id);
  if (!label) return gone(ctx, t('label.gone'));
  const showCompleted = api.showCompleted(label.id);
  const { tasks, completedCount } = labelTasks(view, label.id, { showCompleted });
  const foreign = isForeignLabel(label, me?.id);
  const open = tasks.filter((x) => !x.checked).length;
  return {
    title: `@${label.name}`, count: open, lead: dot(label.color, 'dot-large'),
    actions: foreign ? [] : [
      headButton('btn-edit', 'pencil', t('label.editButton'), () => api.editLabel(label)),
      headButton('btn-menu', 'more', t('label.more'), () => api.labelMenu(label)),
    ],
    nodes: [
      foreign && h('div', { class: 'banner', role: 'status' }, h('span', {}, t('label.foreignBanner'))),
      group({ title: null, rows: rows(tasks.map((task) => ({ task })), true), total: tasks.length }),
      !foreign && h('button', { class: 'add-inline', type: 'button', onclick: () => handlers.quickAdd({ text: `@${label.name} ` }) }, icon('plus'), t('quick.addTask')),
      tasks.length === 0 && emptyState({ title: t('label.emptyTitle'), text: t('label.empty') }),
      completedCount > 0 && h('button', { class: 'link-button', type: 'button', onclick: () => api.toggleCompleted(label.id) },
        showCompleted ? t('view.hideCompleted') : t('view.showCompleted', { count: completedCount })),
    ],
  };
}

// ---------- overzichten om te beheren ----------

/** Een regel in een beheerlijst: links een knop die het label of filter opent, rechts de knoppen om te wijzigen. */
function manageRow({ fk, lead, name, detail, onOpen, buttons }) {
  return h('li', { class: 'manage-row' },
    h('button', { class: 'manage-open', type: 'button', dataset: { fk }, onclick: onOpen },
      lead,
      h('span', { class: 'manage-text' }, h('span', { class: 'manage-name' }, name), detail)),
    h('span', { class: 'manage-buttons' }, buttons));
}

const iconAction = (iconName, label, onclick, extra = {}) => h('button', { class: 'icon-button', type: 'button', 'aria-label': label, title: label, onclick, ...extra }, icon(iconName));
const favoriteToggle = (on, label, onclick) => iconAction('star', label, onclick, { 'aria-pressed': String(on), class: `icon-button favorite-toggle${on ? ' favorite-on' : ''}` });

export function labelsPage(ctx, api) {
  const { view, emptyState, me } = ctx;
  const { own, others } = labelList(view, me?.id);
  const counts = labelCounts(view);
  const rowOf = ({ label }, mine) => manageRow({
    fk: `label-row:${label.id}`,
    lead: dot(label.color, 'dot-large'),
    name: `@${label.name}`,
    detail: h('span', { class: 'manage-detail' }, t('label.openCount', { count: counts.get(label.id) ?? 0 })),
    onOpen: () => api.navigate({ type: 'label', id: label.id }),
    buttons: mine ? [
      favoriteToggle(Boolean(label.is_favorite), t('label.favoriteLabel', { name: label.name }), () => api.toggleFavoriteLabel(label)),
      iconAction('pencil', t('label.editLabel', { name: label.name }), () => api.editLabel(label)),
      iconAction('trash', t('label.deleteLabel', { name: label.name }), () => api.deleteLabel(label)),
    ] : [],
  });
  return {
    title: t('labels.title'), count: null, lead: icon('tag'),
    actions: [headButton('btn-add', 'plus', t('label.add'), () => api.addLabel({ open: false }))],
    nodes: [
      h('p', { class: 'hint manage-intro' }, t('labels.intro')),
      own.length > 0 && h('ul', { class: 'manage-list' }, own.map((x) => rowOf(x, true))),
      own.length === 0 && emptyState({ title: t('labels.emptyTitle'), text: t('labels.empty') }),
      others.length > 0 && h('section', { class: 'group' },
        h('div', { class: 'group-head' }, h('h2', { class: 'group-title' }, t('labels.othersTitle'))),
        h('p', { class: 'hint manage-intro' }, t('labels.othersText')),
        h('ul', { class: 'manage-list' }, others.map((x) => rowOf(x, false)))),
    ],
  };
}

export function filtersPage(ctx, api) {
  const { view, emptyState, me } = ctx;
  const list = filterList(view, me?.id);
  const fctx = filterContext(api.store);
  const rowOf = (filter) => {
    const outcome = filterOutcome(filter, fctx);
    return manageRow({
      fk: `filter-row:${filter.id}`,
      lead: dot(filter.color, 'dot-large'),
      name: filter.name,
      detail: [
        h('code', { class: 'manage-query' }, filter.query),
        outcome.ok
          ? h('span', { class: 'manage-detail' }, t('filter.count', { count: outcome.count }))
          : h('span', { class: 'manage-detail manage-bad' }, t('filter.brokenShort'), ': ', filterErrorText(outcome.error)),
      ],
      onOpen: () => api.navigate({ type: 'filter', id: filter.id }),
      buttons: [
        favoriteToggle(Boolean(filter.is_favorite), t('filter.favoriteLabel', { name: filter.name }), () => api.toggleFavoriteFilter(filter)),
        iconAction('pencil', t('filter.editLabel', { name: filter.name }), () => api.editFilter(filter)),
        iconAction('trash', t('filter.deleteLabel', { name: filter.name }), () => api.deleteFilter(filter)),
      ],
    });
  };
  return {
    title: t('filters.title'), count: null, lead: icon('funnel'),
    actions: [
      headButton('btn-help', 'help', t('filter.helpButton'), () => api.filterHelp({ onUse: true })),
      headButton('btn-add', 'plus', t('filter.add'), () => api.addFilter({ open: true })),
    ],
    nodes: [
      h('p', { class: 'hint manage-intro' }, t('filters.intro')),
      list.length > 0 && h('ul', { class: 'manage-list' }, list.map(rowOf)),
      list.length === 0 && emptyState({ title: t('filters.emptyTitle'), text: t('filters.empty') }),
    ],
  };
}
