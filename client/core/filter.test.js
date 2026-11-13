// Tests voor de filtertaal (client/core/filter.js). De klok staat vast (`now` wordt meegegeven); woensdag 11 november 2026, 09:00.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from './reducer.js';
import { compileFilter, evaluateFilter, FILTER_ERROR_CODES, filterErrorMessage, TERMS } from './filter.js';
import { hasReminder } from './selectors.js';
import { ENTITIES } from '../../shared/schema.js';
import { addDays, todayString } from './format.js';

const NOW = new Date(2026, 10, 11, 9, 0, 0);
const ME = 'u-anna';
const USERS = [
  { id: 'u-anna', username: 'anna', name: 'Anna de Vries' },
  { id: 'u-bram', username: 'bram', name: 'Bram Jansen' },
  { id: 'u-bram2', username: 'bramk', name: 'Bram Köhler' },
];

let counter = 0;
/** Een taak met standaardwaarden; alleen opgeven wat ertoe doet. */
const T = (id, o = {}) => ({
  id, project_id: 'p-thuis', section_id: null, parent_id: null, content: id, description: '', priority: 4, labels: [], due: null,
  deadline: null, assignee_id: null, checked: false, order_key: `k${String(++counter).padStart(6, '0')}`, ...o,
});
const D = (date, extra = {}) => ({ date, ...extra });

/** Een toestand met een paar projecten, secties en labels, en de gegeven taken (en herinneringen). */
function world(tasks = [], { reminders = [], extra } = {}) {
  const v = emptyState();
  const put = (res, row) => v[res].set(row.id, { order_key: `k${++counter}`, ...row });
  put('projects', { id: 'inbox-u-anna', name: 'Inbox', order_key: 'a' });
  put('projects', { id: 'p-thuis', name: 'Thuis', order_key: 'b' });
  put('projects', { id: 'p-tuin', name: 'Tuin', parent_id: 'p-thuis', order_key: 'c' });
  put('projects', { id: 'p-schuur', name: 'Schuur', parent_id: 'p-tuin', order_key: 'd' });
  put('projects', { id: 'p-werk', name: 'Werk & privé', order_key: 'e' });
  put('projects', { id: 'p-cafe', name: 'Café', order_key: 'f' });
  put('projects', { id: 'p-oud', name: 'Oud', order_key: 'g', is_archived: true });
  put('sections', { id: 's-keuken', project_id: 'p-thuis', name: 'Keuken', order_key: 'a' });
  put('sections', { id: 's-bad', project_id: 'p-thuis', name: 'Badkamer', order_key: 'b' });
  put('sections', { id: 's-keuken-w', project_id: 'p-werk', name: 'keuken', order_key: 'a' });
  put('labels', { id: 'l-bellen', name: 'bellen', owner_id: ME, order_key: 'a' });
  put('labels', { id: 'l-zoe', name: 'Zoë', owner_id: ME, order_key: 'b' });
  put('labels', { id: 'l-extern', name: 'extern', owner_id: 'u-bram', order_key: 'c' });
  for (const t of tasks) v.tasks.set(t.id, t);
  for (const r of reminders) v.reminders.set(r.id, r);
  extra?.(v);
  return v;
}
const ctxOf = (view, more = {}) => ({ view, now: NOW, userId: ME, users: USERS, ...more });
const compiled = (query, view, more) => {
  const c = compileFilter(query, ctxOf(view, more));
  assert.equal(c.ok, true, `"${query}" hoort te compileren: ${JSON.stringify(c.error)}`);
  return c;
};
/** Ids van de taken waar de filtertekst op past (alle taken, ook afgevinkte), alfabetisch. */
const hits = (query, tasks, more = {}) => {
  const view = world(tasks, more);
  const c = compiled(query, view, more.ctx);
  return tasks.filter((t) => c.match(t)).map((t) => t.id).sort();
};
const error = (query, more = {}) => {
  const c = compileFilter(query, ctxOf(world([]), more));
  assert.equal(c.ok, false, `"${query}" hoort een fout te geven`);
  return c.error;
};

// ---------- datums ----------

const DATES = [
  T('today', { due: D('2026-11-11') }),
  T('todayPast', { due: D('2026-11-11T08:00') }),
  T('todayLater', { due: D('2026-11-11T15:00') }),
  T('tomorrow', { due: D('2026-11-12') }),
  T('yesterday', { due: D('2026-11-10') }),
  T('old', { due: D('2026-10-01') }),
  T('nodate'),
  T('d7', { due: D('2026-11-18') }),
  T('d8', { due: D('2026-11-19') }),
  T('mon9', { due: D('2026-11-09') }),
  T('sun15', { due: D('2026-11-15') }),
  T('mon16', { due: D('2026-11-16') }),
  T('sun22', { due: D('2026-11-22') }),
  T('mon23', { due: D('2026-11-23') }),
  T('last6', { due: D('2026-11-06') }),
  T('last2', { due: D('2026-11-02') }),
  T('minus7', { due: D('2026-11-04') }),
  T('minus8', { due: D('2026-11-03') }),
  T('dec31', { due: D('2026-12-31') }),
  T('dec31next', { due: D('2027-12-31') }),
  T('jan1', { due: D('2026-01-01') }),
  T('jan1next', { due: D('2027-01-01') }),
  T('leap', { due: D('2028-02-29') }),
  T('rec', { due: D('2026-11-13', { recurrence: { freq: 'weekly' } }) }),
  T('doneOld', { due: D('2026-10-01'), checked: true }),
];
const dayOf = (t) => t.due?.date.slice(0, 10) ?? null;
const where = (pred) => DATES.filter((t) => t.due && pred(dayOf(t))).map((t) => t.id).sort();

const TODAY_IDS = ['today', 'todayLater', 'todayPast'];
const DATE_CASES = [
  // [nederlands, engels, verwacht]
  ['vandaag', 'today', TODAY_IDS],
  ['morgen', 'tomorrow', ['tomorrow']],
  ['gisteren', 'yesterday', ['yesterday']],
  ['te laat', 'overdue', ['jan1', 'last2', 'last6', 'minus7', 'minus8', 'mon9', 'old', 'todayPast', 'yesterday']],
  ['geen datum', 'no date', ['nodate']],
  ['7 dagen', '7 days', where((d) => d >= '2026-11-11' && d <= '2026-11-18')],
  ['volgende 7 dagen', 'next 7 days', where((d) => d >= '2026-11-11' && d <= '2026-11-18')],
  ['1 dag', '1 day', where((d) => d >= '2026-11-11' && d <= '2026-11-12')],
  ['-7 dagen', '-7 days', where((d) => d >= '2026-11-04' && d <= '2026-11-11')],
  ['deze week', 'this week', where((d) => d >= '2026-11-09' && d <= '2026-11-15')],
  ['volgende week', 'next week', where((d) => d >= '2026-11-16' && d <= '2026-11-22')],
  ['vorige week', 'last week', where((d) => d >= '2026-11-02' && d <= '2026-11-08')],
  ['heeft tijd', 'has time', ['todayLater', 'todayPast']],
  ['terugkerend', 'recurring', ['rec']],
];

for (const [nl, en, expected] of DATE_CASES) {
  test(`datum: "${nl}" en "${en}"`, () => {
    assert.deepEqual(hits(nl, DATES), expected, nl);
    assert.deepEqual(hits(en, DATES), expected, en);
    assert.ok(expected.length > 0);
  });
}

test('datum: hoofdletters, spaties en accenten in de termen maken niet uit', () => {
  assert.deepEqual(hits('  VANDAAG ', DATES), TODAY_IDS);
  assert.deepEqual(hits('Te   Laat', DATES), hits('te laat', DATES));
  assert.deepEqual(hits('Today', DATES), TODAY_IDS);
});

