// De kant van de web-app bij de widgets van de Android-app: de brug, de vingerafdruk van wat in de widgets staat,
// het openen van "Taak toevoegen" via #add, en het afvinken van een terugkerende taak met if_due.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { addContextFromHash, androidBridge, taskIdFromHash, watchWidgets, widgetFingerprint } from './android.js';

let counter = 0;

async function client() {
  const db = freshDb();
  const user = addUser(db, 'anna', 'Anna');
  const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
  const transport = async (body) => JSON.parse(JSON.stringify(handleSync(db, JSON.parse(JSON.stringify(body)), user.id)));
  const sync = new SyncClient({ store, transport, onCommandErrors: () => {} });
  const actions = createActions(store, {
    makeId: () => `id${String(++counter).padStart(10, '0')}`,
    makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}`,
  });
  await store.init();
  await sync.syncNow();
  return { db, user, store, sync, actions, inbox: store.me.inbox_project_id };
}

test('de brug kent widgetsChanged en een oudere app zonder die methode breekt niets', () => {
  const calls = [];
  const host = { widgetsChanged() { calls.push(this === host); } };
  androidBridge(host).widgetsChanged();
  assert.deepEqual(calls, [true], 'aangeroepen op het object van Android zelf');
  assert.equal(androidBridge({}).widgetsChanged(), undefined, 'een app zonder widgets');
  assert.equal(androidBridge(undefined).widgetsChanged(), undefined, 'een gewone browser');
  assert.equal(androidBridge({ widgetsChanged() { throw new Error('stuk'); } }).widgetsChanged(), undefined, 'een fout in de brug breekt de web-app niet');
});

test('#add opent Taak toevoegen: waar je nu bent, met vandaag, of in een project; al het andere niet', () => {
  assert.deepEqual(addContextFromHash('#add'), {});
  assert.deepEqual(addContextFromHash('#add=today'), { due: 'today' });
  assert.deepEqual(addContextFromHash('#add=project-aaaa1111'), { projectId: 'project-aaaa1111' });
  assert.deepEqual(addContextFromHash('#add=inbox-project', (id) => id === 'inbox-project'), { projectId: 'inbox-project' });
  assert.deepEqual(addContextFromHash('#add=project-onbekend', () => false), {}, 'een project dat niet bestaat: waar je nu bent');
  const nee = ['', '#', '#task=AbCd1234efGH5678', '#added', '#add=', '#add=a b', '#add=<script>', '#add=x&y=1', `#add=${'a'.repeat(41)}`, 'add', null, undefined];
  for (const no of nee) assert.equal(addContextFromHash(no), null, String(no));
  assert.equal(taskIdFromHash('#add'), null, '#add is geen taak');
});

test('widgetFingerprint verandert bij alles wat in de widgets staat en niet bij de rest', async () => {
  const c = await client();
  const id = await c.actions.addTask({ content: 'Boodschappen', project_id: c.inbox, due: { date: '2026-12-01' } });
  await c.sync.syncNow();
  let last = widgetFingerprint(c.store.view);
  const changes = {
    titel: () => c.actions.updateTask(id, { content: 'Boodschappen doen' }),
    datum: () => c.actions.updateTask(id, { due: { date: '2026-12-02' } }),
    prioriteit: () => c.actions.updateTask(id, { priority: 1 }),
  };
  for (const [name, change] of Object.entries(changes)) {
    await change();
    await c.sync.syncNow();
    const now = widgetFingerprint(c.store.view);
    assert.notEqual(now, last, name);
    last = now;
  }
  await c.actions.updateTask(id, { description: 'alleen een notitie' });
  await c.sync.syncNow();
  assert.equal(widgetFingerprint(c.store.view), last, 'een notitie staat niet in de widget');
  await c.actions.completeTask(id);
  await c.sync.syncNow();
  assert.notEqual(widgetFingerprint(c.store.view), last, 'afgevinkt: weg uit de widget');
  const project = await c.actions.addProject({ name: 'Werk' });
  await c.sync.syncNow();
  const withProject = widgetFingerprint(c.store.view);
  await c.actions.updateProject(project, { name: 'Werk 2' });
  await c.sync.syncNow();
  assert.notEqual(widgetFingerprint(c.store.view), withProject, 'de naam van een project staat in de widget');
});

