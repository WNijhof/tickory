// Het zoekvenster: een invoerveld met direct eronder de treffers (taken, opmerkingen, projecten, secties, labels en filters),
// met de gevonden woorden gemarkeerd. Bediening met het toetsenbord: pijltjes kiezen, Enter opent, Esc sluit.
// Zoals het opdrachtmenu van Todoist (Ctrl+K) staan er ook opdrachten in: zonder tekst allemaal ("Naar Vandaag", "Taak toevoegen",
// "Thema wijzigen" …), met tekst de opdrachten die erop lijken, boven de treffers. Een gekozen opdracht heeft kind 'command' en een
// functie `run`; de aanroeper voert hem uit.
// De zoekopdracht zelf staat in core/search.js (hoofdletters en accenten tellen niet mee).
//
// Dit bestand opent niets zelf: `openSearchDialog` geeft de gekozen treffer terug en de aanroeper (ui/find.js) weet hoe
// een taak, project, label of filter wordt geopend.

import { formatDue, todayString } from '../core/format.js';
import { t } from '../core/i18n.js';
import { colorClass } from '../core/colors.js';
import { markSegments, search } from '../core/search.js';
import { foldText } from '../core/fold.js';
import { h, openDialog, replace } from './dom.js';
import { icon } from './icons.js';

let optionNo = 0;

/** Tekst met de gemarkeerde stukken in een `<mark>`; alles gaat als tekst het document in. */
export function markedText(text, marks) {
  return markSegments(text, marks).map((s) => (s.mark ? h('mark', { class: 'search-mark' }, s.text) : s.text));
}

/** Het kleine plaatje voor het begin van een treffer. */
function leadOf(hit) {
  switch (hit.kind) {
    case 'task': return h('span', { class: `search-check prio-${hit.priority ?? 4}${hit.checked ? ' search-check-done' : ''}`, 'aria-hidden': 'true' });
    case 'project': return h('span', { class: `search-lead ${colorClass(hit.color)}`, 'aria-hidden': 'true' }, h('span', { class: 'dot dot-large' }));
    case 'label': return h('span', { class: `search-lead ${colorClass(hit.color)}`, 'aria-hidden': 'true' }, icon('tag'));
    case 'filter': return h('span', { class: `search-lead ${colorClass(hit.color)}`, 'aria-hidden': 'true' }, icon('funnel'));
    case 'comment': return h('span', { class: 'search-lead', 'aria-hidden': 'true' }, icon('comment'));
    case 'command': return h('span', { class: 'search-lead search-lead-command', 'aria-hidden': 'true' }, icon(hit.icon ?? 'chevronRight'));
    default: return h('span', { class: 'search-lead', 'aria-hidden': 'true' }, icon('subtasks'));
  }
}

/** De tweede regel onder de titel van een treffer: waar hij staat, of het stuk tekst waarin de woorden voorkomen. */
function detailOf(hit, today) {
  if (hit.kind === 'command') return [];
  if (hit.kind === 'comment') {
    return [h('span', { class: 'search-snippet' }, markedText(hit.text, hit.marks)), hit.project && h('span', { class: 'search-where' }, hit.project.name)];
  }
  if (hit.where === 'description' || (hit.where === 'label' && hit.kind === 'task')) {
    const found = h('span', { class: 'search-snippet' }, hit.where === 'label' ? ['@', markedText(hit.text, hit.marks)] : markedText(hit.text, hit.marks));
    return [found, hit.project && h('span', { class: 'search-where' }, hit.project.name)];
  }
  if (hit.kind === 'task') {
    const due = hit.due ? formatDue(hit.due, today) : '';
    return [hit.project && h('span', { class: 'search-where' }, hit.project.name), due && h('span', { class: 'search-where search-due' }, due)];
  }
  if (hit.kind === 'section') return [hit.project && h('span', { class: 'search-where' }, hit.project.name)];
  if (hit.kind === 'project') return [hit.project && h('span', { class: 'search-where' }, t('search.insideProject', { name: hit.project.name }))];
  if (hit.kind === 'label' && hit.foreign) return [h('span', { class: 'search-where' }, t('search.foreignLabel'))];
  return [];
}

/** De titel van een treffer: bij een treffer in de titel of naam met markering; anders (beschrijving, label, opmerking) gewoon de titel. */
const titleOf = (hit) => (hit.kind === 'comment' ? hit.on.name : hit.kind === 'command' ? hit.title : hit.where === 'title' || hit.where === 'name' ? markedText(hit.text, hit.marks) : hit.title);

const kindText = (kind) => ({
  task: t('search.kind.task'), project: t('search.kind.project'), section: t('search.kind.section'),
  label: t('search.kind.label'), filter: t('search.kind.filter'), comment: t('search.kind.comment'), command: t('search.kind.command'),
}[kind]);

/**
 * Opent het zoekvenster.
 * @param {{ store: import('../core/store.js').Store, initial?: string, commands?: { id: string, label: string, icon?: string, keys?: string[], words?: string[], run: () => void }[] }} options
 *   `commands`: de opdrachten (zoals het opdrachtmenu van Todoist); `keys` is de sneltoets die rechts staat, `words` zijn extra zoekwoorden
 * @returns {Promise<object | null>} de gekozen treffer (zie `search` in core/search.js), of null bij sluiten
 */
