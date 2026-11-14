// Aanroepen voor inloggen, het eigen account, apparaten en beheer. Los van de sync: dit zijn gewone verzoeken
// waarvan de gebruiker het antwoord (of de fout) meteen wil zien.

import { nameKey } from '../../shared/text.js';
import { weakPasswordReason } from '../../shared/password.js';
import { DEFAULT_LANGUAGE, getLanguage, t } from './i18n.js';

/** De taal waarin de server zijn foutteksten schrijft. */
const SERVER_LANGUAGE = DEFAULT_LANGUAGE;

/** Een fout van de server met een melding in de taal van de interface, geschikt om rechtstreeks te tonen. */
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', retryAfter = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * De eigen vertaling van een foutcode, waar nodig per soort aanroep (`action` is de naam van de aanroep hieronder,
 * bijvoorbeeld 'changePassword'). Geeft null als er geen eigen tekst is; dan volgt de tekst van de server.
 */
function ownMessage(action, code) {
  const admin = action.startsWith('admin.');
  switch (code) {
    case 'INVALID_CREDENTIALS': return t('api.invalidCredentials');
    case 'TOO_MANY_ATTEMPTS': return t('api.tooManyAttempts');
    case 'BUSY': return t('api.busy');
    case 'UNAUTHORIZED': return t('error.unauthorized');
    case 'INTERNAL': return t('error.internal');
    case 'FORBIDDEN': return action === 'changePassword' ? t('api.wrongCurrentPassword') : admin ? t('api.adminOnly') : t('error.forbidden');
    case 'NOT_FOUND': return action === 'revokeSession' ? t('api.sessionGone') : admin ? t('api.userGone') : null;
    case 'DUPLICATE': return action === 'admin.createUser' ? t('api.usernameTaken') : null;
    case 'CONFLICT': return action === 'admin.updateUser' ? t('api.lastAdmin') : null;
    default: return null;
  }
}

/**
 * De melding bij een geweigerd verzoek. De server stuurt een Nederlandse tekst mee: in het Nederlands tonen we die,
 * in een andere taal eerst de eigen vertaling op basis van de code, en de tekst van de server alleen als er niets beters is.
 */
function errorMessage(action, { code, status, serverText }) {
  const fromServer = serverText ? capitalize(serverText) : null;
  const own = getLanguage() === SERVER_LANGUAGE ? null : ownMessage(action, code);
  return own ?? fromServer ?? t('api.serverError', { status });
}

/**
 * @param {{ baseUrl?: string, fetch?: typeof fetch, getToken?: () => string | null }} [options]
 */
