// Het eerste account bij de eerste start: uit TODO_ADMIN_USER met TODO_ADMIN_PASSWORD of TODO_ADMIN_PASSWORD_FILE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminPasswordFrom, createFirstAccount } from './main.ts';
import { freshDb, addUser } from './testutil.ts';
import { getUserByName, setPasswordCostForTests, verifyPassword } from './users.ts';

setPasswordCostForTests(1024);

function withDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'tickory-first-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('het wachtwoord komt uit de omgeving, of uit een bestand (zoals een Docker-secret) zonder de eindregel', (t) => {
  const dir = withDir(t);
  const file = join(dir, 'admin-wachtwoord');
  writeFileSync(file, 'een-goed-wachtwoord\n');
  assert.equal(adminPasswordFrom({ TODO_ADMIN_PASSWORD: 'direct-wachtwoord' }), 'direct-wachtwoord');
  assert.equal(adminPasswordFrom({ TODO_ADMIN_PASSWORD_FILE: file }), 'een-goed-wachtwoord');
  writeFileSync(file, 'met-windows-eindregel\r\n');
  assert.equal(adminPasswordFrom({ TODO_ADMIN_PASSWORD_FILE: file }), 'met-windows-eindregel');
  assert.equal(adminPasswordFrom({ TODO_ADMIN_PASSWORD: 'wint', TODO_ADMIN_PASSWORD_FILE: file }), 'wint', 'de omgeving gaat voor');
  assert.equal(adminPasswordFrom({}), undefined);
  assert.throws(() => adminPasswordFrom({ TODO_ADMIN_PASSWORD_FILE: join(dir, 'bestaat-niet') }), /TODO_ADMIN_PASSWORD_FILE .* is niet te lezen/);
});

test('het eerste account wordt beheerder en kan inloggen met het wachtwoord uit het bestand', async (t) => {
  const dir = withDir(t);
  const file = join(dir, 'wachtwoord');
  writeFileSync(file, 'paarse olifant fietst langzaam\n');
  const db = freshDb();
  const u = await createFirstAccount(db, { TODO_ADMIN_USER: 'anna', TODO_ADMIN_PASSWORD_FILE: file, TODO_ADMIN_NAME: 'Anna' });
  assert.equal(u?.is_admin, true);
  const stored = getUserByName(db, 'anna')!;
  assert.equal(await verifyPassword('paarse olifant fietst langzaam', stored.password_hash), true);
});

test('niets ingesteld, of er is al een account: er gebeurt niets; een te makkelijk wachtwoord wordt geweigerd', async () => {
  const empty = freshDb();
  assert.equal(await createFirstAccount(empty, {}), null);
  assert.equal(await createFirstAccount(empty, { TODO_ADMIN_USER: 'anna' }), null, 'zonder wachtwoord');
  await assert.rejects(createFirstAccount(empty, { TODO_ADMIN_USER: 'anna', TODO_ADMIN_PASSWORD: 'wachtwoord123' }), /te makkelijk te raden/);
  await assert.rejects(createFirstAccount(empty, { TODO_ADMIN_USER: 'anna', TODO_ADMIN_PASSWORD: 'kort' }), /minimaal 10 tekens/);
  assert.equal((empty.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 0, 'er is niets aangemaakt');
  const used = freshDb();
  addUser(used, 'bestaand');
  assert.equal(await createFirstAccount(used, { TODO_ADMIN_USER: 'anna', TODO_ADMIN_PASSWORD: 'een-goed-wachtwoord' }), null, 'het werkt alleen als er nog geen accounts zijn');
});