test('Android hoort een wijziging voor de widgets één keer per reeks, en niet buiten de app', async () => {
  const c = await client();
  let now = 0;
  const pending = [];
  const timers = {
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; pending.push(t); return t; },
    clearTimeout: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
  };
  const advance = (ms) => { now += ms; for (const t of [...pending]) if (t.at <= now) { pending.splice(pending.indexOf(t), 1); t.fn(); } };
  let pings = 0;
  const stop = watchWidgets({ store: c.store, bridge: { available: true, widgetsChanged: () => { pings += 1; } }, delayMs: 1000, timers });
  const id = await c.actions.addTask({ content: 'Een', project_id: c.inbox });
  await c.actions.updateTask(id, { priority: 2 });
  await c.actions.updateTask(id, { content: 'Twee' });
  advance(999);
  assert.equal(pings, 0);
  advance(1);
  assert.equal(pings, 1, 'drie wijzigingen, één waarschuwing');
  await c.actions.updateTask(id, { description: 'notitie' });
  advance(5000);
  assert.equal(pings, 1, 'een notitie telt niet');
  stop();
  await c.actions.updateTask(id, { content: 'Drie' });
  advance(5000);
  assert.equal(pings, 1, 'na stoppen niets meer');
  const listeners = c.store.listeners.size;
  watchWidgets({ store: c.store, bridge: androidBridge(undefined) })();
  assert.equal(c.store.listeners.size, listeners, 'in een gewone browser wordt er niet geluisterd');
});

test('afvinken van een terugkerende taak stuurt de geziene datum mee; een gewone taak niet', async () => {
  const c = await client();
  const rec = await c.actions.addTask({ content: 'Planten water geven', project_id: c.inbox, due: { date: '2026-11-13', recurrence: { freq: 'weekly', byweekday: [5] } } });
  const plain = await c.actions.addTask({ content: 'Gewoon', project_id: c.inbox, due: { date: '2026-11-13' } });
  await c.sync.syncNow();
  await c.actions.completeTask(rec);
  await c.actions.completeTask(plain);
  const sent = c.store.queue.filter((q) => q.cmd.type === 'task_complete').map((q) => q.cmd.args);
  assert.deepEqual(sent, [{ id: rec, if_due: '2026-11-13' }, { id: plain }]);
  await c.sync.syncNow();
  assert.equal(c.store.view.tasks.get(rec).due.date, '2026-11-20');
  assert.equal(c.store.view.tasks.get(plain).checked, true);
});

test('twee afvinkacties op dezelfde terugkerende taak (widget en web-app) schuiven hem één keer door, ook lokaal', async () => {
  const c = await client();
  const due = { date: '2026-11-13', recurrence: { freq: 'weekly', byweekday: [5] } };
  const rec = await c.actions.addTask({ content: 'Planten water geven', project_id: c.inbox, due });
  await c.sync.syncNow();
  // de widget deed het al op de server (andere uuid, zelfde geziene datum) terwijl de web-app het nog niet wist
  const widgetCommand = { type: 'task_complete', uuid: 'tickory-w-aaaaaaaaaaaaaaaa', args: { id: rec, if_due: '2026-11-13' } };
  const res = handleSync(c.db, { sync_token: '*', resource_types: ['tasks'], commands: [widgetCommand] }, c.user.id);
  assert.equal(res.sync_status[widgetCommand.uuid], 'ok');
  await c.actions.completeTask(rec); // de web-app denkt nog dat de datum 13 november is
  await c.sync.syncNow();
  assert.equal(c.store.view.tasks.get(rec).due.date, '2026-11-20', 'één keer doorgeschoven');
  assert.equal(c.store.view.tasks.get(rec).completed_count, 1);
});

test('lokaal doet het commando hetzelfde als de server: een al doorgeschoven terugkerende taak blijft staan', async () => {
  const { applyCommand, emptyState } = await import('./reducer.js');
  const state = emptyState();
  const due = { date: '2026-11-20', recurrence: { freq: 'weekly', byweekday: [5] } };
  state.tasks.set('recurring-aaaa11', { id: 'recurring-aaaa11', project_id: 'p', content: 'x', due, checked: false, completed_count: 1, order_key: 'a' });
  // een afvinkactie die de datum van vóór het doorschuiven zag: niets doen
  applyCommand(state, { type: 'task_complete', args: { id: 'recurring-aaaa11', if_due: '2026-11-13' } }, '2026-11-13T10:00:00Z');
  assert.equal(state.tasks.get('recurring-aaaa11').due.date, '2026-11-20');
  assert.equal(state.tasks.get('recurring-aaaa11').completed_count, 1);
  // met de goede datum, of zonder: wel doorschuiven
  applyCommand(state, { type: 'task_complete', args: { id: 'recurring-aaaa11', if_due: '2026-11-20' } }, '2026-11-13T10:00:00Z');
  assert.equal(state.tasks.get('recurring-aaaa11').due.date, '2026-11-27');
  applyCommand(state, { type: 'task_complete', args: { id: 'recurring-aaaa11' } }, '2026-11-13T10:00:00Z');
  assert.equal(state.tasks.get('recurring-aaaa11').due.date, '2026-12-04');
});
