// Het scherm Notities (SPEC 5k), zoals in Anchor: kaarten met de achtergrond van de notitie en een voorbeeld met opmaak (vinkjes,
// opsommingen, markeringen; afgevinkte punten als "3 gedaan"), in de groepen Vastgepind en Overige, als metselwerk, raster of lijst.
// Bovenaan zoeken, Weergave (indeling en sortering, in je instellingen), Selecteren (meerdere tegelijk) en Nieuwe notitie (ook met
// de toets N). In de zijbalk "Notities", en zolang je daar bent ook het archief, de prullenbak en de labels met hun aantal.
//
// Route: `{ type: 'notes' }` voor alle notities, of met `id`: 'archive', 'trash' of 'label:<label-id>'. Een notitie lezen en
// schrijven doet ui/noteEditor.js, in een venster.

import { NOTE_LAYOUTS, NOTE_SORTS, noteFileKind, notePrefsOf } from '../../shared/notes.js';
import { t } from '../core/i18n.js';
import { colorClass } from '../core/colors.js';
import { markSegments } from '../core/search.js';
import { cachedNoteFileUrl, forgetNoteFileUrls, noteFileUrl, noteFilesOf } from './noteFiles.js';
import { NOTE_TRASH_DAYS, cardDate, expiredNotes, noteCounts, noteGroups, noteLabels, noteList, noteReminderInfo, noteSnippet, trashDaysLeft } from '../core/notes.js';
import { cardRows, fromMarkdown, runsText } from '../core/noteDoc.js';
import { mySettings } from '../core/selectors.js';
import { isTyping } from '../core/shortcuts.js';
import { confirmDialog, h, openDialog, toast } from './dom.js';
import { icon } from './icons.js';
import { openNoteEditor } from './noteEditor.js';
import { bgClass } from './noteLook.js';
import { sidebarHooks, viewHooks } from './render.js';

export const isNotesRoute = (route) => Boolean(route) && route.type === 'notes';

/** `#note=<id>` (een melding van een herinnering, of de Android-app): het id, of null. */
export function noteIdFromHash(hash) {
  const m = /^#note=([A-Za-z0-9_-]{8,40})$/.exec(hash ?? '');
  return m ? m[1] : null;
}

/** De route `{ type: 'notes', id }` als keuze voor de lijst. Een onbekende id is "alle notities". */
export function scopeOfRoute(route) {
  const id = route?.id ?? '';
  if (id === 'archive' || id === 'trash') return { scope: id, labelId: null };
  if (typeof id === 'string' && id.startsWith('label:')) return { scope: 'all', labelId: id.slice(6) };
  return { scope: 'all', labelId: null };
}

const ROW_LIMIT = { list: 2, grid: 4, masonry: 6 };
const MIN_COLUMN = 236; // px: de smalste kolom in het metselwerk
const GAP = 14;

// ---------- het voorbeeld op een kaart ----------

const blocksCache = new WeakMap();
const blocksOf = (note) => {
  let b = blocksCache.get(note);
  if (!b) { b = fromMarkdown(note.content ?? ''); blocksCache.set(note, b); }
  return b;
};

/** Tekst met opmaak voor een kaart: zoals in de editor, maar een link is hier geen link (de hele kaart is aan te klikken). */
function cardRuns(runs) {
  return runs.map((r) => {
    let node = document.createTextNode(r.text);
    const wrap = (tag, cls) => { const el = document.createElement(tag); if (cls) el.className = cls; el.append(node); node = el; };
    if (r.code) wrap('code', 'md-code');
    if (r.s) wrap('s');
    if (r.u) wrap('u');
    if (r.i) wrap('em');
    if (r.b) wrap('strong');
    if (r.hl) wrap('mark', `md-mark hl-${r.hl}`);
    if (r.link) wrap('span', 'nc-link');
    return node;
  });
}

