// Importeren uit Todoist in een echte browser: een back-up (zip) kiezen via het DevTools-protocol, het voorbeeld per project (wat
// meekomt en wat niet), een project uitvinken, een telefoonscherm en donker, importeren, controleren op de server, ongedaan maken,
// en kapotte of verkeerde bestanden. Wordt aangeroepen vanuit scripts/e2e.ts (E2E_IMPORT_ONLY=1: alleen dit onderdeel); de
// hulpfuncties van die test komen binnen via `c`. De back-up is verzonnen (scripts/todoistSample.ts).

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { addDays, todayString } from '../client/core/format.js';
import { sampleBackup } from './todoistSample.ts';

export async function importScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, serverState, clickText, click, nav, workDir } = c;
  const live = (rows: any[]) => rows.filter((x) => !x.is_deleted);
  const dialogText = () => evaluate<string>(`([...document.querySelectorAll('dialog[open]')].at(-1)?.innerText ?? '').replace(/\\s+/g, ' ')`);
  const status = () => evaluate<string>(`document.querySelector('dialog[open] .import-status')?.textContent ?? ''`);
  const chooseFiles = async (files: string[]) => {
    const doc = await send('DOM.getDocument', { depth: 1 });
    const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'dialog[open] input[type="file"]' });
    await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files });
  };
  const openImport = async () => {
    await nav('Alice');
    await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
    await clickText('Importeren uit Todoist');
    await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Importeren uit Todoist'`, 'importvenster');
  };

  // ---- 1. een back-up kiezen: het voorbeeld per project ----
  await waitFor(SYNCED, 'gesynchroniseerd');
  await openImport();
  let text = await dialogText();
  assert.ok(text.includes('Instellingen › Back-ups') && text.includes('er wordt niets uitgevoerd of opgehaald'), `uitleg: ${text}`);
  assert.equal(await evaluate(`document.querySelector('dialog[open] [data-role="import-submit"]').disabled`), true, 'zonder bestand valt er niets te importeren');
  const zip = `${workDir}todoist-backup.zip`;
  writeFileSync(zip, await sampleBackup());
  await chooseFiles([zip]);
  await waitFor(`document.querySelectorAll('dialog[open] .import-item').length === 5`, 'voorbeeld met vijf projecten');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] .import-name')].map((e) => e.textContent)`), ['Inbox', 'Huishouden', 'Werk', 'Werk › Klanten', 'Boodschappen - Markt']);
  text = await dialogText();
  for (const part of ['5 projecten gevonden', '5 taken, 1 opmerking, 2 labels', '2 secties, 5 taken, 1 opmerking, 1 label', '1 datum niet herkend, staat in de beschrijving',
    '1 bijlage niet overgenomen', 'Gemaakt door: Sam · Toegewezen aan: Kim', 'niet gekoppeld aan gebruikers', '2 bestanden in de zip zijn overgeslagen']) {
    assert.ok(text.includes(part), `"${part}" in: ${text}`);
  }
  assert.equal(await status(), 'Klaar om te importeren: 5 projecten met 13 taken.');
  assert.equal(await evaluate(`document.querySelector('dialog[open] [data-role="import-umbrella"]').value`), 'Uit Todoist');
  // een project uitvinken
  await evaluate(`[...document.querySelectorAll('dialog[open] .import-item')].find((li) => li.querySelector('.import-name').textContent === 'Boodschappen - Markt').querySelector('input').click()`);
  await waitFor(`document.querySelector('dialog[open] .import-status').textContent === 'Klaar om te importeren: 4 projecten met 12 taken.'`, 'de samenvatting telt mee');
  await shot('importeren-voorbeeld');
  step('Importeren: een back-up van Todoist (zip) kiezen toont per project secties, taken, opmerkingen en labels, wat niet herkend is (datum, bijlage), wie het maakte (niet gekoppeld), overgeslagen bestanden en een samenvatting die meetelt bij uitvinken');

  // ---- 2. donker en een telefoon ----
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  const colors = await evaluate<{ fg: string; bg: string }>(`(() => { const li = document.querySelector('dialog[open] .import-item'); return { fg: getComputedStyle(li.querySelector('.import-name')).color, bg: getComputedStyle(li).backgroundColor }; })()`);
  assert.notEqual(colors.fg, colors.bg);
  await shot('importeren-donker');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const phone = await evaluate<{ overflow: boolean; page: boolean; submit: boolean; wide: string[] }>(`(() => {
    const d = document.querySelector('dialog[open]');
    const b = d.querySelector('[data-role="import-submit"]');
    b.scrollIntoView();
    const r = b.getBoundingClientRect();
    const wide = [...d.querySelectorAll('*')].filter((e) => { const x = e.getBoundingClientRect(); return x.width > 0 && (x.right > innerWidth + 1 || x.left < -1); }).map((e) => e.className || e.tagName);
    return { overflow: d.scrollWidth > d.clientWidth + 1, page: document.documentElement.scrollWidth > innerWidth + 1, submit: r.left >= 0 && r.right <= innerWidth && r.height >= 40, wide };
  })()`);
  assert.equal(phone.overflow, false, 'geen horizontaal scrollen in het venster op een telefoon');
  assert.equal(phone.page, false, 'de pagina zelf steekt niet uit');
  assert.deepEqual(phone.wide, [], 'niets steekt buiten het scherm');
  assert.equal(phone.submit, true, 'de knop Importeren is bereikbaar en groot genoeg');
  await shot('importeren-telefoon');
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);
  step('Importeren: leesbaar in donker, en op een telefoon van 390 pixels steekt niets uit en is de knop bereikbaar');

  // ---- 3. importeren, op de server, en ongedaan maken ----
  await click('dialog[open] [data-role="import-submit"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'importvenster gesloten');
  await waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('4 projecten geïmporteerd, met 12 taken.'))`, 'melding met ongedaan maken');
  await waitFor(`document.getElementById('view-title').textContent === 'Uit Todoist'`, 'het nieuwe project staat open');
  await waitFor(SYNCED, 'gesynchroniseerd', 15_000);
  const state = serverState();
  const projects = live(state.projects);
  const umbrella = projects.find((p: any) => p.name === 'Uit Todoist');
  assert.ok(umbrella, '"Uit Todoist" staat op de server');
  const named = (name: string) => projects.find((p: any) => p.name === name && !p.id.startsWith('inbox-'));
  assert.deepEqual(['Inbox', 'Huishouden', 'Werk'].map((n) => named(n)?.parent_id), [umbrella.id, umbrella.id, umbrella.id]);
  assert.equal(named('Klanten').parent_id, named('Werk').id, 'Werk - Klanten werd een subproject');
  assert.equal(named('Boodschappen - Markt'), undefined, 'het uitgevinkte project niet');
  assert.equal(named('Huishouden').view_style, 'board');
  const tasks = live(state.tasks);
  const task = (content: string) => tasks.find((x: any) => x.content === content);
  assert.equal(task('Call the dentist').priority, 1);
  assert.equal(task('Call the dentist').due.date, `${addDays(todayString(), 1)}T09:00`, 'tomorrow at 9am');
  assert.equal(task('Call the dentist').duration, 15);
  assert.deepEqual(task('Water the plants').due.recurrence, { freq: 'weekly', byweekday: [1] });
  assert.equal(task('Water the plants').due.string, 'elke maandag', 'een Engelse herhaling met een Nederlandse tekst');
  assert.equal(task('File taxes').description, 'Datum uit Todoist: every 3rd workday');
  assert.equal(task('Heg snoeien').deadline, '2026-12-24');
  assert.equal(task('Lampje vervangen').parent_id, task('Planken uitnemen').id);
  const labelNames = live(state.labels).map((l: any) => l.name);
  for (const name of ['phone', 'money', 'schoonmaak']) assert.ok(labelNames.some((l: string) => l.toLowerCase() === name), `label ${name}`);
  assert.ok(live(state.comments).some((x: any) => x.content === 'See the photo [Bijlage: receipt.jpg]'));
  await shot('importeren-klaar');
  await evaluate(`[...document.querySelectorAll('.toast')].find((t) => t.textContent.includes('geïmporteerd')).querySelector('.toast-action').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd na ongedaan maken', 15_000);
  const after = serverState();
  assert.equal(live(after.projects).some((p: any) => p.name === 'Uit Todoist' || p.name === 'Klanten'), false, 'ongedaan maken verwijdert alles');
  assert.equal(live(after.tasks).some((x: any) => x.content === 'Call the dentist'), false);
  step('Importeren: vier projecten onder "Uit Todoist" met subproject, prioriteit, datums (Engels en Nederlands), duur, deadline, labels en opmerkingen staan op de server; ongedaan maken haalt alles weer weg');

  // ---- 4. kapotte en verkeerde bestanden ----
  const broken = `${workDir}kapot.zip`;
  const bytes = await sampleBackup();
  writeFileSync(broken, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const other = `${workDir}huishoudboekje.csv`;
  writeFileSync(other, 'Datum,Bedrag,Omschrijving\r\n2026-11-01,-800,Huur\r\n', 'utf8');
  await openImport();
  await chooseFiles([broken, other]);
  await waitFor(`document.querySelectorAll('dialog[open] .import-result .error').length === 2`, 'twee meldingen');
  text = await dialogText();
  assert.ok(text.includes('kapot.zip: het zip-bestand is beschadigd of onvolledig.') && text.includes('huishoudboekje.csv: dit is geen CSV van Todoist'), text);
  assert.equal(await evaluate(`document.querySelector('dialog[open] [data-role="import-submit"]').disabled`), true);
  await evaluate(`document.querySelector('dialog[open]').close()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');
  step('Importeren: een afgekapte zip en een CSV die niet van Todoist is geven een duidelijke melding, en er valt niets te importeren');

  // opruimen: de labels die de import aanmaakte (ongedaan maken laat ze staan), zodat de volgende stappen er geen last van hebben
  const token = await evaluate<string>(`localStorage.getItem('tickory.token')`);
  const commands = (serverState().labels as any[]).filter((l) => ['phone', 'money', 'schoonmaak'].includes(l.name) && !l.is_deleted)
    .map((l, i) => ({ type: 'label_delete', uuid: `e2e-importeren-opruimen-${String(i).padStart(3, '0')}`, args: { id: l.id } }));
  const cleaned = await evaluate<number>(`fetch('/api/v1/sync', { method: 'POST', headers: { Authorization: 'Bearer ' + ${js(token)}, 'Content-Type': 'application/json', 'X-Client-Id': 'e2e-opruimen' }, body: JSON.stringify({ commands: ${js(commands)} }) }).then((r) => r.status)`);
  assert.equal(cleaned, 200);
  await evaluate(`document.querySelector('#sync-status').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd na opruimen');
  assert.equal((serverState().labels as any[]).some((l) => ['phone', 'money', 'schoonmaak'].includes(l.name)), false, 'de labels van de import zijn opgeruimd');
  await nav('Inbox');
  await sleep(100);
}
