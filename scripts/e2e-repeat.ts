// De herhalingskiezer in het taakvenster (ui/repeatPicker.js) in een echte browser: "Herhalen" opent het paneel met vaste keuzes,
// "Elke werkdag" komt als tekst in het datumveld en wordt bewaard; daarna een eigen keuze (om de 2 weken op maandag en donderdag om
// 9:00) met een voorbeeld; Escape sluit alleen het paneel, niet het venster; en "Niet herhalen" laat de datum staan.
// Wordt aangeroepen vanuit scripts/e2e.ts.

import assert from 'node:assert/strict';
import { createSession } from '../server/users.ts';

export async function repeatScenario(c: any) {
  const { send, evaluate, waitFor, step, db, alice, syncAs, serverState, nav, sleep, shot } = c;
  const token = createSession(db, alice.id, 'Controle herhalen').token;
  let k = 0;
  const as = async (commands: [string, object][]) => {
    const res = await syncAs(token, 'e2e-herhalen', commands.map(([type, args]) => ({ type, uuid: `e2e-herh-${String(++k).padStart(6, '0')}`, args })));
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const [uuid, s] of Object.entries(body.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
  };
  const until = async (check: () => boolean, what: string, ms = 10_000) => {
    for (let waited = 0; !check(); waited += 100) {
      if (waited > ms) throw new Error(`wachten op de server: ${what}`);
      await sleep(100);
    }
  };
  const startView = await evaluate<string>(`document.getElementById('view-title').textContent`);
  const tomorrow = await evaluate<string>(`(() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`);
  const P = 'e2eherhaalproj01';
  const ID = 'e2erep-planten01';
  await as([
    ['project_add', { id: P, name: 'Herhaalproef' }],
    ['task_add', { id: ID, project_id: P, content: 'Herhaalproef: kamerplanten', due: { date: tomorrow } }],
  ]);
  const task = () => (serverState().tasks as any[]).find((x) => x.id === ID);
  const D = `document.querySelector('#task-dialog')`;
  const field = `${D}.querySelector('[data-fk="task-due"]')`;
  const panel = `${D}.querySelector('[data-fk="repeat-panel"]')`;
  const openTask = async () => {
    await evaluate(`document.querySelector('li.task[data-id="${ID}"] .task-body').click()`);
    await waitFor(`document.querySelector('#task-dialog[open] [data-fk="repeat-open"]')`, 'het taakvenster met Herhalen');
  };
  const openPanel = async () => {
    await evaluate(`${D}.querySelector('[data-fk="repeat-open"]').click()`);
    await waitFor(`!${panel}.hidden`, 'het paneel Herhalen');
  };
  const save = async () => {
    await evaluate(`${D}.querySelector('button[type="submit"]').click()`);
    await waitFor(`!document.querySelector('#task-dialog[open]')`, 'het venster dicht na opslaan');
  };
  const set = (selector: string, value: string) => evaluate(`(() => { const el = ${panel}.querySelector('${selector}'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);

  await waitFor(`[...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Herhaalproef')`, 'het project', 10_000);
  await nav('Herhaalproef');
  await waitFor(`document.querySelector('li.task[data-id="${ID}"]')`, 'de taak');

  // ---- vaste keuze: elke werkdag ----
  await openTask();
  assert.equal(await evaluate(`${D}.querySelector('[data-fk="repeat-open"]').getAttribute('aria-expanded')`), 'false');
  assert.equal(await evaluate(`getComputedStyle(${panel}).display`), 'none', 'het paneel is dicht ook echt onzichtbaar');
  await openPanel();
  assert.equal(await evaluate(`${D}.querySelector('[data-fk="repeat-open"]').getAttribute('aria-expanded')`), 'true');
  const weekday = await evaluate<string>(`new Intl.DateTimeFormat('nl-NL', { weekday: 'long', timeZone: 'UTC' }).format(new Date('${tomorrow}T00:00:00Z'))`);
  const presets = await evaluate<string[]>(`[...${panel}.querySelectorAll('.repeat-presets button')].map((b) => b.textContent)`);
  assert.deepEqual(presets.slice(0, 2), ['Elke dag', 'Elke werkdag (ma–vr)']);
  assert.equal(presets[2], `Elke week op ${weekday}`, 'de weekdag van de gekozen datum');
  assert.ok(!presets.includes('Niet herhalen'), 'nog geen herhaling: geen knop om die weg te halen');
  await evaluate(`${panel}.querySelector('[data-fk="repeat-workdays"]').click()`);
  assert.equal(await evaluate<string>(`${field}.value`), 'elke werkdag');
  assert.ok(await evaluate(`${panel}.hidden`), 'het paneel is dicht na een keuze');
  assert.match(await evaluate<string>(`${field}.closest('label').querySelector('.hint').textContent`), /^Wordt: /);
  await save();
  await until(() => JSON.stringify(task()?.due?.recurrence) === JSON.stringify({ freq: 'weekly', byweekday: [1, 2, 3, 4, 5] }), 'elke werkdag op de server');

  // ---- eigen keuze: om de 2 weken op maandag en donderdag om 9:00, begint bij de huidige herhaling ----
  await openTask();
  await openPanel();
  assert.ok(await evaluate(`Boolean(${panel}.querySelector('[data-fk="repeat-none"]'))`), 'Niet herhalen bij een taak die herhaalt');
  assert.equal(await evaluate<string>(`${panel}.querySelector('[data-fk="repeat-unit"]').value`), 'week');
  const pressed = () => evaluate<string[]>(`[...${panel}.querySelectorAll('.repeat-day')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.fk)`);
  assert.deepEqual(await pressed(), ['repeat-day-1', 'repeat-day-2', 'repeat-day-3', 'repeat-day-4', 'repeat-day-5'], 'begint bij de werkdagen');
  await set('[data-fk="repeat-interval"]', '2');
  assert.equal(await evaluate<string>(`${panel}.querySelector('[data-fk="repeat-unit"] option[value="week"]').textContent`), 'weken', 'meervoud bij 2');
  for (const d of [2, 3, 5]) await evaluate(`${panel}.querySelector('[data-fk="repeat-day-${d}"]').click()`);
  assert.deepEqual(await pressed(), ['repeat-day-1', 'repeat-day-4']);
  // bij weken alleen de weekdagen; de keuzes voor maanden en jaren zijn onzichtbaar, en de zeven dagen passen op één regel
  assert.deepEqual(await evaluate(`[...${panel}.querySelectorAll('.repeat-weekdays, .repeat-months')].map((e) => getComputedStyle(e).display)`), ['flex', 'none']);
  assert.equal(await evaluate(`new Set([...${panel}.querySelectorAll('.repeat-day')].map((b) => Math.round(b.getBoundingClientRect().top))).size`), 1, 'de dagen op één regel');
  await set('[data-fk="repeat-time"]', '09:00');
  const preview = await evaluate<string>(`${panel}.querySelector('[data-fk="repeat-preview"]').textContent`);
  assert.ok(preview.startsWith('Wordt: Om de 2 weken op maandag en donderdag om 9:00, voor het eerst '), preview);
  await evaluate(`${panel}.scrollIntoView({ block: 'center' })`);
  await shot('herhalen-paneel');
  // Escape sluit alleen het paneel (niet het taakvenster)
  await evaluate(`${panel}.querySelector('[data-fk="repeat-interval"]').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(`${panel}.hidden`, 'het paneel dicht na Escape');
  assert.ok(await evaluate(`Boolean(document.querySelector('#task-dialog[open]'))`), 'het taakvenster blijft open');
  assert.equal(await evaluate<string>(`document.activeElement?.dataset?.fk ?? ''`), 'repeat-open', 'de focus terug op Herhalen');
  // opnieuw kiezen en toepassen met Enter in het veld van het aantal
  await openPanel();
  await set('[data-fk="repeat-interval"]', '2');
  for (const d of [2, 3, 5]) await evaluate(`${panel}.querySelector('[data-fk="repeat-day-${d}"]').click()`);
  await set('[data-fk="repeat-time"]', '09:00');
  await evaluate(`${panel}.querySelector('[data-fk="repeat-interval"]').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(`${panel}.hidden`, 'toegepast met Enter');
  assert.ok(await evaluate(`Boolean(document.querySelector('#task-dialog[open]'))`), 'Enter bewaart nog niet de hele taak');
  assert.equal(await evaluate<string>(`${field}.value`), 'elke 2 ma en do om 9:00');
  await save();
  await until(() => JSON.stringify(task()?.due?.recurrence) === JSON.stringify({ freq: 'weekly', interval: 2, byweekday: [1, 4] }), 'om de 2 weken op ma en do');
  assert.match(task().due.date, /T09:00$/);

  // ---- niet herhalen: de datum blijft, de herhaling gaat weg ----
  const before = task().due.date;
  await openTask();
  await openPanel();
  await evaluate(`${panel}.querySelector('[data-fk="repeat-none"]').click()`);
  await save();
  await until(() => task()?.due && !task().due.recurrence, 'zonder herhaling');
  assert.equal(task().due.date, before, 'dezelfde datum en tijd');

  // opruimen: latere stappen zoeken taken op naam
  await as([['project_delete', { id: P }]]);
  await waitFor(`![...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Herhaalproef')`, 'het proefproject is weg', 10_000);
  await nav(startView);
  step('herhalen met knoppen in het taakvenster: elke werkdag, een eigen keuze (om de 2 weken op ma en do om 9:00) met voorbeeld, Enter en Escape in het paneel, en niet herhalen');
}
