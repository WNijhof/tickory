// Snel toevoegen: één regel tekst wordt een taak met datum, project, sectie, labels en prioriteit.
//
//   "Tandarts bellen morgen om 9 uur #Thuis @bellen p1"
//
//   #project   een bestaand project (namen met spaties mogen: de langste passende naam wint)
//   /sectie    een bestaande sectie in dat project
//   @label     een label; een onbekend label wordt aangemaakt. Een bestaand label met spaties of leestekens in de naam
//              ("@Uitgaan met Zoë") wordt op naam gevonden; de langste passende naam wint
//   p1 … p4    prioriteit (ook !!1 … !!4); 1 is de hoogste
//   {vrijdag}  een deadline (los van de datum waarop je eraan wilt werken)
//   !30m       een herinnering: !30m, !1u of !1h, !2d (minuten, uren, dagen vooraf), !0 (op het tijdstip zelf), of tussen haakjes
//              in gewone taal: !(een kwartier ervoor), !(morgen om 8 uur), !(30 minutes before), !(tomorrow at 8am). Meerdere mag.
//              Ook zonder uitroepteken: "met herinnering 10 minuten vooraf", "herinnering 10 minuten voor tijd", "melding een
//              kwartier van tevoren", "herinner me om 14:30", "with a reminder 30 minutes before", "remind me at 9am" (alleen een
//              tijd: op de dag van de taak). Zie SPOKEN_REMINDER.
//   datum      gewone taal in de taal van de interface, ook herhalingen ("elke maandag", "every monday"); zie core/dateInput.js
//
// Elk teken telt alleen aan het begin van een woord, zodat een e-mailadres of "en/of" met rust wordt gelaten.

import { parseDateText, parseDue } from './dateInput.js';
import { getLanguage } from './i18n.js';
import { parseDuration } from './duration.js';
import { nameKey, normalizeText } from '../../shared/text.js';
import { hasTime, parseOffsetNl } from '../../shared/reminders.js';

const START = '(?<![^\\s])'; // begin van de tekst of na witruimte
const END = '(?![\\p{L}\\p{N}_-])';

/** Zoekt na elk `trigger`-teken de langste naam uit `items` die erop volgt. */
function matchNamed(text, trigger, items) {
  // namen in dezelfde NFC-vorm als de tekst (de invoer wordt hieronder ook genormaliseerd), anders valt "é" soms niet samen
  const names = items.map((item) => ({ item, name: normalizeText(item.name).trim().replace(/\s+/g, ' ') })).filter((x) => x.name).sort((a, b) => b.name.length - a.name.length);
  const re = new RegExp(`${START}[${trigger}]`, 'gu'); // trigger is '#' of '/', veilig binnen een tekenklasse
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const after = text.slice(m.index + 1);
    for (const { item, name } of names) {
      if (after.toLowerCase().startsWith(name.toLowerCase()) && !/^[\p{L}\p{N}_-]/u.test(after.slice(name.length))) {
        return { item, start: m.index, end: m.index + 1 + name.length };
      }
    }
  }
  return null;
}

// =45m · =1u30 · =1,5u · =2 uur · =30 (minuten): alleen echte eenheden, zodat "=30 Tandarts" gewoon 30 minuten is
const DURATION_HOURS = 'u|uur|h|hr|hrs|hours?';
const DURATION_MINS = 'm|min|mins|minuut|minuten|minutes?';
const DURATION_TOKEN = new RegExp(String.raw`(?<![\p{L}\p{N}=])=(\d+(?:[.,]\d+)?\s?(?:${DURATION_HOURS})(?:\s?\d{1,2}(?:\s?(?:${DURATION_MINS}))?)?|\d+\s?(?:${DURATION_MINS})?)(?![\p{L}\p{N}])`, 'iu');

// ---------- bijhouden waar elk teken vandaan kwam ----------
// De herkenner knipt stukken uit de tekst. Om te kunnen zeggen welke woorden van wat je typte herkend zijn, loopt naast de tekst
// `s` een lijst `map` mee: voor elk teken de plek [van, tot) in de oorspronkelijke tekst. `map` is null als dat niet lukt
// (NFC per letter gaf iets anders dan NFC van het geheel); dan werkt alles gewoon, alleen zonder markering.

const WS = /\s/u;

