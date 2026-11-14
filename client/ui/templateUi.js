// Sjablonen in de interface: een project of taken uit een sjabloon maken (met voorbeeldweergave en startdatum), een project of taak
// als sjabloon bewaren, sjablonen delen via een bestand (of kopiëren en plakken) en importeren. De logica staat in core/templates.js
// en core/templateFile.js, de commando's in core/actions.js. Alle tekst gaat als tekst het document in (nooit als HTML).

import { addDays, formatDate, todayString } from '../core/format.js';
import { t } from '../core/i18n.js';
import { colorClass } from '../core/colors.js';
import { quickDates } from '../core/quickDates.js';
import { byOrder, projectList } from '../core/selectors.js';
import { exportTemplate, parseTemplateFile, templateFileName } from '../core/templateFile.js';
import { dateSpan, labelNamesOf, previewLines, relativeDayText, templateFromProject, templateFromTask, templateList } from '../core/templates.js';
import { starterTemplates } from '../core/starters/index.js';
import { TEMPLATE_LIMITS, templateStats } from '../../shared/template.js';
import { nameKey } from '../../shared/text.js';
import { confirmDialog, h, openDialog, promptDialog, replace, toast } from './dom.js';
import { icon } from './icons.js';

const INDENT = String.fromCharCode(160, 160);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- teksten bij fouten en samenvattingen ----------

/** Een grens van de server die het aanmaken zou overschrijden, als zin (zie quotaProblem in core/templates.js). */
export function quotaText(problem) {
  const { have, need, limit } = problem;
  switch (problem.code) {
    case 'projects': return t('template.quota.projects', { have, need, limit });
    case 'sections': return t('template.quota.sections', { have, need, limit });
    case 'tasksPerProject': return t('template.quota.tasksPerProject', { have, need, limit });
    case 'tasksPerUser': return t('template.quota.tasksPerUser', { have, need, limit });
    case 'labels': return t('template.quota.labels', { have, need, limit });
    case 'reminders': return t('template.quota.reminders', { have, need, limit });
    default: return t('template.quota.templates', { have, need, limit });
  }
}

/** Waarom een project of taak (nog) geen sjabloon kan worden. */
export function problemText(problem) {
  switch (problem.code) {
    case 'empty': return t('template.problem.empty');
    case 'tooMany': return t('template.problem.tooMany', { count: problem.count ?? TEMPLATE_LIMITS.tasks, limit: problem.limit ?? TEMPLATE_LIMITS.tasks });
    case 'tooBig': return t('template.problem.tooBig', { kib: Math.round(TEMPLATE_LIMITS.bytes / 1024) });
    case 'gone': return t('template.problem.gone');
    default: return t('template.problem.invalid');
  }
}

/** Waarom een bestand niet als sjabloon te lezen was. */
export function importProblemText(result) {
  switch (result.code) {
    case 'empty': return t('template.import.empty');
    case 'tooBig': return t('template.import.tooBig', { kib: Math.round(TEMPLATE_LIMITS.fileBytes / 1024) });
    case 'notJson': return t('template.import.notJson');
    case 'unsupported': return t('template.import.unsupported');
    case 'tooMany': return t('template.import.tooMany', { limit: TEMPLATE_LIMITS.tasks });
    default: return t('template.import.invalid');
  }
}

/** "16 taken in 5 secties" */
export function sizeText(stats) {
  return stats.sections > 0
    ? t('template.size', { tasks: t('template.tasksCount', { count: stats.tasks }), sections: t('template.sectionsCount', { count: stats.sections }) })
    : t('template.tasksCount', { count: stats.tasks });
}

const kindLabel = (kind) => (kind === 'task' ? t('template.kind.task') : t('template.kind.project'));

