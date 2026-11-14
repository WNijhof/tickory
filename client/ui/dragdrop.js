// Slepen en verplaatsen in de interface: taken in de lijst en naar een project in de zijbalk, projecten in de zijbalk, en het
// toetsenbord-alternatief (Alt + pijl) met aankondigingen voor schermlezers.
//
// Dit bestand regelt alleen het gebaar en het beeld (pointer events: muis, pen en aanraking; een grijper die meebeweegt, een
// invoegstreep, automatisch scrollen). Wat er bij loslaten gebeurt, staat in core/dnd.js (getest zonder scherm), en het
// verplaatsen zelf gaat via de gewone handelingen (actions.moveTask / moveProject), dus optimistisch, offline en met
// foutmeldingen van de server zoals elke andere wijziging.
//
// Gebaar: met een muis of pen begint slepen na 5 px bewegen vanaf een regel. Met aanraking begint het na lang indrukken
// (380 ms zonder te bewegen: wie eerder beweegt, scrolt gewoon) of meteen vanaf het handvat aan de rand van de regel
// (`.drag-handle`, dat geen scrollen toelaat). Een klik of tik blijft een klik of tik.
//
// Aanhaken (zie render.js): `.group[data-drop-project]` (+ `data-drop-section`) is een lijst waar taken in kunnen; `li.task` zijn de
// taken; in de zijbalk zijn `[data-project-id][data-list=inbox|favorite|tree]` de projecten en `[data-drop-top]` de kop "Projecten".
// Het bord (ui/board.js): `.board-column[data-project-id][data-section-id]` is een kolom, `li.task-card` een kaart; slepen werkt als in de
// lijst, maar alleen boven of onder een kaart (geen subtaak maken). De kalender (ui/calendar.js): `td.cal-day[data-date]` is een dag waar
// je een taak op laat vallen en `li.cal-item[data-task-id][data-real=true]` een taak die je kunt slepen (een voorkomen van een herhaling
// dat nog niet aan de beurt is, niet: `data-real=false`); loslaten verzet de datum, het tijdstip en de herhaling blijven.

import { canReorderProject, currentProjectPlan, currentTaskPlan, planCardDrop, planCardKey, planDayDrop, planDayKey, planProjectDrop, planProjectDropToTop, planProjectKey, planTaskDrop, planTaskDropOnGroup, planTaskDropOnProject, planTaskKey, zoneAt } from '../core/dnd.js';
import { dayLabel } from '../core/calendar.js';
import { descendantIds } from '../core/reducer.js';
import { planDate, planGroupDrop } from '../core/bulk.js';
import { MAX_DRAG_GROUP } from '../core/selection.js';
import { projectDescendantIds } from '../core/selectors.js';
import { getLocale, t } from '../core/i18n.js';
import { h, toast } from './dom.js';

const MOUSE_SLOP = 5; // px bewegen voor een muis of pen sleept
const TOUCH_SLOP = 8; // px bewegen vóór de lange druk: dan is het scrollen
const HANDLE_SLOP = 3;
const LONG_PRESS_MS = 380;
const EDGE = 64; // px van de rand waarbinnen automatisch gescrold wordt
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'indent', ArrowLeft: 'outdent' };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {{
 *   content: HTMLElement, sidebar: HTMLElement,
 *   actions: { moveTask: Function, moveProject: Function, updateTask: Function, track: Function, batch: Function, planUpdateTask: Function },
 *   getContext: () => { view: any, userId: string | null, showCompleted: (projectId: string) => boolean },
 *   selection?: ReturnType<typeof import('./selection.js').installSelection>,   // meerdere taken kiezen en samen slepen
 * }} options
 *
 * Slepen en kiezen (ui/selection.js) komen elkaar niet in de weg: op een telefoon kiest lang indrukken de taak en tilt haar op; wie daarna
 * verder beweegt sleept, wie loslaat zonder te bewegen houdt alleen de keuze. Met een muis begint slepen na 5 px zoals altijd en een
 * klik blijft een klik. Sleep je een gekozen taak terwijl er
 * meer gekozen zijn, dan gaan ze samen mee (tot `MAX_DRAG_GROUP` taken, en alleen waar ze alle passen); anders verplaatst alleen de
 * gesleepte taak en zegt een melding waarom.
 */
