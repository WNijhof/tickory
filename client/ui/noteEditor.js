// Het venster van één notitie (SPEC 5k), zoals in Anchor: bovenaan terug en de opslagstatus, en rechts de achtergrond, vastpinnen en
// een menu; daaronder een grote titel, "Bewerkt … · N woorden", de labels als chips en de tekst met opmaak in beeld
// (ui/blockEditor.js). Het hele venster krijgt de achtergrond van de notitie. Alles wordt vanzelf bewaard: kort na het laatste typen
// en bij sluiten; offline gaat het in de wachtrij zoals elke wijziging. Een notitie in de prullenbak is alleen te lezen.
//
// Het is een venster en geen pagina: de lijst erachter wordt bij elke wijziging opnieuw getekend en zou de editor anders kwijtraken.

import { NOTE_LIMITS } from '../../shared/schema.js';
import { notePrefsOf } from '../../shared/notes.js';
import { t } from '../core/i18n.js';
import { colorClass } from '../core/colors.js';
import { editedText, noteReminderInfo, noteTitle, reminderPresets, trashDaysLeft } from '../core/notes.js';
import { NOTE_REPEATS } from '../../shared/notes.js';
import { formatDue, todayString } from '../core/format.js';
import { labelList, mySettings } from '../core/selectors.js';
import { confirmDialog, h, menuDialog, openDialog, promptDialog, toast } from './dom.js';
import { icon } from './icons.js';
import { createBlockEditor } from './blockEditor.js';
import { backgroundPicker, bgClass } from './noteLook.js';
import { saveTextFile } from './exportDialog.js';

const SAVE_DELAY_MS = 600;
// letterlijke sleutels, zodat de controle op ontbrekende en ongebruikte teksten ze vindt
const REPEAT_LABEL = {
  none: () => t('note.repeatNone'), daily: () => t('note.repeatDaily'), weekly: () => t('note.repeatWeekly'),
  monthly: () => t('note.repeatMonthly'), yearly: () => t('note.repeatYearly'),
};

/**
 * @param {{ store: import('../core/store.js').Store, actions: object, noteId: string, created?: boolean }} options
 *   `created`: de notitie is zojuist gemaakt; blijft ze leeg, dan wordt ze bij sluiten weer weggehaald
 * @returns {Promise<void>} klaar zodra het venster dicht is
 */
