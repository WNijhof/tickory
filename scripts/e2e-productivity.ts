// Het productiviteitsoverzicht in een echte browser, tegen de echte server. Alice ziet boven Voltooid wat ze vandaag en deze week
// afvinkte; de knop opent het scherm Productiviteit (ook via Instellingen) met tegels, twee staafdiagrammen met een verborgen tabel,
// de verdeling over projecten en haar doelen. Ze vinkt iets af (hier en via een ander apparaat): het overzicht loopt vanzelf bij.
// Wat Bob afvinkt, telt voor haar niet. De doelen gaan via de sync naar de server (en dus naar al haar apparaten); zonder server
// blijft het laatste overzicht staan. Ook op een telefoon en in het donker. Wordt aangeroepen vanuit scripts/e2e.ts.

import assert from 'node:assert/strict';
import { createSession } from '../server/users.ts';
import { myStats } from '../server/stats.ts';

export async function productivityScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, db, alice, bob, syncAs, serverState, click, clickText, nav, startServer, stopServer } = c;
  const aliceToken = createSession(db, alice.id, 'Controle productiviteit').token;
  const bobToken = createSession(db, bob.id, 'Bob productiviteit').token;
  let k = 0;
  const as = async (token: string, commands: [string, object][]) => {
    const res = await syncAs(token, 'e2e-productiviteit', commands.map(([type, args]) => ({ type, uuid: `e2e-prod-${String(++k).padStart(5, '0')}`, args })));
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const [uuid, s] of Object.entries(body.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
    return body;
  };
  const closeToasts = () => evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  const zone = await evaluate<string>(`Intl.DateTimeFormat().resolvedOptions().timeZone`);
  const todayOnServer = () => myStats(db, alice.id, { tz: zone }).per_day.find((d: any) => d.date === myStats(db, alice.id, { tz: zone }).today)?.count ?? 0;
  const stripToday = () => evaluate<string>(`document.querySelector('.stats-strip .stats-strip-value')?.textContent ?? ''`);
  const settings = () => (serverState().settings as any[])[0];
  const startView = await evaluate<string>(`document.getElementById('view-title').textContent`);
  const inbox = alice.inbox_project_id;

  // ---- de kop boven Voltooid ----
  await closeToasts();
  await nav('Voltooid');
  await waitFor(`document.querySelector('.stats-strip .stats-strip-value')`, 'de cijfers boven Voltooid');
  const before = todayOnServer();
  await waitFor(`document.querySelector('.stats-strip .stats-strip-value').textContent === ${js(`${before}/5`)}`, `vandaag ${before}/5, zoals de server telt`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.stats-strip .stats-strip-label')].map((e) => e.textContent)`), ['Vandaag', 'Deze week', 'Reeks dagen']);
  assert.equal(await evaluate(`document.querySelector('.stats-strip').getAttribute('aria-label')`), 'Wat je afvinkte');

  // ---- afvinken via een ander apparaat (live) en hier: het overzicht loopt bij; wat Bob doet telt niet ----
  await as(aliceToken, [['task_add', { id: 'e2eprodtask00001', project_id: inbox, content: 'Productief zijn' }], ['task_complete', { id: 'e2eprodtask00001' }]]);
  await waitFor(`document.querySelector('.stats-strip .stats-strip-value').textContent === ${js(`${before + 1}/5`)}`, 'een afvinking op een ander apparaat komt vanzelf binnen', 15_000);
  await as(bobToken, [['task_add', { id: 'e2eprodtask00002', project_id: bob.inbox_project_id, content: 'Van Bob' }], ['task_complete', { id: 'e2eprodtask00002' }]]);
  await sleep(1500);
  assert.equal(todayOnServer(), before + 1, 'wat Bob afvinkt telt niet voor Alice');
  // een terugkerende taak telt elke keer
  await as(aliceToken, [['task_add', { id: 'e2eprodtask00003', project_id: inbox, content: 'Elke dag water drinken', due: { date: '2020-01-01', recurrence: { freq: 'daily' } } }]]);
  await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
  await nav('Inbox');
  await waitFor(`[...document.querySelectorAll('.task-title')].some((e) => e.textContent === 'Elke dag water drinken')`, 'terugkerende taak in de Inbox');
  await evaluate(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === 'Elke dag water drinken').querySelector('.check').click()`);
  await waitFor(`await ${SYNCED}`, 'afgevinkt en gesynchroniseerd');
  await closeToasts();
  await nav('Voltooid');
  await waitFor(`document.querySelector('.stats-strip .stats-strip-value').textContent === ${js(`${before + 2}/5`)}`, 'de terugkerende taak telt mee', 15_000);
  await shot('productiviteit-voltooid');
  step('productiviteit: boven Voltooid vandaag, deze week en de reeks; een afvinking hier en op een ander apparaat komt vanzelf binnen, ook van een terugkerende taak; wat Bob afvinkt telt niet');

  // ---- het scherm ----
  await click('.stats-strip-open');
  await waitFor(`document.getElementById('view-title').textContent === 'Productiviteit' && document.querySelector('.stat-tiles')`, 'het scherm Productiviteit');
  assert.equal(await evaluate(`document.title`), 'Productiviteit · Tickory');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.stat-label')].map((e) => e.textContent)`), ['Vandaag', 'Deze week', 'Reeks dagen', 'Reeks weken']);
  assert.equal(await evaluate(`document.querySelector('.stat-value').textContent`), `${before + 2}/5`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.stats-heading')].map((e) => e.textContent)`), ['De laatste 7 dagen', 'Per week', 'Deze week per project', 'Je doelen']);
  assert.equal(await evaluate(`document.querySelectorAll('.chart')[0].querySelectorAll('.bar').length`), 7, 'zeven dagen');
  assert.equal(await evaluate(`document.querySelectorAll('.chart')[1].querySelectorAll('.bar').length`), 12, 'twaalf weken');
  // toegankelijk: de tekening is decoratief, de getallen staan in een tabel; de dagnamen komen uit Intl (Nederlands)
  assert.equal(await evaluate(`document.querySelector('.bar-chart').getAttribute('aria-hidden')`), 'true');
  const table = await evaluate<string[][]>(`[...document.querySelectorAll('.chart')[0].querySelectorAll('table tbody tr')].map((r) => [...r.children].map((c) => c.textContent))`);
  assert.equal(table.length, 7);
  assert.match(table[6][0], /^(maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag) \d{1,2} [a-z]+$/, `de dag voluit in het Nederlands: ${table[6][0]}`);
  assert.equal(table[6][1], `${before + 2} taken`);
  assert.equal(await evaluate(`document.querySelectorAll('.chart')[0].querySelector('caption').textContent`), 'De laatste 7 dagen (dagdoel 5)');
  assert.ok(await evaluate(`[...document.querySelectorAll('.share-text')].map((e) => e.textContent).includes('Inbox')`), 'de Inbox staat bij de projecten');
  // de kleur volgt de accentkleur (geen eigen kleuren in het diagram)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.bar-fill')).fill`), await evaluate(`getComputedStyle(document.querySelector('.stat-meter-fill')).backgroundColor`));
  // 4 of 12 weken, onthouden op dit apparaat
  await click('[data-fk="stats-weeks-4"]');
  await waitFor(`document.querySelectorAll('.chart')[1].querySelectorAll('.bar').length === 4`, 'vier weken');
  assert.equal(await evaluate(`localStorage.getItem('tickory.productivityWeeks')`), '4');
  assert.equal(await evaluate(`document.querySelector('[data-fk="stats-weeks-4"]').getAttribute('aria-pressed')`), 'true');
  await shot('productiviteit');
  step('productiviteit: het scherm met tegels, de laatste 7 dagen en 12 (of 4) weken als diagram met een verborgen tabel, dagnamen in het Nederlands, per project, kleuren uit de accentkleur');

  // ---- doelen: via de sync naar de server ----
  await evaluate(`(() => { const i = document.getElementById('goal-daily'); i.focus(); i.value = '2'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`await ${SYNCED}`, 'doel opgeslagen');
  assert.equal(settings().goal_daily, 2, 'het dagdoel staat op de server');
  await evaluate(`document.activeElement.blur()`);
  await waitFor(`document.querySelector('.stat-value').textContent === ${js(`${before + 2}/2`)}`, 'de tegel volgt het nieuwe doel');
  assert.equal(await evaluate(`document.querySelectorAll('.stat-sub')[0].textContent`), 'Doel gehaald');
  await evaluate(`(() => { const i = document.getElementById('goal-weekly'); i.value = '701'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await evaluate(`document.getElementById('goal-weekly').getAttribute('aria-invalid')`), 'true');
  assert.equal(await evaluate(`document.getElementById('goal-weekly-hint').textContent`), 'Kies een heel getal van 0 tot 700.');
  assert.equal(settings().goal_weekly, null, 'een ongeldig doel gaat niet naar de server');
  await evaluate(`(() => { const i = document.getElementById('goal-weekly'); i.value = '0'; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`await ${SYNCED}`, 'weekdoel uit');
  assert.equal(settings().goal_weekly, 0);
  await waitFor(`document.querySelectorAll('.stat-value')[3].textContent === '–'`, 'geen weekreeks zonder weekdoel');
  // vrije dagen: maandag erbij; alle zeven kan niet
  await click('[data-fk="day-off-1"]');
  await waitFor(`await ${SYNCED}`, 'maandag vrij');
  assert.deepEqual(settings().days_off, [1, 6, 7]);
  for (const day of [2, 3, 4]) await click(`[data-fk="day-off-${day}"]`); // snel na elkaar
  await waitFor(`await ${SYNCED}`, 'zes vrije dagen');
  await waitFor(`[2, 3, 4].every((d) => document.querySelector('[data-fk="day-off-' + d + '"]').checked)`, 'dinsdag tot en met donderdag vrij');
  await click('[data-fk="day-off-5"]');
  await waitFor(`document.getElementById('days-off-hint').textContent === 'Er moet minstens één dag overblijven die meetelt.'`, 'melding bij zeven vrije dagen');
  assert.equal(await evaluate(`document.querySelector('[data-fk="day-off-5"]').checked`), false, 'vrijdag blijft een werkdag');
  assert.deepEqual(settings().days_off, [1, 2, 3, 4, 6, 7]);
  // terug naar de standaard (via een ander apparaat): het scherm volgt
  await as(aliceToken, [['settings_update', { id: `settings-${alice.id}`, goal_daily: null, goal_weekly: null, days_off: null }]]);
  await waitFor(`document.getElementById('goal-daily').value === '5' && document.getElementById('goal-weekly').value === '25' && document.querySelector('[data-fk="day-off-6"]').checked && !document.querySelector('[data-fk="day-off-1"]').checked`, 'standaarddoelen terug', 10_000);
  step('productiviteit: dag- en weekdoel en vrije dagen gaan via de sync naar de server (en terug); een ongeldig doel en zeven vrije dagen worden geweigerd met een melding');

  // ---- zonder server: het laatste overzicht blijft staan ----
  await stopServer();
  await click('[data-fk="productivity-refresh"]');
  await waitFor(`document.querySelector('.stats-status').textContent.startsWith('Geen verbinding. Dit is het overzicht van')`, 'zonder verbinding: het laatste overzicht', 10_000);
  assert.equal(await evaluate(`document.querySelectorAll('.stat-tile').length`), 4, 'de tegels blijven staan');
  assert.ok(await evaluate(`Boolean(JSON.parse(localStorage.getItem('tickory.stats')).data.per_day)`), 'het laatste antwoord is bewaard');
  await startServer();
  await click('[data-fk="productivity-refresh"]');
  await waitFor(`document.querySelector('.stats-status').textContent.startsWith('Bijgewerkt')`, 'weer bijgewerkt', 10_000);
  step('productiviteit: zonder server blijft het laatste overzicht staan (bewaard op het apparaat), met wanneer het is bijgewerkt');

  // ---- telefoon en donker ----
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  assert.equal(await evaluate(`document.documentElement.scrollWidth`), 390, 'geen horizontaal scrollen');
  assert.equal(await evaluate(`new Set([...document.querySelectorAll('.stat-tile')].map((e) => Math.round(e.getBoundingClientRect().left))).size`), 1, 'de tegels staan onder elkaar');
  const small = await evaluate<string[]>(`[...document.querySelectorAll('#content button, #content input, .day-toggle span[aria-hidden], .view-actions button')].filter((e) => e.offsetParent !== null && !(e.type === 'checkbox')).map((e) => { const r = e.getBoundingClientRect(); return r.height < 44 ? (e.dataset.fk || e.textContent || e.className) + ' ' + Math.round(r.height) : null; }).filter(Boolean)`);
  assert.deepEqual(small, [], 'tikvlakken van minstens 44 px');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  await shot('productiviteit-telefoon-donker');
  const accent = await evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  assert.equal(accent, '#2dd4bf', 'donker: de donkere accentkleur');
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  step('productiviteit: op een telefoon alles onder elkaar met tikvlakken van 44 px, zonder zijwaarts scrollen; in het donker de donkere tokens');

  // ---- via Instellingen ----
  await nav('Vandaag');
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
  await clickText('Productiviteit', `document.querySelector('dialog[open]')`);
  await waitFor(`document.getElementById('view-title').textContent === 'Productiviteit'`, 'Productiviteit via Instellingen');
  assert.equal(await evaluate(`[...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Productiviteit')`), false, 'geen eigen regel in de zijbalk');
  await click('[data-fk="productivity-completed"]');
  await waitFor(`document.getElementById('view-title').textContent === 'Voltooid'`, 'terug naar Voltooid');
  await evaluate(`localStorage.removeItem('tickory.productivityWeeks')`);
  // opruimen voor de rest van de test: de taken weg (de afvinkingen blijven in het logboek en tellen dus nog)
  const counted = todayOnServer();
  await as(aliceToken, [['task_delete', { id: 'e2eprodtask00001' }], ['task_delete', { id: 'e2eprodtask00003' }]]);
  await as(bobToken, [['task_delete', { id: 'e2eprodtask00002' }]]);
  assert.equal(todayOnServer(), counted, 'een verwijderde taak neemt haar afvinking niet mee');
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
  step('productiviteit: ook via Instellingen te openen, zonder eigen regel in de zijbalk, met een knop terug naar Voltooid');
}
