// Het uiterlijk van een notitie: de achtergrond (een kleur of een patroon, shared/notes.js) en de kiezer daarvoor, zoals in Anchor.
// De kleuren en patronen staan in notes.css (licht en donker); hier alleen de klassen, de namen en de kiezer.

import { NOTE_COLORS, NOTE_PATTERNS } from '../../shared/notes.js';
import { t } from '../core/i18n.js';
import { h } from './dom.js';

/** De klasse voor een achtergrond (null = de gewone achtergrond van de app). */
export const bgClass = (bg) => `nbg nbg-${bg && (NOTE_COLORS.includes(bg) || NOTE_PATTERNS.includes(bg)) ? bg : 'none'}`;

// letterlijke sleutels, zodat de controle op ontbrekende en ongebruikte teksten ze kan vinden
const LABELS = {
  none: () => t('note.bg.none'), yellow: () => t('note.bg.yellow'), orange: () => t('note.bg.orange'), brown: () => t('note.bg.brown'),
  red: () => t('note.bg.red'), pink: () => t('note.bg.pink'), purple: () => t('note.bg.purple'), indigo: () => t('note.bg.indigo'),
  blue: () => t('note.bg.blue'), teal: () => t('note.bg.teal'), green: () => t('note.bg.green'),
  dots: () => t('note.bg.dots'), grid: () => t('note.bg.grid'), lines: () => t('note.bg.lines'), waves: () => t('note.bg.waves'),
  groceries: () => t('note.bg.groceries'), music: () => t('note.bg.music'), travel: () => t('note.bg.travel'), code: () => t('note.bg.code'),
};
export const bgLabel = (bg) => (LABELS[bg ?? 'none'] ?? LABELS.none)();

/**
 * De kiezer: twee groepen tegels (kleur en patroon), met de pijltjestoetsen te bedienen. `onPreview` toont een achtergrond zolang
 * de muis erboven staat (false = weer de gekozen).
 * @param {{ value: string | null, onChange: (bg: string | null) => void, onPreview?: (bg: string | null | false) => void }} options
 */
export function backgroundPicker({ value, onChange, onPreview = () => {} }) {
  const section = (label, items, color) => {
    const chosen = items.includes(value) ? bgLabel(value) : '';
    const grid = h('div', { class: 'nbg-grid', role: 'radiogroup', 'aria-label': label });
    items.forEach((bg, n) => {
      const isChosen = bg === value;
      grid.append(h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(isChosen), 'aria-label': bgLabel(bg), title: bgLabel(bg),
        class: `nbg-tile ${bgClass(bg)}${isChosen ? ' chosen' : ''}`, tabIndex: isChosen || (!items.includes(value) && n === 0) ? 0 : -1,
        dataset: { fk: `note-bg:${bg ?? 'none'}`, bg: bg ?? '' },
        onclick: () => onChange(bg),
        onpointerenter: () => onPreview(bg),
        onkeydown: (e) => {
          const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 }[e.key];
          if (!step) return;
          e.preventDefault();
          const next = Math.min(items.length - 1, Math.max(0, n + step));
          onChange(items[next]);
          grid.querySelectorAll('button')[next]?.focus();
        },
      }, color ? 'Aa' : ''));
    });
    return h('div', { class: 'nbg-section' }, h('div', { class: 'nbg-head' }, h('span', { class: 'nbg-label' }, label), h('span', { class: 'nbg-chosen' }, chosen)), grid);
  };
  return h('div', { class: 'nbg-picker', onpointerleave: () => onPreview(false) },
    section(t('note.bg.colors'), [null, ...NOTE_COLORS], true),
    section(t('note.bg.patterns'), [...NOTE_PATTERNS], false));
}
