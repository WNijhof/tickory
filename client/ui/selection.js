// Meerdere taken selecteren en bewerken, in de interface: klikken en toetsen worden keuzes (de logica staat in core/selection.js), de
// actiebalk laat de bulkacties zien (de logica en de commando's staan in core/bulk.js), en de uitkomst loopt via `actions.batch`:
// één reeks bestaande commando's, optimistisch en offline, met dezelfde rechten als voor één taak. Elke actie legt een stap neer voor
// "Ongedaan maken" (core/undo.js).
//
// Selecteren:
//   - Ctrl- of Cmd-klik op een taak: kiezen of loslaten. Shift-klik: alles van het anker tot die taak erbij.
//   - de knop "Selecteren" in de kop van het scherm: elke regel krijgt een vakje (het afvinkrondje blijft afvinken);
//     zolang er iets gekozen is, kiest een gewone klik op een regel ook.
//   - `x` (of Spatie zodra je aan het kiezen bent) kiest de taak onder de focus of de aanwijzer; Ctrl/Cmd+A kiest alles in beeld;
//     Esc stopt. Op een telefoon: lang indrukken (ui/dragdrop.js roept `longPress` aan; verder slepen sleept de taak).
// De regels in de lijst (render.js), het bord (board.js) en de kalender (calendar.js) hebben `li.task` of `li.cal-item`; de taak staat
// in `data-id` of `data-task-id`.

import { createSelection } from '../core/selection.js';
import {
  assignChoices, nameList, planAssign, planComplete, planDate, planDelete, planLabels, planMove, planPriority, planReopen, selectionInfo, skippedText, summarizeErrors,
} from '../core/bulk.js';
import { describeCommandError } from '../core/messages.js';
import { formatDate, todayString } from '../core/format.js';
import { isTyping } from '../core/shortcuts.js';
import { t } from '../core/i18n.js';
import { labelList } from '../core/selectors.js';
import { assignDialog, dateDialog, labelsDialog, moveDialog, priorityDialog } from './bulkDialogs.js';
import { confirmDialog, h, replace, toast } from './dom.js';
import { icon } from './icons.js';

const ROW = 'li.task, li.cal-item';
/** Wat in een regel zijn eigen werk doet en dus niet als "kies deze taak" telt (in de modus Selecteren). */
const OWN_CONTROLS = '[data-act="check"], [data-act="fold"], [data-act="label"], [data-act="move"], [data-act="restore"], .task-actions, .cal-check, a, input, textarea, select';

/**
 * @param {{
 *   content: HTMLElement,
 *   store: import('../core/store.js').Store, actions: ReturnType<typeof import('../core/actions.js').createActions>,
 *   handlers: { open: (task: object) => void },
 * }} options
 */
