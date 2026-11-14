// Meerdere taken selecteren en bewerken, en ongedaan maken: de selectie zelf, wat elke bulkactie verstuurt, en de uitkomst met een
// echte client tegen de echte server-engine (twee gebruikers in een gedeeld project, ook als taken intussen verdwenen zijn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { RESOURCES, applyCommand, cloneState } from './reducer.js';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { createUndo } from './undo.js';
import { inverseCommands } from './inverse.js';
import { createSelection, rangeBetween } from './selection.js';
import {
  assignChoices, nameList, planAssign, planComplete, planDate, planDelete, planGroupDrop, planLabels, planMove, planPriority, planReopen, selectionInfo, skippedText, summarizeErrors, topLevel,
} from './bulk.js';
import { MAX_DRAG_GROUP } from './selection.js';
import { planTaskDrop, planTaskDropOnGroup } from './dnd.js';
import { describeCommandError } from './messages.js';
import { setLanguage } from './i18n.js';

let counter = 0;

function world() {
  const db = freshDb();
  const alice = addUser(db, 'alice', 'Alice');
  const bob = addUser(db, 'bob', 'Bob');
  const make = (user) => {
    const store = new Store(new MemoryAdapter(), { onPersistError: () => {} });
    const errors = [];
    const transport = async (body) => JSON.parse(JSON.stringify(handleSync(db, JSON.parse(JSON.stringify(body)), user.id)));
    const sync = new SyncClient({ store, transport, onCommandErrors: (e) => errors.push(...e) });
    const undo = createUndo();
    const actions = createActions(store, {
      makeId: () => `id${String(++counter).padStart(10, '0')}`,
      makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}`,
      undo,
    });
    return { user, store, sync, actions, errors, undo };
  };
  return { db, a: make(alice), b: make(bob), alice, bob };
}
const settle = async (...cs) => { for (const c of cs) assert.equal(await c.sync.syncNow(), true); };
const snapshot = (view) => {
  const out = {};
  for (const r of RESOURCES) {
    out[r] = [...view[r].values()]
      .map(({ created_at, updated_at, completed_at, ...rest }) => ({ ...rest, completed: Boolean(completed_at) }))
      .sort((x, y) => (x.id < y.id ? -1 : 1));
  }
  out.members = out.members.map(({ id, ...rest }) => rest);
  return out;
};

/** Alice: project Gezin met sectie Week en vijf taken, een subtaak, een label; gedeeld met Bob. Bob heeft zijn eigen sync al gedaan. */
async function setup() {
  const w = world();
  await w.a.store.init();
  await w.b.store.init();
  await settle(w.a, w.b);
  const P = await w.a.actions.addProject({ name: 'Gezin' });
  const Q = await w.a.actions.addProject({ name: 'Werk' });
  const S = await w.a.actions.addSection(P, 'Week');
  await w.a.actions.shareProject(P, 'bob');
  const ids = [];
  for (const [i, name] of ['Café reserveren', 'Boodschappen', 'Bellen: crème', 'Ijsjes kopen', 'Fiets maken'].entries()) {
    ids.push(await w.a.actions.addTask({ content: name, project_id: P, section_id: i % 2 ? S : null, priority: 4 }));
  }
  const kid = await w.a.actions.addTask({ content: 'Kind van café', project_id: P, parent_id: ids[0] });
  const label = await w.a.actions.addLabel('thuis');
  await settle(w.a, w.b);
  return { ...w, P, Q, S, ids, kid, label };
}

// ---------- de selectie ----------

test('selectie: kiezen, bereik, alles, opruimen', () => {
  let changes = 0;
  const s = createSelection({ onChange: () => { changes += 1; } });
  const order = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(s.active, false);
  s.toggle('b');
  assert.equal(s.active, true);
  assert.equal(s.anchor, 'b');
  s.extendTo(order, 'd');
  assert.deepEqual(s.list(order), ['b', 'c', 'd']);
  s.extendTo(order, 'a'); // naar boven, vanaf het anker b
  assert.deepEqual(s.list(order), ['a', 'b', 'c', 'd']);
  assert.equal(s.toggle('c'), false);
  assert.deepEqual(s.list(order), ['a', 'b', 'd']);
  assert.deepEqual(rangeBetween(order, 'e', 'c'), ['c', 'd', 'e']);
  assert.deepEqual(rangeBetween(order, 'zzz', 'c'), ['c'], 'zonder geldig anker alleen de taak zelf');
  assert.equal(s.prune((id) => id !== 'a'), 1);
  assert.deepEqual(s.list(order), ['b', 'd']);
  s.selectAll(order);
  assert.equal(s.size, 5);
  assert.equal(s.clear(), true);
  assert.equal(s.size, 0);
  assert.equal(s.active, false);
  assert.equal(s.clear(), false, 'niets te stoppen');
  s.setMode(true);
  assert.equal(s.active, true, 'de knop Selecteren zet de vakjes aan zonder dat iets gekozen is');
  s.deselect();
  assert.equal(s.active, true);
  s.clear();
  assert.equal(s.active, false);
  assert.ok(changes > 5);
});

test('een subtaak gaat mee met haar ouder: topLevel laat haar weg als de ouder ook gekozen is', async () => {
  const w = await setup();
  const v = w.a.store.view;
  assert.deepEqual(topLevel(v, [w.kid, w.ids[0], w.ids[1]]), [w.ids[0], w.ids[1]]);
  assert.deepEqual(topLevel(v, [w.kid, w.ids[1]]), [w.kid, w.ids[1]], 'alleen de subtaak gekozen: ze doet zelf mee');
  assert.deepEqual(topLevel(v, ['bestaat-niet', w.ids[1]]), [w.ids[1]]);
});

// ---------- afvinken en heropenen ----------

test('afvinken: open taken van het hoogste niveau, terugkerend met if_due; ongedaan maken opent alles weer', async () => {
  const w = await setup();
  await w.a.actions.updateTask(w.ids[2], { due: { date: '2026-11-20', string: 'elke vrijdag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [5] } } });
  await settle(w.a);
  const before = snapshot(w.a.store.view);
  const picked = [w.kid, w.ids[0], w.ids[1], w.ids[2]];
  const plan = planComplete(w.a.store.view, picked, (id) => w.a.actions.planComplete(id));
  assert.equal(plan.count, 3, 'de subtaak gaat mee met haar ouder');
  assert.equal(plan.commands.find((c) => c.args.id === w.ids[2]).args.if_due, '2026-11-20');
  const { entry } = await w.a.actions.batch(plan.commands, { label: 'afvinken' });
  assert.ok(entry);
  assert.equal(w.a.store.view.tasks.get(w.kid).checked, true, 'de subtaak is meegegaan');
  assert.equal(w.a.store.view.tasks.get(w.ids[1]).checked, true);
  assert.notEqual(w.a.store.view.tasks.get(w.ids[2]).due.date, '2026-11-20');
  await settle(w.a, w.b);
  assert.deepEqual(snapshot(w.b.store.view).tasks.map((t) => t.checked).sort(), snapshot(w.a.store.view).tasks.map((t) => t.checked).sort());
  assert.equal(await w.a.actions.runUndo(entry), true);
  await settle(w.a, w.b);
  const after = snapshot(w.a.store.view);
  const strip = (s) => s.tasks.map(({ completed_count, completed, checked, ...r }) => ({ ...r, checked, completed }));
  assert.deepEqual(strip(after), strip(before), 'alles staat weer zoals voor het afvinken');
  assert.deepEqual(snapshot(w.b.store.view).tasks.map((t) => t.id), after.tasks.map((t) => t.id));
  const reopen = planReopen(w.a.store.view, [w.ids[0]]);
  assert.equal(reopen.count, 0, 'er is niets afgevinkt om te heropenen');
});

// ---------- verplaatsen ----------

test('verplaatsen: in de volgorde van de lijst achteraan, subtaken mee, wat er al staat blijft liggen; client en server komen gelijk uit', async () => {
  const w = await setup();
  const order = [w.ids[3], w.ids[0], w.ids[4], w.kid];
  const plan = planMove(w.a.store.view, [w.ids[0], w.kid, w.ids[3], w.ids[4], w.ids[1]], { project_id: w.Q }, order);
  assert.equal(plan.count, 4, 'de subtaak gaat met haar ouder mee: vier taken, vier commando\'s');
  assert.equal(plan.commands.filter((c) => c.type === 'task_move').length, 4);
  await w.a.actions.batch(plan.commands, { label: 'verplaatst' });
  const view = w.a.store.view;
  const inQ = [...view.tasks.values()].filter((t) => t.project_id === w.Q && !t.parent_id).sort((x, y) => (x.order_key < y.order_key ? -1 : 1)).map((t) => t.id);
  assert.deepEqual(inQ.slice(0, 3), [w.ids[3], w.ids[0], w.ids[4]], 'in de volgorde van de lijst');
  assert.equal(new Set(inQ.map((id) => view.tasks.get(id).order_key)).size, inQ.length, 'elke taak een eigen sleutel');
  assert.equal(view.tasks.get(w.kid).project_id, w.Q, 'de subtaak is met haar ouder mee');
  const optimistic = snapshot(view);
  await settle(w.a);
  assert.deepEqual(w.a.errors, []);
  assert.deepEqual(snapshot(w.a.store.view), optimistic, 'de server kwam op precies hetzelfde uit');
  // al in het doel: overslaan
  const again = planMove(w.a.store.view, [w.ids[3]], { project_id: w.Q }, []);
  assert.equal(again.count, 0);
  assert.deepEqual(again.skipped, [{ id: w.ids[3], reason: 'already' }]);
});

test('verplaatsen naar een sectie van hetzelfde project haalt een subtaak uit haar ouder; ongedaan maken zet alles terug op de oude plek', async () => {
  const w = await setup();
  await settle(w.a);
  const before = snapshot(w.a.store.view);
  const plan = planMove(w.a.store.view, [w.kid, w.ids[4]], { project_id: w.P, section_id: w.S });
  const { entry } = await w.a.actions.batch(plan.commands, { label: 'verplaatst' });
  assert.equal(w.a.store.view.tasks.get(w.kid).parent_id, null);
  assert.equal(w.a.store.view.tasks.get(w.kid).section_id, w.S);
  await settle(w.a);
  assert.deepEqual(w.a.errors, []);
  await w.a.actions.runUndo(entry);
  await settle(w.a);
  assert.deepEqual(w.a.errors, []);
  assert.deepEqual(snapshot(w.a.store.view), before);
});

test('verplaatsen met een toegewezen persoon: ongedaan maken wijst weer toe', async () => {
  const w = await setup();
  await w.a.actions.assignTask(w.ids[1], w.bob.id);
  await settle(w.a);
  const before = snapshot(w.a.store.view);
  const plan = planMove(w.a.store.view, [w.ids[1]], { project_id: w.Q });
  const { entry } = await w.a.actions.batch(plan.commands, { label: 'verplaatst' });
  await settle(w.a);
  assert.equal(w.a.store.view.tasks.get(w.ids[1]).assignee_id, null, 'Bob is geen lid van Werk');
  await w.a.actions.runUndo(entry);
  await settle(w.a);
  assert.deepEqual(w.a.errors, []);
  assert.deepEqual(snapshot(w.a.store.view), before);
});

// ---------- datum, prioriteit, labels ----------

test('datum: tijdstip en herhaling blijven, een taak die er al staat doet niet mee, geen datum haalt weg; ongedaan maken zet de oude datums terug', async () => {
  const w = await setup();
  await w.a.actions.updateTask(w.ids[0], { due: { date: '2026-11-18T10:00' } });
  await w.a.actions.updateTask(w.ids[1], { due: { date: '2026-11-25' } });
  await settle(w.a);
  const before = snapshot(w.a.store.view);
  const plan = planDate(w.a.store.view, w.ids, '2026-11-25', (id, changes) => w.a.actions.planUpdateTask(id, changes));
  assert.equal(plan.count, 4, 'Boodschappen staat er al');
  const { entry } = await w.a.actions.batch(plan.commands, { label: 'datum' });
  assert.equal(w.a.store.view.tasks.get(w.ids[0]).due.date, '2026-11-25T10:00', 'het tijdstip blijft');
  await settle(w.a);
  assert.deepEqual(w.a.errors, []);
  const none = planDate(w.a.store.view, [w.ids[0], w.ids[1], w.ids[2]], null, (id, changes) => w.a.actions.planUpdateTask(id, changes));
  assert.ok(none.count >= 2);
  await w.a.actions.runUndo(entry);
  await settle(w.a);
  assert.deepEqual(snapshot(w.a.store.view).tasks.map((t) => [t.id, t.due]), before.tasks.map((t) => [t.id, t.due]));
});

test('prioriteit en labels: alleen taken waar iets verandert; labels erbij en eraf', async () => {
  const w = await setup();
  const p = planPriority(w.a.store.view, w.ids, 1);
  assert.equal(p.count, 5);
  assert.equal(planPriority(w.a.store.view, w.ids, 4).count, 0, 'ze staan al op p4');
  await w.a.actions.updateTask(w.ids[0], { labels: [w.label] });
  const add = planLabels(w.a.store.view, w.ids, { add: [w.label] });
  assert.equal(add.count, 4, 'de eerste heeft het label al');
  const { entry } = await w.a.actions.batch([...p.commands, ...add.commands], { label: 'x' });
  assert.ok([...w.a.store.view.tasks.values()].filter((t) => w.ids.includes(t.id)).every((t) => t.priority === 1 && t.labels.includes(w.label)));
  const rm = planLabels(w.a.store.view, [w.ids[0], w.ids[1]], { remove: [w.label] });
  assert.equal(rm.count, 2);
  await settle(w.a);
  assert.deepEqual(w.a.errors, []);
  await w.a.actions.batch(rm.commands, { label: 'weg' });
  assert.deepEqual(w.a.store.view.tasks.get(w.ids[0]).labels, []);
  assert.deepEqual(w.a.store.view.tasks.get(w.ids[2]).labels, [w.label]);
  await w.a.actions.runUndo(entry).catch(() => {});
  await settle(w.a);
  assert.deepEqual(w.a.errors, []);
});

test('labels op naam: een nieuw label wordt in dezelfde reeks aangemaakt en weer weggehaald bij ongedaan maken', async () => {
  const w = await setup();
  const { ids, commands } = w.a.actions.resolveLabels(['Café']);
  assert.equal(commands.length, 1, 'bestaat nog niet: aanmaken');
  const plan = planLabels(w.a.store.view, [w.ids[1]], { add: ids });
  const { entry } = await w.a.actions.batch([...commands, ...plan.commands], { label: 'label' });
  await settle(w.a);
  assert.deepEqual(w.a.errors, []);
  assert.equal([...w.a.store.view.labels.values()].filter((l) => l.name === 'Café').length, 1);
  await w.a.actions.runUndo(entry);
  await settle(w.a);
  assert.deepEqual(w.a.errors, []);
  assert.equal([...w.a.store.view.labels.values()].filter((l) => l.name === 'Café').length, 0);
  assert.deepEqual(w.a.store.view.tasks.get(w.ids[1]).labels, []);
});

// ---------- toewijzen en rechten ----------

test('toewijzen: alleen leden van het project van de taak; de rest wordt overgeslagen met een reden, de rest gaat door', async () => {
  const w = await setup();
  await w.a.actions.moveTask(w.ids[4], { project_id: w.Q });
  await settle(w.a);
  const plan = planAssign(w.a.store.view, w.ids, w.bob.id);
  assert.deepEqual(plan.skipped, [{ id: w.ids[4], reason: 'notMember' }], 'Bob is geen lid van Werk');
  assert.equal(plan.count, 4);
  await w.a.actions.batch(plan.commands, { label: 'toegewezen' });
  await settle(w.a, w.b);
  assert.deepEqual(w.a.errors, []);
  assert.equal(w.b.store.view.tasks.get(w.ids[0]).assignee_id, w.bob.id);
  assert.equal(w.b.store.view.tasks.get(w.kid)?.assignee_id ?? null, null);
  const choices = assignChoices(w.a.store.view, w.ids);
  assert.deepEqual(choices.map((c) => [c.userId === w.bob.id ? 'bob' : 'alice', c.everywhere]).sort(), [['alice', true], ['bob', false]].sort());
  assert.equal(selectionInfo(w.a.store.view, w.ids).shared, true);
  assert.equal(skippedText(plan.skipped, (id) => w.a.store.view.tasks.get(id)?.content).includes('Fiets maken'), true);
});

test('wat de server weigert komt als één melding terug: hoeveel, welke taken en waarom; de rest is wel gelukt', async () => {
  const w = await setup();
  setLanguage('nl');
  // Bob verwijdert twee taken terwijl Alice ze al gekozen heeft
  await w.b.actions.deleteTask(w.ids[1]);
  await w.b.actions.deleteTask(w.ids[2]);
  await settle(w.b);
  const plan = planPriority(w.a.store.view, w.ids, 1);
  assert.equal(plan.count, 5, 'Alice ziet de verwijdering nog niet');
  await w.a.actions.batch(plan.commands, { label: 'prioriteit', bulk: 'b1' });
  await settle(w.a);
  const bulkErrors = w.a.errors.filter((e) => e.cmd.local?.bulk === 'b1');
  assert.equal(bulkErrors.length, 2);
  assert.ok(bulkErrors.every((e) => e.cmd.args.id !== undefined && !('local' in e.cmd.args)), 'het bulklabel reist niet in de argumenten');
  const text = summarizeErrors(bulkErrors, { total: plan.count, nameOf: (id) => ['Boodschappen', 'Bellen: crème'][[w.ids[1], w.ids[2]].indexOf(id)] ?? null, describe: describeCommandError });
  assert.match(text, /2 niet gelukt \(je koos er 5\)/);
  assert.match(text, /Boodschappen/);
  assert.match(text, /Bellen: crème/);
  assert.equal(summarizeErrors([], { total: 3, nameOf: () => null, describe: () => '' }), null);
  assert.equal(nameList(['A', 'B', 'C', 'D']), '“A”, “B”, “C” en 1 andere');
  assert.equal(w.a.store.view.tasks.get(w.ids[0]).priority, 1);
  assert.equal(w.a.store.view.tasks.has(w.ids[1]), false, 'na de sync is de verdwenen taak ook bij Alice weg');
});

test('het bulklabel gaat nooit naar de server', async () => {
  const w = await setup();
  const seen = [];
  const store = w.a.store;
  const original = w.a.sync.transport;
  w.a.sync.transport = async (body) => { seen.push(...body.commands); return original(body); };
  await w.a.actions.batch([{ type: 'task_update', args: { id: w.ids[0], priority: 2 } }], { label: 'x', bulk: 'b2' });
  await settle(w.a);
  assert.ok(seen.length > 0 && seen.every((c) => !('local' in c)), JSON.stringify(seen));
  assert.equal(store.queueLength, 0);
});

// ---------- verwijderen en terugzetten ----------

test('verwijderen: alleen het hoogste niveau, aantal subtaken voor de vraag; ongedaan maken zet alles terug, ook bij de ander', async () => {
  const w = await setup();
  const c = await w.a.actions.addComment({ taskId: w.ids[0] }, 'Niet vergeten');
  await w.a.actions.addReminder(w.ids[0], { type: 'relative', minute_offset: 30 });
  await settle(w.a, w.b);
  const before = snapshot(w.a.store.view);
  const plan = planDelete(w.a.store.view, [w.ids[0], w.kid, w.ids[1]]);
  assert.equal(plan.count, 2);
  assert.equal(plan.subtasks, 1);
  const { entry } = await w.a.actions.batch(plan.commands, { label: 'verwijderd' });
  assert.equal(w.a.store.view.tasks.has(w.kid), false);
  assert.equal(w.a.store.view.comments.has(c), false);
  await settle(w.a, w.b);
  assert.equal(w.b.store.view.tasks.has(w.ids[0]), false);
  assert.equal(await w.a.actions.runUndo(entry), true);
  assert.equal(w.a.store.view.tasks.get(w.ids[0]).content, 'Café reserveren', 'direct terug, nog voor de server antwoordt');
  await settle(w.a, w.b);
  assert.deepEqual(w.a.errors, []);
  assert.deepEqual(snapshot(w.a.store.view), before);
  assert.deepEqual(snapshot(w.b.store.view).tasks.map((t) => t.id), before.tasks.map((t) => t.id));
  assert.equal(w.b.store.view.comments.has(c), true, 'de opmerking is ook bij Bob terug');
  assert.equal(await w.a.actions.runUndo(entry), false, 'een stap kan maar één keer');
});

test('Ctrl+Z-stapel: de laatste handeling eerst; een stap die al te oud is vervalt; projecten verwijderen is niet terug te zetten', async () => {
  const w = await setup();
  let now = 1_000_000;
  const undo = createUndo({ now: () => now, ttlMs: 60_000, max: 3 });
  const actions = createActions(w.a.store, { makeId: () => `id${String(++counter).padStart(10, '0')}`, makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}`, undo });
  await actions.track('een', () => actions.updateTask(w.ids[0], { priority: 1 }));
  await actions.track('twee', () => actions.updateTask(w.ids[0], { priority: 2 }));
  assert.equal(undo.size, 2);
  const item = await actions.undoLast();
  assert.equal(item.label, 'twee');
  assert.equal(w.a.store.view.tasks.get(w.ids[0]).priority, 1);
  now += 61_000;
  assert.equal(undo.size, 0, 'na de termijn vervallen de stappen');
  assert.equal(await actions.undoLast(), null);
  const noUndo = await actions.track('project weg', () => actions.deleteProject(w.Q));
  assert.equal(noUndo.entry, null, 'een project kan niet terug: geen stap');
  assert.equal(undo.size, 0);
  for (let i = 0; i < 5; i++) await actions.track(`s${i}`, () => actions.updateTask(w.ids[1], { priority: 1 + (i % 3) }));
  assert.equal(undo.size, 3, 'hooguit het ingestelde aantal');
});

