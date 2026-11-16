// De opmerkingen bij een taak of een project: de lijst, een invoerveld, en bewerken en verwijderen van je eigen opmerkingen.
// De tekst van een opmerking gaat altijd als tekst het document in (nooit als HTML); webadressen worden gewone tekstlinks, en wie
// er met @Naam genoemd is (`mentions`), staat gemarkeerd. In een gedeeld project opent @ een keuzelijst met de leden (ui/mentionPicker.js).

import { linkify } from '../core/commentText.js';
import { getLocale, t } from '../core/i18n.js';
import { mentionIds, mentionParts } from '../core/mentions.js';
import { commentsOf, membersOf } from '../core/selectors.js';
import { timeAgo } from '../core/timeAgo.js';
import { initials } from '../core/rowModel.js';
import { confirmDialog, h, iconButton, replace, toast } from './dom.js';
import { attachMentionPicker } from './mentionPicker.js';
import { attachmentRuntime, failureText, rejectionText, saveBlob } from './attachments.js';
import { icon } from './icons.js';
import { formatBytes, isPreviewMime } from '../../shared/attachments.js';

/**
 * De tekst van een opmerking als stukken tekst, tekstlinks en vermeldingen.
 * @param {string} content
 * @param {string[]} [mentions] wie er genoemd is (gebruikers-id's)
 * @param {(id: string) => string | null} [nameOf]
 */
export function commentBody(content, mentions = [], nameOf = () => null) {
  return mentionParts(content, mentions, nameOf).flatMap((piece) => (piece.mention
    ? [h('span', { class: 'mention', dataset: { userId: piece.mention } }, piece.text)]
    : linkify(piece.text).map((part) => (part.href
      ? h('a', { href: part.href, target: '_blank', rel: 'noopener noreferrer nofollow' }, part.text)
      : document.createTextNode(part.text)))));
}

const fullTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' });
};

/**
 * @param {{ target: { taskId?: string, projectId?: string }, store: import('../core/store.js').Store, actions: object, heading?: boolean }} options
 * @returns {{ node: HTMLElement, dispose: () => void, focus: () => void }}
 */
