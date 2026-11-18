// Inloggen via SSO in een echte browser, tegen een nagebootste inlogdienst (server/fakeIdp.ts, met een tussenpagina "Doorgaan"):
// koppelen vanuit Account (wachtwoord, naar de inlogdienst en terug, de melding), opnieuw inloggen met de knop "Inloggen met …"
// (dezelfde gebruiker: de gegevens blijven), een onbekende identiteit (een nette melding op het inlogscherm), en de koppeling weer
// verwijderen. Daarna draait de server weer zonder SSO voor de rest van de e2e.
// Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties van die test komen binnen via `c`. Namen en geheimen zijn verzonnen.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startFakeIdp } from '../server/fakeIdp.ts';
import { createOidcClient, oidcConfigFrom } from '../server/oidc.ts';

// Wachttijden op "Bijgewerkt" zijn ruim (45 s): een netwerkfilter op de pc (AdGuard) laat een verzoek soms een tijd hangen, zie scripts/e2e.ts.
export async function oidcScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, sleep, SYNCED, db, alice, typeInto, clickText, nav, PASSWORD_ALICE, BASE, startServer, stopServer } = c;
  const top = `[...document.querySelectorAll('dialog[open]')].at(-1)`;
  const idp = await startFakeIdp({ clientSecret: 'e2e-geheim-van-de-test' });
  idp.interactive = true;
  idp.user = { sub: 'sub-alice-e2e', preferred_username: 'alice', name: 'Alice' };
  const config = oidcConfigFrom({
    OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: 'e2e-geheim-van-de-test', PUBLIC_URL: BASE, OIDC_BUTTON_NAME: 'Nep-inlogdienst',
  })!;
  /** De server opnieuw starten (met of zonder SSO) en de app opnieuw laden: verse verbindingen, en bijgewerkt voordat we verdergaan. */
  const restart = async (extra: object = {}) => {
    await stopServer();
    await startServer(extra);
    await send('Page.reload');
    await waitFor(`document.body.classList.contains('ready') && await ${SYNCED}`, 'opnieuw geladen en bijgewerkt na het herstarten van de server', 45_000);
  };
  await restart({ oidc: createOidcClient(config) });
  try {
    const browserSession = async () => {
      const token = await evaluate<string>(`localStorage.getItem('tickory.token')`);
      return (db.prepare('SELECT id FROM sessions WHERE token_hash = ?').get(createHash('sha256').update(token).digest('hex')) as any).id as string;
    };
    /** Het token van de app nu; na inloggen moet het een ander zijn (pas dan is de nieuwe sessie er echt, niet alleen "Bijgewerkt" van ervoor). */
    const tokenNow = () => evaluate<string>(`localStorage.getItem('tickory.token')`);
    const newToken = (old: string) => `localStorage.getItem('tickory.token') !== ${JSON.stringify(old)}`;
    /** Op de pagina van de inlogdienst: "Doorgaan" (de inlogdienst stuurt de browser terug naar Tickory). */
    const passIdp = async () => {
      await waitFor(`location.href.startsWith(${JSON.stringify(idp.base)}) && document.getElementById('doorgaan')`, 'de pagina van de inlogdienst', 15_000);
      await shot('sso-inlogdienst');
      await evaluate(`document.getElementById('doorgaan').click()`);
      await waitFor(`location.href.startsWith(${JSON.stringify(BASE)}) && document.body.classList.contains('ready')`, 'terug in Tickory', 15_000);
    };

    // ---- koppelen vanuit Account ----
    await nav('Alice');
    await waitFor(`document.querySelector('dialog[open] .settings-menu')`, 'instellingenmenu');
    await clickText('Account, wachtwoord en apparaten');
    await waitFor(`${top}.querySelector('.sso-section summary')?.textContent === 'Inloggen met Nep-inlogdienst'`, 'het stuk over SSO in Account');
    await evaluate(`${top}.querySelector('.sso-section').open = true`);
    await waitFor(`${top}.querySelector('.sso-section input[type=password]')`, 'wachtwoord bij koppelen');
    assert.match(await evaluate<string>(`${top}.querySelector('.sso-section').innerText`), /Koppel je account, dan kun je voortaan ook inloggen met Nep-inlogdienst/);
    await shot('sso-koppelen');
    await typeInto('dialog[open] .sso-section input[type=password]', PASSWORD_ALICE);
    await evaluate(`${top}.querySelector('.sso-section form').requestSubmit()`);
    await passIdp();
    await waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Je account is gekoppeld. Je kunt voortaan ook inloggen met Nep-inlogdienst.'))`, 'melding: gekoppeld');
    assert.equal(await evaluate(`location.hash`), '', 'de code staat niet meer in de adresbalk');
    assert.equal(await evaluate(`localStorage.getItem('tickory.sso')`), null, 'het geheim van de poging is weg');
    assert.equal((db.prepare('SELECT user_id FROM oidc_identities WHERE subject = ?').get('sub-alice-e2e') as any)?.user_id, alice.id);
    await waitFor(`await ${SYNCED}`, 'bijgewerkt na koppelen', 45_000);
    step('SSO koppelen vanuit Account: eerst het wachtwoord, dan naar de inlogdienst en terug; de melding "gekoppeld", de code weg uit de adresbalk');

    // ---- opnieuw inloggen met de knop ----
    const stale = await tokenNow();
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), await browserSession());
    await evaluate(`document.getElementById('sync-status').click()`);
    await waitFor(`document.querySelector('dialog[open] .sso-button')?.textContent === 'Inloggen met Nep-inlogdienst'`, 'de knop op het inlogscherm');
    assert.equal(await evaluate(`document.querySelector('dialog[open] .login-or').textContent`), 'of met je gebruikersnaam');
    assert.ok(await evaluate(`Boolean(document.querySelector('dialog[open] input[type=password]'))`), 'het wachtwoord kan ook nog');
    await shot('sso-inlogscherm');
    const tasksBefore = await evaluate<number>(`document.querySelectorAll('.nav-item').length`);
    await evaluate(`document.querySelector('dialog[open] .sso-button').click()`);
    await passIdp();
    await waitFor(`${newToken(stale)} && !document.querySelector('dialog[open]') && await ${SYNCED}`, 'ingelogd via SSO (een nieuw token) en bijgewerkt', 45_000);
    assert.equal(await evaluate(`document.querySelectorAll('.nav-item').length`), tasksBefore, 'dezelfde gebruiker: de gegevens zijn gebleven');
    const sessionName = (db.prepare('SELECT name FROM sessions WHERE id = ?').get(await browserSession()) as any).name;
    assert.match(sessionName, /^(Chrome|Edge) op (Windows|Linux|Mac)$/, 'de naam van het apparaat uit het begin van de poging');
    step('opnieuw inloggen met "Inloggen met Nep-inlogdienst": naar de inlogdienst en terug, ingelogd zonder wachtwoord; dezelfde gegevens');

    // ---- een identiteit zonder Tickory-account: een nette melding op het inlogscherm ----
    const viaSso = await tokenNow();
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), await browserSession());
    idp.user = { sub: 'sub-onbekend-e2e', preferred_username: 'onbekend', name: 'Iemand' };
    await evaluate(`document.getElementById('sync-status').click()`);
    await waitFor(`document.querySelector('dialog[open] .sso-button')`, 'inlogscherm');
    await evaluate(`document.querySelector('dialog[open] .sso-button').click()`);
    await passIdp();
    await waitFor(`document.querySelector('dialog[open] .hint')?.textContent.startsWith('Aan dit account bij de inlogdienst is nog geen Tickory-account gekoppeld.')`, 'melding: geen account', 15_000);
    await shot('sso-geen-account');
    // gewoon weer met het wachtwoord
    await typeInto('dialog[open] input[type=password]', PASSWORD_ALICE);
    await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
    await waitFor(`${newToken(viaSso)} && !document.querySelector('dialog[open]') && await ${SYNCED}`, 'weer ingelogd met het wachtwoord', 45_000);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL').get(alice.id) as any).n, 2, 'alleen dit apparaat en de "Telefoon" van eerder zijn aangemeld');
    step('een identiteit zonder Tickory-account: terug op het inlogscherm met een begrijpelijke melding, zonder details; met het wachtwoord gaat het gewoon');

    // ---- de koppeling verwijderen ----
    await nav('Alice');
    await waitFor(`document.querySelector('dialog[open] .settings-menu')`, 'instellingenmenu');
    await clickText('Account, wachtwoord en apparaten');
    await waitFor(`${top}.querySelector('.sso-section')`, 'het stuk over SSO');
    await evaluate(`${top}.querySelector('.sso-section').open = true`);
    await waitFor(`${top}.querySelector('.sso-section').innerText.includes('Gekoppeld met Nep-inlogdienst sinds')`, 'status: gekoppeld');
    await shot('sso-gekoppeld');
    await clickText('Koppeling verwijderen', top);
    await waitFor(`${top}.querySelector('.sso-section [role=status]')?.textContent === 'De koppeling met Nep-inlogdienst is verwijderd.'`, 'melding: verwijderd');
    await waitFor(`${top}.querySelector('.sso-section input[type=password]')`, 'weer te koppelen');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM oidc_identities').get() as any).n, 0);
    for (let i = 0; i < 5 && (await evaluate(`Boolean(document.querySelector('dialog[open]'))`)); i++) {
      await evaluate(`${top}.close()`);
      await sleep(100);
    }
    step('de koppeling verwijderen in Account (er is een wachtwoord, dus dat mag)');
  } finally {
    await restart();
    await idp.close();
  }
}
