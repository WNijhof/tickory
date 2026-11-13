// Het kleurenpalet voor projecten: geldige kleuren, genoeg contrast, een nette terugval, en gelijk aan wat app.css toont.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COLOR_NAMES, DEFAULT_COLOR, PALETTE, colorClass, colorHex, colorName, isColorName } from './colors.js';

const css = readFileSync(fileURLToPath(new URL('../app.css', import.meta.url)), 'utf8');
const HEX = /^#[0-9a-f]{6}$/;

const channel = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
const luminance = (hex) => {
  const [r, g, b] = [0, 1, 2].map((i) => channel(hex, i)).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** De waarde van een token (`--bg`) in het eerste blok van app.css dat het zet: licht in `:root`, donker in de mediaquery. */
function token(name, scheme) {
  const rootStart = css.indexOf(':root {');
  const rootEnd = css.indexOf('\n}', rootStart);
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)', rootEnd);
  const darkEnd = css.indexOf('\n}\n', css.indexOf('\n  }', darkStart));
  const block = scheme === 'dark' ? css.slice(darkStart, darkEnd) : css.slice(rootStart, rootEnd);
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  assert.ok(m, `--${name} ontbreekt in het ${scheme}e thema van app.css`);
  return m[1].toLowerCase();
}

test('het palet heeft zestien benoemde kleuren, met "charcoal" als standaard van de server', () => {
  assert.equal(COLOR_NAMES.length, 16);
  assert.equal(new Set(COLOR_NAMES).size, 16);
  assert.equal(DEFAULT_COLOR, 'charcoal');
  assert.ok(COLOR_NAMES.includes('charcoal'));
  for (const name of COLOR_NAMES) assert.match(name, /^[a-z]+$/, 'een naam is gewoon een woord, zoals de server hem bewaart (maximaal 32 tekens)');
});

test('elke naam heeft een geldige kleur voor licht en donker, en geen twee kleuren zijn gelijk', () => {
  for (const [name, { light, dark }] of Object.entries(PALETTE)) {
    assert.match(light, HEX, `${name} licht`);
    assert.match(dark, HEX, `${name} donker`);
    assert.notEqual(light, dark, `${name}: licht en donker zijn gelijk`);
  }
  assert.equal(new Set(Object.values(PALETTE).map((c) => c.light)).size, 16, 'twee namen hebben dezelfde lichte kleur');
  assert.equal(new Set(Object.values(PALETTE).map((c) => c.dark)).size, 16, 'twee namen hebben dezelfde donkere kleur');
});

test('elke kleur heeft genoeg contrast (3:1) met alle achtergronden waar hij op komt, in beide thema\'s', () => {
  for (const scheme of ['light', 'dark']) {
    const backgrounds = ['bg', 'bg-soft', 'bg-hover'].map((n) => token(n, scheme === 'dark' ? 'dark' : 'light'));
    for (const name of COLOR_NAMES) {
      for (const bg of backgrounds) {
        const ratio = contrast(PALETTE[name][scheme], bg);
        assert.ok(ratio >= 3, `${name} (${scheme}) heeft maar ${ratio.toFixed(2)}:1 op ${bg}`);
      }
    }
  }
});

test('onbekende, ontbrekende of vreemde namen vallen netjes terug op de standaardkleur', () => {
  for (const unknown of [undefined, null, '', 'berry_red', 'RED', 'constructor', 'toString', '__proto__', 42, {}, ['red']]) {
    assert.equal(isColorName(unknown), false, String(unknown));
    assert.equal(colorName(unknown), 'charcoal', String(unknown));
    assert.equal(colorClass(unknown), 'pc-charcoal', String(unknown));
    assert.equal(colorHex(unknown), PALETTE.charcoal.light, String(unknown));
  }
  for (const name of COLOR_NAMES) {
    assert.equal(isColorName(name), true);
    assert.equal(colorName(name), name);
    assert.equal(colorClass(name), `pc-${name}`);
  }
  assert.equal(colorHex('red', 'dark'), PALETTE.red.dark);
  assert.equal(colorHex('red', 'light'), PALETTE.red.light);
  assert.equal(colorHex('red', 'anders'), PALETTE.red.light, 'een onbekend thema is licht');
});

test('app.css toont precies dit palet: een klasse per kleur, licht en donker', () => {
  const darkBlock = css.slice(css.indexOf('/* palet-donker */'), css.indexOf('/* einde-palet */'));
  const lightBlock = css.slice(css.indexOf('/* palet-licht */'), css.indexOf('/* palet-donker */'));
  assert.ok(lightBlock.length > 100 && darkBlock.length > 100, 'de blokken met het palet ontbreken in app.css');
  const read = (block) => Object.fromEntries([...block.matchAll(/\.pc-([a-z]+)\s*\{\s*--dot:\s*(#[0-9a-fA-F]{6});\s*\}/g)].map((m) => [m[1], m[2].toLowerCase()]));
  assert.deepEqual(read(lightBlock), Object.fromEntries(COLOR_NAMES.map((n) => [n, PALETTE[n].light])));
  assert.deepEqual(read(darkBlock), Object.fromEntries(COLOR_NAMES.map((n) => [n, PALETTE[n].dark])));
});
