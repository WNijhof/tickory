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

  // ---- subtaken uitklappen in Vandaag; Markdown in een titel ----
  await as([
    ['task_add', { id: 'e2elijstouder001', project_id: P, content: 'Verhuizing **plannen**', due: { date: today } }],
    ['task_add', { id: 'e2elijstkind0001', project_id: P, parent_id: 'e2elijstouder001', content: 'Dozen halen' }],
    ['task_add', { id: 'e2elijstkind0002', project_id: P, parent_id: 'e2elijstouder001', content: 'Adres doorgeven' }],
  ]);
  await nav('Vandaag');
  const ouder = `document.querySelector('.task[data-id="e2elijstouder001"]')`;
  await waitFor(`${ouder}?.querySelector('[data-fk="fold:e2elijstouder001"]')`, 'de taak met een uitklapknop bij de subtaken', 10_000);
  assert.equal(await evaluate(`${ouder}.querySelector('.task-title strong')?.textContent`), 'plannen', 'vet in de titel');
  assert.equal(await evaluate(`${ouder}.querySelector('.task-title').textContent`), 'Verhuizing plannen');
  assert.ok(!(await evaluate<string>(`${ouder}.querySelector('.check').getAttribute('aria-label')`)).includes('*'), 'zonder sterretjes voor schermlezers');
  assert.equal(await evaluate(`[...document.querySelectorAll('#content .task')].some((l) => l.dataset.id === 'e2elijstkind0001')`), false, 'ingeklapt');
  await click('[data-fk="fold:e2elijstouder001"]');
  await waitFor(`document.querySelector('.task[data-id="e2elijstkind0001"]')`, 'de subtaken eronder');
  const order = await evaluate<string[]>(`[...document.querySelectorAll('#content .task')].map((l) => l.dataset.id).filter((id) => id.startsWith('e2elijst'))`);
  assert.deepEqual(order.slice(order.indexOf('e2elijstouder001'), order.indexOf('e2elijstouder001') + 3), ['e2elijstouder001', 'e2elijstkind0001', 'e2elijstkind0002']);
  assert.equal(await evaluate(`document.querySelector('.task[data-id="e2elijstkind0001"]').dataset.depth`), '1');
  assert.equal((serverState().tasks as any[]).find((x) => x.id === 'e2elijstouder001').is_collapsed, false, 'het uitklappen verandert de taak zelf niet');
  await click('[data-fk="fold:e2elijstouder001"]');
  await waitFor(`!document.querySelector('.task[data-id="e2elijstkind0001"]')`, 'weer ingeklapt');
  step('Vandaag: subtaken van een taak uitklappen (een niveau dieper, zonder de taak te wijzigen) en weer inklappen; vet in de titel, zonder sterretjes voor schermlezers');

  // ---- de beschrijving van een project; de kalender gekleurd per project ----
  await as([['project_update', { id: P, description: 'Alles voor de **verhuizing**. Zie [de lijst](https://example.org/lijst).' }]]);
  await nav('Lijstproef');
  await waitFor(`document.querySelector('[data-fk="project-desc"] strong')?.textContent === 'verhuizing'`, 'de beschrijving met opmaak onder de titel', 10_000);
  assert.equal(await evaluate(`document.querySelector('[data-fk="project-desc"] a').getAttribute('href')`), 'https://example.org/lijst');
  assert.equal(await evaluate(`document.querySelector('[data-fk="project-desc"] a').getAttribute('target')`), '_blank');
  await as([['project_update', { id: P, color: 'teal' }]]);
  await nav('Aankomend');
  await waitFor(`document.querySelector('[data-fk="viewstyle:calendar"]')`, 'de keuze kalender');
  await click('[data-fk="viewstyle:calendar"]');
  await waitFor(`document.querySelector('[data-fk="cal-color"]')`, 'de kleurkeuze in de kalender');
  await evaluate(`(() => { const s = document.querySelector('[data-fk="cal-color"]'); s.value = 'project'; s.dispatchEvent(new Event('change')); })()`);
  await waitFor(`document.querySelector('.cal-item[data-task-id="e2elijstouder001"]')?.classList.contains('pc-teal')`, 'de taak in de kleur van het project', 10_000);
  await evaluate(`(() => { const s = document.querySelector('[data-fk="cal-color"]'); s.value = 'priority'; s.dispatchEvent(new Event('change')); })()`);
  await waitFor(`!document.querySelector('.cal-item[data-task-id="e2elijstouder001"]')?.classList.contains('cal-colored')`, 'weer op prioriteit');
  await click('[data-fk="viewstyle:list"]');
  step('een projectbeschrijving met opmaak en een klikbare link onder de titel; de kalender gekleurd per project en weer per prioriteit');

  // ---- opruimen ----
  await as([['project_delete', { id: P }], ['label_delete', { id: 'e2elijstlabel001' }]]);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
}
