// Test van de Docker-image zoals die op je server draait, met dezelfde beveiligingsinstellingen als docker-compose.yml.
// Vereist Docker. De workflow gebruikt dit vóór elke publicatie; je kunt het ook zelf draaien:
//
//   docker build -t eigen-tool:ci .
//   node scripts/docker-smoke.ts eigen-tool:ci

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const image = process.argv[2] ?? 'eigen-tool:ci';
const TOKEN = randomBytes(24).toString('base64url');
const name = `eigen-tool-smoke-${process.pid}`;
const volume = `${name}-data`;
const ok = (text: string) => console.log(`✔ ${text}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function dockerTry(...args: string[]): { code: number | null; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function start(): void {
  docker(
    'run', '-d', '--name', name, '-p', '127.0.0.1::8787', '-e', `TODO_TOKEN=${TOKEN}`, '-v', `${volume}:/data`,
    '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--init',
    // sneller controleren dan de standaard 30 seconden, zonder de HEALTHCHECK-opdracht zelf te wijzigen
    '--health-interval', '2s', '--health-start-period', '0s', '--health-timeout', '3s', image,
  );
}

async function waitHealthy(timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const state = docker('inspect', '-f', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', name);
    if (state === 'running healthy') return;
    if (state.startsWith('exited') || state.startsWith('dead')) throw new Error(`de container is gestopt:\n${dockerTry('logs', name).out}`);
    if (Date.now() > end) throw new Error(`niet gezond binnen ${timeoutMs / 1000} s (${state}):\n${dockerTry('logs', name).out}`);
    await sleep(500);
  }
}

/** De poort op de host waarop de container bereikbaar is (verandert bij elke herstart). */
function baseUrl(): string {
  const line = docker('port', name, '8787/tcp').split('\n')[0];
  const port = /:(\d+)$/.exec(line)?.[1];
  assert.ok(port, `geen poort gevonden in: ${line}`);
  return `http://127.0.0.1:${port}`;
}

async function sync(body: unknown, token: string | null = TOKEN): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl()}/api/v1/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

