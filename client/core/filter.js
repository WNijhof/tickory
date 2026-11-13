// De filtertaal: een zoekopdracht op taken, zoals Todoist die kent, in het Nederlands én het Engels tegelijk.
//
//   vandaag | overdue & p1            wat vandaag moet of te laat is, met de hoogste prioriteit
//   (#Thuis | @bellen) & !subtaak      in project Thuis of met label bellen, zonder subtaken
//   Werk: #Werk, Thuis: ##Thuis        twee lijsten met een eigen naam (komma's)
//   vóór: 31-12 & zoek: café           datum en tekst
//
// Voorrang: `!` gaat voor `&`, en `&` gaat voor `|`; haakjes gaan voor alles. Een komma scheidt aparte lijsten en mag alleen
// buiten haakjes. Namen met een `&`, `|`, `(`, `)` of `,` schrijf je tussen aanhalingstekens ("#Werk & privé") of met een
// backslash (#Werk \& privé).
//
// Eigennamen (projecten, secties, labels) zijn data en blijven zoals ze zijn. Ze worden gevonden via nameKey() (hoofdletters
// en de gewone of ontleedde schrijfwijze van "é" maken niet uit); bestaat de naam zo niet, dan nog zonder accenten.
//
// Alle termen staan opgesomd in TERMS hieronder. Een onbekend woord, een haakje dat niet sluit, een lege term of een naam die
// niet bestaat is een nette fout met een positie (zie FilterError), nooit een crash en nooit een stille lege uitkomst.

import { addDays, dueStatus, nowString, todayString } from './format.js';
import { parseDateText } from './dateNl.js';
import { isValidDate } from '../../shared/recurrence.js';
import { reminderMoment } from '../../shared/reminders.js';
import { nameKey, normalizeText } from '../../shared/text.js';
import { byOrder } from './selectors.js';
import { foldText, foldWords, foldedField } from './fold.js';

export const MAX_QUERY_LENGTH = 2000; // gelijk aan de maximale lengte van `filter.query` in het datamodel
const MAX_DEPTH = 40; // diepste nesting van haakjes
const MAX_DAYS = 36_500;

// ---------- fouten ----------

/** De codes van alle fouten; de interface vertaalt zelf op basis van `code` en `params`. */
const MESSAGES = {
  empty_query: () => 'Het filter is leeg.',
  empty_term: () => 'Hier ontbreekt een term.',
  empty_name: ({ prefix }) => `Na ${prefix} ontbreekt een naam.`,
  unknown_term: ({ term }) => `Onbekende term: "${term}".`,
  unclosed_paren: () => 'Dit haakje wordt niet gesloten.',
  unexpected_paren: () => 'Dit haakje sluit niets af.',
  unclosed_quote: () => 'Deze aanhalingstekens worden niet gesloten.',
  expected_operator: () => 'Hier hoort & (en) of | (of) te staan.',
  comma_in_parens: () => 'Een komma (aparte lijsten) kan alleen buiten haakjes.',
  unknown_project: ({ name }) => `Onbekend project: "${name}".`,
  unknown_section: ({ name }) => `Onbekende sectie: "${name}".`,
  unknown_label: ({ name }) => `Onbekend label: "${name}".`,
  unknown_user: ({ name }) => `Onbekende gebruiker: "${name}".`,
  no_user: ({ term }) => `"${term}" werkt pas als je bent ingelogd.`,
  invalid_date: ({ term }) => `Geen geldige datum: "${term}".`,
  bad_number: ({ term }) => `Dit aantal is te groot of ongeldig: "${term}".`,
  too_deep: () => 'Te veel haakjes in elkaar.',
  too_long: ({ max }) => `Het filter is te lang (maximaal ${max} tekens).`,
  internal: () => 'Het filter kon niet worden gelezen.',
};
export const FILTER_ERROR_CODES = Object.keys(MESSAGES);

