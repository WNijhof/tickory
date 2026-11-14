// Herinneringen: wanneer gaat een herinnering af, en hoe schrijf je er een op?
// Gedeeld door server en client; de Android-app volgt dezelfde regels (zie android/README.md).
//
// Datums zijn "zwevend": een lokale datum en tijd zonder tijdzone ("2026-12-01T09:00"). Negen uur is negen uur op de
// plek waar je bent. Pas bij het inplannen wordt daar een echt tijdstip van gemaakt, in de tijdzone van het apparaat.
//
// Drie soorten, de eerste twee zoals in Todoist:
//   relatief  een aantal minuten vóór het tijdstip van de taak (0 = op het tijdstip zelf). Werkt alleen als de taak een
//             datum mét tijd heeft; zonder tijd doet de herinnering niets, en ze werkt weer zodra er een tijd is.
//   absoluut  een eigen datum en tijd, los van de taak.
//   locatie   bij aankomst op of vertrek van een eigen plaats (place_id, trigger enter | leave). Heeft geen tijdstip: of je
//             er bent, bepaalt alleen het toestel (Android-app); de server en de browser weten dat nooit.

const pad = (n) => String(n).padStart(2, '0');
const FLOATING = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Heeft deze datum een tijd erbij? */
export const hasTime = (date) => typeof date === 'string' && FLOATING.test(date);

function parts(floating) {
  const m = FLOATING.exec(floating);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] ?? 0) };
}

/** Telt minuten op bij een zwevend tijdstip (negatief trekt af). Puur kalenderrekenen: er komt geen tijdzone aan te pas. */
export function addMinutes(floating, minutes) {
  const p = parts(floating);
  if (!p) return null;
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) + minutes * 60_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

/**
 * Het zwevende tijdstip waarop een herinnering afgaat, of null als ze nu niets doet (taak weg of afgevinkt, of een
 * relatieve herinnering bij een taak zonder tijd).
 * @param {{ type: string, minute_offset?: number | null, due?: { date: string } | null, is_deleted?: boolean }} reminder
 * @param {{ due?: { date: string } | null, checked?: boolean, is_deleted?: boolean } | null | undefined} task
 * @returns {string | null} "YYYY-MM-DDTHH:MM"
 */
export function reminderMoment(reminder, task) {
  if (!reminder || reminder.is_deleted || !task || task.is_deleted || task.checked) return null;
  if (reminder.type === 'absolute') return hasTime(reminder.due?.date) ? addMinutes(reminder.due.date, 0) : null;
  if (reminder.type === 'relative') {
    if (!hasTime(task.due?.date) || !Number.isInteger(reminder.minute_offset) || reminder.minute_offset < 0) return null;
    return addMinutes(task.due.date, -reminder.minute_offset);
  }
  return null;
}

/**
 * Een herinnering op een plek, zolang ze iets kan doen: de taak bestaat en is niet afgevinkt. Ze heeft geen tijdstip
 * (`reminderMoment` geeft null); of ze afgaat, beslist de Android-app aan de hand van de positie van het toestel.
 */
export function isLocationActive(reminder, task) {
  return Boolean(reminder && reminder.type === 'location' && !reminder.is_deleted && task && !task.is_deleted && !task.checked);
}

// Een Intl.DateTimeFormat aanmaken is duidelijk duurder dan er een tijdstip mee opmaken; per tijdzone hergebruiken.
const formatters = new Map();
function offsetFormatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    if (formatters.size > 200) formatters.clear(); // begrensd, voor het geval er veel verschillende namen langskomen
    formatters.set(timeZone, f);
  }
  return f;
}

