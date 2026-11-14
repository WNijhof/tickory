// De sync-lus van de client: stuurt de wachtrij naar de server en verwerkt de delta.
// Er loopt hooguit één sync tegelijk. Mislukt het netwerk, dan blijft de wachtrij staan en wordt het later
// opnieuw geprobeerd met dezelfde uuid's, zodat niets dubbel wordt uitgevoerd.

export class AuthError extends Error {
  constructor(message = 'niet geautoriseerd') {
    super(message);
    this.name = 'AuthError';
  }
}

export class TimeoutError extends Error {
  constructor(ms) {
    super(`geen antwoord binnen ${Math.round(ms / 1000)} seconden`);
    this.name = 'TimeoutError';
  }
}

export class HttpError extends Error {
  constructor(status, message = `HTTP ${status}`) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Het commando zoals het naar de server gaat: type, uuid en argumenten. Een commando in de wachtrij kan er een veld `local`
 * bij hebben (alleen voor dit apparaat, bijvoorbeeld de rijen om een verwijdering terug te zetten, zie core/reducer.js); dat gaat nooit mee.
 */
export const wireCommand = ({ cmd }) => (cmd.args === undefined ? { type: cmd.type, uuid: cmd.uuid } : { type: cmd.type, uuid: cmd.uuid, args: cmd.args });

/** @typedef {'idle' | 'syncing' | 'offline' | 'unauthorized' | 'error'} SyncState */

export class SyncClient {
  /**
   * @param {{
   *   store: import('./store.js').Store,
   *   transport: (body: object) => Promise<object>,   // gooit AuthError (401), HttpError (andere status) of iets anders (netwerk)
   *   onCommandErrors?: (errors: { cmd: object, error_code: string, error: string }[]) => void,
   *   onState?: (state: SyncState) => void,
   *   batchSize?: number,
   *   timeoutMs?: number,   // een verzoek zonder antwoord wordt na zoveel tijd afgebroken (standaard 30 seconden)
   *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
   * }} options
   */
  constructor({ store, transport, onCommandErrors = () => {}, onState = () => {}, batchSize = 100, timeoutMs = 30_000, timers = globalThis }) {
    this.timeoutMs = timeoutMs;
    this.store = store;
    this.transport = transport;
    this.onCommandErrors = onCommandErrors;
    this.onState = onState;
    this.batchSize = batchSize;
    this.timers = timers;
    /** @type {SyncState} */
    this.state = 'idle';
    this.lastError = null;
    this.running = null;
    this.again = false;
    this.timer = null;
    this.failures = 0;
  }

  /**
   * Eén verzoek, met een tijdslimiet. Zonder die limiet blokkeert een verzoek dat nooit antwoord krijgt (een halfopen
   * verbinding, een tussenliggend filter) de sync-lus voorgoed, want er loopt er maar één tegelijk.
   * De limiet gebruikt bewust de echte klok, los van de timers die voor uitstellen en herhalen kunnen worden vervangen.
   */
  callTransport(body) {
    const controller = new AbortController();
    let timer;
    const call = Promise.resolve().then(() => this.transport(body, { signal: controller.signal }));
    call.catch(() => {}); // verliest het van de limiet, dan mag een latere fout niet als "onverwerkt" gemeld worden
    const limit = new Promise((_, reject) => {
      timer = globalThis.setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    });
    return Promise.race([call, limit]).finally(() => globalThis.clearTimeout(timer));
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
  }

  /** Synchroniseert nu. Loopt er al een sync, dan volgt er direct daarna nog een. Geeft true bij succes. */
  syncNow() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async run() {
    this.setState('syncing');
    try {
      do {
        this.again = false;
        let size = this.batchSize;
        for (;;) {
          const batch = this.store.peek(size);
          let res;
          try {
            res = await this.callTransport({ sync_token: this.store.token, commands: batch.map(wireCommand) });
          } catch (err) {
            if (!(err instanceof HttpError && err.status === 413)) throw err;
            if (batch.length > 1) {
              size = Math.max(1, Math.floor(batch.length / 2)); // te groot verzoek: kleinere porties proberen
              continue;
            }
            if (batch.length === 1) {
              await this.store.drop([batch[0]]);
              this.onCommandErrors([{ cmd: batch[0].cmd, error_code: 'TOO_LARGE', error: 'deze wijziging is te groot om te versturen' }]);
              continue;
            }
            throw err;
          }
          const errors = await this.store.applyResponse(res);
          if (errors.length > 0) this.onCommandErrors(errors);
          if (batch.length === 0 || this.store.queueLength === 0) break;
          // is geen enkel verzonden commando bevestigd, dan stoppen we om een eindeloze lus te voorkomen
          const status = res.sync_status ?? {};
          if (!batch.some((item) => Object.hasOwn(status, item.cmd.uuid))) throw new HttpError(500, 'de server bevestigde de verzonden wijzigingen niet');
        }
      } while (this.again);
      this.failures = 0;
      this.lastError = null;
      this.setState('idle');
      return true;
    } catch (err) {
      this.lastError = err;
      this.failures += 1;
      this.setState(err instanceof AuthError ? 'unauthorized' : err instanceof HttpError ? 'error' : 'offline');
      return false;
    }
  }

  /**
   * Vraagt een sync aan (kort uitgesteld, zodat snel opeenvolgende wijzigingen samen gaan).
   * Na een netwerkfout volgt vanzelf een nieuwe poging, met oplopende wachttijd tot maximaal een minuut.
   */
  requestSync(delayMs = 300) {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(async () => {
      this.timer = null;
      const ok = await this.syncNow();
      if (!ok && this.state === 'offline') this.requestSync(Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6)));
    }, delayMs);
  }

  stop() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Transport voor de browser: POST naar /api/v1/sync met het token.
 * @param {{ getToken: () => string | null, clientId: string, baseUrl?: string, fetch?: typeof fetch }} options
 */
export function httpTransport({ getToken, clientId, baseUrl = '', fetch: fetchFn = globalThis.fetch }) {
  return async (body, { signal } = {}) => {
    const token = getToken();
    if (!token) throw new AuthError('geen token ingesteld');
    const res = await fetchFn(`${baseUrl}/api/v1/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Client-Id': clientId },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 401) throw new AuthError();
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  };
}
