// De echte server (server/main.ts) met bijlagen: de map naast de database, MAX_UPLOAD_MB en ATTACHMENT_QUOTA_MB uit de omgeving,
// en de controle bij het opstarten. Draait main.ts als eigen proces, zoals een beheerder het doet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { megabytesFrom } from './main.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });

test('megabytesFrom: een getal, de standaardwaarde bij niets, en een waarschuwing bij onzin', () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (m: string) => { warnings.push(m); };
  try {
    assert.equal(megabytesFrom({ X: '40' }, 'X', 25), 40);
    assert.equal(megabytesFrom({ X: '0.5' }, 'X', 25), 0.5);
    assert.equal(megabytesFrom({}, 'X', 25), 25);
    assert.equal(megabytesFrom({ X: '  ' }, 'X', 25), 25);
    assert.deepEqual(warnings, []);
    for (const bad of ['abc', '-5', '0', '1e99', 'Infinity', '25 MB']) assert.equal(megabytesFrom({ X: bad }, 'X', 25), 25, bad);
    assert.equal(warnings.length, 6);
    assert.match(warnings[0], /X is geen geldig aantal megabytes/);
  } finally {
    console.warn = original;
  }
});

test('de server als proces: de map staat naast de database, de grenzen komen uit de omgeving, en na een herstart is alles er nog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tickory-startup-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, DB_PATH: join(dir, 'todo.db'), PORT: String(port), HOST: '127.0.0.1', TODO_ADMIN_USER: 'anna', TODO_ADMIN_PASSWORD: 'een-lang-wachtwoord-77',
    MAX_UPLOAD_MB: '1', ATTACHMENT_QUOTA_MB: '3', ATTACHMENTS_DIR: '',
  };
  let output = '';
  const start = () => {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'main.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    return child;
  };
  const ready = async () => { for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* nog niet */ } await sleep(100); } throw new Error(`server start niet: ${output}`); };
  let child = start();
  const stop = async () => { child.kill('SIGTERM'); await sleep(400); };
  try {
    await ready();
    const login = (await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'anna', password: 'een-lang-wachtwoord-77', device_name: 'test' }) })).json()) as { token: string; me: { inbox_project_id: string } };
    const auth = { Authorization: `Bearer ${login.token}` };
    const sync = async (commands: object[]) => (await (await fetch(`${base}/api/v1/sync`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ commands }) })).json()) as { sync_status: Record<string, unknown> };
    await sync([{ type: 'task_add', uuid: 'startup-0000001', args: { id: 'startup-task-01', project_id: login.me.inbox_project_id, content: 'Taak' } }]);
    assert.deepEqual(await (await fetch(`${base}/api/v1/attachments/limits`, { headers: auth })).json(), { max_upload_bytes: 1_000_000, quota_bytes: 3_000_000, used_bytes: 0, per_task: 20 });

    const up = await fetch(`${base}/api/v1/attachments?id=startup-bijl-01&task_id=startup-task-01`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(900_000, 7) });
    assert.equal(up.status, 200);
    const meta = (await up.json()) as { size: number; mime: string; sha256: string };
    const added = await sync([{ type: 'attachment_add', uuid: 'startup-0000002', args: { id: 'startup-bijl-01', task_id: 'startup-task-01', name: 'groot.bin', size: meta.size, mime: meta.mime, sha256: meta.sha256 } }]);
    assert.equal(added.sync_status['startup-0000002'], 'ok');
    assert.equal((await fetch(`${base}/api/v1/attachments?id=startup-bijl-02&task_id=startup-task-01`, { method: 'POST', headers: auth, body: Buffer.alloc(1_000_001, 1) })).status, 413, 'MAX_UPLOAD_MB=1');
    assert.ok(existsSync(join(dir, 'attachments')), 'de map staat naast de database');
    assert.equal(readdirSync(join(dir, 'attachments')).filter((d) => /^[0-9a-f]{2}$/.test(d)).length, 1);

    // een zwerver en een tijdelijk bestand van een eerdere crash, terwijl de server uit staat
    await stop();
    mkdirSync(join(dir, 'attachments', 'ab'), { recursive: true });
    writeFileSync(join(dir, 'attachments', 'ab', 'abcdef0123456789abcdef0123456789'), 'zwerver');
    writeFileSync(join(dir, 'attachments', 'tmp', 'half'), 'half');
    output = '';
    child = start();
    await ready();
    assert.match(output, /Bijlagen gecontroleerd: 1 bestand\(en\) zonder bijlage opgeruimd/);
    assert.equal(existsSync(join(dir, 'attachments', 'ab', 'abcdef0123456789abcdef0123456789')), false);
    assert.deepEqual(readdirSync(join(dir, 'attachments', 'tmp')), []);
    const again = (await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'anna', password: 'een-lang-wachtwoord-77', device_name: 'test' }) })).json()) as { token: string };
    const dl = await fetch(`${base}/api/v1/attachments/startup-bijl-01`, { headers: { Authorization: `Bearer ${again.token}` } });
    assert.equal(dl.status, 200);
    assert.equal(Buffer.from(await dl.arrayBuffer()).length, 900_000);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
