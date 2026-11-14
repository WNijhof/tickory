// De taal van de interface: de woordenboeken (zelfde sleutels en invulvelden), het gebruik in de code (elke sleutel
// bestaat en wordt gebruikt), meervouden, de taalkeuze, en de Engelse varianten van datums, meldingen en accountfouten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import nl from '../i18n/nl.js';
import en from '../i18n/en.js';
import { DEFAULT_LANGUAGE, LANGUAGES, LANGUAGE_KEY, detectLanguage, getLanguage, getLocale, setLanguage, t } from './i18n.js';
import { addDays, formatDate, formatDateInput, formatDayHeading, formatDue, formatDueLong } from './format.js';
import { describeCommand, describeCommandError } from './messages.js';
import { ApiError, createApi, deviceName, displayNameProblem, passwordProblem, usernameProblem } from './auth.js';
import { dateLanguageNote, mentionsEnglishDate } from './dateHint.js';
import { parseDateText } from './dateNl.js';
import { parseQuickAdd } from './quickadd.js';

const clientDir = fileURLToPath(new URL('../', import.meta.url));
const DICTIONARIES = { nl, en };

/** Voert `fn` uit met een Engelse interface en zet daarna het Nederlands terug. */
function inEnglish(fn) {
  setLanguage('en');
  try {
    return fn();
  } finally {
    setLanguage('nl');
  }
}
async function inEnglishAsync(fn) {
  setLanguage('en');
  try {
    return await fn();
  } finally {
    setLanguage('nl');
  }
}

const isPlural = (v) => Boolean(v) && typeof v === 'object';
const forms = (v) => (isPlural(v) ? Object.values(v) : [v]);
const placeholders = (v) => [...new Set(forms(v).flatMap((s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort();

// ---------- de woordenboeken ----------

test('beide woordenboeken hebben exact dezelfde sleutels', () => {
  const a = Object.keys(nl).sort();
  const b = Object.keys(en).sort();
  assert.deepEqual(a.filter((k) => !Object.hasOwn(en, k)), [], 'sleutels die in en.js ontbreken');
  assert.deepEqual(b.filter((k) => !Object.hasOwn(nl, k)), [], 'sleutels die in nl.js ontbreken');
  assert.ok(a.length > 200, `verwacht een flink woordenboek, vond ${a.length} sleutels`);
});

test('elke tekst is ingevuld, en een meervoud heeft precies de vormen one en other', () => {
  for (const [lang, dictionary] of Object.entries(DICTIONARIES)) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.match(key, /^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/, `${lang}: vreemde sleutel "${key}"`);
      if (isPlural(value)) {
        assert.deepEqual(Object.keys(value).sort(), ['one', 'other'], `${lang} ${key}: een meervoud heeft one en other`);
        assert.ok(value.other.includes('{count}'), `${lang} ${key}: het meervoud noemt het aantal niet`);
      } else {
        assert.equal(typeof value, 'string', `${lang} ${key}: tekst of meervoud verwacht`);
      }
      for (const text of forms(value)) {
        assert.ok(typeof text === 'string' && text.trim() !== '', `${lang} ${key}: lege tekst`);
        assert.equal(text, text.normalize('NFC'), `${lang} ${key}: niet in NFC`);
        assert.ok(!/\$\{|\{\{|\}\}|\{\s|\s\}/.test(text), `${lang} ${key}: verdacht invulveld in "${text}"`);
      }
    }
  }
});

test('per sleutel dezelfde invulvelden en dezelfde vorm (tekst of meervoud) in beide talen', () => {
  for (const key of Object.keys(nl)) {
    assert.equal(isPlural(nl[key]), isPlural(en[key]), `${key}: in de ene taal een meervoud, in de andere niet`);
    assert.deepEqual(placeholders(en[key]), placeholders(nl[key]), `${key}: andere invulvelden in het Engels dan in het Nederlands`);
  }
});

test('de Engelse teksten zijn ook echt vertaald (alleen bewust gelijke teksten zijn hetzelfde)', () => {
  // Woorden die in beide talen hetzelfde zijn, en teksten zonder woorden.
  const same = new Set([
    'shell.menu', 'sync.offline', 'task.deadlineChip', 'task.deadline', 'task.labels', 'activity.field.labels', 'activity.field.deadline', 'bulk.labels', 'task.project', 'completed.project', 'completed.projectOption', 'project.menu', 'view.projectTitle',
    'settings.language', 'account.title', 'admin.accounts', 'command.noun.project', 'command.noun.label', 'command.noun.filter',
    'reminder.line', 'color.magenta', 'calendar.week', 'calendar.weekNumber', 'calendar.weekShort',
    'duration.min', 'duration.days', 'export.projectLabel', 'search.kind.project', 'search.kind.label', 'search.kind.filter', 'filters.title', 'labels.title', 'filter.queryLabel', 'attachment.meta',
  ]);
  for (const key of Object.keys(nl)) {
    const equal = JSON.stringify(nl[key]) === JSON.stringify(en[key]);
    if (same.has(key)) assert.ok(equal, `${key} staat als "in beide talen gelijk", maar verschilt`);
    else assert.ok(!equal, `${key} is in het Engels gelijk aan het Nederlands: ${JSON.stringify(en[key])}`);
  }
  // Nederlandse woorden die in geen enkele Engelse tekst horen (behalve als voorbeeld van wat je kunt typen).
  const dutch = /\b(de|het|een|niet|taak|voor|bijgewerkt|wachtwoord|gebruikersnaam|verwijderen|toevoegen|opslaan|annuleren|sluiten|vandaag|morgen|gisteren|jij|jou|bv)\b/i;
  for (const [key, value] of Object.entries(en)) {
    for (const text of forms(value)) assert.ok(!dutch.test(text), `en ${key}: Nederlands woord in "${text}"`);
  }
});

// ---------- het gebruik in de code ----------

/** Haalt commentaar uit JavaScript, zodat een voorbeeld in commentaar niet als aanroep telt. Tekst (ook in sjablonen) blijft staan. */
function stripComments(source) {
  let out = '';
  const stack = []; // per geopende sjabloon-uitdrukking `${`: de diepte van de accolades
  let state = 'code';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/' && source[i - 1] !== '\\') { i = source.indexOf('\n', i) - 1; if (i < 0) break; continue; }
      if (c === '/' && next === '*') { i = source.indexOf('*/', i + 2) + 1; out += ' '; continue; }
      if (c === "'" || c === '"') state = c;
      else if (c === '`') state = '`';
      else if (c === '{' && stack.length > 0) stack[stack.length - 1]++;
      else if (c === '}' && stack.length > 0 && stack[stack.length - 1]-- === 0) { stack.pop(); state = '`'; }
      out += c;
    } else if (state === '`') {
      if (c === '\\') { out += c + next; i++; continue; }
      if (c === '$' && next === '{') { stack.push(0); state = 'code'; out += '${'; i++; continue; }
      if (c === '`') state = 'code';
      out += c;
    } else {
      if (c === '\\') { out += c + next; i++; continue; }
      if (c === state) state = 'code';
      out += c;
    }
  }
  return out;
}

/** De tekst van de argumenten vanaf het haakje op `open` tot het bijbehorende sluithaakje. */
function argumentsAt(code, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error('geen sluithaakje gevonden');
}

/** Alle aanroepen van t() in de bronbestanden van de app (zonder tests en zonder i18n.js zelf). */
function findCalls() {
  const calls = [];
  const dynamic = [];
  for (const dir of ['ui', 'core']) {
    for (const name of readdirSync(resolve(clientDir, dir)).sort()) {
      if (!name.endsWith('.js') || name.endsWith('.test.js') || (dir === 'core' && name === 'i18n.js')) continue;
      const file = `${dir}/${name}`;
      const code = stripComments(readFileSync(resolve(clientDir, dir, name), 'utf8'));
      for (const m of code.matchAll(/(?<![\w.$])t\(/g)) {
        const line = code.slice(0, m.index).split('\n').length;
        const args = argumentsAt(code, m.index + 1);
        const literal = /^\s*'([^'\\]*)'\s*(?:,\s*([\s\S]*))?$/.exec(args);
        if (!literal) dynamic.push(`${file}:${line}: t(${args.slice(0, 60)})`);
        else calls.push({ file, line, key: literal[1], params: literal[2]?.trim() ?? '' });
      }
    }
  }
  return { calls, dynamic };
}
const { calls, dynamic } = findCalls();

