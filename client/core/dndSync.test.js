// Slepen en verplaatsen, echte clients tegen de echte server-engine: wat de gebruiker direct ziet is wat de server bevestigt,
// en een verplaatsing die niet mag of niet meer kan, draait netjes terug met een melding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { RESOURCES } from './reducer.js';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { currentTaskPlan, planProjectDrop, planProjectKey, planTaskDrop, planTaskDropOnProject, planTaskKey } from './dnd.js';
import { projectList } from './selectors.js';
import { describeCommandError } from './messages.js';

let counter = 0;

function world(names = ['alice', 'bob']) {
  const db = freshDb();
  const users = Object.fromEntries(names.map((n) => [n, addUser(db, n, n[0].toUpperCase() + n.slice(1))]));
  const clients = {};
  for (const name of names) {
    const user = users[name];
    const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
    const errors = [];
    const net = { online: true };
    const transport = async (body) => {
      if (!net.online) throw new TypeError('fetch failed');
      return JSON.parse(JSON.stringify(handleSync(db, JSON.parse(JSON.stringify(body)), user.id)));
    };
    const sync = new SyncClient({ store, transport, onCommandErrors: (e) => errors.push(...e) });
    const actions = createActions(store, {
      makeId: () => `id${String(++counter).padStart(10, '0')}`,
      makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}`,
    });
    clients[name] = { name, user, store, sync, actions, errors, net };
  }
  return { db, users, ...clients };
}

async function start(...cs) {
  for (const c of cs) {
    await c.store.init();
    assert.equal(await c.sync.syncNow(), true);
  }
}
const snapshot = (view) => {
  const out = {};
  for (const r of RESOURCES) {
    out[r] = [...view[r].values()]
      .map(({ created_at, updated_at, completed_at, ...rest }) => ({ ...rest, completed: Boolean(completed_at) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  out.members = out.members.map(({ id, ...rest }) => rest).sort((a, b) => (`${a.project_id}/${a.user_id}` < `${b.project_id}/${b.user_id}` ? -1 : 1));
  return out;
};
/** Voert een handeling uit en controleert dat wat direct te zien was ook is wat de server daarna bevestigt. */
async function settles(c, action) {
  await action();
  const optimistic = snapshot(c.store.view);
  assert.equal(await c.sync.syncNow(), true);
  assert.equal(c.store.queueLength, 0);
  assert.deepEqual(c.errors, [], 'de server weigerde niets');
  assert.deepEqual(snapshot(c.store.view), optimistic, 'wat direct te zien was, is ook wat de server bevestigde');
}
/** Wat beide gebruikers delen: taken en secties (de Inbox, instellingen en leden zijn van elk apart). */
const shared = (c) => ({ tasks: snapshot(c.store.view).tasks, sections: snapshot(c.store.view).sections });
const sync2 = async (a, b) => { await a.sync.syncNow(); await b.sync.syncNow(); };
/** De taken van een lijst, op volgorde, zoals de app ze toont. */
const order = (c, project_id, section_id = null, parent_id = null) =>
  [...c.store.view.tasks.values()]
    .filter((t) => t.project_id === project_id && (t.section_id ?? null) === section_id && (t.parent_id ?? null) === parent_id)
    .sort((a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : 1))
    .map((t) => t.content);

async function sharedProject(w) {
  await start(w.alice, w.bob);
  const project = await w.alice.actions.addProject({ name: 'Samen' });
  const section = await w.alice.actions.addSection(project, 'Later');
  const ids = {};
  for (const name of ['een', 'twee', 'drie', 'vier']) ids[name] = await w.alice.actions.addTask({ content: name, project_id: project });
  ids.sectie = await w.alice.actions.addTask({ content: 'in sectie', project_id: project, section_id: section });
  await w.alice.actions.shareProject(project, 'bob');
  await sync2(w.alice, w.bob);
  return { project, section, ids };
}

test('slepen in een gedeeld project: lid en eigenaar zien dezelfde volgorde, ook bij subtaken en een andere sectie', async () => {
  const w = world();
  const { project, section, ids } = await sharedProject(w);
  const move = (c, plan, id) => settles(c, () => c.actions.moveTask(id, plan));
  // bob (lid) zet "vier" bovenaan en "twee" onder "drie"
  await move(w.bob, planTaskDrop(w.bob.store.view, { dragId: ids.vier, overId: ids.een, zone: 'before' }), ids.vier);
  await move(w.bob, planTaskDrop(w.bob.store.view, { dragId: ids.twee, overId: ids.drie, zone: 'child' }), ids.twee);
  await w.alice.sync.syncNow();
  assert.deepEqual(order(w.alice, project), ['vier', 'een', 'drie']);
  assert.deepEqual(order(w.alice, project, null, ids.drie), ['twee']);
  assert.deepEqual(snapshot(w.alice.store.view).tasks, snapshot(w.bob.store.view).tasks);
  // alice zet "drie" (met subtaak) naar de sectie, vóór "in sectie"
  await move(w.alice, planTaskDrop(w.alice.store.view, { dragId: ids.drie, overId: ids.sectie, zone: 'before' }), ids.drie);
  await w.bob.sync.syncNow();
  assert.deepEqual(order(w.bob, project, section), ['drie', 'in sectie']);
  assert.equal(w.bob.store.view.tasks.get(ids.twee).section_id, section, 'de subtaak volgt');
  // de subtaak er weer uit slepen, naast zijn ouder
  await move(w.bob, planTaskDrop(w.bob.store.view, { dragId: ids.twee, overId: ids.drie, zone: 'after' }), ids.twee);
  await w.alice.sync.syncNow();
  assert.deepEqual(order(w.alice, project, section), ['drie', 'twee', 'in sectie']);
});

test('slepen op een project in de zijbalk: de taak verdwijnt bij wie dat project niet ziet, en komt op de nieuwe plek bij wie wel', async () => {
  const w = world();
  const { project, ids } = await sharedProject(w);
  const second = await w.alice.actions.addProject({ name: 'Tweede' });
  await w.alice.actions.shareProject(second, 'bob');
  const private_ = await w.alice.actions.addProject({ name: 'Privé' });
  await sync2(w.alice, w.bob);
  await w.alice.actions.addTask({ content: 'sub van twee', project_id: project, parent_id: ids.twee });
  await w.alice.sync.syncNow();
  // naar het tweede (ook gedeelde) project: bob ziet de taak daar
  await settles(w.alice, () => w.alice.actions.moveTask(ids.twee, planTaskDropOnProject(w.alice.store.view, { dragId: ids.twee, projectId: second })));
  await w.bob.sync.syncNow();
  assert.deepEqual(order(w.bob, second), ['twee']);
  assert.deepEqual(order(w.bob, second, null, ids.twee), ['sub van twee']);
  assert.deepEqual(order(w.bob, project), ['een', 'drie', 'vier']);
  // naar het privéproject van alice: bob krijgt de taak (en subtaak) als verwijderd, geen spook
  await settles(w.alice, () => w.alice.actions.moveTask(ids.twee, planTaskDropOnProject(w.alice.store.view, { dragId: ids.twee, projectId: private_ })));
  await w.bob.sync.syncNow();
  assert.equal(w.bob.store.view.tasks.has(ids.twee), false);
  assert.equal([...w.bob.store.view.tasks.values()].some((t) => t.content === 'sub van twee'), false);
  assert.deepEqual(order(w.bob, project), ['een', 'drie', 'vier']);
});

test('een toegewezen taak naar een project slepen waar die persoon geen lid van is: de toewijzing vervalt meteen en op de server', async () => {
  const w = world();
  const { project, ids } = await sharedProject(w);
  await w.alice.actions.assignTask(ids.een, w.bob.user.id);
  const mine = await w.alice.actions.addProject({ name: 'Alleen ik' });
  await w.alice.sync.syncNow();
  assert.equal(w.alice.store.view.tasks.get(ids.een).assignee_id, w.bob.user.id);
  await w.alice.actions.addTask({ content: 'sub', project_id: project, parent_id: ids.een });
  await w.alice.actions.assignTask([...w.alice.store.view.tasks.values()].find((t) => t.content === 'sub').id, w.bob.user.id);
  await w.alice.sync.syncNow();
  await settles(w.alice, async () => {
    await w.alice.actions.moveTask(ids.een, planTaskDropOnProject(w.alice.store.view, { dragId: ids.een, projectId: mine }));
    assert.equal(w.alice.store.view.tasks.get(ids.een).assignee_id, null, 'direct al leeg');
    assert.deepEqual([...w.alice.store.view.tasks.values()].filter((t) => t.project_id === mine).map((t) => t.assignee_id), [null, null], 'ook de subtaak');
  });
  // binnen een gedeeld project blijft de toewijzing staan
  await settles(w.alice, async () => {
    await w.alice.actions.assignTask(ids.vier, w.bob.user.id);
    await w.alice.actions.moveTask(ids.vier, planTaskDrop(w.alice.store.view, { dragId: ids.vier, overId: ids.twee, zone: 'before' }));
    assert.equal(w.alice.store.view.tasks.get(ids.vier).assignee_id, w.bob.user.id);
  });
});

test('een taak die een ander net heeft verwijderd of weggehaald, laat zich niet meer verplaatsen: terugdraaien met een duidelijke melding', async () => {
  const w = world();
  const { project, section, ids } = await sharedProject(w);
  w.bob.net.online = false;
  // bob verplaatst offline: "drie" onder "een", "vier" naar de sectie
  await w.bob.actions.moveTask(ids.drie, planTaskDrop(w.bob.store.view, { dragId: ids.drie, overId: ids.een, zone: 'child' }));
  await w.bob.actions.moveTask(ids.vier, { project_id: project, section_id: section, beforeId: null });
  assert.deepEqual(order(w.bob, project, null, ids.een), ['drie']);
  // intussen verwijdert alice "een" (met zijn subtaken) en de sectie
  await w.alice.actions.deleteTask(ids.een);
  await w.alice.actions.deleteSection(section);
  await w.alice.sync.syncNow();
  w.bob.net.online = true;
  await w.bob.sync.syncNow();
  assert.deepEqual(w.bob.errors.map((e) => e.error_code).sort(), ['NOT_FOUND', 'NOT_FOUND']);
  assert.ok(w.bob.errors.every((e) => e.cmd.type === 'task_move'));
  for (const e of w.bob.errors) assert.match(describeCommandError(e), /^Niet gelukt \(taak verplaatsen\)/);
  assert.equal(w.bob.store.queueLength, 0);
  assert.deepEqual(shared(w.bob), shared(w.alice), 'beide zien dezelfde toestand');
  assert.equal(w.bob.store.view.tasks.get(ids.drie).parent_id, null, 'drie staat weer waar het stond, niet onder een verdwenen taak');
  assert.equal(w.bob.store.view.tasks.get(ids.vier).section_id, null, 'vier ook: de sectie bestaat niet meer');
});

test('twee mensen verplaatsen tegelijk elkaars taak onder elkaar: één lukt, de ander draait terug (CYCLE), geen kring', async () => {
  const w = world();
  const { ids } = await sharedProject(w);
  w.alice.net.online = false;
  w.bob.net.online = false;
  await w.alice.actions.moveTask(ids.een, planTaskDrop(w.alice.store.view, { dragId: ids.een, overId: ids.twee, zone: 'child' }));
  await w.bob.actions.moveTask(ids.twee, planTaskDrop(w.bob.store.view, { dragId: ids.twee, overId: ids.een, zone: 'child' }));
  w.bob.net.online = true;
  await w.bob.sync.syncNow(); // bob komt eerst
  w.alice.net.online = true;
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  assert.deepEqual(w.alice.errors.map((e) => e.error_code), ['CYCLE']);
  assert.match(describeCommandError(w.alice.errors[0]), /niet in zichzelf/);
  assert.deepEqual(shared(w.alice), shared(w.bob));
  assert.equal(w.alice.store.view.tasks.get(ids.twee).parent_id, ids.een);
  assert.equal(w.alice.store.view.tasks.get(ids.een).parent_id, null);
});

test('gelijke volgordesleutels (twee apparaten voegen offline achteraan toe): slepen ertussen werkt en geeft dezelfde volgorde overal', async () => {
  const w = world(['alice']);
  await start(w.alice);
  const inbox = w.alice.user.inbox_project_id;
  // een tweede apparaat van alice op dezelfde server
  const second = (() => {
    const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
    const errors = [];
    const sync = new SyncClient({ store, transport: async (body) => JSON.parse(JSON.stringify(handleSync(w.db, JSON.parse(JSON.stringify(body)), w.alice.user.id))), onCommandErrors: (e) => errors.push(...e) });
    const actions = createActions(store, { makeId: () => `id${String(++counter).padStart(10, '0')}`, makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}` });
    return { store, sync, actions, errors };
  })();
  await second.store.init();
  await second.sync.syncNow();
  await w.alice.actions.addTask({ content: 'telefoon', project_id: inbox });
  await second.actions.addTask({ content: 'laptop', project_id: inbox });
  await second.actions.addTask({ content: 'laptop 2', project_id: inbox });
  await w.alice.sync.syncNow();
  await second.sync.syncNow();
  await w.alice.sync.syncNow();
  const keys = [...w.alice.store.view.tasks.values()].filter((t) => t.project_id === inbox).map((t) => t.order_key);
  assert.ok(new Set(keys).size < keys.length, 'de proef heeft echt gelijke sleutels nodig');
  const ids = Object.fromEntries([...w.alice.store.view.tasks.values()].map((t) => [t.content, t.id]));
  const shown = order(w.alice, inbox);
  assert.equal(shown.length, 3);
  // elke taak overal tussen zetten, in elke richting: geen uitzondering, wel dezelfde uitkomst als de server
  for (const dragged of shown) {
    for (const over of shown.filter((n) => n !== dragged)) {
      for (const zone of ['before', 'after']) {
        const plan = planTaskDrop(w.alice.store.view, { dragId: ids[dragged], overId: ids[over], zone });
        if (!plan) continue;
        await settles(w.alice, () => w.alice.actions.moveTask(ids[dragged], plan));
        const names = order(w.alice, inbox);
        const i = names.indexOf(over);
        assert.equal(names[zone === 'before' ? i - 1 : i + 1], dragged, `${dragged} ${zone} ${over}: ${names}`);
      }
    }
  }
  await second.sync.syncNow();
  assert.deepEqual(snapshot(second.store.view), snapshot(w.alice.store.view));
});

