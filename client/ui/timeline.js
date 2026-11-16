// De tijdlijn (SPEC 5o): een dag of een week met uren. Taken met een tijd staan op hun plek, zo hoog als hun duur; taken zonder tijd
// in de rij "Hele dag" bovenaan; rechts (op een telefoon eronder) "In te plannen": taken zonder datum en wat te laat is. De rekenkant
// staat in core/timeline.js; de kalender (ui/calendar.js) toont dit als je Tijdlijn kiest.
//
// Wat je kunt doen:
//   - klikken op een lege plek: een taak toevoegen op die dag en dat tijdstip (op een kwartier afgerond);
//   - een taak slepen (ook uit "In te plannen") naar een andere tijd of dag, of naar "Hele dag" (dan zonder tijd);
//   - de onderrand van een taak slepen: de duur (per kwartier, minstens een kwartier);
//   - met het toetsenbord op een taak: Alt+pijl omhoog/omlaag een kwartier eerder of later, Alt+pijl links/rechts een dag;
//   - elke wijziging is ongedaan te maken (de melding onderaan).
// Een voorkomen van een herhaling (nog niet aan de beurt) en een taak die je alleen leest, sleep je niet. Op een aanraakscherm begin je
// het slepen door de taak even vast te houden; een korte veeg scrolt gewoon.

import { DAY_MINUTES, DEFAULT_SCROLL_HOUR, SNAP_MINUTES, dueAt, hhmmOf, snap, timelineModel } from '../core/timeline.js';
import { dayLabel, isoWeekday, weekdayNames } from '../core/calendar.js';
import { formatDuration } from '../core/duration.js';
import { clockText, nowString } from '../core/format.js';
import { getLocale, t } from '../core/i18n.js';
import { colorClass } from '../core/colors.js';
import { h } from './dom.js';
import { icon } from './icons.js';

const DRAG_THRESHOLD = 5;
const LONG_PRESS_MS = 350;

/** De nieuwe `due` voor "Hele dag": de dag zonder tijd; een herhaling blijft herhalen. */
function dueOnDay(due, date) {
  const next = { date };
  if (due?.recurrence) {
    next.recurrence = due.recurrence;
    if (due.string) next.string = due.string;
    if (due.lang) next.lang = due.lang;
  }
  return next;
}

const timeRange = (start, end) => `${clockText(hhmmOf(start))}–${clockText(hhmmOf(Math.min(end, DAY_MINUTES - 1)))}`;

/**
 * @param {{
 *   state: { tlMode: 'day' | 'week', anchor: string | null, tlScroll?: number | null },
 *   tasks: object[], view: object, today: string, anchor: string, colorOf: (task: object) => string | null,
 *   handlers: { open: (task: object) => void, toggle: (task: object) => void, addToDay: (day: string, target: object) => void,
 *     planTask: (task: object, changes: object, text: string) => Promise<unknown> },
 *   showProject?: boolean, addTarget?: object, readOnly?: boolean, canEdit?: (task: object) => boolean,
 * }} options
 * @returns {HTMLElement}
 */
