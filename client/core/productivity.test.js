// De rekenkern van het scherm Productiviteit (core/productivity.js): reeksen van dagen en weken met vrije dagen, ISO-weken over
// de jaargrens, de verdeling over projecten, een bewaard antwoord van een eerdere dag, en het bewaren zelf. Plus: de dag van het
// apparaat (todayString) en de dag waarin de server telt (dayIn met de tijdzone van het apparaat) zijn dezelfde, in elke
// tijdzone en rond zomer- en wintertijd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATS_KEY, completionMark, createStatsFeed, dayCounts, dayStreaks, projectShare, summarize, validStats, weekStreaks, weekTotals } from './productivity.js';
import { todayString } from './format.js';
import { dayIn, tallyCompletions } from '../../shared/stats.js';

/** Een antwoord zoals de server het geeft: `days` = { datum: aantal } of { datum: { project: aantal } }. */
function answer(today, from, days) {
  const per_day = Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, v]) => {
    const projects = typeof v === 'number' ? { 'proj-a': v } : v;
    return { date, count: Object.values(projects).reduce((s, c) => s + c, 0), projects };
  }).filter((d) => d.count > 0);
  return { tz: 'Europe/Amsterdam', today, from, days: 180, retention_days: 180, per_day };
}
const counts = (o) => new Map(Object.entries(o));

test('dagreeks: aaneengesloten dagen met het doel gehaald; een gemiste werkdag breekt, vandaag nog niet', () => {
  // ma 2 nov t/m za 14 nov 2026; geen vrije dagen
  const c = counts({ '2026-11-02': 5, '2026-11-03': 6, '2026-11-04': 2, '2026-11-05': 5, '2026-11-06': 5, '2026-11-07': 9, '2026-11-08': 5, '2026-11-09': 5, '2026-11-10': 4, '2026-11-11': 5, '2026-11-12': 5, '2026-11-13': 7 });
  assert.deepEqual(dayStreaks(c, { from: '2026-11-02', today: '2026-11-14', goal: 5 }), { current: 3, longest: 5 }, 'vandaag (0) breekt de reeks van 11-13 nov nog niet');
  assert.deepEqual(dayStreaks(new Map([...c, ['2026-11-14', 5]]), { from: '2026-11-02', today: '2026-11-14', goal: 5 }), { current: 4, longest: 5 }, 'gehaald vandaag telt mee');
  assert.deepEqual(dayStreaks(c, { from: '2026-11-02', today: '2026-11-15', goal: 5 }), { current: 0, longest: 5 }, 'de dag erna is 14 nov voorbij en gemist');
  assert.deepEqual(dayStreaks(c, { from: '2026-11-02', today: '2026-11-14', goal: 6 }), { current: 1, longest: 1 });
  assert.deepEqual(dayStreaks(c, { from: '2026-11-02', today: '2026-11-14', goal: 1 }), { current: 12, longest: 12 });
  assert.equal(dayStreaks(c, { from: '2026-11-02', today: '2026-11-14', goal: 0 }), null, 'doel 0: geen reeks');
  assert.deepEqual(dayStreaks(new Map(), { from: '2026-11-14', today: '2026-11-14', goal: 5 }), { current: 0, longest: 0 });
  assert.deepEqual(dayStreaks(counts({ '2026-11-14': 5 }), { from: '2026-11-14', today: '2026-11-14', goal: 5 }), { current: 1, longest: 1 });
  assert.deepEqual(dayStreaks(counts({ '2026-11-01': 5, '2026-11-02': 5 }), { from: '2026-11-02', today: '2026-11-02', goal: 5 }), { current: 1, longest: 1 }, 'vóór from is niets bekend');
});

