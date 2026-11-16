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
  assert.deepEqual(JSON.parse(saved.general), { start_page: 'upcoming', time_format: '12h', date_recognition: false, sidebar_hidden: ['notes', 'labels'] });
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

  // ---- opruimen ----
  await as([...pasted.map((x) => ['task_delete', { id: x.id }] as [string, object]), ['project_delete', { id: 'e2esnelproject01' }], ['label_delete', { id: 'e2esnellabel0001' }]]);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
}
