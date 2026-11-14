// Bouwt de browserextensie "Pagina als taak opslaan" (extension/) zonder bibliotheken en zonder bundler:
//   dist/extension/chrome/                      uitgepakt, voor Chrome en Edge (ontwikkelaarsmodus: "Uitgepakte extensie laden")
//   dist/extension/firefox/                     uitgepakt, voor Firefox (about:debugging: "Tijdelijke add-on laden")
//   dist/tickory-extension-<versie>.zip         voor de Chrome Web Store en Edge Add-ons
//   dist/tickory-extension-<versie>-firefox.zip voor addons.mozilla.org
//
// Gebruik: node scripts/build-extension.ts
//
// Wat er gebeurt:
// - De versie komt uit package.json (zoals de Android-app en de image).
// - De snelle invoer van de web-app (client/core/quickadd.js) gaat ongewijzigd mee: dit script volgt de imports vanaf quickadd.js
//   en kopieert die bestanden met hun eigen mappen naar lib/ (lib/client/core/…, lib/shared/…), zodat de relatieve imports gewoon
//   werken als ES-modules in de extensie. Geen inline scripts en geen eval: de strenge CSP van extensies blijft heel.
// - De pictogrammen tekent scripts/make-icons.js (hetzelfde beeldmerk als de app) in 16, 32, 48 en 128 punten.
// - Firefox krijgt een eigen manifest: een achtergrondscript in plaats van een service worker, en browser_specific_settings met een
//   neutrale id (geen naam van een persoon) en de opgave welke gegevens de extensie verstuurt (alleen naar de eigen server).
// - Een zip met vaste volgorde en vaste tijd (1 januari 1980, de nul van het zip-formaat): dezelfde bron geeft dezelfde zip.

import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORNER, icon, png } from './make-icons.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = join(ROOT, 'extension');
/** De id voor Firefox: neutraal (.invalid is een gereserveerd domein dat nooit bestaat); wijzig hem niet na de eerste publicatie. */
export const GECKO_ID = 'tickory@tickory.invalid';
/** Wat de extensie naar de eigen server stuurt (Firefox vraagt dit bij nieuwe extensies): adres en titel, de selectie, het inloggen. */
export const FIREFOX_DATA = ['browsingActivity', 'websiteContent', 'authenticationInfo'];
export const ICON_SIZES = [16, 32, 48, 128];
/** Het begin van de snelle invoer; alles wat het importeert, gaat mee. */
const QUICK_ADD = 'client/core/quickadd.js';

export type Files = Map<string, Buffer>;

/** De bestanden van extension/ zelf, zonder tests en zonder uitleg voor ontwikkelaars. */
export function sourceFiles(dir = SOURCE): Files {
  const out: Files = new Map();
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (!/\.test\.[jt]s$/.test(name) && name !== 'README.md' && name !== 'manifest.json') out.set(relative(dir, full).split(sep).join('/'), readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

/** De relatieve imports van een ES-module (statisch: `import … from '…'`, `import '…'` en `export … from '…'`). */
export function importsOf(code: string): string[] {
  const found = new Set<string>();
  for (const m of code.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm)) found.add(m[1] ?? m[2]);
  return [...found];
}

/**
 * quickadd.js en alles wat het (via relatieve imports) nodig heeft, met het pad vanaf de hoofdmap van de repo. Alleen bestanden uit
 * client/ en shared/; een import van buiten (een pakket, of een pad buiten de repo) laat de bouw mislukken.
 */
export function quickAddFiles(root = ROOT, entry = QUICK_ADD): Files {
  const out: Files = new Map();
  const queue = [entry];
  while (queue.length) {
    const path = queue.shift()!;
    if (out.has(path)) continue;
    if (!/^(client|shared)\/[\w./-]+\.js$/.test(path) || path.split('/').includes('..')) throw new Error(`de snelle invoer importeert iets buiten client/ en shared/: ${path}`);
    const code = readFileSync(join(root, path));
    out.set(path, code);
    for (const spec of importsOf(code.toString('utf8'))) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) throw new Error(`${path} importeert een pakket (${spec}); de extensie heeft geen bundler`);
      queue.push(posix.normalize(posix.join(posix.dirname(path), spec)));
    }
  }
  return out;
}