test('inverseCommands: een reeks wordt in omgekeerde volgorde teruggedraaid; onbekende of onomkeerbare commando\'s geven null', async () => {
  const w = await setup();
  const v = w.a.store.view;
  const inv = inverseCommands(v, [
    { type: 'task_update', args: { id: w.ids[0], priority: 1 } },
    { type: 'task_update', args: { id: w.ids[0], priority: 2, content: 'Anders' } },
  ]);
  assert.deepEqual(inv.map((c) => c.args), [{ id: w.ids[0], priority: 1, content: 'Café reserveren' }, { id: w.ids[0], priority: 4 }]);
  assert.equal(inverseCommands(v, [{ type: 'label_delete', args: { id: w.label } }]), null);
  assert.equal(inverseCommands(v, [{ type: 'project_share', args: { project_id: w.P, username: 'bob' } }]), null);
  assert.equal(inverseCommands(v, [{ type: 'task_update', args: { id: w.ids[0], priority: 1 } }, { type: 'project_delete', args: { id: w.Q } }]), null);
  assert.deepEqual(inverseCommands(v, [{ type: 'task_update', args: { id: 'bestaat-niet-ooit', priority: 1 } }]), [], 'niets om terug te draaien');
  const del = inverseCommands(v, [{ type: 'task_delete', args: { id: w.ids[0] } }]);
  assert.equal(del[0].type, 'task_restore');
  assert.deepEqual(del[0].local.rows.tasks.map((t) => t.id).sort(), [w.ids[0], w.kid].sort());
});

