// Foutmeldingen in de taal van de extensie. De server schrijft zijn eigen teksten in het Nederlands en met technische woorden;
// de extensie toont daarom altijd een eigen tekst bij de foutcode (in het Nederlands of Engels, via _locales), en de tekst van de
// server nooit. `msg(sleutel, invulwaarden)` is chrome.i18n.getMessage (of in tests een nagebootste versie).

/** Foutcodes van de server en van de extensie zelf, met de sleutel van de melding. */
const MESSAGES = {
  // verbinden
  EMPTY: 'errAddressEmpty',
  SCHEME: 'errAddressScheme',
  CREDENTIALS: 'errAddressCredentials',
  INVALID: 'errAddressInvalid',
  INSECURE: 'errInsecure',
  PERMISSION_DENIED: 'errPermission',
  NOT_TICKORY: 'errNotTickory',
  OFFLINE: 'errOffline',
  TIMEOUT: 'errTimeout',
  // inloggen
  INVALID_CREDENTIALS: 'errCredentials',
  PASSWORD_LOGIN_OFF: 'errPasswordOff',
  INVALID_CODE: 'errCode',
  CHALLENGE_EXPIRED: 'errChallenge',
  CODE_INVALID: 'errPairCode',
  PAIR_CODE_FORMAT: 'errPairCodeFormat',
  BUSY: 'errBusy',
  UNAUTHORIZED: 'errUnauthorized',
  // een taak toevoegen
  FORBIDDEN: 'errForbidden',
  NOT_FOUND: 'errNotFound',
  LIMIT_REACHED: 'errLimit',
  INVALID_ARG: 'errInvalidTask',
  MISSING_ARG: 'errInvalidTask',
  UNKNOWN_ARG: 'errInvalidTask',
  READONLY: 'errInvalidTask',
  ID_EXISTS: 'errInvalidTask',
  DUPLICATE: 'errInvalidTask',
  INVALID_REQUEST: 'errInvalidTask',
  TOO_LARGE: 'errTooLarge',
  EMPTY_TITLE: 'errEmptyTitle',
  INTERNAL: 'errServer',
};

/**
 * De melding bij een fout.
 * @param {{ code?: string, status?: number, retryAfter?: number | null } | unknown} err
 * @param {(key: string, subs?: string[]) => string} msg
 * @param {{ https?: boolean }} [context] bij OFFLINE: het adres dat geprobeerd werd (een tip over http of https)
 */
export function errorText(err, msg, context = {}) {
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'TOO_MANY_ATTEMPTS' || code === 'TOO_MANY_REQUESTS') {
    const minutes = Math.max(1, Math.ceil((Number(err.retryAfter) || 60) / 60));
    return minutes === 1 ? msg('errTooManyOne') : msg('errTooMany', [String(minutes)]);
  }
  if (code === 'OFFLINE' && typeof context.https === 'boolean') return `${msg('errOffline')} ${msg(context.https ? 'errOfflineTryHttp' : 'errOfflineTryHttps')}`;
  const key = MESSAGES[code] ?? (/^HTTP_5\d\d$/.test(code) || err?.status >= 500 ? 'errServer' : null);
  if (key) return msg(key);
  return msg('errUnknown', [code || '?']);
}

/** Moet de gebruiker opnieuw verbinden (de sessie is ingetrokken of verlopen)? */
export const needsReconnect = (err) => err?.code === 'UNAUTHORIZED';

/** Alle meldingssleutels die errorText kan gebruiken (voor de test die controleert dat ze in elke taal bestaan). */
export const ERROR_KEYS = [...new Set([...Object.values(MESSAGES), 'errTooMany', 'errTooManyOne', 'errOfflineTryHttp', 'errOfflineTryHttps', 'errServer', 'errUnknown'])];
