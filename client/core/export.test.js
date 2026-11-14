import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allProjectsCsv, csvCell, csvLine, exportFileName, exportJson, projectCsv, projectRows } from './export.js';

const m = (rows) => new Map(rows.map((r) => [r.id, r]));
const view = () => ({
  projects: m([{ id: 'p1', name: 'Huishouden', order_key: 'a' }, { id: 'p2', name: 'Vakantie Texel', order_key: 'b', parent_id: null }, { id: 'p3', name: 'Fietsroute', order_key: 'a', parent_id: 'p2' }]),
  sections: m([{ id: 's1', project_id: 'p1', name: 'Boodschappen', order_key: 'a' }]),
  labels: m([{ id: 'l1', name: 'bellen' }, { id: 'l2', name: 'met de auto' }]),
  tasks: m([
    { id: 't1', project_id: 'p1', section_id: null, parent_id: null, content: 'Rekening betalen', description: 'Voor 1 dec, "dringend"', priority: 1, labels: ['l1'], due: { date: '2026-11-20', string: 'vrijdag', lang: 'nl' }, order_key: 'a', creator_id: 'u1', assignee_id: 'u2' },
    { id: 't2', project_id: 'p1', section_id: 's1', parent_id: null, content: 'Melk, eieren', description: '', priority: 4, labels: ['l2'], due: null, order_key: 'a', creator_id: 'u1' },
    { id: 't3', project_id: 'p1', section_id: 's1', parent_id: 't2', content: 'Koffiebonen', description: '', priority: 3, labels: [], due: { date: '2026-11-21T09:30' }, order_key: 'a' },
    { id: 't4', project_id: 'p1', section_id: null, parent_id: null, content: '=SOM(A1:A2)', description: '', priority: 4, labels: [], due: null, order_key: 'b' },
    { id: 't5', project_id: 'p1', section_id: null, parent_id: null, content: 'Verwijderd', is_deleted: true, order_key: 'c' },
    { id: 't6', project_id: 'p3', section_id: null, parent_id: null, content: 'Route plannen', description: '', priority: 4, labels: [], due: null, order_key: 'a' },
  ]),
  comments: m([
    { id: 'c1', task_id: 't1', content: 'Even bellen eerst', author_id: 'u2', created_at: '2026-11-10T10:00:00Z' },
    { id: 'c2', task_id: 't1', content: 'Verwijderd', author_id: 'u2', is_deleted: true },
    { id: 'c3', project_id: 'p1', content: 'Projectnotitie', author_id: 'u1' },
  ]),
});
const names = (id) => ({ u1: 'Anna', u2: 'Bram' })[id] ?? '';

test('csvCell: aanhalingstekens, komma, regeleinde, en geen formules voor een spreadsheet', () => {
  assert.equal(csvCell('gewoon'), 'gewoon');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('zeg "hoi"'), '"zeg ""hoi"""');
  assert.equal(csvCell('a\nb'), '"a\nb"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(4), '4');
  for (const bad of ['=SOM(A1)', '+31 6', '@bellen', '-cmd', '\tx']) assert.equal(csvCell(bad), `'${bad}`.includes(',') ? `"'${bad}"` : `'${bad}`, bad);
  assert.equal(csvCell('-5'), '-5', 'een negatief getal blijft een getal');
  assert.equal(csvCell('-5,5'), '"-5,5"');
  assert.equal(csvLine(['a', 'b,c', 3]), 'a,"b,c",3');
});

test('projectRows: taken zonder sectie, dan secties met taken, subtaken ingesprongen, opmerkingen als note, labels in de tekst', () => {
  const rows = projectRows(view(), 'p1', names);
  assert.deepEqual(rows.map((r) => r.slice(0, 5)), [
    ['task', 'Rekening betalen @bellen', 'Voor 1 dec, "dringend"', 1, 1],
    ['note', 'Even bellen eerst', '', '', ''],
    ['task', '=SOM(A1:A2)', '', 4, 1],
    ['section', 'Boodschappen', '', '', ''],
    ['task', 'Melk, eieren @met_de_auto', '', 4, 1],
    ['task', 'Koffiebonen', '', 3, 2],
  ]);
  assert.deepEqual(rows[0].slice(5), ['Anna', 'Bram', 'vrijdag', 'nl', '']);
  assert.deepEqual(rows[1].slice(5, 6), ['Bram']);
  assert.deepEqual(rows[5].slice(7, 9), ['2026-11-21T09:30', 'nl'], 'zonder tekst telt de datum zelf');
  assert.equal(rows.some((r) => r[1] === 'Verwijderd'), false, 'verwijderde taken en opmerkingen niet');
});

test('projectCsv: kopregel, CRLF, en alles netjes gequote', () => {
  const csv = projectCsv(view(), 'p1', names);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE');
  assert.equal(lines[1], 'task,Rekening betalen @bellen,"Voor 1 dec, ""dringend""",1,1,Anna,Bram,vrijdag,nl,');
  assert.equal(lines[3], "task,'=SOM(A1:A2),,4,1,,,,,", 'formule onschadelijk gemaakt');
  assert.equal(lines.at(-1), '', 'eindigt met een regeleinde');
});

test('allProjectsCsv: extra kolom PROJECT met het pad van subprojecten', () => {
  const csv = allProjectsCsv(view(), names).split('\r\n');
  assert.equal(csv[0], 'PROJECT,TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE');
  assert.ok(csv.some((l) => l.startsWith('Huishouden,task,Rekening betalen')));
  assert.ok(csv.some((l) => l === 'Vakantie Texel / Fietsroute,task,Route plannen,,4,1,,,,,'));
});

test('exportJson: alle tabellen, wie het maakte, en een datum', () => {
  const j = exportJson(view(), { username: 'anna', name: 'Anna' }, new Date('2026-11-14T08:00:00Z'));
  assert.equal(j.format, 'tickory-export');
  assert.equal(j.version, 1);
  assert.equal(j.exported_at, '2026-11-14T08:00:00.000Z');
  assert.deepEqual(j.user, { username: 'anna', name: 'Anna' });
  assert.deepEqual(j.projects.map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.equal(j.tasks.length, 6, 'de JSON bevat alles, ook wat als verwijderd staat gemarkeerd (dat zie je aan is_deleted)');
  assert.equal(exportJson(view(), null).user, null);
  assert.notEqual(j.tasks[0], view().tasks.get('t1'), 'het zijn kopieën');
});

test('exportFileName: veilig en met de datum', () => {
  const d = new Date(2026, 10, 14, 12, 0);
  assert.equal(exportFileName('export', 'json', d), 'tickory-export-2026-11-14.json');
  assert.equal(exportFileName('Huishouden', 'csv', d), 'tickory-Huishouden-2026-11-14.csv');
  assert.equal(exportFileName('Vakantie / Texel: "zomer"?', 'csv', d), 'tickory-Vakantie-Texel-zomer-2026-11-14.csv');
  assert.equal(exportFileName('../../etc/passwd', 'csv', d), 'tickory-etcpasswd-2026-11-14.csv');
  assert.equal(exportFileName('', 'csv', d), 'tickory-2026-11-14.csv');
  assert.equal(exportFileName('x'.repeat(200), 'csv', d).length < 90, true);
});
