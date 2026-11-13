// De uitleg bij de filtertaal: hoe je termen combineert, voorbeelden en alle termen. Nederlandse en Engelse woorden werken door
// elkaar; de taal van de interface bepaalt welke vorm voorop staat. De voorbeelden en termen zelf staan in core/filterText.js
// (daar controleert een test dat ze allemaal kloppen). Als `onPick` is gegeven, zijn ze knoppen die de tekst doorgeven.

import { FILTER_EXAMPLES, FILTER_TERM_GROUPS, formsOf } from '../core/filterText.js';
import { t } from '../core/i18n.js';
import { h, openDialog } from './dom.js';

/** Een stukje filtertekst: een knop als je het kunt gebruiken, anders gewone code. */
function snippet(text, onPick) {
  if (!onPick) return h('code', { class: 'filter-code' }, text);
  return h('button', { class: 'filter-code filter-code-button', type: 'button', title: t('filter.helpInsert'), onclick: () => onPick(text) }, text);
}

/**
 * De hele uitleg als één stuk pagina.
 * @param {{ onPick?: ((text: string) => void) | null }} [options]
 */
export function filterHelp({ onPick = null } = {}) {
  const operators = [
    ['&', t('filter.help.and')],
    ['|', t('filter.help.or')],
    ['!', t('filter.help.not')],
    ['( )', t('filter.help.group')],
    [',', t('filter.help.lists')],
    ['" "', t('filter.help.quotes')],
  ];
  return h('div', { class: 'filter-help-body' },
    h('p', {}, t('filter.help.intro')),
    h('h3', { class: 'filter-help-heading' }, t('filter.help.combine')),
    h('dl', { class: 'filter-help-list' }, operators.map(([sign, text]) => h('div', { class: 'filter-help-row' },
      h('dt', {}, h('code', { class: 'filter-code' }, sign)), h('dd', {}, text)))),
    h('h3', { class: 'filter-help-heading' }, t('filter.help.examples')),
    h('dl', { class: 'filter-help-list' }, FILTER_EXAMPLES.map((example) => {
      const forms = formsOf(example);
      return h('div', { class: 'filter-help-row filter-help-example' },
        h('dt', {}, snippet(forms.main, onPick), forms.other && h('span', { class: 'filter-help-other' }, t('filter.help.also'), ' ', h('code', {}, forms.other))),
        h('dd', {}, example.text()));
    })),
    h('h3', { class: 'filter-help-heading' }, t('filter.help.terms')),
    FILTER_TERM_GROUPS.map((group) => h('section', { class: 'filter-help-group' },
      h('h4', { class: 'filter-help-subheading' }, group.title()),
      h('dl', { class: 'filter-help-list' }, group.terms.map((term) => {
        const forms = formsOf(term);
        return h('div', { class: 'filter-help-row' },
          h('dt', {}, snippet(forms.main, onPick), forms.other && h('span', { class: 'filter-help-other' }, t('filter.help.also'), ' ', h('code', {}, forms.other))),
          h('dd', {}, term.text()));
      })))),
    h('p', { class: 'hint' }, t('filter.help.names')));
}

/**
 * Het uitlegvenster. Met `onUse` staat bij elk voorbeeld een knop om het als nieuw filter te proberen.
 * @returns {Promise<string | null>} het gekozen voorbeeld, of null bij sluiten
 */
export function filterHelpDialog({ onUse = false } = {}) {
  return openDialog((finish) => h('div', { class: 'dialog-form filter-help-dialog' },
    h('h2', {}, t('filter.help.title')),
    onUse && h('p', { class: 'hint' }, t('filter.help.useHint')),
    filterHelp({ onPick: onUse ? (text) => finish(text) : null }),
    h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close')))),
  { wide: true, className: 'dialog-filter-help' });
}
