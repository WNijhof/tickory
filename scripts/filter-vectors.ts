// Testgevallen voor de filtertaal van de Android-app (android/.../core/FilterLang.kt): dezelfde zoekopdrachten op dezelfde taken,
// uitgerekend door de filtertaal van de web-app (client/core/filter.js) zonder datums in gewone taal (`naturalDates: false`, die
// kent de widget niet). De Kotlin-test (FilterLangVectorsTest) moet precies dezelfde taken, lijsten en fouten geven.
//
//   node scripts/filter-vectors.ts        schrijft android/app/src/test/resources/filter-vectors.json
//
// client/core/filterVectors.test.js controleert dat dat bestand bij de huidige filtertaal hoort.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateFilter } from '../client/core/filter.js';

export const VECTORS_PATH = fileURLToPath(new URL('../android/app/src/test/resources/filter-vectors.json', import.meta.url));
export const ZONE = 'Europe/Amsterdam';

const ME = 'user-anna-0001';

/** De gegevens, in de vorm van een sync-antwoord (zo leest de Android-app ze ook). */
const BODY = {
  me: { id: ME, inbox_project_id: 'inbox-anna' },
  users: [
    { id: ME, username: 'anna', name: 'Anna de Vries' },
    { id: 'user-bram-0002', username: 'bram', name: 'Bram Jansen' },
    { id: 'user-bram-0003', username: 'brambakker', name: 'Bram Bakker' },
    { id: 'user-cem-00004', username: 'cem', name: 'Cém Öztürk' },
  ],
  projects: [
    { id: 'inbox-anna', name: 'Inbox', parent_id: null, is_archived: false, order_key: 'a0' },
    { id: 'p-werk', name: 'Werk', parent_id: null, is_archived: false, order_key: 'a1' },
    { id: 'p-klanten', name: 'Klanten', parent_id: 'p-werk', is_archived: false, order_key: 'a0' },
    { id: 'p-groot', name: 'Grote klant', parent_id: 'p-klanten', is_archived: false, order_key: 'a0' },
    { id: 'p-thuis', name: 'Thuis', parent_id: null, is_archived: false, order_key: 'a2' },
    { id: 'p-prive', name: 'Werk & privé', parent_id: null, is_archived: false, order_key: 'a3' },
    { id: 'p-cafe-accent', name: 'Café', parent_id: null, is_archived: false, order_key: 'a4' },
    { id: 'p-cafe-plain', name: 'Cafe', parent_id: null, is_archived: false, order_key: 'a5' },
    { id: 'p-archief', name: 'Archief', parent_id: null, is_archived: true, order_key: 'a6' },
    { id: 'p-gedeeld', name: 'Gedeeld  met   Bram', parent_id: null, is_archived: false, order_key: 'a7' },
  ],
  sections: [
    { id: 's-werk-bellen', project_id: 'p-werk', name: 'Bellen', is_archived: false, order_key: 'a0' },
    { id: 's-werk-later', project_id: 'p-werk', name: 'Later', is_archived: false, order_key: 'a1' },
    { id: 's-thuis-bellen', project_id: 'p-thuis', name: 'bellen', is_archived: false, order_key: 'a0' },
    { id: 's-oud', project_id: 'p-thuis', name: 'Oud', is_archived: true, order_key: 'a1' },
  ],
  labels: [
    { id: 'l-bellen', name: 'bellen' },
    { id: 'l-email', name: 'e-mail' },
    { id: 'l-cafe', name: 'café' },
    { id: 'l-werk', name: 'Werk' },
    { id: 'l-spatie', name: 'heel  dringend' },
  ],
  filters: [
    { id: 'f-belangrijk', name: 'Belangrijk', query: 'p1 | p2', order_key: 'a0' },
    { id: 'f-weg', name: 'Weg', query: 'vandaag', order_key: 'a1', is_deleted: true },
  ],
  reminders: [
    { id: 'r-1', task_id: 't-offerte', type: 'relative', minute_offset: 30, owner_id: ME },
    { id: 'r-2', task_id: 't-tandarts', type: 'absolute', due: { date: '2026-11-22T20:00' }, owner_id: ME },
    { id: 'r-3', task_id: 't-boodschap', type: 'location', place_id: 'pl-1', trigger: 'enter', owner_id: ME },
    { id: 'r-4', task_id: 't-jarig', type: 'relative', minute_offset: 15, owner_id: ME },
    { id: 'r-5', task_id: 't-kapot', type: 'absolute', due: { date: '2026-11-18T09:00' }, owner_id: ME, is_deleted: true },
    { id: 'r-6', task_id: 't-lezen', type: 'absolute', due: { date: '2026-11-17T22:00' }, owner_id: 'user-bram-0002' },
    { id: 'r-7', task_id: 't-fiets', type: 'absolute', due: { date: '2026-11-20' }, owner_id: ME },
    { id: 'r-8', task_id: 't-zonder', type: 'relative', minute_offset: 0, owner_id: null },
  ],
  tasks: [
    { id: 't-offerte', content: 'Offerte maken voor de klant', description: '', project_id: 'p-werk', section_id: null, parent_id: null, due: { date: '2026-11-17T14:00' }, deadline: '2026-11-20', priority: 1, labels: ['l-bellen'], assignee_id: ME, order_key: 'a0' },
    { id: 't-bellen', content: 'Klant bellen', description: 'Over de **offerte**', project_id: 'p-werk', section_id: 's-werk-bellen', parent_id: null, due: { date: '2026-11-17' }, priority: 2, labels: ['l-bellen', 'l-werk'], assignee_id: 'user-bram-0002', order_key: 'a1' },
    { id: 't-cafe', content: 'Café reserveren', description: null, project_id: 'p-thuis', section_id: null, parent_id: null, due: { date: '2026-11-16' }, priority: 3, labels: ['l-cafe'], order_key: 'a0' },
    { id: 't-rapport', content: 'Rapport', description: 'Kwartaalcijfers en de offerte voor Cém', project_id: 'p-klanten', section_id: null, parent_id: null, due: { date: '2026-11-17T08:00' }, priority: 4, labels: [], order_key: 'a0' },
    { id: 't-sub', content: 'Bijlage zoeken', project_id: 'p-werk', section_id: null, parent_id: 't-offerte', due: null, priority: 4, labels: [], order_key: 'a2' },
    { id: 't-review', content: 'Wekelijkse review', project_id: 'p-werk', section_id: null, parent_id: null, due: { date: '2026-11-20T16:00', recurrence: { freq: 'weekly', byweekday: [5] } }, priority: 2, labels: [], order_key: 'a3' },
    { id: 't-tandarts', content: 'Tandarts', project_id: 'p-thuis', section_id: null, parent_id: null, due: { date: '2026-11-23' }, priority: 4, labels: [], order_key: 'a1' },
    { id: 't-belasting', content: 'Belastingaangifte', project_id: 'inbox-anna', section_id: null, parent_id: null, due: { date: '2026-12-31' }, deadline: '2027-01-31', priority: 1, labels: [], order_key: 'a0' },
    { id: 't-boodschap', content: 'Boodschappen', project_id: 'inbox-anna', section_id: null, parent_id: null, due: null, priority: 4, labels: [], order_key: 'a1' },
    { id: 't-archief', content: 'Oud project opruimen', project_id: 'p-archief', section_id: null, parent_id: null, due: { date: '2026-11-17' }, priority: 1, labels: [], order_key: 'a0' },
    { id: 't-mail', content: 'Mail sturen', project_id: 'p-werk', section_id: 's-werk-later', parent_id: null, due: { date: '2026-11-10' }, priority: 3, labels: ['l-email'], assignee_id: 'user-cem-00004', order_key: 'a4' },
    { id: 't-jarig', content: 'Verjaardag Jan', project_id: 'p-thuis', section_id: null, parent_id: null, due: { date: '2026-11-18' }, priority: 2, labels: [], order_key: 'a2' },
    { id: 't-nieuwjaar', content: 'Nieuwjaarsborrel', project_id: 'p-thuis', section_id: null, parent_id: null, due: { date: '2027-01-01' }, priority: 4, labels: [], order_key: 'a3' },
    { id: 't-fiets', content: 'Fiets maken', project_id: 'p-thuis', section_id: 's-thuis-bellen', parent_id: null, due: { date: '2026-11-21' }, priority: 3, labels: [], order_key: 'a4' },
    { id: 't-prive', content: 'Werk & privé scheiden', project_id: 'p-prive', section_id: null, parent_id: null, due: null, priority: 4, labels: ['l-spatie'], order_key: 'a0' },
    { id: 't-lezen', content: 'Lezen', project_id: 'inbox-anna', section_id: null, parent_id: null, due: { date: '2026-11-17T23:00' }, priority: 4, labels: [], order_key: 'a2' },
    { id: 't-kapot', content: 'Herinnering weg', project_id: 'inbox-anna', section_id: null, parent_id: null, due: { date: '2026-11-18' }, priority: 4, labels: [], order_key: 'a3' },
    { id: 't-af', content: 'Al gedaan', project_id: 'inbox-anna', section_id: null, parent_id: null, due: { date: '2026-11-17' }, priority: 1, labels: [], checked: true, order_key: 'a4' },
    { id: 't-weg', content: 'Verwijderd', project_id: 'inbox-anna', section_id: null, parent_id: null, due: { date: '2026-11-17' }, priority: 1, labels: [], is_deleted: true, order_key: 'a5' },
    { id: 't-schrikkel', content: 'Schrikkeldag', project_id: 'inbox-anna', section_id: null, parent_id: null, due: { date: '2028-02-29' }, priority: 4, labels: [], order_key: 'a6' },
    { id: 't-zomer', content: 'Klok verzetten', project_id: 'p-thuis', section_id: null, parent_id: null, due: { date: '2026-03-29T02:30' }, priority: 4, labels: [], order_key: 'a5' },
    { id: 't-uitroep', content: 'Fiets !belangrijk nakijken', project_id: 'p-thuis', section_id: null, parent_id: null, due: { date: '2026-11-19' }, priority: 4, labels: [], order_key: 'a6' },
    { id: 't-ijs', content: 'IJs kopen in het café', project_id: 'p-cafe-accent', section_id: null, parent_id: null, due: { date: '2026-11-19' }, priority: 4, labels: [], order_key: 'a0' },
    { id: 't-plain', content: 'Koffie zetten', project_id: 'p-cafe-plain', section_id: null, parent_id: null, due: { date: '2026-11-19' }, priority: 4, labels: [], order_key: 'a0' },
    { id: 't-groot', content: 'Contract tekenen', project_id: 'p-groot', section_id: null, parent_id: null, due: { date: '2026-11-24T09:30' }, priority: 1, labels: [], assignee_id: 'user-bram-0003', order_key: 'a0' },
    { id: 't-gelijk-a', content: 'Gelijk A', project_id: 'p-thuis', section_id: null, parent_id: null, due: { date: '2026-11-25' }, priority: 3, labels: [], order_key: 'b1' },
    { id: 't-gelijk-b', content: 'Gelijk B', project_id: 'p-werk', section_id: null, parent_id: null, due: { date: '2026-11-25' }, priority: 3, labels: [], order_key: 'b0' },
    { id: 't-gelijk-c', content: 'Gelijk C', project_id: 'p-werk', section_id: null, parent_id: null, due: { date: '2026-11-25' }, priority: 3, labels: [], order_key: 'b0' },
    { id: 't-ver', content: 'Pensioen regelen', project_id: 'inbox-anna', section_id: null, parent_id: null, due: { date: '2030-06-01' }, priority: 4, labels: [], order_key: 'a7' },
    { id: 't-zonder', content: 'Zonder eigenaar herinnerd', project_id: 'p-gedeeld', section_id: null, parent_id: null, due: { date: '2026-11-26T10:00' }, priority: 4, labels: [], assignee_id: 'user-bram-0002', order_key: 'a0' },
    { id: 't-oudsectie', content: 'In een oude sectie', project_id: 'p-thuis', section_id: 's-oud', parent_id: null, due: null, priority: 4, labels: [], order_key: 'a7' },
  ],
};