test('Nederlands: namen met accenten en leestekens blijven heel door verplaatsen, verwijderen en terugzetten', async () => {
  const w = await setup();
  await w.a.actions.updateTask(w.ids[2], { content: 'Zoë’s café: crème brûlée — “één” & ijsjes', description: 'Ö ï ñ\nTweede regel' });
  await settle(w.a);
  const original = w.a.store.view.tasks.get(w.ids[2]);
  const del = planDelete(w.a.store.view, [w.ids[2]]);
  const { entry } = await w.a.actions.batch(del.commands, { label: 'weg' });
  await settle(w.a);
  await w.a.actions.runUndo(entry);
  await settle(w.a, w.b);
  const back = w.b.store.view.tasks.get(w.ids[2]);
  assert.equal(back.content, original.content);
  assert.equal(back.description, original.description);
  assert.equal(w.a.store.view.tasks.get(w.ids[2]).content, original.content);
});

// ---------- samen slepen ----------

test('samen slepen: alle gekozen taken komen in de volgorde van de lijst op de plek, onder een eigen sleutel; client en server komen gelijk uit', async () => {
  const w = await setup();
  const view = w.a.store.view;
  const order = [w.ids[0], w.ids[1], w.ids[2], w.ids[3], w.ids[4]];
  // loslaten vóór Fiets maken (ids[4]), met Boodschappen (ids[1]) en Zoë (ids[3]) gekozen
  const plan = planTaskDrop(view, { dragId: w.ids[3], overId: w.ids[4], zone: 'before' });
  const r = planGroupDrop(view, [w.ids[3], w.ids[1]], plan, order);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  await w.a.actions.batch(r.commands, { label: 'samen' });
  const v = w.a.store.view;
  const keyOf = (id) => v.tasks.get(id).order_key;
  assert.ok(keyOf(w.ids[1]) < keyOf(w.ids[3]) && keyOf(w.ids[3]) < keyOf(w.ids[4]), 'Boodschappen, Zoë, Fiets: in de volgorde van de lijst, vóór de plek');
  assert.equal(new Set([w.ids[1], w.ids[3], w.ids[4]].map(keyOf)).size, 3);
  const optimistic = snapshot(v);
  await settle(w.a);
  assert.deepEqual(w.a.errors, []);
  assert.deepEqual(snapshot(w.a.store.view), optimistic);
});

