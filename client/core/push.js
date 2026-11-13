// Meldingen in de browser aan- en uitzetten (Web Push). De browser vraagt toestemming, meldt zich aan bij zijn eigen
// pushdienst, en wij geven die aanmelding door aan de server; die stuurt daarna de herinneringen (zie server/push.ts).
// Werkt alleen via HTTPS (of localhost) en als de service worker draait. In de Android-app is dit niet nodig: die plant
// zijn meldingen zelf in.

/** Waarom meldingen niet (konden worden) aangezet. De interface maakt er een zin van in de gekozen taal. */
export class PushError extends Error {
  /** @param {'unsupported' | 'denied' | 'offline' | 'server'} code */
  constructor(code, message = code) {
    super(message);
    this.name = 'PushError';
    this.code = code;
  }
}

function keyBytes(base64url) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sameKey(buffer, base64url) {
  if (!buffer) return true; // de browser zegt het niet: aannemen dat het klopt (de server weigert anders vanzelf)
  const a = new Uint8Array(buffer);
  const b = keyBytes(base64url);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * @param {{
 *   getToken: () => string | null,
 *   lang?: () => string,                     // de taal van dit apparaat ('nl' of 'en'), voor de tekst in de melding
 *   baseUrl?: string,
 *   fetch?: typeof fetch,
 *   env?: { navigator?: any, PushManager?: any, Notification?: any },   // voor tests
 * }} options
 */
export function createPushClient({ getToken, lang = () => 'nl', baseUrl = '', fetch: fetchFn = (...a) => globalThis.fetch(...a), env = globalThis }) {
  const sw = env.navigator?.serviceWorker;
  const supported = Boolean(sw && env.PushManager && env.Notification);

  async function request(method, path, body) {
    let res;
    try {
      res = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${getToken() ?? ''}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
      });
    } catch {
      throw new PushError('offline');
    }
    let data = null;
    try {
      data = await res.json();
    } catch { /* geen JSON */ }
    if (!res.ok) throw new PushError('server', typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`);
    return data ?? {};
  }

  /** Meldt (opnieuw) aan bij de pushdienst van de browser en geeft de aanmelding door aan de server. */
  async function register() {
    const { public_key: key } = await request('GET', '/api/v1/push/key');
    const reg = await sw.ready;
    let sub = await reg.pushManager.getSubscription();
    // Aangemeld met een andere serversleutel (de server is opnieuw ingericht): die aanmelding werkt niet meer.
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    const json = sub.toJSON();
    await request('POST', '/api/v1/push/subscribe', { endpoint: json.endpoint, keys: json.keys, lang: lang() });
    return true;
  }

  return {
    /** Kan deze browser meldingen ontvangen (en draait de app via HTTPS met een service worker)? */
    supported,
    /** 'granted', 'denied', 'default' (nog niet gevraagd) of 'unsupported'. */
    permission: () => (supported ? env.Notification.permission : 'unsupported'),
    /** Staan meldingen op dit apparaat aan? */
    async enabled() {
      if (!supported || env.Notification.permission !== 'granted') return false;
      return Boolean(await (await sw.ready).pushManager.getSubscription());
    },
    /** Zet meldingen aan: vraagt zo nodig toestemming. Gooit een PushError als het niet kan of niet mag. */
    async enable() {
      if (!supported) throw new PushError('unsupported');
      if ((await env.Notification.requestPermission()) !== 'granted') throw new PushError('denied');
      return register();
    },
    /** Zet meldingen op dit apparaat uit (bij de server en in de browser). */
    async disable() {
      if (!supported) return;
      const sub = await (await sw.ready).pushManager.getSubscription();
      if (!sub) return;
      await request('POST', '/api/v1/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => { /* de server ruimt het ook zelf op */ });
      await sub.unsubscribe();
    },
    /**
     * Bij het starten van de app: staat het aan, dan de aanmelding bij de server verversen (een aanmelding kan verlopen,
     * de taal kan veranderd zijn, of je bent opnieuw ingelogd). Vraagt nooit om toestemming. Geeft terug of het aan staat.
     */
    async refresh() {
      if (!supported || env.Notification.permission !== 'granted') return false;
      if (!(await (await sw.ready).pushManager.getSubscription())) return false;
      return register();
    },
    /** Stuurt een proefmelding naar al je apparaten. @returns {Promise<{ sent: number, failed: number, errors: string[] }>} */
    test: () => request('POST', '/api/v1/push/test', {}),
    /** De apparaten waarop meldingen aan staan. */
    devices: async () => (await request('GET', '/api/v1/push/subscriptions')).subscriptions ?? [],
  };
}