/** Het verschil in ms tussen de wandklok in een tijdzone en UTC, op een gegeven moment. */
function zoneOffset(epochMs, timeZone) {
  const f = offsetFormatter(timeZone);
  const get = Object.fromEntries(f.formatToParts(new Date(epochMs)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(get.year, get.month - 1, get.day, get.hour, get.minute, get.second) - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Maakt van een zwevend tijdstip een echt tijdstip (ms sinds 1970), in de tijdzone van dit apparaat of in een opgegeven
 * tijdzone ("Europe/Amsterdam"). Bij de overgang naar zomertijd bestaat een uur niet: dat schuift naar voren (02:30 wordt
 * 03:30). Bij de overgang naar wintertijd bestaat een uur twee keer: de eerste telt. De browser, Java en Android doen
 * hetzelfde, zodat een herinnering overal op hetzelfde moment afgaat.
 * @param {string} floating "YYYY-MM-DDTHH:MM[:SS]"
 * @param {string | null} [timeZone] IANA-naam; zonder: de tijdzone van het apparaat
 * @returns {number | null}
 */
export function floatingToEpoch(floating, timeZone = null) {
  const p = parts(floating);
  if (!p) return null;
  if (!timeZone) return new Date(p.y, p.mo - 1, p.d, p.h, p.mi, p.s).getTime();
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  // Twee kandidaten: met de afwijking van vóór en van ná een mogelijke overgang in de buurt.
  const a = wall - zoneOffset(wall - 86_400_000, timeZone);
  const b = wall - zoneOffset(wall + 86_400_000, timeZone);
  if (a === b) return a;
  const valid = [a, b].filter((t) => wall - zoneOffset(t, timeZone) === t);
  if (valid.length === 2) return Math.min(a, b); // het uur bestaat twee keer: de eerste
  if (valid.length === 1) return valid[0];
  return Math.max(a, b); // het uur bestaat niet: naar voren
}

/** De keuzes die de app aanbiedt, in minuten vóór het tijdstip van de taak (zoals Todoist). */
export const REMINDER_PRESETS = [0, 10, 30, 45, 60, 120, 180, 1440, 2880, 4320];

/** De hoogste waarde die de server aanneemt: een jaar vooraf. */
export const MAX_OFFSET = 60 * 24 * 365;

/**
 * Een aantal minuten als leesbare eenheid: 0 → op het tijdstip zelf, 90 → 90 minuten, 120 → 2 uur, 1440 → 1 dag.
 * De tekst zelf maakt de interface (in de gekozen taal).
 * @returns {{ unit: 'at' | 'minutes' | 'hours' | 'days', n: number }}
 */
export function offsetParts(minutes) {
  if (minutes === 0) return { unit: 'at', n: 0 };
  if (minutes % 1440 === 0) return { unit: 'days', n: minutes / 1440 };
  if (minutes % 60 === 0) return { unit: 'hours', n: minutes / 60 };
  return { unit: 'minutes', n: minutes };
}

const WORDS = { een: 1, één: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10, kwartier: 15, half: 30 };
const UNIT = [
  [/^(m|min|mins|minuut|minuten|mv)$/, 1],
  [/^(u|uur|uren|h|uv)$/, 60],
  [/^(d|dag|dagen|dv)$/, 1440],
  [/^(w|week|weken)$/, 10080],
];

/**
 * Leest een relatieve herinnering in gewoon Nederlands of als korte code. Geeft het aantal minuten vooraf, of null.
 *   "30mv", "30m", "30 min", "30 minuten ervoor", "1uv", "2 uur van tevoren", "een kwartier vooraf", "1dv", "2 dagen",
 *   "0mv", "0", "op tijd", "op het tijdstip van de taak"
 */
export function parseOffsetNl(text) {
  if (typeof text !== 'string') return null;
  const s = text.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ')
    .replace(/ ?(ervoor|vooraf|van tevoren|vantevoren|tevoren|eerder|voor de taak|voor het tijdstip)$/, '').trim();
  if (/^(0|op tijd|op het tijdstip|op tijdstip|op het tijdstip van de taak|op tijdstip van taak|op het moment zelf)$/.test(s)) return 0;
  if (/^(een )?kwartier$/.test(s)) return 15;
  if (/^(een )?half uur$/.test(s) || s === 'halfuur') return 30;
  const m = /^(\d{1,4}|[a-zé]+) ?([a-z]+)$/.exec(s);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORDS[m[1]];
  const unit = UNIT.find(([re]) => re.test(m[2]));
  if (n === undefined || !unit) return null;
  const minutes = n * unit[1];
  return minutes <= MAX_OFFSET ? minutes : null;
}

/**
 * Het omgekeerde van floatingToEpoch: een echt tijdstip als zwevende datum en tijd ("2026-12-01T09:00") in de tijdzone
 * van dit apparaat of in een opgegeven tijdzone. Seconden vallen weg.
 * @param {number} epochMs
 * @param {string | null} [timeZone]
 */
export function epochToFloating(epochMs, timeZone = null) {
  if (!timeZone) {
    const d = new Date(epochMs);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const get = Object.fromEntries(f.formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
  return `${get.year}-${get.month}-${get.day}T${get.hour}:${get.minute}`;
}