test('datum: te laat telt het tijdstip, en een afgevinkte taak is nooit te laat', () => {
  const at = (hhmm) => [T('x', { due: D(`2026-11-11T${hhmm}`) })];
  const overdue = (hhmm) => hits('te laat', at(hhmm)).length === 1;
  assert.equal(overdue('08:59'), true);
  assert.equal(overdue('09:00'), false); // precies nu is nog niet te laat
  assert.equal(overdue('09:01'), false);
  assert.equal(hits('te laat', [T('y', { due: D('2026-11-10'), checked: true })]).length, 0);
  assert.equal(hits('te laat', [T('z', { due: D('2026-11-11') })]).length, 0); // vandaag zonder tijd: pas morgen te laat
});

test('datum: geen tijd is het omgekeerde van heeft tijd', () => {
  assert.deepEqual(hits('geen tijd', DATES), where(() => true).filter((id) => !['todayLater', 'todayPast'].includes(id)));
  assert.deepEqual(hits('no time', DATES), hits('geen tijd', DATES));
});

test('datum: een datum als tekst, in alle vormen', () => {
  const dec31 = ['dec31'];
  for (const q of ['31-12', '31/12', '31.12', '31-12-2026', '31/12/2026', '2026-12-31', '2026-12-31', '31 december', '31 dec', '31 DECEMBER 2026', 'december 31', 'dec 31', 'December 31 2026', '31dec', '31-dec', '  31   december  ']) {
    assert.deepEqual(hits(q, DATES), dec31, q);
  }
  assert.deepEqual(hits('31-12-2027', DATES), ['dec31next']);
  assert.deepEqual(hits('2027-12-31', DATES), ['dec31next']);
  assert.deepEqual(hits('1 jan 2026', DATES), ['jan1']);
  // een datum zonder jaar is die dag in het jaar van vandaag, ook als die al voorbij is
  assert.deepEqual(hits('1-1', DATES), ['jan1']);
  assert.deepEqual(hits('1 januari', DATES), ['jan1']);
  assert.deepEqual(hits('29-2-2028', DATES), ['leap']);
  assert.equal(error('29-2').code, 'invalid_date', '2026 heeft geen 29 februari');
  assert.deepEqual(hits('11-11', DATES), TODAY_IDS);
  assert.deepEqual(hits('10-11', DATES), ['yesterday']);
  // zomertijd/wintertijd: een datum is een dag, geen tijdstip
  assert.deepEqual(hits('11 nov', DATES), TODAY_IDS);
  assert.deepEqual(hits('11 mrt 2027', DATES), []);
});

test('datum: wat de Nederlandse datumherkenner kent werkt ook (donderdag, overmorgen, eind januari)', () => {
  assert.deepEqual(hits('donderdag', DATES), ['tomorrow']);
  assert.deepEqual(hits('overmorgen', DATES), ['rec']);
  assert.deepEqual(hits('volgende week donderdag', DATES), ['d8']);
  assert.deepEqual(hits('vóór: donderdag', DATES), where((d) => d < '2026-11-12'));
});

test('vóór: en na: vergelijken op dag, zonder tijdstip', () => {
  for (const [nl, en] of [['vóór', 'before'], ['voor', 'before'], ['VÓÓR', 'Before']]) {
    assert.deepEqual(hits(`${nl}: 31-12`, DATES), where((d) => d < '2026-12-31'), nl);
    assert.deepEqual(hits(`${en}: 2026-12-31`, DATES), where((d) => d < '2026-12-31'), en);
    assert.deepEqual(hits(`${nl}:31-12`, DATES), where((d) => d < '2026-12-31'), 'zonder spatie');
    assert.deepEqual(hits(`${nl} : 31-12`, DATES), where((d) => d < '2026-12-31'), 'spatie voor de dubbele punt');
  }
  for (const word of ['na', 'after', 'NA']) assert.deepEqual(hits(`${word}: 31-12`, DATES), where((d) => d > '2026-12-31'), word);
  // vandaag zelf valt er niet onder, ongeacht het tijdstip van de taak (09:00 nu, taken om 08:00 en 15:00)
  assert.deepEqual(hits('vóór: vandaag', DATES), where((d) => d < '2026-11-11'));
  assert.deepEqual(hits('na: vandaag', DATES), where((d) => d > '2026-11-11'));
  assert.deepEqual(hits('before: today', DATES), hits('vóór: vandaag', DATES));
  assert.deepEqual(hits('after: tomorrow', DATES), where((d) => d > '2026-11-12'));
  assert.deepEqual(hits('na: gisteren', DATES), where((d) => d > '2026-11-10'));
  // taken zonder datum vallen er nooit onder
  assert.ok(!hits('vóór: 31-12', DATES).includes('nodate'));
  assert.ok(!hits('na: 31-12', DATES).includes('nodate'));
  // een bereik: na én voor
  assert.deepEqual(hits('na: 10-11 & vóór: 13-11', DATES), ['today', 'todayLater', 'todayPast', 'tomorrow']);
});

test('datum: elk aantal dagen telt, ook nul en de randen', () => {
  assert.deepEqual(hits('0 dagen', DATES), TODAY_IDS);
  assert.deepEqual(hits('-0 dagen', DATES), TODAY_IDS);
  assert.deepEqual(hits('volgende 365 dagen', DATES), where((d) => d >= '2026-11-11' && d <= '2027-11-11'));
  assert.deepEqual(hits('-1 dag', DATES), ['today', 'todayLater', 'todayPast', 'yesterday']);
});

// ---------- eigenschappen ----------

const PROPS = [
  T('pr1', { priority: 1 }), T('pr2', { priority: 2 }), T('pr3', { priority: 3 }), T('pr4', { priority: 4 }), T('pr-none', { priority: undefined }),
  T('lab', { labels: ['l-bellen'] }), T('lab2', { labels: ['l-bellen', 'l-zoe'] }), T('labF', { labels: ['l-extern'] }),
  T('inTuin', { project_id: 'p-tuin' }), T('inSchuur', { project_id: 'p-schuur' }), T('inWerk', { project_id: 'p-werk' }),
  T('inCafe', { project_id: 'p-cafe' }), T('inInbox', { project_id: 'inbox-u-anna' }), T('inOud', { project_id: 'p-oud' }),
  T('secK', { section_id: 's-keuken' }), T('secB', { section_id: 's-bad' }), T('secKW', { project_id: 'p-werk', section_id: 's-keuken-w' }),
  T('sub', { parent_id: 'pr1', priority: 1 }),
  T('dl', { deadline: '2026-12-01' }),
  T('asMe', { assignee_id: 'u-anna' }), T('asBram', { assignee_id: 'u-bram' }), T('asBram2', { assignee_id: 'u-bram2' }),
];
const propIds = PROPS.map((t) => t.id);
const except = (...ids) => propIds.filter((id) => !ids.includes(id)).sort();

test('prioriteit: p1 tot en met p4, ook in hoofdletters; p4 is de standaard', () => {
  assert.deepEqual(hits('p1', PROPS), ['pr1', 'sub']);
  assert.deepEqual(hits('P2', PROPS), ['pr2']);
  assert.deepEqual(hits('p3', PROPS), ['pr3']);
  assert.deepEqual(hits('p4', PROPS), except('pr1', 'pr2', 'pr3', 'sub'));
  assert.ok(hits('p4', PROPS).includes('pr-none'));
});

test('labels: @label, ook van een ander, hoofdletters en ontleedde accenten', () => {
  assert.deepEqual(hits('@bellen', PROPS), ['lab', 'lab2']);
  assert.deepEqual(hits('@BELLEN', PROPS), ['lab', 'lab2']);
  assert.deepEqual(hits('@Zoë', PROPS), ['lab2']);
  assert.deepEqual(hits('@ZOË', PROPS), ['lab2']);
  assert.deepEqual(hits('@Zoe\u0308', PROPS), ['lab2'], 'ontleed getypt');
  assert.deepEqual(hits('@zoe', PROPS), ['lab2'], 'zonder accent, als er geen label met exact die naam is');
  assert.deepEqual(hits('@extern', PROPS), ['labF']);
  assert.deepEqual(hits('@bellen & @zoë', PROPS), ['lab2']);
  assert.deepEqual(hits('@bellen | @extern', PROPS), ['lab', 'lab2', 'labF']);
});

