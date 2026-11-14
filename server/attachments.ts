// Bijlagen bij taken: de bestanden zelf. De gegevens over een bijlage (naam, grootte, type) staan als gewone entiteit
// `attachment` in de sync (zie sync.ts en shared/schema.js); hier staat wat daarbuiten hoort: uploaden, downloaden en opruimen.
//
// Uploaden is twee stappen, zodat het ook offline kan wachten en een herhaling veilig is:
//   1. POST /api/v1/attachments?id=<bijlage-id>&task_id=<taak-id>   met het bestand als body (geen multipart), Content-Type = het type.
//      De server streamt het naar een tijdelijk bestand (nooit het hele bestand in het geheugen), telt en hasht onderweg, en
//      zet het na afloop op zijn plek. Antwoord: { id, size, sha256, mime } zoals de server het zag.
//   2. Het commando attachment_add met diezelfde waarden (sync.ts) maakt er een bijlage van. Een bestand dat niet binnen een
//      uur aan een bijlage wordt gekoppeld, ruimt de server op.
// Dezelfde upload nog eens (zelfde id, zelfde inhoud) geeft hetzelfde antwoord en verandert niets.
//
// Op schijf heet een bestand naar een willekeurige sleutel (`<map>/<aa>/<sleutel>`), nooit naar het id of de naam van de
// gebruiker: id's kiest de client en op een bestandssysteem dat hoofdletters niet onderscheidt zouden twee id's elkaars
// bestand kunnen worden. De naam van de gebruiker is alleen tekst in de database en in de Content-Disposition van een download.

import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Transform, Writable } from 'node:stream';
import { join } from 'node:path';
import { DEFAULT_MIME, effectiveMime, isInlineMime, normalizeMime } from '../shared/attachments.js';
import { ID_RE } from './schema.ts';
import { LIMITS } from './limits.ts';
import { SyncError } from './rows.ts';
import type { Row } from './rows.ts';

export interface AttachmentOptions {
  /** De map voor de bestanden (hoort bij het datavolume, naast de database). */
  dir: string;
  /** Grootste bestand in bytes (MAX_UPLOAD_MB). */
  maxUploadBytes: number;
  /** Totaal aan bestanden per gebruiker in bytes (ATTACHMENT_QUOTA_MB). */
  quotaBytes: number;
  /** Hoe lang een upload zonder bijlage mag blijven staan (standaard een uur). */
  orphanMs?: number;
  /** Hoe lang een upload mag stilvallen voordat hij wordt afgebroken (standaard 20 seconden). */
  idleMs?: number;
  /** De traagste snelheid die we nog accepteren, in bytes per seconde (standaard 16 KiB/s): bepaalt de totale tijd voor een upload. */
  minBytesPerSecond?: number;
  /** Voor tests: de klok in milliseconden. */
  now?: () => number;
}

export interface Uploaded { id: string; size: number; sha256: string; mime: string }

const HEAD_BYTES = 16;
const BASE_UPLOAD_MS = 30_000;
const MAX_UPLOAD_MS = 2 * 60 * 60 * 1000;

const memberOfTask = (db: DatabaseSync, userId: string, taskId: string): boolean =>
  db.prepare(`SELECT 1 FROM tasks t JOIN project_members m ON m.project_id = t.project_id
              WHERE t.id = ? AND t.is_deleted = 0 AND m.user_id = ? AND m.is_deleted = 0`).get(taskId, userId) !== undefined;

