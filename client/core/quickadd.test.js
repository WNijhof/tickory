// Snel toevoegen: een tijdsbereik (core/quickadd.js, findTimeRange en parseQuickAdd).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTimeRange, parseQuickAdd } from './quickadd.js';

test('tijdsbereik: met een dubbele punt, "uur" of "van … tot" wordt het een tijd met een duur; "9-10" alleen is een datum', () => {
  assert.deepEqual(findTimeRange('Vergadering 9:00-10:30'), { start: '09:00', minutes: 90, index: 12, length: 10 });
  assert.equal(findTimeRange('Sporten 18:00 - 19:30').minutes, 90);
  assert.deepEqual([findTimeRange('Les 9-10 uur').start, findTimeRange('Les 9-10 uur').minutes], ['09:00', 60]);
  assert.equal(findTimeRange('Overleg van 9 tot 10:30').minutes, 90);
  assert.equal(findTimeRange('Overleg van 14 tot en met 15 uur').minutes, 60);
  assert.equal(findTimeRange('Verjaardag 9-10'), null, 'een datum (9 oktober)');
  assert.equal(findTimeRange('Kosten 10:00-9:00'), null, 'het einde vóór het begin');
  assert.equal(findTimeRange('Iets 25:00-26:00'), null);
  assert.equal(findTimeRange('versie 1.2-3.4'), null);
});

test('snel toevoegen met een tijdsbereik: begin als tijd, het verschil als duur; een eigen =duur gaat voor', () => {
  const view = { projects: new Map([['inbox', { id: 'inbox', name: 'Inbox' }]]), sections: new Map(), labels: new Map(), tasks: new Map(), members: new Map() };
  const now = new Date(2026, 10, 16, 8, 0);
  const p = parseQuickAdd('Vergadering morgen 9:00-10:30', { view, now, defaultProjectId: 'inbox' });
  assert.deepEqual([p.content, p.due?.date, p.duration], ['Vergadering', '2026-11-17T09:00', 90]);
  const q = parseQuickAdd('Lunch morgen 12:00-13:00 =45m', { view, now, defaultProjectId: 'inbox' });
  assert.deepEqual([q.due?.date, q.duration], ['2026-11-17T12:00', 45]);
  const r = parseQuickAdd('Verjaardag oma 9-10', { view, now, defaultProjectId: 'inbox' });
  assert.equal(r.duration, undefined, '9-10 is 9 oktober, geen tijd');
});

test('datums herkennen uit (Instellingen › Algemeen): "morgen 9:00-10:30" blijft tekst, een {deadline} en p1 werken nog', () => {
  const view = { projects: new Map([['inbox', { id: 'inbox', name: 'Inbox' }]]), sections: new Map(), labels: new Map(), tasks: new Map(), members: new Map() };
  const now = new Date(2026, 10, 16, 8, 0);
  const p = parseQuickAdd('Vergadering morgen 9:00-10:30 {vrijdag} p1', { view, now, defaultProjectId: 'inbox', dates: false });
  assert.equal(p.content, 'Vergadering morgen 9:00-10:30');
  assert.equal(p.due, null);
  assert.equal(p.duration, undefined);
  assert.equal(p.deadline, '2026-11-20');
  assert.equal(p.priority, 1);
});

test('snel toevoegen in het Engels: datums, herhalingen, tijdsbereik, deadline en herinneringen; cijfers werken ook', () => {
  const view = { projects: new Map([['inbox', { id: 'inbox', name: 'Inbox' }]]), sections: new Map(), labels: new Map(), tasks: new Map(), members: new Map() };
  const now = new Date(2026, 10, 16, 8, 0); // maandag 16 november 2026
  const quick = (text) => parseQuickAdd(text, { view, now, defaultProjectId: 'inbox', language: 'en' });
  const a = quick('Call the dentist tomorrow at 9am p1');
  assert.deepEqual([a.content, a.due?.date, a.due?.lang, a.priority], ['Call the dentist', '2026-11-17T09:00', 'en', 1]);
  const b = quick('Gym every monday at 7:30');
  assert.deepEqual([b.content, b.due?.recurrence, b.due?.date], ['Gym', { freq: 'weekly', byweekday: [1] }, '2026-11-23T07:30'], 'vandaag 7:30 is al voorbij');
  const c = quick('Meeting tomorrow from 9 to 10:30');
  assert.deepEqual([c.content, c.due?.date, c.duration], ['Meeting', '2026-11-17T09:00', 90]);
  const d = quick('Workshop friday 14:00-16:00');
  assert.deepEqual([d.content, d.due?.date, d.duration], ['Workshop', '2026-11-20T14:00', 120]);
  const e = quick('Send report {friday} tomorrow');
  assert.deepEqual([e.content, e.deadline, e.due?.date], ['Send report', '2026-11-20', '2026-11-17']);
  const f = quick('Flight tomorrow at 10am !1h !(30 minutes before) !(an hour before)');
  assert.deepEqual([f.content, f.reminders], ['Flight', [{ type: 'relative', minute_offset: 60 }, { type: 'relative', minute_offset: 30 }]]);
  const g = quick('Pay rent 31-12 p2');
  assert.deepEqual([g.content, g.due?.date, g.priority], ['Pay rent', '2026-12-31', 2], 'cijfers via de Nederlandse herkenner');
  const h = quick('Wake up !(tomorrow at 6am) tomorrow at 7am');
  assert.deepEqual([h.content, h.reminders], ['Wake up', [{ type: 'absolute', due: { date: '2026-11-17T06:00' } }]]);
  assert.equal(quick('Buy sun cream').due, null);
  // in het Nederlands verandert er niets
  const nl = parseQuickAdd('Tandarts bellen morgen om 9 uur p1', { view, now, defaultProjectId: 'inbox', language: 'nl' });
  assert.deepEqual([nl.content, nl.due?.date, nl.due?.lang], ['Tandarts bellen', '2026-11-17T09:00', 'nl']);
  assert.equal(parseQuickAdd('Call the dentist tomorrow', { view, now, defaultProjectId: 'inbox', language: 'nl' }).due, null, 'in het Nederlands geen Engelse datums');
});

