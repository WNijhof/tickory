// Het venster "Importeren": de back-up van Todoist (zip), losse CSV-bestanden of de eigen export kiezen, per project zien wat er
// meekomt en wat niet, kiezen welke projecten mee moeten en waar ze komen, en dan importeren (per project één reeks commando's in
// de wachtrij, met voortgang). Het lezen staat in core/todoistImport.js, het omzetten in core/importPlan.js; zie SPEC.md, 5h.
// Alles gebeurt op dit apparaat: er wordt niets opgehaald of uitgevoerd, en tekst uit de bestanden blijft tekst.

import { importQuotaProblem, planImport } from '../core/importPlan.js';
import { t } from '../core/i18n.js';
import { IMPORT_LIMITS, isImportFile, readImport } from '../core/todoistImport.js';
import { ZIP_LIMITS } from '../core/zip.js';
import { h, openDialog, replace, toast } from './dom.js';

/** Waarom een bestand niet te lezen is, in gewone taal. */
export function importProblemText({ name, code }) {
  switch (code) {
    case 'zip.notZip': return t('import.problem.zipNotZip', { name });
    case 'zip.corrupt': return t('import.problem.zipCorrupt', { name });
    case 'zip.encrypted': return t('import.problem.zipEncrypted', { name });
    case 'zip.zip64': return t('import.problem.zipLarge', { name });
    case 'zip.tooMany': return t('import.problem.zipTooMany', { name });
    case 'zip.tooBig': return t('import.problem.tooBig', { name });
    case 'zip.noCsv': return t('import.problem.zipNoCsv', { name });
    case 'tooBig': return t('import.problem.tooBig', { name });
    case 'tooManyFiles': return t('import.problem.tooManyFiles', { name, limit: IMPORT_LIMITS.files });
    case 'tooManyRows': return t('import.problem.tooManyRows', { name, limit: IMPORT_LIMITS.rows });
    case 'tooManyProjects': return t('import.problem.tooManyProjects', { name, limit: IMPORT_LIMITS.projects });
    case 'empty': return t('import.problem.empty', { name });
    case 'notTodoist': return t('import.problem.notTodoist', { name });
    case 'notJson': return t('import.problem.notJson', { name });
    case 'template': return t('import.problem.template', { name });
    case 'unsupported': return t('import.problem.unsupported', { name });
    case 'noTasks': return t('import.problem.noTasks', { name });
    default: return t('import.problem.unreadable', { name });
  }
}

/** Waarom de import niet past binnen de grenzen van de server. */
export function importQuotaText(problem) {
  const { have, need, limit, project = '' } = problem;
  switch (problem.code) {
    case 'projects': return t('import.quota.projects', { have, need, limit });
    case 'sections': return t('import.quota.sections', { need, limit, project });
    case 'tasksPerProject': return t('import.quota.tasksPerProject', { need, limit, project });
    case 'tasksPerUser': return t('import.quota.tasksPerUser', { have, need, limit });
    default: return t('import.quota.labels', { have, need, limit });
  }
}

/** Wat er bij een project niet (helemaal) mee kon, als korte zinnen. */
export function issueTexts(stats) {
  const out = [];
  if (stats.dates) out.push(t('import.issue.dates', { count: stats.dates }));
  if (stats.deadlines) out.push(t('import.issue.deadlines', { count: stats.deadlines }));
  if (stats.durations) out.push(t('import.issue.durations', { count: stats.durations }));
  if (stats.attachments) out.push(t('import.issue.attachments', { count: stats.attachments }));
  if (stats.completed) out.push(t('import.issue.completed', { count: stats.completed }));
  if (stats.flattened) out.push(t('import.issue.flattened', { count: stats.flattened, depth: IMPORT_LIMITS.depth }));
  if (stats.truncated) out.push(t('import.issue.truncated', { count: stats.truncated }));
  if (stats.commentsDropped) out.push(t('import.issue.commentsDropped', { count: stats.commentsDropped, limit: IMPORT_LIMITS.comments }));
  if (stats.skippedRows) out.push(t('import.issue.skippedRows', { count: stats.skippedRows }));
  return out;
}

/** "3 secties, 42 taken, 5 opmerkingen, 4 labels" (wat nul is, valt weg; taken altijd). */
export function countsText(project) {
  const s = project.stats;
  const parts = [];
  if (s.sections) parts.push(t('import.count.sections', { count: s.sections }));
  parts.push(t('import.count.tasks', { count: s.tasks }));
  if (s.comments) parts.push(t('import.count.comments', { count: s.comments }));
  if (s.labels.length) parts.push(t('import.count.labels', { count: s.labels.length }));
  return parts.join(', ');
}

