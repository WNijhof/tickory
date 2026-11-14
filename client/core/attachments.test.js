// De bijlagen op de client: bestanden kiezen, bewaren, uploaden en koppelen, tegen de echte server-engine (zonder netwerk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSync } from '../../server/sync.ts';
import { createAttachments } from '../../server/attachments.ts';
import { SyncError } from '../../server/rows.ts';
import { addUser, freshDb } from '../../server/testutil.ts';
import { MemoryAdapter, Store } from './store.js';
import { AuthError, SyncClient } from './syncClient.js';
import { createActions } from './actions.js';
import { AttachmentError } from './attachmentsApi.js';
import { backoff, createAttachmentManager, MemoryFiles } from './attachments.js';
import { applyCommand, emptyState } from './reducer.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]);
const file = (name, data = 'inhoud', type = 'text/plain') => new File([data], name, { type });

let counter = 0;
const nextId = () => `bijl${String(++counter).padStart(10, '0')}`;

/** Een server met één gebruiker, en een client die daarmee praat; `net` bestuurt de verbinding. */
function setup({ limits = {}, extraUsers = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tickory-att-client-'));
  const db = freshDb();
  const alice = addUser(db, 'alice', 'Alice');
  const others = Object.fromEntries(extraUsers.map((n) => [n, addUser(db, n, n)]));
  const attachments = createAttachments(db, { dir, maxUploadBytes: 100_000, quotaBytes: 1_000_000, ...limits });
  const net = { online: true, auth: true, uploads: 0, failWith: null, onUpload: null };
  const transport = async (body) => {
    if (!net.online) throw new TypeError('fetch failed');
    const res = handleSync(db, JSON.parse(JSON.stringify(body)), alice.id);
    attachments.purgeDeleted();
    return JSON.parse(JSON.stringify(res));
  };
  const api = {
    limits: async () => ({ max_upload_bytes: attachments.maxUploadBytes, quota_bytes: attachments.quotaBytes, used_bytes: 0, per_task: 20 }),
    upload: async ({ id, taskId, blob, mime, signal, onProgress }) => {
      if (!net.online) throw new AttachmentError('geen verbinding', { retryable: true });
      if (!net.auth) throw new AuthError();
      net.uploads += 1;
      if (net.failWith) throw net.failWith;
      await net.onUpload?.({ id, signal });
      if (signal?.aborted) throw new AttachmentError('afgebroken', { code: 'ABORTED' });
      const data = Buffer.from(await blob.arrayBuffer());
      const req = Object.assign(Readable.from([data]), { headers: { 'content-length': String(data.length), 'content-type': mime } });
      Object.defineProperty(req, 'complete', { get: () => req.readableEnded });
      try {
        const out = await attachments.upload(req, alice.id, { id, taskId });
        onProgress(1);
        return out;
      } catch (err) {
        if (err instanceof SyncError) throw new AttachmentError(err.message, { code: err.code, status: 400 });
        throw err;
      }
    },
    download: async (id) => {
      const chunks = [];
      const res = Object.assign(new (await import('node:stream')).Writable({ write: (c, _e, cb) => { chunks.push(c); cb(); } }), { writeHead() { return this; } });
      await attachments.download({ headers: {}, method: 'GET' }, res, alice.id, id, false);
      return new Blob(chunks);
    },
  };
  let clock = Date.parse('2026-11-13T10:00:00Z');
  const store = new Store(new MemoryAdapter(), { now: () => new Date((clock += 1000)).toISOString(), onPersistError: () => {} });
  const sync = new SyncClient({ store, transport });
  const actions = createActions(store, { makeId: nextId, makeUuid: () => `uuid-${String(++counter).padStart(10, '0')}` });
  const files = new MemoryFiles();
  let now = 1_000_000;
  const timers = { fired: [], setTimeout: (fn, ms) => { timers.fired.push({ fn, ms }); return timers.fired.length; }, clearTimeout: () => {} };
  const manager = createAttachmentManager({
    store, actions, api, files, getToken: () => (net.auth ? 'token' : null), makeId: nextId, online: () => net.online, timers, now: () => now,
  });
  return {
    dir, db, alice, others, attachments, net, store, sync, actions, files, manager, timers,
    tick: (ms) => { now += ms; },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function withTask(c, content = 'Boodschappen') {
  await c.store.init();
  await c.sync.syncNow();
  const id = await c.actions.addTask({ content, project_id: c.alice.inbox_project_id });
  return id;
}
const serverAttachments = (c) => c.db.prepare('SELECT * FROM attachments WHERE is_deleted = 0').all();

test('een bestand kiezen: bewaard in de lokale opslag, schone naam, en pas geüpload als de taak bij de server is', async () => {
  const c = setup();
  try {
    const taskId = await withTask(c); // staat nog in de wachtrij
    const { added, rejected } = await c.manager.stage(taskId, [file('../../Rekening "maart".pdf', 'abc', 'application/pdf')]);
    assert.equal(added.length, 1);
    assert.deepEqual(rejected, []);
    const [pending] = c.manager.pendingFor(taskId);
    assert.equal(pending.name, '_.._Rekening _maart_.pdf');
    assert.equal(pending.status, 'waiting');
    assert.equal((await c.files.list()).length, 1, 'ook bewaard voor als de app sluit');
    await c.manager.process();
    assert.equal(c.net.uploads, 0, 'de taak staat nog niet op de server: nog niet uploaden');

    await c.sync.syncNow(); // de taak komt bij de server
    await c.manager.process();
    assert.equal(c.net.uploads, 1);
    assert.equal(c.manager.pendingFor(taskId).length, 0, 'niet meer wachtend');
    assert.equal((await c.files.list()).length, 0, 'de lokale kopie is weg');
    assert.equal(c.store.queueLength, 1, 'het commando staat nu in de wachtrij');
    assert.equal(c.store.view.attachments.size, 1, 'en de bijlage is meteen zichtbaar');
    await c.sync.syncNow();
    assert.equal(c.store.queueLength, 0);
    const rows = serverAttachments(c);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, pending.name);
    assert.equal(rows[0].creator_id, c.alice.id);
    assert.equal(c.store.base.attachments.size, 1);
  } finally { c.close(); }
});

test('controles bij het kiezen: leeg, te groot, te veel bijlagen, opslag vol; wat wel kan gaat gewoon door', async () => {
  const c = setup({ limits: { maxUploadBytes: 1000 } });
  try {
    const taskId = await withTask(c);
    await c.sync.syncNow();
    const big = file('groot.bin', 'x'.repeat(1001));
    const { added, rejected } = await c.manager.stage(taskId, [file('leeg.txt', ''), big, file('goed.txt', 'ok')]);
    assert.equal(added.length, 1);
    assert.deepEqual(rejected.map((r) => [r.name, r.reason]), [['leeg.txt', 'empty'], ['groot.bin', 'tooLarge']]);
    assert.equal(rejected[1].max, 1000);

    c.files.full = true;
    const full = await c.manager.stage(taskId, [file('past-niet.txt', 'x')]);
    assert.deepEqual(full.rejected.map((r) => r.reason), ['storageFull']);
    assert.equal(c.manager.pendingFor(taskId).length, 1, 'er blijft niets half achter');
    c.files.full = false;

    const gone = await c.manager.stage('taak-bestaat-niet-1', [file('x.txt', 'x')]);
    assert.deepEqual(gone.rejected.map((r) => r.reason), ['noTask']);

    // per taak hooguit 20 (wachtende tellen mee)
    const many = await c.manager.stage(taskId, Array.from({ length: 25 }, (_, i) => file(`f${i}.txt`, 'x')));
    assert.equal(many.added.length, 19);
    assert.equal(many.rejected.length, 6);
    assert.ok(many.rejected.every((r) => r.reason === 'tooMany' && r.max === 20));
  } finally { c.close(); }
});

test('zonder verbinding of zonder token blijft een bestand wachten; zodra het kan, gaat het door', async () => {
  const c = setup();
  try {
    const taskId = await withTask(c);
    await c.sync.syncNow();
    c.net.online = false;
    await c.manager.stage(taskId, [file('een.txt')]);
    await c.manager.process();
    assert.equal(c.net.uploads, 0);
    assert.equal(c.manager.pendingFor(taskId)[0].status, 'waiting');

    c.net.online = true;
    c.net.auth = false;
    await c.manager.process();
    assert.equal(c.net.uploads, 0, 'niet ingelogd: niet proberen');

    c.net.auth = true;
    await c.manager.process();
    await c.manager.idle();
    assert.equal(c.net.uploads, 1);
    await c.sync.syncNow();
    assert.equal(serverAttachments(c).length, 1);
  } finally { c.close(); }
});

test('een upload die mislukt omdat de verbinding wegvalt, wordt later opnieuw geprobeerd met oplopende wachttijd', async () => {
  const c = setup();
  try {
    const taskId = await withTask(c);
    await c.sync.syncNow();
    c.net.failWith = new AttachmentError('geen verbinding', { retryable: true });
    await c.manager.stage(taskId, [file('een.txt')]);
    await c.manager.idle();
    assert.equal(c.net.uploads, 1);
    const [p] = c.manager.pendingFor(taskId);
    assert.equal(p.status, 'waiting');
    assert.equal(p.reason, 'offline');
    assert.deepEqual(c.timers.fired.map((t) => t.ms), [backoff(1)]);
    // nog te vroeg: niet nog eens
    await c.manager.process();
    assert.equal(c.net.uploads, 1);
    // na de wachttijd, en de verbinding is terug
    c.net.failWith = null;
    c.tick(backoff(1) + 1);
    await c.manager.process();
    await c.manager.idle();
    assert.equal(c.net.uploads, 2);
    assert.equal(c.manager.pendingFor(taskId).length, 0);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(backoff), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  } finally { c.close(); }
});

test('een bestand dat de server weigert, blijft staan als mislukt, met de reden; opnieuw proberen of weghalen', async () => {
  const c = setup({ limits: { quotaBytes: 10 } });
  try {
    const taskId = await withTask(c);
    await c.sync.syncNow();
    await c.manager.stage(taskId, [file('groot.txt', 'meer dan tien bytes')]);
    await c.manager.idle();
    const [p] = c.manager.pendingFor(taskId);
    assert.equal(p.status, 'failed');
    assert.equal(p.error, 'LIMIT_REACHED');
    assert.equal(c.net.uploads, 1);
    await c.manager.process();
    assert.equal(c.net.uploads, 1, 'een mislukt bestand wordt niet vanzelf opnieuw geprobeerd');
    assert.equal((await c.files.list()).length, 1, 'en blijft bewaard');

    await c.manager.retry(p.id);
    await c.manager.idle();
    assert.equal(c.net.uploads, 2, 'opnieuw proberen probeert het meteen');
    assert.equal(c.manager.pendingFor(taskId)[0].status, 'failed');

    await c.manager.discard(p.id);
    assert.equal(c.manager.pendingFor(taskId).length, 0);
    assert.equal((await c.files.list()).length, 0);
  } finally { c.close(); }
});

test('weghalen tijdens het uploaden breekt de upload af en voegt geen bijlage toe; de volgende gaat gewoon door', async () => {
  const c = setup();
  try {
    const taskId = await withTask(c);
    await c.sync.syncNow();
    let calls = 0;
    c.net.onUpload = async ({ id, signal }) => {
      calls += 1;
      if (calls !== 1) return;
      await c.manager.discard(id);
      assert.equal(signal.aborted, true);
    };
    await c.manager.stage(taskId, [file('eerste.txt', 'a'), file('tweede.txt', 'b')]);
    await c.manager.idle();
    await c.sync.syncNow();
    assert.deepEqual(serverAttachments(c).map((r) => r.name), ['tweede.txt']);
  } finally { c.close(); }
});

test('sluit de app tussen uploaden en koppelen, dan volgt na het openen dezelfde upload en één bijlage', async () => {
  const c = setup();
  try {
    const taskId = await withTask(c);
    await c.sync.syncNow();
    // het bewaren van het commando mislukt eenmalig (bijvoorbeeld omdat de app wordt afgesloten)
    const real = c.actions.addAttachment;
    c.actions.addAttachment = async () => { throw new Error('app sluit'); };
    await c.manager.stage(taskId, [file('een.txt', 'inhoud')]);
    await c.manager.idle();
    assert.equal(c.manager.pendingFor(taskId).length, 1);
    c.actions.addAttachment = real;

    // "nieuwe start": de lokale opslag wordt opnieuw gelezen
    await c.manager.init();
    await c.manager.idle();
    assert.equal(c.net.uploads, 2, 'het bestand is opnieuw geüpload (de server geeft bij dezelfde inhoud dezelfde uitkomst)');
    assert.equal(c.manager.pendingFor(taskId).length, 0);
    await c.sync.syncNow();
    assert.equal(serverAttachments(c).length, 1, 'geen dubbele bijlage');
  } finally { c.close(); }
});

test('hetzelfde commando twee keer in de wachtrij (zelfde uuid) levert één bijlage en geen foutmelding', async () => {
  const c = setup();
  try {
    const taskId = await withTask(c);
    await c.sync.syncNow();
    await c.manager.stage(taskId, [file('een.txt', 'inhoud')]);
    await c.manager.idle();
    const [item] = c.store.peek(1);
    await c.store.enqueue([{ ...item.cmd }]); // dezelfde uuid nog eens
    const errors = [];
    c.sync.onCommandErrors = (e) => errors.push(...e);
    await c.sync.syncNow();
    assert.deepEqual(errors, []);
    assert.equal(serverAttachments(c).length, 1);
  } finally { c.close(); }
});

test('de taak is verdwenen voordat het bestand kon worden geüpload: het bestand wordt weggegooid', async () => {
  const c = setup();
  try {
    const taskId = await withTask(c);
    await c.sync.syncNow();
    c.net.online = false;
    await c.manager.stage(taskId, [file('een.txt')]);
    await c.actions.deleteTask(taskId);
    c.net.online = true;
    await c.manager.process();
    assert.equal(c.net.uploads, 0);
    assert.equal(c.manager.pendingFor(taskId).length, 0);
    assert.equal((await c.files.list()).length, 0);
  } finally { c.close(); }
});

test('afmelden wist de wachtende bestanden en de bewaarde exemplaren', async () => {
  const c = setup();
  try {
    const taskId = await withTask(c);
    await c.sync.syncNow();
    c.net.online = false;
    await c.manager.stage(taskId, [file('een.txt')]);
    assert.equal((await c.files.list()).length, 1);
    await c.manager.clear();
    assert.equal(c.manager.pendingFor(taskId).length, 0);
    assert.equal((await c.files.list()).length, 0);
  } finally { c.close(); }
});

test('een bijlage ophalen: eerst uit het geheugen als die er al is, anders van de server; een onbekende geeft een fout', async () => {
  const c = setup();
  try {
    const taskId = await withTask(c);
    await c.sync.syncNow();
    await c.manager.stage(taskId, [new File([PNG], 'plaatje.png', { type: 'image/png' })]);
    await c.manager.idle();
    await c.sync.syncNow();
    const [row] = serverAttachments(c);
    assert.equal(row.mime, 'image/png');
    const blob = await c.manager.fetchBlob(row.id);
    assert.equal(blob.size, PNG.length);
    c.manager.forgetBlob(row.id);
    const again = await c.manager.fetchBlob(row.id); // nu van de server
    assert.deepEqual(Buffer.from(await again.arrayBuffer()), PNG);
    await assert.rejects(c.manager.fetchBlob('bestaat-niet-12345'));
  } finally { c.close(); }
});

test('de grenzen van de server worden één keer opgehaald; bij een fout gelden de standaardwaarden', async () => {
  let calls = 0;
  const manager = createAttachmentManager({
    store: { view: { tasks: new Map(), attachments: new Map() }, base: { tasks: new Map() } }, actions: {}, getToken: () => null, makeId: nextId,
    api: { limits: async () => { calls += 1; throw new Error('weg'); } },
  });
  const limits = await manager.limits();
  assert.equal(limits.max_upload_bytes, 25_000_000);
  assert.equal(limits.per_task, 20);
  await manager.limits();
  assert.equal(calls, 1);
  await manager.limits({ refresh: true });
  assert.equal(calls, 2);
});

// ---------- de reducer tegenover de server ----------

test('de client rekent bijlagen net als de server: toevoegen, verwijderen (maker of eigenaar), en meeverdwijnen met taak en project', async () => {
  const db = freshDb();
  const alice = addUser(db, 'alice');
  const bob = addUser(db, 'bob');
  const dir = mkdtempSync(join(tmpdir(), 'tickory-att-reducer-'));
  try {
    const sha = 'a'.repeat(64);
    // Twee kanten: de server (handleSync) en een client-toestand per gebruiker (applyCommand).
    const states = { alice: emptyState(), bob: emptyState() };
    const users = { alice, bob };
    let seq = 0;
    const run = (as, type, args, { upload = null } = {}) => {
      if (upload) {
        db.prepare('INSERT OR REPLACE INTO attachment_files (id, user_id, task_id, size, sha256, mime, key, linked, created_at) VALUES (?, ?, ?, 5, ?, ?, ?, 0, ?)')
          .run(upload.id, users[as].id, upload.task, sha, 'text/plain', `k${String(++seq).padStart(31, '0')}`, new Date().toISOString());
      }
      const cmd = { type, uuid: `diff-${String(++seq).padStart(8, '0')}`, args };
      const res = handleSync(db, { sync_token: '*', commands: [cmd] }, users[as].id);
      applyCommand(states[as], cmd, '2026-11-13T10:00:00Z', users[as].id);
      // de ander ziet de bijlagen van de server (zoals na een sync)
      const other = as === 'alice' ? 'bob' : 'alice';
      states[other].attachments = new Map(handleSync(db, { sync_token: '*' }, users[other].id).attachments.map((a) => [a.id, a]));
      return res.sync_status[cmd.uuid];
    };
    const idsOf = (as) => [...states[as].attachments.keys()].sort();
    const serverIds = (as) => handleSync(db, { sync_token: '*' }, users[as].id).attachments.map((a) => a.id).sort();
    const same = (as) => assert.deepEqual(idsOf(as), serverIds(as), `bijlagen van ${as}: client en server verschillen`);

    assert.equal(run('alice', 'project_add', { id: 'project-gezin-01', name: 'Gezin' }), 'ok');
    assert.equal(run('alice', 'task_add', { id: 'task-gezin-0001', project_id: 'project-gezin-01', content: 'Taak' }), 'ok');
    assert.equal(run('alice', 'task_add', { id: 'task-gezin-0002', project_id: 'project-gezin-01', content: 'Taak twee' }), 'ok');
    assert.equal(run('alice', 'project_share', { project_id: 'project-gezin-01', username: 'bob' }), 'ok');
    // bob ziet het project ook in zijn eigen toestand
    for (const e of ['projects', 'tasks', 'members']) for (const row of handleSync(db, { sync_token: '*' }, bob.id)[e]) states.bob[e].set(row.id, row);

    const add = (as, id, task = 'task-gezin-0001') => run(as, 'attachment_add', { id, task_id: task, name: 'a.txt', size: 5, mime: 'text/plain', sha256: sha }, { upload: { id, task } });
    assert.equal(add('alice', 'bijlage-alice-1'), 'ok');
    assert.equal(add('bob', 'bijlage-bob-001'), 'ok');
    same('alice'); same('bob');
    assert.deepEqual(idsOf('bob').sort(), ['bijlage-alice-1', 'bijlage-bob-001']);

    // bob mag de bijlage van alice niet verwijderen; alice (eigenaar) die van bob wel
    const denied = run('bob', 'attachment_delete', { id: 'bijlage-alice-1' });
    assert.equal(denied.error_code, 'FORBIDDEN');
    assert.ok(states.bob.attachments.has('bijlage-alice-1'), 'de client houdt de bijlage ook, zoals de server');
    assert.equal(run('alice', 'attachment_delete', { id: 'bijlage-bob-001' }), 'ok');
    assert.equal(run('bob', 'attachment_delete', { id: 'bijlage-alice-1' }).error_code, 'FORBIDDEN');
    assert.equal(run('alice', 'attachment_delete', { id: 'bijlage-alice-1' }), 'ok');
    same('alice');

    // een taak (en een project) verwijderen neemt de bijlagen mee
    assert.equal(add('alice', 'bijlage-alice-2', 'task-gezin-0002'), 'ok');
    assert.equal(add('alice', 'bijlage-alice-3', 'task-gezin-0001'), 'ok');
    assert.equal(run('alice', 'task_delete', { id: 'task-gezin-0002' }), 'ok');
    same('alice');
    assert.deepEqual(idsOf('alice'), ['bijlage-alice-3']);
    assert.equal(run('alice', 'project_delete', { id: 'project-gezin-01' }), 'ok');
    same('alice');
    assert.deepEqual(idsOf('alice'), []);

    // grens per taak: de 21e wordt door allebei geweigerd
    assert.equal(run('alice', 'project_add', { id: 'project-druk-001', name: 'Druk' }), 'ok');
    assert.equal(run('alice', 'task_add', { id: 'task-druk-00001', project_id: 'project-druk-001', content: 'Druk' }), 'ok');
    for (let i = 0; i < 20; i++) assert.equal(add('alice', `bijlage-druk-${String(i).padStart(2, '0')}`, 'task-druk-00001'), 'ok');
    const twentyFirst = add('alice', 'bijlage-druk-20', 'task-druk-00001');
    assert.equal(twentyFirst.error_code, 'LIMIT_REACHED');
    same('alice');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
