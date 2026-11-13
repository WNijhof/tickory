// Tests voor de teksten bij de filtertaal (core/filterText.js): elke foutmelding in beide talen, de plek van een fout, en
// dat elk voorbeeld en elke term uit de uitleg ook echt werkt, in het Nederlands én het Engels, met dezelfde uitkomst.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from './reducer.js';
import { FILTER_ERROR_CODES, compileFilter } from './filter.js';
import { ERROR_CODES, FILTER_EXAMPLES, FILTER_TERM_GROUPS, errorParts, filterErrorText, formsOf } from './filterText.js';
import { setLanguage } from './i18n.js';

const NOW = new Date(2026, 10, 11, 9, 30); // woensdag 11 november 2026
const USER = 'u-anna';

function world() {
  const v = emptyState();
  const put = (res, row) => v[res].set(row.id, { order_key: row.id, ...row });
  for (const [id, name, parent] of [['p-werk', 'Werk'], ['p-work', 'Work'], ['p-thuis', 'Thuis'], ['p-home', 'Home'], ['p-sub', 'Onderdeel', 'p-werk']]) put('projects', { id, name, parent_id: parent ?? null });
  put('sections', { id: 's-plan', project_id: 'p-werk', name: 'Planning' });
  put('labels', { id: 'l-bellen', name: 'bellen', owner_id: USER });
  put('labels', { id: 'l-calls', name: 'calls', owner_id: USER });
  const base = { project_id: 'p-werk', section_id: null, parent_id: null, description: '', priority: 4, labels: [], due: null, deadline: null, checked: false, assignee_id: null };
  const tasks = [
    { id: 't01', content: 'Tandarts bellen', priority: 1, labels: ['l-bellen'], due: { date: '2026-11-11T14:00' } },
    { id: 't02', content: 'Café reserveren', project_id: 'p-thuis', due: { date: '2026-11-10' }, description: 'voor Zoë' },
    { id: 't03', content: 'Rapport schrijven', section_id: 's-plan', priority: 2, due: { date: '2026-11-12' }, deadline: '2026-11-20' },
    { id: 't04', content: 'Subtaak', parent_id: 't03', due: { date: '2026-11-17' }, labels: ['l-calls'] },
    { id: 't05', content: 'Gordijnen', project_id: 'p-home', due: { date: '2026-12-31' }, assignee_id: USER, priority: 3 },
    { id: 't06', content: 'Oud papier', project_id: 'p-sub', due: { date: '2026-11-11', string: 'elke week', recurrence: { freq: 'weekly' } }, assignee_id: 'u-bob' },
    { id: 't07', content: 'Klaar', checked: true, due: { date: '2026-11-04' }, priority: 1 },
    { id: 't08', content: 'Zonder datum', project_id: 'p-thuis' },
    { id: 't09', content: 'Dit jaar', due: { date: '2026-12-01' }, labels: ['l-bellen', 'l-calls'] },
    { id: 't10', content: 'Vorige maand', due: { date: '2026-10-15T09:00' } },
    { id: 't11', content: 'Morgen vroeg', due: { date: '2026-11-12T08:00' }, project_id: 'p-home' },
  ];
  for (const t of tasks) put('tasks', { ...base, ...t });
  put('reminders', { id: 'r1', task_id: 't01', type: 'relative', minute_offset: 30, owner_id: USER });
  return v;
}
const ctx = (view) => ({ view, now: NOW, userId: USER, users: [{ id: USER, username: 'anna', name: 'Anna' }, { id: 'u-bob', username: 'bob', name: 'Bob' }] });
const matches = (query, view) => {
  const r = compileFilter(query, ctx(view));
  assert.equal(r.ok, true, `${query}: ${JSON.stringify(r.error)}`);
  return [...view.tasks.values()].filter((t) => r.match(t)).map((t) => t.id).sort().join(',');
};

