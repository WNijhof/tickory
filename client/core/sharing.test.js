// Twee echte clients (elk met eigen opslag en wachtrij) tegen dezelfde server-engine: samenwerken in gedeelde projecten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { RESOURCES } from './reducer.js';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { isForeignLabel, isShared, membersOf, projectList, roleIn } from './selectors.js';

let counter = 0;

function world() {
  const db = freshDb();
  const users = { alice: addUser(db, 'alice', 'Alice'), bob: addUser(db, 'bob', 'Bob'), carol: addUser(db, 'carol', 'Carol') };
  const clients = {};
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
    return { name, user, store, sync, actions, errors };
  };
  for (const name of Object.keys(users)) clients[name] = make(name);
  return { db, users, ...clients };
}

async function start(...cs) {
  for (const c of cs) {
    await c.store.init();
    assert.equal(await c.sync.syncNow(), true);
  }
}
const names = (c, resource, key = 'content') => [...c.store.view[resource].values()].map((r) => r[key]).sort();
/** Vergelijkbare momentopname zonder tijdstempels en zonder het (door de server gekozen) id van ledenrijen. */
function snapshot(view) {
  const out = {};
  for (const r of RESOURCES) {
    out[r] = [...view[r].values()]
      .map(({ created_at, updated_at, completed_at, ...rest }) => ({ ...rest, completed: Boolean(completed_at) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  out.members = out.members.map(({ id, ...rest }) => rest).sort((a, b) => (`${a.project_id}/${a.user_id}` < `${b.project_id}/${b.user_id}` ? -1 : 1));
  return out;
}

/** Voert een handeling uit en controleert dat wat de gebruiker direct zag klopt met wat de server daarna bevestigt. */
async function settles(c, action) {
  await action();
  const optimistic = snapshot(c.store.view);
  assert.equal(await c.sync.syncNow(), true);
  assert.equal(c.store.queueLength, 0);
  assert.deepEqual(snapshot(c.store.view), optimistic, 'wat direct te zien was, is ook wat de server bevestigde');
}

test('de gebruiker is bekend na de eerste sync, met de Inbox van de gebruiker zelf', async () => {
  const w = world();
  await start(w.alice, w.bob);
  assert.equal(w.alice.store.me.username, 'alice');
  assert.equal(w.alice.store.me.inbox_project_id, w.users.alice.inbox_project_id);
  assert.notEqual(w.alice.store.me.inbox_project_id, w.bob.store.me.inbox_project_id);
  assert.deepEqual(names(w.alice, 'projects', 'name'), ['Inbox']);
  assert.deepEqual(w.alice.store.users.map((u) => u.username), ['alice'], 'bob is onzichtbaar zolang jullie niets delen');
  // taken in de eigen Inbox
  await settles(w.alice, () => w.alice.actions.addTask({ content: 'Tandarts', project_id: w.alice.store.me.inbox_project_id }));
  assert.deepEqual(names(w.bob, 'tasks'), []);
});

test('delen: de ander krijgt het project met alles erin, en jullie werken in dezelfde taken', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const project = await w.alice.actions.addProject({ name: 'Gezin' });
  await w.alice.actions.addTask({ content: 'Boodschappen', project_id: project });
  await w.alice.sync.syncNow();
  assert.deepEqual(names(w.bob, 'tasks'), []);

  // delen heeft geen optimistisch effect: de leden verschijnen pas als de server het bevestigt
  await w.alice.actions.shareProject(project, 'Bob');
  assert.equal(membersOf(w.alice.store.view, project).length, 1);
  assert.equal(await w.alice.sync.syncNow(), true);
  assert.equal(membersOf(w.alice.store.view, project).length, 2);
  assert.equal(await w.bob.sync.syncNow(), true);
  assert.deepEqual(names(w.bob, 'projects', 'name'), ['Gezin', 'Inbox']);
  assert.deepEqual(names(w.bob, 'tasks'), ['Boodschappen']);
  assert.equal(roleIn(w.bob.store.view, project, w.bob.user.id), 'member');
  assert.equal(roleIn(w.bob.store.view, project, w.alice.user.id), 'owner');
  assert.equal(isShared(w.bob.store.view, project), true);
  assert.deepEqual(w.bob.store.users.map((u) => u.name), ['Alice', 'Bob']);
  assert.equal(w.bob.store.userName(w.alice.user.id), 'Alice');

  // bob werkt mee; alice ziet het na haar volgende sync, beide kanten kloppen met de server
  const created = await w.bob.actions.addTask({ content: 'Pannen kopen', project_id: project, assignee_id: w.alice.user.id });
  await w.bob.sync.syncNow();
  assert.deepEqual(w.bob.errors, []);
  await w.alice.sync.syncNow();
  const task = w.alice.store.view.tasks.get(created);
  assert.equal(task.creator_id, w.bob.user.id);
  assert.equal(task.assignee_id, w.alice.user.id);
  await settles(w.alice, () => w.alice.actions.completeTask(created));
  await w.bob.sync.syncNow();
  assert.equal(w.bob.store.view.tasks.get(created).checked, true);

  // de maker van een taak is in de eigen weergave al direct bekend
  const mine = await w.bob.actions.addTask({ content: 'Direct zichtbaar', project_id: project });
  assert.equal(w.bob.store.view.tasks.get(mine).creator_id, w.bob.user.id);
});

test('eruit gehaald of zelf vertrokken: het project en alles eraan verdwijnt lokaal, ook zonder aparte meldingen', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const project = await w.alice.actions.addProject({ name: 'Samen' });
  const task = await w.alice.actions.addTask({ content: 'Gedeelde taak', project_id: project });
  await w.alice.actions.shareProject(project, 'bob');
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  await w.bob.actions.addTask({ content: 'Subtaak van bob', project_id: project, parent_id: task });
  await w.bob.sync.syncNow();
  assert.equal(w.bob.errors.length, 0);
  assert.ok(w.bob.store.view.projects.has(project));
  const sectionId = await w.alice.actions.addSection(project, 'Sectie');
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  assert.ok(w.bob.store.view.sections.has(sectionId));

  await w.alice.actions.unshareProject(project, w.bob.user.id);
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  const v = w.bob.store.view;
  assert.deepEqual([...v.projects.keys()], [w.bob.user.id && w.users.bob.inbox_project_id]);
  for (const r of ['sections', 'tasks', 'comments', 'reminders']) assert.equal(v[r].size, 0, r);
  assert.deepEqual(membersOf(v, project), []);
  assert.deepEqual(names(w.alice, 'tasks'), ['Gedeelde taak', 'Subtaak van bob']);
  assert.equal(membersOf(w.alice.store.view, project).length, 1);

  // en weer uitnodigen werkt, en vertrekken ook
  await w.alice.actions.shareProject(project, 'bob');
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  assert.deepEqual(names(w.bob, 'tasks'), ['Gedeelde taak', 'Subtaak van bob']);
  await w.bob.actions.leaveProject(project);
  await w.bob.sync.syncNow();
  assert.deepEqual(w.bob.errors, []);
  assert.equal(w.bob.store.view.tasks.size, 0);
  assert.equal(w.bob.store.view.projects.has(project), false);
});

test('een taak die naar een project verhuist dat de ander niet ziet, verdwijnt bij de ander (geen spooktaak)', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const shared = await w.alice.actions.addProject({ name: 'Samen' });
  const task = await w.alice.actions.addTask({ content: 'Verhuist', project_id: shared });
  await w.alice.actions.addTask({ content: 'Onderdeel', project_id: shared, parent_id: task });
  await w.alice.actions.shareProject(shared, 'bob');
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  const rem = await w.bob.actions.addReminder?.call?.(null);
  void rem;
  assert.deepEqual(names(w.bob, 'tasks'), ['Onderdeel', 'Verhuist']);

  await settles(w.alice, () => w.alice.actions.moveTask(task, { project_id: w.alice.store.me.inbox_project_id }));
  await w.bob.sync.syncNow();
  assert.deepEqual(names(w.bob, 'tasks'), [], 'ook de subtaak is weg');
  assert.deepEqual(names(w.alice, 'tasks'), ['Onderdeel', 'Verhuist']);
});

test('alleen de eigenaar verwijdert een project: bij een lid verandert niets en de melding is begrijpelijk', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const project = await w.alice.actions.addProject({ name: 'Van Alice' });
  await w.alice.actions.shareProject(project, 'bob');
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();

  await w.bob.actions.deleteProject(project);
  assert.ok(w.bob.store.view.projects.has(project), 'niet eens kort verdwenen in beeld');
  await w.bob.sync.syncNow();
  assert.equal(w.bob.errors.length, 1);
  assert.equal(w.bob.errors[0].error_code, 'FORBIDDEN');
  assert.ok(w.bob.store.view.projects.has(project));
  // delen met iemand die niet bestaat
  await w.alice.actions.shareProject(project, 'bestaat-niet');
  await w.alice.sync.syncNow();
  assert.equal(w.alice.errors[0].error_code, 'NOT_FOUND');
  assert.equal(w.alice.errors[0].error, 'deze gebruiker bestaat niet');
});

