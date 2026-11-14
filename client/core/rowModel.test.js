// Wat een regel van de takenlijst toont: beschrijving, initialen, datumkleur, tellers, labels, toewijzing en project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from './reducer.js';
import { DESCRIPTION_CHARS, descriptionLine, initials, rowModel } from './rowModel.js';
import { hasReminder, tasksWithReminder } from './selectors.js';
import { setLanguage } from './i18n.js';

const TODAY = '2026-11-13';
const NOW = '2026-11-13T10:00';

function sample() {
  const view = emptyState();
  view.projects.set('p1', { id: 'p1', name: 'Thuis', color: 'teal' });
  view.projects.set('p2', { id: 'p2', name: 'Werk', color: 'berry_red' }); // onbekende kleur
  view.sections.set('s1', { id: 's1', project_id: 'p1', name: 'Keuken' });
  view.labels.set('l1', { id: 'l1', name: 'bellen', color: 'blue' });
  view.labels.set('l2', { id: 'l2', name: 'spoed' });
  return view;
}
const task = (extra = {}) => ({ id: 't1', content: 'Taak', description: '', priority: 4, project_id: 'p1', section_id: null, labels: [], due: null, deadline: null, checked: false, assignee_id: null, ...extra });
const model = (extra, ctx = {}) => rowModel(task(extra), { view: sample(), today: TODAY, now: NOW, ...ctx });

test('descriptionLine: de eerste regel met tekst, witruimte samengevoegd, en afgekapt met een beletselteken', () => {
  assert.equal(descriptionLine(''), '');
  assert.equal(descriptionLine(null), '');
  assert.equal(descriptionLine(undefined), '');
  assert.equal(descriptionLine('  \n\n  Eerste   regel \n tweede'), 'Eerste regel');
  assert.equal(descriptionLine('kort'), 'kort');
  const long = 'x'.repeat(DESCRIPTION_CHARS + 50);
  assert.equal(descriptionLine(long).length, DESCRIPTION_CHARS);
  assert.ok(descriptionLine(long).endsWith('…'));
  assert.equal(descriptionLine('y'.repeat(DESCRIPTION_CHARS)), 'y'.repeat(DESCRIPTION_CHARS), 'precies de grens is nog niet afgekapt');
});

test('initials: eerste letter van de eerste en de laatste naam, ook met accenten en een lege naam', () => {
  assert.equal(initials('Anna'), 'A');
  assert.equal(initials('Anna de Vries'), 'AV');
  assert.equal(initials('  bram   jansen '), 'BJ');
  assert.equal(initials('Émile Zoë'), 'ÉZ');
  assert.equal(initials('ijsbrand'), 'I');
  assert.equal(initials(''), '?');
  assert.equal(initials(null), '?');
});

test('rowModel: een kale taak', () => {
  const m = model();
  assert.deepEqual(m, {
    id: 't1', content: 'Taak', description: '', priority: 4, done: false, depth: 0, hasChildren: false, collapsed: false,
    due: null, duration: null, deadline: null, subtasks: null, comments: null, attachments: null, labels: [], bell: false, assignee: null, project: null,
  });
});

test('rowModel: de datum krijgt zijn status (te laat, vandaag, later) en herhaling wordt herkend', () => {
  assert.deepEqual(model({ due: { date: '2026-11-12' } }).due, { text: 'gisteren', status: 'overdue', repeats: false });
  assert.deepEqual(model({ due: { date: TODAY } }).due, { text: 'vandaag', status: 'today', repeats: false });
  assert.deepEqual(model({ due: { date: '2026-11-14' } }).due, { text: 'morgen', status: 'future', repeats: false });
  assert.equal(model({ due: { date: '2026-11-13T09:00' } }).due.status, 'overdue', 'een tijdstip dat voorbij is');
  assert.equal(model({ due: { date: '2026-11-13T18:00' } }).due.status, 'today');
  const weekly = model({ due: { date: '2026-11-20', recurrence: { freq: 'weekly', byweekday: [5] } } }).due;
  assert.equal(weekly.repeats, true);
  assert.equal(weekly.text, '↻ vr 20 nov');
  assert.deepEqual(model({ deadline: '2026-11-12' }).deadline, { text: 'deadline gisteren', overdue: true });
  assert.deepEqual(model({ deadline: '2026-11-20' }).deadline.overdue, false);
});

test('rowModel: tellers voor subtaken en opmerkingen', () => {
  const m = model({}, { subtasks: new Map([['t1', { done: 1, total: 3 }]]), comments: new Map([['t1', 2]]), hasChildren: true, collapsed: true, depth: 7 });
  assert.deepEqual(m.subtasks, { done: 1, total: 3, text: '1/3', label: 'Subtaken: 1/3 afgerond' });
  assert.deepEqual(m.comments, { count: 2, label: '2 opmerkingen' });
  assert.deepEqual([m.hasChildren, m.collapsed, m.depth], [true, true, 4], 'het inspringniveau houdt op bij 4');
  assert.equal(model({}, { comments: new Map([['t1', 1]]) }).comments.label, '1 opmerking');
  assert.equal(model({}, { subtasks: new Map([['andere', { done: 0, total: 1 }]]) }).subtasks, null);
});

