// Het scherm Activiteit zonder scherm (core/activity.js): bladeren, bijwerken, zonder verbinding, en wat een regel zegt.
// En wat de interface mag in een project dat je alleen leest (core/access.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_FILTERS, createActivityFeed, describeEntry, groupByDay, kindsFor } from './activity.js';
import { canBeAssigned, canEditProject, canEditTask, editableProjectList } from './access.js';
import { emptyState } from './reducer.js';
import { ACTIVITY_GROUPS, ACTIVITY_KINDS, changedTaskFields, parseActivityQuery, shortTitle, TITLE_MAX } from '../../shared/activity.js';
import { canEditRole, shareRoleProblem } from '../../shared/roles.js';

const entry = (id, kind, extra = {}) => ({ id: String(id), at: '2026-11-14T09:05:00.000Z', actor_id: 'u-anna', kind, task_id: null, section_id: null, comment_id: null, attachment_id: null, user_id: null, title: null, extra: null, ...extra });

/** Een nagebootste server met `count` regels, de nieuwste (hoogste id) eerst. */
function fakeServer(count) {
  const all = Array.from({ length: count }, (_, i) => entry(i + 1, i % 2 ? 'task_added' : 'comment_added'));
  const state = { online: true, gone: false, calls: [] };
  const fetchPage = async (projectId, { before, limit, kinds }) => {
    state.calls.push({ projectId, before, limit, kinds });
    if (!state.online) throw Object.assign(new Error('offline'), { code: 'OFFLINE' });
    if (state.gone) throw Object.assign(new Error('weg'), { code: 'NOT_FOUND' });
    const list = all.filter((e) => (before === null || Number(e.id) < Number(before)) && (!kinds || kinds.includes(e.kind))).sort((a, b) => Number(b.id) - Number(a.id));
    const page = list.slice(0, limit);
    return { entries: page, next: list.length > limit ? page[page.length - 1].id : null };
  };
  return { all, state, fetchPage };
}

test('bladeren: de nieuwste pagina, dan meer; bijwerken zet wat nieuw is bovenaan zonder dubbele regels', async () => {
  const server = fakeServer(7);
  let changes = 0;
  const feed = createActivityFeed({ fetchPage: server.fetchPage, pageSize: 3, onChange: () => { changes += 1; } });
  await feed.refresh('p1');
  assert.deepEqual(feed.get('p1').entries.map((e) => e.id), ['7', '6', '5']);
  await feed.more('p1');
  await feed.more('p1');
  assert.deepEqual(feed.get('p1').entries.map((e) => e.id), ['7', '6', '5', '4', '3', '2', '1']);
  assert.equal(feed.get('p1').next, null);
  await feed.more('p1'); // niets meer: geen verzoek
  assert.equal(server.state.calls.length, 3);
  server.all.push(entry(8, 'task_added'));
  await feed.refresh('p1');
  assert.deepEqual(feed.get('p1').entries.map((e) => e.id), ['8', '7', '6', '5', '4', '3', '2', '1'], 'het nieuwe erbij, de rest blijft');
  assert.ok(changes >= 8, 'het scherm hoort het bij begin en einde van elk verzoek');
});

test('filteren: een eigen lijst per soort, met de soorten van die groep', async () => {
  const server = fakeServer(6);
  const feed = createActivityFeed({ fetchPage: server.fetchPage, pageSize: 10 });
  await feed.refresh('p1', 'comments');
  assert.deepEqual(server.state.calls.at(-1).kinds, ACTIVITY_GROUPS.comments);
  assert.ok(feed.get('p1', 'comments').entries.every((e) => e.kind === 'comment_added'));
  assert.equal(feed.get('p1', 'all').loaded, false, 'de lijst zonder filter is apart');
  assert.equal(kindsFor('all'), null);
  assert.equal(kindsFor('onbekend'), null);
  assert.deepEqual(ACTIVITY_FILTERS, ['all', 'tasks', 'sections', 'comments', 'attachments', 'members', 'project']);
});

