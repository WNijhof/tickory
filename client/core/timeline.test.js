// De tijdlijn zonder scherm (core/timeline.js): tijden, afronden, overlappende taken naast elkaar, het model en verplaatsen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MINUTES, dueAt, hhmmOf, layoutColumns, minutesOf, snap, timelineDays, timelineModel } from './timeline.js';

test('tijden: HH:MM heen en terug, afronden op een kwartier binnen de dag', () => {
  assert.equal(minutesOf('09:30'), 570);
  assert.equal(minutesOf('24:00'), null);
  assert.equal(minutesOf('9:30'), null);
  assert.equal(hhmmOf(570), '09:30');
  assert.equal(hhmmOf(-5), '00:00');
  assert.equal(hhmmOf(5000), '23:59');
  assert.equal(snap(577), 570);
  assert.equal(snap(583), 585);
  assert.equal(snap(1439), 1425, 'het laatste kwartier begint om 23:45');
});

test('overlappende taken naast elkaar: elke groep zoveel kolommen als er tegelijk lopen', () => {
  // 9:00-10:00, 9:30-10:30, 10:00-11:00 (raakt de eerste niet), 12:00-12:30 (los)
  const placed = layoutColumns([{ start: 540, end: 600 }, { start: 570, end: 630 }, { start: 600, end: 660 }, { start: 720, end: 750 }]);
  assert.deepEqual(placed, [{ column: 0, columns: 2 }, { column: 1, columns: 2 }, { column: 0, columns: 2 }, { column: 0, columns: 1 }]);
  assert.deepEqual(layoutColumns([]), []);
  const three = layoutColumns([{ start: 600, end: 700 }, { start: 600, end: 650 }, { start: 610, end: 640 }]);
  assert.deepEqual(three.map((x) => x.columns), [3, 3, 3]);
  assert.deepEqual(new Set(three.map((x) => x.column)).size, 3);
});

test('het model: getimede taken met hun duur, zonder tijd bovenaan, in te plannen zonder datum, te laat apart', () => {
  const tasks = [
    { id: 'a', content: 'Overleg', due: { date: '2026-11-18T09:00' }, duration: 90, priority: 4 },
    { id: 'b', content: 'Bellen', due: { date: '2026-11-18T09:30' }, priority: 1 },
    { id: 'c', content: 'Hele dag', due: { date: '2026-11-18' }, priority: 4 },
    { id: 'd', content: 'Ooit', due: null, priority: 2 },
    { id: 'e', content: 'Subtaak zonder datum', due: null, parent_id: 'd' },
    { id: 'f', content: 'Te laat', due: { date: '2026-11-10T08:00' } },
    { id: 'g', content: 'Klaar', due: { date: '2026-11-18T11:00' }, checked: true },
    { id: 'h', content: 'Elke dag', due: { date: '2026-11-16T07:00', recurrence: { freq: 'daily' } }, duration: 15 },
  ];
  const m = timelineModel({ tasks, mode: 'week', anchor: '2026-11-18', today: '2026-11-16' });
  assert.deepEqual(m.days.map((d) => d.date), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
  const wed = m.days[2];
  assert.deepEqual(wed.timed.map((e) => [e.task.id, e.start, e.end, e.columns]), [['h', 420, 435, 1], ['a', 540, 630, 2], ['b', 570, 570 + DEFAULT_MINUTES, 2]]);
  assert.deepEqual(wed.allDay.map((e) => e.task.id), ['c']);
  assert.deepEqual(m.unscheduled.map((x) => x.id), ['d'], 'alleen taken van het hoogste niveau');
  assert.deepEqual(m.overdue.map((x) => x.id), ['f']);
  assert.equal(m.days[0].timed[0].real, true, 'de eigen datum van de herhaling');
  assert.equal(m.days[1].timed[0].real, false, 'een volgend voorkomen');
  assert.equal(m.earliest, 420);
  const day = timelineModel({ tasks, mode: 'day', anchor: '2026-11-18', today: '2026-11-16' });
  assert.deepEqual(day.days.map((d) => d.date), ['2026-11-18']);
  assert.deepEqual(timelineDays('day', '2026-11-18T10:00'), ['2026-11-18']);
});

test('verplaatsen: een nieuwe dag en tijd; een herhaling blijft herhalen', () => {
  assert.deepEqual(dueAt({ date: '2026-11-18', string: 'woensdag', lang: 'nl' }, '2026-11-19', 615), { date: '2026-11-19T10:15' });
  const rec = { freq: 'weekly', byweekday: [3] };
  assert.deepEqual(dueAt({ date: '2026-11-18T09:00', string: 'elke woensdag om 9', lang: 'nl', recurrence: rec }, '2026-11-18', 600),
    { date: '2026-11-18T10:00', recurrence: rec, string: 'elke woensdag om 9', lang: 'nl' });
  assert.deepEqual(dueAt(null, '2026-11-20', 480), { date: '2026-11-20T08:00' }, 'een taak zonder datum uit In te plannen');
});
