// De verbinding met de server op één plek: aanmelding (het sessietoken), de account-aanroepen, de sync en het live-signaal.
// De app praat alleen via dit object met de buitenwereld. De demo op de website vervangt dit ene bestand door een versie
// die alles in de browser zelf afhandelt; de rest van de app blijft daarbij ongewijzigd.

import { createApi } from './auth.js';
import { listenForChanges } from './events.js';
import { httpTransport } from './syncClient.js';
import { createAttachmentsApi } from './attachmentsApi.js';

const TOKEN_KEY = 'tickory.token';

/**
 * @param {{ clientId: string, storage?: Storage }} options
 * @returns {{
 *   demo: boolean,
 *   getToken: () => string | null,
 *   setToken: (token: string) => void,
 *   clearToken: () => void,
 *   api: ReturnType<typeof createApi>,
 *   transport: (body: object, options?: { signal?: AbortSignal }) => Promise<object>,
 *   attachments: ReturnType<typeof createAttachmentsApi>,
 *   listen: (handlers: { onSyncNeeded: () => void, onConnected?: () => void }) => { stop: () => void, restart: () => void },
 * }}
 */
export function createBackend({ clientId, storage = globalThis.localStorage }) {
  const getToken = () => storage.getItem(TOKEN_KEY);
  return {
    /** true in de demo: er is dan geen server en geen aanmelding. */
    demo: false,
    getToken,
    setToken: (token) => storage.setItem(TOKEN_KEY, token),
    clearToken: () => storage.removeItem(TOKEN_KEY),
    api: createApi({ getToken }),
    transport: httpTransport({ getToken, clientId }),
    attachments: createAttachmentsApi({ getToken }),
    listen: (handlers) => listenForChanges({ getToken, clientId, ...handlers }),
  };
}