test('dagreeks: een vrije dag zonder doel breekt niet en telt niet; met gehaald doel telt hij wel', () => {
  // vr 6 nov, za 7, zo 8, ma 9 nov 2026; het weekend vrij
  const weekend = [6, 7];
  assert.deepEqual(dayStreaks(counts({ '2026-11-06': 5, '2026-11-09': 5 }), { from: '2026-11-06', today: '2026-11-10', goal: 5, daysOff: weekend }), { current: 2, longest: 2 });
  assert.deepEqual(dayStreaks(counts({ '2026-11-06': 5, '2026-11-07': 5, '2026-11-09': 5 }), { from: '2026-11-06', today: '2026-11-10', goal: 5, daysOff: weekend }), { current: 3, longest: 3 }, 'zaterdag toch gehaald');
  assert.deepEqual(dayStreaks(counts({ '2026-11-06': 5, '2026-11-09': 5 }), { from: '2026-11-06', today: '2026-11-10', goal: 5, daysOff: [] }), { current: 1, longest: 1 }, 'zonder vrije dagen breekt het weekend');
  assert.deepEqual(dayStreaks(counts({ '2026-11-06': 5, '2026-11-09': 5 }), { from: '2026-11-06', today: '2026-11-10', goal: 5, daysOff: [7] }), { current: 1, longest: 1 }, 'alleen zondag vrij: zaterdag breekt');
  assert.deepEqual(dayStreaks(counts({ '2026-11-04': 5, '2026-11-06': 5 }), { from: '2026-11-04', today: '2026-11-07', goal: 5, daysOff: [4] }), { current: 2, longest: 2 }, 'een vrije donderdag');
  assert.deepEqual(dayStreaks(counts({ '2026-11-06': 5 }), { from: '2026-11-06', today: '2026-11-08', goal: 5, daysOff: weekend }), { current: 1, longest: 1 }, 'het weekend na vrijdag laat de reeks staan');
});

test('weken: ISO-weken van maandag tot zondag, ook over de jaargrens (2026 heeft een week 53)', () => {
  const c = counts({ '2026-12-27': 1, '2026-12-28': 2, '2027-01-03': 3, '2027-01-04': 4, '2027-01-06': 5 });
  const w = weekTotals(c, { from: '2026-12-24', today: '2027-01-06' });
  assert.deepEqual(w, [
    { start: '2026-12-21', year: 2026, week: 52, count: 1, partial: true },
    { start: '2026-12-28', year: 2026, week: 53, count: 5, partial: false },
    { start: '2027-01-04', year: 2027, week: 1, count: 9, partial: true },
  ]);
  assert.deepEqual(weekTotals(counts({ '2026-11-15': 3, '2026-11-16': 9 }), { from: '2026-11-16', today: '2026-11-16' }), [{ start: '2026-11-16', year: 2026, week: 47, count: 9, partial: true }], 'wat vóór from ligt telt niet');
  assert.deepEqual(weekTotals(counts({ '2026-11-15': 3, '2026-11-17': 9 }), { from: '2026-11-09', today: '2026-11-16' }).map((x) => x.count), [3, 0], 'na today telt niet');
  assert.deepEqual(weekTotals(counts({ '2026-11-16': 4, '2026-11-18': 2 }), { from: '2026-11-18', today: '2026-11-20' }).map((x) => [x.start, x.count, x.partial]), [['2026-11-16', 2, true]], 'ook binnen de eerste week telt wat vóór from ligt niet');
  assert.deepEqual(weekTotals(new Map(), { from: '2027-01-01', today: '2027-01-01' }).map((x) => [x.start, x.year, x.week]), [['2026-12-28', 2026, 53]], '1 januari 2027 hoort bij week 53 van 2026');
  assert.deepEqual(weekTotals(new Map(), { from: '2025-12-29', today: '2025-12-29' }).map((x) => [x.year, x.week]), [[2026, 1]], '29 december 2025 hoort bij week 1 van 2026');
});

