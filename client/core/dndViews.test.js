// Tests voor het slepen op het bord (kaarten tussen kolommen) en in de kalender (een taak naar een andere dag).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyState } from './reducer.js';
import { boardColumns } from './projectViews.js';
import { planCardDrop, planCardKey, planDayDrop, planDayKey, taskMoveCommands } from './dnd.js';

const NOW = '2026-11-13T10:00:00.000Z';

function sample() {
  const v = emptyState();
  const put = (res, row) => v[res].set(row.id, { is_archived: false, checked: false, labels: [], due: null, parent_id: null, section_id: null, priority: 4, ...row });
  put('projects', { id: 'p', name: 'Thuis', order_key: 'k' });
  put('projects', { id: 'q', name: 'Werk', order_key: 'm' });
  put('sections', { id: 's1', project_id: 'p', name: 'Keuken', order_key: 'V' });
  put('sections', { id: 's2', project_id: 'p', name: 'Badkamer', order_key: 'k' });
  put('sections', { id: 's3', project_id: 'p', name: 'Zolder', order_key: 'z' });
  put('sections', { id: 'sq', project_id: 'q', name: 'Planning', order_key: 'V' });
  put('tasks', { id: 'a', project_id: 'p', content: 'Alfa', order_key: 'a' });
  put('tasks', { id: 'b', project_id: 'p', content: 'Bravo', order_key: 'b' });
  put('tasks', { id: 'k1', project_id: 'p', section_id: 's1', content: 'Afwas', order_key: 'a' });
  put('tasks', { id: 'k2', project_id: 'p', section_id: 's1', content: 'Koken', order_key: 'b' });
  put('tasks', { id: 'k3', project_id: 'p', section_id: 's1', content: 'Opruimen', order_key: 'c' });
  put('tasks', { id: 'sub', project_id: 'p', section_id: 's1', parent_id: 'k2', content: 'Pannen', order_key: 'a' });
  put('tasks', { id: 'x1', project_id: 'p', section_id: 's2', content: 'Tegels', order_key: 'a' });
  put('tasks', { id: 'done', project_id: 'p', section_id: 's2', content: 'Klaar', order_key: 'b', checked: true });
  put('tasks', { id: 'w', project_id: 'q', section_id: 'sq', content: 'Vergadering', order_key: 'a' });
  return v;
}
const column = (v, id, { showCompleted = false } = {}) => boardColumns(v, 'p', { showCompleted }).columns.find((c) => c.id === id).tasks.map((t) => t.content);
const run = (v, commands) => { for (const c of commands) applyCommand(v, c, NOW); };

// ---------- bord: loslaten ----------

test('kaart loslaten boven of onder een andere kaart, in dezelfde of een andere kolom', () => {
  const v = sample();
  assert.deepEqual(planCardDrop(v, { dragId: 'k3', overId: 'k1', zone: 'before', projectId: 'p', sectionId: 's1' }), { project_id: 'p', section_id: 's1', parent_id: null, beforeId: 'k1' });
  assert.deepEqual(planCardDrop(v, { dragId: 'k1', overId: 'k2', zone: 'after', projectId: 'p', sectionId: 's1' }), { project_id: 'p', section_id: 's1', parent_id: null, beforeId: 'k3' }, 'onder Koken is vóór Opruimen');
  assert.deepEqual(planCardDrop(v, { dragId: 'k3', overId: 'k2', zone: 'after', projectId: 'p', sectionId: 's1' }), null, 'daar staat ze al');
  assert.deepEqual(planCardDrop(v, { dragId: 'k1', overId: 'x1', zone: 'after', projectId: 'p', sectionId: 's2' }), { project_id: 'p', section_id: 's2', parent_id: null, beforeId: 'done' }, 'een andere kolom: vóór de kaart die erna kwam (ook de afgevinkte)');
  assert.deepEqual(planCardDrop(v, { dragId: 'a', overId: 'k1', zone: 'before', projectId: 'p', sectionId: 's1' }).section_id, 's1', 'uit "zonder sectie" naar een sectie');
  assert.deepEqual(planCardDrop(v, { dragId: 'k1', overId: 'b', zone: 'before', projectId: 'p', sectionId: null }), { project_id: 'p', section_id: null, parent_id: null, beforeId: 'b' }, 'naar "zonder sectie"');
});