class FilterError extends Error {
  constructor(code, position, length = 1, params = {}) {
    super(code);
    this.info = { code, position, length: Math.max(1, length), params, message: MESSAGES[code](params) };
  }
}
const fail = (code, position, length, params) => {
  throw new FilterError(code, position, length, params);
};
const failAt = (code, tok, params) => fail(code, tok.start, tok.end - tok.start, params);

/** De Nederlandse melding bij een foutcode (voor wie een eigen `code` + `params` wil tonen). */
export const filterErrorMessage = (code, params = {}) => (MESSAGES[code] ?? MESSAGES.internal)(params);

// ---------- lezen: van tekst naar tokens ----------

const OPERATORS = new Set(['&', '|', '(', ')']);
const RESERVED_PREFIX = /^(?:zoek|zoeken|search|voor|vóór|before|na|after|toegewezen aan|assigned to)$/iu;
const SEARCH_PREFIX = /^(?:zoek|zoeken|search)\s*:$/iu;

/**
 * Tokens: `(` `)` `&` `|` `!` `,`, een groepsnaam (`name`, de tekst vóór een dubbele punt aan het begin van een lijst) en
 * termen (`term`). Posities verwijzen naar de tekst zoals die is getypt.
 */
function lex(q) {
  const tokens = [];
  const n = q.length;
  let i = 0;
  let groupHasToken = false;
  outer: while (i < n) {
    const c = q[i];
    if (/\s/u.test(c)) { i++; continue; }
    if (OPERATORS.has(c) || c === '!') {
      tokens.push({ type: c, start: i, end: i + 1 });
      groupHasToken = true;
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ type: ',', start: i, end: i + 1 });
      groupHasToken = false;
      i++;
      continue;
    }
    const start = i;
    let value = '';
    let last = i;
    let search = false; // in een zoektekst is `!` gewoon een teken
    while (i < n) {
      const d = q[i];
      if (d === '\\' && i + 1 < n) { value += q[i + 1]; i += 2; last = i; continue; }
      if (d === '"') {
        const j = q.indexOf('"', i + 1);
        if (j < 0) fail('unclosed_quote', i, 1);
        value += q.slice(i + 1, j);
        i = j + 1;
        last = i;
        continue;
      }
      if (OPERATORS.has(d) || d === ',') break;
      if (d === '!' && !search) break;
      if (d === ':' && !groupHasToken) {
        // "Naam: filter" aan het begin van een lijst geeft die lijst een naam (behalve bij zoek:, vóór:, na: enz.)
        const name = value.replace(/\s+/gu, ' ').trim();
        if (name && !RESERVED_PREFIX.test(name) && !/^[#@/]/u.test(name)) {
          tokens.push({ type: 'name', value: normalizeText(name), start: i, end: i + 1 }); // de plek is die van de dubbele punt
          groupHasToken = true;
          i++;
          continue outer;
        }
      }
      value += d;
      if (!/\s/u.test(d)) last = i + 1;
      i++;
      if (d === ':' && SEARCH_PREFIX.test(value.trim())) search = true;
    }
    tokens.push({ type: 'term', value: normalizeText(value.replace(/\s+/gu, ' ').trim()), start, end: Math.max(last, start + 1) });
    groupHasToken = true;
  }
  return tokens;
}

// ---------- datums ----------

