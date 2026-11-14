// Bouwt de zichtbare onderdelen uit de lokale toestand: de zijbalk, de kop en de takenlijst.
// Geen eigen toestand behalve een bewaarplaats met getekende regels (zie `rowCache`); elke wijziging in de opslag tekent het
// scherm opnieuw, en een regel waarvan de gegevens niet veranderden wordt hergebruikt in plaats van opnieuw gebouwd.
//
// AANHAKEN VOOR LATERE ONDERDELEN (zoeken, filters, labels): de zijbalk heeft twee lege plekken met een vaste id, `#sidebar-search`
// (bovenaan, onder de knop "Taak toevoegen", voor een zoekveld of zoekknop) en `#sidebar-extra` (direct onder Binnenkort en vóór
// Favorieten, voor Filters en Labels). `sidebar()` maakt de plekken bij elke keer tekenen opnieuw leeg aan; een onderdeel dat er iets
// in zet, meldt zich één keer aan met `sidebarHooks.push(({ search, extra }) => { … })`. app.js roept elke aangemelde functie aan
// direct nadat de zijbalk is getekend, met de twee plekken als argument. In de kop van de pagina is `#topbar-tools` (index.html)
// de plek voor een zoekveld in het midden; die is vast en wordt niet opnieuw getekend.
//
// WEERGAVEN (bord en kalender): `mainView` kiest bij een project op `project.view_style` ('list' | 'board' | 'calendar', zie
// core/projectViews.js) en bij Binnenkort op een voorkeur van dit apparaat. Het bord staat in ui/board.js en de kalender in
// ui/calendar.js; beide krijgen hun gegevens en handelingen mee en hebben zelf geen toestand in de opslag. Een kaart op het bord is
// dezelfde regel als in de lijst (`buildRow`, met de variant 'card'), zodat afvinken en openen via `bindList` hetzelfde werken.

import { isInboxId } from '../../shared/schema.js';
import {
  archivedList, commentCounts, counts, favoriteProjects, foldRows, isArchivedProject, isShared, membersOf, navProjects, projectCommentCount, projectView,
  roleIn, subtaskCounts, tasksWithReminder, todayView, upcomingView,
} from '../core/selectors.js';
import { formatDayHeading } from '../core/format.js';
import { colorClass } from '../core/colors.js';
import { rowModel } from '../core/rowModel.js';
import { t } from '../core/i18n.js';
import { VIEW_STYLES, boardColumns, viewStyleOf } from '../core/projectViews.js';
import { h } from './dom.js';
import { emptyArt, icon } from './icons.js';
import { boardView } from './board.js';
import { calendarView } from './calendar.js';
import { upcomingStyle, viewSwitch } from './viewSwitch.js';

const sameRoute = (a, b) => a.type === b.type && (a.id ?? null) === (b.id ?? null);

/** Functies die na elke keer tekenen van de zijbalk de plekken `{ search, extra }` mogen vullen (zie bovenaan). */
export const sidebarHooks = [];

/**
 * Eigen schermen voor een soort route (`route.type`): `viewHooks.filter = (ctx) => ({ title, count, lead, actions, nodes })`.
 * `ctx` heeft view, route, today, now, me, userName, handlers en de hulpmiddelen `rows(lijst, toonProject)`, `group` en `emptyState`.
 */
export const viewHooks = {};

/** Het gekleurde bolletje van een project of label. */
export const dot = (color, extra = '') => h('span', { class: `dot ${colorClass(color)}${extra ? ` ${extra}` : ''}`, 'aria-hidden': 'true' });

// ---------- zijbalk ----------

