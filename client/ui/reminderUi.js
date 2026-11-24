// Schermen voor herinneringen: het stuk in het taakvenster, en het scherm "Herinneringen en meldingen" in de instellingen.

import { hasTime } from '../../shared/reminders.js';
import { SNOOZE_MINUTES, generalOf } from '../../shared/general.js';
import { androidBridge } from '../core/android.js';
import { formatDateTimeLocal } from '../core/format.js';
import { t } from '../core/i18n.js';
import { needsTimeNote, presetOptions, reminderLine } from '../core/reminderText.js';
import { locationAdvice } from '../core/places.js';
import { mySettings, placeList, remindersOf } from '../core/selectors.js';
import { h, openDialog, replace } from './dom.js';
import { icon } from './icons.js';
import { placesDialog } from './placesUi.js';
import { pushKindsSection } from './inboxSettings.js';
import { SNOOZE_LABEL } from './generalDialog.js';

const CUSTOM = 'custom';
const PLACE = 'place';

/**
 * Het stuk "Herinneringen" in het taakvenster: je eigen herinneringen bij deze taak, met de keuzes van Todoist
 * (op het tijdstip, 10/30/45 minuten, 1/2/3 uur, 1/2/3 dagen vooraf, of een eigen datum en tijd). Wijzigingen gaan direct door,
 * zoals bij subtaken. Geef `dispose` aan als het venster sluit.
 * @returns {{ node: HTMLElement, dispose: () => void }}
 */