test('labels: zonder label / no labels', () => {
  const withLabel = ['lab', 'lab2', 'labF'];
  for (const q of ['zonder label', 'no labels', 'zonder labels', 'geen label', 'no label']) assert.deepEqual(hits(q, PROPS), except(...withLabel), q);
  assert.deepEqual(hits('zonder label', [T('x', { labels: undefined })]), ['x']);
});

test('projecten: #project, ##project met subprojecten, namen met spaties en tekens', () => {
  assert.deepEqual(hits('#Tuin', PROPS), ['inTuin']);
  assert.deepEqual(hits('##Tuin', PROPS), ['inSchuur', 'inTuin']);
  assert.deepEqual(hits('## Tuin', PROPS), ['inSchuur', 'inTuin'], 'spatie na de ##');
  assert.deepEqual(hits('#Schuur', PROPS), ['inSchuur']);
  assert.deepEqual(hits('#thuis', PROPS), except('inTuin', 'inSchuur', 'inWerk', 'secKW', 'inCafe', 'inInbox', 'inOud'));
  assert.deepEqual(hits('##thuis', PROPS), except('inWerk', 'secKW', 'inCafe', 'inInbox', 'inOud'));
  assert.deepEqual(hits('#inbox', PROPS), ['inInbox']);
  assert.deepEqual(hits('"#Werk & privé"', PROPS), ['inWerk', 'secKW']);
  assert.deepEqual(hits('#"Werk & privé"', PROPS), ['inWerk', 'secKW']);
  assert.deepEqual(hits('#Werk \\& privé', PROPS), ['inWerk', 'secKW']);
  assert.deepEqual(hits('#Tuin | #Schuur', PROPS), ['inSchuur', 'inTuin']);
});

test('projecten: Café in elke schrijfwijze', () => {
  for (const q of ['#Café', '#CAFÉ', '#café', '#Cafe\u0301', '#CAFE\u0301', '#cafe', '#CAFE', '#Cafè', '#CAFÈ']) assert.deepEqual(hits(q, PROPS), ['inCafe'], q);
});

test('projecten: bij twee projecten met dezelfde naam tellen beide', () => {
  const two = [T('a', { project_id: 'p-tuin' }), T('b', { project_id: 'p-tuin2' })];
  const view = world(two, { extra: (v) => v.projects.set('p-tuin2', { id: 'p-tuin2', name: 'tuin', order_key: 'x' }) });
  const c = compiled('#Tuin', view);
  assert.deepEqual(two.filter((t) => c.match(t)).map((t) => t.id), ['a', 'b']);
});

test('secties: /sectie in elk project, op naam', () => {
  assert.deepEqual(hits('/Keuken', PROPS), ['secK', 'secKW']);
  assert.deepEqual(hits('/badkamer', PROPS), ['secB']);
  assert.deepEqual(hits('#Thuis & /Keuken', PROPS), ['secK']);
  assert.deepEqual(hits('/Keuken & !#Thuis', PROPS), ['secKW']);
});

test('subtaak / subtask, en het omgekeerde', () => {
  assert.deepEqual(hits('subtaak', PROPS), ['sub']);
  assert.deepEqual(hits('subtask', PROPS), ['sub']);
  assert.deepEqual(hits('!subtaak', PROPS), except('sub'));
});

test('deadline, heeft deadline en geen deadline', () => {
  for (const q of ['deadline', 'heeft deadline', 'has deadline']) assert.deepEqual(hits(q, PROPS), ['dl'], q);
  for (const q of ['geen deadline', 'no deadline']) assert.deepEqual(hits(q, PROPS), except('dl'), q);
});

test('alles / all', () => {
  assert.deepEqual(hits('alles', PROPS), propIds.slice().sort());
  assert.deepEqual(hits('all', PROPS), propIds.slice().sort());
});

// ---------- toewijzing ----------

test('toegewezen: aan mij, aan anderen, niet toegewezen, aan een naam', () => {
  for (const q of ['toegewezen aan mij', 'toegewezen aan: mij', 'assigned to: me', 'assigned to me', 'Toegewezen aan: MIJ']) assert.deepEqual(hits(q, PROPS), ['asMe'], q);
  for (const q of ['toegewezen aan anderen', 'toegewezen aan: anderen', 'assigned to others', 'assigned to: others']) assert.deepEqual(hits(q, PROPS), ['asBram', 'asBram2'], q);
  for (const q of ['niet toegewezen', 'unassigned']) assert.deepEqual(hits(q, PROPS), except('asMe', 'asBram', 'asBram2'), q);
  for (const q of ['toegewezen', 'assigned']) assert.deepEqual(hits(q, PROPS), ['asBram', 'asBram2', 'asMe'], q);
  assert.deepEqual(hits('toegewezen aan: Anna', PROPS), ['asMe'], 'voornaam');
  assert.deepEqual(hits('toegewezen aan: Bram Jansen', PROPS), ['asBram'], 'volledige naam');
  assert.deepEqual(hits('assigned to: BRAM JANSEN', PROPS), ['asBram']);
  assert.deepEqual(hits('toegewezen aan: Bram', PROPS), ['asBram', 'asBram2'], 'voornaam die twee keer voorkomt');
  assert.deepEqual(hits('toegewezen aan: bramk', PROPS), ['asBram2'], 'gebruikersnaam');
  assert.deepEqual(hits('assigned to: Bram Kohler', PROPS), ['asBram2'], 'zonder accent');
  assert.deepEqual(hits('toegewezen aan mij | toegewezen aan: bram jansen', PROPS), ['asBram', 'asMe']);
});

test('toegewezen aan mij hoort bij de ingelogde gebruiker, niet bij een naam', () => {
  const tasks = [T('a', { assignee_id: 'u-bram' }), T('b', { assignee_id: 'u-anna' })];
  const as = (userId) => {
    const c = compileFilter('toegewezen aan mij', { view: world(tasks), now: NOW, userId, users: USERS });
    assert.equal(c.ok, true);
    return tasks.filter((t) => c.match(t)).map((t) => t.id);
  };
  assert.deepEqual(as('u-bram'), ['a']);
  assert.deepEqual(as('u-anna'), ['b']);
});

// ---------- herinneringen ----------

test('herinneringen: alleen die van de ingelogde gebruiker, en alleen als ze kunnen afgaan', () => {
  const tasks = [
    T('timed', { due: D('2026-11-12T10:00') }), // eigen relatieve herinnering
    T('other', { due: D('2026-11-12T10:00') }), // alleen een herinnering van een ander
    T('noTime', { due: D('2026-11-12') }), // relatief, maar de taak heeft geen tijd: gaat niet af
    T('absolute', { due: D('2026-11-12') }), // eigen vaste tijdstip
    T('legacy', { due: D('2026-11-12T10:00') }), // herinnering zonder eigenaar telt mee
    T('done', { due: D('2026-11-12T10:00'), checked: true }),
    T('none', { due: D('2026-11-12T10:00') }),
    T('both', { due: D('2026-11-12T10:00') }),
  ];
  const R = (id, task_id, o) => ({ id, task_id, type: 'relative', minute_offset: 30, owner_id: ME, ...o });
  const reminders = [
    R('r1', 'timed'), R('r2', 'other', { owner_id: 'u-bram' }), R('r3', 'noTime'),
    R('r4', 'absolute', { type: 'absolute', minute_offset: null, due: { date: '2026-11-11T20:00' } }),
    R('r5', 'legacy', { owner_id: null }), R('r6', 'done'), R('r7', 'both', { owner_id: 'u-bram' }), R('r8', 'both'),
  ];
  for (const q of ['heeft herinnering', 'has reminder']) assert.deepEqual(hits(q, tasks, { reminders }), ['absolute', 'both', 'legacy', 'timed'], q);
  for (const q of ['geen herinnering', 'no reminder']) assert.deepEqual(hits(q, tasks, { reminders }), ['done', 'noTime', 'none', 'other'], q);
  // als de ander kijkt, is het omgekeerd
  const asBram = compileFilter('heeft herinnering', { view: world(tasks, { reminders }), now: NOW, userId: 'u-bram', users: USERS });
  assert.deepEqual(tasks.filter((t) => asBram.match(t)).map((t) => t.id).sort(), ['both', 'legacy', 'other']);
});