export function sidebar({ view, today, route, handlers, me = null }) {
  const n = counts(view, today);
  const countOf = (count) => count > 0 && h('span', { class: 'nav-count' }, String(count));
  const item = ({ target, label, lead, count = 0, shared = false, fk, list = null }) => {
    const active = sameRoute(route, target);
    // `list` (inbox, favorite of tree) maakt van een project een plek om op te slepen en iets om te slepen (ui/dragdrop.js)
    return h('button', {
      class: `nav-item${active ? ' active' : ''}`, type: 'button', 'aria-current': active ? 'page' : null, dataset: { fk, ...(list ? { projectId: target.id, list } : {}) },
      onclick: () => handlers.navigate(target),
    },
    lead,
    h('span', { class: 'nav-label' }, label),
    shared && h('span', { class: 'nav-shared', title: t('nav.sharedProject'), role: 'img', 'aria-label': t('nav.sharedProjectLabel') }, icon('users')),
    countOf(count));
  };
  const projectItem = (project, extra = {}) => item({
    target: { type: 'project', id: project.id }, label: project.name, lead: dot(project.color), count: n.perProject.get(project.id) ?? 0,
    shared: isShared(view, project.id), ...extra,
  });
  const inbox = view.projects.get(me?.inbox_project_id) ?? [...view.projects.values()].find((p) => isInboxId(p.id));
  const favorites = favoriteProjects(view);
  const archivedCount = archivedList(view).length;

  return [
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('check')), h('span', { class: 'brand-name' }, 'Tickory')),
    h('button', { class: 'sidebar-add', type: 'button', 'aria-keyshortcuts': 'q', onclick: () => handlers.quickAdd() }, h('span', { class: 'sidebar-add-plus', 'aria-hidden': 'true' }, icon('plus')), t('quick.addTask')),
    h('div', { id: 'sidebar-search', class: 'sidebar-slot' }),
    h('nav', { class: 'nav', 'aria-label': t('nav.views') },
      inbox && item({ target: { type: 'project', id: inbox.id }, label: inbox.name, lead: icon('inbox'), count: n.perProject.get(inbox.id) ?? 0, fk: 'nav-inbox', list: 'inbox' }),
      item({ target: { type: 'today' }, label: t('nav.today'), lead: icon('today'), count: n.today, fk: 'nav-today' }),
      item({ target: { type: 'upcoming' }, label: t('nav.upcoming'), lead: icon('upcoming'), fk: 'nav-upcoming' }),
      h('div', { id: 'sidebar-extra', class: 'sidebar-slot' }),
      favorites.length > 0 && [
        h('div', { class: 'nav-heading' }, h('span', {}, t('nav.favorites'))),
        favorites.map((p) => projectItem(p, { fk: `fav:${p.id}`, list: 'favorite' })),
      ],
      h('div', { class: 'nav-heading', dataset: { dropTop: '1' } },
        h('span', {}, t('nav.projects')),
        h('div', { class: 'nav-heading-buttons' },
          h('button', { class: 'icon-button', type: 'button', 'aria-label': t('nav.addProject'), title: t('nav.addProject'), onclick: () => handlers.addProject() }, icon('plus')),
          h('button', { class: 'icon-button', type: 'button', 'aria-label': t('template.menu.fromTemplate'), title: t('template.menu.fromTemplate'), dataset: { fk: 'nav-from-template' }, onclick: () => handlers.projectFromTemplate() }, icon('template')))),
      navProjects(view).map(({ project, depth, hasChildren, collapsed }) => h('div', { class: 'nav-row', dataset: { depth: String(Math.min(depth, 3)), hasChildren: String(hasChildren && !collapsed) } },
        hasChildren
          ? h('button', {
            class: 'nav-toggle', type: 'button', 'aria-expanded': String(!collapsed), dataset: { fk: `toggle:${project.id}` },
            'aria-label': collapsed ? t('nav.expand', { name: project.name }) : t('nav.collapse', { name: project.name }),
            onclick: () => handlers.toggleProject(project),
          }, icon(collapsed ? 'chevronRight' : 'chevronDown'))
          : h('span', { class: 'nav-toggle nav-toggle-empty', 'aria-hidden': 'true' }),
        projectItem(project, { fk: `project:${project.id}`, list: 'tree' }))),
      archivedCount > 0 && h('button', { class: 'nav-link', type: 'button', onclick: handlers.showArchive }, icon('archive'), t('nav.archived')),
    ),
    h('div', { class: 'sidebar-footer' },
      h('button', { class: 'nav-item', type: 'button', onclick: handlers.settings },
        h('span', { class: 'nav-avatar', 'aria-hidden': 'true' }, me ? initialsOf(me.name) : icon('settings')),
        h('span', { class: 'nav-stack' },
          h('span', { class: 'nav-label' }, me ? me.name : t('settings.title')),
          me && h('span', { class: 'nav-count' }, t('settings.title')))),
      h('button', { class: 'icon-button', type: 'button', 'aria-label': t('shortcuts.open'), title: t('shortcuts.open'), 'aria-keyshortcuts': '?', onclick: handlers.shortcuts }, icon('keyboard'))),
  ];
}

