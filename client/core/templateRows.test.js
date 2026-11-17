// Tests voor de regels van het sjabloonbewerkscherm (core/templateRows.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTemplateContent } from '../../shared/template.js';
import { moveRow, rowsToTemplate, shiftRow, templateToRows } from './templateRows.js';

const content = {
  v: 1,
  tasks: [{ content: 'Plannen', day: 0, labels: ['werk'], subtasks: [{ content: 'Bellen', description: 'eerst' }] }],
  sections: [{ name: 'Keuken', tasks: [{ content: 'Offerte', day: 2, time: '10:00', reminders: [30], recurrence: { freq: 'weekly', byweekday: [5] }, repeat_text: 'elke vrijdag' }] }],
};

test('heen en terug: dezelfde inhoud, ook de velden die het scherm niet toont', () => {
  const rows = templateToRows(content);
  assert.deepEqual(rows.map((r) => (r.kind === 'section' ? `# ${r.name}` : `${r.depth}:${r.task.content}`)), ['1:Plannen', '2:Bellen', '# Keuken', '1:Offerte']);
  assert.deepEqual(rowsToTemplate(rows), content);
  assert.equal(checkTemplateContent(rowsToTemplate(rows)), null);
  rows[0].task.content = 'Gewijzigd';
  assert.equal(content.tasks[0].content, 'Plannen', 'de regels zijn een kopie');
});

test('terug naar inhoud: lege taken weg, niveaus netjes, een tijd zonder dag krijgt dag 0, herinneringen alleen met een tijd', () => {
  const rows = [
    { kind: 'task', depth: 3, task: { content: '  te diep  ' } },
    { kind: 'task', depth: 2, task: { content: '   ' } },
    { kind: 'task', depth: 2, task: { content: 'onder', time: '08:00', reminders: [10] } },
    { kind: 'section', name: '  Week  ' },
    { kind: 'task', depth: 2, task: { content: 'eerste in sectie', reminders: [10] } },
    { kind: 'task', depth: 9, task: { content: 'diep' } },
  ];
  const out = rowsToTemplate(rows);
  assert.deepEqual(out, {
    v: 1,
    tasks: [{ content: 'te diep', subtasks: [{ content: 'onder', time: '08:00', day: 0, reminders: [10] }] }],
    sections: [{ name: 'Week', tasks: [{ content: 'eerste in sectie', subtasks: [{ content: 'diep' }] }] }],
  });
  assert.equal(checkTemplateContent(out), null);
  assert.deepEqual(rowsToTemplate([]), { v: 1, tasks: [], sections: [] });
});

test('in- en uitspringen: hooguit één dieper dan de regel erboven, niet onder een sectiekop, niet ondieper dan 1', () => {
  const rows = templateToRows(content);
  assert.equal(shiftRow(rows, 0, 1), rows, 'de eerste kan niet inspringen');
  assert.equal(shiftRow(rows, 1, 1), rows, 'Bellen staat al zo diep als kan (onder Plannen)');
  assert.equal(shiftRow(rows, 1, -1)[1].depth, 1);
  assert.equal(shiftRow(rows, 3, 1), rows, 'onder een sectiekop: niveau 1');
  assert.equal(shiftRow(rows, 2, 1), rows, 'een sectiekop springt niet in');
  assert.equal(shiftRow(rows, 9, 1), rows);
});

test('verplaatsen: een plek omhoog of omlaag, niet voorbij de randen', () => {
  const rows = templateToRows(content);
  const up = moveRow(rows, 3, -1);
  assert.deepEqual(up.map((r) => r.kind === 'section' ? r.name : r.task.content), ['Plannen', 'Bellen', 'Offerte', 'Keuken']);
  assert.equal(moveRow(rows, 0, -1), rows);
  assert.equal(moveRow(rows, 3, 1), rows);
});
