// Schermen rond het account: inloggen, wachtwoord en apparaten, en (voor beheerders) gebruikersbeheer.

import { ApiError, MIN_PASSWORD_LENGTH, displayNameProblem, passwordProblem, usernameProblem } from '../core/auth.js';
import { getLocale, t } from '../core/i18n.js';
import { confirmDialog, h, menuDialog, openDialog, promptDialog, replace, toast } from './dom.js';

const MIN_PASSWORD = MIN_PASSWORD_LENGTH;

/** De tijd van laatste gebruik, in de taal van de interface ("13 nov 2026, 14:05"). */
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' });
};

/** Een nette foutmelding voor in een dialoog; bij te veel pogingen met de wachttijd. */
export function errorText(err) {
  if (err instanceof ApiError) {
    if (err.code === 'TOO_MANY_ATTEMPTS' && err.retryAfter) return t('account.tooManyAttempts', { count: Math.ceil(err.retryAfter / 60) });
    return err.message;
  }
  return t('common.somethingWrong');
}

/**
 * Het inlogscherm. Het is niet te sluiten: zonder aanmelding is er niets te doen.
 * `attempt(username, password)` voert de aanmelding uit en gooit een ApiError als het niet lukt; de melding staat dan in beeld.
 * Geeft het resultaat van `attempt` terug zodra het gelukt is.
 */
