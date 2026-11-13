// Test van de Docker-image zoals die op je server draait, met dezelfde beveiligingsinstellingen als docker-compose.yml.
// Vereist Docker. De workflow gebruikt dit vóór elke publicatie; je kunt het ook zelf draaien:
//
//   docker build -t tickory:ci .
//   node scripts/docker-smoke.ts tickory:ci

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const image = process.argv[2] ?? 'tickory:ci';
const ADMIN = 'beheerder';
const PASSWORD = randomBytes(18).toString('base64url'); // 24 tekens
let TOKEN = ''; // het sessietoken na inloggen
const name = `tickory-smoke-${process.pid}`;
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

/** Start de container zoals docker-compose.yml dat doet. Standaard met de gegevens voor het eerste account. */
function start(env: string[] = [`TODO_ADMIN_USER=${ADMIN}`, `TODO_ADMIN_PASSWORD=${PASSWORD}`, 'TODO_ADMIN_NAME=De Beheerder']): void {
  docker(
    'run', '-d', '--name', name, '-p', '127.0.0.1::8787', ...env.flatMap((e) => ['-e', e]), '-v', `${volume}:/data`,
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

async function login(username: string, password: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl()}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, device_name: 'Rooktest' }),
  });
  return { status: res.status, json: await res.json() };
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

  // ---- een te zwak wachtwoord voor het eerste account: de container stopt met een duidelijke melding ----
  const weak = dockerTry('run', '--rm', '-e', `TODO_ADMIN_USER=${ADMIN}`, '-e', 'TODO_ADMIN_PASSWORD=kort', image);
  assert.notEqual(weak.code, 0, 'een te kort wachtwoord had geweigerd moeten worden');
  assert.match(weak.out, /minimaal 10 tekens/);
  ok('een te kort wachtwoord voor het eerste account wordt geweigerd, met een duidelijke melding');

  // ---- zonder gegevens voor het eerste account: de server draait, niemand kan inloggen, en een account maak je vanaf de server ----
  start([]);
  await waitHealthy();
  assert.match(dockerTry('logs', name).out, /nog geen accounts/);
  assert.equal((await login(ADMIN, PASSWORD)).status, 401);
  assert.equal((await sync({}, null)).status, 401);
  const added = dockerTry('exec', '-e', 'TODO_PASSWORD=anna-wachtwoord-123', name, 'node', 'server/main.ts', 'user', 'add', 'anna', '--name', 'Anna de Vries');
  assert.equal(added.code, 0, added.out);
  assert.match(added.out, /Account "anna" aangemaakt \(beheerder\)/, 'het eerste account is altijd beheerder');
  assert.match(docker('exec', name, 'node', 'server/main.ts', 'user', 'list'), /anna\s+Anna de Vries\s+beheerder/);
  const anna = await login('anna', 'anna-wachtwoord-123');
  assert.equal(anna.status, 200);
  assert.equal(anna.json.me.name, 'Anna de Vries');
  const short = dockerTry('exec', '-e', 'TODO_PASSWORD=kort', name, 'node', 'server/main.ts', 'user', 'add', 'ben');
  assert.notEqual(short.code, 0);
  assert.match(short.out, /minimaal 10 tekens/);
  const noTty = dockerTry('exec', name, 'node', 'server/main.ts', 'user', 'add', 'ben');
  assert.notEqual(noTty.code, 0, 'zonder terminal en zonder TODO_PASSWORD kan er geen wachtwoord worden gevraagd');
  assert.match(noTty.out, /TODO_PASSWORD/);
  ok('zonder eerste account: server draait, inloggen kan niet; "user add" in de container maakt het account (terwijl de server doorloopt)');
  dockerTry('rm', '-f', name);
  dockerTry('volume', 'rm', '-f', volume);

  // ---- starten met de beveiligingsinstellingen en het eerste account uit docker-compose.yml ----
  start();
  await waitHealthy();
  assert.match(dockerTry('logs', name).out, /Eerste account "beheerder" \(beheerder\) aangemaakt/);
  ok('container start, maakt het eerste account aan en meldt zich gezond (HEALTHCHECK)');

  const health = await fetch(`${baseUrl()}/health`);
  assert.equal(health.status, 200);
  const page = await fetch(`${baseUrl()}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Tickory<\/title>/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal((await fetch(`${baseUrl()}/shared/schema.js`)).status, 200);
  assert.equal((await fetch(`${baseUrl()}/server/main.ts`)).status, 404, 'servercode wordt niet uitgeleverd');
  assert.equal((await fetch(`${baseUrl()}/server/testutil.ts`)).status, 404);
  assert.equal((await fetch(`${baseUrl()}/sw.js`)).status, 200);
  ok('de web-app wordt geleverd met CSP; servercode niet');

  assert.equal((await sync({}, null)).status, 401);
  assert.equal((await sync({}, 'tky_verzonnen-token-0123456789-abcdefghij')).status, 401);
  assert.equal((await login(ADMIN, 'verkeerd-wachtwoord')).status, 401);
  const session = await login(ADMIN, PASSWORD);
  assert.equal(session.status, 200);
  assert.equal(session.json.me.is_admin, true);
  assert.equal(session.json.me.name, 'De Beheerder');
  TOKEN = session.json.token;
  const first = await sync({ sync_token: '*' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.projects.map((p: { name: string }) => p.name), ['Inbox']);
  ok('API: zonder aanmelding of met fout wachtwoord 401; na inloggen komt de eigen Inbox terug');

  // ---- een tweede gebruiker via de beheer-API, en gescheiden gegevens ----
  const created = await fetch(`${baseUrl()}/api/v1/admin/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ username: 'tweede', name: 'Tweede Gebruiker', password: 'tweede-wachtwoord-1' }),
  });
  assert.equal(created.status, 200);
  const second = await login('tweede', 'tweede-wachtwoord-1');
  assert.equal(second.status, 200);
  const secondInbox = (await sync({ sync_token: '*' }, second.json.token)).json.projects;
  assert.equal(secondInbox.length, 1);
  assert.notEqual(secondInbox[0].id, first.json.projects[0].id, 'ieder heeft een eigen Inbox');
  ok('een tweede account via het beheer; ieder heeft een eigen Inbox');

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
  assert.equal((dockerTry('logs', name).out.match(/Eerste account/g) ?? []).length, 1, 'na een herstart wordt er niet nog een eerste account gemaakt');
  const again = await sync({ sync_token: after.json.sync_token, commands: [{ type: 'project_add', uuid: 'smoke-docker-0001', args: { id: 'project-docker-01', name: 'Rooktest' } }] });
  assert.equal(again.json.sync_status['smoke-docker-0001'], 'ok', 'een herhaald commando na de herstart is idempotent');
  assert.equal(again.json.sync_token, after.json.sync_token, 'en verandert niets');
  ok('gegevens, de aanmelding en idempotentie overleven een herstart van de container');

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
  assert.ok(!logs.includes(TOKEN), 'het sessietoken mag niet in de logs staan');
  assert.ok(!logs.includes(PASSWORD), 'het wachtwoord mag niet in de logs staan');
  ok(`stopt netjes met afsluitcode 0 in ${secs.toFixed(1)} s; wachtwoord en token staan niet in de logs`);

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
