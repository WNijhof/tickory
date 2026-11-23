// Een Engelse datumherkenner. Twee gebruikers:
// - de app in het Engels (core/dateInput.js): het datumveld leest de hele tekst met parseDateEn, en snel toevoegen zoekt met
//   parseDueEn een datum in de titel ("Call mom tomorrow at 6pm");
// - het importeren uit Todoist (core/todoistImport.js): wie Todoist in het Engels gebruikte, heeft in zijn back-up datums als
//   "every monday", "Jan 12" of "tomorrow at 9am" (kolom DATE, met DATE_LANG "en"). Wat er niet tussen zit geeft null, en de
//   import zet die tekst dan in de beschrijving in plaats van iets te raden.
//
// Herkend (hoofdletters, komma's en een punt achter een maand doen er niet toe):
//   eenmalig    today · tod · tomorrow · tom · yesterday · next week · next month · in 3 days · in 2 weeks · monday · next fri
//               Jan 12 · January 12th · 12 Jan · 12th of January · Jan 12 2027 · 12 Jan 2027 · 2026-12-01 · 2026-12-01T09:30
//   herhaling   every day · daily · every 3 days · every other week · every week · weekly · every monday · every mon, wed and fri
//               every other monday · every weekday · every workday · every weekend · every month · every month on the 15th
//               every 15th · every last day · every 2 months on the last day · every first monday · every last friday of the month
//               every year · every jan 12 · every 12 January · every year on jan 12 · every 2 years on 12 january
//               every! 3 days (vanaf het afvinken) · ev / ev! als afkorting
//   tijd        at 9am · 9am · 9:30 · 9:30pm · at 14:00 · 14:00 · at noon · at midnight (overal in de tekst, hooguit één keer)
// Een datum zonder jaar ("Jan 12") is de dichtstbijzijnde: in een back-up kan een taak al over tijd zijn, en "Nov 10" op
// 14 november is dan vier dagen geleden, niet volgend jaar.

import { isValidDate, isValidRecurrence } from '../../shared/recurrence.js';
import { getDayPrefs } from '../../shared/dayPrefs.js';
import { normalizeText } from '../../shared/text.js';
import { firstOccurrence, localDate } from './dateNl.js';

const WEEKDAYS = {
  monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7,
};
const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, other: 2 };
const ORDINALS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, last: -1 };

const longestFirst = (o) => Object.keys(o).sort((a, b) => b.length - a.length).join('|');
const WD = `(?:${longestFirst(WEEKDAYS)})`;
const MON = `(?:${longestFirst(MONTHS)})`;
const NUM = `(?:\\d{1,3}|${longestFirst(NUMBERS)})`;
const ORD = `(?:${longestFirst(ORDINALS)})`;
const TH = '(?:st|nd|rd|th)?';

const pad = (n) => String(n).padStart(2, '0');
const readNumber = (s) => (s === undefined ? 1 : /^\d+$/.test(s) ? Number(s) : NUMBERS[s]);
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const plusDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const validYmd = (y, m, d) => {
  const t = new Date(y, m - 1, d);
  return y >= 1000 && y <= 9999 && t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
};

// ---------- tijd ----------

const AMPM = '(am|pm|a\\.m\\.|p\\.m\\.)';
const TIME_PATTERNS = [
  new RegExp(`(?:^|\\s)(?:at|@)\\s+(\\d{1,2})(?::(\\d{2}))?\\s*${AMPM}?(?=\\s|$)`),
  new RegExp(`(?:^|\\s)(\\d{1,2}):(\\d{2})\\s*${AMPM}?(?=\\s|$)`),
  new RegExp(`(?:^|\\s)(\\d{1,2})()\\s*${AMPM}(?=\\s|$)`),
];
const NAMED_TIME = /(?:^|\s)(?:at\s+)?(noon|midday|midnight)(?=\s|$)/;

/** Haalt één tijdstip uit de tekst. `bad` als het geen geldige tijd is of als er twee staan. */
function takeTime(s) {
  let found = null;
  let rest = s;
  for (const re of TIME_PATTERNS) {
    const m = re.exec(rest);
    if (!m) continue;
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const half = m[3]?.replace(/\./g, '');
    if (half) {
      if (hour < 1 || hour > 12) return { bad: true };
      hour = (hour % 12) + (half === 'pm' ? 12 : 0);
    }
    if (hour > 23 || minute > 59) return { bad: true };
    if (found) return { bad: true };
    found = { hour, minute };
    rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
  }
  const named = NAMED_TIME.exec(rest);
  if (named) {
    if (found) return { bad: true };
    found = { hour: named[1] === 'midnight' ? 0 : 12, minute: 0 };
    rest = `${rest.slice(0, named.index)} ${rest.slice(named.index + named[0].length)}`;
  }
  return { rest: rest.replace(/\s+/g, ' ').trim(), time: found };
}