test('samen slepen: vóór een taak die zelf meegaat wordt vóór de eerstvolgende die blijft staan; onder jezelf of meer dan het maximum geeft een reden', async () => {
  const w = await setup();
  const v = w.a.store.view;
  const top = [w.ids[1], w.ids[2], w.ids[3]];
  const sectionless = [...v.tasks.values()].filter((t) => t.project_id === w.P && !t.section_id && !t.parent_id).sort((x, y) => (x.order_key < y.order_key ? -1 : 1)).map((t) => t.id);
  const before = sectionless.find((id) => !top.includes(id));
  const plan = { project_id: w.P, section_id: null, parent_id: null, beforeId: top.find((id) => sectionless.includes(id)) ?? before };
  const r = planGroupDrop(v, top, plan, sectionless);
  assert.equal(r.ok, true, 'vóór een gekozen taak: kan');
  // onder zichzelf
  const under = planGroupDrop(v, [w.ids[0], w.ids[1]], { project_id: w.P, section_id: null, parent_id: w.ids[0], beforeId: null });
  assert.deepEqual(under, { ok: false, reason: 'here' });
  const underKid = planGroupDrop(v, [w.ids[0], w.ids[1]], { project_id: w.P, section_id: null, parent_id: w.kid, beforeId: null });
  assert.deepEqual(underKid, { ok: false, reason: 'here' }, 'ook onder een subtaak van een gekozen taak');
  // te veel
  const many = Array.from({ length: MAX_DRAG_GROUP + 1 }, (_, i) => `veel-taak-${String(i).padStart(4, '0')}`);
  await w.a.store.enqueue(many.map((id, i) => ({ type: 'task_add', uuid: `uuid-veel-${String(i).padStart(6, '0')}`, args: { id, project_id: w.P, content: `Veel ${i}` } })));
  assert.deepEqual(planGroupDrop(w.a.store.view, many, { project_id: w.P, section_id: null, parent_id: null, beforeId: null }), { ok: false, reason: 'many' });
  // een lijst waar de taken al staan, en de subtaak gaat met haar ouder
  const withKid = planGroupDrop(v, [w.ids[0], w.kid], planTaskDropOnGroup(v, { dragId: w.ids[0], projectId: w.Q, sectionId: null, edge: 'end' }), []);
  assert.equal(withKid.ok, true);
  assert.equal(withKid.count, 1, 'de subtaak gaat met haar ouder mee');
});