test('weekreeks: aaneengesloten weken met het weekdoel; de lopende week breekt nog niet; doel 0 is uit', () => {
  const weeks = (...n) => n.map((count, i) => ({ start: `w${i}`, count }));
  assert.deepEqual(weekStreaks(weeks(30, 25, 10, 25, 26, 4), 25), { current: 2, longest: 2 });
  assert.deepEqual(weekStreaks(weeks(30, 25, 25, 10, 25, 26), 25), { current: 2, longest: 3 }, 'gehaald deze week telt mee');
  assert.deepEqual(weekStreaks(weeks(10, 25, 4), 25), { current: 1, longest: 1 }, 'deze week nog niet: de vorige telt');
  assert.deepEqual(weekStreaks(weeks(30, 24, 25, 4), 25), { current: 1, longest: 1 });
  assert.deepEqual(weekStreaks(weeks(0), 25), { current: 0, longest: 0 });
  assert.deepEqual(weekStreaks([], 25), { current: 0, longest: 0 });
  assert.equal(weekStreaks(weeks(30), 0), null);
});

test('projecten: de vijf grootste en de rest samen; gelijk aantal op naam; alleen de gevraagde dagen', () => {
  const stats = answer('2026-11-14', '2026-05-19', {
    '2026-11-08': { p0: 50 },
    '2026-11-09': { p1: 6, p2: 4, p3: 3, p4: 3 },
    '2026-11-12': { p5: 2, p6: 1, p7: 1, p2: 1 },
    '2026-11-15': { p7: 99 },
  });
  const names = { p1: 'Werk', p2: 'Huis', p3: 'Tuin', p4: 'Auto', p5: 'Inbox', p6: 'Club', p7: 'Boek' };
  const share = projectShare(stats, { start: '2026-11-09', end: '2026-11-14', nameOf: (id) => names[id] });
  assert.deepEqual(share, {
    items: [{ projectId: 'p1', count: 6 }, { projectId: 'p2', count: 5 }, { projectId: 'p4', count: 3 }, { projectId: 'p3', count: 3 }, { projectId: 'p5', count: 2 }],
    rest: 2, restProjects: 2, total: 21,
  });
  assert.deepEqual(projectShare(stats, { start: '2026-11-09', end: '2026-11-14', top: 2 }).items.map((x) => x.projectId), ['p1', 'p2']);
  assert.deepEqual(projectShare(stats, { start: '2026-11-12', end: '2026-11-12' }).items.map((x) => x.projectId), ['p5', 'p2', 'p6', 'p7'], 'zonder namen op id');
  assert.deepEqual(projectShare(null, { start: '2026-11-09', end: '2026-11-14' }), { items: [], rest: 0, restProjects: 0, total: 0 });
  const proto = JSON.parse('{"tz":"UTC","today":"2026-11-14","from":"2026-11-14","per_day":[{"date":"2026-11-14","count":2,"projects":{"__proto__":2}}]}');
  assert.deepEqual(projectShare(proto, { start: '2026-11-14', end: '2026-11-14' }).items, [{ projectId: '__proto__', count: 2 }]);
});

