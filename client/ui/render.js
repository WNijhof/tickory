// Bouwt de zichtbare onderdelen uit de lokale toestand: de zijbalk en het hoofdscherm.
// Geen eigen toestand; elke wijziging in de opslag tekent het scherm opnieuw.

import { isInboxId } from '../../shared/schema.js';
import { counts, hasReminder, isShared, membersOf, projectList, projectView, roleIn, todayView, upcomingView } from '../core/selectors.js';
import { dueStatus, formatDate, formatDayHeading, formatDue } from '../core/format.js';
import { t } from '../core/i18n.js';
import { h } from './dom.js';

const sameRoute = (a, b) => a.type === b.type && (a.id ?? null) === (b.id ?? null);

export function sidebar({ view, today, route, handlers, me = null }) {
  const n = counts(view, today);
  const item = (target, label, count, depth = 0, shared = false) => {
    const active = sameRoute(route, target);
    return h('button', {
      class: `nav-item ${active ? 'active' : ''}`, type: 'button', dataset: { depth: String(Math.min(depth, 3)) },
      'aria-current': active ? 'page' : null, onclick: () => handlers.navigate(target),
    },
    h('span', { class: 'nav-label' }, label),
    shared && h('span', { class: 'nav-shared', title: t('nav.sharedProject'), role: 'img', 'aria-label': t('nav.sharedProjectLabel') }, '👥'),
    count > 0 && h('span', { class: 'nav-count' }, String(count)));
  };
  return [
    h('div', { class: 'brand' }, 'Tickory'),
    h('nav', { class: 'nav', 'aria-label': t('nav.views') },
      item({ type: 'today' }, t('nav.today'), n.today),
      item({ type: 'upcoming' }, t('nav.upcoming'), 0),
      h('div', { class: 'nav-heading' },
        h('span', {}, t('nav.projects')),
        h('button', { class: 'icon-button', type: 'button', 'aria-label': t('nav.addProject'), title: t('nav.addProject'), onclick: handlers.addProject }, '+')),
      projectList(view).map(({ project, depth }) => item({ type: 'project', id: project.id }, project.name, n.perProject.get(project.id) ?? 0, depth, isShared(view, project.id))),
    ),
    h('div', { class: 'sidebar-footer' },
      h('button', { class: 'nav-item', type: 'button', onclick: handlers.settings },
        h('span', { class: 'nav-label' }, me ? me.name : t('settings.title')),
        me && h('span', { class: 'nav-count' }, t('settings.title')))),
  ];
}

function taskRow(task, { view, today, now, depth = 0, showProject = false, handlers, me, userName }) {
  const meta = [];
  if (task.due) meta.push(h('span', { class: `chip chip-due due-${dueStatus(task.due, today, now)}` }, formatDue(task.due, today)));
  if (task.deadline) meta.push(h('span', { class: `chip chip-deadline ${task.deadline < today ? 'due-overdue' : ''}` }, t('task.deadlineChip', { date: formatDate(task.deadline, today) })));
  for (const id of task.labels ?? []) {
    const label = view.labels.get(id);
    if (label) meta.push(h('span', { class: 'chip chip-label' }, `@${label.name}`));
  }
  if (hasReminder(view, task.id, me?.id)) meta.push(h('span', { class: 'chip chip-bell', title: t('reminder.bell'), role: 'img', 'aria-label': t('reminder.bell') }, '🔔'));
  if (task.assignee_id) {
    const mine = task.assignee_id === me?.id;
    const name = mine ? t('task.assigneeYou') : userName(task.assignee_id) ?? t('common.someone');
    meta.push(h('span', { class: `chip chip-assignee${mine ? ' chip-mine' : ''}`, title: t('task.assigneeTitle', { name }) }, t('task.assigneeChip', { name })));
  }
  if (showProject) {
    const project = view.projects.get(task.project_id);
    const section = task.section_id ? view.sections.get(task.section_id) : null;
    if (project) meta.push(h('span', { class: 'chip chip-project' }, section ? `${project.name} / ${section.name}` : project.name));
  }
  if (task.description) meta.push(h('span', { class: 'chip chip-note', title: t('task.hasDescription') }, t('task.noteChip')));
  return h('li', { class: `task prio-${task.priority} ${task.checked ? 'task-done' : ''}`, dataset: { id: task.id, depth: String(Math.min(depth, 4)) } },
    h('button', {
      class: 'check', type: 'button', 'aria-pressed': String(Boolean(task.checked)),
      'aria-label': task.checked ? t('task.reopenLabel', { name: task.content }) : t('task.completeLabel', { name: task.content }), onclick: () => handlers.toggle(task),
    }),
    h('button', { class: 'task-body', type: 'button', onclick: () => handlers.open(task) },
      h('span', { class: 'task-title' }, task.content),
      meta.length > 0 && h('span', { class: 'task-meta' }, meta)),
  );
}

