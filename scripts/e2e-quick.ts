// Snel toevoegen in een echte browser: suggesties tijdens het typen (# project, / sectie, @ label, { deadline) met muis en
// toetsenbord, een tijdsbereik ("9:00-10:30" wordt een tijd met een duur), en meer regels plakken (elke regel een taak, na een
// vraag). Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties komen via `c`.

import assert from 'node:assert/strict';
import { createSession } from '../server/users.ts';

export async function quickScenario(c: any) {
  const { send, evaluate, waitFor, step, js, SYNCED, db, alice, syncAs, serverState, nav, clickText } = c;
  const token = createSession(db, alice.id, 'Controle snel toevoegen').token;
  let k = 0;
  const as = async (commands: [string, object][]) => {
    const res = await syncAs(token, 'e2e-snel', commands.map(([type, args]) => ({ type, uuid: `e2e-snel-${String(++k).padStart(5, '0')}`, args })));
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const [uuid, s] of Object.entries(body.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
  };
  const key = async (name: string, vk: number, text?: string) => {
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: vk, text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: vk });
  };
  /** Typt aan het eind van de balk, teken voor teken (zoals iemand typt), zodat de suggesties meelopen. */
  const type = async (text: string) => { for (const ch of text) await send('Input.insertText', { text: ch }); };
  const items = () => evaluate<string[]>(`[...document.querySelectorAll('.quick-suggest:not([hidden]) .quick-suggest-label')].map((e) => e.textContent)`);
  const bar = () => evaluate<string>(`document.getElementById('quick-input').value`);
  const startView = await evaluate<string>(`document.getElementById('view-title').textContent`);
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const tomorrow = ymd(new Date(Date.now() + 86_400_000));

  await as([
    ['project_add', { id: 'e2esnelproject01', name: 'Snelproef' }],
    ['section_add', { id: 'e2esnelsectie001', project_id: 'e2esnelproject01', name: 'Inkopen' }],
    ['label_add', { id: 'e2esnellabel0001', name: 'snelproeflabel' }],
  ]);
  await nav('Inbox');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await evaluate(`(() => { const i = document.getElementById('quick-input'); i.value = ''; i.focus(); })()`);

  // ---- # project (Enter), / sectie (Tab), @ label (muis), { deadline (Enter), en een tijdsbereik ----
  await type('Vergadering #Snel');
  await waitFor(`[...document.querySelectorAll('.quick-suggest:not([hidden]) .quick-suggest-label')].some((e) => e.textContent === 'Snelproef')`, 'het project als suggestie');
  assert.equal(await evaluate(`document.getElementById('quick-input').getAttribute('aria-expanded')`), 'true');
  await key('Enter', 13, '\r');
  assert.equal(await bar(), 'Vergadering #Snelproef ', 'Enter kiest de suggestie (en voegt nog niets toe)');
  await type('/Ink');
  await waitFor(`document.querySelector('.quick-suggest:not([hidden]) .quick-suggest-label')?.textContent === 'Inkopen'`, 'de sectie van dat project');
  await key('Tab', 9);
  assert.equal(await bar(), 'Vergadering #Snelproef /Inkopen ');
  await type('@snelp');
  await waitFor(`document.querySelector('.quick-suggest:not([hidden]) .quick-suggest-label')?.textContent === 'snelproeflabel'`, 'het label');
  await evaluate(`document.querySelector('.quick-suggest:not([hidden]) .quick-suggest-item').click()`);
  assert.equal(await bar(), 'Vergadering #Snelproef /Inkopen @snelproeflabel ');
  await type('{mor');
  await waitFor(`document.querySelector('.quick-suggest:not([hidden]) .quick-suggest-label')?.textContent === 'Morgen'`, 'de deadline Morgen');
  assert.ok((await evaluate<string>(`document.querySelector('.quick-suggest:not([hidden]) .quick-suggest-hint').textContent`)).length > 0, 'met de datum ernaast');
  await key('Escape', 27);
  assert.deepEqual(await items(), [], 'Escape sluit de lijst');
  await type('gen');
  await waitFor(`document.querySelector('.quick-suggest:not([hidden]) .quick-suggest-label')?.textContent === 'Morgen'`, 'weer open bij verder typen');
  await key('Enter', 13, '\r');
  await type('morgen 9:00-10:30');
  assert.equal(await bar(), 'Vergadering #Snelproef /Inkopen @snelproeflabel {morgen} morgen 9:00-10:30');
  await key('Enter', 13, '\r'); // nu geen lijst open: toevoegen
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  const made = (serverState().tasks as any[]).find((x) => x.content === 'Vergadering');
  assert.ok(made, 'de taak is toegevoegd');
  assert.deepEqual([made.project_id, made.section_id, made.labels, made.deadline, made.due?.date, made.duration], ['e2esnelproject01', 'e2esnelsectie001', ['e2esnellabel0001'], tomorrow, `${tomorrow}T09:00`, 90]);
  step('snel toevoegen: suggesties voor # project (Enter), / sectie (Tab), @ label (klik) en { deadline met de datum; Escape sluit; "9:00-10:30" wordt een tijd met 90 minuten');

  // ---- meer regels plakken: na een vraag elke regel een taak (opsommingstekens weg, p1 herkend) ----
  await evaluate(`(() => {
    const i = document.getElementById('quick-input'); i.value = ''; i.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', '- Eieren kopen\\n- [ ] Brood p1\\n\\n3. Kaas morgen');
    i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === '3 taken toevoegen?')`, 'de vraag');
  await evaluate(`[...document.querySelectorAll('dialog[open] .dialog-buttons button')].find((b) => b.textContent === '3 taken toevoegen').click()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'de vraag dicht');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  const pasted = (serverState().tasks as any[]).filter((x) => ['Eieren kopen', 'Brood', 'Kaas'].includes(x.content));
  assert.equal(pasted.length, 3);
  assert.equal(pasted.find((x) => x.content === 'Brood').priority, 1);
  assert.equal(pasted.find((x) => x.content === 'Kaas').due?.date, tomorrow);
  assert.equal(await bar(), '', 'het veld blijft leeg');
  step('snel toevoegen: meer regels plakken geeft na een vraag een taak per regel (opsommingstekens weg, p1 en morgen herkend)');

  // ---- Instellingen › Algemeen: 12 uur, onderdelen uit de zijbalk, datums niet herkennen, en de startpagina ----
  await as([['task_add', { id: 'e2esneltijd00001', project_id: (serverState().me as any).inbox_project_id, content: 'Tijdproef', due: { date: `${tomorrow}T14:30`, string: 'morgen om 14:30', lang: 'nl' } }]]);
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  const openGeneral = async () => {
    await nav('Alice');
    await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
    await clickText('Algemeen');
    await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Algemeen'`, 'venster Algemeen');
  };
  const rowText = (title: string) => evaluate<string>(`[...document.querySelectorAll('li.task')].find((l) => l.querySelector('.task-title')?.textContent === ${js(title)})?.textContent ?? ''`);
  await nav('Inbox');
  await waitFor(`[...document.querySelectorAll('li.task .task-title')].some((e) => e.textContent === 'Tijdproef')`, 'de taak met een tijd');
  assert.match(await rowText('Tijdproef'), /14:30/);
  await openGeneral();
  assert.equal(await evaluate(`document.querySelector('[data-fk="general-start"]').value`), 'last');
  await evaluate(`(() => {
    const d = document.querySelector('dialog[open]');
    d.querySelector('[data-fk="general-start"]').value = 'upcoming';
    d.querySelector('[data-fk="general-clock:12h"]').click();
    d.querySelector('[data-fk="general-dates"]').click();
    d.querySelector('[data-fk="general-nav:notes"]').click();
    d.querySelector('[data-fk="general-nav:labels"]').click();
    d.querySelector('[data-fk="general-save"]').click();
  })()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  const saved = db.prepare('SELECT general FROM user_settings WHERE id = ?').get(`settings-${alice.id}`) as any;
  assert.deepEqual(JSON.parse(saved.general), { start_page: 'upcoming', time_format: '12h', date_recognition: false, sidebar_hidden: ['notes', 'labels'], week_start: 1, bottom_tabs: ['inbox', 'today', 'upcoming'] });
  await waitFor(`/2:30\\s?p\\.?\\s?m\\.?/i.test([...document.querySelectorAll('li.task')].find((l) => l.querySelector('.task-title')?.textContent === 'Tijdproef')?.textContent ?? '')`, 'de tijd in 12 uur');
  assert.equal(await evaluate(`document.querySelector('[data-fk="nav-notes"]')?.offsetParent ?? null`), null, 'Notities staat niet meer in de zijbalk');
  assert.equal(await evaluate(`document.querySelector('[data-fk="find-toggle:labels"]')`), null, 'Labels ook niet');
  assert.ok(await evaluate(`!!document.querySelector('[data-fk="find-toggle:filters"]')`), 'Filters wel');
  await evaluate(`(() => { const i = document.getElementById('quick-input'); i.value = ''; i.focus(); })()`);
  await send('Input.insertText', { text: 'Tandarts morgen' });
  await key('Enter', 13, '\r');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  const plain = (serverState().tasks as any[]).find((x) => x.content === 'Tandarts morgen');
  assert.ok(plain, '"morgen" blijft deel van de naam');
  assert.equal(plain.due ?? null, null);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready') && document.getElementById('view-title').textContent === 'Aankomend'`, 'na herladen op de startpagina Aankomend', 15_000);
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await as([['settings_update', { id: `settings-${alice.id}`, general: null }], ['task_delete', { id: 'e2esneltijd00001' }], ['task_delete', { id: plain.id }]]);
  await waitFor(`!document.body.dataset.hideNav && document.querySelector('[data-fk="find-toggle:labels"]')`, 'weer de standaard (via de server)');
  step('Instellingen › Algemeen: 12 uur (2:30 p.m.), Notities en Labels uit de zijbalk, "morgen" blijft tekst als datums niet herkend worden, en na herladen opent de startpagina Aankomend; overal op de server bewaard');

  // ---- een plek uit het adres (snelkoppelingen onder het app-icoon op Android): #view=today en #note=new ----
  await nav('Inbox');
  await evaluate(`location.hash = '#view=today'`);
  await waitFor(`document.getElementById('view-title').textContent === 'Vandaag' && location.hash === ''`, 'Vandaag geopend, het adres weer schoon');
  const notesBefore = (serverState().notes as any[] ?? []).length;
  await evaluate(`location.hash = '#note=new'`);
  await waitFor(`document.querySelector('dialog[open] .note-sheet') && location.hash === ''`, 'een nieuwe notitie open');
  await evaluate(`document.querySelector('dialog[open] [data-fk="note-close"]').click()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'notitie dicht');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  assert.equal(await evaluate(`document.getElementById('view-title').textContent`), 'Notities');
  assert.ok((serverState().notes as any[]).length <= notesBefore + 1, 'hooguit één nieuwe notitie (een lege verdwijnt vanzelf)');
  await evaluate(`location.hash = '#view=onzin'`);
  await waitFor(`location.hash === '#view=onzin'`, 'een onbekende plek doet niets');
  assert.equal(await evaluate(`document.getElementById('view-title').textContent`), 'Notities');
  await evaluate(`history.replaceState(null, '', location.pathname)`);
  step('adres: #view=today opent Vandaag en #note=new een nieuwe notitie (zoals de snelkoppelingen onder het app-icoon op Android); iets onbekends doet niets');

  // ---- een taak dupliceren (met zijn open subtaken), ongedaan maken, en een link naar de taak ----
  const inbox = (serverState().me as any).inbox_project_id;
  await as([
    ['task_add', { id: 'e2edupliceer0001', project_id: inbox, content: 'Dupliceerproef', priority: 2, due: { date: tomorrow, string: 'morgen', lang: 'nl' } }],
    ['task_add', { id: 'e2edupliceer0002', project_id: inbox, parent_id: 'e2edupliceer0001', content: 'Stap een' }],
    ['task_add', { id: 'e2edupliceer0003', project_id: inbox, parent_id: 'e2edupliceer0001', content: 'Al klaar' }],
    ['task_complete', { id: 'e2edupliceer0003' }],
  ]);
  await nav('Inbox');
  const openDup = async () => {
    await waitFor(`!document.querySelector('#task-dialog')`, 'geen taakvenster open');
    await waitFor(`[...document.querySelectorAll('li.task .task-title')].some((e) => e.textContent === 'Dupliceerproef')`, 'de taak in de lijst');
    await evaluate(`[...document.querySelectorAll('li.task')].find((l) => l.querySelector('.task-title').textContent === 'Dupliceerproef').querySelector('.task-body').click()`);
    await waitFor(`document.querySelector('#task-dialog [data-fk="task-more"]')`, 'het taakvenster met ⋯');
    await evaluate(`document.querySelector('#task-dialog [data-fk="task-more"]').click()`);
    await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Meer')`, 'het menu Meer');
  };
  await openDup();
  await clickText('Dupliceren');
  await waitFor(`!document.querySelector('#task-dialog')`, 'het venster dicht');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  const dups = (serverState().tasks as any[]).filter((x) => x.content === 'Dupliceerproef');
  assert.equal(dups.length, 2, 'een kopie erbij');
  const copy = dups.find((x) => x.id !== 'e2edupliceer0001');
  assert.deepEqual([copy.priority, copy.due?.date, copy.project_id], [2, tomorrow, inbox]);
  assert.deepEqual((serverState().tasks as any[]).filter((x) => x.parent_id === copy.id).map((x) => x.content), ['Stap een'], 'alleen de open subtaak gaat mee');
  const order = await evaluate<string[]>(`[...document.querySelectorAll('li.task .task-title')].map((e) => e.textContent)`);
  assert.equal(order[order.indexOf('Dupliceerproef') + 1 + (order[order.indexOf('Dupliceerproef') + 1] === 'Stap een' ? 1 : 0)], 'Dupliceerproef', `de kopie direct onder het origineel: ${order}`);
  await waitFor(`document.querySelector('.toast')?.textContent.includes('gedupliceerd')`, 'de melding met ongedaan maken');
  await evaluate(`[...document.querySelector('.toast').querySelectorAll('button')].find((b) => b.textContent === 'Ongedaan maken').click()`);
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await waitFor(`[...document.querySelectorAll('li.task .task-title')].filter((e) => e.textContent === 'Dupliceerproef').length === 1`, 'de kopie weer weg');
  assert.equal((serverState().tasks as any[]).filter((x) => x.content === 'Dupliceerproef' || x.parent_id === copy.id).length, 1, 'ook op de server, met de subtaak');
  await openDup();
  await clickText('Link kopiëren');
  await waitFor(`document.querySelector('.toast')?.textContent.includes('Link gekopieerd') || [...document.querySelectorAll('dialog[open] input')].some((i) => /#task=/.test(i.value))`, 'gekopieerd, of de link om zelf te kopiëren');
  const shown = await evaluate<string | null>(`[...document.querySelectorAll('dialog[open] input')].find((i) => /#task=/.test(i.value))?.value ?? null`);
  if (shown) {
    assert.equal(shown, `${await evaluate<string>('location.origin')}/#task=e2edupliceer0001`);
    await evaluate(`[...document.querySelectorAll('dialog[open] input')].find((i) => /#task=/.test(i.value)).closest('dialog').close()`);
  }
  await evaluate(`document.querySelector('#task-dialog')?.close()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'alles dicht');
  step(`taak dupliceren via ⋯: een kopie direct onder het origineel met de open subtaak (niet de afgevinkte), ongedaan te maken; link kopiëren (${shown ? 'als tekst om zelf te kopiëren' : 'naar het klembord'})`);

  // ---- opruimen ----
  await as([['task_delete', { id: 'e2edupliceer0001' }]]);
  await as([...pasted.map((x) => ['task_delete', { id: x.id }] as [string, object]), ['project_delete', { id: 'e2esnelproject01' }], ['label_delete', { id: 'e2esnellabel0001' }]]);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
}
