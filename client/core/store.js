// Lokale opslag van de client: de laatst bevestigde toestand van de server ("base"), een wachtrij met nog niet
// bevestigde commando's, en de weergave ("view") = base met de wachtrij er optimistisch op toegepast.
//
// Bewaren gaat via een adapter (IndexedDB in de browser, geheugen in tests). Eén `commit` is atomair:
// de rijen uit een sync-antwoord, het nieuwe token en het leegmaken van de wachtrij gaan samen of niet.

import { applyCommand, cloneState, emptyState, RESOURCES } from './reducer.js';

/**
 * @typedef {{ type: string, uuid: string, args?: Record<string, unknown> }} Command
 * @typedef {{ seq: number, origin: string, at: string, cmd: Command }} QueueItem
 *   seq + origin vormen samen de sleutel: seq loopt per tabblad op, origin is uniek per tabblad. Zo kunnen twee
 *   tabbladen die dezelfde opslag delen nooit elkaars wachtende commando's overschrijven.
 * @typedef {{
 *   clearRows?: boolean,
 *   rowsPut?: { resource: string, row: { id: string } }[],
 *   rowsDelete?: { resource: string, id: string }[],
 *   meta?: Record<string, unknown>,
 *   queueAdd?: QueueItem[],
 *   queueRemove?: [number, string][],
 * }} Batch
 * @typedef {{
 *   load(): Promise<{ rows: { resource: string, row: { id: string } }[], meta: Record<string, unknown>, queue: QueueItem[] }>,
 *   commit(batch: Batch): Promise<void>,
 * }} Adapter
 */

/** Volgorde van de wachtrij: op volgnummer, bij gelijke nummers (twee tabbladen) op herkomst. */
export const byQueueOrder = (a, b) => a.seq - b.seq || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0);
const keyOf = (item) => `${item.seq}:${item.origin}`;

function randomOrigin() {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(9))) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36];
  return s;
}

/** Opslag in het geheugen: voor tests, en als terugval wanneer IndexedDB niet beschikbaar is. */
export class MemoryAdapter {
  constructor() {
    this.rows = new Map();
    this.meta = {};
    this.queue = new Map();
    /** Zet op true om de eerstvolgende commit te laten mislukken (voor tests). */
    this.failNextCommit = false;
  }

  async load() {
    return {
      rows: [...this.rows.values()].map((x) => structuredClone(x)),
      meta: structuredClone(this.meta),
      queue: [...this.queue.values()].sort(byQueueOrder).map((x) => structuredClone(x)),
    };
  }

  async commit(batch) {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error('opslag mislukt (test)');
    }
    if (batch.clearRows) this.rows.clear();
    for (const { resource, row } of batch.rowsPut ?? []) this.rows.set(`${resource}/${row.id}`, structuredClone({ resource, row }));
    for (const { resource, id } of batch.rowsDelete ?? []) this.rows.delete(`${resource}/${id}`);
    Object.assign(this.meta, structuredClone(batch.meta ?? {}));
    for (const item of batch.queueAdd ?? []) this.queue.set(`${item.seq}:${item.origin}`, structuredClone(item));
    for (const [seq, origin] of batch.queueRemove ?? []) this.queue.delete(`${seq}:${origin}`);
  }
}

export class Store {
  /**
   * @param {Adapter} adapter
   * @param {{ now?: () => string, origin?: string, onPersistError?: (err: unknown) => void }} [options]
   */
  constructor(adapter, { now = () => new Date().toISOString(), origin = randomOrigin(), onPersistError = (err) => console.error('bewaren mislukt', err) } = {}) {
    this.adapter = adapter;
    this.now = now;
    this.origin = origin;
    this.onPersistError = onPersistError;
    /** Commando's die al in het geheugen staan maar nog niet bewaard zijn (zie init). */
    this.unsaved = new Set();
    this.base = emptyState();
    this.view = emptyState();
    /** @type {QueueItem[]} */
    this.queue = [];
    this.token = '*';
    /** De ingelogde gebruiker en wie je verder in gedeelde projecten tegenkomt (alleen namen), zoals de server ze meldde. */
    this.me = null;
    this.users = [];
    this.lastSeq = 0;
    this.listeners = new Set();
    this.ready = false;
  }

