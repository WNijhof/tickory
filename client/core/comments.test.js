// Opmerkingen: acties, selectors, rechten (alleen de schrijver wijzigt) en de weergave van tekst en tijd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { applyCommand, emptyState } from './reducer.js';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { commentCounts, commentsOf, projectCommentCount } from './selectors.js';
import { linkify } from './commentText.js';
import { timeAgo } from './timeAgo.js';
import { setLanguage } from './i18n.js';

let counter = 0;

function world() {
  const db = freshDb();
  const users = { alice: addUser(db, 'alice', 'Alice'), bob: addUser(db, 'bob', 'Bob') };
  const make = (name) => {
    const user = users[name];
    const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
    const errors = [];
    const transport = async (body) => JSON.parse(JSON.stringify(handleSync(db, JSON.parse(JSON.stringify(body)), user.id)));
    const sync = new SyncClient({ store, transport, onCommandErrors: (e) => errors.push(...e) });
    const actions = createActions(store, {
      makeId: () => `id${String(++counter).padStart(10, '0')}`,
      makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}`,
    });
    return { user, store, sync, actions, errors };
  };
  return { db, users, alice: make('alice'), bob: make('bob') };
}
async function start(...cs) {
  for (const c of cs) {
    await c.store.init();
    assert.equal(await c.sync.syncNow(), true);
  }
}
const texts = (c, target) => commentsOf(c.store.view, target).map((x) => x.content);

test('een opmerking bij een taak: direct zichtbaar, met jou als schrijver, en bevestigd door de server', async () => {
  const w = world();
  await start(w.alice);
  const inbox = w.alice.store.me.inbox_project_id;
  const task = await w.alice.actions.addTask({ content: 'Taak', project_id: inbox });
  const id = await w.alice.actions.addComment({ taskId: task }, '  Eerste opmerking \n met een tweede regel ');
  const shown = w.alice.store.view.comments.get(id);
  assert.equal(shown.content, 'Eerste opmerking \n met een tweede regel', 'omringende witruimte weg, regeleinden blijven');
  assert.equal(shown.author_id, w.users.alice.id, 'de schrijver staat er al voordat de server heeft bevestigd');
  assert.equal(shown.task_id, task);
  assert.equal(shown.project_id, null);
  assert.equal(await w.alice.sync.syncNow(), true);
  assert.deepEqual(w.alice.errors, []);
  const confirmed = w.alice.store.view.comments.get(id);
  assert.equal(confirmed.author_id, w.users.alice.id);
  assert.equal(confirmed.content, 'Eerste opmerking \n met een tweede regel');
});

test('een opmerking bij een project, apart van die bij taken', async () => {
  const w = world();
  await start(w.alice);
  const inbox = w.alice.store.me.inbox_project_id;
  const task = await w.alice.actions.addTask({ content: 'Taak', project_id: inbox });
  await w.alice.actions.addComment({ projectId: inbox }, 'Over het project');
  await w.alice.actions.addComment({ taskId: task }, 'Over de taak');
  assert.deepEqual(texts(w.alice, { projectId: inbox }), ['Over het project']);
  assert.deepEqual(texts(w.alice, { taskId: task }), ['Over de taak']);
  assert.deepEqual(commentsOf(w.alice.store.view, {}), [], 'zonder doel geen opmerkingen');
  assert.equal(projectCommentCount(w.alice.store.view, inbox), 1);
  assert.equal(await w.alice.sync.syncNow(), true);
  assert.deepEqual(w.alice.errors, []);
});

test('bewerken en verwijderen door de schrijver, en de tellers volgen', async () => {
  const w = world();
  await start(w.alice);
  const inbox = w.alice.store.me.inbox_project_id;
  const a = await w.alice.actions.addTask({ content: 'A', project_id: inbox });
  const b = await w.alice.actions.addTask({ content: 'B', project_id: inbox });
  await w.alice.actions.addComment({ projectId: inbox }, 'bij het project: telt niet mee bij de taken');
  const c1 = await w.alice.actions.addComment({ taskId: a }, 'een');
  const c2 = await w.alice.actions.addComment({ taskId: a }, 'twee');
  await w.alice.actions.addComment({ taskId: b }, 'drie');
  assert.deepEqual([...commentCounts(w.alice.store.view)].sort(), [[a, 2], [b, 1]]);
  await w.alice.actions.updateComment(c1, ' aangepast ');
  await w.alice.actions.deleteComment(c2);
  assert.deepEqual(texts(w.alice, { taskId: a }), ['aangepast']);
  assert.equal(commentCounts(w.alice.store.view).get(a), 1);
  const optimistic = JSON.stringify(commentsOf(w.alice.store.view, { taskId: a }).map(({ id, content, author_id }) => ({ id, content, author_id })));
  assert.equal(await w.alice.sync.syncNow(), true);
  assert.deepEqual(w.alice.errors, []);
  assert.equal(JSON.stringify(commentsOf(w.alice.store.view, { taskId: a }).map(({ id, content, author_id }) => ({ id, content, author_id }))), optimistic);
});

test('volgorde: oudste eerst, bij gelijke tijd op id; een taak verwijderen neemt de opmerkingen mee', () => {
  const v = emptyState();
  v.comments.set('c3', { id: 'c3', task_id: 't1', created_at: '2026-11-13T10:00:00.000Z' });
  v.comments.set('c1', { id: 'c1', task_id: 't1', created_at: '2026-11-13T09:00:00.000Z' });
  v.comments.set('c2b', { id: 'c2b', task_id: 't1', created_at: '2026-11-13T09:30:00.000Z' });
  v.comments.set('c2a', { id: 'c2a', task_id: 't1', created_at: '2026-11-13T09:30:00.000Z' });
  v.comments.set('x', { id: 'x', task_id: 't2', created_at: '2026-11-13T08:00:00.000Z' });
  assert.deepEqual(commentsOf(v, { taskId: 't1' }).map((c) => c.id), ['c1', 'c2a', 'c2b', 'c3']);
  assert.deepEqual(commentsOf(v, { taskId: 'onbekend' }), []);
  v.tasks.set('t1', { id: 't1', project_id: 'p1' });
  applyCommand(v, { type: 'task_delete', args: { id: 't1' } }, '2026-11-13T11:00:00.000Z', 'u1');
  assert.deepEqual([...v.comments.keys()], ['x']);
});

test('de optimistische weergave kent dezelfde regels als de server voor opmerkingen', () => {
  const now = '2026-11-13T10:00:00.000Z';
  const v = emptyState();
  v.projects.set('inbox-u1', { id: 'inbox-u1' });
  v.tasks.set('t1', { id: 't1', project_id: 'inbox-u1' });
  const add = (args, user = 'u1') => applyCommand(v, { type: 'comment_add', args }, now, user);
  add({ id: 'c-both-0001', task_id: 't1', project_id: 'inbox-u1', content: 'allebei' });
  add({ id: 'c-none-0001', content: 'geen van beide' });
  add({ id: 'c-gone-0001', task_id: 'bestaat-niet', content: 'taak bestaat niet' });
  add({ id: 'c-gone-0002', project_id: 'bestaat-niet', content: 'project bestaat niet' });
  assert.equal(v.comments.size, 0, 'wat de server weigert, verschijnt ook niet');
  add({ id: 'c-mijn-0001', task_id: 't1', content: 'van u1' });
  assert.equal(v.comments.get('c-mijn-0001').author_id, 'u1');
  // een ander mag jouw opmerking niet wijzigen of verwijderen
  applyCommand(v, { type: 'comment_update', args: { id: 'c-mijn-0001', content: 'overschreven' } }, now, 'u2');
  applyCommand(v, { type: 'comment_delete', args: { id: 'c-mijn-0001' } }, now, 'u2');
  assert.equal(v.comments.get('c-mijn-0001')?.content, 'van u1');
  applyCommand(v, { type: 'comment_update', args: { id: 'c-mijn-0001', content: 'aangepast' } }, now, 'u1');
  assert.equal(v.comments.get('c-mijn-0001').content, 'aangepast');
  // de schrijver en de taak zelf zijn niet te wijzigen
  applyCommand(v, { type: 'comment_update', args: { id: 'c-mijn-0001', author_id: 'u2', task_id: 'ander' } }, now, 'u1');
  assert.equal(v.comments.get('c-mijn-0001').author_id, 'u1');
  assert.equal(v.comments.get('c-mijn-0001').task_id, 't1');
  applyCommand(v, { type: 'comment_delete', args: { id: 'c-mijn-0001' } }, now, 'u1');
  assert.equal(v.comments.size, 0);
});

test('samenwerken: Bob ziet de opmerking van Alice, kan hem niet wijzigen, en beantwoordt hem met een eigen opmerking', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const project = await w.alice.actions.addProject({ name: 'Samen' });
  await w.alice.actions.shareProject(project, 'bob');
  const task = await w.alice.actions.addTask({ content: 'Gedeelde taak', project_id: project });
  const mine = await w.alice.actions.addComment({ taskId: task }, 'Wie pakt dit op?');
  await w.alice.actions.addComment({ projectId: project }, 'Afspraak voor dit project');
  assert.equal(await w.alice.sync.syncNow(), true);
  assert.equal(await w.bob.sync.syncNow(), true);
  assert.deepEqual(texts(w.bob, { taskId: task }), ['Wie pakt dit op?']);
  assert.deepEqual(texts(w.bob, { projectId: project }), ['Afspraak voor dit project']);
  assert.equal(w.bob.store.view.comments.get(mine).author_id, w.users.alice.id);
  // Bob probeert Alice' opmerking te wijzigen en te verwijderen: de client doet niets, en ook de server zou weigeren
  await w.bob.actions.updateComment(mine, 'Bob was hier');
  await w.bob.actions.deleteComment(mine);
  assert.deepEqual(texts(w.bob, { taskId: task }), ['Wie pakt dit op?'], 'optimistisch blijft alles zoals het was');
  assert.equal(w.bob.store.queueLength, 2, 'de commando\'s staan wel in de wachtrij');
  assert.equal(await w.bob.sync.syncNow(), true);
  assert.deepEqual(w.bob.errors.map((e) => e.error_code), ['FORBIDDEN', 'FORBIDDEN']);
  assert.deepEqual(texts(w.bob, { taskId: task }), ['Wie pakt dit op?']);
  // een eigen antwoord kan wel; Alice ziet het
  const reply = await w.bob.actions.addComment({ taskId: task }, 'Ik doe het');
  assert.equal(await w.bob.sync.syncNow(), true);
  assert.equal(await w.alice.sync.syncNow(), true);
  assert.deepEqual(texts(w.alice, { taskId: task }), ['Wie pakt dit op?', 'Ik doe het']);
  assert.equal(w.alice.store.view.comments.get(reply).author_id, w.users.bob.id);
  // Alice kan Bobs opmerking niet verwijderen, maar haar eigen wel
  await w.alice.actions.deleteComment(reply);
  assert.equal(await w.alice.sync.syncNow(), true);
  assert.deepEqual(w.alice.errors.map((e) => e.error_code), ['FORBIDDEN']);
  await w.alice.actions.deleteComment(mine);
  assert.equal(await w.alice.sync.syncNow(), true);
  assert.equal(await w.bob.sync.syncNow(), true);
  assert.deepEqual(texts(w.bob, { taskId: task }), ['Ik doe het']);
  assert.deepEqual(texts(w.alice, { projectId: project }), ['Afspraak voor dit project']);
});

test('Nederlands: accenten en regeleinden in opmerkingen komen precies zo terug (NFC)', async () => {
  const w = world();
  await start(w.alice);
  const inbox = w.alice.store.me.inbox_project_id;
  const id = await w.alice.actions.addComment({ projectId: inbox }, 'Zoë belt morgen\nvoor café');
  assert.equal(w.alice.store.view.comments.get(id).content, 'Zoë belt morgen\nvoor café');
  assert.equal(await w.alice.sync.syncNow(), true);
  assert.equal(w.alice.store.view.comments.get(id).content, 'Zoë belt morgen\nvoor café');
});

// ---------- tekst met webadressen ----------

const plain = (parts) => parts.map((p) => p.text).join('');

test('linkify: een webadres wordt een link, de rest blijft tekst, en samen is het weer de oorspronkelijke tekst', () => {
  const text = 'Zie https://voorbeeld.nl/pad?x=1 en ook http://a.nl voor meer';
  const parts = linkify(text);
  assert.equal(plain(parts), text);
  assert.deepEqual(parts.filter((p) => p.href).map((p) => [p.text, p.href]), [['https://voorbeeld.nl/pad?x=1', 'https://voorbeeld.nl/pad?x=1'], ['http://a.nl', 'http://a.nl/']]);
  assert.deepEqual(linkify('geen link hier'), [{ text: 'geen link hier' }]);
  assert.deepEqual(linkify(''), []);
  assert.deepEqual(linkify(null), []);
});

test('linkify: leestekens aan het eind horen niet bij het adres, haakjes in een adres wel', () => {
  const href = (text) => linkify(text).find((p) => p.href)?.text;
  assert.equal(href('Kijk op https://a.nl/b.'), 'https://a.nl/b');
  assert.equal(href('Is het https://a.nl/b?'), 'https://a.nl/b');
  assert.equal(href('(zie https://a.nl/b)'), 'https://a.nl/b');
  assert.equal(href('https://nl.wikipedia.org/wiki/Tickory_(app) is het'), 'https://nl.wikipedia.org/wiki/Tickory_(app)');
  assert.equal(href('https://a.nl/b, en verder'), 'https://a.nl/b');
  assert.equal(plain(linkify('(zie https://a.nl/b).')), '(zie https://a.nl/b).');
});

test('linkify: alleen http en https; javascript:, data: en adressen zonder host worden nooit een link', () => {
  for (const text of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://a.nl/b', 'file:///etc/passwd', 'https://', 'https:///pad', 'mailto:a@b.nl', 'www.voorbeeld.nl']) {
    assert.equal(linkify(text).some((p) => p.href), false, text);
    assert.equal(plain(linkify(text)), text);
  }
  // HTML in de tekst blijft tekst: de aanroeper zet alles met textContent neer
  const html = '<img src=x onerror=alert(1)> https://a.nl/<b>';
  const parts = linkify(html);
  assert.equal(plain(parts), html);
  assert.ok(parts.every((p) => !p.href || /^https?:\/\//.test(p.href)));
  assert.deepEqual(parts.filter((p) => p.href).map((p) => p.text), ['https://a.nl/'], 'een < hoort niet bij het adres');
  assert.deepEqual(linkify('Zie HTTPS://VOORBEELD.NL/Pad').filter((p) => p.href).map((p) => p.href), ['https://voorbeeld.nl/Pad'], 'ook een adres in hoofdletters');
});

// ---------- hoe lang geleden ----------

test('timeAgo (Nederlands): zojuist, minuten, uren, dagen en daarna de datum', () => {
  setLanguage('nl');
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  const ago = (ms) => timeAgo(new Date(now - ms).toISOString(), now);
  assert.equal(ago(5_000), 'zojuist');
  assert.equal(ago(-30_000), 'zojuist', 'een klok die iets voorloopt');
  assert.equal(ago(59_999), 'zojuist');
  assert.equal(ago(60_000), '1 minuut geleden');
  assert.equal(ago(5 * 60_000), '5 minuten geleden');
  assert.equal(ago(59 * 60_000 + 59_000), '59 minuten geleden');
  assert.equal(ago(3_600_000), '1 uur geleden');
  assert.equal(ago(2 * 3_600_000 + 1000), '2 uur geleden');
  assert.equal(ago(23 * 3_600_000), '23 uur geleden');
  assert.equal(ago(24 * 3_600_000), '1 dag geleden');
  assert.equal(ago(3 * 24 * 3_600_000), '3 dagen geleden');
  assert.equal(ago(6.5 * 24 * 3_600_000), '6 dagen geleden');
  assert.doesNotMatch(ago(7 * 24 * 3_600_000), /geleden/, 'vanaf een week geleden: de datum');
  assert.match(ago(8 * 24 * 3_600_000), /^[a-z]{2} \d{1,2} nov$/);
  assert.equal(timeAgo('geen datum', now), '');
  assert.equal(timeAgo(undefined, now), '');
});

test('timeAgo (Engels): dezelfde stappen in het Engels', () => {
  setLanguage('en');
  try {
    const now = Date.parse('2026-11-13T12:00:00.000Z');
    const ago = (ms) => timeAgo(new Date(now - ms).toISOString(), now);
    assert.equal(ago(5_000), 'just now');
    assert.equal(ago(60_000), '1 minute ago');
    assert.equal(ago(5 * 60_000), '5 minutes ago');
    assert.equal(ago(3_600_000), '1 hour ago');
    assert.equal(ago(2 * 3_600_000), '2 hours ago');
    assert.equal(ago(24 * 3_600_000), '1 day ago');
    assert.equal(ago(4 * 24 * 3_600_000), '4 days ago');
  } finally {
    setLanguage('nl');
  }
});
