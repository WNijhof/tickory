// Het overzicht "Voltooid": alle afgevinkte taken, nieuwste eerst, per dag van afvinken, voor alle projecten of één project, met zoeken en
// een knop om een taak terug te zetten. De logica (welke taken, groeperen per dag) staat in core/completed.js; dit bestand tekent en
// haakt aan via `sidebarHooks` (de regel onder Binnenkort) en `viewHooks.completed` (zie ui/render.js). De route is
// `{ type: 'completed' }` of `{ type: 'completed', id: <project> }`.
//
// Het scherm tekent maar een deel van de lijst (`PAGE` taken, daarna "Meer tonen"): een lijst van duizenden voltooide taken blijft zo vlot.

import { completedGroups, completedProjects, completedTasks, completedTime, mergeCompleted, recurringEntries } from '../core/completed.js';
import { renderInline } from './markdown.js';
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
 *   header?: (ctx: { view: object, today: string }) => Node | null,
 * }} options `header`: een kop boven de lijst bij alle projecten (de cijfers van ui/productivity.js)
 */
export function installCompleted({ store, handlers, getRoute, header = null, api = null }) {
  const state = { query: '', limit: PAGE };
  // De afvinkingen van terugkerende taken komen van de server; hooguit eens per minuut opnieuw gevraagd, en opnieuw na een afvinking.
  const recurring = { entries: [], at: 0, loading: false, mark: '' };
  const markOf = () => [...store.view.tasks.values()].reduce((sum, t) => sum + (t.completed_count ?? 0), 0);
  function fetchRecurring() {
    if (!api?.recurringCompleted || recurring.loading) return;
    const fresh = Date.now() - recurring.at < 60_000 && recurring.mark === String(markOf());
    if (fresh) return;
    recurring.loading = true;
    recurring.mark = String(markOf());
    api.recurringCompleted({ days: 90 })
      .then((answer) => { recurring.entries = Array.isArray(answer?.entries) ? answer.entries : []; })
      .catch(() => { /* zonder verbinding: wat er al was */ })
      .finally(() => {
        recurring.loading = false;
        recurring.at = Date.now();
        if (getRoute().type === 'completed') handlers.refresh();
      });
  }

  /** Een regel voor een afvinking van een terugkerende taak: geen eigen taak (die staat nog open), een klik opent de taak zelf. */
  const recurringRow = (e, showProject) => {
    const task = store.view.tasks.get(e.task_id);
    const project = store.view.projects.get(e.project_id);
    // geen `task`: het is geen taak om te kiezen of te tellen (selecteren, Ctrl+A), alleen een regel met dezelfde opmaak
    return h('li', { class: 'task-recurring-done', dataset: { fk: `recurring-done:${e.id}` } },
      h('span', { class: 'check task-done check-static', 'aria-hidden': 'true' }),
      h('div', { class: 'task-content' },
        h('button', {
          type: 'button', class: 'task-body', disabled: !task, onclick: () => task && handlers.open?.(task),
          'aria-label': t('completed.recurringLabel', { name: e.title }),
        }, h('span', { class: 'task-title' }, ...renderInline(e.title, { links: false }))),
        h('div', { class: 'task-meta' },
          h('span', { class: 'chip chip-repeat' }, icon('repeat'), t('completed.recurringChip')),
          h('span', { class: 'chip chip-completed' }, icon('check'), t('completed.at', { time: completedTime(e.at) })))),
      showProject && project && h('span', { class: 'chip chip-project' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'chip-project-name' }, project.name)));
  };
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
    fetchRecurring();
    const all = mergeCompleted(completedTasks(view, { projectId, query: state.query, userId }), recurringEntries(view, recurring.entries, { projectId, query: state.query }));
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
        !projectId && header && header({ view, today }),
        h('div', { class: 'completed-tools' }, select, search),
        h('p', { class: 'hint completed-note' }, t('completed.note')),
        ...groups.map((g) => group({
          title: g.day ? formatDayHeading(g.day, today) : t('completed.unknownDay'),
          // gewone afgevinkte taken als regel; een afvinking van een terugkerende taak als eigen regel ertussen
          rows: g.tasks.flatMap((x) => (x.recurring ? [recurringRow(x, !projectId)] : rows([{ task: x }], !projectId, 'completed'))),
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