test('zonder verbinding blijft wat er was; is het project weg (NOT_FOUND), dan gaat ook wat geladen was weg', async () => {
  const server = fakeServer(4);
  const feed = createActivityFeed({ fetchPage: server.fetchPage, pageSize: 10 });
  server.state.online = false;
  await feed.refresh('p1');
  assert.deepEqual([feed.get('p1').loaded, feed.get('p1').error], [false, 'OFFLINE'], 'niets geladen: dan zegt het scherm dat er verbinding nodig is');
  server.state.online = true;
  await feed.refresh('p1');
  server.state.online = false;
  await feed.refresh('p1');
  assert.deepEqual([feed.get('p1').entries.length, feed.get('p1').error], [4, 'OFFLINE'], 'wat geladen was, blijft te zien');
  server.state.online = true;
  server.state.gone = true;
  await feed.refresh('p1');
  assert.deepEqual([feed.get('p1').entries.length, feed.get('p1').error], [0, 'NOT_FOUND'], 'een oud-lid ziet niets meer, ook niet wat al geladen was');
  feed.forget('p1');
  assert.deepEqual(feed.projects(), []);
});

test('wat een regel zegt: wie, wat, met de taak als link zolang die in dit project staat; een oud-lid zonder naam', () => {
  const view = emptyState();
  view.projects.set('p1', { id: 'p1', name: 'Gezin' });
  view.projects.set('p2', { id: 'p2', name: 'Werk' });
  view.sections.set('s1', { id: 's1', name: 'Keuken', project_id: 'p1' });
  view.tasks.set('t1', { id: 't1', project_id: 'p1', content: 'Boodschappen' });
  const names = { 'u-anna': 'Anna', 'u-bram': 'Bram' };
  const say = (e) => describeEntry(e, { view, projectId: 'p1', userName: (id) => names[id] ?? null });
  const added = say(entry(1, 'task_added', { task_id: 't1', title: 'Boodschappen' }));
  assert.deepEqual([added.actor, added.sentence, added.taskId, added.gone, added.title], ['Anna', 'Anna heeft een taak toegevoegd', 't1', false, 'Boodschappen']);
  assert.equal(say(entry(2, 'task_updated', { task_id: 't1', extra: { fields: ['content', 'due', 'assignee_id'], assignee_id: 'u-bram' } })).sentence, 'Anna heeft een taak gewijzigd: titel, datum en toegewezen aan Bram');
  assert.equal(say(entry(3, 'task_updated', { extra: { fields: ['assignee_id'], assignee_id: null } })).sentence, 'Anna heeft een taak gewijzigd: niemand meer toegewezen');
  const deleted = say(entry(4, 'task_deleted', { task_id: 't-weg', title: 'Oud' }));
  assert.deepEqual([deleted.taskId, deleted.gone], [null, true], 'een verdwenen taak is geen link');
  assert.equal(say(entry(5, 'task_moved', { task_id: 't1', extra: { from_project: 'p2', to_project: 'p1' } })).sentence, 'Anna heeft een taak hierheen verplaatst uit Werk');
  assert.equal(say(entry(6, 'task_moved', { extra: { from_project: 'p1', to_project: 'p-geheim' } })).sentence, 'Anna heeft een taak verplaatst naar een ander project', 'een project dat je niet ziet, heeft geen naam');
  assert.equal(say(entry(7, 'task_moved', { extra: { from_section: null, to_section: 's1' } })).sentence, 'Anna heeft een taak verplaatst naar Keuken');
  assert.equal(say(entry(8, 'member_added', { user_id: 'u-bram', extra: { role: 'viewer' } })).sentence, 'Anna heeft Bram toegevoegd (alleen lezen)');
  assert.equal(say(entry(9, 'member_role', { user_id: 'u-bram', extra: { role: 'member' } })).sentence, 'Anna heeft de rol van Bram gewijzigd: kan bewerken');
  assert.equal(say(entry(10, 'member_left', { actor_id: 'u-weg', user_id: 'u-weg' })).sentence, 'Een oud-lid heeft het project verlaten');
  assert.equal(say(entry(11, 'task_completed', { extra: { recurring: true } })).sentence, 'Anna heeft een terugkerende taak afgevinkt (die schuift door)');
  assert.equal(say(entry(12, 'section_renamed', { title: 'Bijkeuken', extra: { from: 'Keuken' } })).sentence, 'Anna heeft een sectie hernoemd (was: Keuken)');
  assert.equal(say(entry(13, 'comment_added', { project_id: 'p1' })).sentence, 'Anna heeft een opmerking bij het project geplaatst');
  assert.equal(say(entry(14, 'iets_nieuws')).sentence, 'Anna deed iets in dit project', 'een soort van een nieuwere server');
  for (const kind of ACTIVITY_KINDS) assert.ok(!/\{|activity\./.test(say(entry(15, kind, { extra: { fields: [], role: 'member', from: 'x' } })).sentence), `${kind}: een echte zin`);
  assert.equal(added.time, `${String(new Date(added.at).getHours()).padStart(2, '0')}:05`);
});

test('per dag, in de volgorde waarin de regels kwamen', () => {
  const days = groupByDay([{ id: '3', day: '2026-11-14' }, { id: '2', day: '2026-11-14' }, { id: '1', day: '2026-11-12' }]);
  assert.deepEqual(days.map((d) => [d.day, d.items.map((x) => x.id)]), [['2026-11-14', ['3', '2']], ['2026-11-12', ['1']]]);
});

test('gedeelde regels: welke taakvelden echt veranderen, korte titels, en de vraag naar een pagina', () => {
  assert.deepEqual(changedTaskFields({ content: 'a', priority: 4, labels: ['x'], due: null, is_collapsed: false }, { content: 'a', priority: 1, labels: ['x'], due: { date: '2026-12-01' }, is_collapsed: true }), ['priority', 'due']);
  assert.equal([...shortTitle('é'.repeat(TITLE_MAX + 5))].length, TITLE_MAX);
  assert.equal(shortTitle('kort'), 'kort');
  assert.equal(shortTitle(null), null);
  assert.deepEqual(parseActivityQuery({}), { before: null, limit: 50, kinds: null });
  assert.deepEqual(parseActivityQuery({ before: '12', limit: '100', kinds: 'task_added,task_added' }), { before: 12, limit: 100, kinds: ['task_added'] });
  for (const bad of [{ before: '-1' }, { before: '1e3' }, { limit: '0' }, { limit: '101' }, { limit: 'x' }, { kinds: 'task_added,iets' }]) assert.ok(parseActivityQuery(bad).error, JSON.stringify(bad));
  assert.deepEqual([canEditRole('owner'), canEditRole('member'), canEditRole('viewer'), canEditRole(null)], [true, true, false, false]);
  assert.equal(shareRoleProblem('viewer'), null);
  assert.ok(shareRoleProblem('owner'));
});

test('alleen lezen in de interface: wat een lezer mag, en waar je een taak heen kunt zetten', () => {
  const view = emptyState();
  for (const [id, name] of [['p-own', 'Eigen'], ['p-read', 'Gelezen'], ['p-edit', 'Samen'], ['p-unknown', 'Nog niet gesynchroniseerd']]) view.projects.set(id, { id, name, order_key: id, parent_id: null });
  const member = (project_id, user_id, role) => view.members.set(`${project_id}/${user_id}`, { id: `${project_id}/${user_id}`, project_id, user_id, role });
  member('p-own', 'me', 'owner');
  member('p-read', 'anna', 'owner');
  member('p-read', 'me', 'viewer');
  member('p-edit', 'anna', 'owner');
  member('p-edit', 'me', 'member');
  member('p-edit', 'kees', 'viewer');
  assert.deepEqual(['p-own', 'p-read', 'p-edit', 'p-unknown'].map((p) => canEditProject(view, p, 'me')), [true, false, true, true], 'zonder bekende leden beslist de server');
  assert.equal(canEditProject(view, 'p-read', null), true, 'zonder gebruiker (vóór de eerste sync) niets blokkeren');
  assert.equal(canEditTask(view, { project_id: 'p-read' }, 'me'), false);
  assert.equal(canEditTask(view, null, 'me'), false);
  assert.deepEqual(editableProjectList(view, 'me').map((x) => x.project.id), ['p-edit', 'p-own', 'p-unknown']);
  assert.deepEqual(editableProjectList(view, 'me', 'p-read').map((x) => x.project.id), ['p-edit', 'p-own', 'p-read', 'p-unknown'], 'het huidige project staat er altijd bij');
  assert.deepEqual(['anna', 'me', 'kees', 'niemand'].map((u) => canBeAssigned(view, 'p-edit', u)), [true, true, false, false]);
});
