// De instellingen van de desktop-app (niet die van je account: die staan op de server), in settings.json in de gebruikersmap van de app.
// Zoals Todoist: sneltoetsen (Tickory tonen: Win+Alt+S, Taak toevoegen: Ctrl+Spatie), in het systeemvak blijven draaien, opstarten
// met Windows (eventueel geminimaliseerd), zwevend op de voorgrond, waar het venster stond, en het thema (zie appearance.mjs).
import { appearanceOf } from './appearance.mjs';
import { inboxStateOf } from './inboxPlan.mjs';

export const DEFAULT_SHORTCUTS = Object.freeze({ activate: 'Super+Alt+S', quickAdd: 'Control+Space' });

export const DEFAULTS = Object.freeze({
  server: null,
  shortcuts: DEFAULT_SHORTCUTS,
  stayInTray: true,
  openAtLogin: false,
  startMinimized: false,
  floatOnTop: false,
  zoom: 0,
  bounds: null,
  lang: null,
  appearance: null,
  shown: Object.freeze([]),
  snoozes: Object.freeze([]),
  // welke meldingen bij samenwerken de app al kent en welke er in beeld staan (zie inboxPlan.mjs)
  inbox: null,
});

const MAX_SHOWN = 500;
const ACCELERATOR = /^(?:(?:Control|Ctrl|CommandOrControl|Alt|Shift|Super|Meta)\+){1,3}(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Plus|Minus)$/;

/** Is dit een sneltoets die Electron kent, met minstens één toets als Ctrl of Alt ervoor? Een lege tekst = uit. */
export const validShortcut = (s) => s === '' || (typeof s === 'string' && ACCELERATOR.test(s));

// de schrijfwijze die Electron kent, bij elke schrijfwijze die je intypt ("ctrl+shift+a", "control + space")
const CANONICAL = new Map(['Control', 'Ctrl', 'CommandOrControl', 'Alt', 'Shift', 'Super', 'Meta', 'Space', 'Tab', 'Enter', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Plus', 'Minus'].map((k) => [k.toLowerCase(), k]));

/**
 * Een getypte sneltoets in de schrijfwijze van Electron (hoofdletters zoals Electron ze kent, spaties weg), of null als het geen
 * geldige sneltoets is. Een lege tekst blijft leeg (= uit).
 */
export function normalizeShortcut(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (s === '') return '';
  const parts = s.split('+').map((p) => p.trim());
  const out = parts.map((p) => CANONICAL.get(p.toLowerCase()) ?? (/^[a-z0-9]$/i.test(p) ? p.toUpperCase() : /^f\d{1,2}$/i.test(p) ? p.toUpperCase() : p)).join('+');
  return validShortcut(out) ? out : null;
}

const bounds = (b) => (b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 400 && b.height >= 300 ? { x: b.x, y: b.y, width: b.width, height: b.height, maximized: b.maximized === true } : null);

/** De instellingen uit wat er bewaard was, aangevuld met de standaard; iets kapots wordt de standaard. */
export function settingsOf(raw) {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sc = v.shortcuts && typeof v.shortcuts === 'object' ? v.shortcuts : {};
  return {
    server: typeof v.server === 'string' && v.server.length < 300 ? v.server : null,
    shortcuts: {
      activate: validShortcut(sc.activate) ? sc.activate : DEFAULT_SHORTCUTS.activate,
      quickAdd: validShortcut(sc.quickAdd) ? sc.quickAdd : DEFAULT_SHORTCUTS.quickAdd,
    },
    stayInTray: typeof v.stayInTray === 'boolean' ? v.stayInTray : DEFAULTS.stayInTray,
    openAtLogin: v.openAtLogin === true,
    startMinimized: v.startMinimized === true,
    floatOnTop: v.floatOnTop === true,
    zoom: Number.isInteger(v.zoom) && v.zoom >= -5 && v.zoom <= 5 ? v.zoom : 0,
    bounds: bounds(v.bounds),
    lang: v.lang === 'nl' || v.lang === 'en' ? v.lang : null,
    appearance: appearanceOf(v.appearance), // null: nog niets gekozen (dan volgt de app de web-app)
    shown: Array.isArray(v.shown) ? v.shown.filter((x) => typeof x === 'string' && x.length < 200).slice(-MAX_SHOWN) : [],
    snoozes: Array.isArray(v.snoozes) ? v.snoozes.filter(validSnooze).slice(-MAX_SNOOZES) : [],
    inbox: inboxStateOf(v.inbox),
  };
}

const MAX_SNOOZES = 50;
const SNOOZE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const validSnooze = (s) => Boolean(s && typeof s === 'object' && SNOOZE_ID.test(s.id ?? '') && SNOOZE_ID.test(s.taskId ?? '')
  && (s.reminderId === null || SNOOZE_ID.test(s.reminderId ?? '')) && Number.isFinite(s.at));

/**
 * Een uitgestelde herinnering (Uitstellen in een melding): alleen op deze pc, zoals op Android. Er komt geen herinnering op de server
 * bij, dus hij gaat niet ook op de telefoon of in de browser af. Een eerdere uitstel van dezelfde herinnering vervalt.
 */
export function addSnooze(settings, { id, taskId, reminderId = null, at }) {
  const entry = { id, taskId, reminderId, at };
  if (!validSnooze(entry)) return settings;
  const rest = settings.snoozes.filter((s) => !(s.taskId === taskId && s.reminderId === reminderId));
  return { ...settings, snoozes: [...rest, entry].slice(-MAX_SNOOZES) };
}

export const removeSnooze = (settings, id) => ({ ...settings, snoozes: settings.snoozes.filter((s) => s.id !== id) });

/** Onthoud dat deze melding (herinnering|moment) getoond is; de oudste vallen eraf. */
export function markShown(settings, key) {
  const shown = settings.shown.filter((k) => k !== key);
  shown.push(key);
  return { ...settings, shown: shown.slice(-MAX_SHOWN) };
}

/** Een bewaard bestand inlezen (via [read], die de tekst of null geeft). */
export function loadSettings(read) {
  try {
    const text = read();
    return settingsOf(text ? JSON.parse(text) : null);
  } catch {
    return settingsOf(null);
  }
}