export function timelineView({ state, tasks, view, today, anchor, colorOf, handlers, showProject = false, addTarget = {}, readOnly = false, canEdit = () => true }) {
  const locale = getLocale();
  const model = timelineModel({ tasks, mode: state.tlMode, anchor, today });
  const locked = (task) => readOnly || !canEdit(task);
  const longNames = weekdayNames(locale, 'long');
  const shortNames = weekdayNames(locale, 'short');
  // een week heeft smalle kolommen: korte dagnamen, alleen de begintijd, en de projectnaam alleen in In te plannen
  const compact = state.tlMode === 'week';
  const now = nowString(); // 'YYYY-MM-DDTHH:MM' in de tijdzone van het apparaat
  const nowMinutes = Number(now.slice(11, 13)) * 60 + Number(now.slice(14, 16));

  // ---------- de onderdelen ----------
  const titleOf = (task) => task.content;
  const projectChip = (task) => {
    if (!showProject) return null;
    const p = view.projects.get(task.project_id);
    return p && h('span', { class: 'tl-project' }, h('span', { class: `dot ${colorClass(p.color)}`, 'aria-hidden': 'true' }), p.name);
  };
  const itemClass = (task, extra = '') => {
    const color = colorOf(task);
    return `tl-item prio-${task.priority ?? 4}${color ? ` tl-colored ${colorClass(color)}` : ''}${extra}`;
  };

  const timedItem = (entry) => {
    const { task, date, start, end, real, column, columns } = entry;
    const movable = real && !locked(task);
    const label = t('timeline.itemLabel', { name: titleOf(task), from: clockText(hhmmOf(start)), to: clockText(hhmmOf(Math.min(end, DAY_MINUTES - 1))) });
    const el = h('div', {
      class: itemClass(task, `${real ? '' : ' tl-virtual'}${movable ? ' tl-movable' : ''}${end - start <= 30 ? ' tl-short' : ''}`),
      dataset: { taskId: task.id, date, start: String(start), end: String(end), real: String(real) },
    },
    h('button', {
      type: 'button', class: 'tl-open', 'aria-label': label, title: label, dataset: { fk: real ? `tlopen:${task.id}` : `tlopen:${task.id}:${date}` },
      'aria-keyshortcuts': movable ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight' : null,
      onclick: () => handlers.open(task),
    },
    h('span', { class: 'tl-time' }, compact ? clockText(hhmmOf(start)) : timeRange(start, end)),
    h('span', { class: 'tl-title' }, real ? task.content : t('calendar.repeatTitle', { name: task.content })),
    projectChip(task)),
    movable && h('div', { class: 'tl-resize', 'aria-hidden': 'true', title: t('timeline.resize') }));
    // plaats en hoogte via de stijl van het element (de CSP staat geen style-attributen toe, wel CSSOM)
    el.style.top = `calc(var(--tl-hour) * ${start / 60})`;
    el.style.height = `calc(var(--tl-hour) * ${(end - start) / 60})`;
    el.style.left = `${(column / columns) * 100}%`;
    el.style.width = `${100 / columns}%`;
    return el;
  };

  const chipItem = (entry) => {
    const { task, date, real } = entry;
    const movable = real && !locked(task);
    return h('li', { class: itemClass(task, ` tl-chip${real ? '' : ' tl-virtual'}${movable ? ' tl-movable' : ''}`), dataset: { taskId: task.id, date, real: String(real) } },
      h('button', { type: 'button', class: 'tl-open', title: titleOf(task), dataset: { fk: `tlopen:${task.id}:${date}` }, onclick: () => handlers.open(task) },
        h('span', { class: 'tl-title' }, real ? task.content : t('calendar.repeatTitle', { name: task.content })), projectChip(task)));
  };

  const planItem = (task, late) => {
    const movable = !locked(task);
    return h('li', { class: itemClass(task, ` tl-plan-item${movable ? ' tl-movable' : ''}${late ? ' tl-late' : ''}`), dataset: { taskId: task.id, plan: 'true' } },
      h('button', { type: 'button', class: 'tl-open', title: titleOf(task), dataset: { fk: `tlplan:${task.id}` }, onclick: () => handlers.open(task) },
        late && h('span', { class: 'tl-when' }, dayLabel(locale, task.due.date.slice(0, 10), 'short')),
        h('span', { class: 'tl-title' }, task.content), projectChip(task)));
  };

  // ---------- de kop met de dagen, de rij Hele dag en het raster ----------
  const days = model.days;
  const dayHead = (day) => {
    const weekday = isoWeekday(day.date) - 1;
    return h('div', { class: `tl-dayhead${day.date === today ? ' tl-today' : ''}${weekday >= 5 ? ' tl-weekend' : ''}`, dataset: { date: day.date } },
      h('span', { class: 'tl-dayname', title: longNames[weekday] }, compact ? shortNames[weekday] : longNames[weekday]),
      h('span', { class: 'tl-daynum', title: dayLabel(locale, day.date, 'long') }, compact ? String(Number(day.date.slice(8, 10))) : dayLabel(locale, day.date, 'dm')));
  };
  const allDayCell = (day) => h('ul', { class: 'tl-allday-cell', dataset: { tlDay: day.date, tlAllday: 'true' } }, day.allDay.map(chipItem));
  const hours = h('div', { class: 'tl-hours', 'aria-hidden': 'true' },
    Array.from({ length: 24 }, (_, hour) => h('span', { class: 'tl-hour' }, hour === 0 ? '' : clockText(hhmmOf(hour * 60)))));
  const column = (day) => {
    const col = h('div', {
      class: `tl-col${day.date === today ? ' tl-today' : ''}`, dataset: { tlDay: day.date },
      role: 'group', 'aria-label': t('timeline.dayLabel', { date: dayLabel(locale, day.date, 'full'), count: day.timed.length }),
    }, day.timed.map(timedItem));
    if (day.date === today) {
      const line = h('div', { class: 'tl-now', 'aria-hidden': 'true' });
      line.style.top = `calc(var(--tl-hour) * ${nowMinutes / 60})`;
      col.append(line);
    }
    return col;
  };
  const grid = h('div', { class: 'tl-grid' }, hours, days.map(column));
  const scroller = h('div', { class: 'tl-scroll', tabIndex: -1 }, grid);
  const board = h('div', { class: 'tl-board', dataset: { days: String(days.length) } },
    h('div', { class: 'tl-headrow' }, h('div', { class: 'tl-gutter' }), days.map(dayHead)),
    h('div', { class: 'tl-alldayrow' }, h('div', { class: 'tl-gutter tl-allday-label' }, t('timeline.allDay')), days.map(allDayCell)),
    scroller);

  // ---------- In te plannen ----------
  const plan = h('aside', { class: 'tl-plan', 'aria-label': t('timeline.plan') },
    h('h3', { class: 'subheading' }, t('timeline.plan')),
    !readOnly && h('p', { class: 'hint' }, t('timeline.planHint')),
    model.unscheduled.length > 0
      ? h('ul', { class: 'tl-plan-list', dataset: { fk: 'tl-plan' } }, model.unscheduled.map((task) => planItem(task, false)))
      : h('p', { class: 'hint tl-plan-empty' }, t('timeline.planEmpty')),
    model.overdue.length > 0 && [
      h('h3', { class: 'subheading tl-late-head' }, t('view.overdue')),
      h('ul', { class: 'tl-plan-list tl-late-list' }, model.overdue.map((task) => planItem(task, true)))]);

  const root = h('div', { class: 'tl', dataset: { tlMode: state.tlMode } },
    h('div', { class: 'tl-main' }, board, plan),
    h('p', { class: 'hint cal-keys' }, readOnly ? t('timeline.keysReadOnly') : t('timeline.keys')));

  // ---------- scrollen: de plek blijft bewaard; de eerste keer naar het begin van de dag (of de eerste taak) ----------
  // pas na het herstellen telt scrollen mee (een focus vlak na het opnieuw tekenen mag de bewaarde plek niet overschrijven)
  let restored = false;
  scroller.addEventListener('scroll', () => { if (restored) state.tlScroll = scroller.scrollTop; }, { passive: true });
  const restore = () => {
    if (restored || !scroller.isConnected) return;
    const hourPx = grid.offsetHeight / 24;
    if (state.tlScroll != null) scroller.scrollTop = state.tlScroll;
    else {
      const first = model.earliest !== null ? Math.max(0, model.earliest - 30) : DEFAULT_SCROLL_HOUR * 60;
      // een klein stukje erboven, zodat het uurlabel bovenaan helemaal te lezen is
      scroller.scrollTop = Math.max(0, Math.round((Math.min(first, DEFAULT_SCROLL_HOUR * 60) / 60) * hourPx) - 10);
    }
    restored = true;
  };
  // meteen na het tekenen (nog voor het scherm wordt bijgewerkt: geen sprong naar boven), en anders bij het volgende beeld
  queueMicrotask(restore);
  requestAnimationFrame(restore);

  // ---------- slepen, de duur veranderen en klikken om toe te voegen ----------
  const taskOf = (id) => view.tasks.get(id);
  const hourPx = () => grid.offsetHeight / 24;
  /** Waar de aanwijzer is: een dag en een tijd in het raster, of een dag in de rij Hele dag, of niets. */
  const targetAt = (x, y, length, grab = 0) => {
    const hit = document.elementFromPoint(x, y);
    const allDay = hit?.closest?.('[data-tl-allday]');
    if (allDay && root.contains(allDay)) return { date: allDay.dataset.tlDay, allDay: true };
    const col = hit?.closest?.('.tl-col');
    if (!col || !root.contains(col)) return null;
    const rect = col.getBoundingClientRect();
    const minutes = snap(((y - rect.top) / hourPx()) * 60 - grab); // `grab`: waar in de taak je haar vastpakte
    return { date: col.dataset.tlDay, minutes: Math.min(minutes, DAY_MINUTES - Math.min(length, DAY_MINUTES - minutes)), col };
  };
  let marker = null;
  const showMarker = (target, length, label) => {
    if (!target || target.allDay) {
      marker?.remove();
      marker = null;
      for (const c of root.querySelectorAll('.tl-allday-cell.tl-drop-over')) c.classList.remove('tl-drop-over');
      if (target?.allDay) root.querySelector(`.tl-allday-cell[data-tl-day="${target.date}"]`)?.classList.add('tl-drop-over');
      return;
    }
    for (const c of root.querySelectorAll('.tl-allday-cell.tl-drop-over')) c.classList.remove('tl-drop-over');
    if (!marker) marker = h('div', { class: 'tl-drop', 'aria-hidden': 'true' }, h('span', { class: 'tl-drop-time' }));
    if (marker.parentElement !== target.col) target.col.append(marker);
    marker.style.top = `calc(var(--tl-hour) * ${target.minutes / 60})`;
    marker.style.height = `calc(var(--tl-hour) * ${length / 60})`;
    marker.firstChild.textContent = label ?? timeRange(target.minutes, target.minutes + length);
  };
  const clearMarker = () => showMarker(null);

  let gesture = null;
  const endGesture = () => {
    if (!gesture) return;
    clearTimeout(gesture.timer);
    if (gesture.active) {
      document.body.classList.remove('hold-render');
      window.dispatchEvent(new Event('hold-render-end'));
    }
    gesture.source?.classList.remove('tl-dragging');
    root.classList.remove('tl-busy');
    clearMarker();
    gesture = null;
  };

  root.addEventListener('pointerdown', (e) => {
    if (readOnly || e.button !== 0) return;
    const resize = e.target.closest('.tl-resize');
    const source = e.target.closest('.tl-movable');
    if (!source || !root.contains(source)) {
      // een lege plek in het raster: bij loslaten zonder bewegen een taak toevoegen
      const col = e.target.closest('.tl-col');
      if (col && !e.target.closest('.tl-item')) gesture = { kind: 'add', x: e.clientX, y: e.clientY, col };
      return;
    }
    const task = taskOf(source.dataset.taskId);
    if (!task) return;
    const start = Number(source.dataset.start ?? NaN);
    const end = Number(source.dataset.end ?? NaN);
    const length = Number.isFinite(start) ? end - start : (task.duration > 0 ? task.duration : 30);
    // waar je een taak in het raster vastpakt, blijft onder de aanwijzer (een taak uit de lijst pak je bij haar begin)
    const grab = Number.isFinite(start) && source.closest('.tl-col') ? ((e.clientY - source.getBoundingClientRect().top) / hourPx()) * 60 : 0;
    gesture = {
      kind: resize ? 'resize' : 'move', task, source, x: e.clientX, y: e.clientY, start, length, grab, touch: e.pointerType === 'touch',
      armed: e.pointerType !== 'touch', active: false, pointerId: e.pointerId,
    };
    if (gesture.touch) gesture.timer = setTimeout(() => { if (gesture) { gesture.armed = true; source.classList.add('tl-armed'); } }, LONG_PRESS_MS);
    if (resize) e.preventDefault();
  });

  root.addEventListener('pointermove', (e) => {
    if (!gesture || gesture.kind === 'add') {
      if (gesture?.kind === 'add' && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > DRAG_THRESHOLD) gesture = null;
      return;
    }
    const moved = Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y);
    if (!gesture.active) {
      if (moved < DRAG_THRESHOLD) return;
      if (!gesture.armed) { endGesture(); return; } // op een aanraakscherm: een veeg zonder vasthouden scrolt
      gesture.active = true;
      document.body.dataset.holdSince = String(Date.now());
      document.body.classList.add('hold-render'); // niet opnieuw tekenen tijdens het slepen (zie invalidate in app.js)
      gesture.source.classList.add('tl-dragging');
      root.classList.add('tl-busy');
      try { root.setPointerCapture?.(gesture.pointerId); } catch { /* al losgelaten */ }
    }
    e.preventDefault();
    if (gesture.kind === 'resize') {
      const col = gesture.source.closest('.tl-col');
      const rect = col.getBoundingClientRect();
      const endMin = Math.max(gesture.start + SNAP_MINUTES, snap(((e.clientY - rect.top) / hourPx()) * 60));
      gesture.newLength = Math.min(endMin, DAY_MINUTES) - gesture.start;
      showMarker({ date: col.dataset.tlDay, minutes: gesture.start, col }, gesture.newLength, formatDuration(gesture.newLength));
      return;
    }
    gesture.target = targetAt(e.clientX, e.clientY, gesture.length, gesture.grab);
    showMarker(gesture.target, gesture.length);
  });

  const finish = async (e) => {
    const g = gesture;
    if (!g) return;
    if (g.kind === 'add') {
      gesture = null;
      if (e.type !== 'pointerup' || e.target.closest('.tl-item')) return;
      const rect = g.col.getBoundingClientRect();
      const minutes = snap(((e.clientY - rect.top) / hourPx()) * 60);
      handlers.addToDay(`${g.col.dataset.tlDay}T${hhmmOf(minutes)}`, addTarget);
      return;
    }
    // de plek bij het loslaten zelf (de laatste beweging kan nog niet verwerkt zijn als je snel loslaat)
    let target = g.target;
    let length = g.newLength;
    if (g.active && e.type === 'pointerup') {
      if (g.kind === 'resize') {
        const col = g.source.closest('.tl-col');
        const rect = col.getBoundingClientRect();
        length = Math.min(Math.max(g.start + SNAP_MINUTES, snap(((e.clientY - rect.top) / hourPx()) * 60)), DAY_MINUTES) - g.start;
      } else {
        target = targetAt(e.clientX, e.clientY, g.length, g.grab) ?? target;
      }
    }
    const active = g.active;
    endGesture();
    if (!active || e.type !== 'pointerup') return;
    // een klik na het slepen opent de taak niet
    window.addEventListener('click', (c) => { c.stopPropagation(); c.preventDefault(); }, { capture: true, once: true });
    setTimeout(() => window.dispatchEvent(new Event('tl-drag-done')), 0);
    const name = g.task.content;
    if (g.kind === 'resize') {
      if (!length || length === g.length) return;
      await handlers.planTask(g.task, { duration: length }, t('timeline.resized', { name, duration: formatDuration(length) }));
      return;
    }
    if (!target) return;
    if (target.allDay) {
      if (g.task.due?.date === target.date) return;
      await handlers.planTask(g.task, { due: dueOnDay(g.task.due, target.date) }, t('timeline.movedDay', { name, date: dayLabel(locale, target.date, 'long') }));
      return;
    }
    const due = dueAt(g.task.due, target.date, target.minutes);
    if (g.task.due?.date === due.date) return;
    await handlers.planTask(g.task, { due }, t('timeline.moved', { name, date: dayLabel(locale, target.date, 'long'), time: clockText(hhmmOf(target.minutes)) }));
  };
  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', finish);
  root.addEventListener('lostpointercapture', (e) => { if (gesture?.active) finish(e); });
  // een vastgehouden taak op een aanraakscherm: niet het menu van de browser
  root.addEventListener('contextmenu', (e) => { if (gesture?.touch) e.preventDefault(); });

  // ---------- toetsenbord: Alt+pijlen verplaatsen een kwartier of een dag ----------
  root.addEventListener('keydown', async (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target.closest?.('.tl-item.tl-movable[data-start]');
    if (!el || readOnly) return;
    const step = { ArrowUp: [0, -SNAP_MINUTES], ArrowDown: [0, SNAP_MINUTES], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (!step) return;
    e.preventDefault();
    const task = taskOf(el.dataset.taskId);
    if (!task) return;
    const date = step[0] === 0 ? el.dataset.date : shiftDay(el.dataset.date, step[0]);
    const minutes = Math.max(0, Math.min(DAY_MINUTES - SNAP_MINUTES, Number(el.dataset.start) + step[1]));
    await handlers.planTask(task, { due: dueAt(task.due, date, minutes) }, t('timeline.moved', { name: task.content, date: dayLabel(locale, date, 'long'), time: clockText(hhmmOf(minutes)) }));
    // na het opnieuw tekenen de focus weer op dezelfde taak
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(`.tl-item[data-task-id="${task.id}"] .tl-open`)?.focus({ preventScroll: true })));
  });

  return root;
}

const shiftDay = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