test('kaart loslaten: nooit een subtaak, nooit op zichzelf, nooit in een sectie van een ander project, nooit in een onbekende kolom', () => {
  const v = sample();
  assert.equal(planCardDrop(v, { dragId: 'k1', overId: 'k1', zone: 'before', projectId: 'p', sectionId: 's1' }), null);
  assert.equal(planCardDrop(v, { dragId: 'k1', overId: 'x1', zone: 'child', projectId: 'p', sectionId: 's2' }), null, 'geen "child"-zone op het bord');
  assert.equal(planCardDrop(v, { dragId: 'k1', overId: 'x1', zone: 'after', projectId: 'p', sectionId: 'sq' }), null, 'sectie van een ander project');
  assert.equal(planCardDrop(v, { dragId: 'k1', overId: 'x1', zone: 'after', projectId: 'weg', sectionId: null }), null);
  assert.equal(planCardDrop(v, { dragId: 'k1', overId: 'w', zone: 'after', projectId: 'p', sectionId: 's2' }), null, 'een kaart die niet in die kolom staat');
  assert.equal(planCardDrop(v, { dragId: 'nee', overId: 'x1', zone: 'after', projectId: 'p', sectionId: 's2' }), null);
});

test('kaart verplaatsen met de commando\'s van het plan: sectie, volgorde en subtaken kloppen daarna op het bord', () => {
  const v = sample();
  const plan = planCardDrop(v, { dragId: 'k2', overId: 'x1', zone: 'before', projectId: 'p', sectionId: 's2' });
  run(v, taskMoveCommands(v, 'k2', plan));
  assert.deepEqual(column(v, 's2'), ['Koken', 'Tegels']);
  assert.deepEqual(column(v, 's1'), ['Afwas', 'Opruimen']);
  assert.equal(v.tasks.get('sub').section_id, 's2', 'de subtaak gaat mee');
  const again = planCardDrop(v, { dragId: 'a', overId: 'x1', zone: 'after', projectId: 'p', sectionId: 's2' });
  run(v, taskMoveCommands(v, 'a', again));
  assert.deepEqual(column(v, 's2'), ['Koken', 'Tegels', 'Alfa'], 'onder Tegels: de afgevinkte kaart staat daarachter, maar is verborgen');
});

// ---------- bord: toetsenbord ----------

test('kaart met het toetsenbord: omhoog en omlaag in de kolom, aan de rand blijft ze staan', () => {
  const v = sample();
  assert.equal(planCardKey(v, 'k1', 'up').blocked, 'first');
  assert.equal(planCardKey(v, 'k3', 'down').blocked, 'last');
  const up = planCardKey(v, 'k3', 'up');
  assert.deepEqual([up.plan.beforeId, up.plan.section_id, up.position, up.count, up.container], ['k2', 's1', 2, 3, 'Keuken']);
  const down = planCardKey(v, 'k1', 'down');
  assert.equal(down.plan.beforeId, 'k3', 'een plek omlaag: vóór de kaart die twee lager staat');
  run(v, taskMoveCommands(v, 'k1', down.plan));
  assert.deepEqual(column(v, 's1'), ['Koken', 'Afwas', 'Opruimen']);
});

test('kaart met het toetsenbord naar de kolom links of rechts, op dezelfde hoogte', () => {
  const v = sample();
  const right = planCardKey(v, 'k3', 'indent'); // pijl rechts: Opruimen (3e in Keuken) naar Badkamer
  assert.deepEqual([right.plan.section_id, right.plan.beforeId, right.container], ['s2', null, 'Badkamer'], 'Badkamer heeft maar één zichtbare kaart: onderaan');
  const left = planCardKey(v, 'x1', 'outdent');
  assert.deepEqual([left.plan.section_id, left.plan.beforeId], ['s1', 'k1'], 'eerste plek links: vóór Afwas');
  assert.equal(planCardKey(v, 'a', 'outdent').blocked, 'noColumnBefore', '"zonder sectie" is de eerste kolom');
  assert.equal(planCardKey(v, 'a', 'indent').plan.section_id, 's1', 'van "zonder sectie" naar Keuken');
  v.tasks.set('z1', { ...v.tasks.get('a'), id: 'z1', content: 'Spullen', section_id: 's3', order_key: 'a' });
  assert.equal(planCardKey(v, 'z1', 'indent').blocked, 'noColumnAfter', 'Zolder is de laatste kolom');
  assert.equal(planCardKey(v, 'sub', 'up').blocked, 'gone', 'een subtaak is geen kaart');
  assert.equal(planCardKey(v, 'k1', 'dansen').blocked, 'unknown');
  run(v, taskMoveCommands(v, 'k3', right.plan));
  assert.deepEqual(column(v, 's2'), ['Tegels', 'Opruimen']);
});

