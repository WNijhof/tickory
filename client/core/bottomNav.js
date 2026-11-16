// De menubalk onderaan op een telefoon (zoals in de Todoist-app): welke knop actief is, en of en waar de ronde knop "+" een taak
// toevoegt. Dit bestand kent de pagina niet; ui/bottomNav.js tekent de balk en de knop met deze uitkomsten.
//
// Vier knoppen: Inbox, Vandaag, Aankomend en Bladeren. Bladeren opent het scherm met wat op een computer in de zijbalk staat
// (zoeken, Voltooid, Meldingen, filters, labels, favorieten, projecten, instellingen). Een scherm dat je daar opent (een project,
// een filter, een label, Voltooid…) hoort bij Bladeren, zoals in de Todoist-app: dan blijft Bladeren actief.

import { isArchivedProject, isForeignLabel } from './selectors.js';
import { canEditProject } from './access.js';

/** De knoppen van de balk zoals ze standaard staan, van links naar rechts (zie `tabsFor` voor de eigen keuze). */
export const TABS = ['inbox', 'today', 'upcoming', 'browse'];

/**
 * Welke knop is actief?
 * @param {{ type: string, id?: string }} route  het scherm dat in beeld is
 * @param {{ inboxId?: string | null, browseOpen?: boolean }} options  `browseOpen`: het scherm Bladeren staat open
 * @returns {'inbox' | 'today' | 'upcoming' | 'browse'}
 */
export function activeTab(route, { inboxId = null, browseOpen = false, tabs = TABS } = {}) {
  if (browseOpen) return 'browse';
  const tab = tabOfRoute(route, inboxId);
  return tab && tabs.includes(tab) ? tab : 'browse';
}

/** De knoppen voor een eigen keuze (Instellingen › Algemeen, `bottom_tabs`): de drie gekozen, met Bladeren rechts. */
export const tabsFor = (chosen) => [...chosen, 'browse'];

/** Bij welke knop een scherm hoort (of null: dan bij Bladeren). */
function tabOfRoute(route, inboxId) {
  switch (route?.type) {
    case 'today': return 'today';
    case 'upcoming': return 'upcoming';
    case 'project': return inboxId && route.id === inboxId ? 'inbox' : null;
    case 'notes': return 'notes';
    case 'notifications': return 'notifications';
    case 'completed': return route.id ? null : 'completed';
    case 'filters': case 'filter': return 'filters';
    case 'labels': case 'label': return 'labels';
    default: return null;
  }
}

/** Het scherm van een knop; null voor Bladeren, of de Inbox zolang die nog niet bekend is. */
export function routeOfTab(tab, inboxId) {
  switch (tab) {
    case 'inbox': return inboxId ? { type: 'project', id: inboxId } : null;
    case 'today': case 'upcoming': case 'notes': case 'notifications': case 'completed': case 'filters': case 'labels': return { type: tab };
    default: return null;
  }
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

/** Hoeveel lager het zichtbare deel van het scherm moet worden voordat we aannemen dat het schermtoetsenbord open is. */
export const KEYBOARD_MIN = 150;

/**
 * Houdt bij of het schermtoetsenbord open lijkt: het zichtbare deel van het scherm is flink lager dan het hoogste dat we bij deze
 * breedte zagen (in de Android-app maakt het toetsenbord de WebView kleiner, in een browser het zichtbare deel). Een andere breedte
 * (draaien) begint opnieuw. Alleen de hoogte telt niet: de balk verdwijnt pas als er ook in een invoerveld wordt getypt (ui/bottomNav.js),
 * zodat een lager venster (gesplitst scherm) hem niet laat verdwijnen.
 * @returns {(size: { width: number, height: number }) => boolean}
 */
export function keyboardTracker(min = KEYBOARD_MIN) {
  let base = null;
  return ({ width, height }) => {
    if (!base || width !== base.width) base = { width, height };
    else if (height > base.height) base.height = height;
    return base.height - height > min;
  };
}