const initialsOf = (name) => [...String(name ?? '?').trim()][0]?.toLocaleUpperCase() ?? '?';

// ---------- takenlijst ----------

/**
 * Getekende regels, per taak-id: { json (de gegevens waarmee ze getekend is), node, task (de nieuwste taak, voor de knoppen), model }.
 * De regels zelf hebben geen eigen gebeurtenissen: `bindList` luistert één keer op de hele lijst (zie hieronder). Dat scheelt bij
 * duizenden taken veel tijd bij het tekenen.
 */
let rowCache = new Map();

/** Een element maken zonder omwegen (voor de regels, waar het om snelheid gaat). */
function mk(tag, cls, ...kids) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

/** Een knop in een regel; `act` zegt `bindList` wat er bij een klik moet gebeuren. */
function rowButton(cls, act, ...kids) {
  const el = mk('button', cls, ...kids);
  el.type = 'button';
  el.dataset.act = act;
  return el;
}

/** Maakt de regel van één taak uit zijn gegevens (zie core/rowModel.js). */
function buildRow(m, variant = '') {
  const card = variant === 'card';
  const li = mk('li', `task prio-${m.priority}${m.done ? ' task-done' : ''}${m.depth > 0 ? ' task-sub' : ''}${card ? ' task-card' : ''}`);
  li.dataset.id = m.id;
  li.dataset.depth = String(m.depth);
  if (card) li.dataset.taskId = m.id; // aanhaakpunt voor slepen: zie de lijst bovenaan ui/board.js

  const check = rowButton('check', 'check');
  check.dataset.fk = `check:${m.id}`;
  check.setAttribute('aria-pressed', String(m.done));
  check.setAttribute('aria-label', m.done ? t('task.reopenLabel', { name: m.content }) : t('task.completeLabel', { name: m.content }));

  const chips = [];
  const chip = (cls, ...kids) => mk('span', `chip ${cls}`, ...kids);
  if (m.due) chips.push(chip(`chip-due due-${m.due.status}`, icon('calendar'), m.due.text)); // bij een herhaling staat ↻ al in de tekst
  if (m.duration) chips.push(chip('chip-duration', icon('clock'), m.duration.text));
  if (m.deadline) chips.push(chip(`chip-deadline${m.deadline.overdue ? ' due-overdue' : ''}`, m.deadline.text));
  if (m.subtasks) {
    const body = [icon('subtasks'), m.subtasks.text];
    if (m.hasChildren || m.collapsed) {
      const toggle = rowButton('chip chip-subtasks chip-toggle', 'fold', ...body, icon(m.collapsed ? 'chevronRight' : 'chevronDown'));
      toggle.dataset.fk = `fold:${m.id}`;
      toggle.setAttribute('aria-expanded', String(!m.collapsed));
      toggle.setAttribute('aria-label', m.subtasks.label);
      toggle.title = m.subtasks.label;
      chips.push(toggle);
    } else {
      const plain = chip('chip-subtasks', ...body);
      plain.title = m.subtasks.label;
      chips.push(plain);
    }
  }
  if (m.comments) {
    const c = chip('chip-comments', icon('comment'), String(m.comments.count));
    c.title = m.comments.label;
    chips.push(c);
  }
  for (const label of m.labels) {
    // een knop: het label openen toont alle taken met dat label
    const open = rowButton(`chip chip-label ${colorClass(label.color)}`, 'label', `@${label.name}`);
    open.dataset.label = label.id;
    open.title = t('label.openLabel', { name: label.name });
    chips.push(open);
  }
  if (m.bell) {
    const bell = chip('chip-bell', '🔔');
    bell.title = t('reminder.bell');
    bell.setAttribute('role', 'img');
    bell.setAttribute('aria-label', t('reminder.bell'));
    chips.push(bell);
  }
  if (m.assignee) {
    const who = chip(`chip-assignee${m.assignee.mine ? ' chip-mine' : ''}`, m.assignee.text);
    who.title = m.assignee.title;
    who.dataset.initials = m.assignee.initials;
    chips.push(who);
  }

  const body = rowButton('task-body', 'open', mk('span', 'task-title', m.content), m.description ? mk('span', 'task-desc', m.description) : null);
  body.dataset.fk = `open:${m.id}`; // zodat de toetsenbordfocus terugkomt na verplaatsen (ui/dragdrop.js)
  li.append(check, mk('div', 'task-content', body, chips.length > 0 ? mk('div', 'task-meta', ...chips) : null));
  li.append(mk('span', 'drag-handle')); // handvat om te slepen; zichtbaar in lijsten waar dat kan (dnd.css), zie ui/dragdrop.js
  if (m.project) li.append(mk('span', 'chip chip-project', dot(m.project.color), mk('span', 'chip-project-name', m.project.name)));
  if (card) {
    // Op een telefoon verdwijnen de snelle knoppen (er is geen aanwijzer); dit menu blijft dus altijd zichtbaar.
    const move = rowButton('icon-button card-move', 'move', icon('move'));
    move.dataset.fk = `move:${m.id}`;
    move.setAttribute('aria-label', t('board.moveLabel', { name: m.content }));
    move.title = t('board.move');
    li.append(move);
  }
  return li;
}