// ---------- eenmalige datums ----------

/** De dichtstbijzijnde datum met deze dag en maand (vorig, dit of volgend jaar); bij gelijke afstand de toekomst. */
function nearest(day, month, today) {
  let best = null;
  for (const y of [today.getFullYear(), today.getFullYear() + 1, today.getFullYear() - 1]) {
    if (!validYmd(y, month, day)) continue;
    const d = new Date(y, month - 1, day);
    const distance = Math.abs(Math.round((d - today) / 86_400_000));
    if (!best || distance < best.distance || (distance === best.distance && d > best.d)) best = { d, distance };
  }
  return best ? best.d : null;
}

/** De eerstvolgende datum (vandaag niet meegeteld) met deze weekdag. */
function nextWeekday(wd, today) {
  const now = today.getDay() || 7;
  return plusDays(today, ((wd - now + 7) % 7) || 7);
}

const MONTH_DAY = new RegExp(`^(?:on\\s+)?(${MON})\\.?\\s+(\\d{1,2})${TH}(?:\\s+(\\d{4}))?$`);
const DAY_MONTH = new RegExp(`^(?:on\\s+)?(?:the\\s+)?(\\d{1,2})${TH}\\s+(?:of\\s+)?(${MON})\\.?(?:\\s+(\\d{4}))?$`);

/** Een eenmalige datum zonder tijd, als Date (lokaal), of null. */
function singleDate(s, today) {
  if (s === '' || s === 'today' || s === 'tod') return today;
  if (s === 'tomorrow' || s === 'tom' || s === 'tmrw' || s === 'tmr') return plusDays(today, 1);
  if (s === 'yesterday') return plusDays(today, -1);
  if (s === 'next week') return nextWeekday(getDayPrefs().nextWeek, today);
  if (s === 'next month') return new Date(today.getFullYear(), today.getMonth() + 1, 1);
  let m = new RegExp(`^in\\s+(${NUM})\\s+(days?|weeks?|months?|years?)$`).exec(s);
  if (m) {
    const n = readNumber(m[1]);
    if (m[2].startsWith('day')) return plusDays(today, n);
    if (m[2].startsWith('week')) return plusDays(today, 7 * n);
    const months = m[2].startsWith('month') ? n : 12 * n;
    const target = new Date(today.getFullYear(), today.getMonth() + months, 1);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    return new Date(target.getFullYear(), target.getMonth(), Math.min(today.getDate(), last));
  }
  m = new RegExp(`^(?:next\\s+|this\\s+|on\\s+)?(${WD})$`).exec(s);
  if (m) return nextWeekday(WEEKDAYS[m[1]], today);
  m = MONTH_DAY.exec(s);
  const md = m ? { day: Number(m[2]), month: MONTHS[m[1]], year: m[3] } : (m = DAY_MONTH.exec(s)) ? { day: Number(m[1]), month: MONTHS[m[2]], year: m[3] } : null;
  if (md) {
    if (md.year) return validYmd(Number(md.year), md.month, md.day) ? new Date(Number(md.year), md.month - 1, md.day) : null;
    return nearest(md.day, md.month, today);
  }
  return null;
}

// ---------- herhalingen ----------

const withInterval = (rule, n) => (n > 1 ? { ...rule, interval: n } : rule);