export function reminderSection({ task, store, actions, today, bridge = androidBridge() }) {
  const list = h('ul', { class: 'device-list' });
  const note = h('p', { class: 'hint', 'aria-live': 'polite' });
  const choose = h('select', { class: 'field', 'aria-label': t('reminder.choose') },
    presetOptions().map((o) => h('option', { value: String(o.minutes), selected: o.minutes === 30 }, o.label)),
    h('option', { value: CUSTOM }, t('reminder.custom')),
    h('option', { value: PLACE }, t('reminder.place')));
  const custom = h('input', { class: 'field', type: 'datetime-local', 'aria-label': t('reminder.customLabel'), hidden: true });
  // een eigen regel (niet de klasse 'error' van het taakvenster zelf), zodat de twee elkaar niet in de weg zitten
  const error = h('p', { class: 'hint hint-bad', role: 'alert', dataset: { role: 'reminder-error' } });
  // Op een plek: een plaats van jezelf en aankomst of vertrek. Of het afgaat, bepaalt alleen de Android-app, op het toestel zelf.
  const placeSelect = h('select', { class: 'field', 'aria-label': t('reminder.placeLabel'), hidden: true, dataset: { role: 'reminder-place' } });
  const triggerSelect = h('select', { class: 'field', 'aria-label': t('reminder.triggerLabel'), hidden: true, dataset: { role: 'reminder-trigger' } },
    h('option', { value: 'enter' }, t('reminder.triggerEnter')), h('option', { value: 'leave' }, t('reminder.triggerLeave')));
  const placeNote = h('p', { class: 'hint', 'aria-live': 'polite', dataset: { role: 'reminder-place-note' } });
  const managePlaces = h('button', { type: 'button', class: 'button button-small', hidden: true, dataset: { role: 'reminder-place-manage' }, onclick: () => placesDialog({ store, actions, bridge }) }, t('reminder.placeManage'));

  const current = () => store.view.tasks.get(task.id) ?? task;

  const draw = () => {
    const items = remindersOf(store.view, task.id, store.userId);
    replace(list, items.length > 0
      ? items.map(({ reminder, moment }) => h('li', { class: 'device' },
        h('span', { class: 'device-info' }, reminderLine(reminder, moment, today(), store.view.places)),
        h('button', {
          type: 'button', class: 'button button-small', 'aria-label': `${t('reminder.remove')}: ${reminderLine(reminder, moment, today(), store.view.places)}`, onclick: () => actions.deleteReminder(reminder.id),
        }, '×')))
      : [h('li', { class: 'hint' }, t('reminder.none'))]);
    const onlyLocation = items.length > 0 && items.every(({ reminder }) => reminder.type === 'location');
    note.textContent = hasTime(current().due?.date) || onlyLocation ? '' : needsTimeNote();
    drawPlaceChoice(items);
  };

  const drawPlaceChoice = (items) => {
    const places = placeList(store.view, store.userId);
    const chosen = choose.value === PLACE;
    const keep = placeSelect.value;
    replace(placeSelect, places.map((p) => h('option', { value: p.id }, p.name)));
    if (places.some((p) => p.id === keep)) placeSelect.value = keep;
    placeSelect.hidden = !chosen || places.length === 0;
    triggerSelect.hidden = placeSelect.hidden;
    const anyLocation = chosen || items.some(({ reminder }) => reminder.type === 'location');
    managePlaces.hidden = !anyLocation;
    managePlaces.textContent = chosen && places.length === 0 ? t('reminder.placeCreate') : t('reminder.placeManage');
    // In de browser gaat een herinnering op een plek niet af: zeg dat meteen, ook al worden ze wel bewaard en gesynchroniseerd.
    placeNote.textContent = !anyLocation ? '' : chosen && places.length === 0 ? t('reminder.placeNone') : bridge.available ? t('reminder.placeNoteApp') : t('reminder.placeNoteBrowser');
  };

  const add = async () => {
    error.textContent = '';
    if (choose.value === PLACE) {
      if (!placeSelect.value) {
        error.textContent = t('reminder.placeRequired');
        return;
      }
      await actions.addReminder(task.id, { type: 'location', place_id: placeSelect.value, trigger: triggerSelect.value });
      // De eerste locatieherinnering: nu mag de Android-app om locatietoegang vragen (met uitleg), nooit eerder.
      if (bridge.available) {
        const status = bridge.locationStatus();
        if (locationAdvice(status) !== 'ok' && !status?.declined) bridge.requestLocationPermission();
      }
      return;
    }
    if (choose.value === CUSTOM) {
      if (!custom.value) {
        error.textContent = t('reminder.customRequired');
        custom.focus();
        return;
      }
      await actions.addReminder(task.id, { type: 'absolute', due: { date: custom.value.slice(0, 16) } });
      custom.value = '';
      return;
    }
    await actions.addReminder(task.id, { type: 'relative', minute_offset: Number(choose.value) });
  };

  choose.addEventListener('change', () => {
    custom.hidden = choose.value !== CUSTOM;
    draw();
    if (!custom.hidden) {
      custom.value ||= formatDateTimeLocal(new Date(Date.now() + 3_600_000));
      custom.focus();
    }
  });
  // Enter in dit stuk voegt de herinnering toe, en slaat niet het hele taakvenster op.
  custom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });

  const unsubscribe = store.subscribe(draw);
  draw();
  const node = h('section', { class: 'section-plain', 'aria-label': t('reminder.title') },
    h('h3', { class: 'subheading' }, t('reminder.title')),
    list,
    h('div', { class: 'reminder-add' }, choose, custom, placeSelect, triggerSelect, h('button', { type: 'button', class: 'button', onclick: add }, t('reminder.add'))),
    h('div', { class: 'reminder-add' }, managePlaces),
    note,
    placeNote,
    error);
  return { node, dispose: unsubscribe };
}

// ---------- instellingen: herinneringen en meldingen ----------

const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/** Een nette tekst bij een mislukte aanmelding voor meldingen in de browser. */
export function pushErrorText(err) {
  if (err?.name === 'PushError') {
    if (err.code === 'denied') return t('notify.denied');
    if (err.code === 'unsupported') return t('notify.unsupported');
    if (err.code === 'offline') return t('notify.errorOffline');
    if (err.code === 'server') return t('notify.errorServer', { message: err.message });
  }
  return t('notify.errorBrowser');
}

/**
 * Het scherm "Herinneringen en meldingen": de automatische herinnering, de tijdzone, en meldingen op dit apparaat
 * (in de browser: aan- en uitzetten, een testmelding en de apparaten; in de Android-app: wat er nog moet worden toegestaan).
 * @param {{ store: object, actions: object, bridge: ReturnType<typeof import('../core/android.js').androidBridge>,
 *           pushClient: ReturnType<typeof import('../core/push.js').createPushClient> }} options
 */