/** De snelle knoppen (bewerken, dag kiezen, verwijderen) van een regel; ze worden pas gemaakt als je de regel aanwijst of er met het toetsenbord in komt. */
function ensureActions(li, model) {
  if (li.querySelector('.task-actions')) return;
  const make = (act, iconName, label, title) => {
    const b = rowButton('icon-button', act, icon(iconName));
    b.setAttribute('aria-label', label);
    b.title = title;
    return b;
  };
  li.append(mk('span', 'task-actions',
    make('edit', 'pencil', t('task.actionEdit', { name: model.content }), t('task.edit')),
    make('date', 'calendar', t('task.actionDate', { name: model.content }), t('task.actionDateTitle')),
    make('delete', 'trash', t('task.actionDelete', { name: model.content }), t('common.delete'))));
}

/**
 * Koppelt het gedrag van de takenlijst (afvinken, openen, in- en uitklappen, snelle knoppen) aan de vaste houder van de lijst.
 * Eén keer aanroepen; werkt voor alle regels, ook de latere.
 * @param {HTMLElement} container
 */
export function bindList(container, handlers) {
  const rowOf = (target) => {
    const li = target.closest?.('li.task');
    const entry = li ? rowCache.get(li.dataset.id) : null;
    return entry ? { li, entry } : null;
  };
  container.addEventListener('click', (e) => {
    const hit = rowOf(e.target);
    if (!hit) return;
    const { li, entry } = hit;
    const control = e.target.closest('[data-act]');
    const act = control?.dataset.act;
    const task = entry.task;
    if (act === 'check') {
      if (entry.model.done || li.classList.contains('task-completing')) {
        handlers.toggle(task);
        return;
      }
      // een korte animatie voordat de taak uit de lijst verdwijnt (niet bij "minder beweging")
      if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        handlers.toggle(task);
        return;
      }
      li.classList.add('task-completing');
      control.setAttribute('aria-pressed', 'true');
      setTimeout(() => handlers.toggle(rowCache.get(li.dataset.id)?.task ?? task), 280);
      return;
    }
    if (act === 'label') handlers.openLabel?.(control.dataset.label);
    else if (act === 'fold') handlers.toggleTask(task);
    else if (act === 'move') handlers.moveCard(task);
    else if (act === 'date') handlers.reschedule(task);
    else if (act === 'delete') handlers.removeTask(task);
    else if (act || !e.target.closest('button, a')) handlers.open(task); // "open", "edit", of een klik op de regel zelf
  });
  const reveal = (e) => {
    const hit = rowOf(e.target);
    if (hit) ensureActions(hit.li, hit.entry.model);
  };
  container.addEventListener('mouseover', reveal);
  container.addEventListener('focusin', reveal);
}

