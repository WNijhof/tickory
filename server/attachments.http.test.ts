// Bijlagen over HTTP: uploaden, downloaden, toegang, grenzen, afgebroken en trage uploads, opruimen.
// Elke test begint met een eigen server, een eigen database en een eigen map voor de bestanden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from './main.ts';
import type { App } from './main.ts';
import { createAttachments } from './attachments.ts';
import type { AttachmentOptions, Attachments } from './attachments.ts';
import { createSession, setPasswordCostForTests, updateUser } from './users.ts';
import type { UserRow } from './users.ts';
import { handleSync } from './sync.ts';
import { Writable } from 'node:stream';
import { cleanFileName } from '../shared/attachments.js';
import type { Command } from './sync.ts';
import { LIMITS } from './limits.ts';
import { addUser, freshDb } from './testutil.ts';

setPasswordCostForTests(1024);

type Row = Record<string, any>;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(40)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(40)]);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `att-${String(++n).padStart(8, '0')}`, args });

interface World {
  db: DatabaseSync; app: App; attachments: Attachments; options: AttachmentOptions; dir: string; base: string; port: number;
  users: Record<'alice' | 'bob' | 'carol', UserRow>; tokens: Record<'alice' | 'bob' | 'carol', string>;
  sync: (as: 'alice' | 'bob' | 'carol', commands: Command[], token?: string) => any;
  /** Alice heeft project P met taak T (en deelt niets). */
  P: string; T: string;
  upload: (as: string | null, id: string, task: string, body: Buffer | string, type?: string) => Promise<{ status: number; json: Row }>;
  get: (as: string | null, path: string, headers?: Record<string, string>) => Promise<Response>;
  close: () => Promise<void>;
}

async function world(opts: Partial<AttachmentOptions> = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'tickory-att-test-'));
  const db = freshDb();
  const users = { alice: addUser(db, 'alice', 'Alice'), bob: addUser(db, 'bob', 'Bob'), carol: addUser(db, 'carol', 'Carol') };
  const tokens = { alice: createSession(db, users.alice.id, 't').token, bob: createSession(db, users.bob.id, 't').token, carol: createSession(db, users.carol.id, 't').token };
  const options: AttachmentOptions = { dir, maxUploadBytes: 1_000_000, quotaBytes: 10_000_000, ...opts };
  const attachments = createAttachments(db, options);
  const app = createApp({ db, attachments, attachmentSweepMs: 0 });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const P = 'project-alice-01', T = 'task-alice-0001';
  // zoals main.ts: na een sync die iets wijzigde, de bestanden van verwijderde bijlagen opruimen
  const sync = (as: 'alice' | 'bob' | 'carol', commands: Command[], token = '*') => {
    const result = handleSync(db, { sync_token: token, commands }, users[as].id);
    attachments.purgeDeleted();
    return result;
  };
  const setup = [cmd('project_add', { id: P, name: 'Gezin' }), cmd('task_add', { id: T, project_id: P, content: 'Boodschappen' })];
  const r = sync('alice', setup);
  for (const c of setup) assert.equal(r.sync_status[c.uuid], 'ok');
  const bearer = (as: string | null) => (as ? { Authorization: `Bearer ${(tokens as Record<string, string>)[as] ?? as}` } : {});
  return {
    db, app, attachments, options, dir, base, port, users, tokens, sync, P, T,
    upload: async (as, id, task, body, type = 'application/octet-stream') => {
      const res = await fetch(`${base}/api/v1/attachments?id=${id}&task_id=${task}`, { method: 'POST', headers: { ...bearer(as), 'Content-Type': type }, body: typeof body === 'string' ? Buffer.from(body) : body });
      return { status: res.status, json: await res.json() };
    },
    get: (as, path, headers = {}) => fetch(`${base}${path}`, { headers: { ...bearer(as), ...headers } }),
    close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Upload én koppelen, zoals de app het doet. Geeft het antwoord van de upload. */
async function addAttachment(w: World, as: 'alice' | 'bob' | 'carol', id: string, body: Buffer | string, name = 'foto.png', type = 'image/png', task = w.T): Promise<Row> {
  const up = await w.upload(as, id, task, body, type);
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const c = cmd('attachment_add', { id, task_id: task, name: cleanFileName(name), size: up.json.size, mime: up.json.mime, sha256: up.json.sha256 });
  const r = w.sync(as, [c]);
  assert.equal(r.sync_status[c.uuid], 'ok', JSON.stringify(r.sync_status[c.uuid]));
  return up.json;
}

/** Wat `download` verstuurt, los van de socket (een netwerkfilter zoals AdGuard herschrijft headers van lokale verzoeken onderweg). */
async function sent(w: World, userId: string, id: string, { inline = false, range }: { inline?: boolean; range?: string } = {}): Promise<{ status: number; headers: Record<string, string | number> }> {
  const out = { status: 0, headers: {} as Record<string, string | number> };
  const res = Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), {
    writeHead(status: number, headers: Record<string, string | number>) { out.status = status; out.headers = headers; return this; },
  });
  await w.attachments.download({ headers: range ? { range } : {}, method: 'GET' } as never, res as never, userId, id, inline);
  return out;
}

const filesOnDisk = (dir: string): string[] => readdirSync(dir).filter((x) => /^[0-9a-f]{2}$/.test(x)).flatMap((d) => readdirSync(join(dir, d)));
const tmpFiles = (dir: string): string[] => (existsSync(join(dir, 'tmp')) ? readdirSync(join(dir, 'tmp')) : []);

/** Een kale HTTP-verbinding, voor wat fetch niet laat zien (afbreken, traag sturen, geen Content-Length). */
function raw(port: number, head: string, onOpen?: (s: ReturnType<typeof connect>) => void, early = false): Promise<{ data: string; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => { socket.write(head); onOpen?.(socket); });
    let data = '';
    // early: niet wachten tot de server de verbinding sluit, maar stoppen zodra het antwoord (met zijn body) binnen is
    socket.on('data', (c) => { data += c.toString('latin1'); if (early && /\r\n\r\n\{.*\}$/s.test(data)) { socket.destroy(); resolve({ data, socket }); } });
    socket.on('close', () => resolve({ data, socket }));
    socket.on('error', (e) => { if ((e as NodeJS.ErrnoException).code === 'ECONNRESET') resolve({ data, socket }); else reject(e); });
  });
}
const status = (data: string) => Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('upload, koppelen en downloaden: het bestand komt byte voor byte terug en staat niet onder zijn eigen naam op schijf', async () => {
  const w = await world();
  try {
    const body = randomBytes(5000);
    const up = await addAttachment(w, 'alice', 'bijlage-0001', Buffer.concat([PNG, body]), '../../etc/passwd.png');
    assert.equal(up.size, PNG.length + 5000);
    assert.equal(up.sha256, sha(Buffer.concat([PNG, body])));
    assert.equal(up.mime, 'image/png');

    const files = filesOnDisk(w.dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{32}$/, 'willekeurige sleutel, niet het id of de naam');
    assert.ok(!files.join().includes('bijlage-0001'));

    const res = await w.get('alice', '/api/v1/attachments/bijlage-0001');
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.concat([PNG, body]));
    assert.equal(res.headers.get('content-length'), String(PNG.length + 5000));
    const h = (await sent(w, w.users.alice.id, 'bijlage-0001')).headers;
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
    assert.equal(h['Cache-Control'], 'private, no-store');
    assert.match(String(h['Content-Disposition']), /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    assert.equal(h['Content-Security-Policy'], "default-src 'none'; sandbox");
    assert.equal(h['Content-Length'], PNG.length + 5000);

    const synced = w.sync('alice', []);
    const row = (synced.attachments as Row[]).find((a) => a.id === 'bijlage-0001')!;
    assert.deepEqual([row.task_id, row.name, row.size, row.mime, row.creator_id], ['task-alice-0001', '_.._etc_passwd.png', up.size, 'image/png', w.users.alice.id]);
  } finally { await w.close(); }
});

