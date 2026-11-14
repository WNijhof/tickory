// Sjablonen in de client: een project of taak omzetten in een sjabloon, een sjabloon omzetten in één reeks commando's (tegen de echte
// server-engine, in het geheugen), de grenzen, de relatieve datums, de meegeleverde sjablonen en het lezen van bestanden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync } from '../../server/sync.ts';
import { LIMITS } from '../../server/limits.ts';
import { firstUser, mkdb } from '../../server/testutil.ts';
import { APPLY_LIMITS, TEMPLATE_LIMITS, checkTemplateContent, templateStats } from '../../shared/template.js';
import { isValidKey } from '../../shared/orderKey.js';
import { setLanguage } from './i18n.js';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { dateSpan, previewLines, quotaProblem, relativeDayText, taskDate, templateFromProject, templateFromTask, templateList } from './templates.js';
import { starterTemplates } from './starters/index.js';
import { exportTemplate, parseTemplateFile, templateFileName } from './templateFile.js';

let counter = 0;
function makeClient(db = mkdb()) {
  let clock = Date.parse('2026-11-13T10:00:00Z');
  const store = new Store(new MemoryAdapter(), { now: () => new Date((clock += 1000)).toISOString(), onPersistError: () => {} });
  const errors = [];
  const sync = new SyncClient({
    store, transport: async (body) => JSON.parse(JSON.stringify(handleSync(db, JSON.parse(JSON.stringify(body)), firstUser(db).id))),
    onCommandErrors: (e) => errors.push(...e),
  });
  const actions = createActions(store, { makeId: () => `id${String(++counter).padStart(10, '0')}`, makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}` });
  return { db, store, sync, actions, errors };
}
const ready = async (c) => { await c.store.init(); await c.sync.syncNow(); return c; };
const inbox = (c) => c.store.me.inbox_project_id;
const tasksOf = (view, projectId) => [...view.tasks.values()].filter((x) => x.project_id === projectId);

/** Vergelijkbare momentopname van wat een sjabloon aanmaakt (zonder id's en tijdstempels). */
function shape(view, projectId) {
  const sections = [...view.sections.values()].filter((s) => s.project_id === projectId).sort((a, b) => (a.order_key < b.order_key ? -1 : 1));
  const name = (id) => view.sections.get(id)?.name ?? null;
  const label = (id) => view.labels.get(id)?.name;
  return {
    sections: sections.map((s) => s.name),
    tasks: tasksOf(view, projectId).sort((a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : 0)).map((x) => ({
      content: x.content, section: name(x.section_id), parent: view.tasks.get(x.parent_id)?.content ?? null, priority: x.priority,
      labels: x.labels.map(label).sort(), due: x.due, duration: x.duration, description: x.description,
    })),
  };
}

const SMALL = {
  name: 'Klus', kind: 'project', description: '', color: 'teal',
  content: {
    v: 1,
    tasks: [{ content: 'Eerst dit', day: 0 }],
    sections: [
      { name: 'Voorbereiden', tasks: [
        { content: 'Bellen', priority: 1, day: 3, time: '09:30', labels: ['telefoon', 'Café'], duration: 15, description: 'Vraag naar de prijs', subtasks: [{ content: 'Nummer opzoeken' }, { content: 'Offerte vragen', day: 4 }] },
        { content: 'Wekelijks overleg', day: 0, recurrence: { freq: 'weekly', byweekday: [5] }, repeat_text: 'elke vrijdag' },
      ] },
      { name: 'Uitvoeren', tasks: [{ content: 'Doen', day: 7 }] },
    ],
  },
};

test('een project uit een sjabloon: één reeks commando\'s, op de server en lokaal precies gelijk', async () => {
  const c = await ready(makeClient());
  const res = await c.actions.createProjectFromTemplate(SMALL, { name: 'Dakkapel', startDate: '2026-11-18' }); // woensdag
  assert.equal(res.ok, true);
  assert.deepEqual(res.counts, { tasks: 6, sections: 2, newSections: 2, newLabels: 2, reminders: 1 });
  const optimistic = shape(c.store.view, res.id);
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
  assert.equal(c.store.queueLength, 0);
  assert.deepEqual(shape(c.store.view, res.id), optimistic, 'na de sync staat er hetzelfde als vooraf lokaal getoond');
  const project = c.store.view.projects.get(res.id);
  assert.equal(project.name, 'Dakkapel');
  assert.equal(project.color, 'teal');
  const s = shape(c.store.view, res.id);
  assert.deepEqual(s.sections, ['Voorbereiden', 'Uitvoeren']);
  const byContent = Object.fromEntries(s.tasks.map((x) => [x.content, x]));
  assert.equal(byContent['Eerst dit'].section, null);
  assert.deepEqual(byContent['Eerst dit'].due, { date: '2026-11-18' });
  assert.deepEqual(byContent.Bellen.due, { date: '2026-11-21T09:30' }, 'dag 3 met een tijd');
  assert.deepEqual([byContent.Bellen.priority, byContent.Bellen.duration, byContent.Bellen.description], [1, 15, 'Vraag naar de prijs']);
  assert.deepEqual(byContent.Bellen.labels, ['Café', 'telefoon']);
  assert.equal(byContent['Nummer opzoeken'].parent, 'Bellen');
  assert.equal(byContent['Nummer opzoeken'].section, 'Voorbereiden', 'een subtaak volgt de sectie van haar ouder');
  assert.deepEqual(byContent['Offerte vragen'].due, { date: '2026-11-22' });
  assert.deepEqual(byContent['Wekelijks overleg'].due, { date: '2026-11-20', string: 'elke vrijdag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [5] } }, 'de herhaling blijft; de eerste keer is de eerste vrijdag');
  assert.deepEqual(byContent.Doen.due, { date: '2026-11-25' });
  const reminders = [...c.store.view.reminders.values()];
  assert.equal(reminders.length, 1, 'alleen de taak met een tijd krijgt de automatische herinnering');
  assert.deepEqual([reminders[0].type, reminders[0].minute_offset], ['relative', 30]);
});

test('zonder startdatum: geen datums, behalve een herhaling (die begint vanaf vandaag)', async () => {
  const c = await ready(makeClient());
  const res = await c.actions.createProjectFromTemplate(SMALL, { name: 'Zonder', startDate: null });
  await c.sync.syncNow();
  const dues = Object.fromEntries(shape(c.store.view, res.id).tasks.map((x) => [x.content, x.due]));
  assert.equal(dues['Eerst dit'], null);
  assert.equal(dues.Bellen, null);
  assert.equal(dues.Doen, null);
  assert.equal(dues['Wekelijks overleg'].recurrence.freq, 'weekly');
  assert.match(dues['Wekelijks overleg'].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(`${dues['Wekelijks overleg'].date}T00:00:00Z`).getUTCDay(), 5, 'vandaag of daarna, op een vrijdag');
  assert.equal([...c.store.view.reminders.values()].length, 0, 'zonder tijd geen automatische herinnering');
});

test('de volgordesleutels: geldig, oplopend per lijst, en het project komt achteraan in de zijbalk', async () => {
  const c = await ready(makeClient());
  await c.actions.addProject({ name: 'Bestaand' });
  const res = await c.actions.createProjectFromTemplate(SMALL, { name: 'Nieuw', startDate: null });
  const view = c.store.view;
  const keys = (list) => list.map((x) => x.order_key);
  const lists = new Map();
  for (const x of tasksOf(view, res.id)) lists.set(`${x.section_id}|${x.parent_id}`, [...(lists.get(`${x.section_id}|${x.parent_id}`) ?? []), x]);
  for (const list of lists.values()) {
    assert.ok(keys(list).every(isValidKey));
    assert.deepEqual(keys(list), [...keys(list)].sort(), 'in de volgorde van het sjabloon');
    assert.equal(new Set(keys(list)).size, list.length, 'geen dubbele sleutels');
  }
  const top = [...view.projects.values()].filter((p) => !p.parent_id && p.name !== 'Inbox').sort((a, b) => (a.order_key < b.order_key ? -1 : 1)).map((p) => p.name);
  assert.deepEqual(top, ['Bestaand', 'Nieuw']);
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
});

test('een taaksjabloon invoegen: bestaande sectie hergebruiken, nieuwe maken, achteraan, en ongedaan maken', async () => {
  const c = await ready(makeClient());
  const pid = await c.actions.addProject({ name: 'Huis' });
  const sectionId = await c.actions.addSection(pid, 'voorbereiden'); // andere hoofdletters dan in het sjabloon
  await c.actions.addTask({ content: 'Al aanwezig', project_id: pid, section_id: sectionId });
  const tpl = { name: 'Los', kind: 'task', description: '', color: 'charcoal', content: SMALL.content };
  const res = await c.actions.insertTemplate(tpl, { projectId: pid, startDate: '2026-11-18' });
  assert.equal(res.ok, true);
  assert.equal(res.counts.newSections, 1, 'alleen "Uitvoeren" is nieuw');
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
  const view = c.store.view;
  assert.equal([...view.sections.values()].filter((s) => s.project_id === pid).length, 2);
  const inSection = tasksOf(view, pid).filter((x) => x.section_id === sectionId && !x.parent_id).sort((a, b) => (a.order_key < b.order_key ? -1 : 1)).map((x) => x.content);
  assert.deepEqual(inSection, ['Al aanwezig', 'Bellen', 'Wekelijks overleg'], 'achter wat er al stond');
  assert.equal(tasksOf(view, pid).length, 1 + 6);
  await res.undo();
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
  assert.deepEqual(tasksOf(c.store.view, pid).map((x) => x.content), ['Al aanwezig'], 'ongedaan maken haalt de ingevoegde taken weg');
  assert.deepEqual([...c.store.view.sections.values()].filter((s) => s.project_id === pid).map((s) => s.name), ['voorbereiden']);
});

test('ongedaan maken van een nieuw project verwijdert het met alles erin', async () => {
  const c = await ready(makeClient());
  const res = await c.actions.createProjectFromTemplate(SMALL, { name: 'Weg', startDate: null });
  await res.undo();
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
  assert.equal(c.store.view.projects.has(res.id), false);
  assert.equal(tasksOf(c.store.view, res.id).length, 0);
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND is_deleted = 0').get(res.id).n, 0);
});

test('offline: de hele reeks staat meteen lokaal en gaat daarna in porties van 100 naar de server', async () => {
  const c = makeClient();
  await c.store.init();
  const big = { v: 1, tasks: Array.from({ length: 450 }, (_, i) => ({ content: `Taak ${i + 1}`, day: i % 30 })), sections: [] };
  const res = await c.actions.createProjectFromTemplate({ name: 'Groot', kind: 'project', color: 'charcoal', content: big }, { name: 'Groot', startDate: '2027-01-04' });
  assert.equal(res.ok, true);
  assert.equal(c.store.queueLength, 451);
  assert.equal(tasksOf(c.store.view, res.id).length, 450, 'lokaal direct zichtbaar, zonder server');
  await c.sync.syncNow();
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(res.id).n, 450);
});

test('grenzen van de server worden vooraf gemeld: er wordt dan niets in de wachtrij gezet', async () => {
  const c = await ready(makeClient());
  let view = c.store.view; // na elke geslaagde handeling is store.view een nieuw object
  const me = c.store.userId;
  const before = () => ({ queue: c.store.queueLength, projects: view.projects.size, tasks: view.tasks.size, sections: view.sections.size, labels: view.labels.size });
  const fake = (map, n, make) => { for (let i = 0; i < n; i++) map.set(`fake${map.size}x${i}`, make(i)); };
  const timed = { v: 1, tasks: [{ content: 'Met tijd', day: 0, time: '09:00' }, { content: 'Ook met tijd', day: 1, time: '10:00' }], sections: [] };

  // projecten: 500 als eigenaar is het maximum
  const tpl = { name: 'Klus', kind: 'project', color: 'charcoal', content: SMALL.content };
  fake(view.members, APPLY_LIMITS.projectsPerUser - 1, (i) => ({ id: `m${i}`, project_id: `p${i}`, user_id: me, role: 'owner' }));
  const snapshot = before();
  const owned = [...view.members.values()].filter((m) => m.role === 'owner' && m.user_id === me).length;
  assert.equal(owned, APPLY_LIMITS.projectsPerUser, 'de Inbox telt mee: dit is het maximum');
  const full = await c.actions.createProjectFromTemplate(tpl, { name: 'Nog een', startDate: null });
  assert.deepEqual(full, { ok: false, problem: { code: 'projects', limit: 500, have: 500, need: 1 } });
  assert.deepEqual(before(), snapshot, 'niets aangemaakt');
  for (const [key, m] of [...view.members]) if (m.id.startsWith('m') && m.project_id.startsWith('p')) view.members.delete(key);
  assert.equal((await c.actions.createProjectFromTemplate(tpl, { name: 'Past wel', startDate: null })).ok, true, 'na ruimte maken past het');
  view = c.store.view;

  // secties: 200 per project
  const pid = await c.actions.addProject({ name: 'Veel secties' });
  view = c.store.view;
  fake(view.sections, APPLY_LIMITS.sectionsPerProject - 1, (i) => ({ id: `s${i}`, project_id: pid, name: `S${i}`, order_key: `V${i}`, is_archived: false }));
  const sections = before();
  const noRoom = await c.actions.insertTemplate({ ...tpl, kind: 'task' }, { projectId: pid, startDate: null });
  assert.deepEqual([noRoom.ok, noRoom.problem.code, noRoom.problem.have, noRoom.problem.need], [false, 'sections', 199, 2]);
  assert.deepEqual(before(), sections);
  const sameSections = { v: 1, tasks: [{ content: 'x' }], sections: [{ name: 'S1', tasks: [{ content: 'y' }] }] };
  assert.equal((await c.actions.insertTemplate({ ...tpl, kind: 'task', content: sameSections }, { projectId: pid, startDate: null })).ok, true, 'een bestaande sectie hergebruiken kost geen ruimte');
  view = c.store.view;

  // labels: 500 per gebruiker; bestaande namen tellen niet mee
  fake(view.labels, APPLY_LIMITS.labelsPerUser - 1 - view.labels.size, (i) => ({ id: `l${i}`, name: `bestaand ${i}`, owner_id: me, order_key: `V${i}` }));
  const withLabels = (names) => ({ ...tpl, content: { v: 1, tasks: names.map((n) => ({ content: n, labels: [n] })), sections: [] } });
  const lbl = before();
  const tooManyLabels = await c.actions.createProjectFromTemplate(withLabels(['nieuw1', 'nieuw2']), { name: 'Labels', startDate: null });
  assert.equal(tooManyLabels.problem.code, 'labels');
  assert.deepEqual(before(), lbl);
  assert.equal((await c.actions.createProjectFromTemplate(withLabels(['nieuw1', 'bestaand 3']), { name: 'Labels', startDate: null })).ok, true, 'één nieuw label past, een bestaand telt niet');
  view = c.store.view;

  // herinneringen: 5000 per gebruiker, en alleen taken met een tijd maken er een
  fake(view.reminders, APPLY_LIMITS.remindersPerUser - 1, (i) => ({ id: `r${i}`, task_id: `t${i}`, owner_id: me, type: 'relative', minute_offset: 5 }));
  const rem = before();
  const tooManyReminders = await c.actions.createProjectFromTemplate({ ...tpl, content: timed }, { name: 'Tijd', startDate: '2027-02-01' });
  assert.deepEqual([tooManyReminders.ok, tooManyReminders.problem.code, tooManyReminders.problem.need], [false, 'reminders', 2]);
  assert.deepEqual(before(), rem);
  assert.equal((await c.actions.createProjectFromTemplate({ ...tpl, content: timed }, { name: 'Tijd', startDate: null })).ok, true, 'zonder datums geen tijd, dus geen herinneringen');
  view = c.store.view;

  // sjablonen: 100 per gebruiker
  fake(view.templates, APPLY_LIMITS.templatesPerUser, (i) => ({ id: `tp${i}`, name: `T${i}`, kind: 'task', owner_id: me, content: SMALL }));
  const queued = c.store.queueLength;
  const saved = await c.actions.saveTemplate({ kind: 'task', name: 'Nog een', content: SMALL });
  assert.deepEqual(saved, { ok: false, problem: { code: 'templates', limit: 100, have: 100, need: 1 } });
  assert.equal(c.store.queueLength, queued);
});

test('veel nieuwe labels in één sjabloon: korte, geldige en oplopende sleutels (de server accepteert ze allemaal)', async () => {
  const c = await ready(makeClient());
  const names = Array.from({ length: 300 }, (_, i) => `label ${String(i).padStart(3, '0')}`);
  const tpl = { name: 'Veel labels', kind: 'project', color: 'charcoal', content: { v: 1, tasks: names.map((n) => ({ content: n, labels: [n] })), sections: [] } };
  const res = await c.actions.createProjectFromTemplate(tpl, { name: 'Veel labels', startDate: null });
  assert.equal(res.ok, true);
  assert.equal(res.counts.newLabels, 300);
  await c.sync.syncNow();
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
  const keys = [...c.store.view.labels.values()].map((l) => l.order_key);
  assert.equal(keys.length, 300);
  assert.ok(keys.every(isValidKey) && new Set(keys).size === 300);
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM labels WHERE is_deleted = 0').get().n, 300);
  assert.equal(tasksOf(c.store.view, res.id).filter((x) => x.labels.length === 1).length, 300, 'elke taak heeft haar label');
});

test('de kopie van de grenzen in shared/template.js is gelijk aan server/limits.ts', () => {
  for (const [key, value] of Object.entries(APPLY_LIMITS)) assert.equal(LIMITS[key], value, `${key}: shared/template.js (APPLY_LIMITS) en server/limits.ts verschillen`);
  assert.equal(LIMITS.tasksPerTemplate, TEMPLATE_LIMITS.tasks);
});

test('een project met 10.000 taken wijst een sjabloon met taken vooraf af (tasksPerProject)', async () => {
  const c = await ready(makeClient());
  const pid = await c.actions.addProject({ name: 'Vol' });
  // 9.999 taken in het project: lokaal in het geheugen gezet, zonder server
  const view = c.store.view;
  for (let i = 0; i < APPLY_LIMITS.tasksPerProject - 1; i++) view.tasks.set(`vol${i}`, { id: `vol${i}`, project_id: pid, creator_id: c.store.userId, content: 'x', order_key: 'V', labels: [] });
  const problem = quotaProblem(view, c.store.userId, { projectId: pid, sections: 0, tasks: 2, labels: 0, reminders: 0 });
  assert.deepEqual(problem, { code: 'tasksPerProject', limit: 10_000, have: 9_999, need: 2 });
  assert.equal(quotaProblem(view, c.store.userId, { projectId: pid, sections: 0, tasks: 1, labels: 0, reminders: 0 }), null);
});

test('project als sjabloon bewaren: open taken, secties, labels op naam, datums relatief, herhaling blijft, herinneringen en opmerkingen niet', async () => {
  const c = await ready(makeClient());
  const pid = await c.actions.addProject({ name: 'Verbouwing', color: 'brown' });
  const sec = await c.actions.addSection(pid, 'Keuken');
  const a = await c.actions.addTask({ content: 'Offerte', project_id: pid, section_id: sec, priority: 2, due: { date: '2026-12-01T10:00' }, newLabels: ['klus'], description: 'drie stuks', duration: 30 });
  await c.actions.addTask({ content: 'Meten', project_id: pid, parent_id: a, due: { date: '2026-12-03' } });
  const done = await c.actions.addTask({ content: 'Klaar', project_id: pid });
  await c.actions.completeTask(done);
  await c.actions.addTask({ content: 'Wekelijks', project_id: pid, due: { date: '2026-12-11', string: 'elke vrijdag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [5] } } });
  await c.actions.addComment({ taskId: a }, 'opmerking');
  await c.actions.addReminder(a, { type: 'relative', minute_offset: 10 });
  await c.actions.assignTask(a, c.store.userId);
  await c.actions.updateTask(a, { deadline: '2026-12-05' });
  const r = templateFromProject(c.store.view, pid, { name: ' Mijn verbouwing ', dates: true });
  assert.ok(r.template, JSON.stringify(r));
  assert.equal(r.template.name, 'Mijn verbouwing');
  assert.equal(r.template.color, 'brown');
  assert.equal(checkTemplateContent(r.template.content), null);
  assert.deepEqual(r.template.content, {
    v: 1,
    tasks: [{ content: 'Wekelijks', day: 10, recurrence: { freq: 'weekly', byweekday: [5] }, repeat_text: 'elke vrijdag' }],
    sections: [{ name: 'Keuken', tasks: [{
      content: 'Offerte', description: 'drie stuks', priority: 2, labels: ['klus'], duration: 30, day: 0, time: '10:00',
      subtasks: [{ content: 'Meten', day: 2 }],
    }] }],
  });
  const json = JSON.stringify(r.template);
  for (const verboden of ['opmerking', 'deadline', 'assignee', 'reminder', 'Klaar', c.store.userId]) assert.ok(!json.includes(verboden), `${verboden} hoort niet in een sjabloon`);
  const plain = templateFromProject(c.store.view, pid, { name: 'Zonder datums', dates: false });
  const wk = plain.template.content.tasks[0];
  assert.deepEqual([wk.day, wk.recurrence.freq], [0, 'weekly'], 'zonder datums blijft een herhaling bestaan');
  assert.equal(plain.template.content.sections[0].tasks[0].day, undefined);
});

test('taak als sjabloon bewaren: met subtaken, dag 0 is de datum van de taak, de sectie gaat mee op verzoek', async () => {
  const c = await ready(makeClient());
  const pid = await c.actions.addProject({ name: 'P' });
  const sec = await c.actions.addSection(pid, 'Week 1');
  const a = await c.actions.addTask({ content: 'Tentamen voorbereiden', project_id: pid, section_id: sec, due: { date: '2026-12-10' } });
  const b = await c.actions.addTask({ content: 'Samenvatting', project_id: pid, parent_id: a, due: { date: '2026-12-07' } });
  await c.actions.addTask({ content: 'Oefenen', project_id: pid, parent_id: b });
  const r = templateFromTask(c.store.view, a, { name: 'Tentamen', withSection: true });
  assert.deepEqual(r.template.content, { v: 1, tasks: [], sections: [{ name: 'Week 1', tasks: [{ content: 'Tentamen voorbereiden', day: 0, subtasks: [{ content: 'Samenvatting', day: -3, subtasks: [{ content: 'Oefenen' }] }] }] }] });
  assert.equal(r.template.kind, 'task');
  const without = templateFromTask(c.store.view, a, { name: 'Tentamen', withSection: false });
  assert.equal(without.template.content.sections.length, 0);
  assert.equal(without.template.content.tasks.length, 1);
  assert.equal(templateFromTask(c.store.view, 'bestaat-niet-1', { name: 'x' }).problem.code, 'gone');
});

test('zeer diepe subtaken worden platgeslagen tot het maximum, en een te groot project geeft een nette melding', async () => {
  const c = await ready(makeClient());
  const pid = await c.actions.addProject({ name: 'Diep' });
  let parent = null;
  for (let i = 1; i <= 7; i++) parent = await c.actions.addTask({ content: `Niveau ${i}`, project_id: pid, parent_id: parent });
  const r = templateFromProject(c.store.view, pid, { name: 'Diep' });
  assert.ok(r.template);
  assert.equal(checkTemplateContent(r.template.content), null);
  assert.equal(templateStats(r.template.content).tasks, 7, 'er gaat niets verloren');
  const names = [];
  const walk = (list, depth) => { for (const x of list) { names.push(`${depth}:${x.content}`); walk(x.subtasks ?? [], depth + 1); } };
  walk(r.template.content.tasks, 1);
  assert.deepEqual(names, ['1:Niveau 1', '2:Niveau 2', '3:Niveau 3', '4:Niveau 4', '4:Niveau 5', '4:Niveau 6', '4:Niveau 7']);

  const empty = await c.actions.addProject({ name: 'Leeg' });
  assert.equal(templateFromProject(c.store.view, empty, { name: 'Leeg' }).problem.code, 'empty');
  const huge = await c.actions.addProject({ name: 'Enorm' });
  for (let i = 0; i < 1001; i++) c.store.view.tasks.set(`t${i}`, { id: `t${i}`, project_id: huge, content: `T${i}`, order_key: `V${i}`, labels: [], priority: 4 });
  const many = templateFromProject(c.store.view, huge, { name: 'Enorm' });
  assert.deepEqual(many.problem, { code: 'tooMany', count: 1001, limit: 1000 });
});

test('relatieve datums in woorden: dag 0, +3 dagen, +1 week, -2 dagen', () => {
  setLanguage('nl');
  assert.deepEqual([0, 1, 3, 7, 14, 10, -1, -2, -7].map((d) => relativeDayText(d)), ['dag 0', '+1 dag', '+3 dagen', '+1 week', '+2 weken', '+10 dagen', '-1 dag', '-2 dagen', '-1 week']);
  assert.equal(relativeDayText(2, '09:30'), '+2 dagen 09:30');
  setLanguage('en');
  try {
    assert.deepEqual([0, 1, 3, 7, 14, -2].map((d) => relativeDayText(d)), ['day 0', '+1 day', '+3 days', '+1 week', '+2 weeks', '-2 days']);
  } finally {
    setLanguage('nl');
  }
});

test('taskDate: startdatum plus dagen, tijd erbij, herhaling op de eerste passende dag, schrikkeljaar en onmogelijke datums', () => {
  const ctx = { startDate: '2028-02-27', today: '2026-11-13' };
  assert.equal(taskDate({ content: 'a', day: 2 }, ctx), '2028-02-29', 'schrikkeldag');
  assert.equal(taskDate({ content: 'a', day: 3, time: '08:05' }, ctx), '2028-03-01T08:05');
  assert.equal(taskDate({ content: 'a' }, ctx), null);
  assert.equal(taskDate({ content: 'a', day: 1 }, { startDate: null, today: '2026-11-13' }), null);
  assert.equal(taskDate({ content: 'a', day: 1, recurrence: { freq: 'daily' } }, { startDate: null, today: '2026-11-13' }), '2026-11-14');
  assert.equal(taskDate({ content: 'a', day: 0, recurrence: { freq: 'weekly', byweekday: [2] } }, { startDate: '2026-11-13', today: '2026-11-13' }), '2026-11-17', 'vrijdag -> eerstvolgende dinsdag');
  assert.equal(taskDate({ content: 'a', day: 0, recurrence: { freq: 'weekly', byweekday: [5] } }, { startDate: '2026-11-13', today: '2026-11-13' }), '2026-11-13', 'valt de startdag zelf op de weekdag, dan die dag');
  assert.equal(taskDate({ content: 'a', day: 0, recurrence: { freq: 'monthly', byweekday: [2], nth: 2 } }, { startDate: '2026-11-01', today: '2026-11-13' }), '2026-11-10', 'tweede dinsdag');
  assert.equal(taskDate({ content: 'a', day: 3650 }, { startDate: '9999-12-30', today: '2026-11-13' }), null, 'voorbij 9999 is geen datum');
  assert.equal(taskDate({ content: 'a', day: -5 }, { startDate: '2026-11-03', today: '2026-11-13' }), '2026-10-29', 'ook vóór de startdatum');
});

test('de voorbeeldweergave: eerste regels, secties, aantal dat er niet bij staat, en het bereik van de datums', () => {
  const v = previewLines(SMALL.content, 4);
  assert.deepEqual(v.lines.map((l) => `${l.kind}:${l.depth}:${l.text}`), ['task:1:Eerst dit', 'section:0:Voorbereiden', 'task:1:Bellen', 'task:2:Nummer opzoeken', 'task:2:Offerte vragen']);
  assert.equal(v.more, 2);
  assert.deepEqual(previewLines(SMALL.content, 100), { lines: previewLines(SMALL.content, 100).lines, more: 0 });
  assert.deepEqual(dateSpan(SMALL.content, '2026-11-16'), { from: '2026-11-16', to: '2026-11-23' });
  assert.equal(dateSpan(SMALL.content, null), null);
  assert.equal(dateSpan({ v: 1, tasks: [{ content: 'a' }], sections: [] }, '2026-11-16'), null);
});

// ---------- de meegeleverde sjablonen ----------

test('meegeleverde sjablonen: zes projecten en twee taken in elke taal, gelijk van opbouw, geldig, 8 tot 20 taken, met secties en relatieve datums', () => {
  const all = { nl: starterTemplates('nl'), en: starterTemplates('en') };
  assert.deepEqual(all.nl.map((x) => x.id), all.en.map((x) => x.id), 'dezelfde sjablonen in beide talen');
  assert.deepEqual(all.nl.map((x) => x.id), ['starter:moving', 'starter:holiday', 'starter:menu', 'starter:birthday', 'starter:onboarding', 'starter:renovation', 'starter:gift', 'starter:meeting']);
  assert.deepEqual(all.nl.map((x) => x.name), ['Verhuizen', 'Op vakantie gaan (inpaklijst)', 'Weekmenu en boodschappen', 'Kinderverjaardag organiseren', 'Nieuwe medewerker inwerken', 'Verbouwing', 'Cadeau regelen', 'Vergadering voorbereiden']);
  const nl = all.nl.filter((x) => x.kind === 'project');
  const en = all.en.filter((x) => x.kind === 'project');
  assert.equal(nl.length, 6);
  for (const tpl of [...all.nl, ...all.en]) {
    assert.equal(checkTemplateContent(tpl.content), null, tpl.id);
    assert.ok(tpl.builtin);
    if (tpl.kind === 'task') {
      assert.equal(tpl.content.tasks.length, 1, `${tpl.id}: een taak met subtaken`);
      assert.ok(templateStats(tpl.content).subtasks >= 3);
    }
  }
  for (const list of [nl, en]) {
    for (const tpl of list) {
      assert.equal(tpl.kind, 'project');
      const stats = templateStats(tpl.content);
      assert.ok(stats.tasks >= 8 && stats.tasks <= 20, `${tpl.id}: ${stats.tasks} taken`);
      assert.ok(stats.sections >= 2, `${tpl.id}: secties`);
      assert.ok(stats.dated >= stats.tasks - stats.subtasks, `${tpl.id}: elke taak van het hoogste niveau heeft een relatieve datum`);
      assert.ok(tpl.description.length > 20 && tpl.description.length <= TEMPLATE_LIMITS.templateDescription);
      assert.ok(tpl.description.includes('Dag 0') || tpl.description.includes('Day 0') || tpl.id === 'starter:menu', `${tpl.id}: de omschrijving legt dag 0 uit`);
    }
  }
  for (const [a, b] of all.nl.map((x, i) => [x, all.en[i]])) {
    const sa = templateStats(a.content);
    const sb = templateStats(b.content);
    assert.deepEqual([sa.tasks, sa.sections, sa.subtasks, sa.recurring, sa.dated, sa.timed], [sb.tasks, sb.sections, sb.subtasks, sb.recurring, sb.dated, sb.timed], `${a.id}: Nederlands en Engels hebben dezelfde opbouw`);
  }
  assert.equal(starterTemplates('fr')[0].name, 'Verhuizen', 'een onbekende taal valt terug op Nederlands');
});

test('elk meegeleverd sjabloon is toe te passen op de server, in beide talen, zonder foutmeldingen', async () => {
  for (const lang of ['nl', 'en']) {
    const c = await ready(makeClient());
    for (const tpl of starterTemplates(lang).filter((x) => x.kind === 'project')) {
      const res = await c.actions.createProjectFromTemplate(tpl, { name: tpl.name, startDate: '2026-11-16' });
      assert.equal(res.ok, true, `${lang} ${tpl.id}`);
      assert.equal(res.counts.tasks, templateStats(tpl.content).tasks);
    }
    const target = await c.actions.addProject({ name: 'Doel' });
    for (const tpl of starterTemplates(lang).filter((x) => x.kind === 'task')) {
      const res = await c.actions.insertTemplate(tpl, { projectId: target, startDate: '2026-11-16' });
      assert.equal(res.ok, true, `${lang} ${tpl.id}`);
    }
    await c.sync.syncNow();
    await c.sync.syncNow();
    assert.deepEqual(c.errors, [], lang);
    assert.equal(c.store.queueLength, 0);
    const mine = [...c.store.view.projects.values()].filter((p) => !p.parent_id && p.id !== inbox(c));
    assert.equal(mine.length, 7, 'zes projecten uit sjablonen en het doelproject');
    // elke herhalende taak begint op de goede weekdag
    for (const task of c.store.view.tasks.values()) {
      const rec = task.due?.recurrence;
      if (rec?.freq === 'weekly' && rec.byweekday) assert.equal((new Date(`${task.due.date.slice(0, 10)}T00:00:00Z`).getUTCDay() || 7), rec.byweekday[0], `${lang}: ${task.content}`);
    }
  }
});

test('de Nederlandse sjablonen: geen Engelse restanten, geen dubbele spaties, correcte hoofdletters en leestekens', () => {
  for (const tpl of starterTemplates('nl')) {
    const texts = [tpl.name, tpl.description];
    const walk = (list) => { for (const x of list) { texts.push(x.content, ...(x.labels ?? [])); walk(x.subtasks ?? []); } };
    walk(tpl.content.tasks);
    for (const s of tpl.content.sections) { texts.push(s.name); walk(s.tasks); }
    for (const text of texts) {
      assert.equal(text, text.normalize('NFC'));
      assert.ok(!/\s{2,}|^\s|\s$/.test(text), `spaties in "${text}"`);
      assert.ok(/^[\p{L}\p{N}]/u.test(text), `begint niet met een letter of cijfer: "${text}"`);
      assert.ok(!/\b(the|and|with|your|week before)\b/i.test(text), `Engels woord in "${text}"`);
    }
  }
});

// ---------- bestanden ----------

const FILE_SAMPLE = { name: 'Klus', kind: 'project', description: 'Een voorbeeld', color: 'teal', content: SMALL.content };

test('exporteren en weer importeren: hetzelfde sjabloon, in JSON zoals afgesproken', () => {
  const text = exportTemplate(FILE_SAMPLE);
  const data = JSON.parse(text);
  assert.deepEqual(Object.keys(data), ['format', 'version', 'name', 'kind', 'description', 'color', 'content']);
  assert.equal(data.format, 'tickory-template');
  const back = parseTemplateFile(text);
  assert.equal(back.ok, true);
  assert.deepEqual(back.template, FILE_SAMPLE);
  assert.equal(templateFileName('Op vakantie gaan (inpaklijst)'), 'tickory-template-op-vakantie-gaan-inpaklijst.json');
  assert.equal(templateFileName('Café Zoë'), 'tickory-template-cafe-zoe.json');
  assert.equal(templateFileName('???'), 'tickory-template-sjabloon.json');
  for (const tpl of starterTemplates('nl')) assert.deepEqual(parseTemplateFile(exportTemplate(tpl)).template.content, tpl.content, `${tpl.id} heen en terug`);
});

test('een bestand is onbetrouwbare invoer: alles wat niet klopt wordt geweigerd met een code', () => {
  const ok = JSON.parse(exportTemplate(FILE_SAMPLE));
  const bad = (mutate, code) => {
    const data = structuredClone(ok);
    mutate(data);
    const r = parseTemplateFile(JSON.stringify(data));
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, code, JSON.stringify(r));
    return r;
  };
  assert.equal(parseTemplateFile('').code, 'empty');
  assert.equal(parseTemplateFile('  \n ').code, 'empty');
  assert.equal(parseTemplateFile('{ geen json').code, 'notJson');
  assert.equal(parseTemplateFile('[1,2]').ok, false, 'een lijst is geen sjabloon');
  assert.equal(parseTemplateFile('{"a":1}').code, 'invalid');
  assert.equal(parseTemplateFile(JSON.stringify([ok])).ok, false);
  bad((d) => { d.version = 2; }, 'unsupported');
  bad((d) => { d.format = 'todoist'; }, 'invalid');
  bad((d) => { d.kind = 'filter'; }, 'invalid');
  bad((d) => { d.name = ''; }, 'invalid');
  bad((d) => { d.name = 'x'.repeat(201); }, 'invalid');
  bad((d) => { d.name = 5; }, 'invalid');
  bad((d) => { d.extra = true; }, 'invalid');
  bad((d) => { d.description = 'x'.repeat(501); }, 'invalid');
  bad((d) => { d.color = 5; }, 'invalid');
  bad((d) => { d.content = null; }, 'invalid');
  bad((d) => { d.content.extra = 1; }, 'invalid');
  bad((d) => { d.content.v = 2; }, 'invalid');
  bad((d) => { d.content.tasks = {}; }, 'invalid');
  bad((d) => { d.content.sections[0].tasks[0].content = ''; }, 'invalid');
  bad((d) => { d.content.sections[0].tasks[0].content = 'a'.repeat(4001); }, 'invalid');
  bad((d) => { d.content.sections[0].tasks[0].priority = 9; }, 'invalid');
  bad((d) => { d.content.sections[0].tasks[0].day = 1.5; }, 'invalid');
  bad((d) => { d.content.sections[0].tasks[0].day = 99999; }, 'invalid');
  bad((d) => { d.content.sections[0].tasks[0].time = '25:00'; }, 'invalid');
  bad((d) => { d.content.sections[0].tasks[0].labels = ['a,b']; }, 'invalid');
  bad((d) => { d.content.sections[0].tasks[0].labels = ['x', 'X']; }, 'invalid');
  bad((d) => { d.content.sections[0].tasks[0].recurrence = { freq: 'hourly' }; }, 'invalid');
  bad((d) => { d.content.sections[0].tasks[0].assignee_id = 'user-anna'; }, 'invalid');
  bad((d) => { d.content.sections[0].tasks[0].html = '<b>x</b>'; }, 'invalid');
  bad((d) => { d.content.sections[1].name = 'voorbereiden'; }, 'invalid'); // dezelfde sectienaam
  bad((d) => { d.content.tasks = []; d.content.sections = []; }, 'invalid');
  bad((d) => { d.content.tasks[0].content = 'stuur\u0000teken'; }, 'invalid');
  bad((d) => { d.content.tasks[0].content = 'half\ud800'; }, 'invalid');
  // te diep
  bad((d) => { let node = d.content.tasks[0]; for (let i = 0; i < 4; i++) { node.subtasks = [{ content: 'x' }]; node = node.subtasks[0]; } }, 'invalid');
  // te groot
  bad((d) => { d.content.tasks = Array.from({ length: 80 }, (_, i) => ({ content: `${i}${'a'.repeat(3900)}` })); }, 'tooBig');
  assert.equal(parseTemplateFile('x'.repeat(TEMPLATE_LIMITS.fileBytes + 1)).code, 'tooBig');
  // te veel taken (maar klein genoeg in bytes)
  const many = { ...ok, content: { v: 1, tasks: Array.from({ length: 1001 }, () => ({ content: 'a' })), sections: [] } };
  assert.equal(parseTemplateFile(JSON.stringify(many)).code, 'tooMany');
  const exactly = { ...ok, content: { v: 1, tasks: Array.from({ length: 1000 }, () => ({ content: 'a' })), sections: [] } };
  assert.equal(parseTemplateFile(JSON.stringify(exactly)).ok, true, 'precies 1000 mag');
  assert.ok(typeof bad((d) => { d.version = 'x'.repeat(500); }, 'unsupported').detail === 'string');
  assert.ok(bad((d) => { d.version = 'x'.repeat(500); }, 'unsupported').detail.length < 60, 'de melding herhaalt geen lange invoer');
});

test('een bestand met __proto__ of vreemde sleutels verandert niets aan andere objecten', () => {
  const evil = '{"format":"tickory-template","version":1,"name":"x","kind":"project","content":{"v":1,"tasks":[{"content":"a","__proto__":{"polluted":true}}],"sections":[]}}';
  const r = parseTemplateFile(evil);
  assert.equal(r.ok, false);
  assert.equal(({}).polluted, undefined);
  const evil2 = '{"__proto__":{"polluted":true},"format":"tickory-template","version":1,"name":"x","kind":"project","content":{"v":1,"tasks":[{"content":"a"}],"sections":[]}}';
  assert.equal(parseTemplateFile(evil2).ok, false);
  assert.equal(({}).polluted, undefined);
});

test('tekst in een bestand blijft tekst: HTML wordt niet uitgevoerd of aangepast, en NFC wordt toegepast', () => {
  const text = exportTemplate({ ...FILE_SAMPLE, name: 'Cafe\u0301 <b>vet</b>', content: { v: 1, tasks: [{ content: '<img src=x onerror=alert(1)>', description: '<script>alert(1)</script>' }], sections: [] } });
  const r = parseTemplateFile(text);
  assert.equal(r.ok, true);
  assert.equal(r.template.name, 'Café <b>vet</b>', 'NFC; de tekens < en > blijven gewoon staan');
  assert.equal(r.template.content.tasks[0].content, '<img src=x onerror=alert(1)>');
});

test('Todoist CSV: taken, secties, subtaken via INDENT, prioriteit; opmerkingen en datums niet', () => {
  const csv = [
    'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE',
    'task,Boodschappen doen,"Melk, brood en kaas",1,1,Anna (1),,every friday,en,Europe/Amsterdam',
    'task,"Naar de ""bakker""",,4,2,,,,,',
    'task,Tot slot,,3,3,,,,,',
    'note,Een opmerking,,,,,,,,',
    'section,Week 2,,,,,,,,',
    'task,Café bezoeken,,2,1,,,5 jan,en,',
    'meta,view_style=list,,,,,,,,',
    'section,week 2,,,,,,,,',
    'task,Zoë bellen,,4,1,,,,,',
  ].join('\r\n');
  const r = parseTemplateFile(csv, { fallbackName: 'Boodschappen' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.template.name, 'Boodschappen');
  assert.equal(r.template.kind, 'project');
  assert.deepEqual(r.template.content, {
    v: 1,
    tasks: [{ content: 'Boodschappen doen', description: 'Melk, brood en kaas', priority: 1, subtasks: [{ content: 'Naar de "bakker"', subtasks: [{ content: 'Tot slot', priority: 3 }] }] }],
    sections: [{ name: 'Week 2', tasks: [{ content: 'Café bezoeken', priority: 2 }, { content: 'Zoë bellen' }] }],
  }, 'dezelfde sectienaam (ook met andere hoofdletters) is één sectie');
  assert.deepEqual(r.notes, { dates: 2, comments: 1, skipped: 1 });
  assert.equal(parseTemplateFile('TYPE,NAAM\na,b').ok, false);
  assert.equal(parseTemplateFile('TYPE,CONTENT\nnote,x').code, 'invalid', 'geen taken');
  assert.equal(parseTemplateFile('hallo wereld').ok, false);
  const jump = parseTemplateFile('TYPE,CONTENT,INDENT\ntask,A,1\ntask,B,4\ntask,C,9').template.content.tasks[0];
  assert.equal(jump.subtasks[0].content, 'B');
  assert.equal(jump.subtasks[0].subtasks[0].content, 'C');
  // BOM, alleen LF, geen sluitende regeleinde en regeleinden in een veld
  const odd = parseTemplateFile('\uFEFFTYPE,CONTENT,DESCRIPTION\ntask,"A",\"regel 1\nregel 2\"');
  assert.equal(odd.template.content.tasks[0].description, 'regel 1\nregel 2');
  const long = `TYPE,CONTENT\n${'task,x\n'.repeat(1001)}`;
  assert.equal(parseTemplateFile(long).code, 'tooMany');
  assert.equal(parseTemplateFile(`TYPE,CONTENT\n${'task,x\n'.repeat(5100)}`).code, 'tooMany', 'te veel regels: afgekapt voordat alles is ingelezen');
  const ctrl = parseTemplateFile('TYPE,CONTENT\ntask,"a\u0000b"').template.content.tasks[0].content;
  assert.equal(ctrl, 'a b', 'stuurtekens worden vervangen');
});

test('import: een sjabloon uit een bestand is zonder omweg op de server te bewaren en weer te gebruiken', async () => {
  const c = await ready(makeClient());
  const parsed = parseTemplateFile(exportTemplate(FILE_SAMPLE));
  const saved = await c.actions.saveTemplate(parsed.template);
  assert.equal(saved.ok, true);
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
  const row = c.store.view.templates.get(saved.id);
  assert.deepEqual([row.name, row.kind, row.color, row.description, row.owner_id], ['Klus', 'project', 'teal', 'Een voorbeeld', c.store.userId]);
  assert.deepEqual(row.content, FILE_SAMPLE.content);
  await c.actions.updateTemplate(saved.id, { name: 'Anders' });
  await c.actions.deleteTemplate(saved.id);
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
  assert.equal(c.store.view.templates.size, 0);
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM templates WHERE is_deleted = 0').get().n, 0);
});

test('project als sjabloon: afgevinkte subtaken en een gearchiveerde sectie gaan niet mee, en dag 0 is de vroegste datum zonder herhaling', async () => {
  const c = await ready(makeClient());
  const pid = await c.actions.addProject({ name: 'Mix' });
  const open = await c.actions.addSection(pid, 'Open');
  const archived = await c.actions.addSection(pid, 'Oud');
  const parent = await c.actions.addTask({ content: 'Ouder', project_id: pid, section_id: open, due: { date: '2026-12-10' } });
  const done = await c.actions.addTask({ content: 'Klaar kind', project_id: pid, parent_id: parent });
  await c.actions.addTask({ content: 'Open kind', project_id: pid, parent_id: parent });
  await c.actions.completeTask(done);
  await c.actions.addTask({ content: 'In oud', project_id: pid, section_id: archived });
  await c.actions.updateSection(archived, { is_archived: true });
  await c.actions.addTask({ content: 'Herhaal', project_id: pid, due: { date: '2026-12-01', string: 'elke dag', lang: 'nl', recurrence: { freq: 'daily' } } });
  const r = templateFromProject(c.store.view, pid, { name: 'Mix' });
  assert.deepEqual(r.template.content, {
    v: 1,
    tasks: [{ content: 'Herhaal', day: -9, recurrence: { freq: 'daily' }, repeat_text: 'elke dag' }],
    sections: [{ name: 'Open', tasks: [{ content: 'Ouder', day: 0, subtasks: [{ content: 'Open kind' }] }] }],
  }, 'dag 0 is de vroegste datum van een taak die niet terugkeert');
});

test('taak als sjabloon: een afgevinkte taak neemt haar (afgevinkte) subtaken mee, een open taak alleen de open subtaken', async () => {
  const c = await ready(makeClient());
  const pid = await c.actions.addProject({ name: 'P' });
  const root = await c.actions.addTask({ content: 'Wortel', project_id: pid });
  const kid = await c.actions.addTask({ content: 'Kind', project_id: pid, parent_id: root });
  await c.actions.addTask({ content: 'Tweede kind', project_id: pid, parent_id: root });
  await c.actions.completeTask(kid);
  assert.deepEqual(templateFromTask(c.store.view, root, { name: 'a' }).template.content.tasks[0].subtasks.map((x) => x.content), ['Tweede kind']);
  await c.actions.completeTask(root);
  assert.deepEqual(templateFromTask(c.store.view, root, { name: 'b' }).template.content.tasks[0].subtasks.map((x) => x.content), ['Kind', 'Tweede kind']);
});

test('een sjabloon dat te groot is, geeft de melding "te groot"', async () => {
  const c = await ready(makeClient());
  const pid = await c.actions.addProject({ name: 'Zwaar' });
  const view = c.store.view;
  for (let i = 0; i < 70; i++) view.tasks.set(`zwaar${i}`, { id: `zwaar${i}`, project_id: pid, content: 'a'.repeat(4000), order_key: `V${String(i).padStart(3, '0')}`, labels: [], priority: 4 });
  assert.deepEqual(templateFromProject(view, pid, { name: 'Zwaar' }).problem.code, 'tooBig');
});

test('de grenzen tellen alleen wat van jou is: taken die jij maakte, je eigen labels', async () => {
  const c = await ready(makeClient());
  const view = c.store.view;
  const me = c.store.userId;
  const need = { newProject: true, sections: 0, tasks: 2, labels: 0, reminders: 0 };
  for (let i = 0; i < 100; i++) view.tasks.set(`ander${i}`, { id: `ander${i}`, project_id: 'ander-project', creator_id: 'user-ander-0001', labels: [] });
  for (let i = 0; i < 600; i++) view.labels.set(`vreemd${i}`, { id: `vreemd${i}`, name: `vreemd ${i}`, owner_id: 'user-ander-0001' });
  assert.equal(quotaProblem(view, me, { ...need, labels: 3 }), null, 'taken en labels van anderen tellen niet mee');
  for (let i = 0; i < APPLY_LIMITS.tasksPerUser - 1; i++) view.tasks.set(`mijn${i}`, { id: `mijn${i}`, project_id: `project${i % 50}`, creator_id: me, labels: [] });
  assert.deepEqual(quotaProblem(view, me, need), { code: 'tasksPerUser', limit: 50_000, have: 49_999, need: 2 });
  assert.equal(quotaProblem(view, me, { ...need, tasks: 1 }), null);
});

test('invoegen: nieuwe secties komen achter de bestaande, taken zonder sectie in de gekozen sectie, en de automatische herinnering volgt de instelling', async () => {
  const c = await ready(makeClient());
  const pid = await c.actions.addProject({ name: 'Doel' });
  const first = await c.actions.addSection(pid, 'Eerste');
  const second = await c.actions.addSection(pid, 'Tweede');
  const tpl = { name: 'Los', kind: 'task', color: 'charcoal', content: { v: 1, tasks: [{ content: 'Zonder sectie' }, { content: 'Met tijd', day: 1, time: '08:00' }], sections: [{ name: 'Derde', tasks: [{ content: 'In derde' }] }] } };
  await c.actions.updateSettings({ auto_reminder: -1 });
  const res = await c.actions.insertTemplate(tpl, { projectId: pid, sectionId: second, startDate: '2026-12-01' });
  assert.equal(res.ok, true);
  assert.equal(res.counts.reminders, 0, 'met de instelling "geen automatische herinnering" komt er geen bij');
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
  const view = c.store.view;
  const sections = [...view.sections.values()].filter((s) => s.project_id === pid).sort((a, b) => (a.order_key < b.order_key ? -1 : 1)).map((s) => s.name);
  assert.deepEqual(sections, ['Eerste', 'Tweede', 'Derde'], 'de nieuwe sectie staat achteraan');
  const inSection = (name) => tasksOf(view, pid).filter((x) => view.sections.get(x.section_id)?.name === name).map((x) => x.content).sort();
  assert.deepEqual(inSection('Tweede'), ['Met tijd', 'Zonder sectie'], 'taken zonder sectie komen in de gekozen sectie');
  assert.deepEqual(inSection('Derde'), ['In derde']);
  assert.equal(view.reminders.size, 0);
  assert.equal(first.length > 0, true);
  // en met een instelling van 10 minuten komt er een herinnering van 10 minuten bij
  await c.actions.updateSettings({ auto_reminder: 10 });
  const again = await c.actions.insertTemplate(tpl, { projectId: pid, startDate: '2026-12-01' });
  assert.equal(again.counts.reminders, 1);
  await c.sync.syncNow();
  assert.deepEqual([...c.store.view.reminders.values()].map((r) => [r.type, r.minute_offset]), [['relative', 10]]);
  assert.deepEqual(c.errors, []);
});

test('de lijst met je sjablonen: alleen eigen, op naam (hoofdletter- en accentongevoelig), eventueel van één soort', () => {
  const view = { templates: new Map([
    ['a', { id: 'a', name: 'zebra', kind: 'task', owner_id: 'ik' }],
    ['b', { id: 'b', name: 'Éclair', kind: 'project', owner_id: 'ik' }],
    ['c', { id: 'c', name: 'appel', kind: 'project', owner_id: 'ik' }],
    ['d', { id: 'd', name: 'Van een ander', kind: 'project', owner_id: 'zij' }],
  ]) };
  assert.deepEqual(templateList(view, 'ik').map((x) => x.id), ['c', 'b', 'a']);
  assert.deepEqual(templateList(view, 'ik', 'project').map((x) => x.id), ['c', 'b']);
  assert.deepEqual(templateList(view, 'ik', 'task').map((x) => x.id), ['a']);
});

test('bestanden: lange namen worden afgekapt, een BOM en losse accenten geen probleem, een onbekende kleur wordt de standaard', () => {
  const long = templateFileName('x'.repeat(100));
  assert.equal(long, `tickory-template-${'x'.repeat(40)}.json`);
  const withBom = parseTemplateFile(`\uFEFF${exportTemplate(FILE_SAMPLE)}`);
  assert.equal(withBom.ok, true, 'een JSON-bestand met BOM wordt gelezen');
  const decomposed = JSON.parse(exportTemplate(FILE_SAMPLE));
  decomposed.content.tasks[0].content = 'Cafe\u0301';
  decomposed.content.sections[0].name = 'Zoe\u0308';
  const normalized = parseTemplateFile(JSON.stringify(decomposed));
  assert.equal(normalized.template.content.tasks[0].content, 'Caf\u00e9', 'NFC in de inhoud');
  assert.equal(normalized.template.content.sections[0].name, 'Zo\u00eb');
  assert.equal(parseTemplateFile(JSON.stringify({ ...JSON.parse(exportTemplate(FILE_SAMPLE)), color: 'paars' })).template.color, 'charcoal', 'een onbekende kleur wordt de standaardkleur');
  assert.equal(JSON.parse(exportTemplate({ ...FILE_SAMPLE, color: 'paars' })).color, 'charcoal');
});

test('Todoist CSV: een ontbrekende kolom, te diepe INDENT en een sectie die de subtaken afbreekt', () => {
  const missing = parseTemplateFile('TYPE,NAAM\ntask,x');
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /TYPE en CONTENT/);
  // zes niveaus: alles wat dieper is dan vier wordt een broer of zus op het diepste niveau
  const deep = parseTemplateFile(['TYPE,CONTENT,INDENT', 'task,1,1', 'task,2,2', 'task,3,3', 'task,4,4', 'task,5,5', 'task,6,6'].join('\n'));
  assert.equal(deep.ok, true, JSON.stringify(deep));
  const level4 = deep.template.content.tasks[0].subtasks[0].subtasks[0].subtasks;
  assert.deepEqual(level4.map((x) => x.content), ['4', '5', '6']);
  // na een sectie begint het opnieuw: een INDENT 2 zonder ouder is een gewone taak van die sectie
  const afterSection = parseTemplateFile(['TYPE,CONTENT,INDENT', 'task,voor,1', 'section,Week 2,', 'task,erna,2'].join('\n'));
  assert.deepEqual(afterSection.template.content.sections[0].tasks, [{ content: 'erna' }]);
  assert.deepEqual(afterSection.template.content.tasks, [{ content: 'voor' }]);
});
