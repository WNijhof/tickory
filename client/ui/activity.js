// Het scherm "Activiteit" van een project (route `activity`, via het projectmenu): wie wat deed en wanneer, per dag, met links naar
// de taken, "Meer laden" en een filter op soort. app.js roept `installActivity` één keer aan; dit bestand haakt aan via `viewHooks`
// (zie render.js). De lijst en de teksten staan in core/activity.js; de gegevens komen van de server (server/activity.ts) of de demo.
// Zonder verbinding toont het scherm wat al geladen was, en anders dat er een verbinding nodig is.

import { ACTIVITY_FILTERS, createActivityFeed, describeEntry, groupByDay } from '../core/activity.js';
import { formatDayHeading, todayString } from '../core/format.js';
import { t } from '../core/i18n.js';
import { initials } from '../core/rowModel.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { dot, viewHooks } from './render.js';

const FILTER_LABEL = {
  all: () => t('activity.filter.all'), tasks: () => t('activity.filter.tasks'), sections: () => t('activity.filter.sections'),
  comments: () => t('activity.filter.comments'), attachments: () => t('activity.filter.attachments'), members: () => t('activity.filter.members'),
  project: () => t('activity.filter.project'),
};

/**
 * @param {{
 *   store: import('../core/store.js').Store, api: { activity: (projectId: string, q: object) => Promise<object> },
 *   handlers: object, navigate: (route: object) => void, getRoute: () => object,
 * }} options
 */
export function installActivity({ store, api, handlers, navigate, getRoute }) {
  const feed = createActivityFeed({ fetchPage: (projectId, q) => api.activity(projectId, q), onChange: () => queueMicrotask(() => { if (getRoute().type === 'activity') handlers.refresh(); }) });
  /** Het gekozen filter per project (alleen in deze pagina). */
  const filters = new Map();
  const filterOf = (projectId) => filters.get(projectId) ?? 'all';
  let lastRefresh = 0;

  const open = (project) => {
    navigate({ type: 'activity', id: project.id });
    lastRefresh = Date.now();
    feed.refresh(project.id, filterOf(project.id));
  };

  // Na een sync (ook van iemand anders, via het live-signaal) kan er iets bij zijn gekomen: de nieuwste pagina opnieuw, niet te vaak.
  let timer = null;
  store.subscribe(() => {
    const route = getRoute();
    // wat je niet meer ziet (verlaten, eruit gehaald, verwijderd), vergeet de app meteen, ook wat al geladen was
    for (const id of feed.projects()) if (store.ready && store.view.projects.size > 0 && !store.view.projects.has(id)) feed.forget(id);
    if (route.type !== 'activity' || !store.view.projects.has(route.id) || timer) return;
    timer = setTimeout(() => {
      timer = null;
      const now = getRoute();
      if (now.type !== 'activity' || Date.now() - lastRefresh < 5000) return;
      lastRefresh = Date.now();
      feed.refresh(now.id, filterOf(now.id));
    }, 1500);
  });

  const entryRow = (item) => h('li', { class: 'activity-item', dataset: { id: item.id } },
    h('span', { class: 'inbox-avatar activity-avatar', 'aria-hidden': 'true' }, initials(item.actor)),
    h('span', { class: 'activity-body' },
      h('span', { class: 'activity-sentence' }, item.sentence),
      item.title && (item.taskId
        ? h('button', { class: 'link-button activity-title', type: 'button', dataset: { fk: `activity:${item.id}` }, onclick: () => { const task = store.view.tasks.get(item.taskId); if (task) handlers.open(task); } }, item.title)
        : h('span', { class: 'activity-title activity-title-plain' }, item.title, item.gone && h('span', { class: 'activity-gone' }, ` · ${t('activity.notHere')}`))),
      h('time', { class: 'activity-time', dateTime: item.at }, item.time)));

  viewHooks.activity = ({ view, route, emptyState }) => {
    const project = view.projects.get(route.id);
    if (!project) {
      feed.forget(route.id);
      return { title: t('activity.title'), count: null, lead: icon('history'), actions: [], nodes: [emptyState({ title: t('view.projectGone') })] };
    }
    const filter = filterOf(project.id);
    const list = feed.get(project.id, filter);
    if (!list.loaded && !list.loading && !list.error) feed.refresh(project.id, filter); // eerste keer (bijvoorbeeld na herladen)
    const today = todayString();
    const items = list.entries.map((e) => describeEntry(e, { view, projectId: project.id, userName: (id) => store.userName(id) }));
    const select = h('select', {
      class: 'field field-small', 'aria-label': t('activity.filterLabel'), dataset: { fk: 'activity-filter' },
      onchange: (e) => {
        filters.set(project.id, e.target.value);
        handlers.refresh();
        const next = feed.get(project.id, e.target.value);
        if (!next.loading) feed.refresh(project.id, e.target.value);
      },
    }, ACTIVITY_FILTERS.map((f) => h('option', { value: f, selected: f === filter }, FILTER_LABEL[f]())));
    const status = list.error === 'NOT_FOUND' ? t('activity.noAccess')
      : list.error === 'OFFLINE' ? (list.loaded ? t('activity.offlineCached') : t('activity.offlineEmpty'))
        : list.error ? t('activity.failed')
          : list.loading && !list.loaded ? t('activity.loading') : '';
    return {
      title: t('activity.titleOf', { name: project.name }),
      count: null,
      lead: dot(project.color, 'dot-large'),
      actions: [
        h('button', { class: 'button button-small button-ghost', type: 'button', dataset: { fk: 'activity-back' }, onclick: () => navigate({ type: 'project', id: project.id }) },
          icon('chevronLeft'), h('span', { class: 'btn-label' }, t('activity.back'))),
        select,
        h('button', {
          class: 'button button-small', type: 'button', dataset: { fk: 'activity-refresh' }, disabled: list.loading,
          onclick: () => { lastRefresh = Date.now(); feed.refresh(project.id, filter); },
        }, t('activity.refresh')),
      ],
      nodes: [
        h('p', { class: `hint activity-status${list.error ? ' hint-bad' : ''}`, role: 'status' }, status),
        items.length > 0 && groupByDay(items).map((g) => h('section', { class: 'group activity-day' },
          h('div', { class: 'group-head' }, h('h2', { class: 'group-title' }, g.day ? formatDayHeading(g.day, today) : '')),
          h('ul', { class: 'activity-list' }, g.items.map(entryRow)))),
        items.length === 0 && list.loaded && !list.loading && emptyState({ title: t('activity.empty'), text: filter === 'all' ? t('activity.emptyText') : t('activity.emptyFiltered') }),
        list.next && h('button', {
          class: 'button activity-more', type: 'button', disabled: list.loading, dataset: { fk: 'activity-more' },
          onclick: () => feed.more(project.id, filter),
        }, list.loading ? t('activity.loading') : t('activity.more')),
      ],
    };
  };

  return { open, feed };
}
