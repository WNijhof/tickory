// Nederlandse datums in gewone taal.
//
// Drie lagen, in deze volgorde:
//   1. Herhalingen ("elke maandag om 9 uur", "elke tweede dinsdag", "om de week", "elk jaar op 5 december"): hier.
//   2. Eenmalige datums ("volgende week donderdag", "vrijdag om 14:00", "31-12"): een eerder gebouwde herkenner
//      (vendor/nlDatum.generated.js, gebundeld met chrono-node; zie THIRD_PARTY_NOTICES.md). Die laat bewust alles liggen
//      wat ook Engels kan zijn ("25 december", "april"), omdat ze ooit naast een Engelse herkenner draaide.
//   3. Nederlandse aanvullingen op laag 2, want in deze app is er geen Engelse herkenner die het overneemt: een dag met
//      maandnaam ("25 december"), begin/midden/eind van een maand, en feestdagen ("voor Sinterklaas", "tegen Pasen").
//
// Uitkomst is een `due` in de vorm van het datamodel: { date, string, lang, recurrence? } met een zwevende
// datum ('YYYY-MM-DD', of 'YYYY-MM-DDTHH:MM' als er een tijdstip is genoemd).

import { markeerDatum, parseTitle } from '../vendor/nlDatum.generated.js';
import { isValidDate, nextOccurrence, nthWeekdayOfMonth } from '../../shared/recurrence.js';
import { normalizeText } from '../../shared/text.js';