// Een zoekopdracht per foutcode die de fout echt oplevert.
const CAUSES = {
  empty_query: '', empty_term: 'vandaag &', empty_name: '#', unknown_term: 'blabla', unclosed_paren: '(vandaag', unexpected_paren: 'vandaag)',
  unclosed_quote: '"abc', expected_operator: 'vandaag morgen', comma_in_parens: '(vandaag, morgen)', unknown_project: '#Nergens',
  unknown_section: '/Nergens', unknown_label: '@nergens', unknown_user: 'toegewezen aan: Nergens', invalid_date: '31-02',
  bad_number: '9999999 dagen', too_deep: `${'('.repeat(60)}vandaag${')'.repeat(60)}`, too_long: 'a'.repeat(2001),
};

test('elke foutcode van de filtertaal heeft een vertaling, en de lijsten lopen niet uiteen', () => {
  assert.deepEqual([...ERROR_CODES].sort(), [...FILTER_ERROR_CODES].sort());
  for (const code of FILTER_ERROR_CODES) {
    if (code === 'internal' || code === 'no_user') continue;
    assert.ok(Object.hasOwn(CAUSES, code), `geen voorbeeld voor ${code}: voeg er een toe aan CAUSES`);
  }
});

test('elke fout levert de melding op in het Nederlands en in het Engels, met de naam of term erin en zonder open invulvelden', () => {
  const v = world();
  const seen = new Set();
  const cases = { ...CAUSES };
  for (const [code, query] of Object.entries(cases)) {
    const r = compileFilter(query, ctx(v));
    assert.equal(r.ok, false, `${code}: "${query.slice(0, 30)}" had een fout moeten geven`);
    assert.equal(r.error.code, code, `${query.slice(0, 30)}: ${r.error.code}`);
    seen.add(code);
    setLanguage('nl');
    const nl = filterErrorText(r.error);
    setLanguage('en');
    const en = filterErrorText(r.error);
    setLanguage('nl');
    for (const text of [nl, en]) {
      assert.ok(text.length > 8, `${code}: te korte tekst "${text}"`);
      assert.ok(!/\{\w+\}/.test(text), `${code}: een invulveld is niet ingevuld in "${text}"`);
    }
    assert.notEqual(nl, en, `${code}: in het Engels dezelfde tekst als in het Nederlands`);
    const param = r.error.params.name ?? r.error.params.term ?? r.error.params.prefix ?? r.error.params.max;
    if (param !== undefined) {
      assert.ok(nl.includes(String(param)) && en.includes(String(param)), `${code}: de ${param} hoort in de melding`);
    }
  }
  // "toegewezen aan mij" werkt alleen met een gebruiker
  const noUser = compileFilter('toegewezen aan mij', { view: v, now: NOW, userId: null });
  assert.equal(noUser.error.code, 'no_user');
  assert.match(filterErrorText(noUser.error), /ingelogd/);
  assert.equal(seen.size, Object.keys(CAUSES).length);
  // een onbekende code of niets geeft de algemene melding, nooit een fout
  assert.equal(filterErrorText({ code: 'bestaat-niet' }), filterErrorText({ code: 'internal' }));
  assert.equal(filterErrorText(undefined), filterErrorText({ code: 'internal' }));
});