export function openNoteEditor({ store, actions, noteId, created = false }) {
  const note = () => store.view.notes.get(noteId);
  if (!note()) return Promise.resolve();
  let timer = null;
  let closing = false;
  let saving = false;
  let pop = null; // het open keuzevenstertje (achtergrond, menu, labels)

  return openDialog((finish, dialog) => {
    const initial = note();
    const trashed = () => Boolean(note()?.trashed_at);
    const prefs = () => notePrefsOf(mySettings(store.view, store.userId));
    const sheet = h('div', { class: `note-sheet ${bgClass(initial.background)}` });

    // ---------- titel en tekst ----------
    const title = h('textarea', {
      class: 'note-title', rows: 1, maxLength: NOTE_LIMITS.title, placeholder: t('note.titlePlaceholder'), 'aria-label': t('note.titleLabel'),
      readOnly: trashed(), dataset: { fk: 'note-title' },
    });
    title.value = initial.title ?? '';
    const grow = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
    const editor = createBlockEditor({
      markdown: initial.content ?? '',
      readOnly: trashed(),
      checkedBottom: prefs().checked_bottom,
      placeholder: t('note.contentPlaceholder'),
      onChange: () => later(),
      onExitUp: () => { title.focus(); title.setSelectionRange(title.value.length, title.value.length); },
      onLink: (current) => askLink(current),
    });
    title.addEventListener('input', () => { grow(); later(); });
    title.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'ArrowDown' && title.selectionStart === title.value.length)) {
        e.preventDefault();
        editor.focus('start');
      }
    });

    // ---------- bewaren ----------
    const status = h('span', { class: 'note-save', role: 'status', 'aria-live': 'polite' });
    const drawStatus = () => {
      const offline = globalThis.navigator?.onLine === false;
      status.replaceChildren(
        saving ? h('span', { class: 'note-save-dot', 'aria-hidden': 'true' }) : icon(offline ? 'history' : 'check'),
        h('span', { class: 'note-save-text' }, saving ? t('note.saving') : offline ? t('note.waiting') : t('note.saved')));
      status.title = offline ? t('note.waitingHint') : '';
    };
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const now = note();
      if (!now || trashed()) { saving = false; drawStatus(); return; }
      const changes = {};
      const md = editor.getMarkdown();
      if (title.value !== (now.title ?? '')) changes.title = title.value;
      if (md !== (now.content ?? '')) changes.content = md;
      saving = false;
      if (Object.keys(changes).length > 0) actions.updateNote(noteId, changes);
      drawStatus();
      drawMeta();
    };
    function later() {
      saving = true;
      drawStatus();
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DELAY_MS);
    }

    // ---------- de kop ----------
    const iconButton = (fk, name, label, onclick, extra = {}) => h('button', {
      type: 'button', class: `icon-button note-bar-button${extra.cls ? ` ${extra.cls}` : ''}`, 'aria-label': label, title: label, dataset: { fk }, onclick,
      'aria-pressed': extra.pressed === undefined ? null : String(extra.pressed), 'aria-haspopup': extra.popup ? 'true' : null,
    }, icon(name));
    const right = h('div', { class: 'note-bar-right' });
    const bar = h('div', { class: 'note-bar' },
      h('div', { class: 'note-bar-left' }, iconButton('note-close', 'chevronLeft', t('note.back'), () => finish(null)), status),
      right);

    function drawBar() {
      const n = note();
      if (!n) return;
      const focused = right.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      if (trashed()) {
        right.replaceChildren(
          h('button', { type: 'button', class: 'button button-small', dataset: { fk: 'note:restore' }, onclick: async () => { await actions.restoreNote(noteId); toast(t('note.restored')); } }, icon('undo'), t('note.restore')),
          h('button', { type: 'button', class: 'button button-small button-danger', dataset: { fk: 'note:delete' }, onclick: removeForever }, icon('trash'), t('note.deleteForever')));
      } else {
        const reminder = noteReminderInfo(n);
        right.replaceChildren(
          iconButton('note:background', 'palette', t('note.background'), (e) => openBackground(e.currentTarget), { popup: true }),
          iconButton('note:reminder', 'bell', reminder ? t('note.reminderAt', { when: reminder.text }) : t('note.reminderAdd'), (e) => openReminder(e.currentTarget), { popup: true, cls: reminder ? (reminder.past ? 'is-late' : 'is-on') : '' }),
          iconButton('note:pin', 'pin', n.is_pinned ? t('note.unpin') : t('note.pin'), () => actions.updateNote(noteId, { is_pinned: !n.is_pinned }), { pressed: Boolean(n.is_pinned), cls: n.is_pinned ? 'is-on' : '' }),
          iconButton('note:more', 'more', t('note.more'), (e) => openMenu(e.currentTarget), { popup: true }));
      }
      if (focused) right.querySelector(`[data-fk="${CSS.escape(focused)}"]`)?.focus();
    }

    // ---------- labels als chips ----------
    const tags = h('div', { class: 'note-tags' });
    function drawTags() {
      const n = note();
      if (!n) return;
      const chosen = (n.labels ?? []).map((id) => store.view.labels.get(id)).filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      const reminder = trashed() ? null : noteReminderInfo(n);
      // replaceChildren zet false als tekst neer: alleen echte knooppunten doorgeven
      tags.replaceChildren(...[
        reminder && h('button', {
          type: 'button', class: `note-reminder-chip${reminder.past ? ' is-late' : ''}`, dataset: { fk: 'note-reminder-chip' },
          'aria-label': t('note.reminderAt', { when: reminder.text }), 'aria-haspopup': 'true', onclick: (e) => openReminder(e.currentTarget),
        }, icon(reminder.repeat ? 'repeat' : 'bell'), h('span', {}, reminder.text), reminder.repeat && h('span', { class: 'note-reminder-repeat' }, `· ${REPEAT_LABEL[reminder.repeat]()}`)),
        ...chosen.map((label) => h('span', { class: 'note-tag' },
          h('span', { class: `note-tag-hash ${colorClass(label.color)}`, 'aria-hidden': 'true' }, '#'), h('span', {}, label.name),
          !trashed() && h('button', {
            type: 'button', class: 'note-tag-remove', 'aria-label': t('note.removeLabel', { name: label.name }), title: t('note.removeLabel', { name: label.name }),
            dataset: { fk: `note-tag-remove:${label.id}` }, onclick: () => actions.updateNote(noteId, { labels: (note()?.labels ?? []).filter((x) => x !== label.id) }),
          }, '×'))),
        !trashed() && h('button', { type: 'button', class: 'note-tag-add', dataset: { fk: 'note-tag-add' }, 'aria-haspopup': 'true', onclick: (e) => openTags(e.currentTarget) }, icon('plus'), t('note.addLabel')),
      ].filter(Boolean));
    }

    // ---------- bewerkt, woorden ----------
    const meta = h('p', { class: 'note-meta' });
    function drawMeta() {
      const n = note();
      if (!n) return;
      const parts = [editedText(n.updated_at), t('note.words', { count: editor.wordCount() })];
      if (trashed()) parts.push(t('note.daysLeftLong', { count: trashDaysLeft(n) }));
      else if (n.is_archived) parts.push(t('note.inArchive'));
      meta.textContent = parts.filter(Boolean).join(' · ');
    }

    // ---------- keuzevenstertjes ----------
    function closePop() {
      if (!pop) return;
      const { el, anchor } = pop;
      pop = null;
      el.remove();
      sheet.className = `note-sheet ${bgClass(note()?.background)}`;
      anchor?.focus?.();
    }
    function openPop(anchor, content, kind) {
      const same = pop?.kind === kind;
      closePop();
      if (same) return;
      const el = h('div', { class: `note-pop note-pop-${kind}`, role: kind === 'menu' ? 'menu' : 'dialog', 'aria-label': anchor.getAttribute('aria-label') ?? anchor.textContent }, content);
      dialog.append(el);
      const a = anchor.getBoundingClientRect();
      const d = dialog.getBoundingClientRect();
      const width = el.offsetWidth;
      el.style.top = `${a.bottom - d.top + 6}px`;
      el.style.left = `${Math.max(8, Math.min(a.right - d.left - width, d.width - width - 8))}px`;
      pop = { el, anchor, kind };
      (el.querySelector('[aria-checked="true"], input, button:not([disabled])'))?.focus();
    }
    dialog.addEventListener('pointerdown', (e) => {
      if (pop && !pop.el.contains(e.target) && !pop.anchor.contains(e.target)) closePop();
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pop) { e.preventDefault(); e.stopPropagation(); closePop(); }
    }, true);
    dialog.addEventListener('cancel', (e) => { if (pop) { e.preventDefault(); closePop(); } });

    function openBackground(anchor) {
      openPop(anchor, backgroundPicker({
        value: note()?.background ?? null,
        onChange: (bg) => { actions.updateNote(noteId, { background: bg }); sheet.className = `note-sheet ${bgClass(bg)}`; closePop(); },
        onPreview: (bg) => { sheet.className = `note-sheet ${bgClass(bg === false ? note()?.background : bg)}`; },
      }), 'background');
    }

    function openReminder(anchor) {
      const n = note();
      const current = n.remind_at ?? null;
      const when = h('input', { class: 'field', type: 'datetime-local', value: current ?? '', 'aria-label': t('note.reminderCustom'), dataset: { fk: 'note-reminder-when' } });
      const repeat = h('select', { class: 'field', 'aria-label': t('note.repeat'), dataset: { fk: 'note-reminder-repeat' } },
        h('option', { value: '', selected: !n.remind_repeat }, REPEAT_LABEL.none()),
        NOTE_REPEATS.map((r) => h('option', { value: r, selected: n.remind_repeat === r }, REPEAT_LABEL[r]())));
      const hint = h('p', { class: 'hint', 'aria-live': 'polite' });
      const save = (at) => {
        if (!at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) { hint.textContent = t('note.reminderInvalid'); when.focus(); return; }
        actions.updateNote(noteId, { remind_at: at, remind_repeat: repeat.value || null });
        toast(t('note.reminderSaved', { when: formatDue({ date: at }, todayString()) }));
        closePop();
      };
      const PRESET_LABEL = { later: () => t('note.reminderLater'), tomorrow: () => t('note.reminderTomorrow'), nextWeek: () => t('note.reminderNextWeek') };
      openPop(anchor, [
        h('p', { class: 'note-pop-title' }, t('note.reminder')),
        ...reminderPresets().map((p) => h('button', {
          type: 'button', class: 'note-menu-item', dataset: { fk: `note-reminder:${p.id}` }, onclick: () => save(p.at),
        }, icon('clock'), h('span', { class: 'note-menu-label' }, PRESET_LABEL[p.id]()), h('span', { class: 'note-menu-hint' }, formatDue({ date: p.at }, todayString())))),
        h('hr', { class: 'note-menu-sep' }),
        h('label', { class: 'field-label' }, t('note.reminderCustom'), when),
        h('label', { class: 'field-label' }, t('note.repeat'), repeat),
        hint,
        h('div', { class: 'note-pop-buttons' },
          current && h('button', { type: 'button', class: 'button button-small button-ghost', dataset: { fk: 'note-reminder-remove' }, onclick: () => { actions.updateNote(noteId, { remind_at: null, remind_repeat: null }); toast(t('note.reminderRemoved')); closePop(); } }, t('note.reminderRemove')),
          h('button', { type: 'button', class: 'button button-small button-primary', dataset: { fk: 'note-reminder-save' }, onclick: () => save(when.value) }, t('common.save'))),
      ], 'reminder');
    }

    function openMenu(anchor) {
      const n = note();
      const counts = editor.counts();
      const item = (fk, iconName, label, run, opts = {}) => h('button', {
        type: 'button', role: 'menuitem', class: `note-menu-item${opts.danger ? ' danger' : ''}`, disabled: opts.disabled, dataset: { fk: `note-menu:${fk}` },
        onclick: () => { closePop(); run(); },
      }, icon(iconName), label);
      openPop(anchor, [
        item('pin', 'pin', n.is_pinned ? t('note.unpin') : t('note.pin'), () => actions.updateNote(noteId, { is_pinned: !n.is_pinned })),
        item('archive', 'archive', n.is_archived ? t('note.unarchive') : t('note.archive'), async () => {
          flush();
          await actions.updateNote(noteId, { is_archived: !n.is_archived });
          toast(n.is_archived ? t('note.unarchived') : t('note.archived'));
          if (!n.is_archived) finish(null);
        }),
        counts.items > 0 && h('hr', { class: 'note-menu-sep' }),
        counts.items > 0 && item('uncheck', 'undo', t('note.uncheckAll'), () => editor.uncheckAll(), { disabled: counts.checked === 0 }),
        counts.items > 0 && item('delete-checked', 'trash', t('note.deleteChecked'), () => editor.deleteChecked(), { disabled: counts.checked === 0, danger: true }),
        h('hr', { class: 'note-menu-sep' }),
        item('export', 'paperclip', t('note.export'), () => exportFile()),
        item('trash', 'trash', t('note.trash'), async () => {
          flush();
          await actions.trashNote(noteId);
          toast(t('note.trashed'), { action: { label: t('note.undo'), run: () => actions.restoreNote(noteId) } });
          finish(null);
        }, { danger: true }),
      ], 'menu');
    }

    function openTags(anchor) {
      const search = h('input', { class: 'field', type: 'text', maxLength: 100, placeholder: t('note.labelSearch'), 'aria-label': t('note.labelSearch'), autocomplete: 'off', dataset: { fk: 'note-label-search' } });
      const list = h('div', { class: 'note-label-list', role: 'group', 'aria-label': t('note.labels') });
      const fold = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
      const draw = () => {
        const q = search.value.trim();
        const all = labelList(store.view, store.userId).own.map((x) => x.label);
        const own = all.filter((l) => !q || fold(l.name).includes(fold(q)));
        const chosen = new Set(note()?.labels ?? []);
        const exact = all.some((l) => fold(l.name) === fold(q));
        list.replaceChildren(...[ // replaceChildren zet false als tekst neer: alleen echte knooppunten
          ...own.map((label) => h('label', { class: 'note-label-option' },
            h('input', {
              type: 'checkbox', checked: chosen.has(label.id), dataset: { fk: `note-label:${label.id}` },
              onchange: (e) => actions.updateNote(noteId, { labels: e.target.checked ? [...new Set([...(note()?.labels ?? []), label.id])] : (note()?.labels ?? []).filter((x) => x !== label.id) }),
            }),
            h('span', { class: `note-tag-hash ${colorClass(label.color)}`, 'aria-hidden': 'true' }, '#'), h('span', {}, label.name))),
          q && !exact && h('button', {
            type: 'button', class: 'note-label-create', dataset: { fk: 'note-label-create' },
            onclick: async () => {
              const id = await actions.addLabel(q);
              if (id) await actions.updateNote(noteId, { labels: [...new Set([...(note()?.labels ?? []), id])] });
              search.value = '';
              draw();
              search.focus();
            },
          }, icon('plus'), t('note.createLabel', { name: q })),
          all.length === 0 && !q && h('p', { class: 'hint' }, t('note.noLabels')),
        ].filter(Boolean));
      };
      search.addEventListener('input', draw);
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); list.querySelector('.note-label-create')?.click(); }
      });
      draw();
      openPop(anchor, [search, list], 'labels');
    }

    async function askLink(current) {
      if (current) {
        const choice = await menuDialog({
          title: current,
          items: [{ value: 'open', label: t('note.linkOpen') }, { value: 'edit', label: t('note.linkEdit') }, { value: 'remove', label: t('note.linkRemove'), danger: true }],
        });
        if (choice === 'open') { window.open(current, '_blank', 'noopener,noreferrer'); return null; }
        if (choice === 'remove') return '';
        if (choice !== 'edit') return null;
      }
      return promptDialog({ title: t('note.linkTitle'), label: t('note.linkLabel'), value: current ?? '', type: 'url', okText: t('common.save'), placeholder: 'https://' });
    }

    function exportFile() {
      flush();
      const n = note();
      const name = `${(noteTitle(n, t('note.untitled')).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 60) || 'notitie')}.md`;
      const body = n.title ? `# ${n.title}\n\n${n.content ?? ''}` : (n.content ?? '');
      if (!saveTextFile({ name, mime: 'text/markdown', text: body })) toast(t('note.exportFailed'), { kind: 'error' });
    }

    async function removeForever() {
      const ok = await confirmDialog({ title: t('note.deleteForeverTitle'), text: t('note.deleteForeverText'), okText: t('note.deleteForever') });
      if (!ok) return;
      closing = true;
      if (timer) { clearTimeout(timer); timer = null; }
      await actions.deleteNotes([noteId]);
      toast(t('note.deleted'));
      finish(null);
    }

    // ---------- wijzigingen van buiten (een ander apparaat, de knoppen hierboven) ----------
    let lastSeen = { title: initial.title ?? '', content: initial.content ?? '' };
    const unsubscribe = store.subscribe(() => {
      const n = note();
      if (!n) { if (!closing) { closing = true; finish(null); } return; }
      // de tekst van een ander apparaat alleen overnemen als je hier niet zelf aan het typen bent
      const typing = Boolean(timer) || editor.el.contains(document.activeElement) || document.activeElement === title;
      if (!typing && n.content !== lastSeen.content) editor.setMarkdown(n.content ?? '');
      if (!typing && n.title !== lastSeen.title) { title.value = n.title ?? ''; grow(); }
      lastSeen = { title: n.title ?? '', content: n.content ?? '' };
      if (!pop || pop.kind !== 'background') sheet.className = `note-sheet ${bgClass(n.background)}`;
      editor.setCheckedBottom(prefs().checked_bottom);
      drawBar();
      drawTags();
      drawMeta();
      if (pop?.kind === 'labels') pop.el.querySelector('input')?.dispatchEvent(new Event('input'));
    });
    const onOnline = () => drawStatus();
    globalThis.addEventListener?.('online', onOnline);
    globalThis.addEventListener?.('offline', onOnline);

    dialog.addEventListener('close', () => {
      unsubscribe();
      globalThis.removeEventListener?.('online', onOnline);
      globalThis.removeEventListener?.('offline', onOnline);
      if (!closing) flush();
      editor.destroy();
      // een nieuwe notitie die leeg bleef, weer weghalen
      const n = note();
      if (created && !closing && n && !n.title && !n.content && (n.labels ?? []).length === 0) actions.deleteNotes([noteId]);
    });

    drawBar();
    drawTags();
    drawMeta();
    sheet.append(
      bar,
      h('div', { class: 'note-scroll' },
        h('div', { class: 'note-page' },
          trashed() && h('p', { class: 'note-banner' }, icon('trash'), t('note.trashedBanner', { count: trashDaysLeft(initial) })),
          title, meta, tags,
          !trashed() && editor.toolbar,
          h('div', { class: 'note-body' }, editor.el))));
    queueMicrotask(() => {
      grow();
      if (created) title.focus();
      else if (!trashed()) editor.focus('end');
    });
    return sheet;
  }, { wide: true, className: 'note-dialog' });
}
