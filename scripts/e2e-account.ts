// Account en beveiliging in een echte browser: de apparatenlijst (soort, aangemeld sinds, per stuk afmelden), een verlopen sessie
// (de app vraagt netjes opnieuw om in te loggen), tweestapsverificatie aanzetten (QR-code, sleutel, bevestigen, herstelcodes),
// inloggen in twee stappen met een code die deze test zelf uitrekent en met een herstelcode, een back-up downloaden als beheerder
// (met code) en controleren dat het archief de database bevat, 2FA van een ander uitzetten als beheerder, en zelf uitzetten.
// Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties van die test komen binnen via `c`. Namen en wachtwoorden zijn verzonnen.
//
// Een code geldt maar één keer per tijdvak van 30 seconden. Om niet te hoeven wachten, zet de test de klok van de server per
// gebruikte code een tijdvak verder (`shiftClock`), en rekent de code uit voor die verschoven tijd.

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readTar } from '../server/backupArchive.ts';
import { createSession } from '../server/users.ts';

/** TOTP (RFC 6238, SHA-1, 6 cijfers), los van de server uitgerekend. */
function totp(secretB32: string, ms: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secretB32.replace(/\s/g, '')].map((ch) => alphabet.indexOf(ch).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export async function accountScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, db, alice, bob, typeInto, clickText, nav, PASSWORD_ALICE, workDir, BASE, shiftClock, serverNow } = c;
  const top = `[...document.querySelectorAll('dialog[open]')].at(-1)`;
  const topText = () => evaluate<string>(`(${top}?.innerText ?? '').replace(/\\s+/g, ' ')`);
  const clickTop = (text: string) => clickText(text, top);
  const openAccount = async () => {
    await nav('Alice');
    await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
    await clickText('Account, wachtwoord en apparaten');
    await waitFor(`document.querySelector('dialog[open] .device .badge')?.textContent === 'dit apparaat'`, 'apparatenlijst');
  };
  const closeAll = async () => {
    for (let i = 0; i < 5 && (await evaluate(`Boolean(document.querySelector('dialog[open]'))`)); i++) {
      await evaluate(`${top}.close()`);
      await sleep(100);
    }
    await waitFor(`!document.querySelector('dialog[open]')`, 'alle vensters dicht');
  };
  const browserSession = async () => {
    const token = await evaluate<string>(`localStorage.getItem('tickory.token')`);
    const hash = createHash('sha256').update(token).digest('hex');
    return (db.prepare('SELECT id FROM sessions WHERE token_hash = ?').get(hash) as any).id as string;
  };
  /** De volgende code: de klok van de server een tijdvak verder, en de code voor die tijd. */
  const nextCode = (secret: string) => {
    shiftClock(30_000);
    return totp(secret, serverNow());
  };

  // ---- apparaten: soort, aangemeld sinds, de regels voor verlopen, per stuk afmelden ----
  const tablet = createSession(db, alice.id, 'Oude tablet', { kind: 'browser', browser: 'Firefox', os: 'Android' });
  await openAccount();
  const devices = await evaluate<string>(`document.querySelector('dialog[open] .devices').innerText`);
  assert.match(devices, /Webbrowser · (Chrome|Edge) · Windows/, 'het soort apparaat van deze browser, zonder versie');
  assert.match(devices, /Webbrowser · Firefox · Android/);
  assert.match(devices, /Aangemeld sinds /);
  assert.match(devices, /Een apparaat dat 90 dagen niet is gebruikt, wordt vanzelf afgemeld\. Na 365 dagen moet elk apparaat opnieuw inloggen\./);
  assert.ok(!/\d+\.\d+\.\d+/.test(devices), 'geen versienummers');
  await evaluate(`[...document.querySelectorAll('dialog[open] .device')].find((li) => li.textContent.includes('Oude tablet')).querySelector('button').click()`);
  await waitFor(`![...document.querySelectorAll('dialog[open] .device')].some((li) => li.textContent.includes('Oude tablet'))`, 'tablet afgemeld');
  assert.ok((db.prepare('SELECT revoked_at FROM sessions WHERE id = ?').get(tablet.id) as any).revoked_at, 'op de server ingetrokken');
  // "alle andere afmelden" vraagt eerst om bevestiging (hier annuleren: de andere apparaten van deze test blijven nodig)
  await clickTop('Alle andere apparaten afmelden');
  await waitFor(`${top}.querySelector('h2')?.textContent === 'Alle andere apparaten afmelden?'`, 'bevestiging');
  await clickTop('Annuleren');
  await shot('account-apparaten');
  await closeAll();
  step('apparaten: soort apparaat zonder versie, laatst gebruikt en aangemeld sinds, de verloopregels, per stuk afmelden; "alle andere afmelden" vraagt om bevestiging');

  // ---- een verlopen sessie: de app vraagt netjes opnieuw om in te loggen, en de gegevens blijven ----
  const old = new Date(serverNow() - 100 * 86_400_000).toISOString();
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(old, await browserSession());
  await evaluate(`document.getElementById('sync-status').click()`);
  await waitFor(`document.querySelector('dialog[open] input[type=password]')`, 'inlogscherm na een verlopen sessie');
  assert.match(await topText(), /Je bent niet meer aangemeld/);
  assert.equal(await evaluate(`document.querySelector('dialog[open] input[autocomplete=username]').value`), 'alice', 'de naam staat er al');
  assert.ok((await evaluate<number>(`document.querySelectorAll('.nav-item').length`)) > 3, 'de gegevens staan nog in beeld');
  await typeInto('dialog[open] input[type=password]', PASSWORD_ALICE);
  await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'weer ingelogd');
  await waitFor(`await ${SYNCED}`, 'bijgewerkt na opnieuw inloggen');
  step('verlopen sessie (90 dagen niet gebruikt): 401, het inlogscherm met uitleg en de naam al ingevuld, de gegevens blijven staan; opnieuw inloggen werkt');

  // ---- tweestapsverificatie aanzetten ----
  await openAccount();
  await evaluate(`document.querySelector('dialog[open] .two-factor-section').open = true`);
  await waitFor(`${top}.querySelector('.two-factor-section')?.innerText.includes('Staat uit')`, 'uitleg: staat uit');
  await clickTop('Tweestapsverificatie aanzetten');
  await waitFor(`${top}.querySelector('.two-factor input[type=password]')`, 'wachtwoord vragen');
  await typeInto('dialog[open] .two-factor input[type=password]', 'verkeerd-wachtwoord');
  await evaluate(`document.querySelector('dialog[open] .two-factor form').requestSubmit()`);
  await waitFor(`${top}.querySelector('.two-factor .error')?.textContent === 'Het wachtwoord klopt niet'`, 'fout wachtwoord');
  await typeInto('dialog[open] .two-factor input[type=password]', PASSWORD_ALICE);
  await evaluate(`document.querySelector('dialog[open] .two-factor form').requestSubmit()`);
  await waitFor(`${top}.querySelector('.two-factor svg.qr path')?.getAttribute('d')?.length > 100`, 'QR-code');
  assert.equal(await evaluate(`document.querySelector('dialog[open] svg.qr').getAttribute('aria-label')`), 'QR-code voor je authenticator-app');
  const secret = (await evaluate<string>(`document.querySelector('dialog[open] .two-factor code.secret').textContent`)).replace(/\s/g, '');
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.match(await evaluate<string>(`document.querySelector('dialog[open] a.otpauth-link').getAttribute('href')`), new RegExp(`^otpauth://totp/Tickory:alice\\?secret=${secret}&`));
  await shot('tweestaps-qr');
  await typeInto('dialog[open] .two-factor input.login-code', '000000' === totp(secret, serverNow()) ? '111111' : '000000');
  await evaluate(`document.querySelector('dialog[open] .two-factor form').requestSubmit()`);
  await waitFor(`${top}.querySelector('.two-factor .error')?.textContent.startsWith('De code klopt niet')`, 'foute code');
  await typeInto('dialog[open] .two-factor input.login-code', nextCode(secret));
  await evaluate(`document.querySelector('dialog[open] .two-factor form').requestSubmit()`);
  await waitFor(`${top}.querySelector('textarea.recovery-codes')`, 'herstelcodes');
  const recovery = (await evaluate<string>(`document.querySelector('dialog[open] textarea.recovery-codes').value`)).split('\n');
  assert.equal(recovery.length, 10);
  for (const code of recovery) assert.match(code, /^[0-9a-z]{5}-[0-9a-z]{5}$/);
  await shot('tweestaps-herstelcodes');
  await clickTop('Ik heb ze bewaard');
  await waitFor(`${top}.querySelector('.two-factor')?.innerText.includes('Nog 10 herstelcodes over')`, 'status: aan');
  assert.ok((db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(alice.id) as any).totp_secret, 'op de server aan');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM users').all()).includes(secret), 'het geheim staat versleuteld in de database');
  await closeAll();
  step('tweestapsverificatie aanzetten: eerst het wachtwoord (fout wordt geweigerd), dan een zelf gemaakte QR-code met de sleutel en een otpauth-link, een foute code geweigerd, de goede bevestigt; tien herstelcodes, daarna "Nog 10 herstelcodes over"');

  // ---- inloggen in twee stappen ----
  const relogin = async () => {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), await browserSession());
    await evaluate(`document.getElementById('sync-status').click()`);
    await waitFor(`document.querySelector('dialog[open] input[type=password]')`, 'inlogscherm');
    await typeInto('dialog[open] input[type=password]', PASSWORD_ALICE);
    await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
    await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Tweestapsverificatie'`, 'tweede stap');
    assert.equal(await evaluate(`document.querySelectorAll('dialog[open] input[type=password]').length`), 0, 'het wachtwoordveld is weg');
  };
  await relogin();
  assert.equal(await evaluate(`document.querySelector('dialog[open] input.login-code').getAttribute('autocomplete')`), 'one-time-code');
  assert.equal(await evaluate(`document.querySelector('dialog[open] input.login-code').inputMode`), 'numeric');
  await shot('inloggen-code');
  await typeInto('dialog[open] input.login-code', '12345');
  await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
  await waitFor(`document.querySelector('dialog[open] .error')?.textContent.startsWith('De code klopt niet')`, 'foute code bij inloggen');
  await typeInto('dialog[open] input.login-code', nextCode(secret));
  await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'ingelogd met code');
  await waitFor(`await ${SYNCED}`, 'bijgewerkt na inloggen met code');
  // met een herstelcode (telefoon kwijt)
  await relogin();
  await clickText('Telefoon kwijt? Gebruik een herstelcode', top);
  await waitFor(`document.querySelector('dialog[open] label')?.textContent.startsWith('Herstelcode')`, 'veld voor de herstelcode');
  await typeInto('dialog[open] input.login-code', recovery[0].toUpperCase());
  await evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'ingelogd met herstelcode');
  await waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Er zijn er nog 9 over'))`, 'melding: nog 9 herstelcodes');
  await waitFor(`await ${SYNCED}`, 'bijgewerkt na inloggen met herstelcode');
  // dezelfde herstelcode werkt geen tweede keer (rechtstreeks tegen de server)
  const reuse = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: PASSWORD_ALICE, device_name: 'test' }) });
  const ch = ((await reuse.json()) as any).challenge;
  const again = await fetch(`${BASE}/api/v1/auth/login/2fa`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: ch, code: recovery[0] }) });
  assert.equal(again.status, 401, 'een herstelcode werkt maar één keer');
  step('inloggen met tweestapsverificatie: na het wachtwoord een tweede stap (veld voor een eenmalige code), een foute code geweigerd, de code uit de app (door deze test zelf uitgerekend) werkt; met een herstelcode ook, met de melding dat er nog 9 zijn; dezelfde herstelcode niet nog een keer');

  // ---- back-up downloaden als beheerder (met code, want 2FA staat aan) ----
  const downloads = `${workDir}downloads`;
  mkdirSync(downloads, { recursive: true });
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await openAccount();
  await clickText('Gebruikersbeheer');
  await waitFor(`${top}.querySelector('.backup-section')`, 'beheer met back-up');
  await evaluate(`${top}.querySelector('.backup-section').open = true`);
  await waitFor(`${top}.querySelector('.backup-section input[autocomplete=one-time-code]')`, 'codeveld bij de back-up (2FA staat aan)');
  assert.match(await evaluate<string>(`${top}.querySelector('.backup-section').innerText`), /wachtwoord-hashes, de privésleutel voor meldingen \(VAPID\) en het geheim van de knoppen in meldingen \(HMAC\)/);
  await shot('beheer-back-up');
  await typeInto('dialog[open] .backup-section input[type=password]', PASSWORD_ALICE);
  await typeInto('dialog[open] .backup-section input[autocomplete=one-time-code]', nextCode(secret));
  await evaluate(`${top}.querySelector('.backup-section form').requestSubmit()`);
  await waitFor(`${top}.querySelector('.backup-section [role=status]')?.textContent.startsWith('De download is begonnen')`, 'download begonnen');
  let file = '';
  for (let i = 0; i < 100 && !file; i++) {
    file = readdirSync(downloads).find((f) => /^tickory-backup-\d{4}-\d{2}-\d{2}\.tar$/.test(f)) ?? '';
    if (!file) await sleep(100);
  }
  assert.ok(file, `het archief is gedownload (${readdirSync(downloads).join(', ')})`);
  await sleep(300); // het bestand helemaal weggeschreven
  const files = readTar(readFileSync(`${downloads}/${file}`));
  assert.ok(files.has('tickory.db') && files.has('tickory-backup.json') && files.has('LEESMIJ.txt'));
  const restored = `${workDir}teruggezet.db`;
  writeFileSync(restored, files.get('tickory.db')!);
  const copy = new DatabaseSync(restored, { readOnly: true });
  try {
    assert.ok((copy.prepare("SELECT COUNT(*) AS n FROM tasks WHERE content = 'Tandarts bellen'").get() as any).n === 1, 'de taken van Alice staan in de back-up');
    assert.deepEqual((copy.prepare('SELECT username FROM users ORDER BY username').all() as any[]).map((u) => u.username).filter((u) => ['alice', 'bob'].includes(u)), ['alice', 'bob']);
  } finally { copy.close(); }
  const attachmentsInDb = (db.prepare('SELECT COUNT(*) AS n FROM attachment_files f JOIN attachments a ON a.id = f.id WHERE f.linked = 1 AND a.is_deleted = 0').get() as any).n;
  assert.equal([...files.keys()].filter((k) => k.startsWith('attachments/')).length, attachmentsInDb, 'de bijlagen gaan mee');
  step(`back-up downloaden als beheerder: waarschuwing over wat erin staat, wachtwoord én code (2FA staat aan), de browser downloadt het tar-bestand zelf; het archief bevat de database (te openen, met de taken) en ${attachmentsInDb} bijlage(n)`);

  // ---- als beheerder 2FA van een ander uitzetten ----
  const bobToken = createSession(db, bob.id, 'Bob test 2FA').token;
  const api = async (path: string, body: unknown) => (await fetch(`${BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as any;
  const bobSecret = (await api('/api/v1/auth/2fa/setup', { password: c.PASSWORD_BOB })).secret;
  assert.equal((await api('/api/v1/auth/2fa/enable', { code: totp(bobSecret, serverNow()) })).enabled, true);
  await evaluate(`${top}.close()`); // terug naar Account, en opnieuw beheer openen: de lijst is dan bijgewerkt
  await waitFor(`${top}?.querySelector('h2')?.textContent === 'Account'`, 'terug in Account');
  await clickText('Gebruikersbeheer');
  await waitFor(`[...${top}.querySelectorAll('.device')].some((li) => li.textContent.includes('Bob') && li.textContent.includes('tweestaps'))`, 'Bob met het label tweestaps');
  await evaluate(`[...${top}.querySelectorAll('.device')].find((li) => li.querySelector('strong').textContent.startsWith('Bob')).querySelector('button').click()`);
  await waitFor(`${top}.querySelector('.menu')`, 'menu bij Bob');
  await clickTop('Tweestapsverificatie uitzetten');
  await waitFor(`${top}.querySelector('h2')?.textContent === 'Tweestapsverificatie van Bob uitzetten?'`, 'bevestiging');
  await clickTop('Uitzetten');
  await waitFor(`[...${top}.querySelectorAll('[role=status]')].some((p) => p.textContent === 'Tweestapsverificatie van Bob staat uit.')`, 'melding');
  await waitFor(`![...${top}.querySelectorAll('.device')].some((li) => li.textContent.includes('Bob') && li.textContent.includes('tweestaps'))`, 'label weg');
  assert.equal((db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(bob.id) as any).totp_secret, null);
  await closeAll();
  step('beheer: een account met tweestapsverificatie heeft het label "tweestaps"; uitzetten na bevestiging (met logregel op de server)');

  // ---- zelf uitzetten: wachtwoord en code ----
  await openAccount();
  await evaluate(`document.querySelector('dialog[open] .two-factor-section').open = true`);
  await waitFor(`${top}.querySelector('.two-factor')?.innerText.includes('Nog 9 herstelcodes over')`, 'status: nog 9');
  await clickTop('Uitzetten');
  await waitFor(`${top}.querySelector('.two-factor input[type=password]')`, 'wachtwoord en code vragen');
  await typeInto('dialog[open] .two-factor input[type=password]', PASSWORD_ALICE);
  await typeInto('dialog[open] .two-factor input[autocomplete=one-time-code]', nextCode(secret));
  await evaluate(`document.querySelector('dialog[open] .two-factor form').requestSubmit()`);
  await waitFor(`${top}.querySelector('.two-factor')?.innerText.includes('Staat uit')`, 'weer uit');
  assert.equal((db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(alice.id) as any).totp_secret, null);
  await closeAll();
  assert.ok(existsSync(`${downloads}/${file}`));
  step('tweestapsverificatie zelf uitzetten met wachtwoord en code');
}
