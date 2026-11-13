import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { currentRev } from './sync.ts';
import { freshDb } from './testutil.ts';
import {
  LoginLimiter, createSession, createUser, findSession, hashPassword, ipBucket, listSessions, peersOf, revokeSession, revokeSessions, setPasswordCostForTests,
  updateUser, validateDisplayName, validatePassword, validateUsername, verifyPassword,
} from './users.ts';
import { handleSync } from './sync.ts';

setPasswordCostForTests(1024); // snelle tests; de hash bevat zijn eigen kosten, dus verifiëren werkt ook met andere kosten

const mk = (db: DatabaseSync, username: string, isAdmin = false) => createUser(db, { username, name: username, passwordHash: 'x', isAdmin });

test('wachtwoorden: juist en fout, elke hash heeft een eigen salt, accenten in NFC of NFD tellen hetzelfde', async () => {
  const h = await hashPassword('correct paard batterij');
  assert.match(h, /^scrypt\$\d+\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword('correct paard batterij', h), true);
  assert.equal(await verifyPassword('Correct paard batterij', h), false);
  assert.equal(await verifyPassword('', h), false);
  assert.notEqual(await hashPassword('correct paard batterij'), h);
  const nfc = 'café-wachtwoord-é'.normalize('NFC');
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd);
  assert.equal(await verifyPassword(nfd, await hashPassword(nfc)), true, 'op een Mac getypt wachtwoord werkt ook op Windows');
});

test('een beschadigde of vervalste hash wordt afgewezen en kost geen onbeperkt geheugen', async () => {
  for (const bad of ['', 'x', 'scrypt$', 'bcrypt$1$2$3$a$b', 'scrypt$1024$8$1$$', 'scrypt$3$8$1$YQ$YQ', 'scrypt$2147483648$8$1$YQ$YQ', 'scrypt$1024$9999$1$YQ$YQ', 'scrypt$1024$8$99$YQ$YQ', 'scrypt$abc$8$1$YQ$YQ']) {
    assert.equal(await verifyPassword('wat dan ook', bad), false, bad);
  }
});

test('gebruikersnaam, naam en wachtwoord worden gecontroleerd', () => {
  for (const good of ['anna', 'Jan-Willem', 'José', 'jan.de_vries', 'a1', 'Zoë2']) assert.equal(validateUsername(good), good);
  assert.equal(validateUsername('  anna '), 'anna');
  assert.equal(validateUsername('café'.normalize('NFD')), 'café'.normalize('NFC'));
  for (const bad of ['', 'a', ' ', 'a b', '-anna', '.anna', 'anna@x.nl', 'an/na', 'x'.repeat(41), '😀anna', 42, null, undefined]) {
    assert.throws(() => validateUsername(bad), /gebruikersnaam/, String(bad));
  }
  assert.equal(validateDisplayName('  Jan   de Vries '), 'Jan de Vries');
  assert.equal(validateDisplayName('a\nb'), 'a b', 'een regeleinde wordt een spatie');
  for (const bad of ['', '   ', 'x'.repeat(101), 'a\u0007b', 7]) assert.throws(() => validateDisplayName(bad), /naam/);
  assert.equal(validatePassword('tandarts-bellen'), 'tandarts-bellen');
  assert.equal(validatePassword('éàèùôîçëäö'), 'éàèùôîçëäö', 'tekens tellen, niet bytes');
  assert.throws(() => validatePassword('qwertyuiop'), /te makkelijk te raden \(een veelgebruikt wachtwoord\)/);
  assert.throws(() => validatePassword('Wachtwoord123'), /een veelgebruikt wachtwoord/);
  assert.throws(() => validatePassword('éééééééééé'), /te weinig verschillende tekens/);
  assert.throws(() => validatePassword('annadevries01', 'annadevries'), /lijkt op de gebruikersnaam/);
  assert.throws(() => validatePassword('abcdefghi'), /minimaal 10/);
  assert.throws(() => validatePassword('x'.repeat(201)), /maximaal 200/);
  assert.throws(() => validatePassword('Annaannaanna', 'annaannaanna'), /gelijk zijn aan de gebruikersnaam/);
  assert.throws(() => validatePassword(123456789012 as unknown as string), /tekst/);
});

