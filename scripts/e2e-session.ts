// "Onthoud mij" en meldingen over een nieuwe versie, in een echte browser.
//   - Inloggen zonder "Onthoud mij": het token staat niet in localStorage maar in een sessiecookie, en de server maakt een korte
//     sessie. De browser sluit (de cookie is weg) en opent de app opnieuw: inlogscherm, en de gegevens op dit apparaat zijn gewist.
//   - Een nieuwere release (een nagebootste controle op de server, geen GitHub): de beheerder krijgt één keer een melding en ziet
//     bovenaan Instellingen een regel met uitleg over bijwerken.
// Wordt aangeroepen vanuit scripts/e2e.ts.

import assert from 'node:assert/strict';

export async function sessionScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, db, alice, typeInto, submit, click, clickText, nav, PASSWORD_ALICE, SYNCED, startServer, stopServer } = c;
  const rows = () => evaluate<number>(`new Promise((res, rej) => { const r = indexedDB.open('tickory'); r.onsuccess = () => { const tx = r.result.transaction(['rows'], 'readonly'); const a = tx.objectStore('rows').count(); tx.oncomplete = () => res(a.result); }; r.onerror = () => rej(r.error); })`);
  const login = async (remember: boolean) => {
    await waitFor(`document.querySelector('dialog[open] input[type=password]')`, 'het inlogscherm');
    assert.equal(await evaluate(`document.querySelector('dialog[open] [data-fk="login-remember"]').checked`), true, '"Onthoud mij" staat standaard aan');
    if (!remember) await evaluate(`document.querySelector('dialog[open] [data-fk="login-remember"]').click()`);
    if (!remember) await shot('inloggen-onthoud-mij');
    await typeInto('dialog[open] input[autocomplete=username]', 'alice');
    await typeInto('dialog[open] input[type=password]', PASSWORD_ALICE);
    await submit('dialog[open] form');
    await waitFor(`!document.querySelector('dialog[open]') && await ${SYNCED}`, 'ingelogd', 20_000);
    await waitFor(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Thuis')`, 'de gegevens zijn er');
  };
  const logout = async () => {
    await nav('Alice');
    await waitFor(`document.querySelector('dialog[open] .settings-menu')`, 'instellingenmenu');
    await clickText('Afmelden en lokale gegevens wissen');
    await waitFor(`[...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent === 'Afmelden')`, 'bevestiging');
    await clickText('Afmelden', `document.querySelector('dialog[open]')`);
  };

  // ---- inloggen zonder "Onthoud mij" ----
  await logout();
  await login(false);
  assert.equal(await evaluate(`localStorage.getItem('tickory.token')`), null, 'niet blijvend bewaard');
  assert.match(await evaluate<string>(`document.cookie`), /tickory_session=tky_/, 'in een sessiecookie');
  assert.equal(await evaluate(`localStorage.getItem('tickory.forget')`), '1');
  const newest = db.prepare('SELECT short FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(alice.id) as any;
  assert.equal(newest.short, 1, 'een korte sessie op de server');
  assert.ok((await rows()) > 0, 'de app werkt gewoon, met de gegevens op het apparaat');
  // de browser sluit: de sessiecookie verdwijnt; daarna de app weer openen
  await evaluate(`document.cookie = 'tickory_session=; Max-Age=0; path=/'`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready') && document.querySelector('dialog[open] input[type=password]')`, 'het inlogscherm na het sluiten van de browser', 15_000);
  assert.equal(await rows(), 0, 'de gegevens op dit apparaat zijn gewist');
  assert.equal(await evaluate(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Thuis')`), false);
  assert.equal(await evaluate(`localStorage.getItem('tickory.forget')`), null);
  // en weer gewoon inloggen (onthouden)
  await login(true);
  assert.match(await evaluate<string>(`localStorage.getItem('tickory.token')`), /^tky_/);
  assert.equal(/tickory_session=/.test(await evaluate<string>(`document.cookie`)), false, 'geen cookie meer');
  step('"Onthoud mij" uit: token alleen in een sessiecookie en een korte sessie op de server; na het sluiten van de browser het inlogscherm en de gegevens op het apparaat gewist; daarna weer gewoon inloggen');

  // ---- een nieuwere release (nagebootst op de server) ----
  const latest = { version: '9.9.0', url: 'https://github.com/WNijhof/tickory/releases/tag/v9.9.0', published_at: null, apk_url: null };
  const fake = { check: async () => {}, status: () => ({ version: '0.3.0', latest, update_available: true, checked_at: new Date().toISOString(), enabled: true }) };
  await evaluate(`localStorage.removeItem('tickory.updateSeen.server')`);
  await stopServer();
  await startServer({ updateCheck: fake, updateCheckMs: 0 });
  await send('Page.reload');
  await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent === 'Tickory 9.9.0 is uit (deze server draait 0.3.0).')`, 'een melding voor de beheerder', 20_000);
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .settings-menu')`, 'instellingenmenu');
  const first = await evaluate<string>(`document.querySelector('dialog[open] .settings-row')?.textContent ?? ''`);
  assert.equal(first, 'Nieuwe versie van Tickory: 9.9.0', 'bovenaan Instellingen');
  await clickText('Nieuwe versie van Tickory: 9.9.0', `document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('docker compose pull')`, 'uitleg over bijwerken');
  assert.ok(await evaluate(`[...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent === 'Wat is er nieuw')`));
  await clickText('Annuleren', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  // nog eens openen: geen tweede melding voor dezelfde versie, de regel in Instellingen blijft
  await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready')`, 'weer geladen', 15_000);
  await click('#sync-status');
  await waitFor(SYNCED, 'weer bijgewerkt', 30_000);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await evaluate(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent.startsWith('Tickory 9.9.0'))`), false, 'geen tweede melding');
  await stopServer();
  await startServer();
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready')`, 'terug bij de gewone server', 15_000);
  await click('#sync-status');
  await waitFor(SYNCED, 'bijgewerkt bij de gewone server', 30_000);
  step('een nieuwere release: de beheerder krijgt één keer een melding en bovenaan Instellingen een regel met uitleg over bijwerken (de server vraagt GitHub; hier nagebootst)');
}
