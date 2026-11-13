// Bouwt de website van Tickory in de map _site/: de pagina's (Nederlands en Engels, met handleiding), en onder demo/
// de echte web-app waarin alleen core/backend.js is vervangen door een versie die alles in de browser afhandelt.
// Zonder afhankelijkheden; Node 26 voert dit bestand rechtstreeks uit.
//
// Gebruik: node scripts/build-site.ts [--out map] [--base /tickory/] [--url https://wnijhof.github.io/tickory/] [--demo-only]
//
//   --base   het pad waaronder de site komt te staan (of de omgevingsvariabele SITE_BASE). Alle links in de site zijn
//            relatief en werken dus onder elk pad; alleen 404.html (dat op elk onbekend adres wordt getoond) heeft dit
//            voorvoegsel nodig.
//   --url    het openbare adres (of SITE_URL), voor canonieke links en het voorbeeldplaatje bij delen: die moeten
//            absoluut zijn.
//   --demo-only   alleen de demo bouwen, zonder de pagina's (dat doet scripts/site-shots.ts om de schermafbeeldingen te maken).
//
// Bron: website/ (pagina's in website/pages/<taal>/, opmaak in layout.html, menu en teksten in site.json).
// Een pagina is een stuk HTML met bovenaan een commentaar met `title:` en `description:`. Drie eigen elementen:
//   <x-shot name="vandaag" alt="…">onderschrift</x-shot>   schermafbeelding (licht en donker) uit assets/shots/
//   <x-compose></x-compose>                                  de inhoud van docker-compose.yml, zonder de toelichting
//   {{root}}, {{version}}, {{repo}}, {{image}}               pad naar de hoofdmap van de site, versie uit package.json, adressen

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = join(ROOT, 'website');

export interface BuildOptions {
  /** Uitvoermap (standaard _site in de hoofdmap van de repo). */
  out?: string;
  /** Het pad waaronder de site komt te staan, met schuine streep aan beide kanten. */
  base?: string;
  /** Het openbare adres van de site, eindigend op een schuine streep. */
  url?: string;
  /** false = alleen de demo bouwen (voor het maken van de schermafbeeldingen, die er dan nog niet zijn). */
  pages?: boolean;
  quiet?: boolean;
}

type Lang = 'nl' | 'en';
interface PageRef { nl: string; en: string }
interface SiteConfig {
  repo: string;
  image: string;
  languages: Record<Lang, Record<string, string>>;
  home: PageRef;
  guide: { group: PageRef; pages: PageRef[] }[];
}
interface Page {
  lang: Lang;
  /** Pad binnen de taalmap, bv. "handleiding/inloggen.html". */
  path: string;
  /** Hetzelfde onderwerp in de andere taal. */
  alt: string;
  kind: 'home' | 'guide';
  title: string;
  description: string;
  html: string;
}

const read = (file: string): string => readFileSync(file, 'utf8');
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const LANGS: Lang[] = ['nl', 'en'];
const other = (lang: Lang): Lang => (lang === 'nl' ? 'en' : 'nl');

/** Alle bestanden in een map (recursief), als paden met schuine strepen ten opzichte van die map. */
export function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