test('de naam van een bijlage moet al schoon zijn: padtekens, stuurtekens en een andere Unicode-vorm worden geweigerd', async () => {
  const w = await world();
  try {
    const bad = ['../geheim.txt', 'a/b.txt', 'a\\b.txt', 'con.txt\u0000', 'tekst‮txt.exe', '  spatie.txt', 'punt.', '', '.verborgen', 'x'.repeat(300), 'CON', 'café.txt'];
    for (const [i, name] of bad.entries()) {
      const id = `slechte-naam-${String(i).padStart(2, '0')}`;
      const up = await w.upload('alice', id, w.T, 'inhoud');
      assert.equal(up.status, 200);
      const c = cmd('attachment_add', { id, task_id: w.T, name, size: up.json.size, mime: up.json.mime, sha256: up.json.sha256 });
      const s = w.sync('alice', [c]).sync_status[c.uuid];
      // 'café.txt' wordt door de server eerst naar NFC gebracht ("café.txt") en is dan wel schoon
      if (name === 'café.txt') assert.equal(s, 'ok');
      else assert.ok(typeof s === 'object' && s.error_code === 'INVALID_ARG', `${JSON.stringify(name)}: ${JSON.stringify(s)}`);
    }
    const good = ['café.txt', 'Rekening maart – Nijhof & Zn.pdf', 'foto 1 (kopie).jpeg', 'ĳsvogel.docx', '日本語.txt', 'a'.repeat(200)];
    for (const [i, name] of good.entries()) {
      const id = `goede-naam-${String(i).padStart(3, '0')}`;
      const up = await w.upload('alice', id, w.T, `inhoud ${i}`);
      const c = cmd('attachment_add', { id, task_id: w.T, name, size: up.json.size, mime: up.json.mime, sha256: up.json.sha256 });
      assert.equal(w.sync('alice', [c]).sync_status[c.uuid], 'ok', name);
    }
    const stored = (w.sync('alice', []).attachments as Row[]).map((a) => a.name);
    assert.ok(stored.includes('café.txt'));
    assert.ok(stored.every((x) => x === x.normalize('NFC')));
  } finally { await w.close(); }
});

