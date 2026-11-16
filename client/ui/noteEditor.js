// Het venster om een notitie te lezen en te schrijven (SPEC 5k): titel, tekst in Markdown met een werkbalk, lezen of bewerken, kleur,
// labels, vastpinnen, archief en prullenbak. Alles wat je typt wordt vanzelf bewaard (kort na het laatste typen, en bij sluiten);
// offline gaat het naar de wachtrij zoals elke wijziging. Het is een venster en geen pagina: de lijst erachter wordt bij elke wijziging
// opnieuw getekend en zou het invoerveld tijdens het typen kwijtraken.
//
// De tekst blijft Markdown (core/markdown.js); in de leesstand zijn de vinkjes van `- [ ]` aan te klikken en worden ze direct bewaard.

import { COLOR_NAMES, colorClass, colorName } from '../core/colors.js';
import { t } from '../core/i18n.js';
import { NOTE_LIMITS } from '../../shared/schema.js';
import { toggleTask } from '../core/markdown.js';
import { noteTitle, trashDaysLeft } from '../core/notes.js';
import { labelList } from '../core/selectors.js';
import { h, openDialog, toast } from './dom.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { colorLabel } from './projectDialog.js';
import { saveTextFile } from './exportDialog.js';

const SAVE_DELAY_MS = 700;

/** Een regel (of de geselecteerde regels) voorzien van `prefix`, of die er weer afhalen als alle regels hem al hebben. */
export function toggleLinePrefix(value, start, end, prefix, { ordered = false } = {}) {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const toRaw = value.indexOf('\n', end);
  const to = toRaw === -1 ? value.length : toRaw;
  const lines = value.slice(from, to).split('\n');
  const marker = ordered ? /^\d{1,9}[.)] / : null;
  const has = (l) => (ordered ? marker.test(l) : l.startsWith(prefix));
  const all = lines.every((l) => !l.trim() || has(l));
  const out = lines.map((l, i) => {
    if (!l.trim()) return l;
    if (all) return ordered ? l.replace(marker, '') : l.slice(prefix.length);
    if (has(l)) return l;
    return ordered ? `${i + 1}. ${l}` : `${prefix}${l}`;
  });
  const text = out.join('\n');
  return { value: value.slice(0, from) + text + value.slice(to), start: from, end: from + text.length };
}

/** Wat er bij Enter in een lijst volgt: het volgende punt (genummerd, taak of streepje), of de lijst eindigt bij een leeg punt. */
export function continueList(value, caret) {
  const from = value.lastIndexOf('\n', caret - 1) + 1;
  const line = value.slice(from, caret);
  const m = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)])) (\[[ xX]\] )?(.*)$/.exec(line);
  if (!m) return null;
  if (m[6] === '') {
    // een leeg punt: het punt weghalen en de lijst afsluiten
    return { value: value.slice(0, from) + value.slice(caret), caret: from };
  }
  const marker = m[3] !== undefined ? `${Number.parseInt(m[3], 10) + 1}${m[4]}` : m[2];
  const insert = `\n${m[1]}${marker} ${m[5] ? '[ ] ' : ''}`;
  return { value: value.slice(0, caret) + insert + value.slice(caret), caret: caret + insert.length };
}

/**
 * @param {{ store: import('../core/store.js').Store, actions: object, noteId: string, edit?: boolean, created?: boolean }} options
 *   `created`: de notitie is zojuist gemaakt; blijft ze leeg, dan wordt ze bij sluiten weer verwijderd
 * @returns {Promise<void>} klaar zodra het venster gesloten is
 */
