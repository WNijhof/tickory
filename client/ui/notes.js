// Het scherm Notities (SPEC 5k): alle notities als kaarten, met zoeken, labels, het archief en de prullenbak. Een regel "Notities"
// in de zijbalk (`sidebarHooks`, onder Voltooid) en een scherm voor de routes `notes` (`viewHooks.notes`). De route is
// `{ type: 'notes' }` voor alle notities, of met `id`: 'archive', 'trash' of 'label:<label-id>'. Een notitie lezen en schrijven doet
// ui/noteEditor.js, in een venster.

import { t } from '../core/i18n.js';
import { colorClass } from '../core/colors.js';
import { markSegments } from '../core/search.js';
import { NOTE_TRASH_DAYS, expiredNotes, noteCounts, noteLabels, noteList, noteSnippet, noteTitle, trashDaysLeft } from '../core/notes.js';
import { dayOf } from '../core/timeAgo.js';
import { confirmDialog, h, toast } from './dom.js';
import { icon } from './icons.js';
import { openNoteEditor } from './noteEditor.js';
import { sidebarHooks, viewHooks } from './render.js';

export const isNotesRoute = (route) => Boolean(route) && route.type === 'notes';

/** De route `{ type: 'notes', id }` als keuze voor de lijst. Een onbekende id is "alle notities". */
export function scopeOfRoute(route) {
  const id = route?.id ?? '';
  if (id === 'archive' || id === 'trash') return { scope: id, labelId: null };
  if (typeof id === 'string' && id.startsWith('label:')) return { scope: 'all', labelId: id.slice(6) };
  return { scope: 'all', labelId: null };
}

/**
 * @param {{
 *   store: import('../core/store.js').Store, actions: object,
 *   handlers: { navigate: (route: object) => void, refresh: () => void },
 *   getRoute: () => object, cleanUp?: boolean,
 * }} options `cleanUp`: ruim notities op die te lang in de prullenbak liggen (niet in de demo)
 */
