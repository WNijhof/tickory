// Inloggen via SSO (OpenID Connect) aan de kant van de app. De server doet het protocol (server/oidc.ts en server/sso.ts); de app
// begint een poging, gaat naar de inlogdienst en komt terug op `/#oidc=<code>` (of `/#oidc-error=<CODE>`). Die eenmalige code
// wisselt de app in, samen met het geheim (`binding`) dat hij bij het begin van de server kreeg en hier even bewaart. Een link
// met een code die niet bij een eigen poging hoort, werkt dus niet: niemand kan je zo in zijn account laten inloggen.
// In de Android-app opent de inlogdienst in de browser van het toestel; die keert terug via `tickory://oidc`, en de app laadt de
// web-app dan opnieuw met hetzelfde fragment. `#signin=<code>` is de noodcode die een beheerder op de server maakt.

import { t } from './i18n.js';

const PENDING_KEY = 'tickory.sso';
/** Hoe lang een begonnen poging bewaard blijft (de server geeft er tien minuten voor). */
export const PENDING_MS = 15 * 60_000;

const CODE_RE = /^[A-Za-z0-9_-]{20,200}$/;
const ERROR_RE = /^[A-Z_]{1,40}$/;

/** De foutcodes die de server bij een terugkeer kan geven (server/sso.ts), elk met een eigen tekst in de taal van de interface. */
const ERROR_TEXT = {
  EXPIRED: () => t('sso.error.expired'),
  CANCELLED: () => t('sso.error.cancelled'),
  PROVIDER: () => t('sso.error.provider'),
  UNAVAILABLE: () => t('sso.error.unavailable'),
  NO_ACCOUNT: () => t('sso.error.noAccount'),
  NOT_ALLOWED: () => t('sso.error.notAllowed'),
  DISABLED: () => t('sso.error.disabled'),
  ALREADY_LINKED: () => t('sso.error.alreadyLinked'),
  CREATE_FAILED: () => t('sso.error.createFailed'),
  TOO_MANY_ATTEMPTS: () => t('sso.error.tooManyAttempts'),
};
export const SSO_ERRORS = Object.keys(ERROR_TEXT);

/**
 * Wat er achter de # staat na een terugkeer: `{ kind: 'code', code }`, `{ kind: 'error', error }`, `{ kind: 'signin', code }`
 * (noodcode), of null als het fragment hier niets mee te maken heeft of niet klopt.
 */
export function parseSsoHash(hash) {
  const m = /^#(oidc|oidc-error|signin)=(.*)$/.exec(String(hash ?? ''));
  if (!m) return null;
  if (m[1] === 'oidc-error') return ERROR_RE.test(m[2]) ? { kind: 'error', error: m[2] } : { kind: 'error', error: 'PROVIDER' };
  if (!CODE_RE.test(m[2])) return null;
  return { kind: m[1] === 'oidc' ? 'code' : 'signin', code: m[2] };
}

/** De tekst bij een foutcode van een terugkeer; een onbekende code krijgt de algemene tekst. */
export function ssoErrorText(code) {
  return (Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code] : ERROR_TEXT.PROVIDER)();
}

/** Bewaart het geheim van een begonnen poging (`purpose`: 'login' of 'link'). Lukt bewaren niet, dan geeft dat false. */
export function savePending(storage, { binding, purpose }, now = Date.now()) {
  try {
    storage.setItem(PENDING_KEY, JSON.stringify({ binding, purpose, at: now }));
    return true;
  } catch {
    return false;
  }
}

/** Haalt de begonnen poging op en wist hem (eenmalig). Null als er geen is, hij te oud is of de opslag onleesbaar. */
export function takePending(storage, now = Date.now()) {
  let raw = null;
  try {
    raw = storage.getItem(PENDING_KEY);
    storage.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  try {
    const p = JSON.parse(raw ?? 'null');
    if (!p || typeof p.binding !== 'string' || !['login', 'link'].includes(p.purpose) || typeof p.at !== 'number') return null;
    if (now - p.at > PENDING_MS || p.at > now + 60_000) return null;
    return { binding: p.binding, purpose: p.purpose };
  } catch {
    return null;
  }
}

/**
 * Begint een poging bij de server en gaat naar de inlogdienst: in de browser met een gewone navigatie, in de Android-app via de
 * brug (de app opent de pagina in de browser van het toestel). Geeft 'away' als de navigatie is begonnen, 'update-app' als de
 * Android-app te oud is om het te kunnen. Gooit een ApiError als de server weigert (bijvoorbeeld een fout wachtwoord bij koppelen).
 */
export async function startSso({ api, purpose, bridge, storage, location, deviceName = '', lang = 'nl', password, code }) {
  const inApp = Boolean(bridge?.available);
  if (inApp && !bridge.canOpenSignIn()) return 'update-app';
  const res = await api.sso.start({ purpose, client: inApp ? 'app' : 'web', device_name: deviceName, lang, ...(password !== undefined ? { password } : {}), ...(code ? { code } : {}) });
  savePending(storage, { binding: res.binding, purpose });
  const url = new URL(res.url, location.href).href;
  if (inApp) bridge.openSignIn(url);
  else location.assign(url);
  return 'away';
}
