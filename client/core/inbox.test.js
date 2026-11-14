// De lijst Meldingen (core/inbox.js), het optimistisch gelezen zetten (reducer), het opruimen in de opslag (store), en samen met de
// echte server: een melding van een ander komt binnen, wordt gelezen en verdwijnt met haar taak.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { applyCommand, emptyState } from './reducer.js';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { inboxItems, inboxSentence, kindLabel, newestAt, unreadCount } from './inbox.js';
import { reminderFingerprint } from './android.js';
import { setLanguage } from './i18n.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

function state() {
  const s = emptyState();
  s.projects.set('proj-0001', { id: 'proj-0001', name: 'Verbouwing' });
  s.tasks.set('task-0001', { id: 'task-0001', project_id: 'proj-0001', content: 'Tegels kiezen' });
  s.comments.set('comm-0001', { id: 'comm-0001', task_id: 'task-0001', project_id: null, content: 'Hoi @Anna,\nkun jij   dit doen?', mentions: ['user-anna'] });
  const n = (id, kind, extra, minutes) => s.notifications.set(id, { id, kind, actor_id: 'user-bram', owner_id: 'user-anna', task_id: null, project_id: null, comment_id: null, is_read: false, created_at: at(minutes), ...extra });
  n('n-assigned', 'assigned', { task_id: 'task-0001' }, 30);
  n('n-mention', 'mention', { task_id: 'task-0001', comment_id: 'comm-0001' }, 5);
  n('n-shared', 'shared', { project_id: 'proj-0001', is_read: true }, 60);
  n('n-gone-task', 'assigned', { task_id: 'task-weg' }, 1);
  n('n-gone-comment', 'comment', { task_id: 'task-0001', comment_id: 'comm-weg' }, 1);
  n('n-old', 'assigned', { task_id: 'task-0001' }, 61 * 24 * 60);
  n('n-other', 'assigned', { task_id: 'task-0001', owner_id: 'user-bram' }, 2);
  return s;
}
const userName = (id) => ({ 'user-anna': 'Anna', 'user-bram': 'Bram' })[id] ?? null;

test('de lijst: nieuwste eerst, alleen van jou, niets over wat er niet (meer) is of te oud is', () => {
  setLanguage('nl');
  const items = inboxItems(state(), { userId: 'user-anna', userName, now: NOW });
  assert.deepEqual(items.map((x) => x.id), ['n-mention', 'n-assigned', 'n-shared']);
  assert.equal(unreadCount(items), 2);
  assert.equal(newestAt(items), at(5));
  const [mention, assigned, shared] = items;
  assert.deepEqual([mention.actor, mention.title, mention.project, mention.excerpt, mention.target], ['Bram', 'Tegels kiezen', 'Verbouwing', 'Hoi @Anna, kun jij dit doen?', { type: 'task', id: 'task-0001' }]);
  assert.deepEqual([shared.title, shared.project, shared.target, shared.onProject, shared.read], ['Verbouwing', null, { type: 'project', id: 'proj-0001' }, true, true]);
  assert.deepEqual(items.map(inboxSentence), ['Bram noemde je in een opmerking', 'Bram heeft je een taak toegewezen', 'Bram heeft je toegevoegd aan een project']);
  assert.equal(assigned.excerpt, null);
  assert.equal(inboxSentence({ ...shared, kind: 'comment' }), 'Bram schreef een opmerking bij het project');
  assert.equal(inboxSentence({ ...assigned, kind: 'iets-nieuws' }), 'Bram deed iets in een gedeeld project', 'een soort van een nieuwere server');
  assert.equal(kindLabel('completed'), 'Mijn taak is afgevinkt');
  setLanguage('en');
  assert.equal(inboxSentence(assigned), 'Bram assigned you a task');
  setLanguage('nl');
  const unknownActor = inboxItems(state(), { userId: 'user-anna', userName: () => null, now: NOW })[0];
  assert.equal(unknownActor.actor, 'iemand');
});

