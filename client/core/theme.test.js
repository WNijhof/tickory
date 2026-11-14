import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACCENTS, ACCENT_KEY, DEFAULT_ACCENT, THEME_KEY, applyAppearance, darkMediaRules, isDark, readAppearance, saveAppearance } from './theme.js';

const css = readFileSync(fileURLToPath(new URL('../app.css', import.meta.url)), 'utf8');

// ---------- contrast (WCAG) ----------
const lum = (hex) => {
  const c = [0, 1, 2].map((i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const blockOf = (selector, dark) => {
  // licht: het blok buiten een mediaquery; donker: het blok binnen het donkere accentblok
  const start = dark ? css.indexOf('/* accent-donker */') : css.indexOf('/* accent-licht */');
  const end = dark ? css.indexOf('/* einde-accent */') : css.indexOf('/* accent-donker */');
  const part = css.slice(start, end);
  const at = part.indexOf(selector);
  assert.ok(at >= 0, `${selector} ontbreekt (${dark ? 'donker' : 'licht'})`);
  return part.slice(at, part.indexOf('}', at));
};
const tokenIn = (block, name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  assert.ok(m, `--${name} ontbreekt in ${block.slice(0, 40)}`);
  return m[1].toLowerCase();
};
const BG = { light: '#ffffff', dark: '#16191c' };
const SOFT_BG = { light: '#f6f7f8', dark: '#1e2226' };
const TEXT = { light: '#1c1f23', dark: '#e8eaed' };

test('elke accentkleur staat in app.css (licht en donker) met dezelfde hoofdkleur als in theme.js', () => {
  for (const a of ACCENTS.slice(1)) {
    assert.equal(tokenIn(blockOf(`[data-accent="${a.name}"]`, false), 'accent'), a.light, a.name);
    assert.equal(tokenIn(blockOf(`[data-accent="${a.name}"]`, true), 'accent'), a.dark, a.name);
  }
  // de standaard (teal) is wat :root al zegt
  assert.match(css, new RegExp(`--accent: ${ACCENTS[0].light};`));
  assert.match(css, new RegExp(`--accent: ${ACCENTS[0].dark};`));
});

test('elke accentkleur heeft genoeg contrast: knoppen, tekst op de knop, en de zachte achtergrond met gewone tekst', () => {
  for (const a of ACCENTS.slice(1)) {
    for (const scheme of ['light', 'dark']) {
      const block = blockOf(`[data-accent="${a.name}"]`, scheme === 'dark');
      const accent = tokenIn(block, 'accent');
      const soft = tokenIn(block, 'accent-soft');
      const onAccent = tokenIn(block, 'accent-text');
      const where = `${a.name} ${scheme}`;
      assert.ok(contrast(accent, BG[scheme]) >= 4.5, `${where}: accent op de achtergrond ${contrast(accent, BG[scheme]).toFixed(2)}`);
      assert.ok(contrast(accent, SOFT_BG[scheme]) >= 3, `${where}: accent op de zachte achtergrond`);
      assert.ok(contrast(onAccent, accent) >= 4.5, `${where}: tekst op een knop ${contrast(onAccent, accent).toFixed(2)}`);
      assert.ok(contrast(TEXT[scheme], soft) >= 4.5, `${where}: tekst op accent-soft`);
      assert.ok(contrast(accent, soft) >= 3, `${where}: accent op accent-soft`);
    }
  }
});

// ---------- opslag ----------
const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

test('readAppearance/saveAppearance: geldige keuzes bewaren, de standaard weghalen, onzin wordt de standaard', () => {
  const s = memory();
  assert.deepEqual(readAppearance(s), { theme: 'system', accent: DEFAULT_ACCENT });
  saveAppearance({ theme: 'dark', accent: 'rose' }, s);
  assert.deepEqual(readAppearance(s), { theme: 'dark', accent: 'rose' });
  saveAppearance({ theme: 'system', accent: DEFAULT_ACCENT }, s);
  assert.equal(s.m.size, 0, 'de standaard staat niet in de opslag');
  s.setItem(THEME_KEY, 'paars');
  s.setItem(ACCENT_KEY, '<script>');
  assert.deepEqual(readAppearance(s), { theme: 'system', accent: DEFAULT_ACCENT });
  saveAppearance({ theme: 'dark', accent: 'green' }, s);
  saveAppearance({ theme: 'paars', accent: 'x' }, s);
  assert.equal(s.getItem(THEME_KEY), 'dark', 'een ongeldige keuze wordt niet bewaard (de oude waarde blijft)');
  assert.equal(s.getItem(ACCENT_KEY), 'green');
  const broken = { getItem() { throw new Error('geblokkeerd'); }, setItem() { throw new Error('geblokkeerd'); }, removeItem() { throw new Error('geblokkeerd'); } };
  assert.deepEqual(readAppearance(broken), { theme: 'system', accent: DEFAULT_ACCENT });
  assert.doesNotThrow(() => saveAppearance({ theme: 'dark', accent: 'rose' }, broken));
  assert.deepEqual(readAppearance(undefined), { theme: 'system', accent: DEFAULT_ACCENT });
});

// ---------- toepassen op een nagebootst document ----------
function fakeDoc() {
  const mediaRule = (text, inner = []) => ({ media: { mediaText: text }, cssRules: inner });
  const darkTop = mediaRule('(prefers-color-scheme: dark)');
  const darkNested = mediaRule('(prefers-color-scheme:   dark)');
  const wide = mediaRule('(min-width: 900px)', [darkNested]);
  const print = mediaRule('print');
  const plain = { selectorText: ':root' };
  const meta = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const root = { dataset: {}, style: {} };
  const crossOrigin = { get cssRules() { throw new Error('SecurityError'); } };
  return {
    darkTop, darkNested, print, meta, root,
    documentElement: root,
    styleSheets: [{ cssRules: [plain, darkTop, wide, print] }, crossOrigin],
    querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? meta : null),
  };
}

test('applyAppearance: donker zet alle donkere blokken altijd aan, licht nooit, systeem zet ze terug', () => {
  const doc = fakeDoc();
  assert.equal(darkMediaRules(doc).length, 2, 'ook het geneste blok, niet de andere mediaquery\'s; een vreemde stylesheet wordt overgeslagen');
  applyAppearance(doc, { theme: 'dark', accent: 'rose' }, false);
  assert.equal(doc.darkTop.media.mediaText, 'all');
  assert.equal(doc.darkNested.media.mediaText, 'all');
  assert.equal(doc.print.media.mediaText, 'print', 'andere mediaquery\'s blijven');
  assert.deepEqual(doc.root.dataset, { theme: 'dark', accent: 'rose' });
  assert.equal(doc.root.style.colorScheme, 'dark');
  assert.equal(doc.meta.attrs.content, '#f9a8c9');
  applyAppearance(doc, { theme: 'light', accent: 'rose' }, true);
  assert.equal(doc.darkTop.media.mediaText, 'not all');
  assert.equal(doc.meta.attrs.content, '#be185d', 'licht, ook al staat het apparaat donker');
  assert.equal(doc.root.style.colorScheme, 'light');
  applyAppearance(doc, { theme: 'system', accent: DEFAULT_ACCENT }, true);
  assert.equal(doc.darkTop.media.mediaText, '(prefers-color-scheme: dark)');
  assert.equal(doc.darkNested.media.mediaText, '(prefers-color-scheme:   dark)');
  assert.deepEqual(doc.root.dataset, {});
  assert.equal(doc.root.style.colorScheme, '');
  assert.equal(doc.meta.attrs.content, ACCENTS[0].dark, 'systeem en het apparaat staat donker');
  applyAppearance(doc, { theme: 'system', accent: DEFAULT_ACCENT }, false);
  assert.equal(doc.meta.attrs.content, ACCENTS[0].light);
});

test('isDark', () => {
  assert.equal(isDark('dark', false), true);
  assert.equal(isDark('light', true), false);
  assert.equal(isDark('system', true), true);
  assert.equal(isDark('system', false), false);
});
