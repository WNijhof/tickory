// Instellingen › Algemeen (SPEC 5m, shared/general.js): de startpagina, de tijdnotatie, of snel toevoegen datums in gewone taal
// herkent, en welke onderdelen in de zijbalk staan. Bewaard in je instellingen op de server, dus op al je apparaten hetzelfde.

import { BOTTOM_TAB_CHOICES, BOTTOM_TAB_COUNT, SIDEBAR_ITEMS, SNOOZE_MINUTES, START_PAGES, SWIPE_ACTIONS, TIME_FORMATS, TOAST_SECONDS, WEEKDAYS, WEEK_STARTS, generalOf } from '../../shared/general.js';
import { weekdayNames } from '../core/calendar.js';
import { getLocale, t } from '../core/i18n.js';
import { mySettings } from '../core/selectors.js';
import { h, openDialog } from './dom.js';

// letterlijke sleutels, zodat de controle op ontbrekende en ongebruikte teksten ze vindt
const START_LABEL = {
  last: () => t('general.startLast'), inbox: () => t('bottomNav.inbox'), today: () => t('nav.today'), upcoming: () => t('nav.upcoming'), notes: () => t('note.title'),
};
const SWIPE_LABEL = {
  none: () => t('swipe.action.none'), select: () => t('swipe.action.select'), complete: () => t('swipe.action.complete'),
  schedule: () => t('swipe.action.schedule'), reminders: () => t('swipe.action.reminders'), delete: () => t('swipe.action.delete'),
};
export const SNOOZE_LABEL = {
  5: () => t('general.snoozeFive'), 10: () => t('general.snoozeTen'), 15: () => t('general.snoozeQuarter'), 30: () => t('general.snoozeHalf'),
  60: () => t('general.snoozeHour'), 360: () => t('general.snoozeSixHours'), 720: () => t('general.snoozeHalfDay'), 1440: () => t('general.snoozeDay'),
};
const CLOCK_LABEL = { '24h': () => t('general.clockFull'), '12h': () => t('general.clockHalf') };
const TAB_LABEL = {
  inbox: () => t('bottomNav.inbox'), today: () => t('nav.today'), upcoming: () => t('nav.upcoming'), notes: () => t('note.title'),
  notifications: () => t('inbox.title'), completed: () => t('nav.completed'), filters: () => t('filters.title'), labels: () => t('labels.title'),
};
const ITEM_LABEL = {
  upcoming: () => t('nav.upcoming'), completed: () => t('nav.completed'), notifications: () => t('inbox.title'),
  notes: () => t('note.title'), filters: () => t('filters.title'), labels: () => t('labels.title'),
};

/**
 * Welk deel van de instellingen het venster toont, zoals Todoist ze indeelt: Algemeen, Navigatiemenu (de zijbalk) en Navigatiebalk
 * (onderaan op een telefoon). 'all' is alles in één venster. Wat een deel niet toont, blijft bij bewaren zoals het was. Uitstellen
 * staat bij Herinneringen en het ochtendoverzicht bij Meldingen (ui/reminderUi.js); in 'all' staan ze ook hier.
 * @typedef {'all' | 'general' | 'sidebar' | 'bottombar'} GeneralPart
 */
const PART_TITLE = { all: () => t('settings.general'), general: () => t('settings.general'), sidebar: () => t('settings.sidebarMenu'), bottombar: () => t('settings.bottomBar') };

/**
 * @param {{ store: import('../core/store.js').Store, actions: { updateSettings: (c: object) => Promise<unknown> }, part?: GeneralPart }} options
 * @returns {Promise<boolean>} true als er iets is bewaard
 */
