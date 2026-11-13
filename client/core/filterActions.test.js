// Filters als data en labels hernoemen en opruimen: de acties en overzichten, getest met echte clients tegen de server-engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { filterList, labelList } from './selectors.js';
import { compileFilter, evaluateFilter } from './filter.js';

let counter = 0;
const NOW = new Date(2026, 10, 11, 9, 0);

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
    return { name, user, store, sync, actions, errors };
  };
  return { db, alice: make('alice'), bob: make('bob') };
}
async function start(...cs) {
  for (const c of cs) {
    await c.store.init();
    assert.equal(await c.sync.syncNow(), true);
  }
}
const ctxOf = (c) => ({ view: c.store.view, now: NOW, userId: c.user.id, users: c.store.users });

// ---------- filters ----------

test('filters: toevoegen, wijzigen en verwijderen; de server bevestigt wat de gebruiker direct zag', async () => {
  const w = world();
  await start(w.alice);
  const a = w.alice;
  const id = await a.actions.addFilter({ name: '  Belangrijk  ', query: ' p1 & vandaag ', color: 'red' });
  const id2 = await a.actions.addFilter({ name: 'Later', query: '7 dagen' });
  // direct zichtbaar, op volgorde van toevoegen, en getrimd
  const before = filterList(a.store.view, a.user.id);
  assert.deepEqual(before.map((f) => [f.id, f.name, f.query, f.color]), [[id, 'Belangrijk', 'p1 & vandaag', 'red'], [id2, 'Later', '7 dagen', 'charcoal']]);
  assert.ok(before[0].order_key < before[1].order_key);
  assert.equal(await a.sync.syncNow(), true);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(filterList(a.store.view, a.user.id).map((f) => [f.id, f.name, f.query, f.color, f.owner_id]), [[id, 'Belangrijk', 'p1 & vandaag', 'red', a.user.id], [id2, 'Later', '7 dagen', 'charcoal', a.user.id]]);

  await a.actions.updateFilter(id, { name: ' Heel belangrijk ', query: 'p1 | p2', is_favorite: true });
  assert.deepEqual(filterList(a.store.view, a.user.id).map((f) => [f.name, f.query, f.is_favorite]), [['Heel belangrijk', 'p1 | p2', true], ['Later', '7 dagen', false]]);
  await a.actions.updateFilter(id2, { color: 'blue' });
  assert.equal(await a.sync.syncNow(), true);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(filterList(a.store.view, a.user.id).map((f) => f.color), ['red', 'blue']);

  await a.actions.deleteFilter(id);
  assert.deepEqual(filterList(a.store.view, a.user.id).map((f) => f.id), [id2]);
  assert.equal(await a.sync.syncNow(), true);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(filterList(a.store.view, a.user.id).map((f) => f.id), [id2]);
});

test('filters: een filter dat niet compileert wordt wel bewaard; bij het tonen is er een duidelijke fout', async () => {
  const w = world();
  await start(w.alice);
  const a = w.alice;
  const broken = ['p1 &', '(vandaag', '#Bestaatniet', 'onzin', 'p1 p2', '31-02'];
  const ids = [];
  for (const query of broken) ids.push(await a.actions.addFilter({ name: `Filter ${query}`, query }));
  assert.equal(await a.sync.syncNow(), true);
  assert.deepEqual(a.errors, [], 'de server weigert niets');
  assert.deepEqual(filterList(a.store.view, a.user.id).map((f) => f.query).sort(), [...broken].sort());
  for (const f of filterList(a.store.view, a.user.id)) {
    const r = evaluateFilter(f.query, ctxOf(a));
    assert.equal(r.ok, false, f.query);
    assert.equal(typeof r.error.message, 'string');
    assert.ok(r.error.position >= 0);
  }
  // later verder werken: herstellen
  await a.actions.updateFilter(ids[0], { query: 'p1 & vandaag' });
  assert.equal(await a.sync.syncNow(), true);
  assert.deepEqual(a.errors, []);
  const fixed = filterList(a.store.view, a.user.id).find((f) => f.id === ids[0]);
  assert.equal(evaluateFilter(fixed.query, ctxOf(a)).ok, true);
  // en de lijst blijft na een herstart van de client hetzelfde
  const again = new Store(a.store.adapter, { onPersistError: () => {} });
  await again.init();
  assert.equal(filterList(again.view, a.user.id).length, broken.length);
});

