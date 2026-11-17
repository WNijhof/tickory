// Secties verplaatsen: slepen aan de kop van een sectie (lijst) of een kolom (bord), Alt + pijl op de kop, of "Omhoog" en "Omlaag"
// in het menu van de sectie (ui/dragdrop.js, ui/app.js). Zonder scherm: welke plek en welke volgordesleutel. Een plan is
// `{ beforeId }`: vóór die sectie (null = achteraan). Gearchiveerde secties tellen niet mee (je ziet ze niet). "Zonder sectie" staat
// altijd vooraan en verplaatst niet.

import { canEditProject } from './access.js';
import { placeKey } from './dnd.js';
import { byOrder, isArchivedProject } from './selectors.js';

/** De secties van een project zoals de lijst en het bord ze tonen: niet gearchiveerd, op volgorde. */
export function projectSections(view, projectId, exceptId = null) {
  return [...view.sections.values()].filter((s) => s.project_id === projectId && !s.is_archived && s.id !== exceptId).sort(byOrder);
}

/** Mag deze gebruiker de sectie verplaatsen? Wie in het project mag wijzigen (geen lezer), en niet in een gearchiveerd project. */
export function canMoveSection(view, sectionId, userId) {
  const section = view.sections.get(sectionId);
  if (!section || section.is_archived) return false;
  return canEditProject(view, section.project_id, userId) && !isArchivedProject(view, section.project_id);
}

/** De plek van nu, als plan. */
export function currentSectionPlan(view, id) {
  const section = view.sections.get(id);
  if (!section) return null;
  const list = projectSections(view, section.project_id);
  return { beforeId: list[list.findIndex((s) => s.id === id) + 1]?.id ?? null };
}

const positionOf = (view, section, plan) => {
  const others = projectSections(view, section.project_id, section.id);
  const found = plan.beforeId ? others.findIndex((s) => s.id === plan.beforeId) : -1;
  return { position: (found < 0 ? others.length : found) + 1, count: others.length + 1 };
};

/**
 * Loslaten vóór (`zone` 'before') of na ('after') de sectie `overId`. Geeft `{ beforeId }`, of null als er niets verandert of het
 * niet kan (een ander project, geen recht).
 */
export function planSectionDrop(view, { dragId, overId, zone, userId = null }) {
  const drag = view.sections.get(dragId);
  const over = view.sections.get(overId);
  if (!drag || !over || dragId === overId || over.project_id !== drag.project_id || over.is_archived) return null;
  if (!canMoveSection(view, dragId, userId)) return null;
  const others = projectSections(view, drag.project_id, dragId);
  const i = others.findIndex((s) => s.id === overId);
  const beforeId = zone === 'before' ? overId : others[i + 1]?.id ?? null;
  if (beforeId === currentSectionPlan(view, dragId).beforeId) return null;
  return { beforeId };
}

/**
 * Met het toetsenbord of het menu een plek eerder ('up', op het bord ook 'left') of later ('down', 'right'). Geeft
 * `{ plan, position, count }` of `{ blocked }`: 'first', 'last', 'denied', 'gone' of 'unknown'.
 */
export function planSectionKey(view, id, command, { userId = null } = {}) {
  const section = view.sections.get(id);
  if (!section || section.is_archived) return { blocked: 'gone' };
  if (!canMoveSection(view, id, userId)) return { blocked: 'denied' };
  const list = projectSections(view, section.project_id);
  const i = list.findIndex((s) => s.id === id);
  let plan;
  if (command === 'up' || command === 'left') {
    if (i === 0) return { blocked: 'first' };
    plan = { beforeId: list[i - 1].id };
  } else if (command === 'down' || command === 'right') {
    if (i === list.length - 1) return { blocked: 'last' };
    plan = { beforeId: list[i + 2]?.id ?? null };
  } else {
    return { blocked: 'unknown' };
  }
  return { plan, ...positionOf(view, section, plan) };
}

/** Plek en totaal na een plan, voor de aankondiging. */
export function sectionPosition(view, id, plan) {
  const section = view.sections.get(id);
  return section ? positionOf(view, section, plan) : null;
}

/** De commando's: zo nodig nieuwe sleutels voor buren met dezelfde sleutel, en de nieuwe sleutel van de sectie. */
export function sectionMoveCommands(view, id, plan) {
  const section = view.sections.get(id);
  if (!section) return [];
  const { order_key, rekeys } = placeKey(projectSections(view, section.project_id, id), plan.beforeId);
  return [...rekeys.map((r) => ({ type: 'section_update', args: { id: r.id, order_key: r.order_key } })), { type: 'section_update', args: { id, order_key } }];
}
