// Het stuk "Meldingen bij samenwerken" in het scherm Herinneringen en meldingen: per soort of die ook als melding op je apparaten
// komt (pushmelding in de browser, melding van de Android-app). De keuze hoort bij de gebruiker (`settings.notify_push`), dus geldt
// op al je apparaten. In de lijst Meldingen in de app staan ze altijd.

import { NOTIFICATION_KINDS, pushChoices } from '../../shared/notifications.js';
import { kindLabel } from '../core/inbox.js';
import { t } from '../core/i18n.js';
import { mySettings } from '../core/selectors.js';
import { h } from './dom.js';

/**
 * @param {{ store: object, actions: { updateSettings: (changes: object) => Promise<void> } }} options
 * @returns {{ node: HTMLElement, dispose: () => void }}
 */
export function pushKindsSection({ store, actions }) {
  const boxes = new Map();
  const list = h('div', { class: 'push-kinds', role: 'group', 'aria-label': t('inbox.pushTitle') },
    NOTIFICATION_KINDS.map((kind) => {
      const box = h('input', { type: 'checkbox', dataset: { kind } });
      box.addEventListener('change', () => {
        const now = pushChoices(mySettings(store.view, store.userId));
        actions.updateSettings({ notify_push: { ...now, [kind]: box.checked } });
      });
      boxes.set(kind, box);
      return h('label', { class: 'check-row' }, box, h('span', {}, kindLabel(kind)));
    }));
  const draw = () => {
    const choices = pushChoices(mySettings(store.view, store.userId));
    for (const [kind, box] of boxes) box.checked = choices[kind];
  };
  const dispose = store.subscribe(draw);
  draw();
  const node = h('details', { class: 'section', open: true, dataset: { role: 'push-kinds' } },
    h('summary', {}, t('inbox.pushTitle')),
    h('div', { class: 'section-form' }, h('p', { class: 'hint' }, t('inbox.pushHint')), list));
  return { node, dispose };
}
