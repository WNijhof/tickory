// Schermen rond het account: inloggen (ook de tweede stap), wachtwoord, apparaten en tweestapsverificatie, en (voor beheerders)
// gebruikersbeheer en een back-up downloaden.

import { ApiError, MIN_PASSWORD_LENGTH, displayNameProblem, passwordProblem, usernameProblem } from '../core/auth.js';
import { getLocale, t } from '../core/i18n.js';
import { qrCode, qrPath } from '../core/qr.js';
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
 * Heeft het account tweestapsverificatie, dan geeft `attempt` `{two_factor_required, challenge}` terug: dan volgt in hetzelfde
 * scherm de tweede stap, met `attemptCode(challenge, code)` (een code uit de app of een herstelcode).
 * Geeft het resultaat van `attempt` (of `attemptCode`) terug zodra het gelukt is.
 */
export function loginDialog({ attempt, attemptCode, username = '', note = '' }) {
  return openDialog((finish) => {
    const user = h('input', { class: 'field', type: 'text', value: username, required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: false, 'aria-label': t('account.username') });
    const pass = h('input', { class: 'field', type: 'password', required: true, autocomplete: 'current-password', 'aria-label': t('account.password') });
    const error = h('p', { class: 'error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'button button-primary' }, t('login.title'));

    // de tweede stap: een code uit de app, of (telefoon kwijt) een herstelcode
    let challenge = null;
    let recovery = false;
    const code = h('input', { class: 'field login-code', type: 'text', required: true, autocomplete: 'one-time-code', autocapitalize: 'none', spellcheck: false, maxLength: 24, 'aria-label': t('login.code') });
    const codeLabel = h('span', {}, t('login.code'));
    const codeIntro = h('p', { class: 'hint', id: 'login-code-intro' }, t('login.codeIntro'));
    code.setAttribute('aria-describedby', 'login-code-intro');
    const codeError = h('p', { class: 'error', role: 'alert' });
    const codeSubmit = h('button', { type: 'submit', class: 'button button-primary' }, t('login.verify'));
    const setRecovery = (on) => {
      recovery = on;
      code.value = '';
      code.inputMode = on ? 'text' : 'numeric';
      code.setAttribute('aria-label', on ? t('login.recoveryCode') : t('login.code'));
      codeLabel.textContent = on ? t('login.recoveryCode') : t('login.code');
      codeIntro.textContent = on ? t('login.recoveryIntro') : t('login.codeIntro');
      toggle.textContent = on ? t('login.useApp') : t('login.useRecovery');
      codeError.textContent = '';
      code.focus();
    };
    const toggle = h('button', { type: 'button', class: 'link-button', onclick: () => setRecovery(!recovery) }, t('login.useRecovery'));
    const showPassword = (message = '') => {
      challenge = null;
      if (codeForm.isConnected) codeForm.replaceWith(form);
      error.textContent = message;
      pass.value = '';
      pass.focus();
    };
    // pas in het scherm als hij nodig is (en weer eruit bij "terug")
    const codeForm = h('form', {
      class: 'dialog-form',
      onsubmit: async (e) => {
        e.preventDefault();
        codeError.textContent = '';
        codeSubmit.disabled = true;
        codeSubmit.textContent = t('login.busy');
        try {
          finish(await attemptCode(challenge, code.value.trim()));
        } catch (err) {
          // verlopen of te vaak fout: terug naar het wachtwoord, met de melding daar
          if (err instanceof ApiError && err.code === 'CHALLENGE_EXPIRED') showPassword(errorText(err));
          else {
            codeError.textContent = errorText(err);
            code.value = '';
            code.focus();
          }
        } finally {
          codeSubmit.disabled = false;
          codeSubmit.textContent = t('login.verify');
        }
      },
    },
    h('h2', {}, t('login.codeTitle')),
    codeIntro,
    h('label', { class: 'field-label' }, codeLabel, code),
    codeError,
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button button-left', onclick: () => showPassword() }, t('login.back')),
      codeSubmit),
    toggle);

    const form = h('form', {
      class: 'dialog-form',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        submit.textContent = t('login.busy');
        try {
          const res = await attempt(user.value.trim(), pass.value);
          if (res?.two_factor_required) {
            challenge = res.challenge;
            form.replaceWith(codeForm);
            setRecovery(false);
          } else {
            finish(res);
          }
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
    return h('div', { class: 'login' }, form);
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

/** Het soort apparaat zoals de server het uit de User-Agent las: "Webbrowser · Firefox · Windows" (zonder versies). */
function deviceKind(device) {
  if (!device) return '';
  const kind = device.kind === 'browser' ? t('account.deviceKind.browser') : device.kind === 'app' ? t('account.deviceKind.app') : t('account.deviceKind.other');
  return [kind, device.browser, device.os].filter(Boolean).join(' · ');
}

/** De lijst met apparaten waarop dit account is aangemeld, met per stuk afmelden en "alle andere afmelden". */
function devicesSection({ api, onCurrentRevoked }) {
  const list = h('ul', { class: 'device-list' }, h('li', { class: 'hint' }, t('common.loading')));
  const policy = h('p', { class: 'hint' });
  const others = h('button', {
    type: 'button', class: 'button button-small', onclick: async () => {
      const ok = await confirmDialog({ title: t('account.signOutOthersTitle'), text: t('account.signOutOthersText'), okText: t('account.signOutOthers') });
      if (!ok) return;
      try {
        const { revoked } = await api.revokeOtherSessions();
        toast(t('account.signedOutOthers', { count: revoked ?? 0 }));
      } catch (err) {
        toast(errorText(err), { kind: 'error' });
      }
      load();
    },
  }, t('account.signOutOthers'));
  const othersRow = h('div', { class: 'dialog-buttons' }, others);
  const load = async () => {
    try {
      const { sessions, policy: p } = await api.sessions();
      replace(list, sessions.map((s) => h('li', { class: 'device' },
        h('div', { class: 'device-info' },
          h('strong', {}, s.name, s.current && h('span', { class: 'badge' }, t('account.thisDevice'))),
          deviceKind(s.device) && h('span', { class: 'hint device-kind' }, deviceKind(s.device)),
          h('span', { class: 'hint' }, t('account.lastUsed', { when: when(s.last_used_at) })),
          s.created_at && h('span', { class: 'hint' }, t('account.signedInSince', { when: when(s.created_at) }))),
        !s.current && h('button', {
          type: 'button', class: 'button button-small', 'aria-label': `${t('account.signOut')}: ${s.name}`, onclick: async () => {
            try {
              await api.revokeSession(s.id);
              toast(t('account.deviceSignedOut', { name: s.name }));
            } catch (err) {
              toast(errorText(err), { kind: 'error' });
            }
            load();
          },
        }, t('account.signOut')))));
      replace(othersRow, sessions.some((s) => !s.current) && others); // de knop alleen als er iets af te melden is
      policy.textContent = [p?.idle_days > 0 && t('account.policyIdle', { days: p.idle_days }), p?.max_days > 0 && t('account.policyMax', { days: p.max_days })].filter(Boolean).join(' ');
    } catch (err) {
      replace(list, h('li', { class: 'error' }, errorText(err)));
      if (err instanceof ApiError && err.status === 401) onCurrentRevoked();
    }
  };
  load();
  return h('details', { class: 'section devices', open: true }, h('summary', {}, t('account.devices')), list, othersRow, policy);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** De QR-code als SVG (zelf gemaakt, zie core/qr.js), of null als de tekst er te lang voor is. Altijd zwart op wit, ook in donker. */
function qrSvg(text) {
  let code;
  try {
    code = qrCode(text);
  } catch {
    return null;
  }
  const n = code.size + 8;
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: `0 0 ${n} ${n}`, width: String(Math.max(180, n * 4)), height: String(Math.max(180, n * 4)), role: 'img', 'aria-label': t('twoFactor.qrLabel'), class: 'qr', 'shape-rendering': 'crispEdges' })) svg.setAttribute(k, v);
  const bg = document.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of Object.entries({ width: String(n), height: String(n), fill: '#ffffff' })) bg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', qrPath(code));
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

/** Herstelcodes tonen, één keer, met kopiëren. */
function recoveryCodesBlock(codes, onDone) {
  const text = codes.join('\n');
  const field = h('textarea', { class: 'field recovery-codes', readOnly: true, rows: codes.length, 'aria-label': t('twoFactor.codesTitle'), spellcheck: false }, text);
  return h('div', { class: 'section-form two-factor-codes' },
    h('strong', {}, t('twoFactor.codesTitle')),
    h('p', { class: 'hint' }, t('twoFactor.codesText')),
    field,
    h('div', { class: 'dialog-buttons' },
      h('button', {
        type: 'button', class: 'button', onclick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast(t('twoFactor.copied'));
          } catch {
            field.focus(); // zonder toestemming van de browser: de codes staan geselecteerd, kopiëren met Ctrl+C
            field.select();
          }
        },
      }, t('twoFactor.copyCodes')),
      h('button', { type: 'button', class: 'button button-primary', onclick: onDone }, t('twoFactor.saved'))));
}

/** Een formulier met wachtwoord en code (uitzetten, nieuwe herstelcodes). */
function passwordAndCodeForm({ okText, danger = false, onSubmit, onCancel }) {
  const pass = h('input', { class: 'field', type: 'password', required: true, autocomplete: 'current-password', 'aria-label': t('account.password') });
  const code = h('input', { class: 'field', type: 'text', required: true, autocomplete: 'one-time-code', autocapitalize: 'none', spellcheck: false, maxLength: 24, 'aria-label': t('twoFactor.codeOrRecovery') });
  const error = h('p', { class: 'error', role: 'alert' });
  const form = h('form', {
    class: 'section-form',
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        await onSubmit(pass.value, code.value.trim());
      } catch (err) {
        error.textContent = errorText(err);
        code.value = '';
      }
    },
  },
  h('p', { class: 'hint' }, t('twoFactor.confirmHint')),
  h('label', { class: 'field-label' }, t('account.password'), pass),
  h('label', { class: 'field-label' }, t('twoFactor.codeOrRecovery'), code),
  error,
  h('div', { class: 'dialog-buttons' },
    h('button', { type: 'button', class: 'button', onclick: onCancel }, t('common.cancel')),
    h('button', { type: 'submit', class: danger ? 'button button-danger' : 'button button-primary' }, okText)));
  queueMicrotask(() => pass.focus());
  return form;
}

/** Tweestapsverificatie van het eigen account: aanzetten (wachtwoord, QR-code, bevestigen, herstelcodes), uitzetten, nieuwe herstelcodes. */
function twoFactorSection({ api }) {
  const body = h('div', { class: 'two-factor' }, h('p', { class: 'hint' }, t('common.loading')));
  const message = h('p', { class: 'hint', role: 'status' });
  const say = (text) => { message.textContent = text; };

  async function load() {
    try {
      showStatus(await api.twoFactor.status());
    } catch (err) {
      replace(body, h('p', { class: 'error' }, errorText(err)));
    }
  }

  function showStatus(s) {
    if (!s.enabled) {
      replace(body,
        h('p', {}, t('twoFactor.off')),
        h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: askPassword }, t('twoFactor.turnOn'))));
      return;
    }
    replace(body,
      h('p', {}, t('twoFactor.on', { when: when(s.enabled_at), count: s.recovery_codes_left })),
      h('div', { class: 'dialog-buttons' },
        h('button', { type: 'button', class: 'button button-danger button-left', onclick: () => confirmForm('disable') }, t('twoFactor.turnOff')),
        h('button', { type: 'button', class: 'button', onclick: () => confirmForm('codes') }, t('twoFactor.newCodes'))));
  }

  function askPassword() {
    say('');
    const pass = h('input', { class: 'field', type: 'password', required: true, autocomplete: 'current-password', 'aria-label': t('account.password') });
    const error = h('p', { class: 'error', role: 'alert' });
    replace(body, h('form', {
      class: 'section-form',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          showSetup(await api.twoFactor.setup(pass.value));
        } catch (err) {
          error.textContent = errorText(err);
          pass.value = '';
          pass.focus();
        }
      },
    },
    h('p', { class: 'hint' }, t('twoFactor.passwordFirst')),
    h('label', { class: 'field-label' }, t('account.password'), pass),
    error,
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: load }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary' }, t('twoFactor.continue')))));
    pass.focus();
  }

  function showSetup({ secret, uri }) {
    const qr = qrSvg(uri);
    const code = h('input', { class: 'field login-code', type: 'text', inputMode: 'numeric', required: true, autocomplete: 'one-time-code', maxLength: 10, 'aria-label': t('twoFactor.confirmCode') });
    const error = h('p', { class: 'error', role: 'alert' });
    // de sleutel in groepjes van vier, makkelijker over te typen
    const grouped = secret.match(/.{1,4}/g).join(' ');
    replace(body, h('form', {
      class: 'section-form',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          const done = await api.twoFactor.enable(code.value.trim());
          say(t('twoFactor.enabled'));
          replace(body, recoveryCodesBlock(done.recovery_codes, () => { say(''); showStatus(done); }));
        } catch (err) {
          error.textContent = errorText(err);
          code.value = '';
          code.focus();
        }
      },
    },
    h('p', {}, t('twoFactor.scan')),
    qr ? h('div', { class: 'qr-box' }, qr) : h('p', { class: 'hint' }, t('twoFactor.noQr')),
    h('p', { class: 'two-factor-secret' }, `${t('twoFactor.secret')}: `, h('code', { class: 'secret' }, grouped)),
    h('p', {}, h('a', { href: uri, class: 'otpauth-link' }, t('twoFactor.openLink'))),
    h('label', { class: 'field-label' }, t('twoFactor.confirmCode'), code),
    error,
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button', onclick: load }, t('common.cancel')),
      h('button', { type: 'submit', class: 'button button-primary' }, t('twoFactor.confirm')))));
    code.focus();
  }

  function confirmForm(kind) {
    say('');
    replace(body, passwordAndCodeForm({
      okText: kind === 'disable' ? t('twoFactor.turnOff') : t('twoFactor.newCodes'),
      danger: kind === 'disable',
      onCancel: load,
      onSubmit: async (password, code) => {
        if (kind === 'disable') {
          showStatus(await api.twoFactor.disable(password, code));
          say(t('twoFactor.disabled'));
        } else {
          const done = await api.twoFactor.newRecoveryCodes(password, code);
          say(t('twoFactor.newCodesDone'));
          replace(body, recoveryCodesBlock(done.recovery_codes, () => { say(''); showStatus(done); }));
        }
      },
    }));
  }

  load();
  return h('details', { class: 'section two-factor-section' }, h('summary', {}, t('twoFactor.title')), body, message);
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
    twoFactorSection({ api }),
    h('div', { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'button button-danger button-left', onclick: () => finish('logout') }, t('account.signOut')),
      me.is_admin && h('button', { type: 'button', class: 'button', onclick: () => finish('admin') }, t('admin.title')),
      h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close')))), { wide: true });
}

