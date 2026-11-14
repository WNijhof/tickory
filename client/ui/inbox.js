// "Meldingen": wat anderen in gedeelde projecten deden (toegewezen, gereageerd, genoemd, afgevinkt, toegevoegd aan een project).
// app.js roept `installInbox` één keer aan; verder haakt dit bestand aan via de plekken die render.js biedt: een regel
// "Meldingen" met het aantal ongelezen in de zijbalk (`sidebarHooks`), een eigen scherm voor de route `notifications`
// (`viewHooks`), en een belletje in de kop op een telefoon (waar de zijbalk een schuifmenu is). Een tik op een melding zet
// haar op gelezen en opent de taak of het project. `#notification=<id>` (een pushmelding of de Android-app) doet hetzelfde.
// De lijst zelf staat in core/inbox.js; de gegevens komen van de server (zie server/notify.ts).

import { inboxItems, inboxSentence, newestAt, unreadCount } from '../core/inbox.js';
import { t } from '../core/i18n.js';
import { mentionParts } from '../core/mentions.js';
import { initials } from '../core/rowModel.js';
import { isShared } from '../core/selectors.js';
import { timeAgo } from '../core/timeAgo.js';
import { h, iconButton } from './dom.js';
import { icon } from './icons.js';
import { sidebarHooks, viewHooks } from './render.js';

const ROUTE = { type: 'notifications' };
const HASH = /^#notification=([A-Za-z0-9_-]{8,40})$/;

/** Het id van een melding uit het adres (`#notification=<id>`), of null. */
export const notificationIdFromHash = (hash) => HASH.exec(hash ?? '')?.[1] ?? null;

/**
 * @param {{
 *   store: import('../core/store.js').Store, actions: object, handlers: object,
 *   navigate: (route: object) => void, getRoute: () => object,
 * }} options
 */
