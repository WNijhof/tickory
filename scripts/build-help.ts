// Bouwt de handleiding voor in de app (Instellingen › Handleiding): dezelfde pagina's als de handleiding op de website
// (website/pages, website/site.json), zodat er maar één tekst is om bij te houden. Per taal één bestand in client/help/
// (nl.js, en.js), dat de app pas laadt als je de handleiding opent, en dat de service worker bewaart (ook offline te lezen).
//
//   node scripts/build-help.ts          schrijft client/help/nl.js en client/help/en.js
//
// Verschillen met de website:
//   - geen schermafbeeldingen (<x-shot>): die staan op de website; de app zelf is er al;
//   - een link naar een andere pagina van de handleiding wordt een plek in de app (#help=herinneringen, met een kop erachter
//     #help=herinneringen~snel-toevoegen-met); een link naar elders op de website (de demo, de startpagina) gaat naar de website;
//   - de rest (de teksten van knoppen uit de app met <x-ui>, de koppen met een id) gaat precies zoals bij de website.
// client/core/help.test.js controleert dat de bestanden bij de pagina's passen: pas je een pagina aan, draai dan dit script.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addHeadingIds, expandElements, fill, loadPages, type Lang, type SiteConfig } from './build-site.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SITE_URL = 'https://wnijhof.github.io/tickory/';

export interface HelpPage { title: string; description: string; html: string; site: string }
export interface HelpData { lang: Lang; version: string; groups: { title: string; pages: string[] }[]; pages: Record<string, HelpPage> }

/** De naam van een pagina in de app: de bestandsnaam zonder .html ("handleiding/herinneringen.html" → "herinneringen"). */
export const slugOf = (path: string): string => posix.basename(path, '.html');

/** De handleiding in één taal, zoals de app hem toont. */
export function helpData(lang: Lang): HelpData {
  const config = JSON.parse(readFileSync(join(ROOT, 'website', 'site.json'), 'utf8')) as SiteConfig;
  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  const pages = loadPages(config).filter((p) => p.lang === lang && p.kind === 'guide');
  const known = new Map(pages.map((p) => [p.path, slugOf(p.path)]));
  const out: Record<string, HelpPage> = {};
  for (const page of pages) {
    const where = `website/pages/${lang}/${page.path}`;
    const pageUrl = `${SITE_URL}${lang}/${page.path}`;
    const root = `${SITE_URL}`; // {{root}}: verwijzingen naar de website zelf worden volledige adressen
    const withoutShots = page.html.replace(/<x-shot\b[\s\S]*?<\/x-shot>\s*/g, '');
    let html = addHeadingIds(expandElements(fill(withoutShots, { root, version, repo: config.repo, image: config.image }, where), root, where, lang), where);
    html = html.replace(/<a\s+href="([^"]*)"/g, (_all, href: string) => `<a href="${appHref(href, page.path, known, pageUrl)}"${external(href) ? ' target="_blank" rel="noopener"' : ''}`);
    html = html.replace(/\n{3,}/g, '\n\n').trim();
    out[slugOf(page.path)] = { title: page.title, description: page.description, html, site: pageUrl };
  }
  const groups = config.guide.map((g) => ({ title: g.group[lang], pages: g.pages.map((ref) => slugOf(ref[lang])) }));
  return { lang, version, groups, pages: out };
}

const external = (href: string): boolean => /^https?:\/\//.test(href) || (!href.startsWith('#') && !/^[a-z0-9-]+\.html(#[^"]*)?$/.test(href));

/** Waar een link in de app heen gaat: een pagina van de handleiding wordt een plek in de app, de rest een volledig adres. */
function appHref(href: string, from: string, known: Map<string, string>, pageUrl: string): string {
  if (/^(https?:|mailto:)/.test(href)) return href;
  if (href.startsWith('#')) return `#help=${slugOf(from)}~${href.slice(1)}`;
  const [path, anchor] = href.split('#');
  const target = posix.normalize(posix.join(posix.dirname(from), path));
  const slug = known.get(target);
  if (slug) return `#help=${slug}${anchor ? `~${anchor}` : ''}`;
  return new URL(href, pageUrl).href; // de startpagina, de demo, een bestand op de website
}

/** De inhoud van client/help/<taal>.js. */
export function helpModule(lang: Lang): string {
  return `// Gemaakt door scripts/build-help.ts uit de handleiding van de website (website/pages/${lang}). Niet zelf bewerken.\nexport default ${JSON.stringify(helpData(lang), null, 1)};\n`;
}

if (import.meta.main) {
  mkdirSync(join(ROOT, 'client', 'help'), { recursive: true });
  for (const lang of ['nl', 'en'] as const) {
    const file = join(ROOT, 'client', 'help', `${lang}.js`);
    writeFileSync(file, helpModule(lang));
    console.log(`${file}: ${Object.keys(helpData(lang).pages).length} pagina's`);
  }
}