function writeOut(outDir: string, path: string, content: string | Buffer): void {
  const file = join(outDir, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Vervangt {{naam}} door de waarde; een onbekende naam is een fout (zo blijft er nooit een leeg gat in een pagina). */
function fill(template: string, values: Record<string, string>, where: string): string {
  return template.replace(/\{\{([a-z_.]+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`${where}: onbekende plaatshouder {{${key}}}`);
    return values[key];
  });
}

/** Breedte en hoogte van een PNG-bestand (uit de eerste bytes). */
export function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`geen PNG: ${file}`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// ---------- pagina's ----------

function parsePage(file: string): { title: string; description: string; body: string } {
  const text = read(file).replace(/^﻿/, '');
  const m = /^<!--\s*\n([\s\S]*?)\n-->\s*\n/.exec(text);
  if (!m) throw new Error(`${file}: begint niet met een commentaar met title: en description:`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([a-z]+):\s*(.+?)\s*$/.exec(line);
    if (kv) meta[kv[1]] = kv[2];
  }
  if (!meta.title || !meta.description) throw new Error(`${file}: title: of description: ontbreekt`);
  // Verder commentaar in een pagina is een notitie voor wie de pagina bijwerkt; dat komt niet op de site.
  const body = text.slice(m[0].length).replace(/[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n?/g, '');
  return { title: meta.title, description: meta.description, body };
}

const slug = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deel';

/** Geeft elke h2 en h3 een id (uit de tekst van de kop), zodat je ernaar kunt linken en de zoekfunctie erheen kan springen. */
function addHeadingIds(html: string, where: string): string {
  const used = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  if (used.size !== [...html.matchAll(/\sid="([^"]+)"/g)].length) throw new Error(`${where}: hetzelfde id komt twee keer voor`);
  return html.replace(/<(h[23])((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/g, (all, tag: string, attrs: string, inner: string) => {
    if (/\sid="/.test(attrs)) return all;
    let id = slug(inner);
    for (let n = 2; used.has(id); n++) id = `${slug(inner)}-${n}`;
    used.add(id);
    return `<${tag}${attrs} id="${id}">${inner}</${tag}>`;
  });
}

/** docker-compose.yml zoals het in de repo staat, zonder commentaarregels (de toelichting staat op de pagina zelf). */
export function composeExample(): string {
  return read(join(ROOT, 'docker-compose.yml'))
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

function expandElements(html: string, root: string, where: string): string {
  const shotsDir = join(SRC, 'assets', 'shots');
  // De afmetingen (in beeldpunten) schrijft scripts/site-shots.ts erbij; zo hoeft de browser de pagina niet te verspringen.
  const sizes = existsSync(join(shotsDir, 'shots.json')) ? (JSON.parse(read(join(shotsDir, 'shots.json'))) as Record<string, { width: number; height: number }>) : {};
  let out = html.replace(/<x-shot\s+name="([a-z0-9-]+)"(?:\s+class="([a-z -]+)")?\s+alt="([^"]*)">([\s\S]*?)<\/x-shot>/g, (_, name: string, cls: string | undefined, alt: string, caption: string) => {
    const missing = [`${name}-light.webp`, `${name}-dark.webp`].filter((f) => !existsSync(join(shotsDir, f)));
    if (missing.length > 0 || !sizes[name]) throw new Error(`${where}: schermafbeelding "${name}" ontbreekt (maak ze met: node scripts/site-shots.ts)`);
    if (!alt.trim()) throw new Error(`${where}: schermafbeelding "${name}" heeft geen beschrijving (alt)`);
    // De afbeeldingen zijn op dubbele scherpte vastgelegd: de helft van de beeldpunten is de grootte op het scherm.
    const w = Math.round(sizes[name].width / 2), h = Math.round(sizes[name].height / 2);
    const kind = w < 500 ? 'shot-phone' : 'shot-wide';
    const first = cls?.split(' ').includes('first'); // staat bovenaan de pagina: meteen laden
    return [
      `<figure class="shot ${kind}${cls ? ` ${cls}` : ''}">`,
      '  <picture>',
      `    <source srcset="${root}assets/shots/${name}-dark.webp" media="(prefers-color-scheme: dark)">`,
      `    <img src="${root}assets/shots/${name}-light.webp" alt="${alt}" width="${w}" height="${h}"${first ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`,
      '  </picture>',
      caption.trim() ? `  <figcaption>${caption.trim()}</figcaption>` : '',
      '</figure>',
    ].filter(Boolean).join('\n');
  });
  out = out.replace(/<x-compose><\/x-compose>/g, () => `<pre><code>${escapeHtml(composeExample())}</code></pre>`);
  const left = /<x-[a-z]+/.exec(out);
  if (left) throw new Error(`${where}: onbekend of verkeerd geschreven element ${left[0]}…`);
  return out;
}

/** Tekst van een stuk HTML, voor de zoekfunctie. */
function plainText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Eén zoekitem per kop (h1, h2 of h3) met de tekst die eronder staat. */
function searchEntries(page: Page): { u: string; p: string; h: string; x: string }[] {
  const parts = page.html.split(/(?=<h[123][\s>])/);
  const entries = [];
  for (const part of parts) {
    const head = /^<(h[123])([^>]*)>([\s\S]*?)<\/\1>/.exec(part);
    if (!head) continue;
    const id = /\sid="([^"]+)"/.exec(head[2])?.[1];
    const text = plainText(part.slice(head[0].length));
    entries.push({ u: `${page.path}${head[1] === 'h1' || !id ? '' : `#${id}`}`, p: page.title, h: plainText(head[3]), x: text });
  }
  return entries;
}

function loadPages(config: SiteConfig): Page[] {
  const pages: Page[] = [];
  const add = (ref: PageRef, kind: Page['kind']) => {
    for (const lang of LANGS) {
      const file = join(SRC, 'pages', lang, ...ref[lang].split('/'));
      if (!existsSync(file)) throw new Error(`pagina ontbreekt: website/pages/${lang}/${ref[lang]} (genoemd in site.json)`);
      const parsed = parsePage(file);
      pages.push({ lang, path: ref[lang], alt: ref[other(lang)], kind, title: parsed.title, description: parsed.description, html: parsed.body });
    }
  };
  add(config.home, 'home');
  for (const group of config.guide) for (const ref of group.pages) add(ref, 'guide');
  // Een pagina die wel in de map staat maar niet in site.json, zou ongemerkt niet op de site komen.
  for (const lang of LANGS) {
    for (const file of listFiles(join(SRC, 'pages', lang))) {
      if (!pages.some((p) => p.lang === lang && p.path === file)) throw new Error(`website/pages/${lang}/${file} staat niet in site.json`);
    }
  }
  return pages;
}

function guideNav(config: SiteConfig, pages: Page[], page: Page, t: Record<string, string>): string {
  const here = posix.dirname(page.path);
  const link = (path: string) => posix.relative(here, path) || posix.basename(path);
  const titleOf = (path: string) => pages.find((p) => p.lang === page.lang && p.path === path)!.title;
  const groups = config.guide.map((g) => {
    const items = g.pages.map((ref) => {
      const path = ref[page.lang];
      const current = path === page.path;
      return `          <li><a href="${link(path)}"${current ? ' aria-current="page"' : ''}>${escapeHtml(titleOf(path))}</a></li>`;
    });
    const single = g.pages.length === 1; // de overzichtspagina staat los bovenaan, zonder kopje
    return single
      ? `        <ul class="guide-nav-top">\n${items.join('\n')}\n        </ul>`
      : `        <p class="guide-nav-group">${escapeHtml(g.group[page.lang])}</p>\n        <ul>\n${items.join('\n')}\n        </ul>`;
  });
  return [
    `    <nav class="guide-nav" aria-label="${t.guide_nav_label}">`,
    `      <form class="search" role="search" hidden data-none="${t.search_none}" data-one="${t.search_count_one}" data-many="${t.search_count_many}" data-failed="${t.search_failed}">`,
    `        <label class="visually-hidden" for="search-input">${t.search_label}</label>`,
    `        <input id="search-input" type="search" placeholder="${t.search_placeholder}" autocomplete="off" spellcheck="false" aria-controls="search-results">`,
    `        <p class="search-status visually-hidden" role="status" aria-live="polite"></p>`,
    `        <ol id="search-results" class="search-results" hidden></ol>`,
    '      </form>',
    '      <details class="guide-nav-list" open>',
    `        <summary>${t.guide_nav_summary}</summary>`,
    groups.join('\n'),
    '      </details>',
    '    </nav>',
  ].join('\n');
}

function pager(config: SiteConfig, pages: Page[], page: Page, t: Record<string, string>): string {
  const order = config.guide.flatMap((g) => g.pages.map((ref) => ref[page.lang]));
  const i = order.indexOf(page.path);
  const here = posix.dirname(page.path);
  const item = (path: string | undefined, rel: 'prev' | 'next', label: string) => {
    if (!path) return '<span></span>';
    const target = pages.find((p) => p.lang === page.lang && p.path === path)!;
    return `<a class="pager-${rel}" rel="${rel}" href="${posix.relative(here, path)}"><span>${label}</span>${escapeHtml(target.title)}</a>`;
  };
  return `      <nav class="pager" aria-label="${t.previous} / ${t.next}">\n        ${item(order[i - 1], 'prev', t.previous)}\n        ${item(order[i + 1], 'next', t.next)}\n      </nav>`;
}

function renderPage(config: SiteConfig, pages: Page[], page: Page, layout: string, opts: Required<BuildOptions>, version: string): string {
  const t = config.languages[page.lang];
  const depth = page.path.split('/').length; // de taalmap telt mee
  const root = '../'.repeat(depth);
  const urlOf = (lang: Lang, path: string) => `${opts.url}${lang}/${path === 'index.html' ? '' : path}`;
  const common = { root, version, repo: config.repo, image: config.image };
  const content = page.html;
  const pageTitle = page.kind === 'home' ? `Tickory · ${page.title}` : `${page.title} · Tickory`;
  const alternates = [
    `  <link rel="alternate" hreflang="${page.lang}" href="${urlOf(page.lang, page.path)}">`,
    `  <link rel="alternate" hreflang="${other(page.lang)}" href="${urlOf(other(page.lang), page.alt)}">`,
    page.kind === 'home' ? `  <link rel="alternate" hreflang="x-default" href="${opts.url}">` : '',
  ].filter(Boolean).join('\n');
  const body = page.kind === 'home'
    ? `  <main id="inhoud" class="home">\n${content}\n  </main>`
    : [
        '  <div class="wrap guide">',
        guideNav(config, pages, page, t),
        '    <main id="inhoud" class="prose">',
        content,
        pager(config, pages, page, t),
        '    </main>',
        '  </div>',
      ].join('\n');
  const values: Record<string, string> = {
    ...common,
    lang: page.lang,
    alt_lang: other(page.lang),
    page_title: escapeHtml(pageTitle),
    description: escapeHtml(page.description),
    canonical: urlOf(page.lang, page.path),
    site_url: opts.url,
    alternates,
    body_class: page.kind === 'home' ? 'page-home' : 'page-guide',
    page_path: page.path,
    home_url: `${root}${page.lang}/`,
    guide_url: `${root}${page.lang}/${t.guide_index}`,
    guide_current: page.kind === 'guide' ? ' aria-current="true"' : '',
    alt_url: `${root}${other(page.lang)}/${page.alt === 'index.html' ? '' : page.alt}`,
    body,
  };
  for (const [key, text] of Object.entries(t)) values[`t.${key}`] = escapeHtml(text);
  return fill(layout, values, 'website/layout.html');
}

// ---------- de demo: de echte app met een andere backend ----------

const DEMO_BAR = `  <div class="demo-bar" id="demo-bar" role="note">
    <span class="demo-bar-text"><span class="demo-bar-long">Dit is een demo: wijzigingen worden niet bewaard.</span><span class="demo-bar-short">Demo: niets wordt bewaard.</span></span>
    <details class="demo-tips">
      <summary>Tips</summary>
      <div class="demo-tips-body">
        <p>Om te proberen:</p>
        <ul>
          <li>Typ in het veld bovenaan: <code>Tandarts bellen morgen om 9 uur p1</code></li>
          <li>Open <strong>Huishouden</strong>, kies <strong>Gedeeld</strong> en voeg de gebruikersnaam <code>kees</code> toe.</li>
          <li>Vink een taak met een herhaling (↻) af: de datum schuift door naar de volgende keer.</li>
          <li>Herlaad je de pagina, dan begint de demo opnieuw met de voorbeeldgegevens.</li>
        </ul>
      </div>
    </details>
    <a class="demo-bar-link" href="../">Naar de website</a>
  </div>
`;

/**
 * Maakt van client/index.html de pagina van de demo. Het bronbestand blijft ongewijzigd; elke aanpassing wordt
 * gecontroleerd, zodat een wijziging in index.html die hier niet meer bij past het bouwen laat mislukken in plaats van
 * een kapotte demo op te leveren.
 */
export function demoIndex(source: string): string {
  let html = source;
  const change = (what: string, from: RegExp, to: string) => {
    const next = html.replace(from, to);
    if (next === html) throw new Error(`demo: client/index.html is veranderd; kan dit niet meer aanpassen: ${what}`);
    html = next;
  };
  // Absolute paden ("/app.css") worden relatief ("app.css"): de demo staat in een submap van de site.
  change('absolute paden relatief maken', /\b(href|src)="\/(?!\/)([^"]*)"/g, '$1="$2"');
  // De demo is geen installeerbare app en heeft geen service worker.
  change('de verwijzing naar het manifest weghalen', /^[ \t]*<link rel="manifest"[^>]*>\r?\n/m, '');
  change('de regels voor de pagina toevoegen', /(<meta charset="utf-8">\r?\n)/,
    `$1  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">\n  <meta name="robots" content="noindex">\n`);
  change('de titel aanpassen', /<title>Tickory<\/title>/, '<title>Tickory · demo</title>');
  change('de stijl van de balk toevoegen', /(<link rel="stylesheet" href="app\.css">\r?\n)/, '$1  <link rel="stylesheet" href="demo.css">\n');
  change('de balk toevoegen', /(<body>\r?\n)/, `$1${DEMO_BAR}`);
  change('het script van de demo toevoegen', /([ \t]*<script type="module" src="ui\/app\.js"><\/script>)/, '  <script type="module" src="demo.js"></script>\n$1');
  if (/\b(?:href|src)="\//.test(html)) throw new Error('demo: er staat nog een absoluut pad in de pagina');
  return html;
}

function buildDemo(outDir: string): number {
  const clientDir = join(ROOT, 'client');
  // niet mee: tests, de service worker en het manifest (de demo werkt niet offline en is niet te installeren),
  // en de twee bestanden die hieronder een eigen versie krijgen
  const skip = (path: string) => path.endsWith('.test.js') || ['sw.js', 'manifest.webmanifest', 'index.html', 'core/backend.js'].includes(path);
  const files = listFiles(clientDir).filter((p) => !skip(p));
  for (const path of files) cpSync(join(clientDir, ...path.split('/')), join(outDir, 'demo', ...path.split('/')), { recursive: true });
  for (const reserved of ['core/demoSeed.js', 'demo.css', 'demo.js']) {
    if (files.includes(reserved)) throw new Error(`demo: client/${reserved} bestaat; kies een andere naam voor het bestand van de demo`);
  }
  writeOut(outDir, 'demo/index.html', demoIndex(read(join(clientDir, 'index.html'))));
  writeOut(outDir, 'demo/core/backend.js', read(join(SRC, 'demo', 'backend.js')));
  writeOut(outDir, 'demo/core/demoSeed.js', read(join(SRC, 'demo', 'seed.js')));
  writeOut(outDir, 'demo/demo.css', read(join(SRC, 'demo', 'demo.css')));
  writeOut(outDir, 'demo/demo.js', read(join(SRC, 'demo', 'demo.js')));
  // De app importeert "../../shared/…" vanuit core/ en ui/: onder demo/core/ wordt dat de map shared/ naast demo/.
  const shared = listFiles(join(ROOT, 'shared')).filter((p) => p.endsWith('.js') && !p.endsWith('.test.js'));
  for (const path of shared) cpSync(join(ROOT, 'shared', path), join(outDir, 'shared', path));
  return files.length + shared.length + 5;
}

// ---------- alles bij elkaar ----------

function rootIndex(config: SiteConfig, url: string): string {
  const nl = config.languages.nl, en = config.languages.en;
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light dark">
  <title>Tickory</title>
  <meta name="description" content="${escapeHtml(nl.site_description)}">
  <link rel="canonical" href="${url}">
  <link rel="alternate" hreflang="nl" href="${url}nl/">
  <link rel="alternate" hreflang="en" href="${url}en/">
  <meta property="og:title" content="Tickory">
  <meta property="og:description" content="${escapeHtml(en.site_description)}">
  <meta property="og:image" content="${url}assets/social-preview.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="assets/favicon-32.png" sizes="32x32" type="image/png">
  <link rel="icon" href="assets/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="assets/site.css">
  <script src="assets/lang.js"></script>
</head>
<body class="page-choose">
  <main class="choose">
    <img src="assets/logo.svg" alt="" width="72" height="72">
    <h1>Tickory</h1>
    <p lang="nl">${escapeHtml(nl.site_description)}</p>
    <p><a class="button button-primary" href="nl/" lang="nl" hreflang="nl">Nederlands</a></p>
    <p lang="en">${escapeHtml(en.site_description)}</p>
    <p><a class="button" href="en/" lang="en" hreflang="en">English</a></p>
  </main>
</body>
</html>
`;
}

function notFound(config: SiteConfig, base: string): string {
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="noindex">
  <title>Pagina niet gevonden · Tickory</title>
  <link rel="icon" href="${base}assets/logo.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${base}assets/site.css">
</head>
<body class="page-choose">
  <main class="choose">
    <img src="${base}assets/logo.svg" alt="" width="72" height="72">
    <h1>Pagina niet gevonden</h1>
    <p lang="nl">Deze pagina bestaat niet (meer).</p>
    <p><a class="button button-primary" href="${base}nl/" lang="nl" hreflang="nl">Naar de startpagina</a></p>
    <p lang="en">This page does not exist (any more).</p>
    <p><a class="button" href="${base}en/" lang="en" hreflang="en">Go to the home page</a></p>
  </main>
</body>
</html>
`;
}

export function buildSite(options: BuildOptions = {}): { out: string; files: number } {
  const opts: Required<BuildOptions> = {
    out: resolve(options.out ?? join(ROOT, '_site')),
    base: options.base ?? process.env.SITE_BASE ?? '/tickory/',
    url: options.url ?? process.env.SITE_URL ?? 'https://wnijhof.github.io/tickory/',
    pages: options.pages ?? true,
    quiet: options.quiet ?? false,
  };
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(opts.base)) throw new Error(`--base moet met een schuine streep beginnen en eindigen: ${opts.base}`);
  if (!/^https?:\/\/[^\s"<>]+\/$/.test(opts.url)) throw new Error(`--url moet een volledig adres zijn dat op een schuine streep eindigt: ${opts.url}`);
  // Nooit een map leegmaken die niet duidelijk een uitvoermap binnen de repo is.
  const rel = relative(ROOT, opts.out);
  if (!rel || rel.startsWith('..') || rel.split(sep).some((part) => ['website', 'client', 'server', 'shared', 'scripts', '.git', '.github'].includes(part))) {
    throw new Error(`weigert te schrijven naar ${opts.out}: kies een eigen map binnen de repo, zoals _site`);
  }
  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(opts.out, { recursive: true });

  const config = JSON.parse(read(join(SRC, 'site.json'))) as SiteConfig;
  const version = (JSON.parse(read(join(ROOT, 'package.json'))) as { version: string }).version;
  let count = buildDemo(opts.out);

  if (opts.pages) {
    cpSync(join(SRC, 'assets'), join(opts.out, 'assets'), { recursive: true });
    count += listFiles(join(SRC, 'assets')).length;
    const layout = read(join(SRC, 'layout.html'));
    const pages = loadPages(config);
    for (const page of pages) {
      const where = `website/pages/${page.lang}/${page.path}`;
      const root = '../'.repeat(page.path.split('/').length);
      const filled = fill(page.html, { root, version, repo: config.repo, image: config.image }, where);
      page.html = addHeadingIds(expandElements(filled, root, where), where);
    }
    for (const page of pages) writeOut(opts.out, `${page.lang}/${page.path}`, renderPage(config, pages, page, layout, opts, version));
    for (const lang of LANGS) {
      const entries = pages.filter((p) => p.lang === lang && p.kind === 'guide').flatMap(searchEntries);
      writeOut(opts.out, `assets/search-${lang}.json`, JSON.stringify(entries));
    }
    writeOut(opts.out, 'index.html', rootIndex(config, opts.url));
    writeOut(opts.out, '404.html', notFound(config, opts.base));
    // De licenties horen bij wat hier wordt verspreid (de demo bevat de app en de meegebundelde datumherkenner).
    writeOut(opts.out, 'LICENSE.txt', read(join(ROOT, 'LICENSE')));
    writeOut(opts.out, 'THIRD_PARTY_NOTICES.txt', read(join(ROOT, 'THIRD_PARTY_NOTICES.md')));
    count += pages.length + LANGS.length + 4;
  }
  if (!opts.quiet) console.log(`Website gebouwd in ${opts.out} (${count} bestanden${opts.pages ? '' : ', alleen de demo'}).`);
  return { out: opts.out, files: count };
}

if (import.meta.main) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    buildSite({ out: arg('--out'), base: arg('--base'), url: arg('--url'), pages: !process.argv.includes('--demo-only') });
  } catch (err) {
    console.error(`Bouwen mislukt: ${(err as Error).message}`);
    process.exit(1);
  }
}