test('het eerste account is beheerder; namen zijn uniek ongeacht hoofdletters en accentvorm; een mislukte poging laat niets achter', () => {
  const db = freshDb();
  const first = mk(db, 'José');
  const second = mk(db, 'bob');
  assert.equal(first.is_admin, true);
  assert.equal(second.is_admin, false);
  assert.equal(mk(db, 'carol', true).is_admin, true);
  const rev = currentRev(db);
  for (const dup of ['josé', 'JOSÉ', 'José', 'BOB']) {
    assert.throws(() => mk(db, dup), /al in gebruik/, dup);
  }
  assert.equal(currentRev(db), rev, 'de versie is niet opgehoogd');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 3);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id LIKE 'inbox-%'").get() as { n: number }).n, 3, 'geen verweesde Inbox');
});

test('beheerder blijven: de laatste actieve beheerder kan niet worden gedemoveerd of geblokkeerd', () => {
  const db = freshDb();
  const admin = mk(db, 'admin');
  const user = mk(db, 'gewoon');
  assert.throws(() => updateUser(db, admin.id, { is_admin: false }), /minstens één actieve beheerder/);
  assert.throws(() => updateUser(db, admin.id, { is_disabled: true }), /minstens één actieve beheerder/);
  updateUser(db, user.id, { is_admin: true });
  assert.equal(updateUser(db, admin.id, { is_admin: false }).is_admin, false, 'met een tweede beheerder mag het wel');
  assert.throws(() => updateUser(db, user.id, { is_disabled: true }), /minstens één/, 'nu is de ander de laatste');
  assert.throws(() => updateUser(db, user.id, { is_admin: 'ja' }), /true of false/);
  assert.throws(() => updateUser(db, 'bestaat-niet-id', { name: 'x' }), /bestaat niet/);
  assert.equal(updateUser(db, admin.id, { name: 'Nieuwe  naam' }).name, 'Nieuwe naam');
});

test('sessies: het token werkt, wordt als hash bewaard, en stopt bij intrekken, blokkeren en uitloggen overal', () => {
  const db = freshDb();
  const a = mk(db, 'alice');
  const b = mk(db, 'bob');
  mk(db, 'reserve-beheerder', true); // anders is alice de laatste beheerder en kan ze niet worden geblokkeerd
  const s1 = createSession(db, a.id, 'Telefoon');
  const s2 = createSession(db, a.id, 'Laptop\nmet regeleinde');
  assert.match(s1.token, /^tky_[\w-]{43}$/);
  assert.notEqual(s1.token, s2.token);
  assert.equal(findSession(db, s1.token)!.user.id, a.id);
  assert.equal(findSession(db, s1.token)!.sessionId, s1.id);
  assert.equal(findSession(db, s1.token + 'x'), null);
  assert.equal(findSession(db, 'kort'), null);
  assert.equal(findSession(db, 'x'.repeat(500)), null);
  const stored = JSON.stringify(db.prepare('SELECT * FROM sessions').all());
  assert.ok(!stored.includes(s1.token) && !stored.includes(s2.token), 'het token zelf staat niet in de database');
  assert.deepEqual(listSessions(db, a.id).map((s) => s.name).sort(), ['Laptop met regeleinde', 'Telefoon']);
  assert.deepEqual(listSessions(db, b.id), []);

  // ook als alleen het account is geblokkeerd (zonder dat de sessies zijn ingetrokken) werkt het token niet
  db.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?').run(b.id);
  const sb = createSession(db, b.id, 'Bobs telefoon');
  assert.equal(findSession(db, sb.token), null);
  db.prepare('UPDATE users SET is_disabled = 0 WHERE id = ?').run(b.id);
  assert.ok(findSession(db, sb.token));
  assert.equal(revokeSession(db, b.id, s1.id), false, 'een ander kan jouw sessie niet intrekken');
  assert.ok(findSession(db, s1.token));
  assert.equal(revokeSession(db, a.id, s1.id), true);
  assert.equal(revokeSession(db, a.id, s1.id), false);
  assert.equal(findSession(db, s1.token), null);
  assert.ok(findSession(db, s2.token));
  updateUser(db, a.id, { is_disabled: true });
  assert.equal(findSession(db, s2.token), null, 'geblokkeerd: sessies zijn ingetrokken');
  updateUser(db, a.id, { is_disabled: false });
  assert.equal(findSession(db, s2.token), null, 'en blijven ingetrokken');
  const s3 = createSession(db, a.id, '');
  assert.equal(listSessions(db, a.id)[0].name, 'Onbekend apparaat');
  const s4 = createSession(db, a.id, 'Tablet');
  revokeSessions(db, a.id, s4.id);
  assert.equal(findSession(db, s3.token), null);
  assert.ok(findSession(db, s4.token));
});

