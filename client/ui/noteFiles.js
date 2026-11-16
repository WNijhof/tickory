// Foto's en geluid bij een notitie (SPEC 5k), zoals in Anchor: bovenaan de notitie de foto's als raster en het geluid als speler,
// toevoegen met de knop in de werkbalk, het /-menu, plakken (een schermafdruk) of neerzetten, en geluid opnemen met de microfoon.
// Uploaden gaat via dezelfde beheerder als de bijlagen van taken (core/attachments.js): eerst lokaal bewaard, dan geüpload zodra
// de notitie op de server staat, ook na een herstart van de app.
//
// Een bestand ophalen gaat met het token (fetch, blob-URL), nooit met een gewone link. Alleen afbeeldingen en geluid van een vaste
// lijst (shared/notes.js) komen hier; de blob krijgt dat type pas hier, zodat de server ze als "bestand" kan blijven sturen.

import { formatBytes } from '../../shared/attachments.js';
import { NOTE_AUDIO_MIMES, NOTE_IMAGE_MIMES, isNoteFileMime, noteFileKind } from '../../shared/notes.js';
import { getLanguage, t } from '../core/i18n.js';
import { shrinkImage } from '../core/imageResize.js';
import { attachmentRuntime, failureText, rejectionText, saveBlob } from './attachments.js';
import { confirmDialog, h, openDialog, toast } from './dom.js';
import { icon } from './icons.js';

/** Wat de bestandskiezer aanbiedt. */
export const NOTE_FILE_ACCEPT = [...NOTE_IMAGE_MIMES, ...NOTE_AUDIO_MIMES].join(',');
/** Een opname stopt vanzelf na tien minuten. */
export const MAX_RECORDING_MS = 10 * 60 * 1000;

/** De foto's en het geluid van een notitie, in de volgorde waarin ze zijn toegevoegd. */
export function noteFilesOf(view, noteId) {
  return [...(view.note_files?.values() ?? [])]
    .filter((f) => f.note_id === noteId && isNoteFileMime(f.mime))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
}

// ---------- blob-URL's, gedeeld door de editor en de kaarten ----------

const urls = new Map(); // id -> { url, mime }
const loading = new Map(); // id -> Promise<string | null>

/** Een blob-URL voor een notitiebestand (met het juiste type, zodat een <audio> het kan afspelen), of null als ophalen mislukt. */
export function noteFileUrl(file) {
  const have = urls.get(file.id);
  if (have) return Promise.resolve(have.url);
  if (loading.has(file.id)) return loading.get(file.id);
  const runtime = attachmentRuntime();
  if (!runtime || !isNoteFileMime(file.mime)) return Promise.resolve(null);
  const p = runtime.manager.fetchBlob(file.id)
    .then((blob) => {
      const url = URL.createObjectURL(new Blob([blob], { type: file.mime }));
      urls.set(file.id, { url, mime: file.mime });
      return url;
    })
    .catch(() => null)
    .finally(() => loading.delete(file.id));
  loading.set(file.id, p);
  return p;
}
/** Al geladen? Dan meteen de URL (zonder te wachten), anders null. */
export const cachedNoteFileUrl = (id) => urls.get(id)?.url ?? null;

/** Ruimt de URL's op van bestanden die niet meer bestaan. */
export function forgetNoteFileUrls(view) {
  for (const [id, { url }] of urls) {
    if (view.note_files?.has(id)) continue;
    URL.revokeObjectURL(url);
    urls.delete(id);
    attachmentRuntime()?.manager.forgetBlob(id);
  }
}

/** De naam van een nieuwe opname: "Opname 16-11-2026 14.03.webm". */
export function recordingName(mime, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ext = mime === 'audio/mp4' ? 'm4a' : mime === 'audio/ogg' ? 'ogg' : 'webm';
  const when = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
  return `${t('note.rec.name', { when })}.${ext}`;
}

/**
 * Een geplakte afbeelding heet in de browser meestal "image.png" (of heeft geen naam): die krijgt "Schermafdruk 16-11-2026 14.03.png".
 * Een bestand met een eigen naam (gekopieerd uit een map) houdt die.
 */
