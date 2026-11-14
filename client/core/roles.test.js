// De optimistische uitvoering (core/reducer.js) volgt de rollen van de server: wat een lezer niet mag, doet de app ook niet, en een
// rolwissel (member_update) rekent ze vooruit zoals de server. (De differentiële test in sync.test.js vergelijkt dit met de server.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyState } from './reducer.js';

const NOW = '2026-11-14T10:00:00.000Z';
const ME = 'u-carol';

/** Anna is eigenaar van P (met subproject SUB) en van Q; Carol (ik) is lezer in P en SUB, lid in Q; Bram is lid in P. */
function world() {
  const s = emptyState();
  const project = (id, extra = {}) => s.projects.set(id, { id, name: id, parent_id: null, order_key: 'V', is_archived: false, ...extra });
  project('P');
  project('SUB', { parent_id: 'P' });
  project('Q');
  project('MINE');
  project('inbox-u-carol');
  const member = (p, u, role) => s.members.set(`${p}-${u}`, { id: `${p}-${u}`, project_id: p, user_id: u, role });
  member('P', 'u-anna', 'owner'); member('P', ME, 'viewer'); member('P', 'u-bram', 'member');
  member('SUB', 'u-anna', 'owner'); member('SUB', ME, 'viewer');
  member('Q', 'u-anna', 'owner'); member('Q', ME, 'member'); member('Q', 'u-kees', 'viewer');
  member('MINE', ME, 'owner'); member('MINE', 'u-bram', 'member');
  member('inbox-u-carol', ME, 'owner');
  s.sections.set('S', { id: 'S', project_id: 'P', name: 'Regelen', order_key: 'V' });
  s.tasks.set('T', { id: 'T', project_id: 'P', section_id: 'S', parent_id: null, content: 'Huisje', checked: false, labels: [], order_key: 'V', assignee_id: 'u-bram' });
  s.tasks.set('TQ', { id: 'TQ', project_id: 'Q', section_id: null, parent_id: null, content: 'Werk', checked: false, labels: [], order_key: 'V', assignee_id: null });
  s.tasks.set('TM', { id: 'TM', project_id: 'MINE', section_id: null, parent_id: null, content: 'Eigen', checked: false, labels: [], order_key: 'V', assignee_id: 'u-bram' });
  s.attachments.set('A', { id: 'A', task_id: 'T', name: 'a.txt', creator_id: ME });
  return s;
}
const run = (s, type, args, user = ME) => applyCommand(s, { type, args }, NOW, user);
const snap = (s) => JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, m]) => [k, [...m.values()]])));

test('een lezer wijzigt niets aan taken, secties, bijlagen of het project, ook niet door iets erheen te verplaatsen', () => {
  const s = world();
  const before = snap(s);
  const refused = [
    ['task_add', { id: 'n1', project_id: 'P', content: 'x' }], ['task_update', { id: 'T', content: 'x' }], ['task_update', { id: 'T', is_collapsed: true }],
    ['task_delete', { id: 'T' }], ['task_complete', { id: 'T' }], ['task_move', { id: 'T', project_id: 'inbox-u-carol' }], ['task_move', { id: 'T', section_id: null }],
    ['task_move', { id: 'TQ', project_id: 'P' }], ['task_move', { id: 'TM', project_id: 'SUB' }],
    ['section_add', { id: 'n2', project_id: 'P', name: 'x' }], ['section_update', { id: 'S', name: 'x' }], ['section_delete', { id: 'S' }],
    ['project_update', { id: 'P', name: 'x' }], ['project_update', { id: 'SUB', is_collapsed: true }], ['project_add', { id: 'n3', name: 'x', parent_id: 'P' }],
    ['project_update', { id: 'MINE', parent_id: 'P' }], ['attachment_delete', { id: 'A' }],
    ['task_restore', { id: 'gone' }], ['section_restore', { id: 'gone' }],
  ];
  for (const [type, args] of refused) {
    const cmd = { type, args, ...(type.endsWith('_restore') ? { local: { rows: { tasks: [{ id: 'gone', project_id: 'P', section_id: null, parent_id: null, labels: [] }], sections: [{ id: 'gone', project_id: 'P', name: 'x' }] } } } : {}) };
    applyCommand(s, cmd, NOW, ME);
    assert.equal(snap(s), before, `${type} ${JSON.stringify(args)} deed toch iets`);
  }
  s.tasks.set('TC', { id: 'TC', project_id: 'P', section_id: null, parent_id: null, content: 'Klaar', checked: true, labels: [], order_key: 'W', assignee_id: null });
  const withDone = snap(s);
  run(s, 'task_uncomplete', { id: 'TC' });
  assert.equal(snap(s), withDone, 'heropenen ook niet');
});

