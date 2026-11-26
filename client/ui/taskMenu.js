// Het menu van een taak, zoals Todoist: met de rechtermuisknop op een taak, of de knop ⋯ die verschijnt als je een taak aanwijst.
// Een klein venstertje bij de muis (geen modaal venster), met:
//   Taak erboven toevoegen · Taak eronder toevoegen
//   Bewerken
//   Datum: Vandaag, Morgen, Dit weekend, Volgende week, Geen datum, ⋯ (de datumkiezer)
//   Prioriteit: P1 … P4
//   Verplaatsen naar… · Dupliceren · Link kopiëren
//   Verwijderen
// Een taak in een project dat je alleen leest: alleen Openen en Link kopiëren. Met het toetsenbord: pijltjes, Home/End, Enter, Esc.
// Wat er gebeurt staat in ui/app.js (handlers.taskMenu); dit bestand tekent alleen het menu.

import { t } from '../core/i18n.js';
import { quickDates } from '../core/quickDates.js';
import { h } from './dom.js';
import { icon } from './icons.js';

let current = null;

/** Sluit het open menu (ook als er een ander opengaat). */
export function closeTaskMenu() {
  current?.close();
}

/**
 * Een klein menu bij een plek op het scherm.
 * @param {{ x: number, y: number } | DOMRect} at waar het menu komt: een punt (rechtermuisknop) of een knop (het menu eronder)
 * @param {(close: () => void) => (Node|false|null)[]} build de inhoud
 * @param {string} label voor schermlezers
 */
export function openPopMenu(at, build, label) {
  closeTaskMenu();
  const box = h('div', { class: 'pop-menu', role: 'menu', 'aria-label': label, tabindex: '-1' });
  const before = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    box.remove();
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    document.removeEventListener('scroll', close, true);
    if (current?.box === box) current = null;
    if (before?.isConnected && box.contains(document.activeElement ?? null) === false) before.focus?.({ preventScroll: true });
  };
  const outside = (e) => { if (!box.contains(e.target)) close(); };
  box.append(...build(close).filter(Boolean));
  document.body.append(box);

  // plaatsen: bij een knop eronder, rechts uitgelijnd; bij een punt rechtsonder de muis; altijd binnen het venster
  const r = box.getBoundingClientRect();
  const margin = 8;
  let x = 'width' in at ? at.right - r.width : at.x;
  let y = 'width' in at ? at.bottom + 4 : at.y;
  if (y + r.height > innerHeight - margin) y = 'width' in at ? Math.max(margin, at.top - r.height - 4) : Math.max(margin, y - r.height);
  x = Math.min(Math.max(margin, x), innerWidth - r.width - margin);
  y = Math.min(Math.max(margin, y), innerHeight - r.height - margin);
  box.style.left = `${Math.round(x)}px`;
  box.style.top = `${Math.round(y)}px`;

  // met het toetsenbord door de knoppen
  const items = () => [...box.querySelectorAll('[role="menuitem"]:not([disabled])')];
  box.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown' || (e.key === 'ArrowRight' && document.activeElement?.closest('.pop-row'))) go(i + 1);
    else if (e.key === 'ArrowUp' || (e.key === 'ArrowLeft' && document.activeElement?.closest('.pop-row'))) go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Tab') close();
  });
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', close, true); // de lijst scrolt onder het menu weg: dicht, zoals Todoist
  }, 0);
  items()[0]?.focus({ preventScroll: true });
  current = { box, close };
  return close;
}

/** Een regel in het menu: pictogram, tekst, en wat er gebeurt (het menu gaat eerst dicht). */
function item(close, { fk, iconName, label, run, danger = false }) {
  return h('button', {
    type: 'button', role: 'menuitem', class: `pop-item${danger ? ' pop-danger' : ''}`, dataset: { fk: `taskmenu:${fk}` },
    onclick: () => { close(); run(); },
  }, icon(iconName), h('span', { class: 'pop-text' }, label));
}

