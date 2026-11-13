// Aanroepen voor inloggen, het eigen account, apparaten en beheer. Los van de sync: dit zijn gewone verzoeken
// waarvan de gebruiker het antwoord (of de fout) meteen wil zien.

/** Een fout van de server met een melding in het Nederlands, geschikt om rechtstreeks te tonen. */
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
 * @param {{ baseUrl?: string, fetch?: typeof fetch, getToken?: () => string | null }} [options]
 */
export function createApi({ baseUrl = '', fetch: fetchFn = globalThis.fetch, getToken = () => null } = {}) {
  async function call(method, path, body, { token = getToken() } = {}) {
    let res;
    try {
      res = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
      });
    } catch {
      throw new ApiError('Geen verbinding met de server. Controleer je internetverbinding en het adres van de server.', { code: 'OFFLINE' });
    }
    let data = null;
    try {
      data = await res.json();
    } catch { /* geen JSON, bijvoorbeeld een foutpagina van een proxy */ }
    if (res.ok) return data ?? {};
    const retryAfter = Number(res.headers?.get?.('retry-after')) || null;
    const message = typeof data?.error === 'string' && data.error ? capitalize(data.error) : `De server gaf een fout (${res.status}).`;
    throw new ApiError(message, { status: res.status, code: data?.error_code ?? 'UNKNOWN', retryAfter });
  }

  return {
    login: (username, password, deviceName) => call('POST', '/api/v1/auth/login', { username, password, device_name: deviceName }, { token: null }),
    logout: (token) => call('POST', '/api/v1/auth/logout', {}, token ? { token } : undefined),
    me: () => call('GET', '/api/v1/auth/me'),
    changePassword: (current_password, new_password) => call('POST', '/api/v1/auth/password', { current_password, new_password }),
    sessions: () => call('GET', '/api/v1/auth/sessions'),
    revokeSession: (id) => call('POST', '/api/v1/auth/sessions/revoke', { id }),
    admin: {
      users: () => call('GET', '/api/v1/admin/users'),
      createUser: (input) => call('POST', '/api/v1/admin/users', input),
      updateUser: (id, changes) => call('POST', '/api/v1/admin/users/update', { id, ...changes }),
      resetPassword: (id, new_password) => call('POST', '/api/v1/admin/users/password', { id, new_password }),
    },
  };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Een leesbare naam voor dit apparaat, voor in de lijst met aangemelde apparaten. */
export function deviceName(userAgent = globalThis.navigator?.userAgent ?? '', { app = false } = {}) {
  const os = /Android/i.test(userAgent) ? 'Android'
    : /iPhone|iPad|iPod/i.test(userAgent) ? 'iOS'
      : /Windows/i.test(userAgent) ? 'Windows'
        : /Mac OS X|Macintosh/i.test(userAgent) ? 'Mac'
          : /Linux|X11/i.test(userAgent) ? 'Linux'
            : 'Onbekend';
  if (app) return `${os}-app`;
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\/|Opera/.test(userAgent) ? 'Opera'
      : /Firefox\//.test(userAgent) ? 'Firefox'
        : /Chrome\//.test(userAgent) ? 'Chrome'
          : /Safari\//.test(userAgent) ? 'Safari'
            : 'Browser';
  return `${browser} op ${os}`;
}
