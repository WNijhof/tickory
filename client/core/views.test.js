// Tests voor quick-add, de overzichten en de datumnotatie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INBOX_ID } from '../../shared/schema.js';
import { emptyState } from './reducer.js';
import { parseQuickAdd } from './quickadd.js';
import { counts, projectList, projectView, todayView, upcomingView } from './selectors.js';
import { addDays, daysBetween, dueStatus, formatDate, formatDateInput, formatDayHeading, formatDue, formatDueLong, todayString } from './format.js';
import { parseDateText } from './dateNl.js';

const NU = new Date(2026, 10, 11, 9, 0, 0); // woensdag 11 november 2026
const TODAY = '2026-11-11';

function sampleView() {
  const v = emptyState();
  const put = (res, row) => v[res].set(row.id, { is_archived: false, checked: false, labels: [], due: null, parent_id: null, section_id: null, priority: 4, ...row });
  put('projects', { id: INBOX_ID, name: 'Inbox', order_key: 'V' });
  put('projects', { id: 'p-thuis', name: 'Thuis', order_key: 'k' });
  put('projects', { id: 'p-klussen', name: 'Thuis klussen', order_key: 'd' });
  put('projects', { id: 'p-sub', name: 'Tuin', order_key: 'V', parent_id: 'p-thuis' });
  put('projects', { id: 'p-oud', name: 'Oud', order_key: 'z', is_archived: true });
  put('sections', { id: 's-keuken', project_id: 'p-thuis', name: 'Keuken', order_key: 'V' });
  put('sections', { id: 's-bad', project_id: 'p-thuis', name: 'Badkamer', order_key: 'k' });
  put('labels', { id: 'l-bellen', name: 'bellen', order_key: 'V' });
  return { v, put };
}
const ctx = (v, extra = {}) => ({ view: v, now: NU, defaultProjectId: INBOX_ID, ...extra });

// ---------- quick-add ----------

test('quick-add: alles in één regel', () => {
  const { v } = sampleView();
  const r = parseQuickAdd('Tandarts bellen morgen om 9 uur #Thuis /Keuken @bellen @spoed p1', ctx(v));
  assert.deepEqual(r, {
    content: 'Tandarts bellen', project_id: 'p-thuis', section_id: 's-keuken', labels: ['l-bellen'], newLabels: ['spoed'],
    priority: 1, due: { date: '2026-11-12T09:00', string: 'morgen om 9 uur', lang: 'nl' }, deadline: null, reminders: [],
  });
});

test('quick-add: zonder tekens blijft het een gewone taak in het standaardproject', () => {
  const { v } = sampleView();
  assert.deepEqual(parseQuickAdd('  Melk   halen ', ctx(v)), {
    content: 'Melk halen', project_id: INBOX_ID, section_id: null, labels: [], newLabels: [], priority: 4, due: null, deadline: null, reminders: [],
  });
});

test('quick-add: de langste projectnaam wint, hoofdletters doen er niet toe', () => {
  const { v } = sampleView();
  assert.equal(parseQuickAdd('Plint zagen #thuis klussen', ctx(v)).project_id, 'p-klussen');
  const r = parseQuickAdd('Plint zagen #Thuis vandaag', ctx(v));
  assert.equal(r.project_id, 'p-thuis');
  assert.equal(r.content, 'Plint zagen');
  assert.equal(r.due.date, TODAY);
});

test('quick-add: onbekend project, gearchiveerd project en tekens midden in een woord blijven gewone tekst', () => {
  const { v } = sampleView();
  assert.equal(parseQuickAdd('Iets #Onbekend doen', ctx(v)).content, 'Iets #Onbekend doen');
  assert.equal(parseQuickAdd('Iets #Oud doen', ctx(v)).project_id, INBOX_ID);
  const r = parseQuickAdd('Mail jan@voorbeeld.nl over en/of C#Thuis', ctx(v));
  assert.equal(r.content, 'Mail jan@voorbeeld.nl over en/of C#Thuis');
  assert.deepEqual([r.labels, r.newLabels, r.project_id], [[], [], INBOX_ID]);
  assert.equal(parseQuickAdd('Versie p10 testen', ctx(v)).priority, 4);
  assert.equal(parseQuickAdd('Stap1 p2', ctx(v)).priority, 2);
});

