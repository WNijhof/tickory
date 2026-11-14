// De weergave van een project (lijst, bord of kalender) en wat het bord nodig heeft. Geen scherm.
//
// De keuze staat in `project.view_style` ('list' | 'board' | 'calendar'): dat veld bestaat al in het datamodel (SPEC hoofdstuk 3),
// wordt met `project_update` gesynchroniseerd en geldt dus voor iedereen met wie het project is gedeeld. Een project zonder dat
// veld (gegevens van vóór deze versie, de demo) of met een onbekende waarde is gewoon een lijst; een oudere client kent de
// keuze niet en toont altijd de lijst.

import { projectView } from './selectors.js';

export const VIEW_STYLES = ['list', 'board', 'calendar'];

/** De weergave van een project; alles wat we niet kennen, wordt 'list'. */
export const viewStyleOf = (project) => (VIEW_STYLES.includes(project?.view_style) ? project.view_style : 'list');

/** Een kolom zonder sectie krijgt dit id in plaats van een sectie-id (voor `data-column` en sleutels); in `data-section-id` blijft het leeg. */
export const NO_SECTION = 'none';

/**
 * De kolommen van het bord: eerst "zonder sectie", dan elke sectie op volgorde. Een kaart is een taak van het hoogste niveau;
 * subtaken blijven in de kaart zelf (teller) en in het taakvenster. Voltooide taken doen alleen mee als `showCompleted`.
 * @returns {{ project: object, columns: { id: string, section: object | null, tasks: object[] }[], completedCount: number } | null}
 */
export function boardColumns(view, projectId, { showCompleted = false } = {}) {
  const pv = projectView(view, projectId, { showCompleted });
  if (!pv) return null;
  return {
    project: pv.project,
    completedCount: pv.completedCount,
    columns: pv.groups.map((g) => ({
      id: g.section?.id ?? NO_SECTION,
      section: g.section,
      tasks: g.tasks.filter((x) => x.depth === 0).map((x) => x.task),
    })),
  };
}

/**
 * Waar een kaart heen kan voor het menu "Verplaats naar…": alle kolommen van het project, met aangegeven waar de taak nu staat.
 * (Slepen doet hetzelfde; dit is het alternatief voor wie niet kan of wil slepen, en voor een telefoon.)
 * @returns {{ id: string, sectionId: string | null, name: string | null, current: boolean }[]} `name` is null voor "zonder sectie" (de aanroeper kiest de tekst)
 */
export function moveTargets(view, task) {
  const board = boardColumns(view, task.project_id, { showCompleted: true });
  if (!board) return [];
  const here = view.sections.has(task.section_id) && !view.sections.get(task.section_id).is_archived ? task.section_id : null;
  return board.columns.map((c) => ({ id: c.id, sectionId: c.section?.id ?? null, name: c.section?.name ?? null, current: (c.section?.id ?? null) === here }));
}