test('kaart met het toetsenbord telt afgevinkte kaarten mee zodra die zichtbaar zijn', () => {
  const v = sample();
  assert.equal(planCardKey(v, 'x1', 'down').blocked, 'last');
  assert.equal(planCardKey(v, 'x1', 'down', { isVisible: () => true }).blocked, undefined, 'met voltooide kaarten zichtbaar is er nog een plek lager');
});

// ---------- kalender ----------

test('taak loslaten op een dag: de datum verandert, tijd en herhaling blijven', () => {
  const v = sample();
  v.tasks.set('d1', { ...v.tasks.get('a'), id: 'd1', due: { date: '2026-11-16' } });
  v.tasks.set('d2', { ...v.tasks.get('a'), id: 'd2', due: { date: '2026-11-16T09:30' } });
  v.tasks.set('d3', { ...v.tasks.get('a'), id: 'd3', due: { date: '2026-11-17T08:00', string: 'elke dinsdag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [2] } } });
  assert.deepEqual(planDayDrop(v, { dragId: 'd1', date: '2026-11-20' }), { date: '2026-11-20', due: { date: '2026-11-20' } });
  assert.deepEqual(planDayDrop(v, { dragId: 'd2', date: '2026-11-20' }).due, { date: '2026-11-20T09:30' }, 'het tijdstip blijft');
  assert.deepEqual(planDayDrop(v, { dragId: 'd3', date: '2026-11-19' }).due, { date: '2026-11-19T08:00', recurrence: { freq: 'weekly', byweekday: [2] }, string: 'elke dinsdag', lang: 'nl' }, 'de herhaling blijft; alleen de huidige datum schuift');
  assert.equal(planDayDrop(v, { dragId: 'd1', date: '2026-11-16' }), null, 'dezelfde dag verandert niets');
  assert.equal(planDayDrop(v, { dragId: 'd2', date: '2026-11-16' }), null, 'ook niet met een tijd');
  assert.equal(planDayDrop(v, { dragId: 'a', date: '2026-11-20' }), null, 'een taak zonder datum');
  assert.equal(planDayDrop(v, { dragId: 'nee', date: '2026-11-20' }), null);
  assert.equal(planDayDrop(v, { dragId: 'd1', date: 'morgen' }), null, 'geen dag');
  v.tasks.get('d1').checked = true;
  assert.equal(planDayDrop(v, { dragId: 'd1', date: '2026-11-20' }), null, 'een afgevinkte taak');
});

test('een verzette terugkerende taak blijft herhalen vanaf de nieuwe datum (via task_update, zoals de app het doet)', () => {
  const v = sample();
  v.tasks.set('d3', { ...v.tasks.get('a'), id: 'd3', due: { date: '2026-11-17', string: 'elke 2 weken', lang: 'nl', recurrence: { freq: 'weekly', interval: 2 } } });
  const plan = planDayDrop(v, { dragId: 'd3', date: '2026-11-19' });
  applyCommand(v, { type: 'task_update', args: { id: 'd3', due: plan.due } }, NOW);
  assert.deepEqual(v.tasks.get('d3').due.recurrence, { freq: 'weekly', interval: 2 });
  assert.equal(v.tasks.get('d3').due.date, '2026-11-19');
  assert.equal(v.tasks.get('d3').completed_count ?? 0, 0, 'verzetten is niet afronden');
});

test('taak met het toetsenbord een dag of week verzetten, ook over een maand- en jaargrens', () => {
  const v = sample();
  v.tasks.set('d1', { ...v.tasks.get('a'), id: 'd1', due: { date: '2026-12-31T21:00' } });
  assert.equal(planDayKey(v, 'd1', 'indent').date, '2027-01-01', 'pijl rechts: een dag verder, over de jaargrens');
  assert.equal(planDayKey(v, 'd1', 'indent').plan.due.date, '2027-01-01T21:00');
  assert.equal(planDayKey(v, 'd1', 'outdent').date, '2026-12-30');
  assert.equal(planDayKey(v, 'd1', 'down').date, '2027-01-07');
  assert.equal(planDayKey(v, 'd1', 'up').date, '2026-12-24');
  assert.equal(planDayKey(v, 'a', 'down').blocked, 'gone', 'zonder datum');
  assert.equal(planDayKey(v, 'd1', 'dansen').blocked, 'gone');
  v.tasks.set('d2', { ...v.tasks.get('a'), id: 'd2', due: { date: '2028-02-28' } });
  assert.equal(planDayKey(v, 'd2', 'indent').date, '2028-02-29', 'schrikkeldag');
});
