// Het venster om een project te delen: wie erin zit, mensen uitnodigen of eruit halen, of zelf vertrekken.

import { t } from '../core/i18n.js';
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
    let inviting = false; // staat de melding "uitnodiging wordt verstuurd" in beeld?
    const invite = h('input', { class: 'field', type: 'text', placeholder: t('account.username'), autocomplete: 'off', autocapitalize: 'none', spellcheck: false, 'aria-label': t('share.usernameLabel') });
    const footer = h('div', { class: 'dialog-buttons' });
    const inviteRow = h('form', {
      class: 'subtask-row',
      onsubmit: async (e) => {
        e.preventDefault();
        const name = invite.value.trim();
        if (!name) return;
        invite.value = '';
        await actions.shareProject(project.id, name);
        note.textContent = t('share.inviting', { name });
        inviting = true;
      },
    }, invite, h('button', { type: 'submit', class: 'button' }, t('project.share')));

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
            h('strong', {}, user?.name ?? t('common.unknownUser'), self && h('span', { class: 'badge' }, t('share.you'))),
            h('span', { class: 'hint' }, `${user ? `@${user.username} · ` : ''}${m.role === 'owner' ? t('share.owner') : t('share.member')}`)),
          mine === 'owner' && !self && m.role !== 'owner' && h('button', {
            type: 'button', class: 'button button-small button-danger', onclick: async () => {
              const ok = await confirmDialog({
                title: t('share.removeTitle'),
                text: t('share.removeText', { name: user?.name ?? t('share.thisPerson'), project: project.name }),
                okText: t('share.removeOk'),
              });
              if (ok) await actions.unshareProject(project.id, m.user_id);
            },
          }, t('share.remove')));
      }));
      inviteRow.hidden = mine !== 'owner'; // het invoerveld zelf blijft staan, zodat typen niet onderbroken wordt
      replace(footer,
        mine === 'member' && h('button', {
          type: 'button', class: 'button button-danger button-left', onclick: async () => {
            const ok = await confirmDialog({ title: t('project.leaveTitle'), text: t('project.leaveText', { name: project.name }), okText: t('project.leaveOk') });
            if (!ok) return;
            await actions.leaveProject(project.id);
            finish('left');
          },
        }, t('project.leave')),
        h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close')));
      const pending = store.queue.filter((q) => q.cmd.type === 'project_share' && q.cmd.args?.project_id === project.id).length;
      if (pending === 0 && inviting) {
        note.textContent = '';
        inviting = false;
      }
    };
    unsubscribe = store.subscribe(draw);
    draw();
    shown = true;
    return h('div', { class: 'dialog-form' },
      h('h2', {}, t('share.title', { name: project.name })),
      h('p', { class: 'hint' }, t('share.intro')),
      list,
      inviteRow,
      note,
      footer);
  }, { wide: true, onClose: () => unsubscribe() });
}
