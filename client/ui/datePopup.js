// De datumkiezer, zoals in de Todoist-app: bovenaan een veld met de gekozen datum (je kunt er ook in typen: "volgende week maandag"),
// dan de snelle keuzes met de weekdag rechts (vandaag, morgen, dit weekend, volgende week, geen datum), een maandkalender, en
// "Tijd toevoegen". Gebruikt bij het aantikken van de datum van een taak (ui/app.js: handlers.reschedule) en in het venster
// "Taak toevoegen" (ui/quickAdd.js).
//
// Een snelle keuze bewaart meteen, met het tijdstip dat er dan staat. Een dag in de kalender kiezen markeert hem; "Opslaan" bewaart
// dag en tijd. De week begint op de dag uit Instellingen › Algemeen.

import { addMonths, getWeekStart, monthGrid, periodTitle, weekdayNames } from '../core/calendar.js';
import { parseDateText } from '../core/dateInput.js';
import { clockText, formatDate, formatDateInput } from '../core/format.js';
import { getLocale, t } from '../core/i18n.js';
import { quickDates, reschedule } from '../core/quickDates.js';
import { choiceFromDue, repeatPresets, repeatSummary, repeatText } from '../core/repeat.js';
import { h, menuDialog, openDialog, replace } from './dom.js';
import { icon } from './icons.js';
import { repeatPicker } from './repeatPicker.js';

