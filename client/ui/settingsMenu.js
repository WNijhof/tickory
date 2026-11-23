// Het venster Instellingen, ingedeeld zoals bij Todoist: bovenaan je account, dan Algemeen (en in de desktop-app Desktop-app),
// Personalisatie (Thema, Navigatiemenu, Navigatiebalk), Productiviteit (Productiviteit, Herinneringen, Meldingen, Locaties) en
// Meer (Taal, Sjablonen, Importeren, Exporteren, Handleiding, Wat is er nieuw, Nu bijwerken, Afmelden).
//
// Op een telefoon is het een lijst met groepen (zoals de app van Todoist op Android): een keuze sluit het venster en geeft de
// waarde terug (zie `handlers.settings` in ui/app.js). Op een breed scherm (zoals Todoist op de computer) staan de onderdelen
// links en het gekozen onderdeel rechts, in hetzelfde venster: de bestaande vensters komen daar te staan via embedNextDialog
// (ui/dom.js).

import { t } from '../core/i18n.js';
import { closeEmbedded, h, openDialog, replace } from './dom.js';
import { icon } from './icons.js';

const initialsOf = (name) => [...String(name ?? '?').trim()][0]?.toLocaleUpperCase() ?? '?';

/**
 * Breed genoeg voor twee kolommen (dezelfde grens als de opmaak voor een telefoon, mobile.css). `__tickorySettingsList` zetten de
 * oudere browsertests (scripts/e2e.ts, site-browser.ts) in elke pagina: zij doorlopen de onderdelen als losse vensters; het
 * scherm met twee kolommen heeft een eigen test (scripts/e2e-settings.ts).
 */
export const settingsWide = () => !globalThis.__tickorySettingsList && !globalThis.matchMedia?.('(max-width: 760px)').matches;

/**
 * De onderdelen, in groepen. Een groep zonder titel staat bovenaan. `danger`: rood en zonder pijltje (Afmelden).
 * @param {{ notices?: { value: string, label: string }[], desktop?: boolean }} options
 */
export function settingsGroups({ notices = [], desktop = false } = {}) {
  const item = (value, iconName, label, tone, extra = {}) => ({ value, icon: iconName, label, tone, ...extra });
  return [
    notices.length > 0 && { title: null, items: notices.map((n) => item(n.value, 'bell', n.label, 'accent')) },
    { title: null, items: [
      item('general', 'sliders', t('settings.general'), 'blue'),
      item('account', 'user', t('settings.account'), 'green'),
      desktop && item('desktop', 'keyboard', t('settings.desktop'), 'gray'),
    ].filter(Boolean) },
    { title: t('settings.groupPersonal'), items: [
      item('appearance', 'palette', t('settings.appearance'), 'pink'),
      item('sidebar', 'menu', t('settings.sidebarMenu'), 'teal'),
      item('bottombar', 'browse', t('settings.bottomBar'), 'teal'),
    ] },
    { title: t('settings.groupProductivity'), items: [
      item('productivity', 'chart', t('settings.productivity'), 'purple'),
      item('reminders', 'clock', t('settings.reminders'), 'orange'),
      item('notifications', 'bell', t('settings.notify'), 'orange'),
      item('places', 'pin', t('settings.places'), 'red'),
    ] },
    { title: t('settings.groupMore'), items: [
      item('language', 'globe', t('settings.language'), 'blue'),
      item('templates', 'template', t('settings.templates'), 'teal'),
      item('import', 'upload', t('settings.import'), 'gray'),
      item('export', 'download', t('settings.export'), 'gray'),
      item('help', 'help', t('settings.help'), 'teal'),
      item('whatsnew', 'star', t('settings.whatsNew'), 'gray'),
      item('sync', 'repeat', t('settings.syncNow'), 'gray'),
      item('logout', 'logout', t('settings.signOut'), 'danger', { danger: true }),
    ] },
  ].filter(Boolean);
}

function rowButton(it, onPick, current = false) {
  return h('button', {
    type: 'button', class: `settings-row${it.danger ? ' settings-row-danger' : ''}${current ? ' is-current' : ''}`,
    dataset: { value: it.value, fk: `settings:${it.value}` }, 'aria-current': current ? 'page' : null, onclick: () => onPick(it.value),
  },
  h('span', { class: `settings-icon settings-tone-${it.tone}`, 'aria-hidden': 'true' }, icon(it.icon)),
  h('span', { class: 'settings-label' }, it.label),
  !it.danger && h('span', { class: 'settings-chevron', 'aria-hidden': 'true' }, icon('chevronRight')));
}