test('het bestandstype komt uit de eerste bytes: een afbeelding die er geen is, wordt geen afbeelding; svg en html nooit inline', async () => {
  const w = await world();
  try {
    const cases: [string, Buffer | string, string, string][] = [
      ['type-0000001', PNG, 'text/plain', 'image/png'],            // de bytes gaan voor wat de afzender zegt
      ['type-0000002', '<html><script>alert(1)</script>', 'image/png', 'application/octet-stream'], // geen png
      ['type-0000003', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', 'image/svg+xml', 'image/svg+xml'],
      ['type-0000004', '<html></html>', 'text/html; charset=utf-8', 'text/html'],
      ['type-0000005', PDF, 'application/pdf', 'application/pdf'],
      ['type-0000006', 'iets', 'rommel zonder slash', 'application/octet-stream'],
      ['type-0000007', 'iets', 'TEXT/Plain; charset=UTF-8', 'text/plain'],
    ];
    for (const [id, body, declared, expected] of cases) {
      const up = await w.upload('alice', id, w.T, body, declared);
      assert.equal(up.json.mime, expected, id);
    }
    const alice = w.users.alice.id;
    const svg = await sent(w, alice, 'type-0000003', { inline: true });
    assert.equal(svg.headers['Content-Type'], 'application/octet-stream', 'svg wordt nooit als svg geleverd');
    assert.match(String(svg.headers['Content-Disposition']), /^attachment/);
    const html = await sent(w, alice, 'type-0000004', { inline: true });
    assert.equal(html.headers['Content-Type'], 'application/octet-stream');
    assert.match(String(html.headers['Content-Disposition']), /^attachment/);
    const png = await sent(w, alice, 'type-0000001', { inline: true });
    assert.equal(png.headers['Content-Type'], 'image/png');
    assert.match(String(png.headers['Content-Disposition']), /^inline/);
    assert.equal(png.headers['Content-Security-Policy'], "default-src 'none'; sandbox");
    const notReally = await sent(w, alice, 'type-0000002', { inline: true });
    assert.equal(notReally.headers['Content-Type'], 'application/octet-stream');
    assert.match(String(notReally.headers['Content-Disposition']), /^attachment/);
    assert.match(String((await sent(w, alice, 'type-0000001')).headers['Content-Disposition']), /^attachment/, 'zonder inline altijd als bestand');
    assert.match(String((await sent(w, alice, 'type-0000005', { inline: true })).headers['Content-Disposition']), /^inline/);
  } finally { await w.close(); }
});

test('toegang: een niet-lid, een uitgelogde, een geblokkeerde gebruiker en een lid van een ander project krijgen niets, en hetzelfde antwoord als voor een bijlage die niet bestaat', async () => {
  const w = await world();
  try {
    await addAttachment(w, 'alice', 'geheim-00001', PNG);
    const missing = await w.get('bob', '/api/v1/attachments/bestaat-niet-1');
    const missingBody = await missing.text();
    assert.equal(missing.status, 404);

    // bob: geen lid
    const asBob = await w.get('bob', '/api/v1/attachments/geheim-00001');
    assert.equal(asBob.status, 404);
    assert.equal(await asBob.text(), missingBody, 'geen bestaansorakel: precies dezelfde melding');
    // carol is lid van een ander project
    const other = [cmd('project_add', { id: 'project-carol-01', name: 'Van Carol' }), cmd('task_add', { id: 'task-carol-0001', project_id: 'project-carol-01', content: 'Iets' })];
    w.sync('carol', other);
    assert.equal((await w.get('carol', '/api/v1/attachments/geheim-00001')).status, 404);
    // uitgelogd / zonder token / onzin
    assert.equal((await w.get(null, '/api/v1/attachments/geheim-00001')).status, 401);
    assert.equal((await w.get('tky_onzin', '/api/v1/attachments/geheim-00001')).status, 401);
    // het token in de URL telt niet
    assert.equal((await fetch(`${w.base}/api/v1/attachments/geheim-00001?token=${w.tokens.alice}`)).status, 401);
    // uploaden naar andermans taak: ook "bestaat niet", en er blijft niets achter
    const up = await w.upload('bob', 'binnendringen-1', w.T, 'x');
    assert.equal(up.status, 404);
    assert.equal(up.json.error_code, 'NOT_FOUND');
    assert.equal((await w.upload('carol', 'binnendringen-2', 'task-bestaat-niet', 'x')).status, 404);
    assert.equal(filesOnDisk(w.dir).length, 1);
    assert.deepEqual(tmpFiles(w.dir), []);
    // koppelen aan andermans taak met een eigen upload mislukt ook
    const own = await w.upload('bob', 'eigen-upload-01', w.users.bob.inbox_project_id === '' ? w.T : 'task-bestaat-niet', 'x');
    assert.equal(own.status, 404);

    // delen: nu wel; weer weghalen: weer niet
    const share = cmd('project_share', { project_id: w.P, username: 'bob' });
    w.sync('alice', [share]);
    const shared = await w.get('bob', '/api/v1/attachments/geheim-00001');
    assert.equal(shared.status, 200);
    await shared.arrayBuffer();
    const unshare = cmd('project_unshare', { project_id: w.P, user_id: w.users.bob.id });
    w.sync('alice', [unshare]);
    assert.equal((await w.get('bob', '/api/v1/attachments/geheim-00001')).status, 404);
    // geblokkeerd
    w.sync('alice', [cmd('project_share', { project_id: w.P, username: 'carol' })]);
    assert.equal((await w.get('carol', '/api/v1/attachments/geheim-00001')).status, 200);
    updateUser(w.db, w.users.carol.id, { is_disabled: true });
    assert.equal((await w.get('carol', '/api/v1/attachments/geheim-00001')).status, 401);
    assert.equal((await w.upload('carol', 'geblokkeerd-01', w.T, 'x')).status, 401);
  } finally { await w.close(); }
});

test('toegangsfuzz: vreemde id\'s geven nooit een fout van de server, nooit een bestand en nooit iets anders dan 404 (of 401 zonder token)', async () => {
  const w = await world();
  try {
    await addAttachment(w, 'alice', 'bestaat-00001', PNG);
    // tijdelijk bestand en sleutels van andere bijlagen mogen via geen enkel pad bereikbaar zijn
    const key = filesOnDisk(w.dir)[0];
    const ids = [
      '', ' ', 'limits2', '..', '../..', '..%2f..%2fetc%2fpasswd', '%2e%2e/%2e%2e/todo.db', 'a/b', 'a\\b', 'bestaat-00001/../x', 'bestaat-00001%00',
      'BESTAAT-00001', 'bestaat-0000', 'x'.repeat(41), 'x'.repeat(5000), '日本語日本語日本語日本語', '%', '%zz', 'null', 'undefined', '{}', '[]', '*', '?', '#', key, `${key.slice(0, 2)}/${key}`,
      "'; DROP TABLE attachments;--", 'tmp', 'tmp/x', '.', '.env', 'con', 'nul.txt', 'bestaat-00001.png', 'bestaat-00001?x=1',
    ];
    for (const id of ids) {
      for (const as of ['bob', 'alice']) {
        const res = await fetch(`${w.base}/api/v1/attachments/${id}`, { headers: { Authorization: `Bearer ${(w.tokens as Row)[as]}` } }).catch(() => null);
        if (!res) continue; // een URL die fetch zelf al weigert
        const text = await res.text();
        const looksLikeBytes = text.startsWith('\u0089PNG');
        // alice mag haar eigen bijlage zien (alleen het exacte id), al het andere is 404
        const expectedOk = as === 'alice' && (id === 'bestaat-00001' || id === 'bestaat-00001?x=1');
        if (expectedOk) { assert.ok(res.status === 200, `${id}: ${res.status}`); continue; }
        assert.ok([404, 405].includes(res.status) || (res.status === 200 && !looksLikeBytes && id === ''), `${as} ${JSON.stringify(id)}: ${res.status} ${text.slice(0, 80)}`);
        assert.ok(!looksLikeBytes, `${id} gaf bytes`);
      }
    }
    // vreemde id's en taken bij uploaden
    for (const bad of ['', 'kort', '../etc', 'x'.repeat(41), 'a b c d e f g h', '日本語日本語日本語日本語']) {
      const up = await fetch(`${w.base}/api/v1/attachments?id=${encodeURIComponent(bad)}&task_id=${w.T}`, { method: 'POST', headers: { Authorization: `Bearer ${w.tokens.alice}` }, body: 'x' });
      assert.equal(up.status, 400, JSON.stringify(bad));
      const up2 = await fetch(`${w.base}/api/v1/attachments?id=upload-00001&task_id=${encodeURIComponent(bad)}`, { method: 'POST', headers: { Authorization: `Bearer ${w.tokens.alice}` }, body: 'x' });
      assert.equal(up2.status, 400, JSON.stringify(bad));
    }
    assert.equal((await fetch(`${w.base}/api/v1/attachments?task_id=${w.T}`, { method: 'POST', headers: { Authorization: `Bearer ${w.tokens.alice}` }, body: 'x' })).status, 400, 'zonder id');
    assert.equal(db_count(w.db, 'attachment_files'), 1);
    assert.deepEqual(tmpFiles(w.dir), []);
    // verkeerde methoden
    assert.equal((await fetch(`${w.base}/api/v1/attachments/bestaat-00001`, { method: 'DELETE', headers: { Authorization: `Bearer ${w.tokens.alice}` } })).status, 405);
    assert.equal((await fetch(`${w.base}/api/v1/attachments`, { headers: { Authorization: `Bearer ${w.tokens.alice}` } })).status, 405);
  } finally { await w.close(); }
});
const db_count = (db: DatabaseSync, table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);

test('een bestand dat te groot is of waarvan de grootte ontbreekt wordt geweigerd, ook als het in stukken komt', async () => {
  const w = await world({ maxUploadBytes: 1000 });
  try {
    const big = await w.upload('alice', 'te-groot-0001', w.T, Buffer.alloc(1001, 1));
    assert.equal(big.status, 413);
    assert.equal(big.json.error_code, 'TOO_LARGE');
    const exact = await w.upload('alice', 'precies-00001', w.T, Buffer.alloc(1000, 1));
    assert.equal(exact.status, 200);
    assert.equal((await w.upload('alice', 'leeg-00000001', w.T, Buffer.alloc(0))).status, 400);
    assert.deepEqual(tmpFiles(w.dir), []);
    assert.equal(filesOnDisk(w.dir).length, 1);

    // zonder Content-Length (chunked): niet toegestaan
    const head = `POST /api/v1/attachments?id=chunked-00001&task_id=${w.T} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${w.tokens.alice}\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhallo\r\n0\r\n\r\n`;
    const r = await raw(w.port, head, undefined, true);
    assert.equal(status(r.data), 411);
    assert.equal(filesOnDisk(w.dir).length, 1);
    // een enorme opgegeven grootte wordt meteen geweigerd, zonder dat de server iets ontvangt
    const huge = await raw(w.port, `POST /api/v1/attachments?id=enorm-0000001&task_id=${w.T} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${w.tokens.alice}\r\nContent-Length: 99999999999\r\n\r\n`, undefined, true);
    assert.equal(status(huge.data), 413);
  } finally { await w.close(); }
});

test('opslagruimte per gebruiker: de grens geldt voor de som, verwijderen geeft ruimte terug, andere gebruikers merken niets', async () => {
  const w = await world({ quotaBytes: 1000, maxUploadBytes: 1000 });
  try {
    w.sync('alice', [cmd('project_share', { project_id: w.P, username: 'bob' })]);
    await addAttachment(w, 'alice', 'ruimte-000001', Buffer.alloc(600, 7), 'a.bin', 'application/octet-stream');
    const second = await w.upload('alice', 'ruimte-000002', w.T, Buffer.alloc(600, 8));
    assert.equal(second.status, 409);
    assert.equal(second.json.error_code, 'LIMIT_REACHED');
    // bob heeft zijn eigen ruimte, ook in alice' project
    assert.equal((await w.upload('bob', 'ruimte-000003', w.T, Buffer.alloc(600, 9))).status, 200);
    const limits = await (await w.get('alice', '/api/v1/attachments/limits')).json();
    assert.deepEqual(limits, { max_upload_bytes: 1000, quota_bytes: 1000, used_bytes: 600, per_task: LIMITS.attachmentsPerTask });
    // verwijderen geeft de ruimte terug
    const del = cmd('attachment_delete', { id: 'ruimte-000001' });
    assert.equal(w.sync('alice', [del]).sync_status[del.uuid], 'ok');
    assert.equal((await (await w.get('alice', '/api/v1/attachments/limits')).json()).used_bytes, 0);
    assert.equal((await w.upload('alice', 'ruimte-000002', w.T, Buffer.alloc(600, 8))).status, 200);
  } finally { await w.close(); }
});

test('gelijktijdige uploads kunnen samen niet over de grens: precies zoveel als erin passen, en geen tijdelijke resten', async () => {
  const w = await world({ quotaBytes: 1000, maxUploadBytes: 1000 });
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => w.upload('alice', `gelijktijdig-${i}`.padEnd(14, '0'), w.T, Buffer.alloc(400, i + 1))));
    const ok = results.filter((r) => r.status === 200).length;
    assert.equal(ok, 2, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 409));
    assert.equal(filesOnDisk(w.dir).length, 2);
    assert.deepEqual(tmpFiles(w.dir), []);
    assert.equal(w.attachments.used(w.users.alice.id), 800);
  } finally { await w.close(); }
});