try {
  // ---- de image zelf ----
  const nodeVersion = docker('run', '--rm', '--entrypoint', 'node', image, '--version');
  assert.match(nodeVersion, /^v26\./, `verwacht Node 26, kreeg ${nodeVersion}`);
  const testFiles = docker('run', '--rm', '--entrypoint', 'sh', image, '-c', "find /app -name '*.test.*' | wc -l");
  assert.equal(testFiles, '0', 'testbestanden horen niet in de image');
  const files = docker('run', '--rm', '--entrypoint', 'sh', image, '-c', 'ls /app /app/client /app/shared /app/server | tr "\\n" " "');
  for (const f of ['index.html', 'sw.js', 'schema.js', 'main.ts', 'backup.ts']) assert.ok(files.includes(f), `${f} ontbreekt in de image`);
  const sizeMb = Math.round(Number(docker('image', 'inspect', '-f', '{{.Size}}', image)) / 1_048_576);
  ok(`image: ${nodeVersion}, ${sizeMb} MB, geen testbestanden, alle bestanden aanwezig`);

  // ---- zonder token start de server niet ----
  const noToken = dockerTry('run', '--rm', image);
  assert.notEqual(noToken.code, 0, 'zonder TODO_TOKEN had de container moeten stoppen');
  assert.match(noToken.out, /TODO_TOKEN/);
  const shortToken = dockerTry('run', '--rm', '-e', 'TODO_TOKEN=kort', image);
  assert.notEqual(shortToken.code, 0, 'een te kort token had geweigerd moeten worden');
  ok('zonder token of met een te kort token weigert de container te starten, met een duidelijke melding');

  // ---- starten met de beveiligingsinstellingen uit docker-compose.yml ----
  start();
  await waitHealthy();
  ok('container start en meldt zich gezond (HEALTHCHECK)');

  const health = await fetch(`${baseUrl()}/health`);
  assert.equal(health.status, 200);
  const page = await fetch(`${baseUrl()}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Taken<\/title>/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal((await fetch(`${baseUrl()}/shared/schema.js`)).status, 200);
  assert.equal((await fetch(`${baseUrl()}/server/main.ts`)).status, 404, 'servercode wordt niet uitgeleverd');
  assert.equal((await fetch(`${baseUrl()}/sw.js`)).status, 200);
  ok('de web-app wordt geleverd met CSP; servercode niet');

  assert.equal((await sync({}, null)).status, 401);
  assert.equal((await sync({}, 'fout-token-0123456789-abcdefghij')).status, 401);
  const first = await sync({ sync_token: '*' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.projects.map((p: { name: string }) => p.name), ['Inbox']);
  ok('API: zonder of met fout token 401; met token komt de Inbox terug');

  // ---- gebruiker en rechten ----
  assert.equal(docker('exec', name, 'id', '-u'), '1000', 'de app hoort niet als root te draaien');
  assert.notEqual(dockerTry('exec', name, 'sh', '-c', 'touch /app/x').code, 0, '/app hoort niet beschrijfbaar te zijn');
  assert.equal(dockerTry('exec', name, 'sh', '-c', 'touch /data/x && rm /data/x').code, 0, '/data moet wel beschrijfbaar zijn');
  ok('draait als gebruiker 1000; alleen /data is beschrijfbaar');

  // ---- gegevens blijven bewaard na een herstart ----
  const add = await sync({
    sync_token: first.json.sync_token,
    commands: [
      { type: 'project_add', uuid: 'smoke-docker-0001', args: { id: 'project-docker-01', name: 'Rooktest' } },
      { type: 'task_add', uuid: 'smoke-docker-0002', args: { id: 'task-docker-0001', project_id: 'project-docker-01', content: 'Overleeft een herstart' } },
    ],
  });
  assert.equal(add.json.sync_status['smoke-docker-0001'], 'ok');
  docker('restart', '-t', '10', name);
  await waitHealthy();
  const after = await sync({ sync_token: '*' });
  assert.deepEqual(after.json.projects.map((p: { name: string }) => p.name).sort(), ['Inbox', 'Rooktest']);
  assert.deepEqual(after.json.tasks.map((t: { content: string }) => t.content), ['Overleeft een herstart']);
  const again = await sync({ sync_token: after.json.sync_token, commands: [{ type: 'project_add', uuid: 'smoke-docker-0001', args: { id: 'project-docker-01', name: 'Rooktest' } }] });
  assert.equal(again.json.sync_status['smoke-docker-0001'], 'ok', 'een herhaald commando na de herstart is idempotent');
  assert.equal(again.json.sync_token, after.json.sync_token, 'en verandert niets');
  ok('gegevens en idempotentie overleven een herstart van de container');

  // ---- een back-up terwijl de server draait ----
  const backup = dockerTry('exec', name, 'node', 'server/backup.ts', '/data/backups/smoke.db');
  assert.equal(backup.code, 0, backup.out);
  assert.match(backup.out, /Back-up gemaakt/);
  const taskCount = docker('exec', name, 'node', '-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/backups/smoke.db',{readOnly:true});console.log(d.prepare('select count(*) n from tasks').get().n)");
  assert.equal(taskCount, '1');
  ok('back-up met server/backup.ts werkt in de container en bevat de gegevens');

  // ---- netjes stoppen ----
  const t0 = Date.now();
  docker('stop', '-t', '10', name);
  const secs = (Date.now() - t0) / 1000;
  assert.equal(docker('inspect', '-f', '{{.State.ExitCode}}', name), '0', 'afsluiten hoort met code 0 te gaan');
  assert.ok(secs < 8, `stoppen duurde ${secs} s: het stopsignaal wordt niet netjes afgehandeld`);
  const logs = dockerTry('logs', name).out;
  assert.ok(!logs.includes(TOKEN), 'het token mag niet in de logs staan');
  ok(`stopt netjes met afsluitcode 0 in ${secs.toFixed(1)} s; het token staat niet in de logs`);

  console.log(`\nALLE CONTROLES VAN DE IMAGE GESLAAGD\n\nlogs van de container:\n${logs}`);
} catch (err) {
  console.error('\n✖ MISLUKT:', err);
  const logs = dockerTry('logs', name).out;
  if (logs) console.error(`\nlogs van de container:\n${logs}`);
  process.exitCode = 1;
} finally {
  dockerTry('rm', '-f', name);
  dockerTry('volume', 'rm', '-f', volume);
}
