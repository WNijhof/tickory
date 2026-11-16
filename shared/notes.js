// Notities (SPEC 5k): de achtergronden en de persoonlijke voorkeuren voor de lijst. Gedeeld door server, reducer, demo en web-app.
//
// Een achtergrond is een kleur of een patroon (een patroon heeft zijn eigen tint); null is de gewone achtergrond van de app.
// De voorkeuren staan in `settings.note_prefs` (dus op al je apparaten gelijk): de indeling van de lijst, de sortering en of
// afgevinkte punten in een checklist vanzelf naar onderen gaan.

export const NOTE_COLORS = Object.freeze(['yellow', 'orange', 'brown', 'red', 'pink', 'purple', 'indigo', 'blue', 'teal', 'green']);
export const NOTE_PATTERNS = Object.freeze(['dots', 'grid', 'lines', 'waves', 'groceries', 'music', 'travel', 'code']);
export const NOTE_BACKGROUNDS = Object.freeze([...NOTE_COLORS, ...NOTE_PATTERNS]);

export const NOTE_LAYOUTS = Object.freeze(['masonry', 'grid', 'list']);
export const NOTE_SORTS = Object.freeze(['updated', 'created', 'title']);
export const NOTE_ORDERS = Object.freeze(['asc', 'desc']);

export const DEFAULT_NOTE_PREFS = Object.freeze({ layout: 'masonry', sort: 'updated', order: 'desc', checked_bottom: true });

// ---------- foto's en geluid bij een notitie ----------
//
// Alleen wat de app zelf kan tonen of afspelen. Een afbeelding herkent de server aan de eerste bytes (shared/attachments.js);
// geluid aan wat de afzender zegt. Een ander type weigert de server al bij de upload.

export const NOTE_IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const NOTE_AUDIO_MIMES = Object.freeze(['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/flac']);
export const isNoteFileMime = (mime) => NOTE_IMAGE_MIMES.includes(mime) || NOTE_AUDIO_MIMES.includes(mime);
/** 'image', 'audio' of null. */
export const noteFileKind = (mime) => (NOTE_IMAGE_MIMES.includes(mime) ? 'image' : NOTE_AUDIO_MIMES.includes(mime) ? 'audio' : null);
/** Zoveel foto's en geluidsfragmenten kan een notitie hebben (gelijk aan LIMITS.filesPerNote op de server). */
export const MAX_FILES_PER_NOTE = 20;
/** Zoveel notities kan iemand hebben (gelijk aan LIMITS.notesPerUser op de server). */
export const MAX_NOTES_PER_USER = 10_000;

// ---------- herinneringen op een notitie ----------
//
// Zoals in Anchor: één tijdstip per notitie (`remind_at`, zwevend 'YYYY-MM-DDTHH:MM' in de tijdzone van de gebruiker, net als de
// datum van een taak), eenmalig of herhaald (`remind_repeat`: elke dag, week, maand of jaar). Bij een maandelijkse herhaling op de
// 31e valt de herinnering in een kortere maand op de laatste dag; bij een jaarlijkse op 29 februari in een gewoon jaar op 28 februari.

export const NOTE_REPEATS = Object.freeze(['daily', 'weekly', 'monthly', 'yearly']);
const FLOATING = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Controle van `note.remind_at`: een geldige datum met tijd ('YYYY-MM-DDTHH:MM'). Geeft een melding of null. */
export function noteRemindCheck(v) {
  const m = FLOATING.exec(String(v));
  if (!m) return 'moet een datum met tijd zijn (JJJJ-MM-DDTHH:MM)';
  const [, y, mo, d, h, mi] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59) return 'bestaat niet';
  if (y < 2000 || y > 2200) return 'valt buiten 2000-2200';
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
const parts = (f) => FLOATING.exec(f)?.slice(1).map(Number) ?? null;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12
const format = (y, mo, d, h, mi) => `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`;

