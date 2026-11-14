// De bijlagen in het taakvenster: de lijst (met voorbeeld bij afbeeldingen), bestanden kiezen of neerzetten, de status van bestanden
// die nog moeten worden geüpload, en openen, opslaan en verwijderen.
//
// Een bijlage ophalen gaat met fetch en het sessietoken (zie core/attachmentsApi.js), niet met een link: de browser stuurt geen
// cookies mee en een token hoort niet in een URL. De inhoud wordt als blob-URL getoond. Alleen afbeeldingen worden getoond
// (een voorbeeld, en een groter venster); al het andere wordt opgeslagen, als "bestand" zonder bekend type, zodat een bestand dat
// scripts bevat (svg, html) nooit in de pagina van de app kan draaien.

import { formatBytes, extensionOf, isInlineMime, isPreviewMime } from '../../shared/attachments.js';
import { getLanguage, t } from '../core/i18n.js';
import { attachmentsOf, roleIn } from '../core/selectors.js';
import { timeAgo } from '../core/timeAgo.js';
import { shrinkImage } from '../core/imageResize.js';
import { confirmDialog, h, iconButton, openDialog, replace } from './dom.js';
import { icon } from './icons.js';

const SHRINK_KEY = 'tickory.shrinkPhotos';
const PREVIEW_MAX_BYTES = 8_000_000;

/** De onderdelen die de app aan dit scherm geeft (zie ui/app.js). Zonder: geen bijlagen in het taakvenster. */
let runtime = null;
export function configureAttachments(value) {
  runtime = value;
}

const readShrink = () => { try { return localStorage.getItem(SHRINK_KEY) === '1'; } catch { return false; } };
const writeShrink = (on) => { try { localStorage.setItem(SHRINK_KEY, on ? '1' : '0'); } catch { /* alleen een gemak */ } };

/** Een blob als bestand opslaan via een tijdelijke link. */
export function saveBlob(blob, name, mime) {
  const safe = isInlineMime(mime) ? mime : 'application/octet-stream';
  const url = URL.createObjectURL(new Blob([blob], { type: safe }));
  const a = h('a', { href: url, download: name, rel: 'noopener' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** De tekst bij een reden waarom een bestand niet is toegevoegd. */
export function rejectionText({ name, reason, max }) {
  switch (reason) {
    case 'empty': return t('attachment.rejected.empty', { name });
    case 'tooLarge': return t('attachment.rejected.tooLarge', { name, max: formatBytes(max, getLanguage()) });
    case 'tooMany': return t('attachment.rejected.tooMany', { name, max });
    case 'storageFull': return t('attachment.rejected.storageFull', { name });
    default: return t('attachment.rejected.noTask', { name });
  }
}

/** De tekst bij een upload die de server niet aannam. */
export function failureText(code) {
  switch (code) {
    case 'TOO_LARGE': return t('attachment.failed.tooLarge');
    case 'LIMIT_REACHED': return t('attachment.failed.limit');
    case 'NOT_FOUND': return t('attachment.failed.gone');
    case 'STORAGE_FULL': return t('attachment.failed.storage');
    default: return t('attachment.failed.other');
  }
}

const fileIcon = (name, mime) => {
  const ext = extensionOf(name);
  const label = (ext || (mime.split('/')[1] ?? 'bestand')).slice(0, 4).toUpperCase();
  return h('span', { class: 'attachment-icon', 'aria-hidden': 'true' }, icon('paperclip'), h('span', { class: 'attachment-ext' }, label));
};

/** Het venster met een afbeelding op volle grootte. */
function viewImage({ attachment, blob }) {
  const url = URL.createObjectURL(blob);
  return openDialog((finish) => h('div', { class: 'dialog-form attachment-viewer' },
    h('h2', {}, attachment.name),
    h('div', { class: 'attachment-viewer-body' }, h('img', { src: url, alt: attachment.name })),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => saveBlob(blob, attachment.name, attachment.mime) }, t('attachment.save')),
      h('button', { type: 'button', class: 'button button-primary', onclick: () => finish(null) }, t('common.close')))),
  { wide: true, className: 'dialog-viewer', onClose: () => URL.revokeObjectURL(url) });
}