export function openSearchDialog({ store, initial = '', commands = [] }) {
  /** De opdrachten die bij de tekst passen: zonder tekst allemaal, anders die waarvan de naam of een zoekwoord de tekst bevat. */
  const commandHits = (text) => {
    const q = foldText(text.trim());
    const found = commands.filter((c) => !q || [c.label, ...(c.words ?? [])].some((w) => foldText(w).includes(q)));
    return (q ? found.slice(0, 6) : found).map((c) => ({ kind: 'command', id: c.id, title: c.label, icon: c.icon, keys: c.keys ?? null, run: c.run }));
  };
  let unsubscribe = () => {};
  return openDialog((finish, dialog) => {
    const listId = `search-list-${++optionNo}`;
    const input = h('input', {
      class: 'search-input', type: 'text', role: 'combobox', value: initial, maxLength: 200, placeholder: commands.length > 0 ? t('search.placeholderCommands') : t('search.placeholder'),
      'aria-label': t('search.label'), 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
      autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterkeyhint: 'search', autofocus: true,
    });
    const list = h('ul', { class: 'search-results', id: listId, role: 'listbox', 'aria-label': t('search.results') });
    const status = h('p', { class: 'search-status', role: 'status' });
    const empty = h('div', { class: 'search-empty' });
    let hits = [];
    let active = 0;
    let activeId = null;
    const options = new Map(); // treffer-id → element

    const setActive = (index, { scroll = true } = {}) => {
      if (hits.length === 0) {
        active = 0;
        input.removeAttribute('aria-activedescendant');
        return;
      }
      active = (index + hits.length) % hits.length;
      const hit = hits[active];
      activeId = `${hit.kind}:${hit.id}`;
      for (const [key, el] of options) {
        const on = key === activeId;
        el.classList.toggle('search-active', on);
        el.setAttribute('aria-selected', String(on));
        if (on) {
          input.setAttribute('aria-activedescendant', el.id);
          if (scroll) el.scrollIntoView({ block: 'nearest' });
        }
      }
    };

    const draw = () => {
      const text = input.value;
      const found = text.trim() === '' ? [] : search(store.view, text, { userId: store.userId, limit: 50 });
      hits = [...commandHits(text), ...found];
      options.clear();
      const today = todayString();
      replace(list, hits.map((hit, i) => {
        const key = `${hit.kind}:${hit.id}`;
        const el = h('li', {
          class: `search-hit search-hit-${hit.kind}${hit.checked && hit.kind === 'task' ? ' search-hit-done' : ''}`, role: 'option', id: `${listId}-${i}`, 'aria-selected': 'false',
          onpointermove: () => { if (activeId !== key) setActive(i, { scroll: false }); },
          onclick: () => finish(hit),
        },
        leadOf(hit),
        h('span', { class: 'search-main' },
          h('span', { class: 'search-title' }, titleOf(hit)),
          h('span', { class: 'search-detail' }, detailOf(hit, today))),
        hit.kind === 'command' && hit.keys
          ? h('span', { class: 'search-kind search-keys-hint' }, hit.keys.map((k) => h('kbd', {}, k)))
          : h('span', { class: 'search-kind' }, kindText(hit.kind)));
        options.set(key, el);
        return el;
      }));
      const keep = hits.findIndex((x) => `${x.kind}:${x.id}` === activeId);
      input.setAttribute('aria-expanded', String(hits.length > 0));
      setActive(keep >= 0 ? keep : 0, { scroll: false });
      list.hidden = hits.length === 0;
      if (text.trim() === '') {
        replace(empty, h('p', { class: 'search-empty-title' }, t('search.startTitle')), h('p', {}, t('search.startText')));
        status.textContent = '';
      } else if (found.length === 0 && hits.length === 0) {
        replace(empty, h('p', { class: 'search-empty-title' }, t('search.noneTitle', { text: text.trim() })), h('p', {}, t('search.noneText')));
        status.textContent = t('search.none');
      } else {
        replace(empty);
        status.textContent = found.length >= 50 ? t('search.countMax', { count: found.length }) : t('search.count', { count: found.length });
      }
      empty.hidden = text.trim() !== '' && hits.length > 0; // zonder tekst: de uitleg, met de opdrachten eronder
    };

    input.addEventListener('input', () => { activeId = null; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'PageDown') { e.preventDefault(); setActive(Math.min(active + 5, hits.length - 1)); }
      else if (e.key === 'PageUp') { e.preventDefault(); setActive(Math.max(active - 5, 0)); }
      else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setActive(0); }
      else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setActive(hits.length - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (hits[active]) finish(hits[active]);
      }
    });

    unsubscribe = store.subscribe(draw); // een wijziging van een ander apparaat komt vanzelf in de treffers
    dialog.id = 'search-dialog';
    dialog.setAttribute('aria-label', t('search.title'));
    queueMicrotask(draw);
    return h('div', { class: 'search-panel' },
      h('div', { class: 'search-box' },
        icon('search'),
        input,
        h('button', { class: 'icon-button search-close', type: 'button', 'aria-label': t('common.close'), title: t('common.close'), onclick: () => finish(null) }, icon('close'))),
      status,
      empty,
      list,
      h('p', { class: 'search-keys', 'aria-hidden': 'true' },
        h('span', {}, h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' ', t('search.keyChoose')),
        h('span', {}, h('kbd', {}, 'Enter'), ' ', t('search.keyOpen')),
        h('span', {}, h('kbd', {}, 'Esc'), ' ', t('search.keyClose'))));
  }, { className: 'dialog-search', onClose: () => unsubscribe() });
}
