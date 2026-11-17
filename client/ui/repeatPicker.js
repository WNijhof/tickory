// De herhalingskiezer in het taakvenster: een knop "Herhalen" bij de snelle datums, en een paneel eronder met vaste keuzes
// (elke dag, elke werkdag, elke week op deze weekdag, elke maand op deze dag, elk jaar op deze datum) en een eigen keuze (elke
// zoveel dagen, weken, maanden of jaren; weekdagen; de dag van de maand, de laatste dag of bijvoorbeeld de tweede dinsdag; een
// tijd; tellen vanaf het afvinken). Een keuze komt als tekst in het datumveld (core/repeat.js), zodat de uitleg onder het veld,
// bewaren en ongedaan maken gewoon werken. Escape sluit alleen het paneel.

import { parseDateText } from '../core/dateInput.js';
import { formatDateInput, formatDueLong } from '../core/format.js';
import { t } from '../core/i18n.js';
import { choiceFromDue, MAX_INTERVAL, monthName, ordinalWord, repeatPresets, repeatSummary, repeatText, weekdayName } from '../core/repeat.js';
import { h, replace } from './dom.js';
import { icon } from './icons.js';

const isoWeekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
const UNITS = ['day', 'week', 'month', 'year'];
const UNIT_LABEL = {
  day: (n) => (n === 1 ? t('repeat.unitDay') : t('repeat.unitDays')),
  week: (n) => (n === 1 ? t('repeat.unitWeek') : t('repeat.unitWeeks')),
  month: (n) => (n === 1 ? t('repeat.unitMonth') : t('repeat.unitMonths')),
  year: (n) => (n === 1 ? t('repeat.unitYear') : t('repeat.unitYears')),
};

let counter = 0;

/**
 * @param {{ field: HTMLInputElement, today: () => string }} options
 * @returns {{ button: HTMLButtonElement, panel: HTMLElement }}
 */
