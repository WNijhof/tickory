// Je eigen account verwijderen in een echte browser (Account › Account verwijderen): eerst zegt de app waarom het nog niet kan
// (eigenaar van een gedeeld project met een lid), daarna met wachtwoord en een vinkje; de app wist dit apparaat en toont het
// inlogscherm met een melding. Daarna logt Alice weer in. Wordt als laatste aangeroepen vanuit scripts/e2e.ts.

import assert from 'node:assert/strict';
import { handleSync } from '../server/sync.ts';
import { createUser, hashPassword } from '../server/users.ts';

export async function deleteScenario(c: any) {
  const { evaluate, waitFor, step, SYNCED, db, alice, typeInto, clickText, nav, submit, PASSWORD_ALICE } = c;
  const PW = 'proef-wachtwoord-2026';
  const proef = createUser(db, { username: 'proefaccount', name: 'Proef', passwordHash: await hashPassword(PW) });
  let k = 0;
  const run = (userId: string, commands: [string, object][]) => {
    const res = handleSync(db, { commands: commands.map(([type, args]) => ({ type, uuid: `e2e-weg-${String(++k).padStart(5, '0')}`, args })) }, userId) as any;
    for (const [uuid, s] of Object.entries(res.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
  };
  run(proef.id, [
    ['project_add', { id: 'e2eweg-project01', name: 'Proefproject' }],
    ['task_add', { id: 'e2eweg-taak00001', project_id: 'e2eweg-project01', content: 'Weg te halen' }],
    ['project_share', { project_id: 'e2eweg-project01', username: 'alice', role: 'member' }],
  ]);

  // ---- Alice meldt zich af, Proef logt in ----
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .settings-menu')`, 'instellingenmenu');
  await clickText('Afmelden en lokale gegevens wissen');
  await waitFor(`[...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent === 'Afmelden')`, 'bevestiging');
  await clickText('Afmelden', `document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('dialog[open] input[type=password]')`, 'inlogscherm', 15_000);
  await typeInto('dialog[open] input[autocomplete=username]', 'proefaccount');
  await typeInto('dialog[open] input[type=password]', PW);
  await submit('dialog[open] form');
  await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Proef') && await ${SYNCED}`, 'ingelogd als Proef', 20_000);

  const openDelete = async () => {
    await waitFor(`document.querySelector('[data-fk="account-delete"]')`, 'de knop Account verwijderen');
    await evaluate(`(() => { const d = document.querySelector('[data-fk="account-delete-summary"]').closest('details'); d.open = true; document.querySelector('[data-fk="account-delete"]').click(); })()`);
  };
  await nav('Proef');
  await waitFor(`document.querySelector('dialog[open] .settings-menu')`, 'instellingenmenu');
  await clickText('Account, wachtwoord en apparaten');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Account'`, 'accountscherm');
  await openDelete();
  await waitFor(`document.querySelector('[data-fk="account-delete-blockers"]')`, 'wat het tegenhoudt');
  assert.equal(await evaluate(`document.querySelector('[data-fk="account-delete-blockers"]').textContent`),
    'Je bent eigenaar van "Proefproject" en er zit nog 1 ander lid in. Maak dat lid eigenaar (onder Delen), verwijder het project of haal het lid eruit.');
  assert.equal(await evaluate(`document.querySelector('[data-fk="account-delete-confirm"]')`), null, 'nog geen knop om te verwijderen');

  // ---- het delen stoppen (zoals in het projectmenu), dan opnieuw: nu met wachtwoord en vinkje ----
  run(proef.id, [['project_unshare', { project_id: 'e2eweg-project01', user_id: alice.id }]]);
  await evaluate(`[...document.querySelector('.account-delete').querySelectorAll('button')].find((b) => b.textContent === 'Sluiten').click()`);
  await openDelete();
  await waitFor(`document.querySelector('[data-fk="account-delete-password"]')`, 'het wachtwoordveld');
  assert.ok((await evaluate<string>(`document.querySelector('.account-delete').textContent`)).includes('Dit blijft: wat je in projecten van anderen hebt gemaakt'));
  await typeInto('[data-fk="account-delete-password"]', PW);
  await evaluate(`document.querySelector('[data-fk="account-delete-confirm"]').click()`);
  assert.ok(await evaluate(`document.querySelector('[data-fk="account-delete-password"]') !== null`), 'zonder vinkje gebeurt er niets (het formulier vraagt erom)');
  await evaluate(`document.querySelector('[data-fk="account-delete-sure"]').click()`);
  await evaluate(`document.querySelector('[data-fk="account-delete-confirm"]').click()`);
  await waitFor(`document.querySelector('dialog[open] input[type=password]') && [...document.querySelectorAll('dialog[open] p')].some((p) => p.textContent.startsWith('Je account is verwijderd'))`, 'inlogscherm met de melding', 20_000);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'proefaccount'").get() as any).n, 0, 'het account is weg');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = 'e2eweg-project01'").get() as any).n, 0, 'het project ook');
  assert.equal(await evaluate(`localStorage.getItem('tickory.token')`), null, 'geen token meer op dit apparaat');
  step('account verwijderen: eerst de reden dat het niet kan (eigenaar van een gedeeld project met een lid), daarna met wachtwoord en vinkje; alles weg, inlogscherm met melding');

  // ---- weer Alice ----
  await typeInto('dialog[open] input[autocomplete=username]', 'alice');
  await typeInto('dialog[open] input[type=password]', PASSWORD_ALICE);
  await submit('dialog[open] form');
  await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Alice') && await ${SYNCED}`, 'weer ingelogd als Alice', 20_000);
  assert.ok(!(await evaluate<string[]>(`[...document.querySelectorAll('.nav-label')].map((e) => e.textContent)`)).includes('Proefproject'), 'het project van Proef is weg bij Alice');
}