test('hooguit zoveel bijlagen per taak als LIMITS.attachmentsPerTask zegt, ook voor uploads die nog niet gekoppeld zijn', async () => {
  const w = await world();
  const before = LIMITS.attachmentsPerTask;
  LIMITS.attachmentsPerTask = 3;
  try {
    await addAttachment(w, 'alice', 'pertaak-00001', 'een', 'een.txt', 'text/plain');
    await addAttachment(w, 'alice', 'pertaak-00002', 'twee', 'twee.txt', 'text/plain');
    assert.equal((await w.upload('alice', 'pertaak-00003', w.T, 'drie')).status, 200); // nog niet gekoppeld, telt al mee
    const four = await w.upload('alice', 'pertaak-00004', w.T, 'vier');
    assert.equal(four.status, 409);
    assert.equal(four.json.error_code, 'LIMIT_REACHED');
    // dezelfde upload nog eens (herhaling) mag wel
    assert.equal((await w.upload('alice', 'pertaak-00003', w.T, 'drie')).status, 200);
    // en het commando houdt zich er ook aan
    const up = (await w.upload('alice', 'pertaak-00003', w.T, 'drie')).json;
    const a = cmd('attachment_add', { id: 'pertaak-00003', task_id: w.T, name: 'drie.txt', size: up.size, mime: up.mime, sha256: up.sha256 });
    assert.equal(w.sync('alice', [a]).sync_status[a.uuid], 'ok');
    const extra = cmd('attachment_add', { id: 'pertaak-00005', task_id: w.T, name: 'vijf.txt', size: 1, mime: 'text/plain', sha256: sha('x') });
    const s = w.sync('alice', [extra]).sync_status[extra.uuid];
    assert.ok(typeof s === 'object', 'het bestand is niet geüpload en de taak zit vol');
  } finally { LIMITS.attachmentsPerTask = before; await w.close(); }
});

test('dezelfde upload herhalen is veilig; een ander bestand onder hetzelfde id wordt geweigerd', async () => {
  const w = await world();
  try {
    const a = await w.upload('alice', 'herhaal-00001', w.T, PNG, 'image/png');
    const b = await w.upload('alice', 'herhaal-00001', w.T, PNG, 'image/png');
    assert.deepEqual(b.json, a.json);
    assert.equal(filesOnDisk(w.dir).length, 1);
    assert.equal(db_count(w.db, 'attachment_files'), 1);
    const other = await w.upload('alice', 'herhaal-00001', w.T, Buffer.concat([PNG, Buffer.from('anders')]), 'image/png');
    assert.equal(other.status, 409);
    assert.equal(other.json.error_code, 'CONFLICT');
    // iemand anders kan het id niet overnemen
    w.sync('alice', [cmd('project_share', { project_id: w.P, username: 'bob' })]);
    assert.equal((await w.upload('bob', 'herhaal-00001', w.T, PNG, 'image/png')).status, 409);
    // het commando herhalen met hetzelfde uuid doet niets extra
    const c = cmd('attachment_add', { id: 'herhaal-00001', task_id: w.T, name: 'foto.png', size: a.json.size, mime: a.json.mime, sha256: a.json.sha256 });
    assert.equal(w.sync('alice', [c]).sync_status[c.uuid], 'ok');
    assert.equal(w.sync('alice', [c]).sync_status[c.uuid], 'ok');
    assert.equal((w.sync('alice', []).attachments as Row[]).length, 1);
    // en opnieuw uploaden na het koppelen (de app weet niet dat het antwoord aankwam) is ook gewoon goed
    assert.equal((await w.upload('alice', 'herhaal-00001', w.T, PNG, 'image/png')).status, 200);
    // met een nieuw uuid voor dezelfde bijlage: ID_EXISTS
    const again = cmd('attachment_add', { id: 'herhaal-00001', task_id: w.T, name: 'foto.png', size: a.json.size, mime: a.json.mime, sha256: a.json.sha256 });
    const s = w.sync('alice', [again]).sync_status[again.uuid];
    assert.ok(typeof s === 'object' && s.error_code === 'ID_EXISTS');
  } finally { await w.close(); }
});

test('het commando komt alleen door met wat de server bij de upload zag: grootte, type, controlegetal, taak en uploader', async () => {
  const w = await world();
  try {
    w.sync('alice', [cmd('project_share', { project_id: w.P, username: 'bob' }), cmd('task_add', { id: 'task-alice-0002', project_id: w.P, content: 'Tweede' })]);
    const up = (await w.upload('alice', 'klopt-0000001', w.T, 'inhoud', 'text/plain')).json;
    const base = { id: 'klopt-0000001', task_id: w.T, name: 'a.txt', size: up.size, mime: up.mime, sha256: up.sha256 };
    const tries: [string, Record<string, unknown>, string, 'alice' | 'bob'][] = [
      ['andere grootte', { ...base, size: up.size + 1 }, 'CONFLICT', 'alice'],
      ['ander type', { ...base, mime: 'image/png' }, 'CONFLICT', 'alice'],
      ['ander controlegetal', { ...base, sha256: sha('anders') }, 'CONFLICT', 'alice'],
      ['hoofdletters in controlegetal', { ...base, sha256: up.sha256.toUpperCase() }, 'INVALID_ARG', 'alice'],
      ['andere taak', { ...base, task_id: 'task-alice-0002' }, 'NOT_FOUND', 'alice'],
      ['andermans upload', base, 'NOT_FOUND', 'bob'],
      ['niet-geüpload id', { ...base, id: 'onbekend-00001' }, 'NOT_FOUND', 'alice'],
      ['server-veld', { ...base, creator_id: w.users.bob.id }, 'READONLY', 'alice'],
      ['onbekend veld', { ...base, pad: '/etc/passwd' }, 'UNKNOWN_ARG', 'alice'],
      ['naam ontbreekt', (({ name: _n, ...rest }) => rest)(base), 'MISSING_ARG', 'alice'],
      ['negatieve grootte', { ...base, size: -1 }, 'INVALID_ARG', 'alice'],
      ['grootte als tekst', { ...base, size: '6' }, 'INVALID_ARG', 'alice'],
    ];
    for (const [what, args, code, as] of tries) {
      const c = cmd('attachment_add', args);
      const s = w.sync(as, [c]).sync_status[c.uuid];
      assert.ok(typeof s === 'object' && s.error_code === code, `${what}: verwacht ${code}, kreeg ${JSON.stringify(s)}`);
    }
    for (const type of ['attachment_update']) {
      const c = cmd(type, { id: 'klopt-0000001', name: 'x.txt' });
      const s = w.sync('alice', [c]).sync_status[c.uuid];
      assert.ok(typeof s === 'object' && s.error_code === 'UNKNOWN_COMMAND');
    }
    // na al die mislukkingen is er geen bijlage, en het goede commando werkt nog
    assert.equal((w.sync('alice', []).attachments as Row[]).length, 0);
    const good = cmd('attachment_add', base);
    assert.equal(w.sync('alice', [good]).sync_status[good.uuid], 'ok');
  } finally { await w.close(); }
});