test('filters: een filter werkt op de eigen taken, projecten en labels', async () => {
  const w = world();
  await start(w.alice);
  const a = w.alice;
  const project = await a.actions.addProject({ name: 'Thuis' });
  await a.actions.addTask({ content: 'Melk halen', project_id: project, priority: 1, due: { date: '2026-11-11' }, newLabels: ['boodschap'] });
  await a.actions.addTask({ content: 'Brood halen', project_id: project, due: { date: '2026-11-12' }, newLabels: ['boodschap'] });
  await a.actions.addTask({ content: 'Plint zagen', project_id: project });
  await a.sync.syncNow();
  const run = (query) => evaluateFilter(query, ctxOf(a));
  assert.deepEqual(run('#Thuis & @boodschap & p1').tasks.map((t) => t.content), ['Melk halen']);
  assert.deepEqual(run('zoek: halen').tasks.map((t) => t.content), ['Melk halen', 'Brood halen']);
  assert.deepEqual(run('geen datum').tasks.map((t) => t.content), ['Plint zagen']);
  assert.deepEqual(run('Vandaag: vandaag, Later: na: vandaag').groups.map((g) => [g.name, g.tasks.map((t) => t.content)]), [['Vandaag', ['Melk halen']], ['Later', ['Brood halen']]]);
  const task = [...a.store.view.tasks.values()].find((t) => t.content === 'Melk halen');
  await a.actions.completeTask(task.id);
  assert.deepEqual(run('#Thuis & @boodschap').tasks.map((t) => t.content), ['Brood halen']);
  assert.deepEqual(run('#Thuis & @boodschap & (completed | !completed)').tasks.map((t) => t.content), ['Melk halen', 'Brood halen']);
});

test('filters: ieder ziet alleen de eigen filters', async () => {
  const w = world();
  await start(w.alice, w.bob);
  await w.alice.actions.addFilter({ name: 'Van Alice', query: 'p1' });
  await w.bob.actions.addFilter({ name: 'Van Bob', query: 'p2' });
  await w.alice.sync.syncNow();
  await w.bob.sync.syncNow();
  assert.deepEqual(filterList(w.alice.store.view, w.alice.user.id).map((f) => f.name), ['Van Alice']);
  assert.deepEqual(filterList(w.bob.store.view, w.bob.user.id).map((f) => f.name), ['Van Bob']);
  // een filter van een ander in de toestand (zou niet moeten) wordt niet getoond
  w.alice.store.view.filters.set('x', { id: 'x', name: 'Vreemd', query: 'p3', owner_id: w.bob.user.id, order_key: 'a' });
  assert.deepEqual(filterList(w.alice.store.view, w.alice.user.id).map((f) => f.name), ['Van Alice']);
});

test('filterList: op volgorde van order_key', () => {
  const view = { filters: new Map([['b', { id: 'b', order_key: 'b', owner_id: 'u' }], ['a', { id: 'a', order_key: 'a', owner_id: 'u' }], ['c', { id: 'c', order_key: 'a', owner_id: 'u' }]]) };
  assert.deepEqual(filterList(view, 'u').map((f) => f.id), ['a', 'c', 'b']);
});

// ---------- labels hernoemen ----------

test('label hernoemen: nieuwe naam direct zichtbaar en door de server bevestigd', async () => {
  const w = world();
  await start(w.alice);
  const a = w.alice;
  const id = await a.actions.addLabel('bellen');
  await a.sync.syncNow();
  const queue = a.store.queueLength;
  assert.deepEqual(await a.actions.renameLabel(id, '  Telefoon  '), { ok: true });
  assert.equal(a.store.view.labels.get(id).name, 'Telefoon');
  assert.equal(a.store.queueLength, queue + 1);
  assert.equal(await a.sync.syncNow(), true);
  assert.deepEqual(a.errors, []);
  assert.equal(a.store.view.labels.get(id).name, 'Telefoon');
});

test('label hernoemen: alleen de hoofdletters wijzigen mag, dezelfde naam doet niets', async () => {
  const w = world();
  await start(w.alice);
  const a = w.alice;
  const id = await a.actions.addLabel('bellen');
  await a.sync.syncNow();
  assert.deepEqual(await a.actions.renameLabel(id, 'Bellen'), { ok: true });
  assert.equal(a.store.view.labels.get(id).name, 'Bellen');
  assert.equal(await a.sync.syncNow(), true);
  assert.deepEqual(a.errors, []);
  const queue = a.store.queueLength;
  assert.deepEqual(await a.actions.renameLabel(id, 'Bellen'), { ok: true });
  assert.equal(a.store.queueLength, queue, 'niets verstuurd');
});

test('label hernoemen: een dubbele naam geeft een fout en er wordt niets verstuurd', async () => {
  const w = world();
  await start(w.alice);
  const a = w.alice;
  const bellen = await a.actions.addLabel('bellen');
  const cafe = await a.actions.addLabel('Café');
  await a.sync.syncNow();
  const dup = { ok: false, code: 'DUPLICATE', message: 'Er bestaat al een label met die naam.' };
  const queue = a.store.queueLength;
  for (const name of ['Café', 'CAFÉ', 'café', 'Cafe\u0301', '  café  ', 'CAFE\u0301']) assert.deepEqual(await a.actions.renameLabel(bellen, name), dup, name);
  assert.deepEqual(await a.actions.renameLabel(cafe, 'BELLEN'), dup);
  assert.equal(a.store.queueLength, queue, 'niets in de wachtrij');
  assert.equal(a.store.view.labels.get(bellen).name, 'bellen', 'de toestand is niet veranderd');
  // zonder accent is het een ander label
  assert.deepEqual(await a.actions.renameLabel(bellen, 'cafe'), { ok: true });
  assert.equal(await a.sync.syncNow(), true);
  assert.deepEqual(a.errors, []);
});

