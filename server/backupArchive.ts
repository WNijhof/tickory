// Een back-up als één bestand om te downloaden: een tar-archief (POSIX ustar) met een consistente kopie van de database en
// de bestanden van de bijlagen. Zelf geschreven: een tar-bestand is een reeks blokken van 512 bytes (een kop per bestand,
// dan de inhoud aangevuld tot een veelvoud van 512, en aan het eind twee lege blokken). Elk systeem kan het uitpakken
// (`tar -xf`, ook Windows 10 en nieuwer, 7-Zip). Niet gecomprimeerd: bijlagen (foto's, pdf's) zijn dat meestal al, en zo
// kost een back-up geen rekenwerk en is hij met elk gereedschap te lezen. Wie wil, comprimeert het bestand achteraf.
//
// Inhoud:
//   tickory.db                 de database (VACUUM INTO: één leesbewerking, een compleet en consistent bestand)
//   attachments/xx/<sleutel>   de bestanden van de bijlagen die in díe kopie staan, met dezelfde indeling als op de server
//   tickory-backup.json        wanneer gemaakt, de schemaversie, het aantal bestanden en wat ontbrak
//   LEESMIJ.txt                hoe je hem terugzet (Nederlands en Engels)
//
// Alles wordt gestreamd: de database gaat eerst naar een tijdelijk bestand (in de map van de database, niet in /tmp: dat is in
// Docker een geheugenschijf), daarna lezen we alles in brokken van 64 KiB, met tegendruk van de verbinding. Er staat nooit
// meer dan één brok in het geheugen.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseSync as Db } from 'node:sqlite';

const BLOCK = 512;
const CHUNK = 64 * 1024;
/** De tijdelijke kopie: herkenbaar, zodat een achtergebleven bestand (na een crash) bij de volgende start wordt opgeruimd. */
export const TEMP_PREFIX = '.tickory-backup-';
const TEMP_RE = /^\.tickory-backup-[0-9a-f]{16}\.db$/;

/** Ruimt tijdelijke kopieën op die na een crash zijn blijven staan. Geeft het aantal verwijderde bestanden. */
export function removeStaleTemp(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (TEMP_RE.test(name)) { rmSync(join(dir, name), { force: true }); n++; }
  }
  return n;
}