test('projecten slepen: volgorde en subproject gaan door de server; alleen de eigenaar mag, leden zien dat niet als mogelijkheid', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const a = await w.alice.actions.addProject({ name: 'A' });
  const b = await w.alice.actions.addProject({ name: 'B' });
  const c = await w.alice.actions.addProject({ name: 'C' });
  await w.alice.actions.shareProject(b, 'bob');
  await sync2(w.alice, w.bob);
  const names = (cl) => projectList(cl.store.view).map((x) => `${'-'.repeat(x.depth)}${x.project.name}`);
  assert.deepEqual(names(w.alice), ['Inbox', 'A', 'B', 'C']);
  const me = w.alice.user.id;
  // C vóór A; B onder A; daarna weer eruit, bovenaan
  await settles(w.alice, () => w.alice.actions.moveProject(c, planProjectDrop(w.alice.store.view, { dragId: c, overId: a, zone: 'before', userId: me })));
  assert.deepEqual(names(w.alice), ['Inbox', 'C', 'A', 'B']);
  await settles(w.alice, () => w.alice.actions.moveProject(b, planProjectDrop(w.alice.store.view, { dragId: b, overId: a, zone: 'child', userId: me })));
  assert.deepEqual(names(w.alice), ['Inbox', 'C', 'A', '-B']);
  await w.bob.sync.syncNow();
  assert.deepEqual(names(w.bob), ['Inbox', 'B'], 'bob ziet alleen B, en omdat A voor hem bestaat niet staat B bovenaan');
  assert.equal(w.bob.store.view.projects.get(b).parent_id, a, 'wel met de verwijzing naar A, die hij niet ziet');
  await settles(w.alice, () => w.alice.actions.moveProject(b, { parent_id: null, beforeId: null }));
  assert.deepEqual(names(w.alice), ['Inbox', 'C', 'A', 'B']);
  // bob (lid van B) kan B niet slepen: geen plan, en doet hij het toch via de actie, dan weigert de server en draait het terug
  const bobId = w.bob.user.id;
  await w.bob.sync.syncNow();
  assert.equal(planProjectDrop(w.bob.store.view, { dragId: b, overId: w.bob.user.inbox_project_id, zone: 'after', userId: bobId }), null);
  assert.equal(planProjectKey(w.bob.store.view, b, 'up', { userId: bobId }).blocked, 'denied');
  const own = await w.bob.actions.addProject({ name: 'Van bob' });
  await w.bob.actions.updateProject(b, { parent_id: own }); // wat de interface nooit aanbiedt
  assert.equal(w.bob.store.view.projects.get(b).parent_id, null, 'ook direct niet doorgevoerd');
  await w.bob.sync.syncNow();
  assert.deepEqual(w.bob.errors.map((e) => e.error_code), ['FORBIDDEN']);
  assert.match(describeCommandError(w.bob.errors[0]), /eigenaar/i);
  assert.equal(w.bob.store.view.projects.get(b).parent_id, null);
});