export function repeatPicker({ field, today }) {
  const id = `repeat-panel-${++counter}`;
  const panel = h('div', { class: 'repeat-panel', id, role: 'group', 'aria-label': t('repeat.title'), hidden: true, dataset: { fk: 'repeat-panel' } });
  const button = h('button', {
    class: 'chip-button', type: 'button', 'aria-expanded': 'false', 'aria-controls': id, dataset: { fk: 'repeat-open' },
    onclick: () => (panel.hidden ? open() : close()),
  }, icon('repeat'), t('task.quickRepeat'));

  const dialog = () => field.closest('dialog');
  const onCancel = (e) => { e.preventDefault(); close(); button.focus(); };
  let applyChoice = () => {};
  panel.addEventListener('keydown', (e) => {
    // Enter in een veld van het paneel past de keuze toe (en bewaart niet meteen de hele taak)
    if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey) && e.target.matches('input, select')) {
      e.preventDefault();
      e.stopPropagation();
      applyChoice();
      return;
    }
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // alleen het paneel dicht, niet het venster
    close();
    button.focus();
  });

  /** Wat er nu in het datumveld staat, als `due` (of null). */
  const current = () => (field.value.trim() ? parseDateText(field.value.trim(), new Date()) : null);

  function set(text) {
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true })); // de uitleg onder het veld
    close();
    button.focus();
  }

  function open() {
    draw();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    dialog()?.addEventListener('cancel', onCancel);
    panel.querySelector('button')?.focus();
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    dialog()?.removeEventListener('cancel', onCancel);
  }

  function draw() {
    const due = current();
    const base = due?.date?.slice(0, 10) ?? today();
    const time = due?.date?.length > 10 ? due.date.slice(11, 16) : null;

    // ---- vaste keuzes ----
    const presets = h('div', { class: 'repeat-presets' },
      repeatPresets(base, time).map((p) => h('button', {
        class: 'chip-button', type: 'button', dataset: { fk: `repeat-${p.key}` }, onclick: () => set(repeatText(p.choice)),
      }, repeatSummary(p.choice))),
      due?.recurrence && h('button', {
        class: 'chip-button', type: 'button', dataset: { fk: 'repeat-none' }, onclick: () => set(formatDateInput({ date: due.date })),
      }, t('repeat.none')));

    // ---- zelf kiezen ----
    const start = choiceFromDue(due) ?? { unit: 'week', interval: 1, weekdays: [isoWeekday(base)], time, fromCompletion: false };
    const [, baseMonth, baseDay] = base.split('-').map(Number);
    const state = {
      unit: start.unit === 'workday' ? 'week' : start.unit,
      interval: start.interval ?? 1,
      weekdays: new Set(start.unit === 'workday' ? [1, 2, 3, 4, 5] : (start.weekdays ?? [isoWeekday(base)])),
      monthMode: start.nth ? 'nth' : start.monthDay === 'last' ? 'last' : 'day',
      monthDay: typeof start.monthDay === 'number' ? start.monthDay : baseDay,
      nthN: start.nth?.n ?? Math.min(4, Math.ceil(baseDay / 7)),
      nthWeekday: start.nth?.weekday ?? isoWeekday(base),
      yearDay: start.yearDate?.day ?? baseDay,
      yearMonth: start.yearDate?.month ?? baseMonth,
      time: start.time ?? '',
      fromCompletion: Boolean(start.fromCompletion),
    };
    const choice = () => {
      const c = { unit: state.unit, interval: state.interval, time: state.time || null, fromCompletion: state.fromCompletion };
      if (state.unit === 'week') c.weekdays = [...state.weekdays];
      if (state.unit === 'month') {
        if (state.monthMode === 'nth') Object.assign(c, { interval: 1, nth: { n: state.nthN, weekday: state.nthWeekday } });
        else c.monthDay = state.monthMode === 'last' ? 'last' : state.monthDay;
      }
      if (state.unit === 'year') c.yearDate = { day: state.yearDay, month: state.yearMonth };
      return c;
    };

    const interval = h('input', {
      class: 'field repeat-interval', type: 'number', min: 1, max: MAX_INTERVAL, value: String(state.interval), inputMode: 'numeric',
      'aria-label': t('repeat.interval'), dataset: { fk: 'repeat-interval' },
    });
    const unit = h('select', { class: 'field', 'aria-label': t('repeat.unit'), dataset: { fk: 'repeat-unit' } });
    const fillUnits = () => replace(unit, UNITS.map((u) => h('option', { value: u, selected: u === state.unit }, UNIT_LABEL[u](state.interval))));

    // weken: welke dagen
    const weekdays = h('div', { class: 'repeat-weekdays', role: 'group', 'aria-label': t('repeat.onWeekdays') },
      [1, 2, 3, 4, 5, 6, 7].map((d) => {
        const b = h('button', {
          class: 'repeat-day', type: 'button', title: weekdayName(d), 'aria-label': weekdayName(d), 'aria-pressed': String(state.weekdays.has(d)),
          dataset: { fk: `repeat-day-${d}` },
          onclick: () => {
            if (state.weekdays.has(d)) state.weekdays.delete(d);
            else state.weekdays.add(d);
            b.setAttribute('aria-pressed', String(state.weekdays.has(d)));
            update();
          },
        }, weekdayName(d, 'short'));
        return b;
      }));

    // maanden: de dag, de laatste dag of de n-de weekdag
    const radio = (mode, label, ...extra) => h('label', { class: 'repeat-option' },
      h('input', { type: 'radio', name: `${id}-month`, value: mode, checked: state.monthMode === mode, onchange: () => { state.monthMode = mode; update(); } }),
      h('span', {}, label), ...extra);
    const monthDay = h('input', { class: 'field repeat-small', type: 'number', min: 1, max: 31, value: String(state.monthDay), 'aria-label': t('repeat.monthDayLabel') });
    const nthN = h('select', { class: 'field', 'aria-label': t('repeat.ordinalLabel') },
      [1, 2, 3, 4, -1].map((n) => h('option', { value: String(n), selected: n === state.nthN }, ordinalWord(n))));
    const weekdayOptions = (selected) => [1, 2, 3, 4, 5, 6, 7].map((d) => h('option', { value: String(d), selected: d === selected }, weekdayName(d)));
    const nthWeekday = h('select', { class: 'field', 'aria-label': t('repeat.weekdayLabel') }, weekdayOptions(state.nthWeekday));
    const months = h('div', { class: 'repeat-months' },
      radio('day', t('repeat.monthOnDay'), monthDay),
      radio('last', t('repeat.monthLast')),
      radio('nth', t('repeat.monthNth'), nthN, nthWeekday));

    // jaren: de datum
    const yearDay = h('input', { class: 'field repeat-small', type: 'number', min: 1, max: 31, value: String(state.yearDay), 'aria-label': t('repeat.yearDayLabel') });
    const yearMonth = h('select', { class: 'field', 'aria-label': t('repeat.yearMonthLabel') },
      Array.from({ length: 12 }, (_, i) => h('option', { value: String(i + 1), selected: i + 1 === state.yearMonth }, monthName(i + 1))));
    const years = h('div', { class: 'repeat-row' }, h('span', {}, t('repeat.yearOn')), yearDay, yearMonth);

    const timeInput = h('input', { class: 'field repeat-time', type: 'time', value: state.time, dataset: { fk: 'repeat-time' } });
    const fromCompletion = h('input', { type: 'checkbox', checked: state.fromCompletion, dataset: { fk: 'repeat-from-completion' } });
    const preview = h('p', { class: 'hint', 'aria-live': 'polite', dataset: { fk: 'repeat-preview' } });
    applyChoice = () => {
      update();
      const text = repeatText(choice());
      if (text && parseDateText(text, new Date())) set(text);
    };
    const apply = h('button', { class: 'button button-primary', type: 'button', dataset: { fk: 'repeat-apply' }, onclick: () => applyChoice() }, t('repeat.apply'));

    const num = (input, lo, hi) => {
      const n = Number(input.value);
      return Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : lo;
    };
    function update() {
      state.interval = num(interval, 1, MAX_INTERVAL);
      state.monthDay = num(monthDay, 1, 31);
      state.yearDay = num(yearDay, 1, 31);
      state.nthN = Number(nthN.value);
      state.nthWeekday = Number(nthWeekday.value);
      state.yearMonth = Number(yearMonth.value);
      state.time = timeInput.value;
      state.fromCompletion = fromCompletion.checked;
      weekdays.hidden = state.unit !== 'week';
      months.hidden = state.unit !== 'month';
      years.hidden = state.unit !== 'year';
      interval.disabled = state.unit === 'month' && state.monthMode === 'nth'; // de n-de weekdag is altijd elke maand
      const c = choice();
      const text = repeatText(c);
      const next = text ? parseDateText(text, new Date()) : null;
      preview.textContent = next ? t('repeat.previewNext', { rule: repeatSummary(c), date: formatDueLong({ date: next.date }, today()) }) : '';
      apply.disabled = !next;
    }
    interval.addEventListener('input', () => {
      update();
      const keep = unit.value;
      fillUnits(); // "1 week" of "2 weken"
      unit.value = keep;
    });
    unit.addEventListener('change', () => { state.unit = unit.value; update(); });
    for (const el of [monthDay, nthN, nthWeekday, yearDay, yearMonth, timeInput, fromCompletion]) el.addEventListener('input', update);
    for (const el of [nthN, nthWeekday, yearMonth, fromCompletion]) el.addEventListener('change', update);
    fillUnits();

    replace(panel,
      presets,
      h('div', { class: 'repeat-custom' },
        h('h4', { class: 'repeat-heading' }, t('repeat.custom')),
        h('div', { class: 'repeat-row' }, h('span', {}, t('repeat.every')), interval, unit),
        weekdays, months, years,
        h('label', { class: 'repeat-row' }, h('span', {}, t('repeat.time')), timeInput),
        h('label', { class: 'repeat-option', title: t('repeat.fromCompletionHint') }, fromCompletion, h('span', {}, t('repeat.fromCompletion'))),
        preview,
        h('div', { class: 'repeat-actions' }, apply)));
    update();
  }

  return { button, panel };
}