/** "Gedeeld met Anna en Bob", of niets als het project van jou alleen is. */
function sharedWith(view, projectId, me, userName) {
  const others = membersOf(view, projectId).filter((m) => m.user_id !== me?.id).map((m) => userName(m.user_id) ?? t('common.someone'));
  if (others.length === 0) return null;
  const names = others.length === 1 ? others[0] : t('common.listAnd', { first: others.slice(0, -1).join(', '), last: others[others.length - 1] });
  return h('p', { class: 'hint shared-with' }, t('share.sharedWith', { names }), roleIn(view, projectId, me?.id) === 'owner' ? '' : ` · ${t('share.youAreMember')}`);
}

const group = (title, rows, extra = null) =>
  h('section', { class: 'group' },
    title && h('div', { class: 'group-head' }, h('h2', { class: 'group-title' }, title), extra),
    rows.length > 0 && h('ul', { class: 'tasks' }, rows));

const empty = (text) => h('p', { class: 'empty' }, text);

/**
 * @returns {{ title: string, nodes: Node[] }}
 */
export function mainView({ view, route, today, now, showCompleted, handlers, me = null, userName = () => null }) {
  const row = (task, depth = 0, showProject = false) => taskRow(task, { view, today, now, depth, showProject, handlers, me, userName });

  if (route.type === 'today') {
    const list = todayView(view, today);
    return {
      title: t('nav.today'),
      nodes: [
        list.overdue.length > 0 && group(t('view.overdue'), list.overdue.map((x) => row(x, 0, true))),
        group(formatDayHeading(today, today), list.today.map((x) => row(x, 0, true))),
        list.overdue.length + list.today.length === 0 && empty(t('view.todayEmpty')),
      ],
    };
  }

  if (route.type === 'upcoming') {
    const days = upcomingView(view, today);
    return {
      title: t('nav.upcoming'),
      nodes: days.length > 0
        ? days.map((d) => group(formatDayHeading(d.date, today), d.tasks.map((x) => row(x, 0, true))))
        : [empty(t('view.upcomingEmpty'))],
    };
  }

  const pv = projectView(view, route.id, { showCompleted });
  if (!pv) return { title: t('view.projectTitle'), nodes: [empty(t('view.projectGone'))] };
  const total = pv.groups.reduce((sum, g) => sum + g.tasks.length, 0);
  const more = (label, onclick) => h('button', { class: 'icon-button', type: 'button', 'aria-label': label, title: label, onclick }, '⋯');
  return {
    title: pv.project.name,
    nodes: [
      h('div', { class: 'toolbar' },
        h('button', { class: 'button button-small', type: 'button', onclick: () => handlers.addSection(pv.project) }, t('section.add')),
        !isInboxId(pv.project.id)
          ? [
              h('button', { class: 'button button-small', type: 'button', onclick: () => handlers.shareProject(pv.project) }, isShared(view, pv.project.id) ? t('project.shared') : t('project.share')),
              h('button', { class: 'button button-small', type: 'button', onclick: () => handlers.projectMenu(pv.project) }, t('project.menu')),
            ]
          : null),
      sharedWith(view, pv.project.id, me, userName),
      ...pv.groups.map((g) => (g.section
        ? group(g.section.name, g.tasks.map((x) => row(x.task, x.depth)), more(t('section.editLabel', { name: g.section.name }), () => handlers.sectionMenu(g.section)))
        : g.tasks.length > 0 && group(null, g.tasks.map((x) => row(x.task, x.depth))))),
      total === 0 && pv.groups.length === 1 && empty(t('view.projectEmpty')),
      pv.completedCount > 0 && h('button', { class: 'link-button', type: 'button', onclick: () => handlers.toggleCompleted(pv.project.id) },
        showCompleted ? t('view.hideCompleted') : t('view.showCompleted', { count: pv.completedCount })),
    ],
  };
}
