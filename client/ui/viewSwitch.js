// De keuze tussen Lijst, Bord en Kalender, bovenaan een project (en tussen Lijst en Kalender bij Binnenkort).
// Het zijn gewone knoppen in een groep met `aria-pressed`: de gekozen weergave is ingedrukt. Op een telefoon blijven alleen de pictogrammen over.

import { t } from '../core/i18n.js';
import { h } from './dom.js';
import { icon } from './icons.js';

/** Onder deze sleutel bewaart dit apparaat de keuze voor Binnenkort (die hoort bij geen enkel project, dus ook niet op de server). */
export const UPCOMING_STYLE_KEY = 'tickory.upcomingView';

const ICONS = { list: 'list', board: 'board', calendar: 'calendar' };

/** De weergave van Binnenkort op dit apparaat: 'list' of 'calendar'. */
export function upcomingStyle() {
  try {
    return globalThis.localStorage?.getItem(UPCOMING_STYLE_KEY) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list'; // opslag geblokkeerd
  }
}

export function setUpcomingStyle(style) {
  try {
    globalThis.localStorage?.setItem(UPCOMING_STYLE_KEY, style === 'calendar' ? 'calendar' : 'list');
  } catch { /* de keuze geldt dan niet langer dan deze pagina */ }
}

/**
 * @param {{ styles: ('list' | 'board' | 'calendar')[], current: string, onChange: (style: string) => void }} options
 */
export function viewSwitch({ styles, current, onChange }) {
  const label = (style) => ({ list: t('viewStyle.list'), board: t('viewStyle.board'), calendar: t('viewStyle.calendar') })[style];
  return h('div', { class: 'view-switch', role: 'group', 'aria-label': t('viewStyle.label') },
    styles.map((style) => h('button', {
      class: `button button-small view-switch-button${style === current ? ' active' : ''}`, type: 'button', 'aria-pressed': String(style === current),
      dataset: { viewStyle: style, fk: `viewstyle:${style}` }, onclick: () => style !== current && onChange(style),
    }, icon(ICONS[style]), h('span', { class: 'btn-label' }, label(style)))));
}
