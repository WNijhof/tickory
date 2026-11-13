// Schermen rond het account: inloggen, wachtwoord en apparaten, en (voor beheerders) gebruikersbeheer.

import { ApiError } from '../core/auth.js';
import { confirmDialog, h, menuDialog, openDialog, promptDialog, replace, toast } from './dom.js';

const MIN_PASSWORD = 10;

/** De tijd van laatste gebruik, in begrijpelijk Nederlands ("13 nov. 2026 14:05"). */
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
};

/** Een nette foutmelding voor in een dialoog; bij te veel pogingen met de wachttijd. */
export function errorText(err) {
  if (err instanceof ApiError) {
    if (err.code === 'TOO_MANY_ATTEMPTS' && err.retryAfter) return `Te veel mislukte pogingen. Probeer het over ${Math.ceil(err.retryAfter / 60)} minuten opnieuw.`;
    return err.message;
  }
  return 'Er ging iets mis. Probeer het opnieuw.';
}

/**
 * Het inlogscherm. Het is niet te sluiten: zonder aanmelding is er niets te doen.
 * `attempt(username, password)` voert de aanmelding uit en gooit een ApiError als het niet lukt; de melding staat dan in beeld.
 * Geeft het resultaat van `attempt` terug zodra het gelukt is.
 */
