// De emoji van de emoji-kiezer (ui/emojiPicker.js): een vaste, korte selectie per groep, met een Nederlandse en een Engelse naam
// (voor zoeken en voor schermlezers). Geen bibliotheek en geen afbeeldingen: de emoji komen uit het lettertype van het apparaat.
// Je laatst gebruikte emoji onthoudt de app per apparaat (localStorage, `tickory.emoji.recent`).

/** @typedef {{ id: string, nl: string, en: string, items: [string, string, string][] }} EmojiGroup */

/** @type {EmojiGroup[]} */
export const EMOJI_GROUPS = [
  { id: 'smileys', nl: 'Gezichten', en: 'Smileys', items: [
    ['😀', 'lach', 'grin'], ['😄', 'blije lach', 'big smile'], ['😂', 'tranen van het lachen', 'tears of joy'], ['🙂', 'glimlach', 'slight smile'],
    ['😉', 'knipoog', 'wink'], ['😊', 'blos', 'blush'], ['😍', 'verliefd', 'heart eyes'], ['🥰', 'liefdevol', 'smiling with hearts'],
    ['😘', 'kus', 'kiss'], ['😎', 'zonnebril', 'cool'], ['🤔', 'nadenken', 'thinking'], ['🤗', 'knuffel', 'hug'],
    ['😅', 'zweetdruppel', 'sweat smile'], ['😬', 'oeps', 'grimace'], ['😴', 'slapen', 'sleeping'], ['🤒', 'ziek', 'sick'],
    ['😢', 'verdrietig', 'sad'], ['😭', 'huilen', 'crying'], ['😡', 'boos', 'angry'], ['😱', 'geschrokken', 'scream'],
    ['🥳', 'feest', 'party face'], ['🤩', 'onder de indruk', 'star struck'], ['😇', 'engel', 'angel'], ['🙃', 'ondersteboven', 'upside down'],
  ] },
  { id: 'gestures', nl: 'Gebaren', en: 'Gestures', items: [
    ['👍', 'duim omhoog', 'thumbs up'], ['👎', 'duim omlaag', 'thumbs down'], ['👏', 'applaus', 'clapping'], ['🙌', 'handen omhoog', 'raised hands'],
    ['🙏', 'dank je', 'thank you'], ['👋', 'zwaaien', 'wave'], ['🤝', 'handdruk', 'handshake'], ['✌️', 'vrede', 'victory'],
    ['👌', 'oké', 'ok hand'], ['🤞', 'duimen', 'fingers crossed'], ['💪', 'sterk', 'strong'], ['👀', 'kijken', 'eyes'],
    ['🫶', 'hartje met handen', 'heart hands'], ['☝️', 'opgelet', 'point up'], ['👉', 'wijzen', 'point right'], ['✋', 'stop', 'raised hand'],
  ] },
  { id: 'hearts', nl: 'Harten', en: 'Hearts', items: [
    ['❤️', 'rood hart', 'red heart'], ['🧡', 'oranje hart', 'orange heart'], ['💛', 'geel hart', 'yellow heart'], ['💚', 'groen hart', 'green heart'],
    ['💙', 'blauw hart', 'blue heart'], ['💜', 'paars hart', 'purple heart'], ['🖤', 'zwart hart', 'black heart'], ['🤍', 'wit hart', 'white heart'],
    ['💔', 'gebroken hart', 'broken heart'], ['💕', 'twee harten', 'two hearts'], ['💯', 'honderd', 'hundred'], ['✨', 'glinstering', 'sparkles'],
  ] },
  { id: 'nature', nl: 'Natuur', en: 'Nature', items: [
    ['🐶', 'hond', 'dog'], ['🐱', 'kat', 'cat'], ['🐰', 'konijn', 'rabbit'], ['🐻', 'beer', 'bear'], ['🐼', 'panda', 'panda'], ['🐸', 'kikker', 'frog'],
    ['🐝', 'bij', 'bee'], ['🦋', 'vlinder', 'butterfly'], ['🐟', 'vis', 'fish'], ['🐦', 'vogel', 'bird'], ['🌸', 'bloesem', 'blossom'], ['🌻', 'zonnebloem', 'sunflower'],
    ['🌳', 'boom', 'tree'], ['🌱', 'plantje', 'seedling'], ['🍀', 'klavertje vier', 'four leaf clover'], ['🌞', 'zon', 'sun'], ['🌧️', 'regen', 'rain'], ['❄️', 'sneeuw', 'snow'],
    ['🌈', 'regenboog', 'rainbow'], ['🔥', 'vuur', 'fire'], ['💧', 'druppel', 'droplet'], ['🌙', 'maan', 'moon'],
  ] },
  { id: 'food', nl: 'Eten en drinken', en: 'Food and drink', items: [
    ['🍎', 'appel', 'apple'], ['🍌', 'banaan', 'banana'], ['🍓', 'aardbei', 'strawberry'], ['🥕', 'wortel', 'carrot'], ['🥦', 'broccoli', 'broccoli'], ['🍞', 'brood', 'bread'],
    ['🧀', 'kaas', 'cheese'], ['🥚', 'ei', 'egg'], ['🍕', 'pizza', 'pizza'], ['🍝', 'pasta', 'pasta'], ['🍔', 'hamburger', 'burger'], ['🥗', 'salade', 'salad'],
    ['🍰', 'taart', 'cake'], ['🍪', 'koekje', 'cookie'], ['🍫', 'chocolade', 'chocolate'], ['☕', 'koffie', 'coffee'], ['🍵', 'thee', 'tea'], ['🥛', 'melk', 'milk'],
    ['🍷', 'wijn', 'wine'], ['🍺', 'bier', 'beer'], ['🥂', 'proosten', 'cheers'], ['🧁', 'cupcake', 'cupcake'],
  ] },
  { id: 'activities', nl: 'Activiteiten', en: 'Activities', items: [
    ['⚽', 'voetbal', 'football'], ['🏀', 'basketbal', 'basketball'], ['🎾', 'tennis', 'tennis'], ['🚴', 'fietsen', 'cycling'], ['🏃', 'hardlopen', 'running'], ['🏊', 'zwemmen', 'swimming'],
    ['🧘', 'yoga', 'yoga'], ['🎉', 'feestje', 'party popper'], ['🎂', 'verjaardag', 'birthday'], ['🎁', 'cadeau', 'gift'], ['🎄', 'kerstboom', 'christmas tree'], ['🎃', 'pompoen', 'pumpkin'],
    ['🎵', 'muziek', 'music'], ['🎮', 'spelletje', 'game'], ['🎨', 'schilderen', 'painting'], ['📚', 'boeken', 'books'], ['🏆', 'beker', 'trophy'], ['🥇', 'gouden medaille', 'gold medal'],
  ] },
  { id: 'travel', nl: 'Reizen en plaatsen', en: 'Travel and places', items: [
    ['🏠', 'huis', 'house'], ['🏢', 'kantoor', 'office'], ['🏫', 'school', 'school'], ['🏥', 'ziekenhuis', 'hospital'], ['🛒', 'boodschappen', 'shopping cart'], ['🚗', 'auto', 'car'],
    ['🚲', 'fiets', 'bicycle'], ['🚆', 'trein', 'train'], ['🚌', 'bus', 'bus'], ['✈️', 'vliegtuig', 'airplane'], ['⛵', 'zeilboot', 'sailboat'], ['🏖️', 'strand', 'beach'],
    ['⛰️', 'berg', 'mountain'], ['🏕️', 'kamperen', 'camping'], ['🗺️', 'kaart', 'map'], ['🧳', 'koffer', 'luggage'],
  ] },
  { id: 'objects', nl: 'Voorwerpen', en: 'Objects', items: [
    ['📅', 'kalender', 'calendar'], ['⏰', 'wekker', 'alarm clock'], ['⏳', 'zandloper', 'hourglass'], ['📌', 'punaise', 'pushpin'], ['📎', 'paperclip', 'paperclip'], ['✏️', 'potlood', 'pencil'],
    ['📝', 'notitie', 'memo'], ['📞', 'telefoon', 'telephone'], ['📱', 'mobiel', 'mobile phone'], ['💻', 'laptop', 'laptop'], ['📧', 'e-mail', 'e-mail'], ['📦', 'pakket', 'package'],
    ['💡', 'idee', 'idea'], ['🔑', 'sleutel', 'key'], ['🔧', 'gereedschap', 'wrench'], ['🧹', 'bezem', 'broom'], ['🧺', 'wasmand', 'laundry basket'], ['💊', 'medicijn', 'medicine'],
    ['💰', 'geld', 'money'], ['💳', 'betaalpas', 'credit card'], ['🧾', 'bon', 'receipt'], ['📷', 'camera', 'camera'],
  ] },
  { id: 'symbols', nl: 'Symbolen', en: 'Symbols', items: [
    ['✅', 'klaar', 'check mark'], ['☑️', 'aangevinkt', 'ballot box with check'], ['❌', 'kruis', 'cross'], ['❗', 'uitroepteken', 'exclamation'], ['❓', 'vraagteken', 'question'], ['⚠️', 'waarschuwing', 'warning'],
    ['🚫', 'verboden', 'prohibited'], ['⭐', 'ster', 'star'], ['🔴', 'rood', 'red circle'], ['🟠', 'oranje', 'orange circle'], ['🟡', 'geel', 'yellow circle'], ['🟢', 'groen', 'green circle'],
    ['🔵', 'blauw', 'blue circle'], ['🟣', 'paars', 'purple circle'], ['➡️', 'pijl rechts', 'right arrow'], ['🔁', 'herhalen', 'repeat'], ['🆕', 'nieuw', 'new'], ['🔔', 'bel', 'bell'],
  ] },
];

