// Het venster "Versiegeschiedenis" van een notitie (SPEC 5k), zoals in Anchor: links de versies per dag (bovenaan de huidige),
// rechts de gekozen versie met opmaak, of wat er daarna veranderd is (regel voor regel), en "Deze versie terugzetten" met
// ongedaan maken. De versies komen van de server (server/noteHistory.ts) en zijn alleen met verbinding te zien.

import { t } from '../core/i18n.js';
import { groupRevisionsByDay, historyTime, lineDiff, revisionCauseLabel, revisionTime } from '../core/noteHistory.js';
import { renderMarkdown } from './markdown.js';
import { h, openDialog, toast } from './dom.js';
import { icon } from './icons.js';

const CURRENT = 'current';

/**
 * @param {{ store: import('../core/store.js').Store, actions: object, api: object, noteId: string, onRestored?: () => void, canRestore?: boolean }} options
 *   `canRestore`: false voor wie de notitie alleen leest (een lezer ziet de versies wel)
 * @returns {Promise<void>}
 */
export function openNoteHistory({ store, actions, api, noteId, onRestored = () => {}, canRestore: mayRestore = true }) {
  const note = () => store.view.notes.get(noteId);
  if (!note()) return Promise.resolve();
  return openDialog((finish) => {
    let revisions = [];
    let selected = CURRENT;
    let mode = 'text'; // of 'changes'
    const contents = new Map(); // versie-id -> { title, content }
    const list = h('div', { class: 'nh-list', role: 'listbox', 'aria-label': t('note.history.versions') });
    const preview = h('div', { class: 'nh-preview' });
    const status = h('p', { class: 'hint nh-status', role: 'status', 'aria-live': 'polite' });

    const canRestore = () => mayRestore && !note()?.trashed_at && selected !== CURRENT;
    /** De versie die na `id` kwam (nieuwer), of de huidige. */
    const newerThan = (id) => {
      const i = revisions.findIndex((r) => r.id === id);
      return i > 0 ? revisions[i - 1] : null;
    };
    const textOf = async (id) => {
      if (id === CURRENT) return { title: note()?.title ?? '', content: note()?.content ?? '' };
      if (!contents.has(id)) {
        const r = await api.noteRevision(noteId, id);
        contents.set(id, { title: r.title ?? '', content: r.content ?? '' });
      }
      return contents.get(id);
    };

    function drawList() {
      const entry = (id, time, label, extra = '') => h('button', {
        type: 'button', role: 'option', class: `nh-entry${selected === id ? ' is-on' : ''}${extra}`, 'aria-selected': String(selected === id),
        dataset: { fk: `nh:${id}` }, onclick: () => choose(id),
      }, h('span', { class: 'nh-time' }, time), h('span', { class: 'nh-label' }, label));
      const days = groupRevisionsByDay(revisions);
      list.replaceChildren(...[ // replaceChildren zet false als tekst neer: alleen echte knooppunten
        entry(CURRENT, t('note.history.now'), t('note.history.current'), ' nh-current'),
        ...days.flatMap((d) => [
          h('p', { class: 'nh-day' }, d.label),
          ...d.entries.map((r) => entry(r.id, historyTime(revisionTime(r)), revisionCauseLabel(r.cause))),
        ]),
        revisions.length === 0 && !status.textContent && h('p', { class: 'hint nh-empty' }, t('note.history.empty')),
      ].filter(Boolean));
    }

    let drawing = 0;
    async function drawPreview() {
      const ticket = ++drawing;
      preview.replaceChildren(h('p', { class: 'hint' }, t('note.history.loading')));
      try {
        const mine = await textOf(selected);
        const newer = selected === CURRENT ? null : newerThan(selected);
        const next = selected === CURRENT ? null : await textOf(newer ? newer.id : CURRENT);
        if (ticket !== drawing) return;
        const diff = next ? lineDiff(mine.content, next.content) : null;
        const titleChanged = next && mine.title !== next.title;
        const when = newer ? historyTime(revisionTime(newer)) : t('note.history.currentLower');
        const summary = diff && (diff.tooLarge
          ? h('p', { class: 'nh-summary' }, t('note.history.tooLarge'))
          : diff.added + diff.removed + diff.changed === 0 && !titleChanged
            ? h('p', { class: 'nh-summary' }, t('note.history.same'))
            : h('p', { class: 'nh-summary' },
              h('span', { class: 'nh-add' }, t('note.history.added', { count: diff.added })), ' · ',
              h('span', { class: 'nh-del' }, t('note.history.removed', { count: diff.removed })), ' · ',
              h('span', { class: 'nh-chg' }, t('note.history.changed', { count: diff.changed + (titleChanged ? 1 : 0) })), ' ',
              h('span', { class: 'nh-when' }, t('note.history.comparedTo', { when }))));
        const tabs = next && h('div', { class: 'note-seg nh-tabs', role: 'radiogroup', 'aria-label': t('note.history.show') },
          ...[['text', t('note.history.text')], ['changes', t('note.history.changes')]].map(([value, label]) => h('button', {
            type: 'button', role: 'radio', class: `note-seg-option${mode === value ? ' active' : ''}`, 'aria-checked': String(mode === value), dataset: { fk: `nh-mode:${value}` },
            onclick: () => { mode = value; drawPreview(); },
          }, label)));
        const body = mode === 'changes' && diff && !diff.tooLarge
          ? h('div', { class: 'nh-diff', 'aria-label': t('note.history.changes') },
            titleChanged && h('p', { class: 'nh-line nh-line-title' }, t('note.history.titleChange', { from: mine.title || t('note.untitled'), to: next.title || t('note.untitled') })),
            ...diff.lines.map((l) => h('p', { class: `nh-line nh-line-${l.kind}` }, h('span', { class: 'nh-mark', 'aria-hidden': 'true' }, { same: ' ', add: '+', del: '−' }[l.kind]),
              l.kind !== 'same' && h('span', { class: 'sr-only' }, l.kind === 'add' ? t('note.history.lineAdded') : t('note.history.lineRemoved')), l.text || ' ')))
          : h('div', { class: 'nh-text md' }, mine.title && h('h2', { class: 'nh-title' }, mine.title), renderMarkdown(mine.content ?? ''));
        preview.replaceChildren(...[
          summary, tabs, body,
          h('div', { class: 'dialog-buttons nh-buttons' },
            canRestore() && h('button', { type: 'button', class: 'button button-primary', dataset: { fk: 'nh-restore' }, onclick: () => restore(mine) }, icon('undo'), t('note.history.restore'))),
        ].filter(Boolean));
      } catch {
        if (ticket !== drawing) return;
        preview.replaceChildren(h('p', { class: 'hint' }, t('note.history.loadFailed')));
      }
    }

    function choose(id) {
      selected = id;
      if (id === CURRENT) mode = 'text';
      drawList();
      drawPreview();
      list.querySelector(`[data-fk="nh:${CSS.escape(id)}"]`)?.focus();
    }

    async function restore(text) {
      const revision = revisions.find((r) => r.id === selected);
      if (!revision) return;
      await actions.restoreNoteRevision(noteId, { id: revision.id, title: text.title, content: text.content });
      onRestored();
      finish(null);
      toast(t('note.history.restored'), {
        action: {
          label: t('note.undo'),
          // ongedaan maken: de server bewaarde vlak ervoor de vorige stand ("Vóór terugzetten"); die weer terugzetten
          run: async () => {
            try {
              const page = await api.noteRevisions(noteId);
              const before = page.revisions.find((r) => r.cause === 'restore');
              if (!before) return;
              const full = await api.noteRevision(noteId, before.id);
              await actions.restoreNoteRevision(noteId, { id: before.id, title: full.title ?? '', content: full.content ?? '' });
              onRestored();
            } catch {
              toast(t('note.history.undoFailed'), { kind: 'error' });
            }
          },
        },
      });
    }

    // keyboard: pijltjes door de lijst
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const ids = [CURRENT, ...revisions.map((r) => r.id)];
      const i = ids.indexOf(selected) + (e.key === 'ArrowDown' ? 1 : -1);
      if (i < 0 || i >= ids.length) return;
      e.preventDefault();
      choose(ids[i]);
    });

    (async () => {
      status.textContent = t('note.history.loading');
      try {
        revisions = (await api.noteRevisions(noteId)).revisions ?? [];
        status.textContent = '';
      } catch {
        status.textContent = t('note.history.loadFailed');
      }
      drawList();
      drawPreview();
    })();
    drawList();
    drawPreview();

    return h('div', { class: 'dialog-form nh' },
      h('div', { class: 'nh-head' },
        h('h2', {}, t('note.history')),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': t('common.close'), title: t('common.close'), dataset: { fk: 'nh-close' }, onclick: () => finish(null) }, icon('close'))),
      status,
      h('div', { class: 'nh-body' }, list, preview));
  }, { wide: true, className: 'dialog-history' });
}
