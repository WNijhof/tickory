// Bewaakt de opmaak van zoeken, filters en labels (client/search.css) en de bouwregels voor die onderdelen:
// genoeg contrast van de tekst op de achtergronden waar ze op staan (licht en donker), geen externe bestanden,
// en geen HTML uit tekst in de nieuwe schermen (alles via createElement).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const clientDir = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(`${clientDir}${path}`, 'utf8');
const app = read('app.css');
const find = read('search.css');

const channel = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => 0.2126 * lin(channel(hex, 0)) + 0.7152 * lin(channel(hex, 1)) + 0.0722 * lin(channel(hex, 2));
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** Menging in sRGB, zoals `color-mix(in srgb, a p%, b)` het doet. */
const mix = (a, percent, b) => `#${[0, 1, 2].map((i) => Math.round(channel(a, i) * percent / 100 + channel(b, i) * (1 - percent / 100)).toString(16).padStart(2, '0')).join('')}`;

/** De waarde van een kleur-token in het lichte of donkere thema: eerst in search.css, dan in app.css. */
function token(name, scheme) {
  for (const css of [find, app]) {
    const rootStart = css.indexOf(':root {');
    const rootEnd = css.indexOf('\n}', rootStart);
    const darkStart = css.indexOf('@media (prefers-color-scheme: dark)', rootEnd);
    const darkEnd = css.indexOf('\n  }', darkStart);
    const block = scheme === 'dark' ? css.slice(darkStart, darkEnd) : css.slice(rootStart, rootEnd);
    const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    if (m) return m[1].toLowerCase();
  }
  throw new Error(`--${name} ontbreekt in het ${scheme}e thema`);
}

test('de markering van gevonden woorden heeft genoeg contrast (4,5:1), licht en donker', () => {
  for (const scheme of ['light', 'dark']) {
    const ratio = contrast(token('mark-text', scheme), token('mark', scheme));
    assert.ok(ratio >= 4.5, `markering (${scheme}): ${ratio.toFixed(2)}:1`);
  }
});

test('de tekst in zoekresultaten, lijsten en meldingen heeft genoeg contrast op de achtergronden waar hij op staat', () => {
  const problems = [];
  const check = (what, fg, bg, scheme, min = 4.5) => {
    const ratio = contrast(fg, bg);
    if (ratio < min) problems.push(`${what} (${scheme}): ${ratio.toFixed(2)}:1`);
  };
  for (const scheme of ['light', 'dark']) {
    const t = (name) => token(name, scheme);
    // de gekozen treffer en de gekozen regel in de zijbalk staan op --accent-soft
    for (const fg of ['text', 'text-soft', 'future', 'accent']) check(`${fg} op de gekozen regel`, t(fg), t('accent-soft'), scheme);
    // uitleg onder een treffer, kopjes in de zijbalk, aantallen
    for (const bg of ['bg', 'bg-soft', 'bg-hover']) {
      for (const fg of ['text-soft', 'danger', 'warn', 'ok', 'accent', 'future']) check(`${fg} op ${bg}`, t(fg), t(bg), scheme);
    }
    // de foutmelding bij een filter staat op een licht gekleurd vlak van --danger in --bg
    const errorBg = mix(t('danger'), 7, t('bg'));
    check('danger op het vlak van een filterfout', t('danger'), errorBg, scheme);
    check('text op het vlak van een filterfout', t('text'), errorBg, scheme);
    check('text-soft op het vlak van een filterfout', t('text-soft'), errorBg, scheme);
    // een favoriet filter of label in het overzicht
    check('warn (ster) op bg', t('warn'), t('bg'), scheme, 3);
  }
  assert.deepEqual(problems, []);
});

test('geen externe bestanden: alleen eigen stijlen, geen @import en geen url() naar buiten', () => {
  assert.doesNotMatch(find, /@import/);
  assert.doesNotMatch(find, /url\(/);
  assert.doesNotMatch(find, /https?:\/\//);
  const html = read('index.html');
  assert.match(html, /<link rel="stylesheet" href="\/search\.css">/);
  assert.ok(html.indexOf('/app.css') < html.indexOf('/search.css'), 'search.css komt na app.css, dan wint hij bij gelijke regels');
});

test('de nieuwe schermen bouwen alles met createElement: nooit HTML uit tekst', () => {
  const files = ['searchDialog.js', 'labelDialog.js', 'filterDialog.js', 'filterHelp.js', 'find.js', 'findViews.js'].map((name) => `ui/${name}`);
  for (const file of files) {
    const source = read(file).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|\beval\(|new Function\(/, file);
  }
});

test('de zoekopmaak werkt op een telefoon: een venster over het hele scherm en tikvlakken van minstens 44 px', () => {
  const phone = find.slice(find.indexOf('@media (max-width: 760px)'));
  assert.match(phone, /\.dialog-search \{[^}]*height: 100dvh/);
  assert.match(phone, /\.search-input \{[^}]*min-height: 48px/);
  assert.match(phone, /\.find-item[^{]*\{[^}]*min-height: 46px/);
  assert.match(phone, /\.icon-button\.topbar-search \{ display: inline-flex/);
  assert.match(find, /\.icon-button\.topbar-search \{ display: none/, 'op een breed scherm staat de zoekknop in de zijbalk, niet ook in de kop');
});