/**
 * @param {{ task: { id: string, project_id: string }, store: import('../core/store.js').Store, actions: object }} options
 * @returns {{ node: HTMLElement, dispose: () => void } | null}
 */
export function attachmentsSection({ task, store, actions, readOnly = false }) {
  // readOnly: een project dat je alleen leest (core/access.js): bekijken en opslaan wel, toevoegen en verwijderen niet
  if (!runtime) return null;
  const { manager, bridge } = runtime;
  const urls = new Map(); // id -> blob-URL van een voorbeeld
  const failedPreviews = new Set();
  const loading = new Set();
  let drawn = null;
  let disposed = false;

  const list = h('ul', { class: 'attachment-list' });
  const title = h('h3', { class: 'subheading' });
  const note = h('p', { class: 'hint attachment-note', role: 'status', 'aria-live': 'polite' });
  const input = h('input', { type: 'file', multiple: true, hidden: true, 'aria-hidden': 'true', tabIndex: -1 });
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, 'aria-hidden': 'true', tabIndex: -1 });
  const shrink = h('input', { type: 'checkbox', checked: readShrink() });
  shrink.addEventListener('change', () => writeShrink(shrink.checked));
  const coarse = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;

  const say = (lines) => { note.textContent = lines.join(' '); };

  async function pick(fileList) {
    const files = [...fileList];
    if (files.length === 0) return;
    const prepared = shrink.checked ? await Promise.all(files.map((f) => shrinkImage(f))) : files;
    const { rejected } = await manager.stage(task.id, prepared);
    say(rejected.map(rejectionText));
  }
  input.addEventListener('change', () => { pick(input.files); input.value = ''; });
  camera.addEventListener('change', () => { pick(camera.files); camera.value = ''; });

  const mayDelete = (a) => !readOnly && Boolean(store.userId) && (a.creator_id === store.userId || roleIn(store.view, task.project_id, store.userId) === 'owner');
  const who = (a) => (a.creator_id === store.userId ? store.me?.name : store.userName(a.creator_id)) ?? t('common.unknownUser');

  async function loadPreview(a) {
    if (urls.has(a.id) || loading.has(a.id) || failedPreviews.has(a.id) || !isPreviewMime(a.mime) || a.size > PREVIEW_MAX_BYTES) return;
    loading.add(a.id);
    try {
      const blob = await manager.fetchBlob(a.id);
      if (disposed) return;
      urls.set(a.id, URL.createObjectURL(blob));
      drawn = null;
      draw();
    } catch {
      failedPreviews.add(a.id);
    } finally {
      loading.delete(a.id);
    }
  }

  async function open(a) {
    if (bridge?.canOpenAttachments?.()) {
      bridge.openAttachment(a.id, a.name, a.mime);
      return;
    }
    say([t('attachment.loading', { name: a.name })]);
    try {
      const blob = await manager.fetchBlob(a.id);
      say([]);
      if (isPreviewMime(a.mime)) await viewImage({ attachment: a, blob });
      else saveBlob(blob, a.name, a.mime);
    } catch {
      say([t('attachment.loadFailed', { name: a.name })]);
    }
  }

  async function save(a) {
    if (bridge?.canOpenAttachments?.()) {
      bridge.saveAttachment(a.id, a.name, a.mime);
      return;
    }
    try {
      saveBlob(await manager.fetchBlob(a.id), a.name, a.mime);
    } catch {
      say([t('attachment.loadFailed', { name: a.name })]);
    }
  }

  async function remove(a) {
    const ok = await confirmDialog({ title: t('attachment.deleteTitle'), text: t('attachment.deleteText', { name: a.name }) });
    if (!ok) return;
    manager.forgetBlob(a.id);
    const url = urls.get(a.id);
    if (url) { URL.revokeObjectURL(url); urls.delete(a.id); }
    await actions.deleteAttachment(a.id);
  }

  const pendingState = (p) => {
    if (p.status === 'uploading') return t('attachment.uploading', { percent: Math.round((p.progress || 0) * 100) });
    if (p.status === 'failed') return t('attachment.failedWith', { reason: failureText(p.error) });
    return store.base.tasks.has(p.task_id) ? t('attachment.waitingOffline') : t('attachment.waitingTask');
  };

  function draw() {
    const saved = attachmentsOf(store.view, task.id);
    const pending = manager.pendingFor(task.id);
    const signature = JSON.stringify([saved.map((a) => [a.id, a.name, urls.has(a.id), who(a)]), pending.map((p) => [p.id, p.status, Math.round((p.progress || 0) * 20), p.error]), store.userId]);
    if (signature === drawn) return;
    drawn = signature;
    const total = saved.length + pending.length;
    title.textContent = total > 0 ? t('attachment.headingCount', { count: total }) : t('attachment.heading');
    replace(list, saved.map((a) => {
      const url = urls.get(a.id);
      const previewable = isPreviewMime(a.mime);
      const thumb = url
        ? h('img', { class: 'attachment-thumb-img', src: url, alt: '' })
        : fileIcon(a.name, a.mime);
      return h('li', { class: 'attachment', dataset: { id: a.id } },
        h('button', { class: 'attachment-thumb', type: 'button', 'aria-label': previewable ? t('attachment.viewLabel', { name: a.name }) : t('attachment.openLabel', { name: a.name }), onclick: () => open(a) }, thumb),
        h('div', { class: 'attachment-main' },
          h('button', { class: 'attachment-name', type: 'button', onclick: () => open(a) }, a.name),
          h('span', { class: 'attachment-meta' }, t('attachment.meta', { size: formatBytes(a.size, getLanguage()), name: who(a), when: timeAgo(a.created_at) }))),
        h('span', { class: 'attachment-tools' },
          h('button', { class: 'button button-small', type: 'button', 'aria-label': t('attachment.saveLabel', { name: a.name }), onclick: () => save(a) }, t('attachment.save')),
          mayDelete(a) && iconButton({ name: 'trash', label: t('attachment.deleteLabel', { name: a.name }), onclick: () => remove(a) })));
    }), pending.map((p) => h('li', { class: `attachment attachment-pending attachment-${p.status}`, dataset: { id: p.id } },
      h('span', { class: 'attachment-thumb' }, fileIcon(p.name, p.mime)),
      h('div', { class: 'attachment-main' },
        h('span', { class: 'attachment-name-plain' }, p.name),
        h('span', { class: 'attachment-meta' }, `${formatBytes(p.size, getLanguage())} · ${pendingState(p)}`),
        p.status === 'uploading' && h('progress', { class: 'attachment-progress', max: 1, value: p.progress || 0, 'aria-label': t('attachment.uploading', { percent: Math.round((p.progress || 0) * 100) }) })),
      h('span', { class: 'attachment-tools' },
        p.status === 'failed' && h('button', { class: 'button button-small', type: 'button', onclick: () => manager.retry(p.id) }, t('attachment.retry')),
        h('button', { class: 'button button-small', type: 'button', 'aria-label': t('attachment.discardLabel', { name: p.name }), onclick: () => manager.discard(p.id) }, t('attachment.discard'))))));
    if (total === 0) list.append(h('li', { class: 'attachment-none' }, t('attachment.none')));
    for (const a of saved) loadPreview(a);
  }

  const unsubscribe = [store.subscribe(draw), manager.subscribe(draw)];
  draw();

  const addButton = h('button', { class: 'button button-small', type: 'button', onclick: () => input.click() }, icon('paperclip'), t('attachment.add'));
  const cameraButton = coarse ? h('button', { class: 'button button-small', type: 'button', onclick: () => camera.click() }, t('attachment.camera')) : null;
  const node = h('section', { class: 'attachments', 'aria-label': t('attachment.heading') },
    title,
    list,
    note,
    !readOnly && h('div', { class: 'attachment-actions' }, addButton, cameraButton, input, camera,
      h('label', { class: 'attachment-shrink' }, shrink, t('attachment.shrink'))));

  // Bestanden neerzetten op het onderdeel
  node.addEventListener('dragover', (e) => {
    if (readOnly || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    node.classList.add('attachments-drop');
  });
  node.addEventListener('dragleave', () => node.classList.remove('attachments-drop'));
  node.addEventListener('drop', (e) => {
    if (readOnly || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    node.classList.remove('attachments-drop');
    pick(e.dataTransfer.files);
  });

  return {
    node,
    dispose() {
      disposed = true;
      for (const stop of unsubscribe) stop();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
