// Uitnodigen via een link (server/invites.ts), aan de kant van de web-app:
//   - in het deelvenster (alleen de eigenaar): een link maken (kan bewerken of alleen lezen, 1, 7 of 30 dagen geldig), hem kopiëren,
//     en de links die nog werken zien en intrekken;
//   - een link openen (#invite=…): na het inloggen en de eerste sync vraagt de app of je mee wilt doen, en opent het project.

import { t } from '../core/i18n.js';
import { DEFAULT_SHARE_ROLE, SHARE_ROLES } from '../../shared/roles.js';
import { confirmDialog, h, replace, toast } from './dom.js';

export const INVITE_TOKEN = /^tki_[A-Za-z0-9_-]{43}$/;
const DAYS = [1, 7, 30];
const PENDING_KEY = 'tickory.invite';

/** Het adres om rond te sturen: de app op deze server, met het token achter #invite=. */
export const inviteUrl = (token) => `${location.origin}${location.pathname}#invite=${token}`;

const ROLE_LABEL = { member: () => t('share.member'), viewer: () => t('share.viewer') };
const DAY_LABEL = { 1: () => t('invite.dayOne'), 7: () => t('invite.daySeven'), 30: () => t('invite.dayThirty') };

const capitalize = (text) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

/** Hoe lang een link nog werkt, in hele dagen (afgerond naar boven). */
const daysLeft = (iso) => Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));

/**
 * Het deel "Uitnodigen met een link" van het deelvenster (alleen voor de eigenaar).
 * @param {{ api: object, project: object }} options
 */
export function inviteSection({ api, project }) {
  const list = h('ul', { class: 'device-list invite-list' });
  const note = h('p', { class: 'hint', role: 'status' });
  const role = h('select', { class: 'field invite-role', 'aria-label': t('invite.roleLabel'), dataset: { fk: 'invite-role' } },
    SHARE_ROLES.map((r) => h('option', { value: r, selected: r === DEFAULT_SHARE_ROLE }, ROLE_LABEL[r]?.() ?? r)));
  const days = h('select', { class: 'field', 'aria-label': t('invite.daysLabel'), dataset: { fk: 'invite-days' } },
    DAYS.map((d) => h('option', { value: String(d), selected: d === 7 }, DAY_LABEL[d]())));
  const made = h('div', { class: 'invite-made', hidden: true });

  const load = async () => {
    try {
      const { invites } = await api.invites.list(project.id);
      replace(list, invites.map((inv) => h('li', { class: 'device', dataset: { inviteId: inv.id } },
        h('div', { class: 'device-info' },
          h('strong', {}, capitalize(ROLE_LABEL[inv.role]?.() ?? inv.role)),
          h('span', { class: 'hint' }, [t('invite.validFor', { count: daysLeft(inv.expires_at) }), t('invite.used', { count: inv.uses })].join(' · '))),
        h('button', {
          type: 'button', class: 'button button-small', dataset: { fk: `invite-revoke:${inv.id}` },
          onclick: async () => {
            try {
              await api.invites.revoke(project.id, inv.id);
              note.textContent = t('invite.revoked');
              await load();
            } catch (err) { note.textContent = err.message; }
          },
        }, t('invite.revoke')))));
    } catch (err) {
      note.textContent = err.message;
    }
  };

  const create = h('button', {
    type: 'button', class: 'button', dataset: { fk: 'invite-create' },
    onclick: async () => {
      note.textContent = '';
      try {
        const inv = await api.invites.create(project.id, { role: role.value, days: Number(days.value) });
        const url = inviteUrl(inv.token);
        const field = h('input', { class: 'field invite-url', type: 'text', readOnly: true, value: url, 'aria-label': t('invite.linkLabel'), dataset: { fk: 'invite-url' } });
        const copy = h('button', {
          type: 'button', class: 'button button-primary', dataset: { fk: 'invite-copy' },
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(url);
              note.textContent = t('invite.copied');
            } catch {
              field.select(); // zonder klembord: geselecteerd, zodat Ctrl+C werkt
              note.textContent = t('invite.copyManually');
            }
          },
        }, t('invite.copy'));
        replace(made, h('p', { class: 'hint' }, t('invite.madeHint')), h('div', { class: 'subtask-row' }, field, copy));
        made.hidden = false;
        field.focus();
        field.select();
        await load();
      } catch (err) {
        note.textContent = err.message;
      }
    },
  }, t('invite.create'));

  load();
  return h('section', { class: 'invite-section', dataset: { fk: 'invite-section' } },
    h('h3', { class: 'subheading' }, t('invite.heading')),
    h('p', { class: 'hint' }, t('invite.intro')),
    h('div', { class: 'invite-row' }, role, days, create),
    made,
    list,
    note);
}

/** Een link uit het adres (#invite=…): onthouden (ook als er eerst ingelogd moet worden) en het adres weer schoon. */
export function takeInviteFromHash() {
  const m = /^#invite=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!m) return false;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (INVITE_TOKEN.test(m[1])) {
    try { sessionStorage.setItem(PENDING_KEY, m[1]); } catch { /* zonder opslag: dan alleen in deze sessie */ }
    pending = m[1];
  }
  return true;
}

let pending = null;
let busy = false;

/**
 * Een onthouden link afhandelen zodra je ingelogd bent en de eerste sync er is: vragen of je meedoet, aannemen, en het project
 * openen. Wordt bij elke wijziging van de toestand aangeroepen (store.subscribe); doet maar één keer iets.
 * @param {{ api: object, store: object, sync: object, navigate: (route: object) => void }} ctx
 */
export async function openPendingInvite({ api, store, sync, navigate }) {
  if (busy) return;
  if (!pending) {
    try { pending = sessionStorage.getItem(PENDING_KEY); } catch { /* geen opslag */ }
  }
  if (!pending || !store.ready || !store.me) return;
  if (document.querySelector('dialog[open]')) return; // straks opnieuw (store.subscribe)
  const token = pending;
  pending = null;
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* geen opslag */ }
  busy = true;
  try {
    const info = await api.invites.preview(token);
    if (info.member) {
      toast(t('invite.already', { project: info.project_name }));
      if (store.view.projects.has(info.project_id)) navigate({ type: 'project', id: info.project_id });
      return;
    }
    const ok = await confirmDialog({
      title: t('invite.title'),
      text: t('invite.text', { owner: info.owner_name, project: info.project_name, role: ROLE_LABEL[info.role]?.() ?? info.role }),
      okText: t('invite.join'),
    });
    if (!ok) return;
    await api.invites.accept(token);
    // het project komt met de volgende sync; dan openen
    const open = () => {
      if (!store.view.projects.has(info.project_id)) return false;
      navigate({ type: 'project', id: info.project_id });
      toast(t('invite.joined', { project: info.project_name }));
      return true;
    };
    await sync.syncNow();
    if (!open()) {
      const stop = store.subscribe(() => { if (open()) stop(); });
      setTimeout(() => stop(), 30_000);
    }
  } catch (err) {
    toast(err.message, { kind: 'error' });
  } finally {
    busy = false;
  }
}