/** De tekst in NFC, met witruimte samengevoegd en zonder witruimte eromheen, zoals de herkenner hem leest. */
function track(text) {
  let s = '';
  let map = [];
  for (const m of text.matchAll(/\P{M}\p{M}*|\p{M}+/gsu)) {
    const n = m[0].normalize('NFC');
    s += n;
    for (let k = 0; k < n.length; k++) map.push([m.index, m.index + m[0].length]);
  }
  const whole = normalizeText(text);
  if (s !== whole) {
    s = whole;
    map = null;
  }
  return collapse({ s, map });
}

/** Elke reeks witruimte één spatie, en geen witruimte aan het begin en het eind (zoals .replace(/\s+/g, ' ').trim()). */
function collapse({ s, map }) {
  let out = '';
  const outMap = map ? [] : null;
  for (let i = 0; i < s.length; i++) {
    if (WS.test(s[i])) {
      if (out.length === 0 || out[out.length - 1] === ' ') continue;
      out += ' ';
    } else {
      out += s[i];
    }
    outMap?.push(map[i]);
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    outMap?.pop();
  }
  return { s: out, map: outMap };
}

/** Haalt [start, end) weg, met een spatie in de plaats (zoals de herkenner altijd knipte). */
const cutTracked = (t, start, end) => replaceTracked(t, start, end, ' ');

/** Zet `insert` in de plaats van [start, end); de nieuwe tekens wijzen terug naar het stuk dat ze vervangen. */
function replaceTracked(t, start, end, insert) {
  const s = `${t.s.slice(0, start)}${insert}${t.s.slice(end)}`;
  if (!t.map) return collapse({ s, map: null });
  const from = t.map[start] ?? t.map[t.map.length - 1] ?? [0, 0];
  const to = t.map[end - 1] ?? from;
  const origin = [Math.min(from[0], to[0]), Math.max(from[1], to[1])];
  return collapse({ s, map: [...t.map.slice(0, start), ...Array.from(insert, () => origin), ...t.map.slice(end)] });
}

/**
 * Waar [start, end) van de huidige tekst in de oorspronkelijke tekst stond, als aaneengesloten stukken zonder witruimte eromheen.
 * Twee stukken met alleen witruimte ertussen worden één stuk ("morgen om 9"); met iets anders ertussen blijven ze los.
 */