test('projecten slepen: cirkels en de Inbox als bovenliggende worden door de server geweigerd én door de optimistische toestand niet doorgevoerd', async () => {
  const w = world(['alice']);
  await start(w.alice);
  const a = await w.alice.actions.addProject({ name: 'A' });
  const b = await w.alice.actions.addProject({ name: 'B', parent_id: a });
  await w.alice.sync.syncNow();
  const inbox = w.alice.user.inbox_project_id;
  const before = snapshot(w.alice.store.view);
  await w.alice.actions.updateProject(a, { parent_id: b }); // cirkel
  await w.alice.actions.updateProject(a, { parent_id: a }); // in zichzelf
  await w.alice.actions.updateProject(b, { parent_id: inbox }); // onder de Inbox
  await w.alice.actions.updateProject(inbox, { parent_id: a }); // de Inbox verplaatsen
  await w.alice.actions.updateProject(b, { parent_id: 'bestaat-niet-0001' });
  assert.deepEqual(snapshot(w.alice.store.view), before, 'direct niets veranderd');
  await w.alice.sync.syncNow();
  assert.deepEqual(w.alice.errors.map((e) => e.error_code), ['CYCLE', 'CYCLE', 'CONFLICT', 'CONFLICT', 'NOT_FOUND']);
  assert.deepEqual(snapshot(w.alice.store.view), before);
});