test('een lezer mag wel: reageren, eigen herinneringen, en in zijn eigen projecten gewoon alles', () => {
  const s = world();
  run(s, 'comment_add', { id: 'c1', task_id: 'T', content: 'Leuk' });
  run(s, 'reminder_add', { id: 'r1', task_id: 'T', type: 'relative', minute_offset: 10 });
  assert.ok(s.comments.has('c1') && s.reminders.has('r1'));
  run(s, 'task_add', { id: 'n1', project_id: 'Q', content: 'Mag wel' });
  run(s, 'task_complete', { id: 'TQ' });
  assert.ok(s.tasks.has('n1') && s.tasks.get('TQ').checked, 'in Q is Carol lid');
  run(s, 'task_move', { id: 'n1', project_id: 'MINE' });
  assert.equal(s.tasks.get('n1').project_id, 'MINE');
});

test('toewijzen kan alleen aan wie kan bewerken; verhuist een taak naar een project waar de toegewezene lezer is, dan vervalt het', () => {
  const s = world();
  run(s, 'task_update', { id: 'TQ', assignee_id: 'u-kees' });
  assert.equal(s.tasks.get('TQ').assignee_id, null, 'Kees is lezer in Q');
  run(s, 'task_add', { id: 'n1', project_id: 'Q', content: 'x', assignee_id: 'u-kees' });
  assert.equal(s.tasks.has('n1'), false, 'de server weigert het hele commando');
  run(s, 'task_update', { id: 'TQ', assignee_id: 'u-anna' });
  assert.equal(s.tasks.get('TQ').assignee_id, 'u-anna');
  // als eigenaar van MINE: TM (voor Bram) naar Q, waar Bram geen lid is → vervalt; en een taak voor Carol naar P? Carol is daar lezer
  run(s, 'task_move', { id: 'TM', project_id: 'Q' });
  assert.equal(s.tasks.get('TM').assignee_id, null);
});

test('member_update: alleen de eigenaar, niet van zichzelf of een eigenaar; ook in subprojecten van de eigenaar; een lezer verliest zijn toewijzingen', () => {
  const s = world();
  const before = snap(s);
  run(s, 'member_update', { project_id: 'P', user_id: 'u-bram', role: 'viewer' }); // Carol is geen eigenaar
  run(s, 'member_update', { project_id: 'P', user_id: 'u-bram', role: 'viewer' }, 'u-bram'); // van zichzelf
  run(s, 'member_update', { project_id: 'P', user_id: 'u-anna', role: 'viewer' }, 'u-anna'); // de eigenaar zelf
  run(s, 'member_update', { project_id: 'P', user_id: 'u-bram', role: 'owner' }, 'u-anna'); // geen rol die je kunt geven
  run(s, 'member_update', { project_id: 'P', user_id: 'u-niemand', role: 'viewer' }, 'u-anna'); // geen lid
  assert.equal(snap(s), before);
  run(s, 'member_update', { project_id: 'P', user_id: ME, role: 'member' }, 'u-anna');
  assert.deepEqual([s.members.get(`P-${ME}`).role, s.members.get(`SUB-${ME}`).role], ['member', 'member'], 'ook in het subproject van Anna');
  run(s, 'member_update', { project_id: 'P', user_id: 'u-bram', role: 'viewer' }, 'u-anna');
  assert.equal(s.members.get('P-u-bram').role, 'viewer');
  assert.equal(s.tasks.get('T').assignee_id, null, 'Bram is lezer geworden: niet meer toegewezen');
  assert.equal(s.tasks.get('TM').assignee_id, 'u-bram', 'in een ander project blijft de toewijzing');
});