export function createApi({ baseUrl = '', fetch: fetchFn = globalThis.fetch, getToken = () => null } = {}) {
  async function call(action, method, path, body, { token = getToken() } = {}) {
    let res;
    try {
      res = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(t('api.offline'), { code: 'OFFLINE' });
    }
    let data = null;
    try {
      data = await res.json();
    } catch { /* geen JSON, bijvoorbeeld een foutpagina van een proxy */ }
    if (res.ok) return data ?? {};
    const retryAfter = Number(res.headers?.get?.('retry-after')) || null;
    const code = data?.error_code ?? 'UNKNOWN';
    const serverText = typeof data?.error === 'string' && data.error ? data.error : null;
    throw new ApiError(errorMessage(action, { code, status: res.status, serverText }), { status: res.status, code, retryAfter });
  }

  return {
    login: (username, password, deviceName) => call('login', 'POST', '/api/v1/auth/login', { username, password, device_name: deviceName }, { token: null }),
    logout: (token) => call('logout', 'POST', '/api/v1/auth/logout', {}, token ? { token } : undefined),
    me: () => call('me', 'GET', '/api/v1/auth/me'),
    changePassword: (current_password, new_password) => call('changePassword', 'POST', '/api/v1/auth/password', { current_password, new_password }),
    sessions: () => call('sessions', 'GET', '/api/v1/auth/sessions'),
    revokeSession: (id) => call('revokeSession', 'POST', '/api/v1/auth/sessions/revoke', { id }),
    /** Een pagina van het activiteitenlogboek van een project (server/activity.ts): `{ entries, next }`, de nieuwste eerst. */
    activity: (projectId, { before = null, limit = null, kinds = null } = {}) => {
      const q = new URLSearchParams();
      if (before) q.set('before', before);
      if (limit) q.set('limit', String(limit));
      if (kinds?.length) q.set('kinds', kinds.join(','));
      const query = q.toString();
      return call('activity', 'GET', `/api/v1/projects/${encodeURIComponent(projectId)}/activity${query ? `?${query}` : ''}`);
    },
    admin: {
      users: () => call('admin.users', 'GET', '/api/v1/admin/users'),
      createUser: (input) => call('admin.createUser', 'POST', '/api/v1/admin/users', input),
      updateUser: (id, changes) => call('admin.updateUser', 'POST', '/api/v1/admin/users/update', { id, ...changes }),
      resetPassword: (id, new_password) => call('admin.resetPassword', 'POST', '/api/v1/admin/users/password', { id, new_password }),
    },
  };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- invoer controleren vóór het versturen ----------
// Dezelfde regels als de server (server/users.ts). De server controleert altijd zelf ook; hier gaat het erom dat de
// gebruiker de melding meteen ziet, in de taal van de interface. Elke functie geeft de melding terug, of '' als het goed is.

export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

/** Een gebruikersnaam: 2 tot 40 tekens uit letters, cijfers, punt, streepje en underscore, beginnend met een letter of cijfer. */
export function usernameProblem(username) {
  const s = String(username ?? '').normalize('NFC').trim();
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{1,39}$/u.test(s) ? '' : t('account.usernameInvalid');
}

/** De naam van een persoon: 1 tot 100 tekens, zonder stuurtekens. */
export function displayNameProblem(name) {
  const s = String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  return s.length < 1 || s.length > 100 || /[\u0000-\u001f\u007f]/u.test(s) ? t('account.nameInvalid') : '';
}

/** De redenen waarom een wachtwoord te makkelijk is (shared/password.js), elk met zijn eigen tekst in de taal van de interface. */
const WEAK_REASON = {
  few_characters: () => t('account.passwordWeak.fewCharacters'),
  common: () => t('account.passwordWeak.common'),
  digits_only: () => t('account.passwordWeak.digitsOnly'),
  like_username: () => t('account.passwordWeak.likeUsername'),
  repetition: () => t('account.passwordWeak.repetition'),
};

/** Een wachtwoord: minimaal 10 tekens, maximaal 200, niet gelijk aan de gebruikersnaam (als die bekend is) en niet te makkelijk te raden. */
export function passwordProblem(password, username = '') {
  const raw = String(password ?? '');
  if ([...raw].length < MIN_PASSWORD_LENGTH) return t('account.passwordTooShort', { min: MIN_PASSWORD_LENGTH });
  if (raw.length > MAX_PASSWORD_LENGTH) return t('account.passwordTooLong', { max: MAX_PASSWORD_LENGTH });
  if (username && nameKey(raw) === nameKey(username)) return t('account.passwordIsUsername');
  const weak = weakPasswordReason(raw, username);
  if (weak) return t('account.passwordTooWeak', { reason: WEAK_REASON[weak]() });
  return '';
}

/** Een leesbare naam voor dit apparaat, voor in de lijst met aangemelde apparaten. */
export function deviceName(userAgent = globalThis.navigator?.userAgent ?? '', { app = false } = {}) {
  const os = /Android/i.test(userAgent) ? 'Android'
    : /iPhone|iPad|iPod/i.test(userAgent) ? 'iOS'
      : /Windows/i.test(userAgent) ? 'Windows'
        : /Mac OS X|Macintosh/i.test(userAgent) ? 'Mac'
          : /Linux|X11/i.test(userAgent) ? 'Linux'
            : t('device.unknownOs');
  if (app) return t('device.app', { os });
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\/|Opera/.test(userAgent) ? 'Opera'
      : /Firefox\//.test(userAgent) ? 'Firefox'
        : /Chrome\//.test(userAgent) ? 'Chrome'
          : /Safari\//.test(userAgent) ? 'Safari'
            : 'Browser';
  return t('device.browserOn', { browser, os });
}
