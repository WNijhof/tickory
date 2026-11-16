// Lijst-UX in een echte browser, tegen de echte server: de keuze Sorteren (sorteren, richting, groeperen) bij een project, Vandaag en
// Aankomend; ze wordt bewaard in de instellingen op de server (view_options) en volgt een wijziging van een ander apparaat. Bij een eigen
// sortering of indeling is er niets om binnen de lijst te slepen. Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties komen via `c`.

import assert from 'node:assert/strict';
import { createSession } from '../server/users.ts';

export async function listsScenario(c: any) {
  const { evaluate, waitFor, step, shot, js, SYNCED, db, alice, syncAs, serverState, click, nav } = c;
  const token = createSession(db, alice.id, 'Controle lijsten').token;
  let k = 0;
  const as = async (commands: [string, object][]) => {
    const res = await syncAs(token, 'e2e-lijsten', commands.map(([type, args]) => ({ type, uuid: `e2e-lijst-${String(++k).padStart(5, '0')}`, args })));
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const [uuid, s] of Object.entries(body.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
  };
  const settings = () => (serverState().settings as any[])[0];
  const titles = () => evaluate<string[]>(`[...document.querySelectorAll('#content .task .task-title')].map((e) => e.textContent)`);
  const heads = () => evaluate<string[]>(`[...document.querySelectorAll('#content .group-title')].map((e) => e.textContent)`);
  const startView = await evaluate<string>(`document.getElementById('view-title').textContent`);
  const today = await evaluate<string>(`(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`);
  const P = 'e2elijstproject1';

  await as([
    ['project_add', { id: P, name: 'Lijstproef' }],
    ['section_add', { id: 'e2elijstsectie01', project_id: P, name: 'Eerst' }],
    ['label_add', { id: 'e2elijstlabel001', name: 'proeflabel' }],
    ['task_add', { id: 'e2elijsttaak0001', project_id: P, content: 'Zebra', priority: 3 }],
    ['task_add', { id: 'e2elijsttaak0002', project_id: P, content: 'appel', priority: 1, labels: ['e2elijstlabel001'] }],
    ['task_add', { id: 'e2elijsttaak0003', project_id: P, content: 'Éclair', priority: 4 }],
    ['task_add', { id: 'e2elijsttaak0004', project_id: P, content: 'taak 10', priority: 1, section_id: 'e2elijstsectie01' }],
    ['task_add', { id: 'e2elijsttaak0005', project_id: P, content: 'Taak 2', priority: 2, section_id: 'e2elijstsectie01', due: { date: today } }],
  ]);
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await waitFor(`[...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Lijstproef')`, 'het project komt via de sync binnen', 15_000);
  await nav('Lijstproef');
  await waitFor(`document.getElementById('view-title').textContent === 'Lijstproef'`, 'het project');
  await waitFor(`document.querySelectorAll('#content .task').length === 5`, 'vijf taken');
  assert.deepEqual(await titles(), ['Zebra', 'appel', 'Éclair', 'taak 10', 'Taak 2'], 'de eigen volgorde, per sectie');
  assert.equal(await evaluate(`document.querySelectorAll('.group[data-drop-project]').length > 0`), true, 'slepen kan');
  assert.equal(await evaluate(`document.querySelector('[data-fk="list-options"]').classList.contains('active')`), false);

  // ---- sorteren op naam ----
  const choose = (name: string, value: string) => evaluate(`(() => { const s = document.querySelector('dialog[open] [data-fk="listopt:${name}"]'); s.value = ${js(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click('[data-fk="list-options"]');
  await waitFor(`document.querySelector('dialog[open] [data-fk="listopt:sort"]')`, 'het venster Sorteren');
  assert.equal(await evaluate(`document.querySelector('dialog[open] h2').textContent`), 'Sorteren en groeperen');
  assert.equal(await evaluate(`document.querySelector('dialog[open] [data-fk="listopt:dir"]').disabled`), true, 'de richting hoort bij een sortering');
  assert.deepEqual(await evaluate(`[...document.querySelector('dialog[open] [data-fk="listopt:group"]').options].map((o) => o.textContent)`),
    ['Secties (standaard)', 'Datum', 'Prioriteit', 'Label', 'Toegewezen aan', 'Deadline'], 'een project kent geen "Project"');
  await choose('sort', 'name');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  assert.deepEqual(settings().view_options, { [`project:${P}`]: { sort: 'name', dir: 'asc', group: 'default' } }, 'de keuze staat bij je instellingen op de server');
  assert.equal(await evaluate(`document.querySelector('dialog[open] [data-fk="listopt:dir"]').disabled`), false);
  await waitFor(`[...document.querySelectorAll('#content .task .task-title')].map((e) => e.textContent).join('|') === 'appel|Éclair|Zebra|Taak 2|taak 10'`, 'op naam, per sectie: hoofdletters en accenten tellen niet, 2 voor 10');
  await choose('dir', 'desc');
  await waitFor(`[...document.querySelectorAll('#content .task .task-title')].map((e) => e.textContent).join('|') === 'Zebra|Éclair|appel|taak 10|Taak 2'`, 'aflopend');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  assert.equal(settings().view_options[`project:${P}`].dir, 'desc');
  await shot('lijst-sorteren');
  // sluiten: de knop is gemarkeerd en er is niets om te slepen
  await evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Sluiten').click()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  assert.equal(await evaluate(`document.querySelector('[data-fk="list-options"]').classList.contains('active')`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.group[data-drop-project]').length`), 0, 'bij een eigen sortering kun je binnen de lijst niet slepen');
  step('sorteren en groeperen: sorteren op naam (hoofdletters, accenten en getallen goed, ook aflopend) per sectie; de keuze staat in je instellingen op de server; de knop is gemarkeerd en slepen binnen de lijst staat uit');

  // ---- groeperen op prioriteit en op label ----
  await click('[data-fk="list-options"]');
  await choose('group', 'priority');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await waitFor(`[...document.querySelectorAll('#content .group-title')].map((e) => e.textContent).join('|') === 'Prioriteit 1|Prioriteit 2|Prioriteit 3|Prioriteit 4'`, 'vier prioriteitsgroepen');
  assert.equal((await titles()).length, 5, 'vijf taken');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#content .group')].map((g) => [g.querySelector('.group-title').textContent, g.querySelector('.group-count').textContent])`),
    [['Prioriteit 1', '2'], ['Prioriteit 2', '1'], ['Prioriteit 3', '1'], ['Prioriteit 4', '1']]);
  await choose('group', 'label');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await waitFor(`[...document.querySelectorAll('#content .group-title')].map((e) => e.textContent).join('|') === 'proeflabel|Zonder label'`, 'groepen per label');
  await shot('lijst-groeperen');
  await evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Sluiten').click()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  step('sorteren en groeperen: groeperen op prioriteit (vier groepen met aantallen) en op label (de groep "Zonder label" achteraan)');

  // ---- een wijziging van een ander apparaat komt vanzelf binnen; standaard herstellen ----
  await as([['settings_update', { id: `settings-${alice.id}`, view_options: { [`project:${P}`]: { sort: 'priority', dir: 'asc', group: 'default' } } }]]);
  await waitFor(`[...document.querySelectorAll('#content .task .task-title')].map((e) => e.textContent).join('|') === 'appel|Zebra|Éclair|taak 10|Taak 2'`, 'een keuze van een ander apparaat komt vanzelf binnen', 15_000).catch(async (err: Error) => {
    throw new Error(`${err.message}; nu: ${JSON.stringify(await titles())}`);
  });
  await click('[data-fk="list-options"]');
  await click('dialog[open] [data-fk="listopt:reset"]');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  assert.deepEqual(settings().view_options, {}, 'de standaard hoeft niet bewaard te worden');
  await waitFor(`document.querySelectorAll('.group[data-drop-project]').length > 0`, 'slepen kan weer');
  assert.deepEqual(await titles(), ['Zebra', 'appel', 'Éclair', 'taak 10', 'Taak 2']);
  step('sorteren en groeperen: een keuze van een ander apparaat komt vanzelf binnen; "Standaard herstellen" wist de keuze en zet slepen weer aan');

  // ---- Vandaag en Aankomend ----
  await nav('Vandaag');
  await waitFor(`document.getElementById('view-title').textContent === 'Vandaag'`, 'Vandaag');
  await click('[data-fk="list-options"]');
  assert.deepEqual(await evaluate(`[...document.querySelector('dialog[open] [data-fk="listopt:group"]').options].map((o) => o.value)`), ['default', 'date', 'priority', 'label', 'assignee', 'project', 'deadline']);
  await choose('group', 'project');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await waitFor(`[...document.querySelectorAll('#content .group-title')].some((e) => e.textContent === 'Lijstproef')`, 'Vandaag per project');
  assert.deepEqual(Object.keys(settings().view_options), ['today']);
  await evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Sluiten').click()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  await nav('Aankomend');
  await waitFor(`document.getElementById('view-title').textContent === 'Aankomend'`, 'Aankomend');
  await click('[data-fk="list-options"]');
  assert.equal(await evaluate(`[...document.querySelector('dialog[open] [data-fk="listopt:group"]').options].some((o) => o.value === 'date')`), false, 'Aankomend is al per dag ingedeeld');
  await evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Sluiten').click()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  await nav('Vandaag');
  await click('[data-fk="list-options"]');
  await click('dialog[open] [data-fk="listopt:reset"]');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  assert.deepEqual(settings().view_options, {});
  step('sorteren en groeperen: Vandaag per project (zonder keuze "Datum" bij Aankomend); herstellen laat niets achter in de instellingen');

  // ---- opruimen ----
  await as([['project_delete', { id: P }], ['label_delete', { id: 'e2elijstlabel001' }]]);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
}