/** De momenten waarop elke zoekopdracht wordt uitgerekend (lokale tijd in ZONE). */
const NOWS = [
  ['dinsdagochtend', [2026, 11, 17, 9, 41]],
  ['zondagavond', [2026, 11, 22, 23, 30]],
  ['maandag na middernacht', [2026, 11, 23, 0, 10]],
  ['schrikkeljaar', [2028, 2, 28, 12, 0]],
  ['zomertijd', [2026, 3, 29, 3, 30]],
];

const deep = (n, inner) => '('.repeat(n) + inner + ')'.repeat(n);

/** De zoekopdrachten: alle termen, schrijfwijzen, operatoren, lijsten en fouten. */
const QUERIES = [
  // vaste termen, Nederlands en Engels
  'vandaag', 'today', 'VANDAAG', 'morgen', 'tomorrow', 'gisteren', 'yesterday', 'te laat', 'Te  Laat', 'overdue',
  'geen datum', 'zonder datum', 'no date', 'no due date', 'heeft tijd', 'has time', 'geen tijd', 'no time',
  'deze week', 'this week', 'volgende week', 'next week', 'vorige week', 'last week', 'terugkerend', 'herhalend', 'recurring',
  'deadline', 'heeft deadline', 'has deadline', 'geen deadline', 'no deadline', 'subtaak', 'subtask',
  'zonder label', 'zonder labels', 'geen label', 'geen labels', 'no label', 'no labels', 'niet toegewezen', 'unassigned',
  'toegewezen', 'assigned', 'heeft herinnering', 'has reminder', 'geen herinnering', 'no reminder', 'afgevinkt', 'completed',
  'alles', 'all', 'view all', 'Alles',
  // prioriteit
  'p1', 'p2', 'p3', 'p4', 'P1', 'p5', 'p0', 'p 1',
  // projecten, secties, labels
  '#Werk', '##Werk', '#werk', '#WERK', '#Klanten', '##Klanten', '#Grote klant', '#grote  KLANT', '#Café', '#Cafe', '#CAFÉ', '#cafè',
  '#Cafe\u0301', '#Inbox', '#Archief', '#Onbekend', '#', '##', '# Werk', '#"Werk & privé"', '#Werk \\& privé', '"#Werk & privé"',
  '#Werk & privé', '#Gedeeld met Bram', '#Werk: x',
  '/Bellen', '/bellen', '/Later', '/Oud', '/Onbekend', '/',
  '@bellen', '@Bellen', '@e-mail', '@cafe', '@café', '@CAFÉ', '@werk', '@heel dringend', '@"heel  dringend"', '@onbekend', '@',
  '@bellen\u00A0', 'p1\u3000|\u3000p2',
  // toegewezen
  'toegewezen aan mij', 'toegewezen aan: mij', 'Toegewezen aan: MIJ', 'assigned to: me', 'assigned to me', 'toegewezen aan anderen',
  'assigned to others', 'toegewezen aan: Bram', 'toegewezen aan Bram Jansen', 'assigned to: bram', 'toegewezen aan: brambakker',
  'toegewezen aan: cem', 'toegewezen aan: Cém Öztürk', 'toegewezen aan: Onbekend', 'toegewezen aan:', 'toegewezen aan',
  // datums in een vaste vorm
  '31-12', '31-12-2026', '31/12', '31.12', '2026-12-31', '31 december', '31 dec', '31 dec.', 'december 31', 'dec 31', '31 december 2026',
  '17-11', '17 nov', 'nov 17', 'november 17 2026', '1-1', '1-1-2027', '29-2', '29 februari', '31-2', '2026-02-30', '32-1', '17-11-26',
  '0-1', '1-13', '31-12-0050', '2026-1-5', '5 mrt', 'mar 5', '1 januari', '31 décembre', '31december', '31-dec',
  'overmorgen',
  // vóór en na
  'vóór: 31-12', 'voor: morgen', 'before: 2026-11-20', 'na: vandaag', 'after: 18-11', 'vóór:', 'na: gisteren', 'voor: 31-2',
  'na: donderdag', 'vóór 31-12', 'VÓÓR: overmorgen', 'na:17 nov', 'before: next week',
  // aantallen dagen
  '7 dagen', '7 days', 'volgende 7 dagen', 'next 7 days', '1 dag', '0 dagen', '-7 dagen', '-1 day', '-0 dagen', '36500 dagen',
  '36501 dagen', '1234567 dagen', '3 weken', 'volgende 3 dagen', '-36501 dagen',
  // zoeken
  'zoek: offerte', 'zoeken: offerte klant', 'search: OFFERTE', 'zoek: cafe', 'zoek: café', 'zoek: CAFE\u0301', 'zoek:', 'zoek:   ',
  'zoek: !belangrijk', 'zoek: a & b', 'zoek: "werk & privé"', 'zoek: offerte | p1', 'zoek: ijs', 'zoek: cem', 'zoek: **offerte**',
  'zoek: x: y', 'search:klant',
  // datums in gewone taal: de widget kent ze niet
  'donderdag', 'volgende week donderdag', 'eind januari', 'over 3 dagen', 'vandaag morgen', 'p1 vandaag', 'p1 p2 p3', 'vandaag "morgen"',
  // operatoren en haakjes
  'vandaag | te laat', 'p1 & vandaag', '(vandaag | te laat) & p1', '!p4', '!!p4', '!(p1 | p2)', 'p1 | p2 & vandaag', '!vandaag & !geen datum',
  '(p1', 'p1)', '()', '(', ')', '&', '|', '!', 'p1 &', '& p1', 'p1 | | p2', '((((p1))))', deep(40, 'p1'), deep(41, 'p1'), '(p1))',
  'p1 (p2)', '(p1) p2',
  // lijsten
  'Werk: #Werk, Thuis: #Thuis', '#Werk, #Thuis', 'vandaag, morgen', 'Vandaag: vandaag', 'p1, ', ', p1', '(p1, p2)', 'Naam: ',
  'zoek: x, Werk: #Werk', 'Mijn lijst: p1 | p2, Later: geen datum', 'Werk:#Werk', 'Te laat: te laat', 'p1,p1', 'p1, p1 | p2, alles',
  'toegewezen aan: Bram, toegewezen aan mij', '#Werk: dit, Thuis: #Thuis',
  // aanhalingstekens en backslashes
  '"vandaag', '#"Werk', '@"bellen"', '\\', 'p1\\', '"vandaag"', '"te laat"', 'te\\ laat', '\\#Werk', '"#Werk"',
  // leeg en te lang
  '', '   ', '\u3000', 'p1 | '.repeat(400) + 'p1', 'p'.repeat(2001),
];

