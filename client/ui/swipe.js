// Veegacties op een aanraakscherm (P8), zoals in de Todoist-app: een taak in een lijst naar rechts vegen vinkt haar af, naar links
// kies je een nieuwe datum. Onder de taak verschijnt de kleur en het pictogram van de actie; pas als je ver genoeg veegt (een derde
// van de breedte, hooguit 120 pixels) gebeurt er iets bij loslaten, anders schuift de taak terug. Beide zijn ongedaan te maken.
//
// Alleen met een vinger (`pointerType` 'touch'), niet tijdens het selecteren, niet op een kaart van het bord en niet bij een taak die
// je alleen leest of die al af is. Een beweging die vooral omhoog of omlaag gaat, is scrollen; vasthouden is slepen of selecteren
// (ui/dragdrop.js en ui/selection.js): die beginnen pas na een halve seconde stilhouden, vegen begint al bij een korte beweging.

import { reschedule } from '../core/quickDates.js';
import { swipeAction } from '../core/swipe.js';
import { formatDate, todayString } from '../core/format.js';
import { t } from '../core/i18n.js';
import { dateDialog } from './bulkDialogs.js';
import { h } from './dom.js';
import { icon } from './icons.js';

const START = 14;

/**
 * @param {{
 *   content: HTMLElement,
 *   store: import('../core/store.js').Store,
 *   handlers: { toggle: (task: object) => unknown, planTask: (task: object, changes: object, text: string) => Promise<unknown> },
 * }} options
 */
export function installSwipe({ content, store, handlers }) {
  let s = null;

  const release = () => {
    if (!document.body.classList.contains('hold-render')) return;
    document.body.classList.remove('hold-render');
    window.dispatchEvent(new Event('hold-render-end'));
  };
  const reset = (animate = true) => {
    if (!s) return;
    const { row, under } = s;
    if (!animate) release();
    else setTimeout(release, 190); // na het terugschuiven
    if (animate) {
      row.classList.add('swipe-back');
      row.style.transform = '';
      setTimeout(() => { row.classList.remove('swipe-back', 'swiping'); under.remove(); }, 180);
    } else {
      row.classList.remove('swiping');
      row.style.transform = '';
      under.remove();
    }
    s = null;
  };

  content.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !e.isPrimary || s) return;
    if (document.body.classList.contains('select-mode')) return;
    const row = e.target.closest('li.task');
    if (!row || !content.contains(row) || row.classList.contains('task-card') || row.dataset.readonly === 'true' || row.classList.contains('task-done')) return;
    if (e.target.closest('.dnd-handle, input, textarea, select, [contenteditable="true"]')) return;
    const task = store.view.tasks.get(row.dataset.id);
    if (!task || task.checked) return;
    s = { row, task, x: e.clientX, y: e.clientY, dx: 0, active: false, id: e.pointerId, under: null };
  }, { passive: true });

  content.addEventListener('pointermove', (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { s = null; return; } // scrollen
      if (Math.abs(dx) < START || Math.abs(dx) < 2 * Math.abs(dy)) return;
      s.active = true;
      // de kleur en het pictogram komen onder de taak, in de lijst zelf (de taak heeft een eigen achtergrond en schuift erover)
      const parent = s.row.parentElement;
      parent.classList.add('swipe-host');
      s.under = h('div', { class: 'swipe-under', 'aria-hidden': 'true' },
        h('span', { class: 'swipe-left' }, icon('check')), h('span', { class: 'swipe-right' }, icon('calendar')));
      s.under.style.top = `${s.row.offsetTop}px`;
      s.under.style.height = `${s.row.offsetHeight}px`;
      parent.append(s.under);
      s.row.classList.add('swiping');
      document.body.dataset.holdSince = String(Date.now());
      document.body.classList.add('hold-render'); // niet opnieuw tekenen tijdens het vegen (zie invalidate in app.js)
    }
    s.dx = dx;
    const width = s.row.offsetWidth;
    s.row.style.transform = `translateX(${Math.max(-width, Math.min(width, dx))}px)`;
    const action = swipeAction(dx, width);
    s.under.dataset.side = dx > 0 ? 'complete' : 'schedule';
    s.under.classList.toggle('swipe-armed', action !== null);
  });

  const finish = async (e) => {
    if (!s || e.pointerId !== s.id) return;
    if (!s.active) { s = null; return; }
    const { row, task, dx } = s;
    const action = e.type === 'pointerup' ? swipeAction(dx, row.offsetWidth) : null;
    // een veeg is geen tik: de klik die erop volgt opent de taak niet
    window.addEventListener('click', (c) => { c.stopPropagation(); c.preventDefault(); }, { capture: true, once: true });
    setTimeout(() => window.dispatchEvent(new Event('swipe-done')), 0);
    if (!action) { reset(); return; }
    if (action === 'complete') {
      row.style.transform = 'translateX(100%)';
      reset(false);
      await handlers.toggle(task);
      return;
    }
    reset();
    const today = todayString();
    const picked = await dateDialog({ today, hasDue: Boolean(task.due), count: 1, title: t('swipe.dateTitle', { name: task.content }) });
    if (!picked) return;
    const due = picked.date ? reschedule(task.due, picked.date) : null;
    const text = picked.date ? t('swipe.scheduled', { name: task.content, date: formatDate(picked.date, today) }) : t('swipe.unscheduled', { name: task.content });
    await handlers.planTask(task, { due }, text);
  };
  content.addEventListener('pointerup', finish);
  content.addEventListener('pointercancel', finish);
}
