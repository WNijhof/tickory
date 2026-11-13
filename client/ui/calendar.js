// De kalender: een maand of een week met de taken op hun dag. De berekeningen staan in core/calendar.js.
//
// Wat je ziet: bovenaan de kop met vorige / vandaag / volgende en de keuze Maand / Week; wat te laat is staat apart in een lijst
// boven de kalender; daaronder de dagen. Terugkerende taken staan ook op de komende voorkomens (alleen getoond, nergens bewaard;
// een voorkomen dat nog niet aan de beurt is, heeft geen afvinkcirkel). Op een telefoon wordt de tabel een lijst per dag
// (agenda), zonder dat er andere elementen nodig zijn: dat doet de CSS (`.cal` in app.css).
//
// Toetsenbord: in de kalender is steeds één dag bereikbaar met Tab (de gekozen dag). Pijltjestoetsen verplaatsen de keuze
// (links/rechts één dag, omhoog/omlaag een week), PageUp en PageDown gaan een maand of week terug of vooruit, Home gaat naar vandaag
// en Enter voegt een taak toe op die dag. De taken en knoppen in een dag zijn gewone knoppen.
//
// AANHAKEN VOOR SLEPEN (de werker `dnd` bouwt het slepen; dit bestand doet het niet):
//   div.cal                  de hele kalender.              data-calendar ("project:<id>" of "upcoming"), data-mode ("month" | "week")
//   td.cal-day               een dag (een doel om op te laten vallen).   data-date (YYYY-MM-DD), data-out="true" buiten de getoonde maand
//   ul.cal-items             de taken van een dag.          data-date
//   li.cal-item              een taak op een dag.           data-task-id, data-date (de dag waarop hij nu staat), data-real ("true" = de echte
//                            datum van de taak, "false" = een voorkomen van een herhaling: dat sleep je niet)
//   li.cal-item in .cal-overdue-list   een taak die te laat is: data-date is zijn echte datum.
// Een taak naar een andere dag zetten: `actions.updateTask(id, { due: reschedule(task.due, 'YYYY-MM-DD') })` (core/quickDates.js).

import { calendarModel, dayLabel, isoWeek, isoWeekday, periodTitle, shiftPeriod, weekdayNames } from '../core/calendar.js';
import { addDays } from '../core/format.js';
import { getLocale, t } from '../core/i18n.js';
import { colorClass } from '../core/colors.js';
import { h } from './dom.js';
import { icon } from './icons.js';

const MODE_KEY = 'tickory.calendarMode';

/** Per kalender (project of Binnenkort) wat je er op dit scherm van hebt gekozen; blijft staan zolang de pagina open is. */
const states = new Map();

function readMode() {
  try {
    return globalThis.localStorage?.getItem(MODE_KEY) === 'week' ? 'week' : 'month';
  } catch {
    return 'month';
  }
}

function stateOf(key) {
  if (!states.has(key)) states.set(key, { mode: readMode(), anchor: null, focus: null });
  return states.get(key);
}

/** Alleen voor de tests en voor afmelden: vergeet wat er gekozen was. */
export function resetCalendarStates() {
  states.clear();
}

const within = (day, from, to) => day >= from && day <= to;

/**
 * @param {{
 *   calendarKey: string, tasks: object[], view: object, today: string,
 *   handlers: { refresh: () => void, toggle: (task: object) => void, open: (task: object) => void, addToDay: (day: string, target: object) => void },
 *   showProject?: boolean, addTarget?: object, readOnly?: boolean,
 * }} options
 */