test('quick-add: sectie alleen binnen het gekozen project; standaardsectie vervalt bij een ander project', () => {
  const { v } = sampleView();
  assert.equal(parseQuickAdd('Kraan /Badkamer', ctx(v, { defaultProjectId: 'p-thuis' })).section_id, 's-bad');
  assert.equal(parseQuickAdd('Kraan /Badkamer', ctx(v)).section_id, null, 'de Inbox heeft die sectie niet');
  assert.equal(parseQuickAdd('Kraan /Badkamer', ctx(v)).content, 'Kraan /Badkamer');
  const moved = parseQuickAdd('Kraan #Inbox', ctx(v, { defaultProjectId: 'p-thuis', defaultSectionId: 's-keuken' }));
  assert.deepEqual([moved.project_id, moved.section_id], [INBOX_ID, null]);
  const kept = parseQuickAdd('Kraan', ctx(v, { defaultProjectId: 'p-thuis', defaultSectionId: 's-keuken' }));
  assert.equal(kept.section_id, 's-keuken');
});

test('quick-add: prioriteit met !!, deadline tussen accolades, herhaling', () => {
  const { v } = sampleView();
  const r = parseQuickAdd('Aangifte doen !!2 {31-12} elke maand', ctx(v));
  assert.equal(r.content, 'Aangifte doen');
  assert.equal(r.priority, 2);
  assert.equal(r.deadline, '2026-12-31');
  assert.deepEqual(r.due.recurrence, { freq: 'monthly', bymonthday: 11 });
  const geen = parseQuickAdd('Config {debug: true} nalopen', ctx(v));
  assert.equal(geen.deadline, null);
  assert.equal(geen.content, 'Config {debug: true} nalopen', 'accolades zonder datum blijven staan');
});

test('quick-add: standaarddatum (overzicht Vandaag) geldt tenzij er zelf een datum staat', () => {
  const { v } = sampleView();
  const d = { date: TODAY, string: 'vandaag', lang: 'nl' };
  assert.deepEqual(parseQuickAdd('Afwas', ctx(v, { defaultDue: d })).due, d);
  assert.equal(parseQuickAdd('Afwas morgen', ctx(v, { defaultDue: d })).due.date, '2026-11-12');
});

test('quick-add: Nederlandse namen met accenten, hoofdletters en de ontleedde schrijfwijze', () => {
  const { v, put } = sampleView();
  put('projects', { id: 'p-cafe', name: 'Café', order_key: 'n' });
  put('projects', { id: 'p-ijs', name: 'IJsselmeer', order_key: 'o' });
  put('labels', { id: 'l-een', name: 'één', order_key: 'k' });
  put('labels', { id: 'l-zoe', name: 'Zoë', order_key: 'n' });
  const ontleed = (s) => s.normalize('NFD'); // zoals sommige toetsenborden het opleveren
  assert.notEqual(ontleed('café'), 'café');

  assert.equal(parseQuickAdd('Taart halen #CAFÉ', ctx(v)).project_id, 'p-cafe');
  assert.equal(parseQuickAdd(`Taart halen #${ontleed('café')}`, ctx(v)).project_id, 'p-cafe');
  assert.equal(parseQuickAdd('Zeilen #ijsselmeer', ctx(v)).project_id, 'p-ijs');
  assert.equal(parseQuickAdd('Zeilen #IJSSELMEER', ctx(v)).project_id, 'p-ijs');
  assert.deepEqual(parseQuickAdd('Appels kopen @ÉÉN', ctx(v)).labels, ['l-een']);
  assert.deepEqual(parseQuickAdd('Appels kopen @één', ctx(v)).labels, ['l-een']);
  assert.deepEqual(parseQuickAdd(`Appels kopen @${ontleed('zoë')}`, ctx(v)).labels, ['l-zoe']);

  // een nieuw label in verschillende schrijfwijzen is één label
  const r = parseQuickAdd('Iets doen @Ömer @ömer @ÖMER', ctx(v));
  assert.deepEqual(r.newLabels, ['Ömer']);
  assert.deepEqual(r.labels, []);

  // de titel komt altijd in NFC uit
  const t = parseQuickAdd(`${ontleed('Café')} bezoeken`, ctx(v));
  assert.equal(t.content, 'Café bezoeken');
  assert.equal(t.content.length, 'Café bezoeken'.length);
});

test('quick-add: datum, project en "IJ" in één regel', () => {
  const { v } = sampleView();
  const r = parseQuickAdd('Morgen ijs kopen #Thuis p2', ctx(v));
  assert.equal(r.content, 'IJs kopen');
  assert.equal(r.project_id, 'p-thuis');
  assert.equal(r.priority, 2);
  assert.equal(r.due.date, '2026-11-12');
});

