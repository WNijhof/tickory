// De keuzelijst bij het typen van @ in een opmerking: de leden van het project (naam en gebruikersnaam), te kiezen met de muis,
// met aanraken en met het toetsenbord (pijltjes, Enter of Tab, Escape), en voor schermlezers als combobox met een lijst
// (aria-expanded, aria-activedescendant, en een aankondiging van het aantal treffers). De logica staat in core/mentions.js.

import { insertMention, mentionAt, mentionCandidates } from '../core/mentions.js';
import { t } from '../core/i18n.js';
import { initials } from '../core/rowModel.js';
import { h, replace } from './dom.js';

let seq = 0;

/**
 * @param {{
 *   input: HTMLTextAreaElement,
 *   people: () => { id: string, name: string, username: string }[],   // wie je in deze opmerking kunt noemen
 *   me: () => string | null,
 *   chosen?: Map<string, string>,                                      // id → naam: wie er al genoemd is (bij bewerken)
 * }} options
 * @returns {{ node: HTMLElement, chosen: Map<string, string>, close: () => void, reset: () => void, isOpen: () => boolean }}
 */
export function attachMentionPicker({ input, people, me, chosen = new Map() }) {
  const id = `mention-list-${++seq}`;
  const list = h('ul', { class: 'mention-list', id, role: 'listbox', 'aria-label': t('mention.listLabel'), hidden: true });
  const status = h('span', { class: 'sr-only', 'aria-live': 'polite' });
  let state = null; // { start, caret, options, active }

  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', id);
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-haspopup', 'listbox');

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

  const choose = (person) => {
    if (!state) return;
    const next = insertMention(input.value, state.start, state.caret, person);
    input.value = next.text;
    input.setSelectionRange(next.caret, next.caret);
    chosen.set(person.id, person.name);
    close();
    input.dispatchEvent(new Event('input', { bubbles: true })); // de knop "Plaatsen" en het concept volgen de nieuwe tekst
    input.focus();
  };

  const update = () => {
    const caret = input.selectionStart ?? input.value.length;
    if (input.selectionEnd !== caret) return close();
    const at = mentionAt(input.value, caret);
    const options = at ? mentionCandidates(people(), at.query, { me: me() }) : [];
    if (!at || options.length === 0) {
      if (state) status.textContent = '';
      return close();
    }
    const keep = state?.options[state.active]?.id;
    const active = Math.max(0, options.findIndex((p) => p.id === keep));
    state = { start: at.start, caret, options, active };
    replace(list, options.map((p, i) => h('li', {
      id: `${id}-${i}`, role: 'option', class: 'mention-option', 'aria-selected': 'false',
      // pointerdown in plaats van click: de focus blijft in het invoerveld, en de lijst sluit niet eerst door het verliezen ervan
      onpointerdown: (e) => { e.preventDefault(); choose(p); },
    },
    h('span', { class: 'mention-avatar', 'aria-hidden': 'true' }, initials(p.name)),
    h('span', { class: 'mention-name' }, p.name),
    h('span', { class: 'mention-username' }, `@${p.username}`))));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight();
    status.textContent = t('mention.found', { count: options.length });
  };

  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') update(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    if (!state || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = state.options.length;
      state.active = (state.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      highlight();
    } else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      choose(state.options[state.active]);
    } else if (e.key === 'Escape') {
      // alleen de lijst sluiten, niet het venster eromheen
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  });

  return {
    node: h('div', { class: 'mention-anchor' }, list, status),
    chosen,
    close,
    reset: () => { chosen.clear(); close(); },
    isOpen: () => Boolean(state),
  };
}
