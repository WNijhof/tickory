// Het venster om een project te delen: wie erin zit, mensen uitnodigen of eruit halen, of zelf vertrekken.

import { membersOf, roleIn } from '../core/selectors.js';
import { confirmDialog, h, openDialog, replace } from './dom.js';

/**
 * @param {{ store: import('../core/store.js').Store, actions: object, project: object }} options
 * @returns {Promise<'left' | null>} 'left' als je het project hebt verlaten
 */
export function openShareDialog({ store, actions, project }) {
  let unsubscribe = () => {};
  return openDialog((finish) => {
    const list = h('ul', { class: 'device-list' });
    const note = h('p', { class: 'hint', role: 'status' });
    const invite = h('input', { class: 'field', type: 'text', placeholder: 'Gebruikersnaam', autocomplete: 'off', autocapitalize: 'none', spellcheck: false, 'aria-label': 'Gebruikersnaam van de persoon' });
    const footer = h('div', { class: 'dialog-buttons' });
    const inviteRow = h('form', {
      class: 'subtask-row',
      onsubmit: async (e) => {
        e.preventDefault();
        const name = invite.value.trim();
        if (!name) return;
        invite.value = '';
        await actions.shareProject(project.id, name);
        note.textContent = `Uitnodiging voor ${name} wordt verstuurd…`;
      },
    }, invite, h('button', { type: 'submit', class: 'button' }, 'Delen'));

    let shown = false;
    const draw = () => {
      const view = store.view;
      if (shown && !view.projects.has(project.id)) return finish(null); // het project is intussen weg
      const mine = roleIn(view, project.id, store.userId);
      const members = membersOf(view, project.id);
      replace(list, members.map((m) => {
        const user = store.users.find((u) => u.id === m.user_id);
        const self = m.user_id === store.userId;
        return h('li', { class: 'device' },
          h('div', { class: 'device-info' },
            h('strong', {}, user?.name ?? 'Onbekende gebruiker', self && h('span', { class: 'badge' }, 'jij')),
            h('span', { class: 'hint' }, `${user ? `@${user.username} · ` : ''}${m.role === 'owner' ? 'eigenaar' : 'lid'}`)),
          mine === 'owner' && !self && m.role !== 'owner' && h('button', {
            type: 'button', class: 'button button-small button-danger', onclick: async () => {
              const ok = await confirmDialog({
                title: 'Uit het project halen?',
                text: `${user?.name ?? 'Deze persoon'} ziet "${project.name}" niet meer. Toewijzingen en herinneringen van die persoon voor dit project vervallen.`,
                okText: 'Uit het project halen',
              });
              if (ok) await actions.unshareProject(project.id, m.user_id);
            },
          }, 'Verwijderen'));
      }));
      inviteRow.hidden = mine !== 'owner'; // het invoerveld zelf blijft staan, zodat typen niet onderbroken wordt
      replace(footer,
        mine === 'member' && h('button', {
          type: 'button', class: 'button button-danger button-left', onclick: async () => {
            const ok = await confirmDialog({ title: 'Project verlaten?', text: `Je ziet "${project.name}" daarna niet meer, tenzij de eigenaar je opnieuw uitnodigt.`, okText: 'Verlaten' });
            if (!ok) return;
            await actions.leaveProject(project.id);
            finish('left');
          },
        }, 'Project verlaten'),
        h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, 'Sluiten'));
      const pending = store.queue.filter((q) => q.cmd.type === 'project_share' && q.cmd.args?.project_id === project.id).length;
      if (pending === 0 && note.textContent.endsWith('verstuurd…')) note.textContent = '';
    };
    unsubscribe = store.subscribe(draw);
    draw();
    shown = true;
    return h('div', { class: 'dialog-form' },
      h('h2', {}, `Delen: ${project.name}`),
      h('p', { class: 'hint' }, 'Iedereen in dit project ziet en bewerkt dezelfde taken en secties. Herinneringen, labels en filters blijven persoonlijk.'),
      list,
      inviteRow,
      note,
      footer);
  }, { wide: true, onClose: () => unsubscribe() });
}