/** Zet getekende regels in een lijst en bewaart ze voor de volgende keer. `pool` verzamelt wat nu in gebruik is. */
function rowsOf(list, pool, ctx) {
  return list.map(({ task, depth = 0, hasChildren = false, collapsed = false }) => {
    const model = rowModel(task, { ...ctx, depth, hasChildren, collapsed, reminder: ctx.reminders.has(task.id) });
    const json = ctx.variant ? `${ctx.variant}|${JSON.stringify(model)}` : JSON.stringify(model);
    if (pool.has(task.id)) return buildRow(model, ctx.variant); // dezelfde taak staat al in beeld (twee lijsten van een filter): een eigen regel
    let entry = rowCache.get(task.id);
    if (entry && entry.json === json) {
      entry.task = task;
    } else {
      entry = { json, task, model, node: buildRow(model, ctx.variant) };
    }
    pool.set(task.id, entry);
    return entry.node;
  });
}

/** Vergeet alle getekende regels. */
export function resetRowCache() {
  rowCache = new Map();
}

// ---------- groepen, lege staat en kop ----------

const count = (n) => h('span', { class: 'group-count' }, String(n));

export function group({ title, rows, total, collapsible = null, extra = null, footer = null, drop = null }) {
  const head = title && h('div', { class: 'group-head' },
    collapsible && h('button', {
      class: 'group-toggle', type: 'button', 'aria-expanded': String(!collapsible.collapsed), dataset: { fk: collapsible.fk },
      'aria-label': collapsible.collapsed ? t('section.expand', { name: title }) : t('section.collapse', { name: title }), onclick: collapsible.toggle,
    }, icon(collapsible.collapsed ? 'chevronRight' : 'chevronDown')),
    h('h2', { class: 'group-title' }, title),
    total > 0 && count(total),
    extra);
  const collapsed = collapsible?.collapsed;
  // `drop`: hier kunnen taken heen gesleept worden (project en sectie), zie ui/dragdrop.js
  return h('section', { class: `group${collapsed ? ' group-collapsed' : ''}`, dataset: drop ? { dropProject: drop.projectId, dropSection: drop.sectionId ?? '' } : {} },
    head,
    !collapsed && rows.length > 0 && h('ul', { class: 'tasks' }, rows),
    !collapsed && footer);
}

export function emptyState({ title, text, action = null }) {
  return h('div', { class: 'empty' }, emptyArt(), h('p', { class: 'empty-title' }, title), text && h('p', { class: 'empty-text' }, text), action);
}

/** "Gedeeld met Anna en Bob", of niets als het project van jou alleen is. */
function sharedWith(view, projectId, me, userName) {
  const others = membersOf(view, projectId).filter((m) => m.user_id !== me?.id).map((m) => userName(m.user_id) ?? t('common.someone'));
  if (others.length === 0) return null;
  const names = others.length === 1 ? others[0] : t('common.listAnd', { first: others.slice(0, -1).join(', '), last: others[others.length - 1] });
  return h('p', { class: 'hint shared-with' }, t('share.sharedWith', { names }), roleIn(view, projectId, me?.id) === 'owner' ? '' : ` · ${t('share.youAreMember')}`);
}