test('taak verplaatsen: wat de server weigert, doet de optimistische toestand ook niet (cirkel, sectie van een ander project, ander project, onbekend argument, ongeldige sleutel)', async () => {
  const w = world(['alice']);
  await start(w.alice);
  const home = w.alice.user.inbox_project_id;
  const other = await w.alice.actions.addProject({ name: 'Ander' });
  const otherSection = await w.alice.actions.addSection(other, 'Sectie');
  const t1 = await w.alice.actions.addTask({ content: 't1', project_id: home });
  const t2 = await w.alice.actions.addTask({ content: 't2', project_id: home, parent_id: t1 });
  const t3 = await w.alice.actions.addTask({ content: 't3', project_id: home });
  const o1 = await w.alice.actions.addTask({ content: 'o1', project_id: other });
  await w.alice.sync.syncNow();
  const before = snapshot(w.alice.store.view);
  const bad = [
    { id: t1, parent_id: t2 }, // cirkel
    { id: t1, parent_id: t1 },
    { id: t3, section_id: otherSection }, // sectie van een ander project
    { id: t3, parent_id: o1 }, // ouder in een ander project
    { id: t3, project_id: 'bestaat-niet-0001' },
    { id: t3, parent_id: 'bestaat-niet-0001' },
    { id: t2, section_id: otherSection }, // een subtaak volgt haar ouder
    { id: t3, project_id: home, order_key: 'geen sleutel!' },
    { id: t3, project_id: home, onzin: 1 },
    { id: t3 },
  ];
  await w.alice.store.enqueue(bad.map((args, i) => ({ type: 'task_move', uuid: `uuid-bad-move-${i}-0001`, args })));
  assert.deepEqual(snapshot(w.alice.store.view), before, 'direct niets veranderd');
  await w.alice.sync.syncNow();
  assert.equal(w.alice.errors.length, bad.length, 'de server weigerde ze allemaal');
  assert.deepEqual(snapshot(w.alice.store.view), before);
});

