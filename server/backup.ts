// Maakt een consistente kopie van de database, ook terwijl de server draait.
//
//   node server/backup.ts <doelbestand.db>
//
// De bron is DB_PATH (standaard ./data/todo.db). In Docker:
//   docker compose exec -T tickory node server/backup.ts /data/backups/todo-$(date +%F).db
//
// Een gewone bestandskopie van een SQLite-database in WAL-modus kan onvolledig zijn; VACUUM INTO maakt in één
// leesbewerking een compleet, consistent bestand. Een bestaand doelbestand wordt nooit overschreven.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function backupTo(sourcePath: string, destPath: string): void {
  const source = resolve(sourcePath);
  const dest = resolve(destPath);
  if (!existsSync(source)) throw new Error(`database niet gevonden: ${source}`);
  if (existsSync(dest)) throw new Error(`doelbestand bestaat al (wordt niet overschreven): ${dest}`);
  if (!dest.endsWith('.db')) throw new Error('geef een doelbestand dat op .db eindigt');
  mkdirSync(dirname(dest), { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(dest);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const dest = process.argv[2];
  if (!dest) {
    console.error('Gebruik: node server/backup.ts <doelbestand.db>');
    process.exit(2);
  }
  try {
    backupTo(process.env.DB_PATH ?? './data/todo.db', dest);
    console.log(`Back-up gemaakt: ${resolve(dest)}`);
  } catch (err) {
    console.error(`Back-up mislukt: ${(err as Error).message}`);
    process.exit(1);
  }
}