export function pastedFile(file, now = new Date()) {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
  const pad = (n) => String(n).padStart(2, '0');
  const ext = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[file.type] ?? 'png';
  const when = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
  return new File([file], `${t('note.files.pastedName', { when })}.${ext}`, { type: file.type });
}

/** Het opnameformaat dat deze browser kan maken: Opus in WebM (Chrome, Firefox, Android), anders MP4 (Safari). */
function recorderMime(MR = globalThis.MediaRecorder) {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    try { if (MR.isTypeSupported?.(m)) return m; } catch { /* oude browser */ }
  }
  return '';
}

/** Kan deze browser (of de app) geluid opnemen? */
export const canRecord = () => typeof globalThis.MediaRecorder === 'function' && typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function';

/**
 * Het venster "Opnemen": vraagt de microfoon, toont de tijd en geeft bij "Stoppen en toevoegen" een bestand terug (of null).
 * @returns {Promise<File | null>}
 */
export async function recordAudio() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    toast(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? t('note.rec.denied') : t('note.rec.failed'), { kind: 'error' });
    return null;
  }
  const stopStream = () => { for (const track of stream.getTracks()) track.stop(); };
  let recorder;
  try {
    const mimeType = recorderMime();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    stopStream();
    toast(t('note.rec.failed'), { kind: 'error' });
    return null;
  }
  const chunks = [];
  recorder.addEventListener('dataavailable', (e) => { if (e.data?.size) chunks.push(e.data); });
  const started = Date.now();
  let keep = false;
  const finished = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
  recorder.start(1000);

  await openDialog((finish) => {
    const clock = h('p', { class: 'nf-rec-clock', role: 'timer', 'aria-live': 'off' }, '0:00');
    const tick = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (Date.now() - started >= MAX_RECORDING_MS) { keep = true; finish(null); }
    }, 250);
    finished.then(() => clearInterval(tick));
    return h('div', { class: 'dialog-form nf-rec' },
      h('h2', {}, t('note.rec.title')),
      h('div', { class: 'nf-rec-live' }, h('span', { class: 'nf-rec-dot', 'aria-hidden': 'true' }), clock),
      h('p', { class: 'hint' }, t('note.rec.hint')),
      h('div', { class: 'dialog-buttons' },
        h('button', { type: 'button', class: 'button', dataset: { fk: 'note-rec-cancel' }, onclick: () => finish(null) }, t('common.cancel')),
        h('button', { type: 'button', class: 'button button-primary', dataset: { fk: 'note-rec-stop' }, onclick: () => { keep = true; finish(null); } }, icon('check'), t('note.rec.stop'))));
  }, { className: 'dialog-rec' });

  if (recorder.state !== 'inactive') recorder.stop();
  await finished;
  stopStream();
  if (!keep || chunks.length === 0) return null;
  const mime = (recorder.mimeType || chunks[0].type || 'audio/webm').split(';')[0].trim().toLowerCase();
  const type = NOTE_AUDIO_MIMES.includes(mime) ? mime : 'audio/webm';
  return new File(chunks, recordingName(type), { type });
}

/**
 * Het deel van de notitie met de foto's en het geluid.
 * @param {{ store: import('../core/store.js').Store, actions: object, noteId: string, readOnly?: () => boolean }} options
 * @returns {{ el: HTMLElement, pick: (files: Iterable<File>) => Promise<void>, choose: () => void, record: () => Promise<void>, draw: () => void, destroy: () => void } | null}
 */