test('reducer: één gelezen, alles gelezen tot een tijdstip, alleen eigen meldingen, en wat clients niet mogen doet niets', () => {
  const s = state();
  applyCommand(s, { type: 'notification_update', args: { id: 'n-assigned', is_read: true, kind: 'shared', owner_id: 'user-bram' } }, at(0), 'user-anna');
  assert.deepEqual([s.notifications.get('n-assigned').is_read, s.notifications.get('n-assigned').kind, s.notifications.get('n-assigned').owner_id], [true, 'assigned', 'user-anna'], 'alleen is_read');
  applyCommand(s, { type: 'notification_read_all', args: { up_to: at(10) } }, at(0), 'user-anna');
  assert.equal(s.notifications.get('n-mention').is_read, false, 'nieuwer dan up_to: blijft ongelezen');
  applyCommand(s, { type: 'notification_read_all', args: {} }, at(0), 'user-anna');
  assert.equal(s.notifications.get('n-mention').is_read, true);
  assert.equal(s.notifications.get('n-other').is_read, false, 'van een ander: niet');
  const before = s.notifications.size;
  applyCommand(s, { type: 'notification_add', args: { id: 'n-zelf-0001', kind: 'assigned' } }, at(0), 'user-anna');
  applyCommand(s, { type: 'notification_delete', args: { id: 'n-mention' } }, at(0), 'user-anna');
  assert.equal(s.notifications.size, before, 'aanmaken en verwijderen bestaat niet');
});

test('reducer: een melding verdwijnt met haar opmerking, taak of project, zoals op de server', () => {
  const s = state();
  applyCommand(s, { type: 'comment_delete', args: { id: 'comm-0001' } }, at(0), 'user-anna');
  assert.ok(!s.notifications.has('n-mention'), 'de opmerking is weg');
  assert.ok(s.notifications.has('n-assigned'));
  applyCommand(s, { type: 'task_delete', args: { id: 'task-0001' } }, at(0), 'user-anna');
  assert.ok(!s.notifications.has('n-assigned'), 'de taak is weg');
  assert.ok(s.notifications.has('n-shared'));
  s.members.set('m-owner', { id: 'm-owner', project_id: 'proj-0001', user_id: 'user-anna', role: 'owner' });
  applyCommand(s, { type: 'project_delete', args: { id: 'proj-0001' } }, at(0), 'user-anna');
  assert.ok(!s.notifications.has('n-shared'), 'het project is weg');
});

test('reducer: in een opmerking blijven alleen vermelde leden van het project staan, zoals op de server', () => {
  const s = state();
  s.members.set('m1', { id: 'm1', project_id: 'proj-0001', user_id: 'user-anna' });
  s.members.set('m2', { id: 'm2', project_id: 'proj-0001', user_id: 'user-bram' });
  applyCommand(s, { type: 'comment_add', args: { id: 'comm-0002', task_id: 'task-0001', content: '@Bram @Carla', mentions: ['user-bram', 'user-carla'] } }, at(0), 'user-anna');
  assert.deepEqual(s.comments.get('comm-0002').mentions, ['user-bram']);
  applyCommand(s, { type: 'comment_update', args: { id: 'comm-0002', content: '@Carla', mentions: ['user-carla', 'user-anna'] } }, at(0), 'user-anna');
  assert.deepEqual(s.comments.get('comm-0002').mentions, ['user-anna']);
  applyCommand(s, { type: 'comment_add', args: { id: 'comm-0003', project_id: 'proj-0001', content: 'zonder' } }, at(0), 'user-anna');
  assert.deepEqual(s.comments.get('comm-0003').mentions, []);
});