test('herinneringen: stemt overeen met het belletje uit selectors.hasReminder', () => {
  const rnd = rng(7);
  const tasks = [];
  const reminders = [];
  for (let i = 0; i < 200; i++) {
    const time = rnd() < 0.5;
    tasks.push(T(`t${i}`, { due: rnd() < 0.8 ? D(time ? '2026-11-12T10:00' : '2026-11-12') : null, checked: rnd() < 0.2 }));
    for (let k = 0; k < Math.floor(rnd() * 3); k++) {
      const abs = rnd() < 0.3;
      reminders.push({
        id: `r${i}-${k}`, task_id: `t${i}`, type: abs ? 'absolute' : 'relative', minute_offset: abs ? null : 15, due: abs ? D(rnd() < 0.5 ? '2026-11-12T08:00' : '2026-11-12') : null,
        owner_id: [ME, 'u-bram', null][Math.floor(rnd() * 3)],
      });
    }
  }
  const view = world(tasks, { reminders });
  const c = compiled('heeft herinnering', view);
  let positives = 0;
  for (const t of tasks) {
    assert.equal(c.match(t), hasReminder(view, t.id, ME), t.id);
    if (c.match(t)) positives++;
  }
  assert.ok(positives > 20 && positives < 180, `de vergelijking moet beide kanten op testen (${positives})`);
});

// ---------- zoeken in tekst ----------

test('zoek: titel en beschrijving, alle woorden, zonder letter- en accentgevoeligheid', () => {
  const tasks = [
    T('cafe', { content: 'Café bezoeken' }), T('CAFE', { content: 'CAFÉ DICHTBIJ' }), T('nfd', { content: 'Cafe\u0301 met Jan' }),
    T('plain', { content: 'Naar het cafe' }), T('desc', { content: 'Iets', description: 'in het café om 8 uur' }),
    T('melk', { content: 'Melk halen', description: 'verse melk' }), T('halen', { content: 'Brood halen' }), T('nope', { content: 'Tuin' }),
  ];
  for (const q of ['zoek: café', 'zoek: CAFÉ', 'zoek: cafe', 'zoek: Cafe\u0301', 'search: café', 'zoeken: café', 'ZOEK:café', 'zoek : café']) {
    assert.deepEqual(hits(q, tasks), ['CAFE', 'cafe', 'desc', 'nfd', 'plain'], q);
  }
  assert.deepEqual(hits('zoek: halen melk', tasks), ['melk'], 'woorden in willekeurige volgorde');
  assert.deepEqual(hits('zoek: verse', tasks), ['melk'], 'beschrijving');
  assert.deepEqual(hits('zoek:   MELK   halen ', tasks), ['melk']);
  assert.deepEqual(hits('zoek: halen', tasks), ['halen', 'melk']);
  assert.deepEqual(hits('zoek: melk brood', tasks), [], 'alle woorden moeten voorkomen, in één taak');
  assert.deepEqual(hits('zoek: tuin & !zoek: iets', tasks), ['nope']);
});

test('zoek: tekens van de filtertaal in de tekst met aanhalingstekens of backslash', () => {
  const tasks = [T('a', { content: 'Jan & Piet' }), T('b', { content: 'wow! (echt)' }), T('c', { content: 'a, b' })];
  assert.deepEqual(hits('zoek: "Jan & Piet"', tasks), ['a']);
  assert.deepEqual(hits('zoek: Jan \\& Piet', tasks), ['a']);
  assert.deepEqual(hits('zoek: wow!', tasks), ['b'], 'een uitroepteken in een zoektekst is gewoon een teken');
  for (const word of ['zoeken', 'search', 'ZOEK']) assert.deepEqual(hits(`${word}: wow!`, tasks), ['b'], word);
  assert.deepEqual(hits('zoek: "(echt)"', tasks), ['b']);
  assert.deepEqual(hits('zoek: "a, b"', tasks), ['c']);
  assert.deepEqual(hits('zoek: wow! & !zoek: jan', tasks), ['b']);
});

test('zoek: zoekt niet in labelnamen of projectnamen (dat doet het zoekveld)', () => {
  assert.deepEqual(hits('zoek: bellen', [T('a', { labels: ['l-bellen'] })]), []);
});

// ---------- operatoren en voorrang ----------

test('operatoren: & is en, | is of, ! is niet, haakjes groeperen', () => {
  const tasks = [
    T('a', { priority: 1, due: D('2026-11-11') }), T('b', { priority: 1 }), T('c', { priority: 2, due: D('2026-11-11') }),
    T('d', { priority: 2, labels: ['l-bellen'] }), T('e', { priority: 1, labels: ['l-bellen'], due: D('2026-11-11') }),
  ];
  assert.deepEqual(hits('p1 & vandaag', tasks), ['a', 'e']);
  assert.deepEqual(hits('p1 | vandaag', tasks), ['a', 'b', 'c', 'e']);
  assert.deepEqual(hits('!p1', tasks), ['c', 'd']);
  assert.deepEqual(hits('!!p1', tasks), ['a', 'b', 'e']);
  assert.deepEqual(hits('!!!p1', tasks), ['c', 'd']);
  assert.deepEqual(hits('! p1', tasks), ['c', 'd']);
  assert.deepEqual(hits('p1 & !vandaag', tasks), ['b']);
  assert.deepEqual(hits('!(p1 | vandaag)', tasks), ['d']);
  assert.deepEqual(hits('!(p1 & vandaag)', tasks), ['b', 'c', 'd']);
  // voorrang: & gaat voor |
  assert.deepEqual(hits('p2 | p1 & vandaag', tasks), ['a', 'c', 'd', 'e']);
  assert.deepEqual(hits('p1 & vandaag | p2', tasks), ['a', 'c', 'd', 'e']);
  assert.deepEqual(hits('(p2 | p1) & vandaag', tasks), ['a', 'c', 'e']);
  assert.deepEqual(hits('p1 & (vandaag | @bellen)', tasks), ['a', 'e']);
  assert.deepEqual(hits('@bellen | p1 & !vandaag', tasks), ['b', 'd', 'e']);
  // ! gaat voor &
  assert.deepEqual(hits('!p1 & vandaag', tasks), ['c']);
  assert.deepEqual(hits('((p1)) & ((vandaag))', tasks), ['a', 'e']);
  assert.deepEqual(hits('  (  p1  )&(vandaag)  ', tasks), ['a', 'e']);
  assert.deepEqual(hits('p1&vandaag', tasks), ['a', 'e']);
  assert.deepEqual(hits('p1|p2', tasks), ['a', 'b', 'c', 'd', 'e']);
});

test('operatoren: een uitroepteken midden in een term is geen "niet"', () => {
  assert.equal(error('vandaag !p1').code, 'expected_operator');
});

