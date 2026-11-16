// Het venster "Delen" van een notitie (SPEC 5k), in dezelfde stijl als het delen van een project (ui/shareDialog.js): met wie de
// notitie gedeeld is en met welke rol, iemand uitnodigen op gebruikersnaam (kan bewerken of alleen lezen), een rol wijzigen of de
// deling weghalen. Alleen voor de eigenaar; wie een notitie gedeeld kreeg, haalt haar uit het menu van de notitie weg.

import { t } from '../core/i18n.js';
import { confirmDialog, h, openDialog, replace } from './dom.js';

export const NOTE_SHARE_ROLES = Object.freeze(['editor', 'viewer']);
// letterlijke sleutels, zodat de controle op ontbrekende en ongebruikte teksten ze vindt
const ROLE_LABEL = { editor: () => t('note.share.editor'), viewer: () => t('note.share.viewer') };
export const noteRoleLabel = (role) => (Object.hasOwn(ROLE_LABEL, role) ? ROLE_LABEL[role]() : role);

/** De delingen van een notitie, op naam. */
export function sharesOf(store, noteId) {
  const name = (s) => store.users.find((u) => u.id === s.user_id)?.name ?? '';
  return [...(store.view.note_shares?.values() ?? [])].filter((s) => s.note_id === noteId)
    .sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }));
}

/**
 * @param {{ store: import('../core/store.js').Store, actions: object, noteId: string }} options
 * @returns {Promise<void>}
 */
export function openNoteShare({ store, actions, noteId }) {
  let unsubscribe = () => {};
  return openDialog((finish) => {
    const list = h('ul', { class: 'device-list' });
    const status = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    let inviting = false;
    const invite = h('input', {
      class: 'field', type: 'text', placeholder: t('account.username'), autocomplete: 'off', autocapitalize: 'none', spellcheck: false,
      'aria-label': t('share.usernameLabel'), dataset: { fk: 'note-share-username' },
    });
    const inviteRole = h('select', { class: 'field share-role', 'aria-label': t('share.roleLabel'), dataset: { fk: 'note-share-role' } },
      NOTE_SHARE_ROLES.map((r) => h('option', { value: r, selected: r === 'editor' }, noteRoleLabel(r))));
    const form = h('form', {
      class: 'subtask-row share-invite',
      onsubmit: async (e) => {
        e.preventDefault();
        const name = invite.value.trim();
        if (!name) return;
        invite.value = '';
        await actions.shareNote(noteId, name, inviteRole.value);
        status.textContent = t('share.inviting', { name });
        inviting = true;
      },
    }, invite, inviteRole, h('button', { type: 'submit', class: 'button', dataset: { fk: 'note-share-invite' } }, t('note.share')));

    const draw = () => {
      if (!store.view.notes.has(noteId)) return finish(null);
      const focused = document.activeElement?.dataset?.fk ?? null;
      const shares = sharesOf(store, noteId);
      replace(list, [
        h('li', { class: 'device' },
          h('div', { class: 'device-info' },
            h('strong', {}, store.me?.name ?? '', h('span', { class: 'badge' }, t('share.you'))),
            h('span', { class: 'hint' }, t('share.owner')))),
        ...shares.map((s) => {
          const user = store.users.find((u) => u.id === s.user_id);
          const name = user?.name ?? t('common.unknownUser');
          return h('li', { class: 'device', dataset: { userId: s.user_id, role: s.role } },
            h('div', { class: 'device-info' },
              h('strong', {}, name),
              h('span', { class: 'hint' }, `${user ? `@${user.username} · ` : ''}${noteRoleLabel(s.role)}`)),
            h('select', {
              class: 'field field-small share-role', 'aria-label': t('share.roleOf', { name }), dataset: { fk: `note-share-role:${s.user_id}` },
              onchange: (e) => actions.updateNoteShare(s.id, e.target.value),
            }, NOTE_SHARE_ROLES.map((r) => h('option', { value: r, selected: r === s.role }, noteRoleLabel(r)))),
            h('button', {
              type: 'button', class: 'button button-small button-danger', dataset: { fk: `note-share-remove:${s.user_id}` }, onclick: async () => {
                const ok = await confirmDialog({ title: t('note.share.removeTitle'), text: t('note.share.removeText', { name }), okText: t('share.removeOk') });
                if (ok) await actions.deleteNoteShare(s.id);
              },
            }, t('share.remove')));
        }),
      ]);
      if (focused) list.querySelector(`[data-fk="${CSS.escape(focused)}"]`)?.focus();
      const pending = store.queue.filter((q) => q.cmd.type === 'note_share' && q.cmd.args?.note_id === noteId).length;
      if (pending === 0 && inviting) {
        status.textContent = '';
        inviting = false;
      }
    };
    unsubscribe = store.subscribe(draw);
    draw();
    return h('div', { class: 'dialog-form' },
      h('h2', {}, t('note.share.title')),
      h('p', { class: 'hint' }, t('note.share.intro')),
      list,
      form,
      status,
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
  }, { wide: true, onClose: () => unsubscribe(), className: 'dialog-note-share' });
}