/** De herhalingsregel na "every", of null. `anchor` is bij een jaarlijkse datum de eerste keer. */
function recurrenceRule(body, today) {
  let m = new RegExp(`^(?:(${NUM})\\s+)?(days?|weeks?|months?|years?)$`).exec(body);
  if (m) {
    const n = readNumber(m[1]);
    if (!n || n > 1000) return null;
    const unit = m[2].replace(/s$/, '');
    if (unit === 'day') return { rule: withInterval({ freq: 'daily' }, n) };
    if (unit === 'week') return { rule: withInterval({ freq: 'weekly' }, n) };
    // "every month" / "every year" zonder dag: de dag van vandaag vastleggen, zoals de Nederlandse herkenner
    if (unit === 'month') return { rule: withInterval({ freq: 'monthly', bymonthday: today.getDate() }, n) };
    return { rule: withInterval({ freq: 'yearly', bymonthday: today.getDate() }, n), anchor: today };
  }
  if (/^(?:weekday|weekdays|workday|workdays|work day|work days)$/.test(body)) return { rule: { freq: 'weekly', byweekday: [1, 2, 3, 4, 5] } };
  if (/^(?:weekend|weekends)$/.test(body)) return { rule: { freq: 'weekly', byweekday: [6, 7] } };
  m = new RegExp(`^(?:(${NUM})\\s+)?(${WD}(?:\\s+(?:and\\s+|&\\s+)?${WD})*)$`).exec(body);
  if (m) {
    const n = readNumber(m[1]);
    if (!n || n > 1000) return null;
    const days = [...new Set(m[2].split(/\s+/).filter((w) => Object.hasOwn(WEEKDAYS, w)).map((w) => WEEKDAYS[w]))].sort((a, b) => a - b);
    return { rule: withInterval({ freq: 'weekly', byweekday: days }, n) };
  }
  // "every 2 weeks on monday" · "every other week on mon and thu" · "every week on friday"
  m = new RegExp(`^(?:(${NUM})\\s+)?weeks?\\s+on\\s+(${WD}(?:\\s+(?:and\\s+|&\\s+)?${WD})*)$`).exec(body);
  if (m) {
    const n = readNumber(m[1]);
    if (!n || n > 1000) return null;
    const days = [...new Set(m[2].split(/\s+/).filter((w) => Object.hasOwn(WEEKDAYS, w)).map((w) => WEEKDAYS[w]))].sort((a, b) => a - b);
    return { rule: withInterval({ freq: 'weekly', byweekday: days }, n) };
  }
  m = new RegExp(`^(?:(${NUM})\\s+)?months?\\s+on\\s+(?:the\\s+)?(\\d{1,2})${TH}$`).exec(body)
    ?? new RegExp(`^()(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)(?:\\s+of\\s+(?:the|every)\\s+month)?$`).exec(body);
  if (m) {
    const n = readNumber(m[1] || undefined);
    const day = Number(m[2]);
    return day >= 1 && day <= 31 && n && n <= 1000 ? { rule: withInterval({ freq: 'monthly', bymonthday: day }, n) } : null;
  }
  m = new RegExp(`^(?:(?:(${NUM})\\s+)?months?\\s+on\\s+the\\s+)?last\\s+day(?:\\s+of\\s+(?:the|every)\\s+month)?$`).exec(body);
  if (m) {
    const n = readNumber(m[1] || undefined);
    return n && n <= 1000 ? { rule: withInterval({ freq: 'monthly', bymonthday: 31 }, n) } : null;
  }
  m = new RegExp(`^(?:months?\\s+on\\s+)?(?:the\\s+)?(${ORD})\\s+(${WD})(?:\\s+of\\s+(?:the|every)\\s+month)?$`).exec(body);
  if (m) return { rule: { freq: 'monthly', byweekday: [WEEKDAYS[m[2]]], nth: ORDINALS[m[1]] } };
  const everyYears = new RegExp(`^(?:(${NUM})\\s+)?years?\\s+on\\s+(.+)$`).exec(body);
  const years = everyYears ? readNumber(everyYears[1] || undefined) : 1;
  if (!years || years > 1000) return null;
  const yearBody = everyYears ? everyYears[2] : body;
  m = MONTH_DAY.exec(yearBody);
  const md = m ? { day: Number(m[2]), month: MONTHS[m[1]] } : (m = DAY_MONTH.exec(yearBody)) ? { day: Number(m[1]), month: MONTHS[m[2]] } : null;
  if (md && !m[3]) {
    // de eerstvolgende keer, vandaag meegeteld
    for (const y of [today.getFullYear(), today.getFullYear() + 1, today.getFullYear() + 2, today.getFullYear() + 3, today.getFullYear() + 4]) {
      if (validYmd(y, md.month, md.day) && new Date(y, md.month - 1, md.day) >= today) return { rule: withInterval({ freq: 'yearly', bymonthday: md.day }, years), anchor: new Date(y, md.month - 1, md.day) };
    }
  }
  return null;
}

const SHORT_REPEAT = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year', annually: 'year' };

// ---------- openbaar ----------

/**
 * Leest een Engelse datum of herhaling zoals Todoist die in een back-up of CSV-sjabloon zet.
 * @param {string} text
 * @param {Date} [now]
 * @returns {{ date: string, string: string, lang: 'en', recurrence?: object } | null} een `due` (zie SPEC.md), of null
 */
export function parseDateEn(text, now = new Date()) {
  if (typeof text !== 'string') return null;
  const original = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!original || original.length > 200) return null;
  const s = original.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').replace(/(?<![ap]\.m)\.$/, '').trim();
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[ t](\d{2}:\d{2})(?::\d{2})?)?$/.exec(s);
  if (iso) {
    const date = iso[2] ? `${iso[1]}T${iso[2]}` : iso[1];
    return isValidDate(date) ? { date, string: original, lang: 'en' } : null;
  }
  const { rest, time, bad } = takeTime(s);
  if (bad) return null;
  const today = startOfDay(now);
  const stamp = (d) => (time ? `${localDate(d)}T${pad(time.hour)}:${pad(time.minute)}` : localDate(d));

  const every = /^(every|ev|each)(!?)\s+(.+)$/.exec(rest);
  const short = /^(daily|weekly|monthly|yearly|annually)$/.exec(rest);
  if (every || short) {
    const fromCompletion = Boolean(every?.[2]);
    const found = recurrenceRule(every ? every[3] : SHORT_REPEAT[short[1]], today);
    if (!found) return null;
    const rule = fromCompletion ? { ...found.rule, fromCompletion: true } : found.rule;
    if (!isValidRecurrence(rule)) return null;
    const plain = { ...found.rule };
    const date = found.anchor ? stamp(found.anchor) : firstOccurrence(plain, now, time);
    return isValidDate(date) ? { date, string: original, lang: 'en', recurrence: rule } : null;
  }
  const day = singleDate(rest, today);
  if (!day) return null;
  const date = stamp(day);
  return isValidDate(date) ? { date, string: original, lang: 'en' } : null;
}