test('label hernoemen: de controle in de client komt overeen met de server', async () => {
  const w = world();
  await start(w.alice);
  const a = w.alice;
  const x = await a.actions.addLabel('x');
  for (const n of ['Café', 'één', 'Zoë', 'naïef', 'Ijs']) await a.actions.addLabel(n);
  await a.sync.syncNow();
  let accepted = 0;
  let rejected = 0;
  for (const name of ['CAFÉ', 'cafe\u0301', 'Cafe', 'ÉÉN', 'EEN', 'zoë', 'zoe\u0308', 'ZOE', 'NAÏEF', 'naief', 'IJS', 'ijs', 'ĳs', 'x', 'X', 'y', 'twee woorden', 'één  woord', ' één ']) {
    const result = await a.actions.renameLabel(x, name);
    // wat de client toestaat, accepteert de server ook; wat de client weigert, weigert de server ook
    // een geweigerde naam sturen we zelf naar de server: ook die moet hem weigeren (wat de client toestond is al verstuurd)
    if (!result.ok) await a.store.enqueue([{ type: 'label_update', uuid: `probe-${++counter}`, args: { id: x, name: name.normalize('NFC').trim() } }]);
    const sync = await a.sync.syncNow();
    assert.equal(sync, true);
    const rejectedByServer = a.errors.length > 0;
    assert.equal(rejectedByServer, !result.ok, `${name}: client ${result.ok ? 'staat toe' : 'weigert'}, server ${rejectedByServer ? 'weigert' : 'staat toe'}`);
    if (result.ok) accepted++;
    else rejected++;
    a.errors.length = 0;
    // terug naar een veilige naam
    const back = `terug${accepted}${rejected}`;
    await a.actions.renameLabel(x, back);
    await a.sync.syncNow();
    a.errors.length = 0;
  }
  assert.ok(accepted >= 5 && rejected >= 8, `beide kanten getest (${accepted} toegestaan, ${rejected} geweigerd)`);
});

test('label hernoemen: ongeldige namen, onbekend label en label van een ander', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const a = w.alice;
  const id = await a.actions.addLabel('bellen');
  const project = await a.actions.addProject({ name: 'Gezin' });
  await a.sync.syncNow();
  await a.actions.shareProject(project, 'bob');
  await a.sync.syncNow();
  await w.bob.sync.syncNow();
  await w.bob.actions.addTask({ content: 'Iets', project_id: project, newLabels: ['bobslabel'] });
  await w.bob.sync.syncNow();
  await a.sync.syncNow();
  const foreign = [...a.store.view.labels.values()].find((l) => l.name === 'bobslabel');
  assert.ok(foreign, 'alice ziet het label van bob');
  const queue = a.store.queueLength;
  assert.equal((await a.actions.renameLabel(foreign.id, 'mijn')).code, 'READONLY');
  assert.equal((await a.actions.renameLabel('bestaat-niet', 'x')).code, 'NOT_FOUND');
  for (const bad of ['', '   ', 'a,b', 'x'.repeat(101), '\u0001', null, undefined]) {
    const r = await a.actions.renameLabel(id, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.code, 'INVALID_ARG');
    assert.ok(r.message.length > 5);
  }
  assert.equal(a.store.queueLength, queue, 'niets verstuurd');
  // dezelfde naam als een label van iemand anders mag wel (het zijn aparte lijsten)
  assert.deepEqual(await a.actions.renameLabel(id, 'bobslabel'), { ok: true });
  assert.equal(await a.sync.syncNow(), true);
  assert.deepEqual(a.errors, []);
});

// ---------- labellijst met aantallen ----------

