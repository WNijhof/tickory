// Het venster "Notities importeren" (SPEC 5k): bestanden kiezen of neerzetten, zien wat er gevonden is (en wat niet, met de reden),
// en dan in één keer importeren. Het lezen doet core/noteImport.js; foto's en geluid gaan daarna via de gewone upload
// (core/attachments.js, stageNote), net als wanneer je ze zelf toevoegt.

import { MAX_NOTES_PER_USER } from '../../shared/notes.js';
import { t } from '../core/i18n.js';
import { readNoteImport } from '../core/noteImport.js';
import { attachmentRuntime } from './attachments.js';
import { h, openDialog, toast } from './dom.js';
import { icon } from './icons.js';

export const NOTE_IMPORT_ACCEPT = '.zip,.json,.md,.markdown,.txt';

// letterlijke sleutels, zodat de controle op ontbrekende en ongebruikte teksten ze vindt
const REASON = {
  trashed: () => t('note.import.reason.trashed'), notKeep: () => t('note.import.reason.notKeep'), notNotes: () => t('note.import.reason.notNotes'),
  empty: () => t('note.import.reason.empty'), tooBig: () => t('note.import.reason.tooBig'), tooMany: () => t('note.import.reason.tooMany'),
  unreadable: () => t('note.import.reason.unreadable'), noNotes: () => t('note.import.reason.noNotes'), zip: () => t('note.import.reason.zip'),
};
const WARNING = {
  tooLong: () => t('note.import.warn.tooLong'), fileType: () => t('note.import.warn.fileType'),
  fileMissing: () => t('note.import.warn.fileMissing'), tooManyFiles: () => t('note.import.warn.tooManyFiles'),
};
const reasonText = (r) => (r === 'zip.noNotes' ? REASON.noNotes() : r.startsWith('zip.') ? REASON.zip() : (REASON[r] ?? REASON.unreadable)());

/** Leest File-objecten als { name, bytes }. */
const readFiles = (files) => Promise.all([...files].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));

/**
 * @param {{ store: import('../core/store.js').Store, actions: object, files?: File[] | null }} options
 * @returns {Promise<{ count: number } | null>}
 */
export function openNoteImport({ store, actions, files = null }) {
  return openDialog((finish) => {
    let found = null; // de uitkomst van readNoteImport
    let withArchived = true;
    const body = h('div', { class: 'ni-body', 'aria-live': 'polite' });
    const input = h('input', { type: 'file', multiple: true, accept: NOTE_IMPORT_ACCEPT, hidden: true, 'aria-hidden': 'true', tabIndex: -1, dataset: { fk: 'note-import-input' } });
    const goButton = h('button', { type: 'button', class: 'button button-primary', disabled: true, dataset: { fk: 'note-import-go' }, onclick: () => go() });

    async function take(list) {
      if (!list || list.length === 0) return;
      body.replaceChildren(h('p', { class: 'hint' }, t('note.import.reading')));
      goButton.disabled = true;
      try {
        found = await readNoteImport(await readFiles(list));
      } catch {
        found = { notes: [], skipped: [...list].map((f) => ({ name: f.name, reason: 'unreadable' })), warnings: [] };
      }
      draw();
    }
    input.addEventListener('change', () => { take(input.files); input.value = ''; });

    const chosen = () => (found?.notes ?? []).filter((n) => withArchived || !n.is_archived);
    const room = () => Math.max(0, MAX_NOTES_PER_USER - store.view.notes.size);

    function draw() {
      const notes = found.notes;
      const archived = notes.filter((n) => n.is_archived).length;
      const media = notes.filter((n) => n.files.length > 0).length;
      const count = Math.min(chosen().length, room());
      const warnings = new Map();
      for (const w of found.warnings) warnings.set(w.reason, (warnings.get(w.reason) ?? 0) + 1);
      body.replaceChildren(...[
        notes.length === 0
          ? h('p', { class: 'ni-none' }, t('note.import.nothing'))
          : h('p', { class: 'ni-found' }, icon('note'), t('note.import.found', { count: notes.length }), media > 0 && h('span', { class: 'ni-media' }, ` · ${t('note.import.withFiles', { count: media })}`)),
        notes.length > 0 && h('ul', { class: 'ni-list' },
          notes.slice(0, 8).map((n) => h('li', {}, n.title || t('note.untitled'), n.is_archived && h('span', { class: 'ni-flag' }, ` · ${t('note.archivedFlag')}`))),
          notes.length > 8 && h('li', { class: 'ni-more' }, t('note.import.more', { count: notes.length - 8 }))),
        archived > 0 && h('label', { class: 'ni-option' },
          h('input', { type: 'checkbox', checked: withArchived, dataset: { fk: 'note-import-archived' }, onchange: (e) => { withArchived = e.target.checked; draw(); } }),
          t('note.import.archived', { count: archived })),
        chosen().length > room() && h('p', { class: 'hint ni-warn' }, t('note.import.tooMany', { count: room() })),
        warnings.size > 0 && h('div', { class: 'ni-skipped' }, h('p', {}, t('note.import.warnings')),
          h('ul', {}, [...warnings].map(([reason, n]) => h('li', {}, `${(WARNING[reason] ?? WARNING.fileType)()} (${n})`)))),
        found.skipped.length > 0 && h('div', { class: 'ni-skipped' }, h('p', {}, t('note.import.skipped')),
          h('ul', {}, found.skipped.slice(0, 12).map((s) => h('li', {}, `${s.name.split('/').pop()}: ${reasonText(s.reason)}`)),
            found.skipped.length > 12 && h('li', { class: 'ni-more' }, t('note.import.more', { count: found.skipped.length - 12 })))),
        h('button', { type: 'button', class: 'button button-small', onclick: () => input.click() }, t('note.import.other')),
      ].filter(Boolean));
      goButton.textContent = t('note.import.go', { count });
      goButton.disabled = count === 0;
    }

    async function go() {
      const list = chosen().slice(0, room());
      if (!list.length) return;
      goButton.disabled = true;
      body.replaceChildren(h('p', { class: 'hint' }, t('note.import.busy')));
      const ids = await actions.importNotes(list);
      // foto's en geluid: via de gewone upload, zodra de notitie op de server staat
      const manager = attachmentRuntime()?.manager;
      let media = 0;
      if (manager) {
        for (let i = 0; i < list.length; i++) {
          if (!list[i].files.length) continue;
          const { added } = await manager.stageNote(ids[i], list[i].files.map((f) => new File([f.bytes], f.name, { type: f.mime })));
          media += added.length;
        }
      }
      toast([t('note.import.done', { count: list.length }), media > 0 ? t('note.import.uploading') : ''].filter(Boolean).join(' '));
      finish({ count: list.length });
    }

    const drop = h('div', { class: 'ni-drop', dataset: { fk: 'note-import-drop' } },
      h('p', {}, t('note.import.intro')),
      h('button', { type: 'button', class: 'button', dataset: { fk: 'note-import-choose' }, onclick: () => input.click() }, icon('plus'), t('note.import.choose')));
    body.append(drop);
    const box = h('div', { class: 'dialog-form ni' },
      h('h2', {}, t('note.import')),
      body, input,
      h('div', { class: 'dialog-buttons' },
        h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
        goButton));
    goButton.textContent = t('note.import.go', { count: 0 });
    box.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); box.classList.add('ni-dragging'); } });
    box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('ni-dragging'); });
    box.addEventListener('drop', (e) => {
      box.classList.remove('ni-dragging');
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      take(e.dataTransfer.files);
    });
    if (files?.length) queueMicrotask(() => take(files));
    return box;
  }, { className: 'dialog-note-import' });
}