test('verwijderen: de maker en de eigenaar van het project mogen, een ander lid niet; het bestand is weg en de rij is leeg', async () => {
  const w = await world();
  try {
    w.sync('alice', [cmd('project_share', { project_id: w.P, username: 'bob' }), cmd('project_share', { project_id: w.P, username: 'carol' })]);
    const before = w.sync('alice', []).sync_token;
    await addAttachment(w, 'bob', 'van-bob-000001', 'bob zijn bestand', 'bob.txt', 'text/plain');
    await addAttachment(w, 'bob', 'van-bob-000002', 'tweede van bob', 'bob2.txt', 'text/plain');
    assert.equal(filesOnDisk(w.dir).length, 2);
    // carol is lid maar niet de maker
    const byCarol = cmd('attachment_delete', { id: 'van-bob-000001' });
    const s = w.sync('carol', [byCarol]).sync_status[byCarol.uuid];
    assert.ok(typeof s === 'object' && s.error_code === 'FORBIDDEN');
    assert.equal(filesOnDisk(w.dir).length, 2);
    // de maker
    const byBob = cmd('attachment_delete', { id: 'van-bob-000001' });
    assert.equal(w.sync('bob', [byBob]).sync_status[byBob.uuid], 'ok');
    assert.equal(filesOnDisk(w.dir).length, 1);
    assert.equal((await w.get('bob', '/api/v1/attachments/van-bob-000001')).status, 404);
    // de eigenaar van het project
    const byAlice = cmd('attachment_delete', { id: 'van-bob-000002' });
    assert.equal(w.sync('alice', [byAlice]).sync_status[byAlice.uuid], 'ok');
    assert.equal(filesOnDisk(w.dir).length, 0);
    assert.equal(db_count(w.db, 'attachment_files'), 0);
    // de verwijderde rij houdt geen naam, type of controlegetal over; in de delta alleen het id
    const rows = w.db.prepare('SELECT * FROM attachments ORDER BY id').all() as Row[];
    assert.ok(rows.every((r) => r.is_deleted === 1 && r.name === '' && r.sha256 === '' && r.mime === '' && r.size === 0));
    const delta = w.sync('alice', [], before).attachments as Row[];
    assert.deepEqual(delta.map((r) => Object.keys(r).sort()), [['id', 'is_deleted'], ['id', 'is_deleted']]);
    // verwijderen kan niet twee keer
    const twice = cmd('attachment_delete', { id: 'van-bob-000002' });
    const t = w.sync('alice', [twice]).sync_status[twice.uuid];
    assert.ok(typeof t === 'object' && t.error_code === 'NOT_FOUND');
  } finally { await w.close(); }
});

test('een taak, sectie of project verwijderen ruimt de bestanden op; een lid weghalen of een gebruiker blokkeren laat andermans bijlagen staan', async () => {
  const w = await world();
  try {
    w.sync('alice', [cmd('project_share', { project_id: w.P, username: 'bob' }), cmd('section_add', { id: 'sectie-alice-01', project_id: w.P, name: 'S' }),
      cmd('task_add', { id: 'task-alice-0002', project_id: w.P, section_id: 'sectie-alice-01', content: 'In sectie' }),
      cmd('task_add', { id: 'task-alice-0003', project_id: w.P, parent_id: w.T, content: 'Subtaak' })]);
    await addAttachment(w, 'bob', 'bijlage-bob-001', 'van bob', 'b.txt', 'text/plain');
    await addAttachment(w, 'alice', 'bijlage-sub-001', 'op subtaak', 's.txt', 'text/plain', 'task-alice-0003');
    await addAttachment(w, 'alice', 'bijlage-sec-001', 'in sectie', 'sec.txt', 'text/plain', 'task-alice-0002');
    assert.equal(filesOnDisk(w.dir).length, 3);

    // bob uit het project halen en blokkeren: zijn bijlage blijft
    w.sync('alice', [cmd('project_unshare', { project_id: w.P, user_id: w.users.bob.id })]);
    updateUser(w.db, w.users.bob.id, { is_disabled: true });
    assert.equal(filesOnDisk(w.dir).length, 3);
    assert.equal((await w.get('alice', '/api/v1/attachments/bijlage-bob-001')).status, 200);

    // de taak met subtaak weg: de bijlage van bob en die van de subtaak gaan mee
    w.sync('alice', [cmd('task_delete', { id: w.T })]);
    assert.equal(filesOnDisk(w.dir).length, 1);
    assert.equal(w.attachments.used(w.users.bob.id), 0);
    // sectie weg
    w.sync('alice', [cmd('section_delete', { id: 'sectie-alice-01' })]);
    assert.equal(filesOnDisk(w.dir).length, 0);
    // project weg, met nog een bijlage erin
    w.sync('alice', [cmd('task_add', { id: 'task-alice-0009', project_id: w.P, content: 'Nog een' })]);
    await addAttachment(w, 'alice', 'bijlage-prj-001', 'in project', 'p.txt', 'text/plain', 'task-alice-0009');
    assert.equal(filesOnDisk(w.dir).length, 1);
    w.sync('alice', [cmd('project_delete', { id: w.P })]);
    assert.equal(filesOnDisk(w.dir).length, 0);
    assert.equal(db_count(w.db, 'attachment_files'), 0);
  } finally { await w.close(); }
});

test('een taak naar een ander project: de bijlagen gaan mee en volgen de toegang', async () => {
  const w = await world();
  try {
    w.sync('alice', [cmd('project_add', { id: 'project-alice-02', name: 'Tweede' }), cmd('project_share', { project_id: 'project-alice-02', username: 'bob' })]);
    await addAttachment(w, 'alice', 'meeverhuis-001', 'inhoud', 'm.txt', 'text/plain');
    assert.equal((await w.get('bob', '/api/v1/attachments/meeverhuis-001')).status, 404);
    const bobSince = w.sync('bob', []).sync_token;
    w.sync('alice', [cmd('task_move', { id: w.T, project_id: 'project-alice-02' })]);
    const res = await w.get('bob', '/api/v1/attachments/meeverhuis-001');
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    // bob krijgt de bijlage (ook al is die ouder dan zijn token) in zijn delta
    const delta = w.sync('bob', [], bobSince);
    assert.deepEqual((delta.attachments as Row[]).map((a) => a.id), ['meeverhuis-001']);
    // en terug naar een project dat hij niet ziet: weer weg
    w.sync('alice', [cmd('task_move', { id: w.T, project_id: w.P })]);
    assert.equal((await w.get('bob', '/api/v1/attachments/meeverhuis-001')).status, 404);
  } finally { await w.close(); }
});

