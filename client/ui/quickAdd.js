// Snel toevoegen: de voorvertoning onder het invoerveld (voor de balk bovenaan en voor het venster "Taak toevoegen"),
// en dat venster zelf.

import { dateExamplesNote, mentionsEnglishDate } from '../core/dateHint.js';
import { clockText, formatDate, formatDateInput, formatDayHeading, formatDue, todayString } from '../core/format.js';
import { getLanguage, t } from '../core/i18n.js';
import { needsTimeNote, offsetText, presetOptions } from '../core/reminderText.js';
import { hasTime } from '../../shared/reminders.js';
import { parseDateText } from '../core/dateInput.js';
import { reschedule } from '../core/quickDates.js';
import { choiceFromDue, repeatSummary } from '../core/repeat.js';
import { parseQuickAdd } from '../core/quickadd.js';
import { canEditProject, editableProjectList } from '../core/access.js';
import { startVoice, voiceSupport } from '../core/voice.js';
import { confirmDialog, h, openDialog, replace, toast } from './dom.js';
import { icon } from './icons.js';
import { attachQuickSuggest } from './quickSuggest.js';
import { pickDateTime } from './datePopup.js';
import { repeatPicker } from './repeatPicker.js';
import { labelList, mySettings } from '../core/selectors.js';
import { generalOf } from '../../shared/general.js';
import { splitPastedLines } from '../core/quickSuggest.js';

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
  // Typt iemand in het Engels iets dat op een datum lijkt maar niet is herkend ("tonight"), dan staan er voorbeelden die wel
  // werken. In het Nederlands is die uitleg leeg en verandert er niets.
  const dateNote = (!p.due || p.due === context.defaultDue) && mentionsEnglishDate(p.content) ? dateExamplesNote() : '';
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

/**
 * Geplakte tekst met meer regels: na een vraag wordt elke regel een eigen taak (met dezelfde herkenning als snel toevoegen, in
 * `context`). Geeft het aantal toegevoegde taken, of 0 als je het niet wilde.
 */
export async function addPastedTasks({ view, actions, text, context }) {
  const lines = splitPastedLines(text);
  if (lines.length < 2) return 0;
  const ok = await confirmDialog({
    title: t('quick.pasteTitle', { count: lines.length }),
    text: t('quick.pasteText', { first: lines.slice(0, 3).join(' · ') }),
    okText: t('quick.pasteOk', { count: lines.length }), danger: false,
  });
  if (!ok) return 0;
  let added = 0;
  for (const line of lines) {
    const p = parseQuickAdd(line, { view, now: new Date(), ...context });
    if (!p.content) continue;
    await actions.addTask(p);
    added += 1;
  }
  toast(t('quick.pasteDone', { count: added }));
  return added;
}