export function createDragDrop({ content, sidebar, actions, getContext, selection = null }) {
  const undoToast = (text, entry) => (selection ? selection.undoToast(text, entry) : toast(text));
  // ---------- aankondigingen voor schermlezers ----------
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', id: 'dnd-live' });
  document.body.append(live);
  let announceTimer = null;
  const announce = (text) => {
    live.textContent = '';
    clearTimeout(announceTimer);
    // een korte pauze, zodat dezelfde tekst twee keer na elkaar ook twee keer wordt voorgelezen
    announceTimer = setTimeout(() => { live.textContent = text; }, 40);
  };

  // ---------- gebaar ----------
  /** @type {null | { pointerId: number, type: string, x: number, y: number, kind: 'task' | 'project', id: string, el: HTMLElement, timer: any, slop: number, startNow: boolean }} */
  let pending = null;
  /** @type {null | object} */
  let drag = null;
  let openedDrawer = false;
  let scrollRaf = 0;

  /** Een taak in de lijst (`li.task`, ook een kaart op het bord) of in de kalender (`li.cal-item`). */
  const taskRowOf = (el) => el?.closest?.('li.task, li.cal-item') ?? null;
  const taskIdOf = (row) => row.dataset.id ?? row.dataset.taskId;
  const taskSelector = (id) => `li.task[data-id="${CSS.escape(id)}"], li.cal-item[data-task-id="${CSS.escape(id)}"][data-real="true"]`;
  const projectRowOf = (el) => {
    const item = el?.closest?.('#sidebar [data-project-id]');
    return item && item.dataset.list !== 'inbox' ? item : null;
  };

  function startPending(e, kind, id, el, handle) {
    cancelPending();
    const touch = e.pointerType === 'touch';
    pending = { pointerId: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, kind, id, el, timer: null, slop: !touch ? MOUSE_SLOP : handle ? HANDLE_SLOP : TOUCH_SLOP, startNow: false };
    if (touch && !handle) {
      pending.timer = setTimeout(() => {
        if (!pending) return;
        // lang indrukken kiest de taak (als er een selectie is) en tilt haar op; laat je los zonder te bewegen, dan blijft alleen de keuze
        if (selection && kind === 'task') selection.longPress(pending.id);
        beginDrag(pending, pending.x, pending.y);
      }, LONG_PRESS_MS);
    }
  }
  function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  function onPointerDown(e) {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0) || e.isPrimary === false) return;
    const target = e.target;
    if (!(target instanceof Element) || target.closest('dialog')) return;
    const row = taskRowOf(target);
    if (row && content.contains(row)) {
      if (target.closest('[data-act="check"], [data-act="fold"], [data-act="move"], [data-act="select"], [data-act="restore"], .task-actions, .cal-check, a, input, textarea')) return;
      if (row.dataset.real === 'false') return; // een voorkomen van een herhaling in de kalender: er is niets om te verzetten
      if (!getContext().view.tasks.has(taskIdOf(row))) return;
      startPending(e, 'task', taskIdOf(row), row, Boolean(target.closest('.drag-handle')));
      return;
    }
    const item = projectRowOf(target);
    if (item && sidebar.contains(item)) {
      const { view, userId } = getContext();
      if (target.closest('.nav-toggle') || !canReorderProject(view, item.dataset.projectId, userId)) return;
      startPending(e, 'project', item.dataset.projectId, item, false);
    }
  }

  function onPointerMove(e) {
    if (pending && e.pointerId === pending.pointerId) {
      const moved = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
      if (moved >= pending.slop) {
        if (pending.type === 'touch' && pending.timer) cancelPending(); // vóór de lange druk bewogen: de pagina scrolt
        else beginDrag(pending, e.clientX, e.clientY);
      }
      return;
    }
    if (drag && e.pointerId === drag.pointerId) {
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > TOUCH_SLOP) drag.moved = true;
      place();
      update();
    }
  }

  function onPointerUp(e) {
    if (pending && e.pointerId === pending.pointerId) cancelPending();
    if (drag && e.pointerId === drag.pointerId) finish(e.type === 'pointerup');
  }

  // Op een telefoon moet het scrollen stoppen zodra het slepen begint; dat kan alleen met een gebeurtenis die niet "passief" is.
  document.addEventListener('touchmove', (e) => { if (drag && e.cancelable) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', (e) => { if (drag || pending) e.preventDefault(); });
  document.addEventListener('selectstart', (e) => { if (drag || pending) e.preventDefault(); });
  content.addEventListener('pointerdown', onPointerDown);
  sidebar.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
  document.addEventListener('keydown', (e) => {
    if (drag && e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  }, true);
  window.addEventListener('blur', () => { if (drag) finish(false); });

  // ---------- slepen ----------
  function beginDrag(from, x, y) {
    const { view } = getContext();
    cancelPending();
    const entity = from.kind === 'task' ? view.tasks.get(from.id) : view.projects.get(from.id);
    if (!entity) return;
    // het scherm kan tussen indrukken en slepen opnieuw getekend zijn (een sync): dan staat de regel er als nieuw element
    if (!from.el.isConnected) from.el = (from.kind === 'task' ? content.querySelector(taskSelector(from.id)) : sidebar.querySelector(`[data-project-id="${CSS.escape(from.id)}"]`)) ?? from.el;
    const rect = from.el.getBoundingClientRect();
    const group = from.kind === 'task' && selection ? selection.dragSet(from.id) : [from.id];
    const ids = from.kind === 'task' ? [...new Set(group.flatMap((g) => [g, ...descendantIds(view, [g])]))] : [from.id, ...projectDescendantIds(view, from.id)];
    const ghost = from.el.cloneNode(true);
    ghost.classList.add('dnd-ghost');
    ghost.classList.remove('dnd-source');
    ghost.removeAttribute('id');
    ghost.setAttribute('aria-hidden', 'true');
    for (const n of ghost.querySelectorAll('[data-fk]')) n.removeAttribute('data-fk');
    for (const n of ghost.querySelectorAll('.task-actions, .drag-handle, .card-move')) n.remove();
    ghost.style.width = `${Math.min(rect.width, 520)}px`;
    if (from.kind === 'project') ghost.classList.add('dnd-ghost-project');
    if (group.length > 1) ghost.dataset.count = String(group.length); // een teller op de gesleepte regel (dnd.css)
    document.body.append(ghost);
    drag = {
      pointerId: from.pointerId, kind: from.kind, id: from.id, ids: new Set(ids), group, ghost, offX: x - rect.left, offY: y - rect.top, x, y, type: from.type,
      plan: null, target: null, line: null, marked: [], drawerTimer: null, name: entity.content ?? entity.name, startX: x, startY: y, moved: false,
    };
    // het signaal blijft bij een vast element, ook als het scherm tijdens het slepen opnieuw wordt getekend
    try { from.el.releasePointerCapture?.(from.pointerId); } catch { /* geen capture om los te laten */ }
    try { document.body.setPointerCapture?.(from.pointerId); } catch { /* de luisteraars op document vangen het toch */ }
    document.body.classList.add('dnd-active');
    markSource();
    // na het loslaten volgt nog een "klik" op de regel waarop je begon; die mag de taak niet openen
    suppressNextClick();
    navigator.vibrate?.(12);
    place();
    update();
    scrollLoop();
  }

  const markSource = () => {
    for (const id of drag.ids) {
      const els = drag.kind === 'task' ? content.querySelectorAll(taskSelector(id)) : [...sidebar.querySelectorAll(`[data-project-id="${CSS.escape(id)}"]`)].map((x) => x.closest('.nav-row') ?? x);
      for (const el of els) el.classList.add('dnd-source');
    }
  };
  const unmarkAll = () => {
    for (const el of document.querySelectorAll('.dnd-source, .dnd-target, .dnd-target-child')) el.classList.remove('dnd-source', 'dnd-target', 'dnd-target-child');
  };

  function place() {
    drag.ghost.style.transform = `translate3d(${Math.round(drag.x - drag.offX)}px, ${Math.round(drag.y - drag.offY - (drag.type === 'touch' ? 28 : 0))}px, 0)`;
  }

  /** Waar valt het neer? Zoekt boven welk deel van welke regel de aanwijzer staat, en vraagt core/dnd.js wat dat betekent. */
  function update() {
    const { view, userId } = getContext();
    const stillThere = drag.kind === 'task' ? view.tasks.has(drag.id) : view.projects.has(drag.id);
    if (!stillThere) { finish(false); return; }
    markSource();
    for (const el of document.querySelectorAll('.dnd-target, .dnd-target-child')) el.classList.remove('dnd-target', 'dnd-target-child');
    let plan = null;
    let line = null; // { x, y, width } in schermcoördinaten
    let label = null;
    const at = (x, y) => document.elementFromPoint(x, y);
    const inSidebar = (el) => Boolean(el?.closest?.('#sidebar'));
    let hit = at(drag.x, drag.y);

    if (drag.kind === 'task') {
      const overSidebar = inSidebar(hit);
      if (overSidebar) {
        const item = hit.closest('[data-project-id]');
        if (item) {
          plan = planTaskDropOnProject(view, { dragId: drag.id, projectId: item.dataset.projectId });
          if (plan) {
            (item.closest('.nav-row') ?? item).classList.add('dnd-target');
            label = { project: view.projects.get(item.dataset.projectId)?.name ?? '' };
          }
        }
      } else if (hit?.closest?.('.board-column[data-project-id]')) {
        // het bord: boven of onder een kaart (geen subtaak), op de kop van een kolom, of in de ruimte van de kolom
        const column = hit.closest('.board-column[data-project-id]');
        const card = hit.closest('li.task-card');
        const target = { projectId: column.dataset.projectId, sectionId: column.dataset.sectionId || null };
        if (card && column.contains(card)) {
          const r = card.getBoundingClientRect();
          const zone = zoneAt((drag.y - r.top) / r.height, false);
          plan = planCardDrop(view, { dragId: drag.id, overId: card.dataset.id, zone, ...target });
          if (plan) line = { x: r.left, y: zone === 'before' ? r.top : r.bottom, width: r.width };
        } else {
          plan = planTaskDropOnGroup(view, { dragId: drag.id, ...target, edge: hit.closest('.board-column-head') ? 'start' : 'end' });
          if (plan) column.classList.add('dnd-target');
        }
        if (plan) label = { container: plan.section_id ? containerName(view, plan) : t('board.noSection') };
      } else if (hit?.closest?.('td.cal-day[data-date]')) {
        // de kalender: een dag, de taak krijgt die datum
        const cell = hit.closest('td.cal-day[data-date]');
        plan = planDayDrop(view, { dragId: drag.id, date: cell.dataset.date });
        if (plan) {
          cell.classList.add('dnd-target');
          label = { day: dayLabel(getLocale(), plan.date, 'long') };
        }
      } else {
        // ook net naast de lijst (in de marge) telt als boven de lijst
        const list = content.getBoundingClientRect();
        if (!content.contains(hit) && drag.x < list.left + 40 && drag.x > list.left - 60) hit = at(clamp(drag.x, list.left + 60, list.right - 60), drag.y);
        const group = hit?.closest?.('.group[data-drop-project]');
        const row = taskRowOf(hit);
        if (group && row && group.contains(row)) {
          const r = row.getBoundingClientRect();
          const zone = zoneAt((drag.y - r.top) / r.height, true);
          const depth = Number(row.dataset.depth ?? 0);
          const next = row.nextElementSibling;
          const overExpanded = Boolean(next && Number(next.dataset.depth ?? 0) > depth);
          plan = planTaskDrop(view, { dragId: drag.id, overId: row.dataset.id, zone, overExpanded });
          if (plan) {
            const step = depth > 0 ? (r.left - row.parentElement.getBoundingClientRect().left) / depth : 28;
            if (zone === 'child') row.classList.add('dnd-target-child');
            else if (zone === 'before') line = { x: r.left, y: r.top, width: r.width };
            else line = { x: r.left + (overExpanded ? step : 0), y: r.bottom, width: r.width - (overExpanded ? step : 0) };
            label = { container: containerName(view, plan) };
          }
        } else if (group) {
          const head = hit.closest('.group-head');
          plan = planTaskDropOnGroup(view, { dragId: drag.id, projectId: group.dataset.dropProject, sectionId: group.dataset.dropSection || null, edge: head ? 'start' : 'end' });
          if (plan) {
            group.classList.add('dnd-target');
            label = { container: containerName(view, plan) };
          }
        }
      }
    } else {
      const item = projectRowOf(hit) ?? (hit?.closest?.('#sidebar [data-project-id][data-list="inbox"]') ?? null);
      const heading = hit?.closest?.('#sidebar [data-drop-top]');
      if (item?.dataset.list === 'inbox' || heading) {
        plan = planProjectDropToTop(view, { dragId: drag.id, userId });
        const el = heading ?? item;
        if (plan) { el.classList.add('dnd-target'); }
      } else if (item) {
        const rowEl = item.closest('.nav-row') ?? item;
        const r = rowEl.getBoundingClientRect();
        const favorite = item.dataset.list === 'favorite';
        const zone = zoneAt((drag.y - r.top) / r.height, !favorite);
        const overExpanded = !favorite && rowEl.dataset.hasChildren === 'true';
        plan = planProjectDrop(view, { dragId: drag.id, overId: item.dataset.projectId, zone, userId, overExpanded, favoritesOnly: favorite });
        if (plan) {
          const stepPx = 14;
          if (zone === 'child') rowEl.classList.add('dnd-target-child');
          else if (zone === 'before') line = { x: r.left + 10, y: r.top, width: r.width - 10 };
          else line = { x: r.left + 10 + (overExpanded ? stepPx : 0), y: r.bottom, width: r.width - 10 - (overExpanded ? stepPx : 0) };
        }
      }
    }
    drag.plan = plan;
    drag.label = label;
    drag.ghost.classList.toggle('dnd-nodrop', !plan);
    drawLine(line);
    maybeOpenDrawer();
  }

  const containerName = (view, plan) => {
    if (plan.parent_id) return view.tasks.get(plan.parent_id)?.content ?? '';
    return (plan.section_id ? view.sections.get(plan.section_id)?.name : view.projects.get(plan.project_id)?.name) ?? '';
  };

  function drawLine(line) {
    if (!line) {
      drag.line?.remove();
      drag.line = null;
      return;
    }
    drag.line ??= document.body.appendChild(h('div', { class: 'dnd-line', 'aria-hidden': 'true' }));
    Object.assign(drag.line.style, { left: `${Math.round(line.x)}px`, top: `${Math.round(line.y - 1)}px`, width: `${Math.round(line.width)}px` });
  }

  /** Op een telefoon is de zijbalk een lade: even bij de linkerrand blijven slepen opent hem, zodat je op een project kunt loslaten. */
  function maybeOpenDrawer() {
    const narrow = globalThis.matchMedia?.('(max-width: 760px)').matches;
    if (!narrow || drag.kind !== 'task') return;
    const near = drag.x < 28 && !document.body.classList.contains('nav-open');
    if (near && !drag.drawerTimer) {
      drag.drawerTimer = setTimeout(() => {
        if (drag) { document.body.classList.add('nav-open'); openedDrawer = true; }
      }, 450);
    } else if (!near && drag.drawerTimer) {
      clearTimeout(drag.drawerTimer);
      drag.drawerTimer = null;
    }
  }

  // automatisch scrollen aan de randen van het scherm of van de zijbalk
  function scrollLoop() {
    cancelAnimationFrame(scrollRaf);
    const tick = () => {
      if (!drag) return;
      const side = sidebar.getBoundingClientRect();
      const overSidebar = drag.x >= side.left && drag.x <= side.right && side.width > 0 && getComputedStyle(sidebar).visibility !== 'hidden';
      let dy = 0;
      const area = overSidebar ? { top: side.top, bottom: side.bottom } : { top: 70, bottom: window.innerHeight }; // 70: de vaste balk bovenaan
      if (drag.y < area.top + EDGE) dy = -Math.ceil(((area.top + EDGE - drag.y) / EDGE) * 18);
      else if (drag.y > area.bottom - EDGE) dy = Math.ceil(((drag.y - (area.bottom - EDGE)) / EDGE) * 18);
      if (dy !== 0) {
        if (overSidebar) sidebar.scrollTop += dy;
        else window.scrollBy(0, dy);
        update();
      }
      // een bord dat breder is dan het scherm: bij de linker- of rechterrand schuift het zijwaarts
      const board = overSidebar ? null : document.querySelector('.board');
      if (board && drag.kind === 'task') {
        const b = board.getBoundingClientRect();
        let dx = 0;
        if (drag.y >= b.top && drag.y <= b.bottom && board.scrollWidth > board.clientWidth) {
          if (drag.x < b.left + EDGE) dx = -Math.ceil(((b.left + EDGE - drag.x) / EDGE) * 22);
          else if (drag.x > b.right - EDGE) dx = Math.ceil(((drag.x - (b.right - EDGE)) / EDGE) * 22);
        }
        if (dx !== 0) {
          board.scrollLeft += dx;
          update();
        }
      }
      scrollRaf = requestAnimationFrame(tick);
    };
    scrollRaf = requestAnimationFrame(tick);
  }

  let swallow = null;
  function suppressNextClick() {
    if (swallow) document.removeEventListener('click', swallow, true);
    swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    document.addEventListener('click', swallow, true);
  }
  function releaseClick() {
    // een klik na loslaten komt direct; blijft hij uit (losgelaten op een ander element), dan ruimen we de blokkade zelf op
    setTimeout(() => { if (swallow) { document.removeEventListener('click', swallow, true); swallow = null; } }, 60);
  }

  async function finish(drop) {
    const d = drag;
    drag = null;
    cancelAnimationFrame(scrollRaf);
    clearTimeout(d.drawerTimer);
    d.ghost.remove();
    d.line?.remove();
    unmarkAll();
    document.body.classList.remove('dnd-active');
    try { document.body.releasePointerCapture?.(d.pointerId); } catch { /* al los */ }
    if (openedDrawer) { document.body.classList.remove('nav-open'); openedDrawer = false; }
    releaseClick();
    selection?.dragEnded(Boolean(d.moved));
    if (!drop) {
      announce(t('dnd.cancelled'));
      return;
    }
    if (!d.moved && d.type === 'touch') return; // lang indrukken en loslaten zonder te bewegen: alleen gekozen, niets verplaatst
    if (d.plan) await commit(d).catch((err) => { console.error(err); toast(t('common.somethingWrong'), { kind: 'error' }); });
  }

  /** Voert het plan uit en meldt het: een toelichting voor schermlezers, en een melding met "Ongedaan maken" (core/undo.js). */
  async function commit(d) {
    const { view } = getContext();
    if (d.kind === 'task' && d.group.length > 1) {
      if (await commitGroup(d, view)) return;
    }
    if (d.kind === 'task' && d.plan.date) {
      const text = t('dnd.dayMoved', { name: d.name, date: d.label?.day ?? d.plan.date });
      const { entry } = await actions.track(text, () => actions.updateTask(d.id, { due: d.plan.due }));
      undoToast(text, entry);
      announce(text);
    } else if (d.kind === 'task') {
      const before = currentTaskPlan(view, d.id);
      const moved = d.plan.project_id !== before.project_id;
      const where = d.label?.project ?? d.label?.container ?? '';
      const text = moved ? t('dnd.movedToProject', { name: d.name, project: where }) : t('dnd.dropped', { name: d.name, container: where });
      const { entry } = await actions.track(text, () => actions.moveTask(d.id, d.plan));
      if (moved) undoToast(text, entry);
      announce(d.plan.parent_id ? t('dnd.droppedSub', { name: d.name, parent: where }) : t('dnd.dropped', { name: d.name, container: where }));
    } else {
      const before = currentProjectPlan(view, d.id);
      const nested = d.plan.parent_id !== before.parent_id;
      const parent = d.plan.parent_id ? view.projects.get(d.plan.parent_id)?.name ?? '' : '';
      const text = d.plan.parent_id ? t('dnd.projectNested', { name: d.name, parent }) : t('dnd.projectTop', { name: d.name });
      const { entry } = await actions.track(text, () => actions.moveProject(d.id, d.plan));
      if (nested) undoToast(text, entry);
      announce(d.plan.parent_id && nested ? t('dnd.projectNested', { name: d.name, parent }) : nested ? t('dnd.projectTop', { name: d.name }) : t('dnd.projectDropped', { name: d.name }));
    }
  }

  /**
   * Meerdere gekozen taken samen neerzetten. Geeft true als dat gelukt is; false als alleen de gesleepte taak kan (dan staat er al een
   * melding die zegt waarom, en gaat `commit` door met die ene).
   */
  async function commitGroup(d, view) {
    const order = selection.order();
    const where = d.label?.project ?? d.label?.container ?? '';
    if (d.plan.date) {
      const plan = planDate(view, d.group, d.plan.date, (id, changes) => actions.planUpdateTask(id, changes));
      if (plan.commands.length === 0) return true;
      const text = t('dnd.dayMovedMany', { count: plan.count, date: d.label?.day ?? d.plan.date });
      const { entry } = await actions.batch(plan.commands, { label: text });
      selection.done();
      undoToast(text, entry);
      announce(text);
      return true;
    }
    const plan = planGroupDrop(view, d.group, d.plan, order);
    if (!plan.ok) {
      const text = plan.reason === 'many' ? t('bulk.dragOnlyOneMany', { name: d.name, max: MAX_DRAG_GROUP }) : t('bulk.dragOnlyOneHere', { name: d.name });
      toast(text, { timeout: 10_000 });
      announce(text);
      return false;
    }
    const text = t('bulk.dragMovedMany', { count: plan.count, container: where });
    const { entry } = await actions.batch(plan.commands, { label: text });
    selection.done();
    undoToast(text, entry);
    announce(text);
    return true;
  }

  // ---------- toetsenbord ----------
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !Object.hasOwn(KEYS, e.key) || drag) return;
    if (document.querySelector('dialog[open]')) return;
    const command = KEYS[e.key];
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest('input, textarea, select, [contenteditable]')) return;
    const row = taskRowOf(target);
    if (row && content.contains(row) && row.closest('.board-column')) {
      e.preventDefault();
      keyboardCard(row.dataset.id, command);
      return;
    }
    if (row && content.contains(row) && row.matches('li.cal-item')) {
      e.preventDefault();
      if (row.dataset.real !== 'false') keyboardDay(row.dataset.taskId, command);
      return;
    }
    if (row && content.contains(row) && row.closest('.group[data-drop-project]')) {
      e.preventDefault();
      keyboardTask(row.dataset.id, command);
      return;
    }
    const item = target.closest('#sidebar [data-project-id]');
    if (item && item.dataset.list !== 'inbox' && sidebar.contains(item)) {
      const { view, userId } = getContext();
      if (!canReorderProject(view, item.dataset.projectId, userId)) return; // leden zien dit niet als mogelijkheid
      e.preventDefault();
      keyboardProject(item.dataset.projectId, command, item.dataset.list === 'favorite');
    }
  });

  /** Waarom het toetsenbord niets deed ("staat al bovenaan"), voor schermlezers. */
  function announceBlocked(reason, name) {
    if (reason === 'first') announce(t('dnd.alreadyFirst', { name }));
    else if (reason === 'last') announce(t('dnd.alreadyLast', { name }));
    else if (reason === 'noPrevious') announce(t('dnd.noPrevious', { name }));
    else if (reason === 'noParent') announce(t('dnd.noParent', { name }));
  }

  function keyboardTask(id, command) {
    const { view, showCompleted } = getContext();
    const task = view.tasks.get(id);
    if (!task) return;
    const showAll = showCompleted(task.project_id);
    const r = planTaskKey(view, id, command, { isVisible: showAll ? () => true : (x) => !x.checked });
    const name = task.content;
    if (r.blocked) {
      announceBlocked(r.blocked, name);
      return;
    }
    actions.track(name, () => actions.moveTask(id, r.plan));
    if (r.kind === 'indented') announce(t('dnd.droppedSub', { name, parent: r.parent }));
    else if (r.kind === 'outdented') announce(t('dnd.outdented', { name, parent: r.parent }));
    else announce(t('dnd.keyMoved', { name, position: r.position, count: r.count, container: r.container }));
  }

  /** Op het bord: omhoog en omlaag in de kolom, links en rechts naar de kolom ernaast. */
  function keyboardCard(id, command) {
    const { view, showCompleted } = getContext();
    const task = view.tasks.get(id);
    if (!task) return;
    const showAll = showCompleted(task.project_id);
    const r = planCardKey(view, id, command, { isVisible: showAll ? () => true : (x) => !x.checked });
    const name = task.content;
    if (r.blocked) {
      if (r.blocked === 'first') announce(t('dnd.alreadyFirst', { name }));
      else if (r.blocked === 'last') announce(t('dnd.alreadyLast', { name }));
      else if (r.blocked === 'noColumnBefore') announce(t('dnd.noColumnBefore', { name }));
      else if (r.blocked === 'noColumnAfter') announce(t('dnd.noColumnAfter', { name }));
      return;
    }
    actions.track(name, () => actions.moveTask(id, r.plan));
    announce(t('dnd.keyMoved', { name, position: r.position, count: r.count, container: r.plan.section_id ? r.container : t('board.noSection') }));
  }

  /** In de kalender: links en rechts een dag, omhoog en omlaag een week. */
  function keyboardDay(id, command) {
    const { view } = getContext();
    const task = view.tasks.get(id);
    if (!task) return;
    const r = planDayKey(view, id, command);
    if (r.blocked) return;
    actions.track(task.content, () => actions.updateTask(id, { due: r.plan.due }));
    announce(t('dnd.dayMoved', { name: task.content, date: dayLabel(getLocale(), r.date, 'long') }));
  }

  function keyboardProject(id, command, favoritesOnly) {
    const { view, userId } = getContext();
    const project = view.projects.get(id);
    if (!project) return;
    const r = planProjectKey(view, id, command, { userId, favoritesOnly });
    const name = project.name;
    if (r.blocked) {
      announceBlocked(r.blocked, name);
      return;
    }
    actions.track(name, () => actions.moveProject(id, r.plan));
    if (r.kind === 'indented') announce(t('dnd.projectNested', { name, parent: r.parent }));
    else if (r.kind === 'outdented') announce(r.plan.parent_id ? t('dnd.projectNested', { name, parent: view.projects.get(r.plan.parent_id)?.name ?? '' }) : t('dnd.projectTop', { name }));
    else announce(t('dnd.projectKeyMoved', { name, position: r.position, count: r.count }));
  }

  return { announce, isDragging: () => Boolean(drag) };
}