  /** Laadt de bewaarde toestand. Aanroepen vóór gebruik, en opnieuw om wijzigingen van een ander tabblad op te halen. */
  async init() {
    const data = await this.adapter.load();
    const base = emptyState();
    for (const { resource, row } of data.rows) if (base[resource]) base[resource].set(row.id, row);
    this.base = base;
    // Wat dit tabblad net heeft toegevoegd maar nog niet bewaard was toen het laden begon, mag niet wegvallen.
    const loaded = new Set(data.queue.map(keyOf));
    const pending = this.queue.filter((q) => this.unsaved.has(keyOf(q)) && !loaded.has(keyOf(q)));
    this.queue = [...data.queue, ...pending].sort(byQueueOrder);
    this.token = typeof data.meta.sync_token === 'string' ? data.meta.sync_token : '*';
    this.me = data.meta.me ?? null;
    this.users = Array.isArray(data.meta.users) ? data.meta.users : [];
    this.lastSeq = Math.max(this.lastSeq, ...this.queue.map((q) => q.seq));
    this.rebuild();
    this.ready = true;
    this.notify();
  }

  get queueLength() {
    return this.queue.length;
  }

  /** Id van de ingelogde gebruiker; null zolang de server er nog niet over gesproken heeft. */
  get userId() {
    return this.me?.id ?? null;
  }

  /** Naam van een gebruiker zoals die in de gedeelde projecten bekend is, of null. */
  userName(id) {
    return this.users.find((u) => u.id === id)?.name ?? null;
  }

