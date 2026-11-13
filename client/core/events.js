// Luistert naar het signaal van de server dat er iets veranderd is (Server-Sent Events via fetch, zodat het token
// in een header kan en niet in de URL hoeft). Het signaal draagt geen gegevens: de client haalt daarna zelf een delta op.

/**
 * @param {{
 *   getToken: () => string | null,
 *   clientId: string,
 *   onSyncNeeded: () => void,       // een ander apparaat of tabblad heeft iets gewijzigd
 *   onConnected?: () => void,       // (opnieuw) verbonden: tijd om bij te werken
 *   baseUrl?: string,
 *   stallMs?: number,        // geen bericht (ook geen ping) binnen zoveel tijd: de verbinding is stuk, opnieuw verbinden
 *   retryBaseMs?: number,    // wachttijd vóór de eerste nieuwe poging; verdubbelt tot maximaal 30 seconden
 *   fetch?: typeof fetch,
 * }} options
 * @returns {{ stop: () => void, restart: () => void }}
 */
export function listenForChanges({ getToken, clientId, onSyncNeeded, onConnected = () => {}, baseUrl = '', stallMs = 70_000, retryBaseMs = 1000, fetch: fetchFn = globalThis.fetch }) {
  let controller = null;
  let stopped = false;
  let timer = null;
  let attempts = 0;

  const schedule = () => {
    if (stopped) return;
    attempts += 1;
    timer = setTimeout(connect, Math.min(30_000, retryBaseMs * 2 ** Math.min(attempts, 5)));
  };

  const handle = (block) => {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (event === 'hello') {
      attempts = 0;
      onConnected();
    } else if (event === 'sync_needed') {
      let origin = null;
      try {
        origin = JSON.parse(data).client_id;
      } catch { /* zonder herkomst: gewoon bijwerken */ }
      if (origin !== clientId) onSyncNeeded();
    }
  };

  async function connect() {
    timer = null;
    const token = getToken();
    if (stopped || !token) return;
    const mine = new AbortController();
    controller = mine;
    let stalled = false;
    let lastSeen = Date.now();
    // De server stuurt elke 25 seconden een ping. Blijft het stil, dan is de verbinding doodgevallen zonder dat de browser
    // dat merkt (slaapstand, wisselend netwerk): afbreken en opnieuw verbinden.
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen > stallMs) {
        stalled = true;
        mine.abort();
      }
    }, Math.max(5, Math.min(10_000, stallMs / 2)));
    try {
      const res = await fetchFn(`${baseUrl}/api/v1/events`, { headers: { Authorization: `Bearer ${token}` }, signal: mine.signal, cache: 'no-store' });
      if (res.status === 401) return; // wacht op een nieuw token (restart)
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        lastSeen = Date.now();
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf('\n\n');
        while (end >= 0) {
          handle(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf('\n\n');
        }
      }
      schedule(); // verbinding netjes gesloten: opnieuw verbinden
    } catch {
      if (stalled || !mine.signal.aborted) schedule(); // bewust stoppen of herstarten (abort) plant zelf niets in
    } finally {
      clearInterval(watchdog);
    }
  }

  const halt = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };

  connect();
  return {
    stop() {
      stopped = true;
      halt();
    },
    restart() {
      halt();
      stopped = false;
      attempts = 0;
      connect();
    },
  };
}