const addInline = (handlers, target, label = t('quick.addTask')) =>
  h('button', { class: 'add-inline', type: 'button', onclick: () => handlers.quickAdd(target) }, icon('plus'), label);

/**
 * @returns {{ title: string, count: number | null, lead: Node | null, actions: Node[], nodes: Node[] }}
 */
export function mainView({ view, route, today, now, showCompleted, handlers, me = null, userName = () => null }) {
  const pool = new Map();
  const ctx = { view, today, now, me, userName, subtasks: subtaskCounts(view), comments: commentCounts(view), reminders: tasksWithReminder(view, me?.id) };
  const rows = (list, showProject, variant = '') => rowsOf(list, pool, { ...ctx, showProject, variant });
  const finish = (result) => {
    rowCache = pool; // alleen wat nu in beeld is, blijft bewaard
    return result;
  };

  if (Object.hasOwn(viewHooks, route.type)) {
    return finish(viewHooks[route.type]({ view, route, today, now, me, userName, handlers, rows, group, emptyState }));
  }

  if (route.type === 'today') {
    const list = todayView(view, today);
    const total = list.overdue.length + list.today.length;
    return finish({
      title: t('nav.today'),
      count: total,
      lead: icon('today'),
      actions: [],
      nodes: [
        list.overdue.length > 0 && group({ title: t('view.overdue'), rows: rows(list.overdue.map((task) => ({ task })), true), total: list.overdue.length }),
        group({
          title: formatDayHeading(today, today), rows: rows(list.today.map((task) => ({ task })), true), total: list.today.length,
          footer: addInline(handlers, { due: 'today' }),
        }),
        total === 0 && emptyState({ title: t('view.todayEmptyTitle'), text: t('view.todayEmpty') }),
      ],
    });
  }

  if (route.type === 'upcoming') {
    const style = upcomingStyle();
    const switcher = viewSwitch({ styles: ['list', 'calendar'], current: style, onChange: (next) => handlers.setUpcomingStyle(next) });
    if (style === 'calendar') {
      return finish({
        title: t('nav.upcoming'), count: null, lead: icon('upcoming'), actions: [switcher],
        nodes: [calendarView({ calendarKey: 'upcoming', tasks: [...view.tasks.values()], view, today, handlers, showProject: true, addTarget: {} })],
      });
    }
    const days = upcomingView(view, today);
    return finish({
      title: t('nav.upcoming'),
      count: days.reduce((sum, d) => sum + d.tasks.length, 0),
      lead: icon('upcoming'),
      actions: [switcher],
      nodes: days.length > 0
        ? days.map((d) => group({ title: formatDayHeading(d.date, today), rows: rows(d.tasks.map((task) => ({ task })), true), total: d.tasks.length }))
        : [emptyState({ title: t('view.upcomingEmptyTitle'), text: t('view.upcomingEmpty') })],
    });
  }

  const pv = projectView(view, route.id, { showCompleted });
  if (!pv) return finish({ title: t('view.projectTitle'), count: null, lead: null, actions: [], nodes: [emptyState({ title: t('view.projectGone') })] });
  const project = pv.project;
  const inbox = isInboxId(project.id);
  const open = pv.groups.reduce((sum, g) => sum + g.tasks.filter((x) => !x.task.checked).length, 0);
  const total = pv.groups.reduce((sum, g) => sum + g.tasks.length, 0);
  const comments = projectCommentCount(view, project.id);
  const headButton = (cls, iconName, label, onclick, extra = {}) => h('button', { class: `button button-small button-ghost ${cls}`, type: 'button', onclick, ...extra },
    icon(iconName), h('span', { class: 'btn-label' }, label));
  const style = viewStyleOf(project);
  const actions = [
    viewSwitch({ styles: VIEW_STYLES, current: style, onChange: (next) => handlers.setViewStyle(project, next) }),
    headButton('btn-comments', 'comment', comments > 0 ? t('comment.projectButtonCount', { count: comments }) : t('comment.projectButton'), () => handlers.projectComments(project), { 'aria-label': t('comment.projectButtonLabel', { count: comments }) }),
    !inbox && headButton('btn-share', 'users', isShared(view, project.id) ? t('project.shared') : t('project.share'), () => handlers.shareProject(project)),
    !inbox && headButton('btn-menu', 'more', t('project.menu'), () => handlers.projectMenu(project)),
  ];
  const archived = isArchivedProject(view, project.id);
  const addTarget = (section) => ({ projectId: project.id, sectionId: section?.id ?? null });
  const banner = archived && h('div', { class: 'banner', role: 'status' }, h('span', {}, t('project.archivedBanner')), h('button', { class: 'button button-small', type: 'button', onclick: () => handlers.restoreProject(project) }, t('project.restore')));
  if (style === 'board') {
    const board = boardColumns(view, project.id, { showCompleted });
    return finish({
      title: project.name, count: open, lead: inbox ? icon('inbox') : dot(project.color, 'dot-large'), actions,
      nodes: [
        banner,
        sharedWith(view, project.id, me, userName),
        boardView({ project, columns: board.columns, readOnly: archived, handlers, cards: (tasks) => rows(tasks.map((task) => ({ task })), false, 'card') }),
        pv.completedCount > 0 && h('button', { class: 'link-button', type: 'button', onclick: () => handlers.toggleCompleted(project.id) },
          showCompleted ? t('view.hideCompleted') : t('view.showCompleted', { count: pv.completedCount })),
      ],
    });
  }
  if (style === 'calendar') {
    return finish({
      title: project.name, count: open, lead: inbox ? icon('inbox') : dot(project.color, 'dot-large'), actions,
      nodes: [
        banner,
        sharedWith(view, project.id, me, userName),
        calendarView({
          calendarKey: `project:${project.id}`, tasks: [...view.tasks.values()].filter((x) => x.project_id === project.id), view, today, handlers,
          showProject: false, addTarget: { projectId: project.id }, readOnly: archived,
        }),
      ],
    });
  }
  const sectionGroups = pv.groups.map((g) => {
    const folded = foldRows(g.tasks);
    const items = rows(folded, false);
    if (!g.section) {
      return (folded.length > 0 || pv.groups.length > 1) && group({ title: null, rows: items, total: g.tasks.length, footer: !archived && addInline(handlers, addTarget(null)), drop: archived ? null : { projectId: project.id } });
    }
    const section = g.section;
    return group({
      title: section.name, rows: items, total: g.tasks.length,
      collapsible: { collapsed: Boolean(section.is_collapsed), fk: `section:${section.id}`, toggle: () => handlers.toggleSection(section) },
      extra: h('button', { class: 'icon-button group-more', type: 'button', 'aria-label': t('section.editLabel', { name: section.name }), title: t('section.editLabel', { name: section.name }), onclick: () => handlers.sectionMenu(section) }, icon('more')),
      footer: !archived && addInline(handlers, addTarget(section)),
      drop: archived ? null : { projectId: project.id, sectionId: section.id },
    });
  });
  return finish({
    title: project.name,
    count: open,
    lead: inbox ? icon('inbox') : dot(project.color, 'dot-large'),
    actions,
    nodes: [
      banner,
      sharedWith(view, project.id, me, userName),
      ...sectionGroups,
      total === 0 && pv.groups.length === 1 && emptyState({
        title: t('view.projectEmptyTitle'), text: t('view.projectEmpty'), action: archived ? null : h('button', { class: 'button button-primary', type: 'button', onclick: () => handlers.quickAdd(addTarget(null)) }, t('quick.addTask')),
      }),
      !archived && h('div', { class: 'toolbar' },
        h('button', { class: 'button button-small button-ghost', type: 'button', onclick: () => handlers.addSection(project) }, icon('plus'), t('section.add'))),
      pv.completedCount > 0 && h('button', { class: 'link-button', type: 'button', onclick: () => handlers.toggleCompleted(project.id) },
        showCompleted ? t('view.hideCompleted') : t('view.showCompleted', { count: pv.completedCount })),
    ],
  });
}