/** De `n`-de keer na `base` (n = 0 is base zelf). */
export function noteReminderAt(base, repeat, n) {
  const p = parts(base);
  if (!p) return null;
  const [y, mo, d, h, mi] = p;
  if (n === 0 || !repeat) return base;
  if (repeat === 'daily' || repeat === 'weekly') {
    const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
    date.setUTCDate(date.getUTCDate() + n * (repeat === 'weekly' ? 7 : 1));
    return format(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, mi);
  }
  const months = repeat === 'yearly' ? 12 * n : n;
  const total = (y * 12 + (mo - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return format(ny, nm, Math.min(d, daysIn(ny, nm)), h, mi);
}

/** Ruwe schatting van het aantal perioden tussen twee momenten (daarna wordt het precies gemaakt). */
function periodsBetween(base, until, repeat) {
  const a = parts(base);
  const b = parts(until);
  if (!a || !b) return 0;
  if (repeat === 'daily' || repeat === 'weekly') {
    const days = (Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86_400_000;
    return Math.max(0, Math.floor(days / (repeat === 'weekly' ? 7 : 1)) - 1);
  }
  const months = (b[0] - a[0]) * 12 + (b[1] - a[1]);
  return Math.max(0, Math.floor(months / (repeat === 'yearly' ? 12 : 1)) - 1);
}

/** De eerste keer op of na `from` (zwevend), of null (een eenmalige herinnering die al voorbij is, of geen herinnering). */
export function nextNoteReminder(remindAt, repeat, from) {
  if (!remindAt || noteRemindCheck(remindAt) !== null) return null;
  if (!repeat || !NOTE_REPEATS.includes(repeat)) return remindAt >= from ? remindAt : null;
  if (remindAt >= from) return remindAt;
  for (let n = Math.max(1, periodsBetween(remindAt, from, repeat)), i = 0; i < 400; n++, i++) {
    const at = noteReminderAt(remindAt, repeat, n);
    if (at >= from) return at;
  }
  return null;
}

/** De laatste keer op of vóór `until` (zwevend), of null. Voor de server: is er net een herinnering aan de beurt geweest? */
export function lastNoteReminder(remindAt, repeat, until) {
  if (!remindAt || noteRemindCheck(remindAt) !== null || remindAt > until) return null;
  if (!repeat || !NOTE_REPEATS.includes(repeat)) return remindAt;
  const start = Math.max(1, periodsBetween(remindAt, until, repeat));
  let last = noteReminderAt(remindAt, repeat, start - 1); // de schatting blijft altijd vóór `until`
  for (let n = start, i = 0; i < 400; n++, i++) {
    const at = noteReminderAt(remindAt, repeat, n);
    if (at > until) break;
    last = at;
  }
  return last;
}

/** Een korte kop voor een melding: de titel, of anders de eerste regel van de tekst zonder Markdown-tekens. */
export function noteHeadline(note, max = 120) {
  const own = String(note?.title ?? '').trim();
  if (own) return own.slice(0, max);
  const clean = (l) => l.replace(/^\s*(?:[-*+]|\d{1,9}[.)]|#{1,6}|>)\s+(?:\[[ xX]\]\s+)?/, '').replace(/\]\([^)]*\)/g, '').replace(/[*_~=`+[\]\\]|\{(?:yellow|green|blue|pink|purple)\}/g, '').trim();
  return (String(note?.content ?? '').split('\n').map(clean).find(Boolean) ?? '').slice(0, max);
}

/** Controle van `settings.note_prefs`: `{ layout?, sort?, order?, checked_bottom? }`. Geeft een melding of null. */
export function notePrefsCheck(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'moet een object zijn';
  for (const key of Object.keys(v)) if (!['layout', 'sort', 'order', 'checked_bottom'].includes(key)) return `onbekend veld "${key.slice(0, 30)}"`;
  if (v.layout !== undefined && !NOTE_LAYOUTS.includes(v.layout)) return `layout: kies uit ${NOTE_LAYOUTS.join(', ')}`;
  if (v.sort !== undefined && !NOTE_SORTS.includes(v.sort)) return `sort: kies uit ${NOTE_SORTS.join(', ')}`;
  if (v.order !== undefined && !NOTE_ORDERS.includes(v.order)) return `order: kies uit ${NOTE_ORDERS.join(', ')}`;
  if (v.checked_bottom !== undefined && typeof v.checked_bottom !== 'boolean') return 'checked_bottom moet true of false zijn';
  return null;
}

/** De voorkeuren uit de instellingen, aangevuld met de standaard (een onbekende waarde, van een nieuwere versie, telt niet). */
export function notePrefsOf(settings) {
  const v = settings?.note_prefs;
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return {
    layout: NOTE_LAYOUTS.includes(o.layout) ? o.layout : DEFAULT_NOTE_PREFS.layout,
    sort: NOTE_SORTS.includes(o.sort) ? o.sort : DEFAULT_NOTE_PREFS.sort,
    order: NOTE_ORDERS.includes(o.order) ? o.order : DEFAULT_NOTE_PREFS.order,
    checked_bottom: typeof o.checked_bottom === 'boolean' ? o.checked_bottom : DEFAULT_NOTE_PREFS.checked_bottom,
  };
}