/** Hoe een datum in de voorbeeldweergave staat: de echte dag bij een gekozen startdatum, anders de relatieve dag. */
function whenText(line, startDate, today) {
  if (line.day === undefined) return line.recurring ? t('template.repeats') : '';
  // met een startdatum: de echte dag, met de relatieve dag erachter ("za 21 nov (+1 week)"); zonder: alleen de relatieve dag
  const text = startDate
    ? `${formatDate(addDays(startDate, line.day), today)}${line.time ? ` ${line.time}` : ''} (${relativeDayText(line.day)})`
    : relativeDayText(line.day, line.time ?? '');
  return line.recurring ? `↻ ${text}` : text;
}

/** De voorbeeldweergave: de eerste regels, met secties en subtaken ingesprongen. */
function previewList(content, { startDate, today, limit = 10 }) {
  const { lines, more } = previewLines(content, limit);
  return h('div', { class: 'tpl-preview' },
    h('ul', { class: 'tpl-preview-list', 'aria-label': t('template.previewLabel') }, lines.map((line) => (line.kind === 'section'
      ? h('li', { class: 'tpl-preview-section' }, line.text)
      : h('li', { class: 'tpl-preview-task', dataset: { depth: String(line.depth) } },
        h('span', { class: 'tpl-preview-text' }, line.text),
        whenText(line, startDate, today) && h('span', { class: 'chip tpl-when' }, whenText(line, startDate, today)))))),
    more > 0 && h('p', { class: 'hint' }, t('template.previewMore', { count: more })));
}

// ---------- een bestand bewaren of kopiëren ----------

/** Zet tekst als bestand klaar om te bewaren (een tijdelijke link naar het geheugen; er gaat niets over het netwerk). */
function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = h('a', { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copyText(text, field) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    field.focus(); // zonder toestemming van de browser: de tekst staat geselecteerd, en met Ctrl+C is hij zo te kopiëren
    field.select();
    return false;
  }
}