test('last_used_at wordt hooguit eens per tien minuten bijgewerkt', () => {
  const db = freshDb();
  const a = mk(db, 'alice');
  const s = createSession(db, a.id, 'x');
  const at = (): string => (db.prepare('SELECT last_used_at FROM sessions WHERE id = ?').get(s.id) as { last_used_at: string }).last_used_at;
  const created = at();
  findSession(db, s.token, Date.parse(created) + 60_000);
  assert.equal(at(), created);
  findSession(db, s.token, Date.parse(created) + 11 * 60_000);
  assert.notEqual(at(), created);
});

/** Een poging die meteen als mislukt telt (zoals bij een fout wachtwoord): `begin` telt hem, `succeed` komt niet. */
const tryLogin = (l: LoginLimiter, name: string, ip: string): number => l.begin(name, ip).wait;

test('inlogpogingen: per naam en adres, per adres en per naam over alle adressen; de limieten lopen af', () => {
  let t = 1_000_000;
  const l = new LoginLimiter({ pair: 3, ip: 20, user: 5 }, 60_000, () => t);
  for (let i = 0; i < 3; i++) assert.equal(tryLogin(l, 'anna', '1.1.1.1'), 0);
  assert.ok(tryLogin(l, 'anna', '1.1.1.1') > 0, 'de vierde poging van dit adres op deze naam wordt geweigerd');
  assert.ok(tryLogin(l, 'ANNA', '1.1.1.1') > 0, 'hoofdletters omzeilen het niet');
  assert.ok(tryLogin(l, ' anna ', '1.1.1.1') > 0, 'omringende spaties ook niet');
  assert.equal(tryLogin(l, 'anna', '2.2.2.2'), 0, 'een ander adres is niet geraakt: een aanvaller kan het account van een ander niet vergrendelen');
  assert.equal(tryLogin(l, 'bob', '1.1.1.1'), 0, 'een andere naam vanaf hetzelfde adres kan nog');
  assert.equal(tryLogin(l, 'anna', '3.3.3.3'), 0);
  assert.ok(tryLogin(l, 'anna', '4.4.4.4') > 0, 'de algemene limiet voor de naam (5) geldt over alle adressen samen');
  t += 59_000;
  assert.ok(tryLogin(l, 'anna', '1.1.1.1') > 0);
  t += 2_000;
  assert.equal(tryLogin(l, 'anna', '1.1.1.1'), 0, 'na het venster mag het weer');

  // geweigerde pogingen tellen niet mee: wie blijft proberen, houdt zichzelf niet eindeloos buiten
  const w = new LoginLimiter({ pair: 2, ip: 100, user: 100 }, 60_000, () => t);
  tryLogin(w, 'anna', 'x'); tryLogin(w, 'anna', 'x');
  const first = w.begin('anna', 'x').wait;
  for (let i = 0; i < 50; i++) w.begin('anna', 'x');
  assert.equal(w.begin('anna', 'x').wait, first, 'de wachttijd groeit niet door geweigerde pogingen');

  const m = new LoginLimiter({ pair: 100, ip: 5, user: 100 }, 60_000, () => t);
  for (let i = 0; i < 5; i++) assert.equal(tryLogin(m, `gebruiker${i}`, '4.4.4.4'), 0);
  assert.ok(tryLogin(m, 'nieuw', '4.4.4.4') > 0, 'veel verschillende namen vanaf één adres');
  assert.equal(tryLogin(m, 'nieuw', '5.5.5.5'), 0);

  const s = new LoginLimiter({ pair: 3, ip: 100, user: 100 }, 60_000, () => t);
  tryLogin(s, 'anna', 'x'); tryLogin(s, 'anna', 'x');
  const ok = s.begin('anna', 'x');
  s.succeed(ok.attempt!);
  tryLogin(s, 'anna', 'x'); tryLogin(s, 'anna', 'x');
  assert.equal(tryLogin(s, 'anna', 'x'), 0, 'een geslaagde poging begint de telling voor deze naam en dit adres opnieuw');

  const c = new LoginLimiter({ pair: 1, ip: 100, user: 100 }, 60_000, () => t);
  const busy = c.begin('anna', 'x');
  c.cancel(busy.attempt!);
  assert.equal(tryLogin(c, 'anna', 'x'), 0, 'een geannuleerde poging (server druk) telt niet');
});

