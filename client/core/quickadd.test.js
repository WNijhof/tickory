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
