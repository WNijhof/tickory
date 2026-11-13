// Bouwt de zichtbare onderdelen uit de lokale toestand: de zijbalk en het hoofdscherm.
// Geen eigen toestand; elke wijziging in de opslag tekent het scherm opnieuw.

import { isInboxId } from '../../shared/schema.js';
import { counts, isShared, membersOf, projectList, projectView, roleIn, todayView, upcomingView } from '../core/selectors.js';
import { dueStatus, formatDate, formatDayHeading, formatDue } from '../core/format.js';
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
    shared && h('span', { class: 'nav-shared', title: 'Gedeeld project', role: 'img', 'aria-label': 'gedeeld project' }, '👥'),
    count > 0 && h('span', { class: 'nav-count' }, String(count)));
  };
  return [
    h('div', { class: 'brand' }, 'Tickory'),
    h('nav', { class: 'nav', 'aria-label': 'Overzichten' },
      item({ type: 'today' }, 'Vandaag', n.today),
      item({ type: 'upcoming' }, 'Binnenkort', 0),
      h('div', { class: 'nav-heading' },
        h('span', {}, 'Projecten'),
        h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Project toevoegen', title: 'Project toevoegen', onclick: handlers.addProject }, '+')),
      projectList(view).map(({ project, depth }) => item({ type: 'project', id: project.id }, project.name, n.perProject.get(project.id) ?? 0, depth, isShared(view, project.id))),
    ),
    h('div', { class: 'sidebar-footer' },
      h('button', { class: 'nav-item', type: 'button', onclick: handlers.settings },
        h('span', { class: 'nav-label' }, me ? me.name : 'Instellingen'),
        me && h('span', { class: 'nav-count' }, 'Instellingen'))),
  ];
}

function taskRow(task, { view, today, now, depth = 0, showProject = false, handlers, me, userName }) {
  const meta = [];
  if (task.due) meta.push(h('span', { class: `chip chip-due due-${dueStatus(task.due, today, now)}` }, formatDue(task.due, today)));
  if (task.deadline) meta.push(h('span', { class: `chip chip-deadline ${task.deadline < today ? 'due-overdue' : ''}` }, `deadline ${formatDate(task.deadline, today)}`));
  for (const id of task.labels ?? []) {
    const label = view.labels.get(id);
    if (label) meta.push(h('span', { class: 'chip chip-label' }, `@${label.name}`));
  }
  if (task.assignee_id) {
    const mine = task.assignee_id === me?.id;
    const name = mine ? 'jou' : userName(task.assignee_id) ?? 'iemand';
    meta.push(h('span', { class: `chip chip-assignee${mine ? ' chip-mine' : ''}`, title: `Toegewezen aan ${mine ? 'jou' : name}` }, `voor ${name}`));
  }
  if (showProject) {
    const project = view.projects.get(task.project_id);
    const section = task.section_id ? view.sections.get(task.section_id) : null;
    if (project) meta.push(h('span', { class: 'chip chip-project' }, section ? `${project.name} / ${section.name}` : project.name));
  }
  if (task.description) meta.push(h('span', { class: 'chip chip-note', title: 'Heeft een beschrijving' }, 'notitie'));
  return h('li', { class: `task prio-${task.priority} ${task.checked ? 'task-done' : ''}`, dataset: { id: task.id, depth: String(Math.min(depth, 4)) } },
    h('button', {
      class: 'check', type: 'button', 'aria-pressed': String(Boolean(task.checked)),
      'aria-label': `${task.checked ? 'Heropenen' : 'Voltooien'}: ${task.content}`, onclick: () => handlers.toggle(task),
    }),
    h('button', { class: 'task-body', type: 'button', onclick: () => handlers.open(task) },
      h('span', { class: 'task-title' }, task.content),
      meta.length > 0 && h('span', { class: 'task-meta' }, meta)),
  );
}

/** "Gedeeld met Anna en Bob", of niets als het project van jou alleen is. */
function sharedWith(view, projectId, me, userName) {
  const others = membersOf(view, projectId).filter((m) => m.user_id !== me?.id).map((m) => userName(m.user_id) ?? 'iemand');
  if (others.length === 0) return null;
  const list = others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} en ${others[others.length - 1]}`;
  return h('p', { class: 'hint shared-with' }, `Gedeeld met ${list}`, roleIn(view, projectId, me?.id) === 'owner' ? '' : ' · je bent lid');
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
    const t = todayView(view, today);
    return {
      title: 'Vandaag',
      nodes: [
        t.overdue.length > 0 && group('Te laat', t.overdue.map((x) => row(x, 0, true))),
        group(formatDayHeading(today, today), t.today.map((x) => row(x, 0, true))),
        t.overdue.length + t.today.length === 0 && empty('Niets voor vandaag. Typ hierboven om een taak toe te voegen.'),
      ],
    };
  }

  if (route.type === 'upcoming') {
    const days = upcomingView(view, today);
    return {
      title: 'Binnenkort',
      nodes: days.length > 0
        ? days.map((d) => group(formatDayHeading(d.date, today), d.tasks.map((x) => row(x, 0, true))))
        : [empty('Niets gepland voor de komende twee weken.')],
    };
  }

  const pv = projectView(view, route.id, { showCompleted });
  if (!pv) return { title: 'Project', nodes: [empty('Dit project bestaat niet (meer).')] };
  const total = pv.groups.reduce((sum, g) => sum + g.tasks.length, 0);
  const more = (label, onclick) => h('button', { class: 'icon-button', type: 'button', 'aria-label': label, title: label, onclick }, '⋯');
  return {
    title: pv.project.name,
    nodes: [
      h('div', { class: 'toolbar' },
        h('button', { class: 'button button-small', type: 'button', onclick: () => handlers.addSection(pv.project) }, 'Sectie toevoegen'),
        !isInboxId(pv.project.id)
          ? [
              h('button', { class: 'button button-small', type: 'button', onclick: () => handlers.shareProject(pv.project) }, isShared(view, pv.project.id) ? 'Gedeeld' : 'Delen'),
              h('button', { class: 'button button-small', type: 'button', onclick: () => handlers.projectMenu(pv.project) }, 'Project…'),
            ]
          : null),
      sharedWith(view, pv.project.id, me, userName),
      ...pv.groups.map((g) => (g.section
        ? group(g.section.name, g.tasks.map((x) => row(x.task, x.depth)), more(`Sectie ${g.section.name} bewerken`, () => handlers.sectionMenu(g.section)))
        : g.tasks.length > 0 && group(null, g.tasks.map((x) => row(x.task, x.depth))))),
      total === 0 && pv.groups.length === 1 && empty('Nog geen taken. Typ hierboven om er een toe te voegen.'),
      pv.completedCount > 0 && h('button', { class: 'link-button', type: 'button', onclick: () => handlers.toggleCompleted(pv.project.id) },
        showCompleted ? 'Voltooide taken verbergen' : `Voltooide taken tonen (${pv.completedCount})`),
    ],
  };
}
