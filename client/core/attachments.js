// Bijlagen op de client: een gekozen bestand wordt eerst lokaal bewaard (IndexedDB, los van de wachtrij met commando's), daarna
// geüpload zodra dat kan, en pas dan wordt het commando attachment_add aan de wachtrij toegevoegd. Zo werkt "bestand kiezen"
// ook zonder verbinding, en blijft het staan als de app tussendoor sluit.
//
// Een bestand heeft een status: 'waiting' (wacht op verbinding, inloggen of op de taak zelf, die eerst op de server moet komen),
// 'uploading', of 'failed' (de server weigert het, bijvoorbeeld te groot of de taak is weg; opnieuw proberen of verwijderen).
// Is een upload geslaagd, dan verdwijnt de lokale kopie en staat de bijlage in de wachtrij als commando. Het bestand zelf
// ophalen (voor een voorbeeld of om te openen) gaat met het token via fetch; zie attachmentsApi.js.

import { AuthError } from './syncClient.js';
import { AttachmentError } from './attachmentsApi.js';
import { cleanFileName, normalizeMime } from '../../shared/attachments.js';
import { MAX_ATTACHMENTS_PER_TASK } from './reducer.js';

const DB_NAME = 'tickory-files';
const STORE = 'uploads';

/** Bestanden die op hun upload wachten, in het geheugen: voor tests en als IndexedDB niet beschikbaar is. */
export class MemoryFiles {
  constructor() {
    this.map = new Map();
    /** Op true laat de eerstvolgende `put` mislukken met een QuotaExceededError (voor tests). */
    this.full = false;
  }

  async list() { return [...this.map.values()]; }

  async put(rec) {
    if (this.full) throw Object.assign(new Error('opslag vol'), { name: 'QuotaExceededError' });
    this.map.set(rec.id, { ...rec });
  }

  async delete(id) { this.map.delete(id); }

  async clear() { this.map.clear(); }
}

/** Dezelfde opslag in IndexedDB, in een eigen database (de bestanden kunnen groot zijn; de rest van de app niet). */
export class IdbFiles {
  constructor(name = DB_NAME) {
    this.name = name;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    const req = indexedDB.open(this.name, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' }); };
    this.db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    this.db.onversionchange = () => { this.db?.close(); this.db = null; };
    return this.db;
  }

  async run(mode, fn) {
    const db = await this.open();
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transactie afgebroken'));
    });
    return result;
  }

  async list() {
    const req = await this.run('readonly', (s) => s.getAll());
    return req.result;
  }

  put(rec) { return this.run('readwrite', (s) => { s.put(rec); }); }

  delete(id) { return this.run('readwrite', (s) => { s.delete(id); }); }

  clear() { return this.run('readwrite', (s) => { s.clear(); }); }
}

/** Wachttijd na een mislukte poging (ms): 2 s, 4 s, ... tot een minuut. */
export const backoff = (tries) => Math.min(60_000, 1000 * 2 ** Math.min(tries, 6));

/** Waar een bestand heen kan: de bijlage-id's zijn gelijk aan de bestands-id's, zo verwijst alles naar hetzelfde. */
const DEFAULT_LIMITS = { max_upload_bytes: 25_000_000, quota_bytes: null, used_bytes: null, per_task: MAX_ATTACHMENTS_PER_TASK };

/**
 * @param {{
 *   store: import('./store.js').Store,
 *   actions: { addAttachment: (input: object) => Promise<void> },
 *   api: ReturnType<typeof import('./attachmentsApi.js').createAttachmentsApi>,
 *   files?: { list: () => Promise<object[]>, put: (rec: object) => Promise<void>, delete: (id: string) => Promise<void>, clear: () => Promise<void> },
 *   getToken: () => string | null,
 *   makeId: () => string,
 *   online?: () => boolean,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 *   now?: () => number,
 *   maxCacheBytes?: number,
 * }} options
 */