export function createNoteFiles({ store, actions, noteId, readOnly = () => false }) {
  const runtime = attachmentRuntime();
  if (!runtime) return null;
  const { manager } = runtime;
  let destroyed = false;
  let drawn = null;

  const pics = h('div', { class: 'nf-pics' });
  const sounds = h('ul', { class: 'nf-sounds' });
  const pendingList = h('ul', { class: 'nf-pending-list' });
  const message = h('p', { class: 'hint nf-message', role: 'status', 'aria-live': 'polite' });
  const input = h('input', { type: 'file', multiple: true, accept: NOTE_FILE_ACCEPT, hidden: true, 'aria-hidden': 'true', tabIndex: -1, dataset: { fk: 'note-file-input' } });
  input.addEventListener('change', () => { pick(input.files); input.value = ''; });
  const el = h('section', { class: 'note-files', 'aria-label': t('note.files.heading') }, pics, sounds, pendingList, message, input);

  // zonder foto's, geluid, wachtende bestanden of melding neemt het deel geen ruimte in
  const refreshHidden = () => { el.hidden = !pics.childElementCount && !sounds.childElementCount && !pendingList.childElementCount && !message.textContent; };
  const say = (text) => { message.textContent = text; refreshHidden(); };

  async function pick(fileList) {
    const files = [...fileList];
    if (files.length === 0 || readOnly()) return;
    say('');
    // foto's verkleinen (hooguit 2048 pixels, alleen grote): sneller op de kaarten en zuinig met de opslag
    const prepared = await Promise.all(files.map((f) => (f.type?.startsWith('image/') && f.type !== 'image/gif' ? shrinkImage(f) : f)));
    const { rejected } = await manager.stageNote(noteId, prepared);
    say(rejected.map((r) => (r.reason === 'notMedia' ? t('note.files.notMedia', { name: r.name }) : rejectionText(r))).join(' '));
  }

  async function view(file) {
    const images = noteFilesOf(store.view, noteId).filter((f) => noteFileKind(f.mime) === 'image');
    let index = Math.max(0, images.findIndex((f) => f.id === file.id));
    await openDialog((finish) => {
      const img = h('img', { alt: '' });
      const name = h('h2', {});
      const counter = h('span', { class: 'nf-viewer-count' });
      const show = async () => {
        const f = images[index];
        name.textContent = f.name;
        img.alt = f.name;
        counter.textContent = images.length > 1 ? `${index + 1} / ${images.length}` : '';
        img.src = cachedNoteFileUrl(f.id) ?? (await noteFileUrl(f)) ?? '';
      };
      const step = (d) => { index = (index + d + images.length) % images.length; show(); };
      const box = h('div', { class: 'dialog-form attachment-viewer nf-viewer' },
        h('div', { class: 'nf-viewer-head' }, name, counter),
        h('div', { class: 'attachment-viewer-body' }, img),
        h('div', { class: 'dialog-buttons' },
          images.length > 1 && h('button', { type: 'button', class: 'button', dataset: { fk: 'nf-prev' }, onclick: () => step(-1) }, icon('chevronLeft'), t('note.files.previous')),
          images.length > 1 && h('button', { type: 'button', class: 'button', dataset: { fk: 'nf-next' }, onclick: () => step(1) }, t('note.files.next'), icon('chevronRight')),
          h('button', { type: 'button', class: 'button', dataset: { fk: 'nf-save' }, onclick: async () => { const f = images[index]; saveBlob(await manager.fetchBlob(f.id), f.name, f.mime); } }, t('attachment.save')),
          !readOnly() && h('button', { type: 'button', class: 'button button-danger', dataset: { fk: 'nf-delete' }, onclick: async () => { if (await remove(images[index])) finish(null); } }, icon('trash'), t('note.files.deleteShort')),
          h('button', { type: 'button', class: 'button button-primary', onclick: () => finish(null) }, t('common.close'))));
      box.addEventListener('keydown', (e) => {
        if (images.length < 2) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      });
      show();
      return box;
    }, { wide: true, className: 'dialog-viewer' });
  }

  async function remove(file) {
    const ok = await confirmDialog({ title: t('note.files.deleteTitle'), text: t('note.files.deleteText', { name: file.name }), okText: t('note.files.deleteShort') });
    if (!ok) return false;
    await actions.deleteNoteFile(file.id);
    forgetNoteFileUrls(store.view);
    return true;
  }

  async function play(file, holder) {
    const url = await noteFileUrl(file);
    if (destroyed) return;
    if (!url) { say(t('note.files.loadFailed', { name: file.name })); return; }
    const audio = h('audio', { class: 'nf-audio', controls: true, src: url, preload: 'auto', 'aria-label': file.name });
    holder.replaceChildren(audio);
    audio.play?.().catch(() => { /* de gebruiker drukt zelf op afspelen */ });
  }

  const pendingState = (p) => {
    if (p.status === 'uploading') return t('attachment.uploading', { percent: Math.round((p.progress || 0) * 100) });
    if (p.status === 'failed') return t('attachment.failedWith', { reason: failureText(p.error) });
    return store.base.notes.has(noteId) ? t('attachment.waitingOffline') : t('note.files.waitingNote');
  };

  function draw() {
    if (destroyed) return;
    const files = noteFilesOf(store.view, noteId);
    const pending = manager.pendingForNote(noteId);
    const ro = readOnly();
    const signature = JSON.stringify([files.map((f) => [f.id, f.name, Boolean(cachedNoteFileUrl(f.id))]), pending.map((p) => [p.id, p.status, Math.round((p.progress || 0) * 20), p.error]), ro]);
    if (signature === drawn) return;
    drawn = signature;
    const images = files.filter((f) => noteFileKind(f.mime) === 'image');
    const audio = files.filter((f) => noteFileKind(f.mime) === 'audio');
    pics.className = `nf-pics nf-n${Math.min(images.length, 4)}`;
    pics.replaceChildren(...images.map((f) => {
      const url = cachedNoteFileUrl(f.id);
      if (!url) noteFileUrl(f).then(() => { drawn = null; draw(); });
      return h('div', { class: 'nf-pic', dataset: { id: f.id } },
        h('button', { type: 'button', class: 'nf-pic-open', 'aria-label': t('note.files.view', { name: f.name }), dataset: { fk: `nf-view:${f.id}` }, onclick: () => view(f) },
          url ? h('img', { src: url, alt: '' }) : h('span', { class: 'nf-pic-wait', 'aria-hidden': 'true' })),
        !ro && h('button', { type: 'button', class: 'nf-del', 'aria-label': t('note.files.delete', { name: f.name }), title: t('note.files.delete', { name: f.name }), dataset: { fk: `nf-delete:${f.id}` }, onclick: () => remove(f) }, '×'));
    }));
    sounds.replaceChildren(...audio.map((f) => {
      const holder = h('div', { class: 'nf-sound-player' },
        h('button', { type: 'button', class: 'nf-play', 'aria-label': t('note.files.play', { name: f.name }), dataset: { fk: `nf-play:${f.id}` }, onclick: () => play(f, holder) }, '▶'));
      return h('li', { class: 'nf-sound', dataset: { id: f.id } },
        h('span', { class: 'nf-sound-icon', 'aria-hidden': 'true' }, icon('mic')),
        h('span', { class: 'nf-sound-main' }, h('span', { class: 'nf-sound-name' }, f.name), h('span', { class: 'nf-sound-size' }, formatBytes(f.size, getLanguage()))),
        holder,
        !ro && h('button', { type: 'button', class: 'nf-del nf-del-row', 'aria-label': t('note.files.delete', { name: f.name }), title: t('note.files.delete', { name: f.name }), dataset: { fk: `nf-delete:${f.id}` }, onclick: () => remove(f) }, '×'));
    }));
    pendingList.replaceChildren(...pending.map((p) => h('li', { class: `nf-pending nf-${p.status}`, dataset: { id: p.id } },
      h('span', { class: 'nf-sound-icon', 'aria-hidden': 'true' }, icon(p.mime.startsWith('audio/') ? 'mic' : 'paperclip')),
      h('span', { class: 'nf-sound-main' },
        h('span', { class: 'nf-sound-name' }, p.name),
        h('span', { class: 'nf-sound-size' }, `${formatBytes(p.size, getLanguage())} · ${pendingState(p)}`),
        p.status === 'uploading' && h('progress', { class: 'attachment-progress', max: 1, value: p.progress || 0 })),
      p.status === 'failed' && h('button', { type: 'button', class: 'button button-small', onclick: () => manager.retry(p.id) }, t('attachment.retry')),
      h('button', { type: 'button', class: 'button button-small', 'aria-label': t('attachment.discardLabel', { name: p.name }), onclick: () => manager.discard(p.id) }, t('attachment.discard')))));
    refreshHidden();
  }

  const stops = [store.subscribe(draw), manager.subscribe(draw)];
  draw();

  return {
    el,
    pick,
    draw,
    /** De bestandskiezer openen (foto's, ook van de camera op een telefoon, en geluid). */
    choose: () => { if (!readOnly()) input.click(); },
    async record() {
      if (readOnly()) return;
      const file = await recordAudio();
      if (file) await pick([file]);
    },
    destroy() {
      destroyed = true;
      for (const stop of stops) stop();
    },
  };
}