/**
 * Zoals Todoist het indeelt: 'reminders' (Herinneringen: de automatische herinnering, uitstellen, de tijdzone en meldingen op dit
 * apparaat), 'notifications' (Meldingen: ochtendoverzicht, avondreview, doelen vieren en meldingen bij samenwerken), of 'all'.
 * Alles hier werkt meteen, zonder Bewaren.
 * @typedef {'all' | 'reminders' | 'notifications'} NotifyPart
 */
export function notificationsDialog({ store, actions, bridge, desktop = { available: false }, pushClient, part = 'all' }) {
  const show = (...parts) => part === 'all' || parts.includes(part);
  const general = () => generalOf(mySettings(store.view, store.userId));
  const saveGeneral = (changes) => actions.updateSettings({ general: { ...general(), ...changes } });
  let unsubscribe = () => {};
  let onAndroid = () => {};
  let kinds = null; // meldingen bij samenwerken: welke soorten als melding (ui/inboxSettings.js)
  return openDialog((finish) => {
    const message = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const say = (text, bad = false) => {
      message.textContent = text;
      message.classList.toggle('hint-bad', bad);
    };

    // --- automatische herinnering ---
    const auto = h('select', { class: 'field', 'aria-label': t('notify.autoTitle') },
      h('option', { value: '-1' }, t('notify.autoNone')),
      presetOptions().map((o) => h('option', { value: String(o.minutes) }, o.label)));
    auto.addEventListener('change', () => actions.updateSettings({ auto_reminder: Number(auto.value) }));

    // --- uitstellen (de knop in een melding) ---
    const snooze = h('select', { class: 'field', 'aria-label': t('general.snooze'), dataset: { fk: 'notify-snooze' } },
      SNOOZE_MINUTES.map((m) => h('option', { value: String(m) }, SNOOZE_LABEL[m]())));
    snooze.addEventListener('change', () => saveGeneral({ snooze_minutes: Number(snooze.value) }));

    // --- ochtendoverzicht en avondreview (een vinkje en een tijd) en doelen vieren ---
    const overview = (key, fallback, label) => {
      const on = h('input', { type: 'checkbox', dataset: { fk: `notify-${key}-on` } });
      const time = h('input', { type: 'time', class: 'field', 'aria-label': label, dataset: { fk: `notify-${key}-time` } });
      const save = () => saveGeneral({ [key]: on.checked && time.value ? time.value : null });
      on.addEventListener('change', () => { if (on.checked && !time.value) time.value = fallback; save(); });
      time.addEventListener('change', () => { if (on.checked) save(); });
      const draw = (value) => { on.checked = value !== null; if (document.activeElement !== time) time.value = value ?? fallback; };
      return { draw, row: h('div', { class: 'check-row general-overview' }, h('label', { class: 'check-row' }, on, label), time) };
    };
    const morning = overview('morning_overview', '08:00', t('general.morning'));
    const evening = overview('evening_review', '18:00', t('general.evening'));
    const celebrate = h('input', { type: 'checkbox', dataset: { fk: 'notify-celebrate' } });
    celebrate.addEventListener('change', () => saveGeneral({ goal_celebrations: celebrate.checked }));

    // --- tijdzone ---
    const zoneText = h('p', { class: 'hint' });
    const zoneButton = h('button', { type: 'button', class: 'button button-small' });
    zoneButton.addEventListener('click', async () => {
      await actions.updateSettings({ timezone: deviceZone() });
      say(t('notify.zoneSaved', { zone: deviceZone() }));
    });

    // --- dit apparaat ---
    const device = h('div', { class: 'section-form' });
    const devices = h('ul', { class: 'device-list' });
    let browserState = { enabled: false, list: [] };

    const drawDevice = async () => {
      if (bridge.available) {
        const s = bridge.status();
        const row = (text, buttonText, run) => h('div', { class: 'device' }, h('span', { class: 'device-info' }, text),
          buttonText && h('button', { type: 'button', class: 'button button-small', onclick: run }, buttonText));
        const problems = [];
        if (s && !s.notifications) problems.push(row(t('notify.androidNoNotifications'), t('notify.androidAllow'), () => bridge.requestNotificationPermission()));
        if (s && !s.exactAlarms) problems.push(row(t('notify.androidNoExact'), t('notify.androidSettings'), () => bridge.openNotificationSettings()));
        if (s && s.batteryOptimized) problems.push(row(t('notify.androidBattery'), t('notify.androidBatterySettings'), () => bridge.openBatterySettings()));
        // dringende herinneringen (alleen op dit toestel): als een wekker, tot je reageert; door Niet storen als Android het toestaat
        const urgent = bridge.canUrgent() && s && h('div', { class: 'urgent-reminders' },
          h('label', { class: 'check-row' },
            h('input', {
              type: 'checkbox', checked: Boolean(s.urgent), dataset: { fk: 'notify-urgent' },
              onchange: (e) => { bridge.setUrgentReminders(e.target.checked); drawDevice(); },
            }),
            t('notify.urgent')),
          h('p', { class: 'hint' }, t('notify.urgentHint')),
          s.urgent && (s.urgentBypassDnd
            ? h('p', { class: 'hint' }, t('notify.urgentDndOn'))
            : row(t('notify.urgentDndOff'), t('notify.androidSettings'), () => bridge.openUrgentSettings())));
        replace(device,
          h('p', { class: 'hint' }, t('notify.androidInfo')),
          s && problems.length === 0 && h('p', { class: 'hint' }, t('notify.androidOk')),
          problems,
          urgent,
          s?.appVersion && h('p', { class: 'hint' }, t('notify.androidVersion', { version: s.appVersion })));
        return;
      }
      if (desktop.available) {
        // De desktop-app voor Windows laat zelf meldingen van Windows zien (Electron kent geen web-push): geen knop om meldingen
        // in de browser aan te zetten, wel uitleg, een testmelding en de instellingen van Windows.
        const prefs = desktop.canSettings?.() ? await desktop.getSettings() : null;
        const can = desktop.canNotify?.() === true;
        replace(device,
          h('p', { class: 'hint' }, can ? t('notify.desktopInfo') : t('notify.desktopInfoOld')),
          prefs && prefs.stayInTray === false && h('p', { class: 'hint hint-bad', dataset: { fk: 'notify-desktop-tray' } }, t('notify.desktopNoTray')),
          can && h('div', { class: 'dialog-buttons dialog-buttons-start' },
            h('button', { type: 'button', class: 'button', dataset: { fk: 'notify-desktop-test' }, onclick: desktopTest }, t('notify.test')),
            h('button', { type: 'button', class: 'button', dataset: { fk: 'notify-desktop-windows' }, onclick: () => desktop.openNotificationSettings() }, t('notify.desktopWindows'))));
        return;
      }
      if (!pushClient.supported) {
        replace(device, h('p', { class: 'hint' }, t('notify.unsupported')));
        return;
      }
      const permission = pushClient.permission();
      browserState.enabled = await pushClient.enabled();
      replace(device,
        h('p', {}, browserState.enabled ? t('notify.browserOn') : t('notify.browserOff')),
        permission === 'denied' && h('p', { class: 'hint hint-bad' }, t('notify.denied')),
        h('div', { class: 'dialog-buttons dialog-buttons-start' },
          browserState.enabled
            ? [h('button', { type: 'button', class: 'button', onclick: switchOff }, t('notify.disable')),
              h('button', { type: 'button', class: 'button', onclick: sendTest }, t('notify.test'))]
            : h('button', { type: 'button', class: 'button button-primary', onclick: switchOn }, t('notify.enable'))),
        browserState.list.length > 0 && h('div', {}, h('h3', { class: 'subheading' }, t('notify.devices')), devices));
      replace(devices, browserState.list.map((d) => h('li', { class: 'device' },
        h('span', { class: 'device-info' },
          h('strong', {}, d.device, d.current && h('span', { class: 'badge' }, '✓')),
          h('span', { class: 'hint' }, d.last_error
            ? t('notify.deviceError', { error: d.last_error })
            : d.last_success_at ? t('notify.deviceDelivered', { when: when(d.last_success_at) }) : t('notify.deviceNever'))))));
    };

    async function desktopTest() {
      say('');
      const r = await desktop.testNotification();
      say(r?.ok ? t('notify.desktopTestSent') : t('notify.desktopTestFailed'), !r?.ok);
    }

    const loadDevices = async () => {
      if (bridge.available || desktop.available || !pushClient.supported) return;
      try {
        browserState.list = await pushClient.devices();
      } catch {
        browserState.list = [];
      }
      await drawDevice();
    };
    async function switchOn() {
      say('');
      try {
        await pushClient.enable();
      } catch (err) {
        say(pushErrorText(err), true);
      }
      await loadDevices();
    }
    async function switchOff() {
      say('');
      await pushClient.disable().catch(() => {});
      await loadDevices();
    }
    async function sendTest() {
      say('');
      try {
        const r = await pushClient.test();
        if (r.sent === 0 && r.failed === 0) say(t('notify.testNone'), true);
        else if (r.failed > 0) say(t('notify.testFailed', { count: r.failed, error: r.errors[0] ?? '' }), true);
        else say(t('notify.testSent', { count: r.sent }));
      } catch (err) {
        say(pushErrorText(err), true);
      }
      await loadDevices();
    }

    const draw = () => {
      const settings = mySettings(store.view, store.userId);
      auto.value = String(settings.auto_reminder);
      const g = general();
      snooze.value = String(g.snooze_minutes);
      morning.draw(g.morning_overview);
      evening.draw(g.evening_review);
      celebrate.checked = g.goal_celebrations;
      const zone = settings.timezone;
      zoneText.textContent = zone ? t('notify.zoneNow', { zone }) : t('notify.zoneUnset');
      zoneButton.textContent = t('notify.zoneUse', { zone: deviceZone() });
      zoneButton.hidden = zone === deviceZone();
    };
    unsubscribe = store.subscribe(draw);
    draw();
    onAndroid = () => drawDevice();
    window.addEventListener('tickory-android-status', onAndroid);
    queueMicrotask(() => { drawDevice().then(loadDevices); });
    kinds = show('notifications') ? pushKindsSection({ store, actions }) : null;
    // zoals Todoist naast de testknoppen: zo ziet een herinnering eruit (alleen ter illustratie)
    const preview = h('div', { class: 'notify-preview', 'aria-hidden': 'true' },
      h('span', { class: 'notify-preview-label' }, t('notify.preview')),
      h('div', { class: 'notify-preview-card' },
        // geen plaatje van de server: de demo op de website staat onder een eigen pad (/tickory/)
        h('span', { class: 'notify-preview-icon' }, icon('check')),
        h('span', { class: 'notify-preview-text' }, h('strong', {}, t('notify.previewTask')), h('span', {}, t('notify.previewWhen'))),
        h('span', { class: 'notify-preview-now' }, t('notify.previewNow'))));
    const section = (title, ...body) => h('details', { class: 'section', open: true }, h('summary', {}, title), h('div', { class: 'section-form' }, body));

    return h('div', { class: 'dialog-form' },
      h('h2', {}, part === 'reminders' ? t('settings.reminders') : part === 'notifications' ? t('settings.notify') : t('notify.title')),
      show('reminders') && [
        section(t('notify.autoTitle'), h('p', { class: 'hint' }, t('notify.autoHint')), auto),
        part === 'reminders' && section(t('general.snooze'), h('p', { class: 'hint' }, t('general.snoozeHint')), snooze),
        section(t('notify.zoneTitle'), zoneText, zoneButton),
        h('details', { class: 'section notify-device', open: true }, h('summary', {}, t('notify.deviceTitle')), device, preview)],
      part === 'notifications' && [
        section(t('general.overview'), morning.row, evening.row, h('p', { class: 'hint' }, t('general.overviewHint'))),
        section(t('settings.celebrate'), h('label', { class: 'check-row' }, celebrate, t('productivity.celebrateOn')))],
      kinds?.node,
      message,
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
  }, { wide: true, onClose: () => { unsubscribe(); kinds?.dispose(); window.removeEventListener('tickory-android-status', onAndroid); } });
}
