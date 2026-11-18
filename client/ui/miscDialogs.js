// Kleine vensters: overzicht van sneltoetsen, gearchiveerde projecten, en opmerkingen bij een project.

import { t } from '../core/i18n.js';
import { archivedList } from '../core/selectors.js';
import { SHORTCUT_KEYS } from '../core/shortcuts.js';
import { commentsSection } from './comments.js';
import { dot } from './render.js';
import { h, openDialog, replace } from './dom.js';

/** Het overzicht van sneltoetsen (opent met `?`). */
export function shortcutsDialog() {
  // `sequence`: de toetsen na elkaar ("g dan t"); anders tegelijk ("Ctrl + Enter")
  const keys = (list, sequence) => h('span', { class: 'keys' }, list.flatMap((k, i) => [i > 0 && h('span', { class: 'keys-then' }, sequence ? t('shortcuts.then') : '+'), h('kbd', {}, k)]));
  const row = (list, text, sequence = true) => h('div', { class: 'shortcut' }, h('dt', {}, keys(list, sequence)), h('dd', {}, text));
  return openDialog((finish) => h('div', { class: 'dialog-form' },
    h('h2', {}, t('shortcuts.title')),
    h('dl', { class: 'shortcuts' },
      row(SHORTCUT_KEYS.add, t('shortcuts.add')),
      row(SHORTCUT_KEYS.today, t('shortcuts.goToday')),
      row(SHORTCUT_KEYS.upcoming, t('shortcuts.goUpcoming')),
      row(SHORTCUT_KEYS.inbox, t('shortcuts.goInbox')),
      row(SHORTCUT_KEYS.help, t('shortcuts.help')),
      row(['/'], t('shortcuts.search'), false),
      row(['Ctrl', 'K'], t('shortcuts.search'), false),
      row(['Esc'], t('shortcuts.escape')),
      row(['X'], t('shortcuts.select'), false),
      row(['Ctrl', 'A'], t('shortcuts.selectAll'), false),
      row(['Esc'], t('shortcuts.selectStop'), false),
      row(['Ctrl', 'Z'], t('shortcuts.undo'), false),
      row(['Ctrl', 'Enter'], t('shortcuts.save'), false),
      row(['Alt', '↑ / ↓'], t('shortcuts.moveUpDown'), false),
      row(['Alt', '→ / ←'], t('shortcuts.moveInOut'), false)),
    h('p', { class: 'hint' }, t('shortcuts.note')),
    h('p', { class: 'hint' }, t('shortcuts.dragNote')),
    h('p', { class: 'hint' }, t('shortcuts.viewsNote')),
    h('p', { class: 'hint' }, t('shortcuts.selectNote')),
    h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button button-primary', onclick: () => finish(null) }, t('common.close')))));
}

/** De opmerkingen bij een project. */
export function projectCommentsDialog({ store, actions, project }) {
  let section;
  return openDialog((finish) => {
    section = commentsSection({ target: { projectId: project.id }, store, actions, heading: false });
    return h('div', { class: 'dialog-form' },
      h('h2', {}, t('comment.projectTitle', { name: project.name })),
      section.node,
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
  }, { wide: true, className: 'dialog-comments', onClose: () => section?.dispose() });
}

/**
 * De gearchiveerde projecten, met per project een knop om het te openen en een om het terug te zetten.
 * `onOpen(project)` en `onRestore(project)` doen het werk; het venster tekent zichzelf opnieuw bij elke wijziging.
 */
export function archiveDialog({ store, onOpen, onRestore }) {
  const list = h('ul', { class: 'archive-list' });
  let unsubscribe = () => {};
  return openDialog((finish) => {
    const draw = () => {
      const items = archivedList(store.view);
      replace(list, items.length > 0
        ? items.map(({ project, depth }) => h('li', { class: 'archive-item', dataset: { depth: String(Math.min(depth, 3)) } },
          h('button', { class: 'archive-open', type: 'button', onclick: () => { finish(null); onOpen(project); } }, dot(project.color), h('span', { class: 'archive-name' }, project.name)),
          h('button', { class: 'button button-small', type: 'button', onclick: () => onRestore(project), 'aria-label': t('project.restoreLabel', { name: project.name }) }, t('project.restore'))))
        : [h('li', { class: 'comment-none' }, t('project.archiveEmpty'))]);
    };
    unsubscribe = store.subscribe(draw);
    draw();
    return h('div', { class: 'dialog-form' },
      h('h2', {}, t('nav.archived')),
      list,
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
  }, { onClose: () => unsubscribe() });
}