test('wat in een gedeeld project met een eigen subproject wordt verwijderd: de eigenaar neemt alleen het zijne mee', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const root = await w.alice.actions.addProject({ name: 'Huis' });
  await w.alice.actions.shareProject(root, 'bob');
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  const privateProject = await w.bob.actions.addProject({ name: 'Privé van bob' });
  await w.bob.actions.updateProject(privateProject, { parent_id: root });
  await w.bob.sync.syncNow();
  assert.deepEqual(w.bob.errors, []);
  await w.alice.sync.syncNow();
  assert.equal(w.alice.store.view.projects.has(privateProject), false, 'alice ziet het niet');

  await settles(w.alice, () => w.alice.actions.deleteProject(root));
  await w.bob.sync.syncNow();
  assert.equal(w.bob.store.view.projects.has(root), false);
  assert.equal(w.bob.store.view.projects.get(privateProject).parent_id, null, 'staat nu op het hoogste niveau');
  assert.deepEqual(projectList(w.bob.store.view).map((p) => p.project.name), ['Inbox', 'Privé van bob']);
});

test('labels: je ziet die van een ander op een gedeelde taak, wijzigt alleen je eigen, en je eigen label gaat voor', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const project = await w.alice.actions.addProject({ name: 'Samen' });
  await w.alice.actions.shareProject(project, 'bob');
  const task = await w.alice.actions.addTask({ content: 'Boodschappen', project_id: project, newLabels: ['Winkel'] });
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();

  const label = [...w.bob.store.view.labels.values()].find((l) => l.name === 'Winkel');
  assert.ok(label, 'het label van alice is zichtbaar voor bob');
  assert.equal(isForeignLabel(label, w.bob.user.id), true);
  assert.equal(isForeignLabel(label, w.alice.user.id), false);
  assert.equal(w.bob.store.view.tasks.get(task).labels[0], label.id);

  // bob past het label niet aan
  await w.bob.actions.updateLabel(label.id, { name: 'Gekaapt' });
  assert.equal(w.bob.store.view.labels.get(label.id).name, 'Winkel', 'ook optimistisch niet gewijzigd');
  await w.bob.sync.syncNow();
  assert.deepEqual(w.bob.errors.map((e) => e.error_code), ['FORBIDDEN'], 'de server weigert het ook als de app het toch zou sturen');
  assert.equal(w.bob.store.view.labels.get(label.id).name, 'Winkel');
  w.bob.errors.length = 0;

  // bob heeft zelf geen "Winkel": zet hij het label op een eigen taak, dan wordt het gedeelde label gebruikt
  const own = await w.bob.actions.addTask({ content: 'Eigen', project_id: project });
  await w.bob.actions.setTaskLabels(own, ['winkel']);
  await w.bob.sync.syncNow();
  assert.deepEqual(w.bob.errors, []);
  assert.equal(w.bob.store.view.tasks.get(own).labels[0], label.id);
  // met een eigen label van dezelfde naam gaat dat voor
  // (de server staat een eigen label met dezelfde naam toe; de app zelf zoekt bij een naam eerst een bestaand label)
  await w.bob.store.enqueue([{ type: 'label_add', uuid: 'uuid-own-label-0001', args: { id: 'label-bob-winkel', name: 'Winkel' } }]);
  const ownLabel = w.bob.store.view.labels.get('label-bob-winkel');
  assert.ok(ownLabel, 'bob mag zelf ook een "Winkel" hebben');
  await w.bob.sync.syncNow();
  assert.deepEqual(w.bob.errors, []);
  const later = await w.bob.actions.addTask({ content: 'Later', project_id: project, newLabels: ['WINKEL'] });
  assert.equal(w.bob.store.view.tasks.get(later).labels[0], ownLabel.id);
});