export function openNoteEditor({ store, actions, noteId, edit = false, created = false }) {
  const note = () => store.view.notes.get(noteId);
  if (!note()) return Promise.resolve();
  let mode = edit || (!note().content && !note().title) ? 'edit' : 'read';
  let timer = null;
  let closing = false;
  let labelsOpen = false;

  return openDialog((finish, dialog) => {
    const initial = note();
    const titleInput = h('input', {
      class: 'field note-title-input', type: 'text', value: initial.title ?? '', maxLength: NOTE_LIMITS.title, placeholder: t('note.titlePlaceholder'),
      'aria-label': t('note.titleLabel'), autocomplete: 'off', dataset: { fk: 'note-title' },
    });
    const area = h('textarea', {
      class: 'field note-text', value: initial.content ?? '', maxLength: NOTE_LIMITS.content, placeholder: t('note.contentPlaceholder'),
      'aria-label': t('note.contentLabel'), spellcheck: true, dataset: { fk: 'note-text' },
    });
    const preview = h('div', { class: 'note-read', tabIndex: -1, dataset: { fk: 'note-read' } });
    const status = h('span', { class: 'note-status', role: 'status', 'aria-live': 'polite' });
    const bar = h('div', { class: 'note-toolbar', role: 'toolbar', 'aria-label': t('note.toolbar') });
    const side = h('div', { class: 'note-side' });
    const labelPanel = h('div', { class: 'note-labels-panel', hidden: true });

    // ---------- opslaan ----------
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const now = note();
      if (!now) return;
      const changes = {};
      if (titleInput.value !== (now.title ?? '')) changes.title = titleInput.value;
      if (area.value !== (now.content ?? '')) changes.content = area.value;
      if (Object.keys(changes).length === 0) return;
      actions.updateNote(noteId, changes);
      status.textContent = t('note.saved');
    };
    const later = () => {
      status.textContent = t('note.saving');
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DELAY_MS);
    };
    titleInput.addEventListener('input', later);
    area.addEventListener('input', later);

    // ---------- werkbalk ----------
    const edited = (value, start, end) => {
      area.value = value;
      area.setSelectionRange(start, end);
      area.focus();
      later();
    };
    const wrap = (before, after = before, sample = '') => () => {
      const { selectionStart: s, selectionEnd: e, value } = area;
      if (s >= before.length && value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after) {
        edited(value.slice(0, s - before.length) + value.slice(s, e) + value.slice(e + after.length), s - before.length, e - before.length);
        return;
      }
      const chosen = value.slice(s, e) || sample;
      const text = `${before}${chosen}${after}`;
      edited(value.slice(0, s) + text + value.slice(e), s + before.length, s + before.length + chosen.length);
    };
    const prefix = (p, opts) => () => {
      const r = toggleLinePrefix(area.value, area.selectionStart, area.selectionEnd, p, opts);
      edited(r.value, r.start, r.end);
    };
    const insertAt = (text, selectFrom = 0, selectTo = 0) => () => {
      const { selectionEnd: s, value } = area; // na de selectie, zonder iets te vervangen
      const lead = s > 0 && value[s - 1] !== '\n' ? '\n' : '';
      edited(value.slice(0, s) + lead + text + value.slice(s), s + lead.length + selectFrom, s + lead.length + (selectTo || text.length));
    };
    const link = () => {
      const { selectionStart: s, selectionEnd: e, value } = area;
      const label = value.slice(s, e) || t('note.linkSample');
      const text = `[${label}](https://)`;
      edited(value.slice(0, s) + text + value.slice(e), s + label.length + 3, s + text.length - 1);
    };
    const TOOLS = [
      { fk: 'bold', glyph: 'B', cls: 'tb-bold', label: () => t('note.tb.bold'), run: wrap('**', '**', t('note.sampleBold')), key: 'b' },
      { fk: 'italic', glyph: 'I', cls: 'tb-italic', label: () => t('note.tb.italic'), run: wrap('*', '*', t('note.sampleItalic')), key: 'i' },
      { fk: 'strike', glyph: 'S', cls: 'tb-strike', label: () => t('note.tb.strike'), run: wrap('~~', '~~', t('note.sampleStrike')) },
      { fk: 'heading', glyph: 'H', cls: 'tb-heading', label: () => t('note.tb.heading'), run: prefix('## ') },
      { fk: 'bullets', glyph: '•', label: () => t('note.tb.bullets'), run: prefix('- ') },
      { fk: 'numbers', glyph: '1.', label: () => t('note.tb.numbers'), run: prefix('1. ', { ordered: true }) },
      { fk: 'tasks', glyph: '☐', label: () => t('note.tb.tasks'), run: prefix('- [ ] ') },
      { fk: 'quote', glyph: '❝', label: () => t('note.tb.quote'), run: prefix('> ') },
      { fk: 'code', glyph: '</>', cls: 'tb-code', label: () => t('note.tb.code'), run: wrap('`', '`', t('note.sampleCode')) },
      { fk: 'link', glyph: '🔗', label: () => t('note.tb.link'), run: link, key: 'k' },
      { fk: 'table', glyph: '▦', label: () => t('note.tb.table'), run: insertAt(`| ${t('note.table.a')} | ${t('note.table.b')} |\n|---|---|\n|  |  |\n`, 2, 2 + t('note.table.a').length) },
    ];
    for (const tool of TOOLS) {
      bar.append(h('button', {
        class: `note-tool ${tool.cls ?? ''}`, type: 'button', title: tool.label() + (tool.key ? ` (Ctrl+${tool.key.toUpperCase()})` : ''), 'aria-label': tool.label(),
        dataset: { fk: `note-tool:${tool.fk}` }, onclick: tool.run,
      }, tool.glyph));
    }
    area.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const tool = mod && !e.altKey ? TOOLS.find((x) => x.key === e.key.toLowerCase()) : null;
      if (tool) {
        e.preventDefault();
        tool.run();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && area.selectionStart === area.selectionEnd) {
        const next = continueList(area.value, area.selectionStart);
        if (next) {
          e.preventDefault();
          area.value = next.value;
          area.setSelectionRange(next.caret, next.caret);
          later();
        }
      }
    });

    // ---------- lezen of bewerken ----------
    const drawRead = () => {
      preview.replaceChildren(renderMarkdown(area.value, {
        onToggleTask: (index) => {
          const next = toggleTask(area.value, index);
          if (next === null) return;
          area.value = next;
          flush();
          drawRead();
        },
      }));
      if (!area.value.trim()) preview.replaceChildren(h('p', { class: 'hint' }, t('note.emptyRead')));
    };
    const setMode = (next) => {
      mode = next;
      if (mode === 'read') flush();
      dialog.classList.toggle('note-editing', mode === 'edit');
      if (mode === 'read') drawRead();
      area.hidden = mode !== 'edit';
      bar.hidden = mode !== 'edit';
      preview.hidden = mode !== 'read';
      drawSide();
      (mode === 'edit' ? area : preview).focus?.({ preventScroll: true });
    };

    // ---------- kleur, labels, vastpinnen, archief, prullenbak ----------
    const trashed = () => Boolean(note()?.trashed_at);
    const tool = (fk, iconName, text, onclick, extra = {}) => h('button', {
      class: `button button-small button-ghost note-action${extra.active ? ' active' : ''}`, type: 'button', dataset: { fk: `note:${fk}` }, 'aria-pressed': extra.pressed === undefined ? null : String(extra.pressed),
      onclick,
    }, icon(iconName), h('span', { class: 'btn-label' }, text));

    const labelInput = h('input', { class: 'field', type: 'text', maxLength: 100, placeholder: t('note.newLabel'), 'aria-label': t('note.newLabelLabel'), autocomplete: 'off', dataset: { fk: 'note-new-label' } });
    const createLabel = async () => {
      const name = labelInput.value.trim();
      if (!name) return;
      labelInput.value = '';
      const id = await actions.addLabel(name);
      if (id && !(note()?.labels ?? []).includes(id)) await actions.updateNote(noteId, { labels: [...(note()?.labels ?? []), id] });
    };
    labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); createLabel(); }
    });

    function drawLabels() {
      const n = note();
      const own = labelList(store.view, store.userId).own.map((x) => x.label);
      const chosen = new Set(n?.labels ?? []);
      const focused = document.activeElement?.dataset?.fk ?? null;
      labelPanel.replaceChildren(
        own.length === 0 && h('p', { class: 'hint' }, t('note.noLabels')),
        own.length > 0 && h('ul', { class: 'note-label-list' }, own.map((label) => h('li', {},
          h('label', { class: 'note-label-option' },
            h('input', {
              type: 'checkbox', checked: chosen.has(label.id), dataset: { fk: `note-label:${label.id}` },
              onchange: (e) => actions.updateNote(noteId, { labels: e.target.checked ? [...(note()?.labels ?? []), label.id] : (note()?.labels ?? []).filter((x) => x !== label.id) }),
            }),
            h('span', { class: `dot ${colorClass(label.color)}`, 'aria-hidden': 'true' }), h('span', {}, label.name))))),
        h('div', { class: 'note-label-new' }, labelInput, h('button', { class: 'button button-small', type: 'button', onclick: createLabel }, t('common.add'))));
      labelPanel.hidden = !labelsOpen;
      if (focused && document.activeElement === document.body) labelPanel.querySelector(`[data-fk="${CSS.escape(focused)}"]`)?.focus();
    }

    function drawSide() {
      const n = note();
      if (!n) return;
      const focused = side.contains(document.activeElement) ? document.activeElement.dataset.fk ?? null : null;
      const swatches = COLOR_NAMES.map((c) => h('label', { class: `swatch ${colorClass(c)}`, title: colorLabel(c) },
        h('input', { type: 'radio', name: `note-color-${noteId}`, value: c, checked: c === colorName(n.color), 'aria-label': colorLabel(c), onchange: () => actions.updateNote(noteId, { color: c }) }),
        h('span', { class: 'swatch-dot' }, icon('check'))));
      side.replaceChildren(
        trashed()
          ? [
            h('p', { class: 'hint' }, t('note.trashedHint', { count: trashDaysLeft(n) })),
            tool('restore', 'undo', t('note.restore'), async () => { await actions.restoreNote(noteId); toast(t('note.restored')); }),
            tool('delete', 'trash', t('note.deleteForever'), () => removeForever(), {}),
          ]
          : [
            tool('mode', mode === 'edit' ? 'eye' : 'pencil', mode === 'edit' ? t('note.read') : t('note.edit'), () => setMode(mode === 'edit' ? 'read' : 'edit')),
            tool('pin', 'pin', n.is_pinned ? t('note.unpin') : t('note.pin'), () => actions.updateNote(noteId, { is_pinned: !n.is_pinned }), { active: n.is_pinned, pressed: Boolean(n.is_pinned) }),
            tool('labels', 'tag', t('note.labels'), () => { labelsOpen = !labelsOpen; drawLabels(); }, { active: labelsOpen, pressed: labelsOpen }),
            tool('archive', 'archive', n.is_archived ? t('note.unarchive') : t('note.archive'), async () => {
              flush();
              await actions.updateNote(noteId, { is_archived: !n.is_archived });
              toast(n.is_archived ? t('note.unarchived') : t('note.archived'));
              if (!n.is_archived) close();
            }),
            tool('export', 'paperclip', t('note.export'), () => {
              flush();
              const now = note();
              const name = `${(noteTitle(now, t('note.untitled')).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 60) || 'notitie')}.md`;
              const body = now.title ? `# ${now.title}\n\n${now.content ?? ''}` : (now.content ?? '');
              if (!saveTextFile({ name, mime: 'text/markdown', text: body })) toast(t('note.exportFailed'), { kind: 'error' });
            }),
            tool('trash', 'trash', t('note.trash'), async () => {
              flush();
              await actions.trashNote(noteId);
              toast(t('note.trashed'), { action: { label: t('note.undo'), run: () => actions.restoreNote(noteId) } });
              close();
            }),
            h('fieldset', { class: 'color-field note-colors' }, h('legend', {}, t('note.color')), h('div', { class: 'swatches' }, swatches)),
          ],
      );
      drawLabels();
      if (focused) side.querySelector(`[data-fk="${CSS.escape(focused)}"]`)?.focus();
    }

    async function removeForever() {
      closing = true;
      if (timer) { clearTimeout(timer); timer = null; }
      await actions.deleteNotes([noteId]);
      toast(t('note.deleted'));
      finish(null);
    }

    function close() {
      finish(null);
    }

    // wijzigingen van buiten (een ander apparaat, de knoppen hierboven) komen in de knoppen en kleuren; de tekst blijft zoals je hem typt
    const unsubscribe = store.subscribe(() => {
      if (!note()) { if (!closing) finish(null); return; }
      drawSide();
    });
    dialog.addEventListener('close', () => {
      unsubscribe();
      // bij sluiten (ook met Escape): wat er nog niet bewaard is, nu bewaren; een nieuwe, lege notitie weer weghalen
      if (closing) return;
      flush();
      const n = note();
      if (created && n && !n.title && !n.content && (n.labels ?? []).length === 0) actions.deleteNotes([noteId]);
    });

    const meta = () => {
      const n = note();
      return n?.updated_at ? t('note.updated', { when: new Date(n.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }) : '';
    };
    status.textContent = meta();

    const root = h('div', { class: 'dialog-form note-form' },
      h('div', { class: 'note-head' },
        titleInput,
        h('button', { class: 'icon-button', type: 'button', 'aria-label': t('common.close'), title: t('common.close'), dataset: { fk: 'note-close' }, onclick: close }, icon('close'))),
      h('div', { class: 'note-body' },
        h('div', { class: 'note-main' }, bar, area, preview, labelPanel),
        side),
      h('div', { class: 'note-foot' }, status));
    queueMicrotask(() => {
      setMode(mode);
      if (mode === 'edit') (created ? titleInput : area).focus();
    });
    return root;
  }, { wide: true, className: 'note-dialog' });
}
