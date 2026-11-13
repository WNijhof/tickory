import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { currentRev } from './sync.ts';
import { freshDb } from './testutil.ts';
import {
  LoginLimiter, createSession, createUser, findSession, hashPassword, listSessions, peersOf, revokeSession, revokeSessions, setPasswordCostForTests,
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
  assert.equal(validatePassword('abcdefghij'), 'abcdefghij');
  assert.equal(validatePassword('éééééééééé'), 'éééééééééé', 'tekens tellen, niet bytes');
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

test('inlogpogingen: te veel mislukkingen blokkeren per gebruikersnaam en per adres, en lopen af', () => {
  let t = 1_000_000;
  const l = new LoginLimiter({ user: 3, ip: 5 }, 60_000, () => t);
  assert.equal(l.retryAfter('anna', '1.1.1.1'), 0);
  for (let i = 0; i < 3; i++) l.fail('anna', '1.1.1.1');
  assert.ok(l.retryAfter('anna', '2.2.2.2') > 0, 'de gebruikersnaam is vergrendeld, van welk adres ook');
  assert.ok(l.retryAfter('ANNA', '3.3.3.3') > 0, 'hoofdletters omzeilen het niet');
  assert.equal(l.retryAfter('bob', '9.9.9.9'), 0, 'een ander account is niet geraakt');
  t += 59_000;
  assert.ok(l.retryAfter('anna', '2.2.2.2') > 0);
  t += 2_000;
  assert.equal(l.retryAfter('anna', '2.2.2.2'), 0, 'na het venster mag het weer');
  const sweep = new LoginLimiter({ user: 3, ip: 3 }, 60_000, () => t);
  for (let i = 0; i < 1500; i++) sweep.fail(`naam${i}`, `adres${i}`); // veel verschillende afzenders, niemand komt terug
  assert.equal(sweep.hits.size, 3000);
  t += 61_000;
  sweep.fail('nieuw', 'adres-nieuw');
  assert.equal(sweep.hits.size, 2, 'verlopen pogingen worden opgeruimd; alleen de nieuwe staat er nog');

  const m = new LoginLimiter({ user: 100, ip: 5 }, 60_000, () => t);
  for (let i = 0; i < 5; i++) m.fail(`gebruiker${i}`, '4.4.4.4');
  assert.ok(m.retryAfter('nieuw', '4.4.4.4') > 0, 'veel verschillende namen vanaf één adres');
  assert.equal(m.retryAfter('nieuw', '5.5.5.5'), 0);
  const s = new LoginLimiter({ user: 3, ip: 100 }, 60_000, () => t);
  s.fail('anna', 'x'); s.fail('anna', 'x');
  s.success('anna');
  s.fail('anna', 'x'); s.fail('anna', 'x');
  assert.equal(s.retryAfter('anna', 'x'), 0, 'een geslaagde poging begint de telling opnieuw');
  const big = new LoginLimiter({ user: 3, ip: 3 }, 60_000, () => t);
  for (let i = 0; i < 12_000; i++) big.fail(`naam${i}`, `ip${i}`);
  assert.ok(big.hits.size <= 20_000, 'geheugen blijft begrensd');
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
