// Maakt een consistente kopie van de database, ook terwijl de server draait.
//
//   node server/backup.ts <doelbestand.db>
//
// De bron is DB_PATH (standaard ./data/todo.db). In Docker:
//   docker compose exec -T tickory node server/backup.ts /data/backups/todo-$(date +%F).db
//
// De bijlagen (bestanden bij taken) staan niet in de database maar in een map ernaast (ATTACHMENTS_DIR, standaard `attachments`
// naast de database). Bestaat die map, dan komt een kopie van de bestanden bij de bijlagen die in de kopie van de database staan
// in `<doelbestand zonder .db>.attachments/`, zodat database en bestanden bij elkaar horen. Bestanden die tussen de twee stappen
// zijn verwijderd, worden overgeslagen en gemeld.
//
// Een gewone bestandskopie van een SQLite-database in WAL-modus kan onvolledig zijn; VACUUM INTO maakt in één
// leesbewerking een compleet, consistent bestand. Een bestaand doelbestand wordt nooit overschreven.

import { DatabaseSync } from 'node:sqlite';
import { liveFileKeysSql } from './backupArchive.ts';
import { renewEpoch } from './rows.ts';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { copyFile, mkdir, stat } from 'node:fs/promises';

export interface BackupReport { files: number; bytes: number; missing: number }

/** Waar de bijlagen van een database staan: ATTACHMENTS_DIR, anders de map `attachments` naast de database. */
export function attachmentsDirFor(dbPath: string, env: Record<string, string | undefined> = process.env): string {
  return resolve(env.ATTACHMENTS_DIR || join(dirname(resolve(dbPath)), 'attachments'));
}

/** De database kopiëren (VACUUM INTO, met een nieuwe epoch) en zeggen welke bestanden van bijlagen erbij horen. */
function copyDatabase(sourcePath: string, destPath: string, attachmentsDir: string | null): { filesDest: string | null; keys: string[] } {
  const source = resolve(sourcePath);
  const dest = resolve(destPath);
  if (!existsSync(source)) throw new Error(`database niet gevonden: ${source}`);
  if (existsSync(dest)) throw new Error(`doelbestand bestaat al (wordt niet overschreven): ${dest}`);
  if (!dest.endsWith('.db')) throw new Error('geef een doelbestand dat op .db eindigt');
  mkdirSync(dirname(dest), { recursive: true });
  const filesDest = `${dest.slice(0, -3)}.attachments`;
  const withFiles = attachmentsDir !== null && existsSync(attachmentsDir);
  if (withFiles && existsSync(filesDest)) throw new Error(`de map voor bijlagen bestaat al (wordt niet overschreven): ${filesDest}`);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(dest);
  } finally {
    db.close();
  }
  // een nieuwe epoch in de kopie: zet iemand haar terug, dan beginnen alle apparaten opnieuw (zie epochOf in rows.ts)
  const fresh = new DatabaseSync(dest);
  try { renewEpoch(fresh); } finally { fresh.close(); }
  if (!withFiles) return { filesDest: null, keys: [] };
  // Welke bestanden bij de kopie horen, volgens de kopie zelf (niet volgens de database die intussen is doorgelopen).
  const copy = new DatabaseSync(dest, { readOnly: true });
  let keys: string[] = [];
  try {
    keys = (copy.prepare(liveFileKeysSql(copy)).all() as { key: string }[]).map((r) => r.key);
  } catch { /* een database van vóór de bijlagen heeft deze tabellen niet */ } finally {
    copy.close();
  }
  mkdirSync(filesDest, { recursive: true });
  return { filesDest, keys: keys.filter((key) => /^[0-9a-f]{32}$/.test(key)) }; // alleen sleutels zoals de server ze maakt
}

export function backupTo(sourcePath: string, destPath: string, attachmentsDir: string | null = null): BackupReport {
  const { filesDest, keys } = copyDatabase(sourcePath, destPath, attachmentsDir);
  const report: BackupReport = { files: 0, bytes: 0, missing: 0 };
  if (!filesDest) return report;
  for (const key of keys) {
    const from = join(attachmentsDir!, key.slice(0, 2), key);
    if (!existsSync(from)) { report.missing += 1; continue; }
    mkdirSync(join(filesDest, key.slice(0, 2)), { recursive: true });
    copyFileSync(from, join(filesDest, key.slice(0, 2), key));
    report.files += 1;
    report.bytes += statSync(from).size;
  }
  return report;
}

/**
 * Hetzelfde als backupTo, maar de bestanden van de bijlagen gaan asynchroon over, één voor één: zo blijft een draaiende server
 * verzoeken beantwoorden terwijl de automatische back-up gigabytes aan bijlagen kopieert (de kopie van de database zelf, VACUUM
 * INTO, is één korte stap).
 */
export async function backupToAsync(sourcePath: string, destPath: string, attachmentsDir: string | null = null): Promise<BackupReport> {
  const { filesDest, keys } = copyDatabase(sourcePath, destPath, attachmentsDir);
  const report: BackupReport = { files: 0, bytes: 0, missing: 0 };
  if (!filesDest) return report;
  for (const key of keys) {
    const from = join(attachmentsDir!, key.slice(0, 2), key);
    let size: number;
    try {
      size = (await stat(from)).size;
    } catch {
      report.missing += 1;
      continue;
    }
    await mkdir(join(filesDest, key.slice(0, 2)), { recursive: true });
    await copyFile(from, join(filesDest, key.slice(0, 2), key));
    report.files += 1;
    report.bytes += size;
  }
  return report;
}

if (import.meta.main) {
  const dest = process.argv[2];
  if (!dest) {
    console.error('Gebruik: node server/backup.ts <doelbestand.db>');
    process.exit(2);
  }
  try {
    const dbPath = process.env.DB_PATH ?? './data/todo.db';
    const report = backupTo(dbPath, dest, attachmentsDirFor(dbPath));
    console.log(`Back-up gemaakt: ${resolve(dest)}`);
    if (report.files > 0 || report.missing > 0) {
      console.log(`Bijlagen: ${report.files} bestand(en), ${(report.bytes / 1_000_000).toFixed(1)} MB, in ${resolve(dest).slice(0, -3)}.attachments${report.missing ? `; ${report.missing} bestand(en) ontbraken en zijn overgeslagen` : ''}`);
    }
  } catch (err) {
    console.error(`Back-up mislukt: ${(err as Error).message}`);
    process.exit(1);
  }
}