test('samenvatting: vandaag, deze week, reeksen, de laatste 7 dagen en 12 weken, uit één antwoord', () => {
  // za 14 nov 2026; weekend vrij (standaard), doelen 5 en 25
  const stats = answer('2026-11-14', '2026-05-19', {
    '2026-11-02': 6, '2026-11-03': 5, '2026-11-04': 5, '2026-11-05': 5, '2026-11-06': 5, // week 45: 26
    '2026-11-09': 7, '2026-11-10': 5, '2026-11-11': 8, '2026-11-12': 3, '2026-11-13': 5, '2026-11-14': { p1: 1, p2: 2 }, // week 46: 31
  });
  const s = summarize(stats, { settings: null, today: '2026-11-14' });
  assert.deepEqual(s.goals, { daily: 5, weekly: 25, daysOff: [6, 7] });
  assert.equal(s.from, '2026-05-19');
  assert.equal(s.stale, false);
  assert.deepEqual(s.today, { date: '2026-11-14', count: 3, goal: 5, met: false, off: true });
  assert.deepEqual(s.week, { start: '2026-11-09', count: 31, goal: 25, met: true });
  assert.deepEqual(s.dayStreak, { current: 1, longest: 8 }, 'donderdag 12 nov brak de reeks van 2 tot en met 11 nov');
  assert.deepEqual(s.weekStreak, { current: 2, longest: 2 });
  assert.deepEqual(s.days.map((d) => [d.date, d.count, d.off, d.known, d.today]), [
    ['2026-11-08', 0, true, true, false], ['2026-11-09', 7, false, true, false], ['2026-11-10', 5, false, true, false], ['2026-11-11', 8, false, true, false],
    ['2026-11-12', 3, false, true, false], ['2026-11-13', 5, false, true, false], ['2026-11-14', 3, true, true, true],
  ]);
  assert.equal(s.weeks.length, 12);
  assert.deepEqual(s.weeks.slice(-3).map((w) => [w.start, w.week, w.count, w.current]), [['2026-10-26', 44, 0, false], ['2026-11-02', 45, 26, false], ['2026-11-09', 46, 31, true]]);
  assert.equal(s.weeks[0].start, '2026-08-24');
  assert.equal(summarize(stats, { today: '2026-11-14', weeks: 4 }).weeks.length, 4);
  assert.deepEqual(s.projects, { items: [{ projectId: 'proj-a', count: 28 }, { projectId: 'p2', count: 2 }, { projectId: 'p1', count: 1 }], rest: 0, restProjects: 0, total: 31 });
  const strict = summarize(stats, { settings: { goal_daily: 3, goal_weekly: 0, days_off: [] }, today: '2026-11-14' });
  assert.deepEqual([strict.dayStreak, strict.weekStreak, strict.week.met, strict.today.met], [{ current: 6, longest: 6 }, null, false, true], 'zonder vrije dagen breekt het weekend; weekdoel uit');
  const off = summarize(stats, { settings: { goal_daily: 0 }, today: '2026-11-14' });
  assert.deepEqual([off.today.met, off.today.goal, off.dayStreak], [false, 0, null], 'zonder dagdoel is er niets gehaald');
  assert.equal(summarize(null, { today: '2026-11-14' }), null);
  assert.equal(summarize({ per_day: [] }, { today: '2026-11-14' }), null);
});

test('samenvatting: weken vóór het begin van het logboek zijn onbekend; een bewaard antwoord van gisteren breekt de reeks niet', () => {
  const young = summarize(answer('2026-11-14', '2026-11-04', { '2026-11-04': 5, '2026-11-05': 5 }), { today: '2026-11-14' });
  assert.deepEqual(young.weeks.filter((w) => w.unknown).length, 10, 'alleen week 45 en 46 zijn (deels) bekend');
  assert.equal(young.weeks.at(-2).partial, true, 'week 45 begint vóór from');
  const cached = answer('2026-11-13', '2026-05-18', { '2026-11-11': 5, '2026-11-12': 5, '2026-11-13': 5 });
  const s = summarize(cached, { today: '2026-11-17' }); // dinsdag, het antwoord is van vrijdag
  assert.equal(s.stale, true);
  assert.deepEqual(s.dayStreak, { current: 3, longest: 3 }, 'de dagen na het antwoord (ook maandag) zijn onbekend en breken niets');
  assert.deepEqual(s.days.map((d) => d.known), [true, true, true, false, false, false, false]);
  assert.equal(s.today.count, 0);
  assert.equal(s.week.count, 0, 'een nieuwe week: nog niets bekend');
  const behind = summarize(answer('2026-11-14', '2026-05-19', { '2026-11-13': 5, '2026-11-14': 5 }), { today: '2026-11-13' });
  assert.deepEqual([behind.stale, behind.dayStreak], [false, { current: 1, longest: 1 }], 'het apparaat loopt een dag achter (andere tijdzone): tot en met zijn vandaag');
});