test('labelList: aantal open taken per label, eigen labels eerst, labels van anderen apart', async () => {
  const w = world();
  await start(w.alice, w.bob);
  const a = w.alice;
  const project = await a.actions.addProject({ name: 'Gezin' });
  const lBellen = await a.actions.addLabel('bellen');
  const lLeeg = await a.actions.addLabel('leeg');
  const lKlus = await a.actions.addLabel('klus');
  await a.actions.addTask({ content: 'a', project_id: project, labels: [lBellen, lKlus] });
  await a.actions.addTask({ content: 'b', project_id: project, labels: [lBellen] });
  const done = await a.actions.addTask({ content: 'c', project_id: project, labels: [lBellen] });
  await a.actions.completeTask(done);
  await a.sync.syncNow();
  await a.actions.shareProject(project, 'bob');
  await a.sync.syncNow();
  await w.bob.sync.syncNow();
  await w.bob.actions.addTask({ content: 'd', project_id: project, newLabels: ['extern'] });
  await w.bob.actions.addTask({ content: 'e', project_id: project, newLabels: ['extern'] });
  await w.bob.sync.syncNow();
  await a.sync.syncNow();

  const list = labelList(a.store.view, a.user.id);
  assert.deepEqual(list.own.map((x) => [x.label.name, x.openCount]), [['bellen', 2], ['leeg', 0], ['klus', 1]], 'op volgorde van aanmaken; afgevinkt telt niet');
  assert.deepEqual(list.others.map((x) => [x.label.name, x.openCount]), [['extern', 2]]);
  assert.equal(list.others[0].label.owner_id, w.bob.user.id);
  // bob ziet zijn eigen label bij zich, het label van alice niet
  const bobs = labelList(w.bob.store.view, w.bob.user.id);
  assert.deepEqual(bobs.own.map((x) => [x.label.name, x.openCount]), [['extern', 2]]);
  assert.deepEqual(bobs.others.map((x) => [x.label.name, x.openCount]), [['bellen', 2], ['klus', 1]]);

  // opruimen: een label dat nergens meer op staat verwijderen
  await a.actions.deleteLabel(lLeeg);
  assert.deepEqual(labelList(a.store.view, a.user.id).own.map((x) => x.label.name), ['bellen', 'klus']);
  // en verwijderen haalt het label van de taken af, dus de aantallen kloppen
  await a.actions.deleteLabel(lBellen);
  assert.deepEqual(labelList(a.store.view, a.user.id).own.map((x) => [x.label.name, x.openCount]), [['klus', 1]]);
  assert.equal(await a.sync.syncNow(), true);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(labelList(a.store.view, a.user.id).own.map((x) => [x.label.name, x.openCount]), [['klus', 1]]);
  // hernoemen verandert de aantallen niet
  await a.actions.renameLabel(lKlus, 'klussen');
  assert.deepEqual(labelList(a.store.view, a.user.id).own.map((x) => [x.label.name, x.openCount]), [['klussen', 1]]);
});

test('labelList: zonder gebruiker (voor de eerste sync) zijn alle labels eigen; een taak zonder labelveld telt niet', () => {
  const view = {
    labels: new Map([['l', { id: 'l', name: 'a', order_key: 'a' }]]),
    tasks: new Map([['t', { id: 't', checked: false }], ['u', { id: 'u', checked: false, labels: ['l'] }]]),
  };
  assert.deepEqual(labelList(view, null).own.map((x) => x.openCount), [1]);
  assert.deepEqual(labelList(view, null).others, []);
});

test('label hernoemen: dezelfde naam in een andere Unicode-vorm is dezelfde naam en wordt niet verstuurd', async () => {
  const w = world();
  await start(w.alice);
  const a = w.alice;
  const id = await a.actions.addLabel('Zoë');
  await a.sync.syncNow();
  const queue = a.store.queueLength;
  assert.deepEqual(await a.actions.renameLabel(id, 'Zoe\u0308'), { ok: true });
  assert.equal(a.store.queueLength, queue);
  assert.equal(a.store.view.labels.get(id).name, 'Zoë');
});

test('filter wijzigen: naam en tekst worden getrimd, andere velden blijven zoals opgegeven', async () => {
  const w = world();
  await start(w.alice);
  const a = w.alice;
  const id = await a.actions.addFilter({ name: 'x', query: 'p1' });
  await a.actions.updateFilter(id, { name: ' Nieuw ', query: ' p2 ', color: 'blue' });
  const f = filterList(a.store.view, a.user.id)[0];
  assert.deepEqual([f.name, f.query, f.color], ['Nieuw', 'p2', 'blue']);
  await a.actions.updateFilter(id, { is_favorite: true });
  const g = filterList(a.store.view, a.user.id)[0];
  assert.deepEqual([g.name, g.query, g.is_favorite], ['Nieuw', 'p2', true]);
  assert.equal(await a.sync.syncNow(), true);
  assert.deepEqual(a.errors, []);
});

test('compileFilter en de acties delen geen verborgen toestand', () => {
  // een filter wordt telkens opnieuw gecompileerd: dezelfde tekst, twee keer, hetzelfde resultaat
  const ctx = { view: { projects: new Map(), tasks: new Map([['t', { id: 't', priority: 1 }]]) }, now: NOW };
  const first = compileFilter('p1', ctx);
  const second = compileFilter('p1', ctx);
  assert.equal(first.match({ priority: 1 }), second.match({ priority: 1 }));
});