test('slepen met het toetsenbord: stap voor stap omhoog, omlaag, in en uit, tot een andere sectie; dezelfde uitkomst als de server', async () => {
  const w = world(['alice']);
  await start(w.alice);
  const project = await w.alice.actions.addProject({ name: 'Klus' });
  const s1 = await w.alice.actions.addSection(project, 'Eerst');
  const s2 = await w.alice.actions.addSection(project, 'Daarna');
  const ids = {};
  for (const n of ['a', 'b', 'c']) ids[n] = await w.alice.actions.addTask({ content: n, project_id: project });
  ids.d = await w.alice.actions.addTask({ content: 'd', project_id: project, section_id: s1 });
  ids.e = await w.alice.actions.addTask({ content: 'e', project_id: project, section_id: s2 });
  await w.alice.sync.syncNow();
  const steps = [['c', 'up'], ['c', 'up'], ['c', 'up'], ['a', 'down'], ['a', 'indent'], ['b', 'indent'], ['b', 'outdent'], ['c', 'down'], ['c', 'down'], ['c', 'down'], ['c', 'up']];
  for (const [name, command] of steps) {
    const r = planTaskKey(w.alice.store.view, ids[name], command);
    if (r.blocked) continue;
    await settles(w.alice, () => w.alice.actions.moveTask(ids[name], r.plan));
    const t = w.alice.store.view.tasks.get(ids[name]);
    const sibs = order(w.alice, project, t.section_id ?? null, t.parent_id ?? null);
    assert.equal(sibs.indexOf(name) + 1, r.position, `${name} ${command}`);
  }
  // de uitkomst is een geldige boom: elke taak staat nog in dit project
  assert.equal([...w.alice.store.view.tasks.values()].filter((t) => t.project_id === project).length, 5);
  assert.equal(currentTaskPlan(w.alice.store.view, ids.c).project_id, project);
});
