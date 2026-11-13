// Het venster om een filter te maken of te bewerken: naam, de filtertekst met direct een melding (of het aantal taken dat het
// oplevert), kleur, favoriet en de uitleg van de filtertaal. Een filter met een fout wordt niet bewaard.
// Ook de weergave van een fout (de getypte tekst met de plek gemarkeerd) staat hier, voor het filterscherm.

import { errorParts, filterErrorText } from '../core/filterText.js';
import { filterOutcome } from '../core/filterViews.js';
import { t } from '../core/i18n.js';
import { h, openDialog, replace } from './dom.js';
import { filterHelp } from './filterHelp.js';
import { colorField } from './labelDialog.js';

/** De getypte filtertekst met het deel dat niet klopt gemarkeerd. */
export function queryWithError(query, error) {
  const { before, bad, after } = errorParts(query, error);
  return h('code', { class: 'filter-query filter-query-error' }, before, bad ? h('mark', { class: 'filter-error-mark' }, bad) : h('mark', { class: 'filter-error-mark filter-error-end', 'aria-hidden': 'true' }, ' '), after);
}

/** Een melding over een fout in een filter, met de tekst eronder; `role="alert"` zodat schermlezers het meteen voorlezen. */
export function errorBlock(query, error, { role = 'alert' } = {}) {
  return h('div', { class: 'filter-error', role },
    h('p', { class: 'filter-error-text' }, filterErrorText(error)),
    queryWithError(query, error));
}

/** De omgeving voor het uitvoeren van een filter, zoals de rest van de app die kent. */
export const filterContext = (store) => ({ view: store.view, now: new Date(), userId: store.userId, users: store.users });

/**
 * @param {{ store: import('../core/store.js').Store, filter?: object | null, query?: string }} options
 *   `filter`: een bestaand filter bewerken; anders een nieuw filter, eventueel met een begintekst (`query`).
 * @returns {Promise<{ name: string, query: string, color: string, is_favorite: boolean } | null>} null bij annuleren
 */
export function openFilterDialog({ store, filter = null, query = '' }) {
  return openDialog((finish) => {
    const editing = Boolean(filter);
    const name = h('input', { type: 'text', value: filter?.name ?? '', class: 'field', 'aria-label': t('common.name'), autocomplete: 'off', maxLength: 200, autofocus: true });
    const text = h('input', {
      type: 'text', value: filter?.query ?? query, class: 'field filter-input', 'aria-label': t('filter.queryLabel'), autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
      maxLength: 2000, placeholder: t('filter.queryPlaceholder'), 'aria-describedby': 'filter-dialog-state',
    });
    const state = h('div', { id: 'filter-dialog-state', class: 'filter-state', 'aria-live': 'polite' });
    const nameError = h('p', { class: 'error', role: 'alert' });
    const color = colorField(filter?.color);
    const favorite = h('input', { type: 'checkbox', checked: Boolean(filter?.is_favorite) });

    /** Controleert de tekst en toont de uitkomst. Geeft true als het filter klopt. */
    const check = () => {
      const value = text.value.trim();
      if (value === '') {
        replace(state, h('p', { class: 'hint' }, t('filter.hintEmpty')));
        text.setAttribute('aria-invalid', 'false');
        return false;
      }
      const outcome = filterOutcome({ query: value }, filterContext(store));
      text.setAttribute('aria-invalid', String(!outcome.ok));
      if (!outcome.ok) {
        // de plek verwijst naar de getrimde tekst; die gebruiken we ook om te tonen
        replace(state, errorBlock(value, outcome.error, { role: null }));
        return false;
      }
      replace(state, h('p', { class: 'hint filter-ok' }, t('filter.matches', { count: outcome.count })));
      return true;
    };
    text.addEventListener('input', check);
    check();

    const insert = (snippetText) => {
      const start = text.selectionStart ?? text.value.length;
      const end = text.selectionEnd ?? text.value.length;
      const before = text.value.slice(0, start);
      const needsSpace = before !== '' && !/\s$/u.test(before);
      text.setRangeText(`${needsSpace ? ' ' : ''}${snippetText}`, start, end, 'end');
      text.dispatchEvent(new Event('input', { bubbles: true }));
      text.focus();
    };

    return h('form', {
      class: 'dialog-form dialog-filter',
      onsubmit: (e) => {
        e.preventDefault();
        nameError.textContent = '';
        if (name.value.trim() === '') {
          nameError.textContent = t('filter.nameRequired');
          name.focus();
          return;
        }
        if (!check()) {
          text.focus();
          return;
        }
        finish({ name: name.value.trim(), query: text.value.trim(), color: color.value(), is_favorite: favorite.checked });
      },
    },
    h('h2', {}, editing ? t('filter.edit') : t('filter.new')),
    h('label', { class: 'field-label' }, t('common.name'), name),
    nameError,
    h('label', { class: 'field-label' }, t('filter.queryLabel'), text),
    state,
    color.node,
    h('label', { class: 'check-row' }, favorite, t('filter.favorite')),
    h('details', { class: 'filter-help' }, h('summary', {}, t('filter.helpSummary')), filterHelp({ onPick: insert })),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary' }, editing ? t('common.save') : t('common.add'))));
  }, { wide: true });
}
