// De client-kern tegen de echte server-engine (in het geheugen, zonder netwerk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { firstUser, mkdb } from '../../server/testutil.ts';
import { INBOX_ID } from '../../shared/schema.js';
import { RESOURCES } from './reducer.js';
import { MemoryAdapter, Store } from './store.js';
import { AuthError, HttpError, SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { planProjectDrop, planProjectDropToTop, planProjectKey, planTaskDrop, planTaskDropOnGroup, planTaskDropOnProject, planTaskKey } from './dnd.js';

/** Een server met één account ("tester") dat de Inbox "inbox-project" heeft; de client logt daar impliciet mee in. */
const makeServer = mkdb;

let counter = 0;
function makeClient(db, { adapter = new MemoryAdapter(), batchSize } = {}) {
  let clock = Date.parse('2026-11-13T10:00:00Z');
  const store = new Store(adapter, { now: () => new Date((clock += 1000)).toISOString(), onPersistError: () => {} });
  const net = { online: true, loseResponse: false, calls: 0, sizes: [], maxCommands: Infinity, db };
  const transport = async (body) => {
    net.calls += 1;
    net.sizes.push(body.commands.length);
    if (!net.online) throw new TypeError('fetch failed');
    if (body.commands.length > net.maxCommands) throw new HttpError(413);
    const res = handleSync(net.db, JSON.parse(JSON.stringify(body)), firstUser(net.db).id);
    if (net.loseResponse) {
      net.loseResponse = false;
      throw new TypeError('verbinding verbroken');
    }
    return JSON.parse(JSON.stringify(res));
  };
  const errors = [];
  const sync = new SyncClient({ store, transport, onCommandErrors: (e) => errors.push(...e), ...(batchSize ? { batchSize } : {}) });
  const actions = createActions(store, {
    makeId: () => `id${String(++counter).padStart(10, '0')}`,
    makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}`,
  });
  return { adapter, store, net, sync, actions, errors };
}

/** Vergelijkbare momentopname: zonder tijdstempels (die verschillen per definitie tussen client en server). */
function snapshot(view) {
  const out = {};
  for (const r of RESOURCES) {
    out[r] = [...view[r].values()]
      .map(({ created_at, updated_at, completed_at, ...rest }) => ({ ...rest, completed: Boolean(completed_at) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  // Het id van een ledenrij kiest de server; vergelijk leden dus op project, gebruiker en rol.
  out.members = out.members.map(({ id, ...rest }) => rest).sort((a, b) => (`${a.project_id}/${a.user_id}` < `${b.project_id}/${b.user_id}` ? -1 : 1));
  return out;
}
const serverRev = (db) => Number(db.prepare("SELECT value FROM meta WHERE key = 'rev'").get().value);
const taskNames = (view) => [...view.tasks.values()].map((t) => t.content).sort();

test('eerste sync: de Inbox komt binnen en het token wordt bewaard', async () => {
  const c = makeClient(makeServer());
  await c.store.init();
  assert.equal(c.store.token, '*');
  assert.equal(await c.sync.syncNow(), true);
  assert.equal(c.store.view.projects.get(INBOX_ID).name, 'Inbox');
  assert.equal(c.store.token, '2');
  assert.equal(c.store.me.username, 'tester', 'de server meldt wie je bent');
  assert.equal(c.store.userId, c.store.me.id);
  assert.equal(c.store.userName(c.store.userId), 'Tester');
  assert.equal(c.store.view.members.size, 1);
  const again = new Store(c.adapter);
  await again.init();
  assert.equal(again.token, '2');
  assert.equal(again.me.username, 'tester', 'ook na een herstart bekend, zonder verbinding');
  assert.equal(again.view.projects.size, 1);
});

test('offline toevoegen: direct zichtbaar, blijft in de wachtrij, komt later aan zonder verschil', async () => {
  const db = makeServer();
  const c = makeClient(db);
  await c.store.init();
  await c.sync.syncNow();
  c.net.online = false;
  const id = await c.actions.addTask({ content: 'Melk halen', project_id: INBOX_ID, priority: 2 });
  assert.equal(c.store.view.tasks.get(id).content, 'Melk halen', 'meteen zichtbaar');
  assert.equal(await c.sync.syncNow(), false);
  assert.equal(c.sync.state, 'offline');
  assert.equal(c.store.queueLength, 1);
  const optimistic = snapshot(c.store.view);

  c.net.online = true;
  assert.equal(await c.sync.syncNow(), true);
  assert.equal(c.sync.state, 'idle');
  assert.equal(c.store.queueLength, 0);
  assert.deepEqual(snapshot(c.store.view), optimistic, 'de server kwam op precies dezelfde toestand uit');
  assert.deepEqual(c.errors, []);
});

test('antwoord verloren: opnieuw versturen geeft geen dubbele taak', async () => {
  const db = makeServer();
  const c = makeClient(db);
  await c.store.init();
  await c.sync.syncNow();
  await c.actions.addTask({ content: 'Eén keer', project_id: INBOX_ID });
  c.net.loseResponse = true;
  assert.equal(await c.sync.syncNow(), false, 'de server voerde het uit, maar het antwoord kwam niet aan');
  const rev = serverRev(db);
  assert.equal(c.store.queueLength, 1);
  assert.equal(await c.sync.syncNow(), true);
  assert.equal(serverRev(db), rev, 'de herhaling veranderde niets op de server');
  assert.equal(c.store.queueLength, 0);
  assert.deepEqual(taskNames(c.store.view), ['Eén keer']);
  const fresh = makeClient(db);
  await fresh.store.init();
  await fresh.sync.syncNow();
  assert.deepEqual(taskNames(fresh.store.view), ['Eén keer']);
});

test('twee apparaten komen op dezelfde toestand uit', async () => {
  const db = makeServer();
  const a = makeClient(db);
  const b = makeClient(db);
  for (const c of [a, b]) { await c.store.init(); await c.sync.syncNow(); }
  const p = await a.actions.addProject({ name: 'Thuis' });
  const t = await a.actions.addTask({ content: 'Stofzuigen', project_id: p });
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.equal(b.store.view.tasks.get(t).content, 'Stofzuigen');
  await b.actions.completeTask(t);
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.equal(a.store.view.tasks.get(t).checked, true);
  assert.deepEqual(snapshot(a.store.view), snapshot(b.store.view));
});

test('een wijziging van een ander apparaat overschrijft mijn nog niet verstuurde wijziging niet', async () => {
  const db = makeServer();
  const a = makeClient(db);
  const b = makeClient(db);
  for (const c of [a, b]) { await c.store.init(); await c.sync.syncNow(); }
  const t = await a.actions.addTask({ content: 'Origineel', project_id: INBOX_ID });
  await a.sync.syncNow();
  await b.sync.syncNow();

  await a.actions.updateTask(t, { content: 'Van A' }); // nog niet verstuurd
  await b.actions.updateTask(t, { priority: 1 });
  await b.sync.syncNow();

  // de delta van B komt binnen terwijl A's wijziging nog in de wachtrij staat
  const delta = handleSync(db, { sync_token: a.store.token }, firstUser(db).id);
  await a.store.applyResponse(JSON.parse(JSON.stringify(delta)));
  assert.equal(a.store.queueLength, 1);
  assert.equal(a.store.view.tasks.get(t).content, 'Van A', 'mijn wijziging blijft zichtbaar');
  assert.equal(a.store.view.tasks.get(t).priority, 1, 'en die van B is overgenomen');

  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.deepEqual(snapshot(a.store.view), snapshot(b.store.view));
  assert.equal(b.store.view.tasks.get(t).content, 'Van A');
  assert.equal(b.store.view.tasks.get(t).priority, 1);
});

test('door de server geweigerd: de wijziging verdwijnt en de fout wordt gemeld', async () => {
  const db = makeServer();
  const a = makeClient(db);
  const b = makeClient(db);
  for (const c of [a, b]) { await c.store.init(); await c.sync.syncNow(); }
  const t = await a.actions.addTask({ content: 'Verdwijnt', project_id: INBOX_ID });
  await a.sync.syncNow();
  await b.sync.syncNow();
  await b.actions.deleteTask(t);
  await b.sync.syncNow();

  await a.actions.updateTask(t, { content: 'Te laat' });
  assert.equal(a.store.view.tasks.get(t).content, 'Te laat');
  assert.equal(await a.sync.syncNow(), true);
  assert.equal(a.store.view.tasks.has(t), false);
  assert.equal(a.store.queueLength, 0);
  assert.equal(a.errors.length, 1);
  assert.equal(a.errors[0].error_code, 'NOT_FOUND');
  assert.equal(a.errors[0].cmd.type, 'task_update');
});

test('herstart: wachtrij en gegevens overleven, en de sync gaat daarna gewoon door', async () => {
  const db = makeServer();
  const first = makeClient(db);
  await first.store.init();
  await first.sync.syncNow();
  first.net.online = false;
  const t = await first.actions.addTask({ content: 'Bewaard', project_id: INBOX_ID });

  const second = makeClient(db, { adapter: first.adapter }); // zelfde opslag, nieuw proces
  await second.store.init();
  assert.equal(second.store.queueLength, 1);
  assert.equal(second.store.view.tasks.get(t).content, 'Bewaard');
  assert.equal(await second.sync.syncNow(), true);
  assert.equal(second.store.queueLength, 0);
  const other = makeClient(db);
  await other.store.init();
  await other.sync.syncNow();
  assert.deepEqual(taskNames(other.store.view), ['Bewaard']);
});

test('bewaren mislukt na een geslaagde sync: na herstart geen verlies en geen dubbel effect', async () => {
  const db = makeServer();
  const c = makeClient(db);
  await c.store.init();
  await c.sync.syncNow();
  await c.actions.addTask({ content: 'Robuust', project_id: INBOX_ID });
  c.adapter.failNextCommit = true; // het antwoord wordt wel verwerkt, maar niet bewaard
  assert.equal(await c.sync.syncNow(), true);
  assert.deepEqual(taskNames(c.store.view), ['Robuust']);

  const restarted = makeClient(db, { adapter: c.adapter });
  await restarted.store.init();
  assert.equal(restarted.store.queueLength, 1, 'het commando staat nog in de bewaarde wachtrij');
  const rev = serverRev(db);
  assert.equal(await restarted.sync.syncNow(), true);
  assert.equal(serverRev(db), rev);
  assert.deepEqual(taskNames(restarted.store.view), ['Robuust']);
  assert.equal(restarted.store.queueLength, 0);
});

test('server teruggezet (token loopt vooruit): volledige sync vervangt de lokale kopie, de wachtrij blijft', async () => {
  const c = makeClient(makeServer());
  await c.store.init();
  await c.actions.addTask({ content: 'Oud', project_id: INBOX_ID });
  await c.actions.addProject({ name: 'Oud project' });
  await c.sync.syncNow();
  assert.equal(c.store.token, '4');

  c.net.db = makeServer(); // verse server
  c.net.online = false;
  await c.actions.addTask({ content: 'Nieuw', project_id: INBOX_ID });
  c.net.online = true;
  assert.equal(await c.sync.syncNow(), true);
  assert.deepEqual(taskNames(c.store.view), ['Nieuw'], 'oude rijen zijn weg, de wachtende taak is aangekomen');
  assert.deepEqual([...c.store.view.projects.keys()], [INBOX_ID]);
  const reloaded = new Store(c.adapter);
  await reloaded.init();
  assert.deepEqual(taskNames(reloaded.view), ['Nieuw'], 'ook de bewaarde kopie is vervangen');
});

test('grote wachtrij gaat in porties van honderd', async () => {
  const c = makeClient(makeServer());
  await c.store.init();
  for (let i = 0; i < 250; i++) await c.actions.addTask({ content: `Taak ${i}`, project_id: INBOX_ID });
  assert.equal(await c.sync.syncNow(), true);
  assert.deepEqual(c.net.sizes, [100, 100, 50]);
  assert.equal(c.store.view.tasks.size, 250);
  assert.equal(c.store.queueLength, 0);
});

test('te groot verzoek (413): de client probeert kleinere porties', async () => {
  const c = makeClient(makeServer());
  await c.store.init();
  c.net.maxCommands = 3;
  for (let i = 0; i < 10; i++) await c.actions.addTask({ content: `Taak ${i}`, project_id: INBOX_ID });
  assert.equal(await c.sync.syncNow(), true);
  assert.equal(c.store.queueLength, 0);
  assert.equal(c.store.view.tasks.size, 10);
  assert.ok(c.net.sizes.includes(10) && c.net.sizes.includes(5), c.net.sizes.join(','));
});

test('401 geeft de toestand "unauthorized" en laat de wachtrij staan', async () => {
  const c = makeClient(makeServer());
  await c.store.init();
  await c.actions.addTask({ content: 'Wacht', project_id: INBOX_ID });
  c.sync.transport = async () => { throw new AuthError(); };
  assert.equal(await c.sync.syncNow(), false);
  assert.equal(c.sync.state, 'unauthorized');
  assert.equal(c.store.queueLength, 1);
});

test('een verzoek dat nooit antwoord krijgt wordt afgebroken: de client komt weer vrij en herstelt', async () => {
  const db = makeServer();
  const c = makeClient(db);
  await c.store.init();
  await c.actions.addTask({ content: 'Blijft hangen', project_id: INBOX_ID });
  const real = c.sync.transport;
  let signalSeen = null;
  c.sync.timeoutMs = 60;
  c.sync.transport = (body, { signal }) => {
    signalSeen = signal;
    return new Promise(() => {}); // antwoordt nooit, reageert ook niet op afbreken
  };
  const started = Date.now();
  assert.equal(await c.sync.syncNow(), false);
  assert.ok(Date.now() - started < 1000, 'binnen de tijdslimiet klaar');
  assert.equal(c.sync.state, 'offline');
  assert.match(c.sync.lastError.message, /geen antwoord binnen/);
  assert.equal(signalSeen.aborted, true, 'het verzoek is ook echt afgebroken');
  assert.equal(c.store.queueLength, 1, 'de wijziging wacht nog');

  c.sync.transport = real; // de verbinding is weer gezond
  assert.equal(await c.sync.syncNow(), true);
  assert.equal(c.store.queueLength, 0);
  assert.deepEqual(taskNames(c.store.view), ['Blijft hangen']);
});

test('de transportlaag geeft een afbreeksignaal door aan fetch', async () => {
  const { httpTransport } = await import('./syncClient.js');
  let seen;
  const transport = httpTransport({
    getToken: () => 't', clientId: 'c',
    fetch: async (url, init) => { seen = init; return new Response('{"sync_token":"1"}', { status: 200 }); },
  });
  const controller = new AbortController();
  await transport({ sync_token: '*' }, { signal: controller.signal });
  assert.equal(seen.signal, controller.signal);
  assert.equal(seen.headers.Authorization, 'Bearer t');
});

test('gelijktijdige aanvragen lopen na elkaar; een aanvraag tijdens een sync levert een extra ronde op', async () => {
  const c = makeClient(makeServer());
  await c.store.init();
  const p1 = c.sync.syncNow();
  const p2 = c.sync.syncNow();
  assert.equal(p1, p2, 'dezelfde lopende sync');
  await p1;
  assert.equal(c.net.calls, 2, 'één ronde plus de aangevraagde extra ronde');
});

test('requestSync: aanvragen worden samengevoegd; na een netwerkfout volgt een nieuwe poging met oplopende wachttijd', async () => {
  const c = makeClient(makeServer());
  await c.store.init();
  const scheduled = [];
  c.sync.timers = {
    setTimeout: (fn, ms) => { scheduled.push({ fn, ms, cancelled: false }); return scheduled.length - 1; },
    clearTimeout: (id) => { scheduled[id].cancelled = true; },
  };
  c.sync.requestSync();
  c.sync.requestSync();
  c.sync.requestSync();
  assert.equal(scheduled.filter((s) => !s.cancelled).length, 1, 'drie aanvragen, één geplande sync');

  c.net.online = false;
  await scheduled.at(-1).fn();
  assert.equal(c.sync.state, 'offline');
  assert.equal(scheduled.at(-1).ms, 2000, 'eerste herhaling na 2 seconden');
  await scheduled.at(-1).fn();
  assert.equal(scheduled.at(-1).ms, 4000);
  c.net.online = true;
  await scheduled.at(-1).fn();
  assert.equal(c.sync.state, 'idle');
  assert.equal(scheduled.filter((s) => !s.cancelled).length, 3, 'na succes geen nieuwe poging gepland');
});

test('Nederlands: hetzelfde label in andere hoofdletters of accentvorm wordt hergebruikt, niet dubbel aangemaakt', async () => {
  const db = makeServer();
  const c = makeClient(db);
  await c.store.init();
  await c.actions.addTask({ content: 'Eerste', project_id: INBOX_ID, newLabels: ['Café'] });
  await c.actions.addTask({ content: 'Tweede', project_id: INBOX_ID, newLabels: ['CAFÉ', 'café', 'café'] });
  assert.equal(c.store.view.labels.size, 1, 'optimistisch: één label');
  assert.equal(await c.sync.syncNow(), true);
  assert.deepEqual(c.errors, [], 'de server weigerde niets');
  const fresh = makeClient(db);
  await fresh.store.init();
  await fresh.sync.syncNow();
  assert.deepEqual([...fresh.store.view.labels.values()].map((l) => l.name), ['Café']);
  const tasks = [...fresh.store.view.tasks.values()];
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((t) => t.labels.length === 1 && t.labels[0] === [...fresh.store.view.labels.keys()][0]));
  // en een taak met een ontleed getypte naam komt als NFC aan
  await c.actions.addTask({ content: 'Café bezoeken', project_id: INBOX_ID });
  await c.sync.syncNow();
  assert.ok([...c.store.view.tasks.values()].some((t) => t.content === 'Café bezoeken'));
  assert.deepEqual(c.errors, []);
});

test('Nederlands: wat optimistisch in beeld staat is al in NFC, precies zoals de server het bewaart', async () => {
  const c = makeClient(makeServer());
  await c.store.init();
  await c.sync.syncNow(); // eerst de Inbox ophalen
  c.net.online = false; // daarna: alleen de lokale toestand telt
  const id = await c.actions.addTask({ content: 'Café bezoeken', project_id: INBOX_ID, description: 'Zoë komt ook' });
  let t = c.store.view.tasks.get(id);
  assert.equal(t.content, 'Café bezoeken');
  assert.equal(t.content.length, 'Café bezoeken'.length, 'één teken voor é, niet twee');
  assert.equal(t.description, 'Zoë komt ook');
  await c.actions.updateTask(id, { description: 'Noël' });
  assert.equal(c.store.view.tasks.get(id).description, 'Noël');
  const optimistic = snapshot(c.store.view);
  c.net.online = true;
  assert.equal(await c.sync.syncNow(), true);
  assert.deepEqual(snapshot(c.store.view), optimistic, 'na de sync is er niets veranderd: client en server gaven hetzelfde antwoord');
  assert.deepEqual(c.errors, []);
});

test('twee tabbladen delen één opslag zonder elkaars wachtende commando\'s te overschrijven', async () => {
  const db = makeServer();
  const adapter = new MemoryAdapter();
  const a = makeClient(db, { adapter });
  const b = makeClient(db, { adapter });
  await a.store.init();
  await b.store.init();
  a.net.online = false;
  b.net.online = false;
  // beide tabbladen maken "tegelijk" een taak; hun volgnummers kunnen gelijk zijn, hun herkomst niet
  const realNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    await a.actions.addTask({ content: 'Uit tab A', project_id: INBOX_ID });
    await b.actions.addTask({ content: 'Uit tab B', project_id: INBOX_ID });
  } finally {
    Date.now = realNow;
  }
  assert.equal(a.store.queue[0].seq, b.store.queue[0].seq, 'de test dekt het geval van gelijke volgnummers');
  assert.equal((await adapter.load()).queue.length, 2, 'beide commando\'s staan bewaard');

  await a.store.init(); // tab A leest opnieuw (in de app gebeurt dat na een seintje van het andere tabblad)
  assert.deepEqual(taskNames(a.store.view), ['Uit tab A', 'Uit tab B']);
  a.net.online = true;
  b.net.online = true;
  assert.equal(await a.sync.syncNow(), true); // A verstuurt beide
  assert.equal(await b.sync.syncNow(), true); // B verstuurt het zijne nog eens: zelfde uuid, dus geen dubbel effect
  const fresh = makeClient(db);
  await fresh.store.init();
  await fresh.sync.syncNow();
  assert.deepEqual(taskNames(fresh.store.view), ['Uit tab A', 'Uit tab B']);
  assert.equal((await adapter.load()).queue.length, 0);
});

test('opnieuw laden terwijl een nieuw commando nog niet bewaard is: het commando valt niet weg', async () => {
  const c = makeClient(makeServer());
  await c.store.init();
  let release;
  const gate = new Promise((r) => { release = r; });
  const commit = c.adapter.commit.bind(c.adapter);
  c.adapter.commit = async (batch) => { await gate; return commit(batch); };
  const pending = c.actions.addTask({ content: 'Net toegevoegd', project_id: INBOX_ID }); // bewaren hangt nog
  await c.store.init(); // de opslag kent het commando nog niet
  assert.equal(c.store.queueLength, 1);
  assert.deepEqual(taskNames(c.store.view), ['Net toegevoegd']);
  release();
  await pending;
  assert.equal((await c.adapter.load()).queue.length, 1);
});

test('een opmerking die wordt verwijderd in dezelfde ronde waarin je een nieuw project maakt, verdwijnt ook uit je bevestigde toestand', async () => {
  const db = makeServer();
  const c = makeClient(db);
  await c.store.init();
  await c.sync.syncNow();
  const task = await c.actions.addTask({ content: 'Met opmerking', project_id: INBOX_ID });
  const onTask = await c.actions.addComment({ taskId: task }, 'bij de taak');
  const onProject = await c.actions.addComment({ projectId: INBOX_ID }, 'bij het project');
  await c.sync.syncNow();
  assert.equal(c.store.view.comments.size, 2);
  await c.actions.deleteComment(onTask);
  await c.actions.deleteComment(onProject);
  await c.actions.addProject({ name: 'Nieuw in dezelfde ronde' }); // het lidmaatschap van het nieuwe project heeft een versie na het token
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
  assert.equal(c.store.view.comments.size, 0, 'beide opmerkingen zijn weg, ook uit de bevestigde toestand');
  const fresh = makeClient(db);
  await fresh.store.init();
  await fresh.sync.syncNow();
  assert.equal(fresh.store.view.comments.size, 0);
});

// ---------- differentieel: honderden willekeurige handelingen, client versus server ----------

function rng(seed) {
  let s = seed;
  return (n) => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s % n;
  };
}

/** Een betere reeks dan rng() (die kijkt naar de lage bits, wat bij kleine bereiken in patronen vervalt); alleen voor de verplaatsingen. */
function rngMixed(seed) {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * n) | 0;
  };
}

// Dezelfde labels in verschillende schrijfwijzen: hoofdletters, accenten en de ontleedde "é"; client en server moeten ze als één label zien
const LABEL_NAMES = ['label0', 'Café', 'CAFÉ', 'café', 'één', 'ÉÉN', 'Zoë', 'zoë'];

/** Voert één willekeurige, geldige handeling uit. Geeft een korte omschrijving terug voor foutmeldingen. */
async function randomAction(c, rnd) {
  const v = c.store.view;
  const pick = (map, pred = () => true) => {
    const list = [...map.values()].filter(pred).sort((a, b) => (a.id < b.id ? -1 : 1));
    return list.length ? list[rnd(list.length)] : null;
  };
  const subtree = (id) => {
    const ids = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of v.tasks.values()) if (t.parent_id && ids.has(t.parent_id) && !ids.has(t.id)) { ids.add(t.id); grew = true; }
    }
    return ids;
  };
  const dues = [
    null,
    { date: '2026-11-20' },
    { date: '2026-11-14T09:30', string: 'morgen om half 10', lang: 'nl' },
    { date: '2026-11-13', string: 'elke vrijdag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [5] } },
    { date: '2026-01-31', string: 'elke maand', lang: 'nl', recurrence: { freq: 'monthly', bymonthday: 31 } },
    { date: '2026-11-13T08:00', string: 'elke dag om 8 uur', lang: 'nl', recurrence: { freq: 'daily' } },
    { date: '2026-11-10', string: 'elke tweede dinsdag', lang: 'nl', recurrence: { freq: 'monthly', byweekday: [2], nth: 2 } },
    { date: '2026-11-27', string: 'elke laatste vrijdag', lang: 'nl', recurrence: { freq: 'monthly', byweekday: [5], nth: -1 } },
    { date: '2026-12-05', string: 'elk jaar op 5 december', lang: 'nl', recurrence: { freq: 'yearly', bymonthday: 5 } },
  ];
  const project = pick(v.projects);
  const task = pick(v.tasks);
  switch (rnd(17)) {
    case 0: {
      const parent = rnd(4) === 0 ? pick(v.projects, (p) => p.id !== INBOX_ID) : null;
      await c.actions.addProject({ name: `Project ${rnd(1000)}`, parent_id: parent?.id ?? null });
      return 'addProject';
    }
    case 1: await c.actions.addSection(project.id, `Sectie ${rnd(1000)}`); return 'addSection';
    case 2: case 3: case 4: {
      const section = rnd(2) ? pick(v.sections, (s) => s.project_id === project.id) : null;
      await c.actions.addTask({
        content: `Taak ${rnd(100000)}`, project_id: project.id, section_id: section?.id ?? null,
        priority: 1 + rnd(4), due: dues[rnd(dues.length)], ...(rnd(5) === 0 ? { newLabels: [LABEL_NAMES[rnd(LABEL_NAMES.length)]] } : {}),
      });
      return 'addTask';
    }
    case 5: {
      if (!task) return 'skip';
      await c.actions.addTask({ content: `Subtaak ${rnd(100000)}`, project_id: task.project_id, parent_id: task.id });
      return 'addSubtask';
    }
    case 6: {
      if (!task) return 'skip';
      await c.actions.updateTask(task.id, { content: `Aangepast ${rnd(100000)}`, priority: 1 + rnd(4), due: dues[rnd(dues.length)], description: rnd(2) ? 'notitie' : '' });
      return 'updateTask';
    }
    case 7: case 8: {
      if (!task) return 'skip';
      const mine = subtree(task.id);
      const kind = rnd(3);
      if (kind === 0) {
        const parent = pick(v.tasks, (t) => !mine.has(t.id));
        if (!parent) return 'skip';
        await c.actions.moveTask(task.id, { project_id: parent.project_id, parent_id: parent.id });
        return 'moveUnderTask';
      }
      const section = kind === 1 ? pick(v.sections, (s) => s.project_id === project.id) : null;
      const before = rnd(2) ? pick(v.tasks, (t) => !mine.has(t.id) && t.project_id === project.id && (t.section_id ?? null) === (section?.id ?? null) && !t.parent_id) : null;
      await c.actions.moveTask(task.id, { project_id: project.id, section_id: section?.id ?? null, beforeId: before?.id ?? null });
      return 'moveTask';
    }
    case 9: case 10: if (!task) return 'skip'; await c.actions.completeTask(task.id); return 'completeTask';
    case 11: {
      const done = pick(v.tasks, (t) => t.checked);
      if (!done) return 'skip';
      await c.actions.uncompleteTask(done.id);
      return 'uncompleteTask';
    }
    case 12: if (!task) return 'skip'; await c.actions.deleteTask(task.id); return 'deleteTask';
    case 13: {
      const what = rnd(3);
      if (what === 0) { const s = pick(v.sections); if (!s) return 'skip'; await c.actions.deleteSection(s.id); return 'deleteSection'; }
      if (what === 1) { const p = pick(v.projects, (x) => x.id !== INBOX_ID); if (!p || rnd(3)) return 'skip'; await c.actions.deleteProject(p.id); return 'deleteProject'; }
      const l = pick(v.labels); if (!l) return 'skip'; await c.actions.deleteLabel(l.id); return 'deleteLabel';
    }
    case 14: {
      if (!task) return 'skip';
      const pickName = () => LABEL_NAMES[rnd(LABEL_NAMES.length)];
      await c.actions.setTaskLabels(task.id, [pickName(), pickName()].slice(0, 1 + rnd(2)));
      return 'setTaskLabels';
    }
    case 15: {
      const uuid = `uuid-${String(++counter).padStart(10, '0')}`;
      const id = `id${String(++counter).padStart(10, '0')}`;
      const comment = pick(v.comments);
      const what = [0, 0, 0, 1, 1, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 7, 8][rnd(18)];
      const other = pick(v.projects, (p) => p.id !== INBOX_ID);
      let cmd = null;
      if (what === 0 && task) cmd = { type: 'comment_add', uuid, args: { id, task_id: task.id, content: 'Opmerking' } };
      else if (what === 1) cmd = { type: 'comment_add', uuid, args: { id, project_id: project.id, content: `Over het project ${rnd(100)}\nmet een tweede regel` } };
      else if (what === 2 && task) cmd = { type: 'reminder_add', uuid, args: { id, task_id: task.id, type: 'relative', minute_offset: 30 } };
      else if (what === 3 && comment) cmd = { type: 'comment_update', uuid, args: { id: comment.id, content: `Aangepast ${rnd(1000)}` } };
      else if (what === 4 && comment) cmd = { type: 'comment_delete', uuid, args: { id: comment.id } };
      else if (what === 5 && other) {
        // archiveren en terugzetten, zoals de zijbalk dat doet (een hele tak tegelijk)
        await (other.is_archived ? c.actions.unarchiveProject(other.id) : c.actions.archiveProject(other.id));
        return 'archiveProject';
      } else if (what === 6 && task) cmd = { type: 'task_update', uuid, args: { id: task.id, is_collapsed: !task.is_collapsed } };
      else if (what === 7) {
        const s = pick(v.sections);
        if (s) cmd = { type: 'section_update', uuid, args: { id: s.id, is_collapsed: !s.is_collapsed } };
      } else if (what === 8 && project.id !== INBOX_ID) cmd = { type: 'project_update', uuid, args: { id: project.id, is_collapsed: !project.is_collapsed, color: ['red', 'blue', 'charcoal', 'berry_red'][rnd(4)] } };
      if (!cmd) return 'skip';
      await c.store.enqueue([cmd]);
      return cmd.type;
    }
    default: await c.actions.updateProject(project.id, { name: `Hernoemd ${rnd(1000)}`, is_favorite: Boolean(rnd(2)) }); return 'updateProject';
  }
}


/**
 * Slepen en verplaatsen zoals de interface het doet (de plannen uit core/dnd.js), en soms twee taken met dezelfde volgordesleutel.
 * Eigen reeks willekeurige getallen, zodat de reeks van randomAction hierboven dezelfde blijft.
 */
async function randomDndAction(c, rnd) {
  const v = c.store.view;
  const pick = (map, pred = () => true) => {
    const list = [...map.values()].filter(pred).sort((a, b) => (a.id < b.id ? -1 : 1));
    return list.length ? list[rnd(list.length)] : null;
  };
  const project = pick(v.projects);
  const task = pick(v.tasks);
  // slepen en verplaatsen zoals de interface het doet (plannen uit core/dnd.js), en soms twee taken met dezelfde volgordesleutel
  const what = rnd(6) + 1;
  const zone = ['before', 'child', 'after'][rnd(3)];
  const userId = c.store.userId;
  if (what === 1 || what === 2) {
    const over = pick(v.tasks);
    if (!task || !over) return 'skip';
    const plan = what === 1 ? planTaskDrop(v, { dragId: task.id, overId: over.id, zone, overExpanded: Boolean(rnd(2)) }) : planTaskKey(v, task.id, ['up', 'down', 'indent', 'outdent'][rnd(4)], { isVisible: () => true }).plan;
    if (!plan) return 'skip';
    await c.actions.moveTask(task.id, plan);
    return what === 1 ? 'dragTask' : 'keyTask';
  }
  if (what === 3) {
    const target = pick(v.projects, (p) => !p.is_archived);
    const plan = rnd(2) && task ? planTaskDropOnProject(v, { dragId: task.id, projectId: target.id }) : task ? planTaskDropOnGroup(v, { dragId: task.id, projectId: project.id, sectionId: pick(v.sections, (x) => x.project_id === project.id)?.id ?? null, edge: rnd(2) ? 'start' : 'end' }) : null;
    if (!plan) return 'skip';
    await c.actions.moveTask(task.id, plan);
    return 'dropTask';
  }
  if (what === 4 || what === 5) {
    const over = pick(v.projects);
    const plan = what === 4
      ? planProjectDrop(v, { dragId: project.id, overId: over.id, zone, userId, overExpanded: Boolean(rnd(2)) })
      : (rnd(2) ? planProjectDropToTop(v, { dragId: project.id, userId }) : planProjectKey(v, project.id, ['up', 'down', 'indent', 'outdent'][rnd(4)], { userId }).plan);
    if (!plan) return 'skip';
    await c.actions.moveProject(project.id, plan);
    return 'dragProject';
  }
  // twee taken met dezelfde sleutel in één lijst (zoals twee apparaten offline achteraan toevoegen)
  for (const n of [1, 2]) {
    await c.store.enqueue([{ type: 'task_add', uuid: `uuid-${String(++counter).padStart(10, '0')}`, args: { id: `id${String(++counter).padStart(10, '0')}`, project_id: project.id, content: `Gelijk ${n}`, order_key: 'V' } }]);
  }
  return 'tieTasks';
}

/**
 * Plaatsen en locatieherinneringen: toevoegen, wijzigen, verwijderen (met de herinneringen erop), herinneringen aan taken hangen,
 * en soms een taak afvinken of verwijderen terwijl er een locatieherinnering aan hangt. Ook een paar bedoeld ongeldige commando's.
 */
async function randomGeoAction(c, rnd) {
  const v = c.store.view;
  const pick = (map, pred = () => true) => {
    const list = [...map.values()].filter(pred).sort((a, b) => (a.id < b.id ? -1 : 1));
    return list.length ? list[rnd(list.length)] : null;
  };
  const place = pick(v.places);
  const task = pick(v.tasks);
  const what = rnd(10);
  const uuid = () => `uuid-${String(++counter).padStart(10, '0')}`;
  if (what <= 1 || !place) {
    await c.actions.addPlace({ name: `Plaats ${rnd(1000)}`, lat: 50 + rnd(3000) / 1000, lon: 4 + rnd(3000) / 1000, radius: [100, 150, 500, 5000][rnd(4)] });
    return 'addPlace';
  }
  if (what === 2) { await c.actions.updatePlace(place.id, { name: `Anders ${rnd(1000)}`, radius: 100 + rnd(900) }); return 'updatePlace'; }
  if (what === 3) { if (rnd(3)) return 'skip'; await c.actions.deletePlace(place.id); return 'deletePlace'; }
  if (what >= 4 && what <= 6) {
    if (!task) return 'skip';
    await c.actions.addReminder(task.id, { type: 'location', place_id: place.id, trigger: ['enter', 'leave'][rnd(2)] });
    return 'addLocationReminder';
  }
  if (what === 7) {
    const r = pick(v.reminders, (x) => x.type === 'location');
    if (!r) return 'skip';
    await c.actions.deleteReminder(r.id);
    return 'deleteLocationReminder';
  }
  if (what === 8) {
    // bedoeld ongeldig: een locatieherinnering zonder plaats of zonder trigger, en een plaats die niet bestaat
    if (!task) return 'skip';
    const id = `id${String(++counter).padStart(10, '0')}`;
    const bad = [{ task_id: task.id, type: 'location', trigger: 'enter' }, { task_id: task.id, type: 'location', place_id: place.id }, { task_id: task.id, type: 'location', place_id: 'bestaat-niet-1', trigger: 'enter' },
      { task_id: task.id, type: 'relative', minute_offset: 5, place_id: place.id }][rnd(4)];
    await c.store.enqueue([{ type: 'reminder_add', uuid: uuid(), args: { id, ...bad } }]);
    return 'invalidLocationReminder';
  }
  if (!task) return 'skip';
  if (rnd(2)) await c.actions.completeTask(task.id); else await c.actions.deleteTask(task.id);
  return 'taskWithLocation';
}

// De eerste vier reeksen zijn ongewijzigd; de volgende drie voegen slepen en verplaatsen toe (met eigen reeks getallen, zodat de
// eerste reeksen precies hetzelfde blijven doen) en eisen daarvoor andere handelingen.
const RUNS = [{ seed: 1, every: 1 }, { seed: 7, every: 1 }, { seed: 42, every: 8 }, { seed: 2026, every: 25 }, { seed: 5, every: 1, dnd: true }, { seed: 31, every: 4, dnd: true }, { seed: 808, every: 25, dnd: true }, { seed: 77, every: 1, geo: true }, { seed: 123, every: 6, geo: true }];
const BASE_KINDS = ['addTask', 'addSubtask', 'moveTask', 'moveUnderTask', 'completeTask', 'deleteTask', 'setTaskLabels', 'comment_add', 'comment_update', 'comment_delete', 'archiveProject'];
const GEO_KINDS = ['addPlace', 'updatePlace', 'deletePlace', 'addLocationReminder', 'deleteLocationReminder', 'invalidLocationReminder'];
const DND_KINDS = ['dragTask', 'keyTask', 'dropTask', 'dragProject', 'tieTasks'];

for (const { seed, every, dnd = false, geo = false } of RUNS) {
  test(`differentieel${dnd ? ' met slepen' : ''}${geo ? ' met plaatsen' : ''} (seed ${seed}, sync na elke ${every} handelingen): optimistische toestand = toestand van de server`, async () => {
    const db = makeServer();
    const c = makeClient(db);
    await c.store.init();
    await c.sync.syncNow();
    const rnd = rng(seed);
    const rndDnd = rngMixed(seed + 999);
    const rndGeo = rngMixed(seed + 4242);
    const log = [];
    for (let i = 1; i <= 400; i++) {
      log.push(await randomAction(c, rnd));
      if (dnd && rndDnd(2) === 0) log.push(await randomDndAction(c, rndDnd));
      if (geo) log.push(await randomGeoAction(c, rndGeo));
      if (i % every !== 0) continue;
      const optimistic = snapshot(c.store.view);
      assert.equal(await c.sync.syncNow(), true);
      // de bedoeld ongeldige locatieherinneringen weigert de server; alles anders moet slagen
      const unexpected = c.errors.filter((e) => !(geo && e.cmd.type === 'reminder_add'));
      c.errors.length = 0;
      assert.deepEqual(unexpected, [], `de server weigerde iets na: ${log.slice(-every * 2).join(', ')}`);
      assert.deepEqual(snapshot(c.store.view), optimistic, `verschil na stap ${i}: ${log.slice(-every * 2).join(', ')}`);
    }
    await c.sync.syncNow();
    const fresh = makeClient(db);
    await fresh.store.init();
    await fresh.sync.syncNow();
    assert.deepEqual(snapshot(fresh.store.view), snapshot(c.store.view), 'een nieuw apparaat ziet hetzelfde');
    const kinds = new Set(log);
    for (const k of dnd ? DND_KINDS : geo ? GEO_KINDS : BASE_KINDS) assert.ok(kinds.has(k), `handeling ${k} kwam niet voor in deze reeks`);
    if (dnd) assert.ok(log.filter((k) => DND_KINDS.includes(k)).length >= 60, 'genoeg verplaatsingen in de reeks');
  });
}