export function calendarView({ calendarKey, tasks, view, today, handlers, showProject = false, addTarget = {}, readOnly = false }) {
  const state = stateOf(calendarKey);
  const locale = getLocale();
  const anchor = state.anchor ?? today;
  const model = calendarModel({ tasks, mode: state.mode, anchor, today });
  const focusDay = state.focus && within(state.focus, model.from, model.to) ? state.focus : within(today, model.from, model.to) ? today : anchor;
  const month = anchor.slice(0, 7);

  const refresh = () => handlers.refresh();
  const setAnchor = (day) => { state.anchor = day === today ? null : day; };
  const shift = (direction) => {
    setAnchor(shiftPeriod(state.mode, anchor, direction));
    state.focus = null;
    refresh();
  };
  const setMode = (mode) => {
    if (mode === state.mode) return;
    state.mode = mode;
    try { globalThis.localStorage?.setItem(MODE_KEY, mode); } catch { /* alleen voor deze pagina */ }
    refresh();
  };

  // ---------- kop ----------
  const monthMode = state.mode === 'month';
  const bar = h('div', { class: 'cal-bar' },
    h('div', { class: 'cal-nav' },
      h('button', { class: 'icon-button', type: 'button', 'aria-label': monthMode ? t('calendar.prevMonth') : t('calendar.prevWeek'), title: monthMode ? t('calendar.prevMonth') : t('calendar.prevWeek'), dataset: { fk: 'cal-prev' }, onclick: () => shift(-1) }, icon('chevronLeft')),
      h('button', { class: 'button button-small', type: 'button', dataset: { fk: 'cal-today' }, onclick: () => { state.anchor = null; state.focus = today; refresh(); } }, t('calendar.today')),
      h('button', { class: 'icon-button', type: 'button', 'aria-label': monthMode ? t('calendar.nextMonth') : t('calendar.nextWeek'), title: monthMode ? t('calendar.nextMonth') : t('calendar.nextWeek'), dataset: { fk: 'cal-next' }, onclick: () => shift(1) }, icon('chevronRight'))),
    h('h2', { class: 'cal-title', 'aria-live': 'polite' }, periodTitle(state.mode, anchor, locale)),
    h('div', { class: 'cal-mode', role: 'group', 'aria-label': t('calendar.modeLabel') },
      ['month', 'week'].map((mode) => h('button', {
        class: `button button-small view-switch-button${mode === state.mode ? ' active' : ''}`, type: 'button', 'aria-pressed': String(mode === state.mode),
        dataset: { mode, fk: `cal-mode:${mode}` }, onclick: () => setMode(mode),
      }, mode === 'month' ? t('calendar.month') : t('calendar.week')))));

  // ---------- een taak op een dag ----------
  const item = (entry, { withDate = false } = {}) => {
    const { task, date, time, real } = entry;
    const overdue = withDate;
    const project = showProject ? view.projects.get(task.project_id) : null;
    const title = real ? task.content : t('calendar.repeatTitle', { name: task.content });
    return h('li', {
      class: `cal-item prio-${task.priority ?? 4}${real ? '' : ' cal-virtual'}${overdue ? ' cal-late' : ''}`,
      dataset: { taskId: task.id, date, real: String(real) },
    },
    real
      ? h('button', {
        class: 'cal-check', type: 'button', 'aria-pressed': 'false', dataset: { fk: `calcheck:${task.id}` },
        'aria-label': t('task.completeLabel', { name: task.content }), title: t('task.completeLabel', { name: task.content }), onclick: () => handlers.toggle(task),
      })
      : h('span', { class: 'cal-repeat', title: t('calendar.repeatHint'), role: 'img', 'aria-label': t('calendar.repeatHint') }, icon('repeat')),
    h('button', { class: 'cal-open', type: 'button', title, dataset: { fk: `calopen:${task.id}:${date}` }, onclick: () => handlers.open(task) },
      withDate && h('span', { class: 'cal-when' }, dayLabel(locale, date, 'short')),
      time && h('span', { class: 'cal-time' }, time),
      h('span', { class: 'cal-title-text' }, task.content),
      project && h('span', { class: 'cal-project' }, h('span', { class: `dot ${colorClass(project.color)}`, 'aria-hidden': 'true' }), h('span', { class: 'cal-project-name' }, project.name))));
  };

  // ---------- te laat ----------
  const overdueBlock = model.overdue.length > 0 && h('section', { class: 'cal-overdue', 'aria-label': t('view.overdue') },
    h('div', { class: 'group-head' }, h('h2', { class: 'group-title' }, t('view.overdue')), h('span', { class: 'group-count' }, String(model.overdue.length))),
    h('ul', { class: 'cal-items cal-overdue-list' }, model.overdue.map((task) => item({ task, date: task.due.date.slice(0, 10), time: task.due.date.length > 10 ? task.due.date.slice(11, 16) : null, real: true }, { withDate: true }))));

  // ---------- dagen ----------
  const names = weekdayNames(locale, 'short');
  const longNames = weekdayNames(locale, 'long');
  const dayCell = ({ date, entries }) => {
    const out = monthMode && date.slice(0, 7) !== month;
    const num = Number(date.slice(8, 10));
    const showMonth = num === 1 || !monthMode; // de eerste van de maand en elke dag in de weekweergave zeggen de maand erbij
    const weekday = isoWeekday(date) - 1;
    const label = dayLabel(locale, date, 'full');
    const cls = ['cal-day'];
    if (date === today) cls.push('cal-today');
    if (date < today) cls.push('cal-past');
    if (weekday >= 5) cls.push('cal-weekend');
    if (out) cls.push('cal-out');
    if (entries.length === 0) cls.push('cal-empty');
    return h('td', {
      class: cls.join(' '), tabindex: date === focusDay ? '0' : '-1', 'aria-label': t('calendar.dayLabel', { date: label, tasks: t('calendar.dayTasks', { count: entries.length }) }),
      'aria-current': date === today ? 'date' : null, dataset: { date, out: out ? 'true' : null, fk: `cal:${date}` },
    },
    h('div', { class: 'cal-day-head' },
      h('span', { class: 'cal-dayname', 'aria-hidden': 'true' }, longNames[weekday]),
      h('span', { class: 'cal-daynum', 'aria-hidden': 'true' }, showMonth ? dayLabel(locale, date, 'dm') : String(num)),
      !readOnly && h('button', {
        class: 'cal-add', type: 'button', tabindex: '-1', 'aria-label': t('calendar.addOn', { date: dayLabel(locale, date, 'long') }), title: t('calendar.addOn', { date: dayLabel(locale, date, 'long') }),
        dataset: { date }, onclick: () => handlers.addToDay(date, addTarget),
      }, icon('plus'))),
    h('ul', { class: 'cal-items', dataset: { date } }, entries.map((entry) => item(entry))),
    entries.length > 4 && h('button', {
      class: 'cal-more', type: 'button', 'aria-label': t('calendar.moreLabel', { count: entries.length - 4, date: dayLabel(locale, date, 'long') }),
      onclick: () => { state.mode = 'week'; state.anchor = date === today ? null : date; state.focus = date; refresh(); },
    }, t('calendar.more', { count: entries.length - 4 })));
  };

  const weeks = [];
  for (let i = 0; i < model.days.length; i += 7) weeks.push(model.days.slice(i, i + 7));
  const table = h('table', { class: 'cal-table' },
    h('caption', { class: 'sr-only' }, t('calendar.caption', { title: periodTitle(state.mode, anchor, locale) })),
    h('thead', {}, h('tr', {},
      h('th', { class: 'cal-weekhead', scope: 'col' }, h('abbr', { title: t('calendar.weekNumberHead') }, t('calendar.weekShort'))),
      names.map((name, i) => h('th', { scope: 'col', class: i >= 5 ? 'cal-weekend' : '' }, h('abbr', { title: longNames[i] }, name))))),
    h('tbody', {}, weeks.map((days) => {
      const { week } = isoWeek(days[0].date);
      return h('tr', {},
        h('th', { class: 'cal-weeknum', scope: 'row', 'aria-label': t('calendar.weekNumber', { week }) }, h('span', { 'aria-hidden': 'true' }, t('calendar.weekNumber', { week }))),
        days.map(dayCell));
    })));

  // ---------- toetsenbord ----------
  const move = (day) => {
    state.focus = day;
    if (within(day, model.from, model.to) && (!monthMode || day.slice(0, 7) === month)) {
      for (const cell of root.querySelectorAll('td.cal-day')) cell.tabIndex = cell.dataset.date === day ? 0 : -1;
      root.querySelector(`td.cal-day[data-date="${day}"]`)?.focus();
      return;
    }
    setAnchor(day);
    refresh();
    requestAnimationFrame(() => document.querySelector(`.cal td.cal-day[data-date="${day}"]`)?.focus());
  };
  const onKey = (e) => {
    const cell = e.target.closest?.('td.cal-day');
    if (e.target !== cell || e.ctrlKey || e.metaKey || e.altKey) return;
    const day = cell.dataset.date;
    const next = {
      ArrowLeft: () => addDays(day, -1), ArrowRight: () => addDays(day, 1), ArrowUp: () => addDays(day, -7), ArrowDown: () => addDays(day, 7),
      PageUp: () => shiftPeriod(state.mode, day, -1), PageDown: () => shiftPeriod(state.mode, day, 1), Home: () => today,
    }[e.key];
    if (next) {
      e.preventDefault();
      move(next());
    } else if (e.key === 'Enter' && !readOnly) {
      e.preventDefault();
      handlers.addToDay(day, addTarget);
    }
  };

  const root = h('div', { class: 'cal', dataset: { calendar: calendarKey, mode: state.mode }, onkeydown: onKey },
    bar,
    overdueBlock,
    table,
    h('p', { class: 'hint cal-keys' }, readOnly ? t('calendar.keysReadOnly') : t('calendar.keys')));
  return root;
}
