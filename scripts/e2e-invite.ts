// Uitnodigen via een link in een echte browser. Alice maakt in het deelvenster een link (alleen lezen), kopieert hem en Bob neemt hem
// aan; ze ziet hoe vaak de link gebruikt is en trekt hem in. Daarna opent Alice een link van Bob (#invite=…): de app vraagt of ze
// meedoet en opent het project. Wordt aangeroepen vanuit scripts/e2e.ts.

import assert from 'node:assert/strict';
import { createSession } from '../server/users.ts';

export async function inviteScenario(c: any) {
  const { evaluate, waitFor, step, sleep, shot, db, alice, bob, syncAs, click, clickText, nav, SYNCED } = c;
  const bobToken = createSession(db, bob.id, 'Bob uitnodigen').token;
  const aliceToken = createSession(db, alice.id, 'Controle uitnodigen').token;
  let k = 0;
  const as = async (token: string, commands: [string, object][]) => {
    const res = await syncAs(token, 'e2e-uitnodigen', commands.map(([type, args]) => ({ type, uuid: `e2e-inv-${String(++k).padStart(6, '0')}`, args })));
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const [uuid, s] of Object.entries(body.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
  };
  const base = await evaluate<string>(`location.origin`);
  const api = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() as any };
  };
  const role = (project: string, user: string) => (db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND is_deleted = 0').get(project, user) as any)?.role ?? null;
  const startView = await evaluate<string>(`document.getElementById('view-title').textContent`);

  // ---- Alice maakt een link voor haar project; Bob neemt hem aan ----
  const Q = 'e2einviteproj001';
  await as(aliceToken, [['project_add', { id: Q, name: 'Kookclub' }]]);
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Kookclub')`, 'Kookclub bij Alice', 8000);
  await nav('Kookclub');
  await waitFor(`document.getElementById('view-title').textContent === 'Kookclub'`, 'Kookclub open');
  await clickText('Delen');
  await waitFor(`document.querySelector('dialog[open] [data-fk="invite-section"]')`, 'het deel Uitnodigen met een link');
  await evaluate(`(() => { const s = document.querySelector('dialog[open] [data-fk="invite-role"]'); s.value = 'viewer'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click('dialog[open] [data-fk="invite-create"]');
  await waitFor(`document.querySelector('dialog[open] [data-fk="invite-url"]')?.value.includes('#invite=tki_')`, 'de link staat er');
  const url = await evaluate<string>(`document.querySelector('dialog[open] [data-fk="invite-url"]').value`);
  assert.ok(url.startsWith(`${base}/`), url);
  const token = url.split('#invite=')[1];
  await waitFor(`document.querySelectorAll('dialog[open] .invite-list li').length === 1`, 'de link in de lijst');
  assert.match(await evaluate<string>(`document.querySelector('dialog[open] .invite-list li').textContent`), /Alleen lezen.*nog 7 dagen geldig · 0 keer gebruikt/);
  await shot('uitnodigen-deelvenster');
  const seen = await api('GET', `/api/v1/invites/${token}`, bobToken);
  assert.deepEqual([seen.body.project_name, seen.body.owner_name, seen.body.role], ['Kookclub', 'Alice', 'viewer']);
  assert.equal((await api('POST', `/api/v1/invites/${token}/accept`, bobToken, {})).body.joined, true);
  assert.equal(role(Q, bob.id), 'viewer');
  await waitFor(`[...document.querySelectorAll('dialog[open] .device-info .hint')].some((e) => e.textContent === '@bob · alleen lezen')`, 'Bob staat in het deelvenster', 10_000);
  // de lijst opnieuw laden: het aantal keer gebruikt; dan intrekken
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  await clickText('Gedeeld');
  await waitFor(`document.querySelector('dialog[open] .invite-list li')?.textContent.includes('1 keer gebruikt')`, 'één keer gebruikt');
  const inviteId = await evaluate<string>(`document.querySelector('dialog[open] .invite-list li').dataset.inviteId`);
  await click(`dialog[open] [data-fk="invite-revoke:${inviteId}"]`);
  await waitFor(`document.querySelectorAll('dialog[open] .invite-list li').length === 0`, 'de link is ingetrokken');
  assert.equal((await api('GET', `/api/v1/invites/${token}`, bobToken)).status, 404);
  await clickText('Sluiten', `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  step('uitnodigen met een link: Alice maakt een link (alleen lezen) in het deelvenster, Bob neemt hem aan, de lijst telt het gebruik, en intrekken werkt meteen');

  // ---- Alice opent een link van Bob ----
  const B = 'e2einviteproj002';
  await as(bobToken, [['project_add', { id: B, name: 'Hardloopschema' }], ['task_add', { project_id: B, content: 'Rondje park' }]]);
  const fromBob = await api('POST', `/api/v1/projects/${B}/invites`, bobToken, { role: 'member', days: 1 });
  assert.equal(fromBob.status, 200);
  await evaluate(`location.hash = ${JSON.stringify(`#invite=${fromBob.body.token}`)}`);
  await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('Bob nodigt je uit voor het project "Hardloopschema" (kan bewerken). Meedoen?')`, 'de vraag of Alice meedoet', 10_000);
  assert.equal(await evaluate(`location.hash`), '', 'het adres is weer schoon');
  await clickText('Meedoen', `document.querySelector('dialog[open]')`);
  await waitFor(`document.getElementById('view-title').textContent === 'Hardloopschema' && await ${SYNCED}`, 'het project is open', 15_000);
  assert.ok(await evaluate(`[...document.querySelectorAll('#content .task-title')].some((e) => e.textContent === 'Rondje park')`), 'met de taken');
  assert.equal(role(B, alice.id), 'member');
  // dezelfde link nog eens: ze zit er al in
  await evaluate(`location.hash = ${JSON.stringify(`#invite=${fromBob.body.token}`)}`);
  await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent === 'Je zit al in "Hardloopschema".')`, 'al lid');
  // een kapotte link: een nette melding
  await evaluate(`location.hash = '#invite=tki_${'z'.repeat(43)}'`);
  await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent.startsWith('Deze link werkt niet (meer)'))`, 'melding bij een kapotte link');
  step('een uitnodigingslink openen: de app vraagt of je meedoet, opent het project met de taken; nog eens: "al lid"; een kapotte link geeft een nette melding');

  // ---- opruimen ----
  await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  await as(aliceToken, [['project_delete', { id: Q }]]);
  await as(bobToken, [['project_delete', { id: B }]]);
  await waitFor(`![...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Kookclub' || e.textContent === 'Hardloopschema')`, 'de projecten zijn weg', 10_000);
  await nav(startView);
  await sleep(100);
}