/** Het venster om een sjabloon te delen: als bestand bewaren of de tekst kopiëren. */
export function shareTemplateDialog(template) {
  const text = exportTemplate(template);
  return openDialog((finish) => {
    const field = h('textarea', { class: 'field tpl-export', readOnly: true, rows: 5, spellcheck: false, 'aria-label': t('template.share.textLabel'), value: text });
    const status = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    return h('div', { class: 'dialog-form' },
      h('h2', {}, t('template.share.title', { name: template.name })),
      h('p', {}, t('template.share.intro')),
      h('p', { class: 'hint' }, t('template.share.privacy')),
      h('div', { class: 'tpl-share-buttons' },
        h('button', { type: 'button', class: 'button button-primary', onclick: () => { downloadText(templateFileName(template.name), text); status.textContent = t('template.share.saved', { file: templateFileName(template.name) }); } }, t('template.share.saveFile')),
        h('button', { type: 'button', class: 'button', onclick: async () => { status.textContent = (await copyText(text, field)) ? t('template.share.copied') : t('template.share.copyFailed'); } }, t('template.share.copy'))),
      status,
      field,
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
  });
}

// ---------- een sjabloon importeren ----------

/** Het venster om een bestand (JSON van Tickory of CSV van Todoist) of geplakte tekst als sjabloon te bewaren. Geeft het nieuwe id of null. */
export function importTemplateDialog({ actions }) {
  return openDialog((finish) => {
    let parsed = null;
    const file = h('input', { type: 'file', accept: '.json,.csv,application/json,text/csv', class: 'field', 'aria-label': t('template.import.fileLabel') });
    const paste = h('textarea', { class: 'field tpl-export', rows: 4, spellcheck: false, 'aria-label': t('template.import.pasteLabel'), placeholder: t('template.import.pastePlaceholder') });
    const name = h('input', { type: 'text', class: 'field', maxLength: TEMPLATE_LIMITS.templateName, autocomplete: 'off', 'aria-label': t('common.name') });
    const nameField = h('label', { class: 'field-label', hidden: true }, t('common.name'), name);
    const result = h('div', { class: 'tpl-import-result', 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'button button-primary', disabled: true }, t('common.save'));
    const show = (parse, fallbackName) => {
      parsed = parse.ok ? parse : null;
      save.disabled = !parsed;
      nameField.hidden = !parsed;
      if (!parse.ok) {
        replace(result, h('p', { class: 'error', role: 'alert' }, importProblemText(parse)), parse.detail && parse.code === 'invalid' ? h('p', { class: 'hint' }, `${t('template.import.detail')} ${parse.detail}`) : null);
        return;
      }
      name.value = parse.template.name || fallbackName;
      const stats = templateStats(parse.template.content);
      const notes = [];
      if (parse.notes.dates) notes.push(t('template.import.noteDates', { count: parse.notes.dates }));
      if (parse.notes.comments) notes.push(t('template.import.noteComments', { count: parse.notes.comments }));
      replace(result,
        h('p', {}, t('template.import.ok', { kind: kindLabel(parse.template.kind), size: sizeText(stats) })),
        notes.length > 0 && h('p', { class: 'hint' }, notes.join(' ')),
        previewList(parse.template.content, { startDate: null, today: todayString(), limit: 6 }));
    };
    const readText = (text, fallbackName) => show(parseTemplateFile(text, { fallbackName }), fallbackName);
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      paste.value = '';
      if (chosen.size > TEMPLATE_LIMITS.fileBytes) {
        show({ ok: false, code: 'tooBig', detail: '' });
        return;
      }
      let text;
      try {
        text = await chosen.text();
      } catch {
        show({ ok: false, code: 'invalid', detail: '' });
        return;
      }
      readText(text, chosen.name.replace(/\.[^.]*$/, ''));
    });
    paste.addEventListener('input', () => {
      file.value = '';
      if (paste.value.trim() === '') {
        parsed = null;
        save.disabled = true;
        nameField.hidden = true;
        replace(result);
        return;
      }
      readText(paste.value, '');
    });
    return h('form', {
      class: 'dialog-form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!parsed) return;
        const label = name.value.trim();
        if (!label) {
          name.focus();
          return;
        }
        const saved = await actions.saveTemplate({ ...parsed.template, name: label });
        if (!saved.ok) {
          replace(result, h('p', { class: 'error', role: 'alert' }, quotaText(saved.problem)));
          return;
        }
        toast(t('template.saved', { name: label }));
        finish(saved.id);
      },
    },
    h('h2', {}, t('template.import.title')),
    h('p', {}, t('template.import.intro')),
    h('label', { class: 'field-label' }, t('template.import.fileLabel'), file),
    h('p', { class: 'hint' }, t('template.import.pasteHint')),
    paste,
    h('p', { class: 'hint' }, t('template.import.safety')),
    nameField,
    result,
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      save));
  });
}

// ---------- bewaren als sjabloon ----------

/**
 * Vraagt naam en keuzes en bewaart een project of een taak als sjabloon.
 * @param {{ store: object, actions: object, project?: object, task?: object }} options één van `project` en `task`
 * @returns {Promise<string | null>} het id van het nieuwe sjabloon, of null
 */