test('rowModel: labels met hun kleur (onbekend of ontbrekend valt terug), onbekende labels worden overgeslagen', () => {
  const m = model({ labels: ['l1', 'l2', 'verdwenen'] });
  assert.deepEqual(m.labels, [{ id: 'l1', name: 'bellen', color: 'blue' }, { id: 'l2', name: 'spoed', color: 'charcoal' }]);
});

test('rowModel: toegewezen aan jou of aan een ander, met initialen', () => {
  const me = { id: 'u1', name: 'Anna de Vries' };
  const userName = (id) => ({ u2: 'Bram Jansen' })[id] ?? null;
  assert.deepEqual(model({ assignee_id: 'u1' }, { me, userName }).assignee, { mine: true, text: 'voor jou', title: 'Toegewezen aan jou', initials: 'AV' });
  assert.deepEqual(model({ assignee_id: 'u2' }, { me, userName }).assignee, { mine: false, text: 'voor Bram Jansen', title: 'Toegewezen aan Bram Jansen', initials: 'BJ' });
  assert.deepEqual(model({ assignee_id: 'u3' }, { me, userName }).assignee, { mine: false, text: 'voor iemand', title: 'Toegewezen aan iemand', initials: 'I' });
  assert.equal(model({ assignee_id: 'u1' }, { me: null, userName }).assignee.mine, false);
});

test('rowModel: het project (met sectie) alleen in overzichten, met zijn kleur', () => {
  assert.equal(model({}).project, null);
  assert.deepEqual(model({}, { showProject: true }).project, { name: 'Thuis', color: 'teal' });
  assert.deepEqual(model({ section_id: 's1' }, { showProject: true }).project, { name: 'Thuis / Keuken', color: 'teal' });
  assert.deepEqual(model({ project_id: 'p2' }, { showProject: true }).project, { name: 'Werk', color: 'charcoal' });
  assert.equal(model({ project_id: 'weg' }, { showProject: true }).project, null);
});

test('rowModel: dezelfde gegevens geven altijd hetzelfde model (daarop wordt een getekende regel hergebruikt)', () => {
  const a = JSON.stringify(model({ due: { date: '2026-11-14' }, labels: ['l1'], description: 'tekst' }, { reminder: true }));
  const b = JSON.stringify(model({ due: { date: '2026-11-14' }, labels: ['l1'], description: 'tekst' }, { reminder: true }));
  assert.equal(a, b);
  assert.notEqual(a, JSON.stringify(model({ due: { date: '2026-11-14' }, labels: ['l1'], description: 'andere tekst' }, { reminder: true })));
  assert.notEqual(a, JSON.stringify(model({ due: { date: '2026-11-14' }, labels: ['l1'], description: 'tekst' }, { reminder: false })));
});

test('rowModel (Engels): teksten in de taal van de interface', () => {
  setLanguage('en');
  try {
    const m = model({ deadline: '2026-11-12', assignee_id: 'u1' }, { me: { id: 'u1', name: 'Anna' }, subtasks: new Map([['t1', { done: 0, total: 2 }]]), comments: new Map([['t1', 3]]) });
    assert.equal(m.deadline.text, 'deadline yesterday');
    assert.equal(m.assignee.text, 'for you');
    assert.equal(m.subtasks.label, 'Subtasks: 0/2 done');
    assert.equal(m.comments.label, '3 comments');
  } finally {
    setLanguage('nl');
  }
});

test('tasksWithReminder geeft precies de taken waar hasReminder ja op zegt', () => {
  const view = emptyState();
  const put = (res, row) => view[res].set(row.id, row);
  put('tasks', { id: 'a', due: { date: '2026-11-14T09:00' } });
  put('tasks', { id: 'b', due: { date: '2026-11-14' } });
  put('tasks', { id: 'c', due: null });
  put('tasks', { id: 'd', due: { date: '2026-11-14T09:00' } });
  put('reminders', { id: 'r1', task_id: 'a', type: 'relative', minute_offset: 30, owner_id: 'u1' });
  put('reminders', { id: 'r2', task_id: 'b', type: 'relative', minute_offset: 30, owner_id: 'u1' }); // zonder tijd: gaat niet af
  put('reminders', { id: 'r3', task_id: 'c', type: 'absolute', due: { date: '2026-11-14T08:00' }, owner_id: 'u1' });
  put('reminders', { id: 'r4', task_id: 'd', type: 'relative', minute_offset: 30, owner_id: 'u2' }); // van iemand anders
  const set = tasksWithReminder(view, 'u1');
  assert.deepEqual([...set].sort(), ['a', 'c']);
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(set.has(id), hasReminder(view, id, 'u1'), id);
  assert.deepEqual([...tasksWithReminder(view, 'u2')], ['d']);
  assert.deepEqual([...tasksWithReminder(emptyState(), 'u1')], []);
});