test('meldingen bij terugzetten: te laat, geen recht, en een server die het commando nog niet kent', () => {
  setLanguage('nl');
  const say = (type, code, error) => describeCommandError({ cmd: { type }, error_code: code, error });
  assert.match(say('task_restore', 'CONFLICT', 'x'), /^Niet gelukt \(taak terugzetten\)\. Terugzetten lukt niet meer/);
  assert.match(say('section_restore', 'CONFLICT', 'x'), /sectie terugzetten/);
  assert.match(say('task_restore', 'FORBIDDEN', 'x'), /Alleen wie het verwijderde, of de eigenaar/);
  assert.match(say('task_restore', 'UNKNOWN_COMMAND', 'onbekend commando'), /^Niet gelukt \(taak terugzetten\)\./, 'een oudere server kent task_restore niet');
  setLanguage('en');
  try {
    assert.match(say('task_restore', 'CONFLICT', 'te lang geleden'), /Restoring is no longer possible/);
    assert.match(say('task_restore', 'FORBIDDEN', 'x'), /Only the person who deleted it/);
  } finally { setLanguage('nl'); }
});

test('een herinnering weghalen en ongedaan maken: dezelfde herinnering komt terug (onder een nieuw id), ook op de server', async () => {
  const w = await setup();
  const id = await w.a.actions.addReminder(w.ids[1], { type: 'relative', minute_offset: 45 });
  await settle(w.a);
  const { entry } = await w.a.actions.track('herinnering weg', () => w.a.actions.deleteReminder(id));
  assert.ok(entry);
  assert.equal([...w.a.store.view.reminders.values()].length, 0);
  await w.a.actions.undoLast();
  await settle(w.a);
  assert.deepEqual(w.a.errors, []);
  const back = [...w.a.store.view.reminders.values()];
  assert.equal(back.length, 1);
  assert.equal(back[0].minute_offset, 45);
  assert.equal(back[0].task_id, w.ids[1]);
  assert.notEqual(back[0].id, id);
});

