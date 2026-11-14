// De verzoeken van de extensie aan de eigen Tickory-server. Alleen naar `origin` (het adres dat de gebruiker koos, met toestemming
// van de browser voor precies die host), met het sessietoken in de kop Authorization, nooit in een adres, zonder cookies.
// Zonder CORS: een extensie met toestemming voor de host mag die rechtstreeks aanroepen; de server stuurt geen CORS-koppen mee.
// Zonder browser-API's (alleen fetch), zodat het in node te testen is.

/** Een fout van de server of de verbinding; `code` is de foutcode van de server, of een eigen code (zie errors.js). */
export class TickoryError extends Error {
  constructor(code, { status = 0, retryAfter = null, serverText = '' } = {}) {
    super(serverText || code);
    this.name = 'TickoryError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Wat de lijst met projecten nodig heeft; de rest van de gegevens (taken, opmerkingen …) haalt de extensie nooit op. */
export const LIST_RESOURCES = ['projects', 'sections', 'labels', 'members', 'settings'];
const TIMEOUT_MS = 20_000;

/**
 * @param {{ origin: string, token?: string | null, fetch?: typeof fetch, timeoutMs?: number }} options
 */
export function createClient({ origin, token = null, fetch: fetchFn = globalThis.fetch.bind(globalThis), timeoutMs = TIMEOUT_MS }) {
  async function call(method, path, body, { auth = true, expectJson = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchFn(`${origin}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        credentials: 'omit', // geen cookies: alleen het token van deze extensie telt
        cache: 'no-store',
        redirect: 'error', // een omleiding naar een ander adres volgen we niet stilzwijgend
        signal: controller.signal,
      });
    } catch {
      throw new TickoryError(controller.signal.aborted ? 'TIMEOUT' : 'OFFLINE');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try {
      data = await res.json();
    } catch { /* geen JSON: een foutpagina van een proxy, of geen Tickory */ }
    if (res.ok) {
      if (expectJson && (data === null || typeof data !== 'object' || Array.isArray(data))) throw new TickoryError('NOT_TICKORY', { status: res.status });
      return data;
    }
    const retryAfter = Number(res.headers?.get?.('retry-after')) || null;
    const code = typeof data?.error_code === 'string' ? data.error_code : res.status === 404 ? 'NOT_TICKORY' : `HTTP_${res.status}`;
    throw new TickoryError(code, { status: res.status, retryAfter, serverText: typeof data?.error === 'string' ? data.error : '' });
  }

  return {
    /** Hoe je op deze server inlogt: `{ password, sso }`. Controleert meteen dat het een Tickory-server is. */
    async methods() {
      const m = await call('GET', '/api/v1/auth/methods', undefined, { auth: false });
      if (typeof m.password !== 'boolean') throw new TickoryError('NOT_TICKORY');
      return m;
    },
    /** `{ token, session_id, me }`, of bij tweestapsverificatie `{ two_factor_required: true, challenge }`. */
    login: (username, password, deviceName) => call('POST', '/api/v1/auth/login', { username, password, device_name: deviceName }, { auth: false }),
    /** De tweede stap: de code uit de app of een herstelcode. */
    loginCode: (challenge, code) => call('POST', '/api/v1/auth/login/2fa', { challenge, code }, { auth: false }),
    /** Een koppelcode uit de web-app (Account, Aangemelde apparaten) inwisselen voor een eigen sessie. */
    pair: (code, deviceName) => call('POST', '/api/v1/auth/pair', { code, device_name: deviceName }, { auth: false }),
    /** Trekt de sessie van de extensie in. */
    logout: () => call('POST', '/api/v1/auth/logout', {}),
    /** Projecten, secties, labels, lidmaatschappen en instellingen: alleen wat de keuzelijst en de snelle invoer nodig hebben. */
    lists: () => call('POST', '/api/v1/sync', { sync_token: '*', resource_types: LIST_RESOURCES }),
    /** Stuurt commando's (met vaste uuid's: opnieuw proberen is veilig) en krijgt de projecten terug. */
    send: (commands) => call('POST', '/api/v1/sync', { sync_token: '*', resource_types: ['projects'], commands }),
  };
}
