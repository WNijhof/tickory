// Sjablonen in een echte browser: een project uit een meegeleverd sjabloon (voorbeeldweergave, startdatum, toetsenbord, ongedaan
// maken), een project en een taak als sjabloon bewaren, taken uit een sjabloon in een project, delen (kopiëren en bestand),
// importeren (JSON, Todoist-CSV, plakken, een ongeldig bestand), hernoemen en verwijderen, Engels, een telefoonscherm en donker.
// Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties van die test komen binnen via `c`. Alle namen en teksten zijn verzonnen.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { addDays, formatDate, todayString } from '../client/core/format.js';

export async function templatesScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, alice, serverState, typeInto, clickText, click, submit, nav, workDir, BASE } = c;

  const templates = () => (serverState().templates as any[]).filter((x) => !x.is_deleted);
  const projectNamed = (name: string) => (serverState().projects as any[]).find((p) => p.name === name && !p.is_deleted);
  const tasksIn = (projectId: string) => (serverState().tasks as any[]).filter((x) => x.project_id === projectId && !x.is_deleted);
  const sectionsIn = (projectId: string) => (serverState().sections as any[]).filter((x) => x.project_id === projectId && !x.is_deleted);
  const dialogText = () => evaluate<string>(`([...document.querySelectorAll('dialog[open]')].at(-1)?.innerText ?? '').replace(/\\s+/g, ' ')`);
  const dialogTitle = () => evaluate<string>(`[...document.querySelectorAll('dialog[open]')].at(-1)?.querySelector('h2')?.textContent ?? ''`);
  const closeDialog = async () => {
    await evaluate(`document.querySelector('dialog[open]')?.close()`);
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');
  };
  const key = async (name: string) => {
    const codes: Record<string, number> = { ArrowDown: 40, ArrowUp: 38, Escape: 27, Enter: 13 };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: codes[name] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: codes[name] });
  };
  const items = () => evaluate<string[]>(`[...document.querySelectorAll('dialog[open] .tpl-item .tpl-item-name')].map((e) => e.textContent)`);
  const selectedName = () => evaluate<string>(`document.querySelector('dialog[open] .tpl-title')?.textContent ?? ''`);
  const choose = async (name: string) => {
    await evaluate(`[...document.querySelectorAll('dialog[open] .tpl-item')].find((l) => l.querySelector('.tpl-item-name').textContent === ${js(name)}).click()`);
    await waitFor(`document.querySelector('dialog[open] .tpl-title')?.textContent === ${js(name)}`, `sjabloon ${name} gekozen`);
  };
  const setDate = (value: string) => evaluate(`(() => { const i = document.querySelector('dialog[open] .tpl-date'); i.value = ${js(value)}; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const toastText = () => evaluate<string>(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
  const closeToasts = () => evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  const openPicker = async () => {
    await click('[data-fk="nav-from-template"]');
    await waitFor(`document.querySelector('dialog[open] .tpl-layout')`, 'sjablonenvenster');
  };
  const settingsTemplates = async () => {
    await nav('Alice');
    await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
    await clickText('Sjablonen');
    await waitFor(`document.querySelector('dialog[open] .tpl-layout')`, 'beheer van sjablonen');
  };

  // ---- 1. het venster: zes meegeleverde sjablonen, voorbeeld, toetsenbord ----
  await nav('Inbox');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(await evaluate(`document.querySelector('[data-fk="nav-from-template"]').getAttribute('aria-label')`), 'Project uit sjabloon…', 'de knop bij Projecten heeft een naam voor schermlezers');
  await openPicker();
  assert.equal(await dialogTitle(), 'Project uit sjabloon');
  assert.deepEqual(await items(), ['Verhuizen', 'Op vakantie gaan (inpaklijst)', 'Weekmenu en boodschappen', 'Kinderverjaardag organiseren', 'Nieuwe medewerker inwerken', 'Verbouwing']);
  assert.equal(await selectedName(), 'Verhuizen', 'het eerste sjabloon is gekozen');
  let text = await dialogText();
  assert.ok(text.includes('16 taken, verdeeld over 5 secties'), text);
  assert.ok(text.toLowerCase().includes('zes weken van tevoren') && text.includes('Opzegtermijn van je huidige woning nakijken') && text.includes('dag 0') && text.includes('+3 dagen'), `het voorbeeld toont secties, taken en relatieve dagen: ${text}`);
  assert.ok(text.includes('en nog 6 taken'), 'het voorbeeld toont de eerste tien regels');
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open] .tpl-preview-task').length`), 10);
  assert.ok(text.toLowerCase().includes('meegeleverd') && !text.toLowerCase().includes('mijn sjablonen'), 'groepen: alleen Meegeleverd zolang je geen eigen sjablonen hebt (de kop staat in hoofdletters)');
  assert.ok(text.includes('Een eigen sjabloon maak je met'), 'uitleg waar eigen sjablonen vandaan komen');
  await shot('sjablonen-kiezen');
  // toetsenbord: pijl omlaag in de lijst kiest het volgende sjabloon
  await evaluate(`document.querySelector('dialog[open] .tpl-item input').focus()`);
  await key('ArrowDown');
  await waitFor(`document.querySelector('dialog[open] .tpl-title')?.textContent === 'Op vakantie gaan (inpaklijst)'`, 'pijl omlaag kiest het volgende sjabloon');
  assert.equal(await evaluate(`document.activeElement.type`), 'radio', 'de focus blijft op de lijst');
  assert.ok((await dialogText()).includes('Op vakantie gaan (inpaklijst)'));
  assert.equal(await evaluate(`document.querySelector('dialog[open] .status, dialog[open] p[role="status"]')?.textContent`), 'Op vakantie gaan (inpaklijst): 16 taken, verdeeld over 3 secties', 'een schermlezer hoort de keuze');
  step('Sjablonen: het venster Project uit sjabloon toont de zes meegeleverde sjablonen met groepskop, samenvatting en voorbeeld (secties, relatieve dagen); pijl omlaag kiest het volgende sjabloon en meldt het aan een schermlezer');

  // ---- 2. aanmaken met een startdatum ----
  await choose('Verhuizen');
  const start = addDays(todayString(), 30);
  await typeInto('dialog[open] [data-fk="tpl-name"]', 'Verhuizing naar Zwolle');
  await setDate(start);
  await waitFor(`document.querySelector('dialog[open] .tpl-preview-task .tpl-when')?.textContent === ${js(`${formatDate(start, todayString())} (dag 0)`)}`, 'het voorbeeld toont de echte datum, met de relatieve dag erachter');
  text = await dialogText();
  assert.ok(text.includes(`datums van ${formatDate(start, todayString())} tot ${formatDate(addDays(start, 56), todayString())}`), text);
  assert.equal(await evaluate(`document.querySelector('dialog[open] [data-fk="tpl-name"]').value`), 'Verhuizing naar Zwolle', 'de naam blijft staan als het voorbeeld opnieuw wordt getekend');
  await shot('sjablonen-startdatum');
  await clickText('Project maken', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const moving = projectNamed('Verhuizing naar Zwolle');
  assert.ok(moving, 'het project staat op de server');
  assert.equal(moving.color, 'orange');
  assert.equal(tasksIn(moving.id).length, 16);
  assert.deepEqual(sectionsIn(moving.id).sort((a, b) => (a.order_key < b.order_key ? -1 : 1)).map((s) => s.name), ['Zes weken van tevoren', 'Vier weken van tevoren', 'De laatste week', 'Verhuisdag', 'Na de verhuizing']);
  const byContent = (id: string, content: string) => tasksIn(id).find((x) => x.content === content);
  assert.equal(byContent(moving.id, 'Opzegtermijn van je huidige woning nakijken').due.date, start);
  assert.equal(byContent(moving.id, 'Verhuisbedrijf of busje regelen').due.date, addDays(start, 3));
  assert.equal(byContent(moving.id, 'Sleutels overdragen').due.date, addDays(start, 42));
  assert.equal(byContent(moving.id, 'Offertes vergelijken').parent_id, byContent(moving.id, 'Verhuisbedrijf of busje regelen').id);
  assert.equal(byContent(moving.id, 'Opzegtermijn van je huidige woning nakijken').priority, 1);
  assert.equal(await evaluate(`document.getElementById('view-title').textContent`), 'Verhuizing naar Zwolle', 'de app opent het nieuwe project');
  assert.ok((await toastText()).includes('Project "Verhuizing naar Zwolle" gemaakt met 16 taken.'), await toastText());
  assert.equal(await evaluate(`document.querySelectorAll('.group-title').length`), 5, 'de vijf secties staan in beeld');
  await shot('sjablonen-project-gemaakt');
  // ongedaan maken verwijdert het project weer
  await evaluate(`[...document.querySelectorAll('.toast-action')].find((b) => b.textContent === 'Ongedaan maken').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(projectNamed('Verhuizing naar Zwolle'), undefined, 'ongedaan maken haalt het project weg');
  step('Sjablonen: Verhuizen met een startdatum maakt in één keer het project met vijf secties en 16 taken (datums vanaf de startdatum, prioriteit, subtaken), opent het project, en Ongedaan maken verwijdert het weer');

  // ---- 3. zonder datums, met een herhaling ----
  await closeToasts();
  await openPicker();
  await choose('Weekmenu en boodschappen');
  await click('dialog[open] input[name="template-start"][value="none"]');
  await waitFor(`document.querySelector('dialog[open] .tpl-start .hint')?.textContent.includes('Herhalende taken krijgen toch een datum')`, 'uitleg bij geen datums');
  text = await dialogText();
  assert.ok(text.includes('1 nieuw label (@boodschappen)'), text);
  await clickText('Project maken', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const menu = projectNamed('Weekmenu en boodschappen');
  assert.ok(menu);
  const menuTasks = tasksIn(menu.id);
  assert.equal(menuTasks.length, 15);
  assert.equal(menuTasks.filter((x) => x.due?.recurrence).length, 10, 'de tien herhalende taken krijgen een datum, de rest niet');
  assert.ok(menuTasks.filter((x) => !x.due).every((x) => x.parent_id), 'alleen de vijf subtaken hebben geen datum');
  for (const task of menuTasks.filter((x) => x.due)) {
    const iso = new Date(`${task.due.date}T00:00:00Z`).getUTCDay() || 7;
    assert.equal(iso, task.due.recurrence.byweekday[0], `${task.content}: begint op de goede weekdag`);
    assert.ok(task.due.date >= todayString());
    assert.equal(task.due.lang, 'nl');
  }
  assert.ok((serverState().labels as any[]).some((l) => l.name === 'boodschappen' && l.owner_id === alice.id), 'het label is aangemaakt');
  step('Sjablonen: zonder datums blijven alleen de herhalende taken een datum houden (op de eerste passende weekdag), het ontbrekende label wordt aangemaakt');

  // ---- 4. een project en een taak als sjabloon bewaren ----
  await evaluate(`document.querySelector('.btn-menu').click()`);
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu');
  const menuItems = await evaluate<string[]>(`[...document.querySelectorAll('dialog[open] .menu button')].map((b) => b.textContent.trim())`);
  assert.ok(menuItems.includes('Opslaan als sjabloon…') && menuItems.includes('Taak uit sjabloon…'), `projectmenu: ${menuItems}`);
  await clickText('Opslaan als sjabloon…', `document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent.startsWith('Project "Weekmenu en boodschappen" als sjabloon bewaren')`, 'venster Opslaan als sjabloon');
  text = await dialogText();
  assert.ok(text.includes('Dit wordt een sjabloon met 15 taken, verdeeld over 2 secties.'), text);
  assert.ok(text.includes('Niet mee: afgevinkte taken, deadlines, herinneringen, opmerkingen en toewijzingen.'));
  await typeInto('dialog[open] input[type="text"]', 'Mijn weekmenu');
  await shot('sjablonen-opslaan');
  await clickText('Sjabloon bewaren', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');
  await waitFor(SYNCED, 'gesynchroniseerd');
  let mine = templates().find((x) => x.name === 'Mijn weekmenu');
  assert.ok(mine, 'het sjabloon staat op de server');
  assert.deepEqual([mine.kind, mine.owner_id, mine.color], ['project', alice.id, 'green']);
  assert.equal(mine.content.sections.length, 2);
  assert.equal(mine.content.tasks.length + mine.content.sections.reduce((n: number, s: any) => n + s.tasks.length, 0), 10);
  assert.ok(JSON.stringify(mine.content).includes('elke zondag'), 'de herhaling blijft bewaard');
  assert.ok(!JSON.stringify(mine.content).includes(alice.id), 'geen gebruikers-id in een sjabloon');
  assert.ok((await toastText()).includes('Sjabloon "Mijn weekmenu" bewaard.'));
  await closeToasts();

  // een taak met subtaken als sjabloon, uit het taakvenster
  await evaluate(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === 'Boodschappenlijst maken').querySelector('.task-body').click()`);
  await waitFor(`document.querySelector('#task-dialog[open]')`, 'taakvenster');
  await clickText('Als sjabloon bewaren', `document.querySelector('#task-dialog')`);
  await waitFor(`document.querySelector('dialog[open]:not(#task-dialog) h2')?.textContent === 'Taak als sjabloon bewaren'`, 'venster Taak als sjabloon');
  text = await evaluate<string>(`document.querySelector('dialog[open]:not(#task-dialog)').innerText.replace(/\\s+/g, ' ')`);
  assert.ok(text.includes('Dit wordt een sjabloon met 6 taken, verdeeld over 1 sectie.'), text);
  assert.ok(text.includes('Sectie "Plannen en boodschappen" meenemen'));
  await evaluate(`(() => { const f = document.querySelector('dialog[open]:not(#task-dialog) form'); f.querySelector('input[type="text"]').value = 'Boodschappenlijst'; f.requestSubmit(); })()`);
  await waitFor(`!document.querySelector('dialog[open]:not(#task-dialog)')`, 'venster Taak als sjabloon gesloten');
  await evaluate(`document.querySelector('#task-dialog')?.close()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  const list = templates().find((x) => x.name === 'Boodschappenlijst');
  assert.ok(list, 'taaksjabloon op de server');
  assert.equal(list.kind, 'task');
  assert.deepEqual(list.content.sections.map((s: any) => s.name), ['Plannen en boodschappen']);
  assert.equal(list.content.sections[0].tasks[0].subtasks.length, 5);
  assert.deepEqual(list.content.sections[0].tasks[0].labels, ['boodschappen']);
  step('Sjablonen: een project (met secties, herhaling en labels) en een taak met subtaken (vanuit het taakvenster, met de sectie) worden als sjabloon bewaard; er staan geen gebruikers-id\'s in');

  // ---- 5. taken uit een sjabloon in een project, vanuit het venster Taak toevoegen ----
  await closeToasts();
  await nav('Inbox');
  await click('.sidebar-add');
  await waitFor(`document.querySelector('dialog[open] .quick-template')`, 'knop Taak uit sjabloon');
  await clickText('Taak uit sjabloon…', `document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('dialog[open] .tpl-layout') && document.querySelector('dialog[open] h2')?.textContent === 'Taken uit een sjabloon'`, 'sjablonen voor taken');
  assert.deepEqual(await items(), ['Cadeau regelen', 'Vergadering voorbereiden', 'Boodschappenlijst'], 'alleen taaksjablonen: de meegeleverde en de eigen');
  assert.equal(await evaluate(`document.querySelector('dialog[open] [data-fk="tpl-project"] option:checked').textContent`), 'Inbox', 'het project van waaruit je kwam');
  await choose('Cadeau regelen');
  await setDate(addDays(todayString(), 2));
  await shot('sjablonen-taken');
  await clickText('Taken toevoegen', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const inbox = (serverState().projects as any[]).find((p) => p.id === serverState().me.inbox_project_id);
  const gift = tasksIn(inbox.id).filter((x) => ['Cadeau regelen', 'Ideeën verzamelen en een budget afspreken', 'Cadeau kopen of bestellen', 'Inpakken en een kaartje schrijven', 'Overhandigen'].includes(x.content));
  assert.equal(gift.length, 5);
  assert.equal(gift.find((x) => x.content === 'Overhandigen').due.date, addDays(todayString(), 12));
  assert.equal(gift.find((x) => x.content === 'Cadeau regelen').parent_id, null);
  assert.ok((await toastText()).includes('Sjabloon "Cadeau regelen" toegevoegd: 5 taken.'));
  const inboxBefore = tasksIn(inbox.id).length;
  await evaluate(`[...document.querySelectorAll('.toast-action')].find((b) => b.textContent === 'Ongedaan maken').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(tasksIn(inbox.id).length, inboxBefore - 5, 'ongedaan maken haalt de ingevoegde taken weer weg, en alleen die');
  step('Sjablonen: vanuit Taak toevoegen opent "Taak uit sjabloon…" alleen de taaksjablonen; de taken met subtaken en relatieve datums komen in het gekozen project');

  // ---- 6. delen: kopiëren en bestand ----
  await closeToasts();
  await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: BASE });
  const downloads = `${workDir}downloads`;
  mkdirSync(downloads, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await settingsTemplates();
  assert.equal(await dialogTitle(), 'Sjablonen');
  text = await dialogText();
  assert.ok(text.toLowerCase().includes('mijn sjablonen') && text.toLowerCase().includes('meegeleverd'));
  assert.ok(text.includes('Projectsjabloon') && text.includes('Taaksjabloon'), 'in het beheer staat bij elk sjabloon de soort');
  await choose('Mijn weekmenu');
  assert.ok(!(await dialogText()).includes('Project maken'), 'beheren maakt niets aan');
  await clickText('Delen…', `document.querySelector('dialog[open] .tpl-manage')`);
  await waitFor(`document.querySelectorAll('dialog[open]').length === 2 || document.querySelector('dialog[open] .tpl-export')`, 'deelvenster');
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((h) => h.textContent === 'Sjabloon "Mijn weekmenu" delen')`, 'titel van het deelvenster');
  await clickText('Kopieer de tekst', `[...document.querySelectorAll('dialog[open]')].at(-1)`);
  await waitFor(`[...document.querySelectorAll('dialog[open] p[role="status"]')].some((p) => p.textContent === 'De tekst is gekopieerd.')`, 'gekopieerd');
  const copied = await evaluate<string>(`navigator.clipboard.readText()`);
  const exported = JSON.parse(copied);
  assert.deepEqual([exported.format, exported.version, exported.name, exported.kind], ['tickory-template', 1, 'Mijn weekmenu', 'project']);
  assert.deepEqual(exported.content, mine.content, 'de gekopieerde tekst bevat de inhoud van het sjabloon');
  assert.ok(!copied.includes(alice.id) && !copied.includes('owner'), 'geen eigenaar in het bestand');
  await clickText('Bewaar als bestand', `[...document.querySelectorAll('dialog[open]')].at(-1)`);
  const file = `${downloads}\\tickory-template-mijn-weekmenu.json`;
  for (let i = 0; i < 50 && !existsSync(file); i++) await sleep(100);
  assert.ok(existsSync(file), 'het bestand is bewaard');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), exported, 'het bestand bevat dezelfde tekst als wat gekopieerd werd');
  await shot('sjablonen-delen');
  await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).close()`);
  step('Sjablonen: delen kopieert de tekst naar het klembord en bewaart een bestand (tickory-template-….json) met alleen secties en taken');

  // ---- 7. importeren ----
  await clickText('Importeren…', `document.querySelector('dialog[open] .dialog-buttons')`);
  await waitFor(`document.querySelector('dialog[open] input[type="file"]')`, 'importvenster');
  assert.ok((await dialogText()).includes('Lukt het kiezen van een bestand niet, of heb je alleen de tekst, plak die dan hieronder.'), `uitleg voor wie geen bestand kan kiezen: ${await dialogText()}`);
  const csv = `${workDir}Boodschappen-week.csv`;
  writeFileSync(csv, ['TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE', 'task,Brood halen,,4,1,Anna (1),,morgen,nl,Europe/Amsterdam', 'task,"Bij de bakker: volkoren, ""zacht""",,1,2,,,,,', 'section,Zaterdag,,,,,,,,', 'task,Kaas kopen,,2,1,,,,,', 'note,Een opmerking,,,,,,,,'].join('\r\n'), 'utf8');
  const doc = await send('DOM.getDocument', { depth: 1 });
  const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'dialog[open] input[type="file"]' });
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [csv] });
  await waitFor(`document.querySelector('dialog[open] .tpl-import-result')?.textContent.includes('Projectsjabloon met 3 taken, verdeeld over 1 sectie')`, 'voorbeeld van het CSV-bestand');
  text = await dialogText();
  assert.ok(text.includes('1 datum uit het bestand is niet overgenomen.') && text.includes('1 opmerking is niet overgenomen.'), text);
  assert.ok(text.includes('Bij de bakker: volkoren, "zacht"'), 'aanhalingstekens in CSV worden goed gelezen');
  assert.equal(await evaluate(`document.querySelector('dialog[open] input[type="text"]').value`), 'Boodschappen-week', 'de naam komt uit de bestandsnaam');
  await shot('sjablonen-importeren');
  await evaluate(`(() => { const f = document.querySelector('dialog[open]:last-of-type form'); f.requestSubmit(); })()`);
  await waitFor(`!document.querySelector('dialog[open] input[type="file"]')`, 'importvenster gesloten');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const imported = templates().find((x) => x.name === 'Boodschappen-week');
  assert.ok(imported, 'het geïmporteerde sjabloon staat op de server');
  assert.deepEqual(imported.content.sections.map((s: any) => s.name), ['Zaterdag']);
  assert.equal(imported.content.tasks[0].subtasks[0].content, 'Bij de bakker: volkoren, "zacht"');
  assert.equal(imported.content.tasks[0].priority, undefined);
  assert.equal(JSON.stringify(imported.content).includes('morgen'), false, 'datums uit een CSV worden niet overgenomen');

  // plakken: eerst iets ongeldigs, dan het eerder gekopieerde sjabloon
  await clickText('Importeren…', `document.querySelector('dialog[open] .dialog-buttons')`);
  await waitFor(`document.querySelector('dialog[open] input[type="file"]')`, 'importvenster');
  const importDialog = `[...document.querySelectorAll('dialog[open]')].at(-1)`;
  const paste = async (value: string) => evaluate(`(() => { const t = ${importDialog}.querySelector('textarea'); t.value = ${js(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const saveDisabled = () => evaluate<boolean>(`${importDialog}.querySelector('button[type="submit"]').disabled`);
  const resultText = () => evaluate<string>(`${importDialog}.querySelector('.tpl-import-result').textContent`);
  await paste('{"format":"tickory-template","version":1,"name":"x","kind":"project","content":{"v":1,"tasks":[{"content":"<img src=x onerror=alert(1)>","assignee_id":"user-anna"}],"sections":[]}}');
  assert.ok((await resultText()).includes('Dit bestand is geen sjabloon dat Tickory kan lezen.'), await resultText());
  assert.equal(await saveDisabled(), true, 'een ongeldig sjabloon is niet te bewaren');
  assert.equal(await evaluate(`${importDialog}.querySelector('[role="alert"]') !== null`), true, 'de fout wordt aan een schermlezer gemeld');
  await paste('{ dit is geen json');
  assert.ok((await resultText()).includes('Dit is geen geldige JSON.'));
  await paste(copied.replace('"Mijn weekmenu"', '"<b>Mijn</b> weekmenu"'));
  await waitFor(`${importDialog}.querySelector('input[type="text"]').value === '<b>Mijn</b> weekmenu'`, 'geplakt sjabloon gelezen');
  assert.equal(await saveDisabled(), false);
  assert.equal(await evaluate(`${importDialog}.querySelector('.tpl-import-result b') === null`), true, 'HTML in de naam wordt niet uitgevoerd');
  await paste('');
  assert.equal(await saveDisabled(), true);
  await evaluate(`${importDialog}.close()`);
  step('Sjablonen: importeren leest een Todoist-CSV (subtaken via INDENT, secties, aanhalingstekens; datums en opmerkingen worden gemeld maar niet overgenomen), weigert een ongeldig sjabloon met een melding, en HTML in een naam blijft tekst');

  // ---- 8. hernoemen en verwijderen ----
  await choose('Boodschappen-week');
  await clickText('Naam wijzigen', `document.querySelector('dialog[open] .tpl-manage')`);
  await waitFor(`document.querySelectorAll('dialog[open]').length >= 1 && [...document.querySelectorAll('dialog[open] h2')].some((h) => h.textContent === 'Naam wijzigen')`, 'hernoemen');
  await typeInto('dialog[open]:last-of-type input', 'Boodschappen op zaterdag');
  await submit('dialog[open]:last-of-type form');
  await waitFor(`document.querySelector('dialog[open] .tpl-title')?.textContent === 'Boodschappen op zaterdag' || [...document.querySelectorAll('dialog[open] .tpl-item-name')].some((e) => e.textContent === 'Boodschappen op zaterdag')`, 'nieuwe naam in de lijst');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.ok(templates().some((x) => x.name === 'Boodschappen op zaterdag'));
  await choose('Boodschappen op zaterdag');
  await clickText('Verwijderen', `document.querySelector('dialog[open] .tpl-manage')`);
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((h) => h.textContent === 'Sjabloon verwijderen?')`, 'bevestiging');
  assert.ok((await evaluate<string>(`[...document.querySelectorAll('dialog[open]')].at(-1).textContent`)).includes('Projecten die je ervan maakte, blijven staan.'));
  await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.button-danger').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.ok(!templates().some((x) => x.name === 'Boodschappen op zaterdag'), 'verwijderd op de server');
  assert.ok(!(await items()).includes('Boodschappen op zaterdag'), 'verdwenen uit de lijst');
  assert.ok((serverState().templates as any[]).every((x) => !x.is_deleted), 'een volledige sync bevat geen verwijderde sjablonen');
  step('Sjablonen: hernoemen en verwijderen (met bevestiging) werken in het beheerscherm en komen op de server');

  // ---- 9. donker, telefoon, Engels ----
  await choose('Mijn weekmenu');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  await shot('sjablonen-donker');
  const contrast = await evaluate<{ fg: string; bg: string }>(`(() => { const s = getComputedStyle(document.querySelector('dialog[open] .tpl-item.selected')); return { fg: getComputedStyle(document.querySelector('dialog[open] .tpl-item.selected .tpl-item-name')).color, bg: s.backgroundColor }; })()`);
  assert.notEqual(contrast.fg, contrast.bg);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await closeDialog();
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  await openPicker().catch(async () => {
    // op een telefoon staat de zijbalk achter het menu
    await click('#menu-button');
    await sleep(200);
    await openPicker();
  });
  const phone = await evaluate<{ overflow: boolean; submit: boolean; cols: string; list: number }>(`(() => {
    const d = document.querySelector('dialog[open]');
    const b = [...d.querySelectorAll('button')].find((x) => x.textContent === 'Project maken');
    b.scrollIntoView();
    const r = b.getBoundingClientRect();
    return { overflow: d.scrollWidth > d.clientWidth + 1, submit: r.left >= 0 && r.right <= innerWidth && r.height >= 40, cols: getComputedStyle(d.querySelector('.tpl-layout')).gridTemplateColumns.split(' ').length + '', list: d.querySelector('.tpl-list').getBoundingClientRect().height };
  })()`);
  assert.equal(phone.overflow, false, 'geen horizontaal scrollen op een telefoon');
  assert.equal(phone.submit, true, 'de knop Project maken is bereikbaar en groot genoeg');
  assert.equal(phone.cols, '1', 'lijst en details staan onder elkaar');
  await shot('sjablonen-telefoon');
  await closeDialog();
  await send('Emulation.clearDeviceMetricsOverride');

  await evaluate(`localStorage.setItem('tickory.lang', 'en')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready')`, 'app in het Engels');
  await openPicker();
  assert.equal(await dialogTitle(), 'Project from a template');
  assert.deepEqual((await items()).slice(0, 6), ['Moving house', 'Going on holiday (packing list)', 'Weekly menu and groceries', 'Organising a children\'s birthday party', 'Onboarding a new employee', 'Home renovation']);
  text = await dialogText();
  assert.ok(text.includes('16 tasks across 5 sections') && text.includes('Check the notice period on your current home') && text.includes('+3 days'), text);
  assert.ok(text.toLowerCase().includes('built in') && text.includes('Import…'));
  await shot('sjablonen-engels');
  await closeDialog();
  await evaluate(`localStorage.setItem('tickory.lang', 'nl')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready')`, 'app weer in het Nederlands');
  await waitFor(SYNCED, 'gesynchroniseerd');
  // opruimen: wat dit scenario maakte, mag de volgende stappen niet storen (vanaf "een ander apparaat", zoals de rest van de test)
  const token = await evaluate<string>(`localStorage.getItem('tickory.token')`);
  const state = serverState();
  const commands = [
    ...(state.projects as any[]).filter((p) => p.name === 'Weekmenu en boodschappen' && !p.is_deleted).map((p) => ({ type: 'project_delete', args: { id: p.id } })),
    ...templates().map((x) => ({ type: 'template_delete', args: { id: x.id } })),
    ...(state.labels as any[]).filter((l) => l.name === 'boodschappen' && !l.is_deleted).map((l) => ({ type: 'label_delete', args: { id: l.id } })),
  ].map((cmd, i) => ({ ...cmd, uuid: `e2e-sjablonen-opruimen-${String(i).padStart(3, '0')}` }));
  const cleaned = await evaluate<number>(`fetch('/api/v1/sync', { method: 'POST', headers: { Authorization: 'Bearer ' + ${js(token)}, 'Content-Type': 'application/json', 'X-Client-Id': 'e2e-opruimen' }, body: JSON.stringify({ commands: ${js(commands)} }) }).then((r) => r.status)`);
  assert.equal(cleaned, 200);
  await evaluate(`document.querySelector('#sync-status').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual(templates(), [], 'alle sjablonen zijn opgeruimd');
  assert.equal(projectNamed('Weekmenu en boodschappen'), undefined);
  assert.ok(!(await evaluate<string[]>(`[...document.querySelectorAll('.nav-row .nav-label')].map((e) => e.textContent)`)).includes('Weekmenu en boodschappen'), 'ook uit de zijbalk');
  step('Sjablonen: donker thema, telefoonscherm (een kolom, geen horizontaal scrollen, grote knoppen) en de Engelse interface met de Engelse meegeleverde sjablonen');
}