/** Een getal als octaal veld van `width` bytes (met een afsluitende nul); te groot voor octaal: base-256 (GNU, alle gangbare tar's lezen dat). */
function numberField(n: number, width: number): Buffer {
  const out = Buffer.alloc(width);
  const octal = n.toString(8);
  if (octal.length < width) {
    out.write(octal.padStart(width - 1, '0'), 0, 'ascii');
    return out;
  }
  let v = BigInt(n);
  for (let i = width - 1; i > 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  out[0] = 0x80;
  return out;
}

/** De kop van één bestand of map (ustar). Namen zijn kort en ASCII (we maken ze zelf), dus het veld voor het voorvoegsel blijft leeg. */
export function tarHeader(name: string, size: number, mtimeSec: number, type: 'file' | 'dir' = 'file'): Buffer {
  if (!/^[\x21-\x7e]{1,99}$/.test(name)) throw new Error(`ongeldige naam in het archief: ${name}`);
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 'ascii');
  numberField(type === 'dir' ? 0o700 : 0o600, 8).copy(h, 100);
  numberField(0, 8).copy(h, 108); // uid
  numberField(0, 8).copy(h, 116); // gid
  numberField(type === 'dir' ? 0 : size, 12).copy(h, 124);
  numberField(Math.max(0, Math.floor(mtimeSec)), 12).copy(h, 136);
  h.fill(0x20, 148, 156); // de controlesom telt met spaties op haar eigen plek
  h.write(type === 'dir' ? '5' : '0', 156, 'ascii');
  h.write('ustar\u000000', 257, 'ascii');
  h.write('tickory', 265, 'ascii'); // eigenaar en groep als naam: bij uitpakken als gewone gebruiker telt die van wie uitpakt
  h.write('tickory', 297, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\u0000 `, 148, 'ascii');
  return h;
}

const padding = (size: number): Buffer => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Een bestand uit het geheugen als archiefdeel. */
function* bufferEntry(name: string, data: Buffer, mtimeSec: number): Generator<Buffer> {
  yield tarHeader(name, data.length, mtimeSec);
  yield data;
  yield padding(data.length);
}

/**
 * Een bestand van schijf als archiefdeel, in brokken. Eerst openen, dan pas de kop: een bestand dat intussen weg is, wordt
 * zo netjes overgeslagen (dan `false`). Wordt het tijdens het lezen korter (dat doet de server nooit), dan vullen we aan met nullen,
 * zodat het archief zelf heel blijft.
 */
async function* fileEntry(name: string, path: string, state: { ok: boolean }): AsyncGenerator<Buffer> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    state.ok = false;
    return;
  }
  try {
    const { size, mtimeMs } = await fh.stat();
    yield tarHeader(name, size, mtimeMs / 1000);
    let left = size;
    while (left > 0) {
      const buf = Buffer.alloc(Math.min(CHUNK, left));
      const { bytesRead } = await fh.read(buf, 0, buf.length, size - left);
      if (bytesRead === 0) { yield Buffer.alloc(left); break; }
      left -= bytesRead;
      yield bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
    }
    yield padding(size);
    state.ok = true;
  } finally {
    await fh.close();
  }
}

export interface BackupSummary { attachments: number; missing: number; bytes: number }

const README = (date: string) => `Tickory - back-up van ${date}

Dit archief bevat de database (tickory.db) en de bijlagen (attachments/). Het bevat ook de wachtwoord-hashes, de
(gehashte) sessies en de sleutels van de server voor meldingen (VAPID-privesleutel en HMAC-geheim): bewaar het net zo
zorgvuldig als de server zelf. Het sleutelbestand voor tweestapsverificatie (secret.key) zit er bewust niet in.

Terugzetten met Docker (zie de handleiding, "Back-up"):
  1. docker compose stop tickory
  2. mkdir herstel && tar -xf <dit bestand>.tar -C herstel
  3. docker compose run --rm --no-deps -v "$PWD/herstel:/herstel:ro" --entrypoint sh tickory -c \\
       'rm -f /data/todo.db /data/todo.db-wal /data/todo.db-shm && cp /herstel/tickory.db /data/todo.db && rm -rf /data/attachments && cp -R /herstel/attachments /data/attachments'
  4. docker compose start tickory

Tickory - backup of ${date}

This archive holds the database (tickory.db) and the attachments (attachments/). It also holds the password hashes, the
(hashed) sessions and the server's keys for notifications: keep it as carefully as the server itself. The key file for
two-step verification (secret.key) is deliberately not included. To restore it with Docker, follow the steps above
(see the guide, "Backup").
`;

/**
 * Maakt de back-up en levert hem als reeks brokken. `tmpDir` is de map voor de tijdelijke kopie van de database (wordt na
 * afloop altijd verwijderd, ook als de verbinding halverwege wegvalt). `summary` wordt onderweg ingevuld.
 * De kopie gebeurt meteen bij het aanroepen (vóór het eerste brok), zodat een fout nog een gewoon foutantwoord kan worden.
 */
export function createBackupArchive(
  db: Db, opts: { tmpDir: string; attachmentsDir: string | null; schemaVersion: number; now?: Date },
): { chunks: AsyncGenerator<Buffer>; summary: BackupSummary; cleanup: () => void } {
  const now = opts.now ?? new Date();
  const mtime = now.getTime() / 1000;
  const temp = join(opts.tmpDir, `${TEMP_PREFIX}${randomBytes(8).toString('hex')}.db`);
  const cleanup = () => { rmSync(temp, { force: true }); };
  const summary: BackupSummary = { attachments: 0, missing: 0, bytes: 0 };
  let keys: string[] = [];
  try {
    db.prepare('VACUUM INTO ?').run(temp);
    // Welke bestanden bij de kopie horen, volgens de kopie zelf (niet volgens de database die intussen doorloopt).
    const copy = new DatabaseSync(temp, { readOnly: true });
    try {
      keys = (copy.prepare('SELECT f.key FROM attachment_files f JOIN attachments a ON a.id = f.id WHERE f.linked = 1 AND a.is_deleted = 0 ORDER BY f.key').all() as { key: string }[])
        .map((r) => r.key).filter((k) => /^[0-9a-f]{32}$/.test(k)); // alleen sleutels zoals de server ze maakt: nooit een pad
    } finally {
      copy.close();
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  async function* chunks(): AsyncGenerator<Buffer> {
    try {
      const count = (b: Buffer): Buffer => { summary.bytes += b.length; return b; };
      const dbState = { ok: false };
      for await (const b of fileEntry('tickory.db', temp, dbState)) yield count(b);
      if (!dbState.ok) throw new Error('de kopie van de database is weg');
      yield count(tarHeader('attachments/', 0, mtime, 'dir')); // de map staat er altijd, ook zonder bijlagen (dat maakt terugzetten eenvoudiger)
      const dirs = new Set<string>();
      for (const key of opts.attachmentsDir ? keys : []) {
        const sub = key.slice(0, 2);
        if (!dirs.has(sub)) { dirs.add(sub); yield count(tarHeader(`attachments/${sub}/`, 0, mtime, 'dir')); }
        const state = { ok: false };
        for await (const b of fileEntry(`attachments/${sub}/${key}`, join(opts.attachmentsDir!, sub, key), state)) yield count(b);
        if (state.ok) summary.attachments++;
        else summary.missing++; // tussen de kopie en nu verwijderd: overslaan
      }
      if (!opts.attachmentsDir) summary.missing += keys.length;
      const manifest = Buffer.from(`${JSON.stringify({
        format: 'tickory-backup', version: 1, created_at: now.toISOString(), schema_version: opts.schemaVersion,
        database: 'tickory.db', attachments: summary.attachments, attachments_missing: summary.missing,
      }, null, 2)}\n`);
      for (const b of bufferEntry('tickory-backup.json', manifest, mtime)) yield count(b);
      for (const b of bufferEntry('LEESMIJ.txt', Buffer.from(README(now.toISOString().slice(0, 10))), mtime)) yield count(b);
      yield count(Buffer.alloc(2 * BLOCK)); // het einde van het archief
    } finally {
      cleanup();
    }
  }
  return { chunks: chunks(), summary, cleanup };
}

/** Voor tests en controle: leest de bestanden uit een tar-archief (alleen wat createBackupArchive maakt). */
export function readTar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let pos = 0;
  while (pos + BLOCK <= buf.length) {
    const h = buf.subarray(pos, pos + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== parseInt(h.subarray(148, 156).toString('ascii'), 8)) throw new Error(`controlesom klopt niet bij ${name}`);
    const type = String.fromCharCode(h[156]);
    pos += BLOCK;
    if (type === '0') out.set(name, buf.subarray(pos, pos + size));
    pos += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}
