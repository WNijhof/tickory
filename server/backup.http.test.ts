// Een back-up downloaden als beheerder: het downloadbewijs (wachtwoord, en een code bij tweestapsverificatie), eenmalig en kort
// geldig, alleen voor beheerders, een grens per uur, het tar-archief zelf (database en bijlagen; ook met het gewone `tar`
// gecontroleerd als dat er is), de logregel en het opruimen van de tijdelijke kopie.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './main.ts';
import { createAttachments } from './attachments.ts';
import { createSchema, SCHEMA_VERSION } from './schema.ts';
import { handleSync } from './sync.ts';
import { createBackupArchive, readTar, removeStaleTemp, tarHeader } from './backupArchive.ts';
import { LoginLimiter, createSession, createUser, hashPassword, revokeSession, setPasswordCostForTests } from './users.ts';

setPasswordCostForTests(1024);
const PW = 'een-goed-wachtwoord';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(70_000)]); // groter dan één brok

function totpNow(secretB32: string, ms: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secretB32].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function world() {
  const root = mkdtempSync(join(tmpdir(), 'tickory-backup-http-'));
  const tmp = join(root, 'data');
  mkdirSync(tmp);
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const alice = createUser(db, { username: 'alice', name: 'Alice', passwordHash: await hashPassword(PW) });
  const bob = createUser(db, { username: 'bob', name: 'Bob', passwordHash: await hashPassword(PW) });
  const attachments = createAttachments(db, { dir: join(root, 'attachments'), maxUploadBytes: 1_000_000, quotaBytes: 10_000_000 });
  const clock = { now: Date.now() };
  const lines: string[] = [];
  const app = createApp({
    db, attachments, attachmentSweepMs: 0, sessionSweepMs: 0, clock: () => clock.now, log: (l) => lines.push(l), backup: { tmpDir: tmp },
    passwordLimiter: new LoginLimiter({ pair: 50, ip: 500, user: 500 }, 900_000, () => clock.now),
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const tokens = { alice: createSession(db, alice.id, 'Laptop').token, bob: createSession(db, bob.id, 'Laptop').token };
  const call = async (path: string, token: string | null, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() as any };
  };
  const ticket = (token: string, body: Record<string, unknown> = { password: PW }) => call('/api/v1/admin/backup', token, body);
  const download = (t: string) => fetch(`${base}/api/v1/admin/backup/download?ticket=${encodeURIComponent(t)}`);
  // Alice heeft een taak met een bijlage
  const sync = (commands: object[]) => handleSync(db, { sync_token: '*', commands }, alice.id) as any;
  sync([{ type: 'task_add', uuid: 'backup-test-0001', args: { id: 'backup-test-task', project_id: alice.inbox_project_id, content: 'Taak met foto' } }]);
  const up = await (await fetch(`${base}/api/v1/attachments?id=backuptestatt0001&task_id=backup-test-task`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.alice}` }, body: PNG })).json() as any;
  const added = sync([{ type: 'attachment_add', uuid: 'backup-test-0002', args: { id: 'backuptestatt0001', task_id: 'backup-test-task', name: 'foto.png', size: up.size, mime: up.mime, sha256: up.sha256 } }]);
  assert.equal(added.sync_status['backup-test-0002'], 'ok');
  return { root, tmp, db, app, base, clock, lines, alice, bob, tokens, call, ticket, download, close: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('alleen een beheerder, met het eigen wachtwoord: dan een eenmalig downloadbewijs dat een minuut geldt', async () => {
  const w = await world();
  try {
    assert.equal((await w.ticket(w.tokens.bob)).status, 403, 'geen beheerder');
    assert.equal((await w.call('/api/v1/admin/backup', null, { password: PW })).status, 401, 'niet aangemeld');
    assert.equal((await w.ticket(w.tokens.alice, { password: 'verkeerd-wachtwoord' })).status, 403, 'fout wachtwoord');
    assert.equal((await w.ticket(w.tokens.alice, {})).status, 403, 'geen wachtwoord');
    assert.equal((await w.call('/api/v1/admin/backup', w.tokens.alice)).status, 405, 'alleen POST');
    const t = await w.ticket(w.tokens.alice);
    assert.equal(t.status, 200);
    assert.match(t.body.ticket, /^tkb_[\w-]{43}$/);
    assert.equal(t.body.expires_in, 60);
    assert.equal(t.body.path, `/api/v1/admin/backup/download?ticket=${t.body.ticket}`);
    assert.ok(!t.body.path.includes(w.tokens.alice), 'het sessietoken staat niet in het adres');
    // zonder of met een verzonnen bewijs: niets
    assert.equal((await w.download('')).status, 403);
    assert.equal((await w.download('tkb_verzonnen')).status, 403);
    assert.equal((await w.download(w.tokens.alice)).status, 403, 'een sessietoken is geen downloadbewijs');
    const first = await w.download(t.body.ticket);
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    assert.equal((await w.download(t.body.ticket)).status, 403, 'eenmalig');
    // verlopen bewijs
    const late = await w.ticket(w.tokens.alice);
    w.clock.now += 61_000;
    assert.equal((await w.download(late.body.ticket)).status, 403, 'na een minuut niet meer');
    // de sessie waarmee het bewijs is aangevraagd is intussen afgemeld
    const revoked = await w.ticket(w.tokens.alice);
    const sessionId = (w.db.prepare("SELECT id FROM sessions WHERE user_id = ? AND name = 'Laptop'").get(w.alice.id) as any).id;
    revokeSession(w.db, w.alice.id, sessionId);
    assert.equal((await w.download(revoked.body.ticket)).status, 403, 'afgemeld: het bewijs vervalt');
    // tussen het bewijs en de download geen beheerder meer
    const fresh = createSession(w.db, w.alice.id, 'Tweede laptop').token;
    const demoted = await w.ticket(fresh);
    assert.equal(demoted.status, 200);
    w.db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(w.alice.id);
    assert.equal((await w.download(demoted.body.ticket)).status, 403, 'geen beheerder meer: het bewijs vervalt');
  } finally { await w.close(); }
});

test('het archief: een tar met de database (te openen, met de gegevens) en de bijlagen; logregel; tijdelijke kopie opgeruimd', async () => {
  const w = await world();
  try {
    const r = await w.download((await w.ticket(w.tokens.alice)).body.ticket);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/x-tar');
    assert.match(r.headers.get('content-disposition')!, /^attachment; filename="tickory-backup-\d{4}-\d{2}-\d{2}\.tar"$/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const tar = Buffer.from(await r.arrayBuffer());
    assert.equal(tar.length % 512, 0, 'het archief bestaat uit hele blokken');
    assert.ok(tar.subarray(tar.length - 1024).every((b) => b === 0), 'het archief eindigt met twee lege blokken');
    const files = readTar(tar);
    const key = (w.db.prepare('SELECT key FROM attachment_files').get() as any).key as string;
    assert.deepEqual([...files.keys()].sort(), ['LEESMIJ.txt', `attachments/${key.slice(0, 2)}/${key}`, 'tickory-backup.json', 'tickory.db'].sort());
    assert.deepEqual(files.get(`attachments/${key.slice(0, 2)}/${key}`), PNG, 'de bijlage is byte voor byte gelijk');
    const manifest = JSON.parse(files.get('tickory-backup.json')!.toString());
    assert.equal(manifest.schema_version, SCHEMA_VERSION);
    assert.equal(manifest.attachments, 1);
    assert.equal(manifest.attachments_missing, 0);
    assert.match(files.get('LEESMIJ.txt')!.toString(), /docker compose down[\s\S]*tar -xf[\s\S]*cp \/herstel\/tickory\.db \/data\/todo\.db/);
    // de database uit het archief openen
    const out = join(w.root, 'uit.db');
    writeFileSync(out, files.get('tickory.db')!);
    const copy = new DatabaseSync(out, { readOnly: true });
    try {
      assert.deepEqual((copy.prepare('SELECT username FROM users ORDER BY username').all() as any[]).map((u) => u.username), ['alice', 'bob']);
      assert.equal((copy.prepare("SELECT content FROM tasks WHERE id = 'backup-test-task'").get() as any).content, 'Taak met foto');
      assert.equal((copy.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
    } finally { copy.close(); }
    assert.ok(w.lines.some((l) => /^\[beheer\] back-up gedownload door "alice": [\d.]+ MB, 1 bijlage\(n\)$/.test(l)), w.lines.join('\n'));
    assert.deepEqual(readdirSync(w.tmp), [], 'geen tijdelijke kopie achtergebleven');
    // met het gewone tar-programma (als dat er is): dezelfde inhoud
    const tarFile = join(w.root, 'b.tar');
    writeFileSync(tarFile, tar);
    const listed = spawnSync('tar', ['-tf', tarFile], { encoding: 'utf8' });
    if (listed.status === 0) {
      const names = listed.stdout.split(/\r?\n/).filter(Boolean).map((n) => n.replace(/\/$/, ''));
      for (const name of ['tickory.db', 'tickory-backup.json', 'LEESMIJ.txt', 'attachments', `attachments/${key.slice(0, 2)}/${key}`]) assert.ok(names.includes(name), `tar -tf toont ${name}: ${names.join(', ')}`);
      const dest = join(w.root, 'uitgepakt');
      mkdirSync(dest);
      assert.equal(spawnSync('tar', ['-xf', tarFile, '-C', dest]).status, 0, 'tar -xf pakt het uit');
      assert.ok(existsSync(join(dest, 'tickory.db')) && existsSync(join(dest, 'attachments', key.slice(0, 2), key)));
    }
  } finally { await w.close(); }
});

test('met tweestapsverificatie is ook een code nodig; hooguit vijf back-ups per uur', async () => {
  const w = await world();
  try {
    const setup = await w.call('/api/v1/auth/2fa/setup', w.tokens.alice, { password: PW });
    assert.equal((await w.call('/api/v1/auth/2fa/enable', w.tokens.alice, { code: totpNow(setup.body.secret, w.clock.now) })).status, 200);
    w.clock.now += 30_000;
    assert.equal((await w.ticket(w.tokens.alice)).status, 403, 'zonder code');
    assert.equal((await w.ticket(w.tokens.alice, { password: PW, code: '12345' })).body.error_code, 'INVALID_CODE');
    for (let i = 0; i < 5; i++) {
      const t = await w.ticket(w.tokens.alice, { password: PW, code: totpNow(setup.body.secret, w.clock.now) });
      assert.equal(t.status, 200, `back-up ${i + 1}`);
      w.clock.now += 30_000; // elke code geldt maar één keer: een nieuw tijdvak
    }
    const sixth = await w.ticket(w.tokens.alice, { password: PW, code: totpNow(setup.body.secret, w.clock.now) });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.error_code, 'TOO_MANY_REQUESTS');
    w.clock.now += 3_600_000;
    assert.equal((await w.ticket(w.tokens.alice, { password: PW, code: totpNow(setup.body.secret, w.clock.now) })).status, 200, 'een uur later weer');
  } finally { await w.close(); }
});

test('een bijlage die tussen de kopie en het inpakken verdwijnt, wordt overgeslagen en gemeld; een achtergebleven kopie wordt opgeruimd', async () => {
  const w = await world();
  try {
    const key = (w.db.prepare('SELECT key FROM attachment_files').get() as any).key as string;
    rmSync(join(w.root, 'attachments', key.slice(0, 2), key));
    const files = readTar(Buffer.from(await (await w.download((await w.ticket(w.tokens.alice)).body.ticket)).arrayBuffer()));
    assert.equal(JSON.parse(files.get('tickory-backup.json')!.toString()).attachments_missing, 1);
    assert.ok(w.lines.some((l) => l.endsWith('0 bijlage(n), 1 ontbrekend')));
    writeFileSync(join(w.tmp, '.tickory-backup-0123456789abcdef.db'), 'oud');
    writeFileSync(join(w.tmp, 'todo.db'), 'blijft');
    assert.equal(removeStaleTemp(w.tmp), 1);
    assert.deepEqual(readdirSync(w.tmp), ['todo.db']);
  } finally { await w.close(); }
});

test('een bijlage van een zojuist verwijderde taak (bestand nog even bewaard voor terugzetten) gaat niet mee, net als met server/backup.ts', async () => {
  const w = await world();
  try {
    const r = handleSync(w.db, { sync_token: '*', commands: [{ type: 'task_delete', uuid: 'backup-test-0003', args: { id: 'backup-test-task' } }] }, w.alice.id) as any;
    assert.equal(r.sync_status['backup-test-0003'], 'ok');
    const key = (w.db.prepare('SELECT key FROM attachment_files').get() as any)?.key as string | undefined;
    if (key) assert.ok(existsSync(join(w.root, 'attachments', key.slice(0, 2), key)), 'het bestand staat er nog (wachttijd voor terugzetten)');
    const files = readTar(Buffer.from(await (await w.download((await w.ticket(w.tokens.alice)).body.ticket)).arrayBuffer()));
    assert.deepEqual([...files.keys()].filter((k) => k.startsWith('attachments/')), []);
    assert.equal(JSON.parse(files.get('tickory-backup.json')!.toString()).attachments, 0);
  } finally { await w.close(); }
});

test('het archief los: de tijdelijke kopie verdwijnt vanzelf zodra alles gelezen is, en ook als er niets gelezen wordt (cleanup)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tickory-archive-'));
  try {
    const db = new DatabaseSync(':memory:');
    createSchema(db);
    const a = createBackupArchive(db, { tmpDir: root, attachmentsDir: null, schemaVersion: SCHEMA_VERSION });
    assert.equal(readdirSync(root).length, 1, 'de kopie staat klaar');
    const parts: Buffer[] = [];
    for await (const part of a.chunks) parts.push(part);
    assert.deepEqual(readdirSync(root), [], 'na het lezen opgeruimd, zonder cleanup aan te roepen');
    assert.ok(readTar(Buffer.concat(parts)).has('tickory.db'));
    const b = createBackupArchive(db, { tmpDir: root, attachmentsDir: null, schemaVersion: SCHEMA_VERSION });
    b.cleanup();
    assert.deepEqual(readdirSync(root), [], 'nooit gelezen: cleanup ruimt op');
    assert.throws(() => createBackupArchive(db, { tmpDir: join(root, 'bestaat-niet'), attachmentsDir: null, schemaVersion: SCHEMA_VERSION }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tar-koppen: controlesom, octale velden, base-256 voor heel grote bestanden, en alleen veilige namen', () => {
  const h = tarHeader('tickory.db', 1234, 1_700_000_000);
  assert.equal(h.length, 512);
  assert.equal(h.subarray(124, 135).toString(), (1234).toString(8).padStart(11, '0'));
  assert.equal(h.subarray(257, 263).toString(), 'ustar\0');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  assert.equal(parseInt(h.subarray(148, 156).toString(), 8), sum);
  const big = tarHeader('groot.bin', 9 * 1024 ** 3, 0);
  assert.equal(big[124], 0x80, 'groter dan 8 GiB: base-256');
  assert.equal(big.readUIntBE(130, 6), 9 * 1024 ** 3);
  assert.equal(String.fromCharCode(tarHeader('map/', 0, 0, 'dir')[156]), '5');
  for (const bad of ['', 'a b', 'x'.repeat(100), 'é', 'a\nb']) assert.throws(() => tarHeader(bad, 0, 0), /ongeldige naam/, bad);
});
