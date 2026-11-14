// Het overzicht "Voltooid": alle afgevinkte taken, nieuwste eerst, per dag van afvinken, voor alle projecten of één project, met zoeken en
// een knop om een taak terug te zetten. De logica (welke taken, groeperen per dag) staat in core/completed.js; dit bestand tekent en
// haakt aan via `sidebarHooks` (de regel onder Binnenkort) en `viewHooks.completed` (zie ui/render.js). De route is
// `{ type: 'completed' }` of `{ type: 'completed', id: <project> }`.
//
// Het scherm tekent maar een deel van de lijst (`PAGE` taken, daarna "Meer tonen"): een lijst van duizenden voltooide taken blijft zo vlot.

import { completedGroups, completedProjects, completedTasks } from '../core/completed.js';
import { formatDayHeading } from '../core/format.js';
import { t } from '../core/i18n.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { sidebarHooks, viewHooks } from './render.js';

/** Hoeveel voltooide taken er per keer getekend worden. */
export const PAGE = 100;

export const isCompletedRoute = (route) => Boolean(route) && route.type === 'completed';

/**
 * @param {{
 *   store: import('../core/store.js').Store,
 *   handlers: { navigate: (route: object) => void, refresh: () => void },
 *   getRoute: () => object,
 * }} options
 */
export function installCompleted({ store, handlers, getRoute }) {
  const state = { query: '', limit: PAGE };
  let composing = false;

  // Het zoekveld blijft hetzelfde element bij elke keer tekenen (de lijst wordt bij elke wijziging opnieuw opgebouwd, een nieuw veld zou
  // tijdens het typen zijn tekst en cursor kwijtraken); app.js zet de focus terug via `data-fk`.
  const search = h('input', {
    class: 'field', type: 'search', autocomplete: 'off', maxLength: 200, dataset: { fk: 'completed-search' },
  });
  const refreshSoon = () => { state.limit = PAGE; handlers.refresh(); };
  search.addEventListener('input', () => {
    state.query = search.value;
    if (!composing) refreshSoon();
  });
  search.addEventListener('compositionstart', () => { composing = true; });
  search.addEventListener('compositionend', () => { composing = false; state.query = search.value; refreshSoon(); });

  sidebarHooks.push(({ extra }) => {
    const active = getRoute().type === 'completed';
    extra.before(h('button', {
      class: `nav-item${active ? ' active' : ''}`, type: 'button', 'aria-current': active ? 'page' : null, dataset: { fk: 'nav-completed' },
      onclick: () => handlers.navigate({ type: 'completed' }),
    }, icon('completed'), h('span', { class: 'nav-label' }, t('nav.completed'))));
  });

  viewHooks.completed = (ctx) => {
    const { view, route, today, me, rows, group, emptyState } = ctx;
    const projectId = route.id && view.projects.has(route.id) ? route.id : null;
    const userId = me?.id ?? null;
    const all = completedTasks(view, { projectId, query: state.query, userId });
    const { groups, shown, total } = completedGroups(all, { limit: state.limit });
    const withCounts = completedProjects(view, { userId });

    search.placeholder = t('completed.searchPlaceholder');
    search.setAttribute('aria-label', t('completed.searchLabel'));
    if (search.value !== state.query) search.value = state.query;

    const select = h('select', {
      class: 'field', 'aria-label': t('completed.project'), dataset: { fk: 'completed-project' },
      onchange: (e) => { state.limit = PAGE; handlers.navigate(e.target.value ? { type: 'completed', id: e.target.value } : { type: 'completed' }); },
    },
    h('option', { value: '' }, t('completed.allProjects')),
    withCounts.map(({ project, count }) => h('option', { value: project.id, selected: project.id === projectId }, t('completed.projectOption', { name: project.name, count }))));
    // een project zonder voltooide taken blijft kiesbaar als het gekozen is
    if (projectId && !withCounts.some((x) => x.project.id === projectId)) {
      select.append(h('option', { value: projectId, selected: true }, t('completed.projectOption', { name: view.projects.get(projectId).name, count: 0 })));
    }

    const title = projectId ? `${t('nav.completed')} · ${view.projects.get(projectId).name}` : t('nav.completed');
    const nothingAtAll = !projectId && state.query.trim() === '' && all.length === 0;
    return {
      title,
      count: total,
      lead: icon('completed'),
      actions: [],
      nodes: [
        h('div', { class: 'completed-tools' }, select, search),
        h('p', { class: 'hint completed-note' }, t('completed.note')),
        ...groups.map((g) => group({
          title: g.day ? formatDayHeading(g.day, today) : t('completed.unknownDay'),
          rows: rows(g.tasks.map((task) => ({ task })), !projectId, 'completed'),
          total: g.tasks.length,
        })),
        shown < total && h('button', {
          class: 'button', type: 'button', dataset: { fk: 'completed-more' },
          onclick: () => { state.limit += PAGE; handlers.refresh(); },
        }, t('completed.more', { shown, total })),
        total === 0 && emptyState(nothingAtAll ? { title: t('completed.emptyTitle'), text: t('completed.empty') } : { title: t('completed.noMatch') }),
      ],
    };
  };
}