const MONTHS = {
  januari: 1, january: 1, jan: 1, februari: 2, february: 2, feb: 2, maart: 3, march: 3, mrt: 3, mar: 3, april: 4, apr: 4,
  mei: 5, may: 5, juni: 6, june: 6, jun: 6, juli: 7, july: 7, jul: 7, augustus: 8, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, oktober: 10, october: 10, okt: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const pad = (n) => String(n).padStart(2, '0');
const dayOfWeek = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = zondag
const mondayOf = (day) => addDays(day, -((dayOfWeek(day) + 6) % 7));

/** Een dag, maand en (optioneel) jaar als 'YYYY-MM-DD'; zonder jaar het jaar van vandaag. Null = bestaat niet. */
function resolveDay(d, m, y, today) {
  const s = `${String(y ?? today.slice(0, 4)).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  return isValidDate(s) ? s : null;
}

/**
 * Een datum in gewone vorm als dag: 'YYYY-MM-DD'. Geeft null als de tekst geen datum lijkt, en gooit invalid_date als het er
 * wel een lijkt maar die niet bestaat (31-02).
 * Vaste vormen (Nederlands en Engels): vandaag/today, morgen/tomorrow, gisteren/yesterday, overmorgen, 2026-12-31, 31-12,
 * 31-12-2026, 31/12, 31.12, 31 december (2026), 31 dec, december 31, dec 31. Alles wat de Nederlandse datumherkenner verder
 * kent ("donderdag", "volgende week donderdag", "eind januari") valt erop terug; Engelse datumtaal is er (nog) niet.
 * Een datum zonder jaar is die dag in het jaar van vandaag (29-2 bestaat dus niet in een gewoon jaar: dat is een fout).
 */
function parseDay(text, env, tok) {
  const key = foldText(text);
  const today = env.today;
  if (key === 'vandaag' || key === 'today') return today;
  if (key === 'morgen' || key === 'tomorrow') return addDays(today, 1);
  if (key === 'gisteren' || key === 'yesterday') return addDays(today, -1);
  if (key === 'overmorgen') return addDays(today, 2);
  let m;
  let parts = null; // [dag, maand, jaar?]
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(key))) parts = [Number(m[3]), Number(m[2]), Number(m[1])];
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}))?$/.exec(key))) parts = [Number(m[1]), Number(m[2]), m[3] === undefined ? undefined : Number(m[3])];
  else if ((m = /^(\d{1,2}) ?-?([a-z]+)\.?(?: (\d{4}))?$/.exec(key)) && Object.hasOwn(MONTHS, m[2])) parts = [Number(m[1]), MONTHS[m[2]], m[3] === undefined ? undefined : Number(m[3])];
  else if ((m = /^([a-z]+)\.? (\d{1,2})(?: (\d{4}))?$/.exec(key)) && Object.hasOwn(MONTHS, m[1])) parts = [Number(m[2]), MONTHS[m[1]], m[3] === undefined ? undefined : Number(m[3])];
  if (parts) {
    const day = resolveDay(parts[0], parts[1], parts[2], today);
    if (!day) failAt('invalid_date', tok, { term: text });
    return day;
  }
  // de Nederlandse datumherkenner; een herhaling ("elke dag") is geen datum
  const due = parseDateText(text, env.now);
  if (due && !due.recurrence && typeof due.date === 'string') return due.date.slice(0, 10);
  return null;
}

// ---------- termen ----------

const dayOf = (t) => (typeof t.due?.date === 'string' ? t.due.date.slice(0, 10) : null);
const onDay = (d) => (t) => dayOf(t) === d;
const between = (lo, hi) => (t) => {
  const d = dayOf(t);
  return d !== null && d >= lo && d <= hi;
};

/**
 * Termen met een vaste tekst. De sleutel is de tekst zoals `foldText` hem maakt (kleine letters, zonder accenten); de
 * vormen met een nummer, naam of datum staan in `compileTerm`.
 */
const KEYWORDS = new Map();
function keyword(names, build) {
  for (const name of names) KEYWORDS.set(name, build);
}

keyword(['vandaag', 'today'], (env) => onDay(env.today));
keyword(['morgen', 'tomorrow'], (env) => onDay(addDays(env.today, 1)));
keyword(['gisteren', 'yesterday'], (env) => onDay(addDays(env.today, -1)));
keyword(['te laat', 'overdue'], (env) => (t) => !t.checked && typeof t.due?.date === 'string' && dueStatus(t.due, env.today, env.nowStr) === 'overdue');
keyword(['geen datum', 'zonder datum', 'no date', 'no due date'], () => (t) => dayOf(t) === null);
keyword(['heeft tijd', 'has time'], () => (t) => typeof t.due?.date === 'string' && t.due.date.length > 10);
keyword(['geen tijd', 'no time'], () => (t) => typeof t.due?.date === 'string' && t.due.date.length <= 10);
keyword(['deze week', 'this week'], (env) => between(mondayOf(env.today), addDays(mondayOf(env.today), 6)));
keyword(['volgende week', 'next week'], (env) => between(addDays(mondayOf(env.today), 7), addDays(mondayOf(env.today), 13)));
keyword(['vorige week', 'last week'], (env) => between(addDays(mondayOf(env.today), -7), addDays(mondayOf(env.today), -1)));
keyword(['terugkerend', 'herhalend', 'recurring'], () => (t) => Boolean(t.due?.recurrence));
keyword(['deadline', 'heeft deadline', 'has deadline'], () => (t) => Boolean(t.deadline));
keyword(['geen deadline', 'no deadline'], () => (t) => !t.deadline);
keyword(['subtaak', 'subtask'], () => (t) => Boolean(t.parent_id));
keyword(['zonder label', 'zonder labels', 'geen label', 'geen labels', 'no label', 'no labels'], () => (t) => !t.labels || t.labels.length === 0);
keyword(['niet toegewezen', 'unassigned'], () => (t) => !t.assignee_id);
keyword(['toegewezen', 'assigned'], () => (t) => Boolean(t.assignee_id));
keyword(['heeft herinnering', 'has reminder'], (env) => (t) => env.hasReminder(t));
keyword(['geen herinnering', 'no reminder'], (env) => (t) => !env.hasReminder(t));
keyword(['afgevinkt', 'completed'], (env) => {
  env.flags.completed = true;
  return (t) => Boolean(t.checked);
});
keyword(['alles', 'all', 'view all'], () => () => true);

/** Alle termen, voor de uitleg in de interface: [vorm, uitleg]. */
export const TERMS = [
  ['vandaag | today', 'met datum vandaag (elk tijdstip)'],
  ['morgen | tomorrow', 'met datum morgen'],
  ['gisteren | yesterday', 'met datum gisteren'],
  ['te laat | overdue', 'de datum is voorbij (met een tijdstip: het tijdstip is voorbij); afgevinkt telt niet'],
  ['geen datum | no date', 'zonder datum (ook: zonder datum, no due date)'],
  ['7 dagen | 7 days', 'vandaag tot en met 7 dagen verder (ook: volgende 7 dagen, next 7 days)'],
  ['-7 dagen | -7 days', 'de laatste 7 dagen tot en met vandaag'],
  ['deze week | this week', 'maandag tot en met zondag van deze week'],
  ['volgende week | next week', 'maandag tot en met zondag van volgende week'],
  ['vorige week | last week', 'maandag tot en met zondag van vorige week'],
  ['31-12 | 31 december | 2026-12-31 | dec 31', 'precies die dag (zonder jaar: dit jaar)'],
  ['vóór: datum | before: datum', 'een dag eerder dan die datum'],
  ['na: datum | after: datum', 'een dag later dan die datum'],
  ['heeft tijd | has time', 'de datum heeft een tijdstip (ook: geen tijd, no time)'],
  ['p1 … p4', 'prioriteit'],
  ['@label', 'heeft dat label'],
  ['#project | ##project', 'in dat project | in dat project en zijn subprojecten'],
  ['/sectie', 'in een sectie met die naam'],
  ['toegewezen aan mij | assigned to: me', 'aan jou toegewezen'],
  ['toegewezen aan: naam | assigned to: name', 'aan die persoon toegewezen (naam, voornaam of gebruikersnaam)'],
  ['toegewezen aan anderen | assigned to others', 'aan iemand anders toegewezen'],
  ['niet toegewezen | unassigned', 'aan niemand toegewezen'],
  ['toegewezen | assigned', 'aan iemand toegewezen'],
  ['heeft herinnering | has reminder', 'heeft een eigen herinnering die kan afgaan (ook: geen herinnering, no reminder)'],
  ['terugkerend | recurring', 'herhaalt zich (ook: herhalend)'],
  ['deadline | heeft deadline | has deadline', 'heeft een deadline (ook: geen deadline, no deadline)'],
  ['zonder label | no labels', 'zonder labels'],
  ['subtaak | subtask', 'is een subtaak'],
  ['zoek: tekst | search: tekst', 'alle woorden in titel of beschrijving, zonder letter- of accentgevoeligheid'],
  ['afgevinkt | completed', 'afgevinkte taken (zonder deze term zie je alleen open taken)'],
  ['alles | all', 'elke taak'],
];

function findByName(rows, name, accept = () => true) {
  const key = nameKey(name);
  const exact = rows.filter((r) => typeof r.name === 'string' && accept(r) && nameKey(r.name) === key);
  if (exact.length > 0) return exact;
  const folded = foldText(name);
  return rows.filter((r) => typeof r.name === 'string' && accept(r) && foldText(r.name) === folded);
}

/** De aanduiding van een persoon: volledige naam, voornaam of gebruikersnaam, zonder letter- of accentgevoeligheid. */
function findUsers(users, name) {
  const key = foldText(name);
  return users.filter((u) => {
    const full = foldText(u.name ?? '');
    return full === key || foldText(u.username ?? '') === key || full.split(' ')[0] === key;
  });
}

function compileTerm(tok, env, hint = true) {
  const raw = tok.value;
  if (raw === '') failAt('empty_term', tok);
  const key = foldText(raw);
  const known = KEYWORDS.get(key);
  if (known) return known(env);

  // #project, ##project, /sectie, @label
  const prefix = raw.startsWith('##') ? '##' : /^[#/@]/u.test(raw) ? raw[0] : null;
  if (prefix) {
    const name = raw.slice(prefix.length).trim();
    if (!name) failAt('empty_name', tok, { prefix });
    if (prefix === '@') {
      const ids = new Set(findByName(env.labels, name).map((l) => l.id));
      if (ids.size === 0) failAt('unknown_label', tok, { name });
      return (t) => Array.isArray(t.labels) && t.labels.some((id) => ids.has(id));
    }
    if (prefix === '/') {
      const ids = new Set(findByName(env.sections, name).map((s) => s.id));
      if (ids.size === 0) failAt('unknown_section', tok, { name });
      return (t) => ids.has(t.section_id);
    }
    const found = findByName(env.projects, name);
    if (found.length === 0) failAt('unknown_project', tok, { name });
    const ids = new Set(found.map((p) => p.id));
    if (prefix === '##') for (const id of env.subprojectIds([...ids])) ids.add(id);
    return (t) => ids.has(t.project_id);
  }

  let m;
  if ((m = /^p([1-4])$/.exec(key))) {
    const level = Number(m[1]);
    return (t) => (t.priority ?? 4) === level;
  }

  // zoek: tekst
  if ((m = /^(?:zoek|zoeken|search)\s*:\s*([\s\S]*)$/iu.exec(raw))) {
    const words = foldWords(m[1], { maxWords: 20 });
    if (words.length === 0) failAt('empty_term', tok);
    return (t) => {
      const text = `${foldedField(t, 'content')}\n${foldedField(t, 'description')}`;
      for (const w of words) if (!text.includes(w)) return false;
      return true;
    };
  }

  // vóór: datum, na: datum
  if ((m = /^(voor|vóór|before|na|after)\s*:\s*([\s\S]*)$/iu.exec(raw))) {
    const day = m[2] ? parseDay(m[2], env, tok) : null;
    if (!day) failAt('invalid_date', tok, { term: m[2] || raw });
    const before = /^(?:voor|vóór|before)$/iu.test(m[1]);
    return before ? (t) => { const d = dayOf(t); return d !== null && d < day; } : (t) => { const d = dayOf(t); return d !== null && d > day; };
  }

  // toegewezen aan mij / anderen / naam
  if ((m = /^(?:toegewezen aan|assigned to)(?:\s*:\s*|\s+)(.+)$/iu.exec(raw))) {
    const who = m[1].trim();
    const whoKey = foldText(who);
    const me = env.userId;
    if (whoKey === 'mij' || whoKey === 'me') {
      if (!me) failAt('no_user', tok, { term: raw });
      return (t) => t.assignee_id === me;
    }
    if (whoKey === 'anderen' || whoKey === 'others') {
      if (!me) failAt('no_user', tok, { term: raw });
      return (t) => Boolean(t.assignee_id) && t.assignee_id !== me;
    }
    const ids = new Set(findUsers(env.users, who).map((u) => u.id));
    if (ids.size === 0) failAt('unknown_user', tok, { name: who });
    return (t) => ids.has(t.assignee_id);
  }

  // 7 dagen, volgende 7 dagen, -7 dagen
  if ((m = /^(?:(?:volgende|next) )?(\d+) (?:dagen|dag|days|day)$/.exec(key))) {
    const n = Number(m[1]);
    if (m[1].length > 6 || n > MAX_DAYS) failAt('bad_number', tok, { term: raw });
    return between(env.today, addDays(env.today, n));
  }
  if ((m = /^-(\d+) (?:dagen|dag|days|day)$/.exec(key))) {
    const n = Number(m[1]);
    if (m[1].length > 6 || n > MAX_DAYS) failAt('bad_number', tok, { term: raw });
    return between(addDays(env.today, -n), env.today);
  }

  // een datum: precies die dag
  const day = parseDay(raw, env, tok);
  if (day) return onDay(day);
  if (hint) forgottenOperator(raw, tok, env);
  failAt('unknown_term', tok, { term: raw });
}

/**
 * Staat er "vandaag morgen" (twee termen zonder & of |), dan is "onbekende term" een slechte melding: wijs dan de plek aan
 * waar de operator ontbreekt. Alleen als een voorste deel van de tekst wél een term is.
 */
function forgottenOperator(raw, tok, env) {
  const words = raw.split(' ');
  if (words.length < 2 || words.length > 8) return;
  const source = env.query.slice(tok.start, tok.end);
  for (let k = 1; k < words.length; k++) {
    try {
      compileTerm({ ...tok, value: words.slice(0, k).join(' ') }, env, false);
    } catch {
      continue;
    }
    // de plek van het (k+1)e woord in de getypte tekst; met aanhalingstekens of backslashes begint de term zelf
    const plain = !/["\\]/u.test(source);
    const at = plain ? [...source.matchAll(/\S+/gu)][k]?.index : undefined;
    const start = at === undefined ? tok.start : tok.start + at;
    fail('expected_operator', start, at === undefined ? tok.end - tok.start : tok.end - start);
  }
}

// ---------- omgeving: wat een filter nodig heeft van de toestand ----------

function makeEnv(ctx) {
  const now = ctx.now instanceof Date && !Number.isNaN(ctx.now.getTime()) ? ctx.now : new Date();
  const view = ctx.view ?? {};
  const rows = (map) => (map instanceof Map ? [...map.values()] : []);
  const userId = ctx.userId ?? null;
  const env = {
    now,
    query: ctx.query,
    today: todayString(now),
    nowStr: nowString(now),
    userId,
    users: Array.isArray(ctx.users) ? ctx.users : [],
    projects: rows(view.projects),
    sections: rows(view.sections),
    labels: rows(view.labels),
    flags: { completed: false },
    subprojectIds(rootIds) {
      const children = new Map();
      for (const p of this.projects) {
        if (!p.parent_id) continue;
        if (!children.has(p.parent_id)) children.set(p.parent_id, []);
        children.get(p.parent_id).push(p.id);
      }
      const seen = new Set(rootIds);
      const todo = [...rootIds];
      const out = [];
      while (todo.length > 0) {
        for (const kid of children.get(todo.pop()) ?? []) {
          if (seen.has(kid)) continue;
          seen.add(kid);
          out.push(kid);
          todo.push(kid);
        }
      }
      return out;
    },
    // Je eigen herinneringen per taak, één keer opgebouwd (zoals remindersOf uit selectors.js ze kiest, maar niet per taak
    // opnieuw door alle herinneringen heen); "heeft herinnering" is: er is er een die nog kan afgaan, zoals het belletje in de lijst.
    hasReminder(task) {
      this.reminderIndex ??= (() => {
        const index = new Map();
        for (const r of rows(view.reminders)) {
          if (r.owner_id && userId && r.owner_id !== userId) continue;
          if (!index.has(r.task_id)) index.set(r.task_id, []);
          index.get(r.task_id).push(r);
        }
        return index;
      })();
      return (this.reminderIndex.get(task.id) ?? []).some((r) => reminderMoment(r, task) !== null);
    },
    reminderIndex: null,
  };
  return env;
}

// ---------- ontleden ----------

/** Zet tokens om in lijsten (groepen) van voorwaarden. */
function parse(q, tokens, env) {
  let pos = 0;
  const peek = () => tokens[pos];

  const parsePrimary = (depth, after) => {
    const tok = peek();
    if (tok?.type === '(') {
      if (depth >= MAX_DEPTH) failAt('too_deep', tok);
      pos++;
      const inner = parseOr(depth + 1, tok);
      const close = peek();
      if (!close) failAt('unclosed_paren', tok);
      if (close.type === ')') {
        pos++;
        return inner;
      }
      if (close.type === ',') failAt('comma_in_parens', close);
      return failAt('expected_operator', close);
    }
    if (tok?.type === 'term') {
      pos++;
      return compileTerm(tok, env);
    }
    return fail('empty_term', tok ? tok.start : (after?.start ?? 0), tok ? tok.end - tok.start : 1);
  };

  const parseUnary = (depth, after) => {
    let negate = false;
    while (peek()?.type === '!') {
      after = tokens[pos++];
      negate = !negate;
    }
    const inner = parsePrimary(depth, after);
    return negate ? (t) => !inner(t) : inner;
  };

  const parseAnd = (depth, after) => {
    const parts = [parseUnary(depth, after)];
    while (peek()?.type === '&') parts.push(parseUnary(depth, tokens[pos++]));
    if (parts.length === 1) return parts[0];
    return (t) => {
      for (const f of parts) if (!f(t)) return false;
      return true;
    };
  };

  function parseOr(depth, after) {
    const parts = [parseAnd(depth, after)];
    while (peek()?.type === '|') parts.push(parseAnd(depth, tokens[pos++]));
    if (parts.length === 1) return parts[0];
    return (t) => {
      for (const f of parts) if (f(t)) return true;
      return false;
    };
  }

  const groups = [];
  let previous = null;
  for (;;) {
    const named = peek()?.type === 'name' ? tokens[pos++] : null;
    const first = peek();
    const match = parseOr(0, named ?? previous);
    const lastTok = tokens[pos - 1];
    const next = peek();
    if (next && next.type !== ',') failAt(next.type === ')' ? 'unexpected_paren' : 'expected_operator', next);
    groups.push({ name: named ? named.value : q.slice(first.start, lastTok.end), match });
    if (!next) break;
    previous = next;
    pos++;
  }
  return groups;
}

/**
 * @param {string} query
 * @param {{ now?: Date, userId?: string | null, view: object, users?: { id: string, username?: string, name?: string }[] }} ctx
 * @returns {{
 *   ok: true,
 *   match: (task: object) => boolean,          // voldoet de taak (de hele filtertekst: alle lijsten samen)
 *   groups: { name: string, match: (task: object) => boolean }[],   // één per lijst (gescheiden door komma's)
 *   includesCompleted: boolean,                 // de tekst bevat "afgevinkt"/"completed"
 * } | { ok: false, error: { code: string, position: number, length: number, message: string, params: object } }}
 *   `position` en `length` verwijzen naar de tekst zoals getypt. `match` kijkt alleen naar de voorwaarden; dat een taak open
 *   moet zijn (tenzij `includesCompleted`) doet evaluateFilter.
 */
export function compileFilter(query, ctx = {}) {
  try {
    if (typeof query !== 'string' || query.trim() === '') fail('empty_query', 0, Math.max(1, typeof query === 'string' ? query.length : 1));
    if (query.length > MAX_QUERY_LENGTH) fail('too_long', MAX_QUERY_LENGTH, query.length - MAX_QUERY_LENGTH, { max: MAX_QUERY_LENGTH });
    const env = makeEnv({ ...ctx, query });
    const tokens = lex(query);
    const groups = parse(query, tokens, env);
    const match = groups.length === 1 ? groups[0].match : (t) => groups.some((g) => g.match(t));
    return { ok: true, match, groups, includesCompleted: env.flags.completed };
  } catch (e) {
    if (e instanceof FilterError) return { ok: false, error: e.info };
    return { ok: false, error: { code: 'internal', position: 0, length: 1, params: {}, message: MESSAGES.internal() } };
  }
}

// ---------- uitvoeren ----------

/**
 * Taken in de volgorde van de overzichten: eerst op datum (en tijdstip; zonder datum achteraan), dan op prioriteit (1 eerst),
 * dan op de plek van het project in de lijst, dan op de eigen volgorde.
 */
export function sortTasks(tasks, view) {
  const rank = new Map();
  const roots = [...(view?.projects?.values() ?? [])].sort(byOrder);
  roots.forEach((p, i) => rank.set(p.id, i));
  const due = (t) => (typeof t.due?.date === 'string' ? t.due.date : null);
  return tasks.sort((a, b) => {
    const da = due(a);
    const db = due(b);
    if (da !== db) return da === null ? 1 : db === null ? -1 : da < db ? -1 : 1;
    const pa = a.priority ?? 4;
    const pb = b.priority ?? 4;
    if (pa !== pb) return pa - pb;
    const ra = rank.get(a.project_id) ?? Infinity;
    const rb = rank.get(b.project_id) ?? Infinity;
    if (ra !== rb) return ra < rb ? -1 : 1;
    return byOrder(a, b);
  });
}

/**
 * De taken die bij een filter horen. Alleen open taken, tenzij het filter "afgevinkt"/"completed" bevat; taken in een
 * gearchiveerd project doen niet mee.
 * @returns {{ ok: true, tasks: object[], groups: { name: string, tasks: object[] }[], includesCompleted: boolean }
 *   | { ok: false, error: object }}
 *   `tasks` is bij één lijst die lijst, en bij meerdere lijsten alle taken uit alle lijsten (elke taak één keer);
 *   `groups` heeft altijd minstens één lijst, elk met een eigen naam.
 */
export function evaluateFilter(query, ctx = {}) {
  const compiled = compileFilter(query, ctx);
  if (!compiled.ok) return compiled;
  const view = ctx.view ?? {};
  const archived = new Set();
  for (const p of view.projects?.values() ?? []) if (p.is_archived) archived.add(p.id);
  const lists = compiled.groups.map(() => []);
  const all = [];
  for (const t of view.tasks?.values() ?? []) {
    if (t.is_deleted || (t.checked && !compiled.includesCompleted) || archived.has(t.project_id)) continue;
    let hit = false;
    for (let i = 0; i < lists.length; i++) {
      if (compiled.groups[i].match(t)) {
        lists[i].push(t);
        hit = true;
      }
    }
    if (hit) all.push(t);
  }
  for (const list of lists) sortTasks(list, view);
  return {
    ok: true,
    tasks: lists.length === 1 ? lists[0] : sortTasks(all, view),
    groups: compiled.groups.map((g, i) => ({ name: g.name, tasks: lists[i] })),
    includesCompleted: compiled.includesCompleted,
  };
}
