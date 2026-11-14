// Weergave: thema (systeem, licht, donker) en accentkleur, per apparaat bewaard (je telefoon donker, je pc licht).
//
// Het donkere thema staat in de css in blokken `@media (prefers-color-scheme: dark)`. Kies je zelf licht of donker, dan zet
// deze module de voorwaarde van die blokken om (`all` = altijd, `not all` = nooit) in plaats van alle kleuren nog eens apart
// te herhalen. Dat gaat via het CSSOM, dat de inhoudsbeleid-regel (CSP, `style-src 'self'`) toestaat. Systeem zet ze terug.
// De accentkleuren staan in app.css als `:root[data-accent="…"]` (licht en donker), gecontroleerd door core/theme.test.js.

export const THEME_KEY = 'tickory.theme';
export const ACCENT_KEY = 'tickory.accent';
export const THEMES = ['system', 'light', 'dark'];

/** De accentkleuren, met de hoofdkleur in licht en donker (ook voor de kleur van de adresbalk). De eerste is de standaard. */
export const ACCENTS = [
  { name: 'teal', light: '#0f766e', dark: '#2dd4bf' },
  { name: 'blue', light: '#1d5fd1', dark: '#7aa7ff' },
  { name: 'indigo', light: '#4f46e5', dark: '#a5b4fc' },
  { name: 'violet', light: '#7c3aed', dark: '#c4a7ff' },
  { name: 'rose', light: '#be185d', dark: '#f9a8c9' },
  { name: 'orange', light: '#b45309', dark: '#fdba74' },
  { name: 'green', light: '#15803d', dark: '#6ee7a0' },
  { name: 'graphite', light: '#374151', dark: '#cbd5e1' },
];
export const DEFAULT_ACCENT = ACCENTS[0].name;

const DARK_QUERY = 'prefers-color-scheme: dark';
const original = new WeakMap(); // de oorspronkelijke voorwaarde van elk donker blok

/** De gekozen weergave uit de opslag van dit apparaat; onbekende of ontbrekende waarden worden de standaard. */
export function readAppearance(storage = globalThis.localStorage) {
  let theme = null;
  let accent = null;
  try {
    theme = storage?.getItem(THEME_KEY) ?? null;
    accent = storage?.getItem(ACCENT_KEY) ?? null;
  } catch { /* opslag geblokkeerd (privévenster): de standaard */ }
  return {
    theme: THEMES.includes(theme) ? theme : 'system',
    accent: ACCENTS.some((a) => a.name === accent) ? accent : DEFAULT_ACCENT,
  };
}

/** Bewaart de keuze op dit apparaat (de standaard wordt niet bewaard maar weggehaald). */
export function saveAppearance({ theme, accent }, storage = globalThis.localStorage) {
  try {
    if (theme === 'system') storage?.removeItem(THEME_KEY);
    else if (THEMES.includes(theme)) storage?.setItem(THEME_KEY, theme);
    if (accent === DEFAULT_ACCENT) storage?.removeItem(ACCENT_KEY);
    else if (ACCENTS.some((a) => a.name === accent)) storage?.setItem(ACCENT_KEY, accent);
  } catch { /* niet te bewaren: dan alleen voor nu */ }
}

/** Alle `@media (prefers-color-scheme: dark)`-blokken in de eigen stylesheets (ook in een geneste @media of @supports). */
export function darkMediaRules(doc) {
  const out = [];
  const walk = (rules) => {
    for (const rule of rules ?? []) {
      if (rule.media && rule.cssRules) {
        const text = original.get(rule) ?? rule.media.mediaText;
        if (text.replace(/\s+/g, ' ').includes(DARK_QUERY)) {
          if (!original.has(rule)) original.set(rule, text);
          out.push(rule);
        }
        walk(rule.cssRules);
      } else if (rule.cssRules) {
        walk(rule.cssRules);
      }
    }
  };
  for (const sheet of doc.styleSheets ?? []) {
    let rules = null;
    try {
      rules = sheet.cssRules; // een stylesheet van een andere herkomst is niet te lezen: overslaan
    } catch {
      continue;
    }
    walk(rules);
  }
  return out;
}

/** Is het nu donker? Bij "systeem" volgt dat het apparaat. */
export function isDark(theme, prefersDark) {
  return theme === 'dark' || (theme === 'system' && Boolean(prefersDark));
}

/**
 * Past de weergave toe op het document: de donkere blokken aan, uit of terug naar het systeem, `data-theme`/`data-accent` op
 * de html, `color-scheme` (formuliervelden en schuifbalken) en de kleur van de adresbalk.
 * @param {Document} doc
 * @param {{ theme: string, accent: string }} appearance
 * @param {boolean} [prefersDark] of het apparaat zelf donker staat
 */
export function applyAppearance(doc, { theme, accent }, prefersDark = globalThis.matchMedia?.(`(${DARK_QUERY})`).matches ?? false) {
  for (const rule of darkMediaRules(doc)) {
    const next = theme === 'dark' ? 'all' : theme === 'light' ? 'not all' : original.get(rule);
    if (rule.media.mediaText !== next) rule.media.mediaText = next;
  }
  const root = doc.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (accent === DEFAULT_ACCENT) delete root.dataset.accent;
  else root.dataset.accent = accent;
  root.style.colorScheme = theme === 'system' ? '' : theme;
  const color = ACCENTS.find((a) => a.name === accent) ?? ACCENTS[0];
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isDark(theme, prefersDark) ? color.dark : color.light);
}