test('herinneringen en filters blijven bij de eigenaar', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const project = await w.alice.actions.addProject({ name: 'Samen' });
  const task = await w.alice.actions.addTask({ content: 'Afspraak', project_id: project });
  await w.alice.actions.shareProject(project, 'bob');
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  const rem = (c, id) => c.store.enqueue([{ type: 'reminder_add', uuid: `uuid-rem-${id}-0001`, args: { id, task_id: task, type: 'relative', minute_offset: 15 } }]).then(() => c.sync.syncNow());
  await rem(w.alice, 'remind-a-00001');
  await rem(w.bob, 'remind-b-00001');
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  assert.deepEqual([...w.alice.store.view.reminders.keys()], ['remind-a-00001']);
  assert.deepEqual([...w.bob.store.view.reminders.keys()], ['remind-b-00001']);
  assert.equal(w.bob.store.view.reminders.get('remind-b-00001').owner_id, w.bob.user.id);
  // uit het project: de eigen herinnering voor die taak is ook weg
  await w.alice.actions.unshareProject(project, w.bob.user.id);
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  assert.equal(w.bob.store.view.reminders.size, 0);
  assert.equal(w.alice.store.view.reminders.size, 1);
});

test('de gebruiker en de namen blijven bewaard over een herstart, ook zonder verbinding', async () => {
  const w = world();
  await start(w.alice);
  const project = await w.alice.actions.addProject({ name: 'Samen' });
  await w.alice.actions.shareProject(project, 'bob');
  await w.alice.sync.syncNow();
  const again = new Store(w.alice.store.adapter, { onPersistError: () => {} });
  await again.init();
  assert.equal(again.me.name, 'Alice');
  assert.deepEqual(again.users.map((u) => u.name), ['Alice', 'Bob']);
  assert.equal(again.userName(w.bob.user.id), 'Bob');
  assert.equal(again.view.members.size, 3);
});

