// Controleert de gebouwde website (_site/) en de demo. Eindigt met code 1 zodra iets niet klopt.
//
// Gebruik: node scripts/build-site.ts && node scripts/site-check.ts [--only bestanden|demo|browser]
//
//   bestanden  alle interne links, ankers en afbeeldingen; geen absolute paden en geen bronnen van buiten; elke pagina in
//              twee talen; de datumvoorbeelden uit de handleiding tegen de echte datumherkenner; pictogrammen en afbeeldingen
//   demo       de "server in de browser" van de demo: het sync-protocol, en dezelfde uitkomsten en foutmeldingen als de
//              echte server (server/sync.ts) voor een reeks commando's; zoeken, filters en labels tegen de voorbeeldgegevens,
//              met de filtervoorbeelden uit de handleiding
//   browser    de site wordt lokaal geserveerd onder /tickory/ en in een browser zonder venster geopend: de demo start
//              zonder inlogscherm en werkt (toevoegen, afvinken, bewerken, delen), geen fouten in de console, geen
//              verzoeken naar /api/ of naar andere herkomsten; elke pagina laadt, past op een telefoon, de zoekfunctie werkt
//
// Poorten: SITE_PORT (8794) en SITE_CDP_PORT (9344). Zonder browser: SITE_CHECK_BROWSER=0 slaat dat deel over (en meldt het).

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { composeExample, listFiles, pngSize } from './build-site.ts';
import { startSiteServer } from './serve-site.ts';
import { findBrowser, js, launchBrowser, sleep } from './site-browser.ts';
import type { Browser } from './site-browser.ts';
import { CORNER, icon, rasterize } from './make-icons.js';
import { parseDateText, parseDue } from '../client/core/dateNl.js';
import { parseQuickAdd } from '../client/core/quickadd.js';
import { describeCommandError } from '../client/core/messages.js';
import { handleSync } from '../server/sync.ts';
import { addUser, freshDb } from '../server/testutil.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SITE = join(ROOT, '_site');
// Het pad waaronder de site komt te staan; hetzelfde als waarmee ze gebouwd is (zie scripts/build-site.ts).
const BASE = process.env.SITE_BASE ?? '/tickory/';
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const wants = (part: string) => !only || only === part;

if (!existsSync(join(SITE, only === 'demo' ? 'demo/index.html' : 'index.html'))) {
  console.error('Geen gebouwde website gevonden. Draai eerst: node scripts/build-site.ts');
  process.exit(1);
}

// ---------- kleine testopzet: elke controle heeft een naam; een mislukte controle stopt de rest niet ----------

