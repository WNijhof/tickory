// Het thema van de desktop-app, zoals in de Android-app: dezelfde keuze als in de web-app (Instellingen › Thema: zoals het
// apparaat, licht of donker, en een accentkleur). De web-app geeft haar keuze door aan de desktop-app; die zet
// dan Windows zelf om (titelbalk, menu's, de achtergrond van de vensters) en geeft de keuze door aan de andere vensters (het venster
// Taak toevoegen). In de eigen Instellingen van de app is het thema ook te kiezen; dan gaat het andersom.
import { ACCENTS, DEFAULT_ACCENT, THEMES, isDark } from '../shared/theme.js';

export { ACCENTS, DEFAULT_ACCENT, THEMES };

/** De achtergrond van de web-app (client/app.css --bg), licht en donker: zo flitst er bij openen niets wit of zwart. */
export const BACKGROUND = Object.freeze({ light: '#ffffff', dark: '#202020' });

/** Een geldige keuze, of null als er niets bruikbaars is. */
export function appearanceOf(raw) {
  if (!raw || typeof raw !== 'object' || !THEMES.includes(raw.theme)) return null;
  return { theme: raw.theme, accent: ACCENTS.some((a) => a.name === raw.accent) ? raw.accent : DEFAULT_ACCENT };
}

export const sameAppearance = (a, b) => Boolean(a && b && a.theme === b.theme && a.accent === b.accent);

/** De standaard (zoals het apparaat, Zeegroen) als er nog niets gekozen is. */
export const appearanceOrDefault = (a) => appearanceOf(a) ?? { theme: 'system', accent: DEFAULT_ACCENT };

/** De achtergrond van een venster bij dit thema; bij "zoals het apparaat" volgt hij Windows. */
export const backgroundOf = (theme, systemDark) => (isDark(theme, systemDark) ? BACKGROUND.dark : BACKGROUND.light);

/**
 * Wat er gebeurt als een venster van de web-app zijn keuze doorgeeft. Bij het opstarten (`initial`) wint wat de desktop-app al
 * bewaarde (gekozen in de eigen Instellingen terwijl de web-app dicht was): dan krijgt dat venster de bewaarde keuze terug. Wist
 * de app nog niets (een installatie van vóór deze versie), dan neemt hij de keuze van de web-app over.
 * @returns {{ save: object | null, reply: object | null }} save: bewaren, toepassen en aan de andere vensters geven; reply: terug naar dit venster
 */
export function fromWeb(stored, sent, initial) {
  const next = appearanceOf(sent);
  const known = appearanceOf(stored);
  if (!next) return { save: null, reply: null };
  if (initial && known) return { save: null, reply: sameAppearance(known, next) ? null : known };
  return { save: sameAppearance(known, next) ? null : next, reply: null };
}