test('quick-add: Nederlandse datums zonder voorzetsel, herhalingen en feestdagen', () => {
  const { v } = sampleView();
  const a = parseQuickAdd('Kerstdiner reserveren 25 december #Thuis', ctx(v));
  assert.deepEqual([a.content, a.due.date, a.project_id], ['Kerstdiner reserveren', '2026-12-25', 'p-thuis']);
  const b = parseQuickAdd('Oud papier elke tweede dinsdag @bellen', ctx(v));
  assert.equal(b.content, 'Oud papier');
  assert.deepEqual(b.due.recurrence, { freq: 'monthly', byweekday: [2], nth: 2 });
  assert.deepEqual(b.labels, ['l-bellen']);
  const c = parseQuickAdd('Cadeau kopen voor Sinterklaas {4 december}', ctx(v));
  assert.equal(c.content, 'Cadeau kopen');
  assert.equal(c.due.date, '2026-12-05');
  assert.equal(c.deadline, '2026-12-04');
  const d = parseQuickAdd('Eind januari belasting regelen p1', ctx(v));
  assert.deepEqual([d.content, d.due.date, d.priority], ['Belasting regelen', '2027-01-31', 1]);
});

test('quick-add: alleen tekens zonder titel levert een lege titel (de app weigert die)', () => {
  const { v } = sampleView();
  assert.equal(parseQuickAdd('#Thuis p1 @bellen', ctx(v)).content, '');
});

// ---------- overzichten ----------

test('projectlijst: Inbox eerst, dan op volgorde, subprojecten ingesprongen, archief verborgen', () => {
  const { v } = sampleView();
  assert.deepEqual(projectList(v).map((x) => [x.project.name, x.depth]), [['Inbox', 0], ['Thuis klussen', 0], ['Thuis', 0], ['Tuin', 1]]);
});

test('projectoverzicht: secties op volgorde, subtaken onder hun taak, voltooid verborgen tenzij gevraagd', () => {
  const { v, put } = sampleView();
  put('tasks', { id: 't1', project_id: 'p-thuis', content: 'Los', order_key: 'V' });
  put('tasks', { id: 't2', project_id: 'p-thuis', section_id: 's-keuken', content: 'Oven', order_key: 'k' });
  put('tasks', { id: 't3', project_id: 'p-thuis', section_id: 's-keuken', content: 'Afwas', order_key: 'V' });
  put('tasks', { id: 't4', project_id: 'p-thuis', section_id: 's-keuken', parent_id: 't2', content: 'Rooster', order_key: 'V' });
  put('tasks', { id: 't5', project_id: 'p-thuis', section_id: 's-keuken', content: 'Klaar', order_key: 'z', checked: true });
  put('tasks', { id: 't6', project_id: 'p-thuis', section_id: 's-weg', content: 'Wees', order_key: 'a' });
  const pv = projectView(v, 'p-thuis');
  assert.deepEqual(pv.groups.map((g) => [g.section?.name ?? null, g.tasks.map((x) => `${'  '.repeat(x.depth)}${x.task.content}`)]), [
    [null, ['Los', 'Wees']],
    ['Keuken', ['Afwas', 'Oven', '  Rooster']],
    ['Badkamer', []],
  ]);
  assert.equal(pv.completedCount, 1);
  assert.ok(projectView(v, 'p-thuis', { showCompleted: true }).groups[1].tasks.some((x) => x.task.content === 'Klaar'));
  assert.equal(projectView(v, 'bestaat-niet'), null);
});

test('vandaag en binnenkort: te laat apart, gesorteerd op tijd en prioriteit, voltooid telt niet mee', () => {
  const { v, put } = sampleView();
  put('tasks', { id: 'a', project_id: INBOX_ID, content: 'Gisteren', order_key: 'V', due: { date: '2026-11-10' } });
  put('tasks', { id: 'b', project_id: INBOX_ID, content: 'Vandaag laag', order_key: 'V', due: { date: TODAY } });
  put('tasks', { id: 'c', project_id: INBOX_ID, content: 'Vandaag hoog', order_key: 'k', due: { date: TODAY }, priority: 1 });
  put('tasks', { id: 'd', project_id: INBOX_ID, content: 'Vandaag 14:00', order_key: 'a', due: { date: `${TODAY}T14:00` } });
  put('tasks', { id: 'e', project_id: INBOX_ID, content: 'Morgen', order_key: 'V', due: { date: '2026-11-12' } });
  put('tasks', { id: 'f', project_id: INBOX_ID, content: 'Klaar', order_key: 'V', due: { date: TODAY }, checked: true });
  put('tasks', { id: 'g', project_id: INBOX_ID, content: 'Zonder datum', order_key: 'V' });
  put('tasks', { id: 'h', project_id: 'p-thuis', content: 'Ver weg', order_key: 'V', due: { date: '2027-03-01' } });
  const t = todayView(v, TODAY);
  assert.deepEqual(t.overdue.map((x) => x.content), ['Gisteren']);
  assert.deepEqual(t.today.map((x) => x.content), ['Vandaag hoog', 'Vandaag laag', 'Vandaag 14:00']);
  assert.deepEqual(upcomingView(v, TODAY).map((d) => [d.date, d.tasks.map((x) => x.content)]), [['2026-11-12', ['Morgen']]]);
  const n = counts(v, TODAY);
  assert.equal(n.today, 4);
  assert.equal(n.perProject.get(INBOX_ID), 6);
  assert.equal(n.perProject.get('p-thuis'), 1);
});