/** Alle emoji op een rij, met hun namen. */
export const ALL_EMOJI = EMOJI_GROUPS.flatMap((g) => g.items.map(([char, nl, en]) => ({ char, nl, en, group: g.id })));

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Zoeken op naam, in beide talen (je typt "koffie" of "coffee"): eerst wat met de zoektekst begint, dan wat hem bevat.
 * @returns {{ char: string, nl: string, en: string, group: string }[]}
 */
export function searchEmoji(query, limit = 60) {
  const q = fold(String(query ?? '').trim());
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const e of ALL_EMOJI) {
    const names = [fold(e.nl), fold(e.en)];
    if (names.some((n) => n.startsWith(q) || n.split(' ').some((w) => w.startsWith(q)))) starts.push(e);
    else if (names.some((n) => n.includes(q))) contains.push(e);
  }
  return [...starts, ...contains].slice(0, limit);
}

/** De naam van een emoji in de taal van de app (voor een schermlezer); een onbekende emoji heeft geen naam. */
export const emojiName = (char, lang) => {
  const e = ALL_EMOJI.find((x) => x.char === char);
  return e ? (lang === 'en' ? e.en : e.nl) : '';
};

export const RECENT_KEY = 'tickory.emoji.recent';
export const MAX_RECENT = 16;

/** De laatst gebruikte emoji (nieuwste eerst), alleen bekende; kapotte opslag geeft een lege lijst. */
export function recentEmoji(storage = globalThis.localStorage) {
  try {
    const list = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && ALL_EMOJI.some((e) => e.char === c)).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

/** Onthoudt dat deze emoji net is gebruikt (vooraan, zonder dubbele). */
export function rememberEmoji(char, storage = globalThis.localStorage) {
  try {
    const next = [char, ...recentEmoji(storage).filter((c) => c !== char)].slice(0, MAX_RECENT);
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* geen opslag: dan zonder geheugen */ }
}

/**
 * Zet tekst op de plek van de cursor in een invoerveld (of vervangt de selectie) en zet de cursor erachter.
 * @param {{ value: string, selectionStart: number | null, selectionEnd: number | null, setSelectionRange?: (a: number, b: number) => void }} input
 */
export function insertAtCaret(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const at = start + text.length;
  input.setSelectionRange?.(at, at);
  return at;
}