/**
 * Een back-up downloaden: eerst opnieuw het wachtwoord (en een code als de beheerder tweestapsverificatie heeft), dan een eenmalig
 * downloadbewijs, en dan downloadt de browser het archief zelf (gestreamd naar schijf, niet via het geheugen van de pagina).
 * In de Android-app kan dat niet (de WebView kent geen downloads): daar staat alleen de uitleg.
 */
function backupSection({ api, inApp }) {
  const intro = [h('p', {}, t('admin.backupText')), h('p', { class: 'warning', role: 'note' }, t('admin.backupWarning'))];
  const restore = h('p', { class: 'hint' }, t('admin.backupRestoreHint'));
  if (inApp) return h('details', { class: 'section backup-section' }, h('summary', {}, t('admin.backup')), intro, h('p', { class: 'hint' }, t('admin.backupInBrowser')), restore);
  const pass = h('input', { class: 'field', type: 'password', required: true, autocomplete: 'current-password', 'aria-label': t('admin.backupPassword') });
  const code = h('input', { class: 'field', type: 'text', autocomplete: 'one-time-code', autocapitalize: 'none', spellcheck: false, maxLength: 24, 'aria-label': t('admin.backupCode') });
  const codeLabel = h('label', { class: 'field-label' }, t('admin.backupCode'), code);
  const message = h('p', { class: 'hint', role: 'status' });
  const button = h('button', { type: 'submit', class: 'button button-primary' }, t('admin.backupDownload'));
  const form = h('form', {
    class: 'section-form',
    onsubmit: async (e) => {
      e.preventDefault();
      message.classList.remove('error');
      message.textContent = '';
      button.disabled = true;
      try {
        const { ticket } = await api.admin.backupTicket(pass.value, code.value.trim());
        pass.value = code.value = '';
        // een gewone link: de browser slaat het bestand zelf op (Content-Disposition: attachment)
        const link = h('a', { href: api.admin.backupUrl(ticket), download: '', hidden: true });
        document.body.append(link);
        link.click();
        link.remove();
        message.textContent = t('admin.backupStarted');
      } catch (err) {
        message.textContent = errorText(err);
        message.classList.add('error');
      } finally {
        button.disabled = false;
      }
    },
  },
  h('label', { class: 'field-label' }, t('admin.backupPassword'), pass),
  codeLabel,
  message,
  h('div', { class: 'dialog-buttons' }, button));
  // het codeveld alleen als de beheerder zelf tweestapsverificatie heeft
  codeLabel.remove();
  api.twoFactor.status().then((s) => { if (s.enabled) { pass.parentElement.after(codeLabel); code.required = true; } }).catch(() => {});
  return h('details', { class: 'section backup-section' }, h('summary', {}, t('admin.backup')), intro, form, restore);
}