/** Een rij met kleine knoppen (de snelle datums, de prioriteiten), met een kopje erboven. */
function row(title, buttons) {
  return h('div', { class: 'pop-group' }, h('div', { class: 'pop-title' }, title), h('div', { class: 'pop-row', role: 'group', 'aria-label': title }, buttons));
}

const separator = () => h('div', { class: 'pop-sep', role: 'separator' });

/**
 * Het menu van een taak.
 * @param {{
 *   task: object, at: { x: number, y: number } | DOMRect, today: string, readOnly: boolean,
 *   on: { open, addAbove, addBelow, setDate: (date: string | null) => void, moreDates, setPriority: (p: number) => void, move, duplicate, copyLink, remove },
 * }} options
 */
export function openTaskMenu({ task, at, today, readOnly, on }) {
  const q = quickDates(today);
  const dayOf = task.due?.date?.slice(0, 10) ?? null;
  return openPopMenu(at, (close) => {
    if (readOnly) {
      return [
        item(close, { fk: 'open', iconName: 'eye', label: t('taskMenu.open'), run: on.open }),
        item(close, { fk: 'link', iconName: 'link', label: t('task.copyLink'), run: on.copyLink }),
      ];
    }
    const dateButton = (fk, iconName, label, date) => h('button', {
      type: 'button', role: 'menuitem', class: `pop-icon${(date ?? null) === dayOf ? ' is-current' : ''}`, title: label, 'aria-label': label, dataset: { fk: `taskmenu:date-${fk}` },
      onclick: () => { close(); on.setDate(date); },
    }, icon(iconName));
    const prioButton = (p) => h('button', {
      type: 'button', role: 'menuitem', class: `pop-icon prio-${p}${task.priority === p ? ' is-current' : ''}`, title: `P${p}`, 'aria-label': t('taskMenu.priorityN', { p }), dataset: { fk: `taskmenu:p${p}` },
      onclick: () => { close(); on.setPriority(p); },
    }, icon('flag'));
    return [
      !task.checked && item(close, { fk: 'above', iconName: 'arrowUp', label: t('taskMenu.addAbove'), run: on.addAbove }),
      !task.checked && item(close, { fk: 'below', iconName: 'arrowDown', label: t('taskMenu.addBelow'), run: on.addBelow }),
      !task.checked && separator(),
      item(close, { fk: 'edit', iconName: 'pencil', label: t('task.edit'), run: on.open }),
      separator(),
      row(t('taskMenu.date'), [
        dateButton('today', 'today', t('task.quickToday'), q.today),
        dateButton('tomorrow', 'sun', t('task.quickTomorrow'), q.tomorrow),
        dateButton('weekend', 'sofa', t('task.quickWeekend'), q.weekend),
        dateButton('nextweek', 'nextWeek', t('task.quickNextWeek'), q.nextWeek),
        dateButton('none', 'ban', t('task.quickNone'), null),
        h('button', { type: 'button', role: 'menuitem', class: 'pop-icon', title: t('taskMenu.moreDates'), 'aria-label': t('taskMenu.moreDates'), dataset: { fk: 'taskmenu:date-more' }, onclick: () => { close(); on.moreDates(); } }, icon('more')),
      ]),
      row(t('task.priority'), [1, 2, 3, 4].map(prioButton)),
      separator(),
      item(close, { fk: 'move', iconName: 'move', label: t('taskMenu.moveTo'), run: on.move }),
      item(close, { fk: 'duplicate', iconName: 'copy', label: t('task.duplicate'), run: on.duplicate }),
      item(close, { fk: 'link', iconName: 'link', label: t('task.copyLink'), run: on.copyLink }),
      separator(),
      item(close, { fk: 'delete', iconName: 'trash', label: t('common.delete'), run: on.remove, danger: true }),
    ];
  }, t('taskMenu.label', { name: task.content }));
}
