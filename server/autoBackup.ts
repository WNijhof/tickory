// Automatische back-ups: de server maakt zelf elke dag één kopie van de database (en de bijlagen), zonder cron.
//
//   BACKUP_DIR   de map voor de kopieën (in Docker bijvoorbeeld /data/backups); zonder deze instelling staat het uit
//   BACKUP_TIME  wanneer, als HH:MM (standaard 03:00), in DEFAULT_TIMEZONE als die is ingesteld, anders in de tijd van de server
//   BACKUP_KEEP  hoeveel dagelijkse kopieën blijven staan (standaard 14, 1 t/m 3650); oudere ruimt de server zelf op
//
// Een kopie heet `todo-YYYY-MM-DD.db` (de bijlagen in `todo-YYYY-MM-DD.attachments/`), net als met `node server/backup.ts`. De server
// kijkt elke paar minuten of de kopie van vandaag er al is; stond hij op het tijdstip uit, dan maakt hij haar alsnog zodra hij weer
// draait. Opruimen raakt alleen bestanden met precies die naam: wat je er zelf neerzet, blijft staan. Elke kopie krijgt een eigen
// epoch (backup.ts), dus wie haar terugzet laat alle apparaten vanzelf opnieuw beginnen.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backupToAsync } from './backup.ts';

export interface AutoBackupConfig { dir: string; time: string; keep: number; timeZone: string | null }

export interface AutoBackupStatus {
  enabled: boolean;
  dir?: string;
  time?: string;
  keep?: number;
  /** De nieuwste kopie in de map: de naam en wanneer ze gemaakt is (ISO). */
  last?: { name: string; at: string } | null;
  /** De laatste mislukte poging sinds de server draait (melding en ISO-tijdstip), of null. */
  error?: { message: string; at: string } | null;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NAME = /^todo-(\d{4}-\d{2}-\d{2})\.db$/;
const DIR_NAME = /^todo-(\d{4}-\d{2}-\d{2})\.attachments$/;

/** De instellingen uit de omgeving; null als BACKUP_DIR ontbreekt (uit). Een ongeldige waarde is een fout met uitleg. */
export function autoBackupConfig(env: Record<string, string | undefined>): AutoBackupConfig | null {
  const dir = (env.BACKUP_DIR ?? '').trim();
  if (!dir) return null;
  const time = (env.BACKUP_TIME ?? '03:00').trim();
  if (!TIME.test(time)) throw new Error(`BACKUP_TIME moet een tijdstip zijn als 03:00, niet "${time}"`);
  const keepText = (env.BACKUP_KEEP ?? '14').trim();
  const keep = Number(keepText);
  if (!/^\d+$/.test(keepText) || keep < 1 || keep > 3650) throw new Error(`BACKUP_KEEP moet een aantal dagen zijn van 1 tot en met 3650, niet "${keepText}"`);
  const timeZone = (env.DEFAULT_TIMEZONE ?? '').trim() || null;
  if (timeZone) new Intl.DateTimeFormat('en-US', { timeZone }); // een onbekende tijdzone geeft hier al een fout
  return { dir: resolve(dir), time, keep, timeZone };
}

/** De lokale datum (YYYY-MM-DD) en tijd (HH:MM) van een moment, in een tijdzone of die van de server. */
function localParts(ms: number, timeZone: string | null): { day: string; time: string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * @param opts.dbPath de database (die mag open zijn: backupTo maakt een consistente kopie terwijl de server draait)
 * @param opts.attachmentsDir de map met bijlagen, of null
 * @param opts.now de klok (voor tests)
 */
export function createAutoBackup(config: AutoBackupConfig, opts: { dbPath: string; attachmentsDir: string | null; now?: () => number; log?: (line: string) => void }) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));
  let lastError: { message: string; at: string } | null = null;
  let running = false;

  const copies = (): string[] => {
    if (!existsSync(config.dir)) return [];
    return readdirSync(config.dir).filter((n) => NAME.test(n)).sort();
  };

  /** Haalt de oudste kopieën weg tot er `keep` over zijn, met hun map met bijlagen; en mappen met bijlagen zonder kopie. */
  function prune(): void {
    const all = copies();
    const keepDays = new Set(all.slice(-config.keep).map((n) => NAME.exec(n)![1]));
    for (const name of all) {
      const day = NAME.exec(name)![1];
      if (keepDays.has(day)) continue;
      rmSync(join(config.dir, name), { force: true });
      log(`automatische back-up: ${name} opgeruimd (er blijven er ${config.keep})`);
    }
    for (const name of readdirSync(config.dir).filter((n) => DIR_NAME.test(n))) {
      if (!keepDays.has(DIR_NAME.exec(name)![1])) rmSync(join(config.dir, name), { recursive: true, force: true });
    }
  }

  /**
   * Maakt de kopie van vandaag als het tijdstip voorbij is en ze er nog niet is, en ruimt daarna op.
   * @returns de naam van de nieuwe kopie, of null als er niets te doen was (of het mislukte; zie status().error)
   */
  async function tick(): Promise<string | null> {
    if (running) return null;
    const { day, time } = localParts(now(), config.timeZone);
    if (time < config.time) return null;
    const name = `todo-${day}.db`;
    if (existsSync(join(config.dir, name))) return null;
    running = true;
    try {
      mkdirSync(config.dir, { recursive: true });
      // een map met bijlagen van een eerder mislukte poging vandaag (zonder database): weg, anders weigert backupTo
      rmSync(join(config.dir, `todo-${day}.attachments`), { recursive: true, force: true });
      const report = await backupToAsync(opts.dbPath, join(config.dir, name), opts.attachmentsDir); // de server blijft intussen antwoorden
      log(`automatische back-up: ${name} gemaakt${opts.attachmentsDir ? ` (${report.files} bijlagen${report.missing ? `, ${report.missing} ontbraken` : ''})` : ''}`);
      lastError = null;
      prune();
      return name;
    } catch (err) {
      lastError = { message: (err as Error).message, at: new Date(now()).toISOString() };
      console.error(`automatische back-up mislukt: ${(err as Error).message}`);
      // een half gemaakte kopie mag de volgende poging niet tegenhouden
      try {
        rmSync(join(config.dir, name), { force: true });
        rmSync(join(config.dir, `todo-${day}.attachments`), { recursive: true, force: true });
      } catch { /* niets aan te doen */ }
      return null;
    } finally {
      running = false;
    }
  }

  function status(): AutoBackupStatus {
    const newest = copies().at(-1) ?? null;
    let last: AutoBackupStatus['last'] = null;
    if (newest) {
      try { last = { name: newest, at: statSync(join(config.dir, newest)).mtime.toISOString() }; } catch { last = null; }
    }
    return { enabled: true, dir: config.dir, time: config.time, keep: config.keep, last, error: lastError };
  }

  return { tick, status, prune };
}

export type AutoBackup = ReturnType<typeof createAutoBackup>;