export function loginDialog({ attempt, username = '', note = '' }) {
  return openDialog((finish) => {
    const user = h('input', { class: 'field', type: 'text', value: username, required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: false, 'aria-label': 'Gebruikersnaam' });
    const pass = h('input', { class: 'field', type: 'password', required: true, autocomplete: 'current-password', 'aria-label': 'Wachtwoord' });
    const error = h('p', { class: 'error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'button button-primary' }, 'Inloggen');
    const form = h('form', {
      class: 'dialog-form',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        submit.textContent = 'Bezig…';
        try {
          finish(await attempt(user.value.trim(), pass.value));
        } catch (err) {
          error.textContent = errorText(err);
          pass.value = '';
          pass.focus();
        } finally {
          submit.disabled = false;
          submit.textContent = 'Inloggen';
        }
      },
    },
    h('h2', {}, 'Inloggen'),
    note && h('p', { class: 'hint' }, note),
    h('label', { class: 'field-label' }, 'Gebruikersnaam', user),
    h('label', { class: 'field-label' }, 'Wachtwoord', pass),
    error,
    h('div', { class: 'dialog-buttons' }, submit));
    queueMicrotask(() => (username ? pass : user).focus());
    return form;
  }, { dismissable: false });
}

/** Het wachtwoord wijzigen, als een deel van het accountscherm. */
function passwordSection({ api }) {
  const current = h('input', { class: 'field', type: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Huidig wachtwoord' });
  const next = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', required: true, minLength: MIN_PASSWORD, 'aria-label': 'Nieuw wachtwoord' });
  const again = h('input', { class: 'field', type: 'password', autocomplete: 'new-password', required: true, 'aria-label': 'Nieuw wachtwoord nogmaals' });
  const message = h('p', { class: 'hint', role: 'status' });
  const form = h('form', {
    class: 'section-form',
    onsubmit: async (e) => {
      e.preventDefault();
      message.classList.remove('error');
      if ([...next.value].length < MIN_PASSWORD) return fail(`Het nieuwe wachtwoord heeft minimaal ${MIN_PASSWORD} tekens nodig.`);
      if (next.value !== again.value) return fail('De twee nieuwe wachtwoorden zijn niet gelijk.');
      try {
        await api.changePassword(current.value, next.value);
        current.value = next.value = again.value = '';
        message.textContent = 'Wachtwoord gewijzigd. Je andere apparaten zijn afgemeld.';
      } catch (err) {
        fail(errorText(err));
      }
    },
  },
  h('label', { class: 'field-label' }, 'Huidig wachtwoord', current),
  h('label', { class: 'field-label' }, 'Nieuw wachtwoord', next, h('span', { class: 'hint' }, `Minimaal ${MIN_PASSWORD} tekens.`)),
  h('label', { class: 'field-label' }, 'Nieuw wachtwoord nogmaals', again),
  message,
  h('div', { class: 'dialog-buttons' }, h('button', { type: 'submit', class: 'button' }, 'Wachtwoord wijzigen')));
  function fail(text) {
    message.textContent = text;
    message.classList.add('error');
  }
  return h('details', { class: 'section' }, h('summary', {}, 'Wachtwoord wijzigen'), form);
}

/** De lijst met apparaten waarop dit account is aangemeld. */
function devicesSection({ api, onCurrentRevoked }) {
  const list = h('ul', { class: 'device-list' }, h('li', { class: 'hint' }, 'Laden…'));
  const load = async () => {
    try {
      const { sessions } = await api.sessions();
      replace(list, sessions.map((s) => h('li', { class: 'device' },
        h('div', { class: 'device-info' },
          h('strong', {}, s.name, s.current && h('span', { class: 'badge' }, 'dit apparaat')),
          h('span', { class: 'hint' }, `Laatst gebruikt: ${when(s.last_used_at)}`)),
        !s.current && h('button', {
          type: 'button', class: 'button button-small', onclick: async () => {
            try {
              await api.revokeSession(s.id);
              toast(`${s.name} is afgemeld.`);
            } catch (err) {
              toast(errorText(err), { kind: 'error' });
            }
            load();
          },
        }, 'Afmelden'))));
    } catch (err) {
      replace(list, h('li', { class: 'error' }, errorText(err)));
      if (err instanceof ApiError && err.status === 401) onCurrentRevoked();
    }
  };
  load();
  return h('details', { class: 'section', open: true }, h('summary', {}, 'Aangemelde apparaten'), list);
}

/**
 * Het accountscherm. Geeft 'logout' of 'admin' terug als de gebruiker dat kiest, anders null.
 * @param {{ me: object, api: object }} options
 */
export function accountDialog({ me, api }) {
  return openDialog((finish) => h('div', { class: 'dialog-form' },
    h('h2', {}, 'Account'),
    h('p', {}, h('strong', {}, me.name), ' ', h('span', { class: 'hint' }, `@${me.username}${me.is_admin ? ' · beheerder' : ''}`)),
    devicesSection({ api, onCurrentRevoked: () => finish('relogin') }),
    passwordSection({ api }),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button button-danger button-left', onclick: () => finish('logout') }, 'Afmelden'),
      me.is_admin && h('button', { type: 'button', class: 'button', onclick: () => finish('admin') }, 'Gebruikersbeheer'),
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, 'Sluiten'))), { wide: true });
}

/** Gebruikersbeheer voor beheerders: accounts aanmaken, blokkeren en wachtwoorden herstellen. */
export function adminDialog({ me, api }) {
  return openDialog((finish) => {
    const list = h('ul', { class: 'device-list' }, h('li', { class: 'hint' }, 'Laden…'));
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
      const text = await promptDialog({ title, label: 'Nieuw wachtwoord', type: 'password', okText: 'Instellen', hint: `Minimaal ${MIN_PASSWORD} tekens. Geef het door aan de gebruiker; die kan het daarna zelf wijzigen.` });
      return text;
    }

    async function userMenu(u) {
      const items = [
        { value: 'password', label: 'Wachtwoord herstellen' },
        u.id !== me.id && { value: 'block', label: u.is_disabled ? 'Account weer activeren' : 'Account blokkeren', danger: !u.is_disabled },
        u.id !== me.id && { value: 'admin', label: u.is_admin ? 'Beheerdersrechten afnemen' : 'Beheerder maken' },
      ].filter(Boolean);
      const choice = await menuDialog({ title: `${u.name} (@${u.username})`, items });
      if (choice === 'password') {
        const pw = await pickPassword(`Nieuw wachtwoord voor ${u.name}`);
        if (pw) run(() => api.admin.resetPassword(u.id, pw), `Wachtwoord van ${u.name} is gewijzigd; die is op alle apparaten afgemeld.`);
      } else if (choice === 'block') {
        const ok = u.is_disabled || await confirmDialog({ title: 'Account blokkeren?', text: `${u.name} kan niet meer inloggen en is direct overal afgemeld. De gegevens blijven bewaard.`, okText: 'Blokkeren' });
        if (ok) run(() => api.admin.updateUser(u.id, { is_disabled: !u.is_disabled }), u.is_disabled ? `${u.name} is weer actief.` : `${u.name} is geblokkeerd.`);
      } else if (choice === 'admin') {
        run(() => api.admin.updateUser(u.id, { is_admin: !u.is_admin }), u.is_admin ? `${u.name} is geen beheerder meer.` : `${u.name} is nu beheerder.`);
      }
    }

    async function load() {
      try {
        const { users } = await api.admin.users();
        replace(list, users.map((u) => h('li', { class: 'device' },
          h('div', { class: 'device-info' },
            h('strong', {}, u.name, u.is_admin && h('span', { class: 'badge' }, 'beheerder'), u.is_disabled && h('span', { class: 'badge badge-bad' }, 'geblokkeerd')),
            h('span', { class: 'hint' }, `@${u.username}`)),
          h('button', { type: 'button', class: 'button button-small', onclick: () => userMenu(u) }, 'Beheren'))));
      } catch (err) {
        replace(list, h('li', { class: 'error' }, errorText(err)));
      }
    }

    const username = h('input', { class: 'field', type: 'text', required: true, autocomplete: 'off', autocapitalize: 'none', spellcheck: false, 'aria-label': 'Gebruikersnaam' });
    const name = h('input', { class: 'field', type: 'text', autocomplete: 'off', 'aria-label': 'Naam' });
    const password = h('input', { class: 'field', type: 'password', required: true, minLength: MIN_PASSWORD, autocomplete: 'new-password', 'aria-label': 'Beginwachtwoord' });
    const isAdmin = h('input', { type: 'checkbox' });
    const create = h('form', {
      class: 'section-form',
      onsubmit: (e) => {
        e.preventDefault();
        const input = { username: username.value.trim(), name: name.value.trim() || username.value.trim(), password: password.value, is_admin: isAdmin.checked };
        run(async () => {
          await api.admin.createUser(input);
          username.value = name.value = password.value = '';
          isAdmin.checked = false;
        }, `Account van ${input.name} aangemaakt. Geef de gebruikersnaam en het beginwachtwoord door.`);
      },
    },
    h('label', { class: 'field-label' }, 'Gebruikersnaam', username),
    h('label', { class: 'field-label' }, 'Naam', name),
    h('label', { class: 'field-label' }, 'Beginwachtwoord', password, h('span', { class: 'hint' }, `Minimaal ${MIN_PASSWORD} tekens. De gebruiker kan het daarna zelf wijzigen.`)),
    h('label', { class: 'check-row' }, isAdmin, ' Beheerder'),
    h('div', { class: 'dialog-buttons' }, h('button', { type: 'submit', class: 'button' }, 'Account aanmaken')));

    load();
    return h('div', { class: 'dialog-form' },
      h('h2', {}, 'Gebruikersbeheer'),
      h('details', { class: 'section', open: true }, h('summary', {}, 'Accounts'), list),
      h('details', { class: 'section' }, h('summary', {}, 'Nieuw account'), create),
      message,
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, 'Sluiten')));
  }, { wide: true });
}
