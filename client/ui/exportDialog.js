// Het scherm "Gegevens exporteren": al je gegevens als JSON, alle taken als CSV, één project als CSV, elk project als eigen CSV in
// een zip, of de bijlagen zelf in een zip (zie core/export.js en core/zipWrite.js).
// Alles gebeurt op dit apparaat uit de lokale gegevens. In de Android-app gaat het bestand via het opslaan-scherm van Android
// (een download van een blob werkt in een WebView niet); in een browser is het een gewone download.

import { androidBridge } from '../core/android.js';
import { allProjectsCsv, attachmentEntries, exportFileName, exportJson, projectCsv, projectFiles } from '../core/export.js';
import { getLanguage, t } from '../core/i18n.js';
import { zipParts } from '../core/zipWrite.js';
import { formatBytes } from '../../shared/attachments.js';
import { projectList } from '../core/selectors.js';
import { h, openDialog, toast } from './dom.js';

const INDENT = ' ';

/** Slaat tekst op als bestand: via de Android-app als die er is, anders als download. Geeft true als het is gestart. */
export function saveTextFile({ name, mime, text, bridge = androidBridge() }) {
  if (bridge.canSaveText?.()) {
    bridge.saveText(name, mime, text);
    return true;
  }
  try {
    // Excel leest een CSV pas als UTF-8 (met é en ï goed) als er een BOM voor staat
    const body = mime.startsWith('text/csv') ? `﻿${text}` : text;
    const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }));
    const link = h('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch {
    return false;
  }
}

/** Zo groot mag een zip in de Android-app zijn (hij gaat als base64 over de brug); in een browser veel groter. */
export const ZIP_MAX_ANDROID = 40 * 1024 * 1024;
export const ZIP_MAX_BROWSER = 1024 * 1024 * 1024;

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/**
 * Slaat een binair bestand (Blob) op: via de Android-app als base64, anders als download. Geeft 'ok', 'tooBig' (te groot voor de
 * app), 'old' (een app die dit nog niet kan) of 'failed'.
 */
export async function saveBlobFile({ name, blob, bridge = androidBridge() }) {
  if (bridge.available) {
    if (!bridge.canSaveBase64?.()) return 'old';
    if (blob.size > ZIP_MAX_ANDROID) return 'tooBig';
    try {
      bridge.saveBase64(name, blob.type || 'application/zip', await toBase64(blob));
      return 'ok';
    } catch {
      return 'failed';
    }
  }
  try {
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return 'ok';
  } catch {
    return 'failed';
  }
}

export function exportDialog({ store, bridge = androidBridge(), attachments = null }) {
  const names = (id) => (id ? store.userName(id) ?? '' : '');
  const done = (ok) => toast(ok ? t('export.started') : t('export.failed'), ok ? {} : { kind: 'error' });
  return openDialog((finish) => {
    const projects = projectList(store.view);
    const project = h('select', { class: 'field', 'aria-label': t('export.projectLabel') },
      projects.map(({ project: p, depth }) => h('option', { value: p.id }, `${INDENT.repeat(depth)}${p.name}`)));
    const json = () => {
      const text = JSON.stringify(exportJson(store.view, store.me), null, 2);
      done(saveTextFile({ name: exportFileName('export', 'json'), mime: 'application/json', text, bridge }));
    };
    const csvAll = () => done(saveTextFile({ name: exportFileName('taken', 'csv'), mime: 'text/csv', text: allProjectsCsv(store.view, names), bridge }));
    const csvOne = () => {
      const p = store.view.projects.get(project.value);
      if (!p) return;
      done(saveTextFile({ name: exportFileName(p.name, 'csv'), mime: 'text/csv', text: projectCsv(store.view, p.id, names), bridge }));
    };
    const status = h('p', { class: 'hint export-status', role: 'status', 'aria-live': 'polite' });
    const reportZip = (result, extra = '') => {
      if (result === 'ok') toast([t('export.started'), extra].filter(Boolean).join(' '));
      else toast(result === 'tooBig' ? t('export.zipTooBigApp', { max: formatBytes(ZIP_MAX_ANDROID, getLanguage()) }) : result === 'old' ? t('export.zipOldApp') : t('export.failed'), { kind: 'error' });
    };
    const zipProjects = async () => {
      const blob = new Blob(zipParts(projectFiles(store.view, names)), { type: 'application/zip' });
      reportZip(await saveBlobFile({ name: exportFileName('projecten', 'zip'), blob, bridge }));
    };
    let busy = false;
    const zipAttachments = async (button) => {
      if (busy || !attachments) return;
      const entries = attachmentEntries(store.view, { notesFolder: t('note.title'), commentsFolder: t('comment.heading') });
      if (entries.length === 0) {
        status.textContent = t('export.attachmentsNone');
        return;
      }
      const total = entries.reduce((n, e) => n + e.size, 0);
      const max = bridge.available ? ZIP_MAX_ANDROID : ZIP_MAX_BROWSER;
      if (total > max) {
        status.textContent = t('export.attachmentsTooBig', { size: formatBytes(total, getLanguage()), max: formatBytes(max, getLanguage()) });
        return;
      }
      busy = true;
      button.disabled = true;
      const files = [];
      let missing = 0;
      try {
        for (const [i, e] of entries.entries()) {
          status.textContent = t('export.attachmentsProgress', { done: i, total: entries.length });
          try {
            const blob = await attachments.fetchBlob(e.id);
            files.push({ name: e.path, data: new Uint8Array(await blob.arrayBuffer()) });
          } catch {
            missing += 1;
          }
        }
        status.textContent = '';
        if (files.length === 0) {
          toast(t('export.failed'), { kind: 'error' });
          return;
        }
        const blob = new Blob(zipParts(files), { type: 'application/zip' });
        reportZip(await saveBlobFile({ name: exportFileName('bijlagen', 'zip'), blob, bridge }), missing > 0 ? t('export.attachmentsMissing', { count: missing }) : '');
      } finally {
        busy = false;
        button.disabled = false;
      }
    };
    return h('div', { class: 'dialog-form' },
      h('h2', {}, t('export.title')),
      h('p', { class: 'hint' }, t('export.intro')),
      h('div', { class: 'section-form' },
        h('button', { type: 'button', class: 'button', dataset: { role: 'export-json' }, onclick: json }, t('export.json')),
        h('p', { class: 'hint' }, t('export.jsonHint'))),
      h('div', { class: 'section-form' },
        h('button', { type: 'button', class: 'button', dataset: { role: 'export-csv-all' }, onclick: csvAll }, t('export.csvAll')),
        h('p', { class: 'hint' }, t('export.csvHint'))),
      h('div', { class: 'section-form' },
        h('label', { class: 'field-label' }, t('export.projectLabel'), project),
        h('button', { type: 'button', class: 'button', dataset: { role: 'export-csv-project' }, onclick: csvOne }, t('export.csvProject'))),
      h('div', { class: 'section-form' },
        h('button', { type: 'button', class: 'button', dataset: { role: 'export-zip-projects' }, onclick: zipProjects }, t('export.zipProjects')),
        h('p', { class: 'hint' }, t('export.zipProjectsHint'))),
      attachments && h('div', { class: 'section-form' },
        h('button', { type: 'button', class: 'button', dataset: { role: 'export-zip-attachments' }, onclick: (e) => zipAttachments(e.currentTarget) }, t('export.zipAttachments')),
        h('p', { class: 'hint' }, t('export.zipAttachmentsHint')),
        status),
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
  }, { wide: true });
}