function accountCard(me, onPick) {
  return me && h('button', { type: 'button', class: 'settings-account', dataset: { value: 'account', fk: 'settings:account-card' }, onclick: () => onPick('account') },
    h('span', { class: 'settings-avatar', 'aria-hidden': 'true' }, initialsOf(me.name)),
    h('span', { class: 'settings-who' }, h('strong', {}, me.name ?? ''), me.username && h('span', { class: 'settings-mail' }, `@${me.username}`)),
    h('span', { class: 'settings-chevron', 'aria-hidden': 'true' }, icon('chevronRight')));
}

/**
 * De lijst (telefoon).
 * @param {{ me: { name?: string, username?: string } | null, notices?: { value: string, label: string }[], desktop?: boolean }} options
 * @returns {Promise<string | null>} de gekozen waarde, of null bij sluiten
 */
export function settingsMenuDialog({ me, notices = [], desktop = false }) {
  return openDialog((finish) => h('div', { class: 'dialog-form settings-menu' },
    h('div', { class: 'settings-head' },
      h('h2', {}, t('settings.title')),
      h('button', { type: 'button', class: 'icon-button', title: t('common.close'), onclick: () => finish(null) }, icon('close'), h('span', { class: 'sr-only' }, t('common.close')))),
    accountCard(me, finish),
    settingsGroups({ notices, desktop }).map((g) => [
      g.title && h('h3', { class: 'settings-group-title' }, g.title),
      h('div', { class: 'settings-group' }, g.items.map((it) => rowButton(it, finish)))])),
  { className: 'dialog-settings' });
}

/**
 * Twee kolommen (breed scherm): links de onderdelen, rechts het gekozen onderdeel. `run(value, pane)` toont het onderdeel in
 * `pane` (of doet iets anders) en geeft terug wat daarna moet: 'stay' (het onderdeel opnieuw tonen, bijvoorbeeld na Bewaren),
 * 'close' (het venster dicht; een handeling zoals Afmelden of naar een scherm gaan) of 'reload' (de teksten opnieuw, na een andere taal).
 * @param {{ me: object | null, notices?: object[], desktop?: boolean, initial?: string,
 *           run: (value: string, pane: HTMLElement) => Promise<'stay' | 'close' | 'reload'> }} options
 */
export function openSettingsPanel({ me, notices = [], desktop = false, initial = 'general', run }) {
  let closed = false;
  let current = initial;
  let generation = 0;
  const nav = h('nav', { class: 'settings-nav', 'aria-label': t('settings.title') });
  const pane = h('div', { class: 'settings-pane', tabIndex: -1 });
  return openDialog((finish) => {
    const drawNav = () => replace(nav,
      h('h2', { class: 'settings-nav-title' }, t('settings.title')),
      accountCard(me, select),
      settingsGroups({ notices, desktop }).map((g) => [
        g.title && h('h3', { class: 'settings-group-title' }, g.title),
        h('div', { class: 'settings-group' }, g.items.map((it) => rowButton(it, select, it.value === current)))]));
    async function select(value) {
      const mine = ++generation;
      const previous = current;
      current = value;
      drawNav();
      let quick = 0;
      while (!closed && mine === generation) {
        const started = Date.now();
        const outcome = await run(value, pane);
        if (closed || mine !== generation) return;
        if (outcome === 'close') { finish(null); return; }
        // niets te tonen (een link geopend, bijwerken gestart): het vorige onderdeel blijft staan
        if (outcome === 'idle') { if (previous && previous !== value) select(previous); return; }
        if (outcome === 'reload') drawNav();
        // een onderdeel dat meteen terugkomt (niets te tonen): niet blijven herhalen
        quick = Date.now() - started < 50 ? quick + 1 : 0;
        if (quick >= 2) { replace(pane); return; }
      }
    }
    queueMicrotask(() => select(current));
    return h('div', { class: 'settings-wide' },
      nav,
      h('div', { class: 'settings-main' },
        h('button', { type: 'button', class: 'icon-button settings-close', title: t('common.close'), dataset: { fk: 'settings-close' }, onclick: () => finish(null) },
          icon('close'), h('span', { class: 'sr-only' }, t('common.close'))),
        pane));
  }, { className: 'dialog-settings dialog-settings-wide', onClose: () => { closed = true; closeEmbedded(pane); } });
}
