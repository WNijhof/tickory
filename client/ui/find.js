// Zoeken, filters en labels aan de app koppelen. app.js roept `installFind` één keer aan; verder haakt dit bestand aan via de
// plekken die render.js biedt (zie het commentaar bovenaan ui/render.js): het zoekveld en de lijsten Filters en Labels in de
// zijbalk (`sidebarHooks`), de schermen voor filter en label (`viewHooks`), een zoekknop in de kop en de sneltoetsen
// `/` en Ctrl+K. De knoppen van die schermen (aanmaken, bewerken, verwijderen) staan hier in `api`.

import { DEFAULT_COLOR } from '../core/colors.js';
import { filterOutcome, labelCounts } from '../core/filterViews.js';
import { t } from '../core/i18n.js';
import { labelProblemText } from '../core/labelManage.js';
import { searchKey } from '../core/searchKeys.js';
import { filterList, labelList } from '../core/selectors.js';
import { confirmDialog, h, menuDialog, replace, toast } from './dom.js';
import { filterContext, openFilterDialog } from './filterDialog.js';
import { filterHelpDialog } from './filterHelp.js';
import { filterView, filtersPage, labelView, labelsPage } from './findViews.js';
import { icon } from './icons.js';
import { openLabelDialog } from './labelDialog.js';
import { dot, sidebarHooks, viewHooks } from './render.js';
import { openSearchDialog } from './searchDialog.js';

const COLLAPSED_KEY = 'tickory.nav.collapsed';
const ROUTES = ['filter', 'label', 'filters', 'labels'];

/** Zijn dit routes die dit bestand tekent? (app.js bewaart ze dan ook voor de volgende keer openen.) */
export const isFindRoute = (route) => Boolean(route) && ROUTES.includes(route.type);

/**
 * @param {{
 *   store: import('../core/store.js').Store, actions: object, handlers: object,
 *   navigate: (route: object) => void, getRoute: () => object, persist?: boolean,
 * }} options  `persist`: onthoud welke lijsten in de zijbalk zijn ingeklapt (niet in de demo)
 */