/** Bestandsnaam voor de Content-Disposition: een veilige ASCII-terugval plus de echte naam als filename* (RFC 6266 / 8187). */
export function contentDisposition(kind: 'attachment' | 'inline', name: string): string {
  // eslint-disable-next-line no-control-regex
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_').slice(0, 150) || 'bijlage';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Leest een Range-header voor een bestand van `size` bytes. null = geen (bruikbare) range, 'invalid' = niet te leveren. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header || !header.startsWith('bytes=')) return null;
  const spec = header.slice(6).trim();
  if (spec.includes(',')) return null; // meerdere stukken: we leveren gewoon het hele bestand
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'invalid';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

export function createAttachments(db: DatabaseSync, options: AttachmentOptions) {
  const dir = options.dir;
  const tmpDir = join(dir, 'tmp');
  const now = options.now ?? Date.now;
  const orphanMs = options.orphanMs ?? 60 * 60 * 1000;
  const idleMs = options.idleMs ?? 20_000;
  const minRate = options.minBytesPerSecond ?? 16 * 1024;
  mkdirSync(tmpDir, { recursive: true });
  /** Bytes die nu onderweg zijn, per gebruiker: twee gelijktijdige uploads mogen samen niet over de grens gaan. */
  const inflight = new Map<string, number>();
  const pathOf = (key: string): string => join(dir, key.slice(0, 2), key);

  const used = (userId: string): number =>
    Number((db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM attachment_files WHERE user_id = ?').get(userId) as Row).n);

  /** Bijlagen van een taak, plus de uploads die er nog op wachten om er een te worden. */
  const perTaskCount = (taskId: string): number => Number((db.prepare(
    `SELECT (SELECT COUNT(*) FROM attachments WHERE task_id = ? AND is_deleted = 0)
          + (SELECT COUNT(*) FROM attachment_files WHERE task_id = ? AND linked = 0) AS n`).get(taskId, taskId) as Row).n);

  const removeFile = (key: string): void => {
    try { unlinkSync(pathOf(key)); } catch { /* weg of nooit gekomen */ }
  };

  /**
   * Streamt het verzoek naar een tijdelijk bestand met een harde grens, telt en hasht onderweg. Traag of stilgevallen = afgebroken.
   */
  async function receive(req: IncomingMessage, length: number, discard = false): Promise<{ tmp: string; size: number; sha256: string; head: Buffer }> {
    const tmp = join(tmpDir, randomBytes(12).toString('hex'));
    const hash = createHash('sha256');
    const head = Buffer.alloc(HEAD_BYTES);
    let headLen = 0;
    let total = 0;
    let last = now();
    const started = last;
    const controller = new AbortController();
    const deadline = Math.min(MAX_UPLOAD_MS, BASE_UPLOAD_MS + Math.ceil((length / minRate) * 1000));
    let timeout: SyncError | null = null;
    // Een kijker die elke seconde nagaat of de afzender nog doorgaat, en of het in redelijke tijd klaar komt.
    const watchdog = setInterval(() => {
      const t = now();
      if (t - last > idleMs) timeout = new SyncError('TIMEOUT', 'de upload viel stil en is afgebroken');
      else if (t - started > deadline) timeout = new SyncError('TIMEOUT', 'de upload gaat te langzaam en is afgebroken');
      if (timeout) controller.abort();
    }, Math.max(50, Math.min(1000, Math.floor(idleMs / 4))));
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        last = now();
        if (total > length) return cb(new SyncError('TOO_LARGE', 'het bestand is groter dan opgegeven'));
        if (headLen < HEAD_BYTES) headLen += chunk.copy(head, headLen, 0, HEAD_BYTES - headLen);
        hash.update(chunk);
        return cb(null, chunk);
      },
    });
    try {
      const sink = discard ? new Writable({ write: (_c, _e, cb) => cb() }) : createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
      // Via een tussenstuk: pipeline() sluit bij een fout ook de bron, en dan sluit Node de verbinding en kan de afzender geen
      // antwoord (408, 413, ...) meer lezen. Het verzoek zelf laten we met rust; de verbinding sluit na het antwoord.
      const bridge = new PassThrough();
      req.pipe(bridge);
      const onReqError = (e: Error): void => { bridge.destroy(e); };
      const onReqClose = (): void => { if (!req.complete) bridge.destroy(Object.assign(new Error('afgebroken'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })); };
      req.once('error', onReqError);
      req.once('close', onReqClose);
      try {
        await pipeline(bridge, tap, sink, { signal: controller.signal });
      } finally {
        req.off('error', onReqError);
        req.off('close', onReqClose);
        req.unpipe(bridge);
        if (timeout || controller.signal.aborted) req.pause();
      }
    } catch (err) {
      rmSync(tmp, { force: true });
      if (timeout) throw timeout;
      if (err instanceof SyncError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC') throw new SyncError('STORAGE_FULL', 'de server heeft geen schijfruimte meer voor bijlagen');
      if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'ABORT_ERR') throw new SyncError('ABORTED', 'de upload is afgebroken');
      throw err;
    } finally {
      clearInterval(watchdog);
    }
    if (total !== length) {
      rmSync(tmp, { force: true });
      throw new SyncError('ABORTED', 'de upload is niet volledig aangekomen');
    }
    return { tmp, size: total, sha256: hash.digest('hex'), head: head.subarray(0, headLen) };
  }

  return {
    dir,
    maxUploadBytes: options.maxUploadBytes,
    quotaBytes: options.quotaBytes,
    used,

    /**
     * Neemt een upload aan. Alle controles die zonder de inhoud kunnen, gebeuren vóór het eerste byte wordt gelezen: een
     * onbekende taak, een taak van een ander project, een volle schijf van de gebruiker. Wat de server niet mag zien is "niet gevonden".
     */
    async upload(req: IncomingMessage, userId: string, params: { id: unknown; taskId: unknown }): Promise<Uploaded> {
      const raw = req.headers['content-length'];
      if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) throw new SyncError('LENGTH_REQUIRED', 'geef de grootte van het bestand op (Content-Length)');
      const length = Number(raw);
      // Wat zonder de inhoud te beoordelen kan, gebeurt vóór we haar bewaren. Daarna lezen we de body toch weg (zonder te bewaren):
      // antwoorden terwijl de afzender nog verstuurt, geeft bij hem vaak een verbroken verbinding in plaats van een bruikbare melding.
      const id = params.id;
      const taskId = params.taskId;
      let problem: SyncError | null = null;
      if (typeof id !== 'string' || !ID_RE.test(id)) problem = new SyncError('INVALID_ARG', 'id moet 8-40 tekens uit [A-Za-z0-9_-] zijn');
      else if (typeof taskId !== 'string' || !ID_RE.test(taskId)) problem = new SyncError('INVALID_ARG', 'task_id moet 8-40 tekens uit [A-Za-z0-9_-] zijn');
      else if (!memberOfTask(db, userId, taskId)) problem = new SyncError('NOT_FOUND', 'deze taak bestaat niet');
      else if (length === 0) problem = new SyncError('INVALID_ARG', 'het bestand is leeg');
      else if (length > options.maxUploadBytes) problem = new SyncError('TOO_LARGE', `het bestand is te groot (maximaal ${Math.floor(options.maxUploadBytes / 1_000_000)} MB)`);
      else if (used(userId) + (inflight.get(userId) ?? 0) + length > options.quotaBytes) problem = new SyncError('LIMIT_REACHED', 'je opslagruimte voor bijlagen is vol; verwijder eerst een bijlage');
      else {
        const perTask = perTaskCount(taskId as string);
        const already = db.prepare('SELECT 1 FROM attachment_files WHERE id = ?').get(id) !== undefined;
        if (!already && perTask >= LIMITS.attachmentsPerTask) problem = new SyncError('LIMIT_REACHED', `een taak kan hooguit ${LIMITS.attachmentsPerTask} bijlagen hebben`);
      }
      if (problem) {
        // Een absurd grote body lezen we niet weg: die verbinding sluit de server na het antwoord.
        if (length <= Math.max(options.maxUploadBytes, 1_000_000) * 4) {
          // de fout van de controle gaat voor; viel de afzender stil tijdens het weglezen, dan sluiten we na het antwoord (zie main.ts)
          await receive(req, length, true).catch((e: unknown) => { if (e instanceof SyncError && e.code === 'TIMEOUT') problem!.cut = true; });
        } else {
          problem.cut = true;
        }
        throw problem;
      }
      const uploadId = id as string;
      const uploadTask = taskId as string;

      inflight.set(userId, (inflight.get(userId) ?? 0) + length);
      let received;
      try {
        received = await receive(req, length);
      } finally {
        const left = (inflight.get(userId) ?? 0) - length;
        if (left > 0) inflight.set(userId, left);
        else inflight.delete(userId);
      }
      const { tmp, size, sha256, head } = received;
      const mime = effectiveMime(normalizeMime(req.headers['content-type']), head);

      // Vanaf hier niets meer dat wacht (geen await): controleren, vastleggen en op zijn plek zetten gebeurt in één keer.
      try {
        const existing = db.prepare('SELECT user_id, task_id, size, sha256, mime FROM attachment_files WHERE id = ?').get(uploadId) as Row | undefined;
        if (existing) {
          rmSync(tmp, { force: true });
          if (existing.user_id === userId && existing.task_id === uploadTask && existing.sha256 === sha256 && existing.size === size) {
            return { id: uploadId, size, sha256, mime: existing.mime as string }; // dezelfde upload nog eens: niets te doen
          }
          throw new SyncError('CONFLICT', 'er is al een ander bestand met dit id geüpload');
        }
        if (!memberOfTask(db, userId, uploadTask)) throw new SyncError('NOT_FOUND', 'deze taak bestaat niet');
        if (used(userId) + size > options.quotaBytes) throw new SyncError('LIMIT_REACHED', 'je opslagruimte voor bijlagen is vol; verwijder eerst een bijlage');
        // ook hier nog eens: gelijktijdige uploads voor dezelfde taak hebben de controle vooraf allemaal gepasseerd
        if (perTaskCount(uploadTask) >= LIMITS.attachmentsPerTask) throw new SyncError('LIMIT_REACHED', `een taak kan hooguit ${LIMITS.attachmentsPerTask} bijlagen hebben`);
        const key = randomBytes(16).toString('hex');
        mkdirSync(join(dir, key.slice(0, 2)), { recursive: true });
        renameSync(tmp, pathOf(key));
        try {
          db.prepare('INSERT INTO attachment_files (id, user_id, task_id, size, sha256, mime, key, linked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
            .run(uploadId, userId, uploadTask, size, sha256, mime, key, new Date(now()).toISOString());
        } catch (err) {
          removeFile(key);
          throw err;
        }
        return { id: uploadId, size, sha256, mime };
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
    },

    /**
     * Levert een bestand. Alleen voor wie het mag zien: een lid van het project van de taak, of de gebruiker die het net heeft
     * geüpload en nog niet gekoppeld. Al het andere (onbekend, verwijderd, van een ander project, geblokkeerde gebruiker) is dezelfde NOT_FOUND.
     */
    async download(req: IncomingMessage, res: ServerResponse, userId: string, id: string, inline: boolean, extraHeaders: Record<string, string> = {}): Promise<void> {
      const notFound = new SyncError('NOT_FOUND', 'deze bijlage bestaat niet');
      if (!ID_RE.test(id)) throw notFound;
      const f = db.prepare(
        `SELECT f.key, f.size, f.mime, f.task_id, f.user_id, f.linked, a.name, a.is_deleted
         FROM attachment_files f LEFT JOIN attachments a ON a.id = f.id WHERE f.id = ?`).get(id) as Row | undefined;
      if (!f) throw notFound;
      if (f.linked === 1) {
        if (f.is_deleted === 1 || !memberOfTask(db, userId, f.task_id as string)) throw notFound;
      } else if (f.user_id !== userId || !memberOfTask(db, userId, f.task_id as string)) throw notFound;
      let size: number;
      try {
        size = statSync(pathOf(f.key as string)).size;
      } catch {
        throw new SyncError('NOT_FOUND', 'het bestand is niet meer op de server te vinden');
      }
      if (size !== f.size) throw new SyncError('NOT_FOUND', 'het bestand op de server klopt niet met wat is opgeslagen');
      const mime = f.mime as string;
      const showInline = inline && isInlineMime(mime);
      const name = (f.name as string | null) || 'bijlage';
      const headers: Record<string, string | number> = {
        // Alleen een korte lijst typen mag als zichzelf worden getoond; al het andere is "een bestand" voor de browser.
        'Content-Type': isInlineMime(mime) ? mime : DEFAULT_MIME,
        'Content-Disposition': contentDisposition(showInline ? 'inline' : 'attachment', name),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'Accept-Ranges': 'bytes',
        ...extraHeaders,
      };
      const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size);
      if (range === 'invalid') {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
        res.end();
        return;
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      const length = size === 0 ? 0 : end - start + 1;
      res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': length, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      if (req.method === 'HEAD' || length === 0) {
        res.end();
        return;
      }
      const stream = createReadStream(pathOf(f.key as string), { start, end });
      res.on('close', () => stream.destroy());
      await pipeline(stream, res).catch(() => { /* de ontvanger haakte af */ });
    },

    /**
     * Ruimt op wat bij verwijderde bijlagen hoort: het bestand, de rij met het bestand, en de inhoud van de verwijderde rij zelf
     * (alleen het id blijft, zoals bij alle verwijderde rijen). Houdt een versienummer bij zodat elke ronde alleen nieuw werk ziet.
     */
    purgeDeleted(): number {
      const mark = Number((db.prepare("SELECT value FROM meta WHERE key = 'attachments_purged_rev'").get() as Row | undefined)?.value ?? 0);
      const rev = Number((db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as Row).value);
      if (rev <= mark) return 0;
      const gone = db.prepare('SELECT id FROM attachments WHERE is_deleted = 1 AND rev > ?').all(mark) as Row[];
      let n = 0;
      for (const { id } of gone) {
        const f = db.prepare('SELECT key FROM attachment_files WHERE id = ?').get(id as string) as Row | undefined;
        if (f) {
          removeFile(f.key as string);
          db.prepare('DELETE FROM attachment_files WHERE id = ?').run(id as string);
          n += 1;
        }
        db.prepare("UPDATE attachments SET name = '', mime = '', sha256 = '', size = 0 WHERE id = ? AND is_deleted = 1").run(id as string);
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('attachments_purged_rev', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(rev));
      return n;
    },

    /** Bestanden die te lang op een bijlage wachten, en tijdelijke bestanden van afgebroken uploads. */
    sweep(): { orphans: number; temp: number } {
      const cutoff = new Date(now() - orphanMs).toISOString();
      let orphans = 0;
      for (const f of db.prepare('SELECT id, key FROM attachment_files WHERE linked = 0 AND created_at < ?').all(cutoff) as Row[]) {
        removeFile(f.key as string);
        db.prepare('DELETE FROM attachment_files WHERE id = ?').run(f.id as string);
        orphans += 1;
      }
      let temp = 0;
      for (const name of existsSync(tmpDir) ? readdirSync(tmpDir) : []) {
        try {
          if (now() - statSync(join(tmpDir, name)).mtimeMs > orphanMs) { unlinkSync(join(tmpDir, name)); temp += 1; }
        } catch { /* al weg */ }
      }
      this.purgeDeleted();
      return { orphans, temp };
    },

    /**
     * Eenmalig bij het opstarten: de map en de database weer met elkaar in overeenstemming brengen. Tijdelijke bestanden
     * (er loopt nog geen upload), bestanden zonder rij, rijen van bijlagen die verdwenen of verwijderd zijn, en rijen zonder bestand.
     * Een gekoppelde bijlage zonder bestand blijft staan (en wordt gemeld): dat is verloren gegane inhoud, geen rommel.
     */
    check(): { strayFiles: number; rowsRemoved: number; missing: number } {
      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(tmpDir, { recursive: true });
      const keys = new Set((db.prepare('SELECT key FROM attachment_files').all() as Row[]).map((r) => r.key as string));
      let strayFiles = 0;
      for (const sub of readdirSync(dir)) {
        if (sub === 'tmp' || !/^[0-9a-f]{2}$/.test(sub)) continue;
        for (const file of readdirSync(join(dir, sub))) {
          if (!keys.has(file)) { rmSync(join(dir, sub, file), { force: true }); strayFiles += 1; }
        }
      }
      let rowsRemoved = 0;
      let missing = 0;
      const rows = db.prepare(
        `SELECT f.id, f.key, f.linked, a.id AS attachment, a.is_deleted FROM attachment_files f LEFT JOIN attachments a ON a.id = f.id`).all() as Row[];
      for (const r of rows) {
        const orphanRow = r.linked === 1 ? r.attachment === null || r.is_deleted === 1 : false;
        const hasFile = existsSync(pathOf(r.key as string));
        if (orphanRow || (!hasFile && r.linked === 0)) {
          removeFile(r.key as string);
          db.prepare('DELETE FROM attachment_files WHERE id = ?').run(r.id as string);
          rowsRemoved += 1;
        } else if (!hasFile) {
          missing += 1;
        }
      }
      db.prepare("DELETE FROM meta WHERE key = 'attachments_purged_rev'").run(); // de volgende ronde kijkt opnieuw naar alle verwijderde rijen
      this.purgeDeleted();
      return { strayFiles, rowsRemoved, missing };
    },
  };
}

export type Attachments = ReturnType<typeof createAttachments>;
