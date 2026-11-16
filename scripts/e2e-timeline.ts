// De tijdlijn in een echte browser (Kalender › Tijdlijn): een taak met een tijd staat op haar plek met haar duur als hoogte, een taak
// zonder tijd bij Hele dag, een taak zonder datum bij In te plannen. Slepen met de muis naar een andere tijd en uit In te plannen
// naar het raster, de onderrand slepen voor de duur, Alt+pijl met het toetsenbord, en klikken op een tijd om toe te voegen.
// Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties komen via `c`.

import assert from 'node:assert/strict';
import { createSession } from '../server/users.ts';

export async function timelineScenario(c: any) {
  const { send, evaluate, waitFor, step, js, SYNCED, db, alice, syncAs, serverState, click, nav, sleep, shot } = c;
  const token = createSession(db, alice.id, 'Controle tijdlijn').token;
  let k = 0;
  const as = async (commands: [string, object][]) => {
    const res = await syncAs(token, 'e2e-tijdlijn', commands.map(([type, args]) => ({ type, uuid: `e2e-tl-${String(++k).padStart(6, '0')}`, args })));
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const [uuid, s] of Object.entries(body.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
  };
  const ymd = (offset: number) => evaluate<string>(`(() => { const d = new Date(); d.setDate(d.getDate() + ${offset}); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`);
  const tomorrow = await ymd(1);
  const startView = await evaluate<string>(`document.getElementById('view-title').textContent`);
  const P = 'e2etijdlijnproj1';
  await as([
    ['project_add', { id: P, name: 'Tijdlijnproef' }],
    ['task_add', { id: 'e2etl-overleg001', project_id: P, content: 'Overleg', due: { date: `${tomorrow}T09:00` }, duration: 60 }],
    ['task_add', { id: 'e2etl-heledag001', project_id: P, content: 'Verjaardag Zoë', due: { date: tomorrow } }],
    ['task_add', { id: 'e2etl-zonder0001', project_id: P, content: 'Offerte schrijven' }],
  ]);
  const task = (id: string) => (serverState().tasks as any[]).find((x) => x.id === id);
  await waitFor(`[...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Tijdlijnproef')`, 'het project in de zijbalk', 10_000);
  await nav('Tijdlijnproef');
  await waitFor(`document.querySelector('[data-fk="viewstyle:calendar"]')`, 'de keuze kalender');
  await click('[data-fk="viewstyle:calendar"]');
  await waitFor(`document.querySelector('[data-fk="cal-mode:timeline"]')`, 'de keuze Tijdlijn');
  await click('[data-fk="cal-mode:timeline"]');
  await waitFor(`document.querySelector('.tl')`, 'de tijdlijn');
  if (await evaluate(`document.querySelector('.tl').dataset.tlMode !== 'week'`)) await click('[data-fk="tl-mode:week"]');
  await waitFor(`document.querySelector('.tl[data-tl-mode="week"]')`, 'de week');
  // tomorrow kan in de volgende week vallen (vandaag is de laatste dag van de week)
  if (!(await evaluate(`Boolean(document.querySelector('.tl-col[data-tl-day="${tomorrow}"]'))`))) await click('[data-fk="cal-next"]');
  const item = `document.querySelector('.tl-col[data-tl-day="${tomorrow}"] .tl-item[data-task-id="e2etl-overleg001"]')`;
  await waitFor(`${item}`, 'Overleg op zijn dag');
  const hour = await evaluate<number>(`document.querySelector('.tl-grid').offsetHeight / 24`);
  assert.deepEqual(await evaluate(`[${item}.dataset.start, ${item}.dataset.end]`), ['540', '600']);
  assert.ok(Math.abs((await evaluate<number>(`${item}.getBoundingClientRect().height`)) - hour) <= 2, 'een uur hoog');
  assert.ok(await evaluate(`[...document.querySelectorAll('.tl-allday-cell[data-tl-day="${tomorrow}"] .tl-title')].some((e) => e.textContent === 'Verjaardag Zoë')`), 'zonder tijd bij Hele dag');
  assert.ok(await evaluate(`[...document.querySelectorAll('.tl-plan-list .tl-title')].some((e) => e.textContent === 'Offerte schrijven')`), 'zonder datum bij In te plannen');
  assert.equal(await evaluate<string>(`${item}.querySelector('.tl-time').textContent`), '09:00', 'in de week alleen de begintijd');
  assert.equal(await evaluate<string>(`${item}.querySelector('.tl-open').getAttribute('aria-label')`), 'Overleg: 09:00 – 10:00');

  // ---- slepen met de muis: Overleg een uur en een half later (het grijppunt blijft onder de muis) ----
  const mouse = async (type: string, x: number, y: number) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
    await sleep(50);
    await mouse('mouseReleased', to.x, to.y);
  };
  const center = (expr: string) => evaluate<{ x: number; y: number }>(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  let at = await center(`${item}.querySelector('.tl-open')`);
  await drag(at, { x: at.x, y: at.y + 1.5 * hour });
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await waitFor(`${item}?.dataset.start === '630'`, 'Overleg om 10:30');
  assert.equal(task('e2etl-overleg001').due.date, `${tomorrow}T10:30`);
  assert.equal(task('e2etl-overleg001').duration, 60, 'de duur blijft');
  await waitFor(`document.querySelector('.toast')?.textContent.includes('10:30')`, 'een melding met ongedaan maken');
  assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open]'))`), false, 'slepen opent de taak niet');

  // ---- de onderrand: een uur langer ----
  const edge = await evaluate<{ x: number; y: number }>(`(() => { const r = ${item}.querySelector('.tl-resize').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await drag(edge, { x: edge.x, y: edge.y + hour });
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await waitFor(`${item}?.dataset.end === '750'`, 'Overleg duurt twee uur');
  assert.equal(task('e2etl-overleg001').duration, 120);

  // ---- uit In te plannen naar het raster (14:00) ----
  const plan = `[...document.querySelectorAll('.tl-plan-item')].find((li) => li.dataset.taskId === 'e2etl-zonder0001')`;
  const from = await center(`${plan}.querySelector('.tl-open')`);
  const col = await evaluate<{ x: number; top: number }>(`(() => { const r = document.querySelector('.tl-col[data-tl-day="${tomorrow}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top }; })()`);
  await drag(from, { x: col.x, y: col.top + 14 * hour + 3 });
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await waitFor(`document.querySelector('.tl-col[data-tl-day="${tomorrow}"] .tl-item[data-task-id="e2etl-zonder0001"]')?.dataset.start === '840'`, 'Offerte schrijven om 14:00');
  assert.equal(task('e2etl-zonder0001').due.date, `${tomorrow}T14:00`);
  assert.ok(!(await evaluate(`Boolean(${plan})`)), 'niet meer bij In te plannen');

  // ---- het toetsenbord: Alt+pijl omlaag is een kwartier later ----
  await evaluate(`${item}.querySelector('.tl-open').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 1 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 1 });
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await waitFor(`${item}?.dataset.start === '645'`, 'Overleg om 10:45');
  assert.equal(await evaluate(`document.activeElement?.closest('.tl-item')?.dataset.taskId`), 'e2etl-overleg001', 'de focus blijft op de taak');

  // ---- klikken op een lege tijd: Taak toevoegen op die dag om 16:00 ----
  assert.ok(Math.abs((await evaluate<number>(`document.querySelector('.tl-scroll').scrollTop`)) - 8 * hour) < hour * 3, 'de tijdlijn sprong niet naar boven na het verplaatsen');
  await evaluate(`document.querySelector('.tl-scroll').scrollTop = ${Math.round(12 * hour)}`);
  await sleep(100);
  const col2 = await evaluate<{ x: number; top: number }>(`(() => { const r = document.querySelector('.tl-col[data-tl-day="${tomorrow}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top }; })()`);
  const blank = { x: col2.x, y: col2.top + 16 * hour + 3 };
  await mouse('mousePressed', blank.x, blank.y);
  await mouse('mouseReleased', blank.x, blank.y);
  await waitFor(`document.querySelector('dialog[open] .quick-day')?.textContent.includes('16:00')`, 'Taak toevoegen voor die dag om 16:00');
  await evaluate(`(() => { const i = document.querySelector('dialog[open] input[type=text]'); i.value = 'Kort bellen'; i.dispatchEvent(new Event('input')); })()`);
  await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  const added = (serverState().tasks as any[]).find((x) => x.content === 'Kort bellen');
  assert.ok(added, 'toegevoegd');
  assert.deepEqual([added.project_id, added.due?.date], [P, `${tomorrow}T16:00`]);
  await evaluate(`document.querySelector('.tl-scroll').scrollTop = ${Math.round(8 * hour)}`);
  await sleep(150);
  await shot('tijdlijn-week');
  step('tijdlijn: een taak op haar tijd met haar duur, Hele dag en In te plannen; slepen naar een andere tijd en uit In te plannen, de onderrand voor de duur, Alt+pijl een kwartier, en klikken op een tijd om toe te voegen');

  // ---- opruimen: weer de maand (de keuze blijft op dit apparaat) en weg met het project ----
  await click('[data-fk="cal-mode:month"]');
  await click('[data-fk="viewstyle:list"]');
  await as([['project_delete', { id: P }]]);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
}