function pieces(t, start, end, original) {
  const ranges = [];
  for (let i = Math.max(0, start); i < Math.min(end, t.s.length); i++) if (!WS.test(t.s[i])) ranges.push(t.map[i]);
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [a, b] of ranges) {
    const last = out[out.length - 1];
    if (last && (a <= last[1] || !original.slice(last[1], a).trim())) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * @param {string} text
 * @param {{
 *   view: { projects: Map<string, object>, sections: Map<string, object>, labels: Map<string, object> },
 *   now?: Date,
 *   defaultProjectId: string,
 *   defaultSectionId?: string | null,
 *   defaultDue?: object | null,     // bijvoorbeeld "vandaag" in het overzicht Vandaag
 * }} context
 * @returns {{
 *   content: string, project_id: string, section_id: string | null, labels: string[], newLabels: string[],
 *   priority: number, due: object | null, deadline: string | null,
 *   reminders: ({ type: 'relative', minute_offset: number } | { type: 'absolute', due: { date: string } })[],
 * }}
 */
const TIME = '(\\d{1,2})(?:[:.](\\d{2}))?';
const RANGE = new RegExp(`(?<![\\p{L}\\p{N}:./-])(van\\s+|from\\s+)?${TIME}\\s*(?:-|–|tot(?:\\s+en\\s+met)?|to|until|till)\\s*${TIME}(\\s*uur)?(?![\\p{L}\\p{N}:./-])`, 'iu');

/**
 * Een tijdsbereik in een regel: "9:00-10:30", "18:00 - 19:30", "9-10 uur", "van 9 tot 10:30", "from 9 to 10:30". Geeft het begin
 * ("HH:MM"), de duur in minuten en de plek, of null. Zonder dubbele punt, "uur" of "van/from … tot/to" is het geen tijd: "9-10" is
 * 9 oktober.
 * @returns {{ start: string, minutes: number, index: number, length: number } | null}
 */
export function findTimeRange(text) {
  const m = RANGE.exec(String(text ?? ''));
  if (!m) return null;
  const [, van, h1, m1, h2, m2, uur] = m;
  const clear = Boolean(van) || Boolean(uur) || m1 !== undefined || m2 !== undefined;
  if (!clear || (van && !/\b(?:tot|to|until|till)\b/i.test(m[0]))) return null;
  const a = Number(h1) * 60 + Number(m1 ?? 0);
  const b = Number(h2) * 60 + Number(m2 ?? 0);
  if (Number(h1) > 23 || Number(h2) > 23 || Number(m1 ?? 0) > 59 || Number(m2 ?? 0) > 59 || b <= a) return null;
  return { start: `${String(h1).padStart(2, '0')}:${String(m1 ?? '00').padStart(2, '0')}`, minutes: b - a, index: m.index, length: m[0].length };
}

export function parseQuickAdd(text, context) {
  return parseQuickAddWithSpans(text, context).parsed;
}

/**
 * Als parseQuickAdd, en daarnaast welke stukken van `text` herkend zijn (zoals Todoist ze markeert tijdens het typen): de datum, het
 * project, de labels enzovoort. Elk stuk is `{ start, end, kind }` met posities in `text` zoals gegeven (UTF-16, net als in Java
 * en Kotlin); `kind` is 'date', 'deadline', 'duration', 'reminder', 'project', 'section', 'label' of 'priority'. Een datum die
 * door een eerder weggehaald stuk heen loopt ("morgen #Thuis om 9") wordt meer stukken.
 * @returns {{ parsed: object, spans: { start: number, end: number, kind: string }[] }}
 */
export function parseQuickAddWithSpans(text, { view, now = new Date(), defaultProjectId, defaultSectionId = null, defaultDue = null, defaultLabels = [], canAddTo = () => true, dates = true, language = getLanguage() }) {
  const original = String(text);
  const spans = [];
  let t = track(original);
  const mark = (start, end, kind) => {
    if (t.map) spans.push(...pieces(t, start, end, original).map(([a, b]) => ({ start: a, end: b, kind })));
  };
  const cutAt = (start, end, kind) => {
    mark(start, end, kind);
    t = cutTracked(t, start, end);
  };
  let rest;
  const out = { content: '', project_id: defaultProjectId, section_id: defaultSectionId, labels: defaultLabels.filter((id) => view.labels.has(id)), newLabels: [], priority: 4, due: defaultDue, deadline: null, reminders: [] };

  // prioriteit
  const prio = new RegExp(`${START}(?:p|!!)([1-4])${END}`, 'iu').exec(t.s);
  if (prio) {
    out.priority = Number(prio[1]);
    cutAt(prio.index, prio.index + prio[0].length, 'priority');
  }

  // project
  // `canAddTo`: alleen projecten waar je een taak in kunt zetten (niet een project dat je alleen leest, zie core/access.js)
  const project = matchNamed(t.s, '#', [...view.projects.values()].filter((p) => !p.is_archived && canAddTo(p.id)));
  if (project) {
    out.project_id = project.item.id;
    if (project.item.id !== defaultProjectId) out.section_id = null; // de standaardsectie hoort bij een ander project
    cutAt(project.start, project.end, 'project');
  }

  // sectie (binnen het gekozen project)
  const section = matchNamed(t.s, '/', [...view.sections.values()].filter((s) => s.project_id === out.project_id && !s.is_archived));
  if (section) {
    out.section_id = section.item.id;
    cutAt(section.start, section.end, 'section');
  }

  // labels
  // Een label met een spatie of een ander teken dat in een gewoon woord niet voorkomt ("Uitgaan met Zoë", "a.b") wordt op naam gevonden,
  // zoals bij projecten: de langste passende naam wint. Alle andere labels volgen hieronder, op het woord na de @.
  const odd = [...view.labels.values()].filter((l) => !/^[\p{L}\p{N}_-]+$/u.test(normalizeText(l.name).trim()));
  for (let m = matchNamed(t.s, '@', odd); m; m = matchNamed(t.s, '@', odd)) {
    if (!out.labels.includes(m.item.id)) out.labels.push(m.item.id);
    cutAt(m.start, m.end, 'label');
  }
  // via nameKey: "@ÉÉN" is het label "één", en "@Zoë" ook als de ë ontleed is getypt
  const known = new Map([...view.labels.values()].map((l) => [nameKey(l.name), l.id]));
  const labelRe = new RegExp(`${START}@([\\p{L}\\p{N}_-]+)`, 'gu');
  const labelHits = [...t.s.matchAll(labelRe)];
  for (const [, name] of labelHits) {
    const id = known.get(nameKey(name));
    if (id) {
      if (!out.labels.includes(id)) out.labels.push(id);
    } else if (!out.newLabels.some((n) => nameKey(n) === nameKey(name))) {
      out.newLabels.push(name);
    }
  }
  cutAll(labelHits, 'label');

  // herinneringen; wat niet te begrijpen is, blijft gewoon in de titel staan
  const UNITS = 'minuten|minuut|minutes|minute|mins|min|mv|m|uren|uur|uv|u|hours|hour|hrs|hr|h|dagen|dag|days|day|dv|d|weken|weeks|week|w';
  const reminderRe = new RegExp(`${START}!(?:\\(([^()]{1,80})\\)|(\\d{1,4} ?(?:${UNITS})|0))${END}`, 'giu');
  const reminderHits = [...t.s.matchAll(reminderRe)].filter(([, phrase, code]) => {
    let spec = null;
    const offset = parseOffsetNl(phrase ?? code);
    if (offset !== null) {
      spec = { type: 'relative', minute_offset: offset };
    } else if (phrase) {
      const when = parseDateText(phrase, now, language);
      if (when && !when.recurrence && hasTime(when.date)) spec = { type: 'absolute', due: { date: when.date } };
    }
    if (!spec) return false; // blijft in de titel staan
    addReminder(spec);
    return true;
  });
  cutAll(reminderHits, 'reminder');

  // herinneringen in gewone taal: "met herinnering 10 minuten vooraf", "herinner me een kwartier ervoor", "met een herinnering om
  // 13:30", "with a reminder 30 minutes before", "remind me at 9am". Wat erna komt moet een herinnering zijn (een tijd vooraf of een
  // moment); anders blijft alles in de titel staan ("Herinnering sturen naar de klant"). Vóór de datum van de taak, zodat
  // "met herinnering morgen om 8 uur" niet de datum van de taak wordt. Alleen een tijd ("om 13:30") hoort bij de dag van de taak.
  const atTaskDay = [];
  if (dates) {
    for (let m = SPOKEN_REMINDER.exec(t.s); m; m = SPOKEN_REMINDER.exec(t.s)) {
      const bare = BARE_REMINDER.test(m[0]);
      if (bare && m.index === 0) continue;
      const found = spokenReminder(t.s.slice(m.index + m[0].length), now, language, bare);
      if (!found) continue;
      if (found.time) atTaskDay.push(found.time);
      else addReminder(found.spec);
      cutAt(m.index, m.index + m[0].length + found.length, 'reminder');
      SPOKEN_REMINDER.lastIndex = 0;
    }
  }

  // deadline tussen accolades; blijft staan als de tekst geen datum is
  const dl = /\{([^{}]+)\}/u.exec(t.s);
  if (dl) {
    const due = parseDateText(dl[1], now, language);
    if (due && !due.recurrence) {
      out.deadline = due.date.slice(0, 10);
      cutAt(dl.index, dl.index + dl[0].length, 'deadline');
    }
  }

  // duur: =45m, =1u30, =1,5u (alleen als het een duur is; anders blijft de tekst staan)
  const du = DURATION_TOKEN.exec(t.s);
  if (du) {
    const minutes = parseDuration(du[1]);
    if (minutes !== null) {
      out.duration = minutes;
      cutAt(du.index, du.index + du[0].length, 'duration');
    }
  }

  // een tijdsbereik ("9:00-10:30", "18-19 uur", "van 9 tot 10:30"): het begin wordt de tijd, het verschil de duur (zoals Todoist).
  // "9-10" alleen is in het Nederlands een datum (9 oktober), dus pas met een dubbele punt, "uur" of "van … tot".
  // `dates: false` (Instellingen › Algemeen): geen datums in gewone taal; een {deadline} en een !herinnering blijven werken
  const range = dates ? findTimeRange(t.s) : null;
  if (range) {
    const at = language === 'en' ? 'at' : 'om';
    // "om 09:00" komt in de plaats van het bereik; die tekens wijzen terug naar het hele bereik, zodat het als datum gemarkeerd wordt
    t = replaceTracked(t, range.index, range.index + range.length, `${at} ${range.start}`);
    if (out.duration === undefined) out.duration = range.minutes;
  }

  // datum of herhaling in gewone taal
  rest = t.s;
  const parsed = dates ? parseDue(rest, now, language) : null;
  if (parsed) {
    if (parsed.due && parsed.range) mark(parsed.range[0], parsed.range[1], 'date');
    rest = parsed.content;
    if (parsed.due) out.due = parsed.due;
  }

  // "met herinnering om 13:30": op de dag van de taak (zonder datum: vandaag, of morgen als die tijd vandaag al voorbij is)
  for (const time of atTaskDay) {
    const today = localDay(now);
    const passed = time <= `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const day = typeof out.due?.date === 'string' ? out.due.date.slice(0, 10) : passed ? localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) : today;
    addReminder({ type: 'absolute', due: { date: `${day}T${time}` } });
  }

  out.content = rest;
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  return { parsed: out, spans };

  /** Haalt alle gevonden stukken weg, van achter naar voren, zodat de plekken ervoor blijven kloppen. */
  function cutAll(hits, kind) {
    for (const m of [...hits].reverse()) cutAt(m.index, m.index + m[0].length, kind);
  }

  function addReminder(spec) {
    const same = (r) => r.type === spec.type && (spec.type === 'absolute' ? r.due.date === spec.due.date : r.minute_offset === spec.minute_offset);
    if (!out.reminders.some(same)) out.reminders.push(spec);
  }
}

/**
 * Het begin van een herinnering in gewone taal (Nederlands en Engels); wat erop volgt leest spokenReminder. Een dubbele punt erachter
 * mag ("herinnering: 10 minuten vooraf").
 */
const SPOKEN_REMINDER = new RegExp(`${START}(?:${[
  '(?:(?:met|en|plus) (?:een )?|(?:stuur|geef) (?:me|mij) een )?(?:herinnering|melding|notificatie|seintje)',
  'herinner (?:me|mij)', 'waarschuw (?:me|mij)',
  'remind me', 'notify me', 'alert me',
  '(?:(?:with|and|plus) (?:an? )?|(?:send|give) me an? )(?:reminder|notification|alert)', 'reminder', 'notification',
].join('|')}):?${END}`, 'giu');
/**
 * Alleen het woord zelf, zonder "met", "herinner me" enzovoort ("Tandarts om 9 uur herinnering 10 minuten vooraf"). Dat is minder
 * duidelijk: het telt niet als eerste woord van de taak ("Herinnering 2 dagen voor de deadline sturen"), en alleen met een tijd vooraf
 * erachter, niet met een moment ("Politie melding om 9 uur" blijft een taak om 9 uur).
 */
const BARE_REMINDER = /^(?:herinnering|melding|notificatie|seintje|reminder|notification):?$/iu;
/** Een tijd zonder datum ("om 13:30", "at 9am", "8 uur"): die hoort bij de dag van de taak. */
const TIME_ONLY = /^(?:om |at |op )?\d{1,2}(?:[:.]\d{2})?(?: ?(?:uur|u|am|pm|h))?$/iu;
/** Waar een herinnering in gewone taal ophoudt: bij het volgende #project, @label, /sectie, {deadline}, !herinnering of =duur. */
const NEXT_MARKER = / [#@/{!=]/u;

/**
 * De herinnering na "met herinnering" enzovoort: de langste reeks woorden die een tijd vooraf ("10 minuten vooraf", "een kwartier
 * ervoor", "op tijd") of een moment ("morgen om 8 uur", "om 13:30") is.
 * `offsetOnly`: alleen een tijd vooraf telt (na het woord "herinnering" zelf, zie BARE_REMINDER).
 * @returns {{ spec?: object, time?: string, length: number } | null} length: hoeveel tekens (met de spatie ervoor) het besloeg
 */
function spokenReminder(after, now, language, offsetOnly = false) {
  const lead = /^ +/u.exec(after)?.[0].length ?? 0;
  if (lead === 0) return null;
  const stop = after.slice(lead).search(NEXT_MARKER);
  const words = (stop < 0 ? after.slice(lead) : after.slice(lead, lead + stop)).split(' ').filter(Boolean);
  for (let n = Math.min(words.length, 8); n >= 1; n--) {
    const phrase = words.slice(0, n).join(' ');
    const length = lead + phrase.length;
    const offset = parseOffsetNl(phrase.replace(/^(?:van|of) /iu, ''));
    if (offset !== null) return { spec: { type: 'relative', minute_offset: offset }, length };
    if (offsetOnly) continue;
    const when = parseDateText(phrase, now, language);
    if (!when || when.recurrence || !hasTime(when.date)) continue;
    if (TIME_ONLY.test(phrase)) return { time: when.date.slice(11, 16), length };
    return { spec: { type: 'absolute', due: { date: when.date } }, length };
  }
  return null;
}

/** De datum van vandaag (op dit apparaat) als JJJJ-MM-DD. */
function localDay(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
