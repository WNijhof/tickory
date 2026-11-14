// De verbinding voor bijlagen: uploaden, ophalen en de grenzen van de server. Eén plek, zoals backend.js voor de rest: de demo op
// de website vervangt dit door een versie die alles in het geheugen houdt.
//
// Een upload is een gewone POST met het bestand als body (geen multipart). Het token gaat in de Authorization-header, nooit in de
// URL; een bijlage ophalen gebeurt daarom ook met fetch en een blob-URL, niet met een gewone link.

import { AuthError } from './syncClient.js';

/**
 * Een mislukte upload of download. `retryable` zegt of opnieuw proberen zin heeft (geen verbinding, server druk) of dat het
 * bestand of de taak zelf het probleem is (te groot, taak verwijderd, opslag vol).
 */
export class AttachmentError extends Error {
  /** @param {string} message @param {{ status?: number, code?: string, retryable?: boolean }} [info] */
  constructor(message, { status = 0, code = 'NETWORK', retryable = false } = {}) {
    super(message);
    this.name = 'AttachmentError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Een HTTP-status en het JSON-antwoord van de server als fout. 401 is een AuthError (opnieuw inloggen). */
function failure(status, body) {
  if (status === 401) return new AuthError();
  const code = typeof body?.error_code === 'string' ? body.error_code : 'HTTP';
  const message = typeof body?.error === 'string' ? body.error : `HTTP ${status}`;
  const retryable = status >= 500 && status !== 507 || status === 408 || status === 429;
  return new AttachmentError(message, { status, code, retryable });
}

/**
 * @param {{ getToken: () => string | null, baseUrl?: string, fetch?: typeof fetch, XHR?: typeof XMLHttpRequest, stallMs?: number }} options
 */
export function createAttachmentsApi({ getToken, baseUrl = '', fetch: fetchFn = globalThis.fetch, XHR = globalThis.XMLHttpRequest, stallMs = 60_000 }) {
  const auth = () => {
    const token = getToken();
    if (!token) throw new AuthError('geen token ingesteld');
    return { Authorization: `Bearer ${token}` };
  };
  const json = async (res) => {
    try { return await res.json(); } catch { return null; }
  };

  return {
    /** De grenzen van de server en wat deze gebruiker al gebruikt: `{ max_upload_bytes, quota_bytes, used_bytes, per_task }`. */
    async limits({ signal } = {}) {
      let res;
      try {
        res = await fetchFn(`${baseUrl}/api/v1/attachments/limits`, { headers: auth(), signal });
      } catch (err) {
        if (err instanceof AuthError) throw err;
        throw new AttachmentError('geen verbinding', { retryable: true });
      }
      if (!res.ok) throw failure(res.status, await json(res));
      return res.json();
    },

    /**
     * Stuurt een bestand naar de server. Gebruikt XMLHttpRequest, want alleen die meldt de voortgang van het versturen.
     * @param {{ id: string, taskId: string, blob: Blob, mime: string, signal?: AbortSignal, onProgress?: (fraction: number) => void }} input
     * @returns {Promise<{ id: string, size: number, sha256: string, mime: string }>}
     */
    upload({ id, taskId, blob, mime, signal, onProgress = () => {} }) {
      return new Promise((resolve, reject) => {
        let headers;
        try {
          headers = auth();
        } catch (err) {
          reject(err);
          return;
        }
        const xhr = new XHR();
        const url = `${baseUrl}/api/v1/attachments?id=${encodeURIComponent(id)}&task_id=${encodeURIComponent(taskId)}`;
        xhr.open('POST', url);
        for (const [k, v] of Object.entries({ ...headers, 'Content-Type': mime || 'application/octet-stream' })) xhr.setRequestHeader(k, v);
        xhr.responseType = 'text';
        // Een upload zonder voortgang (verbinding weggevallen zonder dat de browser het merkt) wordt na een tijd afgebroken.
        let stall;
        const arm = () => {
          globalThis.clearTimeout(stall);
          stall = globalThis.setTimeout(() => xhr.abort(), stallMs);
        };
        const done = () => { globalThis.clearTimeout(stall); signal?.removeEventListener('abort', onAbort); };
        const onAbort = () => xhr.abort();
        signal?.addEventListener('abort', onAbort);
        xhr.upload.onprogress = (e) => { arm(); if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); };
        xhr.onload = () => {
          done();
          let body = null;
          try { body = JSON.parse(xhr.responseText); } catch { /* geen JSON */ }
          if (xhr.status >= 200 && xhr.status < 300 && body && typeof body.sha256 === 'string') {
            onProgress(1);
            resolve(body);
          } else {
            reject(failure(xhr.status, body));
          }
        };
        xhr.onerror = () => { done(); reject(new AttachmentError('geen verbinding', { retryable: true })); };
        xhr.onabort = () => { done(); reject(new AttachmentError(signal?.aborted ? 'afgebroken' : 'de verbinding viel stil', { code: 'ABORTED', retryable: !signal?.aborted })); };
        arm();
        xhr.send(blob);
      });
    },

    /** Haalt een bijlage op als Blob. Het bestandstype van de Blob is het type dat de server meegeeft (octet-stream tenzij het een veilig type is). */
    async download(id, { signal } = {}) {
      let res;
      try {
        res = await fetchFn(`${baseUrl}/api/v1/attachments/${encodeURIComponent(id)}`, { headers: auth(), signal });
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (signal?.aborted) throw new AttachmentError('afgebroken', { code: 'ABORTED' });
        throw new AttachmentError('geen verbinding', { retryable: true });
      }
      if (!res.ok) throw failure(res.status, await json(res));
      return res.blob();
    },
  };
}
