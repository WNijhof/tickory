// Snel toevoegen: de voorvertoning onder het invoerveld (voor de balk bovenaan en voor het venster "Taak toevoegen"),
// en dat venster zelf.

import { dateLanguageNote, mentionsEnglishDate } from '../core/dateHint.js';
import { formatDate, formatDayHeading, formatDue, todayString } from '../core/format.js';
import { getLanguage, t } from '../core/i18n.js';
import { offsetText } from '../core/reminderText.js';
import { parseQuickAdd } from '../core/quickadd.js';
import { canEditProject, editableProjectList } from '../core/access.js';
import { startVoice, voiceSupport } from '../core/voice.js';
import { h, openDialog, replace, toast } from './dom.js';
import { icon } from './icons.js';

const INDENT = String.fromCharCode(160, 160);

/**
 * Wat een regel tekst wordt: de taak met datum, project, labels en prioriteit, als chips. Geeft de chips terug (leeg bij lege tekst).
 * @param {string} text
 * @param {{ view: object, context: { defaultProjectId: string, defaultSectionId?: string | null, defaultDue?: object | null } }} options
 */
export function previewChips(text, { view, context }) {
  if (!text.trim() || !context.defaultProjectId) return [];
  const p = parseQuickAdd(text, { view, now: new Date(), ...context });
  const today = todayString();
  const chip = (kind, label) => h('span', { class: `chip chip-${kind}` }, label);
  // Typt iemand een Engelse datum ("tomorrow") die niet is herkend, dan zeggen we erbij dat datums in gewone taal nu alleen
  // in het Nederlands werken. In het Nederlands is die uitleg leeg en verandert er niets.
  const dateNote = (!p.due || p.due === context.defaultDue) && mentionsEnglishDate(p.content) ? dateLanguageNote() : '';
  return [
    chip('title', p.content || t('quick.noName')),
    p.due && p.due !== context.defaultDue && chip('due', formatDue(p.due, today)),
    p.deadline && chip('deadline', t('task.deadlineChip', { date: formatDate(p.deadline, today) })),
    p.project_id !== context.defaultProjectId && chip('project', `#${view.projects.get(p.project_id)?.name ?? ''}`),
    p.section_id && p.section_id !== context.defaultSectionId && chip('project', `/${view.sections.get(p.section_id)?.name ?? ''}`),
    p.labels.map((id) => chip('label', `@${view.labels.get(id)?.name ?? ''}`)),
    p.newLabels.map((name) => chip('label', t('quick.newLabel', { name }))),
    p.priority < 4 && chip(`prio prio-${p.priority}`, `P${p.priority}`),
    p.reminders.map((r) => chip('bell', `🔔 ${r.type === 'absolute' ? formatDue({ date: r.due.date }, today) : offsetText(r.minute_offset)}`)),
    dateNote && h('p', { class: 'hint preview-note' }, dateNote),
  ].flat().filter(Boolean);
}

/**
 * Het venster "Taak toevoegen": dezelfde invoer als de balk bovenaan, groter, met beschrijving en een keuze voor het project.
 * @param {{ store: import('../core/store.js').Store, actions: object, context: { projectId?: string | null, sectionId?: string | null, due?: 'today' | string | null, text?: string } }} options
 * @returns {Promise<string | null>} het id van de nieuwe taak, of null bij annuleren
 */
/** De melding bij een mislukte spraakopname (elke tekst letterlijk, zodat de vertaaltests ze kunnen controleren). */
function voiceErrorText(code) {
  switch (code) {
    case 'no-speech': return t('voice.error.noSpeech');
    case 'denied': return t('voice.error.denied');
    case 'network': return t('voice.error.network');
    case 'unavailable': return t('voice.error.unavailable');
    default: return t('voice.error.error');
  }
}