// Willekeurige uitdrukkingen: de leesbare vorm (met zo min mogelijk haakjes, op de voorrang vertrouwend) en de volledig
// tussen haakjes gezette vorm geven dezelfde uitkomst als het rechtstreeks uitrekenen van de boom.
test('operatoren: willekeurige uitdrukkingen kloppen met rechtstreeks uitrekenen (voorrang)', () => {
  const rnd = rng(42);
  const tasks = [];
  for (let i = 0; i < 40; i++) {
    tasks.push(T(`t${i}`, {
      priority: 1 + Math.floor(rnd() * 4), labels: rnd() < 0.5 ? ['l-bellen'] : [], due: rnd() < 0.5 ? D(rnd() < 0.5 ? '2026-11-11' : '2026-11-12') : null,
      project_id: rnd() < 0.5 ? 'p-thuis' : 'p-tuin',
    }));
  }
  const view = world(tasks);
  const atoms = ['p1', 'p2', '@bellen', 'vandaag', 'morgen', '#Tuin', 'geen datum'].map((q) => ({ q, m: compiled(q, view).match }));
  const gen = (depth) => {
    const r = rnd();
    if (depth === 0 || r < 0.3) return { t: 'atom', a: atoms[Math.floor(rnd() * atoms.length)] };
    if (r < 0.45) return { t: 'not', x: gen(depth - 1) };
    return { t: rnd() < 0.5 ? 'and' : 'or', l: gen(depth - 1), r: gen(depth - 1) };
  };
  const ev = (n, task) => (n.t === 'atom' ? n.a.m(task) : n.t === 'not' ? !ev(n.x, task) : n.t === 'and' ? ev(n.l, task) && ev(n.r, task) : ev(n.l, task) || ev(n.r, task));
  const PREC = { or: 1, and: 2, not: 3, atom: 4 };
  const minimal = (n, min = 0) => {
    let s;
    if (n.t === 'atom') s = n.a.q;
    else if (n.t === 'not') s = `!${minimal(n.x, 3)}`;
    else if (n.t === 'and') s = `${minimal(n.l, 2)} & ${minimal(n.r, 2)}`;
    else s = `${minimal(n.l, 1)} | ${minimal(n.r, 1)}`;
    return PREC[n.t] < min ? `(${s})` : s;
  };
  const full = (n) => (n.t === 'atom' ? n.a.q : n.t === 'not' ? `!(${full(n.x)})` : `(${full(n.l)} ${n.t === 'and' ? '&' : '|'} ${full(n.r)})`);
  let nonTrivial = 0;
  for (let i = 0; i < 300; i++) {
    const tree = gen(4);
    const expected = tasks.filter((t) => ev(tree, t)).map((t) => t.id);
    for (const text of [minimal(tree), full(tree)]) {
      const c = compiled(text, view);
      assert.deepEqual(tasks.filter((t) => c.match(t)).map((t) => t.id), expected, text);
    }
    if (expected.length > 0 && expected.length < tasks.length) nonTrivial++;
  }
  assert.ok(nonTrivial > 150, `genoeg uitdrukkingen die iets onderscheiden (${nonTrivial})`);
});

// ---------- lijsten met komma's ----------

test('komma: aparte lijsten, elk met een naam', () => {
  const tasks = [T('a', { due: D('2026-11-10') }), T('b', { due: D('2026-11-11') }), T('c', { due: D('2026-11-11'), priority: 1 }), T('d')];
  const view = world(tasks);
  const c = compiled('te laat, vandaag & !p1, Rest: geen datum', view);
  assert.deepEqual(c.groups.map((g) => g.name), ['te laat', 'vandaag & !p1', 'Rest']);
  assert.deepEqual(c.groups.map((g) => tasks.filter((t) => g.match(t)).map((t) => t.id)), [['a'], ['b'], ['d']]);
  assert.deepEqual(tasks.filter((t) => c.match(t)).map((t) => t.id), ['a', 'b', 'd'], 'match = alle lijsten samen');
  const r = evaluateFilter('te laat, vandaag & !p1, Rest: geen datum', ctxOf(view));
  assert.deepEqual(r.groups.map((g) => [g.name, g.tasks.map((t) => t.id)]), [['te laat', ['a']], ['vandaag & !p1', ['b']], ['Rest', ['d']]]);
  assert.deepEqual(r.tasks.map((t) => t.id), ['a', 'b', 'd'], 'samen, op volgorde');
});

test('komma: een taak in twee lijsten staat in beide, maar één keer in het geheel', () => {
  const tasks = [T('a', { due: D('2026-11-11'), priority: 1 }), T('b', { due: D('2026-11-11') })];
  const r = evaluateFilter('vandaag, p1', ctxOf(world(tasks)));
  assert.deepEqual(r.groups.map((g) => g.tasks.map((t) => t.id)), [['a', 'b'], ['a']]);
  assert.deepEqual(r.tasks.map((t) => t.id), ['a', 'b']);
});

test('komma: een naam met een dubbele punt, behalve bij zoek:, vóór: en dergelijke', () => {
  const view = world([]);
  assert.deepEqual(compiled('Mijn werk: #Thuis & p1', view).groups.map((g) => g.name), ['Mijn werk']);
  assert.deepEqual(compiled('Werk: (p1 | p2), Thuis: #Tuin', view).groups.map((g) => g.name), ['Werk', 'Thuis']);
  assert.deepEqual(compiled('zoek: a, vóór: 31-12, na: 31-12, toegewezen aan: Anna, before: 1-1, search: b', view).groups.map((g) => g.name),
    ['zoek: a', 'vóór: 31-12', 'na: 31-12', 'toegewezen aan: Anna', 'before: 1-1', 'search: b']);
  assert.deepEqual(compiled('  p1 ,  p2  ', view).groups.map((g) => g.name), ['p1', 'p2']);
  assert.equal(compiled('p1', view).groups.length, 1);
});

test('komma: in aanhalingstekens en na een backslash is het een gewoon teken', () => {
  const tasks = [T('a', { content: 'x, y' })];
  assert.equal(compiled('zoek: "x, y"', world(tasks)).groups.length, 1);
  assert.equal(compiled('zoek: x\\, y', world(tasks)).groups.length, 1);
  assert.deepEqual(hits('zoek: x\\, y', tasks), ['a']);
});

// ---------- afgevinkt ----------

test('afgevinkt: evaluateFilter laat alleen open taken zien, tenzij de tekst afgevinkt/completed bevat', () => {
  const tasks = [T('open', { due: D('2026-11-11') }), T('done', { due: D('2026-11-11'), checked: true }), T('doneOther', { checked: true })];
  const view = world(tasks);
  const ids = (q) => evaluateFilter(q, ctxOf(view)).tasks.map((t) => t.id);
  assert.deepEqual(ids('vandaag'), ['open']);
  assert.deepEqual(ids('alles'), ['open']);
  assert.deepEqual(ids('vandaag | afgevinkt'), ['open', 'done', 'doneOther'], 'op datum; zonder datum achteraan');
  assert.deepEqual(ids('vandaag | completed'), ['open', 'done', 'doneOther']);
  assert.deepEqual(ids('afgevinkt'), ['done', 'doneOther']);
  assert.deepEqual(ids('afgevinkt & vandaag'), ['done']);
  assert.deepEqual(ids('vandaag & !afgevinkt'), ['open']);
  assert.equal(compiled('vandaag', view).includesCompleted, false);
  assert.equal(compiled('vandaag | completed', view).includesCompleted, true);
  assert.equal(compiled('!afgevinkt', view).includesCompleted, true);
});

// ---------- evaluateFilter ----------

test('evaluateFilter: gesorteerd op datum, tijdstip, prioriteit en volgorde; zonder datum achteraan', () => {
  const tasks = [
    T('nodate-p4'), T('nodate-p1', { priority: 1 }),
    T('later', { due: D('2026-11-12') }),
    T('today-p3', { due: D('2026-11-11'), priority: 3 }), T('today-p1', { due: D('2026-11-11'), priority: 1 }),
    T('today-p3-b', { due: D('2026-11-11'), priority: 3 }),
    T('today-9', { due: D('2026-11-11T09:00') }), T('today-8', { due: D('2026-11-11T08:00') }),
    T('old', { due: D('2026-10-01') }),
  ];
  const r = evaluateFilter('alles', ctxOf(world(tasks)));
  assert.deepEqual(r.tasks.map((t) => t.id), ['old', 'today-p1', 'today-p3', 'today-p3-b', 'today-8', 'today-9', 'later', 'nodate-p1', 'nodate-p4']);
});

test('evaluateFilter: gelijke datum en prioriteit in verschillende projecten volgen de volgorde van de projecten', () => {
  const tasks = [T('w', { project_id: 'p-werk', order_key: 'a' }), T('c', { project_id: 'p-cafe', order_key: 'a' }), T('t', { project_id: 'p-thuis', order_key: 'a' }), T('t2', { project_id: 'p-thuis', order_key: 'a0' })];
  assert.deepEqual(evaluateFilter('alles', ctxOf(world(tasks))).tasks.map((t) => t.id), ['t', 't2', 'w', 'c']);
});

test('evaluateFilter: taken in een gearchiveerd project doen niet mee, een verwijderde taak ook niet', () => {
  const tasks = [T('a', { project_id: 'p-oud' }), T('b'), T('c', { is_deleted: true })];
  assert.deepEqual(evaluateFilter('alles', ctxOf(world(tasks))).tasks.map((t) => t.id), ['b']);
});

