// De reducer en het terugzetten (task_restore, section_restore): dezelfde weigeringen en rechtzettingen als de server (server/restore.ts),
// getest op losse toestanden. De rijen om terug te zetten reizen mee in `cmd.local.rows`; zonder die rijen doet het commando niets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyState } from './reducer.js';

const ME = 'user-anna';
const NOW = '2026-11-14T10:00:00.000Z';
const row = (extra) => ({ is_deleted: false, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...extra });

/** Project P (Anna eigenaar, Bram lid), sectie S, en niets anders. */
function base() {
  const s = emptyState();
  s.projects.set('P', row({ id: 'P', name: 'Gezin', parent_id: null }));
  s.members.set('m1', row({ id: 'm1', project_id: 'P', user_id: ME, role: 'owner' }));
  s.members.set('m2', row({ id: 'm2', project_id: 'P', user_id: 'user-bram', role: 'member' }));
  s.sections.set('S', row({ id: 'S', project_id: 'P', name: 'Week' }));
  return s;
}
const task = (id, extra = {}) => row({
  id, project_id: 'P', section_id: null, parent_id: null, content: id, description: '', priority: 4, labels: [], due: null, deadline: null, duration: null,
  assignee_id: null, creator_id: ME, checked: false, completed_at: null, completed_count: 0, is_collapsed: false, order_key: 'a', ...extra,
});
const comment = (id, taskId) => row({ id, task_id: taskId, project_id: null, content: 'opmerking', author_id: ME });
const reminder = (id, taskId, extra = {}) => row({ id, task_id: taskId, type: 'relative', minute_offset: 30, due: null, place_id: null, trigger: null, owner_id: ME, ...extra });
const attachment = (id, taskId) => row({ id, task_id: taskId, name: 'a.txt', size: 1, mime: 'text/plain', sha256: 'a'.repeat(64), creator_id: ME });
const restore = (state, type, id, rows) => applyCommand(state, { type, args: { id }, ...(rows ? { local: { rows } } : {}) }, NOW, ME);

test('een taak komt terug met subtaak, opmerking, bijlage en herinnering', () => {
  const s = base();
  restore(s, 'task_restore', 'T', { tasks: [task('T'), task('K', { parent_id: 'T' })], comments: [comment('C', 'T')], attachments: [attachment('A', 'K')], reminders: [reminder('R', 'T')] });
  assert.deepEqual([...s.tasks.keys()].sort(), ['K', 'T']);
  assert.deepEqual([...s.comments.keys()], ['C']);
  assert.deepEqual([...s.attachments.keys()], ['A']);
  assert.deepEqual([...s.reminders.keys()], ['R']);
  assert.equal(s.tasks.get('T').updated_at, NOW);
});

test('zonder rijen, of voor een taak die er al is, verandert er niets', () => {
  const s = base();
  restore(s, 'task_restore', 'T', null);
  assert.equal(s.tasks.size, 0, 'zonder meegedragen rijen weet de reducer niets terug te zetten');
  restore(s, 'task_restore', 'T', { tasks: [task('X')] });
  assert.equal(s.tasks.size, 0, 'de taak zit niet in de meegedragen rijen');
  s.tasks.set('T', task('T', { content: 'Intussen aangepast' }));
  restore(s, 'task_restore', 'T', { tasks: [task('T', { content: 'Oud' })], comments: [comment('C', 'T')] });
  assert.equal(s.tasks.get('T').content, 'Intussen aangepast', 'een taak die er al is, wordt niet overschreven');
  assert.equal(s.comments.size, 0, 'en haar opmerkingen komen er niet bij');
});

test('de plek moet er nog zijn: project, bovenliggende taak, sectie', () => {
  const s = base();
  restore(s, 'task_restore', 'K', { tasks: [task('K', { parent_id: 'T' })] });
  assert.equal(s.tasks.size, 0, 'zonder bovenliggende taak niet');
  s.tasks.set('T', task('T', { project_id: 'ANDER' }));
  restore(s, 'task_restore', 'K', { tasks: [task('K', { parent_id: 'T' })] });
  assert.equal(s.tasks.has('K'), false, 'de bovenliggende taak staat in een ander project');
  s.tasks.delete('T');
  restore(s, 'task_restore', 'X', { tasks: [task('X', { section_id: 'WEG' })] });
  assert.equal(s.tasks.size, 0, 'zonder sectie niet');
  restore(s, 'task_restore', 'Y', { tasks: [task('Y', { project_id: 'GEEN' })] });
  assert.equal(s.tasks.size, 0, 'zonder project niet');
  restore(s, 'task_restore', 'Z', { tasks: [task('Z', { section_id: 'S' })] });
  assert.equal(s.tasks.get('Z').section_id, 'S', 'met sectie en project wel');
});