test('opmerkingen op het project zelf verdwijnen mee als je uit het project wordt gehaald', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const project = await w.alice.actions.addProject({ name: 'Samen' });
  await w.alice.actions.shareProject(project, 'bob');
  await w.alice.store.enqueue([{ type: 'comment_add', uuid: 'uuid-project-comment-1', args: { id: 'comment-project-01', project_id: project, content: 'Welkom!' } }]);
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  assert.equal(w.bob.store.view.comments.size, 1);
  assert.equal(w.bob.store.view.comments.get('comment-project-01').author_id, w.alice.user.id);
  await w.alice.actions.unshareProject(project, w.bob.user.id);
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  assert.equal(w.bob.store.view.comments.size, 0);
});

test('een subproject krijgt direct (nog vóór de server antwoordt) dezelfde leden als het bovenliggende project', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const root = await w.alice.actions.addProject({ name: 'Huis' });
  await w.alice.actions.shareProject(root, 'bob');
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  await settles(w.bob, async () => {
    const child = await w.bob.actions.addProject({ name: 'Tuin', parent_id: root });
    const roles = membersOf(w.bob.store.view, child).map((m) => `${m.user_id === w.bob.user.id ? 'bob' : 'alice'}:${m.role}`).sort();
    assert.deepEqual(roles, ['alice:owner', 'bob:owner']);
  });
});

test('een project verwijderen laat een subproject staan waar je geen eigenaar van bent, ook direct in beeld', async () => {
  const w = world();
  await start(w.alice, w.carol);
  const root = await w.alice.actions.addProject({ name: 'Wijk' });
  await w.alice.actions.shareProject(root, 'carol');
  await w.alice.sync.syncNow();
  await w.carol.sync.syncNow();
  const mine = await w.carol.actions.addProject({ name: 'Van Carol' }); // carol is daar eigenaar van
  await w.carol.actions.shareProject(mine, 'alice'); // en deelt het met alice (die lid wordt)
  await w.carol.actions.updateProject(mine, { parent_id: root });
  await w.carol.sync.syncNow();
  await w.alice.sync.syncNow();
  assert.equal(w.alice.store.view.projects.get(mine).parent_id, root, 'alice ziet het project onder het hare');
  assert.equal(roleIn(w.alice.store.view, mine, w.alice.user.id), 'member');

  await settles(w.alice, () => w.alice.actions.deleteProject(root));
  assert.equal(w.alice.store.view.projects.has(root), false);
  assert.equal(w.alice.store.view.projects.get(mine).parent_id, null, 'het project van carol blijft, op het hoogste niveau');
});

