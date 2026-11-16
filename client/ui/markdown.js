// Markdown (core/markdown.js) als knooppunten in de pagina. Alles gaat met createElement en tekst; nooit als HTML. Links openen in een
// nieuw tabblad zonder dat de pagina erachter iets over de app te weten komt.

import { hasInlineMarkup, parseInline, parseMarkdown } from '../core/markdown.js';
import { t } from '../core/i18n.js';
import { h } from './dom.js';

const inline = (nodes, links = true) => nodes.map((n) => {
  switch (n.t) {
    case 'text': return document.createTextNode(n.v);
    case 'br': return h('br');
    case 'code': return h('code', { class: 'md-code' }, n.v);
    case 'strong': return h('strong', {}, inline(n.c, links));
    case 'em': return h('em', {}, inline(n.c, links));
    case 'del': return h('del', {}, inline(n.c, links));
    case 'u': return h('u', {}, inline(n.c, links));
    case 'mark': return h('mark', { class: `md-mark hl-${n.color ?? 'yellow'}` }, inline(n.c, links));
    // in een rij die zelf een knop is, kan een link geen link zijn (geen klikbaar element in een klikbaar element)
    case 'link': return links ? h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer nofollow' }, inline(n.c, links)) : h('span', { class: 'md-link' }, inline(n.c, links));
    default: return null;
  }
});

/**
 * Eén regel met opmaak (vet, cursief, doorgestreept, code, markeren, links), zoals de titel van een taak.
 * @param {string} source
 * @param {{ links?: boolean }} [options] `links: false`: een link als gewone tekst (in een rij die zelf een knop is)
 * @returns {(Node | null)[]}
 */
export function renderInline(source, { links = true } = {}) {
  const text = String(source ?? '');
  if (!hasInlineMarkup(text)) return [document.createTextNode(text)];
  return inline(parseInline(text), links);
}

/**
 * @param {string} source
 * @param {{ onToggleTask?: ((index: number) => void) | null }} [options] met `onToggleTask` zijn de taakpunten te (de)markeren; zonder is ze alleen te lezen
 * @returns {HTMLElement}
 */
export function renderMarkdown(source, { onToggleTask = null } = {}) {
  let taskIndex = 0;
  const list = (b) => {
    const el = h(b.ordered ? 'ol' : 'ul', { class: 'md-list', start: b.ordered && b.start !== 1 ? b.start : null });
    for (const item of b.items) {
      const index = item.checked === null ? -1 : taskIndex++;
      const box = item.checked === null ? null : h('input', {
        type: 'checkbox', class: 'md-check', checked: item.checked, disabled: !onToggleTask, dataset: { taskIndex: String(index) },
        'aria-label': item.c.map((n) => n.v ?? '').join('').slice(0, 80) || undefined,
        onchange: () => onToggleTask?.(index),
      });
      el.append(h('li', { class: `md-item${item.checked === null ? '' : ' md-task'}${item.checked ? ' md-done' : ''}` }, box, h('span', {}, inline(item.c)), item.children.map(list)));
    }
    return el;
  };
  const block = (b) => {
    switch (b.t) {
      case 'heading': return h(`h${Math.min(6, b.level + 1)}`, { class: `md-h md-h${b.level}` }, inline(b.c)); // de paginakop is al een h1
      case 'paragraph': return h('p', { class: 'md-p' }, inline(b.c));
      case 'quote': return h('blockquote', { class: 'md-quote' }, b.c.map(block));
      case 'code': return h('pre', { class: 'md-pre' }, h('code', {}, b.v));
      case 'rule': return h('hr', { class: 'md-rule' });
      case 'list': return list(b);
      case 'table': return h('div', { class: 'md-table-wrap', tabIndex: 0, role: 'group', 'aria-label': t('markdown.table') },
        h('table', { class: 'md-table' },
          h('thead', {}, h('tr', {}, b.head.map((c, k) => h('th', { scope: 'col', class: b.align[k] ? `md-al-${b.align[k]}` : null }, inline(c))))),
          h('tbody', {}, b.rows.map((row) => h('tr', {}, row.map((c, k) => h('td', { class: b.align[k] ? `md-al-${b.align[k]}` : null }, inline(c))))))));
      default: return null;
    }
  };
  return h('div', { class: 'md' }, parseMarkdown(source).map(block));
}