/** Gebruikersbeheer voor beheerders: accounts aanmaken, blokkeren, wachtwoorden herstellen, tweestapsverificatie uitzetten, back-up. */
export function adminDialog({ me, api, inApp = false }) {
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
        u.two_factor && u.id !== me.id && { value: 'twoFactor', label: t('admin.resetTwoFactor'), danger: true },
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
      } else if (choice === 'twoFactor') {
        const ok = await confirmDialog({ title: t('admin.resetTwoFactorTitle', { name: u.name }), text: t('admin.resetTwoFactorText', { name: u.name }), okText: t('admin.resetTwoFactorOk') });
        if (ok) run(() => api.admin.resetTwoFactor(u.id), t('admin.twoFactorReset', { name: u.name }));
      }
    }

    async function load() {
      try {
        const { users } = await api.admin.users();
        replace(list, users.map((u) => h('li', { class: 'device' },
          h('div', { class: 'device-info' },
            h('strong', {}, u.name, u.is_admin && h('span', { class: 'badge' }, t('account.admin')), u.two_factor && h('span', { class: 'badge' }, t('admin.twoFactorBadge')), u.is_disabled && h('span', { class: 'badge badge-bad' }, t('account.blocked'))),
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
      backupSection({ api, inApp }),
      message,
      h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.close'))));
  }, { wide: true });
}