const failures: string[] = [];
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`✔ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`✖ ${name}\n    ${String((err as Error).message ?? err).split('\n').join('\n    ')}`);
  }
}
const read = (path: string): string => readFileSync(join(SITE, ...path.split('/')), 'utf8');
const siteFiles = listFiles(SITE);
const htmlPages = siteFiles.filter((f) => f.endsWith('.html'));

// ====================================================================================================================
// 1. Bestanden
// ====================================================================================================================

/** De waarden van href, src en srcset in een stuk HTML, met het element erbij. */
function references(html: string): { tag: string; attr: string; value: string; rel: string }[] {
  const out = [];
  for (const m of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const rel = /\srel="([^"]*)"/i.exec(m[2])?.[1] ?? '';
    for (const a of m[2].matchAll(/\s(href|src|srcset|content)="([^"]*)"/gi)) {
      if (a[1].toLowerCase() === 'content') continue; // meta-waarden zijn geen verwijzingen die de browser ophaalt
      for (const value of a[1].toLowerCase() === 'srcset' ? a[2].split(',').map((s) => s.trim().split(/\s+/)[0]) : [a[2]]) {
        out.push({ tag: m[1].toLowerCase(), attr: a[1].toLowerCase(), value, rel });
      }
    }
  }
  return out;
}
const ids = (html: string): Set<string> => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

/** Zoekt het bestand waar een relatieve verwijzing vanaf `page` naar wijst; een map betekent haar index.html. */
function resolveLink(page: string, value: string): { file: string | null; hash: string } {
  const [pathAndQuery, hash = ''] = value.split('#');
  const path = pathAndQuery.split('?')[0];
  if (path === '') return { file: page, hash };
  let target = posix.normalize(posix.join(posix.dirname(page), path));
  if (target.startsWith('..')) return { file: null, hash };
  if (target.endsWith('/') || target === '.') target = posix.join(target, 'index.html');
  else if (existsSync(join(SITE, ...target.split('/'))) && statSync(join(SITE, ...target.split('/'))).isDirectory()) return { file: null, hash }; // map zonder streep: GitHub verwijst door, maar wij linken altijd met streep
  return { file: siteFiles.includes(target) ? target : null, hash };
}

if (wants('bestanden')) {
  await check('links, ankers en afbeeldingen: alles wat een pagina noemt bestaat, relatief en van de eigen site', () => {
    const problems: string[] = [];
    const idsOf = new Map<string, Set<string>>();
    for (const page of htmlPages) idsOf.set(page, ids(read(page)));
    let links = 0;
    for (const page of htmlPages) {
      const is404 = page === '404.html'; // staat op elk onbekend adres en gebruikt daarom het voorvoegsel /tickory/
      for (const ref of references(read(page))) {
        const v = ref.value;
        links += 1;
        if (/^(mailto:|tel:)/i.test(v)) { problems.push(`${page}: ${v} (geen e-mail- of telefoonlinks)`); continue; }
        if (/^(https?:)?\/\//i.test(v)) {
          // Naar buiten linken mag (GitHub, Tailscale), maar alleen als gewone link of als metagegeven: nooit iets laden.
          const loads = ref.tag !== 'a' && !(ref.tag === 'link' && /^(canonical|alternate)$/.test(ref.rel));
          if (loads) problems.push(`${page}: <${ref.tag} ${ref.attr}="${v}"> laadt iets van een andere herkomst`);
          else if (!v.startsWith('https://')) problems.push(`${page}: ${v} (externe links alleen via https)`);
          continue;
        }
        if (/^data:/i.test(v)) continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(v)) { problems.push(`${page}: onverwacht soort adres ${v}`); continue; }
        let value = v;
        if (v.startsWith('/')) {
          if (!is404 || !v.startsWith(BASE)) { problems.push(`${page}: absoluut pad ${v} (werkt niet onder ${BASE})`); continue; }
          value = posix.relative(posix.dirname(`/${page}`), v.slice(BASE.length - 1)) || './';
          if (v.endsWith('/') && !value.endsWith('/')) value += '/';
        }
        const { file, hash } = resolveLink(page, value);
        if (!file) { problems.push(`${page}: ${v} bestaat niet`); continue; }
        if (hash && file.endsWith('.html') && !idsOf.get(file)!.has(decodeURIComponent(hash))) problems.push(`${page}: ${v} (het anker #${hash} bestaat niet in ${file})`);
      }
    }
    // stijlbladen: url(...) moet ook relatief en aanwezig zijn
    for (const css of siteFiles.filter((f) => f.endsWith('.css'))) {
      for (const m of read(css).matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        if (/^data:/.test(m[1])) continue;
        if (/^([a-z]+:)?\/\//i.test(m[1]) || m[1].startsWith('/') || !resolveLink(css, m[1]).file) problems.push(`${css}: url(${m[1]})`);
      }
      if (/@import/.test(read(css))) problems.push(`${css}: @import (alles hoort in één bestand of via een link in de pagina)`);
    }
    assert.deepEqual(problems, [], `${problems.length} probleem/problemen:\n${problems.join('\n')}`);
    assert.ok(links > 300, `verwacht honderden verwijzingen, vond er ${links} (zoekt de controle nog wel?)`);
  });

  await check('scripts: elke import verwijst naar een bestand in de site; nergens een adres van buiten of een aanroep van /api/', () => {
    const problems: string[] = [];
    const scripts = siteFiles.filter((f) => f.endsWith('.js'));
    for (const file of scripts) {
      const code = read(file);
      for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (!spec.startsWith('.')) problems.push(`${file}: import van "${spec}" is niet relatief`);
        else if (!resolveLink(file, spec).file) problems.push(`${file}: import van "${spec}" bestaat niet in de site`);
      }
    }
    // De demo mag de bestanden met netwerkcode van de app bevatten (auth.js, events.js, syncClient.js), maar het ene
    // bestand dat ze aan elkaar knoopt (backend.js) is vervangen: de demo-versie roept geen fetch aan.
    const backend = read('demo/core/backend.js');
    if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(backend)) problems.push('demo/core/backend.js gebruikt het netwerk');
    if (!/demo:\s*true/.test(backend)) problems.push('demo/core/backend.js is niet de demo-versie');
    for (const file of ['demo/sw.js', 'demo/manifest.webmanifest']) if (siteFiles.includes(file)) problems.push(`${file} hoort niet in de demo`);
    if (siteFiles.some((f) => f.endsWith('.test.js') || f.endsWith('.ts'))) problems.push('er staan test- of TypeScript-bestanden in de site');
    // de eigen scripts van de website: geen enkel adres van buiten
    for (const file of scripts.filter((f) => f.startsWith('assets/') || f === 'demo/demo.js')) {
      if (/https?:\/\//.test(read(file).replace(/\/\/[^\n]*/g, ''))) problems.push(`${file}: bevat een adres van buiten`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(scripts.length >= 20, `verwacht de scripts van de app en de site, vond er ${scripts.length}`);
  });

  await check('de demo-pagina: relatieve paden, geen manifest, de balk met de afgesproken tekst en een link terug', () => {
    const html = read('demo/index.html');
    assert.ok(!/\b(?:href|src)="\//.test(html), 'er staat een absoluut pad in demo/index.html');
    assert.ok(!/rel="manifest"/.test(html), 'de demo hoort geen manifest te hebben');
    assert.match(html, /Dit is een demo: wijzigingen worden niet bewaard\./);
    assert.match(html, /<a class="demo-bar-link" href="\.\.\/">/);
    assert.match(html, /connect-src 'none'/, 'de pagina zelf verbiedt elk netwerkverzoek van scripts');
    assert.ok(html.indexOf('src="demo.js"') < html.indexOf('src="ui/app.js"'), 'demo.js hoort vóór de app te staan');
    // de app zelf is ongewijzigd overgenomen (op backend.js na)
    for (const file of listFiles(join(ROOT, 'client')).filter((f) => !f.endsWith('.test.js') && !['sw.js', 'manifest.webmanifest', 'index.html', 'core/backend.js'].includes(f))) {
      assert.ok(readFileSync(join(ROOT, 'client', ...file.split('/'))).equals(readFileSync(join(SITE, 'demo', ...file.split('/')))), `demo/${file} wijkt af van client/${file}`);
    }
  });

  await check('elke pagina: taal, titel, beschrijving, precies één h1, afbeeldingen met beschrijving en afmetingen', () => {
    const problems: string[] = [];
    const titles = new Map<string, string>();
    for (const page of htmlPages.filter((p) => p !== 'demo/index.html')) {
      const html = read(page);
      const lang = /<html lang="([a-z]{2})">/.exec(html)?.[1];
      if (!lang) problems.push(`${page}: geen <html lang>`);
      if (/^(nl|en)\//.test(page) && lang !== page.slice(0, 2)) problems.push(`${page}: taal van de pagina is ${lang}`);
      const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? '';
      if (!title) problems.push(`${page}: geen titel`);
      // binnen één taal heeft elke pagina een eigen titel ("HTTPS" heet in beide talen hetzelfde, dat mag)
      const titleKey = `${lang}: ${title}`;
      if (titles.has(titleKey)) problems.push(`${page}: dezelfde titel als ${titles.get(titleKey)} ("${title}")`);
      titles.set(titleKey, page);
      if (page !== '404.html' && !/<meta name="description" content="[^"]{40,}">/.test(html)) problems.push(`${page}: geen (of een te korte) beschrijving`);
      const h1 = [...html.matchAll(/<h1[\s>]/g)].length;
      if (h1 !== 1) problems.push(`${page}: ${h1} keer een h1`);
      for (const img of html.matchAll(/<img\b([^>]*)>/g)) {
        if (!/\salt="/.test(img[1])) problems.push(`${page}: afbeelding zonder alt`);
        if (!/\swidth="\d+"/.test(img[1]) || !/\sheight="\d+"/.test(img[1])) problems.push(`${page}: afbeelding zonder breedte en hoogte`);
      }
      if (/\sstyle="|<style[\s>]|<script(?![^>]*\ssrc=)/i.test(html)) problems.push(`${page}: inline stijl of script (de pagina staat alleen eigen bestanden toe)`);
      if (/\{\{|<x-[a-z]/.test(html)) problems.push(`${page}: een plaatshouder is niet ingevuld`);
      // koppen slaan geen niveau over
      let last = 0;
      for (const h of html.matchAll(/<h([1-6])[\s>]/g)) {
        const level = Number(h[1]);
        if (last && level > last + 1) problems.push(`${page}: kop h${level} volgt op h${last}`);
        last = level;
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await check('twee talen: elke Nederlandse pagina heeft een Engelse tegenhanger, en ze verwijzen naar elkaar', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'website', 'site.json'), 'utf8'));
    const pairs: { nl: string; en: string }[] = [config.home, ...config.guide.flatMap((g: any) => g.pages)];
    assert.ok(pairs.length >= 18, `verwacht minstens 18 pagina's per taal, vond er ${pairs.length}`);
    for (const pair of pairs) {
      for (const [lang, alt] of [['nl', 'en'], ['en', 'nl']] as const) {
        const page = `${lang}/${pair[lang]}`;
        assert.ok(siteFiles.includes(page), `${page} ontbreekt`);
        const link = /<a class="lang-switch" href="([^"]+)"/.exec(read(page))?.[1];
        assert.ok(link, `${page}: geen taalwissel`);
        assert.equal(resolveLink(page, link).file, `${alt}/${pair[alt]}`, `${page}: de taalwissel wijst naar ${link}`);
      }
    }
    // dezelfde opbouw in beide talen: evenveel koppen, codeblokken en schermafbeeldingen (een vergeten alinea valt zo op)
    for (const pair of pairs) {
      const count = (html: string) => ({
        h2: [...html.matchAll(/<h2[\s>]/g)].length, h3: [...html.matchAll(/<h3[\s>]/g)].length,
        pre: [...html.matchAll(/<pre>/g)].length, figure: [...html.matchAll(/<figure/g)].length, tr: [...html.matchAll(/<tr>/g)].length,
      });
      assert.deepEqual(count(read(`en/${pair.en}`)), count(read(`nl/${pair.nl}`)), `nl/${pair.nl} en en/${pair.en} hebben niet dezelfde opbouw`);
    }
  });

  await check('zoekindex: per taal, met een item voor elke pagina van de handleiding, en elk adres bestaat', () => {
    for (const lang of ['nl', 'en']) {
      const entries = JSON.parse(read(`assets/search-${lang}.json`)) as { u: string; p: string; h: string; x: string }[];
      assert.ok(entries.length > 60, `${lang}: slechts ${entries.length} items`);
      const guidePages = htmlPages.filter((p) => p.startsWith(`${lang}/`) && p.split('/').length === 3);
      for (const page of guidePages) assert.ok(entries.some((e) => `${lang}/${e.u.split('#')[0]}` === page), `${page} staat niet in de zoekindex`);
      for (const e of entries) {
        const { file, hash } = resolveLink(`${lang}/index.html`, e.u);
        assert.ok(file, `zoekindex ${lang}: ${e.u} bestaat niet`);
        if (hash) assert.ok(ids(read(file)).has(hash), `zoekindex ${lang}: anker ${e.u} bestaat niet`);
      }
    }
  });

  await check('het Docker-voorbeeld op de site is het echte docker-compose.yml', () => {
    const compose = composeExample();
    assert.match(compose, /image: ghcr\.io\/wnijhof\/tickory:latest/);
    const escaped = compose.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    for (const page of ['nl/index.html', 'en/index.html', 'nl/handleiding/installeren.html', 'en/guide/installing.html']) {
      assert.ok(read(page).includes(escaped), `${page} toont niet de inhoud van docker-compose.yml`);
    }
  });

  await check('datumvoorbeelden in de handleiding: elk voorbeeld geeft bij de echte herkenner precies wat erbij staat', () => {
    // De voorbeelden gaan uit van dinsdag 17 november 2026, 10:00 (dat staat ook op de pagina).
    const now = new Date(2026, 10, 17, 10, 0);
    const view = {
      projects: new Map([['inbox-x', { id: 'inbox-x', name: 'Inbox' }], ['p-thuis', { id: 'p-thuis', name: 'Thuis' }]]),
      sections: new Map([['s-keuken', { id: 's-keuken', project_id: 'p-thuis', name: 'Keuken' }]]),
      labels: new Map([['l-bellen', { id: 'l-bellen', name: 'bellen' }]]),
    };
    const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const problems: string[] = [];
    const counts = { date: 0, repeat: 0, title: 0, none: 0, quick: 0 };
    const pages = htmlPages.filter((p) => /^(nl|en)\//.test(p));
    for (const page of pages) {
      for (const m of read(page).matchAll(/<code class="(ex(?:-[a-z]+)?)"((?:\s+data-[a-z]+=(?:"[^"]*"|'[^']*'))*)>([^<]*)<\/code>/g)) {
        const text = decode(m[3]);
        const data: Record<string, string> = {};
        for (const a of m[2].matchAll(/data-([a-z]+)=(?:"([^"]*)"|'([^']*)')/g)) data[a[1]] = decode(a[2] ?? a[3]);
        const where = `${page}: "${text}"`;
        const expectDue = (due: any) => {
          if (!due) return problems.push(`${where} wordt niet als datum herkend`);
          if (data.date === undefined) return problems.push(`${where} heeft geen data-date (de verwachte datum)`);
          if (due.date !== data.date) problems.push(`${where} geeft ${due.date}, de pagina zegt ${data.date}`);
          const rule = data.rule ? JSON.parse(data.rule) : undefined;
          try {
            assert.deepEqual(due.recurrence, rule);
          } catch {
            problems.push(`${where} geeft herhaling ${JSON.stringify(due.recurrence)}, de pagina zegt ${data.rule ?? 'geen'}`);
          }
          return undefined;
        };
        if (m[1] === 'ex') {
          // alleen een datum, zoals in het datumveld van een taak
          const due = parseDateText(text, now);
          counts[data.rule ? 'repeat' : 'date'] += 1;
          expectDue(due);
        } else if (m[1] === 'ex-title') {
          // een hele regel: de datum wordt uit de titel gehaald
          const r = parseDue(text, now);
          counts.title += 1;
          expectDue(r?.due);
          if (r && data.title !== undefined && r.content !== data.title) problems.push(`${where} laat als titel "${r.content}" over, de pagina zegt "${data.title}"`);
        } else if (m[1] === 'ex-none') {
          // wordt bewust met rust gelaten
          const r = parseDue(text, now);
          counts.none += 1;
          if (r?.due) problems.push(`${where} wordt wél als datum gelezen (${r.due.date}), de pagina zegt van niet`);
          if (data.title !== undefined && (r?.content ?? text) !== data.title) problems.push(`${where} wordt "${r?.content ?? text}", de pagina zegt "${data.title}"`);
        } else if (m[1] === 'ex-quick') {
          // snel toevoegen: project, sectie, labels, prioriteit en deadline
          const q = parseQuickAdd(text, { view, now, defaultProjectId: 'inbox-x' });
          counts.quick += 1;
          const got: Record<string, string> = {
            title: q.content, date: q.due?.date ?? '', prio: String(q.priority), deadline: q.deadline ?? '',
            project: (view.projects.get(q.project_id) as any)?.name ?? '', section: q.section_id ? (view.sections.get(q.section_id) as any).name : '',
            labels: [...q.labels.map((id: string) => (view.labels.get(id) as any).name), ...q.newLabels.map((n: string) => `${n}*`)].join(','),
            // herinneringen: een aantal minuten vooraf, of de datum en tijd van een herinnering op een vast tijdstip
            reminders: q.reminders.map((r: any) => (r.type === 'relative' ? String(r.minute_offset) : r.due.date)).join(','),
          };
          for (const [key, value] of Object.entries(data)) {
            if (!(key in got)) problems.push(`${where}: onbekende verwachting data-${key}`);
            else if (got[key] !== value) problems.push(`${where}: ${key} is "${got[key]}", de pagina zegt "${value}"`);
          }
          if (Object.keys(data).length === 0) problems.push(`${where}: geen verwachtingen bij dit voorbeeld`);
        } else if (m[1] === 'ex-filter') {
          // filtervoorbeelden worden gecontroleerd tegen de voorbeeldgegevens, in het onderdeel over de demo
        } else {
          problems.push(`${where}: onbekende soort voorbeeld (${m[1]})`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
    // beide talen tonen dezelfde voorbeelden; samen dus minstens het dubbele van wat één handleiding hoort te hebben
    assert.ok(counts.date >= 2 * 20 && counts.repeat >= 2 * 15 && counts.title >= 2 * 4 && counts.none >= 2 * 5 && counts.quick >= 2 * 5, `te weinig gecontroleerde voorbeelden: ${JSON.stringify(counts)}`);
    console.log(`    (${Object.values(counts).reduce((a, b) => a + b, 0)} voorbeelden: ${JSON.stringify(counts)})`);
  });

  await check('pictogrammen en afbeeldingen: aanwezig, juiste afmetingen, en het beeldmerk is overal hetzelfde bestand', () => {
    const size = (file: string) => { const s = pngSize(join(ROOT, ...file.split('/'))); return `${s.width}x${s.height}`; };
    assert.equal(size('client/icon-192.png'), '192x192');
    assert.equal(size('client/icon-512.png'), '512x512');
    assert.equal(size('client/icon-maskable-512.png'), '512x512');
    assert.equal(size('website/assets/favicon-32.png'), '32x32');
    assert.equal(size('website/assets/apple-touch-icon.png'), '180x180');
    assert.equal(size('website/assets/social-preview.png'), '1280x640', 'GitHub vraagt 1280 x 640 voor het voorbeeldplaatje');
    assert.equal(readFileSync(join(ROOT, 'client/icon.svg'), 'utf8'), readFileSync(join(ROOT, 'website/assets/logo.svg'), 'utf8'), 'client/icon.svg en website/assets/logo.svg horen gelijk te zijn');
    const shots = JSON.parse(readFileSync(join(ROOT, 'website/assets/shots/shots.json'), 'utf8')) as Record<string, { width: number; height: number }>;
    for (const name of Object.keys(shots)) {
      for (const theme of ['light', 'dark']) {
        const file = join(ROOT, 'website/assets/shots', `${name}-${theme}.webp`);
        assert.ok(existsSync(file), `schermafbeelding ${name}-${theme}.webp ontbreekt`);
        const b = readFileSync(file);
        assert.ok(b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP', `${name}-${theme}.webp is geen WebP`);
        assert.ok(b.length < 200_000, `${name}-${theme}.webp is ${Math.round(b.length / 1024)} kB (te zwaar voor een snelle pagina)`);
      }
    }
    // elke schermafbeelding wordt ergens gebruikt, anders staat er dood gewicht in de repo
    const used = htmlPages.map(read).join('\n');
    for (const name of Object.keys(shots)) assert.ok(used.includes(`shots/${name}-light.webp`), `schermafbeelding ${name} wordt op geen enkele pagina gebruikt`);
  });
}

// ====================================================================================================================
// 2. De demo-backend, zonder browser
// ====================================================================================================================

if (wants('demo')) {
  const load = (path: string) => import(pathToFileURL(join(SITE, ...path.split('/'))).href);
  const { DemoServer, createBackend } = await load('demo/core/backend.js');
  const { createSeed } = await load('demo/core/demoSeed.js');
  const { Store, MemoryAdapter } = await load('demo/core/store.js');
  const { SyncClient, HttpError } = await load('demo/core/syncClient.js');
  const { createActions } = await load('demo/core/actions.js');
  const { todayView, upcomingView, projectView, membersOf } = await load('demo/core/selectors.js');
  const { todayString } = await load('demo/core/format.js');

  let n = 0;
  const uuid = () => `check-uuid-${String(++n).padStart(6, '0')}`;
  const cmd = (type: string, args: object) => ({ type, uuid: uuid(), args });

  await check('voorbeeldgegevens: op elke dag van de komende twee jaar kloppen alle datums en is er iets te zien', () => {
    for (let i = 0; i < 740; i++) {
      for (const [h, min] of [[0, 1], [10, 0], [23, 58]]) {
        const now = new Date(2026, 10, 13 + i, h, min);
        const seed = createSeed(now, { strict: true });
        const today = todayString(now);
        const t = todayView(seed.state, today);
        const label = now.toISOString();
        assert.ok(t.overdue.length >= 2, `${label}: te weinig taken te laat`);
        assert.ok(t.today.length >= 3, `${label}: te weinig taken voor vandaag`);
        assert.ok(upcomingView(seed.state, today).length >= 3, `${label}: te weinig dagen in Binnenkort`);
        for (const task of seed.state.tasks.values()) {
          if (task.due?.recurrence) assert.ok(task.due.date.slice(0, 10) >= today, `${label}: de herhaling "${task.content}" begint in het verleden`);
        }
      }
    }
    const seed = createSeed(new Date(2026, 10, 17, 10, 0), { strict: true });
    assert.deepEqual([...seed.state.projects.values()].map((p) => p.name).sort(), ['Buurtfeest', 'Fietsroute', 'Huishouden', 'Inbox', 'Vakantie Texel', 'Verhuizing 2025']);
    const byName = (name: string) => [...seed.state.projects.values()].find((p) => p.name === name).id;
    assert.deepEqual(membersOf(seed.state, byName('Huishouden')).map((m: any) => `${m.user_id}:${m.role}`), ['user-anna:owner', 'user-bram:member', 'user-sanne:member']);
    assert.deepEqual(membersOf(seed.state, byName('Buurtfeest')).map((m: any) => `${m.user_id}:${m.role}`), ['user-joost:owner', 'user-anna:member', 'user-mila:member']);
    assert.equal(projectView(seed.state, byName('Huishouden')).groups.length, 4, 'Huishouden: taken zonder sectie en drie secties');
    assert.ok([...seed.state.tasks.values()].some((t) => t.parent_id), 'er zijn subtaken');
    assert.ok([...seed.state.tasks.values()].some((t) => t.checked), 'er is een voltooide taak');
    assert.ok([...seed.state.tasks.values()].some((t) => t.priority === 1) && [...seed.state.tasks.values()].some((t) => t.deadline), 'prioriteiten en deadlines');
    assert.ok([...seed.state.labels.values()].some((l) => l.owner_id !== 'user-anna'), 'er is een label van iemand anders');
  });

  await check('sync-protocol: volledige sync, delta op sync_token, sync_status, verwijderingen, partial, een uuid maar één keer', () => {
    const server = new DemoServer({ strict: true });
    const first = server.sync({ sync_token: '*' });
    assert.equal(first.full_sync, true);
    assert.equal(first.partial, false);
    assert.equal(first.sync_token, '1');
    assert.deepEqual(first.sync_status, {});
    assert.deepEqual(first.me, { id: 'user-anna', username: 'anna', name: 'Anna', is_admin: true, inbox_project_id: 'inbox-user-anna' });
    assert.deepEqual(first.users.map((u: any) => u.username), ['anna', 'bram', 'joost', 'mila', 'sanne'], 'alleen wie een project met je deelt, op naam gesorteerd');
    for (const r of ['projects', 'sections', 'tasks', 'labels', 'comments', 'reminders', 'filters', 'members']) assert.ok(Array.isArray(first[r]), `${r} ontbreekt in het antwoord`);
    assert.ok(first.tasks.length > 25 && first.tasks.every((t: any) => t.is_deleted === false));
    assert.deepEqual(first.settings.map((s: any) => [s.id, s.auto_reminder, s.timezone, s.owner_id]), [['settings-user-anna', 30, 'Europe/Amsterdam', 'user-anna']], 'de eigen instellingen komen mee, zoals op de echte server');
    assert.ok(first.reminders.length >= 8 && first.reminders.every((r: any) => r.owner_id === 'user-anna'), 'er zijn voorbeeldherinneringen, alleen van jou');

    const idle = server.sync({ sync_token: first.sync_token });
    assert.equal(idle.full_sync, false);
    assert.equal(idle.sync_token, '1');
    assert.deepEqual([idle.tasks, idle.projects, idle.members], [[], [], []], 'zonder wijziging is de delta leeg');

    const add = cmd('task_add', { id: 'check-task-0001', project_id: 'inbox-user-anna', content: 'Nieuwe taak' });
    const res = server.sync({ sync_token: '1', commands: [add] });
    assert.deepEqual(res.sync_status, { [add.uuid]: 'ok' });
    assert.equal(res.sync_token, '2');
    assert.deepEqual(res.tasks.map((t: any) => t.id), ['check-task-0001'], 'de delta bevat alleen de gewijzigde rij');
    assert.equal(res.tasks[0].creator_id, 'user-anna');
    res.tasks[0].content = 'gewijzigd in het antwoord';
    assert.equal(server.sync({ sync_token: '*' }).tasks.find((t: any) => t.id === 'check-task-0001').content, 'Nieuwe taak', 'het antwoord is een eigen kopie');

    const again = server.sync({ sync_token: '2', commands: [add] });
    assert.deepEqual(again.sync_status, { [add.uuid]: 'ok' }, 'een herhaald uuid krijgt dezelfde uitkomst');
    assert.equal(again.sync_token, '2', 'en verandert niets');

    const del = cmd('task_delete', { id: 'check-task-0001' });
    const gone = server.sync({ sync_token: '2', commands: [del] });
    assert.deepEqual(gone.tasks, [{ id: 'check-task-0001', is_deleted: true }], 'een verwijdering komt als is_deleted in de delta');
    assert.ok(!server.sync({ sync_token: '*' }).tasks.some((t: any) => t.id === 'check-task-0001'), 'en niet in een volledige sync');
    assert.equal(server.sync({ sync_token: '2' }).tasks.length, 1, 'ook wie later synchroniseert krijgt de verwijdering');

    const partial = server.sync({ sync_token: '*', resource_types: ['tasks', 'projects'] });
    assert.equal(partial.partial, true);
    assert.ok(partial.tasks && partial.projects && partial.labels === undefined);
    assert.equal(server.sync({ sync_token: '*', resource_types: ['all', '-comments'] }).comments, undefined);
    assert.equal(server.sync({ sync_token: '999' }).full_sync, true, 'een token dat voorloopt op de server geeft een volledige sync');

    for (const bad of [{ sync_token: 'abc' }, { commands: 'x' }, { commands: [{ type: 'task_add', uuid: 'kort' }] }, { resource_types: ['bestaat-niet'] }, { commands: Array.from({ length: 101 }, () => cmd('task_complete', { id: 'x' })) }, null]) {
      assert.throws(() => server.sync(bad), (err: any) => err instanceof HttpError && err.status === 400, `ongeldig verzoek hoort HTTP 400 te geven: ${JSON.stringify(bad)?.slice(0, 60)}`);
    }
  });

  await check('zelfde uitkomsten als de echte server: een reeks commando\'s, per commando dezelfde status en foutmelding, daarna dezelfde rijen', () => {
    // Echte server: dezelfde mensen, en hetzelfde gedeelde project van Joost waar Anna lid van is.
    const db = freshDb();
    const real: Record<string, any> = {};
    for (const [username, name] of [['anna', 'Anna'], ['bram', 'Bram'], ['joost', 'Joost'], ['kees', 'Opa Kees']]) real[username] = addUser(db, username, name);
    const realFeest = 'check-proj-feest';
    assert.deepEqual(Object.values(handleSync(db, { commands: [
      { type: 'project_add', uuid: 'check-setup-0001', args: { id: realFeest, name: 'Buurtfeest' } },
      { type: 'project_share', uuid: 'check-setup-0002', args: { project_id: realFeest, username: 'anna' } },
    ] }, real.joost.id).sync_status), ['ok', 'ok']);

    const demo = new DemoServer({ strict: true });
    const demoFeest = demo.sync({ sync_token: '*' }).projects.find((p: any) => p.name === 'Buurtfeest').id;
    const sides = {
      real: { inbox: real.anna.inbox_project_id, bram: real.bram.id, kees: real.kees.id, joost: real.joost.id, feest: realFeest, settings: `settings-${real.anna.id}`, run: (commands: object[]) => handleSync(db, { commands }, real.anna.id) },
      demo: { inbox: 'inbox-user-anna', bram: 'user-bram', kees: 'user-kees', joost: 'user-joost', feest: demoFeest, settings: 'settings-user-anna', run: (commands: object[]) => demo.sync({ commands }) },
    };
    const C1 = 'check-comm-0001', C2 = 'check-comm-0002', P = 'check-proj-0001', S = 'check-sect-0001', L = 'check-labl-0001', R1 = 'check-remi-0001', R2 = 'check-remi-0002', T1 = 'check-task-1001', T2 = 'check-task-1002', T3 = 'check-task-1003', T4 = 'check-task-1004';
    const weekly = { date: '2030-01-07', string: 'elke maandag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [1] } };
    /** De commando's, met de id's van de ene of de andere kant ingevuld. Bij elk commando de verwachte uitkomst. */
    const script = (x: typeof sides.real): [string, object, string][] => [
      ['project_add', { id: P, name: 'Verbouwing' }, 'ok'],
      ['section_add', { id: S, project_id: P, name: 'Keuken' }, 'ok'],
      ['label_add', { id: L, name: 'klus' }, 'ok'],
      ['label_add', { id: 'check-labl-0002', name: 'KLUS' }, 'DUPLICATE'],
      ['task_add', { id: T1, project_id: P, section_id: S, content: 'Tegels uitzoeken', labels: [L], due: weekly, priority: 2 }, 'ok'],
      ['task_add', { id: T2, project_id: P, parent_id: T1, content: 'Monsters ophalen' }, 'ok'],
      ['task_add', { id: T3, project_id: x.inbox, content: 'Offerte opvragen', deadline: '2030-02-01' }, 'ok'],
      ['task_add', { id: T3, project_id: x.inbox, content: 'Nog een keer' }, 'ID_EXISTS'],
      ['task_add', { id: 'check-task-9001', project_id: P, content: 'x', kleur: 'rood' }, 'UNKNOWN_ARG'],
      ['task_add', { id: 'check-task-9002', project_id: P, content: 'x', checked: true }, 'READONLY'],
      ['task_add', { id: 'check-task-9003', project_id: P }, 'MISSING_ARG'],
      ['task_add', { id: 'check-task-9004', project_id: P, content: 'x', priority: 9 }, 'INVALID_ARG'],
      ['task_add', { id: 'check-task-9005', project_id: 'check-proj-geen', content: 'x' }, 'NOT_FOUND'],
      ['task_add', { id: 'check-task-9006', project_id: x.inbox, section_id: S, content: 'x' }, 'CONFLICT'],
      ['task_add', { id: 'kort', project_id: P, content: 'x' }, 'INVALID_ARG'],
      ['project_add', { id: 'inbox-zelfgemaakt', name: 'x' }, 'INVALID_ARG'],
      ['project_share', { project_id: P, username: 'Bram' }, 'ok'],
      ['project_share', { project_id: P, username: 'bram' }, 'ok'],
      ['project_share', { project_id: P, username: 'niemand-bekend' }, 'NOT_FOUND'],
      ['project_share', { project_id: x.inbox, username: 'bram' }, 'CONFLICT'],
      ['project_share', { project_id: x.feest, username: 'bram' }, 'FORBIDDEN'],
      ['project_share', { project_id: P, username: 'anna' }, 'ok'],
      ['task_update', { id: T1, assignee_id: x.bram, content: 'Tegels kiezen' }, 'ok'],
      ['task_update', { id: T3, assignee_id: x.bram }, 'INVALID_ARG'],
      ['task_update', { id: T1, project_id: x.inbox }, 'IMMUTABLE'],
      ['task_update', { id: 'check-task-geen', content: 'x' }, 'NOT_FOUND'],
      ['task_complete', { id: T1 }, 'ok'],
      ['task_complete', { id: T3 }, 'ok'],
      ['task_complete', { id: T3 }, 'ok'],
      ['task_uncomplete', { id: T3 }, 'ok'],
      ['task_add', { id: T4, project_id: P, content: 'Aannemer bellen', assignee_id: x.bram }, 'ok'],
      ['task_move', { id: T4, project_id: x.inbox }, 'ok'],
      ['task_move', { id: T1, parent_id: T2 }, 'CYCLE'],
      ['task_move', { id: T2 }, 'MISSING_ARG'],
      ['task_move', { id: T3, project_id: P, section_id: S }, 'ok'],
      ['label_update', { id: L, name: 'klussen' }, 'ok'],
      // herinneringen: zelfde regels als op de server (relatief heeft een aantal minuten nodig, absoluut een datum met tijd)
      ['reminder_add', { id: R1, task_id: T3, type: 'relative', minute_offset: 30 }, 'ok'],
      ['reminder_add', { id: R2, task_id: T3, type: 'absolute', due: { date: '2030-01-03T09:00' } }, 'ok'],
      ['reminder_add', { id: 'check-remi-0003', task_id: T3, type: 'absolute', due: { date: '2030-01-03' } }, 'INVALID_ARG'],
      ['reminder_add', { id: 'check-remi-0004', task_id: T3, type: 'relative' }, 'INVALID_ARG'],
      ['reminder_add', { id: 'check-remi-0005', task_id: T3, type: 'relative', minute_offset: 30, due: { date: '2030-01-03T09:00' } }, 'INVALID_ARG'],
      ['reminder_add', { id: 'check-remi-0006', task_id: T3, type: 'relative', minute_offset: -5 }, 'INVALID_ARG'],
      ['reminder_add', { id: 'check-remi-0007', task_id: 'check-task-geen', type: 'relative', minute_offset: 5 }, 'NOT_FOUND'],
      ['reminder_add', { id: 'check-remi-0008', task_id: T3, type: 'relative', minute_offset: 5, owner_id: x.bram }, 'READONLY'],
      ['reminder_delete', { id: R2 }, 'ok'],
      ['reminder_delete', { id: R2 }, 'NOT_FOUND'],
      // opmerkingen: bij een taak of bij een project; de schrijver vult de server in, en alleen de schrijver wijzigt of verwijdert
      ['comment_add', { id: C1, task_id: T3, content: 'Eerste opmerking' }, 'ok'],
      ['comment_add', { id: C2, project_id: P, content: 'Over het hele project' }, 'ok'],
      ['comment_add', { id: 'check-comm-0003', task_id: T3, project_id: P, content: 'x' }, 'INVALID_ARG'],
      ['comment_add', { id: 'check-comm-0004', content: 'x' }, 'INVALID_ARG'],
      ['comment_add', { id: 'check-comm-0005', task_id: 'check-task-geen', content: 'x' }, 'NOT_FOUND'],
      ['comment_add', { id: 'check-comm-0006', task_id: T3, content: 'x', author_id: x.bram }, 'READONLY'],
      ['comment_update', { id: C1, content: 'Aangepast' }, 'ok'],
      ['comment_update', { id: C1, task_id: T1 }, 'IMMUTABLE'],
      ['comment_delete', { id: C2 }, 'ok'],
      ['comment_delete', { id: C2 }, 'NOT_FOUND'],
      // projecten: kleur, favoriet en archiveren
      ['project_update', { id: P, color: 'teal', is_favorite: true }, 'ok'],
      ['project_update', { id: P, is_archived: true }, 'ok'],
      ['project_update', { id: P, is_archived: false }, 'ok'],
      // instellingen: alleen wijzigen, en alleen met geldige waarden
      ['settings_update', { id: x.settings, auto_reminder: 10 }, 'ok'],
      ['settings_update', { id: x.settings, auto_reminder: -1, timezone: 'Europe/Amsterdam' }, 'ok'],
      ['settings_update', { id: x.settings, auto_reminder: -2 }, 'INVALID_ARG'],
      ['settings_update', { id: x.settings, timezone: 'Mars/Olympus' }, 'INVALID_ARG'],
      ['settings_update', { id: x.settings, owner_id: x.bram }, 'READONLY'],
      ['settings_update', { id: 'settings-niemand', auto_reminder: 5 }, 'NOT_FOUND'],
      ['settings_add', { id: 'settings-check-0001', auto_reminder: 5 }, 'UNKNOWN_COMMAND'],
      ['settings_delete', { id: x.settings }, 'UNKNOWN_COMMAND'],
      ['project_unshare', { project_id: P, user_id: x.kees }, 'NOT_FOUND'],
      ['project_leave', { project_id: P }, 'CONFLICT'],
      ['project_delete', { id: x.inbox }, 'CONFLICT'],
      ['project_delete', { id: x.feest }, 'FORBIDDEN'],
      ['project_update', { id: x.feest, name: 'Straatfeest' }, 'ok'],
      ['project_unshare', { project_id: x.feest, user_id: x.joost }, 'FORBIDDEN'],
      ['section_delete', { id: 'check-sect-geen' }, 'NOT_FOUND'],
      ['bestaat_niet', { id: P }, 'UNKNOWN_COMMAND'],
      ['member_add', { project_id: P, user_id: x.kees, role: 'owner' }, 'UNKNOWN_COMMAND'],
    ];
    const names = (x: typeof sides.real) => new Map([[x.inbox, 'INBOX'], [x.bram, 'BRAM'], [x.kees, 'KEES'], [x.joost, 'JOOST'], [x.feest, 'FEEST'], [x === sides.real ? real.anna.id : 'user-anna', 'ANNA']]);
    /** Rijen vergelijkbaar maken: eigen id's van elke kant krijgen dezelfde naam; tijdstippen en id's van leden tellen niet. */
    const normalize = (x: typeof sides.real, rows: any[], keep: (row: any) => boolean, resource: string) => {
      const map = names(x);
      const swap = (v: unknown) => (typeof v === 'string' && map.has(v) ? map.get(v) : v);
      return rows.filter(keep).map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          if (k === 'created_at' || k === 'updated_at') continue;
          if (k === 'completed_at') out[k] = v === null ? null : 'TIJD';
          else if (k === 'id' && resource === 'members') continue;
          else if (k === 'id' && resource === 'settings') out[k] = 'SETTINGS';
          else out[k] = swap(v);
        }
        return out;
      }).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    };
    const outcome = (x: typeof sides.real) => {
      const steps = script(x);
      const commands = steps.map(([type, args], i) => ({ type, uuid: `check-diff-${String(i).padStart(4, '0')}`, args }));
      const status = x.run(commands).sync_status;
      return steps.map(([type, , expected], i) => {
        const s = status[commands[i].uuid];
        const code = s === 'ok' ? 'ok' : s.error_code;
        assert.equal(code, expected, `${x === sides.real ? 'echte server' : 'demo'}, stap ${i} (${type}): ${JSON.stringify(s)}`);
        return s;
      });
    };
    const realStatus = outcome(sides.real);
    const demoStatus = outcome(sides.demo);
    assert.deepEqual(demoStatus, realStatus, 'de demo geeft per commando dezelfde status en dezelfde foutmelding als de echte server');

    const own = new Set([P, S, L, T1, T2, T3, T4, R1, R2, C1, C2]);
    const state = (x: typeof sides.real) => {
      const full = x === sides.real ? handleSync(db, { sync_token: '*' }, real.anna.id) : demo.sync({ sync_token: '*' });
      const projects = new Set([P, x.feest]);
      return {
        projects: normalize(x, full.projects as any[], (r) => projects.has(r.id), 'projects').map((p: any) => ({ ...p, order_key: p.id === 'FEEST' ? '?' : p.order_key, color: p.id === 'FEEST' ? '?' : p.color })),
        sections: normalize(x, full.sections as any[], (r) => own.has(r.id), 'sections'),
        tasks: normalize(x, full.tasks as any[], (r) => own.has(r.id), 'tasks'),
        labels: normalize(x, full.labels as any[], (r) => own.has(r.id), 'labels'),
        members: normalize(x, full.members as any[], (r) => r.project_id === P, 'members'),
        reminders: normalize(x, full.reminders as any[], (r) => own.has(r.id), 'reminders'),
        comments: normalize(x, full.comments as any[], (r) => own.has(r.id), 'comments'),
        settings: normalize(x, full.settings as any[], () => true, 'settings'),
      };
    };
    const a = state(sides.real), b = state(sides.demo);
    // De volgorde van de eigen taken hangt af van wat er al in de Inbox stond; de demo heeft daar voorbeeldtaken.
    const loose = (s: typeof a) => ({ ...s, tasks: s.tasks.map((t: any) => ({ ...t, order_key: t.project_id === 'INBOX' ? '?' : t.order_key })), labels: s.labels.map((l: any) => ({ ...l, order_key: '?' })), projects: s.projects.map((p: any) => ({ ...p, order_key: '?' })) });
    assert.deepEqual(loose(b), loose(a), 'na dezelfde commando\'s staan in de demo dezelfde rijen als op de echte server');
    assert.equal(a.tasks.length, 4);
    const t1 = b.tasks.find((t: any) => t.id === T1) as any;
    assert.equal(t1.due.date, '2030-01-14', 'een terugkerende taak schuift door bij afvinken');
    assert.equal(t1.assignee_id, 'BRAM');
    assert.equal((b.tasks.find((t: any) => t.id === T4) as any).assignee_id, null, 'na verhuizen naar de Inbox vervalt de toewijzing aan iemand die daar geen lid is');

    // Daarna: iemand uit het project halen, het project van een ander verlaten, en opruimen.
    const second = (x: typeof sides.real): [string, object, string][] => [
      ['project_unshare', { project_id: P, user_id: x.bram }, 'ok'],
      ['project_unshare', { project_id: P, user_id: x.bram }, 'NOT_FOUND'],
      ['project_leave', { project_id: x.feest }, 'ok'],
      ['project_leave', { project_id: x.feest }, 'NOT_FOUND'],
      ['label_delete', { id: L }, 'ok'],
      ['section_delete', { id: S }, 'ok'],
      ['project_delete', { id: P }, 'ok'],
      ['task_add', { id: T1, project_id: x.inbox, content: 'Hergebruikt id' }, 'ID_EXISTS'],
    ];
    const run2 = (x: typeof sides.real) => {
      const steps = second(x);
      const commands = steps.map(([type, args], i) => ({ type, uuid: `check-more-${String(i).padStart(4, '0')}`, args }));
      const res = x.run(commands);
      const status = steps.map(([type, , expected], i) => {
        const s = res.sync_status[commands[i].uuid];
        assert.equal(s === 'ok' ? 'ok' : s.error_code, expected, `${x === sides.real ? 'echte server' : 'demo'}, vervolg stap ${i} (${type}): ${JSON.stringify(s)}`);
        return s;
      });
      const full = x === sides.real ? handleSync(db, { sync_token: '*' }, real.anna.id) : demo.sync({ sync_token: '*' });
      return { status, feestGone: !(full.projects as any[]).some((p) => p.id === x.feest), left: (full.tasks as any[]).filter((t) => own.has(t.id)).map((t) => t.id).sort(), remindersLeft: (full.reminders as any[]).filter((r) => own.has(r.id)).length, users: (full.users as any[]).map((u) => u.username) };
    };
    const r2 = run2(sides.real), d2 = run2(sides.demo);
    assert.deepEqual(d2.status, r2.status);
    assert.ok(r2.feestGone && d2.feestGone, 'na verlaten zie je het project niet meer');
    assert.deepEqual(d2.left, r2.left, 'dezelfde taken blijven over');
    assert.deepEqual([d2.remindersLeft, r2.remindersLeft], [0, 0], 'met de taak verdwijnen ook haar herinneringen');
    assert.deepEqual(d2.left, [T4], 'alleen de taak die naar de Inbox verhuisde bestaat nog');
    assert.deepEqual(r2.users, ['anna'], 'op de echte server deelt Anna nu met niemand meer');
    assert.ok(!d2.users.includes('joost'), 'in de demo verdwijnt Joost uit de lijst (Bram en Sanne delen nog Huishouden)');
  });

  await check('de app zelf tegen de demo: opstarten, taak toevoegen, delen met een onbekende en een bekende gebruikersnaam', async () => {
    const backend = createBackend();
    assert.equal(backend.demo, true);
    assert.ok(backend.getToken(), 'er is altijd een aanmelding, dus geen inlogscherm');
    backend.setToken('iets');
    backend.clearToken();
    assert.ok(backend.getToken());
    const handle = backend.listen({ onSyncNeeded: () => assert.fail('de demo stuurt geen signalen') });
    handle.restart();
    handle.stop();

    const store = new Store(new MemoryAdapter());
    await store.init();
    const errors: any[] = [];
    const sync = new SyncClient({ store, transport: backend.transport, onCommandErrors: (e: any[]) => errors.push(...e) });
    const actions = createActions(store);
    assert.equal(await sync.syncNow(), true);
    assert.equal(store.me.name, 'Anna');
    assert.equal(store.view.projects.size, 6);
    const huis = [...store.view.projects.values()].find((p: any) => p.name === 'Huishouden').id;

    const id = await actions.addTask({ content: 'Ramen lappen', project_id: huis, newLabels: ['buiten', 'zomer'] });
    assert.equal(store.queueLength, 2, 'een nieuw label en de taak wachten');
    assert.equal(await sync.syncNow(), true);
    assert.equal(store.queueLength, 0);
    assert.equal(store.base.tasks.get(id).content, 'Ramen lappen', 'de taak is bevestigd door de demo-server');
    assert.equal(store.base.tasks.get(id).labels.length, 2);
    assert.deepEqual(errors, []);

    await actions.shareProject(huis, 'niemand-bekend');
    await sync.syncNow();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error_code, 'NOT_FOUND');
    assert.equal(describeCommandError(errors[0]), 'Niet gelukt (project delen). Deze gebruiker bestaat niet.');
    await actions.shareProject(huis, 'KEES');
    await sync.syncNow();
    assert.deepEqual(membersOf(store.view, huis).map((m: any) => m.user_id), ['user-anna', 'user-bram', 'user-kees', 'user-sanne']);
    assert.equal(store.userName('user-kees'), 'Opa Kees');
    assert.equal(errors.length, 1);

    // account en beheer: voorbeeldantwoorden, of een nette melding
    const { sessions } = await backend.api.sessions();
    assert.equal(sessions.filter((s: any) => s.current).length, 1);
    await backend.api.revokeSession(sessions.find((s: any) => !s.current).id);
    assert.equal((await backend.api.sessions()).sessions.length, sessions.length - 1);
    await assert.rejects(backend.api.changePassword('a', 'b'), (err: any) => err.name === 'ApiError' && /kan niet in de demo/.test(err.message));
    const { users } = await backend.api.admin.users();
    assert.ok(users.length >= 6 && users.every((u: any) => typeof u.is_disabled === 'boolean'));
    await backend.api.admin.createUser({ username: 'oma', name: 'Oma Truus', password: 'lang-genoeg-wachtwoord', is_admin: false });
    await assert.rejects(backend.api.admin.createUser({ username: 'OMA', name: 'Nog een oma', password: 'lang-genoeg-wachtwoord' }), /al in gebruik/);
    await assert.rejects(backend.api.admin.createUser({ username: 'opa2', password: 'kort' }), /minimaal 10 tekens/);
    await assert.rejects(backend.api.admin.updateUser('user-anna', { is_disabled: true }), /jezelf niet blokkeren/);
    await backend.api.admin.updateUser('user-kees', { is_disabled: true });
    await actions.shareProject([...store.view.projects.values()].find((p: any) => p.name === 'Vakantie Texel').id, 'kees');
    await sync.syncNow();
    assert.equal(errors.length, 2, 'een geblokkeerd account geeft dezelfde melding als een onbekend account');
    await actions.shareProject([...store.view.projects.values()].find((p: any) => p.name === 'Vakantie Texel').id, 'oma');
    await sync.syncNow();
    assert.equal(errors.length, 2, 'met een in de demo aangemaakt account kun je delen');
    assert.equal(store.userName([...store.users].find((u: any) => u.username === 'oma').id), 'Oma Truus');
  });

  await check('zoeken, filters en labels tegen de demo-backend: de voorbeelden uit de handleiding, en een filter of label maken, wijzigen en verwijderen', async () => {
    const { evaluateFilter, compileFilter } = await load('demo/core/filter.js');
    const { search } = await load('demo/core/search.js');
    const { labelNameProblem } = await load('demo/core/labelManage.js');
    const { FILTER_TERM_GROUPS } = await load('demo/core/filterText.js');
    const backend = createBackend();
    const store = new Store(new MemoryAdapter());
    await store.init();
    const errors: any[] = [];
    const sync = new SyncClient({ store, transport: backend.transport, onCommandErrors: (e: any[]) => errors.push(...e) });
    const actions = createActions(store);
    assert.equal(await sync.syncNow(), true);
    const ctx = () => ({ view: store.view, now: new Date(), userId: store.userId, users: store.users });
    const taskIdOf = (content: string) => [...store.view.tasks.values()].find((t: any) => t.content === content).id;
    const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 1. elk filtervoorbeeld in de handleiding (beide talen) geeft bij de echte filtertaal wat erbij staat, op de voorbeeldgegevens van de demo
    const problems: string[] = [];
    let examples = 0;
    for (const page of htmlPages.filter((p) => /^(nl|en)\//.test(p))) {
      for (const m of read(page).matchAll(/<code class="ex-filter"((?:\s+data-[a-z]+="[^"]*")*)>([^<]*)<\/code>/g)) {
        const text = decode(m[2]);
        const data: Record<string, string> = {};
        for (const a of m[1].matchAll(/data-([a-z]+)="([^"]*)"/g)) data[a[1]] = decode(a[2]);
        const where = `${page}: "${text}"`;
        examples += 1;
        if (Object.keys(data).length === 0) problems.push(`${where}: geen verwachtingen`);
        if (data.error !== undefined) {
          const r = compileFilter(text, ctx());
          if (r.ok) problems.push(`${where} klopt, de pagina zegt dat er een fout (${data.error}) hoort te komen`);
          else if (r.error.code !== data.error) problems.push(`${where} geeft fout ${r.error.code}, de pagina zegt ${data.error}`);
          continue;
        }
        const r = evaluateFilter(text, ctx());
        if (!r.ok) { problems.push(`${where} geeft een fout (${r.error.code}), maar zou moeten werken`); continue; }
        const titles = new Set(r.tasks.map((t: any) => t.content));
        for (const t of (data.has ?? '').split('|').filter(Boolean)) if (!titles.has(t)) problems.push(`${where}: "${t}" ontbreekt in de uitkomst`);
        for (const t of (data.hasnot ?? '').split('|').filter(Boolean)) if (titles.has(t)) problems.push(`${where}: "${t}" hoort er niet in te staan`);
        if (data.groups !== undefined && r.groups.map((g: any) => g.name).join(',') !== data.groups) problems.push(`${where}: de lijsten heten ${r.groups.map((g: any) => g.name).join(',')}, de pagina zegt ${data.groups}`);
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(examples >= 2 * 15, `te weinig gecontroleerde filtervoorbeelden: ${examples}`);

    // 2. elke term van de filtertaal staat in de handleiding, in de vorm van de taal van de pagina
    const termProblems: string[] = [];
    for (const [page, lang] of [['nl/handleiding/filters.html', 'nl'], ['en/guide/filters.html', 'en']] as const) {
      const html = read(page);
      for (const group of FILTER_TERM_GROUPS) for (const term of group.terms) {
        if (!html.includes(`<code>${esc(term[lang])}</code>`)) termProblems.push(`${page}: de term "${term[lang]}" ontbreekt`);
        compileFilter(term[lang], ctx()); // moet kunnen (zie ook de unit-test)
      }
    }
    assert.deepEqual(termProblems, [], termProblems.join('\n'));

    // 3. zoeken in de voorbeeldgegevens: elke soort treffer, zonder letter- of accentverschil
    const kinds = new Set(search(store.view, 'BOODSCHAP', { userId: store.userId }).map((h: any) => h.kind));
    assert.deepEqual([...kinds].sort(), ['comment', 'label', 'section', 'task']);
    assert.ok(search(store.view, 'tandarts', { userId: store.userId }).some((h: any) => h.title === 'Tandarts bellen voor controle'));
    assert.deepEqual(search(store.view, 'nietsdergelijks', { userId: store.userId }), []);

    // 4. een filter maken, wijzigen en verwijderen: de demo bewaart het zoals de echte server
    const filterId = await actions.addFilter({ name: 'Nu of morgen', query: '(vandaag | morgen) & @bellen', color: 'blue' });
    await actions.updateFilter(filterId, { query: 'p1 & !subtaak' });
    await actions.updateFilter(filterId, { is_favorite: true });
    assert.equal(await sync.syncNow(), true);
    const filter = store.base.filters.get(filterId);
    assert.deepEqual([filter.name, filter.query, filter.color, filter.is_favorite, filter.owner_id], ['Nu of morgen', 'p1 & !subtaak', 'blue', true, 'user-anna']);
    assert.ok(evaluateFilter(filter.query, ctx()).tasks.some((t: any) => t.content === 'Boot reserveren'));
    await actions.addFilter({ name: 'Kapot', query: '#Bestaatniet' }); // een filter dat niet klopt wordt bewaard zoals getypt
    await actions.deleteFilter(filterId);
    assert.equal(await sync.syncNow(), true);
    assert.equal(store.base.filters.has(filterId), false);
    assert.equal([...store.base.filters.values()].filter((f: any) => f.name === 'Kapot').length, 1);
    assert.equal(compileFilter('#Bestaatniet', ctx()).error.code, 'unknown_project');

    // 5. labels: aanmaken (ook met spaties), dubbele namen, hernoemen, kleur, verwijderen haalt het van de taken, een label van een ander is alleen te lezen
    assert.equal(labelNameProblem(store.view, store.userId, 'BELLEN'), 'duplicate');
    const label = await actions.addLabel('Uitgaan met Zoë');
    assert.equal(labelNameProblem(store.view, store.userId, `uitgaan met zoe${String.fromCharCode(0x308)}`), 'duplicate', 'e met een los trema is hetzelfde als ë');
    await actions.setTaskLabels(taskIdOf('Fietsband plakken'), ['Uitgaan met Zoë']);
    assert.equal(await sync.syncNow(), true);
    assert.deepEqual(store.base.tasks.get(taskIdOf('Fietsband plakken')).labels, [label]);
    assert.deepEqual(await actions.renameLabel(label, 'bellen'), { ok: false, code: 'DUPLICATE', message: 'Er bestaat al een label met die naam.' });
    assert.deepEqual(await actions.renameLabel(label, 'Uitgaan'), { ok: true });
    await actions.updateLabel(label, { color: 'green' });
    assert.equal(await sync.syncNow(), true);
    assert.deepEqual([store.base.labels.get(label).name, store.base.labels.get(label).color], ['Uitgaan', 'green']);
    const buurt = [...store.view.labels.values()].find((l: any) => l.name === 'buurt');
    assert.equal((await actions.renameLabel(buurt.id, 'wijk')).code, 'READONLY', 'het label van iemand anders kun je niet hernoemen');
    await actions.deleteLabel(label);
    assert.equal(await sync.syncNow(), true);
    assert.equal(store.base.labels.has(label), false);
    assert.deepEqual(store.base.tasks.get(taskIdOf('Fietsband plakken')).labels ?? [], [], 'het label is van de taak gehaald');
    assert.deepEqual(errors, []);
  });

  await check('de demo-backend biedt precies hetzelfde als de echte backend (client/core/backend.js)', async () => {
    // Krijgt de echte backend er iets bij (bijvoorbeeld voor herinneringen), dan moet de demo dat ook kennen: anders
    // roept de app in de demo iets aan dat niet bestaat. Deze controle valt dan om en zegt wat er ontbreekt.
    const { createBackend: createReal } = await import('../client/core/backend.js');
    const real = createReal({ clientId: 'site-check', storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } as unknown as Storage });
    const demo = createBackend();
    const shape = (o: any, depth = 0): unknown =>
      Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k] !== null && typeof o[k] === 'object' && depth < 3 ? shape(o[k], depth + 1) : typeof o[k]]));
    assert.deepEqual(shape(demo), shape(real), 'de demo-backend (website/demo/backend.js) en client/core/backend.js lopen uiteen');
    assert.equal(real.demo, false);
    assert.equal(demo.demo, true);
  });
}

// ====================================================================================================================
// 3. In de browser
// ====================================================================================================================

/** Leest een PNG (8 bits, RGB of RGBA, niet geïnterlinieerd) naar beeldpunten. Genoeg voor schermafbeeldingen uit de browser. */
function decodePng(buf: Buffer): { width: number; height: number; channels: number; data: Buffer } {
  let pos = 8;
  let width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || (body[9] !== 6 && body[9] !== 2) || body[12] !== 0) throw new Error('PNG-soort niet ondersteund');
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? data[y * stride + x - channels] : 0;
      const b = y > 0 ? data[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? data[(y - 1) * stride + x - channels] : 0;
      let out = v;
      if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      data[y * stride + x] = out & 0xff;
    }
  }
  return { width, height, channels, data };
}

if (wants('browser')) {
  if (process.env.SITE_CHECK_BROWSER === '0') {
    console.log('– browsercontroles overgeslagen (SITE_CHECK_BROWSER=0): de demo en de pagina\'s zijn NIET in een browser getest');
  } else if (!findBrowser()) {
    failures.push('browser');
    console.error('✖ geen browser gevonden (Edge of Chrome). Geef het pad in SITE_BROWSER, of sla dit deel bewust over met SITE_CHECK_BROWSER=0.');
  } else {
    const PORT = Number(process.env.SITE_PORT ?? 8794);
    const CDP_PORT = Number(process.env.SITE_CDP_PORT ?? 9344);
    const site = await startSiteServer({ root: SITE, base: BASE, port: PORT });
    const origin = `http://127.0.0.1:${PORT}`;
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser({ workDir: join(ROOT, '.site-work', 'check'), cdpPort: CDP_PORT });
      const b = browser;
      const { evaluate, waitFor } = b;
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

      /** Alle verzoeken van de pagina horen binnen de site te blijven; fouten in de console zijn er niet. */
      const assertClean = (what: string) => {
        const outside = b.requests.filter((r) => !/^(data|blob|about):/.test(r.url) && !r.url.startsWith(site.url));
        assert.deepEqual(outside.map((r) => `${r.method} ${r.url}`), [], `${what}: verzoeken buiten ${site.url}`);
        assert.deepEqual(b.requests.filter((r) => /\/api\//.test(r.url)).map((r) => r.url), [], `${what}: verzoeken naar /api/`);
        const bad = b.requests.filter((r) => r.failed || (r.status !== undefined && r.status >= 400));
        assert.deepEqual(bad.map((r) => `${r.status ?? r.failed} ${r.url}`), [], `${what}: mislukte verzoeken`);
        assert.deepEqual(b.errors, [], `${what}: fouten in de console`);
      };
      const SYNCED = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(['Bijgewerkt', 'Up to date'].includes(document.getElementById('sync-status').textContent)))))`;
      const nav = (label: string) => evaluate(`(() => { const el = [...document.querySelectorAll('.nav-item')].find((x) => x.querySelector('.nav-label')?.textContent === ${js(label)}); if (!el) throw new Error('geen menu-item: ' + ${js(label)}); el.click(); })()`);
      const clickText = (text: string, root = 'document') => evaluate(`(() => { const el = [...${root}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${js(text)}); if (!el) throw new Error('geen knop: ' + ${js(text)}); el.click(); })()`);
      const typeInto = (selector: string, text: string) => evaluate(`(() => { const el = document.querySelector(${js(selector)}); if (!el) throw new Error('niet gevonden: ' + ${js(selector)}); el.focus(); el.value = ${js(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      const submit = (selector: string) => evaluate(`document.querySelector(${js(selector)}).requestSubmit()`);
      const titles = () => evaluate<string[]>(`[...document.querySelectorAll('.task .task-title')].map((e) => e.textContent)`);
      const chips = (content: string) => evaluate<string[] | null>(`(() => { const li = [...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === ${js(content)}); return li ? [...li.querySelectorAll('.chip')].map((c) => c.textContent) : null; })()`);
      const taskDo = (content: string, selector: string) => evaluate(`(() => { const li = [...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === ${js(content)}); if (!li) throw new Error('geen taak: ' + ${js(content)}); li.querySelector(${js(selector)}).click(); })()`);
      const viewTitle = (text: string) => waitFor(`document.getElementById('view-title').textContent === ${js(text)}`, `scherm ${text}`);
      const toastSeen = (text: string) => waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent.startsWith(${js(text)}))`, `melding "${text}"`);
      const openDemo = async (query = '') => {
        await b.goto(`${site.url}demo/${query}`);
        await waitFor(`document.body.classList.contains('ready')`, 'de app is gestart');
        await waitFor(`await ${SYNCED}`, 'de voorbeeldgegevens zijn geladen');
      };

      await check('demo: start zonder inlogscherm, met de voorbeeldgegevens en de balk', async () => {
        b.reset();
        await b.viewport(1280, 860);
        await openDemo();
        assert.equal(await evaluate(`document.querySelector('dialog[open]')`), null, 'er staat geen (inlog)venster open');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('.nav-item .nav-label')].map((e) => e.textContent)`), ['Inbox', 'Vandaag', 'Binnenkort', 'Huishouden', 'Huishouden', 'Vakantie Texel', 'Fietsroute', 'Buurtfeest', 'Anna']);
        assert.equal(await evaluate(`document.getElementById('view-title').textContent`), 'Vandaag');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('.group-title')].map((e) => e.textContent.split(' · ')[0])`), ['Te laat', 'Vandaag']);
        assert.ok((await titles()).length >= 5, 'te laat en vandaag samen minstens vijf taken');
        assert.deepEqual(await chips('Boodschappen doen'), ['vandaag 17:30', '1/4', '2', '@boodschappen', '🔔', 'voor jou', 'Huishouden / Boodschappen']);
        const bar = await evaluate<{ text: string; href: string; top: number; height: number }>(`(() => { const el = document.getElementById('demo-bar'); const r = el.getBoundingClientRect(); return { text: el.querySelector('.demo-bar-long').textContent, href: el.querySelector('.demo-bar-link').href, top: r.top, height: r.height }; })()`);
        assert.equal(bar.text, 'Dit is een demo: wijzigingen worden niet bewaard.');
        assert.equal(bar.href, site.url, 'de link in de balk gaat terug naar de website');
        assert.ok(bar.top === 0 && bar.height > 30, 'de balk staat zichtbaar bovenaan');
        assert.ok(await evaluate(`document.querySelector('.topbar').getBoundingClientRect().top >= document.getElementById('demo-bar').getBoundingClientRect().bottom - 1`), 'de app begint onder de balk');
        assert.equal(await evaluate(`document.getElementById('sidebar').getBoundingClientRect().bottom <= window.innerHeight + 1`), true, 'de zijbalk (met Instellingen onderaan) past in beeld');
        assertClean('demo starten');
      });

      await check('demo: taak toevoegen met Nederlandse datum, afvinken met ongedaan maken, herhaling schuift door', async () => {
        b.reset();
        await typeInto('#quick-input', 'Loodgieter bellen morgen om 9 uur #Huishouden /Klusjes @bellen p1');
        await waitFor(`document.querySelectorAll('#quick-preview .chip').length >= 6`, 'voorbeeld onder het invoerveld');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('#quick-preview .chip')].map((c) => c.textContent)`), ['Loodgieter bellen', 'morgen 09:00', '#Huishouden', '/Klusjes', '@bellen', 'P1']);
        await submit('#quick-add');
        await waitFor(`document.getElementById('quick-input').value === ''`, 'invoerveld leeg');
        await nav('Huishouden');
        await viewTitle('Huishouden');
        await waitFor(`await ${SYNCED}`, 'bijgewerkt');
        assert.deepEqual(await chips('Loodgieter bellen'), ['morgen 09:00', '@bellen', '🔔']);
        assert.equal(await evaluate(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === 'Loodgieter bellen').classList.contains('prio-1')`), true);
        assert.equal(await evaluate(`[...document.querySelectorAll('.group')].find((g) => g.querySelector('.group-title')?.textContent === 'Klusjes').textContent.includes('Loodgieter bellen')`), true, 'de taak staat in de sectie Klusjes');

        const before = (await titles()).length;
        await taskDo('Kattenvoer bestellen', '.check');
        await waitFor(`document.querySelectorAll('.task').length === ${before - 1}`, 'taak verdwenen na afvinken');
        await toastSeen('Taak voltooid');
        assert.equal((await titles()).length, before - 1);
        await evaluate(`document.querySelector('.toast-action').click()`);
        await waitFor(`document.querySelectorAll('.task').length === ${before}`, 'taak terug na ongedaan maken');

        const stofzuigen = await chips('Stofzuigen');
        await taskDo('Stofzuigen', '.check');
        await toastSeen('Volgende keer:');
        await waitFor(`await ${SYNCED}`, 'bijgewerkt');
        const after = await chips('Stofzuigen');
        assert.ok(after && stofzuigen && after[0].startsWith('↻ ') && after[0] !== stofzuigen[0], `de herhaling schuift door (${stofzuigen?.[0]} → ${after?.[0]})`);
        assert.equal((await titles()).length, before, 'een terugkerende taak blijft staan');

        // een afgevinkte taak met subtaken: tonen en verbergen van voltooide taken
        assert.match(await evaluate(`document.querySelector('.link-button').textContent`), /^Voltooide taken tonen \(1\)$/);
        assertClean('toevoegen en afvinken');
      });

      await check('demo: taak bewerken (naam, datum in gewone taal, prioriteit, subtaak, toewijzen)', async () => {
        b.reset();
        await taskDo('Lamp in de gang vervangen', '.task-body');
        await waitFor(`document.querySelector('#task-dialog[open]')`, 'bewerkvenster');
        assert.equal(await evaluate(`[...document.querySelectorAll('#task-dialog select[aria-label="Toegewezen aan"] option')].map((o) => o.textContent).join('|')`), '(niemand)|Anna (jij)|Bram|Sanne');
        await typeInto('#task-dialog textarea[aria-label="Taak"]', 'Lamp in de hal vervangen');
        await typeInto('#task-dialog input[placeholder^="bv. morgen"]', 'niet te begrijpen datum');
        await submit('#task-dialog form');
        await waitFor(`document.querySelector('#task-dialog .error').textContent.includes('niet herkend')`, 'foutmelding bij onbekende datum');
        await typeInto('#task-dialog input[placeholder^="bv. morgen"]', 'elke eerste maandag');
        await waitFor(`document.querySelector('#task-dialog .hint').textContent.startsWith('Wordt: ↻')`, 'uitleg bij de datum');
        await evaluate(`(() => { const d = document.querySelector('#task-dialog'); d.querySelector('.prio-option.prio-1 input').click(); d.querySelector('select[aria-label="Toegewezen aan"]').value = 'user-sanne'; })()`);
        await typeInto('#task-dialog input[placeholder="Subtaak toevoegen"]', 'Trapje lenen');
        await clickText('Toevoegen', `document.querySelector('#task-dialog')`);
        await waitFor(`document.querySelector('#task-dialog').textContent.includes('Subtaak toegevoegd: Trapje lenen')`, 'subtaak toegevoegd');
        await submit('#task-dialog form');
        await waitFor(`!document.querySelector('dialog[open]')`, 'bewerkvenster gesloten');
        await waitFor(`await ${SYNCED}`, 'bijgewerkt');
        const meta = await chips('Lamp in de hal vervangen');
        assert.ok(meta && meta[0].startsWith('↻ ') && meta[1] === '0/1' && meta[2] === '1' && meta[3] === 'voor Sanne', `de taak toont de herhaling en de nieuwe toewijzing: ${JSON.stringify(meta)}`);
        assert.equal(await evaluate(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === 'Lamp in de hal vervangen').classList.contains('prio-1')`), true);
        assert.equal(await evaluate(`[...document.querySelectorAll('.task[data-depth="1"] .task-title')].some((e) => e.textContent === 'Trapje lenen')`), true, 'de subtaak staat eronder');
        assert.ok(!(await titles()).includes('Lamp in de gang vervangen'));
        assertClean('bewerken');
      });

      await check('demo: delen: onbekende gebruikersnaam geeft de melding van de echte server, een bestaande wordt lid; toewijzen kan daarna', async () => {
        b.reset();
        await clickText('Gedeeld');
        await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Delen: Huishouden'`, 'deelvenster');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] .device-info strong')].map((e) => e.firstChild.textContent)`), ['Anna', 'Bram', 'Sanne']);
        await typeInto('dialog[open] input[aria-label="Gebruikersnaam van de persoon"]', 'niemand-bekend');
        await submit('dialog[open] form.subtask-row');
        await toastSeen('Niet gelukt (project delen). Deze gebruiker bestaat niet.');
        await typeInto('dialog[open] input[aria-label="Gebruikersnaam van de persoon"]', 'kees');
        await submit('dialog[open] form.subtask-row');
        await waitFor(`[...document.querySelectorAll('dialog[open] .device-info strong')].some((e) => e.textContent.startsWith('Opa Kees'))`, 'Opa Kees in de ledenlijst');
        assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] .device')].find((d) => d.textContent.includes('Opa Kees')).textContent.includes('@kees · lid')`));
        await clickText('Sluiten', `document.querySelector('dialog[open]')`);
        await waitFor(`document.querySelector('.shared-with')?.textContent === 'Gedeeld met Bram, Opa Kees en Sanne'`, 'regel "Gedeeld met …"');
        await taskDo('Fietsenschuur opruimen', '.task-body');
        await waitFor(`document.querySelector('#task-dialog[open]')`, 'bewerkvenster');
        await evaluate(`document.querySelector('#task-dialog select[aria-label="Toegewezen aan"]').value = 'user-kees'`);
        await submit('#task-dialog form');
        await waitFor(`!document.querySelector('dialog[open]')`, 'bewerkvenster gesloten');
        await waitFor(`await ${SYNCED}`, 'bijgewerkt');
        assert.deepEqual(await chips('Fietsenschuur opruimen'), ['@buiten', 'voor Opa Kees']);

        // lid van andermans project: bekijken, niet beheren, wel verlaten
        await nav('Buurtfeest');
        await viewTitle('Buurtfeest');
        assert.equal(await evaluate(`document.querySelector('.shared-with').textContent`), 'Gedeeld met Joost en Mila · je bent lid');
        assert.deepEqual(await chips('Vergunning aanvragen bij de gemeente'), [await evaluate(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === 'Vergunning aanvragen bij de gemeente').querySelector('.chip').textContent`), '@buurt', 'voor Joost']);
        await clickText('Project…');
        await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] .menu-item')].map((e) => e.textContent)`), ['Bewerken…', 'Subproject toevoegen', 'Aan favorieten toevoegen', 'Leden bekijken', 'Project verlaten']);
        await clickText('Project verlaten', `document.querySelector('dialog[open]')`);
        await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Project verlaten?')`, 'bevestiging');
        await clickText('Verlaten', `[...document.querySelectorAll('dialog[open]')].at(-1)`);
        await viewTitle('Inbox');
        await waitFor(`await ${SYNCED}`, 'bijgewerkt');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('.nav-item .nav-label')].map((e) => e.textContent)`), ['Inbox', 'Vandaag', 'Binnenkort', 'Huishouden', 'Huishouden', 'Vakantie Texel', 'Fietsroute', 'Anna']);
        assert.deepEqual(b.errors, []);
        assertClean('delen en verlaten');
      });

      await check('demo: account en gebruikersbeheer geven voorbeeldantwoorden of een nette melding; een nieuw project maken werkt', async () => {
        b.reset();
        await nav('Anna');
        await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingen');
        await clickText('Account, wachtwoord en apparaten');
        await waitFor(`document.querySelector('dialog[open] .device .badge')?.textContent === 'dit apparaat'`, 'apparatenlijst');
        assert.equal(await evaluate(`document.querySelectorAll('dialog[open] .device').length`), 3);
        await evaluate(`document.querySelectorAll('dialog[open] details')[1].open = true`);
        await typeInto('dialog[open] input[aria-label="Huidig wachtwoord"]', 'maakt-niet-uit');
        await typeInto('dialog[open] input[aria-label="Nieuw wachtwoord"]', 'een-nieuw-wachtwoord');
        await typeInto('dialog[open] input[aria-label="Nieuw wachtwoord nogmaals"]', 'een-nieuw-wachtwoord');
        await submit('dialog[open] details:nth-of-type(2) form');
        await waitFor(`document.querySelector('dialog[open] details:nth-of-type(2) .hint.error')?.textContent.startsWith('Dat kan niet in de demo')`, 'melding dat dit in de demo niet kan');
        await clickText('Gebruikersbeheer');
        await waitFor(`document.querySelectorAll('dialog[open] .device').length >= 6`, 'gebruikerslijst');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] .device .hint')].map((e) => e.textContent)`), ['@anna', '@bram', '@joost', '@kees', '@mila', '@sanne']);
        await clickText('Sluiten', `document.querySelector('dialog[open]')`);
        await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Account'`, 'terug in het accountscherm');
        await clickText('Sluiten', `document.querySelector('dialog[open]')`);
        await waitFor(`!document.querySelector('dialog[open]')`, 'alles gesloten');

        await evaluate(`document.querySelector('.nav-heading button').click()`);
        await waitFor(`document.querySelector('dialog[open] input')`, 'naam van het project');
        await typeInto('dialog[open] input', 'Tuin');
        await submit('dialog[open] form');
        await viewTitle('Tuin');
        await clickText('Sectie toevoegen');
        await waitFor(`document.querySelector('dialog[open] input')`, 'naam van de sectie');
        await typeInto('dialog[open] input', 'Moestuin');
        await submit('dialog[open] form');
        await waitFor(`[...document.querySelectorAll('.group-title')].some((e) => e.textContent === 'Moestuin')`, 'sectie zichtbaar');
        await typeInto('#quick-input', 'Tomaten water geven elke ochtend /Moestuin');
        await submit('#quick-add');
        await waitFor(`await ${SYNCED}`, 'bijgewerkt');
        assert.deepEqual(await titles(), ['Tomaten water geven']);
        assert.match((await chips('Tomaten water geven'))![0], /^↻ .* 09:00$/);
        assertClean('account en project');
      });

      await check('demo: herinneringen in het taakvenster (kiezen, eigen tijdstip, verwijderen, taak zonder tijd) en met !-snelschrift', async () => {
        b.reset();
        await nav('Inbox');
        await viewTitle('Inbox');
        const lines = () => evaluate<string[]>(`[...document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] .device-info')].map((e) => e.textContent)`);
        const pick = (value: string) => evaluate(`(() => { const s = document.querySelector('#task-dialog section[aria-label="Herinneringen"] select'); s.value = ${js(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        const addReminder = () => clickText('Herinnering toevoegen', `document.querySelector('#task-dialog')`);
        const closeTask = async () => { await submit('#task-dialog form'); await waitFor(`!document.querySelector('dialog[open]')`, 'taakvenster gesloten'); };

        assert.ok((await chips('Tandarts bellen voor controle'))!.includes('🔔'), 'een taak met een herinnering toont de bel');
        assert.ok(!(await chips('Fietsband plakken'))!.includes('🔔'), 'een taak zonder tijd en zonder herinnering toont geen bel');
        await taskDo('Tandarts bellen voor controle', '.task-body');
        await waitFor(`document.querySelector('#task-dialog[open]')`, 'taakvenster');
        assert.deepEqual(await lines(), ['1 dag vooraf · vandaag 09:00', 'Op een vast tijdstip · vandaag 20:00', '30 minuten vooraf · morgen 08:30'], 'de voorbeeldherinneringen, op volgorde van moment');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] select option')].map((o) => o.textContent)`), ['Op het tijdstip van de taak', '10 minuten vooraf', '30 minuten vooraf', '45 minuten vooraf', '1 uur vooraf', '2 uur vooraf', '3 uur vooraf', '1 dag vooraf', '2 dagen vooraf', '3 dagen vooraf', 'Datum en tijd kiezen…']);
        await evaluate(`document.querySelector('#task-dialog button[aria-label^="Herinnering verwijderen: Op een vast tijdstip"]').click()`);
        await waitFor(`document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] .device-info').length === 2`, 'herinnering verwijderd');
        await pick('120');
        await addReminder();
        await waitFor(`document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] .device-info').length === 3`, 'herinnering toegevoegd');
        assert.ok((await lines()).includes('2 uur vooraf · morgen 07:00'), `2 uur voor 9 uur morgen: ${JSON.stringify(await lines())}`);
        await pick('custom');
        assert.match(await evaluate(`document.querySelector('#task-dialog input[type="datetime-local"]').value`), /^\d{4}-\d\d-\d\dT\d\d:\d\d$/, 'het veld voor een eigen tijdstip is zichtbaar en al ingevuld');
        await evaluate(`document.querySelector('#task-dialog input[type="datetime-local"]').value = ''`);
        await addReminder();
        await waitFor(`document.querySelector('#task-dialog [data-role="reminder-error"]').textContent === 'Kies een datum en een tijd.'`, 'melding zonder gekozen tijdstip');
        await evaluate(`(() => { const d = new Date(); d.setDate(d.getDate() + 1); const p = (n) => String(n).padStart(2, '0'); const i = document.querySelector('#task-dialog input[type="datetime-local"]'); i.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T07:30'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await addReminder();
        await waitFor(`[...document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] .device-info')].some((e) => e.textContent === 'Op een vast tijdstip · morgen 07:30')`, 'eigen tijdstip toegevoegd');
        await closeTask();
        await waitFor(`await ${SYNCED}`, 'bijgewerkt');
        assert.ok((await chips('Tandarts bellen voor controle'))!.includes('🔔'));

        // een taak zonder tijd: de herinnering wacht tot er een tijd is
        await taskDo('Fietsband plakken', '.task-body');
        await waitFor(`document.querySelector('#task-dialog[open]')`, 'taakvenster');
        assert.deepEqual(await lines(), []);
        assert.match(await evaluate(`document.querySelector('#task-dialog section[aria-label="Herinneringen"]').textContent`), /Nog geen herinneringen\./);
        assert.match(await evaluate(`document.querySelector('#task-dialog section[aria-label="Herinneringen"]').textContent`), /alleen als de taak een datum mét tijd heeft/);
        await pick('10');
        await addReminder();
        await waitFor(`document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] .device-info').length === 1`, 'herinnering toegevoegd');
        assert.deepEqual(await lines(), ['10 minuten vooraf · gaat af zodra de taak een tijd heeft']);
        await closeTask();

        // snel toevoegen met !
        await typeInto('#quick-input', 'Bloemen kopen morgen om 10 uur !1u !0 !(vandaag om 20:00)');
        await waitFor(`document.querySelectorAll('#quick-preview .chip').length >= 5`, 'voorbeeld onder het invoerveld');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('#quick-preview .chip')].map((c) => c.textContent)`), ['Bloemen kopen', 'morgen 10:00', '🔔 1 uur vooraf', '🔔 Op het tijdstip van de taak', '🔔 vandaag 20:00']);
        await submit('#quick-add');
        await waitFor(`document.getElementById('quick-input').value === ''`, 'invoerveld leeg');
        await waitFor(`await ${SYNCED}`, 'bijgewerkt');
        assert.deepEqual(await chips('Bloemen kopen'), ['morgen 10:00', '🔔']);
        await taskDo('Bloemen kopen', '.task-body');
        await waitFor(`document.querySelector('#task-dialog[open]')`, 'taakvenster');
        assert.deepEqual((await lines()).sort(), ['1 uur vooraf · morgen 09:00', 'Op een vast tijdstip · vandaag 20:00', 'Op het tijdstip van de taak · morgen 10:00']);
        await closeTask();
        assertClean('herinneringen');
      });

      await check('demo: Herinneringen en meldingen: automatische herinnering, tijdzone, en meldingen kunnen in de demo niet', async () => {
        b.reset();
        const openSettings = async () => {
          await nav('Anna');
          await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingen');
          await clickText('Herinneringen en meldingen');
          await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Herinneringen en meldingen'`, 'scherm Herinneringen en meldingen');
        };
        const closeAll = async () => {
          for (let i = 0; i < 3 && (await evaluate(`Boolean(document.querySelector('dialog[open]'))`)); i++) {
            await evaluate(`[...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Sluiten')?.click()`);
            await sleep(150);
          }
          await waitFor(`!document.querySelector('dialog[open]')`, 'alles gesloten');
        };
        const setAuto = (value: string) => evaluate(`(() => { const s = document.querySelector('dialog[open] select[aria-label="Automatische herinnering"]'); s.value = ${js(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await openSettings();
        assert.equal(await evaluate(`document.querySelector('dialog[open] select[aria-label="Automatische herinnering"]').selectedOptions[0].textContent`), '30 minuten vooraf', 'standaard 30 minuten vooraf');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] select[aria-label="Automatische herinnering"] option')].map((o) => o.textContent)`), ['Geen automatische herinnering', 'Op het tijdstip van de taak', '10 minuten vooraf', '30 minuten vooraf', '45 minuten vooraf', '1 uur vooraf', '2 uur vooraf', '3 uur vooraf', '1 dag vooraf', '2 dagen vooraf', '3 dagen vooraf']);
        assert.match(await evaluate(`document.querySelector('dialog[open]').textContent`), /Herinneringen gaan af op de tijd van deze tijdzone: Europe\/Amsterdam\./);
        // de uitleg over meldingen komt uit de stijl van de demo; er is geen knop om meldingen aan te zetten
        assert.match(await evaluate(`getComputedStyle(document.querySelector('dialog[open] details.section:nth-of-type(3) > .section-form'), '::before').content`), /In de demo kun je geen meldingen aanzetten: die komen van je eigen server\./);
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] details.section:nth-of-type(3) button')].filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.textContent)`), [], 'geen knop om meldingen aan te zetten');
        assert.equal(await evaluate(`typeof PushManager + ' ' + Notification.permission`), 'undefined default', 'de demo vraagt de browser nergens om toestemming');
        assertClean('herinneringen en meldingen (scherm)');

        // zonder automatische herinnering krijgt een nieuwe taak met een tijd geen bel; met wel
        await setAuto('-1');
        await sleep(300);
        await closeAll();
        await nav('Inbox');
        await viewTitle('Inbox');
        await typeInto('#quick-input', 'Zonder bel morgen om 11 uur');
        await submit('#quick-add');
        await waitFor(`document.getElementById('quick-input').value === ''`, 'invoerveld leeg');
        await waitFor(`await ${SYNCED}`, 'bijgewerkt');
        assert.deepEqual(await chips('Zonder bel'), ['morgen 11:00'], 'zonder automatische herinnering geen bel');
        await openSettings();
        await setAuto('60');
        await sleep(300);
        await closeAll();
        await typeInto('#quick-input', 'Met bel morgen om 11 uur');
        await submit('#quick-add');
        await waitFor(`document.getElementById('quick-input').value === ''`, 'invoerveld leeg');
        await waitFor(`await ${SYNCED}`, 'bijgewerkt');
        assert.deepEqual(await chips('Met bel'), ['morgen 11:00', '🔔']);
        await taskDo('Met bel', '.task-body');
        await waitFor(`document.querySelector('#task-dialog[open]')`, 'taakvenster');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] .device-info')].map((e) => e.textContent)`), ['1 uur vooraf · morgen 10:00'], 'de automatische herinnering staat als gewone herinnering bij de taak');
        await submit('#task-dialog form');
        await waitFor(`!document.querySelector('dialog[open]')`, 'taakvenster gesloten');
        assertClean('automatische herinnering');
      });

      await check('demo: opmerkingen, favoriet, subproject, kleur, archiveren en terugzetten; venster Taak toevoegen en sneltoetsen', async () => {
        b.reset();
        const text = (selector: string) => evaluate<string>(`document.querySelector(${js(selector)}).innerText`);
        const press = async (key: string, shift = false) => {
          const base = { key, code: key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : '', text: key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers: shift ? 8 : 0 };
          await b.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
          await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        };
        /** g en dan een tweede toets; de pauze ertussen is kort, maar een trage computer kan de 1,5 seconde overschrijden: dan nog een keer. */
        const go = async (second: string, view: string) => {
          for (let i = 0; i < 2; i++) {
            await press('g');
            await press(second);
            if (await evaluate(`new Promise((r) => setTimeout(() => r(document.getElementById('view-title').textContent === ${js(view)}), 400))`)) return;
          }
          await viewTitle(view);
        };
        const menuItems = () => evaluate<string[]>(`[...document.querySelectorAll('dialog[open] .menu-item')].map((e) => e.textContent)`);
        const navRows = () => evaluate<string[]>(`[...document.querySelectorAll('.nav-row')].map((r) => r.dataset.depth + ':' + r.querySelector('.nav-label').textContent)`);
        const openProjectMenu = async () => { await clickText('Project…'); await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu'); };
        await nav('Huishouden');
        await viewTitle('Huishouden');
        assert.equal(await evaluate(`[...document.querySelectorAll('.nav-heading span')].map((e) => e.textContent).join('|')`), 'Favorieten|Projecten', 'Huishouden is favoriet en staat onder Favorieten');
        assert.equal(await evaluate(`document.querySelector('.btn-comments').textContent.trim()`), 'Opmerkingen (1)');

        // opmerkingen bij een taak: lezen, plaatsen met een weblink (een gewone tekstlink), eigen opmerking bewerken en verwijderen
        await taskDo('Boodschappen doen', '.task-body');
        await waitFor(`document.querySelector('#task-dialog[open]')`, 'taakvenster');
        assert.match(await text('#task-dialog .comments'), /Opmerkingen \(2\)[\s\S]*Bram[\s\S]*2 uur geleden[\s\S]*koffiebonen[\s\S]*Anna[\s\S]*1 uur geleden/);
        await typeInto('#task-dialog .comment-input', 'Nieuwe opmerking https://voorbeeld.nl.');
        await clickText('Opmerking plaatsen', `document.querySelector('#task-dialog')`);
        await waitFor(`document.querySelectorAll('#task-dialog .comment').length === 3`, 'opmerking geplaatst');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .comment a')].map((a) => a.href + ' ' + a.rel)`), ['https://www.voorbeeld.nl/boodschappen noopener noreferrer nofollow', 'https://voorbeeld.nl/ noopener noreferrer nofollow'], 'een weblink is een tekstlink, zonder het leesteken erachter');
        assert.equal(await evaluate(`document.querySelectorAll('#task-dialog .icon-button[aria-label="Opmerking bewerken"]').length`), 2, 'alleen je eigen opmerkingen kun je bewerken');
        await evaluate(`[...document.querySelectorAll('#task-dialog .comment')].at(-1).querySelector('.icon-button[aria-label="Opmerking bewerken"]').click()`);
        await waitFor(`document.querySelector('#task-dialog .comment-edit textarea')`, 'bewerken');
        await typeInto('#task-dialog .comment-edit textarea', 'Aangepaste opmerking');
        await clickText('Opslaan', `document.querySelector('#task-dialog .comment-edit')`);
        await waitFor(`[...document.querySelectorAll('#task-dialog .comment')].at(-1).textContent.includes('Aangepaste opmerking')`, 'opmerking aangepast');
        await evaluate(`[...document.querySelectorAll('#task-dialog .comment')].at(-1).querySelector('.icon-button[aria-label="Opmerking verwijderen"]').click()`);
        await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Opmerking verwijderen?')`, 'bevestiging');
        await clickText('Verwijderen', `[...document.querySelectorAll('dialog[open]')].at(-1)`);
        await waitFor(`document.querySelectorAll('#task-dialog .comment').length === 2`, 'opmerking verwijderd');
        await clickText('Annuleren', `document.querySelector('#task-dialog')`);
        await waitFor(`!document.querySelector('dialog[open]')`, 'taakvenster gesloten');

        // opmerkingen bij het project
        await clickText('Opmerkingen (1)');
        await waitFor(`document.querySelector('dialog[open] .comment-list')`, 'opmerkingen van het project');
        assert.match(await text('dialog[open]'), /Opmerkingen: Huishouden[\s\S]*Sanne[\s\S]*Wie zet deze week het vuilnis buiten\?/);
        await typeInto('dialog[open] .comment-input', 'Ik doe het deze week.');
        await clickText('Opmerking plaatsen', `document.querySelector('dialog[open]')`);
        await waitFor(`document.querySelectorAll('dialog[open] .comment').length === 2`, 'opmerking bij het project');
        await clickText('Sluiten', `document.querySelector('dialog[open]')`);
        await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');
        await waitFor(`document.querySelector('.btn-comments').textContent.trim() === 'Opmerkingen (2)'`, 'het aantal opmerkingen bij het project');

        // favoriet: uit de lijst halen en weer in
        await openProjectMenu();
        assert.deepEqual(await menuItems(), ['Bewerken…', 'Subproject toevoegen', 'Uit favorieten halen', 'Delen…', 'Archiveren', 'Project verwijderen']);
        await clickText('Uit favorieten halen', `document.querySelector('dialog[open]')`);
        await waitFor(`![...document.querySelectorAll('.nav-heading span')].some((e) => e.textContent === 'Favorieten')`, 'Favorieten verdwenen');
        await openProjectMenu();
        await clickText('Aan favorieten toevoegen', `document.querySelector('dialog[open]')`);
        await waitFor(`[...document.querySelectorAll('.nav-heading span')].some((e) => e.textContent === 'Favorieten')`, 'Favorieten terug');

        // een subproject met een kleur
        await openProjectMenu();
        await clickText('Subproject toevoegen', `document.querySelector('dialog[open]')`);
        await waitFor(`document.querySelector('dialog[open] input[name="project-color"]')`, 'projectvenster');
        assert.equal(await evaluate(`document.querySelector('dialog[open] h2').textContent`), 'Nieuw subproject');
        assert.equal(await evaluate(`document.querySelectorAll('dialog[open] input[name="project-color"]').length`), 16, 'zestien kleuren');
        assert.equal(await evaluate(`document.querySelector('dialog[open] select').selectedOptions[0].textContent`), 'Huishouden', '"Subproject van" staat op het project waar je vandaan komt');
        await typeInto('dialog[open] input[type="text"]', 'Schoonmaakrooster');
        await evaluate(`document.querySelector('dialog[open] input[name="project-color"][value="violet"]').click()`);
        await submit('dialog[open] form');
        await viewTitle('Schoonmaakrooster');
        assert.ok((await navRows()).includes('1:Schoonmaakrooster'), 'het subproject staat ingesprongen onder Huishouden');
        assert.equal(await evaluate(`document.querySelector('.view-lead .dot').classList.contains('pc-violet')`), true, 'de kleur staat bij de titel');

        // in- en uitklappen in de zijbalk
        await evaluate(`document.querySelector('.nav-toggle[aria-label="Subprojecten van Huishouden verbergen"]').click()`);
        await waitFor(`![...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Schoonmaakrooster')`, 'subproject verborgen');
        await evaluate(`document.querySelector('.nav-toggle[aria-label="Subprojecten van Huishouden tonen"]').click()`);
        await waitFor(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Schoonmaakrooster')`, 'subproject weer zichtbaar');

        // archiveren en terugzetten
        await openProjectMenu();
        await clickText('Archiveren', `document.querySelector('dialog[open]')`);
        await viewTitle('Inbox');
        await toastSeen('"Schoonmaakrooster" is gearchiveerd.');
        assert.equal(await evaluate(`document.querySelector('.nav-link').textContent.trim()`), 'Gearchiveerde projecten');
        await evaluate(`document.querySelector('.nav-link').click()`);
        await waitFor(`document.querySelector('dialog[open] .archive-list')`, 'gearchiveerde projecten');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] .archive-name')].map((e) => e.textContent)`), ['Schoonmaakrooster', 'Verhuizing 2025']);
        await clickText('Terugzetten', `document.querySelector('dialog[open] .archive-item')`);
        await waitFor(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Schoonmaakrooster')`, 'project teruggezet');
        await clickText('Sluiten', `document.querySelector('dialog[open]')`);
        await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');

        // het venster Taak toevoegen (knop in de zijbalk) en de sneltoets q
        await nav('Inbox');
        await viewTitle('Inbox');
        await evaluate(`document.querySelector('.sidebar-add').click()`);
        await waitFor(`document.querySelector('dialog[open] .quick-big')`, 'venster Taak toevoegen');
        assert.equal(await evaluate(`document.querySelector('dialog[open] h2').textContent`), 'Taak toevoegen');
        await typeInto('dialog[open] .quick-big', 'Rooster printen morgen p2');
        await typeInto('dialog[open] textarea', 'Voor op de koelkast.');
        await waitFor(`document.querySelectorAll('dialog[open] .chips .chip').length >= 3`, 'voorbeeld in het venster');
        await submit('dialog[open] form');
        await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');
        await waitFor(`await ${SYNCED}`, 'bijgewerkt');
        assert.ok((await titles()).includes('Rooster printen'));
        assert.match(await evaluate(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === 'Rooster printen').querySelector('.task-desc').textContent`), /Voor op de koelkast\./);
        await evaluate(`document.activeElement?.blur()`); // de focus stond nog in het invoerveld van een eerdere stap
        await press('q');
        await waitFor(`document.querySelector('dialog[open] .quick-big')`, 'q opent Taak toevoegen');
        await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await waitFor(`!document.querySelector('dialog[open]')`, 'Escape sluit het venster');
        await go('u', 'Binnenkort');
        await go('t', 'Vandaag');
        await go('i', 'Inbox');
        await press('?', true);
        await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Sneltoetsen')`, 'overzicht van sneltoetsen');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] .shortcut dd')].map((e) => e.textContent)`), ['Taak toevoegen', 'Naar Vandaag', 'Naar Binnenkort', 'Naar de Inbox', 'Dit overzicht tonen', 'Zoeken', 'Zoeken', 'Een venster sluiten', 'De taak opslaan in het taakvenster', 'Een taak of project een plek omhoog of omlaag zetten', 'Een taak of project onder het vorige hangen (subtaak) of er weer uit halen']);
        await clickText('Sluiten', `document.querySelector('dialog[open]')`);
        await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');
        // in een invoerveld doen de toetsen niets
        await evaluate(`document.getElementById('quick-input').focus()`);
        await press('q');
        assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open]'))`), false, 'q in een invoerveld opent niets');
        assert.equal(await evaluate(`document.getElementById('quick-input').value`), 'q');
        await typeInto('#quick-input', '');
        await evaluate(`document.activeElement.blur()`);
        // slepen in de demo: een echt muisgebaar zet de eerste taak onder de vierde, en dat is meteen te zien
        await nav('Huishouden');
        await viewTitle('Huishouden');
        const beforeDrag = await titles();
        const rects = await evaluate<{ from: { x: number; y: number }; to: { x: number; y: number } }>(`(() => {
          const rows = [...document.querySelectorAll('.task')];
          const box = (e, fy) => { const r = e.querySelector('.task-title').getBoundingClientRect(); const row = e.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(row.top + row.height * fy) }; };
          return { from: box(rows[0], 0.5), to: box(rows[Math.min(3, rows.length - 1)], 0.9) };
        })()`);
        const mouse = (type: string, x: number, y: number, buttons: number) => b.send('Input.dispatchMouseEvent', { type, x, y, button: buttons || type === 'mouseReleased' ? 'left' : 'none', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
        await mouse('mouseMoved', rects.from.x, rects.from.y, 0);
        await mouse('mousePressed', rects.from.x, rects.from.y, 1);
        for (let i = 1; i <= 10; i++) await mouse('mouseMoved', rects.from.x, Math.round(rects.from.y + ((rects.to.y - rects.from.y) * i) / 10), 1);
        assert.equal(await evaluate(`Boolean(document.querySelector('.dnd-ghost')) && Boolean(document.querySelector('.dnd-line'))`), true, 'tijdens het slepen: een kopie en een invoegstreep');
        await mouse('mouseReleased', rects.from.x, rects.to.y, 0);
        await waitFor(`document.querySelectorAll('.dnd-ghost, .dnd-line').length === 0`, 'slepen afgerond');
        await waitFor(`JSON.stringify([...document.querySelectorAll('.task .task-title')].map((e) => e.textContent)) !== ${js(JSON.stringify(beforeDrag))}`, 'de nieuwe volgorde staat in beeld');
        const afterDrag = await titles();
        assert.notDeepEqual(afterDrag, beforeDrag, 'de volgorde is veranderd');
        assert.deepEqual([...afterDrag].sort(), [...beforeDrag].sort(), 'er is niets verdwenen of verdubbeld');
        assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open]'))`), false, 'het taakvenster is niet opengegaan');
        assertClean('opmerkingen, projecten en sneltoetsen');
      });

      await check('demo: zoeken (/ en de zijbalk), een filter maken met fout en uitleg, labels beheren; ook in het Engels', async () => {
        b.reset();
        const press = async (key: string, ctrl = false) => {
          const named: Record<string, [string, number, string]> = { '/': ['Slash', 191, '/'], Enter: ['Enter', 13, String.fromCharCode(13)] };
          const [code, vk, text] = named[key] ?? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), key];
          const base = { key, code, text: ctrl ? undefined : text, windowsVirtualKeyCode: vk, modifiers: ctrl ? 2 : 0 };
          await b.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
          await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        };
        const closeSearch = () => evaluate(`document.querySelector('#search-dialog').close()`);
        for (const lang of ['en', 'nl'] as const) { // eindigt in het Nederlands, zoals de controles hierna verwachten
          const nl = lang === 'nl';
          await b.viewport(1280, 860);
          await openDemo(`?lang=${lang}`);
          assert.equal(await evaluate(`document.querySelector('.search-field-text').textContent`), nl ? 'Zoeken' : 'Search');
          assert.deepEqual(await evaluate(`[...document.querySelectorAll('.nav-section-link')].map((e) => e.textContent)`), ['Filters', 'Labels']);
          // zoeken: / opent het venster, hoofdletters en accenten tellen niet, Enter opent de eerste treffer
          await evaluate(`document.activeElement?.blur(); document.body.focus()`);
          await press('/');
          await waitFor(`document.querySelector('#search-dialog[open]')`, 'zoekvenster');
          await typeInto('#search-dialog .search-input', 'BOODSCHAP');
          await waitFor(`document.querySelectorAll('#search-dialog .search-hit').length >= 4`, 'treffers');
          assert.deepEqual(await evaluate(`[...document.querySelectorAll('#search-dialog .search-kind')].map((e) => e.textContent)`), nl ? ['Label', 'Sectie', 'Taak', 'Opmerking'] : ['Label', 'Section', 'Task', 'Comment']);
          assert.ok(await evaluate(`document.querySelectorAll('#search-dialog mark').length >= 4`), 'de gevonden woorden zijn gemarkeerd');
          await typeInto('#search-dialog .search-input', 'tandarts');
          await waitFor(`document.querySelector('#search-dialog .search-title')?.textContent === 'Tandarts bellen voor controle'`, 'taak gevonden');
          await press('Enter');
          await waitFor(`document.querySelector('#task-dialog[open]')`, 'Enter opent de taak');
          assert.equal(await evaluate(`document.querySelector('#task-dialog textarea').value`), 'Tandarts bellen voor controle');
          await evaluate(`document.querySelector('#task-dialog').close()`);
          await waitFor(`!document.querySelector('dialog')`, 'taakvenster dicht');
          await press('k', true);
          await waitFor(`document.querySelector('#search-dialog[open]')`, 'Ctrl+K');
          await closeSearch();
          await waitFor(`!document.querySelector('dialog')`, 'zoekvenster dicht');
          // een filter: eerst met een fout, dan goed; het staat daarna in de zijbalk en toont zijn taken
          await evaluate(`document.querySelector('.nav-section-head .icon-button').click()`);
          await waitFor(`document.querySelector('dialog[open] .filter-input')`, 'filtervenster');
          await typeInto('dialog[open] input[autocomplete=off]', nl ? 'Dringend' : 'Urgent');
          await typeInto('dialog[open] .filter-input', nl ? 'vandaag & #Keuken' : 'today & #Kitchen');
          await waitFor(`document.querySelector('dialog[open] .filter-error-text')`, 'foutmelding');
          assert.equal(await evaluate(`document.querySelector('dialog[open] .filter-error-text').textContent`), nl ? 'Onbekend project: "Keuken".' : 'Unknown project: "Kitchen".');
          await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
          assert.ok(await evaluate(`Boolean(document.querySelector('dialog[open] .filter-input'))`), 'een filter met een fout wordt niet bewaard');
          await evaluate(`document.querySelector('dialog[open] .filter-help > summary').click()`);
          assert.ok(await evaluate(`document.querySelectorAll('dialog[open] .filter-help-row').length > 30`), 'de uitleg staat in het venster');
          await typeInto('dialog[open] .filter-input', nl ? '(vandaag | morgen | te laat) & !subtaak' : '(today | tomorrow | overdue) & !subtask');
          await waitFor(`document.querySelector('dialog[open] .filter-ok')`, 'filter klopt');
          await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
          await viewTitle(nl ? 'Dringend' : 'Urgent');
          assert.ok((await titles()).length >= 5, 'het filter toont taken');
          assert.ok((await titles()).includes('Tandarts bellen voor controle'));
          assert.equal(await evaluate(`document.querySelector('.find-item.active .find-label').textContent`), nl ? 'Dringend' : 'Urgent');
          // labels: overzicht, toevoegen met spaties, hernoemen, verwijderen; het label van een ander is alleen te lezen
          await evaluate(`[...document.querySelectorAll('.nav-section-link')].at(-1).click()`);
          await viewTitle('Labels');
          const rows = () => evaluate<string[]>(`[...document.querySelectorAll('.manage-name')].map((e) => e.textContent)`);
          assert.deepEqual((await rows()).sort(), ['@bellen', '@boodschappen', '@buiten', '@buurt']);
          assert.equal(await evaluate(`document.querySelectorAll('.manage-row .manage-buttons .icon-button').length`), 9, 'drie knoppen bij elk eigen label en geen bij dat van een ander');
          await evaluate(`document.querySelector('.btn-add').click()`);
          await waitFor(`document.querySelector('dialog[open] input[aria-label]')`, 'labelvenster');
          await typeInto('dialog[open] input[aria-label]', 'BELLEN');
          await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
          assert.equal(await evaluate(`document.querySelector('dialog[open] .error').textContent`), nl ? 'Er bestaat al een label met deze naam.' : 'A label with this name already exists.');
          await typeInto('dialog[open] input[aria-label]', 'Uitgaan met Zoë');
          await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
          await waitFor(`[...document.querySelectorAll('.manage-name')].some((e) => e.textContent === '@Uitgaan met Zoë')`, 'label toegevoegd');
          await typeInto('#quick-input', 'Taxi regelen @Uitgaan met Zoë');
          await waitFor(`document.querySelectorAll('#quick-preview .chip').length === 2`, 'voorbeeld met het label');
          assert.deepEqual(await evaluate(`[...document.querySelectorAll('#quick-preview .chip')].map((c) => c.textContent)`), ['Taxi regelen', '@Uitgaan met Zoë'], 'een bestaand label met spaties wordt herkend');
          await typeInto('#quick-input', '');
          await evaluate(`document.querySelector('[aria-label*="Uitgaan met Zoë"]:not([aria-pressed])').click()`);
          await waitFor(`document.querySelector('dialog[open] input[aria-label]')`, 'label bewerken');
          await typeInto('dialog[open] input[aria-label]', 'Uitgaan');
          await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
          await waitFor(`[...document.querySelectorAll('.manage-name')].some((e) => e.textContent === '@Uitgaan')`, 'label hernoemd');
          await evaluate(`[...document.querySelectorAll('button[aria-label]')].find((x) => x.getAttribute('aria-label').includes('@Uitgaan') && x.querySelector('.icon-trash')).click()`);
          await waitFor(`document.querySelector('dialog[open] .button-danger')`, 'bevestiging');
          await evaluate(`document.querySelector('dialog[open] .button-danger').click()`);
          await waitFor(`![...document.querySelectorAll('.manage-name')].some((e) => e.textContent === '@Uitgaan')`, 'label verwijderd');
          // een label in een taakregel opent het label
          await nav(nl ? 'Inbox' : 'Inbox');
          await viewTitle('Inbox');
          await taskDo('Tandarts bellen voor controle', '.chip-label');
          await viewTitle('@bellen');
          assertClean(`zoeken, filters en labels (${lang})`);
        }
      });

      await check('demo: bewaart niets: na herladen zijn de voorbeeldgegevens terug; geen service worker, geen opslag, geen aanmelding', async () => {
        b.reset();
        await b.send('Page.reload');
        await waitFor(`document.body.classList.contains('ready') && await ${SYNCED}`, 'de demo is opnieuw gestart');
        assert.equal(await evaluate(`document.getElementById('view-title').textContent`), 'Vandaag', 'ook het laatst bekeken scherm is vergeten');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('.nav-item .nav-label')].map((e) => e.textContent)`), ['Inbox', 'Vandaag', 'Binnenkort', 'Huishouden', 'Huishouden', 'Vakantie Texel', 'Fietsroute', 'Buurtfeest', 'Anna']);
        await nav('Huishouden');
        await viewTitle('Huishouden');
        const list = await titles();
        assert.ok(list.includes('Lamp in de gang vervangen') && !list.includes('Loodgieter bellen') && !list.includes('Lamp in de hal vervangen'), 'de wijzigingen van daarnet zijn weg');
        assert.equal(await evaluate(`document.querySelector('.shared-with').textContent`), 'Gedeeld met Bram en Sanne');
        assert.equal(await evaluate(`navigator.serviceWorker.getRegistrations().then((r) => r.length)`), 0, 'geen service worker');
        assert.deepEqual(await evaluate(`indexedDB.databases().then((d) => d.map((x) => x.name))`), [], 'geen IndexedDB');
        assert.equal(await evaluate(`localStorage.getItem('tickory.token')`), null, 'geen sessietoken');
        assert.deepEqual(await evaluate(`caches.keys()`), [], 'geen cache');
        assert.equal(await evaluate(`document.cookie`), '', 'geen cookies');
        await b.goto('about:blank');
        await b.goto(`${site.url}nl/`);
        assert.deepEqual(await evaluate(`Object.keys(localStorage)`), [], 'na het verlaten van de demo staat er niets meer in de browser');
        assertClean('herladen');
        assert.deepEqual(site.log.filter((r) => /\/api\/|\/sw\.js|manifest/.test(r.path)).map((r) => r.path), [], 'de server zag geen verzoek naar /api/, een service worker of een manifest');
        assert.deepEqual(site.log.filter((r) => !r.path.startsWith(BASE)).map((r) => r.path), [], `de server zag geen verzoek buiten ${BASE}`);
      });

      await check('demo op een telefoon, licht en donker: uitschuifmenu, niets valt buiten beeld; Engelse balk via ?lang=en', async () => {
        b.reset();
        await b.viewport(360, 740, { scale: 2, mobile: true });
        await openDemo('?lang=en');
        // Vergelijken met de breedte van het toestel zelf: een telefoonbrowser zoomt een te brede pagina uit, en dan
        // lijkt ze (gemeten tegen window.innerWidth) altijd te passen.
        assert.equal(await evaluate(`document.documentElement.scrollWidth`), 360, 'geen horizontaal scrollen: de pagina is precies zo breed als het scherm');
        const bar = await evaluate<{ short: string; long: string; href: string; fits: boolean }>(`(() => { const el = document.getElementById('demo-bar'); const vis = (s) => getComputedStyle(el.querySelector(s)).display !== 'none'; return { short: vis('.demo-bar-short') ? el.querySelector('.demo-bar-short').textContent : '', long: vis('.demo-bar-long') ? el.querySelector('.demo-bar-long').textContent : '', href: el.querySelector('.demo-bar-link').href, fits: el.scrollWidth <= el.clientWidth && el.querySelector('.demo-bar-link').getBoundingClientRect().right <= 360 }; })()`);
        assert.deepEqual(bar, { short: 'Demo: nothing is saved.', long: '', href: `${site.url}en/`, fits: true });
        assert.equal(await evaluate(`getComputedStyle(document.getElementById('sidebar')).position`), 'fixed');
        await evaluate(`document.getElementById('menu-button').click()`);
        await sleep(300);
        assert.ok(await evaluate(`(() => { const r = document.getElementById('sidebar').getBoundingClientRect(); return r.left === 0 && r.top === 0 && r.bottom === window.innerHeight; })()`), 'het menu schuift over het hele scherm, ook over de balk');
        await evaluate(`document.getElementById('scrim').click()`);
        await evaluate(`document.querySelector('.demo-tips > summary').click()`);
        assert.ok(await evaluate(`(() => { const r = document.querySelector('.demo-tips-body').getBoundingClientRect(); return r.left >= 0 && r.right <= 360 && r.width > 200; })()`), 'de tips passen op het scherm');
        assert.match(await evaluate(`document.querySelector('.demo-tips-body').textContent`), /Things to try/);
        await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        assert.equal(await evaluate(`document.querySelector('.demo-tips').open`), false, 'Escape sluit de tips');
        await b.colorScheme('dark');
        await sleep(150);
        const colors = await evaluate<{ bar: string; body: string }>(`({ bar: getComputedStyle(document.getElementById('demo-bar')).backgroundColor, body: getComputedStyle(document.body).backgroundColor })`);
        assert.equal(colors.body, 'rgb(22, 25, 28)', 'donker thema');
        assert.notEqual(colors.bar, 'rgba(0, 0, 0, 0)');
        await b.colorScheme('light');
        assertClean('telefoon');
      });

      await check('demo in het Engels (?lang=en): Engelse app en balk, herinneringen en meldingen in het Engels, niets bewaard, geen verkeer naar /api/', async () => {
        b.reset();
        await b.viewport(1280, 860);
        await openDemo('?lang=en');
        assert.equal(await evaluate(`document.documentElement.lang`), 'en');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('.nav-item .nav-label')].map((e) => e.textContent)`), ['Inbox', 'Today', 'Upcoming', 'Huishouden', 'Huishouden', 'Vakantie Texel', 'Fietsroute', 'Buurtfeest', 'Anna']);
        assert.equal(await evaluate(`document.getElementById('view-title').textContent`), 'Today');
        assert.equal(await evaluate(`document.querySelector('.demo-bar-long').textContent`), 'This is a demo: changes are not saved.');
        assert.equal(await evaluate(`document.querySelector('.demo-bar-link').href`), `${site.url}en/`, 'de link in de balk gaat naar de Engelse website');
        assert.ok((await chips('Boodschappen doen'))!.includes('🔔'), 'de bel staat ook in het Engels bij de taak');
        await nav('Inbox');
        await viewTitle('Inbox');
        await taskDo('Tandarts bellen voor controle', '.task-body');
        await waitFor(`document.querySelector('#task-dialog[open]')`, 'taakvenster');
        const lines = await evaluate<string[]>(`[...document.querySelectorAll('#task-dialog section[aria-label="Reminders"] .device-info')].map((e) => e.textContent)`);
        assert.equal(lines.length, 3);
        assert.match(lines[0], /^1 day before · /);
        assert.match(lines[1], /^At a set time · /);
        assert.match(lines[2], /^30 minutes before · /);
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog section[aria-label="Reminders"] select option')].map((o) => o.textContent).slice(0, 3)`), ['At the time of the task', '10 minutes before', '30 minutes before']);
        await submit('#task-dialog form');
        await waitFor(`!document.querySelector('dialog[open]')`, 'taakvenster gesloten');
        await nav('Anna');
        await waitFor(`document.querySelector('dialog[open] .menu')`, 'settings');
        await clickText('Reminders and notifications');
        await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Reminders and notifications'`, 'scherm Reminders and notifications');
        assert.equal(await evaluate(`document.querySelector('dialog[open] select[aria-label="Automatic reminder"]').selectedOptions[0].textContent`), '30 minutes before');
        assert.match(await evaluate(`getComputedStyle(document.querySelector('dialog[open] details.section:nth-of-type(3) > .section-form'), '::before').content`), /You can't turn on notifications in the demo: they come from your own server\./);
        assertClean('Engelse demo');
        await b.goto('about:blank');
        await b.goto(`${site.url}en/`);
        assert.deepEqual(await evaluate(`Object.keys(localStorage)`), [], 'na het verlaten van de demo staat er niets meer in de browser');
      });

      await check('beeldmerk: het SVG-bestand en de PNG uit scripts/make-icons.js tonen hetzelfde beeld', async () => {
        b.reset();
        await b.viewport(512, 512);
        await b.goto(`${site.url}demo/icon.svg`);
        const shot = decodePng(await b.screenshot({ format: 'png', clip: { x: 0, y: 0, width: 512, height: 512 } }));
        assert.deepEqual([shot.width, shot.height], [512, 512]);
        const drawn = rasterize(512, icon({ radius: CORNER }));
        let far = 0, total = 0;
        for (let i = 0; i < 512 * 512; i++) {
          const a = drawn[i * 4 + 3] / 255; // de PNG is doorzichtig buiten het afgeronde vlak; de browser toont daar wit
          for (let c = 0; c < 3; c++) {
            const expected = drawn[i * 4 + c] * a + 255 * (1 - a);
            const diff = Math.abs(expected - shot.data[i * shot.channels + c]);
            total += diff;
            if (diff > 48) far += 1;
          }
        }
        const mean = total / (512 * 512 * 3);
        assert.ok(mean < 1.2 && far < 600, `SVG en PNG wijken af: gemiddeld ${mean.toFixed(2)} per kleurwaarde, ${far} waarden ver ernaast (alleen randen mogen iets verschillen)`);
      });

      await check(`website: elke pagina laadt zonder fouten, alleen van de eigen site, en past op een telefoon (${htmlPages.length - 1} pagina's)`, async () => {
        const problems: string[] = [];
        for (const page of htmlPages.filter((p) => p !== 'demo/index.html' && p !== 'index.html')) {
          for (const [width, height, mobile] of [[360, 740, true], [1280, 860, false]] as const) {
            b.reset();
            await b.viewport(width, height, { scale: 1, mobile });
            await b.goto(`${site.url}${page}`);
            // afbeeldingen die pas bij scrollen laden nu ophalen, zodat een kapotte verwijzing ook echt opvalt
            await evaluate(`Promise.all([...document.images].map((img) => { img.loading = 'eager'; return img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }); }))`);
            const info = await evaluate<{ overflow: number; broken: string[]; h1: number; skip: boolean; gutter: number; top: number }>(`({
              overflow: document.documentElement.scrollWidth - ${width}, // tegen de breedte van het toestel, niet tegen een uitgezoomd venster
              broken: [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.currentSrc || i.src),
              h1: document.querySelectorAll('h1').length,
              skip: Boolean(document.querySelector('a.skip')) || document.body.classList.contains('page-choose'),
              // de kleinste afstand van een kop of alinea tot de linker- of rechterrand van het scherm
              gutter: Math.min(...[...document.querySelectorAll('h1, h2, h3, p')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 2 && r.height > 2).map((r) => Math.min(r.left, ${width} - r.right))),
              // en de ruimte boven het beeldmerk in de kop en boven de eerste kop van de pagina
              top: Math.min(document.querySelector('.brand img')?.getBoundingClientRect().top ?? 99, (document.querySelector('h1').getBoundingClientRect().top + scrollY) - (document.querySelector('.site-header')?.getBoundingClientRect().bottom ?? -99)),
            })`);
            if (info.overflow > 0) problems.push(`${page} (${width} breed): ${info.overflow} punten te breed`);
            if (info.gutter < 12) problems.push(`${page} (${width} breed): tekst staat tegen de rand van het scherm (${Math.round(info.gutter)} punten ruimte)`);
            if (info.top < 8) problems.push(`${page} (${width} breed): de kop of de titel staat zonder ruimte tegen de bovenrand (${Math.round(info.top)} punten)`);
            if (info.broken.length) problems.push(`${page}: afbeelding laadt niet: ${info.broken.join(', ')}`);
            if (!info.skip) problems.push(`${page}: geen link "naar de inhoud"`);
            try {
              assertClean(`${page} (${width} breed)`);
            } catch (err) {
              problems.push((err as Error).message.split('\n').slice(0, 6).join(' | '));
            }
          }
        }
        assert.deepEqual(problems, [], problems.join('\n'));
      });

      await check('website: de startpagina kiest de taal van de browser; een onbekend adres geeft de 404-pagina', async () => {
        const ua = (await b.send('Browser.getVersion')).userAgent as string;
        for (const [accept, expected] of [['nl-NL,nl,en', 'nl/'], ['en-US,en', 'en/'], ['de-DE,de,nl,en', 'nl/'], ['fr-FR,fr', 'en/'], ['en-GB,en,nl', 'en/']]) {
          b.reset();
          await b.send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: accept });
          await b.goto(site.url);
          await waitFor(`location.pathname === ${js(`${BASE}${expected}`)}`, `met talen "${accept}" naar ${expected}`);
          assertClean(`startpagina (${accept})`);
        }
        await b.send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'nl-NL,nl' });
        b.reset();
        await b.goto(`${site.url}bestaat/niet.html`);
        assert.equal(await evaluate(`document.querySelector('h1').textContent`), 'Pagina niet gevonden');
        assert.equal(b.requests[0].status, 404);
        assert.deepEqual(b.requests.slice(1).filter((r) => r.status !== 200).map((r) => r.url), [], 'het stijlblad en het beeldmerk van de 404-pagina laden ook vanaf een dieper adres');
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('a')].map((a) => a.pathname)`), [`${BASE}nl/`, `${BASE}en/`]);
      });

      await check('website: zoeken in de handleiding, taalwissel, menu op de telefoon en kopieerknop', async () => {
        b.reset();
        await b.viewport(1280, 860);
        await b.goto(`${site.url}nl/handleiding/index.html`);
        await waitFor(`!document.querySelector('form.search').hidden`, 'het zoekveld is er');
        await typeInto('#search-input', 'tweede dinsdag');
        await waitFor(`document.querySelectorAll('#search-results li a').length > 0`, 'zoekresultaten');
        const first = await evaluate<{ href: string; text: string }>(`(() => { const a = document.querySelector('#search-results li a'); return { href: a.getAttribute('href'), text: a.textContent }; })()`);
        assert.match(first.href, /^datums-en-herhalingen\.html#/, `het eerste resultaat voor "tweede dinsdag" is de pagina over datums: ${JSON.stringify(first)}`);
        assert.match(await evaluate(`document.querySelector('.search-status').textContent`), /^\d+ resulta/);
        await typeInto('#search-input', 'qqqzzzxxy');
        await waitFor(`document.querySelector('#search-results').textContent.includes('Niets gevonden')`, 'melding bij geen resultaten');
        await typeInto('#search-input', 'back-up');
        await waitFor(`[...document.querySelectorAll('#search-results li a')].some((a) => a.getAttribute('href').startsWith('back-up.html'))`, 'zoeken op "back-up" vindt de pagina over back-ups');
        // met het toetsenbord: pijl omlaag gaat naar het eerste resultaat, Enter opent het
        await evaluate(`document.getElementById('search-input').focus()`);
        await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        assert.equal(await evaluate(`document.activeElement.closest('#search-results') !== null`), true, 'pijl omlaag zet de focus op een resultaat');
        const target = await evaluate<string>(`document.activeElement.href`);
        await evaluate(`document.activeElement.click()`);
        await waitFor(`location.href === ${js(target)}`, 'het resultaat opent');

        await b.goto(`${site.url}nl/handleiding/delen.html`);
        await evaluate(`document.querySelector('a.lang-switch').click()`);
        await waitFor(`location.pathname === ${js(`${BASE}en/guide/sharing.html`)} && document.querySelector('form.search')?.hidden === false`, 'taalwissel naar de Engelse pagina over delen');
        assert.equal(await evaluate(`document.documentElement.lang`), 'en');
        await typeInto('#search-input', 'recurring');
        await waitFor(`document.querySelectorAll('#search-results li a').length > 0`, 'Engelse zoekresultaten');
        assert.ok(await evaluate(`[...document.querySelectorAll('#search-results li a')].every((a) => !a.getAttribute('href').includes('handleiding'))`), 'de Engelse zoekfunctie zoekt in de Engelse pagina\'s');

        await b.viewport(360, 740, { scale: 1, mobile: true });
        await b.goto(`${site.url}nl/handleiding/installeren.html`);
        await waitFor(`!document.querySelector('form.search').hidden`, 'script geladen');
        assert.equal(await evaluate(`document.querySelector('.guide-nav-list').open`), false, 'op de telefoon is de lijst met pagina\'s ingeklapt');
        await evaluate(`document.querySelector('.guide-nav-list > summary').click()`);
        assert.ok(await evaluate(`document.querySelector('.guide-nav-list a[aria-current="page"]').getBoundingClientRect().height > 0`), 'uitgeklapt toont de lijst de huidige pagina');
        assert.ok(await evaluate(`document.querySelectorAll('pre .copy').length > 0`), 'codeblokken hebben een kopieerknop');
        assertClean('zoeken en taalwissel');
      });

      await check('website: te bedienen met het toetsenbord, en leesbaar in licht en donker (contrast van tekst en links)', async () => {
        b.reset();
        await b.viewport(1280, 860);
        const luminance = `(c) => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map((v) => { v = Number(v) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }`;
        for (const scheme of ['light', 'dark'] as const) {
          await b.colorScheme(scheme);
          for (const page of ['nl/index.html', 'nl/handleiding/datums-en-herhalingen.html']) {
            await b.goto(`${site.url}${page}`);
            const low = await evaluate<string[]>(`(() => {
              const lum = ${luminance};
              const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c !== 'rgba(0, 0, 0, 0)' && !/, 0\\)$/.test(c)) return c; } return getComputedStyle(document.documentElement).backgroundColor === 'rgba(0, 0, 0, 0)' ? 'rgb(255, 255, 255)' : getComputedStyle(document.documentElement).backgroundColor; };
              const out = [];
              for (const el of document.querySelectorAll('p, li, a, h1, h2, h3, td, th, figcaption, code, summary, span, button')) {
                if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const s = getComputedStyle(el);
                if (/color-mix|gradient/.test(s.backgroundImage)) continue;
                const a = lum(s.color), c = lum(bgOf(el));
                const ratio = (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
                if (ratio < 4.5) out.push(el.tagName.toLowerCase() + '.' + el.className + ' "' + el.textContent.trim().slice(0, 30) + '" ' + ratio.toFixed(2));
              }
              return [...new Set(out)];
            })()`);
            assert.deepEqual(low, [], `${page} (${scheme}): te weinig contrast (lager dan 4,5 op 1)`);
          }
        }
        await b.colorScheme('light');
        await b.goto(`${site.url}nl/`);
        await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        const focus = await evaluate<{ cls: string; visible: boolean; outline: string }>(`(() => { const el = document.activeElement; const r = el.getBoundingClientRect(); return { cls: el.className, visible: r.top >= 0 && r.height > 0, outline: getComputedStyle(el).outlineStyle }; })()`);
        assert.equal(focus.cls, 'skip', 'de eerste Tab gaat naar "Naar de inhoud"');
        assert.ok(focus.visible && focus.outline !== 'none', 'en die link is dan zichtbaar, met een duidelijke rand');
        assertClean('toetsenbord en contrast');
      });

      if (b.filtered.length > 0) console.log(`    (${b.filtered.length} meldingen van een netwerkfilter op deze computer (AdGuard) genegeerd: dat is geen verkeer van de site)`);
    } catch (err) {
      failures.push('browser');
      console.error('✖ de browsercontrole is afgebroken:\n', err);
    } finally {
      await browser?.close();
      await site.close();
    }
  }
}

// ====================================================================================================================

if (failures.length > 0) {
  console.error(`\n${failures.length} controle(s) MISLUKT, ${passed} geslaagd:\n${failures.map((f) => `  ✖ ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`\nALLE ${passed} CONTROLES GESLAAGD.`);
