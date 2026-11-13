// Het live-signaal (SSE): alleen wie iets van een wijziging ziet, krijgt het te horen, zonder globaal versienummer.
// En: een gebruiker kan niet onbeperkt veel verbindingen openen.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createSchema } from './schema.ts';
import { createApp } from './main.ts';
import type { App } from './main.ts';
import { LIMITS } from './limits.ts';
import { createUser, hashPassword, setPasswordCostForTests } from './users.ts';

let app: App;
let base = '';
const PW = 'een-goed-wachtwoord';
const tokens: Record<string, string> = {};
const ids: Record<string, { inbox: string; id: string }> = {};

const call = (path: string, body: unknown, token: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
let n = 0;
const sync = async (who: string, commands: unknown[], clientId = `client-${who}`) => {
  const r = await call('/api/v1/sync', { commands: commands.map((c: any) => ({ ...c, uuid: `sse-${String(++n).padStart(8, '0')}` })), resource_types: ['settings'] }, tokens[who], { 'X-Client-Id': clientId });
  const body = await r.json();
  for (const c of commands as any[]) void c;
  return body as any;
};

/** Opent een live-verbinding en bewaart alles wat binnenkomt. */
async function listen(who: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/v1/events`, { headers: { Authorization: `Bearer ${tokens[who]}` }, signal: ctrl.signal });
  const text: string[] = [];
  if (res.status === 200) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    (async () => { for (;;) { const r = await reader.read().catch(() => ({ done: true, value: undefined })); if (r.done) break; text.push(dec.decode(r.value)); } })();
  }
  return { status: res.status, text: () => text.join(''), close: () => ctrl.abort() };
}
const quiet = (ms = 250) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  setPasswordCostForTests(1024);
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  for (const name of ['alice', 'bob', 'carol']) {
    const u = createUser(db, { username: name, name, passwordHash: await hashPassword(PW) });
    ids[name] = { inbox: u.inbox_project_id, id: u.id };
  }
  app = createApp({ db });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  for (const name of ['alice', 'bob', 'carol']) {
    const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PW, device_name: 'test' }) });
    tokens[name] = ((await r.json()) as any).token;
  }
});
after(async () => { await app.close(); });

test('sync_needed gaat alleen naar wie de wijziging ziet, en draagt geen versienummer', async () => {
  const [a1, a2, b, c] = [await listen('alice'), await listen('alice'), await listen('bob'), await listen('carol')];
  try {
    await quiet(100);
    for (const s of [a1, b, c]) assert.ok(!/"rev"/.test(s.text()), 'ook de begroeting bevat geen versienummer');
    assert.match(c.text(), /event: hello\ndata: \{\}\n\n/);
    await sync('alice', [{ type: 'project_add', args: { id: 'projectShared01', name: 'Samen' } }, { type: 'project_share', args: { project_id: 'projectShared01', username: 'carol' } }]);
    await quiet();
    assert.match(c.text(), /event: sync_needed\ndata: \{\}\n\n/, 'carol is lid geworden: zij hoort het, zonder client_id of versienummer van iemand anders');
    assert.ok(!/client_id/.test(c.text().replace(/event: hello[^]*?\n\n/, '')), 'het client_id van alice gaat niet naar carol');
    assert.match(a1.text(), /sync_needed\ndata: \{"client_id":"client-alice"\}/, 'de eigen apparaten van alice krijgen het client_id (om de eigen wijziging te negeren)');
    assert.match(a2.text(), /sync_needed\ndata: \{"client_id":"client-alice"\}/);
    assert.ok(!/sync_needed/.test(b.text()), 'bob deelt niets met alice en hoort niets');

    const cBefore = c.text().length;
    const bBefore = b.text().length;
    await sync('alice', [{ type: 'task_add', args: { id: 'taskPrivate001', project_id: ids.alice.inbox, content: 'privé' } }]);
    await quiet();
    assert.equal(c.text().length, cBefore, 'een wijziging in alice\' eigen Inbox komt niet bij carol');
    assert.equal(b.text().length, bBefore);
    await sync('alice', [{ type: 'task_add', args: { id: 'taskShared0001', project_id: 'projectShared01', content: 'samen' } }]);
    await quiet();
    assert.ok(c.text().length > cBefore, 'een wijziging in het gedeelde project wel');
    assert.equal(b.text().length, bBefore, 'bob hoort ook die niet');

    // wie uit een project wordt gehaald, moet horen dat het voor hem verdwijnt
    const cMid = c.text().length;
    await sync('alice', [{ type: 'project_unshare', args: { project_id: 'projectShared01', user_id: ids.carol.id } }]);
    await quiet();
    assert.ok(c.text().length > cMid, 'carol hoort dat ze uit het project is gehaald');
    assert.equal(b.text().length, bBefore);

    // eigen gegevens (labels) horen bij de eigenaar, niet bij een ander
    const bMid = b.text().length;
    await sync('bob', [{ type: 'label_add', args: { id: 'labelBob000001', name: 'bob' } }]);
    await quiet();
    assert.ok(b.text().length > bMid);
    assert.equal(a1.text().includes('labelBob'), false);
  } finally {
    for (const s of [a1, a2, b, c]) s.close();
  }
});

test('een gebruiker kan niet onbeperkt veel live-verbindingen openen', async () => {
  const before = LIMITS.sseConnectionsPerUser;
  LIMITS.sseConnectionsPerUser = 2;
  const opened: Awaited<ReturnType<typeof listen>>[] = [];
  try {
    opened.push(await listen('bob'), await listen('bob'));
    const third = await listen('bob');
    assert.equal(third.status, 429);
    assert.equal(opened[0].status, 200);
    const other = await listen('carol');
    assert.equal(other.status, 200, 'een andere gebruiker heeft zijn eigen ruimte');
    opened.push(other);
    opened[0].close();
    await quiet(100);
    const again = await listen('bob');
    assert.equal(again.status, 200, 'na het sluiten van een verbinding is er weer ruimte');
    opened.push(again);
  } finally {
    LIMITS.sseConnectionsPerUser = before;
    for (const s of opened) s.close();
  }
});
