// Het scherm "Gegevens exporteren": al je gegevens als JSON, alle taken als CSV, of één project als CSV (zie core/export.js).
// Alles gebeurt op dit apparaat uit de lokale gegevens. In de Android-app gaat het bestand via het opslaan-scherm van Android
// (een download van een blob werkt in een WebView niet); in een browser is het een gewone download.

import { androidBridge } from '../core/android.js';
import { allProjectsCsv, exportFileName, exportJson, projectCsv } from '../core/export.js';
import { t } from '../core/i18n.js';
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

export function exportDialog({ store, bridge = androidBridge() }) {
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
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
  }, { wide: true });
}
