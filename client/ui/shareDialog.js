// Het venster om een project te delen: wie erin zit en met welke rol, mensen uitnodigen (kan bewerken of alleen lezen), een rol
// wijzigen of iemand eruit halen (alleen de eigenaar), of zelf vertrekken. De rollen staan in shared/roles.js.

import { t } from '../core/i18n.js';
import { membersOf, roleIn } from '../core/selectors.js';
import { DEFAULT_SHARE_ROLE, SHARE_ROLES } from '../../shared/roles.js';
import { confirmDialog, h, openDialog, replace } from './dom.js';

const ROLE_LABEL = { owner: () => t('share.owner'), member: () => t('share.member'), viewer: () => t('share.viewer') };
const roleLabel = (role) => (Object.hasOwn(ROLE_LABEL, role) ? ROLE_LABEL[role]() : role);

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
    const inviteRole = h('select', { class: 'field share-role', 'aria-label': t('share.roleLabel'), dataset: { fk: 'share-invite-role' } },
      SHARE_ROLES.map((r) => h('option', { value: r, selected: r === DEFAULT_SHARE_ROLE }, roleLabel(r))));
    const footer = h('div', { class: 'dialog-buttons' });
    const inviteRow = h('form', {
      class: 'subtask-row share-invite',
      onsubmit: async (e) => {
        e.preventDefault();
        const name = invite.value.trim();
        if (!name) return;
        invite.value = '';
        await actions.shareProject(project.id, name, inviteRole.value);
        note.textContent = t('share.inviting', { name });
        inviting = true;
      },
    }, invite, inviteRole, h('button', { type: 'submit', class: 'button' }, t('project.share')));

    let shown = false;
    const draw = () => {
      const view = store.view;
      if (shown && !view.projects.has(project.id)) return finish(null); // het project is intussen weg
      const mine = roleIn(view, project.id, store.userId);
      const members = membersOf(view, project.id);
      // de focus blijft op een keuzelijst als die opnieuw getekend wordt
      const focused = document.activeElement?.dataset?.fk ?? null;
      replace(list, members.map((m) => {
        const user = store.users.find((u) => u.id === m.user_id);
        const self = m.user_id === store.userId;
        const name = user?.name ?? t('common.unknownUser');
        const manage = mine === 'owner' && !self && m.role !== 'owner';
        return h('li', { class: 'device', dataset: { userId: m.user_id, role: m.role } },
          h('div', { class: 'device-info' },
            h('strong', {}, name, self && h('span', { class: 'badge' }, t('share.you'))),
            h('span', { class: 'hint' }, `${user ? `@${user.username} · ` : ''}${roleLabel(m.role)}`)),
          manage && h('select', {
            class: 'field field-small share-role', 'aria-label': t('share.roleOf', { name }), dataset: { fk: `share-role:${m.user_id}` },
            onchange: (e) => actions.updateMemberRole(project.id, m.user_id, e.target.value),
          }, SHARE_ROLES.map((r) => h('option', { value: r, selected: r === m.role }, roleLabel(r)))),
          manage && h('button', {
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
      if (focused) list.querySelector(`[data-fk="${CSS.escape(focused)}"]`)?.focus();
      inviteRow.hidden = mine !== 'owner'; // het invoerveld zelf blijft staan, zodat typen niet onderbroken wordt
      replace(footer,
        mine !== 'owner' && mine !== null && h('button', {
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
      h('p', { class: 'hint' }, t('share.rolesHint')),
      list,
      inviteRow,
      note,
      footer);
  }, { wide: true, onClose: () => unsubscribe() });
}
