// De keuzelijst onder het veld van snel toevoegen (zoals Todoist): na `#` projecten, `/` secties, `@` labels en `{` een deadline
// (core/quickSuggest.js). Te kiezen met de muis, met aanraken en met het toetsenbord (pijltjes, Enter of Tab, Escape), en voor
// schermlezers een combobox met een lijst (aria-expanded, aria-activedescendant, een aankondiging van het aantal).

import { applySuggestion, suggestions, tokenAt } from '../core/quickSuggest.js';
import { colorClass } from '../core/colors.js';
import { formatDate, todayString } from '../core/format.js';
import { t } from '../core/i18n.js';
import { h, replace } from './dom.js';
import { icon } from './icons.js';

let seq = 0;

/**
 * @param {{ input: HTMLInputElement, source: () => { projects: object[], sections: object[], labels: object[], defaultProjectId?: string | null } }} options
 * @returns {{ node: HTMLElement, isOpen: () => boolean, close: () => void }}
 */
export function attachQuickSuggest({ input, source }) {
  const id = `quick-suggest-${++seq}`;
  const list = h('ul', { class: 'quick-suggest', id, role: 'listbox', 'aria-label': t('quick.suggestLabel'), hidden: true });
  const status = h('span', { class: 'sr-only', 'aria-live': 'polite' });
  let state = null; // { token, caret, items, active }

  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', id);
  input.setAttribute('aria-expanded', 'false');

  const close = () => {
    if (!state && list.hidden) return;
    state = null;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const highlight = () => {
    for (const [i, li] of [...list.children].entries()) {
      const on = i === state.active;
      li.setAttribute('aria-selected', String(on));
      li.classList.toggle('active', on);
      if (on) {
        input.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView?.({ block: 'nearest' });
      }
    }
  };

  const choose = (item) => {
    if (!state) return;
    const next = applySuggestion(input.value, state.token, state.caret, item);
    input.value = next.text;
    input.setSelectionRange(next.caret, next.caret);
    close();
    input.dispatchEvent(new Event('input', { bubbles: true })); // het voorbeeld onder het veld volgt de nieuwe tekst
    input.focus();
  };

  const KIND_ICON = { project: null, section: 'list', label: 'tag', date: 'calendar' };
  const update = () => {
    const caret = input.selectionStart ?? input.value.length;
    const token = tokenAt(input.value, caret);
    if (!token) { close(); return; }
    const src = source();
    const items = suggestions(token, { ...src, text: input.value, now: new Date() });
    if (items.length === 0) { close(); return; }
    state = { token, caret, items, active: 0 };
    replace(list, items.map((item, i) => h('li', {
      id: `${id}-${i}`, role: 'option', class: `quick-suggest-item kind-${item.kind}`, dataset: { fk: `quick-suggest:${item.kind}:${item.id}` },
      onmousedown: (e) => e.preventDefault(), // de focus blijft in het veld
      onclick: () => choose(item),
    },
    item.kind === 'project' || item.kind === 'label'
      ? h('span', { class: `dot ${colorClass(item.color)}`, 'aria-hidden': 'true' })
      : icon(KIND_ICON[item.kind]),
    h('span', { class: 'quick-suggest-label' }, item.label),
    item.hint && h('span', { class: 'quick-suggest-hint' }, formatDate(item.hint, todayString())))));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    status.textContent = t('quick.suggestCount', { count: items.length });
    highlight();
  };

  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', () => setTimeout(close, 150));
  // vóór de andere toetsen (Enter = toevoegen) zodat een open lijst eerst kiest
  input.addEventListener('keydown', (e) => {
    if (!state) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      state.active = (state.active + (e.key === 'ArrowDown' ? 1 : -1) + state.items.length) % state.items.length;
      highlight();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      choose(state.items[state.active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // het venster blijft open
      close();
    }
  }, true);

  return { node: h('div', { class: 'quick-suggest-wrap' }, list, status), isOpen: () => Boolean(state), close };
}