test('evaluateFilter: geeft de fout van compileFilter door', () => {
  const r = evaluateFilter('p1 &', ctxOf(world([])));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'empty_term');
});

test('evaluateFilter: zonder taken of zonder toestand een lege lijst, geen fout', () => {
  assert.deepEqual(evaluateFilter('p1', ctxOf(world([]))).tasks, []);
  assert.deepEqual(evaluateFilter('p1', { now: NOW }).tasks, []);
  assert.equal(compileFilter('p1').ok, true);
  assert.equal(compileFilter('#Thuis').ok, false, 'zonder toestand bestaat het project niet');
});

// ---------- fouten ----------

const ERRORS = [
  // [tekst, code, positie, lengte]
  ['', 'empty_query', 0],
  ['   ', 'empty_query', 0],
  ['foo', 'unknown_term', 0, 3],
  ['p1 & foo', 'unknown_term', 5, 3],
  ['p1 & foo bar', 'unknown_term', 5, 7],
  ['  vandaagg', 'unknown_term', 2, 8],
  ['p5', 'unknown_term', 0, 2],
  ['p0', 'unknown_term', 0, 2],
  ['vandaag &', 'empty_term', 8],
  ['& vandaag', 'empty_term', 0],
  ['vandaag | | p1', 'empty_term', 10],
  ['(vandaag &)', 'empty_term', 10],
  ['()', 'empty_term', 1],
  ['!', 'empty_term', 0],
  ['p1 & !', 'empty_term', 5],
  ['p1,', 'empty_term', 2],
  [',p1', 'empty_term', 0],
  ['p1,,p2', 'empty_term', 3],
  ['Werk:', 'empty_term', 4],
  ['""', 'empty_term', 0],
  ['zoek:', 'empty_term', 0],
  ['zoek:    ', 'empty_term', 0],
  ['(vandaag', 'unclosed_paren', 0],
  ['p1 & (vandaag | (p2)', 'unclosed_paren', 5],
  ['((p1)', 'unclosed_paren', 0],
  ['vandaag)', 'unexpected_paren', 7],
  [')', 'empty_term', 0],
  ['p1 & (p2))', 'unexpected_paren', 9],
  ['"abc', 'unclosed_quote', 0],
  ['p1 & zoek: "abc', 'unclosed_quote', 11],
  ['p1 p2', 'expected_operator', 3, 2],
  ['vandaag morgen', 'expected_operator', 8, 6],
  ['p1 & vandaag morgen', 'expected_operator', 13, 6],
  ['(p1) (p2)', 'expected_operator', 5],
  ['(p1 p2)', 'expected_operator', 4, 2],
  ['p1 !p2', 'expected_operator', 3],
  ['p1 #Thuis', 'expected_operator', 3, 6],
  ['(p1, p2)', 'comma_in_parens', 3],
  ['#', 'empty_name', 0],
  ['##', 'empty_name', 0],
  ['@', 'empty_name', 0],
  ['/', 'empty_name', 0],
  ['p1 & #  ', 'empty_name', 5],
  ['#Bestaatniet', 'unknown_project', 0, 12],
  ['p1 & ##Bestaatniet', 'unknown_project', 5],
  ['@bestaatniet', 'unknown_label', 0],
  ['/Bestaatniet', 'unknown_section', 0],
  ['toegewezen aan: Niemand', 'unknown_user', 0],
  ['assigned to: nobody', 'unknown_user', 0],
  ['31-02', 'invalid_date', 0, 5],
  ['32-12', 'invalid_date', 0],
  ['5-13', 'invalid_date', 0],
  ['2026-02-30', 'invalid_date', 0],
  ['30 februari', 'invalid_date', 0],
  ['29-02-2027', 'invalid_date', 0],
  ['p1 & vóór: 31-02', 'invalid_date', 5],
  ['vóór:', 'invalid_date', 0],
  ['na: onzin', 'invalid_date', 0],
  ['before: ', 'invalid_date', 0],
  ['9999999 dagen', 'bad_number', 0],
  ['37000 days', 'bad_number', 0],
  ['-99999 dagen', 'bad_number', 0],
];

for (const [query, code, position, length] of ERRORS) {
  test(`fout: ${JSON.stringify(query)} geeft ${code} op positie ${position}`, () => {
    const e = error(query);
    assert.equal(e.code, code);
    assert.equal(e.position, position);
    if (length !== undefined) assert.equal(e.length, length);
    assert.ok(FILTER_ERROR_CODES.includes(e.code));
    assert.equal(typeof e.message, 'string');
    assert.ok(e.message.length > 5);
    assert.ok(e.position >= 0 && e.position <= query.length);
    assert.ok(e.length >= 1);
  });
}

test('fout: de melding is Nederlands, heeft de term erin, en codes hebben een melding', () => {
  assert.equal(error('foo').message, 'Onbekende term: "foo".');
  assert.equal(error('#Nergens').message, 'Onbekend project: "Nergens".');
  assert.deepEqual(error('#Nergens').params, { name: 'Nergens' });
  assert.deepEqual(error('foo').params, { term: 'foo' });
  assert.equal(error('(p1').message, 'Dit haakje wordt niet gesloten.');
  for (const code of FILTER_ERROR_CODES) assert.equal(typeof filterErrorMessage(code, { term: 'x', name: 'x', prefix: '#', max: 5 }), 'string', code);
  assert.equal(filterErrorMessage('bestaat-niet'), filterErrorMessage('internal'));
});

test('fout: ontleed getypte tekens verschuiven de positie niet', () => {
  // "é" als e + los accent telt als twee tekens in de tekst; de positie verwijst naar de tekst zoals getypt
  const q = 'zoek: cafe\u0301 & foo';
  const e = error(q);
  assert.equal(e.code, 'unknown_term');
  assert.equal(q.slice(e.position, e.position + e.length), 'foo');
});

test('fout: zonder ingelogde gebruiker werken "mij" en "anderen" niet, de rest wel', () => {
  assert.equal(error('toegewezen aan mij', { userId: null }).code, 'no_user');
  assert.equal(error('assigned to others', { userId: null }).code, 'no_user');
  assert.equal(compileFilter('p1 & heeft herinnering', { view: world([]), now: NOW }).ok, true);
});

test('een ongeldige tijd als "nu" valt terug op de echte klok in plaats van te crashen', () => {
  const c = compileFilter('vandaag', { view: world([]), now: new Date(Number.NaN), userId: ME });
  assert.equal(c.ok, true);
  const today = todayString(new Date());
  assert.equal(c.match({ due: { date: today } }), true);
});

test('fout: te lang, te diep genest', () => {
  assert.equal(compileFilter('p1'.padEnd(2000, ' ')).ok, true, 'precies de maximale lengte mag');
  const e = error(`p1${' '.repeat(2000)}`);
  assert.equal(e.code, 'too_long');
  assert.equal(e.position, 2000);
  assert.equal(ENTITIES.filter.cols.find((c) => c.name === 'query').maxLen, 2000, 'gelijk aan wat het datamodel toestaat');
  const deep = error(`${'('.repeat(100)}p1${')'.repeat(100)}`);
  assert.equal(deep.code, 'too_deep');
  assert.equal(compileFilter(`${'('.repeat(30)}p1${')'.repeat(30)}`, ctxOf(world([]))).ok, true);
});

test('fout: geen tekst als filter (null, getal, object) is een nette fout', () => {
  for (const q of [null, undefined, 5, {}, [], true]) {
    const c = compileFilter(q, ctxOf(world([])));
    assert.equal(c.ok, false);
    assert.equal(c.error.code, 'empty_query');
  }
});

// ---------- middernacht en zomertijd ----------

/** Dezelfde dag vanaf zijn getypte onderdelen, zonder de tijdzone van de pc te gebruiken. */
const ymd = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const dayAfter = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