/** De naam met de ouders ervoor ("Werk › Klanten"), zoals het in de zijbalk komt. */
function pathOf(project, byKey) {
  const parts = [project.name];
  for (let cur = byKey.get(project.parentKey), guard = 0; cur && guard < 20; cur = byKey.get(cur.parentKey), guard++) parts.unshift(cur.name);
  return parts.join(' › ');
}

/** Zijn al deze (gedeelde) bestanden om te importeren (een zip, een CSV van Todoist, de eigen export)? Kijkt naar het begin van elk. */
export async function allImportable(files) {
  if (files.length === 0) return false;
  for (const file of files) {
    try {
      if (!isImportFile(new Uint8Array(await file.slice(0, 4096).arrayBuffer()))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Leest gekozen bestanden als bytes; een te groot bestand wordt niet eens gelezen. */
async function readFiles(files) {
  const out = [];
  const tooBig = [];
  for (const file of files) {
    const max = /\.zip$/i.test(file.name) ? ZIP_LIMITS.archiveBytes : IMPORT_LIMITS.fileBytes;
    if (file.size > max) {
      tooBig.push({ name: file.name, code: 'tooBig' });
      continue;
    }
    try {
      out.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    } catch {
      tooBig.push({ name: file.name, code: 'unreadable' });
    }
  }
  return { inputs: out, problems: tooBig };
}

/**
 * Het importvenster. `files`: bestanden om meteen te lezen (bijvoorbeeld gedeeld vanuit een andere app).
 * Geeft na een gelukte import `{ counts, rootIds, undo }`, anders null.
 */
export function importDialog({ store, actions, files = null }) {
  return openDialog((finish) => {
    let projects = [];
    let busy = false;
    const chosen = new Set();
    const input = h('input', {
      type: 'file', multiple: true, class: 'field', dataset: { role: 'import-file' },
      accept: '.zip,.csv,.json,application/zip,application/x-zip-compressed,text/csv,application/json',
      'aria-label': t('import.fileLabel'), 'aria-describedby': 'import-file-hint',
    });
    const result = h('div', { class: 'import-result', 'aria-live': 'polite' });
    const status = h('p', { class: 'import-status', role: 'status' });
    const warning = h('div', { class: 'import-warning' });
    const progress = h('progress', { class: 'import-progress', max: 1, value: 0, hidden: true, 'aria-label': t('import.progressLabel') });
    const submit = h('button', { type: 'submit', class: 'button button-primary', disabled: true, dataset: { role: 'import-submit' } }, t('import.submit'));
    const cancel = h('button', { type: 'button', class: 'button', onclick: () => { if (!busy) finish(null); } }, t('common.cancel'));
    const umbrella = h('input', { type: 'text', class: 'field import-umbrella', maxLength: 200, autocomplete: 'off', value: t('import.umbrellaName'), 'aria-label': t('import.umbrellaLabel'), dataset: { role: 'import-umbrella' } });
    const placeUnder = h('input', { type: 'radio', name: 'import-place', value: 'under', checked: true, dataset: { role: 'import-under' } });
    const placeLoose = h('input', { type: 'radio', name: 'import-place', value: 'loose', dataset: { role: 'import-loose' } });
    const place = h('fieldset', { class: 'import-place', hidden: true },
      h('legend', {}, t('import.placeLegend')),
      h('label', { class: 'import-choice' }, placeUnder, h('span', {}, t('import.placeUnder'))),
      h('div', { class: 'import-umbrella-row' }, umbrella),
      h('label', { class: 'import-choice' }, placeLoose, h('span', {}, t('import.placeLoose'))));

    const options = () => ({
      selected: chosen, inboxName: t('import.inboxName'),
      under: placeUnder.checked ? (umbrella.value.trim() || t('import.umbrellaName')) : null,
    });
    /** Telt wat de gekozen projecten kosten, en zet de knop en de waarschuwing. */
    const refresh = () => {
      const picked = projects.filter((p) => chosen.has(p.key));
      umbrella.disabled = !placeUnder.checked;
      if (picked.length === 0) {
        submit.disabled = true;
        replace(warning);
        status.textContent = projects.length > 0 ? t('import.noneChosen') : '';
        return;
      }
      const plan = planImport(store.view, projects, { ...options(), makeId: () => 'x', resolveLabels: (names) => actions.resolveLabels(names) });
      const problem = importQuotaProblem(store.view, store.userId, plan);
      const tasks = picked.reduce((n, p) => n + p.stats.tasks, 0);
      status.textContent = t('import.summary', { projects: t('import.count.projects', { count: picked.length }), tasks: t('import.count.tasks', { count: tasks }) });
      replace(warning, problem && h('p', { class: 'error', role: 'alert' }, `${importQuotaText(problem)} ${t('import.quota.fewer')}`));
      submit.disabled = Boolean(problem) || busy;
    };

    const projectItem = (project, byKey) => {
      const box = h('input', { type: 'checkbox', checked: chosen.has(project.key), dataset: { key: project.key } });
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(project.key);
        else chosen.delete(project.key);
        refresh();
      });
      const issues = issueTexts(project.stats);
      const people = [];
      if (project.people.authors.length) people.push(t('import.people.authors', { names: project.people.authors.join(', ') }));
      if (project.people.responsible.length) people.push(t('import.people.responsible', { names: project.people.responsible.join(', ') }));
      return h('li', { class: 'import-item' },
        h('label', { class: 'import-item-head' }, box, h('span', { class: 'import-name' }, pathOf(project, byKey))),
        h('p', { class: 'import-counts' }, countsText(project)),
        issues.length > 0 && h('ul', { class: 'import-issues' }, issues.map((text) => h('li', {}, text))),
        people.length > 0 && h('p', { class: 'import-people hint' }, `${people.join(' · ')} ${t('import.people.note')}`));
    };

    const show = ({ projects: found, problems, skipped }) => {
      projects = found;
      chosen.clear();
      for (const p of projects) chosen.add(p.key);
      const byKey = new Map(projects.map((p) => [p.key, p]));
      const selectAll = (on) => {
        for (const p of projects) on ? chosen.add(p.key) : chosen.delete(p.key);
        for (const box of result.querySelectorAll('.import-item input[type="checkbox"]')) box.checked = on;
        refresh();
      };
      place.hidden = projects.length === 0;
      replace(result,
        problems.map((p) => h('p', { class: 'error', role: 'alert' }, importProblemText(p))),
        skipped.length > 0 && h('p', { class: 'hint' }, t('import.skippedFiles', { count: skipped.length })),
        projects.length > 0 && h('fieldset', { class: 'import-projects' },
          h('legend', {}, t('import.projectsLegend', { count: projects.length })),
          h('div', { class: 'import-select' },
            h('button', { type: 'button', class: 'button button-small', onclick: () => selectAll(true) }, t('import.selectAll')),
            h('button', { type: 'button', class: 'button button-small', onclick: () => selectAll(false) }, t('import.selectNone'))),
          h('ul', { class: 'import-list' }, projects.map((p) => projectItem(p, byKey)))));
      refresh();
    };

    const load = async (list) => {
      replace(result, h('p', { class: 'hint' }, t('common.loading')));
      replace(warning);
      status.textContent = '';
      submit.disabled = true;
      const { inputs, problems } = await readFiles(list);
      const read = await readImport(inputs);
      show({ ...read, problems: [...problems, ...read.problems] });
    };
    input.addEventListener('change', () => {
      if (busy || !input.files?.length) return;
      load([...input.files]);
    });
    placeUnder.addEventListener('change', refresh);
    placeLoose.addEventListener('change', refresh);
    umbrella.addEventListener('input', refresh);
    if (files?.length) queueMicrotask(() => load(files));

    return h('form', {
      class: 'dialog-form import-dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        if (busy || submit.disabled) return;
        busy = true;
        submit.disabled = true;
        input.disabled = true;
        progress.hidden = false;
        progress.value = 0;
        const res = await actions.importProjects(projects, options(), (done, total, name) => {
          progress.max = total;
          progress.value = done;
          status.textContent = t('import.progress', { done, total, name });
        });
        busy = false;
        input.disabled = false;
        if (!res.ok) {
          progress.hidden = true;
          replace(warning, h('p', { class: 'error', role: 'alert' }, `${importQuotaText(res.problem)} ${t('import.quota.fewer')}`));
          refresh();
          return;
        }
        finish(res);
      },
    },
    h('h2', {}, t('import.title')),
    h('p', {}, t('import.intro')),
    h('p', { class: 'hint', id: 'import-file-hint' }, t('import.howTo')),
    h('label', { class: 'field-label' }, t('import.fileLabel'), input),
    h('p', { class: 'hint' }, t('import.safety')),
    result,
    place,
    warning,
    progress,
    status,
    h('div', { class: 'dialog-buttons' }, cancel, submit));
  }, { wide: true, className: 'dialog-import' });
}

/** Na een gelukte import: naar het (eerste) geïmporteerde project, met een melding met "Ongedaan maken". */
export function announceImport(made, navigate = () => {}) {
  if (!made) return;
  if (made.rootIds[0]) navigate({ type: 'project', id: made.rootIds[0] });
  toast(t('import.done', { projects: t('import.count.projects', { count: made.counts.projects }), tasks: t('import.count.tasks', { count: made.counts.tasks }) }), {
    action: { label: t('task.undo'), run: () => made.undo() }, timeout: 15_000,
  });
}