const pad = (n) => String(n).padStart(2, '0');
/** Lokale datum als 'YYYY-MM-DD'. */
export const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDateTime = (d) => `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysInMonth = (y, m0) => new Date(y, m0 + 1, 0).getDate();
const validYmd = (y, m, d) => {
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
};
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

const B = '(?<![\\p{L}\\p{N}])'; // geen letter of cijfer ervoor
const E = '(?![\\p{L}\\p{N}])'; // geen letter of cijfer erna

// ---------- maanden en kalenderrekenen ----------

const MONTHS = {
  januari: 1, jan: 1, februari: 2, feb: 2, maart: 3, mrt: 3, april: 4, apr: 4, mei: 5, juni: 6, jun: 6, juli: 7, jul: 7,
  augustus: 8, aug: 8, september: 9, sept: 9, sep: 9, oktober: 10, okt: 10, november: 11, nov: 11, december: 12, dec: 12,
};
// langste eerst, zodat "december" voor "dec" wint
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

/**
 * De eerstvolgende datum vanaf vandaag met deze dag en maand ('YYYY-MM-DD'). Met een jaar: alleen als die datum
 * niet in het verleden ligt. Dagen die niet bestaan (31 april, 29 februari in een gewoon jaar) geven null,
 * of vallen op het eerstvolgende jaar waarin ze wel bestaan.
 */
function resolveDate(day, month, year, now) {
  const today = startOfDay(now);
  const years = year ? [year] : Array.from({ length: 9 }, (_, i) => today.getFullYear() + i);
  for (const y of years) {
    if (validYmd(y, month, day) && new Date(y, month - 1, day) >= today) return ymd(y, month, day);
  }
  return null;
}

/** Eerste Paasdag (Gregoriaanse kalender, algoritme van Meeus/Jones/Butcher). */
function easterDate(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

// ---------- eenmalige datum (via de bestaande herkenner) ----------

/** Vrijdag van deze week ("deze week" als deadline); in het weekend de vrijdag van de volgende week. */
function endOfWeek(now) {
  const dow = (now.getDay() + 6) % 7; // maandag = 0
  const d = startOfDay(now);
  d.setDate(d.getDate() + (dow <= 4 ? 4 - dow : 11 - dow));
  return d;
}

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
  const matched = text.slice(mark.index, mark.eind);
  // "deze week" is voor een deadline het einde van de week; de herkenner maakt er een willekeurige dag van
  const date = /^deze\s+week$/iu.test(matched.trim()) ? localDate(endOfWeek(now)) : hasTime ? localDateTime(d) : localDate(d);
  return { content: a.title, due: { date, string: matched, lang: 'nl' }, range: [mark.index, mark.eind] };
}

// ---------- herhalingen ----------

const WEEKDAYS = { maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7, ma: 1, di: 2, wo: 3, do: 4, vr: 5, za: 6, zo: 7 };
// "tweede" staat hier bewust niet bij: "elke tweede dinsdag" is de tweede dinsdag van de maand, niet "om de week"
const NUMBERS = { een: 1, één: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10, elf: 11, twaalf: 12, andere: 2 };
const ORDINALS = { eerste: 1, tweede: 2, derde: 3, vierde: 4, laatste: -1 };
const WD = 'maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|ma|di|wo|do|vr|za|zo';
const NUM = '\\d{1,3}|een|één|twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf|andere';
const ORD = 'eerste|tweede|derde|vierde|laatste|[1-4](?:e|de|ste)';
const UNIT = 'werkdagen|werkdag|dagen|dag|weekend|weken|week|maanden|maand|kwartalen|kwartaal|jaren|jaar';
const ELK = '(?:elke|elk|iedere|ieder)';
const SEP = '(?:\\s*,\\s*(?:en\\s+)?|\\s+en\\s+|\\s*[/&+]\\s*)';
const DAYPART_TIME = { ochtend: { hour: 9, minute: 0 }, morgen: { hour: 9, minute: 0 }, middag: { hour: 15, minute: 0 }, avond: { hour: 20, minute: 0 } };

const readNumber = (s) => (s === undefined ? 1 : /^\d+$/.test(s) ? Number(s) : NUMBERS[s.toLowerCase()]);
const readOrdinal = (s) => ORDINALS[s.toLowerCase()] ?? Number(s[0]);

function unitRule(unit, n) {
  const u = unit.toLowerCase();
  if (u.startsWith('werkdag')) return { freq: 'weekly', byweekday: [1, 2, 3, 4, 5] };
  if (u === 'weekend') return { freq: 'weekly', byweekday: [6] };
  const base = u.startsWith('dag') ? { freq: 'daily' } : u.startsWith('we') ? { freq: 'weekly' } : u.startsWith('maand') ? { freq: 'monthly' } : u.startsWith('kwarta') ? { freq: 'monthly' } : { freq: 'yearly' };
  const interval = u.startsWith('kwarta') ? 3 * n : n;
  return interval > 1 ? { ...base, interval } : base;
}

/**
 * Elk patroon geeft een herhalingsregel, of null als de tekst toch geen herhaling is. De volgorde telt: bij een gelijk
 * beginpunt wint het eerste patroon ("elke eerste maandag" is de n-de weekdag, niet "elke eerste").
 */
const PATTERNS = [
  // elke eerste maandag · elke tweede dinsdag van de maand · elke laatste vrijdag · elke maand op de eerste maandag
  {
    re: new RegExp(`${B}${ELK}\\s+(?:maand\\s+op\\s+de\\s+)?(${ORD})\\s+(${WD})${E}(?:\\s+van\\s+de\\s+maand${E})?`, 'iu'),
    rule: (m) => ({ freq: 'monthly', byweekday: [WEEKDAYS[m[2].toLowerCase()]], nth: readOrdinal(m[1]) }),
  },
  // elke maandag · elke ma, wo en vr · elke andere vrijdag
  {
    re: new RegExp(`${B}${ELK}\\s+(?:(${NUM})\\s+)?((?:${WD})(?:${SEP}(?:${WD}))*)${E}`, 'iu'),
    rule: (m) => {
      // "elke 2e dinsdag van de maand" is iets anders dan om de week; dat staat hierboven, dus hier niet raden
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
    // niet als er een weekdag op volgt ("elke eerste maandag" staat hierboven)
    re: new RegExp(`${B}${ELK}\\s+(?:(\\d{1,2})(?:e|de|ste)|(eerste))${E}(?!\\s+(?:${WD})${E})(?:\\s+van\\s+de\\s+maand${E})?`, 'iu'),
    rule: (m) => {
      const day = m[2] ? 1 : Number(m[1]);
      return day >= 1 && day <= 31 ? { freq: 'monthly', bymonthday: day } : null;
    },
  },
  // elke dag · elke 2 weken · iedere maand · elk jaar · elke werkdag · elk kwartaal
  { re: new RegExp(`${B}${ELK}\\s+(?:(${NUM})\\s+)?(${UNIT})${E}`, 'iu'), rule: (m) => unitRule(m[2], readNumber(m[1])) },
  // elke ochtend · elke morgen · elke middag · elke avond (met een vast tijdstip, tenzij er zelf een staat)
  {
    re: new RegExp(`${B}${ELK}\\s+(ochtend|morgen|middag|avond)${E}`, 'iu'),
    rule: () => ({ freq: 'daily' }),
    defaultTime: (m) => DAYPART_TIME[m[1].toLowerCase()],
  },
  // om de dag (= elke 2 dagen) · om de 3 weken · om de andere week
  {
    re: new RegExp(`${B}om\\s+de\\s+(?:(${NUM})\\s+)?(dagen|dag|weken|week|maanden|maand|jaren|jaar)${E}`, 'iu'),
    rule: (m) => unitRule(m[2], m[1] === undefined ? 2 : readNumber(m[1])),
  },
  // dagelijks · wekelijks · tweewekelijks · maandelijks · jaarlijks · doordeweeks
  {
    re: new RegExp(`${B}(dagelijks|tweewekelijks|wekelijks|maandelijks|jaarlijks|doordeweeks)${E}`, 'iu'),
    rule: (m) => ({
      dagelijks: { freq: 'daily' }, wekelijks: { freq: 'weekly' }, tweewekelijks: { freq: 'weekly', interval: 2 },
      maandelijks: { freq: 'monthly' }, jaarlijks: { freq: 'yearly' }, doordeweeks: { freq: 'weekly', byweekday: [1, 2, 3, 4, 5] },
    })[m[1].toLowerCase()],
  },
];

// "elke maand op de 15e" · "elke maand op de laatste dag"
const DAY_OF_MONTH_REST = /^\s+op\s+(?:de\s+)?(?:(\d{1,2})(?:e|de|ste)|(eerste|laatste)(?:\s+dag)?)(?![\p{L}\p{N}])/iu;
// "elk jaar op 5 december" · "jaarlijks 5 december"
const YEAR_DATE_REST = new RegExp(`^\\s+(?:op\\s+)?(?:de\\s+)?(\\d{1,2})\\s+(${MONTH_RE})\\.?(?![\\p{L}\\p{N}])`, 'iu');

/** Een tijdstip direct achter de herhaling ("… om 9 uur", "… om half 10"), gelezen door dezelfde herkenner als eenmalige datums. */
function timeAfter(rest, now) {
  const prefix = 'taak vandaag';
  const probe = prefix + rest;
  const a = markeerDatum(probe, now, { defaultTime: '00:00' });
  if (!a || a.index !== 5 || a.eind <= prefix.length) return null;
  const b = markeerDatum(probe, now, { defaultTime: '00:01' });
  if (!b || b.due.getTime() !== a.due.getTime()) return null;
  return { hour: a.due.getHours(), minute: a.due.getMinutes(), length: a.eind - prefix.length, raw: rest.slice(0, a.eind - prefix.length) };
}

/**
 * Bij "elke ochtend/middag/avond om 7 uur" bepaalt het dagdeel wat "7" is. De herkenner kent die samenhang niet en leest
 * "om 7 uur" los als 19:00 (in het Nederlands is "om 2 uur" vrijwel altijd 14:00). Een tijd op de 24-uursklok ("om 14:00") blijft staan.
 */
function adjustToDaypart(time, part) {
  if (/(?<![\d:.])(?:1[3-9]|2[0-3])(?!\d)/.test(time.raw)) return time;
  let hour = time.hour;
  if ((part === 'ochtend' || part === 'morgen') && hour > 12) hour -= 12;
  else if ((part === 'middag' || part === 'avond') && hour < 12) hour += 12;
  return { ...time, hour };
}

const isoWeekday = (d) => d.getDay() || 7;

/** De eerste datum vanaf vandaag die bij de regel past. */
function firstOccurrence(rule, now, time) {
  const today = startOfDay(now);
  let d = new Date(today);
  if (rule.nth !== undefined) {
    // de n-de weekdag van de maand: deze maand als die nog niet voorbij is, anders de volgende
    let y = today.getFullYear();
    let m0 = today.getMonth();
    for (let i = 0; i < 3; i++) {
      d = new Date(y, m0, nthWeekdayOfMonth(y, m0, rule.byweekday[0], rule.nth));
      if (d >= today) break;
      [y, m0] = m0 === 11 ? [y + 1, 0] : [y, m0 + 1];
    }
  } else if (rule.byweekday) {
    while (!rule.byweekday.includes(isoWeekday(d))) d.setDate(d.getDate() + 1);
  } else if (rule.freq === 'monthly' && rule.bymonthday) {
    d.setDate(Math.min(rule.bymonthday, daysInMonth(d.getFullYear(), d.getMonth())));
    if (d < today) {
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      d.setDate(Math.min(rule.bymonthday, daysInMonth(d.getFullYear(), d.getMonth())));
    }
  }
  if (!time) return localDate(d);
  const date = `${localDate(d)}T${pad(time.hour)}:${pad(time.minute)}`;
  const passed = localDate(d) === localDate(now) && time.hour * 60 + time.minute <= now.getHours() * 60 + now.getMinutes();
  return passed ? (nextOccurrence(date, rule) ?? date) : date; // dat tijdstip is vandaag al geweest
}

/** Haalt een stuk uit de tekst en laat een nette titel over: een hoofdletter vooraan blijft, leestekens kleven aan het woord ervoor. */
function removeSpan(text, start, end) {
  let s = `${text.slice(0, start)} ${text.slice(end)}`.replace(/\s+/g, ' ').replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, '');
  if (s && /\p{Lu}/u.test(text.trimStart()[0] ?? '') && /\p{Ll}/u.test(s[0])) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

// "elke! 3 dagen" · "elke! week": herhalen vanaf het afvinken. Het uitroepteken wordt voor het zoeken een spatie (zelfde lengte,
// dus alle posities kloppen) en de regel krijgt `fromCompletion`.
const FROM_COMPLETION = /(?<![\p{L}\p{N}])(elke|elk|iedere|ieder)!(?=\s)/iu;

function parseRecurring(original, now) {
  const fromCompletion = FROM_COMPLETION.test(original);
  const text = fromCompletion ? original.replace(FROM_COMPLETION, (m) => `${m.slice(0, -1)} `) : original;
  let best = null;
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m || (best && best.m.index <= m.index)) continue;
    const rule = p.rule(m);
    if (rule) best = { m, rule, p };
  }
  if (!best) return null;
  const start = best.m.index;
  if (text[start - 1] === '~') return { content: (text.slice(0, start - 1) + text.slice(start)).trim(), due: null, range: null }; // ~ = geen datum
  let end = start + best.m[0].length;
  let rule = best.rule;
  let anchor = null; // vaste startdatum (jaarlijks met een datum)

  // "elke maand op de 15e" en "elk jaar op 5 december": de dag erbij nemen, anders blijft die tekst in de titel staan
  const rest = text.slice(end);
  if (rule.freq === 'monthly' && !rule.byweekday && rule.bymonthday === undefined) {
    const d = DAY_OF_MONTH_REST.exec(rest);
    const day = d ? (d[2] ? (d[2].toLowerCase() === 'eerste' ? 1 : 31) : Number(d[1])) : 0;
    if (d && day >= 1 && day <= 31) {
      rule = { ...rule, bymonthday: day };
      end += d[0].length;
    }
  } else if (rule.freq === 'yearly') {
    const d = YEAR_DATE_REST.exec(rest);
    const found = d ? resolveDate(Number(d[1]), MONTHS[d[2].toLowerCase()], null, now) : null;
    if (d && found) {
      anchor = found;
      rule = { ...rule, bymonthday: Number(d[1]) };
      end += d[0].length;
    }
  }

  const found = timeAfter(text.slice(end), now);
  if (found) end += found.length;
  const time = found && best.p.defaultTime ? adjustToDaypart(found, best.m[1].toLowerCase()) : found;
  const when = time ?? best.p.defaultTime?.(best.m) ?? null;
  // "elke maand" en "elk jaar" zonder dag: de dag van vandaag vastleggen, zodat de 31e de 31e blijft
  if ((rule.freq === 'monthly' || rule.freq === 'yearly') && rule.bymonthday === undefined && rule.nth === undefined) rule = { ...rule, bymonthday: now.getDate() };
  const content = removeSpan(text, start, end);
  if (!content) return null; // de tekst bestond alleen uit de herhaling
  const date = anchor ? (when ? `${anchor}T${pad(when.hour)}:${pad(when.minute)}` : anchor) : firstOccurrence(rule, now, when);
  return { content, due: { date, string: original.slice(start, end).trim(), lang: 'nl', recurrence: fromCompletion ? { ...rule, fromCompletion: true } : rule }, range: [start, end] };
}

// ---------- Nederlandse aanvullingen op de eenmalige herkenner ----------

const PREP = '(?:(?:voor|vóór|tegen|uiterlijk|op|per)\\s+)?'; // gaat samen met de datum uit de titel
const NOT_A_DATE_BEFORE = /(?<![\p{L}])(?:hoofdstuk(?:ken)?|pagina'?s?|blz\.?|nr\.?|nummers?|stap|versie|kamer|lokaal|artikel|paragraaf|les|deel|ronde)\s*$/iu;

// een dag met een maandnaam: "25 december", "1 mei", "3 maart 2027", "op 5 dec"
const BARE_DATE = new RegExp(`(?<![\\p{L}\\p{N}\\-/.:])${PREP}(\\d{1,2})\\s+(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?${E}`, 'iu');
// begin, midden of eind van een maand: "begin december", "eind januari", "midden mei"
const MONTH_PART = new RegExp(`${B}${PREP}(begin|midden|einde?)\\s+(?:van\\s+)?(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?${E}`, 'iu');

// Feestdagen horen alleen bij een datum als er een voorzetsel voor staat ("voor Kerst", "op Koningsdag"):
// "Kerst inkopen doen" is gewoon een taak.
const fixed = (month, day) => ({ fixed: [month, day] });
const easter = (offset) => ({ easter: offset });
const HOLIDAYS = {
  'eerste kerstdag': fixed(12, 25), '1e kerstdag': fixed(12, 25), '1ste kerstdag': fixed(12, 25), kerstdag: fixed(12, 25), kerst: fixed(12, 25),
  'tweede kerstdag': fixed(12, 26), '2e kerstdag': fixed(12, 26), '2de kerstdag': fixed(12, 26),
  'oud en nieuw': fixed(12, 31), 'oud & nieuw': fixed(12, 31), oudejaarsdag: fixed(12, 31), oudjaarsdag: fixed(12, 31), oudjaar: fixed(12, 31),
  nieuwjaarsdag: fixed(1, 1), nieuwjaar: fixed(1, 1),
  sinterklaasavond: fixed(12, 5), sinterklaas: fixed(12, 5), pakjesavond: fixed(12, 5),
  koningsdag: fixed(4, 27), dodenherdenking: fixed(5, 4), bevrijdingsdag: fixed(5, 5),
  'goede vrijdag': easter(-2),
  paaszondag: easter(0), 'eerste paasdag': easter(0), '1e paasdag': easter(0), pasen: easter(0),
  paasmaandag: easter(1), 'tweede paasdag': easter(1), '2e paasdag': easter(1),
  hemelvaartsdag: easter(39), hemelvaart: easter(39),
  pinksteren: easter(49), pinksterzondag: easter(49), 'eerste pinksterdag': easter(49), '1e pinksterdag': easter(49),
  pinkstermaandag: easter(50), 'tweede pinksterdag': easter(50), '2e pinksterdag': easter(50),
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'); // alleen echt speciale tekens (in Unicode-modus is "\&" ongeldig)
const HOLIDAY_RE = new RegExp(
  `${B}(?:voor|vóór|tegen|uiterlijk|op|per)\\s+(?:(?:de|het)\\s+)?(${Object.keys(HOLIDAYS).sort((a, b) => b.length - a.length).map(escapeRe).join('|')})${E}`, 'iu');

function holidayDate(name, now) {
  const h = HOLIDAYS[name.toLowerCase().replace(/\s+/g, ' ')];
  if (!h) return null;
  const today = startOfDay(now);
  for (let y = today.getFullYear(); y < today.getFullYear() + 3; y++) {
    let d;
    if (h.fixed) d = new Date(y, h.fixed[0] - 1, h.fixed[1]);
    else { d = easterDate(y); d.setDate(d.getDate() + h.easter); }
    if (d >= today) return localDate(d);
  }
  return null;
}

function monthPartDate(kind, month, year, now) {
  const today = startOfDay(now);
  for (const y of year ? [year] : [today.getFullYear(), today.getFullYear() + 1]) {
    const day = kind === 'begin' ? 1 : kind === 'midden' ? 15 : daysInMonth(y, month - 1);
    if (new Date(y, month - 1, day) >= today) return ymd(y, month, day);
  }
  return null;
}

const insideUrl = (text, index, end) => {
  let b = index;
  while (b > 0 && !/\s/.test(text[b - 1])) b--;
  let e = end;
  while (e < text.length && !/\s/.test(text[e])) e++;
  const word = text.slice(b, e);
  return /:\/\//.test(word) || /^www\./i.test(word);
};

/** Wat er van de tekst overblijft zodra het stuk `start`..`end` weg is, met een eventueel tijdstip erachter erbij. */
function finishSpan(text, start, end, date, now) {
  if (text[start - 1] === '~') return { content: (text.slice(0, start - 1) + text.slice(start)).trim(), due: null, range: null };
  const time = timeAfter(text.slice(end), now);
  if (time) end += time.length;
  const content = removeSpan(text, start, end);
  if (!content) return null; // de tekst bestond alleen uit de datum
  return {
    content,
    due: { date: time ? `${date}T${pad(time.hour)}:${pad(time.minute)}` : date, string: text.slice(start, end).trim(), lang: 'nl' },
    range: [start, end],
  };
}

/**
 * Feestdag met voorzetsel ("voor Sinterklaas", "tegen Pasen"). Komt vóór de herkenner, want sommige namen bevatten een
 * weekdag ("Goede Vrijdag") die de herkenner anders als gewone vrijdag leest.
 */
function parseHoliday(text, now) {
  const m = HOLIDAY_RE.exec(text);
  const date = m ? holidayDate(m[1], now) : null;
  return date ? finishSpan(text, m.index, m.index + m[0].length, date, now) : null;
}

function parseDutchExtras(text, now) {
  const candidates = [];
  const pm = MONTH_PART.exec(text);
  if (pm) {
    const date = monthPartDate(pm[1].toLowerCase().replace(/^einde$/, 'eind'), MONTHS[pm[2].toLowerCase()], pm[3] ? Number(pm[3]) : null, now);
    if (date) candidates.push({ index: pm.index, length: pm[0].length, date });
  }
  const bare = [...text.matchAll(new RegExp(BARE_DATE.source, 'giu'))];
  for (const m of bare) {
    if (NOT_A_DATE_BEFORE.test(text.slice(0, m.index)) || insideUrl(text, m.index, m.index + m[0].length)) continue;
    const date = resolveDate(Number(m[1]), MONTHS[m[2].toLowerCase()], m[3] ? Number(m[3]) : null, now);
    if (date) candidates.push({ index: m.index, length: m[0].length, date });
  }
  if (candidates.length !== 1) return null; // meerdere datums in één titel: te onduidelijk om te raden
  const { index: start, length, date } = candidates[0];
  return finishSpan(text, start, start + length, date, now);
}

// ---------- openbare functies ----------

/**
 * In het Nederlands is "IJ" één letter: na het weghalen van de datum werd "ijs kopen" een "Ijs kopen"; dat hoort "IJs kopen" te zijn.
 * Alleen aanpassen als de hoofdletter door het weghalen is ontstaan (de gebruiker typte "ij…" met kleine letters).
 */
function fixIJ(content, original) {
  const word = /^\S+/u.exec(content)?.[0];
  if (!word || !word.startsWith('Ij')) return content;
  if (original.includes(word) || !original.includes(`i${word.slice(1)}`)) return content;
  return `IJ${word.slice(2)}${content.slice(word.length)}`;
}

/**
 * Zoekt een datum of herhaling in de titel van een taak.
 * @param {string} text
 * @param {Date} [now]
 * @returns {{ content: string, due: object | null, range: [number, number] | null } | null}
 *   null = niets herkend; `content` is de titel zonder de datumtekst; `range` is de plek van de datum in `text`.
 */
export function parseDue(text, now = new Date()) {
  if (typeof text !== 'string' || !text.trim()) return null;
  text = normalizeText(text);
  const escaped = text.startsWith('~');
  let r = escaped ? null : parseRecurring(text, now);
  if (!r && !escaped) {
    const holiday = parseHoliday(text, now);
    if (holiday) {
      // staat er behalve de feestdag nog een andere datum in? Dan is het te onduidelijk om te raden: niets aanraken
      const other = holiday.due && (parseSingle(holiday.content, now)?.due || parseRecurring(holiday.content, now)?.due);
      r = other ? null : holiday;
      return r ? { ...r, content: fixIJ(r.content, text) } : null;
    }
  }
  r ??= parseSingle(text, now);
  if (!r && !escaped) r = parseDutchExtras(text, now);
  return r ? { ...r, content: fixIJ(r.content, text) } : null;
}

/**
 * Leest een tekst die alleen een datum bevat ("morgen", "elke maandag om 9 uur", "2026-12-01"), bijvoorbeeld uit een datumveld.
 * @returns {object | null} een `due`, of null als de tekst niet (volledig) als datum is herkend
 */
export function parseDateText(text, now = new Date()) {
  const t = normalizeText(text ?? '').trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(t)) return isValidDate(t) ? { date: t, string: t, lang: 'nl' } : null;
  const r = parseDue(`taak ${t}`, now);
  return r && r.due && r.content === 'taak' ? r.due : null;
}