export function commentsSection({ target, store, actions, heading = true }) {
  let editing = null; // { id, draft } terwijl een eigen opmerking wordt bewerkt
  const list = h('ul', { class: 'comment-list' });
  const title = h('h3', { class: 'subheading' });
  const input = h('textarea', { class: 'field comment-input', rows: 2, maxLength: 16000, placeholder: t('comment.placeholder'), 'aria-label': t('comment.inputLabel') });
  const post = h('button', { class: 'button button-primary button-small', type: 'button', disabled: true, onclick: () => submit() }, t('comment.post'));

  // ---- bijlagen bij een opmerking (alleen bij een taak, zoals Todoist; core/attachments.js met comment_id) ----
  const runtime = target.taskId ? attachmentRuntime() : null;
  let chosenFiles = [];
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, 'aria-hidden': 'true', tabIndex: -1, dataset: { fk: 'comment-file-input' } });
  const chips = h('div', { class: 'comment-files-chosen' });
  const drawChosen = () => {
    replace(chips, chosenFiles.map((f, i) => h('span', { class: 'comment-file-chip' }, icon('paperclip'), h('span', {}, f.name),
      h('button', { type: 'button', class: 'comment-file-remove', 'aria-label': t('comment.fileRemove', { name: f.name }), onclick: () => { chosenFiles.splice(i, 1); drawChosen(); } }, '×'))));
    post.disabled = !input.value.trim() && chosenFiles.length === 0;
  };
  fileInput.addEventListener('change', () => { chosenFiles = [...chosenFiles, ...fileInput.files]; fileInput.value = ''; drawChosen(); });
  const attachButton = runtime && h('button', {
    type: 'button', class: 'icon-button comment-attach', 'aria-label': t('comment.attach'), title: t('comment.attach'), dataset: { fk: 'comment-attach' },
    onclick: () => fileInput.click(),
  }, icon('paperclip'));
  const previews = new Map(); // bijlage-id -> blob-URL
  const loadPreview = (a) => {
    if (previews.has(a.id) || !isPreviewMime(a.mime) || a.size > 8_000_000) return;
    previews.set(a.id, null);
    runtime.manager.fetchBlob(a.id).then((blob) => { previews.set(a.id, URL.createObjectURL(blob)); drawn = null; draw(); }).catch(() => {});
  };
  const openFile = async (a) => {
    try {
      const blob = await runtime.manager.fetchBlob(a.id);
      saveBlob(blob, a.name, a.mime);
    } catch {
      toast(t('attachment.loadFailed', { name: a.name }), { kind: 'error' });
    }
  };
  /** De bijlagen onder een opmerking: afbeeldingen als voorbeeld, de rest als naam; en wat nog wordt geüpload. */
  const filesOf = (c) => {
    if (!runtime) return null;
    const saved = [...(store.view.attachments?.values() ?? [])].filter((a) => a.comment_id === c.id).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const pending = runtime.manager.pendingFor(target.taskId, { commentId: c.id });
    if (saved.length === 0 && pending.length === 0) return null;
    for (const a of saved) loadPreview(a);
    return h('ul', { class: 'comment-files' },
      saved.map((a) => {
        const url = previews.get(a.id);
        return h('li', { class: 'comment-file', dataset: { id: a.id } },
          h('button', { type: 'button', class: 'comment-file-open', 'aria-label': t('attachment.saveLabel', { name: a.name }), title: a.name, onclick: () => openFile(a) },
            url ? h('img', { src: url, alt: '' }) : icon('paperclip'), h('span', { class: 'comment-file-name' }, a.name)));
      }),
      pending.map((p) => h('li', { class: `comment-file comment-file-pending is-${p.status}` },
        icon('paperclip'), h('span', { class: 'comment-file-name' }, p.name),
        h('span', { class: 'hint' }, p.status === 'failed' ? failureText(p.error) : p.status === 'uploading' ? `${Math.round((p.progress || 0) * 100)}%` : formatBytes(p.size)))));
  };

  // wie je kunt noemen: de leden van het project van de taak (of van het project zelf), met hun naam en gebruikersnaam
  const people = () => {
    const projectId = target.taskId ? store.view.tasks.get(target.taskId)?.project_id : target.projectId;
    return membersOf(store.view, projectId).map((m) => store.users.find((u) => u.id === m.user_id)).filter(Boolean);
  };
  const nameOf = (id) => (id === store.userId ? store.me?.name : null) ?? store.userName(id);
  const picker = attachMentionPicker({ input, people, me: () => store.userId });

  const authorName = (c) => {
    if (c.author_id && c.author_id === store.userId) return store.me?.name ?? store.userName(c.author_id) ?? t('common.unknownUser');
    return (c.author_id && store.userName(c.author_id)) || t('common.unknownUser');
  };

  const startEdit = (c) => {
    editing = { id: c.id, draft: c.content };
    draw();
    list.querySelector('textarea')?.focus();
  };
  const stopEdit = () => {
    editing = null;
    draw();
  };
  const saveEdit = async (c, text, chosen) => {
    const content = text.trim();
    if (!content) return;
    editing = null;
    const mentions = mentionIds(content, chosen);
    const before = c.mentions ?? [];
    const changed = mentions.length !== before.length || mentions.some((id) => !before.includes(id));
    if (content !== c.content || changed) await actions.updateComment(c.id, content, mentions);
    draw();
  };
  const remove = async (c) => {
    const ok = await confirmDialog({ title: t('comment.deleteTitle'), text: t('comment.deleteText') });
    if (ok) await actions.deleteComment(c.id);
  };

  const editor = (c) => {
    const area = h('textarea', { class: 'field comment-input', rows: 3, maxLength: 16000, value: editing.draft, 'aria-label': t('comment.editLabel') });
    // wie er al genoemd is, blijft herkend zolang "@Naam" in de tekst staat; de keuzelijst komt vóór de andere toetsen
    const known = new Map((c.mentions ?? []).map((id) => [id, nameOf(id)]).filter(([, name]) => name));
    const editPicker = attachMentionPicker({ input: area, people, me: () => store.userId, chosen: known });
    area.addEventListener('input', () => { editing.draft = area.value; });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stopEdit();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        saveEdit(c, area.value, editPicker.chosen);
      }
    });
    return h('div', { class: 'comment-edit' }, h('div', { class: 'comment-compose' }, area, editPicker.node),
      h('div', { class: 'comment-buttons' },
        h('button', { class: 'button button-small', type: 'button', onclick: stopEdit }, t('common.cancel')),
        h('button', { class: 'button button-primary button-small', type: 'button', onclick: () => saveEdit(c, area.value, editPicker.chosen) }, t('common.save'))));
  };

  let drawn = null;
  function draw() {
    const comments = commentsOf(store.view, target);
    // Alleen opnieuw tekenen als er iets veranderd is: zo blijft een opmerking die je net bewerkt met rust als er een sync binnenkomt.
    const files = runtime ? [...(store.view.attachments?.values() ?? [])].filter((a) => a.comment_id && comments.some((c) => c.id === a.comment_id)).map((a) => [a.id, previews.get(a.id) ?? null])
      .concat(comments.flatMap((c) => runtime.manager.pendingFor(target.taskId, { commentId: c.id }).map((p) => [p.id, p.status, Math.round((p.progress || 0) * 10)]))) : [];
    const signature = JSON.stringify([editing?.id ?? null, comments.map((c) => [c.id, c.content, c.updated_at, authorName(c), (c.mentions ?? []).map(nameOf)]), files]);
    if (signature === drawn) return;
    drawn = signature;
    title.textContent = comments.length > 0 ? t('comment.headingCount', { count: comments.length }) : t('comment.heading');
    replace(list, comments.length > 0
      ? comments.map((c) => {
        const mine = Boolean(c.author_id) && c.author_id === store.userId;
        const name = authorName(c);
        const edited = Date.parse(c.updated_at) - Date.parse(c.created_at) > 2000;
        return h('li', { class: 'comment', dataset: { id: c.id } },
          h('span', { class: 'comment-avatar', 'aria-hidden': 'true' }, initials(name)),
          h('div', { class: 'comment-main' },
            h('div', { class: 'comment-head' },
              h('strong', { class: 'comment-author' }, name),
              h('time', { class: 'comment-time', dateTime: c.created_at, title: fullTime(c.created_at) }, timeAgo(c.created_at)),
              edited && h('span', { class: 'comment-edited' }, t('comment.edited')),
              mine && editing?.id !== c.id && h('span', { class: 'comment-tools' },
                iconButton({ name: 'pencil', label: t('comment.edit'), onclick: () => startEdit(c) }),
                iconButton({ name: 'trash', label: t('comment.delete'), onclick: () => remove(c) }))),
            editing?.id === c.id ? editor(c) : h('p', { class: 'comment-text' }, commentBody(c.content, c.mentions, nameOf)),
            filesOf(c)));
      })
      : [h('li', { class: 'comment-none' }, t('comment.none'))]);
  }

  const submit = async () => {
    const files = chosenFiles;
    // alleen bestanden, zonder tekst: dan de namen als tekst (een opmerking heeft altijd tekst)
    const content = input.value.trim() || files.map((f) => f.name).join(', ').slice(0, 1000);
    if (!content) return;
    const mentions = mentionIds(content, picker.chosen);
    input.value = '';
    picker.reset();
    chosenFiles = [];
    drawChosen();
    post.disabled = true;
    const id = await actions.addComment(target, content, mentions);
    if (files.length > 0 && runtime) {
      const { rejected } = await runtime.manager.stage(target.taskId, files, { commentId: id });
      if (rejected.length) toast(rejected.map(rejectionText).join(' '), { kind: 'error' });
    }
    list.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
  };
  input.addEventListener('input', () => { post.disabled = !input.value.trim() && chosenFiles.length === 0; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation(); // niet ook het taakvenster opslaan
      submit();
    }
  });

  const unsubscribe = store.subscribe(draw);
  const unsubscribeFiles = runtime ? runtime.manager.subscribe(draw) : () => {};
  draw();
  const node = h('section', { class: 'comments', 'aria-label': t('comment.heading') },
    heading && title,
    list,
    // geen <form>: de opmerkingen staan ook in het taakvenster, en formulieren mogen niet in elkaar
    h('div', { class: 'comment-form' },
      h('div', { class: 'comment-compose' }, input, picker.node),
      chips,
      h('div', { class: 'comment-buttons' }, attachButton, fileInput, h('span', { class: 'comment-tip' }, people().length > 1 ? t('comment.tipMention') : t('comment.tip')), post)));
  const dispose = () => {
    unsubscribe();
    unsubscribeFiles();
    for (const url of previews.values()) if (url) URL.revokeObjectURL(url);
  };
  return { node, dispose, focus: () => input.focus() };
}