test('t() krijgt overal een letterlijke sleutel mee (anders is niet te controleren of die bestaat)', () => {
  assert.deepEqual(dynamic, []);
  assert.ok(calls.length > 250, `verwacht veel aanroepen van t(), vond er ${calls.length}`);
  for (const dir of ['ui', 'core']) {
    for (const name of readdirSync(resolve(clientDir, dir))) {
      if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
      const source = readFileSync(resolve(clientDir, dir, name), 'utf8');
      assert.ok(!/\bt\s*\(\s*["`]/.test(stripComments(source)), `${dir}/${name}: geef de sleutel tussen enkele aanhalingstekens`);
    }
  }
});

test('elke sleutel die de code gebruikt, bestaat in beide woordenboeken', () => {
  const missing = calls.filter((c) => !Object.hasOwn(nl, c.key) || !Object.hasOwn(en, c.key)).map((c) => `${c.file}:${c.line}: ${c.key}`);
  assert.deepEqual(missing, []);
});

test('geen sleutel is ongebruikt', () => {
  const used = new Set(calls.map((c) => c.key));
  assert.deepEqual(Object.keys(nl).filter((k) => !used.has(k)), []);
});

test('elke aanroep geeft de invulvelden mee die de tekst nodig heeft', () => {
  const problems = [];
  for (const c of calls) {
    if (!Object.hasOwn(nl, c.key)) continue; // gemeld door de test hierboven
    const needed = [...new Set([...placeholders(nl[c.key]), ...(isPlural(nl[c.key]) ? ['count'] : [])])];
    if (needed.length === 0) {
      if (c.params) problems.push(`${c.file}:${c.line}: ${c.key} heeft geen invulvelden, maar krijgt ${c.params}`);
      continue;
    }
    if (!c.params.startsWith('{')) {
      problems.push(`${c.file}:${c.line}: ${c.key} heeft {${needed.join('}, {')}} nodig`);
      continue;
    }
    for (const name of needed) {
      if (!new RegExp(`[{,]\\s*${name}\\s*[:,}]`).test(c.params)) problems.push(`${c.file}:${c.line}: ${c.key} mist het invulveld {${name}}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('geen module zoekt tekst op tijdens het laden (anders blijft die na het wisselen van taal in de oude taal staan)', async () => {
  // Elke tekst in het woordenboek wordt tijdelijk een eigenschap die bijhoudt dat ze is gelezen. Daarna laden we elke module
  // opnieuw (een eigen adres geeft een nieuw exemplaar): leest er één een tekst, dan gebeurt dat bij het laden.
  const saved = new Map();
  let reads = [];
  for (const dictionary of [nl, en]) {
    for (const key of Object.keys(dictionary)) {
      const value = dictionary[key];
      saved.set(`${dictionary === nl ? 'nl' : 'en'}/${key}`, [dictionary, key, value]);
      Object.defineProperty(dictionary, key, { get() { reads.push(key); return value; }, enumerable: true, configurable: true });
    }
  }
  try {
    assert.equal(t('nav.today'), 'Vandaag');
    assert.deepEqual(reads, ['nav.today'], 'de proef zelf werkt: een opgezochte tekst wordt gezien');
    assert.equal(inEnglish(() => t('nav.upcoming')), 'Upcoming');
    assert.deepEqual(reads, ['nav.today', 'nav.upcoming']);
    // ui/app.js start de app en heeft een pagina nodig; die kan hier niet geladen worden (de browsertest dekt het wisselen daar).
    for (const dir of ['ui', 'core']) {
      for (const name of readdirSync(resolve(clientDir, dir)).sort()) {
        if (!name.endsWith('.js') || name.endsWith('.test.js') || (dir === 'ui' && name === 'app.js')) continue;
        reads = [];
        await import(`${pathToFileURL(resolve(clientDir, dir, name)).href}?laadproef=${dir}-${name}`);
        assert.deepEqual(reads, [], `${dir}/${name} roept t() aan tijdens het laden`);
      }
    }
  } finally {
    for (const [dictionary, key, value] of saved.values()) Object.defineProperty(dictionary, key, { value, writable: true, enumerable: true, configurable: true });
  }
  assert.equal(Object.getOwnPropertyDescriptor(nl, 'nav.today').value, 'Vandaag', 'het woordenboek is weer gewoon');
});

test('index.html: de vaste tekst is de Nederlandse uit het woordenboek, en het script zet precies die teksten in de gekozen taal', () => {
  const html = readFileSync(resolve(clientDir, 'index.html'), 'utf8');
  const app = stripComments(readFileSync(resolve(clientDir, 'ui/app.js'), 'utf8'));
  const applyLanguage = app.slice(app.indexOf('function applyLanguage()'), app.indexOf('applyLanguage();'));
  assert.match(html, /<html lang="nl">/, 'de terugval is Nederlands');
  assert.match(applyLanguage, /document\.documentElement\.lang = getLanguage\(\)/);
  const fixed = [
    [/<aside id="sidebar"[^>]* aria-label="([^"]+)"/, 'shell.navigation'],
    [/<button id="menu-button"[^>]* aria-label="([^"]+)"/, 'shell.menu'],
    [/<button id="sync-status"[^>]* title="([^"]+)"/, 'shell.syncTitle'],
    [/<input id="quick-input"[^>]* placeholder="([^"]+)"/, 'quick.placeholder'],
    [/<input id="quick-input"[^>]* aria-label="([^"]+)"/, 'quick.label'],
    [/<button class="button button-primary" type="submit">([^<]+)<\/button>/, 'common.add'],
  ];
  for (const [pattern, key] of fixed) {
    assert.equal(pattern.exec(html)?.[1], nl[key], `index.html: de vaste tekst bij ${key}`);
    assert.ok(applyLanguage.includes(`t('${key}')`), `ui/app.js zet ${key} niet in de gekozen taal`);
  }
  // Meer tekst met letters staat er niet in de pagina zelf, behalve de naam van de app en de melding zonder JavaScript (in beide talen).
  const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<noscript>[\s\S]*?<\/noscript>/, '').replace(/<[^>]+>/g, ' ').match(/\p{L}[\p{L} ]*/gu).map((s) => s.trim());
  assert.deepEqual(visible, ['Tickory', 'Tickory', nl['common.add']]);
  assert.match(html, /<noscript><p class="fatal">Deze app heeft JavaScript nodig\.<\/p><p class="fatal" lang="en">This app needs JavaScript\.<\/p><\/noscript>/);
});

// ---------- t(): invulvelden, meervoud en terugval ----------

test('invulvelden: ingevuld van links naar rechts, een ingevulde waarde wordt niet opnieuw gelezen', () => {
  assert.equal(t('section.newIn', { name: 'Thuis' }), 'Nieuwe sectie in Thuis');
  assert.equal(t('share.removeText', { name: '{project}', project: 'Thuis' }), '{project} ziet "Thuis" niet meer. Toewijzingen en herinneringen van die persoon voor dit project vervallen.');
  assert.equal(t('section.newIn', { name: '$& $1 {name}' }), 'Nieuwe sectie in $& $1 {name}');
  assert.equal(t('view.showCompleted', { count: 0 }), 'Voltooide taken tonen (0)');
  assert.equal(t('section.newIn'), 'Nieuwe sectie in {name}', 'een vergeten invulveld blijft zichtbaar staan en geeft geen fout');
  assert.equal(t('section.newIn', { name: undefined }), 'Nieuwe sectie in {name}');
});

test('meervoud: Nederlands en Engels hebben elk enkelvoud (precies 1) en meervoud', () => {
  assert.equal(t('logout.textWaiting', { count: 1 }), 'Er staat nog 1 wijziging te wachten die niet naar de server zijn gestuurd. Die gaan verloren.');
  assert.equal(t('logout.textWaiting', { count: 2 }), 'Er staan nog 2 wijzigingen te wachten die niet naar de server zijn gestuurd. Die gaan verloren.');
  assert.equal(t('login.switchTextWaiting', { name: 'Bob', count: 1 }), 'Op dit apparaat staan nog de gegevens van Bob, met 1 wijziging die nog niet naar de server zijn gestuurd. Die worden gewist.');
  assert.equal(t('login.switchTextWaiting', { name: 'Bob', count: 3 }), 'Op dit apparaat staan nog de gegevens van Bob, met 3 wijzigingen die nog niet naar de server zijn gestuurd. Die worden gewist.');
  assert.equal(t('sync.waiting', { count: 1 }), '1 wachtend');
  assert.equal(t('sync.waiting', { count: 12 }), '12 wachtend');
  assert.equal(t('account.tooManyAttempts', { count: 15 }), 'Te veel mislukte pogingen. Probeer het over 15 minuten opnieuw.');
  inEnglish(() => {
    assert.equal(t('sync.waiting', { count: 1 }), '1 change waiting');
    assert.equal(t('sync.waiting', { count: 2 }), '2 changes waiting');
    assert.equal(t('sync.waiting', { count: 0 }), '0 changes waiting');
    assert.equal(t('sync.waiting', { count: 21 }), '21 changes waiting');
    assert.equal(t('account.tooManyAttempts', { count: 1 }), 'Too many failed attempts. Try again in 1 minute.');
    assert.equal(t('account.tooManyAttempts', { count: 15 }), 'Too many failed attempts. Try again in 15 minutes.');
    assert.equal(t('logout.textWaiting', { count: 1 }), "1 change is still waiting and hasn't been sent to the server. It will be lost.");
    assert.equal(t('logout.textWaiting', { count: 4 }), "4 changes are still waiting and haven't been sent to the server. They will be lost.");
    assert.match(t('login.switchTextWaiting', { name: 'Bob', count: 1 }), /belonging to Bob, including 1 change that hasn't/);
    assert.match(t('login.switchTextWaiting', { name: 'Bob', count: 2 }), /belonging to Bob, including 2 changes that haven't/);
  });
  // zonder aantal: het meervoud, nooit een fout of een lege tekst
  assert.equal(t('sync.waiting'), '{count} wachtend');
});

test('een ontbrekende sleutel geeft nooit een lege tekst of een fout: eerst Nederlands, dan de sleutel zelf', () => {
  assert.equal(t('bestaat.niet'), 'bestaat.niet');
  assert.equal(t('constructor'), 'constructor', 'geen eigenschappen van Object');
  assert.equal(t('toString', { count: 1 }), 'toString');
  assert.equal(t(undefined), 'undefined');
  const saved = { today: en['nav.today'], waiting: en['sync.waiting'], nlToday: nl['nav.today'] };
  try {
    delete en['nav.today'];
    en['sync.waiting'] = '';
    inEnglish(() => {
      assert.equal(t('nav.today'), 'Vandaag', 'ontbreekt de Engelse tekst, dan de Nederlandse');
      assert.equal(t('sync.waiting', { count: 2 }), '2 wachtend', 'een lege Engelse tekst telt als ontbrekend');
      assert.equal(t('nav.upcoming'), 'Upcoming');
      delete nl['nav.today'];
      assert.equal(t('nav.today'), 'nav.today', 'ontbreekt ook de Nederlandse, dan de sleutel');
    });
  } finally {
    en['nav.today'] = saved.today;
    en['sync.waiting'] = saved.waiting;
    nl['nav.today'] = saved.nlToday;
  }
  assert.equal(inEnglish(() => t('nav.today')), 'Today');
});

// ---------- de taalkeuze ----------

test('taalkeuze: opgeslagen voorkeur, dan de talen van de browser, anders Nederlands', () => {
  assert.equal(DEFAULT_LANGUAGE, 'nl');
  assert.deepEqual(LANGUAGES.map((l) => l.code), ['nl', 'en']);
  assert.deepEqual(LANGUAGES.map((l) => l.name), ['Nederlands', 'English']);
  // 1. de opgeslagen voorkeur wint altijd
  assert.equal(detectLanguage({ stored: 'en', browserLanguages: ['nl-NL', 'nl'] }), 'en');
  assert.equal(detectLanguage({ stored: 'nl', browserLanguages: ['en-US'] }), 'nl');
  // een onbekende of beschadigde voorkeur telt niet
  assert.equal(detectLanguage({ stored: 'fr', browserLanguages: ['en-US'] }), 'en');
  assert.equal(detectLanguage({ stored: '', browserLanguages: ['nl'] }), 'nl');
  assert.equal(detectLanguage({ stored: 'toString', browserLanguages: ['nl'] }), 'nl');
  assert.equal(detectLanguage({ stored: 'EN', browserLanguages: ['nl'] }), 'nl');
  // 2. de browser: begint er één taal met "nl", dan Nederlands; anders Engels
  assert.equal(detectLanguage({ browserLanguages: ['nl-NL', 'nl', 'en'] }), 'nl');
  assert.equal(detectLanguage({ browserLanguages: ['nl'] }), 'nl');
  assert.equal(detectLanguage({ browserLanguages: ['nl-BE'] }), 'nl');
  assert.equal(detectLanguage({ browserLanguages: ['NL-nl'] }), 'nl');
  assert.equal(detectLanguage({ browserLanguages: ['en-US', 'en', 'nl'] }), 'nl', 'Nederlands hoeft niet vooraan te staan');
  assert.equal(detectLanguage({ browserLanguages: ['en-US', 'en'] }), 'en');
  assert.equal(detectLanguage({ browserLanguages: ['de-DE', 'fr'] }), 'en', 'elke andere taal krijgt Engels');
  assert.equal(detectLanguage({ browserLanguages: ['nb-NO', 'nn', 'ne'] }), 'en', 'alleen "nl", niet elke taal die met een n begint');
  assert.equal(detectLanguage({ browserLanguages: ['nlx'] }), 'en');
  // 3. geen browser (zoals in deze tests): Nederlands
  assert.equal(detectLanguage(), 'nl');
  assert.equal(detectLanguage({ stored: null, browserLanguages: null }), 'nl');
  assert.equal(detectLanguage({ browserLanguages: [] }), 'nl');
  assert.equal(detectLanguage({ browserLanguages: ['', null] }), 'nl');
});

test('zonder browser is de taal Nederlands, ook als Node zelf een andere systeemtaal meldt', () => {
  assert.equal(typeof document, 'undefined', 'deze test draait zonder pagina');
  assert.equal(getLanguage(), 'nl');
  assert.equal(getLocale(), 'nl-NL');
});

test('setLanguage wisselt direct, weigert een onbekende taal en geeft de locale voor datum en tijd', () => {
  try {
    assert.equal(setLanguage('en'), 'en');
    assert.equal(getLanguage(), 'en');
    assert.equal(getLocale(), 'en-GB');
    assert.equal(t('nav.today'), 'Today');
    assert.equal(setLanguage('fr'), 'en', 'een onbekende taal verandert niets');
    assert.equal(setLanguage(undefined), 'en');
    assert.equal(setLanguage('toString'), 'en');
    assert.equal(getLanguage(), 'en');
  } finally {
    setLanguage('nl');
  }
  assert.equal(t('nav.today'), 'Vandaag');
  // de datum met tijd in de lijst met apparaten
  const d = new Date(2026, 10, 13, 14, 5);
  assert.equal(d.toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }), '13 nov 2026, 14:05');
  inEnglish(() => assert.equal(d.toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }), '13 Nov 2026, 14:05'));
});

/** Laadt een nieuw exemplaar van i18n.js in een nagebootste browser en geeft terug wat het kiest en bewaart. */
async function inFakeBrowser({ stored = null, languages, language, brokenStorage = false, page = true }, fn) {
  const store = new Map(stored === null ? [] : [[LANGUAGE_KEY, stored]]);
  const fake = {
    ...(page ? { document: { value: {} } } : {}),
    navigator: { value: { languages, language } },
    localStorage: {
      value: {
        getItem: (k) => { if (brokenStorage) throw new Error('opslag geblokkeerd'); return store.has(k) ? store.get(k) : null; },
        setItem: (k, v) => { if (brokenStorage) throw new Error('opslag geblokkeerd'); store.set(k, String(v)); },
      },
    },
  };
  const original = {};
  for (const [name, d] of Object.entries(fake)) {
    original[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { ...d, configurable: true, writable: true });
  }
  try {
    const fresh = await import(`./i18n.js?browser=${Math.random()}`);
    return await fn(fresh, store);
  } finally {
    for (const [name, d] of Object.entries(original)) {
      if (d) Object.defineProperty(globalThis, name, d);
      else delete globalThis[name];
    }
  }
}

test('in de browser: de browsertaal kiest, de voorkeur wordt bewaard onder tickory.lang en wint daarna', async () => {
  assert.equal(LANGUAGE_KEY, 'tickory.lang');
  await inFakeBrowser({ languages: ['en-US', 'en'] }, (i18n, store) => {
    assert.equal(i18n.getLanguage(), 'en', 'een Engelse browser krijgt Engels');
    assert.equal(i18n.t('nav.today'), 'Today');
    assert.equal(store.size, 0, 'alleen kijken bewaart niets');
    assert.equal(i18n.setLanguage('nl'), 'nl');
    assert.equal(store.get('tickory.lang'), 'nl');
    assert.equal(i18n.t('nav.today'), 'Vandaag');
  });
  await inFakeBrowser({ languages: ['nl-NL', 'nl', 'en'] }, (i18n) => assert.equal(i18n.getLanguage(), 'nl'));
  await inFakeBrowser({ languages: ['en-GB', 'nl'] }, (i18n) => assert.equal(i18n.getLanguage(), 'nl', 'Nederlands ergens in de lijst is genoeg'));
  await inFakeBrowser({ languages: ['de'] }, (i18n) => assert.equal(i18n.getLanguage(), 'en'));
  await inFakeBrowser({ languages: undefined, language: 'en-US' }, (i18n) => assert.equal(i18n.getLanguage(), 'en', 'een oude browser kent alleen navigator.language'));
  await inFakeBrowser({ languages: [], language: 'nl' }, (i18n) => assert.equal(i18n.getLanguage(), 'nl'));
  await inFakeBrowser({ languages: [], language: '' }, (i18n) => assert.equal(i18n.getLanguage(), 'nl', 'een browser zonder taal: de hoofdtaal'));
  await inFakeBrowser({ stored: 'en', languages: ['nl-NL'] }, (i18n) => assert.equal(i18n.getLanguage(), 'en', 'de bewaarde voorkeur gaat voor de browsertaal'));
  await inFakeBrowser({ stored: 'nl', languages: ['en-US'] }, (i18n) => assert.equal(i18n.getLanguage(), 'nl'));
  await inFakeBrowser({ stored: 'klingon', languages: ['en-US'] }, (i18n) => assert.equal(i18n.getLanguage(), 'en', 'een onbekende voorkeur telt niet'));
  // geblokkeerde opslag (privémodus): geen fout, de browsertaal beslist en wisselen werkt tot de pagina sluit
  await inFakeBrowser({ languages: ['en-US'], brokenStorage: true }, (i18n) => {
    assert.equal(i18n.getLanguage(), 'en');
    assert.equal(i18n.setLanguage('nl'), 'nl');
    assert.equal(i18n.getLanguage(), 'nl');
  });
  assert.equal(typeof document, 'undefined', 'de nagebootste browser is weer opgeruimd');
  assert.equal(getLanguage(), 'nl');
});

test('zonder pagina (Node, zoals in de tests en op de bouwserver) telt de systeemtaal niet, en wordt er niets gelezen of bewaard', async () => {
  // Node heeft zelf een `navigator` met de taal van het systeem; op een Engelse bouwserver is dat "en-US".
  await inFakeBrowser({ page: false, stored: 'en', languages: ['en-US', 'en'], language: 'en-US' }, (i18n) => {
    assert.equal(i18n.getLanguage(), 'nl', 'noch de systeemtaal, noch een toevallig aanwezige opslag bepaalt de taal');
    assert.equal(i18n.t('nav.today'), 'Vandaag');
  });
  await inFakeBrowser({ page: false, languages: ['en-US'] }, (i18n, store) => {
    assert.equal(i18n.setLanguage('en'), 'en');
    assert.equal(store.size, 0, 'zonder pagina wordt de keuze niet bewaard');
  });
});

// ---------- datums tonen (core/format.js) ----------

const TODAY = '2026-11-11'; // woensdag

test('Engels: vandaag, morgen, weekdagen en maanden', () => {
  inEnglish(() => {
    assert.equal(formatDate(TODAY, TODAY), 'today');
    assert.equal(formatDate('2026-11-12', TODAY), 'tomorrow');
    assert.equal(formatDate('2026-11-10', TODAY), 'yesterday');
    assert.equal(formatDate('2026-11-13', TODAY), 'Friday');
    assert.equal(formatDate('2026-11-17', TODAY), 'Tuesday');
    assert.equal(formatDate('2026-11-18', TODAY), 'Wed 18 Nov');
    assert.equal(formatDate('2026-11-03', TODAY), 'Tue 3 Nov');
    assert.equal(formatDate('2027-03-01', TODAY), '1 Mar 2027');
    assert.equal(formatDue({ date: '2026-11-12T09:00' }, TODAY), 'tomorrow 09:00');
    assert.equal(formatDue({ date: '2026-11-13', recurrence: { freq: 'weekly' } }, TODAY), '↻ Friday');
    assert.equal(formatDue(null, TODAY), '');
    assert.equal(formatDayHeading(TODAY, TODAY), 'Today · Wed 11 Nov');
    assert.equal(formatDayHeading('2026-11-12', TODAY), 'Tomorrow · Thu 12 Nov');
    assert.equal(formatDayHeading('2026-11-14', TODAY), 'Saturday · 14 Nov');
    assert.equal(formatDueLong({ date: '2026-11-19' }, TODAY), 'Thu 19 Nov');
    assert.equal(formatDueLong({ date: '2026-11-12T09:00' }, TODAY), 'Thu 12 Nov 09:00');
    assert.equal(formatDueLong({ date: '2027-01-01T14:30' }, TODAY), 'Fri 1 Jan 2027 14:30');
    assert.equal(formatDueLong({ date: '2026-11-13', recurrence: { freq: 'weekly' } }, TODAY), '↻ Fri 13 Nov');
    assert.equal(formatDueLong(null, TODAY), '');
  });
});

test('elke weekdag en elke maand heeft in beide talen een eigen naam', () => {
  const names = (lang) => {
    setLanguage(lang);
    try {
      const days = [];
      const short = [];
      const months = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays('2027-01-03', i); // zondag 3 januari 2027
        days.push(formatDayHeading(date, '2026-06-01').split(' · ')[0]);
        short.push(formatDueLong({ date }, '2027-06-01').split(' ')[0]);
      }
      for (let m = 1; m <= 12; m++) months.push(formatDate(`2030-${String(m).padStart(2, '0')}-15`, '2026-06-01').split(' ')[1]);
      return { days, short, months };
    } finally {
      setLanguage('nl');
    }
  };
  assert.deepEqual(names('nl'), {
    days: ['Zondag', 'Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag'],
    short: ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'],
    months: ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
  });
  assert.deepEqual(names('en'), {
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    short: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  });
});

test('de datum in het invoerveld is in elke taal weer te lezen door de datumherkenner', () => {
  const now = new Date(2026, 10, 13, 10, 0); // vrijdag 13 november 2026
  assert.equal(formatDateInput({ date: '2026-12-31' }), '31-12-2026');
  assert.equal(formatDateInput({ date: '2026-12-31T14:30' }), '31-12-2026 om 14:30');
  assert.equal(formatDateInput({ date: '2026-11-13', recurrence: { freq: 'weekly' }, string: 'elke vrijdag' }), 'elke vrijdag');
  inEnglish(() => {
    assert.equal(formatDateInput({ date: '2026-12-31' }), '2026-12-31');
    assert.equal(formatDateInput({ date: '2026-12-31T14:30' }), '2026-12-31T14:30');
    assert.equal(formatDateInput({ date: '2026-12-31T14:30:59' }), '2026-12-31T14:30', 'seconden vallen weg, net als in het Nederlands');
    assert.equal(formatDateInput({ date: '2026-11-13', recurrence: { freq: 'weekly' }, string: 'elke vrijdag' }), 'elke vrijdag', 'een herhaling blijft zoals ze is getypt');
    assert.equal(formatDateInput(null), '');
    assert.ok(!/[a-su-z]/i.test(formatDateInput({ date: '2026-12-31T14:30' })), 'geen Nederlands woord ("om") in de Engelse vorm');
  });
  for (const lang of ['nl', 'en']) {
    setLanguage(lang);
    try {
      for (const date of ['2026-11-13', '2026-11-13T18:30', '2026-12-31', '2026-12-31T14:30', '2027-01-05T00:00', '2028-02-29', '2030-06-01T09:05']) {
        const text = formatDateInput({ date });
        assert.deepEqual(parseDateText(text, now)?.date, date, `${lang}: "${text}" wordt niet teruggelezen als ${date}`);
      }
    } finally {
      setLanguage('nl');
    }
  }
});

// ---------- de datumtaal: eerlijke voorbeelden ----------

test('elke datum die een tekst als voorbeeld noemt, wordt ook echt herkend', () => {
  const now = new Date(2026, 10, 13, 10, 0);
  const view = { projects: new Map([['inbox-test', { id: 'inbox-test', name: 'Inbox' }]]), sections: new Map(), labels: new Map() };
  const quick = (text) => parseQuickAdd(text, { view, now, defaultProjectId: 'inbox-test' });
  const numeric = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?|\b\d{1,2}-\d{1,2}(?:-\d{4})?\b/g;

  // Het datumveld in het bewerkvenster: alles wat het voorbeeld, de uitleg en de foutmelding noemen.
  for (const key of ['task.duePlaceholder', 'task.dueError', 'date.dutchOnly']) {
    const examples = en[key].match(numeric) ?? [];
    assert.ok(examples.length >= 2, `en ${key}: verwacht voorbeelden van een datum, vond ${JSON.stringify(examples)}`);
    for (const example of examples) assert.ok(parseDateText(example, now), `en ${key}: het voorbeeld "${example}" wordt niet herkend`);
  }
  assert.deepEqual(parseDateText('31-12', now), { date: '2026-12-31', string: '31-12', lang: 'nl' });
  assert.deepEqual(parseDateText('31-12-2026', now)?.date, '2026-12-31');
  assert.deepEqual(parseDateText('2026-12-31', now)?.date, '2026-12-31');
  assert.deepEqual(parseDateText('2026-12-31T14:30', now)?.date, '2026-12-31T14:30');
  for (const quoted of nl['task.dueError'].match(/"[^"]+"/g)) assert.ok(parseDateText(quoted.slice(1, -1), now), `nl task.dueError: ${quoted} wordt niet herkend`);
  assert.ok(parseDateText('morgen om 9 uur', now) && parseDateText('elke maandag', now), 'de Nederlandse voorbeelden in het datumveld');

  // Snel toevoegen: het voorbeeld in het invoerveld, en de uitleg die eronder kan verschijnen.
  const example = /e\.g\. (.+)$/.exec(en['quick.placeholder'])[1];
  const parsed = quick(example);
  assert.deepEqual({ content: parsed.content, due: parsed.due?.date, priority: parsed.priority }, { content: 'Pay rent', due: '2026-12-31', priority: 1 }, `en quick.placeholder: "${example}"`);
  const nlExample = quick(/bv\. (.+)$/.exec(nl['quick.placeholder'])[1]);
  assert.deepEqual({ content: nlExample.content, due: nlExample.due?.date, priority: nlExample.priority }, { content: 'Bellen', due: '2026-11-14', priority: 1 });
  for (const found of en['date.dutchOnly'].match(numeric)) {
    const p = quick(`Call the dentist ${found}`);
    assert.deepEqual({ content: p.content, due: p.due?.date }, { content: 'Call the dentist', due: '2026-12-31' }, `en date.dutchOnly: "${found}" werkt niet bij snel toevoegen`);
  }

  // Wat de Engelse teksten bewust níet beloven: dit herkent de herkenner (nog) niet.
  for (const no of ['tomorrow', 'tomorrow at 9', 'next friday', 'every monday', '14:30', '31-12 14:30', '12/31/2026']) {
    assert.equal(parseDateText(no, now), null, `"${no}" wordt nu wel herkend: pas de Engelse voorbeelden en hints aan`);
  }
  assert.equal(quick('Call the dentist 2026-12-31').due, null, 'de ISO-vorm werkt alleen in het datumveld, niet bij snel toevoegen');
  for (const text of Object.values(en).flatMap(forms)) {
    assert.ok(!/\b\d{1,2}:\d{2}\b/.test(text.replace(/T\d{2}:\d{2}/g, '')), `Engelse tekst noemt een los tijdstip dat niet werkt: "${text}"`);
  }
});

test('de uitleg over de datumtaal staat er alleen als de interface geen Nederlands is', () => {
  assert.equal(dateLanguageNote(), '');
  inEnglish(() => {
    assert.equal(dateLanguageNote(), en['date.dutchOnly']);
    assert.match(dateLanguageNote(), /only recognized in Dutch for now/);
  });
  for (const text of ['Call dentist tomorrow', 'Gym every monday', 'Meeting at 9', 'Lunch 12:30pm', 'Call mom on Friday', 'Report next week', 'Pay rent in 3 days', 'Standup daily', 'Dinner tonight', 'Review 9 am']) {
    assert.ok(mentionsEnglishDate(text), `"${text}" lijkt een Engelse datum`);
  }
  for (const text of ['Call dentist', 'Tandarts bellen morgen', 'Buy sun cream', 'May I ask', 'March for science', 'Read chapter 3', 'Email sat@example.com', 'Planten water geven', '', null, undefined]) {
    assert.ok(!mentionsEnglishDate(text), `"${text}" is geen Engelse datum`);
  }
});

// ---------- geweigerde wijzigingen (core/messages.js) ----------

test('Engels: welk soort handeling het was', () => {
  inEnglish(() => {
    assert.equal(describeCommand('task_update'), 'edit the task');
    assert.equal(describeCommand('label_add'), 'add the label');
    assert.equal(describeCommand('task_complete'), 'complete the task');
    assert.equal(describeCommand('task_uncomplete'), 'reopen the task');
    assert.equal(describeCommand('project_delete'), 'delete the project');
    assert.equal(describeCommand('task_move'), 'move the task');
    assert.equal(describeCommand('comment_add'), 'add the comment');
    assert.equal(describeCommand('reminder_delete'), 'delete the reminder');
    assert.equal(describeCommand('section_update'), 'edit the section');
    assert.equal(describeCommand('filter_add'), 'add the filter');
    assert.equal(describeCommand('project_share'), 'share the project');
    assert.equal(describeCommand('project_unshare'), 'remove someone from the project');
    assert.equal(describeCommand('project_leave'), 'leave the project');
    assert.equal(describeCommand('onzin'), '');
    assert.equal(describeCommand('constructor_add'), '');
    assert.equal(describeCommand(undefined), '');
  });
});

test('Engels: elke foutcode geeft een eigen Engelse melding; de Nederlandse tekst van de server blijft buiten beeld', () => {
  const dutch = 'task.priority: moet een van 1, 2, 3, 4 zijn';
  inEnglish(() => {
    const codes = ['NOT_FOUND', 'DUPLICATE', 'CYCLE', 'CONFLICT', 'ID_EXISTS', 'UNAUTHORIZED', 'TOO_LARGE', 'UNKNOWN_COMMAND', 'INTERNAL', 'FORBIDDEN', 'UNKNOWN',
      'INVALID_ARG', 'MISSING_ARG', 'UNKNOWN_ARG', 'READONLY', 'IMMUTABLE', 'INVALID_REQUEST'];
    const seen = new Set();
    for (const error_code of codes) {
      const text = describeCommandError({ cmd: { type: 'task_update' }, error_code, error: dutch });
      assert.match(text, /^Couldn't edit the task\. [A-Z]/, error_code);
      assert.ok(!/task\.priority|moet een van|zijn/.test(text), `${error_code} toont de tekst van de server: ${text}`);
      assert.ok(text.endsWith('.'), text);
      seen.add(text);
    }
    assert.equal(seen.size, 12, 'elke code een eigen zin (de zes "ongeldig"-codes delen er één)');
    assert.equal(describeCommandError({ cmd: { type: 'task_update' }, error_code: 'NOT_FOUND' }), "Couldn't edit the task. This no longer exists; it may have been deleted on another device.");
    assert.equal(describeCommandError({ cmd: { type: 'label_add' }, error_code: 'DUPLICATE', error: 'er bestaat al een label met deze naam' }), "Couldn't add the label. A label with that name already exists.");
    assert.equal(describeCommandError({ cmd: { type: 'task_update' }, error_code: 'INVALID_ARG', error: 'de toegewezen persoon is geen lid van dit project' }), "Couldn't edit the task. This change is invalid and wasn't applied.");
    assert.equal(describeCommandError({ cmd: { type: 'task_add' }, error_code: 'UNKNOWN', error: 'onbekende fout' }), "Couldn't add the task. Unknown error.");
  });
});

test('Engels: delen en rechten krijgen een eigen vertaling per handeling en code', () => {
  const cases = [
    ['project_share', 'NOT_FOUND', 'deze gebruiker bestaat niet', "Couldn't share the project. There's no user with that username."],
    ['project_share', 'FORBIDDEN', 'alleen de eigenaar kan een project delen', "Couldn't share the project. Only the owner can share a project."],
    ['project_share', 'CONFLICT', 'de Inbox kan niet worden gedeeld', "Couldn't share the project. The Inbox can't be shared."],
    ['project_unshare', 'FORBIDDEN', 'alleen de eigenaar kan iemand uit een project halen', "Couldn't remove someone from the project. Only the owner can remove someone from a project."],
    ['project_unshare', 'NOT_FOUND', 'deze persoon is geen lid van het project', "Couldn't remove someone from the project. This person is no longer a member of the project."],
    ['project_unshare', 'CONFLICT', 'een eigenaar kan niet uit het project worden gehaald', "Couldn't remove someone from the project. An owner can't be removed from the project."],
    ['project_leave', 'CONFLICT', 'de eigenaar kan het project niet verlaten; verwijder het project of laat het door iemand anders overnemen', "Couldn't leave the project. The owner can't leave the project; delete the project instead."],
    ['project_leave', 'NOT_FOUND', 'project_id: project bestaat niet', "Couldn't leave the project. This no longer exists; it may have been deleted on another device."],
    ['project_delete', 'FORBIDDEN', 'alleen de eigenaar kan een project verwijderen; gebruik "verlaten" om er zelf uit te gaan', 'Couldn\'t delete the project. Only the owner can delete a project; use "Leave project" to leave it yourself.'],
    ['project_update', 'FORBIDDEN', 'alleen de eigenaar kan een project verplaatsen', "Couldn't edit the project. Only the owner can move a project."],
    ['label_update', 'FORBIDDEN', 'dit label is van iemand anders; je kunt het alleen lezen', "Couldn't edit the label. This label belongs to someone else; you can only view it."],
    ['label_delete', 'FORBIDDEN', 'dit label is van iemand anders; je kunt het alleen lezen', "Couldn't delete the label. This label belongs to someone else; you can only view it."],
    ['filter_update', 'FORBIDDEN', 'dit filter is van iemand anders', "Couldn't edit the filter. This filter belongs to someone else."],
    ['filter_delete', 'FORBIDDEN', 'dit filter is van iemand anders', "Couldn't delete the filter. This filter belongs to someone else."],
    ['comment_update', 'FORBIDDEN', 'je kunt alleen je eigen opmerkingen wijzigen of verwijderen', "Couldn't edit the comment. You can only edit or delete your own comments."],
    ['comment_delete', 'FORBIDDEN', 'je kunt alleen je eigen opmerkingen wijzigen of verwijderen', "Couldn't delete the comment. You can only edit or delete your own comments."],
    ['task_update', 'FORBIDDEN', 'iets wat de server nu nog niet zegt', "Couldn't edit the task. You don't have permission to do this."],
  ];
  inEnglish(() => {
    for (const [type, error_code, error, expected] of cases) assert.equal(describeCommandError({ cmd: { type }, error_code, error }), expected);
  });
  // In het Nederlands blijft voor dezelfde gevallen de tekst van de server staan, zoals voorheen.
  assert.equal(describeCommandError({ cmd: { type: 'project_share' }, error_code: 'NOT_FOUND', error: 'deze gebruiker bestaat niet' }), 'Niet gelukt (project delen). Deze gebruiker bestaat niet.');
  assert.equal(describeCommandError({ cmd: { type: 'label_update' }, error_code: 'FORBIDDEN', error: 'dit label is van iemand anders; je kunt het alleen lezen' }), 'Niet gelukt (label wijzigen). Dit label is van iemand anders; je kunt het alleen lezen');
  assert.equal(describeCommandError({ cmd: { type: 'task_add' }, error_code: 'UNKNOWN', error: 'onbekende fout' }), 'Niet gelukt (taak toevoegen). Onbekende fout');
});

test('Engels: een onbekende code valt terug op de tekst van de server; zonder alles een nette standaardtekst', () => {
  inEnglish(() => {
    assert.equal(describeCommandError({ cmd: { type: 'task_add' }, error_code: 'RARE_CODE', error: 'iets bijzonders' }), "Couldn't add the task. Iets bijzonders");
    assert.equal(describeCommandError({ error_code: 'RARE_CODE' }), "That didn't work. The change wasn't applied.");
    assert.equal(describeCommandError({}), "That didn't work. The change wasn't applied.");
    assert.equal(describeCommandError({ cmd: { type: 'onbekend' }, error_code: 'NOT_FOUND' }), "That didn't work. This no longer exists; it may have been deleted on another device.");
  });
});

// ---------- account-aanroepen (core/auth.js) ----------

/** Een nep-fetch die antwoordt zoals gevraagd. */
function fake(responses) {
  return async () => {
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status < 400, status: r.status, headers: new Headers(r.headers ?? {}), json: async () => { if (r.notJson) throw new Error('geen json'); return r.body; } };
  };
}
const messageOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ApiError);
    return err.message;
  }
  throw new Error('een fout verwacht');
};

test('Engels: fouten van de server komen als eigen Engelse tekst op basis van de code en de aanroep', async () => {
  const reply = (status, error_code, error) => ({ status, body: { error_code, error } });
  const answers = () => [
    reply(401, 'INVALID_CREDENTIALS', 'gebruikersnaam of wachtwoord klopt niet'),
    reply(429, 'TOO_MANY_ATTEMPTS', 'te veel mislukte pogingen; probeer het over 15 minuut of langer opnieuw'),
    reply(403, 'FORBIDDEN', 'het huidige wachtwoord klopt niet'),
    reply(401, 'UNAUTHORIZED', 'ongeldige of ontbrekende aanmelding'),
    reply(404, 'NOT_FOUND', 'deze sessie bestaat niet'),
    reply(403, 'FORBIDDEN', 'alleen voor beheerders'),
    reply(409, 'DUPLICATE', 'deze gebruikersnaam is al in gebruik'),
    reply(404, 'NOT_FOUND', 'gebruiker bestaat niet'),
    reply(409, 'CONFLICT', 'er moet minstens één actieve beheerder blijven'),
    reply(404, 'NOT_FOUND', 'gebruiker bestaat niet'),
    reply(500, 'INTERNAL', 'interne fout'),
    reply(400, 'INVALID_ARG', 'wachtwoord: maximaal 200 tekens'),
    { status: 502, notJson: true },
    new TypeError('Failed to fetch'),
  ];
  const run = (api) => [
    api.login('a', 'b'), api.login('a', 'b'), api.changePassword('a', 'b'), api.sessions(), api.revokeSession('s1'), api.admin.users(),
    api.admin.createUser({}), api.admin.updateUser('u1', {}), api.admin.updateUser('u1', {}), api.admin.resetPassword('u1', 'x'), api.me(),
    api.admin.resetPassword('u1', 'x'), api.me(), api.me(),
  ];
  const collect = async () => {
    const api = createApi({ fetch: fake(answers()) });
    const out = [];
    for (const p of run(api).map(messageOf)) out.push(await p);
    return out;
  };
  // let op: de aanroepen starten in volgorde, dus elk krijgt het antwoord op dezelfde plek in de lijst
  assert.deepEqual(await inEnglishAsync(collect), [
    'Incorrect username or password.',
    'Too many failed attempts. Try again later.',
    'The current password is incorrect.',
    "You're no longer signed in. Sign in again.",
    'This device was already signed out.',
    'Only an admin can do this.',
    'This username is already taken.',
    'This user no longer exists.',
    'At least one active admin must remain.',
    'This user no longer exists.',
    'The server had a problem. Try again later.',
    'Wachtwoord: maximaal 200 tekens', // geen eigen vertaling: de afgesproken terugval op de tekst van de server
    'The server returned an error (502).',
    'No connection to the server. Check your internet connection and the server address.',
  ]);
  // In het Nederlands verandert er niets: de tekst van de server, met een hoofdletter.
  assert.deepEqual(await collect(), [
    'Gebruikersnaam of wachtwoord klopt niet',
    'Te veel mislukte pogingen; probeer het over 15 minuut of langer opnieuw',
    'Het huidige wachtwoord klopt niet',
    'Ongeldige of ontbrekende aanmelding',
    'Deze sessie bestaat niet',
    'Alleen voor beheerders',
    'Deze gebruikersnaam is al in gebruik',
    'Gebruiker bestaat niet',
    'Er moet minstens één actieve beheerder blijven',
    'Gebruiker bestaat niet',
    'Interne fout',
    'Wachtwoord: maximaal 200 tekens',
    'De server gaf een fout (502).',
    'Geen verbinding met de server. Controleer je internetverbinding en het adres van de server.',
  ]);
});

test('de apparaatnaam in het Engels', () => {
  const chromeAndroid = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
  inEnglish(() => {
    assert.equal(deviceName(chromeAndroid), 'Chrome on Android');
    assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'), 'Edge on Windows');
    assert.equal(deviceName(chromeAndroid, { app: true }), 'Android app');
    assert.equal(deviceName(''), 'Browser on unknown device');
  });
});

test('controle vóór het versturen: dezelfde regels en (in het Nederlands) dezelfde tekst als de server', async () => {
  const users = await import('../../server/users.ts');
  const serverSays = (fn) => {
    try {
      fn();
      return '';
    } catch (err) {
      return `${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}`; // zo toont de app de tekst van de server
    }
  };
  const usernames = ['anna', 'a', 'ab', 'x'.repeat(40), 'x'.repeat(41), 'Zoë', 'zoe\u0308', 'jan.de-vries_2', '.jan', '-jan', '_jan', '9lives', 'jan jansen', 'jan@huis', ' anna ', '', 'é', 'éé', '日本'];
  for (const name of usernames) assert.equal(usernameProblem(name), serverSays(() => users.validateUsername(name)), `gebruikersnaam ${JSON.stringify(name)}`);
  const names = ['Anna de Vries', '', ' ', 'a', 'x'.repeat(100), 'x'.repeat(101), 'Anna\u0007', 'Anna\tde  Vries', ' Anna '];
  for (const name of names) assert.equal(displayNameProblem(name), serverSays(() => users.validateDisplayName(name)), `naam ${JSON.stringify(name)}`);
  const passwords = [['kort', ''], ['precies-10', ''], ['negen-tek', ''], ['x'.repeat(200), ''], ['x'.repeat(201), ''], ['een-goed-wachtwoord', 'anna'], ['Anna-de-Vries', 'anna-de-vries'],
    ['anna-de-vries', 'Anna-De-Vries'], ['  anna-de-vries ', 'anna-de-vries'], ['😀😀😀😀😀😀😀😀😀', ''], ['😀😀😀😀😀😀😀😀😀😀', ''], ['', '']];
  for (const [password, username] of passwords) {
    assert.equal(passwordProblem(password, username), serverSays(() => users.validatePassword(password, username || undefined)), `wachtwoord ${JSON.stringify(password)} bij ${JSON.stringify(username)}`);
  }
  assert.equal(passwordProblem('kort'), 'Wachtwoord: minimaal 10 tekens');
  assert.equal(usernameProblem('a'), 'Gebruikersnaam: 2 tot 40 tekens, letters, cijfers, punt, streepje of underscore, beginnend met een letter of cijfer');
  inEnglish(() => {
    assert.equal(passwordProblem('kort'), 'The password needs at least 10 characters.');
    assert.equal(passwordProblem('x'.repeat(201)), 'The password can have at most 200 characters.');
    assert.equal(passwordProblem('anna-de-vries', 'Anna-de-Vries'), "The password can't be the same as the username.");
    assert.equal(passwordProblem('een-goed-wachtwoord', 'anna'), '');
    assert.equal(usernameProblem('a'), 'A username has 2 to 40 characters (letters, digits, dot, hyphen or underscore) and starts with a letter or digit.');
    assert.equal(usernameProblem('anna'), '');
    assert.equal(displayNameProblem(''), 'A name has 1 to 100 characters and no control characters.');
    assert.equal(displayNameProblem('Anna'), '');
  });
});
