// Meldingen bij samenwerken en @-vermeldingen in een echte browser: Bob wijst Alice een taak toe, noemt haar en reageert; Alice
// ziet het aantal in de zijbalk, de lijst Meldingen, opent een melding (gelezen, het taakvenster gaat open), zet er een terug op
// ongelezen, en "Alles gelezen". Daarna noemt Alice Bob met de keuzelijst (toetsenbord, Nederlandse naam met accent), kiest welke
// soorten als pushmelding komen, en een melding verdwijnt als Bob haar uit zijn project haalt. Ook op een telefoon (het belletje in de
// kop) en in het donker. Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties van die test komen binnen via `c`.

import assert from 'node:assert/strict';
import { createSession, createUser } from '../server/users.ts';

export async function notifyScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, sleep, SYNCED, db, alice, bob, syncAs, serverState, typeInto, click, clickText, nav } = c;
  /** Een toetsaanslag via het DevTools-protocol, zoals een echt toetsenbord. */
  const press = async (key: string, options: { ctrl?: boolean } = {}) => {
    const named: Record<string, [string, number]> = { Enter: ['Enter', 13], Escape: ['Escape', 27], ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38] };
    const [code, vk] = named[key];
    const modifiers = options.ctrl ? 2 : 0;
    const text = key === 'Enter' && !options.ctrl ? '\r' : undefined;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, text });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const aliceToken = createSession(db, alice.id, 'Controle meldingen').token;
  const bobToken = createSession(db, bob.id, 'Bob meldingen').token;
  const zoe = createUser(db, { username: 'zoe', name: 'Zoë', passwordHash: 'x' }); // een Nederlandse naam met een accent
  let k = 0;
  const as = async (token: string, commands: [string, object][]) => {
    const res = await syncAs(token, 'e2e-meldingen', commands.map(([type, args]) => ({ type, uuid: `e2e-notify-${String(++k).padStart(5, '0')}`, args })));
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const [uuid, s] of Object.entries(body.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
    return body;
  };
  const P = 'e2enotifyproj0001', T = 'e2enotifytask0001';
  const navCount = () => evaluate<string | null>(`document.querySelector('[data-fk="nav-notifications"] .nav-count')?.textContent ?? null`);
  const sentences = () => evaluate<string[]>(`[...document.querySelectorAll('.inbox-item .inbox-sentence')].map((e) => e.textContent)`);
  const unreadOnServer = () => (serverState().notifications as any[]).filter((n) => !n.is_read).length;

  // ---- klaarzetten: een project van Alice, gedeeld met Bob en Zoë; alles wat er al was, gelezen ----
  await as(aliceToken, [
    ['project_add', { id: P, name: 'Klussen' }], ['project_share', { project_id: P, username: 'bob' }], ['project_share', { project_id: P, username: 'zoe' }],
    ['task_add', { id: T, project_id: P, content: 'Schuur verven' }], ['notification_read_all', {}],
  ]);
  await waitFor(`[...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Klussen')`, 'het project Klussen in de zijbalk', 8000);
  await waitFor(`document.querySelector('[data-fk="nav-notifications"]') && !document.querySelector('[data-fk="nav-notifications"] .nav-count')`, 'Meldingen in de zijbalk, niets ongelezen');

  // ---- Bob doet iets: toewijzen, Alice noemen, een opmerking bij het project ----
  await as(bobToken, [['task_update', { id: T, assignee_id: alice.id }]]);
  await sleep(20);
  await as(bobToken, [['comment_add', { id: 'e2enotifycomm0001', task_id: T, content: '@Alice, welke kleur wordt het?', mentions: [alice.id] }]]);
  await sleep(20);
  await as(bobToken, [['comment_add', { id: 'e2enotifycomm0002', project_id: P, content: 'De verf ligt in de garage.' }]]);
  await waitFor(`document.querySelector('[data-fk="nav-notifications"] .nav-count')?.textContent === '3'`, 'drie ongelezen meldingen in de zijbalk, zonder herladen', 8000);
  assert.equal(await evaluate(`document.querySelector('[data-fk="nav-notifications"]').getAttribute('aria-label')`), 'Meldingen, 3 ongelezen');
  await nav('Meldingen');
  await waitFor(`document.getElementById('view-title').textContent === 'Meldingen'`, 'het scherm Meldingen');
  assert.deepEqual(await sentences(), ['Ongelezen: Bob schreef een opmerking bij het project', 'Ongelezen: Bob noemde je in een opmerking', 'Ongelezen: Bob heeft je een taak toegewezen']);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.inbox-item .inbox-title')].map((e) => e.textContent)`), ['Klussen', 'Schuur verven · Klussen', 'Schuur verven · Klussen']);
  assert.equal(await evaluate(`document.querySelector('.inbox-item[data-kind="mention"] .inbox-excerpt').textContent`), '@Alice, welke kleur wordt het?');
  assert.equal(await evaluate(`document.querySelector('.inbox-item[data-kind="mention"] .inbox-excerpt .mention').textContent`), '@Alice', 'de vermelding is gemarkeerd');
  assert.equal(await evaluate(`document.querySelector('.inbox-count').textContent`), '3 ongelezen meldingen');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#view-actions button')].map((b) => b.textContent)`), ['Alles gelezen']);
  await shot('meldingen-lijst');

  // ---- een melding openen: gelezen, en het taakvenster met de opmerking (vermelding gemarkeerd) ----
  await click('.inbox-item[data-kind="mention"] .inbox-open');
  await waitFor(`document.querySelector('#task-dialog[open]')`, 'het taakvenster van de genoemde taak');
  assert.equal(await evaluate(`document.querySelector('#task-dialog textarea[aria-label="Taak"]').value`), 'Schuur verven');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comment-text .mention')?.textContent`), '@Alice');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(unreadOnServer(), 2, 'op de server gelezen');

  // ---- @-vermelding met de keuzelijst: alleen met het toetsenbord, een naam met accent ----
  await typeInto('#task-dialog .comment-input', 'Wit, @zo');
  await waitFor(`document.querySelector('#task-dialog .mention-list:not([hidden]) [role="option"]')`, 'de keuzelijst met leden');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .mention-list [role="option"]')].map((o) => [o.querySelector('.mention-name').textContent, o.querySelector('.mention-username').textContent])`), [['Zoë', '@zoe']], '"zo" vindt Zoë');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comment-input').getAttribute('aria-expanded')`), 'true');
  assert.equal(await evaluate(`document.querySelector('#task-dialog .comment-input').getAttribute('aria-activedescendant')`), await evaluate(`document.querySelector('#task-dialog .mention-list [role="option"]').id`));
  await press('Escape');
  await waitFor(`document.querySelector('#task-dialog .mention-list').hidden`, 'Escape sluit alleen de lijst');
  assert.ok(await evaluate(`Boolean(document.querySelector('#task-dialog[open]'))`), 'het taakvenster staat nog open');
  await typeInto('#task-dialog .comment-input', 'Wit, @');
  await waitFor(`document.querySelectorAll('#task-dialog .mention-list [role="option"]').length === 2`, 'zonder tekst: alle leden behalve jezelf');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog .mention-list .mention-name')].map((e) => e.textContent)`), ['Bob', 'Zoë']);
  await evaluate(`document.querySelector('#task-dialog .comment-input').scrollIntoView({ block: 'center' })`);
  await shot('meldingen-keuzelijst');
  await press('ArrowDown');
  await press('ArrowUp');
  await press('Enter');
  await waitFor(`document.querySelector('#task-dialog .comment-input').value === 'Wit, @Bob '`, 'de naam is ingevoegd');
  await evaluate(`(() => { const el = document.querySelector('#task-dialog .comment-input'); el.value += 'kun jij verf halen?'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await press('Enter', { ctrl: true });
  await waitFor(`[...document.querySelectorAll('#task-dialog .comment-text')].some((e) => e.textContent === 'Wit, @Bob kun jij verf halen?')`, 'de opmerking staat er');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const posted = (serverState().comments as any[]).find((x) => x.content === 'Wit, @Bob kun jij verf halen?');
  assert.deepEqual(posted.mentions, [bob.id], 'de server kent de vermelding');
  assert.ok((serverState(bob.id).notifications as any[]).some((n) => n.kind === 'mention' && n.comment_id === posted.id && n.actor_id === alice.id), 'Bob krijgt een melding');
  assert.ok(!(serverState(zoe.id).notifications as any[]).some((n) => n.comment_id === posted.id), 'Zoë niet: zij is niet genoemd en had er niets mee te maken');
  await shot('meldingen-vermelding');
  await clickText('Annuleren', `document.querySelector('#task-dialog')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'taakvenster dicht');

  // ---- gelezen en ongelezen per melding, en alles gelezen ----
  await waitFor(`document.querySelectorAll('.inbox-item.unread').length === 2`, 'nog twee ongelezen');
  await click('.inbox-item[data-kind="mention"] .inbox-toggle');
  await waitFor(`document.querySelector('.inbox-item[data-kind="mention"]').classList.contains('unread')`, 'weer ongelezen');
  assert.equal(await navCount(), '3');
  await clickText('Alles gelezen');
  await waitFor(`document.querySelectorAll('.inbox-item.unread').length === 0 && !document.querySelector('[data-fk="nav-notifications"] .nav-count')`, 'alles gelezen');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(unreadOnServer(), 0);
  step('meldingen: toewijzen, een vermelding en een projectopmerking van Bob komen vanzelf binnen (aantal in de zijbalk), de lijst toont wie, wat en waar, openen zet gelezen en opent de taak; @ geeft een keuzelijst met de leden (toetsenbord, "zo" vindt Zoë), de server bewaart de vermelding en Bob krijgt een melding; gelezen en ongelezen per melding en "Alles gelezen"');

  // ---- welke soorten als pushmelding ----
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
  await clickText('Herinneringen en meldingen');
  await waitFor(`document.querySelector('dialog[open] [data-role="push-kinds"]')`, 'het stuk Meldingen bij samenwerken');
  const boxes = () => evaluate<[string, boolean][]>(`[...document.querySelectorAll('dialog[open] [data-role="push-kinds"] label')].map((l) => [l.textContent, l.querySelector('input').checked])`);
  assert.deepEqual(await boxes(), [['Een taak aan mij toegewezen', true], ['Opmerkingen bij mijn taken en projecten', true], ['Iemand noemt mij (@)', true], ['Mijn taak is afgevinkt', false], ['Toegevoegd aan een project', true]], 'standaard alles aan behalve afgevinkt');
  await click('dialog[open] [data-role="push-kinds"] input[data-kind="completed"]');
  await click('dialog[open] [data-role="push-kinds"] input[data-kind="comment"]');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const mine = (serverState().settings as any[]).find((s) => s.owner_id === alice.id);
  assert.deepEqual(mine.notify_push, { assigned: true, comment: false, mention: true, completed: true, shared: true });
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'scherm gesloten');

  // ---- een project van Bob: hij wijst Alice iets toe en haalt haar er daarna uit; de melding verdwijnt met het project ----
  const Q = 'e2enotifyproj0002';
  await as(bobToken, [['project_add', { id: Q, name: 'Bobs feest' }], ['project_share', { project_id: Q, username: 'alice' }], ['task_add', { id: 'e2enotifytask0002', project_id: Q, content: 'Taart bakken', assignee_id: alice.id }]]);
  await waitFor(`document.querySelector('[data-fk="nav-notifications"] .nav-count')?.textContent === '2'`, 'twee nieuwe: toegevoegd aan Bobs feest en een taak', 8000);
  assert.deepEqual((await sentences()).slice(0, 2).sort(), ['Ongelezen: Bob heeft je een taak toegewezen', 'Ongelezen: Bob heeft je toegevoegd aan een project']);
  await as(bobToken, [['project_unshare', { project_id: Q, user_id: alice.id }]]);
  await waitFor(`!document.querySelector('[data-fk="nav-notifications"] .nav-count') && ![...document.querySelectorAll('.inbox-title')].some((e) => e.textContent.includes('Bobs feest') || e.textContent.includes('Taart'))`, 'de meldingen over Bobs feest zijn weg', 8000);
  step('meldingen: per soort kiezen of het als pushmelding komt (standaard alles behalve "afgevinkt", bewaard op de server); wie uit een project wordt gehaald, houdt er geen meldingen over');

  // ---- op een telefoon: het belletje in de kop, en in het donker ----
  await as(bobToken, [['comment_add', { id: 'e2enotifycomm0003', task_id: T, content: 'Is de schuur al droog?' }]]);
  await nav('Vandaag');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await waitFor(`getComputedStyle(document.querySelector('.inbox-bell')).display !== 'none' && document.querySelector('.inbox-bell .inbox-badge').textContent === '1'`, 'het belletje met het aantal in de kop', 8000);
  assert.equal(await evaluate(`document.querySelector('.inbox-bell').getAttribute('aria-label')`), 'Meldingen, 1 ongelezen');
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), 'niets steekt buiten het scherm');
  await click('.inbox-bell');
  await waitFor(`document.getElementById('view-title').textContent === 'Meldingen'`, 'het belletje opent Meldingen');
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), 'de lijst past op een telefoon');
  await shot('meldingen-telefoon');
  const background = () => evaluate<string>(`getComputedStyle(document.body).backgroundColor`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(150);
  assert.equal(await background(), 'rgb(255, 255, 255)', 'licht');
  await shot('meldingen-licht');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(150);
  assert.notEqual(await background(), 'rgb(255, 255, 255)', 'in het donker is de achtergrond donker');
  await shot('meldingen-donker');
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await clickText('Alles gelezen');
  await waitFor(SYNCED, 'gesynchroniseerd');
  // ---- een pushmelding of de Android-app opent een melding via het adres ----
  const last = (serverState().notifications as any[]).find((n) => n.comment_id === 'e2enotifycomm0003');
  await as(aliceToken, [['notification_update', { id: last.id, is_read: false }]]);
  await waitFor(`document.querySelector('.inbox-item.unread')`, 'weer ongelezen', 8000);
  await evaluate(`location.hash = '#notification=${last.id}'`);
  await waitFor(`document.querySelector('#task-dialog[open]')`, '#notification= opent de taak');
  assert.equal(await evaluate(`location.hash`), '', 'het adres is weer schoon');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal((serverState().notifications as any[]).find((n) => n.id === last.id).is_read, true, 'en zet hem op gelezen');
  await clickText('Annuleren', `document.querySelector('#task-dialog')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'taakvenster dicht');
  await nav('Vandaag');
  step('meldingen op een telefoon: een belletje met het aantal in de kop opent de lijst, alles past op het scherm, ook in het donker; #notification=<id> (van een pushmelding of de Android-app) opent de melding en zet hem op gelezen');
}
