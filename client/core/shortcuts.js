// Sneltoetsen met één toets of twee na elkaar: `q` een taak toevoegen, `g` en dan `t`, `u` of `i` om naar Vandaag, Binnenkort
// of de Inbox te gaan, en `?` voor het overzicht. De toetsen werken alleen als je niet in een invoerveld zit en er geen venster
// open is. `/` en Ctrl+K laten we vrij: die zijn bedoeld voor zoeken.
//
// Dit bestand kent de pagina niet: `handle(event)` krijgt een toetsaanslag (key, ctrlKey, metaKey, altKey, shiftKey en target)
// en geeft true terug als de toets is afgehandeld (de aanroeper roept dan preventDefault aan). Zo is het te testen zonder browser.

/** Hoe lang `g` blijft wachten op de tweede toets. */
export const CHORD_MS = 1500;

/** De toetsen die je indrukt, per sneltoets. Het overzicht (ui/shortcutsDialog.js) toont ze; de test controleert dat ze werken. */
export const SHORTCUT_KEYS = {
  add: ['q'],
  today: ['g', 't'],
  upcoming: ['g', 'u'],
  inbox: ['g', 'i'],
  help: ['?'],
};

/** Invoervelden waar je tekst typt (een selectievakje of knop houdt de sneltoetsen niet tegen). */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'time', 'month', 'week']);

/** Typt de gebruiker hier tekst (of kiest hij uit een lijst), dan horen toetsen bij dat veld en niet bij de app. */
export function isTyping(target) {
  if (!target) return false;
  const tag = String(target.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(String(target.type ?? 'text').toLowerCase());
  return Boolean(target.isContentEditable);
}

/**
 * @param {{
 *   addTask: () => void, goToday: () => void, goUpcoming: () => void, goInbox: () => void, showHelp: () => void,
 *   blocked?: () => boolean,        // true als een venster open staat: dan doen de toetsen niets
 *   now?: () => number,
 * }} options
 * @returns {{ handle: (event: { key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, target?: object }) => boolean, reset: () => void }}
 */
export function createShortcuts({ addTask, goToday, goUpcoming, goInbox, showHelp, blocked = () => false, now = () => Date.now() }) {
  let pendingSince = null; // het moment waarop `g` is ingedrukt, of null

  const reset = () => { pendingSince = null; };

  function handle(event) {
    const key = typeof event.key === 'string' && event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) || blocked()) {
      reset();
      return false;
    }
    if (pendingSince !== null) {
      const waiting = now() - pendingSince <= CHORD_MS;
      reset();
      const target = waiting ? { t: goToday, u: goUpcoming, i: goInbox }[key] : undefined;
      if (target) {
        target();
        return true;
      }
      // een andere toets na `g`: die telt gewoon mee (ook een nieuwe `g`)
    }
    switch (key) {
      case 'q': addTask(); return true;
      case 'g': pendingSince = now(); return true;
      case '?': showHelp(); return true;
      default: return false; // onder meer `/` en `k`: gereserveerd voor zoeken
    }
  }

  return { handle, reset };
}