export function openQuickAddDialog({ store, actions, context = {}, onTemplate = null }) {
  const view = store.view;
  const inbox = store.me?.inbox_project_id ?? null;
  // in een project dat je alleen leest, kan geen taak: dan de Inbox
  const canAddTo = (id) => canEditProject(view, id, store.userId);
  const startProject = context.projectId && view.projects.has(context.projectId) && canAddTo(context.projectId) ? context.projectId : inbox;
  let voice = null; // de lopende spraakopname, als die er is
  return openDialog((finish) => {
    const input = h('input', {
      class: 'field quick-big', type: 'text', maxLength: 4000, value: context.text ?? '', placeholder: t('quick.placeholder'), 'aria-label': t('quick.label'), autocomplete: 'off', enterkeyhint: 'done', autofocus: true,
    });
    const description = h('textarea', { class: 'field', rows: context.description ? 4 : 2, maxLength: 16000, placeholder: t('task.description'), 'aria-label': t('task.descriptionLabel') });
    description.value = context.description ?? ''; // bijvoorbeeld de link bij tekst die uit een andere app is gedeeld
    const project = h('select', { class: 'field', 'aria-label': t('task.project') },
      editableProjectList(view, store.userId).map(({ project: p, depth }) => h('option', { value: p.id, selected: p.id === startProject }, `${INDENT.repeat(depth)}${p.name}`)));
    const preview = h('div', { class: 'chips preview', 'aria-live': 'polite' });
    // bestanden die uit een andere app zijn gedeeld: ze worden bijlagen van de taak zodra je Toevoegen kiest
    const shared = context.files?.length ? h('p', { class: 'hint quick-files' }, icon('paperclip'), t('quick.sharedFiles', { names: context.files.join(', ') })) : null;
    const sectionFor = () => (project.value === startProject && context.sectionId ? context.sectionId : null);
    // `due` is 'today' (Vandaag), of een dag 'YYYY-MM-DD' (een "+" in de kalender): dan staat de taak op die dag, ook zonder dat je die typt.
    const day = /^\d{4}-\d{2}-\d{2}$/.test(context.due ?? '') ? context.due : null;
    const dueFor = () => (context.due === 'today' ? { date: todayString(), string: 'vandaag', lang: 'nl' } : day ? { date: day } : null);
    const parseContext = () => ({ defaultProjectId: project.value, defaultSectionId: sectionFor(), defaultDue: dueFor(), canAddTo });
    const draw = () => replace(preview, previewChips(input.value, { view, context: parseContext() }));
    input.addEventListener('input', draw);
    project.addEventListener('change', draw);

    // Spraakinvoer: alleen een knop als dit apparaat het kan. De herkende tekst komt in het veld; er wordt niets aangemaakt.
    let mic = null;
    if (voiceSupport()) {
      mic = h('button', { type: 'button', class: 'icon-button voice-button', 'aria-pressed': 'false', 'aria-label': t('voice.start'), title: t('voice.start') }, icon('mic'));
      const reset = () => {
        voice = null;
        mic.classList.remove('listening');
        mic.setAttribute('aria-pressed', 'false');
        mic.setAttribute('aria-label', t('voice.start'));
        mic.title = t('voice.start');
      };
      mic.addEventListener('click', () => {
        if (voice) {
          voice.stop();
          return;
        }
        mic.classList.add('listening');
        mic.setAttribute('aria-pressed', 'true');
        mic.setAttribute('aria-label', t('voice.stop'));
        mic.title = t('voice.stop');
        toast(t('voice.listening'), { timeout: 3000 });
        voice = startVoice({
          lang: getLanguage(),
          onResult: (text) => {
            input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text;
            draw();
            input.focus();
            toast(t('voice.heard'), { timeout: 4000 });
          },
          onError: (code) => {
            if (code !== 'cancelled') toast(voiceErrorText(code), { kind: 'error' });
          },
          onEnd: reset,
        });
        if (!voice) reset();
      });
    }
    if (input.value) {
      draw(); // een begintekst (bijvoorbeeld het label waar je bij staat): meteen de voorvertoning, de cursor erachter
      queueMicrotask(() => input.setSelectionRange(input.value.length, input.value.length));
    }
    return h('form', {
      class: 'dialog-form quick-form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!project.value) {
          toast(t('quick.signInFirst'));
          return;
        }
        const p = parseQuickAdd(input.value, { view, now: new Date(), ...parseContext() });
        if (!p.content) {
          toast(t('task.nameRequired'));
          input.focus();
          return;
        }
        const text = description.value.trim();
        finish(await actions.addTask({ ...p, ...(text ? { description: text } : {}) }));
      },
    },
    h('h2', {}, t('quick.addTask')),
    day && h('p', { class: 'hint quick-day' }, t('quick.forDay', { date: formatDayHeading(day, todayString()) })),
    mic ? h('div', { class: 'quick-row' }, input, mic) : input,
    description,
    shared,
    preview,
    h('div', { class: 'quick-options' },
      h('label', { class: 'field-label' }, t('task.project'), project),
      // "Taak uit sjabloon…": sluit dit venster en opent de sjablonen voor het gekozen project (en de sectie, als die bij dit project hoort)
      onTemplate && h('button', { type: 'button', class: 'button button-small button-ghost quick-template', onclick: () => { const where = { projectId: project.value, sectionId: sectionFor() }; finish(null); onTemplate(where); } }, icon('template'), t('template.menu.insert'))),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary' }, t('common.add'))));
  }, { wide: true, className: 'dialog-quick', onClose: () => voice?.stop() });
}
