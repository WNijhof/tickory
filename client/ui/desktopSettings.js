// Instellingen › Desktop-app (alleen in de desktop-app voor Windows): de sneltoetsen, opstarten met Windows, in het systeemvak blijven
// draaien en de server. Zoals bij Todoist staan die bij de andere instellingen, niet in een apart venster. Bewaard in de desktop-app
// zelf (op deze pc), via de brug (core/desktop.js, desktop/preload.cjs). Elke keuze werkt meteen, zonder Bewaren.

import { t } from '../core/i18n.js';
import { h, openDialog, replace } from './dom.js';

/**
 * @param {{ bridge: ReturnType<typeof import('../core/desktop.js').desktopBridge> }} options
 * @returns {Promise<boolean>} true als er iets is bewaard
 */
export function desktopSettingsDialog({ bridge }) {
  return openDialog((finish) => {
    const body = h('div', { class: 'section-form' }, h('p', { class: 'hint' }, t('common.loading')));
    const error = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { class: 'dialog-form desktop-settings', onsubmit: (e) => e.preventDefault() },
      h('h2', {}, t('settings.desktop')), body, error);

    bridge.getSettings().then((s) => {
      if (!s) { replace(body, h('p', { class: 'hint' }, t('desktop.unavailable'))); return; }
      const shortcut = (value, fk) => h('input', { class: 'field', type: 'text', value: value ?? '', autocomplete: 'off', dataset: { fk } });
      const quickAdd = shortcut(s.shortcuts?.quickAdd, 'desktop-sc-quickadd');
      const activate = shortcut(s.shortcuts?.activate, 'desktop-sc-activate');
      const check = (value, fk) => h('input', { type: 'checkbox', checked: Boolean(value), dataset: { fk } });
      const atLogin = check(s.openAtLogin, 'desktop-at-login');
      const minimized = check(s.startMinimized, 'desktop-minimized');
      const tray = check(s.stayInTray, 'desktop-tray');
      const saved = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
      // Zoals Todoist: elke keuze werkt meteen (een vinkje bij de klik, een sneltoets zodra je het veld verlaat of op Enter drukt).
      let pending = Promise.resolve();
      const save = () => {
        pending = pending.then(async () => {
          error.textContent = '';
          saved.textContent = '';
          const res = await bridge.saveSettings({
            shortcuts: { quickAdd: quickAdd.value.trim(), activate: activate.value.trim() },
            openAtLogin: atLogin.checked, startMinimized: minimized.checked, stayInTray: tray.checked,
          });
          if (!res?.ok) { error.textContent = res?.error === 'shortcutInvalid' ? t('desktop.shortcutInvalid') : t('desktop.saveFailed'); return; }
          saved.textContent = t('desktop.saved');
          // de sneltoetsen in de schrijfwijze van Electron ("ctrl+shift+a" wordt "Ctrl+Shift+A")
          const fresh = await bridge.getSettings();
          if (fresh) { quickAdd.value = fresh.shortcuts?.quickAdd ?? ''; activate.value = fresh.shortcuts?.activate ?? ''; }
        });
        return pending;
      };
      form.onchange = () => { save(); };
      form.onsubmit = (e) => { e.preventDefault(); save(); };
      replace(body,
        h('fieldset', { class: 'general-group' }, h('legend', {}, t('desktop.shortcuts')),
          h('label', { class: 'field-label' }, t('desktop.quickAdd'), quickAdd),
          h('label', { class: 'field-label' }, t('desktop.show'), activate),
          h('p', { class: 'hint' }, t('desktop.shortcutHint'))),
        h('fieldset', { class: 'general-group' }, h('legend', {}, t('desktop.startup')),
          h('label', { class: 'check-row' }, atLogin, t('desktop.openAtLogin')),
          h('label', { class: 'check-row' }, minimized, t('desktop.startMinimized')),
          h('label', { class: 'check-row' }, tray, t('desktop.stayInTray')),
          h('p', { class: 'hint' }, t('desktop.stayInTrayHint'))),
        h('fieldset', { class: 'general-group' }, h('legend', {}, t('desktop.server')),
          h('p', {}, h('code', {}, s.server ?? '')),
          h('button', { type: 'button', class: 'button button-small', dataset: { fk: 'desktop-change-server' }, onclick: () => bridge.changeServer() }, t('desktop.changeServer'))),
        s.version && h('p', { class: 'hint' }, t('desktop.version', { version: s.version })),
        saved,
        h('div', { class: 'dialog-buttons' },
          h('button', { type: 'button', class: 'button', dataset: { fk: 'desktop-done' }, onclick: async () => { await pending; finish(false); } }, t('common.close'))));
      form.append(error);
    }, () => replace(body, h('p', { class: 'hint' }, t('desktop.unavailable'))));
    return form;
  });
}
