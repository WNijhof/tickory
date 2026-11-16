// De verbinding met de server op één plek: aanmelding (het sessietoken), de account-aanroepen, de sync en het live-signaal.
// De app praat alleen via dit object met de buitenwereld. De demo op de website vervangt dit ene bestand door een versie
// die alles in de browser zelf afhandelt; de rest van de app blijft daarbij ongewijzigd.

import { createApi } from './auth.js';
import { listenForChanges } from './events.js';
import { httpTransport } from './syncClient.js';
import { createAttachmentsApi } from './attachmentsApi.js';

const TOKEN_KEY = 'tickory.token';
// Inloggen zonder "onthoud mij": het token staat in een sessiecookie (alle tabbladen delen hem, de browser gooit hem weg bij het
// sluiten). FORGET_KEY onthoudt dat zo'n aanmelding er was: is het token bij het starten weg, dan horen de gegevens op dit apparaat
// ook weg (`forgotten`). De server gebruikt de cookie niet: aanmelden gaat altijd met de Authorization-header.
const COOKIE = 'tickory_session';
const FORGET_KEY = 'tickory.forget';
const hasDocument = () => typeof document !== 'undefined' && typeof document.cookie === 'string';
function readCookie() {
  if (!hasDocument()) return null;
  const m = /(?:^|;\s*)tickory_session=([^;]*)/.exec(document.cookie);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}
function writeCookie(value, maxAge = null) {
  if (!hasDocument()) return;
  const secure = globalThis.location?.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${encodeURIComponent(value)}; path=/; SameSite=Strict${maxAge === null ? '' : `; Max-Age=${maxAge}`}${secure}`;
}

/**
 * @param {{ clientId: string, storage?: Storage }} options
 * @returns {{
 *   demo: boolean,
 *   getToken: () => string | null,
 *   setToken: (token: string, options?: { remember?: boolean }) => void,
 *   clearToken: () => void,
 *   forgotten: () => boolean,
 *   clearForgotten: () => void,
 *   api: ReturnType<typeof createApi>,
 *   transport: (body: object, options?: { signal?: AbortSignal }) => Promise<object>,
 *   attachments: ReturnType<typeof createAttachmentsApi>,
 *   listen: (handlers: { onSyncNeeded: () => void, onConnected?: () => void }) => { stop: () => void, restart: () => void },
 * }}
 */
export function createBackend({ clientId, storage = globalThis.localStorage }) {
  const getToken = () => storage.getItem(TOKEN_KEY) ?? readCookie();
  return {
    /** true in de demo: er is dan geen server en geen aanmelding. */
    demo: false,
    getToken,
    /** `remember: false`: alleen tot de browser sluit (een sessiecookie), en daarna gaan de gegevens op dit apparaat weg. */
    setToken: (token, { remember = true } = {}) => {
      if (remember) {
        storage.setItem(TOKEN_KEY, token);
        storage.removeItem(FORGET_KEY);
        writeCookie('', 0);
      } else {
        storage.removeItem(TOKEN_KEY);
        storage.setItem(FORGET_KEY, '1');
        writeCookie(token);
      }
    },
    clearToken: () => {
      storage.removeItem(TOKEN_KEY);
      writeCookie('', 0);
    },
    /** Was er een aanmelding zonder "onthoud mij" die met het sluiten van de browser is verdwenen? Dan de lokale gegevens wissen. */
    forgotten: () => storage.getItem(FORGET_KEY) === '1' && !getToken(),
    clearForgotten: () => storage.removeItem(FORGET_KEY),
    api: createApi({ getToken }),
    transport: httpTransport({ getToken, clientId }),
    attachments: createAttachmentsApi({ getToken }),
    listen: (handlers) => listenForChanges({ getToken, clientId, ...handlers }),
  };
}