/** De bronnen voor de suggesties (ui/quickSuggest.js): projecten waar je kunt toevoegen, secties, je eigen labels. */
export const suggestSource = (store, defaultProjectId) => ({
  projects: editableProjectList(store.view, store.userId).map(({ project: p }) => p),
  sections: [...store.view.sections.values()].filter((s) => !s.is_archived),
  labels: labelList(store.view, store.userId).own.map((x) => x.label),
  defaultProjectId,
});

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
    // of een dag met een tijd 'YYYY-MM-DDTHH:MM' (een klik in de tijdlijn)
    const dayTime = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(context.due ?? '') ? context.due : null;
    const day = dayTime ? dayTime.slice(0, 10) : null;
    const dueFor = () => (context.due === 'today' ? { date: todayString(), string: 'vandaag', lang: 'nl' } : dayTime ? { date: dayTime } : null);
    const parseContext = () => ({ defaultProjectId: project.value, defaultSectionId: sectionFor(), defaultDue: dueFor(), canAddTo, dates: generalOf(mySettings(view, store.userId)).date_recognition });
    const draw = () => replace(preview, previewChips(input.value, { view, context: parseContext() }));
    input.addEventListener('input', draw);
    project.addEventListener('change', draw);

    // Suggesties tijdens het typen: # projecten, / secties, @ labels, { een deadline (ui/quickSuggest.js)
    const suggest = attachQuickSuggest({ input, source: () => suggestSource(store, project.value) });

    // ---- datum, herinnering en herhaling kiezen (de knoppen onder de beschrijving) ----
    // `chosen.due`: de datum (en herhaling) die je met de knoppen koos; die gaat voor op wat in het veld staat. `chosen.reminders`: de herinneringen.
    const chosen = { due: null, reminders: [] };
    const dueButton = h('button', { type: 'button', class: 'chip-button', dataset: { fk: 'quick-due' } });
    const reminderButton = h('button', { type: 'button', class: 'chip-button', dataset: { fk: 'quick-reminder' } });
    const repeatButton = h('button', { type: 'button', class: 'chip-button', dataset: { fk: 'quick-repeat' } });
    // de herhalingskiezer (ui/repeatPicker.js) werkt op een tekstveld met de datum; hier een verborgen veld, de keuze komt in `chosen.due`
    const dueField = h('input', { type: 'hidden' });
    const repeat = repeatPicker({ field: dueField, today: todayString });
    repeat.button.hidden = true;
    const effectiveDue = () => chosen.due ?? parseQuickAdd(input.value, { view, now: new Date(), ...parseContext() }).due;
    const paintChoices = () => {
      const day = chosen.due;
      dueButton.replaceChildren(icon('calendar'), day ? formatDue(day, todayString()) : t('quick.date'));
      dueButton.classList.toggle('active', Boolean(day));
      const rule = chosen.due?.recurrence ? choiceFromDue(chosen.due) : null;
      repeatButton.replaceChildren(icon('repeat'), rule ? repeatSummary(rule) : t('task.quickRepeat'));
      repeatButton.classList.toggle('active', Boolean(rule));
      const n = chosen.reminders.length;
      reminderButton.replaceChildren(icon('bell'), n > 0 ? t('quick.remindersCount', { count: n }) : t('quick.reminder'));
      reminderButton.classList.toggle('active', n > 0);
      dueField.value = chosen.due ? formatDateInput(chosen.due) : '';
    };
    dueButton.addEventListener('click', async () => {
      const current = effectiveDue();
      const picked = await pickDateTime({ today: todayString(), due: current ?? null, allowNone: Boolean(current) });
      if (!picked) return;
      // een herhaling die er al is, blijft; alleen de dag en de tijd veranderen
      chosen.due = picked.date ? reschedule(chosen.due, picked.date, picked.time) : null;
      if (!picked.date) chosen.reminders = chosen.reminders.filter((r) => r.type === 'absolute');
      paintChoices();
      input.focus();
    });
    // herhalen: de kiezer opent als popup met het paneel van ui/repeatPicker.js
    dueField.addEventListener('input', () => {
      const parsed = parseDateText(dueField.value.trim(), new Date());
      if (!parsed) return;
      // had je al een dag gekozen, dan begint de herhaling op die dag
      chosen.due = chosen.due && !chosen.due.recurrence ? reschedule(parsed, chosen.due.date.slice(0, 10), chosen.due.date.length > 10 ? chosen.due.date.slice(11, 16) : undefined) : parsed;
      paintChoices();
    });
    repeatButton.addEventListener('click', () => {
      dueField.value = chosen.due ? formatDateInput(chosen.due) : effectiveDue() ? formatDateInput(effectiveDue()) : '';
      repeat.button.click(); // opent het paneel (draw)
      const panel = repeat.panel;
      openDialog((finish) => {
        const hide = new MutationObserver(() => { if (panel.hidden) finish(null); }); // "Toepassen" in het paneel sluit het paneel, en dan ook de popup
        hide.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
        return h('div', { class: 'dialog-form' },
          h('h2', {}, t('repeat.title')),
          panel,
          h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
      }, { className: 'dialog-sheet', onClose: () => {
        if (!panel.hidden) repeat.button.click(); // sluit het paneel netjes (haalt ook zijn Escape-afhandeling weg)
        form.append(panel); // het paneel blijft in dit venster, voor de volgende keer
      } }).then(() => input.focus());
    });
    reminderButton.addEventListener('click', async () => {
      const due = effectiveDue();
      const picked = await reminderDialog({ selected: chosen.reminders, timed: hasTime(due?.date) });
      if (!picked) return;
      chosen.reminders = picked;
      paintChoices();
      input.focus();
    });
    paintChoices();

    // Meer regels plakken (zoals Todoist): na een vraag wordt elke regel een eigen taak, met dezelfde herkenning als hier.
    input.addEventListener('paste', async (e) => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (splitPastedLines(text).length < 2) return;
      e.preventDefault();
      if (await addPastedTasks({ view, actions, text, context: parseContext() })) finish(null);
    });

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
    const form = h('form', {
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
        // wat je met de knoppen koos gaat voor op wat er in de tekst stond; de herinneringen komen erbij
        const due = chosen.due ?? p.due;
        const same = (a, b) => a.type === b.type && (a.type === 'absolute' ? a.due.date === b.due.date : a.minute_offset === b.minute_offset);
        const reminders = [...p.reminders, ...chosen.reminders.filter((r) => !p.reminders.some((x) => same(x, r)))];
        finish(await actions.addTask({ ...p, due, reminders, ...(text ? { description: text } : {}) }));
      },
    },
    h('h2', {}, t('quick.addTask')),
    day && h('p', { class: 'hint quick-day' }, t('quick.forDay', { date: dayTime.length > 10 ? `${formatDayHeading(day, todayString())} ${clockText(dayTime.slice(11, 16))}` : formatDayHeading(day, todayString()) })),
    mic ? h('div', { class: 'quick-row' }, input, mic) : input,
    suggest.node,
    description,
    shared,
    preview,
    // datum (kalender), herinnering en herhaling: elk opent een kleine popup
    h('div', { class: 'quick-choices', role: 'group', 'aria-label': t('quick.choices') }, dueButton, reminderButton, repeatButton, repeat.button),
    h('div', { class: 'quick-options' },
      h('label', { class: 'field-label' }, t('task.project'), project),
      // "Taak uit sjabloon…": sluit dit venster en opent de sjablonen voor het gekozen project (en de sectie, als die bij dit project hoort)
      onTemplate && h('button', { type: 'button', class: 'button button-small button-ghost quick-template', onclick: () => { const where = { projectId: project.value, sectionId: sectionFor() }; finish(null); onTemplate(where); } }, icon('template'), t('template.menu.insert'))),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary' }, t('common.add'))));
    form.append(repeat.panel); // het paneel van de herhaling verhuist naar zijn popup zodra die opent
    return form;
  }, { wide: true, className: 'dialog-quick', onClose: () => voice?.stop() });
}

