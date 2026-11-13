// Het kleurenpalet voor projecten (en labels en filters): het veld `color` van de server bevat een naam, standaard
// "charcoal". Elke naam heeft een kleur voor het lichte en een voor het donkere thema.
//
// De kleuren zelf staan in app.css als klassen `.pc-<naam>` die de eigenschap `--dot` zetten (daar werkt de wisseling
// tussen licht en donker vanzelf, en de Content-Security-Policy staat geen stijlen vanuit script toe). Dit bestand is de
// bron van de lijst; colors.test.js controleert dat app.css precies deze kleuren bevat en dat elke kleur genoeg
// contrast heeft met de achtergrond (3:1, de norm voor pictogrammen en bolletjes).

/** @type {Record<string, { light: string, dark: string }>} */
export const PALETTE = {
  charcoal: { light: '#4a5460', dark: '#a9b3be' },
  red: { light: '#d03a31', dark: '#f0786f' },
  orange: { light: '#d4690a', dark: '#f29a45' },
  amber: { light: '#a97a00', dark: '#e0b030' },
  olive: { light: '#7a8a1a', dark: '#b4c64a' },
  green: { light: '#2b9a45', dark: '#5fcf7a' },
  mint: { light: '#16977f', dark: '#4fd1b4' },
  teal: { light: '#0f8a8c', dark: '#3fc9cc' },
  sky: { light: '#1a8cc4', dark: '#58b8ee' },
  blue: { light: '#3a6fd8', dark: '#7aa2f7' },
  indigo: { light: '#5b57d9', dark: '#9a97f5' },
  violet: { light: '#8a4fd8', dark: '#b88af2' },
  magenta: { light: '#c43aa8', dark: '#ea6fd0' },
  rose: { light: '#d4426e', dark: '#f27a9f' },
  brown: { light: '#8c5a3a', dark: '#c89a78' },
  grey: { light: '#7a8591', dark: '#98a3af' },
};

/** De namen op volgorde van het palet. */
export const COLOR_NAMES = Object.keys(PALETTE);

/** De kleur die een onbekende of ontbrekende naam krijgt; ook de standaard van de server. */
export const DEFAULT_COLOR = 'charcoal';

/** Is dit een naam uit het palet? */
export const isColorName = (name) => typeof name === 'string' && Object.hasOwn(PALETTE, name);

/** De naam die we gebruiken: de eigen naam, of de standaard bij een onbekende (bijvoorbeeld uit een import). */
export const colorName = (name) => (isColorName(name) ? name : DEFAULT_COLOR);

/** De CSS-klasse die `--dot` zet voor deze kleur. */
export const colorClass = (name) => `pc-${colorName(name)}`;

/** De hexwaarde van een kleur in het gegeven thema. */
export const colorHex = (name, theme = 'light') => PALETTE[colorName(name)][theme === 'dark' ? 'dark' : 'light'];