// ---------- een datum in de titel van een taak (snel toevoegen in het Engels) ----------

// Korte vormen die ook gewone woorden of namen zijn ("Call Tom", "Buy sun cream") tellen in een titel niet los als datum:
// "tom" en "tod" nooit, een afgekorte weekdag alleen na next/this/on/every/each/ev, na "and" of "&", of na een andere weekdag.
const NEVER_INLINE = new Set(['tom', 'tod']);
const SHORT_WEEKDAYS = new Set(['mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun']);
const INTRO = new Set(['next', 'this', 'on', 'every', 'every!', 'each', 'ev', 'ev!', 'and', '&']);
// Snelle voorselectie: zonder cijfer of een van deze woorden staat er zeker geen datum in.
const HINT = new RegExp(`\\d|(?:^|[^\\p{L}])(?:today|tomorrow|tmrw?|yesterday|next|every|ev|each|daily|weekly|monthly|yearly|annually|noon|midday|midnight|${WD}|${MON})(?!\\p{L})`, 'iu');
const MAX_WORDS = 10; // "every last friday of the month at 9am" is er acht

const bareWord = (word) => word.toLowerCase().replace(/[,.]+$/, '');

function allowedInTitle(words) {
  for (let i = 0; i < words.length; i++) {
    const w = bareWord(words[i]);
    if (NEVER_INLINE.has(w)) return false;
    if (SHORT_WEEKDAYS.has(w)) {
      const before = i > 0 ? bareWord(words[i - 1]) : null;
      if (!before || !(INTRO.has(before) || Object.hasOwn(WEEKDAYS, before))) return false;
    }
  }
  return true;
}

const tidy = (s) => s.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').replace(/[\s,]+$/, '').trim();

/**
 * Zoekt een Engelse datum of herhaling in de titel van een taak, zoals core/dateNl.js dat in het Nederlands doet:
 * "Call mom tomorrow at 6pm", "Gym every mon, wed and fri at 7am", "Report next friday", "Pay rent every 1st".
 * Het langste stuk dat als datum te lezen is wint; bij gelijke lengte het laatste. Een tilde ervoor ("Watch ~Tomorrow")
 * betekent: geen datum, en de tilde verdwijnt; een tilde aan het begin van de regel geldt voor de hele regel.
 * @param {string} text
 * @param {Date} [now]
 * @returns {{ content: string, due: object | null, range: [number, number] | null } | null}
 */
export function parseDueEn(text, now = new Date()) {
  if (typeof text !== 'string') return null;
  const source = normalizeText(text);
  if (!source.trim() || source.length > 500) return null;
  if (source.trimStart().startsWith('~')) return { content: tidy(source.trimStart().slice(1)), due: null, range: null }; // de hele regel: geen datum
  if (!HINT.test(source)) return null;
  const words = [...source.matchAll(/\S+/g)].map((m) => ({ word: m[0], start: m.index, end: m.index + m[0].length }));
  let best = null;
  for (let i = 0; i < words.length; i++) {
    const escaped = words[i].word.startsWith('~');
    for (let j = Math.min(words.length, i + MAX_WORDS); j > i; j--) {
      if (best && j - i < best.length) break; // korter dan wat er al gevonden is
      const part = words.slice(i, j).map((w) => w.word);
      if (escaped) part[0] = part[0].slice(1);
      if (!allowedInTitle(part)) continue;
      const due = parseDateEn(part.join(' '), now);
      if (!due) continue;
      best = { i, j, length: j - i, due, escaped }; // even lang als het vorige: dit staat verder naar rechts en wint
      break;
    }
  }
  if (!best) return null;
  const start = words[best.i].start;
  const end = words[best.j - 1].end;
  if (best.escaped) return { content: tidy(source.slice(0, start) + source.slice(start + 1)), due: null, range: null };
  const string = source.slice(start, end).replace(/[,.]+$/, '');
  return { content: tidy(`${source.slice(0, start)} ${source.slice(end)}`), due: { ...best.due, string }, range: [start, start + string.length] };
}