test('het teken om bij te werken verandert bij afvinken, heropenen en elke afvinking van een terugkerende taak', () => {
  const view = (tasks) => ({ tasks: new Map(tasks.map((t, i) => [`t${i}`, t])) });
  const a = completionMark(view([{ checked: false, completed_count: 0 }, { checked: true, completed_count: 1 }]));
  assert.equal(a, '1:1');
  assert.notEqual(completionMark(view([{ checked: false, completed_count: 1 }, { checked: true, completed_count: 1 }])), a, 'terugkerend: alleen de teller');
  assert.notEqual(completionMark(view([{ checked: false, completed_count: 0 }, { checked: false, completed_count: 1 }])), a, 'heropend');
  assert.equal(completionMark(null), '0:0');
});

test('antwoorden controleren: alleen bruikbare gegevens uit de opslag of van de server', () => {
  assert.equal(validStats(answer('2026-11-14', '2026-05-19', { '2026-11-14': 2 })), true);
  for (const bad of [null, {}, { today: '2026-11-14', from: '2026-05-19' }, { today: 'x', from: '2026-05-19', per_day: [] },
    { today: '2026-11-14', from: '2026-05-19', per_day: [{ date: '2026-11-14', count: -1, projects: {} }] },
    { today: '2026-11-14', from: '2026-05-19', per_day: [{ date: '2026-11-14', count: 1, projects: { a: 'x' } }] },
    { today: '2026-11-14', from: '2026-05-19', per_day: [{ date: 'gisteren', count: 1, projects: {} }] },
    { today: '2026-11-14', from: '2026-05-19', per_day: [{ date: '2026-11-14', count: 1 }] }]) assert.equal(validStats(bad), false, JSON.stringify(bad));
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

test('bewaren: het laatste antwoord blijft (per gebruiker) en is zonder verbinding te zien; afmelden wist het', async () => {
  const storage = memoryStorage();
  const good = answer('2026-11-14', '2026-05-19', { '2026-11-14': 2 });
  let reply = () => good;
  const asked = [];
  let changes = 0;
  const feed = createStatsFeed({ fetchStats: async (q) => { asked.push(q); return reply(); }, storage, onChange: () => { changes += 1; }, now: () => Date.parse('2026-11-14T10:00:00Z') });
  await feed.refresh({ tz: 'UTC' });
  assert.deepEqual(asked, [], 'zonder gebruiker niets ophalen');
  feed.use('anna');
  await feed.refresh({ tz: 'Europe/Amsterdam' });
  assert.deepEqual(asked, [{ tz: 'Europe/Amsterdam' }]);
  assert.deepEqual(feed.state.data, good);
  assert.equal(feed.state.fetchedAt, '2026-11-14T10:00:00.000Z');
  assert.ok(changes >= 2, 'laden en klaar');
  assert.deepEqual(JSON.parse(storage.map.get(STATS_KEY)), { user: 'anna', fetched_at: '2026-11-14T10:00:00.000Z', data: good });

  const later = createStatsFeed({ fetchStats: async () => { throw Object.assign(new Error('weg'), { code: 'OFFLINE' }); }, storage });
  later.use('anna');
  assert.deepEqual(later.state.data, good, 'na herstarten is het bewaarde antwoord er meteen');
  await later.refresh({ tz: 'UTC' });
  assert.deepEqual([later.state.error, later.state.data], ['OFFLINE', good], 'zonder verbinding blijft het staan');
  const other = createStatsFeed({ fetchStats: async () => good, storage });
  other.use('bram');
  assert.equal(other.state.data, null, 'een ander account krijgt het niet');

  reply = () => ({ kapot: true });
  await feed.refresh({ tz: 'UTC' });
  assert.deepEqual([feed.state.error, feed.state.data], ['FAILED', good], 'een onbruikbaar antwoord vervangt niets');
  reply = () => { throw Object.assign(new Error('oud'), { status: 404 }); };
  await feed.refresh({ tz: 'UTC' });
  assert.equal(feed.state.error, 'UNSUPPORTED', 'een oudere server zonder dit eindpunt');

  feed.forget();
  assert.equal(storage.map.has(STATS_KEY), false);
  assert.equal(feed.state.data, null);
  storage.setItem(STATS_KEY, '{kapot');
  const broken = createStatsFeed({ fetchStats: async () => good, storage });
  broken.use('anna');
  assert.equal(broken.state.data, null, 'onleesbare opslag: gewoon zonder');
  const blocked = createStatsFeed({ fetchStats: async () => good, storage: { getItem() { throw new Error('geblokkeerd'); }, setItem() { throw new Error('vol'); }, removeItem() { throw new Error('x'); } } });
  blocked.use('anna');
  await blocked.refresh({ tz: 'UTC' });
  assert.deepEqual(blocked.state.data, good, 'geblokkeerde opslag: het werkt met verbinding');
  blocked.forget();
});

test('bewaren: één verzoek tegelijk, en een antwoord voor een vorige gebruiker wordt weggegooid', async () => {
  let release;
  let calls = 0;
  const feed = createStatsFeed({ fetchStats: () => { calls += 1; return new Promise((r) => { release = r; }); }, storage: memoryStorage() });
  feed.use('anna');
  const a = feed.refresh({ tz: 'UTC' });
  const b = feed.refresh({ tz: 'UTC' });
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.equal(feed.state.loading, true);
  feed.use('bram');
  release(answer('2026-11-14', '2026-05-19', { '2026-11-14': 9 }));
  await a;
  assert.equal(feed.state.data, null, 'Anna’s antwoord komt niet bij Bram');
  assert.equal(feed.state.error, null);
});

test('de dag van het apparaat is de dag waarin de server telt, in elke tijdzone en rond zomer- en wintertijd', () => {
  const saved = process.env.TZ;
  try {
    for (const tz of ['Europe/Amsterdam', 'America/New_York', 'Pacific/Auckland', 'Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Chatham', 'UTC']) {
      process.env.TZ = tz;
      const day = dayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
      for (const iso of ['2026-03-28T22:59:00Z', '2026-03-28T23:00:00Z', '2026-03-29T01:30:00Z', '2026-03-29T22:00:00Z', '2026-10-24T22:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', '2026-10-25T23:00:00Z',
        '2026-09-26T11:59:00Z', '2026-09-26T12:00:00Z', '2026-04-05T13:59:00Z', '2026-11-14T10:45:00Z', '2026-12-31T23:59:59Z', '2027-01-01T00:00:00Z']) {
        const ms = Date.parse(iso);
        assert.equal(todayString(new Date(ms)), day(ms), `${tz} ${iso}`);
      }
      // en de telling van de server hoort zo bij "vandaag" van het apparaat
      const now = Date.parse('2026-10-25T01:30:00Z');
      const s = tallyCompletions([{ at: '2026-10-25T00:10:00Z', kind: 'task_completed', task_id: 'x', project_id: 'p' }], { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, nowMs: now, days: 2 });
      assert.equal(s.today, todayString(new Date(now)), tz);
      assert.equal(summarize(s, { today: todayString(new Date(now)) }).days.find((d) => d.date === todayString(new Date(Date.parse('2026-10-25T00:10:00Z')))).count, 1, tz);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('dayCounts: een Map van datum naar aantal', () => {
  assert.deepEqual([...dayCounts(answer('2026-11-14', '2026-05-19', { '2026-11-13': 2, '2026-11-14': 1 }))], [['2026-11-13', 2], ['2026-11-14', 1]]);
  assert.deepEqual([...dayCounts(null)], []);
});
