// De kleine popup met een kalender om een dag en tijd te kiezen, zoals in Todoist. Gebruikt bij het aantikken van de datum van een taak
// (ui/app.js: handlers.reschedule) en in het venster "Taak toevoegen" (ui/quickAdd.js).
//
// Bovenaan de snelle keuzes (vandaag, morgen, dit weekend, volgende week, geen datum): een tik bewaart meteen, met het tijdstip dat er
// dan staat. Daaronder een maandkalender (de week begint op de dag uit Instellingen › Algemeen) en een tijd. Een dag in de kalender
// kiezen markeert hem; "Opslaan" bewaart dag en tijd.

import { addMonths, getWeekStart, monthGrid, periodTitle, weekdayNames } from '../core/calendar.js';
import { formatDate } from '../core/format.js';
import { getLocale, t } from '../core/i18n.js';
import { quickDates } from '../core/quickDates.js';
import { h, openDialog, replace } from './dom.js';
import { icon } from './icons.js';

/**
 * @param {{ today: string, due?: { date: string } | null, allowNone?: boolean }} options  `due`: de huidige datum (met of zonder tijd);
 *   `allowNone`: een keuze "Geen datum" erbij (zonder huidige datum is die er niet)
 * @returns {Promise<{ date: string | null, time: string } | null>} de keuze (`date` null = geen datum, `time` '' = geen tijd), of null bij sluiten
 */
export function pickDateTime({ today, due = null, allowNone = true }) {
  const d = quickDates(today);
  const currentTime = due?.date.length > 10 ? due.date.slice(11, 16) : '';
  let selected = due?.date.slice(0, 10) ?? '';
  let shown = selected || today; // de maand die de kalender toont
  return openDialog((finish) => {
    const time = h('input', { class: 'field', type: 'time', value: currentTime, 'aria-label': t('task.dueTime'), dataset: { fk: 'due-time' } });
    const choose = (day) => finish(day ? { date: day, time: time.value } : { date: null, time: '' });
    const quick = (label, day, fk) => h('button', { class: 'chip-button', type: 'button', dataset: { fk }, onclick: () => choose(day) }, label);

    const title = h('strong', { class: 'datepop-month', 'aria-live': 'polite' });
    const grid = h('div', { class: 'datepop-grid', role: 'grid' });
    const head = h('div', { class: 'datepop-weekdays', 'aria-hidden': 'true' }, weekdayNames(getLocale(), 'narrow', getWeekStart()).map((n) => h('span', {}, n)));

    function draw() {
      title.textContent = periodTitle('month', shown, getLocale());
      const { month, weeks } = monthGrid(shown);
      replace(grid, weeks.map((w) => h('div', { class: 'datepop-week', role: 'row' }, w.days.map((day) => {
        const inMonth = day.slice(0, 7) === month;
        const cls = `datepop-day${inMonth ? '' : ' is-other'}${day === today ? ' is-today' : ''}${day === selected ? ' is-selected' : ''}`;
        return h('button', {
          class: cls, type: 'button', role: 'gridcell', 'aria-selected': String(day === selected), 'aria-label': formatDate(day, today), dataset: { fk: `due-day:${day}`, date: day },
          onclick: () => {
            selected = day;
            if (!inMonth) shown = day;
            draw();
          },
        }, String(Number(day.slice(8, 10))));
      }))));
    }
    const step = (n) => { shown = addMonths(shown, n); draw(); };
    draw();

    return h('form', {
      class: 'dialog-form datepop',
      onsubmit: (e) => {
        e.preventDefault();
        choose(selected || null);
      },
    },
    h('h2', {}, t('task.dueEditTitle')),
    h('div', { class: 'datepop-quick', role: 'group', 'aria-label': t('task.quickDates') },
      quick(t('task.quickToday'), d.today, 'due-today'), quick(t('task.quickTomorrow'), d.tomorrow, 'due-tomorrow'),
      quick(t('task.quickWeekend'), d.weekend, 'due-weekend'), quick(t('task.quickNextWeek'), d.nextWeek, 'due-nextweek'),
      allowNone && due && quick(t('task.quickNone'), null, 'due-none')),
    h('div', { class: 'datepop-cal' },
      h('div', { class: 'datepop-nav' },
        h('button', { class: 'icon-button', type: 'button', 'aria-label': t('calendar.prevMonth'), onclick: () => step(-1), dataset: { fk: 'due-prev' } }, icon('chevronLeft')),
        title,
        h('button', { class: 'icon-button', type: 'button', 'aria-label': t('calendar.nextMonth'), onclick: () => step(1), dataset: { fk: 'due-next' } }, icon('chevronRight'))),
      head, grid),
    h('label', { class: 'field-label datepop-time' }, t('task.dueTime'), h('span', { class: 'datepop-time-row' }, time,
      h('button', { class: 'link-button', type: 'button', onclick: () => { time.value = ''; } }, t('task.dueTimeClear')))),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary', dataset: { fk: 'due-save' } }, t('common.save'))));
  }, { className: 'dialog-sheet' });
}
