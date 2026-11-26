// Twee lijsten of notities naast elkaar (core/split.js) in een echte browser, tegen de echte server: openen met de knop bovenaan,
// de zijbalk werkt op de kolom waar je het laatst klikte, afvinken in de rechter kolom, hetzelfde project links en rechts, een taak van
// de ene naar de andere kolom slepen, twee notities naast elkaar bewerken, terug en sluiten, Ctrl+\, en op een smal scherm één kolom.
// Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties komen via `c`.

import assert from 'node:assert/strict';
import { createSession } from '../server/users.ts';

export async function splitScenario(c: any) {
  const { send, evaluate, waitFor, shot, sleep, SYNCED, db, alice, syncAs, nav } = c;
  const token = createSession(db, alice.id, 'Controle naast elkaar').token;
  let k = 0;
  const as = async (commands: [string, object][]) => {
    const res = await syncAs(token, 'e2e-split', commands.map(([type, args]) => ({ type, uuid: `e2e-split-${String(++k).padStart(5, '0')}`, args })));
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const [uuid, s] of Object.entries(body.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
  };
  const task = (id: string) => db.prepare('SELECT project_id, checked FROM tasks WHERE id = ?').get(id) as { project_id: string; checked: number };
  const note = (id: string) => db.prepare('SELECT title FROM notes WHERE id = ?').get(id) as { title: string };
  const titles = (pane: 'content' | 'side-content') => evaluate<string[]>(`[...document.querySelectorAll('#${pane} .task .task-title')].map((e) => e.textContent)`);
  const state = () => evaluate<{ split: boolean; side: boolean; main: string; right: string; active: string }>(`({
    split: document.body.classList.contains('split'),
    side: !document.getElementById('side-pane').hidden,
    main: document.getElementById('view-title').textContent,
    right: document.getElementById('side-title').textContent,
    active: document.querySelector('.pane-active')?.id ?? '',
  })`);
  /** Een klik in een kolom maakt die kolom actief (zoals met de muis: pointerdown). */
  const activate = (id: 'main-pane' | 'side-pane') => evaluate(`document.getElementById('${id}').querySelector('.view-head').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  const L = 'e2esplitlinks001', R = 'e2esplitrechts01';
  // waar de vorige onderdelen waren: daar eindigt dit onderdeel ook weer (de volgende rekenen erop)
  const startView = await evaluate<string>(`document.getElementById('view-title').textContent`);

  await as([
    ['project_add', { id: L, name: 'Splitlinks' }], ['project_add', { id: R, name: 'Splitrechts' }],
    ['task_add', { id: 'e2esplittaakL001', project_id: L, content: 'Links een' }],
    ['task_add', { id: 'e2esplittaakL002', project_id: L, content: 'Links twee' }],
    ['task_add', { id: 'e2esplittaakR001', project_id: R, content: 'Rechts een' }],
    ['note_add', { id: 'e2esplitnotitie1', title: 'Eerste notitie', content: 'alfa' }],
    ['note_add', { id: 'e2esplitnotitie2', title: 'Tweede notitie', content: 'bravo' }],
  ]);
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await waitFor(`[...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Splitrechts')`, 'de projecten komen binnen', 15_000);
  await nav('Splitlinks');
  await waitFor(`document.getElementById('view-title').textContent === 'Splitlinks'`, 'het linker project');
  assert.equal((await state()).split, false, 'eerst één kolom');

  // ---- openen met de knop bovenaan: rechts hetzelfde, en rechts is actief ----
  await evaluate(`document.querySelector('[data-fk="split-open"]').click()`);
  await waitFor(`document.body.classList.contains('split') && !document.getElementById('side-pane').hidden`, 'twee kolommen');
  assert.deepEqual(await state(), { split: true, side: true, main: 'Splitlinks', right: 'Splitlinks', active: 'side-pane' });
  assert.deepEqual(await titles('side-content'), ['Links een', 'Links twee'], 'rechts dezelfde taken, met eigen regels');
  assert.deepEqual(await titles('content'), ['Links een', 'Links twee'], 'links staan ze nog');
  // de zijbalk werkt op de actieve kolom (rechts)
  await nav('Splitrechts');
  await waitFor(`document.getElementById('side-title').textContent === 'Splitrechts'`, 'rechts het andere project');
  assert.equal((await state()).main, 'Splitlinks', 'links bleef staan');
  assert.deepEqual(await titles('side-content'), ['Rechts een']);
  assert.equal(await evaluate(`document.querySelector('.nav-item.active .nav-label')?.textContent`), 'Splitrechts', 'de zijbalk toont de actieve kolom');
  // elke kolom scrolt zelf
  const scroll = await evaluate<string[]>(`[getComputedStyle(document.getElementById('main-pane')).overflowY, getComputedStyle(document.getElementById('side-pane')).overflowY]`);
  assert.deepEqual(scroll, ['auto', 'auto']);
  await shot('naast-elkaar');

  // ---- afvinken in de rechter kolom ----
  await evaluate(`document.querySelector('#side-content li.task [data-act="check"]').click()`);
  await waitFor(`await ${SYNCED}`, 'afgevinkt en verstuurd');
  for (let i = 0; i < 50 && task('e2esplittaakR001').checked !== 1; i++) await sleep(100);
  assert.equal(task('e2esplittaakR001').checked, 1, 'de taak rechts is afgevinkt op de server');
  await waitFor(`document.querySelectorAll('#side-content li.task').length === 0`, 'rechts is leeg');

  // ---- links actief maken: de zijbalk werkt dan links ----
  await activate('main-pane');
  await waitFor(`document.querySelector('.pane-active')?.id === 'main-pane'`, 'links actief');
  await nav('Vandaag');
  await waitFor(`document.getElementById('view-title').textContent === 'Vandaag'`, 'links Vandaag');
  assert.equal((await state()).right, 'Splitrechts', 'rechts bleef staan');
  await nav('Splitlinks');
  await waitFor(`document.getElementById('view-title').textContent === 'Splitlinks'`, 'links weer het linker project');

  // ---- slepen van links naar rechts: de taak gaat naar het andere project ----
  // (een lege lijst heeft geen plek om op te slepen, ook niet met één kolom: eerst een taak rechts)
  await as([['task_add', { id: 'e2esplittaakR009', project_id: R, content: 'Rechts staat er weer een' }]]);
  await waitFor(`document.querySelectorAll('#side-content li.task').length === 1`, 'rechts een taak', 15_000);
  await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  const from = await evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('#content li.task[data-id="e2esplittaakL001"] .task-title').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()`);
  const to = await evaluate<{ x: number; y: number }>(`(() => { const g = document.querySelector('#side-content .group[data-drop-project]') ?? document.querySelector('#side-content .group'); const r = g.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height, 60) / 2 + 10) }; })()`);
  const mouse = (type: string, x: number, y: number, buttons: number) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: buttons || type === 'mouseReleased' ? 'left' : 'none', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse' });
  await mouse('mouseMoved', from.x, from.y, 0);
  await mouse('mousePressed', from.x, from.y, 1);
  for (let i = 1; i <= 12; i++) await mouse('mouseMoved', Math.round(from.x + ((to.x - from.x) * i) / 12), Math.round(from.y + ((to.y - from.y) * i) / 12), 1);
  await sleep(120);
  await mouse('mouseReleased', to.x, to.y, 0);
  await waitFor(`await ${SYNCED}`, 'verplaatst en verstuurd');
  for (let i = 0; i < 50 && task('e2esplittaakL001').project_id !== R; i++) await sleep(100);
  assert.equal(task('e2esplittaakL001').project_id, R, 'van de linker naar de rechter lijst gesleept');
  await waitFor(`[...document.querySelectorAll('#side-content .task-title')].some((e) => e.textContent === 'Links een')`, 'rechts in beeld');
  assert.deepEqual(await titles('content'), ['Links twee'], 'links weg');

  // ---- hetzelfde project links en rechts: een wijziging komt in beide ----
  await nav('Splitrechts');
  await waitFor(`document.getElementById('view-title').textContent === 'Splitrechts'`, 'links ook Splitrechts');
  await as([['task_add', { id: 'e2esplittaakR002', project_id: R, content: 'Van een ander apparaat' }]]);
  await waitFor(`[...document.querySelectorAll('#content .task-title')].some((e) => e.textContent === 'Van een ander apparaat') && [...document.querySelectorAll('#side-content .task-title')].some((e) => e.textContent === 'Van een ander apparaat')`, 'in beide kolommen', 15_000);

  // ---- twee notities naast elkaar ----
  await nav('Notities');
  await waitFor(`document.getElementById('view-title').textContent === 'Notities' && document.querySelector('#content .nc-open')`, 'links Notities');
  await evaluate(`document.querySelector('#content .nc[data-id="e2esplitnotitie1"] .nc-open').click()`);
  await waitFor(`document.querySelector('#content .note-sheet .note-title')?.value === 'Eerste notitie'`, 'links de eerste notitie, in de kolom');
  assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open]'))`), false, 'geen venster: de notitie staat in de kolom');
  await activate('side-pane');
  await nav('Notities');
  await waitFor(`document.getElementById('side-title').textContent === 'Notities' && document.querySelector('#side-content .nc-open')`, 'rechts Notities');
  await evaluate(`document.querySelector('#side-content .nc[data-id="e2esplitnotitie2"] .nc-open').click()`);
  await waitFor(`document.querySelector('#side-content .note-sheet .note-title')?.value === 'Tweede notitie'`, 'rechts de tweede notitie');
  assert.equal(await evaluate(`document.querySelector('#content .note-sheet .note-title')?.value`), 'Eerste notitie', 'links staat de eerste nog open');
  await shot('twee-notities');
  // typen in de rechter notitie wordt bewaard
  await evaluate(`(() => { const t = document.querySelector('#side-content .note-title'); t.value = 'Tweede notitie, bijgewerkt'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  for (let i = 0; i < 60 && note('e2esplitnotitie2').title !== 'Tweede notitie, bijgewerkt'; i++) await sleep(100);
  assert.equal(note('e2esplitnotitie2').title, 'Tweede notitie, bijgewerkt', 'bewaard op de server');
  // een wijziging van buiten tekent de lijst opnieuw, maar de open editors blijven staan
  await as([['task_add', { id: 'e2esplittaakR003', project_id: R, content: 'Nog een' }]]);
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  assert.equal(await evaluate(`document.querySelector('#side-content .note-title')?.value`), 'Tweede notitie, bijgewerkt', 'de editor rechts bleef staan');
  // terug: rechts weer de lijst van notities
  await evaluate(`document.querySelector('#side-content [data-fk="note-close"]').click()`);
  await waitFor(`document.querySelector('#side-content .nc-open') && !document.querySelector('#side-content .note-sheet')`, 'rechts weer de lijst');

  // ---- links typen en meteen ergens anders heen: wat je typte, wordt eerst bewaard ----
  await activate('main-pane');
  await evaluate(`(() => { const t = document.querySelector('#content .note-title'); t.value = 'Eerste notitie, snel weg'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await nav('Vandaag');
  await waitFor(`document.getElementById('view-title').textContent === 'Vandaag' && !document.querySelector('#content .note-sheet')`, 'links Vandaag');
  for (let i = 0; i < 60 && note('e2esplitnotitie1').title !== 'Eerste notitie, snel weg'; i++) await sleep(100);
  assert.equal(note('e2esplitnotitie1').title, 'Eerste notitie, snel weg', 'bewaard bij het weggaan');
  await nav('Notities');
  await waitFor(`document.querySelector('#content .nc[data-id="e2esplitnotitie1"] .nc-open')`, 'links Notities');
  await evaluate(`document.querySelector('#content .nc[data-id="e2esplitnotitie1"] .nc-open').click()`);
  await waitFor(`document.querySelector('#content .note-sheet .note-title')?.value === 'Eerste notitie, snel weg'`, 'links weer de eerste notitie');

  // ---- sluiten met het kruisje, en weer openen met Ctrl+\ ----
  await evaluate(`document.querySelector('[data-fk="split-close:side"]').click()`);
  await waitFor(`!document.body.classList.contains('split') && document.getElementById('side-pane').hidden`, 'één kolom');
  assert.equal(await evaluate(`document.querySelector('#content .note-sheet .note-title')?.value`), 'Eerste notitie, snel weg', 'links bleef de notitie open');
  await evaluate(`document.querySelector('#content [data-fk="note-close"]').click()`);
  await waitFor(`document.getElementById('view-title').textContent === 'Notities' && document.querySelector('#content .nc-open')`, 'links weer de lijst');
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', code: 'Backslash', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(`document.body.classList.contains('split')`, 'Ctrl+\\ opent naast elkaar');
  assert.equal((await state()).right, 'Notities', 'rechts wat links stond');
  // zonder twee kolommen opent een notitie gewoon in een venster (zoals eerst)
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', code: 'Backslash', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await waitFor(`!document.body.classList.contains('split')`, 'Ctrl+\\ sluit weer');
  await evaluate(`document.querySelector('#content .nc[data-id="e2esplitnotitie1"] .nc-open').click()`);
  await waitFor(`document.querySelector('dialog[open] .note-title')?.value === 'Eerste notitie, snel weg'`, 'een venster zonder twee kolommen');
  await evaluate(`document.querySelector('dialog[open] [data-fk="note-close"]').click()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');

  // ---- op een smal scherm: één kolom, ook als rechts nog iets bewaard staat ----
  await evaluate(`document.querySelector('[data-fk="split-open"]').click()`);
  await waitFor(`document.body.classList.contains('split')`, 'weer twee kolommen');
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 860, deviceScaleFactor: 1, mobile: false });
  await waitFor(`!document.body.classList.contains('split') && document.getElementById('side-pane').hidden`, 'smal: één kolom');
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-fk="split-open"]'))`), false, 'smal: geen knop naast elkaar');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await waitFor(`document.body.classList.contains('split')`, 'weer breed: de rechter kolom komt terug');
  await evaluate(`document.querySelector('[data-fk="split-close:side"]').click()`);
  await waitFor(`!document.body.classList.contains('split')`, 'dicht voor de volgende onderdelen');
  // opruimen: de volgende onderdelen zien dezelfde zijbalk als zonder dit onderdeel
  await as([['project_delete', { id: L }], ['project_delete', { id: R }], ['note_delete', { id: 'e2esplitnotitie1' }], ['note_delete', { id: 'e2esplitnotitie2' }]]);
  await waitFor(`![...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Splitlinks')`, 'de projecten zijn weer weg', 15_000);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${JSON.stringify(startView)}`, 'terug waar we begonnen');
}
