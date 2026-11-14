// De menubalk onderaan op een telefoon (zoals in de Todoist-app): welke knop actief is, en of en waar de ronde knop "+" een taak
// toevoegt. Dit bestand kent de pagina niet; ui/bottomNav.js tekent de balk en de knop met deze uitkomsten.
//
// Vier knoppen: Inbox, Vandaag, Aankomend en Bladeren. Bladeren opent het scherm met wat op een computer in de zijbalk staat
// (zoeken, Voltooid, Meldingen, filters, labels, favorieten, projecten, instellingen). Een scherm dat je daar opent (een project,
// een filter, een label, Voltooid…) hoort bij Bladeren, zoals in de Todoist-app: dan blijft Bladeren actief.

import { isArchivedProject, isForeignLabel } from './selectors.js';
import { canEditProject } from './access.js';

/** De knoppen van de balk, van links naar rechts. */
export const TABS = ['inbox', 'today', 'upcoming', 'browse'];

/**
 * Welke knop is actief?
 * @param {{ type: string, id?: string }} route  het scherm dat in beeld is
 * @param {{ inboxId?: string | null, browseOpen?: boolean }} options  `browseOpen`: het scherm Bladeren staat open
 * @returns {'inbox' | 'today' | 'upcoming' | 'browse'}
 */
export function activeTab(route, { inboxId = null, browseOpen = false } = {}) {
  if (browseOpen) return 'browse';
  if (route?.type === 'today') return 'today';
  if (route?.type === 'upcoming') return 'upcoming';
  if (route?.type === 'project' && inboxId && route.id === inboxId) return 'inbox';
  return 'browse';
}

/**
 * Waar voegt de ronde knop "+" een taak toe? Hetzelfde als de sneltoets `q` (het huidige scherm), met in een label het label al
 * ingevuld. `null`: de knop staat er niet, omdat je hier niets kunt toevoegen (niet ingelogd, een project dat je alleen leest of dat
 * gearchiveerd of weg is, Voltooid, Meldingen, Productiviteit, Activiteit, de lijsten van filters en labels, het scherm Bladeren of
 * tijdens het selecteren: dan staat de actiebalk onderaan).
 * @param {{ type: string, id?: string }} route
 * @param {{ view: object, userId?: string | null, inboxId?: string | null, browseOpen?: boolean, selecting?: boolean }} options
 * @returns {null | { projectId?: string } | { due: 'today' } | { text: string } | {}}
 */
export function fabTarget(route, { view, userId = null, inboxId = null, browseOpen = false, selecting = false }) {
  if (!inboxId || browseOpen || selecting || !route) return null;
  switch (route.type) {
    case 'today': return { due: 'today' };
    case 'upcoming': return {};
    case 'filter': return view.filters?.has(route.id) ? {} : null;
    case 'label': {
      const label = view.labels?.get(route.id);
      if (!label) return null;
      return isForeignLabel(label, userId) ? {} : { text: `@${label.name} ` }; // een label van een ander: gewoon in de Inbox
    }
    case 'project': {
      if (!view.projects.has(route.id)) return null;
      if (!canEditProject(view, route.id, userId) || isArchivedProject(view, route.id)) return null;
      return { projectId: route.id };
    }
    default: return null;
  }
}