function cardBody(note, maxRows) {
  const { rows, cut } = cardRows(blocksOf(note), maxRows);
  const out = [];
  let list = null;
  let listType = null;
  let number = 0;
  const flushList = () => { if (list) out.push(list); list = null; listType = null; };
  for (const row of rows) {
    if (row.type === 'done') {
      flushList();
      out.push(h('div', { class: 'nc-done' }, icon('completed'), row.all && row.count > 1 ? t('note.allDone', { count: row.count }) : t('note.done', { count: row.count })));
      continue;
    }
    if (row.type === 'check' || row.type === 'bullet' || row.type === 'number') {
      if (listType !== row.type) { flushList(); listType = row.type; number = 0; list = h(row.type === 'number' ? 'ol' : 'ul', { class: `nc-list nc-${row.type}` }); }
      number += 1;
      list.append(h('li', { class: row.checked ? 'done' : null, dataset: { level: String(Math.min(row.level ?? 0, 3)), n: `${number}.` } },
        row.type === 'check' && h('span', { class: 'nc-box', 'aria-hidden': 'true' }),
        row.type === 'check' && h('span', { class: 'sr-only' }, row.checked ? t('note.checkedSr') : t('note.uncheckedSr')),
        h('span', { class: 'nc-tx' }, ...cardRuns(row.runs))));
      continue;
    }
    flushList();
    if (row.type === 'code') out.push(h('pre', { class: `nc-code${row.cutCode ? ' cut' : ''}` }, runsText(row.runs)));
    else if (row.type === 'table') out.push(h('pre', { class: 'nc-code' }, runsText(row.runs).split('\n').slice(0, 3).join('\n')));
    else if (row.type === 'quote') out.push(h('blockquote', { class: 'nc-quote' }, ...cardRuns(row.runs)));
    else if (/^h[1-3]$/.test(row.type)) out.push(h('p', { class: `nc-${row.type}` }, ...cardRuns(row.runs)));
    else out.push(h('p', { class: 'nc-p' }, ...cardRuns(row.runs)));
  }
  flushList();
  return out.length ? h('div', { class: `nc-body${cut ? ' cut' : ''}` }, out) : null;
}

/**
 * @param {{
 *   store: import('../core/store.js').Store, actions: object,
 *   handlers: { navigate: (route: object) => void, refresh: () => void },
 *   getRoute: () => object, cleanUp?: boolean,
 * }} options `cleanUp`: ruim notities op die te lang in de prullenbak liggen (niet in de demo)
 */