export function saveAsTemplateDialog({ store, actions, project = null, task = null }) {
  const source = project ?? task;
  const inSection = task?.section_id ? store.view.sections.get(task.section_id) : null;
  return openDialog((finish) => {
    const name = h('input', { type: 'text', class: 'field', required: true, maxLength: TEMPLATE_LIMITS.templateName, autocomplete: 'off', autofocus: true, value: project ? project.name : task.content.slice(0, TEMPLATE_LIMITS.templateName), 'aria-label': t('common.name') });
    const description = h('textarea', { class: 'field', rows: 2, maxLength: TEMPLATE_LIMITS.templateDescription, 'aria-label': t('template.save.descriptionLabel'), placeholder: t('template.save.descriptionPlaceholder') });
    const dates = h('input', { type: 'checkbox', checked: true });
    const withSection = h('input', { type: 'checkbox', checked: true });
    const error = h('p', { class: 'error', role: 'alert' });
    const overview = h('p', { class: 'hint' });
    const build = () => (project
      ? templateFromProject(store.view, project.id, { name: name.value, description: description.value, dates: dates.checked, userId: store.userId })
      : templateFromTask(store.view, task.id, { name: name.value, description: description.value, dates: dates.checked, withSection: withSection.checked, userId: store.userId }));
    const refresh = () => {
      const built = build();
      overview.textContent = built.template ? t('template.save.overview', { size: sizeText(templateStats(built.template.content)) }) : problemText(built.problem);
      overview.classList.toggle('hint-bad', !built.template);
    };
    for (const control of [dates, withSection]) control.addEventListener('change', refresh);
    refresh();
    return h('form', {
      class: 'dialog-form',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        if (!name.value.trim()) {
          name.focus();
          return;
        }
        const built = build();
        if (!built.template) {
          error.textContent = problemText(built.problem);
          return;
        }
        const saved = await actions.saveTemplate(built.template);
        if (!saved.ok) {
          error.textContent = quotaText(saved.problem);
          return;
        }
        toast(t('template.saved', { name: built.template.name }));
        finish(saved.id);
      },
    },
    h('h2', {}, project ? t('template.save.titleProject', { name: source.name }) : t('template.save.titleTask')),
    h('label', { class: 'field-label' }, t('template.save.nameLabel'), name),
    h('label', { class: 'field-label' }, t('template.save.descriptionLabel'), description),
    h('label', { class: 'check-row' }, dates, t('template.save.dates')),
    task && inSection && h('label', { class: 'check-row' }, withSection, t('template.save.withSection', { name: inSection.name })),
    h('p', { class: 'hint' }, project ? t('template.save.whatProject') : t('template.save.whatTask')),
    overview,
    error,
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary' }, t('template.save.submit'))));
  });
}

// ---------- kiezen, bekijken en gebruiken ----------

/**
 * Het venster met de sjablonen: kiezen, bekijken wat je krijgt (aantal taken en secties, de eerste regels), de startdatum kiezen en
 * aanmaken. `mode`: 'project' (nieuw project), 'task' (taken in een bestaand project; `context.projectId` en `context.sectionId`
 * zijn het begin) of 'manage' (alleen bekijken, delen, hernoemen, verwijderen en importeren).
 * @returns {Promise<{ kind: 'project' | 'tasks', id: string, name: string, counts: object } | null>}
 */