export function openGeneralDialog({ store, actions, part = 'all' }) {
  const show = (...parts) => part === 'all' || parts.includes(part);
  const now = generalOf(mySettings(store.view, store.userId));
  return openDialog((finish) => {
    const start = h('select', { class: 'field', dataset: { fk: 'general-start' } },
      START_PAGES.map((p) => h('option', { value: p, selected: p === now.start_page }, START_LABEL[p]())));
    const clocks = TIME_FORMATS.map((f) => h('label', { class: 'check-row' },
      h('input', { type: 'radio', name: 'general-clock', value: f, checked: f === now.time_format, dataset: { fk: `general-clock:${f}` } }), CLOCK_LABEL[f]()));
    const dates = h('input', { type: 'checkbox', checked: now.date_recognition, dataset: { fk: 'general-dates' } });
    const dayNames = weekdayNames(getLocale(), 'long');
    const weekStart = h('select', { class: 'field', dataset: { fk: 'general-week' } },
      WEEK_STARTS.map((d) => h('option', { value: String(d), selected: d === now.week_start }, dayNames[d - 1])));
    const daySelect = (fk, value) => h('select', { class: 'field', dataset: { fk } },
      WEEKDAYS.map((d) => h('option', { value: String(d), selected: d === value }, dayNames[d - 1])));
    const nextWeek = daySelect('general-nextweek', now.next_week);
    const weekend = daySelect('general-weekend', now.weekend);
    const swipeSelect = (fk, value) => h('select', { class: 'field', dataset: { fk } },
      SWIPE_ACTIONS.map((a) => h('option', { value: a, selected: a === value }, SWIPE_LABEL[a]())));
    const swipeRight = swipeSelect('general-swipe-right', now.swipe_right);
    const swipeLeft = swipeSelect('general-swipe-left', now.swipe_left);
    // het ochtendoverzicht en de avondreview (Android): een vinkje en een tijd
    const overviewRow = (fk, value, fallback, label) => {
      const on = h('input', { type: 'checkbox', checked: value !== null, dataset: { fk: `${fk}-on` } });
      const time = h('input', { type: 'time', class: 'field', value: value ?? fallback, 'aria-label': label, dataset: { fk: `${fk}-time` } });
      return { on, time, row: h('div', { class: 'check-row general-overview' }, h('label', { class: 'check-row' }, on, label), time), get value() { return on.checked && time.value ? time.value : null; } };
    };
    const morning = overviewRow('general-morning', now.morning_overview, '08:00', t('general.morning'));
    const evening = overviewRow('general-evening', now.evening_review, '18:00', t('general.evening'));
    const resetSubtasks = h('input', { type: 'checkbox', checked: now.reset_subtasks, dataset: { fk: 'general-reset-subtasks' } });
    const sound = h('input', { type: 'checkbox', checked: now.completion_sound, dataset: { fk: 'general-sound' } });
    const toastTime = h('select', { class: 'field', dataset: { fk: 'general-toast' } },
      TOAST_SECONDS.map((s) => h('option', { value: String(s), selected: s === now.toast_seconds }, s === 0 ? t('general.toastSticky') : t('general.toastSeconds', { count: s }))));
    const snooze = h('select', { class: 'field', dataset: { fk: 'general-snooze' } },
      SNOOZE_MINUTES.map((m) => h('option', { value: String(m), selected: m === now.snooze_minutes }, SNOOZE_LABEL[m]())));
    const tabSelects = Array.from({ length: BOTTOM_TAB_COUNT }, (_, i) => h('select', {
      class: 'field', 'aria-label': t('general.tabN', { n: i + 1 }), dataset: { fk: `general-tab:${i}` },
    }, BOTTOM_TAB_CHOICES.map((c) => h('option', { value: c, selected: c === now.bottom_tabs[i] }, TAB_LABEL[c]()))));
    const productivity = h('input', { type: 'checkbox', checked: now.productivity, dataset: { fk: 'general-productivity' } });
    const tabError = h('p', { class: 'error', role: 'alert' });
    const items = SIDEBAR_ITEMS.map((key) => h('label', { class: 'check-row' },
      h('input', { type: 'checkbox', value: key, checked: !now.sidebar_hidden.includes(key), dataset: { fk: `general-nav:${key}` } }), ITEM_LABEL[key]()));
    return h('form', {
      class: 'dialog-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const bottomTabs = tabSelects.map((s) => s.value);
        if (new Set(bottomTabs).size !== bottomTabs.length) { tabError.textContent = t('general.tabsTwice'); tabSelects[0].focus(); return; }
        const next = {
          ...now, // wat dit venster niet toont (de vakanties) blijft zoals het was
          start_page: start.value,
          time_format: clocks.map((l) => l.querySelector('input')).find((i) => i.checked)?.value ?? '24h',
          date_recognition: dates.checked,
          sidebar_hidden: items.map((l) => l.querySelector('input')).filter((i) => !i.checked).map((i) => i.value),
          week_start: Number(weekStart.value),
          bottom_tabs: bottomTabs,
          productivity: productivity.checked,
          next_week: Number(nextWeek.value),
          weekend: Number(weekend.value),
          swipe_right: swipeRight.value,
          swipe_left: swipeLeft.value,
          completion_sound: sound.checked,
          reset_subtasks: resetSubtasks.checked,
          morning_overview: morning.value,
          evening_review: evening.value,
          snooze_minutes: Number(snooze.value),
          toast_seconds: Number(toastTime.value),
        };
        await actions.updateSettings({ general: next });
        finish(true);
      },
    },
    h('h2', {}, PART_TITLE[part]()),
    show('general') && [
    h('label', { class: 'field-label' }, t('general.start'), start),
    h('label', { class: 'field-label' }, t('general.weekStart'), weekStart),
    h('label', { class: 'field-label' }, t('general.nextWeek'), nextWeek),
    h('label', { class: 'field-label' }, t('general.weekend'), weekend),
    h('p', { class: 'hint' }, t('general.dayHint')),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.clock')), clocks),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.quickAdd')),
      h('label', { class: 'check-row' }, dates, t('general.dates')),
      h('p', { class: 'hint' }, t('general.datesHint'))),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.swipe')),
      h('label', { class: 'field-label' }, t('general.swipeRight'), swipeRight),
      h('label', { class: 'field-label' }, t('general.swipeLeft'), swipeLeft)),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.recurring')),
      h('label', { class: 'check-row' }, resetSubtasks, t('general.resetSubtasks')),
      h('p', { class: 'hint' }, t('general.resetSubtasksHint'))),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.sound')),
      h('label', { class: 'check-row' }, sound, t('general.soundOn'))),
    h('label', { class: 'field-label' }, t('general.toast'), toastTime),
    h('p', { class: 'hint' }, t('general.toastHint'))],
    part === 'all' && [
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.overview')),
      morning.row, evening.row,
      h('p', { class: 'hint' }, t('general.overviewHint'))),
    h('label', { class: 'field-label' }, t('general.snooze'), snooze),
    h('p', { class: 'hint' }, t('general.snoozeHint'))],
    show('sidebar') && [
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.productivity')),
      h('label', { class: 'check-row' }, productivity, t('general.productivityShow')),
      h('p', { class: 'hint' }, t('general.productivityHint'))),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.sidebar')), items)],
    show('bottombar') && h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.bottomBar')),
      h('p', { class: 'hint' }, t('general.bottomBarHint')),
      h('div', { class: 'general-tabs' }, tabSelects), tabError),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(false) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary', dataset: { fk: 'general-save' } }, t('common.save'))));
  });
}
