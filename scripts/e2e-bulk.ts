// Meerdere taken selecteren en bewerken, ongedaan maken en het overzicht Voltooid, in een echte browser: echte muis-, toets- en
// aanraakgebaren via het DevTools-protocol (geen gesimuleerde gebeurtenissen vanuit de pagina), met controle op de server.
// Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties van die test komen binnen via `c`.
// Na een sleepgebaar wacht de test 150 ms voordat er geklikt wordt: de app negeert 60 ms lang elke klik na het loslaten.

import assert from 'node:assert/strict';
import { handleSync } from '../server/sync.ts';

type Rect = { x: number; y: number; w: number; h: number };

export async function bulkScenario(c: any): Promise<void> {
  try {
    await scenario(c);
  } catch (err) {
    await c.shot('MISLUKT-selecteren').catch(() => {});
    throw err;
  }
}

async function scenario(c: any): Promise<void> {
  const { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, db, alice, bob, syncAs, serverState, otherToken, startServer, stopServer } = c;
  let uuid = 0;
  const cmd = (type: string, args: object) => ({ type, uuid: `e2e-bulk-${String(++uuid).padStart(4, '0')}-${Date.now()}`, args });
  const asAlice = (commands: object[]) => syncAs(otherToken, 'ander-apparaat', commands);
  const asBob = (commands: object[]) => handleSync(db, { commands }, bob.id);

  // ---------- gegevens ----------
  const P = 'bulk-project-0001', P2 = 'bulk-project-0002', PS = 'bulk-project-0003', S1 = 'bulk-section-0001', S2 = 'bulk-section-0002', LAB = 'bulk-label-00001';
  const NAMES = ['Café reserveren', 'Boodschappen doen', 'Ijsjes kopen', 'Zoë bellen', 'Fiets maken', 'Planten sproeien'];
  const T = (name: string) => `bulk-task-${name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 12)}`;
  await asAlice([
    cmd('project_add', { id: P, name: 'Selectieproef' }), cmd('project_add', { id: P2, name: 'Doel voor selectie' }), cmd('project_add', { id: PS, name: 'Samen selecteren' }),
    cmd('section_add', { id: S1, project_id: P, name: 'Week' }), cmd('section_add', { id: S2, project_id: P2, name: 'Daarna' }),
    cmd('label_add', { id: LAB, name: 'thuisproef' }),
    ...NAMES.map((n, i) => cmd('task_add', { id: T(n), project_id: P, section_id: i % 3 === 2 ? S1 : null, content: n, priority: 4 })),
    cmd('task_add', { id: 'bulk-task-kind', project_id: P, parent_id: T('Café reserveren'), content: 'Kind van café' }),
    cmd('comment_add', { id: 'bulk-comment-001', task_id: T('Café reserveren'), content: 'Niet vergeten: crème' }),
    cmd('project_share', { project_id: PS, username: 'bob' }),
    cmd('task_add', { id: 'bulk-task-samen1', project_id: PS, content: 'Samen een' }), cmd('task_add', { id: 'bulk-task-samen2', project_id: PS, content: 'Samen twee' }),
  ]);
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Doel voor selectie') && [...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Samen selecteren')`, 'projecten van de proef in de zijbalk', 15_000);
  for (const key of ['filters', 'labels']) await evaluate(`(() => { const b = document.querySelector('[data-fk="find-toggle:${key}"]'); if (b && b.getAttribute('aria-expanded') === 'true') b.click(); })()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(300);

  // ---------- hulpmiddelen ----------
  const nav = (label: string) => evaluate(`(() => { const el = [...document.querySelectorAll('.nav-item')].find((b) => b.querySelector('.nav-label')?.textContent === ${js(label)}); if (!el) throw new Error('geen menu-item: ' + ${js(label)}); el.click(); })()`);
  const rowExpr = (name: string) => `[...document.querySelectorAll('li.task')].find((l) => l.querySelector('.task-title').textContent === ${js(name)})`;
  const rectNow = (expr: string) => evaluate<Rect>(`(() => { const e = ${expr}; if (!e) throw new Error('niet gevonden: ' + ${js(expr.slice(0, 120))}); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const rectOf = async (expr: string) => {
    let last = await rectNow(expr);
    for (let i = 0; i < 20; i++) {
      await sleep(60);
      const now = await rectNow(expr);
      if (now.x === last.x && now.y === last.y && now.w === last.w && now.h === last.h) return now;
      last = now;
    }
    return last;
  };
  const rowRect = (name: string) => rectOf(rowExpr(name));
  const titleRect = (name: string) => rectOf(`${rowExpr(name)}.querySelector('.task-title')`);
  const mid = (r: Rect) => ({ x: Math.round(r.x + Math.min(r.w / 2, 60)), y: Math.round(r.y + r.h / 2) });
  const mouse = (type: string, x: number, y: number, buttons: number, modifiers = 0) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: buttons || type === 'mouseReleased' ? 'left' : 'none', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse', modifiers });
  /** Een echte klik, met toetsen ingedrukt (Ctrl = 2, Shift = 8). */
  async function clickAt(p: { x: number; y: number }, modifiers = 0) {
    await mouse('mouseMoved', p.x, p.y, 0, modifiers);
    await mouse('mousePressed', p.x, p.y, 1, modifiers);
    await mouse('mouseReleased', p.x, p.y, 0, modifiers);
    await sleep(60);
  }
  const KEYS: Record<string, { code: string; vk: number }> = { x: { code: 'KeyX', vk: 88 }, a: { code: 'KeyA', vk: 65 }, z: { code: 'KeyZ', vk: 90 }, Escape: { code: 'Escape', vk: 27 }, ' ': { code: 'Space', vk: 32 } };
  async function key(k: string, modifiers = 0) {
    const { code, vk } = KEYS[k];
    const text = modifiers === 0 && k.length === 1 ? k : undefined;
    await send('Input.dispatchKeyEvent', { type: modifiers === 0 && text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(60);
  }
  const settle = async () => { await sleep(150); await waitFor(`await ${SYNCED}`, 'gesynchroniseerd', 15_000); };
  const state = () => serverState() as Record<string, any[]>;
  const serverTaskById = (id: string) => state().tasks.find((t) => t.id === id);
  const selected = () => evaluate<string[]>(`[...document.querySelectorAll('li.task.is-selected .task-title')].map((e) => e.textContent)`);
  const bar = () => evaluate<{ hidden: boolean; count: string; buttons: string[] }>(`(() => { const b = document.getElementById('bulk-bar'); return { hidden: b.hidden, count: b.querySelector('.bulk-count')?.textContent ?? '', buttons: [...b.querySelectorAll('.bulk-button')].map((x) => x.dataset.bulk + (x.disabled ? '!' : '')) }; })()`);
  const liveText = () => evaluate<string>(`document.getElementById('bulk-live')?.textContent ?? ''`);
  const toastTexts = () => evaluate<string[]>(`[...document.querySelectorAll('.toast-text')].map((e) => e.textContent)`);
  const closeToasts = () => evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  const bulkButton = (name: string) => evaluate(`(() => { const b = document.querySelector('#bulk-bar [data-bulk="${name}"]'); if (!b || b.disabled) throw new Error('knop ontbreekt of staat uit: ${name}'); b.click(); })()`);
  const undoToast = async () => {
    await waitFor(`document.querySelector('.toast-action')`, 'melding met Ongedaan maken');
    await evaluate(`[...document.querySelectorAll('.toast-action')].at(-1).click()`);
    await settle();
  };
  const dialogButton = (text: string) => evaluate(`(() => { const b = [...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === ${js(text)}); if (!b) throw new Error('geen knop in het venster: ' + ${js(text)}); b.click(); })()`);
  const stopSelecting = async () => { if ((await bar()).hidden === false) { await key('Escape'); await waitFor(`document.getElementById('bulk-bar').hidden`, 'selecteren gestopt'); } };

  await nav('Selectieproef');
  await waitFor(`document.getElementById('view-title').textContent === 'Selectieproef' && document.querySelectorAll('li.task').length === ${NAMES.length + 1}`, 'Selectieproef geopend', 15_000);
  const titles = () => evaluate<string[]>(`[...document.querySelectorAll('li.task .task-title')].map((e) => e.textContent)`);
  const order = await titles();
  assert.equal(order.length, NAMES.length + 1);
  assert.equal(await evaluate(`document.getElementById('bulk-bar').hidden`), true, 'zonder selectie geen actiebalk');
  assert.equal(await evaluate(`document.body.classList.contains('select-mode')`), false);

  // ---------- 1. Ctrl-klik, Shift-klik, Esc ----------
  {
    await clickAt(mid(await titleRect('Boodschappen doen')), 2);
    assert.deepEqual(await selected(), ['Boodschappen doen'], 'Ctrl-klik kiest de taak');
    assert.equal(await evaluate(`document.querySelector('#task-dialog')`), null, 'Ctrl-klik opent het taakvenster niet');
    let b = await bar();
    assert.equal(b.hidden, false);
    assert.equal(b.count, '1 taak geselecteerd');
    assert.equal(await evaluate(`${rowExpr('Boodschappen doen')}.getAttribute('aria-selected')`), 'true');
    assert.equal(await evaluate(`${rowExpr('Boodschappen doen')}.querySelector('.sel-box').getAttribute('aria-checked')`), 'true');
    assert.equal(await evaluate(`document.body.classList.contains('select-mode')`), true, 'de vakjes staan aan zodra er iets gekozen is');
    await waitFor(`document.getElementById('bulk-live').textContent === '1 taak geselecteerd'`, 'het aantal wordt aangekondigd voor schermlezers');
    await clickAt(mid(await titleRect('Fiets maken')), 8);
    const from = order.indexOf('Boodschappen doen');
    const to = order.indexOf('Fiets maken');
    assert.deepEqual(await selected(), order.slice(Math.min(from, to), Math.max(from, to) + 1), 'Shift-klik kiest het bereik van het anker tot de taak');
    b = await bar();
    assert.equal(b.count, `${to - from + 1} taken geselecteerd`);
    await waitFor(`document.getElementById('bulk-live').textContent === ${js(b.count)}`, 'nieuw aantal aangekondigd');
    await clickAt(mid(await titleRect('Boodschappen doen')), 2);
    assert.ok(!(await selected()).includes('Boodschappen doen'), 'nog een Ctrl-klik laat los');
    await shot('selecteren-ctrl-shift');
    await key('Escape');
    await waitFor(`document.getElementById('bulk-bar').hidden && document.querySelectorAll('li.task.is-selected').length === 0`, 'Esc stopt het selecteren');
    assert.equal(await evaluate(`document.body.classList.contains('select-mode')`), false);
    assert.equal(await evaluate(`document.querySelectorAll('[aria-selected]').length`), 0, 'geen aria-selected meer buiten het selecteren');
    step('selecteren met Ctrl-klik en Shift-klik (bereik, ook omhoog), het aantal staat in de balk en in de aria-live, een Ctrl-klik opent het taakvenster niet, Esc stopt en ruimt alle aria-selected op');
  }

  // ---------- 2. de knop Selecteren: vakjes, afvinken blijft afvinken ----------
  {
    assert.equal(await evaluate(`document.querySelector('.bulk-toggle')?.textContent.trim()`), 'Selecteren');
    await evaluate(`document.querySelector('.bulk-toggle').click()`);
    await waitFor(`document.body.classList.contains('select-mode') && !document.getElementById('bulk-bar').hidden`, 'selectiemodus aan');
    assert.equal(await evaluate(`document.querySelector('.bulk-toggle').getAttribute('aria-pressed')`), 'true');
    assert.equal((await bar()).count, 'Niets geselecteerd');
    assert.deepEqual((await bar()).buttons.filter((x) => x.endsWith('!')).sort(), ['date!', 'delete!', 'labels!', 'move!', 'priority!'].concat(['complete!']).sort(), 'zonder keuze staan de acties uit');
    assert.ok(await evaluate(`getComputedStyle(${rowExpr('Fiets maken')}.querySelector('.sel-box')).display !== 'none'`), 'elke regel heeft een vakje');
    // het afvinkrondje blijft afvinken
    await evaluate(`${rowExpr('Planten sproeien')}.querySelector('.check').click()`);
    await waitFor(`!${rowExpr('Planten sproeien')}`, 'afgevinkt in de selectiemodus');
    await settle();
    assert.equal(serverTaskById(T('Planten sproeien')).checked, true, 'het rondje vinkt af, het kiest niet');
    assert.equal((await bar()).count, 'Niets geselecteerd');
    await undoToast();
    await waitFor(`${rowExpr('Planten sproeien')}`, 'terug na Ongedaan maken');
    assert.equal(serverTaskById(T('Planten sproeien')).checked, false);
    // twee vakjes
    await clickAt(mid(await rectOf(`${rowExpr('Fiets maken')}.querySelector('.sel-box')`)));
    await clickAt(mid(await rectOf(`${rowExpr('Zoë bellen')}.querySelector('.sel-box')`)));
    assert.deepEqual((await selected()).sort(), ['Fiets maken', 'Zoë bellen']);
    // in de modus kiest een gewone klik op de regel ook (en opent het venster niet)
    await clickAt(mid(await titleRect('Ijsjes kopen')));
    assert.deepEqual((await selected()).sort(), ['Fiets maken', 'Ijsjes kopen', 'Zoë bellen']);
    assert.equal(await evaluate(`document.querySelector('#task-dialog')`), null);
    await shot('selecteren-balk');
    await evaluate(`document.querySelector('.bulk-toggle').click()`);
    await waitFor(`document.getElementById('bulk-bar').hidden`, 'Klaar stopt het selecteren');
    step('de knop Selecteren zet vakjes bij elke regel, het afvinkrondje blijft afvinken (met Ongedaan maken), een klik op de regel kiest, Klaar stopt');
  }

  // ---------- 3. toetsenbord: x, Spatie, Ctrl+A ----------
  {
    const p = mid(await titleRect('Zoë bellen'));
    await mouse('mouseMoved', p.x, p.y, 0);
    await sleep(100);
    await key('x');
    assert.deepEqual(await selected(), ['Zoë bellen'], 'x kiest de taak onder de aanwijzer');
    // focus op een andere regel: x gaat voor de focus
    await evaluate(`${rowExpr('Fiets maken')}.querySelector('.task-body').focus()`);
    await key('x');
    assert.deepEqual((await selected()).sort(), ['Fiets maken', 'Zoë bellen']);
    await evaluate(`${rowExpr('Ijsjes kopen')}.querySelector('.task-body').focus()`);
    await key(' ');
    assert.deepEqual((await selected()).sort(), ['Fiets maken', 'Ijsjes kopen', 'Zoë bellen'], 'Spatie kiest zodra je aan het kiezen bent');
    assert.equal(await evaluate(`document.querySelector('#task-dialog')`), null);
    await key('a', 2);
    await waitFor(`document.querySelectorAll('li.task.is-selected').length === document.querySelectorAll('li.task').length`, 'Ctrl+A kiest alles in beeld');
    assert.equal((await bar()).count, `${order.length} taken geselecteerd`);
    await waitFor(`document.getElementById('bulk-live').textContent === 'Alles geselecteerd: ${order.length} taken.'`, 'aankondiging van Ctrl+A');
    await key('Escape');
    await waitFor(`document.getElementById('bulk-bar').hidden`, 'Esc');
    // in een invoerveld doen de toetsen niets
    await evaluate(`document.getElementById('quick-input').focus()`);
    await key('x');
    assert.equal(await evaluate(`document.getElementById('bulk-bar').hidden`), true, 'in een invoerveld is x gewoon een letter');
    await evaluate(`document.getElementById('quick-input').blur(); document.getElementById('quick-input').value = ''`);
    step('toetsenbord: x kiest de taak onder de aanwijzer of focus, Spatie tijdens het kiezen, Ctrl+A kiest alles in beeld (aangekondigd), Esc stopt, in een invoerveld doen ze niets');
  }

  // ---------- 4. bulkacties met controle op de server, en Ctrl+Z ----------
  const pick = async (...names: string[]) => {
    await stopSelecting();
    await closeToasts(); // meldingen liggen over de onderste regels en vangen anders de klik op
    for (const n of names) { const r = await titleRect(n); await clickAt(mid(r), 2); if (process.env.E2E_DEBUG) console.log('pick', n, JSON.stringify(r), JSON.stringify(await selected())); }
    assert.deepEqual((await selected()).sort(), [...names].sort());
  };
  {
    // prioriteit
    await pick('Boodschappen doen', 'Ijsjes kopen', 'Zoë bellen');
    await bulkButton('priority');
    await waitFor(`document.querySelector('dialog[open] .menu')`, 'prioriteit kiezen');
    await dialogButton('P1 – hoogste');
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    await settle();
    for (const n of ['Boodschappen doen', 'Ijsjes kopen', 'Zoë bellen']) assert.equal(serverTaskById(T(n)).priority, 1, n);
    assert.equal(serverTaskById(T('Fiets maken')).priority, 4);
    assert.ok((await toastTexts()).some((x) => x === 'Prioriteit van 3 taken gezet op P1.'), (await toastTexts()).join(' | '));
    assert.equal((await bar()).hidden, true, 'na de actie is de selectie weg');
    // Ctrl+Z
    await key('z', 2);
    await settle();
    for (const n of ['Boodschappen doen', 'Ijsjes kopen', 'Zoë bellen']) assert.equal(serverTaskById(T(n)).priority, 4, `${n} terug op p4`);
    assert.ok((await toastTexts()).includes('Ongedaan gemaakt.'));
    await closeToasts();

    // datum: morgen
    await pick('Boodschappen doen', 'Fiets maken');
    await bulkButton('date');
    await waitFor(`document.querySelector('dialog[open] .menu')`, 'datum kiezen');
    await evaluate(`document.querySelector('dialog[open] [data-date]:not([data-date=""])').click()`); // vandaag
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    await settle();
    const today = (await evaluate<string>(`new Date().toLocaleDateString('sv-SE')`));
    assert.equal(serverTaskById(T('Boodschappen doen')).due.date, today);
    assert.equal(serverTaskById(T('Fiets maken')).due.date, today);
    await undoToast();
    assert.equal(serverTaskById(T('Boodschappen doen')).due, null);
    await closeToasts();

    // labels: bestaand label erbij plus een nieuw label op naam
    await pick('Boodschappen doen', 'Ijsjes kopen');
    await bulkButton('labels');
    await waitFor(`document.querySelector('dialog[open] .bulk-label-row')`, 'labels kiezen');
    await evaluate(`document.querySelector('dialog[open] input[data-label-id="${LAB}"]').click()`);
    await evaluate(`(() => { const i = document.querySelector('dialog[open] input[type=text]'); i.value = 'Café, crème'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    await settle();
    const labelId = (name: string) => state().labels.find((l) => l.name === name)?.id;
    assert.ok(labelId('Café') && labelId('crème'), 'de nieuwe labels bestaan (op naam aangemaakt)');
    for (const n of ['Boodschappen doen', 'Ijsjes kopen']) assert.deepEqual(serverTaskById(T(n)).labels.sort(), [LAB, labelId('Café'), labelId('crème')].sort(), n);
    await key('z', 2);
    await settle();
    for (const n of ['Boodschappen doen', 'Ijsjes kopen']) assert.deepEqual(serverTaskById(T(n)).labels, [], `${n}: labels weer weg`);
    await closeToasts();
    step('bulkacties prioriteit, datum en labels (ook nieuwe labels op naam) komen op de server aan en gaan terug met de knop in de melding en met Ctrl+Z');
  }

  // verplaatsen, afvinken, verwijderen
  {
    const before = ['Zoë bellen', 'Ijsjes kopen', 'Fiets maken'].map((n) => ({ n, ...serverTaskById(T(n)) }));
    await pick('Zoë bellen', 'Ijsjes kopen', 'Fiets maken');
    await bulkButton('move');
    await waitFor(`document.querySelector('dialog[open] .bulk-target')`, 'doel kiezen');
    await evaluate(`(() => { const i = document.querySelector('dialog[open] input[type=search]'); i.value = 'daar'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`document.querySelectorAll('dialog[open] .bulk-target').length === 1`, 'filter op sectie');
    await evaluate(`document.querySelector('dialog[open] .bulk-target').click()`); // Doel voor selectie / Daarna
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    await settle();
    const moved = ['Zoë bellen', 'Ijsjes kopen', 'Fiets maken'].map((n) => serverTaskById(T(n)));
    assert.ok(moved.every((t) => t.project_id === P2 && t.section_id === S2), 'alle drie in de sectie Daarna van Doel voor selectie');
    const keys = moved.map((t) => t.order_key);
    assert.equal(new Set(keys).size, 3, 'elk een eigen volgordesleutel');
    assert.deepEqual(moved.sort((a, b) => (a.order_key < b.order_key ? -1 : 1)).map((t) => t.content), order.filter((n) => ['Zoë bellen', 'Ijsjes kopen', 'Fiets maken'].includes(n)), 'in de volgorde van de lijst');
    assert.ok((await toastTexts()).some((x) => x === '3 taken verplaatst naar "Doel voor selectie / Daarna".'), (await toastTexts()).join(' | '));
    await undoToast();
    for (const b of before) {
      const now = serverTaskById(b.id);
      assert.equal(now.project_id, b.project_id, `${b.n}: project terug`);
      assert.equal(now.section_id, b.section_id, `${b.n}: sectie terug`);
      assert.equal(now.order_key, b.order_key, `${b.n}: plek in de lijst terug`);
    }
    await closeToasts();
    await shot('selecteren-verplaatst');

    // afvinken: subtaak gaat mee met haar ouder
    await pick('Café reserveren', 'Kind van café', 'Boodschappen doen');
    await bulkButton('complete');
    await settle();
    assert.equal(serverTaskById(T('Café reserveren')).checked, true);
    assert.equal(serverTaskById('bulk-task-kind').checked, true, 'de subtaak is met haar ouder afgevinkt');
    assert.equal(serverTaskById(T('Boodschappen doen')).checked, true);
    assert.ok((await toastTexts()).some((x) => x === '2 taken voltooid.'), 'twee taken (de subtaak telt niet apart): ' + (await toastTexts()).join(' | '));
    await undoToast();
    assert.equal(serverTaskById(T('Café reserveren')).checked, false);
    assert.equal(serverTaskById('bulk-task-kind').checked, false, 'ook de subtaak is weer open');
    assert.equal(serverTaskById(T('Boodschappen doen')).checked, false);
    await closeToasts();
    step('bulk verplaatsen (zoeken in het doelvenster, sectie als doel, volgorde van de lijst, eigen sleutels) en afvinken (subtaak mee met haar ouder) met ongedaan maken dat alles op de oude plek zet');
  }

  {
    // verwijderen met bevestiging en aantal; ongedaan maken zet taak, subtaak en opmerking terug
    await pick('Café reserveren', 'Kind van café', 'Planten sproeien');
    await bulkButton('delete');
    await waitFor(`document.querySelector('dialog[open] .button-danger')`, 'bevestiging');
    const dialogText = await evaluate<string>(`document.querySelector('dialog[open]').textContent`);
    assert.match(dialogText, /2 taken verwijderen\?/);
    assert.match(dialogText, /Daar hoort 1 subtaak bij\./);
    await dialogButton('Annuleren');
    await waitFor(`!document.querySelector('dialog[open]')`, 'geannuleerd');
    assert.ok(serverTaskById(T('Café reserveren')), 'annuleren verwijdert niets');
    assert.equal((await bar()).count, '3 taken geselecteerd', 'de selectie blijft na annuleren');
    await bulkButton('delete');
    await waitFor(`document.querySelector('dialog[open] .button-danger')`, 'bevestiging');
    await evaluate(`document.querySelector('dialog[open] .button-danger').click()`);
    await settle();
    assert.equal(serverTaskById(T('Café reserveren')), undefined);
    assert.equal(serverTaskById('bulk-task-kind'), undefined);
    assert.equal(serverTaskById(T('Planten sproeien')), undefined);
    assert.equal(await evaluate(`document.querySelector('.toast-text')?.textContent`), '2 taken verwijderd.');
    await undoToast();
    const back = serverTaskById(T('Café reserveren'));
    assert.equal(back.content, 'Café reserveren');
    assert.equal(serverTaskById('bulk-task-kind').parent_id, T('Café reserveren'), 'de subtaak hangt weer onder haar ouder');
    assert.ok(serverTaskById(T('Planten sproeien')));
    assert.ok(state().comments.some((x) => x.id === 'bulk-comment-001' && x.content === 'Niet vergeten: crème'), 'de opmerking is terug');
    await waitFor(`${rowExpr('Café reserveren')} && ${rowExpr('Kind van café')}`, 'taak en subtaak weer in beeld');
    await closeToasts();
    step('bulk verwijderen: bevestiging met het aantal en de subtaken, annuleren laat alles staan, Ongedaan maken zet taken, subtaak en opmerking terug op de server (task_restore)');
  }

  // ---------- 5. toewijzen alleen in een gedeeld project; de server weigert wat niet mag ----------
  {
    await nav('Selectieproef');
    await waitFor(`document.getElementById('view-title').textContent === 'Selectieproef'`, 'terug');
    await pick('Boodschappen doen');
    assert.ok(!(await bar()).buttons.some((x) => x.startsWith('assign')), 'in een privéproject geen Toewijzen');
    await stopSelecting();
    await nav('Samen selecteren');
    await waitFor(`document.getElementById('view-title').textContent === 'Samen selecteren' && document.querySelectorAll('li.task').length === 2`, 'gedeeld project');
    await pick('Samen een', 'Samen twee');
    assert.ok((await bar()).buttons.some((x) => x.startsWith('assign')), 'in een gedeeld project wel Toewijzen');
    await bulkButton('assign');
    await waitFor(`document.querySelector('dialog[open] .menu')`, 'persoon kiezen');
    await dialogButton('Bob');
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    await settle();
    assert.equal(serverTaskById('bulk-task-samen1').assignee_id, bob.id);
    assert.equal(serverTaskById('bulk-task-samen2').assignee_id, bob.id);
    await key('z', 2);
    await settle();
    assert.equal(serverTaskById('bulk-task-samen1').assignee_id, null);
    await closeToasts();

    // de server weigert voor een deel: een taak is intussen verwijderd (server uit, taak weg, server aan)
    await nav('Selectieproef');
    await waitFor(`document.getElementById('view-title').textContent === 'Selectieproef'`, 'terug');
    await pick('Boodschappen doen', 'Fiets maken', 'Zoë bellen');
    await stopServer();
    await bulkButton('priority');
    await waitFor(`document.querySelector('dialog[open] .menu')`, 'prioriteit kiezen');
    await dialogButton('P2');
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    handleSync(db, { commands: [cmd('task_delete', { id: T('Fiets maken') })] }, alice.id); // iemand anders verwijdert de taak ondertussen
    await startServer();
    await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent.startsWith('1 niet gelukt (je koos er 3).'))`, 'één melding voor wat de server weigerde', 25_000);
    const failure = (await toastTexts()).find((x) => x.startsWith('1 niet gelukt (je koos er 3)'))!;
    assert.match(failure, /“Fiets maken”/, failure);
    assert.equal((await toastTexts()).filter((x) => /niet gelukt|Niet gelukt/.test(x)).length, 1, 'precies één melding, niet één per taak');
    await settle();
    assert.equal(serverTaskById(T('Boodschappen doen')).priority, 2, 'de rest is wel gelukt');
    assert.equal(serverTaskById(T('Zoë bellen')).priority, 2);
    await closeToasts();
    // opruimen: de verwijderde taak komt weer terug via de server (binnen de termijn), prioriteiten terug
    await asAlice([cmd('task_restore', { id: T('Fiets maken') }), cmd('task_update', { id: T('Boodschappen doen'), priority: 4 }), cmd('task_update', { id: T('Zoë bellen'), priority: 4 })]);
    await waitFor(`${rowExpr('Fiets maken')}`, 'de teruggezette taak komt vanzelf binnen', 15_000);
    step('toewijzen alleen in een gedeeld project; weigert de server een deel (taak intussen verwijderd) dan is er één melding met aantal en naam en de rest is gelukt; task_restore van een ander apparaat komt vanzelf binnen');
  }

  // ---------- 6. slepen en selecteren ----------
  {
    await stopSelecting();
    // een gekozen taak slepen terwijl er meer gekozen zijn: ze gaan samen
    await pick('Boodschappen doen', 'Fiets maken');
    const a = mid(await titleRect('Boodschappen doen'));
    const target = await rectOf(`[...document.querySelectorAll('#sidebar .nav-row')].find((r) => r.querySelector('.nav-label').textContent === 'Doel voor selectie')`);
    await mouse('mouseMoved', a.x, a.y, 0);
    await mouse('mousePressed', a.x, a.y, 1);
    for (let i = 1; i <= 10; i++) await mouse('mouseMoved', Math.round(a.x + ((target.x + 80 - a.x) * i) / 10), Math.round(a.y + ((target.y + target.h / 2 - a.y) * i) / 10), 1);
    await sleep(80);
    assert.equal(await evaluate(`document.querySelector('.dnd-ghost')?.dataset.count`), '2', 'de gesleepte regel toont dat er twee meegaan');
    assert.deepEqual((await evaluate<string[]>(`[...document.querySelectorAll('.dnd-source .task-title')].map((e) => e.textContent)`)).sort(), ['Boodschappen doen', 'Fiets maken']);
    await mouse('mouseReleased', target.x + 80, Math.round(target.y + target.h / 2), 0);
    await sleep(150); // de app negeert 60 ms lang elke klik na het loslaten
    await settle();
    assert.equal(serverTaskById(T('Boodschappen doen')).project_id, P2);
    assert.equal(serverTaskById(T('Fiets maken')).project_id, P2, 'de andere gekozen taak is met de gesleepte meegegaan');
    assert.ok((await toastTexts()).some((x) => x === '2 taken verplaatst naar "Doel voor selectie".'), (await toastTexts()).join(' | '));
    assert.equal(await evaluate(`document.getElementById('bulk-bar').hidden`), true);
    await undoToast();
    assert.equal(serverTaskById(T('Boodschappen doen')).project_id, P);
    assert.equal(serverTaskById(T('Fiets maken')).project_id, P);
    await closeToasts();
    // een taak die niet gekozen is, sleep je alleen
    await pick('Boodschappen doen', 'Fiets maken');
    const z = mid(await titleRect('Zoë bellen'));
    await mouse('mouseMoved', z.x, z.y, 0);
    await mouse('mousePressed', z.x, z.y, 1);
    for (let i = 1; i <= 10; i++) await mouse('mouseMoved', Math.round(z.x + ((target.x + 80 - z.x) * i) / 10), Math.round(z.y + ((target.y + target.h / 2 - z.y) * i) / 10), 1);
    await sleep(80);
    assert.equal(await evaluate(`document.querySelector('.dnd-ghost')?.dataset.count ?? null`), null, 'een ongekozen taak sleep je alleen');
    await mouse('mouseReleased', target.x + 80, Math.round(target.y + target.h / 2), 0);
    await sleep(150);
    await settle();
    assert.equal(serverTaskById(T('Zoë bellen')).project_id, P2);
    assert.equal(serverTaskById(T('Boodschappen doen')).project_id, P, 'de gekozen taken bleven staan');
    await undoToast();
    await stopSelecting();
    // een klik blijft een klik: zonder selectie opent een tik het taakvenster
    await clickAt(mid(await titleRect('Ijsjes kopen')));
    await waitFor(`document.querySelector('#task-dialog[open]')`, 'taakvenster na gewone klik');
    await key('Escape');
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    await closeToasts();
    step('slepen en selecteren: een gekozen taak slepen neemt de andere gekozen taken mee (teller op de kopie, één melding, ongedaan maken), een ongekozen taak sleep je alleen, een gewone klik opent nog steeds het taakvenster');
  }

  // ---------- 7. aanraking: lang indrukken kiest, daarna verder bewegen sleept ----------
  {
    await closeToasts();
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const touch = (type: string, x: number, y: number) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    try {
      const p = mid(await titleRect('Ijsjes kopen'));
      await touch('touchStart', p.x, p.y);
      await sleep(520);
      await touch('touchEnd', p.x, p.y);
      await sleep(150);
      assert.deepEqual(await selected(), ['Ijsjes kopen'], 'lang indrukken kiest de taak');
      assert.equal(await evaluate(`document.querySelector('#task-dialog')`), null, 'lang indrukken opent het taakvenster niet');
      assert.equal(await evaluate(`document.querySelector('.dnd-ghost')`), null, 'loslaten zonder te bewegen laat niets in de lucht hangen');
      assert.equal(await evaluate(`document.querySelectorAll('.dnd-source').length`), 0);
      assert.equal(serverTaskById(T('Ijsjes kopen')).project_id, P, 'en verplaatst niets');
      // in de modus kiest een tik ook (en de klik direct na een lange druk telt niet: die landt anders op wat er door de balk is opgeschoven)
      await sleep(400);
      const q = mid(await titleRect('Fiets maken'));
      if (process.env.E2E_DEBUG) await evaluate(`window.__ev = []; for (const t of ['pointerdown','pointerup','pointercancel','click','touchstart','touchend']) document.addEventListener(t, (e) => window.__ev.push(t + ':' + (e.target.className || e.target.tagName) + ':' + e.defaultPrevented), true)`);
      await touch('touchStart', q.x, q.y);
      await sleep(60);
      await touch('touchEnd', q.x, q.y);
      if (process.env.E2E_DEBUG) { await sleep(500); console.log('events', JSON.stringify(await evaluate(`window.__ev`)), JSON.stringify(q), await evaluate(`document.querySelector('dialog[open]')?.textContent.slice(0, 200)`)); }
      await waitFor(`document.querySelectorAll('li.task.is-selected').length === 2`, 'een tik kiest tijdens het selecteren');
      assert.deepEqual((await selected()).sort(), ['Fiets maken', 'Ijsjes kopen']);
      // lang indrukken en verder bewegen: slepen van de gekozen taak, de andere gaat mee
      const target = await rectOf(`[...document.querySelectorAll('#sidebar .nav-row')].find((r) => r.querySelector('.nav-label').textContent === 'Doel voor selectie')`);
      const g = mid(await titleRect('Ijsjes kopen'));
      await touch('touchStart', g.x, g.y);
      await sleep(520);
      for (let i = 1; i <= 8; i++) { await touch('touchMove', Math.round(g.x + ((target.x + 80 - g.x) * i) / 8), Math.round(g.y + ((target.y + target.h / 2 - g.y) * i) / 8)); await sleep(16); }
      assert.equal(await evaluate(`Boolean(document.querySelector('.dnd-ghost'))`), true, 'na lang indrukken en bewegen sleep je');
      await touch('touchEnd', target.x + 80, Math.round(target.y + target.h / 2));
      await sleep(150);
      await settle();
      assert.equal(serverTaskById(T('Ijsjes kopen')).project_id, P2);
      assert.equal(serverTaskById(T('Fiets maken')).project_id, P2, 'de andere gekozen taak ging mee');
      await undoToast();
      assert.equal(serverTaskById(T('Ijsjes kopen')).project_id, P);
      await closeToasts();
    } finally {
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
    await stopSelecting();
    step('aanraking: lang indrukken kiest (zonder taakvenster, loslaten zonder te bewegen verplaatst niets), een tik kiest tijdens het selecteren, lang indrukken en bewegen sleept de gekozen taken samen');
  }

  // ---------- 7b. de kalender en het bord ----------
  {
    const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('sv-SE'); };
    await asAlice([cmd('task_update', { id: T('Boodschappen doen'), due: { date: day(1) } }), cmd('task_update', { id: T('Fiets maken'), due: { date: day(2) } })]);
    await waitFor(`${rowExpr('Boodschappen doen')}?.querySelector('.chip-due')`, 'datums binnen', 15_000);
    await closeToasts();
    await evaluate(`document.querySelector('.view-switch [data-view-style="calendar"]').click()`);
    await waitFor(`document.querySelector('.cal')`, 'kalender');
    const item = (name: string) => `[...document.querySelectorAll('li.cal-item[data-real="true"]')].find((l) => l.querySelector('.cal-title-text').textContent === ${js(name)})`;
    await waitFor(`${item('Boodschappen doen')} && ${item('Fiets maken')}`, 'taken in de kalender', 15_000);
    await clickAt(mid(await rectOf(`${item('Boodschappen doen')}.querySelector('.cal-open')`)), 2);
    await clickAt(mid(await rectOf(`${item('Fiets maken')}.querySelector('.cal-open')`)), 2);
    assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('li.cal-item.is-selected .cal-title-text')].map((e) => e.textContent).sort()`), ['Boodschappen doen', 'Fiets maken'], 'kiezen werkt in de kalender');
    assert.equal(await evaluate(`document.querySelector('#task-dialog')`), null);
    assert.equal((await bar()).count, '2 taken geselecteerd');
    // samen slepen naar een andere dag: beide krijgen die dag
    const target = await rectOf(`document.querySelector('td.cal-day[data-date="${day(5)}"] .cal-day-head')`);
    const from = mid(await rectOf(`${item('Boodschappen doen')}.querySelector('.cal-open')`));
    await mouse('mouseMoved', from.x, from.y, 0);
    await mouse('mousePressed', from.x, from.y, 1);
    for (let i = 1; i <= 10; i++) await mouse('mouseMoved', Math.round(from.x + ((target.x + target.w / 2 - from.x) * i) / 10), Math.round(from.y + ((target.y + target.h / 2 - from.y) * i) / 10), 1);
    await sleep(80);
    await mouse('mouseReleased', Math.round(target.x + target.w / 2), Math.round(target.y + target.h / 2), 0);
    await sleep(150);
    await settle();
    assert.equal(serverTaskById(T('Boodschappen doen')).due.date, day(5));
    assert.equal(serverTaskById(T('Fiets maken')).due.date, day(5), 'de andere gekozen taak ging mee naar die dag');
    await undoToast();
    assert.equal(serverTaskById(T('Boodschappen doen')).due.date, day(1));
    assert.equal(serverTaskById(T('Fiets maken')).due.date, day(2));
    await closeToasts();
    await stopSelecting();
    // aanraking op een telefoon: lang indrukken in de kalender kiest en tilt op
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    await evaluate(`window.scrollTo(0, 0)`);
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    try {
      const touch = (type: string, x: number, y: number) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
      const p = mid(await rectOf(`${item('Fiets maken')}.querySelector('.cal-open')`));
      await touch('touchStart', p.x, p.y);
      await sleep(520);
      assert.equal(await evaluate(`Boolean(document.querySelector('.dnd-ghost'))`), true, 'in de kalender tilt lang indrukken de taak op');
      await touch('touchEnd', p.x, p.y);
      await sleep(200);
      assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('li.cal-item.is-selected .cal-title-text')].map((e) => e.textContent)`), ['Fiets maken'], 'en kiest haar');
    } finally {
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
    }
    await stopSelecting();
    await evaluate(`document.querySelector('.view-switch [data-view-style="list"]').click()`);
    await waitFor(`document.querySelector('.group-title') && !document.querySelector('.cal')`, 'lijst terug');
    step('kalender: Ctrl-klik kiest taken, samen slepen naar een dag zet ze allemaal op die dag (met ongedaan maken), lang indrukken met een vinger tilt op en kiest');
  }

  // ---------- 8. de telefoon: balk onderaan, grote tikvlakken ----------
  {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    await stopSelecting();
    await closeToasts();
    await evaluate(`document.querySelector('.bulk-toggle').click()`);
    await waitFor(`document.body.classList.contains('select-mode')`, 'selectiemodus op de telefoon');
    await evaluate(`${rowExpr('Boodschappen doen')}.querySelector('.sel-box').click()`);
    await evaluate(`${rowExpr('Zoë bellen')}.querySelector('.sel-box').click()`);
    await waitFor(`!document.getElementById('bulk-bar').hidden && document.querySelectorAll('li.task.is-selected').length >= 2`, 'balk op de telefoon');
    const m = await evaluate<any>(`(() => { const r = document.getElementById('bulk-bar').getBoundingClientRect(); const cs = getComputedStyle(document.getElementById('bulk-bar')); return { bottom: Math.round(window.innerHeight - r.bottom), position: cs.position, buttons: [...document.querySelectorAll('#bulk-bar .bulk-button')].map((b) => Math.round(b.getBoundingClientRect().height)), box: Math.round(document.querySelector('li.task .sel-box').getBoundingClientRect().height), wide: document.documentElement.scrollWidth <= window.innerWidth }; })()`);
    assert.equal(m.position, 'fixed');
    assert.ok(m.bottom <= 1, 'de balk staat onderaan');
    assert.ok(m.buttons.every((h: number) => h >= 44), `tikvlakken van de knoppen zijn groot genoeg: ${m.buttons}`);
    assert.ok(m.box >= 44, `het vakje is groot genoeg: ${m.box}`);
    assert.ok(m.wide, 'de pagina scrolt niet zijwaarts');
    await shot('selecteren-telefoon');
    await evaluate(`document.querySelector('#bulk-bar [data-bulk="stop"]').click()`);
    await waitFor(`document.getElementById('bulk-bar').hidden`, 'gestopt');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    step('telefoon: de actiebalk zit vast onderaan met knoppen en vakjes van minstens 44 px, geen horizontaal scrollen');
  }

  // ---------- 9. donker en minder beweging ----------
  {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(200);
    await pick('Boodschappen doen', 'Zoë bellen');
    const colors = await evaluate<any>(`(() => { const cs = (e) => getComputedStyle(e); const li = document.querySelector('li.task.is-selected'); const bar = document.getElementById('bulk-bar'); return { row: cs(li).backgroundColor, bar: cs(bar).backgroundColor, text: cs(bar.querySelector('.bulk-count')).color, page: cs(document.body).backgroundColor }; })()`);
    assert.notEqual(colors.row, colors.page, 'een gekozen regel is in het donker te onderscheiden');
    assert.notEqual(colors.text, colors.bar, 'de tekst van de balk heeft contrast met de balk');
    await shot('selecteren-donker');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await stopSelecting();
    step('donkere weergave en minder beweging: een gekozen regel en de balk zijn te onderscheiden');
  }

  // ---------- 10. Voltooid ----------
  {
    const rev = () => Number((db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as any).value);
    /** Een taak als afgevinkt op een bepaald moment, rechtstreeks in de database (de klok van de server laat zich niet verzetten). */
    const completeAt = (id: string, iso: string) => {
      const r = rev() + 1;
      db.prepare("UPDATE meta SET value = ? WHERE key = 'rev'").run(String(r));
      db.prepare('UPDATE tasks SET checked = 1, completed_at = ?, rev = ?, updated_at = ? WHERE id = ?').run(iso, r, iso, id);
    };
    const day = (offset: number, hh = 10) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(hh, 15, 0, 0); return d.toISOString(); };
    completeAt(T('Café reserveren'), day(0, 9));
    completeAt(T('Planten sproeien'), day(0, 11));
    completeAt(T('Ijsjes kopen'), day(-1, 16));
    completeAt(T('Zoë bellen'), day(-3, 8));
    completeAt('bulk-task-samen1', day(-3, 20));
    await evaluate(`document.getElementById('sync-status').click()`);
    await settle();
    await nav('Voltooid');
    await waitFor(`document.getElementById('view-title').textContent === 'Voltooid' && document.querySelectorAll('li.task').length >= 5`, 'overzicht Voltooid', 15_000);
    assert.equal(await evaluate(`document.querySelector('.nav-item.active .nav-label').textContent`), 'Voltooid');
    const heads = await evaluate<string[]>(`[...document.querySelectorAll('.group-title')].map((e) => e.textContent)`);
    assert.ok(heads.length >= 3, `een groep per dag: ${heads}`);
    assert.match(heads[0], /vandaag/i);
    assert.match(heads[1], /^[A-Za-z]+ · \d+ [a-z]+$/, `gisteren staat onder zijn weekdag en datum: ${heads[1]}`);
    assert.notEqual(heads[1], heads[0]);
    const firstTitles = await titles();
    assert.deepEqual(firstTitles.slice(0, 2), ['Planten sproeien', 'Café reserveren'], 'nieuwste eerst: 11:15 gaat voor 09:15');
    assert.deepEqual(firstTitles[2], 'Ijsjes kopen');
    assert.match(await evaluate<string>(`${rowExpr('Planten sproeien')}.querySelector('.chip-completed').textContent`), /om \d\d:\d\d/);
    assert.ok(await evaluate(`${rowExpr('Planten sproeien')}.querySelector('.chip-project-name').textContent === 'Selectieproef / Week'`), 'met het project (en de sectie) erbij');
    assert.equal(await evaluate(`document.querySelector('.completed-restore')?.textContent`), 'Terugzetten');
    await shot('voltooid');
    // zoeken (accenten en hoofdletters maken niet uit)
    await evaluate(`(() => { const i = document.querySelector('[data-fk="completed-search"]'); i.focus(); i.value = 'CAFE'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`document.querySelectorAll('li.task').length === 1 && ${rowExpr('Café reserveren')}`, 'zoeken zonder accent vindt Café');
    assert.equal(await evaluate(`document.activeElement?.dataset?.fk`), 'completed-search', 'de focus blijft in het zoekveld tijdens het typen');
    await evaluate(`(() => { const i = document.querySelector('[data-fk="completed-search"]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`document.querySelectorAll('li.task').length >= 5`, 'leeg zoekveld toont alles');
    // filter op project
    await evaluate(`(() => { const s = document.querySelector('[data-fk="completed-project"]'); s.value = '${PS}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.getElementById('view-title').textContent === 'Voltooid · Samen selecteren' && document.querySelectorAll('li.task').length === 1`, 'filter op project');
    assert.equal(await evaluate(`document.querySelector('li.task .chip-project')`), null, 'bij één project hoeft het project niet bij elke regel');
    await nav('Voltooid');
    await waitFor(`document.getElementById('view-title').textContent === 'Voltooid'`, 'alle projecten');
    // terugzetten
    await evaluate(`${rowExpr('Zoë bellen')}.querySelector('.completed-restore').click()`);
    await waitFor(`!${rowExpr('Zoë bellen')}`, 'taak weg uit Voltooid na terugzetten');
    await settle();
    assert.equal(serverTaskById(T('Zoë bellen')).checked, false);
    assert.equal(serverTaskById(T('Zoë bellen')).completed_at, null);
    assert.ok((await toastTexts()).includes('"Zoë bellen" teruggezet.'), (await toastTexts()).join(' | '));
    await undoToast();
    assert.equal(serverTaskById(T('Zoë bellen')).checked, true, 'ongedaan maken van terugzetten vinkt weer af');
    await closeToasts();
    // selectie werkt hier ook: meerdere tegelijk terugzetten
    await clickAt(mid(await titleRect('Ijsjes kopen')), 2);
    await clickAt(mid(await titleRect('Zoë bellen')), 2);
    assert.ok((await bar()).buttons.some((x) => x.startsWith('reopen')), 'in Voltooid heet de actie Heropenen');
    await bulkButton('reopen');
    await settle();
    assert.equal(serverTaskById(T('Ijsjes kopen')).checked, false);
    assert.equal(serverTaskById(T('Zoë bellen')).checked, false);
    await closeToasts();
    // gearchiveerde projecten en projecten waar je geen lid van bent horen er niet in
    await asAlice([cmd('project_update', { id: PS, is_archived: true })]);
    await waitFor(`!${rowExpr('Samen een')}`, 'taak van een gearchiveerd project verdwijnt uit Voltooid', 15_000);
    await asAlice([cmd('project_update', { id: PS, is_archived: false })]);
    // het project-menu heeft een snelle weg naar de voltooide taken van dat project
    await nav('Selectieproef');
    await waitFor(`document.getElementById('view-title').textContent === 'Selectieproef'`, 'terug');
    await evaluate(`document.querySelector('.view-actions .btn-menu').click()`);
    await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu');
    await dialogButton('Voltooide taken bekijken');
    await waitFor(`document.getElementById('view-title').textContent === 'Voltooid · Selectieproef'`, 'Voltooid van dit project');
    assert.deepEqual((await titles()).sort(), ['Café reserveren', 'Kind van café', 'Planten sproeien'].filter((n) => n !== 'Kind van café').sort());
    step('Voltooid: per dag van afvinken (nieuwste eerst, tijd en project erbij), zoeken zonder accenten, filter op project, Terugzetten met melding en ongedaan maken, Heropenen voor meerdere tegelijk, gearchiveerde projecten tellen niet mee, via het projectmenu');
  }

  // ---------- 11. veel voltooide taken: vlot en met "Meer tonen" ----------
  {
    const many = 1200;
    const commands: object[] = [];
    for (let i = 0; i < many; i++) commands.push(cmd('task_add', { id: `bulk-veel-${String(i).padStart(5, '0')}`, project_id: P2, content: `Veel ${i}` }));
    for (let i = 0; i < commands.length; i += 100) handleSync(db, { commands: commands.slice(i, i + 100) }, alice.id);
    const rev = () => Number((db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as any).value);
    const r = rev() + 1;
    db.prepare("UPDATE meta SET value = ? WHERE key = 'rev'").run(String(r));
    db.prepare("UPDATE tasks SET checked = 1, completed_at = ?, rev = ? WHERE id LIKE 'bulk-veel-%'").run(new Date(Date.now() - 86_400_000 * 5).toISOString(), r);
    await evaluate(`document.getElementById('sync-status').click()`);
    await waitFor(`await ${SYNCED}`, 'gesynchroniseerd', 30_000);
    await nav('Voltooid');
    await waitFor(`document.getElementById('view-title').textContent === 'Voltooid' && document.querySelector('[data-fk="completed-more"]')`, 'Meer tonen', 20_000);
    const rows1 = await evaluate<number>(`document.querySelectorAll('li.task').length`);
    assert.equal(rows1, 100, 'maar 100 regels getekend, ook bij ruim 1200 voltooide taken');
    assert.match(await evaluate<string>(`document.querySelector('[data-fk="completed-more"]').textContent`), /^Meer tonen \(100 getoond van \d+\)$/);
    const started = Date.now();
    await evaluate(`document.querySelector('[data-fk="completed-more"]').click()`);
    await waitFor(`document.querySelectorAll('li.task').length === 200`, 'volgende 100');
    assert.ok(Date.now() - started < 3000, `Meer tonen reageert vlot (${Date.now() - started} ms)`);
    // Ctrl+A kiest alleen wat in beeld is
    await key('a', 2);
    await waitFor(`document.querySelectorAll('li.task.is-selected').length === 200`, 'Ctrl+A kiest wat getekend is');
    await key('Escape');
    // opruimen: weg met de proefdata, zodat de rest van de test niet trager wordt
    for (let i = 0; i < many; i += 100) {
      handleSync(db, { commands: Array.from({ length: Math.min(100, many - i) }, (_, k) => cmd('task_delete', { id: `bulk-veel-${String(i + k).padStart(5, '0')}` })) }, alice.id);
    }
    await evaluate(`document.getElementById('sync-status').click()`);
    await waitFor(`await ${SYNCED}`, 'gesynchroniseerd', 30_000);
    await nav('Selectieproef');
    step('veel voltooide taken: ruim 1200 afgevinkt, maar 100 regels getekend, "Meer tonen" voegt er 100 toe en blijft vlot, Ctrl+A kiest alleen wat getekend is');
  }

  // ---------- opruimen ----------
  await asAlice([cmd('project_delete', { id: P }), cmd('project_delete', { id: P2 }), cmd('project_delete', { id: PS }), cmd('label_delete', { id: LAB })]);
  await waitFor(`![...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Selectieproef')`, 'proefprojecten opgeruimd', 15_000);
  await nav('Thuis').catch(() => {});
}
