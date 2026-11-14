// Importeren uit Todoist en uit de eigen export: lezen (CSV, zip, JSON), omzetten, grenzen, en een realistische back-up die op een
// echte server wordt geïmporteerd en weer ongedaan gemaakt. Alle namen en teksten zijn verzonnen.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleSync } from '../../server/sync.ts';
import { firstUser, mkdb } from '../../server/testutil.ts';
import { isValidKey } from '../../shared/orderKey.js';
import { APPLY_LIMITS } from '../../shared/template.js';
import { makeZip } from '../../scripts/zipFixture.ts';
import { sampleBackup } from '../../scripts/todoistSample.ts';
import { createActions } from './actions.js';
import { allProjectsCsv, exportJson, projectCsv } from './export.js';
import { setLanguage } from './i18n.js';
import { canonicalLabel, importQuotaProblem, planImport, selectedProjects } from './importPlan.js';
import { MemoryAdapter, Store } from './store.js';
import { SyncClient } from './syncClient.js';
import {
  IMPORT_LIMITS, allTasks, decodeText, dutchRepeatText, extractLabels, isImportFile, nestByName, parseCsvFile, parseOwnJson,
  projectNameFromFile, readDate, readImport,
} from './todoistImport.js';

setLanguage('nl');
// zaterdag 14 november 2026, 10:00
const NOW = new Date(2026, 10, 14, 10, 0);
const enc = new TextEncoder();
const HEADER = 'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE';
const HEADER_NEW = `${HEADER},DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG`;
const csv = (...lines) => `${lines.join('\r\n')}\r\n`;
const one = (text, name = 'Thuis.csv') => {
  const r = parseCsvFile(text, name, NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.projects[0];
};
const tasksOf = (project) => [...allTasks(project)];

// ---------- CSV ----------

test('CSV: BOM, CRLF, aanhalingstekens (komma, "" en een regeleinde in een veld) en lege regels', () => {
  const text = `\uFEFF${csv(HEADER,
    'task,"Melk, eieren en ""echte"" boter",,4,1,,,,,',
    ',,,,,,,,,',
    '',
    'task,Brood,"Volkoren\nof spelt",4,1,,,,,')}`;
  const p = one(text);
  assert.deepEqual(tasksOf(p).map((x) => x.content), ['Melk, eieren en "echte" boter', 'Brood']);
  assert.equal(tasksOf(p)[1].description, 'Volkoren\nof spelt');
  assert.equal(p.stats.skippedRows, 0, 'lege regels tellen niet als overgeslagen');
  const lf = one(`${HEADER}\ntask,Een\ntask,Twee\n`);
  assert.deepEqual(tasksOf(lf).map((x) => x.content), ['Een', 'Twee'], 'LF en ontbrekende kolommen achteraan');
});

test('CSV: kolommen op naam, in elke volgorde; extra en ontbrekende kolommen; kleine letters in de kop; dubbele kolom', () => {
  const p = one(csv('content,Type,EXTRA,priority', 'Afwassen,task,iets,1', 'Stofzuigen,TASK,,2'));
  assert.deepEqual(tasksOf(p).map((x) => [x.content, x.priority]), [['Afwassen', 1], ['Stofzuigen', 2]]);
  const old = one(csv('TYPE,CONTENT,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE', 'task,Oud formaat zonder beschrijving,2,1,Anna (1846598),,,en,Europe/Amsterdam'));
  assert.equal(tasksOf(old)[0].priority, 2);
  assert.deepEqual(old.people.authors, ['Anna']);
  const dup = one(csv('TYPE,CONTENT,CONTENT', 'task,Eerste,Tweede'));
  assert.equal(tasksOf(dup)[0].content, 'Eerste', 'bij een dubbele kolom telt de eerste');
  assert.deepEqual(parseCsvFile(csv('NAAM,WAT', 'a,b'), 'x.csv', NOW), { ok: false, code: 'notTodoist' });
  assert.deepEqual(parseCsvFile('', 'x.csv', NOW), { ok: false, code: 'empty' });
});

test('CSV: een puntkomma als scheidingsteken (Excel in het Nederlands) en de codering van Windows', () => {
  const p = one(csv('TYPE;CONTENT;PRIORITY', 'task;Rekening betalen, vandaag;1'));
  assert.deepEqual(tasksOf(p).map((x) => [x.content, x.priority]), [['Rekening betalen, vandaag', 1]]);
  const latin = Uint8Array.from([...enc.encode(`${HEADER}\r\ntask,Caf`), 0xe9, ...enc.encode(' reserveren\r\n')]);
  assert.equal(decodeText(latin).includes('Café reserveren'), true);
  assert.equal(decodeText(enc.encode('\uFEFFabc')), 'abc');
});

test('CSV: secties, subtaken via INDENT (een sprong wordt één niveau, dieper dan vijf wordt platgeslagen) en dubbele secties', () => {
  const p = one(csv(HEADER,
    'task,Zonder sectie,,4,1,,,,,',
    'section,Keuken,,,,,,,,',
    'task,Opruimen,,4,1,,,,,',
    'task,Kastjes,,4,3,,,,,',
    'task,Bovenkast,,4,4,,,,,',
    'section,keuken,,,,,,,,',
    'task,Vloer,,4,1,,,,,',
    'task,N1,,4,1,,,,,', 'task,N2,,4,2,,,,,', 'task,N3,,4,3,,,,,', 'task,N4,,4,4,,,,,', 'task,N5,,4,5,,,,,', 'task,N6,,4,6,,,,,', 'task,N7,,4,7,,,,,',
    'section,,,,,,,,,',
    'onzin,Iets,,,,,,,,'));
  assert.deepEqual(p.tasks.map((x) => x.content), ['Zonder sectie']);
  assert.deepEqual(p.sections.map((s) => s.name), ['Keuken'], 'dezelfde naam (hoofdletters maken niet uit) is één sectie');
  const keuken = p.sections[0].tasks;
  assert.deepEqual(keuken.map((x) => x.content), ['Opruimen', 'Vloer', 'N1']);
  assert.equal(keuken[0].subtasks[0].content, 'Kastjes', 'INDENT 3 onder 1 wordt niveau 2');
  assert.equal(keuken[0].subtasks[0].subtasks[0].content, 'Bovenkast');
  let deep = keuken[2];
  for (let i = 0; i < 4; i++) deep = deep.subtasks[0];
  assert.equal(deep.content, 'N5');
  assert.deepEqual(keuken[2].subtasks[0].subtasks[0].subtasks[0].subtasks.map((x) => x.content), ['N5', 'N6', 'N7'], 'N6 en N7 komen op het vijfde niveau');
  assert.equal(p.stats.flattened, 2);
  assert.equal(p.stats.skippedRows, 2, 'een sectie zonder naam en een onbekend type');
  assert.equal(p.stats.tasks, 12);
  assert.equal(p.stats.sections, 1);
});

test('prioriteit: dezelfde schaal als in Todoist (1 = p1, hoogst; 4 = p4, geen); leeg of onzin is geen prioriteit', () => {
  // Aanname, nagezocht in de documentatie van Todoist ("Type 1 to add p1 to the task (highest priority)") en een echte export
  // (een gewone taak heeft PRIORITY 4). De API van Todoist telt andersom (4 = p1), maar dat getal staat niet in de CSV.
  const p = one(csv(HEADER, 'task,Een,,1,1', 'task,Twee,,2,1', 'task,Drie,,3,1', 'task,Vier,,4,1', 'task,Leeg,,,1', 'task,Vijf,,5,1', 'task,Tekst,,hoog,1', 'task,Nul,,0,1'));
  assert.deepEqual(tasksOf(p).map((x) => [x.content, x.priority]), [['Een', 1], ['Twee', 2], ['Drie', 3], ['Vier', 4], ['Leeg', 4], ['Vijf', 4], ['Tekst', 4], ['Nul', 4]]);
  const plan = planFor([p]);
  const sent = plan.batches[0].commands.filter((c) => c.type === 'task_add').map((c) => c.args.priority);
  assert.deepEqual(sent, [1, 2, 3, undefined, undefined, undefined, undefined, undefined], 'geen prioriteit wordt niet meegestuurd (de standaard is 4)');
});

// ---------- labels ----------

test('labels: @naam uit de titel, leestekens erachter, dubbel, ongeldig en een e-mailadres', () => {
  assert.deepEqual(extractLabels('Bellen @telefoon @Thuis'), { text: 'Bellen', labels: ['telefoon', 'Thuis'] });
  assert.deepEqual(extractLabels('Bellen @telefoon, morgen'), { text: 'Bellen, morgen', labels: ['telefoon'] });
  assert.deepEqual(extractLabels('Mail anna@example.org'), { text: 'Mail anna@example.org', labels: [] });
  assert.deepEqual(extractLabels('@a @A @a'), { text: '', labels: ['a'] });
  assert.deepEqual(extractLabels('Lang @'.concat('x'.repeat(101))), { text: `Lang @${'x'.repeat(101)}`, labels: [] });
  assert.deepEqual(extractLabels('Zoë @café_bezoek'), { text: 'Zoë', labels: ['café_bezoek'] });
  const p = one(csv(HEADER, 'task,@alleen_label,,4,1', 'task,* Niet af te vinken @werk,,4,1'));
  assert.deepEqual(tasksOf(p).map((x) => [x.content, x.labels]), [['@alleen_label', []], ['Niet af te vinken', ['werk']]], 'alleen een label: de tekst blijft de titel');
  assert.deepEqual(p.stats.labels, ['werk']);
});

test('labels: bestaande labels worden hergebruikt (hoofdletters, en _ voor een spatie uit de eigen export), nieuwe aangemaakt', () => {
  const view = emptyView();
  view.labels.set('l1', { id: 'l1', name: 'Boodschappen', order_key: 'a' });
  view.labels.set('l2', { id: 'l2', name: 'met de auto', order_key: 'b' });
  assert.equal(canonicalLabel(view, 'boodschappen'), 'Boodschappen');
  assert.equal(canonicalLabel(view, 'met_de_auto'), 'met de auto');
  assert.equal(canonicalLabel(view, 'nieuw_label'), 'nieuw_label');
  const p = one(csv(HEADER, 'task,Melk @boodschappen @met_de_auto @nieuw,,4,1', 'task,Kaas @NIEUW,,4,1'));
  const plan = planFor([p], view);
  const labelAdds = plan.batches[0].commands.filter((c) => c.type === 'label_add');
  assert.deepEqual(labelAdds.map((c) => c.args.name), ['nieuw']);
  const adds = plan.batches[0].commands.filter((c) => c.type === 'task_add');
  assert.deepEqual(adds[0].args.labels, ['l1', 'l2', labelAdds[0].args.id]);
  assert.deepEqual(adds[1].args.labels, [labelAdds[0].args.id]);
  assert.equal(plan.counts.newLabels, 1);
});

// ---------- datums ----------

test('datums: Nederlands via de Nederlandse herkenner, Engels via de kleine Engelse, ISO in elke taal', () => {
  assert.deepEqual(readDate('morgen', 'nl', NOW), { date: '2026-11-15' }, 'een vaste datum zonder tekst: "morgen" zegt later iets anders');
  assert.deepEqual(readDate('elke vrijdag', 'nl', NOW), { date: '2026-11-20', string: 'elke vrijdag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [5] } });
  assert.deepEqual(readDate('tomorrow at 9am', 'en', NOW), { date: '2026-11-15T09:00' });
  assert.deepEqual(readDate('Jan 12', 'en', NOW), { date: '2027-01-12' });
  assert.deepEqual(readDate('every monday', 'en', NOW), { date: '2026-11-16', string: 'elke maandag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [1] } }, 'een Engelse herhaling krijgt een Nederlandse tekst die de app weer leest');
  assert.deepEqual(readDate('every day at 9am', 'en', NOW), { date: '2026-11-15T09:00', string: 'elke dag om 09:00', lang: 'nl', recurrence: { freq: 'daily' } });
  assert.deepEqual(readDate('every other monday', 'en', NOW), { date: '2026-11-16', string: 'every other monday', lang: 'en', recurrence: { freq: 'weekly', interval: 2, byweekday: [1] } }, 'geen Nederlandse vorm: de Engelse tekst blijft');
  assert.deepEqual(readDate('2026-12-01', 'de', NOW), { date: '2026-12-01' });
  assert.deepEqual(readDate('2026-12-01T09:30:00Z', '', NOW), { date: '2026-12-01T09:30' });
  assert.deepEqual(readDate('next friday', '', NOW), { date: '2026-11-20' }, 'zonder taal eerst Engels');
  assert.deepEqual(readDate('overmorgen', '', NOW), { date: '2026-11-16' }, 'zonder taal daarna Nederlands');
  assert.equal(readDate('morgen', 'en', NOW), null);
  assert.equal(readDate('mañana', 'es', NOW), null, 'andere talen alleen als ISO-datum');
  assert.equal(readDate('every 3rd workday', 'en', NOW), null);
  assert.equal(readDate('2026-02-30', 'nl', NOW), null);
});

test('datums: elke Nederlandse tekst van een Engelse herhaling leest de app terug als dezelfde regel', () => {
  const cases = ['every day', 'every 3 days', 'every week', 'every 2 weeks', 'every monday', 'every mon, wed and fri', 'every weekday', 'every weekend',
    'every month', 'every month on the 15th', 'every 3 months on the 1st', 'every last day', 'every first monday', 'every last friday', 'every 2nd tue',
    'every jan 12', 'every year', 'every! 3 days', 'every! week', 'every friday at 17:30', 'every 15th at 8am'];
  for (const text of cases) {
    const due = readDate(text, 'en', NOW);
    assert.ok(due?.recurrence, text);
    assert.equal(due.lang, 'nl', `${text} → ${due.string}`);
    assert.ok(dutchRepeatText(due.recurrence, due.date), text);
  }
  assert.equal(dutchRepeatText({ freq: 'yearly', interval: 2, bymonthday: 3 }, '2027-01-03'), null);
});

test('datums: wat niet herkend wordt komt in de beschrijving, ook bij een deadline en een duur; de rest blijft staan', () => {
  const p = one(csv(HEADER_NEW,
    'task,Belasting,Aangifte doen,4,1,,,every 3rd workday,en,,,,,',
    'task,Verjaardag,,4,1,,,elk jaar op 5 december,nl,,,,,',
    'task,Deadline,,4,1,,,,,,,,2026-12-24,en',
    'task,Deadline Engels,,4,1,,,,,,,,Dec 24,en',
    'task,Deadline kapot,,4,1,,,,,,,,someday,en',
    'task,Deadline herhaalt,,4,1,,,,,,,,every day,en',
    'task,Kwartier,,4,1,,,,,,15,minute,,',
    'task,Twee dagen,,4,1,,,,,,2,day,,',
    'task,Geen duur,,4,1,,,,,,,None,,',
    'task,Te lang,,4,1,,,,,,30,day,,',
    'task,Raar,,4,1,,,,,,5,parsec,,'));
  const [belasting, verjaardag, deadline, deadlineEn, kapot, herhaalt, kwartier, twee, geen, lang, raar] = tasksOf(p);
  assert.equal(belasting.due, null);
  assert.equal(belasting.description, 'Aangifte doen\n\nDatum uit Todoist: every 3rd workday');
  assert.equal(verjaardag.due.recurrence.freq, 'yearly');
  assert.equal(deadline.deadline, '2026-12-24');
  assert.equal(deadlineEn.deadline, '2026-12-24');
  assert.equal(kapot.deadline, null);
  assert.equal(kapot.description, 'Deadline uit Todoist: someday');
  assert.equal(herhaalt.deadline, null, 'een deadline herhaalt niet');
  assert.equal(kwartier.duration, 15);
  assert.equal(twee.duration, 2 * 24 * 60);
  assert.equal(geen.duration, null);
  assert.equal(geen.description, '');
  assert.equal(lang.duration, null);
  assert.equal(lang.description, 'Duur uit Todoist: 30 day');
  assert.equal(raar.description, 'Duur uit Todoist: 5 parsec');
  assert.equal(p.stats.dates, 1);
  assert.equal(p.stats.deadlines, 2);
  assert.equal(p.stats.durations, 2);
});

test('datums: een lange beschrijving wordt ingekort zodat de regel over de datum er nog bij past', () => {
  const long = 'x'.repeat(IMPORT_LIMITS.description);
  const p = one(csv(HEADER, `task,Lang,${long},4,1,,,someday,en,`));
  const description = tasksOf(p)[0].description;
  assert.ok(description.length <= IMPORT_LIMITS.description);
  assert.ok(description.endsWith('\n\nDatum uit Todoist: someday'));
});

// ---------- opmerkingen ----------

test('opmerkingen: bij de taak erboven, anders bij het project; een bijlage wordt alleen haar naam', () => {
  const attachment = JSON.stringify({ file_type: 'image/png', file_name: 'Bonnetje.png', file_url: 'https://example.invalid/x.png' }).replace(/"/g, '""');
  const p = one(csv(HEADER,
    'note,Over het hele project,,,,Anna (1),,,,',
    'task,Boodschappen,,4,1,,,,,',
    'note,"Niet vergeten:\nde lijst",,,,Bram (2),,,,',
    `note,"Zie foto [[file ${attachment}]]",,,,,,,,`,
    'note,[[file {kapot]],,,,,,,,',
    'section,Later,,,,,,,,',
    'note,Na een sectie,,,,,,,,',
    'note,,,,,,,,,'));
  assert.deepEqual(p.comments, ['Over het hele project', 'Na een sectie']);
  assert.deepEqual(p.tasks[0].comments, ['Niet vergeten:\nde lijst', 'Zie foto [Bijlage: Bonnetje.png]', '[[file {kapot]]']);
  assert.equal(p.stats.attachments, 1);
  assert.equal(p.stats.comments, 5);
  assert.equal(p.stats.skippedRows, 1, 'een lege opmerking');
  assert.deepEqual(p.people.authors, ['Anna', 'Bram']);
  assert.equal(JSON.stringify(p).includes('example.invalid'), false, 'geen adres van een bijlage');
});

test('opmerkingen: hooguit 500 per taak; meer telt als niet overgenomen', () => {
  const lines = [HEADER, 'task,Druk,,4,1'];
  for (let i = 0; i < 503; i++) lines.push(`note,Opmerking ${i},,,,,,,,`);
  const p = one(csv(...lines));
  assert.equal(p.tasks[0].comments.length, 500);
  assert.equal(p.stats.commentsDropped, 3);
});

// ---------- tekst en grenzen ----------

test('tekst blijft tekst: HTML wordt niets, stuurtekens verdwijnen, NFC, en te lange teksten worden ingekort', () => {
  const p = one(csv(HEADER,
    'task,<img src=x onerror=alert(1)>,<b>vet</b>,4,1',
    'task,Zoe\u0308 bellen\u0007,,4,1',
    `task,${'a'.repeat(5000)},,4,1`,
    `section,${'s'.repeat(300)},,,,`));
  const [html, zoe, lang] = tasksOf(p);
  assert.equal(html.content, '<img src=x onerror=alert(1)>');
  assert.equal(html.description, '<b>vet</b>');
  assert.equal(zoe.content, 'Zoë bellen');
  assert.equal(lang.content.length, IMPORT_LIMITS.content);
  assert.ok(lang.content.endsWith('…'));
  assert.equal(p.sections[0].name.length, IMPORT_LIMITS.sectionName);
  assert.equal(p.stats.truncated, 2);
});

test('grenzen: te veel regels, te groot, te veel bestanden', async () => {
  const many = [HEADER, ...Array.from({ length: IMPORT_LIMITS.rows + 1 }, (_, i) => `task,T${i}`)].join('\n');
  assert.deepEqual(parseCsvFile(many, 'x.csv', NOW), { ok: false, code: 'tooManyRows' });
  const big = new Uint8Array(IMPORT_LIMITS.fileBytes + 1).fill(0x41);
  const r = await readImport([{ name: 'groot.csv', bytes: big }], { now: NOW });
  assert.deepEqual(r.problems, [{ name: 'groot.csv', code: 'tooBig' }]);
  const r2 = await readImport([{ name: 'leeg.csv', bytes: new Uint8Array(0) }, { name: 'raar', bytes: 'geen bytes' }, { name: 'alleenkop.csv', bytes: enc.encode(HEADER) }], { now: NOW });
  assert.deepEqual(r2.problems.map((x) => x.code), ['empty', 'unreadable', 'noTasks']);
});

test('de projectnaam uit de bestandsnaam: zonder map, uitgang en id van Todoist', () => {
  assert.equal(projectNameFromFile('backup/Werk [2203306141].csv'), 'Werk');
  assert.equal(projectNameFromFile('C:\\Downloads\\Thuis.CSV'), 'Thuis');
  assert.equal(projectNameFromFile('  Op   vakantie  .csv'), 'Op vakantie');
  assert.equal(projectNameFromFile('Kamer [A].csv'), 'Kamer [A]');
  assert.equal(projectNameFromFile(`${'n'.repeat(300)}.csv`).length, IMPORT_LIMITS.projectName);
});

test('mappen uit bestandsnamen: "Werk - Klanten" onder "Werk" alleen als dat eenduidig is', () => {
  const mk = (name, key) => ({ key, name, parentKey: null, source: 'todoist' });
  const set = nestByName([mk('Werk', 'a'), mk('Werk - Klanten', 'b'), mk('Werk - Klanten - Acme', 'c'), mk('Boodschappen - Markt', 'd'), mk('Huis - Tuin', 'e')]);
  assert.deepEqual(set.map((p) => [p.name, p.parentKey]), [['Werk', null], ['Klanten', 'a'], ['Acme', 'b'], ['Boodschappen - Markt', null], ['Huis - Tuin', null]]);
  const twice = nestByName([mk('Werk', 'a'), mk('werk', 'b'), mk('Werk - Klanten', 'c')]);
  assert.deepEqual(twice.map((p) => [p.name, p.parentKey]), [['Werk', null], ['werk', null], ['Werk - Klanten', null]], 'twee mogelijke ouders: niet raden');
  const own = nestByName([{ ...mk('Werk', 'a'), source: 'tickory-json' }, mk('Werk - Klanten', 'b')]);
  assert.equal(own[1].parentKey, null, 'alleen tussen bestanden van Todoist');
});

// ---------- de eigen export ----------

const m = (rows) => new Map(rows.map((r) => [r.id, r]));
function ownView() {
  return {
    projects: m([{ id: 'inbox-x', name: 'Inbox', order_key: 'a' }, { id: 'p1', name: 'Huishouden', color: 'teal', view_style: 'board', order_key: 'b' }, { id: 'p2', name: 'Fietsroute', parent_id: 'p1', order_key: 'a' }, { id: 'p3', name: 'Oud', is_archived: true, order_key: 'c' }]),
    sections: m([{ id: 's1', project_id: 'p1', name: 'Boodschappen', order_key: 'a' }]),
    labels: m([{ id: 'l1', name: 'met de auto', order_key: 'a' }]),
    tasks: m([
      { id: 't1', project_id: 'p1', section_id: null, parent_id: null, content: '=SOM(A1:A2)', description: '', priority: 1, labels: ['l1'], due: { date: '2026-11-20', string: 'vrijdag', lang: 'nl' }, deadline: '2026-12-01', duration: 30, order_key: 'a' },
      { id: 't2', project_id: 'p1', section_id: 's1', parent_id: null, content: 'Melk', description: 'Halfvol', priority: 4, labels: [], due: { date: '2026-11-16', string: 'elke maandag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [1] } }, order_key: 'a' },
      { id: 't3', project_id: 'p1', section_id: 's1', parent_id: 't2', content: 'Koffie', priority: 3, labels: [], due: null, order_key: 'a' },
      { id: 't4', project_id: 'p1', section_id: null, parent_id: null, content: 'Al gedaan', checked: true, labels: [], order_key: 'b' },
      { id: 't5', project_id: 'p2', section_id: null, parent_id: null, content: 'Route plannen', priority: 4, labels: [], order_key: 'a' },
      { id: 't6', project_id: 'inbox-x', section_id: null, parent_id: null, content: 'Losse taak', priority: 4, labels: [], order_key: 'a' },
    ]),
    comments: m([{ id: 'c1', task_id: 't1', content: 'Eerst bellen', created_at: '2026-11-10T10:00:00Z' }, { id: 'c2', project_id: 'p1', content: 'Projectnotitie', created_at: '2026-11-09T10:00:00Z' }]),
  };
}

test('eigen JSON-export: projecten met ouders, secties, open taken met subtaken, labels op naam, datums, opmerkingen', () => {
  const r = parseOwnJson(JSON.stringify(exportJson(ownView(), { username: 'anna', name: 'Anna' })), 'tickory-export.json');
  assert.equal(r.ok, true);
  assert.deepEqual(r.projects.map((p) => p.name), ['Inbox', 'Huishouden', 'Fietsroute'], 'zonder het gearchiveerde project');
  const [inbox, huis, fiets] = r.projects;
  assert.equal(fiets.parentKey, huis.key);
  assert.equal(huis.color, 'teal');
  assert.equal(huis.viewStyle, 'board');
  assert.deepEqual(huis.comments, ['Projectnotitie']);
  assert.equal(huis.tasks[0].content, '=SOM(A1:A2)');
  assert.deepEqual(huis.tasks[0].labels, ['met de auto']);
  assert.deepEqual(huis.tasks[0].due, { date: '2026-11-20' });
  assert.equal(huis.tasks[0].deadline, '2026-12-01');
  assert.equal(huis.tasks[0].duration, 30);
  assert.deepEqual(huis.tasks[0].comments, ['Eerst bellen']);
  assert.deepEqual(huis.sections[0].tasks[0].due.recurrence, { freq: 'weekly', byweekday: [1] });
  assert.equal(huis.sections[0].tasks[0].due.string, 'elke maandag');
  assert.equal(huis.sections[0].tasks[0].subtasks[0].content, 'Koffie');
  assert.equal(huis.stats.completed, 1);
  assert.equal(inbox.tasks[0].content, 'Losse taak');
  assert.deepEqual(parseOwnJson('{"format":"tickory-template","version":1}', 'x.json'), { ok: false, code: 'template' });
  assert.deepEqual(parseOwnJson('{"format":"tickory-export","version":2}', 'x.json'), { ok: false, code: 'unsupported' });
  assert.deepEqual(parseOwnJson('{"format":"iets"}', 'x.json'), { ok: false, code: 'notJson' });
  assert.deepEqual(parseOwnJson('[1,2]', 'x.json'), { ok: false, code: 'notJson' });
  assert.deepEqual(parseOwnJson('{kapot', 'x.json'), { ok: false, code: 'notJson' });
});

test('eigen JSON-export: onzin in de velden wordt genegeerd, een kring van ouders doorbroken, te diep platgeslagen', () => {
  const tasks = [{ id: 'a', project_id: 'p', content: 'A', order_key: 'a' }];
  for (let i = 1; i < 8; i++) tasks.push({ id: `d${i}`, project_id: 'p', parent_id: i === 1 ? 'a' : `d${i - 1}`, content: `D${i}`, order_key: 'a' });
  tasks.push({ id: 'x', project_id: 'p', parent_id: 'y', content: 'X', order_key: 'b' }, { id: 'y', project_id: 'p', parent_id: 'x', content: 'Y', order_key: 'c' });
  tasks.push({ id: 'z', project_id: 'p', content: 'Z', priority: 9, labels: 'geen lijst', due: { date: 'gisteren' }, deadline: '2026-13-01', duration: -5, order_key: 'd', __proto__: { evil: true } });
  const data = { format: 'tickory-export', version: 1, projects: [{ id: 'p', name: 'P', parent_id: 'q', order_key: 'a' }, { id: 'q', name: 'Q', parent_id: 'p', order_key: 'b' }, 'onzin', null], tasks, labels: [], comments: [{ id: 'c', task_id: 'onbekend', content: 'weg' }] };
  const r = parseOwnJson(JSON.stringify(data), 'x.json');
  assert.equal(r.ok, true);
  assert.ok(r.projects.some((p) => p.parentKey === null), 'een kring van projecten wordt doorbroken');
  const p = r.projects.find((x) => x.name === 'P');
  const z = p.tasks.find((x) => x.content === 'Z');
  assert.deepEqual([z.priority, z.labels, z.due, z.deadline, z.duration], [4, [], null, null, null]);
  assert.deepEqual(p.tasks.map((x) => x.content).sort(), ['A', 'X', 'Y', 'Z'], 'een kring van taken: allebei bovenaan');
  let deep = p.tasks.find((x) => x.content === 'A');
  for (let i = 0; i < 3; i++) deep = deep.subtasks[0];
  assert.deepEqual(deep.subtasks.map((x) => x.content), ['D4', 'D5', 'D6', 'D7'], 'dieper dan vijf: broers op het vijfde niveau');
  assert.equal(p.stats.flattened, 3);
});

test('eigen CSV-export: weer te importeren, met de mappen uit PROJECT en zonder de bescherming tegen formules', () => {
  const view = ownView();
  const r = parseCsvFile(allProjectsCsv(view), 'tickory-taken-2026-11-14.csv', NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.projects.map((p) => [p.name, p.source]), [['Inbox', 'tickory-csv'], ['Huishouden', 'tickory-csv'], ['Fietsroute', 'tickory-csv']], 'een project zonder taken staat niet in de CSV');
  const huis = r.projects[1];
  assert.equal(r.projects[2].parentKey, huis.key);
  assert.equal(huis.tasks[0].content, '=SOM(A1:A2)', "de ' die de export ervoor zette is weer weg");
  assert.deepEqual(huis.tasks[0].labels, ['met_de_auto']);
  assert.deepEqual(huis.tasks[0].due, { date: '2026-11-20' }, 'de export schrijft de datum zelf, niet "vrijdag"');
  assert.deepEqual(huis.tasks[0].comments, ['Eerst bellen']);
  assert.equal(huis.sections[0].tasks[0].due.string, 'elke maandag');
  assert.equal(huis.sections[0].tasks[0].subtasks[0].content, 'Koffie');
  const single = parseCsvFile(projectCsv(view, 'p1'), 'tickory-Huishouden-2026-11-14.csv', NOW);
  assert.equal(single.projects[0].tasks[0].content, '=SOM(A1:A2)');
  assert.equal(single.projects[0].name, 'tickory-Huishouden-2026-11-14');
  const todoist = one(csv(HEADER, "task,'=SOM(A1),,4,1"), 'Rekenen.csv');
  assert.equal(tasksOf(todoist)[0].content, "'=SOM(A1)", 'in een bestand van Todoist blijft de tekst zoals hij is');
});

test('isImportFile: zip, CSV van Todoist en de eigen JSON wel; een foto of een andere CSV niet', async () => {
  assert.equal(isImportFile(await makeZip([{ name: 'a.csv', data: 'x' }])), true);
  assert.equal(isImportFile(enc.encode(`\uFEFF${HEADER}\r\ntask,x`)), true);
  assert.equal(isImportFile(enc.encode('"TYPE";"CONTENT"\nTask;x')), true);
  assert.equal(isImportFile(enc.encode('{\n  "format": "tickory-export",\n  "version": 1')), true);
  assert.equal(isImportFile(enc.encode('{"format":"tickory-template"}')), false);
  assert.equal(isImportFile(enc.encode('Naam,Bedrag\nHuur,800')), false);
  assert.equal(isImportFile(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(isImportFile('tekst'), false);
});

// ---------- het plan en de grenzen ----------

function emptyView() {
  return { projects: new Map(), sections: new Map(), tasks: new Map(), labels: new Map(), members: new Map(), comments: new Map(), reminders: new Map(), templates: new Map() };
}
let ids = 0;
const makeId = () => `imp${String(++ids).padStart(9, '0')}`;
function simpleLabels(view) {
  return (names) => {
    const byName = new Map();
    const commands = [];
    for (const name of names) {
      const found = [...view.labels.values()].find((l) => l.name.toLowerCase() === name.toLowerCase());
      const id = found?.id ?? makeId();
      if (!found) commands.push({ type: 'label_add', args: { id, name } });
      byName.set(name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase(), id);
    }
    return { byName, commands };
  };
}
function planFor(projects, view = emptyView(), extra = {}) {
  return planImport(view, projects, { selected: new Set(projects.map((p) => p.key)), under: null, inboxName: 'Inbox uit Todoist', makeId, resolveLabels: simpleLabels(view), ...extra });
}

test('het plan: per project één reeks in de goede volgorde, ouders eerst, korte geldige volgordesleutels', () => {
  const lines = [HEADER, 'section,Eén,,,,', ...Array.from({ length: 400 }, (_, i) => `task,Taak ${i},,4,1`), 'task,Sub,,4,2', 'note,Bij Sub,,,,'];
  const parent = one(csv(...lines), 'Werk.csv');
  const child = { ...one(csv(HEADER, 'task,Klant bellen,,1,1'), 'Werk - Klanten.csv') };
  nestByName([parent, child]);
  const plan = planFor([child, parent], emptyView(), { under: 'Uit Todoist' });
  assert.equal(plan.batches.length, 2);
  assert.deepEqual(plan.batches.map((b) => b.name), ['Werk', 'Klanten'], 'de ouder eerst, ook als het kind eerder in de lijst staat');
  const [first, second] = plan.batches.map((b) => b.commands);
  assert.equal(first[0].type, 'project_add');
  assert.equal(first[0].args.name, 'Uit Todoist');
  assert.equal(first[1].args.parent_id, first[0].args.id);
  assert.equal(second[0].args.parent_id, first[1].args.id);
  assert.deepEqual(first.slice(2, 3).map((c) => c.type), ['section_add']);
  const tasks = first.filter((c) => c.type === 'task_add');
  assert.equal(tasks.length, 401);
  assert.ok(tasks.every((c) => isValidKey(c.args.order_key) && c.args.order_key.length <= 64));
  const keys = tasks.slice(0, 400).map((c) => c.args.order_key);
  assert.deepEqual([...keys].sort(), keys, 'oplopend');
  assert.equal(tasks[400].args.parent_id, tasks[399].args.id);
  assert.equal(tasks[400].args.section_id, undefined, 'een subtaak volgt de sectie van haar ouder');
  const note = first.at(-1);
  assert.deepEqual([note.type, note.args.task_id, note.args.content], ['comment_add', tasks[400].args.id, 'Bij Sub']);
  assert.deepEqual(plan.rootIds, [first[0].args.id], 'ongedaan maken: alleen "Uit Todoist" (de rest gaat mee)');
  assert.equal(plan.counts.projects, 3);
  assert.equal(plan.counts.tasks, 402);
  assert.equal(plan.counts.comments, 1);
});

test('het plan: los bovenaan, een Inbox krijgt een eigen naam, een kind zonder gekozen ouder komt bovenaan', () => {
  const inbox = one(csv(HEADER, 'task,Iets'), 'Inbox.csv');
  const werk = one(csv(HEADER, 'task,Werk'), 'Werk.csv');
  const klant = one(csv(HEADER, 'task,Klant'), 'Werk - Klant.csv');
  nestByName([inbox, werk, klant]);
  const plan = planFor([inbox, werk, klant], emptyView(), { selected: new Set([inbox.key, klant.key]) });
  const adds = plan.batches.map((b) => b.commands.find((c) => c.type === 'project_add').args);
  assert.deepEqual(adds.map((a) => [a.name, a.parent_id ?? null]), [['Inbox uit Todoist', null], ['Klant', null]]);
  assert.deepEqual(plan.rootIds, adds.map((a) => a.id));
  assert.deepEqual(selectedProjects([inbox, werk, klant], new Set([werk.key, klant.key])).map((x) => [x.project.name, x.parentKey]), [['Werk', null], ['Klant', werk.key]]);
  const under = planFor([inbox], emptyView(), { under: 'Uit Todoist' });
  assert.equal(under.batches[0].commands[1].args.name, 'Inbox', 'onder "Uit Todoist" mag het gewoon Inbox heten');
});

test('grenzen vooraf: projecten, secties en taken per project, taken per gebruiker, labels', () => {
  const view = emptyView();
  for (let i = 0; i < APPLY_LIMITS.projectsPerUser - 1; i++) view.members.set(`m${i}`, { id: `m${i}`, user_id: 'u1', role: 'owner' });
  const small = one(csv(HEADER, 'task,Een'), 'Een.csv');
  assert.equal(importQuotaProblem(view, 'u1', planFor([small], view)), null, 'precies passend');
  assert.deepEqual(importQuotaProblem(view, 'u1', planFor([small], view, { under: 'Uit Todoist' })), { code: 'projects', limit: 500, have: 499, need: 2 });
  const sections = one(csv(HEADER, ...Array.from({ length: 201 }, (_, i) => `section,S${i}`), 'task,x'), 'Veel.csv');
  assert.deepEqual(importQuotaProblem(emptyView(), 'u1', planFor([sections])), { code: 'sections', limit: 200, have: 0, need: 201, project: 'Veel' });
  const tasks = one(csv(HEADER, ...Array.from({ length: APPLY_LIMITS.tasksPerProject + 1 }, (_, i) => `task,T${i}`)), 'Groot.csv');
  assert.equal(importQuotaProblem(emptyView(), 'u1', planFor([tasks])).code, 'tasksPerProject');
  const busy = emptyView();
  for (let i = 0; i < APPLY_LIMITS.tasksPerUser; i++) busy.tasks.set(`t${i}`, { id: `t${i}`, creator_id: 'u1' });
  assert.deepEqual(importQuotaProblem(busy, 'u1', planFor([small], busy)), { code: 'tasksPerUser', limit: 50000, have: 50000, need: 1 });
  const labelled = emptyView();
  for (let i = 0; i < APPLY_LIMITS.labelsPerUser; i++) labelled.labels.set(`l${i}`, { id: `l${i}`, name: `label${i}`, owner_id: 'u1' });
  const withLabel = one(csv(HEADER, 'task,Iets @gloednieuw'), 'L.csv');
  assert.equal(importQuotaProblem(labelled, 'u1', planFor([withLabel], labelled)).code, 'labels');
  const reuse = one(csv(HEADER, 'task,Iets @LABEL3'), 'L.csv');
  assert.equal(importQuotaProblem(labelled, 'u1', planFor([reuse], labelled)), null, 'een bestaand label kost niets');
});

// ---------- een realistische back-up, op een echte server ----------

let counter = 0;
function makeClient(db = mkdb()) {
  let clock = Date.parse('2026-11-14T09:00:00Z');
  const store = new Store(new MemoryAdapter(), { now: () => new Date((clock += 1000)).toISOString(), onPersistError: () => {} });
  const errors = [];
  const sync = new SyncClient({
    store, transport: async (body) => JSON.parse(JSON.stringify(handleSync(db, JSON.parse(JSON.stringify(body)), firstUser(db).id))),
    onCommandErrors: (e) => errors.push(...e),
  });
  const actions = createActions(store, { makeId: () => `id${String(++counter).padStart(10, '0')}`, makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}` });
  return { db, store, sync, actions, errors };
}

test('een back-up van Todoist: wat er meekomt, wat niet, en de mappen', async () => {
  const r = await readImport([{ name: 'todoist-backup.zip', bytes: await sampleBackup() }], { now: NOW });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ['type', 'unsafe']);
  assert.deepEqual(r.projects.map((p) => p.name), ['Inbox', 'Huishouden', 'Werk', 'Klanten', 'Boodschappen - Markt']);
  const [inbox, huis, werk, klanten] = r.projects;
  assert.equal(klanten.parentKey, werk.key);
  assert.equal(huis.viewStyle, 'board');
  const [dentist, plants, rent, taxes, flights] = inbox.tasks;
  assert.deepEqual([dentist.content, dentist.labels, dentist.priority, dentist.due, dentist.duration], ['Call the dentist', ['phone'], 1, { date: '2026-11-15T09:00' }, 15]);
  assert.deepEqual(plants.due, { date: '2026-11-16', string: 'elke maandag', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [1] } });
  assert.equal(rent.description, 'Transfer before the 1st, "urgent"');
  assert.deepEqual(rent.due.recurrence, { freq: 'monthly', bymonthday: 1 });
  assert.equal(taxes.due, null);
  assert.equal(taxes.deadline, '2027-01-12');
  assert.equal(taxes.description, 'Datum uit Todoist: every 3rd workday');
  assert.deepEqual(taxes.comments, ['See the photo [Bijlage: receipt.jpg]']);
  assert.deepEqual([flights.due, flights.duration], [{ date: '2027-01-12' }, 2880]);
  assert.deepEqual(inbox.stats, { tasks: 5, sections: 0, comments: 1, labels: ['phone', 'money'], dates: 1, deadlines: 0, durations: 0, attachments: 1, truncated: 0, flattened: 0, skippedRows: 0, commentsDropped: 0, completed: 0 });
  assert.deepEqual(inbox.people, { authors: ['Sam'], responsible: ['Kim'] });
  assert.deepEqual(huis.tasks[0].due.recurrence, { freq: 'monthly', byweekday: [2], nth: 2 });
  assert.deepEqual(huis.sections.map((s) => s.name), ['Keuken', 'Tuin']);
  const koelkast = huis.sections[0].tasks[0];
  assert.deepEqual([koelkast.content, koelkast.labels, koelkast.due, koelkast.duration], ['Koelkast schoonmaken', ['schoonmaak'], { date: '2026-11-14' }, 45]);
  assert.equal(koelkast.subtasks[0].subtasks[0].content, 'Lampje vervangen');
  assert.deepEqual(koelkast.subtasks[0].subtasks[0].comments, ['Het lampje is een E14']);
  assert.equal(huis.sections[1].tasks[0].deadline, '2026-12-24');
  assert.deepEqual(werk.tasks[0].due, { date: '2026-11-20T16:00', string: 'elke vrijdag om 16:00', lang: 'nl', recurrence: { freq: 'weekly', byweekday: [5] } });
});

test('een back-up van Todoist importeren op een echte server: alles komt aan, lokaal gelijk, en ongedaan maken haalt het weg', async () => {
  const c = makeClient();
  await c.store.init();
  await c.sync.syncNow();
  // een bestaand label met een andere schrijfwijze wordt hergebruikt
  await c.actions.addLabel('Schoonmaak');
  await c.sync.syncNow();
  const r = await readImport([{ name: 'todoist-backup.zip', bytes: await sampleBackup() }], { now: NOW });
  const progress = [];
  const res = await c.actions.importProjects(r.projects, { selected: new Set(r.projects.map((p) => p.key)), under: 'Uit Todoist', inboxName: 'Inbox uit Todoist' }, (done, total, name) => progress.push(`${done}/${total} ${name}`));
  assert.equal(res.ok, true);
  assert.deepEqual(progress, ['1/5 Inbox', '2/5 Huishouden', '3/5 Werk', '4/5 Klanten', '5/5 Boodschappen - Markt']);
  assert.equal(c.store.queueLength > 0, true, 'eerst alleen in de wachtrij (offline-first)');
  const umbrella = res.rootIds[0];
  assert.equal(c.store.view.projects.get(umbrella).name, 'Uit Todoist', 'meteen lokaal te zien');
  await c.sync.syncNow();
  assert.deepEqual(c.errors, []);
  assert.equal(c.store.queueLength, 0);
  const server = handleSync(c.db, { sync_token: '*' }, firstUser(c.db).id);
  const live = (rows) => rows.filter((x) => !x.is_deleted);
  const projects = live(server.projects);
  const byName = (name) => projects.find((p) => p.name === name && !p.id.startsWith('inbox-'));
  assert.equal(byName('Inbox').parent_id, umbrella, 'de Inbox uit Todoist, naast de eigen Inbox');
  assert.equal(byName('Klanten').parent_id, byName('Werk').id);
  assert.equal(byName('Huishouden').view_style, 'board');
  const tasks = live(server.tasks);
  assert.equal(tasks.length, 5 + 5 + 1 + 1 + 1);
  const task = (content) => tasks.find((x) => x.content === content);
  assert.equal(task('Call the dentist').priority, 1);
  assert.equal(task('Call the dentist').due.date, '2026-11-15T09:00');
  assert.equal(task('File taxes').deadline, '2027-01-12');
  assert.equal(task('Lampje vervangen').parent_id, task('Planken uitnemen').id);
  const labels = live(server.labels);
  assert.deepEqual(labels.map((l) => l.name).sort(), ['money', 'phone', 'Schoonmaak'].sort(), 'Schoonmaak hergebruikt, niet dubbel');
  assert.deepEqual(task('Heg snoeien').labels, [labels.find((l) => l.name === 'Schoonmaak').id]);
  const comments = live(server.comments);
  assert.deepEqual(comments.map((x) => x.content).sort(), ['Het lampje is een E14', 'See the photo [Bijlage: receipt.jpg]']);
  // lokaal precies gelijk aan de server
  for (const x of tasks) assert.deepEqual(c.store.view.tasks.get(x.id)?.due ?? null, x.due ?? null, x.content);
  // ongedaan maken: "Uit Todoist" en alles eronder weg; het nieuwe label blijft
  await res.undo();
  await c.sync.syncNow();
  const after = handleSync(c.db, { sync_token: '*' }, firstUser(c.db).id);
  assert.deepEqual(live(after.projects).map((p) => p.name), ['Inbox'], 'alleen de eigen Inbox blijft');
  assert.equal(live(after.tasks).length, 0);
  assert.equal(live(after.labels).length, 3);
  assert.deepEqual(c.errors, []);
});

test('importeren boven de grenzen: er wordt niets in de wachtrij gezet', async () => {
  const c = makeClient();
  await c.store.init();
  await c.sync.syncNow();
  const big = one(csv(HEADER, ...Array.from({ length: 201 }, (_, i) => `section,S${i}`), 'task,x'), 'Veel.csv');
  const before = c.store.queueLength;
  const res = await c.actions.importProjects([big], { selected: new Set([big.key]), under: null });
  assert.deepEqual(res, { ok: false, problem: { code: 'sections', limit: 200, have: 0, need: 201, project: 'Veel' } });
  assert.equal(c.store.queueLength, before);
});