export function templatesDialog({ store, actions, mode, context = {} }) {
  let unsubscribe = () => {};
  return openDialog((finish) => {
    const today = todayString();
    const dates = quickDates(today);
    const state = { selected: null, startMode: 'date', startDate: dates.today, busy: false };

    const catalog = () => {
      const kind = mode === 'manage' ? null : mode;
      const starters = starterTemplates().filter((x) => !kind || x.kind === kind);
      const own = templateList(store.view, store.userId, kind);
      return { starters, own, all: [...starters, ...own] };
    };
    const current = () => catalog().all.find((x) => x.id === state.selected) ?? null;

    const list = h('div', { class: 'tpl-list' });
    const detail = h('div', { class: 'tpl-detail' });
    const status = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', class: 'button button-primary' }, mode === 'project' ? t('template.use.project') : t('template.use.task'));
    const error = h('p', { class: 'error', role: 'alert' });

    // ---- de lijst ----
    const item = (tpl) => {
      const stats = templateStats(tpl.content);
      const radio = h('input', { type: 'radio', name: 'template-choice', value: tpl.id, checked: tpl.id === state.selected, onchange: () => select(tpl.id) });
      return h('label', { class: `tpl-item${tpl.id === state.selected ? ' selected' : ''}`, dataset: { id: tpl.id } },
        radio,
        h('span', { class: `dot ${colorClass(tpl.color)}`, 'aria-hidden': 'true' }),
        h('span', { class: 'tpl-item-text' },
          h('span', { class: 'tpl-item-name' }, tpl.name),
          h('span', { class: 'tpl-item-meta' }, mode === 'manage' ? `${kindLabel(tpl.kind)} · ${sizeText(stats)}` : sizeText(stats))));
    };
    const drawList = () => {
      const { starters, own } = catalog();
      replace(list,
        h('fieldset', { class: 'tpl-fieldset' },
          h('legend', { class: 'sr-only' }, t('template.listLabel')),
          starters.length > 0 && [h('div', { class: 'tpl-group' }, t('template.group.starters')), starters.map(item)],
          own.length > 0 && [h('div', { class: 'tpl-group' }, t('template.group.own')), own.map(item)],
          own.length === 0 && h('p', { class: 'hint tpl-none' }, mode === 'project' ? t('template.noneOwn.project') : mode === 'task' ? t('template.noneOwn.task') : t('template.noneOwn.manage'))));
    };

    // ---- het deel rechts ----
    const startRadios = (stats) => {
      if (stats.dated === 0 && stats.recurring === 0) return null;
      const dateInput = h('input', { type: 'date', class: 'field tpl-date', dataset: { fk: 'tpl-date' }, value: state.startDate, 'aria-label': t('template.start.dateLabel'), disabled: state.startMode !== 'date', onchange: (e) => { state.startDate = ISO_DATE.test(e.target.value) ? e.target.value : state.startDate; drawDetail(); } });
      const quick = (label, value) => h('button', { type: 'button', class: 'chip-button', dataset: { fk: `tpl-quick-${value}` }, onclick: () => { state.startMode = 'date'; state.startDate = value; drawDetail(); } }, label);
      const choose = (value) => { state.startMode = value; drawDetail(); };
      return h('fieldset', { class: 'tpl-start' },
        h('legend', {}, t('template.start.legend')),
        h('label', { class: 'check-row' }, h('input', { type: 'radio', name: 'template-start', value: 'date', dataset: { fk: 'tpl-start-date' }, checked: state.startMode === 'date', onchange: () => choose('date') }), t('template.start.date')),
        h('div', { class: 'tpl-start-row' }, dateInput,
          h('div', { class: 'quick-dates', role: 'group', 'aria-label': t('task.quickDates') },
            quick(t('task.quickToday'), dates.today), quick(t('task.quickTomorrow'), dates.tomorrow), quick(t('task.quickNextWeek'), dates.nextWeek))),
        h('label', { class: 'check-row' }, h('input', { type: 'radio', name: 'template-start', value: 'none', dataset: { fk: 'tpl-start-none' }, checked: state.startMode === 'none', onchange: () => choose('none') }), t('template.start.none')),
        stats.recurring > 0 && state.startMode === 'none' && h('p', { class: 'hint' }, t('template.start.recurringNote')));
    };

    let nameInput = null;
    let projectSelect = null;
    let sectionSelect = null;
    const manageButtons = (tpl) => h('div', { class: 'tpl-manage' },
      h('button', { type: 'button', class: 'button button-small', onclick: () => shareTemplateDialog(tpl) }, icon('move'), t('template.share.open')),
      !tpl.builtin && h('button', { type: 'button', class: 'button button-small', onclick: async () => {
        const name = await promptDialog({ title: t('common.rename'), label: t('common.name'), value: tpl.name });
        if (name && name !== tpl.name) await actions.updateTemplate(tpl.id, { name });
      } }, icon('pencil'), t('common.rename')),
      !tpl.builtin && h('button', { type: 'button', class: 'button button-small button-danger', onclick: async () => {
        if (!(await confirmDialog({ title: t('template.delete.title'), text: t('template.delete.text', { name: tpl.name }) }))) return;
        await actions.deleteTemplate(tpl.id);
        toast(t('template.deleted', { name: tpl.name }));
      } }, icon('trash'), t('common.delete')));

    const drawDetail = () => {
      const focused = detail.contains(document.activeElement) ? document.activeElement.dataset.fk ?? null : null;
      drawDetailNow();
      if (focused) detail.querySelector(`[data-fk="${focused}"]`)?.focus();
    };
    const drawDetailNow = () => {
      const tpl = current();
      error.textContent = '';
      if (!tpl) {
        replace(detail, h('p', { class: 'hint' }, t('template.pick')));
        submit.disabled = true;
        return;
      }
      const stats = templateStats(tpl.content);
      const startDate = state.startMode === 'date' && stats.dated + stats.recurring > 0 ? state.startDate : null;
      const span = dateSpan(tpl.content, startDate);
      const newLabels = labelNamesOf(tpl.content).filter((name) => ![...store.view.labels.values()].some((l) => nameKey(l.name) === nameKey(name)));
      submit.disabled = false;
      const options = [];
      if (mode === 'project') {
        nameInput = h('input', { type: 'text', class: 'field', required: true, maxLength: 200, autocomplete: 'off', dataset: { fk: 'tpl-name' }, value: nameInput?.dataset.for === tpl.id ? nameInput.value : tpl.name, dataset: { fk: 'tpl-name', for: tpl.id }, 'aria-label': t('template.projectName') });
        options.push(h('label', { class: 'field-label' }, t('template.projectName'), nameInput));
      } else if (mode === 'task') {
        projectSelect = h('select', { class: 'field', dataset: { fk: 'tpl-project' }, 'aria-label': t('task.project'), onchange: () => { fillSections(); } },
          projectList(store.view).map(({ project, depth }) => h('option', { value: project.id, selected: project.id === (projectSelect?.value || context.projectId || store.me?.inbox_project_id) }, `${INDENT.repeat(depth)}${project.name}`)));
        sectionSelect = h('select', { class: 'field', dataset: { fk: 'tpl-section' }, 'aria-label': t('template.sectionFor') });
        options.push(h('label', { class: 'field-label' }, t('task.project'), projectSelect), h('label', { class: 'field-label' }, t('template.sectionFor'), sectionSelect));
        fillSections(context.sectionId);
      }
      replace(detail,
        h('h3', { class: 'tpl-title' }, h('span', { class: `dot dot-large ${colorClass(tpl.color)}`, 'aria-hidden': 'true' }), tpl.name),
        tpl.description && h('p', { class: 'tpl-description' }, tpl.description),
        mode !== 'manage' && options,
        mode !== 'manage' && startRadios(stats),
        h('p', { class: 'tpl-summary' },
          sizeText(stats),
          newLabels.length > 0 && ` · ${t('template.newLabels', { count: newLabels.length, names: `${newLabels.slice(0, 4).map((n) => `@${n}`).join(', ')}${newLabels.length > 4 ? ', …' : ''}` })}`,
          span && ` · ${t('template.span', { from: formatDate(span.from, today), to: formatDate(span.to, today) })}`),
        previewList(tpl.content, { startDate, today }),
        manageButtons(tpl));
      status.textContent = `${tpl.name}: ${sizeText(stats)}`;
    };
    const fillSections = (selected = null) => {
      if (!sectionSelect) return;
      const sections = [...store.view.sections.values()].filter((s) => s.project_id === projectSelect.value && !s.is_archived).sort(byOrder);
      replace(sectionSelect, h('option', { value: '' }, t('task.noSection')), sections.map((s) => h('option', { value: s.id, selected: s.id === selected }, s.name)));
    };
    const select = (id) => {
      state.selected = id;
      for (const el of list.querySelectorAll('.tpl-item')) el.classList.toggle('selected', el.dataset.id === id);
      drawDetail();
    };

    // de lijst volgt wijzigingen (een sjabloon verwijderd, hernoemd of geïmporteerd); de keuze blijft staan zolang het sjabloon bestaat
    let drawn = '';
    const signature = () => JSON.stringify(catalog().all.map((x) => [x.id, x.name, x.color, x.description, templateStats(x.content).tasks]));
    const redraw = () => {
      const now = signature();
      if (now === drawn) return;
      drawn = now;
      if (state.selected && !current()) state.selected = null;
      const focused = list.contains(document.activeElement) ? state.selected : null;
      drawList();
      if (focused) list.querySelector(`input[value="${CSS.escape(focused)}"]`)?.focus();
      drawDetail();
    };
    unsubscribe = store.subscribe(redraw);
    state.selected = catalog().all[0]?.id ?? null;
    drawn = signature();
    drawList();
    drawDetail();

    const importIt = async () => {
      const id = await importTemplateDialog({ actions });
      if (id) {
        await Promise.resolve(); // het nieuwe sjabloon staat dan al in de lijst
        const made = store.view.templates.get(id);
        if (made && (mode === 'manage' || made.kind === mode)) state.selected = id;
        else if (made) toast(t('template.importedOther', { kind: kindLabel(made.kind) }));
        drawn = signature();
        drawList();
        drawDetail();
      }
    };

    return h('form', {
      class: 'dialog-form tpl-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const tpl = current();
        if (!tpl || mode === 'manage' || state.busy) return;
        error.textContent = '';
        const stats = templateStats(tpl.content);
        const startDate = state.startMode === 'date' && stats.dated + stats.recurring > 0 && ISO_DATE.test(state.startDate) ? state.startDate : null;
        state.busy = true;
        try {
          if (mode === 'project') {
            const name = nameInput?.value.trim();
            if (!name) {
              nameInput.focus();
              return;
            }
            const res = await actions.createProjectFromTemplate(tpl, { name, startDate });
            if (!res.ok) { error.textContent = quotaText(res.problem); return; }
            finish({ kind: 'project', id: res.id, name, counts: res.counts, undo: res.undo });
          } else {
            const res = await actions.insertTemplate(tpl, { projectId: projectSelect.value, sectionId: sectionSelect.value || null, startDate });
            if (!res.ok) { error.textContent = quotaText(res.problem); return; }
            finish({ kind: 'tasks', id: projectSelect.value, name: tpl.name, counts: res.counts, undo: res.undo });
          }
        } finally {
          state.busy = false;
        }
      },
    },
    h('h2', {}, mode === 'project' ? t('template.title.project') : mode === 'task' ? t('template.title.task') : t('template.title.manage')),
    h('p', { class: 'hint' }, mode === 'project' ? t('template.intro.project') : mode === 'task' ? t('template.intro.task') : t('template.intro.manage')),
    h('div', { class: 'tpl-layout' }, list, detail),
    status,
    error,
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button button-left', onclick: importIt }, t('template.import.open')),
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, mode === 'manage' ? t('common.close') : t('common.cancel')),
      mode !== 'manage' && submit));
  }, { wide: true, className: 'dialog-templates', onClose: () => unsubscribe() });
}

// ---------- aanhaken in de app ----------

/**
 * De handelingen die app.js gebruikt. `navigate(route)` opent een project.
 */
export function createTemplatesUi({ store, actions, navigate }) {
  const announce = (made) => {
    if (!made) return;
    navigate({ type: 'project', id: made.id });
    const tasks = t('template.tasksCount', { count: made.counts.tasks });
    toast(made.kind === 'project' ? t('template.created.project', { name: made.name, tasks }) : t('template.created.tasks', { name: made.name, tasks }), { action: { label: t('task.undo'), run: () => made.undo() } });
  };
  return {
    /** "Project uit sjabloon…" */
    async projectFromTemplate() {
      announce(await templatesDialog({ store, actions, mode: 'project' }));
    },
    /** "Taak uit sjabloon…" in een project (en eventueel een sectie). */
    async tasksFromTemplate(context = {}) {
      announce(await templatesDialog({ store, actions, mode: 'task', context }));
    },
    /** Instellingen › Sjablonen. */
    manage: () => templatesDialog({ store, actions, mode: 'manage' }),
    saveProject: (project) => saveAsTemplateDialog({ store, actions, project }),
    saveTask: (task) => saveAsTemplateDialog({ store, actions, task }),
  };
}