test('de Inbox wordt niet gearchiveerd en krijgt geen subprojecten; een herinnering hoort bij een taak die bestaat (zoals de server)', () => {
  const s = world();
  run(s, 'project_update', { id: 'inbox-u-carol', is_archived: true });
  assert.equal(s.projects.get('inbox-u-carol').is_archived, false);
  run(s, 'project_add', { id: 'n1', name: 'Onder de Inbox', parent_id: 'inbox-u-carol' });
  assert.equal(s.projects.has('n1'), false);
  run(s, 'reminder_add', { id: 'r1', task_id: 'bestaat-niet', type: 'relative', minute_offset: 5 });
  assert.equal(s.reminders.has('r1'), false);
});

test('toewijzing aan iemand die in het nieuwe project alleen leest, vervalt bij verhuizen en bij terugzetten', () => {
  const s = world();
  s.members.set('MINE-u-kees', { id: 'MINE-u-kees', project_id: 'MINE', user_id: 'u-kees', role: 'member' });
  s.tasks.set('TK', { id: 'TK', project_id: 'MINE', section_id: null, parent_id: null, content: 'Kees', checked: false, labels: [], order_key: 'W', assignee_id: 'u-kees' });
  run(s, 'task_move', { id: 'TK', project_id: 'Q' });
  assert.equal(s.tasks.get('TK').project_id, 'Q');
  assert.equal(s.tasks.get('TK').assignee_id, null, 'Kees is lezer in Q');
  // terugzetten (als eigenaar van Q): een taak die aan een lezer was toegewezen, komt terug zonder toewijzing
  const rows = { tasks: [{ id: 'gone', project_id: 'Q', section_id: null, parent_id: null, content: 'Terug', labels: [], order_key: 'X', assignee_id: 'u-kees' }] };
  applyCommand(s, { type: 'task_restore', args: { id: 'gone' }, local: { rows } }, NOW, 'u-anna');
  assert.equal(s.tasks.get('gone').assignee_id, null);
});

test('member_update laat een subproject van een ander met rust, en zonder bekende leden beslist de server', () => {
  const s = world();
  s.projects.set('BSUB', { id: 'BSUB', name: 'Garage', parent_id: 'P', order_key: 'W', is_archived: false });
  s.members.set('BSUB-u-bram', { id: 'BSUB-u-bram', project_id: 'BSUB', user_id: 'u-bram', role: 'owner' });
  s.members.set(`BSUB-${ME}`, { id: `BSUB-${ME}`, project_id: 'BSUB', user_id: ME, role: 'viewer' });
  run(s, 'member_update', { project_id: 'P', user_id: ME, role: 'member' }, 'u-anna');
  assert.deepEqual([s.members.get(`P-${ME}`).role, s.members.get(`BSUB-${ME}`).role], ['member', 'viewer'], 'Anna is geen eigenaar van het project van Bram');
  // een project waarvan de app de leden (nog) niet kent: niet blokkeren, de server beslist
  s.projects.set('ONBEKEND', { id: 'ONBEKEND', name: 'Nieuw gedeeld', parent_id: null, order_key: 'Z', is_archived: false });
  run(s, 'task_add', { id: 'n9', project_id: 'ONBEKEND', content: 'Mag' });
  assert.ok(s.tasks.has('n9'));
});