// ---------- datumnotatie ----------

test('datumnotatie in het Nederlands', () => {
  assert.equal(todayString(NU), TODAY);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-29', 1), '2026-03-30', 'geen last van de zomertijd');
  assert.equal(daysBetween(TODAY, '2026-11-18'), 7);
  assert.equal(formatDate(TODAY, TODAY), 'vandaag');
  assert.equal(formatDate('2026-11-12', TODAY), 'morgen');
  assert.equal(formatDate('2026-11-10', TODAY), 'gisteren');
  assert.equal(formatDate('2026-11-13', TODAY), 'vrijdag');
  assert.equal(formatDate('2026-11-17', TODAY), 'dinsdag');
  assert.equal(formatDate('2026-11-18', TODAY), 'wo 18 nov');
  assert.equal(formatDate('2026-11-03', TODAY), 'di 3 nov');
  assert.equal(formatDate('2027-03-01', TODAY), '1 mrt 2027');
  assert.equal(formatDue({ date: '2026-11-12T09:00' }, TODAY), 'morgen 09:00');
  assert.equal(formatDue({ date: '2026-11-13', recurrence: { freq: 'weekly' } }, TODAY), '↻ vrijdag');
  assert.equal(formatDue(null, TODAY), '');
  assert.equal(formatDayHeading(TODAY, TODAY), 'Vandaag · wo 11 nov');
  assert.equal(formatDayHeading('2026-11-12', TODAY), 'Morgen · do 12 nov');
  assert.equal(formatDayHeading('2026-11-14', TODAY), 'Zaterdag · 14 nov');
});

test('volledige datum voor bevestiging: weekdag, dag en maand, jaar alleen als het een ander jaar is', () => {
  assert.equal(formatDueLong({ date: '2026-11-19' }, TODAY), 'do 19 nov');
  assert.equal(formatDueLong({ date: '2026-11-12T09:00' }, TODAY), 'do 12 nov 09:00');
  assert.equal(formatDueLong({ date: '2027-01-01T14:30' }, TODAY), 'vr 1 jan 2027 14:30');
  assert.equal(formatDueLong({ date: '2026-11-13', recurrence: { freq: 'weekly' } }, TODAY), '↻ vr 13 nov');
  assert.equal(formatDueLong(null, TODAY), '');
  assert.equal(formatDueLong(parseDateText('volgende week donderdag', NU), TODAY), 'do 19 nov', 'ondubbelzinnig, ook al staat er "donderdag" in de tekst');
});

test('datum in een invoerveld: de getoonde tekst leest terug als dezelfde datum', () => {
  for (const date of ['2026-11-12', '2026-11-12T09:00', '2027-01-05T14:30', '2026-12-31']) {
    const text = formatDateInput({ date, string: 'morgen', lang: 'nl' });
    assert.equal(parseDateText(text, NU)?.date, date, `"${text}" moet teruglezen als ${date}`);
  }
  assert.equal(formatDateInput({ date: '2026-11-12T09:00' }), '12-11-2026 om 09:00');
  assert.equal(formatDateInput({ date: '2026-11-13', string: 'elke vrijdag', recurrence: { freq: 'weekly', byweekday: [5] } }), 'elke vrijdag');
  assert.equal(formatDateInput(null), '');
});

test('te laat: zonder tijd pas de volgende dag, met tijd zodra het tijdstip voorbij is', () => {
  assert.equal(dueStatus(null, TODAY), 'none');
  assert.equal(dueStatus({ date: '2026-11-10' }, TODAY), 'overdue');
  assert.equal(dueStatus({ date: TODAY }, TODAY, `${TODAY}T23:00`), 'today');
  assert.equal(dueStatus({ date: `${TODAY}T08:00` }, TODAY, `${TODAY}T09:00`), 'overdue');
  assert.equal(dueStatus({ date: `${TODAY}T10:00` }, TODAY, `${TODAY}T09:00`), 'today');
  assert.equal(dueStatus({ date: '2026-11-12' }, TODAY), 'future');
});