export function installInbox({ store, actions, handlers, navigate, getRoute }) {
  const items = () => (store.me ? inboxItems(store.view, { userId: store.userId, userName: (id) => store.userName(id) }) : []);
  /** Alleen tonen voor wie samenwerkt: een gedeeld project, of al eens een melding. */
  const relevant = () => Boolean(store.me) && ((store.view.notifications?.size ?? 0) > 0 || [...store.view.projects.keys()].some((id) => isShared(store.view, id)));
  const bellLabel = (count) => (count > 0 ? t('inbox.bellLabel', { count }) : t('inbox.title'));

  /** De melding in de browser (als die er nog staat) hoeft niet meer: je hebt hem in de app gelezen. */
  const closeShown = (ids) => {
    navigator.serviceWorker?.ready
      .then((reg) => reg.getNotifications?.())
      .then((list) => { for (const n of list ?? []) if (ids.includes(n.data?.notificationId)) n.close(); })
      .catch(() => {});
  };

  async function markRead(item, read = true) {
    if (item.read === read) return;
    await actions.markNotificationRead(item.id, read);
    if (read) closeShown([item.id]);
  }

  async function readAll() {
    const list = items();
    const unread = list.filter((x) => !x.read).map((x) => x.id);
    if (unread.length === 0) return;
    await actions.readAllNotifications(newestAt(list));
    closeShown(unread);
  }

  /** Een melding openen: gelezen, en naar de taak (het taakvenster) of het project (bij een opmerking: de opmerkingen erbij). */
  async function open(item) {
    await markRead(item);
    if (item.target.type === 'task') {
      const task = store.view.tasks.get(item.target.id);
      if (task) handlers.open(task);
      return;
    }
    const project = store.view.projects.get(item.target.id);
    if (!project) return;
    navigate({ type: 'project', id: project.id });
    if (item.kind === 'comment' || item.kind === 'mention') handlers.projectComments(project);
  }

  // ---------- het scherm ----------

  const excerpt = (item) => {
    if (!item.excerpt) return null;
    const parts = mentionParts(item.excerpt, item.comment?.mentions, (id) => (id === store.userId ? store.me?.name : store.userName(id)));
    return h('span', { class: 'inbox-excerpt' }, parts.map((p) => (p.mention ? h('span', { class: 'mention' }, p.text) : p.text)));
  };

  const row = (item) => h('li', { class: `inbox-item${item.read ? '' : ' unread'}`, dataset: { id: item.id, kind: item.kind } },
    h('button', { class: 'inbox-open', type: 'button', dataset: { fk: `inbox:${item.id}` }, onclick: () => open(item) },
      h('span', { class: 'inbox-avatar', 'aria-hidden': 'true' }, initials(item.actor)),
      h('span', { class: 'inbox-body' },
        h('span', { class: 'inbox-sentence' }, !item.read && h('span', { class: 'sr-only' }, `${t('inbox.unread')}: `), inboxSentence(item)),
        h('span', { class: 'inbox-title' }, item.title, item.project && h('span', { class: 'inbox-project' }, ` · ${item.project}`)),
        excerpt(item),
        h('time', { class: 'inbox-time', dateTime: item.at }, timeAgo(item.at)))),
    iconButton({
      name: item.read ? 'bell' : 'check', className: 'inbox-toggle',
      label: item.read ? t('inbox.markUnread', { title: item.title }) : t('inbox.markRead', { title: item.title }),
      onclick: () => markRead(item, !item.read),
      props: { dataset: { fk: `inbox-toggle:${item.id}` } },
    }));

  viewHooks.notifications = ({ emptyState }) => {
    const list = items();
    const unread = unreadCount(list);
    return {
      title: t('inbox.title'),
      count: null,
      lead: icon('bell'),
      actions: unread > 0 ? [h('button', { class: 'button button-small', type: 'button', dataset: { fk: 'inbox-read-all' }, onclick: readAll }, t('inbox.readAll'))] : [],
      nodes: [
        unread > 0 && h('p', { class: 'hint inbox-count', role: 'status' }, t('inbox.count', { count: unread })),
        list.length > 0
          ? h('ul', { class: 'inbox-list', 'aria-label': t('inbox.title') }, list.map(row))
          : emptyState({ title: t('inbox.empty'), text: t('inbox.emptyText') }),
      ],
    };
  };

  // ---------- de zijbalk en het belletje in de kop ----------

  sidebarHooks.push(({ extra }) => {
    if (!extra || !relevant()) return;
    const count = unreadCount(items());
    const active = getRoute().type === ROUTE.type;
    // vóór de plek van Filters en Labels (die tekent ui/find.js soms opnieuw), direct onder Binnenkort
    extra.before(h('button', {
      class: `nav-item${active ? ' active' : ''}`, type: 'button', 'aria-current': active ? 'page' : null, dataset: { fk: 'nav-notifications' },
      'aria-label': bellLabel(count), onclick: () => navigate(ROUTE),
    }, icon('bell'), h('span', { class: 'nav-label' }, t('inbox.title')), count > 0 && h('span', { class: 'nav-count nav-count-unread' }, String(count))));
  });

  const bell = h('button', { class: 'icon-button inbox-bell', type: 'button', hidden: true, onclick: () => navigate(ROUTE) }, icon('bell'), h('span', { class: 'inbox-badge', 'aria-hidden': 'true' }));
  const topbar = document.querySelector('.topbar');
  topbar?.insertBefore(bell, document.getElementById('sync-status'));
  const drawBell = () => {
    const count = unreadCount(items());
    bell.hidden = !relevant();
    bell.setAttribute('aria-label', bellLabel(count));
    bell.title = bellLabel(count);
    bell.lastChild.textContent = count > 99 ? '99+' : count > 0 ? String(count) : '';
  };
  store.subscribe(drawBell);
  drawBell();

  // ---------- openen vanuit een pushmelding of de Android-app ----------

  let pending = null;
  let pendingSince = 0;
  const openPending = () => {
    if (!pending) return;
    if (Date.now() - pendingSince > 30_000) {
      pending = null; // een melding die niet (meer) komt: opgeven
      return;
    }
    const item = items().find((x) => x.id === pending);
    if (!item || document.querySelector('dialog[open]')) return;
    pending = null;
    open(item);
  };
  const openById = (id) => {
    pending = id;
    pendingSince = Date.now();
    openPending();
  };
  const fromHash = () => {
    const id = notificationIdFromHash(location.hash);
    if (!id) return;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    openById(id);
  };
  store.subscribe(openPending);
  window.addEventListener('hashchange', fromHash);
  fromHash();
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open-notification' && typeof e.data.id === 'string') openById(e.data.id);
  });

  return { open, readAll, items };
}