export function createAttachmentManager({
  store, actions, api, files = new MemoryFiles(), getToken, makeId, online = () => globalThis.navigator?.onLine !== false,
  timers = globalThis, now = () => Date.now(), maxCacheBytes = 40_000_000,
}) {
  /** @type {Map<string, object>} */
  const records = new Map();
  const listeners = new Set();
  const cache = new Map(); // id -> Blob, voor voorbeelden en openen; de oudste gaat eruit
  let cacheBytes = 0;
  let running = null;
  let again = false;
  let timer = null;
  let limitsPromise = null;
  let current = null; // { id, controller } van de lopende upload

  const notify = () => { for (const fn of [...listeners]) fn(); };
  const sorted = () => [...records.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  /** Wat de interface van een record mag zien (zonder het bestand zelf). */
  const view = (r) => ({ id: r.id, task_id: r.task_id, name: r.name, size: r.size, mime: r.mime, status: r.status, error: r.error ?? null, progress: r.progress ?? 0, reason: r.reason ?? null });

  async function save(rec) {
    records.set(rec.id, rec);
    await files.put(rec);
  }
  async function forget(id) {
    records.delete(id);
    await files.delete(id).catch(() => {});
  }

  /** De taak moet door de server bevestigd zijn voordat we een bestand erbij kunnen zetten. */
  const taskConfirmed = (taskId) => store.base.tasks.has(taskId);
  const taskKnown = (taskId) => store.view.tasks.has(taskId);

  const schedule = (ms) => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { timer = null; manager.process(); }, ms);
  };

  /** Eén bestand uploaden. Geeft 'done', 'retry' (later opnieuw), 'stop' (niet doorgaan: niet ingelogd) of 'failed'. */
  async function uploadOne(rec) {
    const controller = new AbortController();
    current = { id: rec.id, controller };
    rec.status = 'uploading';
    rec.error = null;
    rec.reason = null;
    rec.progress = 0;
    notify();
    try {
      const uploaded = await api.upload({
        id: rec.id, taskId: rec.task_id, blob: rec.blob, mime: rec.mime, signal: controller.signal,
        onProgress: (f) => { rec.progress = f; notify(); },
      });
      // Bewaar eerst het commando (in de wachtrij op schijf) en pas dan het wissen van de lokale kopie: sluit de app ertussen,
      // dan volgt een nieuwe upload (dezelfde inhoud = hetzelfde antwoord) en hetzelfde commando-uuid (geen dubbele bijlage).
      if (!records.has(rec.id)) return 'discarded'; // intussen weggegooid: het bestand op de server ruimt de server zelf op
      await actions.addAttachment({ taskId: rec.task_id, name: rec.name, uploaded });
      rememberBlob(rec.id, rec.blob);
      await forget(rec.id);
      return 'done';
    } catch (err) {
      if (!records.has(rec.id)) return 'discarded';
      if (err instanceof AuthError) {
        rec.status = 'waiting';
        return 'stop';
      }
      const info = err instanceof AttachmentError ? err : new AttachmentError(String(err?.message ?? err), { retryable: true });
      rec.tries = (rec.tries ?? 0) + 1;
      if (info.code === 'ABORTED' && !info.retryable) {
        rec.status = 'waiting';
        return 'stop';
      }
      if (info.retryable) {
        rec.status = 'waiting';
        rec.retryAt = now() + backoff(rec.tries);
        rec.reason = 'offline';
        return 'retry';
      }
      rec.status = 'failed';
      rec.error = info.code;
      rec.reason = info.message;
      await files.put(rec).catch(() => {});
      return 'failed';
    } finally {
      current = null;
      notify();
    }
  }

  function rememberBlob(id, blob) {
    if (!blob || blob.size > maxCacheBytes / 2) return;
    if (cache.has(id)) cacheBytes -= cache.get(id).size;
    cache.set(id, blob);
    cacheBytes += blob.size;
    for (const [oldId, b] of cache) {
      if (cacheBytes <= maxCacheBytes) break;
      if (oldId === id) continue;
      cache.delete(oldId);
      cacheBytes -= b.size;
    }
  }

  /** De lus: neemt steeds het eerstvolgende bestand dat kan, tot er niets meer kan. */
  async function loop() {
    do {
      again = false;
      for (;;) {
        if (!getToken() || !online()) break;
        const t = now();
        let next = null;
        let soonest = Infinity;
        for (const rec of sorted()) {
          if (rec.status !== 'waiting') continue;
          if (!taskKnown(rec.task_id)) {
            // de taak bestaat niet meer (verwijderd, of het project verlaten): het bestand heeft geen bestemming meer
            if (store.ready) await forget(rec.id);
            continue;
          }
          if (!taskConfirmed(rec.task_id)) continue; // de taak staat nog in de wachtrij; zodra de server hem heeft, gaan we door
          if ((rec.retryAt ?? 0) > t) { soonest = Math.min(soonest, rec.retryAt); continue; }
          next = rec;
          break;
        }
        notify();
        if (!next) {
          if (soonest !== Infinity) schedule(Math.max(200, soonest - t));
          break;
        }
        if ((await uploadOne(next)) === 'stop') break;
      }
    } while (again);
  }

  const manager = {
    /** Laadt wat een eerdere sessie nog niet kon uploaden. Een upload die halverwege werd afgebroken, begint opnieuw. */
    async init() {
      records.clear();
      for (const rec of await files.list().catch(() => [])) {
        if (rec.status === 'uploading') rec.status = 'waiting';
        records.set(rec.id, rec);
      }
      notify();
      manager.process();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** De grenzen van de server (een keer opgehaald; bij een fout de standaardwaarden). */
    limits({ refresh = false } = {}) {
      if (refresh || !limitsPromise) {
        limitsPromise = api.limits().catch(() => ({ ...DEFAULT_LIMITS }));
      }
      return limitsPromise;
    },

    /** De bestanden bij een taak die nog niet als bijlage in de lijst staan. */
    pendingFor(taskId) {
      return sorted().filter((r) => r.task_id === taskId).map(view);
    },
    get pendingCount() { return records.size; },

    /**
     * Kiest bestanden voor een taak. Elk bestand wordt gecontroleerd (leeg, te groot, te veel bijlagen) en lokaal bewaard.
     * @param {string} taskId
     * @param {readonly File[]} fileList
     * @returns {Promise<{ added: string[], rejected: { name: string, reason: 'empty' | 'tooLarge' | 'tooMany' | 'storageFull' | 'noTask', max?: number }[] }>}
     */
    async stage(taskId, fileList) {
      const limits = await manager.limits();
      const added = [];
      const rejected = [];
      if (!taskKnown(taskId)) return { added, rejected: [...fileList].map((f) => ({ name: f.name, reason: 'noTask' })) };
      const have = () => [...store.view.attachments.values()].filter((a) => a.task_id === taskId).length + [...records.values()].filter((r) => r.task_id === taskId && r.status !== 'failed').length;
      for (const file of fileList) {
        const name = cleanFileName(file.name);
        if (file.size === 0) { rejected.push({ name, reason: 'empty' }); continue; }
        if (file.size > limits.max_upload_bytes) { rejected.push({ name, reason: 'tooLarge', max: limits.max_upload_bytes }); continue; }
        if (have() >= (limits.per_task ?? MAX_ATTACHMENTS_PER_TASK)) { rejected.push({ name, reason: 'tooMany', max: limits.per_task ?? MAX_ATTACHMENTS_PER_TASK }); continue; }
        const rec = {
          id: makeId(), task_id: taskId, name, size: file.size, mime: normalizeMime(file.type), blob: file,
          status: 'waiting', error: null, reason: null, progress: 0, tries: 0, retryAt: 0, created_at: now(),
        };
        try {
          await save(rec);
        } catch (err) {
          records.delete(rec.id);
          rejected.push({ name, reason: err?.name === 'QuotaExceededError' ? 'storageFull' : 'storageFull' });
          continue;
        }
        added.push(rec.id);
      }
      notify();
      manager.process();
      return { added, rejected };
    },

    /** Probeert een mislukt bestand opnieuw. */
    async retry(id) {
      const rec = records.get(id);
      if (!rec || rec.status === 'uploading') return;
      rec.status = 'waiting';
      rec.error = null;
      rec.reason = null;
      rec.tries = 0;
      rec.retryAt = 0;
      await files.put(rec).catch(() => {});
      notify();
      manager.process();
    },

    /** Gooit een wachtend of mislukt bestand weg (loopt de upload nu, dan wordt die afgebroken). */
    async discard(id) {
      if (current?.id === id) current.controller.abort();
      await forget(id);
      notify();
    },

    /**
     * Gaat de wachtende bestanden langs. Hooguit één lus tegelijk; een aanroep terwijl de lus loopt, laat hem nog een keer rondgaan.
     * Geeft een belofte die klaar is zodra er niets meer te doen valt (niets wacht, of alles wacht op verbinding of tijd).
     */
    process() {
      if (running) {
        again = true;
        return running;
      }
      running = loop().finally(() => { running = null; });
      return running;
    },

    /** Klaar zodra de lopende upload(s) klaar zijn (voor tests en voor het afsluiten). */
    idle() { return running ?? Promise.resolve(); },

    /** De inhoud van een bijlage als Blob (uit het geheugen als die er al is). */
    async fetchBlob(id, { signal } = {}) {
      const hit = cache.get(id);
      if (hit) return hit;
      const local = records.get(id);
      if (local?.blob) return local.blob;
      const blob = await api.download(id, { signal });
      rememberBlob(id, blob);
      return blob;
    },

    /** Een bijlage is verwijderd: het bewaarde exemplaar kan weg. */
    forgetBlob(id) {
      const b = cache.get(id);
      if (b) { cache.delete(id); cacheBytes -= b.size; }
    },

    /** Wist alles (bij afmelden). */
    async clear() {
      current?.controller.abort();
      records.clear();
      cache.clear();
      cacheBytes = 0;
      limitsPromise = null;
      await files.clear().catch(() => {});
      notify();
    },
  };
  return manager;
}