/**
 * De popup met herinneringen voor een nieuwe taak: vaste keuzes vooraf (op het tijdstip, 10 minuten, 1 uur, 1 dag, …) en eventueel een
 * eigen datum en tijd. Zonder tijd bij de taak werken de keuzes "vooraf" pas als je er een tijd aan geeft; dat staat erbij.
 * @param {{ selected: object[], timed: boolean }} options  `selected`: wat er al gekozen is; `timed`: heeft de taak een datum mét tijd?
 * @returns {Promise<object[] | null>} de herinneringen (relatief: `{ type: 'relative', minute_offset }`, eigen: `{ type: 'absolute', due: { date } }`), of null bij sluiten
 */
export function reminderDialog({ selected, timed }) {
  return openDialog((finish) => {
    const offsets = new Set(selected.filter((r) => r.type === 'relative').map((r) => r.minute_offset));
    const own = selected.filter((r) => r.type === 'absolute').map((r) => r.due.date);
    const checks = presetOptions().map(({ minutes, label }) => h('label', { class: 'check-row' },
      h('input', { type: 'checkbox', checked: offsets.has(minutes), dataset: { fk: `quick-reminder:${minutes}` }, onchange: (e) => (e.target.checked ? offsets.add(minutes) : offsets.delete(minutes)) }), label));
    const when = h('input', { class: 'field', type: 'datetime-local', 'aria-label': t('reminder.customLabel'), dataset: { fk: 'quick-reminder-own' } });
    const list = h('ul', { class: 'quick-reminder-own' });
    const drawOwn = () => replace(list, own.map((date, i) => h('li', {},
      h('span', {}, formatDue({ date }, todayString())),
      h('button', { class: 'icon-button', type: 'button', 'aria-label': t('reminder.remove'), title: t('reminder.remove'), onclick: () => { own.splice(i, 1); drawOwn(); } }, icon('close')))));
    drawOwn();
    const addOwn = () => {
      if (!when.value) return;
      const date = when.value.slice(0, 16);
      if (!own.includes(date)) own.push(date);
      when.value = '';
      drawOwn();
    };
    return h('form', {
      class: 'dialog-form',
      onsubmit: (e) => {
        e.preventDefault();
        addOwn(); // een datum die nog in het veld staat, telt ook mee
        finish([
          ...[...offsets].sort((a, b) => a - b).map((minute_offset) => ({ type: 'relative', minute_offset })),
          ...own.map((date) => ({ type: 'absolute', due: { date } })),
        ]);
      },
    },
    h('h2', {}, t('reminder.title')),
    !timed && h('p', { class: 'hint' }, needsTimeNote()),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('reminder.choose')), checks),
    h('fieldset', { class: 'general-group' }, h('legend', {}, t('reminder.custom')),
      h('div', { class: 'quick-row' }, when, h('button', { type: 'button', class: 'button button-small', onclick: addOwn }, t('reminder.add'))),
      list),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary', dataset: { fk: 'quick-reminder-save' } }, t('common.save'))));
  }, { className: 'dialog-sheet' });
}