test('middernacht en zomertijd: dag, morgen, week en bereik kloppen op elk uur rond de overgangen', () => {
  const view = world([]);
  const periods = [[2, 1, 2, 25], [3, 1, 3, 10]]; // maart/begin april en eind september-oktober-begin november...
  const days = [];
  for (let d = new Date(Date.UTC(2026, 2, 1)); d < new Date(Date.UTC(2026, 3, 10)); d = new Date(+d + 86_400_000)) days.push(d);
  for (let d = new Date(Date.UTC(2026, 8, 20)); d < new Date(Date.UTC(2026, 10, 8)); d = new Date(+d + 86_400_000)) days.push(d);
  void periods;
  const times = [[0, 0], [0, 30], [1, 30], [2, 30], [3, 30], [12, 0], [23, 59]];
  let checked = 0;
  for (const d of days) {
    const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
    const today = ymd(y, m, dd);
    for (const [h, mi] of times) {
      const now = new Date(y, m, dd, h, mi);
      assert.equal(todayString(now), today, `de pc-klok: ${today} ${h}:${mi}`); // de dag staat vast, ook als het uur niet bestaat
      const dow = (d.getUTCDay() + 6) % 7; // maandag = 0
      const monday = dayAfter(today, -dow);
      const q = (text) => {
        const c = compileFilter(text, { view, now, userId: ME, users: USERS });
        assert.equal(c.ok, true, text);
        return (date) => c.match({ id: 'x', due: { date }, checked: false });
      };
      const isToday = q('vandaag');
      assert.deepEqual([-1, 0, 1].map((n) => isToday(dayAfter(today, n))), [false, true, false], `vandaag ${today} ${h}:${mi}`);
      assert.deepEqual([-1, 0, 1, 2].map((n) => q('morgen')(dayAfter(today, n))), [false, false, true, false]);
      assert.deepEqual([-2, -1, 0].map((n) => q('gisteren')(dayAfter(today, n))), [false, true, false]);
      const next7 = q('7 dagen');
      assert.deepEqual([-1, 0, 7, 8].map((n) => next7(dayAfter(today, n))), [false, true, true, false], `7 dagen ${today}`);
      const week = q('deze week');
      assert.deepEqual([-1, 0, 6, 7].map((n) => week(dayAfter(monday, n))), [false, true, true, false], `deze week ${today}`);
      const nextWeek = q('volgende week');
      assert.deepEqual([6, 7, 13, 14].map((n) => nextWeek(dayAfter(monday, n))), [false, true, true, false], `volgende week ${today}`);
      assert.equal(q('te laat')(dayAfter(today, -1)), true);
      assert.equal(q('te laat')(today), false);
      assert.equal(q('te laat')(`${today}T00:00`), h > 0 || mi > 0 ? true : false, `te laat om middernacht ${today} ${h}:${mi}`);
      assert.equal(q('vóór: morgen')(today), true);
      assert.equal(q('na: gisteren')(today), true);
      assert.equal(q('na: gisteren')(dayAfter(today, -1)), false);
      checked++;
    }
  }
  assert.ok(checked > 500);
});

test('middernacht: vlak voor en na het begin van een nieuwe dag, en nieuwjaar', () => {
  const tasks = [T('dec31', { due: D('2026-12-31') }), T('jan1', { due: D('2027-01-01') })];
  const asOf = (now) => {
    const c = compileFilter('vandaag', { view: world(tasks), now, userId: ME, users: USERS });
    return tasks.filter((t) => c.match(t)).map((t) => t.id);
  };
  assert.deepEqual(asOf(new Date(2026, 11, 31, 23, 59, 59)), ['dec31']);
  assert.deepEqual(asOf(new Date(2027, 0, 1, 0, 0, 0)), ['jan1']);
  const next = (now) => {
    const c = compileFilter('morgen', { view: world(tasks), now, userId: ME, users: USERS });
    return tasks.filter((t) => c.match(t)).map((t) => t.id);
  };
  assert.deepEqual(next(new Date(2026, 11, 31, 23, 59)), ['jan1']);
  // een jaar zonder jaartal: 31-12 op nieuwjaarsdag is eind dit jaar, op 31 december zelf vandaag
  assert.deepEqual(hitsAt('31-12', tasks, new Date(2027, 0, 1, 12, 0)), []);
  assert.deepEqual(hitsAt('31-12', tasks, new Date(2026, 11, 31, 23, 59)), ['dec31']);
});
function hitsAt(query, tasks, now) {
  const c = compileFilter(query, { view: world(tasks), now, userId: ME, users: USERS });
  assert.equal(c.ok, true);
  return tasks.filter((t) => c.match(t)).map((t) => t.id);
}

// ---------- willekeurige en kapotte invoer ----------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('willekeurige en kapotte invoer: altijd ok of een nette fout, nooit een crash', () => {
  const rnd = rng(2026);
  const pool = [
    'vandaag', 'morgen', 'p1', 'p2', '@bellen', '#Thuis', '##Thuis', '/Keuken', 'zoek: a', 'zoek:', '(', ')', '&', '|', '!', ',', ' ', '  ', '"', '\\',
    'te laat', 'overdue', '7 dagen', '-3 days', '31-12', '31 december', 'toegewezen aan mij', 'assigned to: bram', 'afgevinkt', 'Werk:', ':', '-',
    'é', '\u0301', '😀', '\u0000', '#', '@', '/', '##', 'vóór:', 'na:', 'before: 1-1', '9'.repeat(12), 'heeft herinnering', 'subtaak', '\n', '\t', '\ud800',
    'constructor', '__proto__', 'toString', '1 constructor', 'hasOwnProperty', 'NaN', 'Infinity',
  ];
  const view = world([T('a', { due: D('2026-11-11'), labels: ['l-bellen'] }), T('b')]);
  const ctx = ctxOf(view);
  const seen = new Set();
  let oks = 0;
  const check = (q) => {
    const c = compileFilter(q, ctx);
    if (c.ok) {
      oks++;
      assert.equal(typeof c.match(view.tasks.get('a')), 'boolean', q);
      for (const g of c.groups) assert.equal(typeof g.match(view.tasks.get('b')), 'boolean');
      const r = evaluateFilter(q, ctx);
      assert.equal(r.ok, true);
    } else {
      const e = c.error;
      seen.add(e.code);
      assert.notEqual(e.code, 'internal', JSON.stringify(q));
      assert.ok(FILTER_ERROR_CODES.includes(e.code), e.code);
      assert.ok(Number.isInteger(e.position) && e.position >= 0 && e.position <= Math.max(q.length, 1), `${JSON.stringify(q)} ${e.position}`);
      assert.ok(Number.isInteger(e.length) && e.length >= 1);
      assert.equal(typeof e.message, 'string');
      assert.equal(evaluateFilter(q, ctx).ok, false);
    }
  };
  for (let i = 0; i < 1500; i++) {
    let q = '';
    const n = 1 + Math.floor(rnd() * 12);
    for (let k = 0; k < n; k++) q += pool[Math.floor(rnd() * pool.length)] + (rnd() < 0.5 ? ' ' : '');
    check(q);
  }
  for (let i = 0; i < 700; i++) {
    let q = '';
    const n = Math.floor(rnd() * 40);
    for (let k = 0; k < n; k++) q += String.fromCharCode(Math.floor(rnd() * (rnd() < 0.5 ? 128 : 0x3000)));
    check(q);
  }
  // reuzen en gemene vormen
  const nasty = [
    '('.repeat(1999), ')'.repeat(1999), '!'.repeat(1999), `${'!'.repeat(1990)}p1`, '"'.repeat(1999), '\\'.repeat(1999), '&'.repeat(1999), ',' .repeat(1999),
    'a '.repeat(999), 'p1 & '.repeat(399), 'p1 | '.repeat(399) + 'p2', `${'(p1 & '.repeat(30)}p2${')'.repeat(30)}`, `${'(p1 | '.repeat(300)}p2`,
    'zoek: '.repeat(300), '#'.repeat(1999), '@'.repeat(1999), 'x:'.repeat(990), '9'.repeat(1999), `${'1 '.repeat(500)}dagen`, 'é'.repeat(1999), '\u0301'.repeat(1999),
  ];
  for (const q of nasty) {
    const t0 = performance.now();
    check(q);
    assert.ok(performance.now() - t0 < 1500, `${q.slice(0, 20)}… duurde te lang`);
  }
  assert.ok(oks > 50, `genoeg geldige queries (${oks})`);
  for (const code of ['unknown_term', 'empty_term', 'unclosed_paren', 'unexpected_paren', 'unclosed_quote', 'expected_operator', 'empty_name', 'unknown_project']) {
    assert.ok(seen.has(code), `de willekeurige invoer raakte ${code}`);
  }
});