/** De pictogrammen: het beeldmerk van de app; op 16 punten zonder de uurstreepjes (die worden daar een vlek). */
export function iconFiles(): Files {
  return new Map(ICON_SIZES.map((size) => [`icons/icon-${size}.png`, png(size, icon({ radius: CORNER, ticks: size >= 32 }))]));
}

/** De twee manifesten uit extension/manifest.json: Chrome en Edge, en Firefox. */
export function manifests(base: Record<string, any>, version: string): { chrome: Record<string, any>; firefox: Record<string, any> } {
  const chrome = { ...base, version };
  const { minimum_chrome_version: _chromeOnly, background, ...rest } = chrome;
  const firefox = {
    ...rest,
    background: { scripts: [background.service_worker] },
    browser_specific_settings: {
      gecko: { id: GECKO_ID, strict_min_version: '140.0', data_collection_permissions: { required: FIREFOX_DATA } },
    },
  };
  return { chrome, firefox };
}

// ---------- zip, zelf geschreven (PKWARE APPNOTE: lokale koppen, centrale map, eindrecord; deflate uit node:zlib) ----------

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

/** Een zip met de bestanden in vaste volgorde. Een bestand dat met deflate niet kleiner wordt, gaat ongecomprimeerd (methode 0). */
export function zip(files: Files): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name)!;
    const packed = deflateRawSync(data, { level: 9 });
    const method = packed.length < data.length ? 8 : 0;
    const body = method === 8 ? packed : data;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // nodig: versie 2.0
    local.writeUInt16LE(0x0800, 6); // namen in UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4); // gemaakt op Unix (3), versie 2.0: dan gelden de bestandsrechten hieronder
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // een gewoon bestand, rw-r--r--
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** Alles voor één browser: de eigen bestanden, de snelle invoer in lib/, de pictogrammen en het manifest. */
export function bundle(manifest: Record<string, any>): Files {
  const files: Files = new Map([...sourceFiles(), ...iconFiles()]);
  for (const [path, data] of quickAddFiles()) files.set(`lib/${path}`, data);
  // de licentie van Tickory, en die van chrono-node in de meegebundelde datumherkenner (MIT vraagt de kennisgeving bij elke kopie)
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) files.set(name, readFileSync(join(ROOT, name)));
  files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return files;
}

function writeDir(dir: string, files: Files): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [name, data] of files) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
}

export function version(): string {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

/**
 * Bouwt alles in `outDir` (standaard dist/). `testHosts`: alleen voor de e2e-test (scripts/e2e-extension.ts) een extra uitgepakte map
 * chrome-test/ met een vaste toestemming voor die hosts, omdat een browser zonder venster de toestemmingsvraag niet kan tonen.
 */
export function build(outDir = join(ROOT, 'dist'), { testHosts = [] as string[] } = {}) {
  const v = version();
  const base = JSON.parse(readFileSync(join(SOURCE, 'manifest.json'), 'utf8'));
  const { chrome, firefox } = manifests(base, v);
  const chromeFiles = bundle(chrome);
  const firefoxFiles = bundle(firefox);
  writeDir(join(outDir, 'extension', 'chrome'), chromeFiles);
  writeDir(join(outDir, 'extension', 'firefox'), firefoxFiles);
  const chromeZip = join(outDir, `tickory-extension-${v}.zip`);
  const firefoxZip = join(outDir, `tickory-extension-${v}-firefox.zip`);
  writeFileSync(chromeZip, zip(chromeFiles));
  writeFileSync(firefoxZip, zip(firefoxFiles));
  let testDir: string | null = null;
  if (testHosts.length) {
    testDir = join(outDir, 'extension', 'chrome-test');
    writeDir(testDir, bundle({ ...chrome, host_permissions: testHosts }));
  }
  return { version: v, chromeDir: join(outDir, 'extension', 'chrome'), firefoxDir: join(outDir, 'extension', 'firefox'), chromeZip, firefoxZip, testDir, files: chromeFiles.size };
}

if (import.meta.main) {
  const out = build();
  const size = (p: string) => `${(statSync(p).size / 1024).toFixed(0)} KB`;
  console.log(`browserextensie ${out.version}: ${out.files} bestanden`);
  console.log(`  ${relative(ROOT, out.chromeZip)} (${size(out.chromeZip)})   uitgepakt: ${relative(ROOT, out.chromeDir)}`);
  console.log(`  ${relative(ROOT, out.firefoxZip)} (${size(out.firefoxZip)})   uitgepakt: ${relative(ROOT, out.firefoxDir)}`);
}