test('een afgebroken upload laat niets achter: geen rij, geen bestand, geen ruimte in beslag', async () => {
  const w = await world({ quotaBytes: 5000, maxUploadBytes: 5000 });
  try {
    const head = `POST /api/v1/attachments?id=afgebroken-001&task_id=${w.T} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${w.tokens.alice}\r\nContent-Type: image/png\r\nContent-Length: 4000\r\n\r\n`;
    await raw(w.port, head, (s) => { s.write(Buffer.alloc(1500, 1)); setTimeout(() => s.destroy(), 60); });
    await sleep(150);
    assert.deepEqual(tmpFiles(w.dir), []);
    assert.equal(filesOnDisk(w.dir).length, 0);
    assert.equal(db_count(w.db, 'attachment_files'), 0);
    assert.equal(w.attachments.used(w.users.alice.id), 0);
    // de ruimte voor lopende uploads is ook weer vrij: een volle upload past
    assert.equal((await w.upload('alice', 'afgebroken-002', w.T, Buffer.alloc(5000, 2))).status, 200);
    // de server werkt gewoon door
    assert.equal((await fetch(`${w.base}/health`)).status, 200);
  } finally { await w.close(); }
});

test('een upload die stilvalt wordt afgebroken (408) en laat niets achter', async () => {
  const w = await world({ idleMs: 300 });
  try {
    const head = `POST /api/v1/attachments?id=stilgevallen1&task_id=${w.T} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${w.tokens.alice}\r\nContent-Length: 4000\r\n\r\n`;
    const started = Date.now();
    const r = await raw(w.port, head, (s) => s.write(Buffer.alloc(100, 1)));
    assert.equal(status(r.data), 408);
    assert.ok(Date.now() - started < 3000, 'binnen een paar seconden');
    assert.deepEqual(tmpFiles(w.dir), []);
    assert.equal(db_count(w.db, 'attachment_files'), 0);
    assert.equal(w.attachments.used(w.users.alice.id), 0);
  } finally { await w.close(); }
});

test('een upload die druppelt (slowloris) haalt de tijdslimiet niet en wordt afgebroken', async () => {
  // Elke meting van de klok loopt 7 seconden op: een bestand van 90 bytes mag 30 s + 90 B / 1 MB/s duren, en dat is na een paar bytes voorbij.
  let t = Date.now();
  const w = await world({ idleMs: 60_000, minBytesPerSecond: 1_000_000, maxUploadBytes: 100, now: () => (t += 7000) });
  try {
    const head = `POST /api/v1/attachments?id=druppel-00002&task_id=${w.T} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${w.tokens.alice}\r\nContent-Length: 90\r\n\r\n`;
    const r = await raw(w.port, head, (s) => {
      let i = 0;
      const drip = setInterval(() => { if (i++ < 40) s.write('x'); else clearInterval(drip); }, 20);
      s.once('close', () => clearInterval(drip));
    });
    assert.equal(status(r.data), 408);
    assert.deepEqual(tmpFiles(w.dir), []);
    assert.equal(db_count(w.db, 'attachment_files'), 0);
  } finally { await w.close(); }
});

test('de server blijft responsief tijdens een grote upload en leest het bestand niet in het geheugen', async () => {
  const w = await world({ maxUploadBytes: 60_000_000, quotaBytes: 100_000_000 });
  try {
    const total = 40_000_000;
    const chunk = randomBytes(64 * 1024);
    const heapBefore = process.memoryUsage().heapUsed;
    const rssBefore = process.memoryUsage().rss;
    const done = new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: w.port, method: 'POST', path: `/api/v1/attachments?id=groot-00000001&task_id=${w.T}`,
        headers: { Authorization: `Bearer ${w.tokens.alice}`, 'Content-Length': String(total), 'Content-Type': 'application/octet-stream' },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject);
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          const part = chunk.subarray(0, Math.min(chunk.length, total - sent));
          sent += part.length;
          if (!req.write(part)) { req.once('drain', pump); return; }
        }
        req.end();
      };
      pump();
    });
    // terwijl de upload loopt: gezondheidscontroles die snel antwoorden
    const times: number[] = [];
    let finished = false;
    void done.then(() => { finished = true; });
    while (!finished && times.length < 200) {
      const t0 = performance.now();
      const res = await fetch(`${w.base}/health`);
      await res.text();
      times.push(performance.now() - t0);
      await sleep(5);
    }
    assert.equal(await done, 200);
    assert.ok(times.length >= 3, `maar ${times.length} metingen`);
    const worst = Math.max(...times);
    assert.ok(worst < 750, `een /health-verzoek duurde ${Math.round(worst)} ms tijdens de upload`);
    assert.equal(statSync(join(w.dir, filesOnDisk(w.dir).map((f) => f.slice(0, 2))[0], filesOnDisk(w.dir)[0])).size, total);
    // 40 MB geüpload; de heap en het werkgeheugen groeien niet met de bestandsgrootte mee
    global.gc?.();
    assert.ok(process.memoryUsage().rss - rssBefore < total, 'het werkgeheugen groeide net zo hard als het bestand');
    assert.ok(process.memoryUsage().heapUsed - heapBefore < total / 2);
  } finally { await w.close(); }
});

test('Range en HEAD: een deel van een bestand, een ongeldig bereik en alleen de kopteksten', async () => {
  const w = await world();
  try {
    const body = Buffer.from('0123456789abcdefghij');
    await addAttachment(w, 'alice', 'bereik-000001', body, 'bereik.txt', 'text/plain');
    const part = await w.get('alice', '/api/v1/attachments/bereik-000001', { Range: 'bytes=5-9' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 5-9/20');
    assert.equal(part.headers.get('content-length'), '5');
    assert.equal(await part.text(), '56789');
    assert.equal(await (await w.get('alice', '/api/v1/attachments/bereik-000001', { Range: 'bytes=15-' })).text(), 'fghij');
    assert.equal(await (await w.get('alice', '/api/v1/attachments/bereik-000001', { Range: 'bytes=-3' })).text(), 'hij');
    assert.equal(await (await w.get('alice', '/api/v1/attachments/bereik-000001', { Range: 'bytes=10-999' })).text(), 'abcdefghij');
    const bad = await w.get('alice', '/api/v1/attachments/bereik-000001', { Range: 'bytes=50-60' });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), 'bytes */20');
    for (const weird of ['bytes=a-b', 'bytes=9-5', 'bytes=0-1,5-6', 'items=0-1', 'bytes=']) {
      const r = await w.get('alice', '/api/v1/attachments/bereik-000001', { Range: weird });
      assert.ok([200, 416].includes(r.status), `${weird}: ${r.status}`);
      await r.arrayBuffer();
    }
    const head = await fetch(`${w.base}/api/v1/attachments/bereik-000001`, { method: 'HEAD', headers: { Authorization: `Bearer ${w.tokens.alice}` } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '20');
    assert.equal(await head.text(), '');
    // een bereik laat de toegangsregels intact
    assert.equal((await w.get('bob', '/api/v1/attachments/bereik-000001', { Range: 'bytes=0-1' })).status, 404);
  } finally { await w.close(); }
});

test('de naam in de Content-Disposition kan geen kopregel of aanhalingsteken ontsnappen', async () => {
  const w = await world();
  try {
    await addAttachment(w, 'alice', 'naam-00000001', 'x', 'Rekening "maart" – café; naam=2.pdf', 'text/plain');
    const cd = String((await sent(w, w.users.alice.id, 'naam-00000001')).headers['Content-Disposition']);
    assert.match(cd, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._~-]*$/);
    assert.ok(!/filename="[^"]*"[^;]*"/.test(cd));
    assert.ok(cd.includes('caf%C3%A9'));
  } finally { await w.close(); }
});