test('een subtaak volgt de sectie van haar ouder zoals die nu is', () => {
  const s = base();
  s.tasks.set('T', task('T', { section_id: null }));
  restore(s, 'task_restore', 'K', { tasks: [task('K', { parent_id: 'T', section_id: 'S' })] });
  assert.equal(s.tasks.get('K').section_id, null);
  const t = base();
  t.tasks.set('T', task('T', { section_id: 'S' }));
  restore(t, 'task_restore', 'K', { tasks: [task('K', { parent_id: 'T', section_id: null })] });
  assert.equal(t.tasks.get('K').section_id, 'S');
});

test('wat intussen niet meer klopt wordt rechtgezet: verwijderd label, vertrokken lid, plaats die weg is', () => {
  const s = base();
  s.labels.set('L1', row({ id: 'L1', name: 'thuis', owner_id: ME }));
  s.members.delete('m2'); // Bram is intussen uit het project gehaald
  restore(s, 'task_restore', 'T', {
    tasks: [task('T', { labels: ['L1', 'L-weg'], assignee_id: 'user-bram' }), task('U', { assignee_id: ME })],
    reminders: [reminder('R1', 'T'), reminder('R2', 'T', { type: 'location', minute_offset: null, place_id: 'PLAATS-WEG', trigger: 'enter' })],
  });
  assert.deepEqual(s.tasks.get('T').labels, ['L1'], 'een verwijderd label komt niet terug');
  assert.equal(s.tasks.get('T').assignee_id, null, 'wie geen lid meer is, is niet meer toegewezen');
  s.tasks.set('U', task('U'));
  assert.deepEqual([...s.reminders.keys()], ['R1'], 'een locatieherinnering zonder plaats komt niet terug');
  const t = base();
  restore(t, 'task_restore', 'T', { tasks: [task('T', { assignee_id: 'user-bram' })] });
  assert.equal(t.tasks.get('T').assignee_id, 'user-bram', 'een lid blijft toegewezen');
});

test('een sectie komt terug met haar taken; een sectie die er al is of zonder project niet', () => {
  const s = base();
  s.sections.delete('S');
  restore(s, 'section_restore', 'S', { sections: [row({ id: 'S', project_id: 'P', name: 'Week' })], tasks: [task('T', { section_id: 'S' }), task('K', { section_id: 'S', parent_id: 'T' })], comments: [comment('C', 'T')] });
  assert.deepEqual([...s.sections.keys()], ['S']);
  assert.deepEqual([...s.tasks.keys()].sort(), ['K', 'T']);
  assert.deepEqual([...s.comments.keys()], ['C']);
  const t = base();
  t.sections.set('S', row({ id: 'S', project_id: 'P', name: 'Hernoemd' }));
  restore(t, 'section_restore', 'S', { sections: [row({ id: 'S', project_id: 'P', name: 'Oud' })], tasks: [task('T', { section_id: 'S' })] });
  assert.equal(t.sections.get('S').name, 'Hernoemd');
  assert.equal(t.tasks.size, 0, 'de taken komen niet mee als de sectie er al is');
  const u = base();
  u.projects.delete('P');
  restore(u, 'section_restore', 'S2', { sections: [row({ id: 'S2', project_id: 'P', name: 'x' })] });
  assert.equal(u.sections.size, 1, 'alleen S uit base(); S2 komt niet terug zonder project');
});

test('het commando is geen verwijdering: andere commando\'s en onbekende soorten laten de toestand met rust', () => {
  const s = base();
  const before = [...s.tasks.keys()];
  applyCommand(s, { type: 'task_restore', args: {} , local: { rows: { tasks: [task('T')] } } }, NOW, ME);
  assert.deepEqual([...s.tasks.keys()], before, 'zonder id niets');
  applyCommand(s, { type: 'project_restore', args: { id: 'P' } }, NOW, ME);
  assert.equal(s.projects.size, 1, 'project_restore bestaat niet');
});