export function installSelection({ content, store, actions, handlers }) {
  const sel = createSelection({ onChange: () => repaint() });

  // ---------- aankondigen voor schermlezers ----------
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', id: 'bulk-live' });
  document.body.append(live);
  let liveTimer = null;
  const announce = (text) => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); }, 120);
  };
  const countText = () => (sel.size === 0 ? t('bulk.none') : t('bulk.count', { count: sel.size }));

  // ---------- regels ----------
  const idOf = (row) => row.dataset.id ?? row.dataset.taskId;
  const isReal = (row) => row.dataset.real !== 'false';
  const rowOf = (el) => {
    const row = el?.closest?.(ROW);
    return row && content.contains(row) && isReal(row) ? row : null;
  };
  /** De taken in beeld van boven naar beneden, zonder dubbele en zonder voorkomens van een herhaling. */
  const order = () => {
    const seen = new Set();
    const out = [];
    for (const row of content.querySelectorAll(ROW)) {
      const id = idOf(row);
      if (!isReal(row) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };
  const rowsOf = (id) => content.querySelectorAll(`li.task[data-id="${CSS.escape(id)}"], li.cal-item[data-task-id="${CSS.escape(id)}"]`);

  // ---------- tekenen ----------
  const bar = h('div', { id: 'bulk-bar', class: 'bulk-bar', role: 'toolbar', 'aria-label': t('bulk.barLabel'), hidden: true });
  content.before(bar);
  const headerButton = h('button', { class: 'button button-small button-ghost bulk-toggle', type: 'button', 'aria-pressed': 'false', onclick: () => {
    if (sel.active) { sel.clear(); announce(t('bulk.announceStopped')); } else { sel.setMode(true); announce(t('bulk.none')); }
  } });

  function paintRows() {
    const on = sel.active;
    document.body.classList.toggle('select-mode', on);
    for (const row of content.querySelectorAll(ROW)) {
      const id = idOf(row);
      const chosen = on && sel.has(id);
      if (row.classList.contains('is-selected') !== chosen) row.classList.toggle('is-selected', chosen);
      if (on && isReal(row)) row.setAttribute('aria-selected', String(chosen));
      else row.removeAttribute('aria-selected');
      const box = row.querySelector('.sel-box');
      if (box) box.setAttribute('aria-checked', String(chosen));
    }
  }

  function paintHeader() {
    const actionsHost = document.getElementById('view-actions');
    const hasRows = content.querySelector('li.task, li.cal-item[data-real="true"]') !== null;
    headerButton.replaceChildren(icon('selectAll'), h('span', { class: 'btn-label' }, sel.active ? t('bulk.selectDone') : t('bulk.select')));
    headerButton.setAttribute('aria-pressed', String(sel.active));
    headerButton.setAttribute('aria-label', sel.active ? t('bulk.stop') : t('bulk.select'));
    headerButton.title = sel.active ? t('bulk.stop') : t('bulk.select');
    // naast de knoppen van het scherm, in de kop (niet erin: die lijst is per scherm anders)
    if (actionsHost && hasRows && headerButton.nextElementSibling !== actionsHost) actionsHost.before(headerButton);
    else if ((!hasRows || !actionsHost) && headerButton.parentNode) headerButton.remove();
  }

  let barKey = '';
  function paintBar() {
    bar.hidden = !sel.active;
    bar.setAttribute('aria-label', t('bulk.barLabel'));
    if (!sel.active) { if (barKey !== '') { replace(bar); barKey = ''; } return; }
    const info = selectionInfo(store.view, sel.list());
    const some = sel.size > 0;
    // alleen opnieuw opbouwen als er iets verandert: anders raakt wie met Tab op een knop van de balk staat zijn plek kwijt bij elke sync
    const key = [t('bulk.barLabel'), sel.size, info.open > 0, info.done > 0, info.shared].join('|');
    if (key === barKey) return;
    barKey = key;
    const button = (key, iconName, label, run, { danger = false, disabled = !some } = {}) => h('button', {
      class: `bulk-button${danger ? ' bulk-danger' : ''}`, type: 'button', disabled, dataset: { bulk: key }, onclick: run, title: label,
    }, icon(iconName), h('span', { class: 'bulk-label' }, label));
    replace(bar,
      h('span', { class: 'bulk-count', 'aria-hidden': 'true' }, countText()),
      h('div', { class: 'bulk-buttons' },
        info.open > 0 || !some ? button('complete', 'check', t('bulk.complete'), () => run.complete(), { disabled: !some || info.open === 0 }) : null,
        info.done > 0 ? button('reopen', 'undo', t('bulk.reopen'), () => run.reopen()) : null,
        button('move', 'move', t('bulk.move'), () => run.move()),
        button('date', 'calendar', t('bulk.date'), () => run.date()),
        button('priority', 'flag', t('bulk.priority'), () => run.priority()),
        button('labels', 'tag', t('bulk.labels'), () => run.labels()),
        info.shared ? button('assign', 'users', t('bulk.assign'), () => run.assign()) : null,
        button('delete', 'trash', t('bulk.delete'), () => run.remove(), { danger: true })),
      h('div', { class: 'bulk-side' },
        h('button', { class: 'bulk-small', type: 'button', dataset: { bulk: 'all' }, onclick: () => selectAllInView() }, t('bulk.selectAll')),
        h('button', { class: 'icon-button bulk-close', type: 'button', 'aria-label': t('bulk.stop'), title: t('bulk.stop'), dataset: { bulk: 'stop' }, onclick: () => { sel.clear(); announce(t('bulk.announceStopped')); } }, icon('close'))));
  }

  let previousSize = -1;
  let previousActive = false;
  function repaint() {
    paintRows();
    paintBar();
    paintHeader();
    if (sel.active && (sel.size !== previousSize || !previousActive)) announce(countText());
    previousSize = sel.size;
    previousActive = sel.active;
  }

  /** Door app.js na elke keer tekenen van het scherm: de modus en de keuze op de nieuwe regels zetten, en wat verdween loslaten. */
  function afterRender({ routeKey }) {
    if (afterRender.route !== undefined && afterRender.route !== routeKey) sel.clear();
    afterRender.route = routeKey;
    sel.prune((id) => store.view.tasks.has(id));
    repaint();
  }

  const selectAllInView = () => {
    const ids = order();
    sel.selectAll(ids);
    announce(t('bulk.announceAll', { count: ids.length }));
  };

  // ---------- klikken ----------
  const taskOf = (id) => store.view.tasks.get(id);
  const toggleId = (id) => { sel.toggle(id); };

  // Na een lange druk volgt bij het loslaten nog een "klik". Die telt niet: hij zou de keuze weer opheffen, of (de actiebalk schuift de
  // lijst op) op een ander element landen. We negeren klikken vanaf de lange druk tot 60 ms na het loslaten.
  let pressing = false;
  let longPressed = null;
  let ignoreClickUntil = 0;
  const released = () => { if (pressing) { pressing = false; ignoreClickUntil = Date.now() + 60; } }; // 60 ms: net als na een sleepgebaar (ui/dragdrop.js)
  document.addEventListener('pointerup', released, true);
  document.addEventListener('pointercancel', released, true);
  document.addEventListener('click', (e) => {
    if (pressing || Date.now() < ignoreClickUntil) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  content.addEventListener('mousedown', (e) => {
    if (e.shiftKey && rowOf(e.target)) e.preventDefault(); // geen tekstselectie bij Shift-klik
  }, true);
  content.addEventListener('click', (e) => {
    const row = rowOf(e.target);
    if (!row) return;
    const id = idOf(row);
    if (!taskOf(id)) return;
    const box = e.target.closest('.sel-box');
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (box) { stop(); toggleId(id); return; }
    if (e.shiftKey && !(e.ctrlKey || e.metaKey)) { stop(); sel.extendTo(order(), id); return; }
    if (e.ctrlKey || e.metaKey) { stop(); toggleId(id); return; }
    if (sel.active && !e.target.closest(OWN_CONTROLS)) { stop(); toggleId(id); }
  }, true);

  // ---------- toetsen ----------
  // `x` kiest de taak waar je het laatst iets mee deed: met de muis erboven (aanwijzer) of met het toetsenbord erin (focus)
  let hoverId = null;
  let hoverAt = 0;
  let focusAt = 0;
  content.addEventListener('mouseover', (e) => { hoverId = rowOf(e.target) ? idOf(rowOf(e.target)) : null; hoverAt = Date.now(); });
  content.addEventListener('mouseleave', () => { hoverId = null; });
  document.addEventListener('focusin', () => { focusAt = Date.now(); });
  const dialogOpen = () => Boolean(document.querySelector('dialog[open]'));

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || dialogOpen() || !store.ready) return;
    const target = e.target instanceof Element ? e.target : null;
    if (isTyping(target)) return;
    if (e.key === 'Escape' && sel.active) {
      e.preventDefault();
      sel.clear();
      announce(t('bulk.announceStopped'));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      if (order().length === 0) return;
      e.preventDefault();
      selectAllInView();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const focusedRow = rowOf(document.activeElement) ?? rowOf(target);
    const focusedId = focusedRow ? idOf(focusedRow) : null;
    if (e.key === 'x' || e.key === 'X') {
      const id = hoverId && hoverAt >= focusAt ? hoverId : focusedId ?? hoverId;
      if (!id || !taskOf(id)) return;
      e.preventDefault();
      toggleId(id);
      return;
    }
    // Spatie kiest alleen als je al aan het kiezen bent; anders blijft het "druk op de knop" van de knop waar de focus op staat
    if (e.key === ' ' && sel.active && focusedId && taskOf(focusedId) && !target?.closest('[data-act="check"], [data-act="fold"], .sel-box, .task-actions')) {
      e.preventDefault();
      toggleId(focusedId);
    }
  });

  // ---------- acties ----------
  let seq = 0;
  /** Per bulkactie: hoeveel taken en hoe ze heten, om weigeringen van de server als één melding te kunnen melden. */
  const reports = new Map();

  const undoToast = (text, entry) => toast(text, entry
    ? { action: { label: t('task.undo'), run: async () => { if (await actions.runUndo(entry)) toast(t('undo.done')); } }, timeout: 10_000 }
    : {});

  /** Voert een plan uit: één reeks commando's, daarna een melding met "Ongedaan maken". */
  async function perform({ commands, count, skipped = [] }, doneText, label) {
    const view = store.view;
    const note = skipped.length > 0 ? skippedText(skipped, (id) => view.tasks.get(id)?.content ?? null) : '';
    if (commands.length === 0) {
      toast([t('bulk.nothingToDo'), note].filter(Boolean).join(' '));
      return;
    }
    const id = `bulk-${Date.now().toString(36)}-${++seq}`;
    reports.set(id, { total: count, names: new Map(sel.list().map((x) => [x, view.tasks.get(x)?.content ?? ''])) });
    if (reports.size > 20) reports.delete(reports.keys().next().value);
    const { entry } = await actions.batch(commands, { label, bulk: id });
    const text = [doneText, note].filter(Boolean).join(' ');
    sel.clear();
    if (document.activeElement === document.body && headerButton.isConnected) headerButton.focus(); // de balk is weg: de focus naar de knop Selecteren
    announce(text);
    undoToast(text, entry);
  }

  const chosen = () => sel.list(order()).filter((id) => store.view.tasks.has(id));

  const run = {
    async complete() {
      const plan = planComplete(store.view, chosen(), (id) => actions.planComplete(id));
      await perform(plan, t('bulk.doneComplete', { count: plan.count }), t('bulk.complete'));
    },
    async reopen() {
      const plan = planReopen(store.view, chosen());
      await perform(plan, t('bulk.doneReopen', { count: plan.count }), t('bulk.reopen'));
    },
    async move() {
      const ids = chosen();
      const target = await moveDialog({ view: store.view, count: ids.length });
      if (!target) return;
      const plan = planMove(store.view, ids, target, order());
      await perform(plan, t('bulk.doneMove', { count: plan.count, target: target.name }), t('bulk.move'));
    },
    async date() {
      const ids = chosen();
      const info = selectionInfo(store.view, ids);
      const picked = await dateDialog({ today: todayString(), hasDue: info.withDue > 0, count: ids.length });
      if (!picked) return;
      const plan = planDate(store.view, ids, picked.date, (id, changes) => actions.planUpdateTask(id, changes));
      const text = picked.date ? t('bulk.doneDate', { count: plan.count, date: formatDate(picked.date, todayString()) }) : t('bulk.doneDateNone', { count: plan.count });
      await perform(plan, text, t('bulk.date'));
    },
    async priority() {
      const ids = chosen();
      const priority = await priorityDialog({ count: ids.length });
      if (!priority) return;
      const plan = planPriority(store.view, ids, priority);
      await perform(plan, t('bulk.donePriority', { count: plan.count, priority }), t('bulk.priority'));
    },
    async labels() {
      const ids = chosen();
      const info = selectionInfo(store.view, ids);
      const own = labelList(store.view, store.userId).own.map((x) => x.label);
      const foreign = [...info.labelCount.keys()].filter((id) => !own.some((l) => l.id === id)).map((id) => store.view.labels.get(id)).filter(Boolean);
      const picked = await labelsDialog({ labels: [...own, ...foreign], counts: info.labelCount, total: info.count, count: ids.length });
      if (!picked) return;
      const fresh = actions.resolveLabels(picked.names);
      const plan = planLabels(store.view, ids, { add: [...picked.add, ...fresh.ids], remove: picked.remove });
      await perform({ ...plan, commands: [...fresh.commands, ...plan.commands] }, t('bulk.doneLabels', { count: plan.count }), t('bulk.labels'));
    },
    async assign() {
      const ids = chosen();
      const people = assignChoices(store.view, ids).map((p) => ({ ...p, name: store.userId === p.userId ? t('task.memberYou', { name: store.userName(p.userId) ?? t('common.someone') }) : store.userName(p.userId) ?? t('common.someone') }));
      const picked = await assignDialog({ people, count: ids.length });
      if (!picked) return;
      const plan = planAssign(store.view, ids, picked.userId);
      const name = picked.userId ? store.userName(picked.userId) ?? t('common.someone') : '';
      await perform(plan, picked.userId ? t('bulk.doneAssign', { count: plan.count, name }) : t('bulk.doneUnassign', { count: plan.count }), t('bulk.assign'));
    },
    async remove() {
      const ids = chosen();
      const plan = planDelete(store.view, ids);
      if (plan.count === 0) return;
      const text = [t('bulk.deleteText', { count: plan.count }), plan.subtasks > 0 ? t('bulk.deleteSubtasks', { count: plan.subtasks }) : '', t('bulk.deleteUndo')].filter(Boolean).join(' ');
      const ok = await confirmDialog({ title: t('bulk.deleteTitle', { count: plan.count }), text });
      if (!ok) return;
      await perform(plan, t('bulk.doneDelete', { count: plan.count }), t('bulk.delete'));
    },
  };

  /**
   * Weigeringen van de server voor bulkacties worden één melding per actie (hoeveel, welke taken, waarom); wat niet van een bulkactie is,
   * komt terug voor de gewone melding per commando.
   * @param {{ cmd: { local?: { bulk?: string }, args?: { id?: string } }, error_code: string, error: string }[]} errors
   * @returns {typeof errors}
   */
  function reportErrors(errors) {
    const rest = [];
    const groups = new Map();
    for (const e of errors) {
      const id = e.cmd?.local?.bulk;
      if (!id || !reports.has(id)) { rest.push(e); continue; }
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(e);
    }
    for (const [id, list] of groups) {
      const { total, names } = reports.get(id);
      const text = summarizeErrors(list, { total, nameOf: (task) => names.get(task) || store.view.tasks.get(task)?.content || null, describe: describeCommandError });
      if (text) toast(text, { kind: 'error', timeout: 15_000 });
    }
    return rest;
  }

  // ---------- slepen en lang indrukken (ui/dragdrop.js) ----------
  const api = {
    sel,
    afterRender,
    reportErrors,
    undoToast,
    announce,
    order,
    nameList,
    /** Op een telefoon: lang indrukken kiest de taak. */
    longPress(id) {
      if (!taskOf(id)) return;
      longPressed = { id, alone: sel.size === 0, was: sel.has(id) };
      sel.add(id);
      pressing = true;
      navigator.vibrate?.(12);
    },
    /** De taken die samen met `dragId` slepen: alle gekozen taken als `dragId` er een van is, anders alleen die ene. */
    dragSet(dragId) {
      if (!sel.active || !sel.has(dragId) || sel.size < 2) return [dragId];
      return sel.list(order());
    },
    /** Na een geslaagde verplaatsing van de groep: de keuze loslaten. */
    done() { sel.clear(); },
    /** Een sleepgebaar is afgelopen. Was de taak alleen gekozen om op te tillen en is ze verplaatst, dan is de keuze niet meer nodig. */
    dragEnded(moved) {
      const lp = longPressed;
      longPressed = null;
      if (lp && moved && lp.alone && !lp.was && sel.size === 1 && sel.has(lp.id)) sel.clear();
    },
  };
  repaint();
  return api;
}