export function installFind({ store, actions, handlers, navigate, getRoute, persist = true }) {
  const same = (route) => { const now = getRoute(); return now.type === route.type && (now.id ?? null) === (route.id ?? null); };
  const completedShown = new Set(); // labels waarvan de afgevinkte taken getoond worden

  // ---------- ingeklapte lijsten in de zijbalk ----------
  const collapsed = new Set();
  if (persist) {
    try {
      const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
      for (const key of Array.isArray(saved) ? saved : []) if (key === 'filters' || key === 'labels') collapsed.add(key);
    } catch { /* geen bewaarde keuze: alles uitgeklapt */ }
  }
  const saveCollapsed = () => {
    if (!persist) return;
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch { /* opslag geblokkeerd: de keuze geldt tot de pagina sluit */ }
  };

  // ---------- zoeken ----------
  async function openSearch(initial = '') {
    if (!store.ready || !store.me) return;
    const open = document.querySelector('#search-dialog[open]');
    if (open) {
      open.querySelector('input')?.focus();
      return;
    }
    document.body.classList.remove('nav-open');
    const hit = await openSearchDialog({ store, initial });
    if (hit) pick(hit);
  }

  /** Wat er gebeurt met een gekozen treffer. */
  function pick(hit) {
    const view = store.view;
    const openTask = (id) => {
      const task = view.tasks.get(id);
      if (task) handlers.open(task);
    };
    if (hit.kind === 'task') openTask(hit.id);
    else if (hit.kind === 'comment') {
      if (hit.on.kind === 'task') openTask(hit.on.id);
      else {
        const project = view.projects.get(hit.on.id);
        if (project) {
          navigate({ type: 'project', id: project.id });
          handlers.projectComments(project);
        }
      }
    } else if (hit.kind === 'project') navigate({ type: 'project', id: hit.id });
    else if (hit.kind === 'section') hit.project && navigate({ type: 'project', id: hit.project.id });
    else if (hit.kind === 'label') navigate({ type: 'label', id: hit.id });
    else if (hit.kind === 'filter') navigate({ type: 'filter', id: hit.id });
  }

  // ---------- labels ----------
  const labelsWithTasks = (id) => [...store.view.tasks.values()].filter((x) => (x.labels ?? []).includes(id)).length;

  async function addLabel({ open = true } = {}) {
    const made = await openLabelDialog({ view: store.view, userId: store.userId });
    if (!made) return;
    const id = await actions.addLabel(made.name);
    const extra = {};
    if (made.color !== DEFAULT_COLOR) extra.color = made.color;
    if (made.is_favorite) extra.is_favorite = true;
    if (id && Object.keys(extra).length > 0) await actions.updateLabel(id, extra);
    if (id && open) navigate({ type: 'label', id });
  }

  async function editLabel(label) {
    const edited = await openLabelDialog({ view: store.view, userId: store.userId, label });
    if (!edited) return;
    if (edited.name !== label.name) {
      const result = await actions.renameLabel(label.id, edited.name);
      if (!result.ok) toast(labelProblemText(result.code), { kind: 'error' });
    }
    const changes = {};
    if (edited.color !== (label.color ?? DEFAULT_COLOR)) changes.color = edited.color;
    if (edited.is_favorite !== Boolean(label.is_favorite)) changes.is_favorite = edited.is_favorite;
    if (Object.keys(changes).length > 0) await actions.updateLabel(label.id, changes);
  }

  async function deleteLabel(label) {
    const count = labelsWithTasks(label.id);
    const ok = await confirmDialog({
      title: t('label.deleteTitle'),
      text: count > 0 ? t('label.deleteTextTasks', { name: label.name, count }) : t('label.deleteText', { name: label.name }),
    });
    if (!ok) return;
    await actions.deleteLabel(label.id);
    const now = getRoute();
    if (now.type === 'label' && now.id === label.id) navigate({ type: 'labels' });
  }

  async function labelMenu(label) {
    const choice = await menuDialog({
      title: `@${label.name}`,
      items: [
        { value: 'edit', label: t('label.editMenu') },
        { value: 'favorite', label: label.is_favorite ? t('label.unfavorite') : t('label.favoriteAdd') },
        { value: 'delete', label: t('label.delete'), danger: true },
      ],
    });
    if (choice === 'edit') await editLabel(label);
    else if (choice === 'favorite') await actions.updateLabel(label.id, { is_favorite: !label.is_favorite });
    else if (choice === 'delete') await deleteLabel(label);
  }

  // ---------- filters ----------
  async function addFilter({ open = true, query = '' } = {}) {
    const made = await openFilterDialog({ store, query });
    if (!made) return;
    const id = await actions.addFilter({ name: made.name, query: made.query, color: made.color });
    if (made.is_favorite) await actions.updateFilter(id, { is_favorite: true });
    if (open) navigate({ type: 'filter', id });
  }

  async function editFilter(filter) {
    const edited = await openFilterDialog({ store, filter });
    if (!edited) return;
    const changes = {};
    if (edited.name !== filter.name) changes.name = edited.name;
    if (edited.query !== filter.query) changes.query = edited.query;
    if (edited.color !== (filter.color ?? DEFAULT_COLOR)) changes.color = edited.color;
    if (edited.is_favorite !== Boolean(filter.is_favorite)) changes.is_favorite = edited.is_favorite;
    if (Object.keys(changes).length > 0) await actions.updateFilter(filter.id, changes);
  }

  async function deleteFilter(filter) {
    const ok = await confirmDialog({ title: t('filter.deleteTitle'), text: t('filter.deleteText', { name: filter.name }) });
    if (!ok) return;
    await actions.deleteFilter(filter.id);
    const now = getRoute();
    if (now.type === 'filter' && now.id === filter.id) navigate({ type: 'filters' });
  }

  async function filterMenu(filter) {
    const choice = await menuDialog({
      title: filter.name,
      items: [
        { value: 'edit', label: t('filter.editMenu') },
        { value: 'favorite', label: filter.is_favorite ? t('filter.unfavorite') : t('filter.favoriteAdd') },
        { value: 'delete', label: t('filter.delete'), danger: true },
      ],
    });
    if (choice === 'edit') await editFilter(filter);
    else if (choice === 'favorite') await actions.updateFilter(filter.id, { is_favorite: !filter.is_favorite });
    else if (choice === 'delete') await deleteFilter(filter);
  }

  async function filterHelp({ onUse = false } = {}) {
    const query = await filterHelpDialog({ onUse });
    if (query) await addFilter({ open: true, query });
  }

  const api = {
    store,
    navigate,
    showCompleted: (id) => completedShown.has(id),
    toggleCompleted(id) {
      if (!completedShown.delete(id)) completedShown.add(id);
      navigate(getRoute());
    },
    addLabel,
    editLabel,
    deleteLabel,
    labelMenu,
    toggleFavoriteLabel: (label) => actions.updateLabel(label.id, { is_favorite: !label.is_favorite }),
    addFilter,
    editFilter,
    deleteFilter,
    filterMenu,
    toggleFavoriteFilter: (filter) => actions.updateFilter(filter.id, { is_favorite: !filter.is_favorite }),
    filterHelp,
  };
  handlers.openLabel = (id) => navigate({ type: 'label', id });
  viewHooks.filter = (ctx) => filterView(ctx, api);
  viewHooks.label = (ctx) => labelView(ctx, api);
  viewHooks.filters = (ctx) => filtersPage(ctx, api);
  viewHooks.labels = (ctx) => labelsPage(ctx, api);

  // ---------- de zijbalk ----------
  let slots = null; // de plekken van de laatste keer tekenen

  const searchField = () => h('button', {
    class: 'search-field', type: 'button', 'aria-keyshortcuts': '/ Control+K', dataset: { fk: 'search-open' }, onclick: () => openSearch(),
  }, icon('search'), h('span', { class: 'search-field-text' }, t('search.fieldText')), h('kbd', { class: 'search-field-key', 'aria-hidden': 'true' }, '/'));

  const navItem = ({ target, label, lead, count, extra = null, warning = false, fk }) => {
    const active = same(target);
    return h('button', {
      class: `find-item${active ? ' active' : ''}`, type: 'button', 'aria-current': active ? 'page' : null, dataset: { fk }, onclick: () => navigate(target),
    }, lead, h('span', { class: 'find-label' }, label), extra,
    warning && h('span', { class: 'find-count find-bad', role: 'img', 'aria-label': t('filter.brokenShort'), title: t('filter.brokenShort') }, '!'),
    count !== null && count !== undefined && h('span', { class: 'find-count' }, String(count)));
  };

  const star = () => h('span', { class: 'find-star', role: 'img', 'aria-label': t('nav.favoriteMark') }, icon('star'));

  const heading = ({ key, title, target, addLabel: addText, onAdd }) => {
    const isCollapsed = collapsed.has(key);
    const active = same(target);
    return h('div', { class: 'nav-section-head' },
      h('button', {
        class: 'find-toggle', type: 'button', 'aria-expanded': String(!isCollapsed), dataset: { fk: `find-toggle:${key}` },
        'aria-label': isCollapsed ? t('nav.expandSection', { name: title }) : t('nav.collapseSection', { name: title }),
        onclick: () => toggleSection(key),
      }, icon(isCollapsed ? 'chevronRight' : 'chevronDown')),
      h('button', {
        class: 'nav-section-link', type: 'button', 'aria-current': active ? 'page' : null, dataset: { fk: `find-head:${key}` }, title: t('nav.manageSection', { name: title }),
        onclick: () => navigate(target),
      }, title),
      h('button', { class: 'icon-button', type: 'button', 'aria-label': addText, title: addText, onclick: onAdd }, icon('plus')));
  };

  const favoritesFirst = (list, favorite) => [...list.filter((x) => favorite(x)), ...list.filter((x) => !favorite(x))];

  function drawExtra(slot) {
    const userId = store.userId;
    const view = store.view;
    const filters = favoritesFirst(filterList(view, userId), (f) => f.is_favorite);
    const counts = labelCounts(view);
    const labels = favoritesFirst(labelList(view, userId).own, (x) => x.label.is_favorite);
    const ctx = filters.length > 0 ? filterContext(store) : null;
    const keepVisible = (target, isHidden) => isHidden && !same(target); // een ingeklapte lijst toont alleen de keuze die open staat
    replace(slot,
      heading({ key: 'filters', title: t('filters.title'), target: { type: 'filters' }, addLabel: t('filter.add'), onAdd: () => addFilter({ open: true }) }),
      filters.map((f) => {
        const target = { type: 'filter', id: f.id };
        if (keepVisible(target, collapsed.has('filters'))) return null;
        const outcome = filterOutcome(f, ctx);
        return navItem({
          target, label: f.name, lead: dot(f.color), fk: `filter:${f.id}`, extra: f.is_favorite && star(),
          count: outcome.ok && outcome.count > 0 ? outcome.count : null,
          warning: !outcome.ok,
        });
      }),
      heading({ key: 'labels', title: t('labels.title'), target: { type: 'labels' }, addLabel: t('label.add'), onAdd: () => addLabel({ open: true }) }),
      labels.map(({ label }) => {
        const openCount = counts.get(label.id) ?? 0;
        const target = { type: 'label', id: label.id };
        if (keepVisible(target, collapsed.has('labels'))) return null;
        return navItem({ target, label: label.name, lead: dot(label.color), fk: `label:${label.id}`, extra: label.is_favorite && star(), count: openCount > 0 ? openCount : null });
      }));
  }

  function toggleSection(key) {
    if (!collapsed.delete(key)) collapsed.add(key);
    saveCollapsed();
    if (!slots) return;
    drawExtra(slots.extra);
    slots.extra.querySelector(`[data-fk="find-toggle:${key}"]`)?.focus();
  }

  const topbarButton = () => h('button', {
    class: 'icon-button topbar-search', type: 'button', 'aria-label': t('search.open'), title: t('search.open'), 'aria-keyshortcuts': '/ Control+K', onclick: () => openSearch(),
  }, icon('search'));

  sidebarHooks.push(({ search, extra }) => {
    slots = { search, extra };
    replace(search, searchField());
    drawExtra(extra);
    const bar = document.getElementById('topbar-tools');
    if (bar) replace(bar, topbarButton());
  });

  // ---------- sneltoetsen ----------
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !store.ready || !store.me) return;
    // `/` werkt alleen buiten invoervelden en zonder open venster; Ctrl+K altijd (en daar nemen we ook de toets van de browser voor over)
    if (searchKey(e, { blocked: () => Boolean(document.querySelector('dialog[open]')) })) {
      e.preventDefault();
      openSearch();
    }
  });

  return { openSearch };
}