test('de reducer: ledenrijen zijn alleen via de eigen commando\'s te wijzigen, en inbox-ids zijn gereserveerd', async () => {
  const { applyCommand, emptyState } = await import('./reducer.js');
  const state = emptyState();
  applyCommand(state, { type: 'member_add', args: { id: 'member-fake-0001', project_id: 'x', user_id: 'y', role: 'owner' } }, 't', 'u1');
  assert.equal(state.members.size, 0);
  applyCommand(state, { type: 'project_add', args: { id: 'inbox-kaping-001', name: 'Nep' } }, 't', 'u1');
  assert.equal(state.projects.size, 0);
  applyCommand(state, { type: 'project_add', args: { id: 'project-echt-001', name: 'Echt' } }, 't', 'u1');
  assert.equal(state.projects.size, 1);
  assert.deepEqual([...state.members.values()].map((m) => [m.project_id, m.user_id, m.role]), [['project-echt-001', 'u1', 'owner']]);
});

test('de store ruimt subtaken op waarvan de bovenliggende taak weg is, ook als de server de subtaak niet apart noemt', async () => {
  const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
  await store.init();
  const row = (extra) => ({ is_deleted: false, created_at: 't', updated_at: 't', ...extra });
  await store.applyResponse({
    full_sync: true, sync_token: '5', partial: false, sync_status: {}, me: { id: 'u1', username: 'a', name: 'A', is_admin: true, inbox_project_id: 'inbox-u1' },
    projects: [row({ id: 'inbox-u1', name: 'Inbox' })],
    tasks: [row({ id: 'taak-ouder-0001', project_id: 'inbox-u1', content: 'ouder' }), row({ id: 'taak-kind-00001', project_id: 'inbox-u1', parent_id: 'taak-ouder-0001', content: 'kind' }),
      row({ id: 'taak-kleinkind1', project_id: 'inbox-u1', parent_id: 'taak-kind-00001', content: 'kleinkind' })],
    comments: [row({ id: 'opm-kleinkind-1', task_id: 'taak-kleinkind1', content: 'x' })],
  });
  assert.equal(store.view.tasks.size, 3);
  await store.applyResponse({ full_sync: false, sync_token: '6', partial: false, sync_status: {}, tasks: [{ id: 'taak-ouder-0001', is_deleted: true }] });
  assert.equal(store.view.tasks.size, 0, 'kind en kleinkind gaan mee');
  assert.equal(store.view.comments.size, 0);
});

test('de store rekent wachtende commando\'s bij elke herberekening met de ingelogde gebruiker', async () => {
  const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
  await store.init();
  store.me = { id: 'u1', username: 'a', name: 'A' };
  await store.enqueue([{ type: 'project_add', uuid: 'uuid-rebuild-00001', args: { id: 'project-rebuild-01', name: 'P' } }]);
  store.rebuild();
  assert.deepEqual([...store.view.members.values()].map((m) => m.user_id), ['u1']);
});

test('de Inbox staat altijd bovenaan in de zijbalk, ook als een ander project een lagere volgordesleutel heeft', async () => {
  const w = world();
  await start(w.alice);
  await w.alice.store.enqueue([{ type: 'project_add', uuid: 'uuid-order-00000001', args: { id: 'project-vooraan-1', name: 'Vooraan', order_key: '5' } }]);
  await w.alice.sync.syncNow();
  const inboxKey = w.alice.store.view.projects.get(w.alice.store.me.inbox_project_id).order_key;
  assert.ok('5' < inboxKey, 'testopzet: het andere project heeft een lagere sleutel');
  assert.deepEqual(projectList(w.alice.store.view).map((p) => p.project.name), ['Inbox', 'Vooraan']);
});