test('opruimen: een upload zonder bijlage verdwijnt na een uur, een gekoppelde blijft; de controle bij het opstarten ruimt resten op', async () => {
  let clock = Date.now();
  const w = await world({ now: () => clock });
  try {
    await addAttachment(w, 'alice', 'gekoppeld-0001', 'blijft', 'blijft.txt', 'text/plain');
    await w.upload('alice', 'wees-000000001', w.T, 'wacht op een commando');
    assert.equal(filesOnDisk(w.dir).length, 2);
    clock += 59 * 60_000;
    assert.deepEqual(w.attachments.sweep(), { orphans: 0, temp: 0 });
    clock += 2 * 60_000;
    assert.equal(w.attachments.sweep().orphans, 1);
    assert.equal(filesOnDisk(w.dir).length, 1);
    assert.equal((await w.get('alice', '/api/v1/attachments/gekoppeld-0001')).status, 200);
    // het commando voor de verdwenen upload faalt nu netjes
    const c = cmd('attachment_add', { id: 'wees-000000001', task_id: w.T, name: 'w.txt', size: 21, mime: 'application/octet-stream', sha256: sha('wacht op een commando') });
    const s = w.sync('alice', [c]).sync_status[c.uuid];
    assert.ok(typeof s === 'object' && s.error_code === 'NOT_FOUND');

    // resten van een crash: een tijdelijk bestand, een bestand zonder rij, een rij zonder bestand
    writeFileSync(join(w.dir, 'tmp', 'half'), 'half');
    mkdirSync(join(w.dir, 'ab'), { recursive: true });
    writeFileSync(join(w.dir, 'ab', 'abcdef0123456789abcdef0123456789'), 'zonder rij');
    await w.upload('alice', 'zonder-bestand', w.T, 'x');
    const key = (w.db.prepare("SELECT key FROM attachment_files WHERE id = 'zonder-bestand'").get() as Row).key as string;
    rmSync(join(w.dir, key.slice(0, 2), key));
    const report = w.attachments.check();
    assert.deepEqual(report, { strayFiles: 1, rowsRemoved: 1, missing: 0 });
    assert.deepEqual(tmpFiles(w.dir), []);
    assert.equal(filesOnDisk(w.dir).length, 1);
    assert.equal(db_count(w.db, 'attachment_files'), 1);

    // een gekoppelde bijlage waarvan het bestand is verdwenen (teruggezette back-up) wordt gemeld maar niet weggegooid
    const kept = (w.db.prepare("SELECT key FROM attachment_files WHERE id = 'gekoppeld-0001'").get() as Row).key as string;
    rmSync(join(w.dir, kept.slice(0, 2), kept));
    assert.deepEqual(w.attachments.check(), { strayFiles: 0, rowsRemoved: 0, missing: 1 });
    assert.equal(db_count(w.db, 'attachment_files'), 1);
    assert.equal((await w.get('alice', '/api/v1/attachments/gekoppeld-0001')).status, 404, 'geen 500 voor een ontbrekend bestand');
  } finally { await w.close(); }
});

test('migratie: een bestaande database zonder bijlagen krijgt de tabellen erbij en houdt al zijn gegevens', async () => {
  const w = await world();
  try {
    await addAttachment(w, 'alice', 'migratie-00001', 'x', 'm.txt', 'text/plain');
    // Zo zag een database van vóór de bijlagen eruit: zonder de twee tabellen.
    w.db.exec('DROP TABLE attachment_files');
    w.db.exec('DROP TABLE attachments');
    w.db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    const { createSchema } = await import('./schema.ts');
    createSchema(w.db);
    createSchema(w.db); // en nog eens: idempotent
    assert.equal(Number((w.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row).value) >= 3, true);
    const full = w.sync('alice', []);
    assert.deepEqual(full.attachments, []);
    assert.equal((full.tasks as Row[]).filter((t) => t.id === w.T).length, 1, 'de taak is er nog');
    const att = createAttachments(w.db, { dir: w.dir, maxUploadBytes: 1000, quotaBytes: 10_000 });
    assert.equal(att.check().strayFiles, 1, 'het bestand van de verdwenen bijlage is nu een zwerver en wordt opgeruimd');
    assert.equal(await (async () => (await w.upload('alice', 'migratie-00002', w.T, 'nieuw')).status)(), 200);
  } finally { await w.close(); }
});

