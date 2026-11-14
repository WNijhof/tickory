// Het bord: een project als kolommen (de secties, voorafgegaan door "Zonder sectie") met de taken als kaarten.
// Een kaart is dezelfde regel als in de lijst (cirkel, titel, chips), getekend door render.js; afvinken en openen lopen via
// dezelfde luisteraar (`bindList`). Hier staan alleen de kolommen eromheen.
//
// AANHAKEN VOOR SLEPEN (de werker `dnd` bouwt het slepen; dit bestand doet het niet). Wat er te vinden is in de pagina:
//   div.board                       houder van alle kolommen, horizontaal scrollbaar.   data-project-id
//   section.board-column            een kolom.                                         data-project-id, data-column ("none" of het sectie-id),
//                                                                                      data-section-id ("" voor "Zonder sectie")
//   ul.board-cards                  de lijst kaarten in een kolom: hier laat je een kaart vallen.   data-column, data-section-id, data-project-id
//   li.task.task-card               een kaart.                                         data-task-id (en data-id), data-section-id van de kolom
//   button.card-move                het menu "Verplaats naar…" van een kaart (blijft het toetsenbord- en telefoon-alternatief voor slepen)
//   div.board-column-head           de kop van een kolom (titel, teller, menu)
// Verplaatsen gaat met `actions.moveTask(taskId, { project_id, section_id, beforeId })`; `beforeId` zet de kaart vóór een andere
// kaart, zonder `beforeId` komt ze achteraan. De kaarten staan in de volgorde van `order_key`.
// Na een verplaatsing tekent de app alles opnieuw; kaarten worden hergebruikt (zelfde element per taak zolang de gegevens gelijk zijn).

import { t } from '../core/i18n.js';
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * @param {{
 *   project: object,
 *   columns: { id: string, section: object | null, tasks: object[] }[],
 *   readOnly?: boolean,
 *   handlers: { quickAdd: (target: object) => void, addSection: (project: object) => void, sectionMenu: (section: object) => void },
 *   cards: (tasks: object[]) => HTMLElement[],     // maakt de kaarten (render.js: getekende regels, hergebruikt)
 * }} options
 */
export function boardView({ project, columns, readOnly = false, handlers, cards }) {
  const column = ({ id, section, tasks }) => {
    const sectionId = section?.id ?? '';
    const name = section ? section.name : t('board.noSection');
    const nodes = cards(tasks);
    for (const node of nodes) node.dataset.sectionId = sectionId;
    return h('section', {
      class: `board-column${section ? '' : ' board-column-none'}`, 'aria-label': name,
      dataset: { projectId: project.id, column: id, sectionId },
    },
    h('div', { class: 'board-column-head' },
      h('h2', { class: 'board-column-title' }, name),
      h('span', { class: 'group-count' }, String(tasks.length)),
      section && !readOnly && h('button', {
        class: 'icon-button group-more', type: 'button', 'aria-label': t('section.editLabel', { name: section.name }), title: t('section.editLabel', { name: section.name }),
        dataset: { fk: `sectionmenu:${section.id}` }, onclick: () => handlers.sectionMenu(section),
      }, icon('more'))),
    h('ul', { class: 'board-cards', 'aria-label': t('board.cardsLabel', { name }), dataset: { projectId: project.id, column: id, sectionId } }, nodes),
    !readOnly && h('button', {
      class: 'add-inline', type: 'button', dataset: { fk: `boardadd:${id}` },
      onclick: () => handlers.quickAdd({ projectId: project.id, sectionId: section?.id ?? null }),
    }, icon('plus'), t('quick.addTask')));
  };
  return h('div', { class: 'board', dataset: { projectId: project.id }, role: 'group', 'aria-label': t('board.label', { name: project.name }) },
    columns.map(column),
    !readOnly && h('div', { class: 'board-column board-column-new' },
      h('button', { class: 'add-inline board-add-section', type: 'button', onclick: () => handlers.addSection(project) }, icon('plus'), t('section.add'))));
}