export function installNotes({ store, actions, handlers, getRoute, cleanUp = true }) {
  const state = { query: '' };
  let composing = false;
  let cleaned = false;

  // Het zoekveld blijft hetzelfde element bij elke keer tekenen (zie ui/completed.js); app.js zet de focus terug via `data-fk`.
  const search = h('input', { class: 'field', type: 'search', autocomplete: 'off', maxLength: 200, dataset: { fk: 'notes-search' } });
  search.addEventListener('input', () => {
    state.query = search.value;
    if (!composing) handlers.refresh();
  });
  search.addEventListener('compositionstart', () => { composing = true; });
  search.addEventListener('compositionend', () => { composing = false; state.query = search.value; handlers.refresh(); });

  // ---------- opruimen ----------
  if (cleanUp) {
    store.subscribe(() => {
      if (cleaned || !store.ready || !store.me) return;
      cleaned = true; // één keer per start is genoeg
      const old = expiredNotes(store.view);
      if (old.length > 0) actions.deleteNotes(old.map((n) => n.id));
    });
  }

  // ---------- handelingen ----------
  async function newNote() {
    const { labelId } = scopeOfRoute(getRoute());
    const id = await actions.addNote({ labels: labelId && store.view.labels.has(labelId) ? [labelId] : [] });
    await openNoteEditor({ store, actions, noteId: id, edit: true, created: true });
  }
  const open = (note) => openNoteEditor({ store, actions, noteId: note.id });

  async function emptyTrash() {
    const ids = [...store.view.notes.values()].filter((n) => n.trashed_at).map((n) => n.id);
    if (ids.length === 0) return;
    const ok = await confirmDialog({ title: t('note.emptyTrashTitle'), text: t('note.emptyTrashText', { count: ids.length }), okText: t('note.emptyTrash') });
    if (!ok) return;
    await actions.deleteNotes(ids);
    toast(t('note.trashEmptied'));
  }

  // ---------- de zijbalk ----------
  sidebarHooks.push(({ extra }) => {
    if (!extra || !store.ready || !store.me) return;
    const active = isNotesRoute(getRoute());
    const count = noteCounts(store.view).all;
    extra.before(h('button', {
      class: `nav-item${active ? ' active' : ''}`, type: 'button', 'aria-current': active ? 'page' : null, dataset: { fk: 'nav-notes' },
      onclick: () => handlers.navigate({ type: 'notes' }),
    }, icon('note'), h('span', { class: 'nav-label' }, t('note.title')), count > 0 && h('span', { class: 'nav-count' }, String(count))));
  });

  // ---------- het scherm ----------
  const card = (note, ctx) => {
    const { view, query, scope } = ctx;
    const snippet = noteSnippet(note, query);
    const labels = (note.labels ?? []).map((id) => view.labels.get(id)).filter(Boolean);
    const title = noteTitle(note, t('note.untitled'));
    const body = snippet.text
      ? h('p', { class: 'note-snippet' }, markSegments(snippet.text, snippet.marks).map((p) => (p.mark ? h('mark', {}, p.text) : p.text)))
      : null;
    return h('li', { class: `note-card ${colorClass(note.color)}${note.is_pinned ? ' note-pinned' : ''}`, dataset: { id: note.id } },
      h('button', { class: 'note-card-open', type: 'button', dataset: { fk: `note:${note.id}` }, 'aria-label': `${title}${note.is_pinned ? `, ${t('note.pinnedMark')}` : ''}`, onclick: () => open(note) },
        h('span', { class: 'note-card-head' },
          h('span', { class: 'note-card-title' }, title),
          note.is_pinned && h('span', { class: 'note-pin', role: 'img', 'aria-label': t('note.pinnedMark') }, icon('pin'))),
        body,
        labels.length > 0 && h('span', { class: 'note-card-labels' }, labels.map((l) => h('span', { class: 'chip' }, h('span', { class: `dot ${colorClass(l.color)}`, 'aria-hidden': 'true' }), l.name))),
        h('span', { class: 'note-card-foot' },
          scope === 'trash' ? t('note.daysLeft', { count: trashDaysLeft(note) }) : t('note.updatedShort', { when: dayOf(note.updated_at) }))),
      scope === 'trash' && h('button', {
        class: 'button button-small note-card-restore', type: 'button', dataset: { fk: `note-restore:${note.id}` },
        onclick: async () => { await actions.restoreNote(note.id); toast(t('note.restored')); },
      }, icon('undo'), t('note.restore')));
  };

  viewHooks.notes = (ctx) => {
    const { view, route, emptyState } = ctx;
    const { scope, labelId } = scopeOfRoute(route);
    const label = labelId ? view.labels.get(labelId) : null;
    const counts = noteCounts(view);
    const list = noteList(view, { scope, labelId: label ? labelId : null, query: state.query });
    search.placeholder = t('note.searchPlaceholder');
    search.setAttribute('aria-label', t('note.searchLabel'));
    if (search.value !== state.query) search.value = state.query;

    const tab = (id, text, count) => h('button', {
      class: `button button-small note-tab${scope === id && !label ? ' active' : ''}`, type: 'button', 'aria-pressed': String(scope === id && !label), dataset: { fk: `notes-tab:${id}` },
      onclick: () => handlers.navigate(id === 'all' ? { type: 'notes' } : { type: 'notes', id }),
    }, text, count > 0 && h('span', { class: 'note-tab-count' }, String(count)));
    const labels = noteLabels(view);
    const chips = labels.length > 0 && h('div', { class: 'note-label-bar', role: 'group', 'aria-label': t('note.filterByLabel') },
      labels.map(({ label: l, count }) => {
        const on = l.id === labelId;
        return h('button', {
          class: `chip note-label-chip${on ? ' active' : ''}`, type: 'button', 'aria-pressed': String(on), dataset: { fk: `notes-label:${l.id}` },
          onclick: () => handlers.navigate(on ? { type: 'notes' } : { type: 'notes', id: `label:${l.id}` }),
        }, h('span', { class: `dot ${colorClass(l.color)}`, 'aria-hidden': 'true' }), l.name, h('span', { class: 'note-tab-count' }, String(count)));
      }));

    const empty = list.length === 0
      ? emptyState(state.query
        ? { title: t('note.noResultsTitle'), text: t('note.noResults') }
        : scope === 'trash' ? { title: t('note.trashEmptyTitle'), text: t('note.trashEmpty', { days: NOTE_TRASH_DAYS }) }
          : scope === 'archive' ? { title: t('note.archiveEmptyTitle'), text: t('note.archiveEmpty') }
            : { title: t('note.emptyTitle'), text: t('note.empty'), action: h('button', { class: 'button button-primary', type: 'button', onclick: newNote }, t('note.new')) })
      : null;

    return {
      title: label ? label.name : scope === 'archive' ? t('note.scope.archive') : scope === 'trash' ? t('note.scope.trash') : t('note.title'),
      count: null,
      lead: icon('note'),
      actions: [
        scope === 'trash'
          ? counts.trash > 0 && h('button', { class: 'button button-small button-ghost', type: 'button', dataset: { fk: 'notes-empty-trash' }, onclick: emptyTrash }, icon('trash'), h('span', { class: 'btn-label' }, t('note.emptyTrash')))
          : h('button', { class: 'button button-small button-primary', type: 'button', dataset: { fk: 'notes-new' }, onclick: newNote }, icon('plus'), h('span', { class: 'btn-label' }, t('note.new'))),
      ],
      nodes: [
        h('div', { class: 'note-tools' }, h('div', { class: 'note-tabs', role: 'group', 'aria-label': t('note.scopes') }, tab('all', t('note.scope.all'), counts.all), tab('archive', t('note.scope.archive'), counts.archive), tab('trash', t('note.scope.trash'), counts.trash)), search),
        chips,
        scope === 'trash' && list.length > 0 && h('p', { class: 'hint' }, t('note.trashHint', { days: NOTE_TRASH_DAYS })),
        empty,
        list.length > 0 && h('ul', { class: 'note-grid', 'aria-label': t('note.listLabel') }, list.map((n) => card(n, { view, query: state.query, scope }))),
      ],
    };
  };

  return { newNote };
}