test('namen die op eigenschappen van Object lijken zijn gewoon onbekend', () => {
  for (const q of ['constructor', '__proto__', '1 constructor', 'constructor 5', '#constructor', '@__proto__', 'toString']) {
    assert.equal(error(q).code.startsWith('unknown_'), true, q);
  }
});

// ---------- prestatie ----------

test('prestatie: 10.000 taken met een paar termen in redelijke tijd', (t) => {
  const rnd = rng(99);
  const v = emptyState();
  for (let p = 0; p < 40; p++) v.projects.set(`p${p}`, { id: `p${p}`, name: p === 0 ? 'Thuis' : `Project ${p}`, order_key: `k${String(p).padStart(3, '0')}`, parent_id: p > 20 ? `p${p - 20}` : null });
  for (let l = 0; l < 60; l++) v.labels.set(`l${l}`, { id: `l${l}`, name: l === 0 ? 'bellen' : `label${l}`, owner_id: ME, order_key: `k${l}` });
  const words = ['melk', 'brood', 'tandarts', 'café', 'bellen', 'tuin', 'belasting', 'fiets'];
  for (let i = 0; i < 10_000; i++) {
    const day = addDays('2026-10-01', Math.floor(rnd() * 90));
    v.tasks.set(`t${i}`, {
      id: `t${i}`, project_id: `p${Math.floor(rnd() * 40)}`, section_id: null, parent_id: null, order_key: `k${i}`, checked: rnd() < 0.1,
      content: `${words[Math.floor(rnd() * 8)]} ${words[Math.floor(rnd() * 8)]} ${i}`, description: rnd() < 0.3 ? `een beschrijving met ${words[Math.floor(rnd() * 8)]}` : '',
      priority: 1 + Math.floor(rnd() * 4), labels: rnd() < 0.5 ? [`l${Math.floor(rnd() * 60)}`] : [], due: rnd() < 0.8 ? { date: rnd() < 0.3 ? `${day}T10:00` : day } : null,
      assignee_id: rnd() < 0.2 ? 'u-bram' : null,
    });
    if (rnd() < 0.3) v.reminders.set(`r${i}`, { id: `r${i}`, task_id: `t${i}`, type: 'relative', minute_offset: 30, owner_id: ME });
  }
  const ctx = ctxOf(v);
  const queries = [
    '(vandaag | te laat | 7 dagen) & p1 & !@bellen',
    '##Thuis & zoek: melk & !toegewezen aan: bram',
    'heeft herinnering & (p1 | p2) & vóór: 31-12 & na: 1-11',
    'zoek: café brood, p1 & @bellen, te laat | afgevinkt',
  ];
  evaluateFilter(queries[0], ctx); // opwarmen
  let slowest = 0;
  for (const q of queries) {
    const t0 = performance.now();
    const r = evaluateFilter(q, ctx);
    const ms = performance.now() - t0;
    assert.equal(r.ok, true, q);
    assert.ok(r.tasks.length > 0, `${q} hoort iets te vinden`);
    slowest = Math.max(slowest, ms);
    t.diagnostic(`${ms.toFixed(1)} ms voor ${r.tasks.length} van 10000 taken: ${q}`);
  }
  assert.ok(slowest < 2000, `te traag: ${slowest.toFixed(0)} ms`);
});

// ---------- aanvullingen op de dekking ----------

test('maandnamen: elke maand, Nederlands en Engels, voluit en afgekort', () => {
  const names = [
    ['januari', 'january', 'jan'], ['februari', 'february', 'feb'], ['maart', 'march', 'mrt', 'mar'], ['april', 'apr'], ['mei', 'may'], ['juni', 'june', 'jun'],
    ['juli', 'july', 'jul'], ['augustus', 'august', 'aug'], ['september', 'sep', 'sept'], ['oktober', 'october', 'okt', 'oct'], ['november', 'nov'], ['december', 'dec'],
  ];
  names.forEach((forms, i) => {
    const day = `2026-${String(i + 1).padStart(2, '0')}-15`;
    const tasks = [T('hit', { due: D(day) }), T('other', { due: D(`2026-${String(((i + 1) % 12) + 1).padStart(2, '0')}-15`) })];
    for (const form of forms) {
      assert.deepEqual(hits(`15 ${form}`, tasks), ['hit'], `15 ${form}`);
      assert.deepEqual(hits(`${form} 15`, tasks), ['hit'], `${form} 15`);
    }
  });
});

test('datum: een herhaling is geen datum, en een tijd bij de datum telt niet mee', () => {
  assert.equal(error('elke dag').code, 'unknown_term');
  assert.equal(error('elke maandag').code, 'unknown_term');
  assert.equal(error('vóór: elke dag').code, 'invalid_date');
  assert.deepEqual(hits('morgen om 9 uur', DATES), ['tomorrow']);
  assert.deepEqual(hits('vóór: morgen om 9 uur', DATES), hits('vóór: morgen', DATES));
});

test('namen: bij twee labels met dezelfde naam (eigen en van een ander) tellen beide', () => {
  const tasks = [T('a', { labels: ['l-bellen'] }), T('b', { labels: ['l-bellen-x'] }), T('c')];
  const extra = (v) => v.labels.set('l-bellen-x', { id: 'l-bellen-x', name: 'Bellen', owner_id: 'u-bram', order_key: 'z' });
  assert.deepEqual(hits('@bellen', tasks, { extra }), ['a', 'b']);
});

test('namen: een exacte naam gaat voor een naam zonder accenten', () => {
  const tasks = [T('plain', { project_id: 'p-cafe-plain' }), T('accent', { project_id: 'p-cafe' })];
  const extra = (v) => v.projects.set('p-cafe-plain', { id: 'p-cafe-plain', name: 'Cafe', order_key: 'z' });
  assert.deepEqual(hits('#Café', tasks, { extra }), ['accent']);
  assert.deepEqual(hits('#Cafe', tasks, { extra }), ['plain']);
  assert.deepEqual(hits('#cafe', tasks, { extra }), ['plain']);
});

test('fout: een vergeten operator wordt aangewezen, maar niet bij een lange reeks woorden', () => {
  assert.equal(error('p1 x x').code, 'expected_operator');
  assert.equal(error('p1 x x x x x x x x').code, 'unknown_term');
  assert.equal(error('x x').code, 'unknown_term');
  const q = 'p1   vandaag';
  const e = error(q);
  assert.equal(q.slice(e.position, e.position + e.length), 'vandaag');
});

test('evaluateFilter: gelijke datum, prioriteit en project volgen de eigen volgorde (order_key), niet de volgorde van aanmaken', () => {
  const tasks = [T('c', { order_key: 'c' }), T('a', { order_key: 'a' }), T('b', { order_key: 'b' })];
  assert.deepEqual(evaluateFilter('alles', ctxOf(world(tasks))).tasks.map((t) => t.id), ['a', 'b', 'c']);
  // bij gelijke volgordesleutel beslist het id
  const same = [T('z', { order_key: 'k' }), T('y', { order_key: 'k' })];
  assert.deepEqual(evaluateFilter('alles', ctxOf(world(same))).tasks.map((t) => t.id), ['y', 'z']);
});

// ---------- de lijst met termen voor de interface ----------

test('TERMS noemt elke term in beide talen', () => {
  assert.ok(TERMS.length >= 25);
  for (const [form, text] of TERMS) {
    assert.equal(typeof form, 'string');
    assert.equal(typeof text, 'string');
  }
  const forms = TERMS.map(([f]) => f).join(' ');
  for (const needle of ['vandaag | today', 'te laat | overdue', 'zoek: tekst | search: tekst', 'afgevinkt | completed', 'assigned to others', 'terugkerend | recurring']) assert.ok(forms.includes(needle), needle);
});
