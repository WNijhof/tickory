// Wat de ingelogde gebruiker in een project mag, voor de interface (shared/roles.js; de server beslist, de reducer volgt hem).
// Een lezer (`viewer`) ziet alles, plaatst opmerkingen en zet eigen herinneringen, maar wijzigt niets aan taken, secties of het
// project. De interface toont voor hem geen knoppen om te wijzigen, sleept niets en opent een taak alleen om te lezen.

import { canEditRole } from '../../shared/roles.js';
import { projectList } from './selectors.js';

/**
 * Kan `userId` in dit project wijzigen? Zonder bekende gebruiker, of als de app de leden van het project (nog) niet kent: ja (dan
 * beslist de server). Een lezer heeft altijd zijn eigen ledenrij.
 */
export function canEditProject(view, projectId, userId) {
  if (!userId) return true;
  let known = false;
  for (const m of view.members.values()) {
    if (m.project_id !== projectId) continue;
    if (m.user_id === userId) return canEditRole(m.role);
    known = true;
  }
  return !known;
}

/** Alleen lezen: het omgekeerde van canEditProject. */
export const isReadOnlyProject = (view, projectId, userId) => !canEditProject(view, projectId, userId);

/** Kan `userId` deze taak wijzigen (afvinken, bewerken, verplaatsen)? */
export const canEditTask = (view, task, userId) => Boolean(task) && canEditProject(view, task.project_id, userId);

/** De projecten waar je iets in kunt zetten (de keuzelijst bij een nieuwe of verplaatste taak), met `keep` er altijd bij (het huidige). */
export function editableProjectList(view, userId, keep = null) {
  return projectList(view).filter(({ project }) => project.id === keep || canEditProject(view, project.id, userId));
}

/** Kan `assigneeId` een taak in dit project krijgen? Alleen wie er kan bewerken (een lezer niet). */
export function canBeAssigned(view, projectId, assigneeId) {
  for (const m of view.members.values()) if (m.project_id === projectId && m.user_id === assigneeId) return canEditRole(m.role);
  return false;
}