test('inlogpogingen: gelijktijdige pogingen worden geteld voordat het wachtwoord is gecontroleerd', () => {
  const l = new LoginLimiter({ pair: 8, ip: 1000, user: 1000 }, 60_000, () => 1_000_000);
  const results = Array.from({ length: 200 }, () => l.begin('victim', '1.1.1.1')); // allemaal "tegelijk": geen enkele is al afgehandeld
  assert.equal(results.filter((r) => r.attempt).length, 8, 'hoogstens 8 komen er door, ook al is er nog geen enkele afgehandeld');
});

test('inlogpogingen: IPv6 telt per /64, IPv4 in IPv6-vorm als IPv4', () => {
  assert.equal(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipBucket('2001:0db8:0001:0002::1'));
  assert.equal(ipBucket('2001:db8:1:2::1'), '2001:0db8:0001:0002::/64');
  assert.notEqual(ipBucket('2001:db8:1:2::1'), ipBucket('2001:db8:1:3::1'));
  assert.equal(ipBucket('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
  assert.equal(ipBucket('fe80::1%eth0'), ipBucket('fe80::2'));
  assert.equal(ipBucket('::1'), '0000:0000:0000:0000::/64');
  const l = new LoginLimiter({ pair: 100, ip: 3, user: 100 }, 60_000, () => 1_000_000);
  for (let i = 0; i < 3; i++) assert.equal(tryLogin(l, `n${i}`, `2001:db8:1:2::${i + 1}`), 0);
  assert.ok(tryLogin(l, 'n9', '2001:db8:1:2:ffff:ffff:ffff:ffff') > 0, 'een ander adres in hetzelfde /64 omzeilt de adreslimiet niet');
  assert.equal(tryLogin(l, 'n9', '2001:db8:1:3::1'), 0, 'een ander /64 is een andere bron');
});

test('inlogpogingen: het geheugen is begrensd en loopt niet in één keer leeg', () => {
  let t = 1_000_000;
  const sweep = new LoginLimiter({ pair: 3, ip: 3, user: 3 }, 60_000, () => t);
  for (let i = 0; i < 1500; i++) sweep.begin(`naam${i}`, `adres${i}`); // veel verschillende afzenders, niemand komt terug
  assert.equal(sweep.hits.size, 4500);
  t += 61_000;
  sweep.begin('nieuw', 'adres-nieuw');
  sweep.maxKeys = 10;
  for (let i = 0; i < 20; i++) sweep.begin(`x${i}`, `y${i}`); // forceert het opruimen: eerst het verlopene, dan de oudste
  assert.ok(sweep.hits.size <= 10 && sweep.hits.size > 0, 'verlopen tellers zijn opgeruimd en er blijft wat over');

  const big = new LoginLimiter({ pair: 3, ip: 3, user: 3 }, 60_000, () => t);
  big.maxKeys = 1000;
  const recent = big.begin('lopende-aanval', '9.9.9.9');
  for (let i = 0; i < 3; i++) big.begin('lopende-aanval', '9.9.9.9');
  for (let i = 0; i < 2000; i++) big.begin(`naam${i}`, `ip${i}`);
  assert.ok(big.hits.size <= 1000, 'geheugen blijft begrensd');
  assert.ok(big.hits.size > 300, 'er wordt niet alles in één keer gewist');
  void recent;
});

test('je ziet alleen jezelf en wie een project met je deelt', () => {
  const db = freshDb();
  const a = mk(db, 'alice');
  const b = mk(db, 'bob');
  const c = mk(db, 'carol');
  const names = (id: string) => peersOf(db, id).map((u) => u.username);
  assert.deepEqual(names(a.id), ['alice']);
  const p = { type: 'project_add', uuid: 'peers-test-0001', args: { id: 'project-peers-01', name: 'Samen' } };
  const share = { type: 'project_share', uuid: 'peers-test-0002', args: { project_id: 'project-peers-01', username: 'bob' } };
  handleSync(db, { commands: [p, share] }, a.id);
  assert.deepEqual(names(a.id), ['alice', 'bob']);
  assert.deepEqual(names(b.id), ['alice', 'bob']);
  assert.deepEqual(names(c.id), ['carol']);
  assert.deepEqual(Object.keys(peersOf(db, a.id)[0]).sort(), ['id', 'name', 'username'], 'geen wachtwoordhash of andere interne velden');
});
