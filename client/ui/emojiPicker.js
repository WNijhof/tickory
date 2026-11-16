// De emoji-kiezer: een knop die een klein paneel opent met een zoekveld, de groepen (en je laatst gebruikte) en een raster met
// emoji. Een keuze komt op de plek van de cursor in het invoerveld. Met het toetsenbord: Tab naar het raster, pijltjes om te
// bewegen, Enter of spatie om te kiezen, Escape om te sluiten (zonder het venster eromheen te sluiten). De lijst en het zoeken
// staan in core/emoji.js.

import { EMOJI_GROUPS, emojiName, insertAtCaret, recentEmoji, rememberEmoji, searchEmoji } from '../core/emoji.js';
import { getLanguage, t } from '../core/i18n.js';
import { h, replace } from './dom.js';
import { icon } from './icons.js';

const COLUMNS = 8;

/**
 * @param {{ input: HTMLInputElement | HTMLTextAreaElement, host: HTMLElement, fk?: string }} options  `host` krijgt het paneel (positie relatief)
 * @returns {HTMLButtonElement} de knop om naast het invoerveld te zetten
 */
export function emojiButton({ input, host, fk = 'emoji-open' }) {
  let panel = null;
  const button = h('button', {
    type: 'button', class: 'icon-button emoji-open', 'aria-label': t('emoji.open'), title: t('emoji.open'), 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    dataset: { fk }, onclick: () => (panel ? close() : open()),
  }, icon('smile'));

  const lang = () => (getLanguage() === 'en' ? 'en' : 'nl');
  const nameOf = (char) => emojiName(char, lang());

  function open() {
    const recent = recentEmoji();
    let group = recent.length > 0 ? 'recent' : EMOJI_GROUPS[0].id;
    const search = h('input', { class: 'field emoji-search', type: 'search', placeholder: t('emoji.search'), 'aria-label': t('emoji.search'), autocomplete: 'off', dataset: { fk: 'emoji-search' } });
    const tabs = h('div', { class: 'emoji-tabs', role: 'tablist', 'aria-label': t('emoji.groups') });
    const grid = h('div', { class: 'emoji-grid', role: 'group' });
    const charsNow = () => {
      if (search.value.trim()) return searchEmoji(search.value).map((e) => e.char);
      if (group === 'recent') return recentEmoji();
      return EMOJI_GROUPS.find((g) => g.id === group).items.map(([c]) => c);
    };
    const drawTabs = () => replace(tabs,
      [recent.length > 0 && { id: 'recent', icon: '🕘', name: t('emoji.recent') }, ...EMOJI_GROUPS.map((g) => ({ id: g.id, icon: g.items[0][0], name: g[lang()] }))]
        .filter(Boolean)
        .map((g) => h('button', {
          type: 'button', class: `emoji-tab${g.id === group && !search.value.trim() ? ' active' : ''}`, role: 'tab',
          'aria-selected': String(g.id === group && !search.value.trim()), 'aria-label': g.name, title: g.name, dataset: { group: g.id },
          onclick: () => { group = g.id; search.value = ''; drawTabs(); drawGrid(); },
        }, g.icon)));
    const drawGrid = () => {
      const chars = charsNow();
      grid.setAttribute('aria-label', search.value.trim() ? t('emoji.results') : (group === 'recent' ? t('emoji.recent') : EMOJI_GROUPS.find((g) => g.id === group)[lang()]));
      if (chars.length === 0) { replace(grid, h('p', { class: 'hint emoji-none' }, t('emoji.none'))); return; }
      replace(grid, chars.map((char, i) => h('button', {
        type: 'button', class: 'emoji-item', 'aria-label': nameOf(char) || char, title: nameOf(char), tabIndex: i === 0 ? 0 : -1, dataset: { char },
        onclick: () => pick(char),
      }, char)));
    };
    search.addEventListener('input', () => { drawTabs(); drawGrid(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = charsNow()[0];
        if (first) pick(first);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        grid.querySelector('.emoji-item')?.focus();
      }
    });
    grid.addEventListener('keydown', (e) => {
      const items = [...grid.querySelectorAll('.emoji-item')];
      const at = items.indexOf(document.activeElement);
      if (at < 0) return;
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      const next = at + step;
      if (next < 0 && e.key === 'ArrowUp') { search.focus(); return; }
      const target = items[Math.max(0, Math.min(items.length - 1, next))];
      for (const b of items) b.tabIndex = -1;
      target.tabIndex = 0;
      target.focus();
    });
    panel = h('div', { class: 'emoji-picker', role: 'dialog', 'aria-label': t('emoji.open'), dataset: { fk: 'emoji-picker' } }, search, tabs, grid);
    drawTabs();
    drawGrid();
    host.append(panel);
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    panel.addEventListener('keydown', onKey);
    dialog()?.addEventListener('cancel', onCancel);
    search.focus();
  }

  const dialog = () => host.closest('dialog');
  const outside = (e) => { if (panel && !panel.contains(e.target) && !button.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // alleen het paneel dicht, niet het venster eromheen
    close();
    button.focus();
  };
  // Escape in een <dialog> komt (ook) als 'cancel' op het venster: zolang het paneel open is, sluit dat alleen het paneel
  const onCancel = (e) => { e.preventDefault(); close(); button.focus(); };

  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    dialog()?.removeEventListener('cancel', onCancel);
  }

  function pick(char) {
    insertAtCaret(input, char);
    input.dispatchEvent(new Event('input', { bubbles: true })); // de knop Plaatsen en de @-lijst horen het
    rememberEmoji(char);
    close();
    input.focus();
  }

  return button;
}