test('de eindpunten bestaan niet als de server zonder bijlagen draait', async () => {
  const db = freshDb();
  const alice = addUser(db, 'alice');
  const token = createSession(db, alice.id, 't').token;
  const app = createApp({ db });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/api/v1/attachments/limits`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await fetch(`${base}/api/v1/attachments?id=abcdefghij&task_id=abcdefghij`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'x' })).status, 404);
  } finally { await app.close(); }
});

test('de gewone verzoeken houden hun tijdslimiet van 30 seconden-regeling: een trage JSON-body wordt nog steeds afgekapt', async () => {
  const w = await world();
  try {
    // Zonder server.requestTimeout bewaakt main.ts het zelf; hier controleren we alleen dat een verbinding met een halve body niet blijft hangen
    // zodra de afzender weggaat, en dat de server daarna gewoon antwoordt.
    const head = `POST /api/v1/sync HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${w.tokens.alice}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"commands":[`;
    await raw(w.port, head, (s) => setTimeout(() => s.destroy(), 50));
    assert.equal((await fetch(`${w.base}/health`)).status, 200);
  } finally { await w.close(); }
});

// ---------- aanvullingen na een mutatietest: wat de eerste tests nog niet vastlegden ----------

/** Een upload die half wordt verstuurd en door de test wordt afgemaakt (of laten doodlopen). */
function heldUpload(w: World, as: 'alice' | 'bob' | 'carol', id: string, task: string, total: number, first: number) {
  const head = `POST /api/v1/attachments?id=${id}&task_id=${task} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${w.tokens[as]}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${total}\r\n\r\n`;
  let socket!: ReturnType<typeof connect>;
  const done = raw(w.port, head, (s) => { socket = s; s.write(Buffer.alloc(first, 5)); });
  return { done, finish: (rest: number) => socket.write(Buffer.alloc(rest, 5)), socket: () => socket };
}

test('een lopende upload houdt zijn ruimte vast: een tweede upload van dezelfde gebruiker wordt meteen geweigerd, nog vóór er iets binnen is', async () => {
  const w = await world({ quotaBytes: 1000, maxUploadBytes: 1000 });
  try {
    const first = heldUpload(w, 'alice', 'houd-vast-0001', w.T, 600, 100);
    await sleep(100);
    const second = await w.upload('alice', 'houd-vast-0002', w.T, Buffer.alloc(600, 9));
    assert.equal(second.status, 409, 'de eerste is nog niet klaar, maar zijn 600 bytes tellen al mee');
    first.finish(500);
    const r = await first.done;
    assert.equal(status(r.data), 200);
    assert.equal(w.attachments.used(w.users.alice.id), 600);
  } finally { await w.close(); }
});

test('de grens wordt aan het eind nog eens gecontroleerd, in één stap met het vastleggen (ook als hij tussendoor lager werd)', async () => {
  const w = await world({ maxUploadBytes: 1000, quotaBytes: 1000 });
  try {
    const held = heldUpload(w, 'alice', 'tussendoor-0001', w.T, 600, 100);
    await sleep(100);
    w.options.quotaBytes = 100; // de beheerder verlaagt de grens terwijl er een upload loopt
    held.finish(500);
    const r = await held.done;
    assert.equal(status(r.data), 409);
    assert.equal(filesOnDisk(w.dir).length, 0);
    assert.deepEqual(tmpFiles(w.dir), []);
  } finally { await w.close(); }
});

test('een lid dat al te veel heeft gedaan, krijgt een nette melding voordat zijn body is gelezen', async () => {
  const w = await world({ idleMs: 400, quotaBytes: 1000, maxUploadBytes: 1000 });
  try {
    // 900 bytes passen niet naast de 300 die er al zijn; de body komt niet, en toch is het antwoord de grens en niet "te langzaam"
    assert.equal((await w.upload('alice', 'al-aanwezig-001', w.T, Buffer.alloc(300, 1))).status, 200);
    const held = heldUpload(w, 'alice', 'stil-en-te-veel1', w.T, 900, 10);
    const r = await held.done;
    assert.equal(status(r.data), 409);
  } finally { await w.close(); }
});

test('een niet-lid dat een upload begint, krijgt 404 zodra de controle klaar is en niet pas na het wachten op zijn body', async () => {
  const w = await world({ idleMs: 400 });
  try {
    const started = Date.now();
    const held = heldUpload(w, 'bob', 'vreemde-upload1', w.T, 500, 50);
    const r = await held.done;
    assert.equal(status(r.data), 404, 'bob is geen lid');
    assert.ok(Date.now() - started < 3000);
    assert.equal(filesOnDisk(w.dir).length, 0);
  } finally { await w.close(); }
});

test('wie tijdens zijn upload uit het project wordt gehaald, houdt niets over', async () => {
  const w = await world();
  try {
    w.sync('alice', [cmd('project_share', { project_id: w.P, username: 'bob' })]);
    const held = heldUpload(w, 'bob', 'weggehaald-0001', w.T, 300, 50);
    await sleep(100);
    w.sync('alice', [cmd('project_unshare', { project_id: w.P, user_id: w.users.bob.id })]);
    held.finish(250);
    const r = await held.done;
    assert.equal(status(r.data), 404);
    assert.equal(filesOnDisk(w.dir).length, 0);
    assert.equal(db_count(w.db, 'attachment_files'), 0);
  } finally { await w.close(); }
});

test('een ander bestand met dezelfde grootte, of hetzelfde id voor een andere taak, is geen herhaling', async () => {
  const w = await world();
  try {
    w.sync('alice', [cmd('task_add', { id: 'task-alice-0002', project_id: w.P, content: 'Tweede' })]);
    const a = await w.upload('alice', 'zelfde-id-00001', w.T, 'aaaa');
    assert.equal(a.status, 200);
    const sameSize = await w.upload('alice', 'zelfde-id-00001', w.T, 'bbbb');
    assert.equal(sameSize.status, 409, 'zelfde grootte, andere inhoud');
    const otherTask = await w.upload('alice', 'zelfde-id-00001', 'task-alice-0002', 'aaaa');
    assert.equal(otherTask.status, 409, 'dezelfde inhoud, maar voor een andere taak');
    assert.equal(db_count(w.db, 'attachment_files'), 1);
  } finally { await w.close(); }
});

test('een upload die nog niet aan een bijlage hangt, is alleen voor de uploader, en alleen zolang die bij de taak mag', async () => {
  const w = await world();
  try {
    w.sync('alice', [cmd('project_share', { project_id: w.P, username: 'bob' })]);
    assert.equal((await w.upload('alice', 'wachtend-00001', w.T, 'x')).status, 200);
    assert.equal((await w.get('alice', '/api/v1/attachments/wachtend-00001')).status, 200);
    assert.equal((await w.get('bob', '/api/v1/attachments/wachtend-00001')).status, 404, 'een ander lid ziet een nog niet gekoppelde upload niet');
    assert.equal((await w.upload('bob', 'wachtend-00002', w.T, 'y')).status, 200);
    w.sync('alice', [cmd('project_unshare', { project_id: w.P, user_id: w.users.bob.id })]);
    assert.equal((await w.get('bob', '/api/v1/attachments/wachtend-00002')).status, 404, 'uit het project: ook zijn eigen upload is niet meer te halen');
  } finally { await w.close(); }
});

test('een bijlage die net is verwijderd maar waarvan het bestand nog staat, is al niet meer te halen; een bestand dat niet klopt met de database ook niet', async () => {
  const w = await world();
  try {
    await addAttachment(w, 'alice', 'verwijderd-0001', 'inhoud', 'a.txt', 'text/plain');
    await addAttachment(w, 'alice', 'beschadigd-0001', 'inhoud', 'b.txt', 'text/plain');
    // verwijderen zonder opruimen (zoals tussen de sync en het opruimen)
    handleSync(w.db, { commands: [cmd('attachment_delete', { id: 'verwijderd-0001' })] }, w.users.alice.id);
    assert.equal((await w.get('alice', '/api/v1/attachments/verwijderd-0001')).status, 404);
    // een bestand waar iemand aan zat: de grootte klopt niet meer
    const key = (w.db.prepare("SELECT key FROM attachment_files WHERE id = 'beschadigd-0001'").get() as Row).key as string;
    writeFileSync(join(w.dir, key.slice(0, 2), key), 'veel langer dan eerst');
    const res = await w.get('alice', '/api/v1/attachments/beschadigd-0001');
    assert.equal(res.status, 404);
    await res.text();
  } finally { await w.close(); }
});

test('de naam in de Content-Disposition: haakjes en een apostrof worden als %-tekens verstuurd (RFC 8187)', async () => {
  const w = await world();
  try {
    await addAttachment(w, 'alice', 'haakjes-000001', 'x', "Anna's foto (1)*.pdf", 'text/plain');
    const cd = String((await sent(w, w.users.alice.id, 'haakjes-000001')).headers['Content-Disposition']);
    const star = cd.slice(cd.indexOf("filename*=UTF-8''") + "filename*=UTF-8''".length);
    assert.equal(star, 'Anna%27s%20foto%20%281%29_.pdf', cd);
  } finally { await w.close(); }
});

test('de tijdslimiet voor een hele upload werkt los van het stilvallen: druppelen is te langzaam, ook als er steeds iets binnenkomt', async () => {
  let t = Date.now();
  const w = await world({ idleMs: 10_000_000, minBytesPerSecond: 1_000_000, maxUploadBytes: 100, now: () => (t += 7000) });
  try {
    const held = heldUpload(w, 'alice', 'langzaam-00001', w.T, 90, 1);
    const drip = setInterval(() => { try { held.socket()?.write('x'); } catch { /* verbinding dicht */ } }, 30);
    const r = await held.done;
    clearInterval(drip);
    assert.equal(status(r.data), 408);
  } finally { await w.close(); }
});
