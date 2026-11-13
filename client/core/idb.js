// Opslag in IndexedDB (alleen in de browser). Eén commit is één transactie: alles of niets.
// Stores: rows ("resource/id" -> { resource, row }), meta (sleutel -> waarde), queue ([seq, origin] -> commando).

const DB_NAME = 'eigen-tool';
const DB_VERSION = 1;

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transactie afgebroken'));
  });
const result = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export class IdbAdapter {
  constructor(name = DB_NAME) {
    this.name = name;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    const request = indexedDB.open(this.name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('rows')) db.createObjectStore('rows');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: ['seq', 'origin'] });
    };
    this.db = await result(request);
    // een nieuwere versie in een ander tabblad mag niet geblokkeerd worden door dit tabblad
    this.db.onversionchange = () => {
      this.db?.close();
      this.db = null;
    };
    return this.db;
  }

  async load() {
    const db = await this.open();
    const tx = db.transaction(['rows', 'meta', 'queue'], 'readonly');
    const rows = result(tx.objectStore('rows').getAll());
    const metaKeys = result(tx.objectStore('meta').getAllKeys());
    const metaValues = result(tx.objectStore('meta').getAll());
    const queue = result(tx.objectStore('queue').getAll());
    await done(tx);
    const keys = await metaKeys;
    const values = await metaValues;
    return { rows: await rows, meta: Object.fromEntries(keys.map((k, i) => [k, values[i]])), queue: await queue };
  }

  async commit(batch) {
    const db = await this.open();
    const tx = db.transaction(['rows', 'meta', 'queue'], 'readwrite');
    const rows = tx.objectStore('rows');
    const meta = tx.objectStore('meta');
    const queue = tx.objectStore('queue');
    if (batch.clearRows) rows.clear();
    for (const { resource, row } of batch.rowsPut ?? []) rows.put({ resource, row }, `${resource}/${row.id}`);
    for (const { resource, id } of batch.rowsDelete ?? []) rows.delete(`${resource}/${id}`);
    for (const [key, value] of Object.entries(batch.meta ?? {})) meta.put(value, key);
    for (const item of batch.queueAdd ?? []) queue.put(item);
    for (const key of batch.queueRemove ?? []) queue.delete(key);
    await done(tx);
  }

  /** Wist alle lokale gegevens (bij afmelden). */
  async clear() {
    const db = await this.open();
    const tx = db.transaction(['rows', 'meta', 'queue'], 'readwrite');
    for (const name of ['rows', 'meta', 'queue']) tx.objectStore(name).clear();
    await done(tx);
  }
}