test('de vingerafdruk voor de Android-app verandert als er een melding bijkomt of gelezen wordt', () => {
  const s = state();
  const a = reminderFingerprint(s, 'user-anna');
  applyCommand(s, { type: 'notification_update', args: { id: 'n-mention', is_read: true } }, at(0), 'user-anna');
  const b = reminderFingerprint(s, 'user-anna');
  assert.notEqual(a, b);
  applyCommand(s, { type: 'notification_update', args: { id: 'n-other', is_read: true } }, at(0), 'user-bram');
  assert.equal(reminderFingerprint(s, 'user-anna'), b, 'een melding van een ander telt niet');
});

// ---------- samen met de echte server ----------

function client(db, user) {
  const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
  const transport = async (body) => JSON.parse(JSON.stringify(handleSync(db, JSON.parse(JSON.stringify(body)), user.id)));
  const sync = new SyncClient({ store, transport, onCommandErrors: () => {} });
  let k = 0;
  const actions = createActions(store, { makeId: () => `${user.username}-id-${String(++k).padStart(6, '0')}`, makeUuid: () => `${user.username}-uuid-${String(++k).padStart(6, '0')}` });
  return { store, sync, actions };
}

test('met de server: Bram noemt Anna; Anna ziet de melding, zet hem gelezen, en hij verdwijnt met de opmerking', async () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  const a = client(db, anna);
  const b = client(db, bram);
  await a.store.init();
  await b.store.init();
  await a.sync.syncNow();
  const P = await a.actions.addProject({ name: 'Gezin' });
  await a.actions.shareProject(P, 'bram');
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.deepEqual(inboxItems(b.store.view, { userId: bram.id, userName: (id) => b.store.userName(id) }).map((x) => x.kind), ['shared']);
  const commentId = await b.actions.addComment({ projectId: P }, 'Hoi @Anna, kom je?', [anna.id]);
  await b.sync.syncNow();
  await a.sync.syncNow();
  let items = inboxItems(a.store.view, { userId: anna.id, userName: (id) => a.store.userName(id) });
  assert.deepEqual(items.map((x) => [x.kind, x.actor, x.read]), [['mention', 'Bram', false]]);
  await a.actions.markNotificationRead(items[0].id);
  assert.equal(unreadCount(inboxItems(a.store.view, { userId: anna.id, userName: () => null })), 0, 'meteen gelezen, ook zonder verbinding');
  await a.sync.syncNow();
  assert.equal(a.store.base.notifications.get(items[0].id).is_read, true, 'de server bevestigt het');
  await b.actions.deleteComment(commentId);
  await b.sync.syncNow();
  await a.sync.syncNow();
  items = inboxItems(a.store.view, { userId: anna.id, userName: () => null });
  assert.deepEqual(items, [], 'de opmerking is weg, de melding ook');
  assert.equal(a.store.base.notifications.size, 0);
});

test('met de server: wie uit het project gaat, houdt geen meldingen erover over (ook niet in de lokale opslag)', async () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  const b = client(db, bram);
  await b.store.init();
  const P = 'proj-weg-00001';
  const r = handleSync(db, { commands: [
    { type: 'project_add', uuid: 'weg-uuid-00001', args: { id: P, name: 'Weg' } },
    { type: 'project_share', uuid: 'weg-uuid-00002', args: { project_id: P, username: 'bram' } },
    { type: 'task_add', uuid: 'weg-uuid-00003', args: { id: 'task-weg-00001', project_id: P, content: 'Voor Bram', assignee_id: bram.id } },
  ] }, anna.id);
  assert.ok(Object.values(r.sync_status).every((s) => s === 'ok'));
  await b.sync.syncNow();
  assert.equal(b.store.base.notifications.size, 2);
  handleSync(db, { commands: [{ type: 'project_unshare', uuid: 'weg-uuid-00004', args: { project_id: P, user_id: bram.id } }] }, anna.id);
  await b.sync.syncNow();
  assert.equal(b.store.base.notifications.size, 0);
  const again = new Store(b.store.adapter);
  await again.init();
  assert.equal(again.base.notifications.size, 0, 'ook niet na een herstart');
});
