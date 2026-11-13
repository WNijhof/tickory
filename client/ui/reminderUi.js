// Schermen voor herinneringen: het stuk in het taakvenster, en het scherm "Herinneringen en meldingen" in de instellingen.

import { hasTime } from '../../shared/reminders.js';
import { formatDateTimeLocal } from '../core/format.js';
import { t } from '../core/i18n.js';
import { needsTimeNote, presetOptions, reminderLine } from '../core/reminderText.js';
import { mySettings, remindersOf } from '../core/selectors.js';
import { h, openDialog, replace } from './dom.js';

const CUSTOM = 'custom';

/**
 * Het stuk "Herinneringen" in het taakvenster: je eigen herinneringen bij deze taak, met de keuzes van Todoist
 * (op het tijdstip, 10/30/45 minuten, 1/2/3 uur, 1/2/3 dagen vooraf, of een eigen datum en tijd). Wijzigingen gaan direct door,
 * zoals bij subtaken. Geef `dispose` aan als het venster sluit.
 * @returns {{ node: HTMLElement, dispose: () => void }}
 */
export function reminderSection({ task, store, actions, today }) {
  const list = h('ul', { class: 'device-list' });
  const note = h('p', { class: 'hint', 'aria-live': 'polite' });
  const choose = h('select', { class: 'field', 'aria-label': t('reminder.choose') },
    presetOptions().map((o) => h('option', { value: String(o.minutes), selected: o.minutes === 30 }, o.label)),
    h('option', { value: CUSTOM }, t('reminder.custom')));
  const custom = h('input', { class: 'field', type: 'datetime-local', 'aria-label': t('reminder.customLabel'), hidden: true });
  // een eigen regel (niet de klasse 'error' van het taakvenster zelf), zodat de twee elkaar niet in de weg zitten
  const error = h('p', { class: 'hint hint-bad', role: 'alert', dataset: { role: 'reminder-error' } });

  const current = () => store.view.tasks.get(task.id) ?? task;

  const draw = () => {
    const items = remindersOf(store.view, task.id, store.userId);
    replace(list, items.length > 0
      ? items.map(({ reminder, moment }) => h('li', { class: 'device' },
        h('span', { class: 'device-info' }, reminderLine(reminder, moment, today())),
        h('button', {
          type: 'button', class: 'button button-small', 'aria-label': `${t('reminder.remove')}: ${reminderLine(reminder, moment, today())}`, onclick: () => actions.deleteReminder(reminder.id),
        }, '×')))
      : [h('li', { class: 'hint' }, t('reminder.none'))]);
    note.textContent = hasTime(current().due?.date) ? '' : needsTimeNote();
  };

  const add = async () => {
    error.textContent = '';
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
    h('div', { class: 'reminder-add' }, choose, custom, h('button', { type: 'button', class: 'button', onclick: add }, t('reminder.add'))),
    note,
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
export function notificationsDialog({ store, actions, bridge, pushClient }) {
  let unsubscribe = () => {};
  let onAndroid = () => {};
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
        replace(device,
          h('p', { class: 'hint' }, t('notify.androidInfo')),
          s && problems.length === 0 && h('p', { class: 'hint' }, t('notify.androidOk')),
          problems,
          s?.appVersion && h('p', { class: 'hint' }, t('notify.androidVersion', { version: s.appVersion })));
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

    const loadDevices = async () => {
      if (bridge.available || !pushClient.supported) return;
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

    return h('div', { class: 'dialog-form' },
      h('h2', {}, t('notify.title')),
      h('details', { class: 'section', open: true }, h('summary', {}, t('notify.autoTitle')), h('div', { class: 'section-form' }, h('p', { class: 'hint' }, t('notify.autoHint')), auto)),
      h('details', { class: 'section', open: true }, h('summary', {}, t('notify.zoneTitle')), h('div', { class: 'section-form' }, zoneText, zoneButton)),
      h('details', { class: 'section', open: true }, h('summary', {}, t('notify.deviceTitle')), device),
      message,
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
  }, { wide: true, onClose: () => { unsubscribe(); window.removeEventListener('tickory-android-status', onAndroid); } });
}