/** De korte weekdag ("do") van een dag 'YYYY-MM-DD', in de taal van de app. */
const shortWeekday = (day) => new Intl.DateTimeFormat(getLocale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`)).replace('.', '');

/**
 * Wat een gekozen dag en tijd (en herhaling) met een datum doen: `current` is de datum van de taak, `picked` de uitkomst van [pickDateTime].
 * Is er geen herhaling gekozen of weggehaald (geen `recurrence` in `picked`), dan blijft een bestaande herhaling zoals ze was.
 */
export function applyPicked(current, picked) {
  if (!picked?.date) return null;
  let base = current ?? null;
  if ('recurrence' in picked) base = picked.recurrence ? { date: picked.date, recurrence: picked.recurrence } : base ? { date: base.date } : null;
  return reschedule(base, picked.date, picked.time);
}

/**
 * @param {{ today: string, due?: { date: string } | null, allowNone?: boolean, counts?: Map<string, number> | null, title?: string | null, dayOnly?: boolean,
 *   showNone?: boolean | null, noneLabel?: string | null, className?: string }} options  `due`: de huidige datum (met of zonder tijd);
 *   `title`: een eigen kop (meer taken tegelijk); `dayOnly`: alleen een dag, zonder tijd en herhaling (meer taken tegelijk, die hun eigen
 *   tijd en herhaling houden); `showNone`: "Geen datum" tonen ook zonder `due` (null: alleen met een datum); `noneLabel`: een eigen tekst daarvoor;
 *   `allowNone`: een keuze "Geen datum" erbij (zonder huidige datum is die er niet); `counts`: het aantal open taken per dag (core/dueCounts.js),
 *   voor een stipje bij die dagen en het aantal in het bijschrift
 * @returns {Promise<{ date: string | null, time: string, recurrence?: object | null } | null>} de keuze (`date` null = geen datum, `time` '' = geen tijd;
 *   `recurrence` alleen als je de herhaling koos (een regel) of wegdeed (null)), of null bij sluiten
 */
export function pickDateTime({ today, due = null, allowNone = true, counts = null, title: heading = null, dayOnly = false, showNone = null, noneLabel = null, className = 'dialog-sheet' }) {
  const d = quickDates(today);
  let timeValue = due?.date.length > 10 ? due.date.slice(11, 16) : '';
  let selected = due?.date.slice(0, 10) ?? '';
  let shown = selected || today; // de maand die de kalender toont
  let timePicking = false; // het tijdveld is open (na "Tijd toevoegen")
  let recurrence = due?.recurrence ?? null; // de herhaling (bestaand of gekozen)
  let repeatChanged = false;
  // Op een telefoon scrolt de kalender door (twaalf maanden onder elkaar, zoals in Todoist); anders één maand met pijlen.
  const stacked = Boolean(globalThis.matchMedia?.('(max-width: 760px)').matches);
  const stackStart = shown;
  return openDialog((finish) => {
    const choose = (day) => finish(day ? { date: day, time: timeValue, ...(repeatChanged ? { recurrence } : {}) } : { date: null, time: '' });

    // ---- het veld met de gekozen datum (en tijd); typen werkt de keuze bij ----
    const text = (day) => (day ? `${formatDate(day, today)}${timeValue ? ` ${clockText(timeValue)}` : ''}` : '');
    const field = h('input', { class: 'datepop-input', type: 'text', value: text(selected), placeholder: t('quick.date'), 'aria-label': t('quick.date'), autocomplete: 'off', dataset: { fk: 'due-text' } });
    field.addEventListener('input', () => {
      const parsed = parseDateText(field.value.trim(), new Date());
      if (!parsed?.date) return;
      selected = parsed.date.slice(0, 10);
      if (parsed.date.length > 10) timeValue = parsed.date.slice(11, 16);
      shown = selected;
      draw(false);
    });

    const title = h('strong', { class: 'datepop-month', 'aria-live': 'polite' });
    const grid = h('div', { class: 'datepop-grid', role: 'grid' });
    const head = h('div', { class: 'datepop-weekdays', 'aria-hidden': 'true' }, weekdayNames(getLocale(), 'narrow', getWeekStart()).map((n) => h('span', {}, n)));
    const caption = h('p', { class: 'datepop-caption', 'aria-live': 'polite' });
    const countOf = (day) => counts?.get(day) ?? 0;

    // ---- tijd: een rij "Tijd toevoegen"; daarna een chip met de tijd en een kruisje ----
    const time = h('input', { class: 'field datepop-time-input', type: 'time', value: timeValue, 'aria-label': t('task.dueTime'), dataset: { fk: 'due-time' } });
    time.addEventListener('input', () => { timeValue = time.value; draw(false); });
    const timeRow = h('div', { class: 'datepop-row datepop-timerow' });
    const paintTime = () => {
      replace(timeRow, [
        icon('clock'),
        timeValue
          ? h('span', { class: 'datepop-chip' }, clockText(timeValue), h('button', { type: 'button', class: 'datepop-chip-x', 'aria-label': t('task.dueTimeClear'), onclick: () => { timeValue = ''; time.value = ''; timePicking = false; draw(false); } }, icon('close')))
          : !timePicking && h('button', { type: 'button', class: 'datepop-rowbutton', dataset: { fk: 'due-addtime' }, onclick: () => { timePicking = true; paintTime(); time.focus(); try { time.showPicker?.(); } catch { /* geen kiezer: het veld zelf werkt */ } } }, t('task.dueTimeAdd')),
        timePicking && !timeValue && time,
      ]);
    };

    // ---- herhaling: een rij "Herhaling" met de vaste keuzes (elke dag, werkdag, week, maand, jaar); daarna een chip met een kruisje ----
    const repeatRow = h('div', { class: 'datepop-row datepop-repeatrow' });
    const paintRepeat = () => {
      const summary = recurrence ? repeatSummary(choiceFromDue({ date: selected || today, recurrence })) : null;
      replace(repeatRow, [
        icon('repeat'),
        summary
          ? h('span', { class: 'datepop-chip' }, summary, h('button', { type: 'button', class: 'datepop-chip-x', 'aria-label': t('repeat.none'), dataset: { fk: 'due-repeat-clear' }, onclick: () => { recurrence = null; repeatChanged = true; paintRepeat(); } }, icon('close')))
          : h('button', { type: 'button', class: 'datepop-rowbutton', dataset: { fk: 'due-repeat' }, onclick: pickRepeat }, t('repeat.title')),
      ]);
    };
    async function pickRepeat() {
      const day = selected || today;
      const presets = repeatPresets(day, timeValue || null);
      const key = await menuDialog({ title: t('repeat.title'), items: [...presets.map((p) => ({ value: p.key, label: repeatSummary(p.choice) })), { value: 'custom', label: t('repeat.customItem') }] });
      if (key === 'custom') return customRepeat();
      const preset = presets.find((p) => p.key === key);
      if (!preset) return;
      const parsed = parseDateText(repeatText(preset.choice), new Date());
      if (!parsed?.recurrence) return;
      recurrence = parsed.recurrence;
      repeatChanged = true;
      if (!selected) { selected = parsed.date.slice(0, 10); shown = selected; draw(); } else paintRepeat();
    }

    const dayButton = (day, inMonth) => {
      const cls = `datepop-day${inMonth ? '' : ' is-other'}${day === today ? ' is-today' : ''}${day === selected ? ' is-selected' : ''}${countOf(day) > 0 ? ' has-tasks' : ''}`;
      return h('button', {
        class: cls, type: 'button', role: 'gridcell', 'aria-selected': String(day === selected), 'aria-label': countOf(day) > 0 ? `${formatDate(day, today)} · ${t('datepop.tasks', { count: countOf(day) })}` : formatDate(day, today), dataset: { fk: `due-day:${day}`, date: day },
        onclick: () => {
          selected = day;
          if (!inMonth) shown = day;
          draw();
        },
      }, String(Number(day.slice(8, 10))));
    };

    // "Aangepast…": het volledige paneel van het taakvenster (ui/repeatPicker.js) in een blad: elke zoveel dagen, weken, maanden of jaren,
    // weekdagen, de n-de weekdag, een tijd en tellen vanaf het afvinken. Het paneel schrijft zijn keuze als tekst in een verborgen veld.
    async function customRepeat() {
      const day = selected || today;
      const field = h('input', { type: 'hidden' });
      const date = timeValue ? `${day}T${timeValue}` : day;
      field.value = formatDateInput(recurrence ? { date, recurrence } : { date });
      const picker = repeatPicker({ field, today: () => day });
      let picked = null;
      field.addEventListener('input', () => {
        const parsed = parseDateText(field.value.trim(), new Date());
        if (parsed?.recurrence) picked = parsed;
      });
      picker.button.click(); // opent het paneel
      const panel = picker.panel;
      await openDialog((done) => {
        new MutationObserver(() => { if (panel.hidden) done(null); }).observe(panel, { attributes: true, attributeFilter: ['hidden'] }); // "Toepassen" sluit het paneel
        return h('div', { class: 'dialog-form' },
          h('h2', {}, t('repeat.title')),
          panel,
          h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => done(null) }, t('common.close'))));
      }, { className: 'dialog-sheet', onClose: () => { if (!panel.hidden) picker.button.click(); } });
      if (!picked) return;
      recurrence = picked.recurrence;
      repeatChanged = true;
      if (!selected) { selected = picked.date.slice(0, 10); shown = selected; draw(); } else paintRepeat();
    }

    function draw(syncField = true) {
      title.textContent = periodTitle('month', shown, getLocale());
      if (stacked) {
        const top = grid.scrollTop; // een dag kiezen tekent opnieuw: de plek in de lijst blijft
        replace(grid, Array.from({ length: 12 }, (_, i) => addMonths(stackStart, i)).map((first, i) => {
          const { month, weeks } = monthGrid(first);
          return h('div', { class: 'datepop-monthblock', dataset: { month } },
            i > 0 && h('strong', { class: 'datepop-monthtitle' }, periodTitle('month', first, getLocale())),
            weeks.map((w) => h('div', { class: 'datepop-week', role: 'row' }, w.days.map((day) => (day.slice(0, 7) === month ? dayButton(day, true) : h('span', { class: 'datepop-blank', 'aria-hidden': 'true' }))))));
        }));
        grid.scrollTop = top;
      } else {
        const { month, weeks } = monthGrid(shown);
        replace(grid, weeks.map((w) => h('div', { class: 'datepop-week', role: 'row' }, w.days.map((day) => dayButton(day, day.slice(0, 7) === month)))));
      }
      caption.textContent = selected ? `${text(selected)}${countOf(selected) > 0 ? ` · ${t('datepop.tasks', { count: countOf(selected) })}` : ''}` : '';
      if (syncField && document.activeElement !== field) field.value = text(selected);
      paintTime();
      paintRepeat();
    }
    const step = (n) => { shown = addMonths(shown, n); draw(false); };
    draw();

    // `data-date`: de dag van de keuze ('' = geen datum), voor de tests en voor wie het venster van buiten bedient
    const quick = (label, day, fk, glyph) => h('button', { class: 'datepop-row datepop-quickrow', type: 'button', dataset: { fk, date: day ?? '' }, onclick: () => choose(day) },
      icon(glyph), h('span', { class: 'datepop-rowlabel' }, label), day && h('span', { class: 'datepop-rowday' }, shortWeekday(day)));

    return h('form', {
      class: 'dialog-form datepop',
      onsubmit: (e) => {
        e.preventDefault();
        choose(selected || null);
      },
    },
    h('h2', {}, heading ?? t('quick.date')),
    h('label', { class: 'datepop-fieldwrap' }, icon('calendar'), field),
    h('div', { class: 'datepop-quick', role: 'group', 'aria-label': t('task.quickDates') },
      quick(t('task.quickToday'), d.today, 'due-today', 'today'), quick(t('task.quickTomorrow'), d.tomorrow, 'due-tomorrow', 'sun'),
      quick(t('task.quickWeekend'), d.weekend, 'due-weekend', 'sofa'), quick(t('task.quickNextWeek'), d.nextWeek, 'due-nextweek', 'nextWeek'),
      allowNone && (showNone ?? Boolean(due)) && quick(noneLabel ?? t('task.quickNone'), null, 'due-none', 'ban')),
    h('div', { class: `datepop-cal${stacked ? ' datepop-cal-stacked' : ''}` },
      h('div', { class: 'datepop-nav' },
        h('button', { class: 'icon-button', type: 'button', 'aria-label': t('calendar.prevMonth'), onclick: () => step(-1), dataset: { fk: 'due-prev' } }, icon('chevronLeft')),
        title,
        h('button', { class: 'icon-button', type: 'button', 'aria-label': t('calendar.nextMonth'), onclick: () => step(1), dataset: { fk: 'due-next' } }, icon('chevronRight'))),
      head, stacked ? h('div', { class: 'datepop-scroll' }, grid) : grid, caption),
    !dayOnly && timeRow,
    !dayOnly && repeatRow,
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary', dataset: { fk: 'due-save' } }, t('common.save'))));
  }, { className });
}