export function installNotes({ store, actions, handlers, getRoute, cleanUp = true }) {
  const state = { query: '', picking: false, picked: new Set() };
  let composing = false;
  let cleaned = false;
  let observer = null;
  const prefs = () => notePrefsOf(mySettings(store.view, store.userId));

  // Het zoekveld blijft hetzelfde element bij elke keer tekenen (zie ui/completed.js); app.js zet de focus terug via `data-fk`.
  const search = h('input', { class: 'field note-search', type: 'search', autocomplete: 'off', maxLength: 200, dataset: { fk: 'notes-search' } });
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
    if (!store.ready || !store.me) return;
    const { labelId } = isNotesRoute(getRoute()) ? scopeOfRoute(getRoute()) : { labelId: null };
    const id = await actions.addNote({ labels: labelId && store.view.labels.has(labelId) ? [labelId] : [] });
    await openNoteEditor({ store, actions, noteId: id, created: true });
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

  function setPrefs(change) {
    const next = { ...prefs(), ...change };
    actions.updateSettings({ note_prefs: next });
  }

  function viewOptions() {
    return openDialog((finish) => {
      const p = prefs();
      const segmented = (name, values, labelOf, current, onPick) => h('div', { class: 'note-seg', role: 'radiogroup', 'aria-label': name },
        values.map((v) => h('button', {
          type: 'button', role: 'radio', class: `note-seg-option${v === current ? ' active' : ''}`, 'aria-checked': String(v === current), dataset: { fk: `notes-opt:${v}` },
          onclick: () => { onPick(v); finish(null); },
        }, labelOf(v))));
      const LAYOUT = { masonry: () => t('note.layout.masonry'), grid: () => t('note.layout.grid'), list: () => t('note.layout.list') };
      const SORT = { updated: () => t('note.sort.updated'), created: () => t('note.sort.created'), title: () => t('note.sort.title') };
      const ORDER = p.sort === 'title'
        ? { asc: () => t('note.order.az'), desc: () => t('note.order.za') }
        : { desc: () => t('note.order.newest'), asc: () => t('note.order.oldest') };
      const bottom = h('input', { type: 'checkbox', checked: p.checked_bottom, dataset: { fk: 'notes-opt:checked-bottom' }, onchange: (e) => setPrefs({ checked_bottom: e.target.checked }) });
      return h('div', { class: 'dialog-form note-options' },
        h('h2', {}, t('note.viewTitle')),
        h('p', { class: 'note-options-label' }, t('note.layout')),
        segmented(t('note.layout'), NOTE_LAYOUTS, (v) => LAYOUT[v](), p.layout, (v) => setPrefs({ layout: v })),
        h('p', { class: 'note-options-label' }, t('note.sortBy')),
        segmented(t('note.sortBy'), NOTE_SORTS, (v) => SORT[v](), p.sort, (v) => setPrefs({ sort: v, order: v === 'title' ? 'asc' : 'desc' })),
        segmented(t('note.order'), Object.keys(ORDER), (v) => ORDER[v](), p.order, (v) => setPrefs({ order: v })),
        h('label', { class: 'note-options-check' }, bottom, t('note.checkedBottom')),
        h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
    }, { className: 'dialog-small' });
  }

  // ---------- selecteren ----------
  function togglePicking() {
    state.picking = !state.picking;
    state.picked.clear();
    handlers.refresh();
  }
  function pick(id) {
    if (!state.picked.delete(id)) state.picked.add(id);
    handlers.refresh();
  }
  async function bulk(kind) {
    const ids = [...state.picked].filter((id) => store.view.notes.has(id));
    if (ids.length === 0) return;
    if (kind === 'delete') {
      const ok = await confirmDialog({ title: t('note.deleteForeverTitle'), text: t('note.deleteManyText', { count: ids.length }), okText: t('note.deleteForever') });
      if (!ok) return;
      await actions.deleteNotes(ids);
    } else {
      const now = new Date().toISOString();
      const change = { pin: { is_pinned: true }, unpin: { is_pinned: false }, archive: { is_archived: true, is_pinned: false }, unarchive: { is_archived: false }, trash: { trashed_at: now, is_pinned: false }, restore: { trashed_at: null } }[kind];
      for (const id of ids) await actions.updateNote(id, change);
    }
    toast(t('note.bulkDone', { count: ids.length }));
    state.picking = false;
    state.picked.clear();
    handlers.refresh();
  }

  // ---------- de zijbalk ----------
  sidebarHooks.push(({ extra }) => {
    if (!extra || !store.ready || !store.me) return;
    const route = getRoute();
    const here = isNotesRoute(route);
    const counts = noteCounts(store.view);
    const { scope, labelId } = scopeOfRoute(route);
    const item = (target, iconName, label, count, active, fk, sub = false) => h('button', {
      class: `nav-item${sub ? ' nav-sub-item' : ''}${active ? ' active' : ''}`, type: 'button', 'aria-current': active ? 'page' : null, dataset: { fk },
      onclick: () => handlers.navigate(target),
    }, iconName ? icon(iconName) : h('span', { class: 'nav-hash', 'aria-hidden': 'true' }, '#'), h('span', { class: 'nav-label' }, label), count > 0 && h('span', { class: 'nav-count' }, String(count)));
    const nodes = [item({ type: 'notes' }, 'note', t('note.title'), counts.all, here && scope === 'all' && !labelId, 'nav-notes')];
    if (here) {
      nodes.push(h('div', { class: 'nav-sub', role: 'group', 'aria-label': t('note.title') },
        item({ type: 'notes', id: 'archive' }, 'archive', t('note.scope.archive'), counts.archive, scope === 'archive', 'nav-notes-archive', true),
        item({ type: 'notes', id: 'trash' }, 'trash', t('note.scope.trash'), counts.trash, scope === 'trash', 'nav-notes-trash', true),
        noteLabels(store.view).map(({ label, count }) => item({ type: 'notes', id: `label:${label.id}` }, null, label.name, count, labelId === label.id, `nav-notes-label:${label.id}`, true))));
    }
    extra.before(...nodes);
  });

  // ---------- sneltoets N ----------
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'n') return;
    if (isTyping(e.target) || document.querySelector('dialog[open]') || !store.ready || !store.me) return;
    e.preventDefault();
    newNote();
  });

  // ---------- het metselwerk ----------
  function layoutMasonry(board) {
    const width = board.clientWidth;
    if (!width) return;
    const columns = Math.max(1, Math.floor((width + GAP) / (MIN_COLUMN + GAP)));
    for (const groupCards of board.querySelectorAll('.note-cards.masonry')) {
      if (Number(groupCards.dataset.columns) === columns) continue;
      const cards = [...groupCards.querySelectorAll(':scope > .nc-col > .nc, :scope > .nc')];
      const cols = Array.from({ length: columns }, () => h('div', { class: 'nc-col' }));
      groupCards.replaceChildren(...cols);
      // de kaart gaat naar de kolom die het minst hoog is: dat leest van links naar rechts en houdt de kolommen gelijk
      for (const card of cards) {
        let best = cols[0];
        for (const c of cols) if (c.offsetHeight < best.offsetHeight) best = c;
        best.append(card);
      }
      groupCards.dataset.columns = String(columns);
    }
  }

  // ---------- foto's op de kaarten: pas ophalen als de kaart (bijna) in beeld komt ----------
  const picObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        picObserver.unobserve(entry.target);
        const img = entry.target;
        const file = store.view.note_files?.get(img.dataset.file);
        if (file) noteFileUrl(file).then((url) => { if (url) { img.src = url; img.classList.add('is-loaded'); } });
      }
    }, { rootMargin: '300px' })
    : null;
  const picture = (file) => {
    const url = cachedNoteFileUrl(file.id);
    const img = h('img', { class: `nc-pic-img${url ? ' is-loaded' : ''}`, alt: '', src: url ?? null, dataset: { file: file.id }, draggable: 'false' });
    if (!url) {
      if (picObserver) picObserver.observe(img);
      else noteFileUrl(file).then((u) => { if (u) { img.src = u; img.classList.add('is-loaded'); } });
    }
    return img;
  };

  // ---------- het scherm ----------
  function card(note, ctx) {
    const { view, query, scope, layout } = ctx;
    const labels = (note.labels ?? []).map((id) => view.labels.get(id)).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const title = (note.title ?? '').trim();
    const picked = state.picked.has(note.id);
    const searching = Boolean(query.trim());
    const snippet = searching ? noteSnippet(note, query) : null;
    const body = searching
      ? (snippet.text ? h('p', { class: 'nc-p nc-snippet' }, markSegments(snippet.text, snippet.marks).map((p) => (p.mark ? h('mark', { class: 'nc-hit' }, p.text) : p.text))) : null)
      : cardBody(note, ROW_LIMIT[layout]);
    const label = title || t('note.untitled');
    const reminder = noteReminderInfo(note);
    // zoals Anchor: bij metselwerk tot vier foto's bovenaan, bij raster één, in een lijst een miniatuur rechts; "+N" voor de rest
    const files = noteFilesOf(view, note.id);
    const images = files.filter((f) => noteFileKind(f.mime) === 'image');
    const shown = layout === 'list' ? [] : images.slice(0, layout === 'grid' ? 1 : 4);
    const hiddenCount = files.length - shown.length;
    const pics = shown.length > 0 && h('div', { class: `nc-pics n${shown.length}`, 'aria-hidden': 'true' },
      shown.map((f, i) => h('div', { class: 'nc-ph' }, picture(f), i === shown.length - 1 && hiddenCount > 0 && h('span', { class: 'nc-more-pics' }, `+${hiddenCount}`))));
    const thumb = layout === 'list' && images.length > 0 && h('div', { class: 'nc-thumb', 'aria-hidden': 'true' },
      picture(images[0]), files.length > 1 && h('span', { class: 'nc-more-pics' }, `+${files.length - 1}`));
    return h('article', { class: `nc ${bgClass(note.background)}${note.is_pinned ? ' nc-pinned' : ''}${picked ? ' picked' : ''}${thumb ? ' nc-with-thumb' : ''}`, dataset: { id: note.id } },
      h('button', {
        class: 'nc-open', type: 'button', dataset: { fk: `note:${note.id}` }, 'aria-label': `${label}${note.is_pinned ? `, ${t('note.pinnedMark')}` : ''}`,
        'aria-pressed': state.picking ? String(picked) : null,
        onclick: (e) => {
          // in de selecteerstand (of met Ctrl/Cmd) kiest een klik de kaart; anders opent hij de notitie
          if (!state.picking && !e.ctrlKey && !e.metaKey) { open(note); return; }
          state.picking = true;
          pick(note.id);
        },
      }),
      state.picking && h('span', { class: 'nc-pick', 'aria-hidden': 'true' }, icon('check')),
      pics,
      h('div', { class: 'nc-in' },
        (title || note.is_pinned) && h('div', { class: 'nc-head' }, title && h('span', { class: 'nc-title' }, title), note.is_pinned && h('span', { class: 'nc-pin', role: 'img', 'aria-label': t('note.pinnedMark') }, icon('pin'))),
        body ?? (!title && h('p', { class: 'nc-p nc-empty' }, t('note.emptyNote'))),
        labels.length > 0 && h('div', { class: 'nc-tags' }, labels.slice(0, 3).map((l) => h('span', { class: 'nc-tag' }, h('span', { class: `note-tag-hash ${colorClass(l.color)}`, 'aria-hidden': 'true' }, '#'), l.name)),
          labels.length > 3 && h('span', { class: 'nc-tag nc-more' }, `+${labels.length - 3}`)),
        h('div', { class: 'nc-foot' },
          reminder && scope !== 'trash' && h('span', { class: `nc-reminder${reminder.past ? ' is-late' : ''}`, title: t('note.reminderAt', { when: reminder.text }) }, icon(reminder.repeat ? 'repeat' : 'bell'), reminder.text),
          note.is_archived && scope === 'all' && h('span', { class: 'nc-flag' }, icon('archive'), t('note.archivedFlag')),
          files.length > 0 && shown.length === 0 && !thumb && h('span', { class: 'nc-files', title: t('note.files.count', { count: files.length }) }, icon('paperclip'), String(files.length)),
          h('span', { class: 'nc-date' }, scope === 'trash' ? t('note.daysLeft', { count: trashDaysLeft(note) }) : cardDate(note.updated_at)))),
      thumb,
      scope === 'trash' && !state.picking && h('button', {
        class: 'button button-small nc-restore', type: 'button', dataset: { fk: `note-restore:${note.id}` },
        onclick: async () => { await actions.restoreNote(note.id); toast(t('note.restored')); },
      }, icon('undo'), t('note.restore')));
  }

  viewHooks.notes = (ctx) => {
    const { view, route, emptyState } = ctx;
    forgetNoteFileUrls(view); // URL's van verwijderde foto's en geluid opruimen
    const { scope, labelId } = scopeOfRoute(route);
    const label = labelId ? view.labels.get(labelId) : null;
    const p = prefs();
    const list = noteList(view, { scope, labelId: label ? labelId : null, query: state.query, sort: p.sort, order: p.order });
    for (const id of [...state.picked]) if (!view.notes.has(id)) state.picked.delete(id);
    search.placeholder = scope === 'archive' ? t('note.searchArchive') : scope === 'trash' ? t('note.searchTrash') : t('note.searchPlaceholder');
    search.setAttribute('aria-label', search.placeholder);
    if (search.value !== state.query) search.value = state.query;

    const cardCtx = { view, query: state.query, scope, layout: p.layout };
    const { pinned, others } = noteGroups(list, scope);
    const groupNode = (key, heading, notes) => notes.length > 0 && h('section', { class: 'note-group', dataset: { group: key } },
      heading && h('h2', { class: 'note-group-title' }, key === 'pinned' && icon('pin'), heading, h('span', { class: 'note-group-count' }, String(notes.length))),
      h('div', { class: `note-cards ${p.layout}` }, notes.map((n) => card(n, cardCtx))));
    const searching = Boolean(state.query.trim());
    const empty = list.length === 0 && (searching
      ? emptyState({ title: t('note.noResultsFor', { query: state.query.trim() }), text: t('note.noResults'), action: h('button', { class: 'button', type: 'button', onclick: () => { state.query = ''; search.value = ''; handlers.refresh(); search.focus(); } }, t('note.clearSearch')) })
      : scope === 'trash' ? emptyState({ title: t('note.trashEmptyTitle'), text: t('note.trashEmpty', { days: NOTE_TRASH_DAYS }) })
        : scope === 'archive' ? emptyState({ title: t('note.archiveEmptyTitle'), text: t('note.archiveEmpty') })
          : emptyState({ title: t('note.emptyTitle'), text: t('note.empty'), action: h('button', { class: 'button button-primary', type: 'button', onclick: newNote }, t('note.new')) }));

    const board = h('div', { class: `note-board layout-${p.layout}`, 'aria-label': t('note.listLabel') },
      ...(scope === 'all' && pinned.length > 0
        ? [groupNode('pinned', t('note.pinned'), pinned), groupNode('others', t('note.others'), others)]
        : [groupNode('all', null, list)]));
    if (p.layout === 'masonry') {
      observer?.disconnect();
      observer = new ResizeObserver(() => layoutMasonry(board));
      observer.observe(board);
    }

    const bulkBar = state.picking && h('div', { class: 'note-bulk', role: 'toolbar', 'aria-label': t('note.selectTitle') },
      h('span', { class: 'note-bulk-count' }, t('note.selected', { count: state.picked.size })),
      h('div', { class: 'note-bulk-actions' },
        ...(scope === 'trash'
          ? [['restore', 'undo', t('note.restore')], ['delete', 'trash', t('note.deleteForever')]]
          : scope === 'archive'
            ? [['unarchive', 'archive', t('note.unarchive')], ['trash', 'trash', t('note.trash')]]
            : [['pin', 'pin', t('note.pin')], ['unpin', 'pin', t('note.unpin')], ['archive', 'archive', t('note.archive')], ['trash', 'trash', t('note.trash')]]
        ).map(([kind, iconName, text]) => h('button', {
          type: 'button', class: `button button-small${kind === 'delete' ? ' button-danger' : ''}`, disabled: state.picked.size === 0, dataset: { fk: `notes-bulk:${kind}` },
          onclick: () => bulk(kind),
        }, icon(iconName), h('span', { class: 'btn-label' }, text))),
        h('button', { type: 'button', class: 'button button-small button-ghost', dataset: { fk: 'notes-bulk:all' }, onclick: () => { for (const n of list) state.picked.add(n.id); handlers.refresh(); } }, t('note.selectAll')),
        h('button', { type: 'button', class: 'button button-small button-ghost', dataset: { fk: 'notes-bulk:cancel' }, onclick: togglePicking }, t('common.cancel'))));

    return {
      title: label ? label.name : scope === 'archive' ? t('note.scope.archive') : scope === 'trash' ? t('note.scope.trash') : t('note.title'),
      count: null,
      lead: label ? h('span', { class: `nav-hash ${colorClass(label.color)}`, 'aria-hidden': 'true' }, '#') : icon(scope === 'archive' ? 'archive' : scope === 'trash' ? 'trash' : 'note'),
      actions: [
        h('button', { class: 'button button-small button-ghost', type: 'button', dataset: { fk: 'notes-view' }, 'aria-haspopup': 'dialog', onclick: viewOptions }, icon('sliders'), h('span', { class: 'btn-label' }, t('note.view'))),
        list.length > 0 && h('button', { class: `button button-small button-ghost${state.picking ? ' active' : ''}`, type: 'button', 'aria-pressed': String(state.picking), dataset: { fk: 'notes-select' }, onclick: togglePicking }, icon('selectAll'), h('span', { class: 'btn-label' }, t('note.select'))),
        scope === 'trash'
          ? (noteCounts(view).trash > 0 && h('button', { class: 'button button-small button-ghost', type: 'button', dataset: { fk: 'notes-empty-trash' }, onclick: emptyTrash }, icon('trash'), h('span', { class: 'btn-label' }, t('note.emptyTrash'))))
          : h('button', { class: 'button button-small button-primary', type: 'button', dataset: { fk: 'notes-new' }, 'aria-keyshortcuts': 'n', title: `${t('note.new')} (N)`, onclick: newNote }, icon('plus'), h('span', { class: 'btn-label' }, t('note.new'))),
      ],
      nodes: [
        h('div', { class: 'note-tools' }, search),
        scope === 'trash' && list.length > 0 && h('p', { class: 'hint' }, t('note.trashHint', { days: NOTE_TRASH_DAYS })),
        empty || board,
        bulkBar,
      ],
    };
  };

  // Een notitie openen vanuit een melding: zodra de gegevens er zijn (de eerste sync kan nog lopen), hooguit 30 seconden wachten.
  let pendingNote = null;
  const tryPending = () => {
    if (!pendingNote) return;
    if (Date.now() - pendingNote.since > 30_000) { pendingNote = null; return; }
    if (!store.ready || !store.view.notes.has(pendingNote.id) || document.querySelector('dialog[open]')) return;
    const id = pendingNote.id;
    pendingNote = null;
    handlers.navigate({ type: 'notes' });
    openNoteEditor({ store, actions, noteId: id });
  };
  store.subscribe(tryPending);
  function openNote(id) {
    pendingNote = { id, since: Date.now() };
    tryPending();
  }

  return { newNote, openNote };
}
