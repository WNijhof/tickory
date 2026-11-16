// Instellingen › Algemeen (SPEC 5m, shared/general.js): de startpagina, de tijdnotatie, of snel toevoegen datums in gewone taal
// herkent, en welke onderdelen in de zijbalk staan. Bewaard in je instellingen op de server, dus op al je apparaten hetzelfde.

import { BOTTOM_TAB_CHOICES, BOTTOM_TAB_COUNT, SIDEBAR_ITEMS, START_PAGES, TIME_FORMATS, WEEK_STARTS, generalOf } from '../../shared/general.js';
import { weekdayNames } from '../core/calendar.js';
import { getLocale, t } from '../core/i18n.js';
import { mySettings } from '../core/selectors.js';
import { h, openDialog } from './dom.js';

// letterlijke sleutels, zodat de controle op ontbrekende en ongebruikte teksten ze vindt
const START_LABEL = {
  last: () => t('general.startLast'), inbox: () => t('bottomNav.inbox'), today: () => t('nav.today'), upcoming: () => t('nav.upcoming'), notes: () => t('note.title'),
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
 * @param {{ store: import('../core/store.js').Store, actions: { updateSettings: (c: object) => Promise<unknown> } }} options
 * @returns {Promise<boolean>} true als er iets is bewaard
 */
export function openGeneralDialog({ store, actions }) {
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
    const tabSelects = Array.from({ length: BOTTOM_TAB_COUNT }, (_, i) => h('select', {
      class: 'field', 'aria-label': t('general.tabN', { n: i + 1 }), dataset: { fk: `general-tab:${i}` },
    }, BOTTOM_TAB_CHOICES.map((c) => h('option', { value: c, selected: c === now.bottom_tabs[i] }, TAB_LABEL[c]()))));
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
          start_page: start.value,
          time_format: clocks.map((l) => l.querySelector('input')).find((i) => i.checked)?.value ?? '24h',
          date_recognition: dates.checked,
          sidebar_hidden: items.map((l) => l.querySelector('input')).filter((i) => !i.checked).map((i) => i.value),
          week_start: Number(weekStart.value),
          bottom_tabs: bottomTabs,
        };
        await actions.updateSettings({ general: next });
        finish(true);
      },
    },
    h('h2', {}, t('settings.general')),
    h('label', { class: 'field-label' }, t('general.start'), start),
    h('label', { class: 'field-label' }, t('general.weekStart'), weekStart),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.clock')), clocks),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.quickAdd')),
      h('label', { class: 'check-row' }, dates, t('general.dates')),
      h('p', { class: 'hint' }, t('general.datesHint'))),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.sidebar')), items),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('general.bottomBar')),
      h('p', { class: 'hint' }, t('general.bottomBarHint')),
      h('div', { class: 'general-tabs' }, tabSelects), tabError),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(false) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary', dataset: { fk: 'general-save' } }, t('common.save'))));
  });
}
