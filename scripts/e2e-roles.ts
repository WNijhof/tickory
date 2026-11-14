// Rollen en activiteit in een echte browser. Bob deelt een project met Alice als lezer: Alice ziet alles, met een balk "alleen
// lezen", zonder rondjes om af te vinken, zonder "Taak toevoegen", zonder snelle knoppen en zonder slepen; het taakvenster is om te
// lezen, maar reageren werkt. Het projectmenu heeft "Activiteit": per dag wie wat deed, met een filter en een link naar de taak.
// Bob maakt Alice daarna lid (kan bewerken) en alles werkt weer. In haar eigen project zet Alice met de keuzelijst in het
// deelvenster Bob op "alleen lezen". Ook op een telefoon en in het donker. Wordt aangeroepen vanuit scripts/e2e.ts.

import assert from 'node:assert/strict';
import { createSession } from '../server/users.ts';

export async function rolesScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, db, alice, bob, syncAs, serverState, click, clickText, nav, openTask, noDialog, buttons, texts } = c;
  const bobToken = createSession(db, bob.id, 'Bob rollen').token;
  const aliceToken = createSession(db, alice.id, 'Controle rollen').token;
  let k = 0;
  const as = async (token: string, commands: [string, object][]) => {
    const res = await syncAs(token, 'e2e-rollen', commands.map(([type, args]) => ({ type, uuid: `e2e-roles-${String(++k).padStart(5, '0')}`, args })));
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const [uuid, s] of Object.entries(body.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
    return body;
  };
  const P = 'e2erolesproj00001', S = 'e2erolessect00001', T1 = 'e2erolestask00001', T2 = 'e2erolestask00002', Q = 'e2erolesproj00002';
  const startView = await evaluate<string>(`document.getElementById('view-title').textContent`);
  const closeToasts = () => evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  const toastTexts = () => evaluate<string[]>(`[...document.querySelectorAll('.toast-text')].map((e) => e.textContent)`);

  // ---- Bob deelt Familieweekend met Alice als lezer ----
  await as(bobToken, [
    ['project_add', { id: P, name: 'Familieweekend' }], ['section_add', { id: S, project_id: P, name: 'Regelen' }],
    ['task_add', { id: T1, project_id: P, section_id: S, content: 'Huisje boeken', due: { date: '2030-03-01' } }],
    ['task_add', { id: T2, project_id: P, content: 'Spelletjes inpakken' }],
    ['task_add', { project_id: P, parent_id: T1, content: 'Aanbetaling doen' }],
    ['project_share', { project_id: P, username: 'alice', role: 'viewer' }],
  ]);
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Familieweekend')`, 'het gedeelde project verschijnt bij Alice', 8000);
  await closeToasts();
  await nav('Familieweekend');
  await waitFor(`document.getElementById('view-title').textContent === 'Familieweekend'`, 'Familieweekend open');
  assert.ok(await evaluate(`Boolean(document.querySelector('[data-fk="readonly-banner"]'))`), 'de balk "alleen lezen" staat boven het project');
  assert.equal(await evaluate(`document.querySelector('#sidebar .nav-readonly')?.getAttribute('aria-label')`), 'Je kunt dit project alleen lezen', 'een oog in de zijbalk');
  assert.equal(await evaluate(`document.querySelectorAll('#content .add-inline').length`), 0, 'geen "Taak toevoegen"');
  assert.equal(await evaluate(`[...document.querySelectorAll('#content button')].some((b) => b.textContent.includes('Sectie toevoegen'))`), false, 'geen "Sectie toevoegen"');
  assert.equal(await evaluate(`document.querySelectorAll('#content .group-more, #content .group-toggle, #content .drag-handle, #content .sel-box').length`), 0, 'geen sectiemenu, inklappen, handvat of keuzevakje');
  assert.deepEqual(await buttons('.view-actions'), ['Opmerkingen', 'Leden bekijken', 'Project…'], 'geen keuze van de weergave');
  assert.ok(await evaluate(`[...document.querySelectorAll('#content li.task')].every((li) => li.classList.contains('task-readonly') && li.querySelector('.check').getAttribute('aria-disabled') === 'true')`));
  assert.equal(await evaluate(`[...document.querySelectorAll('#content .task-title')].map((e) => e.textContent).includes('Aanbetaling doen')`), true, 'subtaken staan uitgeklapt');
  // aanwijzen geeft geen snelle knoppen; het rondje zegt dat afvinken niet kan, en er verandert niets
  await evaluate(`document.querySelector('#content li.task').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  assert.equal(await evaluate(`document.querySelectorAll('#content .task-actions').length`), 0, 'geen snelle knoppen');
  await click('#content li.task .check');
  await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent.startsWith('Je kunt dit project alleen lezen'))`, 'melding dat afvinken niet kan');
  await sleep(300);
  assert.equal((serverState().tasks as any[]).filter((t) => t.project_id === P && t.checked).length, 0, 'niets afgevinkt op de server');
  assert.equal((await toastTexts()).some((x: string) => /lukte niet/.test(x)), false, 'er ging ook geen geweigerd commando naar de server');
  await closeToasts();
  // slepen met het toetsenbord: zegt dat het niet kan
  await evaluate(`document.querySelector('#content li.task .task-body').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 1 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 1 });
  await waitFor(`document.getElementById('dnd-live').textContent.includes('alleen leest')`, 'Alt+pijl meldt dat verplaatsen niet kan');
  step('lezer: het gedeelde project met een balk "alleen lezen", een oog in de zijbalk, geen toevoegen, snelle knoppen, slepen, kiezen of weergavekeuze, en afvinken zegt dat het niet kan');

  // ---- het taakvenster om te lezen, met reageren ----
  await openTask('Huisje boeken');
  assert.ok(await evaluate(`Boolean(document.querySelector('#task-dialog [data-fk="task-readonly"]'))`), 'het venster zegt dat je alleen kunt lezen');
  assert.equal(await evaluate(`document.querySelector('#task-dialog h2').textContent`), 'Taak bekijken');
  assert.deepEqual(await evaluate(`[document.querySelector('#task-dialog .task-title-input').readOnly, document.querySelector('#task-dialog .check-large').disabled, document.querySelector('#task-dialog .subtask-row') === null]`), [true, true, true]);
  assert.equal(await evaluate(`[...document.querySelectorAll('#task-dialog .dialog-buttons button')].map((b) => b.textContent.trim()).join('|')`), 'Als sjabloon bewaren|Sluiten', 'geen Opslaan of Verwijderen');
  await evaluate(`(() => { const t = document.querySelector('#task-dialog .comment-form textarea'); t.focus(); t.value = 'Zal ik de spelletjes meenemen?'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('#task-dialog .comment-form .button-primary');
  await waitFor(`document.querySelectorAll('#task-dialog .comment').length === 1 && await ${SYNCED}`, 'de opmerking van de lezer is geplaatst');
  assert.equal((serverState().comments as any[]).filter((x) => x.task_id === T1 && x.author_id === alice.id).length, 1);
  await shot('rollen-taakvenster-lezer');
  await clickText('Sluiten', `document.querySelector('#task-dialog')`);
  await noDialog();
  step('lezer: het taakvenster toont alles om te lezen (geen Opslaan, Verwijderen, subtaak toevoegen of afvinken), en reageren werkt');

  // ---- het projectmenu en Activiteit ----
  await clickText('Project…');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu van de lezer');
  assert.deepEqual(await buttons(), ['Opslaan als sjabloon…', 'Voltooide taken bekijken', 'Activiteit', 'Leden bekijken', 'Project verlaten', 'Sluiten']);
  await clickText('Activiteit', `document.querySelector('dialog[open]')`);
  await waitFor(`document.getElementById('view-title').textContent === 'Activiteit: Familieweekend' && document.querySelectorAll('.activity-item').length >= 6`, 'het scherm Activiteit');
  const sentences = await texts('.activity-sentence');
  assert.equal(sentences[0], 'Alice heeft gereageerd op een taak', 'de nieuwste bovenaan');
  for (const s of ['Bob heeft een taak toegevoegd', 'Bob heeft een sectie toegevoegd', 'Bob heeft Alice toegevoegd (alleen lezen)', 'Bob heeft het project gemaakt']) assert.ok(sentences.includes(s), `"${s}" staat erin: ${JSON.stringify(sentences)}`);
  assert.equal(await evaluate(`document.querySelectorAll('.activity-day h2').length`), 1, 'alles van vandaag, onder één kop');
  await evaluate(`(() => { const s = document.querySelector('[data-fk="activity-filter"]'); s.value = 'members'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`[...document.querySelectorAll('.activity-sentence')].map((e) => e.textContent).join('|') === 'Bob heeft Alice toegevoegd (alleen lezen)'`, 'het filter Leden');
  await evaluate(`(() => { const s = document.querySelector('[data-fk="activity-filter"]'); s.value = 'all'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`document.querySelectorAll('.activity-item').length >= 6`, 'weer alles');
  await evaluate(`[...document.querySelectorAll('.activity-title')].find((b) => b.tagName === 'BUTTON' && b.textContent === 'Huisje boeken').click()`);
  await waitFor(`document.querySelector('#task-dialog h2')?.textContent === 'Taak bekijken'`, 'de link opent de taak');
  await clickText('Sluiten', `document.querySelector('#task-dialog')`);
  await noDialog();
  // Bob doet iets terwijl Alice kijkt: het komt vanzelf binnen
  await as(bobToken, [['task_complete', { id: T2 }]]);
  await waitFor(`document.querySelector('.activity-sentence')?.textContent === 'Bob heeft een taak afgevinkt'`, 'een nieuwe regel komt vanzelf binnen', 12_000);
  await shot('rollen-activiteit');
  step('activiteit: het projectmenu van een lezer, de lijst per dag met wie wat deed, het filter op leden, de link naar de taak, en nieuwe activiteit komt vanzelf binnen');

  // ---- op een telefoon en in het donker ----
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`), true, 'geen horizontale schuifbalk op een telefoon');
  await shot('rollen-activiteit-telefoon-donker');
  await send('Emulation.clearDeviceMetricsOverride', {});
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await click('[data-fk="activity-back"]');
  await waitFor(`document.getElementById('view-title').textContent === 'Familieweekend'`, 'terug naar het project');

  // ---- Bob maakt Alice lid: alles werkt weer ----
  await as(bobToken, [['member_update', { project_id: P, user_id: alice.id, role: 'member' }]]);
  await waitFor(`!document.querySelector('[data-fk="readonly-banner"]') && document.querySelectorAll('#content .add-inline').length > 0`, 'Alice kan nu bewerken', 8000);
  await click('#content li.task .check');
  await sleep(400);
  await waitFor(`await ${SYNCED}`, 'afgevinkt en gesynchroniseerd');
  assert.ok((serverState().tasks as any[]).some((t) => t.project_id === P && t.checked && t.content !== 'Spelletjes inpakken'), 'als lid vinkt Alice af');
  await closeToasts();
  step('rol wijzigen: Bob maakt Alice lid (member_update), de balk verdwijnt en afvinken werkt meteen');

  // ---- Alice zet Bob in haar eigen project op "alleen lezen" via het deelvenster ----
  await as(aliceToken, [['project_add', { id: Q, name: 'Moestuin' }], ['project_share', { project_id: Q, username: 'bob' }], ['task_add', { project_id: Q, content: 'Tomaten zaaien', assignee_id: bob.id }]]);
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Moestuin')`, 'Moestuin bij Alice', 8000);
  await nav('Moestuin');
  await waitFor(`document.getElementById('view-title').textContent === 'Moestuin'`, 'Moestuin open');
  await clickText('Gedeeld');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Delen: Moestuin'`, 'het deelvenster');
  assert.deepEqual(await texts('dialog[open] .device-info .hint'), ['@alice · eigenaar', '@bob · kan bewerken']);
  assert.deepEqual((await evaluate<string[]>(`[...document.querySelectorAll('dialog[open] select.share-role')].map((s) => s.getAttribute('aria-label'))`)).sort(), ['Rol van Bob', 'Rol van de nieuwe persoon']);
  await evaluate(`(() => { const s = document.querySelector('dialog[open] [data-fk^="share-role:"]'); s.value = 'viewer'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`[...document.querySelectorAll('dialog[open] .device-info .hint')].map((e) => e.textContent).includes('@bob · alleen lezen') && await ${SYNCED}`, 'Bob is lezer');
  const bobRole = (serverState().members as any[]).find((m) => m.project_id === Q && m.user_id === bob.id)?.role;
  assert.equal(bobRole, 'viewer');
  assert.equal((serverState().tasks as any[]).find((t) => t.project_id === Q).assignee_id, null, 'een lezer is niet meer toegewezen');
  await shot('rollen-deelvenster');
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await noDialog();
  step('deelvenster: de rol bij elk lid, en de eigenaar zet een lid met de keuzelijst op "alleen lezen" (de toewijzing vervalt)');

  // ---- opruimen: terug waar de test begon ----
  await as(bobToken, [['project_delete', { id: P }]]);
  await as(aliceToken, [['project_delete', { id: Q }]]);
  await waitFor(`![...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Familieweekend' || e.textContent === 'Moestuin')`, 'de projecten zijn weg', 8000);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
  await closeToasts();
}