test('samen slepen vóór een taak die zelf meegaat: de volgorde blijft kloppen (vóór de eerstvolgende die blijft staan)', async () => {
  const w = await setup();
  const v = w.a.store.view;
  const topNoSection = (state) => [...state.tasks.values()].filter((t) => t.project_id === w.P && !t.section_id && !t.parent_id).sort((x, y) => (x.order_key < y.order_key ? -1 : 1)).map((t) => t.id);
  const start = topNoSection(v);
  assert.deepEqual(start, [w.ids[0], w.ids[2], w.ids[4]]);
  const r = planGroupDrop(v, [w.ids[2], w.ids[4]], { project_id: w.P, section_id: null, parent_id: null, beforeId: w.ids[2] }, start);
  assert.equal(r.ok, true);
  const sim = cloneState(v);
  for (const c of r.commands) applyCommand(sim, c, '2026-11-14T10:00:00.000Z');
  assert.deepEqual(topNoSection(sim), [w.ids[0], w.ids[2], w.ids[4]], 'ze blijven in de volgorde van de lijst, achter Café');
  // vóór de laatste, met een van de twee gekozen taken aan het eind: de gekozen taken komen vóór de eerstvolgende die blijft staan
  const r2 = planGroupDrop(v, [w.ids[0], w.ids[2]], { project_id: w.P, section_id: null, parent_id: null, beforeId: w.ids[0] }, start);
  const sim2 = cloneState(v);
  for (const c of r2.commands) applyCommand(sim2, c, '2026-11-14T10:00:00.000Z');
  assert.deepEqual(topNoSection(sim2), [w.ids[0], w.ids[2], w.ids[4]]);
});

test('afvinken slaat afgevinkte taken over en heropenen alleen die', async () => {
  const w = await setup();
  await w.a.actions.completeTask(w.ids[1]);
  const v = w.a.store.view;
  const done = planComplete(v, [w.ids[0], w.ids[1], w.ids[2]], (id) => w.a.actions.planComplete(id));
  assert.equal(done.count, 2, 'de afgevinkte taak telt niet mee');
  assert.deepEqual(done.commands.map((c) => c.args.id).sort(), [w.ids[0], w.ids[2]].sort());
  const reopen = planReopen(v, [w.ids[0], w.ids[1], w.ids[2]]);
  assert.deepEqual(reopen.commands.map((c) => c.args.id), [w.ids[1]]);
  const info = selectionInfo(v, [w.ids[0], w.ids[1], w.ids[2]]);
  assert.deepEqual([info.count, info.open, info.done], [3, 2, 1]);
});
