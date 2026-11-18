// Het venster Instellingen, zoals in de app van Todoist: bovenaan je account (naam en gebruikersnaam), daaronder groepen regels met een
// gekleurd pictogram, de naam en een pijltje, en onderaan afmelden. Een keuze sluit het venster en geeft de waarde terug (zie
// `handlers.settings` in ui/app.js); wat erachter zit (Algemeen, Account, Meldingen, …) zijn de bestaande vensters.

import { t } from '../core/i18n.js';
import { h, openDialog } from './dom.js';
import { icon } from './icons.js';

const initialsOf = (name) => [...String(name ?? '?').trim()][0]?.toLocaleUpperCase() ?? '?';

/**
 * @param {{ me: { name?: string, username?: string } | null, notices?: { value: string, label: string }[] }} options  `notices`: een nieuwere versie, bovenaan
 * @returns {Promise<string | null>} de gekozen waarde, of null bij sluiten
 */
export function settingsMenuDialog({ me, notices = [] }) {
  return openDialog((finish) => {
    const row = (value, iconName, label, { danger = false, tone = '' } = {}) => h('button', {
      type: 'button', class: `settings-row${danger ? ' settings-row-danger' : ''}`, dataset: { value, fk: `settings:${value}` }, onclick: () => finish(value),
    },
    h('span', { class: `settings-icon${tone ? ` settings-tone-${tone}` : ''}`, 'aria-hidden': 'true' }, icon(iconName)),
    h('span', { class: 'settings-label' }, label),
    !danger && h('span', { class: 'settings-chevron', 'aria-hidden': 'true' }, icon('chevronRight')));
    const group = (...rows) => h('div', { class: 'settings-group' }, rows);

    return h('div', { class: 'dialog-form settings-menu' },
      h('div', { class: 'settings-head' },
        h('h2', {}, t('settings.title')),
        h('button', { type: 'button', class: 'icon-button', title: t('common.close'), onclick: () => finish(null) }, icon('close'), h('span', { class: 'sr-only' }, t('common.close')))),
      me && h('button', { type: 'button', class: 'settings-account', dataset: { value: 'account', fk: 'settings:account-card' }, onclick: () => finish('account') },
        h('span', { class: 'settings-avatar', 'aria-hidden': 'true' }, initialsOf(me.name)),
        h('span', { class: 'settings-who' }, h('strong', {}, me.name ?? ''), me.username && h('span', { class: 'settings-mail' }, `@${me.username}`)),
        h('span', { class: 'settings-chevron', 'aria-hidden': 'true' }, icon('chevronRight'))),
      notices.length > 0 && group(...notices.map((n) => row(n.value, 'bell', n.label, { tone: 'accent' }))),
      group(
        row('general', 'sliders', t('settings.general'), { tone: 'blue' }),
        row('account', 'user', t('settings.account'), { tone: 'green' }),
        row('notifications', 'bell', t('settings.notifications'), { tone: 'orange' }),
        row('productivity', 'chart', t('settings.productivity'), { tone: 'purple' })),
      group(
        row('appearance', 'palette', t('settings.appearance'), { tone: 'pink' }),
        row('language', 'globe', t('settings.language'), { tone: 'blue' }),
        row('places', 'pin', t('settings.places'), { tone: 'red' }),
        row('templates', 'template', t('settings.templates'), { tone: 'teal' })),
      group(
        row('import', 'upload', t('settings.import'), { tone: 'gray' }),
        row('export', 'download', t('settings.export'), { tone: 'gray' }),
        row('sync', 'repeat', t('settings.syncNow'), { tone: 'gray' })),
      group(row('logout', 'logout', t('settings.signOut'), { danger: true, tone: 'danger' })));
  }, { className: 'dialog-settings' });
}
