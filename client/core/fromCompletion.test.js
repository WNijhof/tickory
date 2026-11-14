import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleSync } from '../../server/sync.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { nextOccurrence } from '../../shared/recurrence.js';
import { createActions } from './actions.js';
import { parseDue } from './dateNl.js';
import { todayString } from './format.js';
import { parseQuickAdd } from './quickadd.js';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';

const NOW = new Date(2026, 10, 14, 10, 0); // za 14 nov 2026, 10:00 (lokale tijd)

test('"elke! 3 dagen": een herhaling vanaf het afvinken, met dezelfde regel als "elke 3 dagen"', () => {
  const fixed = parseDue('Planten water geven elke 3 dagen', NOW);
  const fromDone = parseDue('Planten water geven elke! 3 dagen', NOW);
  assert.equal(fromDone.content, 'Planten water geven');
  assert.deepEqual(fromDone.due.recurrence, { ...fixed.due.recurrence, fromCompletion: true });
  assert.equal(fromDone.due.recurrence.fromCompletion, true);
  assert.equal(fixed.due.recurrence.fromCompletion, undefined, 'gewoon "elke" heeft het veld niet');
  assert.equal(fromDone.due.date, fixed.due.date);
  assert.equal(fromDone.due.string, 'elke! 3 dagen', 'de tekst blijft zoals getypt');
});

test('"elke!" werkt met alle vormen van elke', () => {
  for (const [text, freq] of [['Bellen elke! week', 'weekly'], ['Bellen elk! jaar', 'yearly'], ['Bellen iedere! maand', 'monthly'], ['Bellen ieder! dag', 'daily'], ['Bellen elke! maandag', 'weekly'], ['Bellen ELKE! 2 weken', 'weekly']]) {
    const r = parseDue(text, NOW);
    assert.equal(r?.content, 'Bellen', text);
    assert.equal(r.due.recurrence.freq, freq, text);
    assert.equal(r.due.recurrence.fromCompletion, true, text);
  }
});

test('een tijdstip erbij en een uitroepteken elders doen niets vreemds', () => {
  const r = parseDue('Pillen elke! dag om 9 uur', NOW);
  assert.equal(r.content, 'Pillen');
  assert.match(r.due.date, /T09:00$/);
  assert.equal(r.due.recurrence.fromCompletion, true);
  // "elke" zonder uitroepteken en een uitroepteken aan een ander woord blijven gewoon
  assert.equal(parseDue('Hoera! elke dag lopen', NOW).due.recurrence.fromCompletion, undefined);
  assert.equal(parseDue('elke!dag', NOW), null, 'zonder spatie erna is het geen herhaling');
  assert.equal(parseDue('Bel Els! morgen', NOW).due.recurrence, undefined);
});

test('"elke!" in snel toevoegen: titel, herhaling en veld', () => {
  const view = { projects: new Map(), sections: new Map(), labels: new Map() };
  const p = parseQuickAdd('Bloemen water geven elke! 3 dagen p2', { view, now: NOW, defaultProjectId: 'inbox-project' });
  assert.equal(p.content, 'Bloemen water geven');
  assert.equal(p.priority, 2);
  assert.equal(p.due.recurrence.fromCompletion, true);
  assert.equal(p.due.recurrence.interval, 3);
});

let counter = 0;
async function client() {
  const db = freshDb();
  const user = addUser(db, 'anna', 'Anna');
  const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
  const transport = async (body) => JSON.parse(JSON.stringify(handleSync(db, JSON.parse(JSON.stringify(body)), user.id)));
  const sync = new SyncClient({ store, transport, onCommandErrors: () => {} });
  const actions = createActions(store, {
    makeId: () => `fc${String(++counter).padStart(10, '0')}`,
    makeUuid: () => `uuid-fc-${String(++counter).padStart(10, '0')}`,
  });
  await store.init();
  await sync.syncNow();
  return { store, sync, actions, inbox: store.me.inbox_project_id };
}

test('afvinken van een "elke!"-taak: de client stuurt zijn eigen afvinkdag mee, en client en server komen op dezelfde datum uit', async () => {
  const c = await client();
  const rec = { freq: 'daily', interval: 3, fromCompletion: true };
  const id = await c.actions.addTask({ content: 'Planten water geven', project_id: c.inbox, due: { date: '2020-01-01T09:30', recurrence: rec } });
  const fixed = await c.actions.addTask({ content: 'Vaste herhaling', project_id: c.inbox, due: { date: '2020-01-01T09:30', recurrence: { freq: 'daily', interval: 3 } } });
  await c.sync.syncNow();
  await c.actions.completeTask(id);
  await c.actions.completeTask(fixed);
  const sent = c.store.queue.filter((q) => q.cmd.type === 'task_complete').map((q) => q.cmd.args);
  assert.deepEqual(sent, [{ id, if_due: '2020-01-01T09:30', completed_on: todayString() }, { id: fixed, if_due: '2020-01-01T09:30' }], 'alleen "elke!" geeft de afvinkdag mee');
  const expected = nextOccurrence(`${todayString()}T09:30`, rec);
  assert.equal(c.store.view.tasks.get(id).due.date, expected, 'optimistisch');
  assert.equal(c.store.view.tasks.get(fixed).due.date, '2020-01-04T09:30', 'een vaste herhaling telt vanaf de oude datum');
  await c.sync.syncNow();
  assert.equal(c.store.view.tasks.get(id).due.date, expected, 'bevestigd door de server');
  assert.equal(c.store.view.tasks.get(id).due.recurrence.fromCompletion, true);
});
