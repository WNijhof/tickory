// Het scherm "Weergave": thema (systeem, licht, donker) en accentkleur. Een keuze werkt meteen en blijft op dit apparaat bewaard.

import { t } from '../core/i18n.js';
import { ACCENTS, THEMES, applyAppearance, readAppearance, saveAppearance } from '../core/theme.js';
import { h, openDialog } from './dom.js';

const THEME_LABEL = { system: () => t('appearance.system'), light: () => t('appearance.light'), dark: () => t('appearance.dark') };
const ACCENT_LABEL = {
  teal: () => t('appearance.accent.teal'),
  blue: () => t('appearance.accent.blue'),
  indigo: () => t('appearance.accent.indigo'),
  violet: () => t('appearance.accent.violet'),
  rose: () => t('appearance.accent.rose'),
  orange: () => t('appearance.accent.orange'),
  green: () => t('appearance.accent.green'),
  graphite: () => t('appearance.accent.graphite'),
};

/**
 * @param {{ persist?: boolean }} [options] persist=false in de demo: dan werkt het alleen voor nu
 */
export function appearanceDialog({ persist = true } = {}) {
  const current = readAppearance();
  const choose = (change) => {
    Object.assign(current, change);
    applyAppearance(document, current);
    if (persist) saveAppearance(current);
  };
  return openDialog((finish) => {
    const radio = (group, value, checked, label, extra = null) => h('label', { class: `choice-option${extra ? ' choice-accent' : ''}`, dataset: { value } },
      h('input', { type: 'radio', name: group, value, checked, onchange: () => choose({ [group]: value }) }),
      extra,
      h('span', {}, label));
    return h('div', { class: 'dialog-form' },
      h('h2', {}, t('appearance.title')),
      h('fieldset', { class: 'choice-group', dataset: { role: 'theme-choice' } },
        h('legend', {}, t('appearance.theme')),
        THEMES.map((v) => radio('theme', v, current.theme === v, THEME_LABEL[v]()))),
      h('fieldset', { class: 'choice-group choice-grid', dataset: { role: 'accent-choice' } },
        h('legend', {}, t('appearance.accent')),
        ACCENTS.map((a) => radio('accent', a.name, current.accent === a.name, ACCENT_LABEL[a.name](), h('span', { class: `accent-dot accent-dot-${a.name}`, 'aria-hidden': 'true' })))),
      h('p', { class: 'hint' }, persist ? t('appearance.hint') : t('appearance.hintDemo')),
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button button-primary', onclick: () => finish(null) }, t('common.close'))));
  });
}
