// Nederlandse datums in gewone taal.
//
// Eenmalige datums ("volgende week donderdag", "vrijdag om 14:00", "31-12") komen van een eerder gebouwde herkenner
// (vendor/nlDatum.generated.js, gebundeld met chrono-node; zie THIRD_PARTY_NOTICES.md).
// Herhalingen ("elke maandag om 9 uur", "om de week") slaat die herkenner bewust over; die staan hier.
//
// Uitkomst is een `due` in de vorm van het datamodel: { date, string, lang, recurrence? } met een zwevende
// datum ('YYYY-MM-DD', of 'YYYY-MM-DDTHH:MM' als er een tijdstip is genoemd).

import { markeerDatum, parseTitle } from '../vendor/nlDatum.generated.js';
import { isValidDate, nextOccurrence } from '../../shared/recurrence.js';

const pad = (n) => String(n).padStart(2, '0');
/** Lokale datum als 'YYYY-MM-DD'. */
export const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDateTime = (d) => `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// ---------- eenmalige datum (via de bestaande herkenner) ----------

/**
 * De herkenner geeft altijd een tijdstip terug en vult een standaardtijd in als er geen genoemd is. Door met twee
 * verschillende standaardtijden te vragen, zien we het verschil: is de uitkomst gelijk, dan stond de tijd in de tekst.
 * (Uitzondering: "vandaag" zonder tijd geeft in beide gevallen 23:59; dat tellen we als datum zonder tijd.)
 */
function parseSingle(text, now) {
  const a = parseTitle(text, now, { defaultTime: '00:00' });
  if (!a) return null;
  if (!a.due) return { content: a.title, due: null, range: null }; // alleen een ~ weggehaald
  const b = parseTitle(text, now, { defaultTime: '00:01' });
  const mark = markeerDatum(text, now, { defaultTime: '00:00' });
  const d = a.due;
  const endOfToday = localDate(d) === localDate(now) && d.getHours() === 23 && d.getMinutes() === 59;
  const hasTime = Boolean(b?.due) && b.due.getTime() === d.getTime() && !endOfToday;
  return {
    content: a.title,
    due: { date: hasTime ? localDateTime(d) : localDate(d), string: text.slice(mark.index, mark.eind), lang: 'nl' },
    range: [mark.index, mark.eind],
  };
}

// ---------- herhalingen ----------

const WEEKDAYS = { maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7, ma: 1, di: 2, wo: 3, do: 4, vr: 5, za: 6, zo: 7 };
const NUMBERS = { een: 1, één: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10, elf: 11, twaalf: 12, andere: 2, tweede: 2 };
const WD = 'maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|ma|di|wo|do|vr|za|zo';
const NUM = '\\d{1,3}|een|één|twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf|andere|tweede';
const UNIT = 'werkdagen|werkdag|dagen|dag|weekend|weken|week|maanden|maand|kwartalen|kwartaal|jaren|jaar';
const B = '(?<![\\p{L}\\p{N}])'; // geen letter of cijfer ervoor
const E = '(?![\\p{L}\\p{N}])'; // geen letter of cijfer erna
const ELK = '(?:elke|elk|iedere|ieder)';
const SEP = '(?:\\s*,\\s*(?:en\\s+)?|\\s+en\\s+|\\s*[/&+]\\s*)';

const readNumber = (s) => (s === undefined ? 1 : /^\d+$/.test(s) ? Number(s) : NUMBERS[s.toLowerCase()]);

function unitRule(unit, n) {
  const u = unit.toLowerCase();
  if (u.startsWith('werkdag')) return { freq: 'weekly', byweekday: [1, 2, 3, 4, 5] };
  if (u === 'weekend') return { freq: 'weekly', byweekday: [6] };
  const base = u.startsWith('dag') ? { freq: 'daily' } : u.startsWith('we') ? { freq: 'weekly' } : u.startsWith('maand') ? { freq: 'monthly' } : u.startsWith('kwarta') ? { freq: 'monthly' } : { freq: 'yearly' };
  const interval = u.startsWith('kwarta') ? 3 * n : n;
  return interval > 1 ? { ...base, interval } : base;
}

/** Elk patroon geeft een herhalingsregel, of null als de tekst toch geen herhaling is. */
const PATTERNS = [
  // elke maandag · elke ma, wo en vr · elke andere vrijdag
  {
    re: new RegExp(`${B}${ELK}\\s+(?:(${NUM})\\s+)?((?:${WD})(?:${SEP}(?:${WD}))*)${E}`, 'iu'),
    rule: (m) => {
      // "elke tweede maandag van de maand" is iets anders dan om de week; dat ondersteunen we niet, dus niet raden
      if (/^\s+van\s+de\s+maand/iu.test(m.input.slice(m.index + m[0].length))) return null;
      const days = [...new Set(m[2].toLowerCase().match(new RegExp(WD, 'g')).map((d) => WEEKDAYS[d]))].sort((a, b) => a - b);
      const n = readNumber(m[1]);
      return n > 1 ? { freq: 'weekly', interval: n, byweekday: days } : { freq: 'weekly', byweekday: days };
    },
  },
  // elke laatste dag van de maand
  { re: new RegExp(`${B}${ELK}\\s+laatste\\s+dag\\s+van\\s+de\\s+maand${E}`, 'iu'), rule: () => ({ freq: 'monthly', bymonthday: 31 }) },
  // elke 15e · elke 1e van de maand · elke eerste van de maand
  {
    // niet als er een weekdag op volgt ("elke eerste maandag van de maand" ondersteunen we niet)
    re: new RegExp(`${B}${ELK}\\s+(?:(\\d{1,2})(?:e|de|ste)|(eerste))${E}(?!\\s+(?:${WD})${E})(?:\\s+van\\s+de\\s+maand${E})?`, 'iu'),
    rule: (m) => {
      const day = m[2] ? 1 : Number(m[1]);
      return day >= 1 && day <= 31 ? { freq: 'monthly', bymonthday: day } : null;
    },
  },
  // elke dag · elke 2 weken · iedere maand · elk jaar · elke werkdag · elk kwartaal
  { re: new RegExp(`${B}${ELK}\\s+(?:(${NUM})\\s+)?(${UNIT})${E}`, 'iu'), rule: (m) => unitRule(m[2], readNumber(m[1])) },
  // om de dag (= elke 2 dagen) · om de 3 weken · om de andere week
  {
    re: new RegExp(`${B}om\\s+de\\s+(?:(${NUM})\\s+)?(dagen|dag|weken|week|maanden|maand|jaren|jaar)${E}`, 'iu'),
    rule: (m) => unitRule(m[2], m[1] === undefined ? 2 : readNumber(m[1])),
  },
  // dagelijks · wekelijks · tweewekelijks · maandelijks · jaarlijks
  {
    re: new RegExp(`${B}(dagelijks|tweewekelijks|wekelijks|maandelijks|jaarlijks)${E}`, 'iu'),
    rule: (m) => ({ dagelijks: { freq: 'daily' }, wekelijks: { freq: 'weekly' }, tweewekelijks: { freq: 'weekly', interval: 2 }, maandelijks: { freq: 'monthly' }, jaarlijks: { freq: 'yearly' } })[m[1].toLowerCase()],
  },
];

/** Een tijdstip direct achter de herhaling ("… om 9 uur", "… om half 10"), gelezen door dezelfde herkenner als eenmalige datums. */
function timeAfter(rest, now) {
  const prefix = 'taak vandaag';
  const probe = prefix + rest;
  const a = markeerDatum(probe, now, { defaultTime: '00:00' });
  if (!a || a.index !== 5 || a.eind <= prefix.length) return null;
  const b = markeerDatum(probe, now, { defaultTime: '00:01' });
  if (!b || b.due.getTime() !== a.due.getTime()) return null;
  return { hour: a.due.getHours(), minute: a.due.getMinutes(), length: a.eind - prefix.length };
}

const isoWeekday = (d) => d.getDay() || 7;
const daysInMonth = (y, m0) => new Date(y, m0 + 1, 0).getDate();

/** De eerste datum vanaf vandaag die bij de regel past. */
function firstOccurrence(rule, now, time) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (rule.byweekday) {
    while (!rule.byweekday.includes(isoWeekday(d))) d.setDate(d.getDate() + 1);
  } else if (rule.freq === 'monthly' && rule.bymonthday) {
    d.setDate(Math.min(rule.bymonthday, daysInMonth(d.getFullYear(), d.getMonth())));
    if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      d.setDate(Math.min(rule.bymonthday, daysInMonth(d.getFullYear(), d.getMonth())));
    }
  }
  if (!time) return localDate(d);
  const date = `${localDate(d)}T${pad(time.hour)}:${pad(time.minute)}`;
  const passed = localDate(d) === localDate(now) && time.hour * 60 + time.minute <= now.getHours() * 60 + now.getMinutes();
  return passed ? nextOccurrence(date, rule) : date; // dat tijdstip is vandaag al geweest
}

function removeSpan(text, start, end) {
  let s = `${text.slice(0, start)} ${text.slice(end)}`.replace(/\s+/g, ' ').replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, '');
  if (s && /\p{Lu}/u.test(text.trimStart()[0] ?? '') && /\p{Ll}/u.test(s[0])) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

function parseRecurring(text, now) {
  let best = null;
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m || (best && best.m.index <= m.index)) continue;
    const rule = p.rule(m);
    if (rule) best = { m, rule };
  }
  if (!best) return null;
  const start = best.m.index;
  if (text[start - 1] === '~') return { content: (text.slice(0, start - 1) + text.slice(start)).trim(), due: null, range: null }; // ~ = geen datum
  let end = start + best.m[0].length;
  const time = timeAfter(text.slice(end), now);
  if (time) end += time.length;
  let rule = best.rule;
  // "elke maand" en "elk jaar" zonder dag: de dag van vandaag vastleggen, zodat de 31e de 31e blijft
  if ((rule.freq === 'monthly' || rule.freq === 'yearly') && !rule.bymonthday) rule = { ...rule, bymonthday: now.getDate() };
  const content = removeSpan(text, start, end);
  if (!content) return null; // de tekst bestond alleen uit de herhaling
  return {
    content,
    due: { date: firstOccurrence(rule, now, time), string: text.slice(start, end).trim(), lang: 'nl', recurrence: rule },
    range: [start, end],
  };
}

// ---------- openbare functies ----------

/**
 * Zoekt een datum of herhaling in de titel van een taak.
 * @param {string} text
 * @param {Date} [now]
 * @returns {{ content: string, due: object | null, range: [number, number] | null } | null}
 *   null = niets herkend; `content` is de titel zonder de datumtekst; `range` is de plek van de datum in `text`.
 */
export function parseDue(text, now = new Date()) {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (!text.startsWith('~')) {
    const recurring = parseRecurring(text, now);
    if (recurring) return recurring;
  }
  return parseSingle(text, now);
}

/**
 * Leest een tekst die alleen een datum bevat ("morgen", "elke maandag om 9 uur", "2026-12-01"), bijvoorbeeld uit een datumveld.
 * @returns {object | null} een `due`, of null als de tekst niet (volledig) als datum is herkend
 */
export function parseDateText(text, now = new Date()) {
  const t = (text ?? '').trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(t)) return isValidDate(t) ? { date: t, string: t, lang: 'nl' } : null;
  const r = parseDue(`taak ${t}`, now);
  return r && r.due && r.content === 'taak' ? r.due : null;
}