  /** @param {() => void} fn */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of [...this.listeners]) fn();
  }

  rebuild() {
    const view = cloneState(this.base);
    for (const item of this.queue) applyCommand(view, item.cmd, item.at, this.userId);
    this.view = view;
  }

  async persist(batch) {
    try {
      await this.adapter.commit(batch);
    } catch (err) {
      // De toestand in het geheugen klopt nog. Wat niet bewaard is, wordt na een herstart opnieuw opgehaald
      // (delta vanaf het oude token) of opnieuw verstuurd (zelfde uuid, dus zonder dubbel effect).
      this.onPersistError(err);
    }
  }

  /**
   * Zet commando's in de wachtrij en past ze direct toe op de weergave.
   * @param {Command[]} commands
   */
  async enqueue(commands) {
    if (commands.length === 0) return;
    const at = this.now();
    const items = commands.map((cmd) => {
      // tijd als basis, zodat commando's van verschillende tabbladen ongeveer op volgorde van maken komen te staan
      this.lastSeq = Math.max(this.lastSeq + 1, Date.now() * 1000);
      return { seq: this.lastSeq, origin: this.origin, at, cmd };
    });
    this.queue.push(...items);
    for (const item of items) this.unsaved.add(keyOf(item));
    const view = cloneState(this.view);
    for (const item of items) applyCommand(view, item.cmd, item.at, this.userId);
    this.view = view;
    this.notify();
    await this.persist({ queueAdd: items });
    for (const item of items) this.unsaved.delete(keyOf(item));
  }

  /** De eerste `max` commando's uit de wachtrij, zonder ze te verwijderen. */
  peek(max) {
    return this.queue.slice(0, max);
  }

  /** Haalt commando's uit de wachtrij zonder ze te versturen (bijvoorbeeld een commando dat de server nooit kan aannemen). */
  async drop(items) {
    const gone = new Set(items.map(keyOf));
    this.queue = this.queue.filter((q) => !gone.has(keyOf(q)));
    this.rebuild();
    this.notify();
    await this.persist({ queueRemove: items.map((q) => [q.seq, q.origin]) });
  }

  /**
   * Ruimt op wat bij een verdwenen project of taak hoorde. De server meldt alleen dát een project of taak voor jou weg is
   * (bijvoorbeeld omdat je uit het project bent gehaald, of de taak naar een project van een ander is verhuisd), niet
   * ook alles wat eraan hing; dat staat intussen voor jou niet meer toegankelijk op de server.
   */
  dropOrphans(batch) {
    const base = this.base;
    const drop = (resource, pred) => {
      for (const row of [...base[resource].values()]) {
        if (!pred(row)) continue;
        base[resource].delete(row.id);
        batch.rowsDelete.push({ resource, id: row.id });
      }
    };
    const projectsLeft = new Set(base.projects.keys());
    // Een rij die naar een project verwijst dat niet (meer) bestaat, hoort er niet meer bij. Het project zelf is de enige
    // plek waar dat mis kan gaan; daarom controleren we de rest tegen de projecten die er nog zijn.
    drop('sections', (s) => !projectsLeft.has(s.project_id));
    drop('members', (m) => !projectsLeft.has(m.project_id));
    drop('comments', (c) => (c.project_id ? !projectsLeft.has(c.project_id) : false));
    drop('tasks', (t) => !projectsLeft.has(t.project_id));
    // subtaken zonder bovenliggende taak, en alles wat aan een verdwenen taak hing
    for (let again = true; again;) {
      again = false;
      drop('tasks', (t) => {
        const orphan = t.parent_id && !base.tasks.has(t.parent_id);
        if (orphan) again = true;
        return Boolean(orphan);
      });
    }
    drop('comments', (c) => (c.task_id ? !base.tasks.has(c.task_id) : false));
    drop('reminders', (r) => !base.tasks.has(r.task_id));
    // een locatieherinnering zonder plaats (de plaats is weg) doet niets meer
    drop('reminders', (r) => Boolean(r.place_id) && !base.places.has(r.place_id));
  }

  /**
   * Verwerkt een sync-antwoord: neemt de rijen over, verwijdert bevestigde commando's en bewaart het token.
   * @returns {Promise<{ cmd: Command, error_code: string, error: string }[]>} de door de server geweigerde commando's
   */
  async applyResponse(res) {
    /** @type {Batch} */
    const batch = { rowsPut: [], rowsDelete: [], meta: {}, queueRemove: [] };
    if (res.full_sync) {
      this.base = emptyState();
      batch.clearRows = true;
    }
    for (const resource of RESOURCES) {
      for (const row of res[resource] ?? []) {
        if (row.is_deleted) {
          this.base[resource].delete(row.id);
          batch.rowsDelete.push({ resource, id: row.id });
        } else {
          this.base[resource].set(row.id, row);
          batch.rowsPut.push({ resource, row });
        }
      }
    }
    this.dropOrphans(batch);
    if (res.me) {
      this.me = res.me;
      batch.meta.me = res.me;
    }
    if (Array.isArray(res.users)) {
      this.users = res.users;
      batch.meta.users = res.users;
    }
    const status = res.sync_status ?? {};
    const errors = [];
    const rest = [];
    for (const item of this.queue) {
      if (!Object.hasOwn(status, item.cmd.uuid)) {
        rest.push(item);
        continue;
      }
      batch.queueRemove.push([item.seq, item.origin]);
      const s = status[item.cmd.uuid];
      if (s !== 'ok') errors.push({ cmd: item.cmd, error_code: s?.error_code ?? 'UNKNOWN', error: s?.error ?? 'onbekende fout' });
    }
    this.queue = rest;
    if (!res.partial && typeof res.sync_token === 'string') {
      this.token = res.sync_token;
      batch.meta.sync_token = res.sync_token;
    }
    this.rebuild();
    this.notify();
    await this.persist(batch);
    return errors;
  }
}