test('errorParts: de getypte tekst rond de plek van een fout, ook aan de randen', () => {
  const v = world();
  const parts = (query) => errorParts(query, compileFilter(query, ctx(v)).error);
  assert.deepEqual(parts('vandaag & #Nergens & p1'), { before: 'vandaag & ', bad: '#Nergens', after: ' & p1' });
  assert.deepEqual(parts('vandaag &'), { before: 'vandaag ', bad: '&', after: '' }, 'een ontbrekende term aan het einde: de operator zonder term wordt gemarkeerd');
  assert.deepEqual(parts('blabla'), { before: '', bad: 'blabla', after: '' });
  assert.deepEqual(parts('vandaag | #Nergens'), { before: 'vandaag | ', bad: '#Nergens', after: '' });
  // vreemde invoer geeft nooit een uitzondering
  assert.deepEqual(errorParts('abc', { position: 99, length: 5 }), { before: 'abc', bad: '', after: '' });
  assert.deepEqual(errorParts('abc', { position: -3, length: 2 }), { before: '', bad: 'ab', after: 'c' });
  assert.deepEqual(errorParts('abcdef', { position: -2, length: 1 }), { before: '', bad: 'a', after: 'bcdef' }, 'een negatieve plek begint vooraan');
  assert.deepEqual(errorParts('abcdef', { position: 3, length: -2 }), { before: 'abc', bad: '', after: 'def' }, 'een negatieve lengte markeert niets');
  assert.deepEqual(errorParts('abcdef', { position: 4, length: 99 }), { before: 'abcd', bad: 'ef', after: '' });
  assert.deepEqual(errorParts(null, null), { before: '', bad: '', after: '' });
  for (const q of Object.values(CAUSES)) {
    const e = compileFilter(q, ctx(v)).error;
    const p = errorParts(q, e);
    assert.equal(p.before + p.bad + p.after, q, 'de delen samen zijn weer de hele tekst');
  }
});

test('elk voorbeeld en elke term uit de uitleg klopt, in het Nederlands én het Engels, met dezelfde taken als uitkomst', () => {
  const v = world();
  const all = [...FILTER_EXAMPLES, ...FILTER_TERM_GROUPS.flatMap((g) => g.terms)];
  assert.ok(all.length >= 35);
  const results = new Set();
  const different = [];
  for (const item of all) {
    // de namen van projecten en labels zijn gegevens en lopen in de voorbeelden uiteen (Werk en Work, Thuis en Home, bellen en calls, tandarts en dentist)
    const nl = matches(item.nl, v);
    const en = matches(item.en.replace(/Work/g, 'Werk').replace(/Home/g, 'Thuis').replace(/calls/g, 'bellen').replace(/dentist/g, 'tandarts'), v);
    assert.equal(nl, en, `"${item.nl}" en "${item.en}" geven niet dezelfde taken`);
    results.add(nl);
  }
  assert.deepEqual(different, [], 'het Nederlandse en het Engelse woord horen dezelfde taken te geven');
  assert.ok(results.size >= 20, `de voorbeelden onderscheiden zich te weinig (${results.size} verschillende uitkomsten): ze testen dan niets`);
  assert.ok(![...results].every((r) => r === matches('alles', v)), 'niet elk voorbeeld mag alles teruggeven');
  // een paar uitkomsten met de hand nagerekend (woensdag 11 november 2026; open taken, tenzij "afgevinkt")
  assert.equal(matches('vandaag', v), 't01,t06');
  assert.equal(matches('te laat', v), 't02,t10');
  assert.equal(matches('p1 & !subtaak', v), 't01,t07', 'ook de afgevinkte p1-taak: dat filteren doet evaluateFilter, niet de voorwaarde');
  assert.equal(matches('(vandaag | morgen) & @bellen', v), 't01');
  assert.equal(matches('toegewezen aan mij & te laat', v), '');
  assert.equal(matches('afgevinkt & vorige week', v), 't07');
});

test('formsOf: eerst de vorm in de taal van de interface, dan (als die anders is) de andere', () => {
  const item = { nl: 'vandaag', en: 'today' };
  setLanguage('nl');
  assert.deepEqual(formsOf(item), { main: 'vandaag', other: 'today' });
  setLanguage('en');
  assert.deepEqual(formsOf(item), { main: 'today', other: 'vandaag' });
  assert.deepEqual(formsOf({ nl: 'p1', en: 'p1' }), { main: 'p1', other: null }, 'een gelijke vorm staat er maar één keer');
  setLanguage('nl');
});