test('herinneringen in gewone taal: "met herinnering 10 minuten vooraf", een moment, alleen een tijd, en in het Engels', () => {
  const view = { projects: new Map([['inbox', { id: 'inbox', name: 'Inbox' }]]), sections: new Map(), labels: new Map(), tasks: new Map(), members: new Map() };
  const now = new Date(2026, 10, 23, 10, 0);
  const nl = (text) => parseQuickAdd(text, { view, now, defaultProjectId: 'inbox', language: 'nl' });
  const en = (text) => parseQuickAdd(text, { view, now, defaultProjectId: 'inbox', language: 'en' });
  const rel = (n) => [{ type: 'relative', minute_offset: n }];
  const abs = (date) => [{ type: 'absolute', due: { date } }];
  let p = nl('Banaan morgen om 14:00 met herinnering 10 minuten vooraf');
  assert.deepEqual([p.content, p.due?.date, p.reminders], ['Banaan', '2026-11-24T14:00', rel(10)]);
  assert.deepEqual(nl('Banaan morgen om 14:00 met een herinnering van een kwartier').reminders, rel(15));
  assert.deepEqual(nl('Tandarts vrijdag om 9 uur herinner me een half uur ervoor').reminders, rel(30));
  assert.deepEqual(nl('Banaan morgen om 14:00 met herinnering op tijd').reminders, rel(0));
  p = nl('Vergadering morgen om 15:00 met herinnering om 14:30');
  assert.deepEqual([p.content, p.due?.date, p.reminders], ['Vergadering', '2026-11-24T15:00', abs('2026-11-24T14:30')], 'alleen een tijd: op de dag van de taak');
  p = nl('Bellen met herinnering morgen om 8 uur');
  assert.deepEqual([p.content, p.due, p.reminders], ['Bellen', null, abs('2026-11-24T08:00')], 'het moment wordt niet de datum van de taak');
  p = nl('Banaan morgen om 14:00 met herinnering 10 minuten vooraf #Inbox p1');
  assert.deepEqual([p.content, p.reminders, p.priority], ['Banaan', rel(10), 1], 'stopt bij het volgende #project of p1');
  // geen herinnering erachter: alles blijft in de titel
  for (const text of ['Herinnering sturen naar de klant', 'Mail met herinnering naar Jan', 'Herinner me niet']) assert.deepEqual([nl(text).content, nl(text).reminders], [text, []], text);
  p = en('Dentist tomorrow at 2pm with a reminder 30 minutes before');
  assert.deepEqual([p.content, p.due?.date, p.reminders], ['Dentist', '2026-11-24T14:00', rel(30)]);
  assert.deepEqual(en('Call Bob remind me at 9am').reminders, abs('2026-11-24T09:00'), 'zonder datum en al voorbij: morgen');
  assert.deepEqual(en('Call Bob remind me at 11am').reminders, abs('2026-11-23T11:00'), 'zonder datum, nog niet voorbij: vandaag');
  // datums in gewone taal uit (Instellingen › Algemeen): dan ook dit niet, het !-snelschrift wel
  const off = parseQuickAdd('Banaan met herinnering 10 minuten vooraf !5m', { view, now, defaultProjectId: 'inbox', language: 'nl', dates: false });
  assert.deepEqual([off.content, off.reminders], ['Banaan met herinnering 10 minuten vooraf', rel(5)]);
});