const localMs = ([y, mo, d, h, mi]) => new Date(y, mo - 1, d, h, mi).getTime();
const pad = (n) => String(n).padStart(2, '0');
const localText = ([y, mo, d, h, mi]) => `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`;

function viewOf(body) {
  const map = (rows) => new Map(rows.map((r) => [r.id, r]));
  // zoals de widget: alleen open taken (afgevinkte en verwijderde bewaart de Android-app niet)
  return {
    tasks: map(body.tasks.filter((t) => !t.checked && !t.is_deleted)),
    projects: map(body.projects),
    sections: map(body.sections),
    labels: map(body.labels),
    reminders: map(body.reminders),
  };
}

function outcome(query, now) {
  const r = evaluateFilter(query, { view: viewOf(BODY), now: new Date(now), userId: ME, users: BODY.users, naturalDates: false });
  if (!r.ok) return { ok: false, code: r.error.code, position: r.error.position, length: r.error.length };
  return {
    ok: true,
    tasks: r.tasks.map((t) => t.id),
    groups: r.groups.map((g) => ({ name: g.name, tasks: g.tasks.map((t) => t.id) })),
    completed: r.includesCompleted,
  };
}

/** De inhoud van het bestand met testgevallen. */
export function buildVectors() {
  const before = process.env.TZ;
  process.env.TZ = ZONE;
  try {
    const nows = NOWS.map(([label, parts]) => ({ label, local: localText(parts), ms: localMs(parts) }));
    const cases = QUERIES.map((query) => ({ query, results: nows.map((n) => outcome(query, n.ms)) }));
    const lines = [
      '{',
      `"comment": ${JSON.stringify('Gemaakt door scripts/filter-vectors.ts uit de filtertaal van de web-app; niet met de hand aanpassen.')},`,
      `"zone": ${JSON.stringify(ZONE)},`,
      `"body": ${JSON.stringify(BODY)},`,
      `"nows": ${JSON.stringify(nows)},`,
      '"cases": [',
      cases.map((c) => JSON.stringify(c)).join(',\n'),
      ']',
      '}',
      '',
    ];
    return lines.join('\n');
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(VECTORS_PATH, buildVectors());
  console.log(`${QUERIES.length} zoekopdrachten × ${NOWS.length} momenten → ${VECTORS_PATH}`);
}