export function loginDialog({ attempt, username = '', note = '' }) {
  return openDialog((finish) => {
    const user = h('input', { class: 'field', type: 'text', value: username, required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: false, 'aria-label': t('account.username') });
    const pass = h('input', { class: 'field', type: 'password', required: true, autocomplete: 'current-password', 'aria-label': t('account.password') });
    const error = h('p', { class: 'error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'button button-primary' }, t('login.title'));
    const form = h('form', {
      class: 'dialog-form',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        submit.textContent = t('login.busy');
        try {
          finish(await attempt(user.value.trim(), pass.value));
        } catch (err) {
          error.textContent = errorText(err);
          pass.value = '';
          pass.focus();
        } finally {
          submit.disabled = false;
          submit.textContent = t('login.title');
        }
      },
    },
    h('h2', {}, t('login.title')),
    note && h('p', { class: 'hint' }, note),
    h('label', { class: 'field-label' }, t('account.username'), user),
    h('label', { class: 'field-label' }, t('account.password'), pass),
    error,
    h('div', { class: 'dialog-buttons' }, submit));
    queueMicrotask(() => (username ? pass : user).focus());
    return form;
  }, { dismissable: false });
}

/** Het wachtwoord wijzigen, als een deel van het accountscherm. */
function passwordSection({ me, api }) {
  const current = h('input', { class: 'field', type: 'password', autocomplete: 'current-password', required: true, 'aria-label': t('account.currentPassword') });
  const next = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', required: true, minLength: MIN_PASSWORD, 'aria-label': t('account.newPassword') });
  const again = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', required: true, 'aria-label': t('account.newPasswordAgain') });
  const message = h('p', { class: 'hint', role: 'status' });
  const form = h('form', {
    class: 'section-form',
    onsubmit: async (e) => {
      e.preventDefault();
      message.classList.remove('error');
      if ([...next.value].length < MIN_PASSWORD) return fail(t('account.newPasswordTooShort', { min: MIN_PASSWORD }));
      if (next.value !== again.value) return fail(t('account.passwordsDiffer'));
      // De overige regels van de server (te lang, gelijk aan de gebruikersnaam) al hier, in de taal van de interface.
      const problem = passwordProblem(next.value, me.username);
      if (problem) return fail(problem);
      try {
        await api.changePassword(current.value, next.value);
        current.value = next.value = again.value = '';
        message.textContent = t('account.passwordChanged');
      } catch (err) {
        fail(errorText(err));
      }
    },
  },
  h('label', { class: 'field-label' }, t('account.currentPassword'), current),
  h('label', { class: 'field-label' }, t('account.newPassword'), next, h('span', { class: 'hint' }, t('account.minChars', { min: MIN_PASSWORD }))),
  h('label', { class: 'field-label' }, t('account.newPasswordAgain'), again),
  message,
  h('div', { class: 'dialog-buttons' }, h('button', { type: 'submit', class: 'button' }, t('account.changePassword'))));
  function fail(text) {
    message.textContent = text;
    message.classList.add('error');
  }
  return h('details', { class: 'section' }, h('summary', {}, t('account.changePassword')), form);
}

/** De lijst met apparaten waarop dit account is aangemeld. */
function devicesSection({ api, onCurrentRevoked }) {
  const list = h('ul', { class: 'device-list' }, h('li', { class: 'hint' }, t('common.loading')));
  const load = async () => {
    try {
      const { sessions } = await api.sessions();
      replace(list, sessions.map((s) => h('li', { class: 'device' },
        h('div', { class: 'device-info' },
          h('strong', {}, s.name, s.current && h('span', { class: 'badge' }, t('account.thisDevice'))),
          h('span', { class: 'hint' }, t('account.lastUsed', { when: when(s.last_used_at) }))),
        !s.current && h('button', {
          type: 'button', class: 'button button-small', onclick: async () => {
            try {
              await api.revokeSession(s.id);
              toast(t('account.deviceSignedOut', { name: s.name }));
            } catch (err) {
              toast(errorText(err), { kind: 'error' });
            }
            load();
          },
        }, t('account.signOut')))));
    } catch (err) {
      replace(list, h('li', { class: 'error' }, errorText(err)));
      if (err instanceof ApiError && err.status === 401) onCurrentRevoked();
    }
  };
  load();
  return h('details', { class: 'section', open: true }, h('summary', {}, t('account.devices')), list);
}

/**
 * Het accountscherm. Geeft 'logout' of 'admin' terug als de gebruiker dat kiest, anders null.
 * @param {{ me: object, api: object }} options
 */
export function accountDialog({ me, api }) {
  return openDialog((finish) => h('div', { class: 'dialog-form' },
    h('h2', {}, t('account.title')),
    h('p', {}, h('strong', {}, me.name), ' ', h('span', { class: 'hint' }, `@${me.username}${me.is_admin ? ` · ${t('account.admin')}` : ''}`)),
    devicesSection({ api, onCurrentRevoked: () => finish('relogin') }),
    passwordSection({ me, api }),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button button-danger button-left', onclick: () => finish('logout') }, t('account.signOut')),
      me.is_admin && h('button', { type: 'button', class: 'button', onclick: () => finish('admin') }, t('admin.title')),
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close')))), { wide: true });
}

/** Gebruikersbeheer voor beheerders: accounts aanmaken, blokkeren en wachtwoorden herstellen. */
export function adminDialog({ me, api }) {
  return openDialog((finish) => {
    const list = h('ul', { class: 'device-list' }, h('li', { class: 'hint' }, t('common.loading')));
    const message = h('p', { class: 'hint', role: 'status' });
    const say = (text, bad = false) => {
      message.textContent = text;
      message.classList.toggle('error', bad);
    };
    const run = async (work, done) => {
      try {
        await work();
        if (done) say(done);
      } catch (err) {
        say(errorText(err), true);
      }
      load();
    };

    async function pickPassword(title) {
      const text = await promptDialog({ title, label: t('account.newPassword'), type: 'password', okText: t('admin.setPassword'), hint: t('admin.newPasswordHint', { min: MIN_PASSWORD }) });
      return text;
    }

    async function userMenu(u) {
      const items = [
        { value: 'password', label: t('admin.resetPassword') },
        u.id !== me.id && { value: 'block', label: u.is_disabled ? t('admin.unblock') : t('admin.block'), danger: !u.is_disabled },
        u.id !== me.id && { value: 'admin', label: u.is_admin ? t('admin.revokeAdmin') : t('admin.makeAdmin') },
      ].filter(Boolean);
      const choice = await menuDialog({ title: `${u.name} (@${u.username})`, items });
      if (choice === 'password') {
        const pw = await pickPassword(t('admin.newPasswordFor', { name: u.name }));
        // Dezelfde regels als de server, vóór het versturen: de melding staat er dan meteen, in de taal van de interface.
        const problem = pw ? passwordProblem(pw, u.username) : '';
        if (problem) say(problem, true);
        else if (pw) run(() => api.admin.resetPassword(u.id, pw), t('admin.passwordReset', { name: u.name }));
      } else if (choice === 'block') {
        const ok = u.is_disabled || await confirmDialog({ title: t('admin.blockTitle'), text: t('admin.blockText', { name: u.name }), okText: t('admin.blockOk') });
        if (ok) run(() => api.admin.updateUser(u.id, { is_disabled: !u.is_disabled }), u.is_disabled ? t('admin.nowActive', { name: u.name }) : t('admin.nowBlocked', { name: u.name }));
      } else if (choice === 'admin') {
        run(() => api.admin.updateUser(u.id, { is_admin: !u.is_admin }), u.is_admin ? t('admin.noLongerAdmin', { name: u.name }) : t('admin.nowAdmin', { name: u.name }));
      }
    }

    async function load() {
      try {
        const { users } = await api.admin.users();
        replace(list, users.map((u) => h('li', { class: 'device' },
          h('div', { class: 'device-info' },
            h('strong', {}, u.name, u.is_admin && h('span', { class: 'badge' }, t('account.admin')), u.is_disabled && h('span', { class: 'badge badge-bad' }, t('account.blocked'))),
            h('span', { class: 'hint' }, `@${u.username}`)),
          h('button', { type: 'button', class: 'button button-small', onclick: () => userMenu(u) }, t('admin.manage')))));
      } catch (err) {
        replace(list, h('li', { class: 'error' }, errorText(err)));
      }
    }

    const username = h('input', { class: 'field', type: 'text', required: true, autocomplete: 'off', autocapitalize: 'none', spellcheck: false, 'aria-label': t('account.username') });
    const name = h('input', { class: 'field', type: 'text', autocomplete: 'off', 'aria-label': t('common.name') });
    const password = h('input', { class: 'field', type: 'password', required: true, minLength: MIN_PASSWORD, autocomplete: 'new-password', 'aria-label': t('admin.initialPassword') });
    const isAdmin = h('input', { type: 'checkbox' });
    const create = h('form', {
      class: 'section-form',
      onsubmit: (e) => {
        e.preventDefault();
        const input = { username: username.value.trim(), name: name.value.trim() || username.value.trim(), password: password.value, is_admin: isAdmin.checked };
        // Dezelfde regels als de server en in dezelfde volgorde, vóór het versturen.
        const problem = passwordProblem(input.password, input.username) || usernameProblem(input.username) || displayNameProblem(input.name);
        if (problem) return say(problem, true);
        run(async () => {
          await api.admin.createUser(input);
          username.value = name.value = password.value = '';
          isAdmin.checked = false;
        }, t('admin.created', { name: input.name }));
        return undefined;
      },
    },
    h('label', { class: 'field-label' }, t('account.username'), username),
    h('label', { class: 'field-label' }, t('common.name'), name),
    h('label', { class: 'field-label' }, t('admin.initialPassword'), password, h('span', { class: 'hint' }, t('admin.initialPasswordHint', { min: MIN_PASSWORD }))),
    h('label', { class: 'check-row' }, isAdmin, ` ${t('admin.isAdmin')}`),
    h('div', { class: 'dialog-buttons' }, h('button', { type: 'submit', class: 'button' }, t('admin.createAccount'))));

    load();
    return h('div', { class: 'dialog-form' },
      h('h2', {}, t('admin.title')),
      h('details', { class: 'section', open: true }, h('summary', {}, t('admin.accounts')), list),
      h('details', { class: 'section' }, h('summary', {}, t('admin.newAccount')), create),
      message,
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
  }, { wide: true });
}
