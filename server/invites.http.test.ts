// Uitnodigen via een link (invites.ts) over echte HTTP: maken, bekijken, aannemen, intrekken, verlopen, en wie wat mag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './main.ts';
import { createSchema } from './schema.ts';
import { handleSync } from './sync.ts';
import { createSession, createUser } from './users.ts';
import { deleteAccount } from './accountDelete.ts';

const P = 'project-gezin-01';

async function world() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const anna = createUser(db, { username: 'anna', name: 'Anna', passwordHash: 'x' });
  const bram = createUser(db, { username: 'bram', name: 'Bram', passwordHash: 'x' });
  const cor = createUser(db, { username: 'cor', name: 'Cor', passwordHash: 'x' });
  const clock = { now: Date.parse('2026-11-17T10:00:00Z') };
  const app = createApp({ db, attachmentSweepMs: 0, sessionSweepMs: 0, backup: null, clock: () => clock.now, log: () => {} });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const tokens = { anna: createSession(db, anna.id, 'Laptop').token, bram: createSession(db, bram.id, 'Laptop').token, cor: createSession(db, cor.id, 'Laptop').token };
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() as any };
  };
  const sync = (userId: string, commands: object[] = []) => handleSync(db, { sync_token: '*', commands }, userId) as any;
  sync(anna.id, [
    { type: 'project_add', uuid: 'inv-0000000001', args: { id: P, name: 'Gezin' } },
    { type: 'project_add', uuid: 'inv-0000000002', args: { id: 'project-gezin-sub', name: 'Vakantie', parent_id: P } },
  ]);
  const roleOf = (user: string, project = P) => (db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND is_deleted = 0').get(project, user) as any)?.role ?? null;
  return { db, app, anna, bram, cor, clock, call, sync, tokens, roleOf, close: () => app.close() };
}

test('de eigenaar maakt een link; Bram bekijkt hem, neemt hem aan en zit erin met de rol van de link (ook in het subproject)', async () => {
  const w = await world();
  try {
    const made = await w.call('POST', `/api/v1/projects/${P}/invites`, w.tokens.anna, { role: 'viewer', days: 7 });
    assert.equal(made.status, 200);
    assert.match(made.body.token, /^tki_[\w-]{43}$/);
    assert.equal(made.body.role, 'viewer');
    assert.equal(made.body.expires_at, '2026-11-24T10:00:00.000Z');
    assert.equal(JSON.stringify(w.db.prepare('SELECT * FROM project_invites').all()).includes(made.body.token), false, 'het token staat niet in de database');
    const list = await w.call('GET', `/api/v1/projects/${P}/invites`, w.tokens.anna);
    assert.deepEqual(list.body.invites.map((i: any) => [i.id, i.role, i.uses]), [[made.body.id, 'viewer', 0]]);
    assert.equal(list.body.invites[0].token, undefined, 'het token komt maar één keer terug');

    const seen = await w.call('GET', `/api/v1/invites/${made.body.token}`, w.tokens.bram);
    assert.deepEqual(seen.body, { project_id: P, project_name: 'Gezin', owner_name: 'Anna', role: 'viewer', member: false });
    const took = await w.call('POST', `/api/v1/invites/${made.body.token}/accept`, w.tokens.bram, {});
    assert.deepEqual(took.body, { project_id: P, joined: true });
    assert.deepEqual([w.roleOf(w.bram.id), w.roleOf(w.bram.id, 'project-gezin-sub')], ['viewer', 'viewer']);
    assert.ok(w.sync(w.bram.id).projects.some((p: any) => p.id === P), 'Bram ziet het project');
    // nog een keer: er verandert niets
    assert.deepEqual((await w.call('POST', `/api/v1/invites/${made.body.token}/accept`, w.tokens.bram, {})).body, { project_id: P, joined: false });
    assert.equal((await w.call('GET', `/api/v1/invites/${made.body.token}`, w.tokens.bram)).body.member, true);
    // de link werkt voor meer mensen, en telt
    assert.equal((await w.call('POST', `/api/v1/invites/${made.body.token}/accept`, w.tokens.cor, {})).body.joined, true);
    assert.equal((await w.call('GET', `/api/v1/projects/${P}/invites`, w.tokens.anna)).body.invites[0].uses, 2);
    // het logboek en de melding gaan zoals bij delen op naam
    const log = w.db.prepare("SELECT user_id FROM activity WHERE project_id = ? AND kind = 'member_added'").all(P) as any[];
    assert.deepEqual(log.map((r) => r.user_id).sort(), [w.bram.id, w.cor.id].sort());
  } finally { await w.close(); }
});

test('wie mag wat: alleen de eigenaar maakt, ziet en trekt links in; een lid of buitenstaander niet', async () => {
  const w = await world();
  try {
    const made = (await w.call('POST', `/api/v1/projects/${P}/invites`, w.tokens.anna, {})).body;
    assert.equal(made.role, 'member', 'standaard: kan bewerken');
    await w.call('POST', `/api/v1/invites/${made.token}/accept`, w.tokens.bram, {});
    assert.equal((await w.call('POST', `/api/v1/projects/${P}/invites`, w.tokens.bram, {})).status, 403, 'een lid maakt geen link');
    assert.equal((await w.call('GET', `/api/v1/projects/${P}/invites`, w.tokens.bram)).status, 403);
    assert.equal((await w.call('DELETE', `/api/v1/projects/${P}/invites/${made.id}`, w.tokens.bram)).status, 403);
    assert.equal((await w.call('GET', `/api/v1/projects/${P}/invites`, w.tokens.cor)).status, 404, 'een buitenstaander hoort niet dat het project bestaat');
    assert.equal((await w.call('POST', `/api/v1/projects/${w.anna.inbox_project_id}/invites`, w.tokens.anna, {})).status, 409, 'de Inbox niet');
    assert.equal((await w.call('POST', `/api/v1/projects/${P}/invites`, w.tokens.anna, { role: 'owner' })).status, 400);
    assert.equal((await w.call('POST', `/api/v1/projects/${P}/invites`, w.tokens.anna, { days: 365 })).status, 400);
    assert.equal((await w.call('GET', `/api/v1/invites/${made.token}`, null)).status, 401, 'alleen aangemeld');
  } finally { await w.close(); }
});

test('een link werkt niet meer na intrekken, verlopen, het overdragen van het project of als het project weg is; altijd dezelfde fout', async () => {
  const w = await world();
  try {
    const a = (await w.call('POST', `/api/v1/projects/${P}/invites`, w.tokens.anna, { days: 1 })).body;
    const b = (await w.call('POST', `/api/v1/projects/${P}/invites`, w.tokens.anna, { days: 30 })).body;
    const c = (await w.call('POST', `/api/v1/projects/${P}/invites`, w.tokens.anna, { days: 30 })).body;
    assert.equal((await w.call('DELETE', `/api/v1/projects/${P}/invites/${b.id}`, w.tokens.anna)).status, 200);
    const gone = async (token: string) => {
      const r = await w.call('GET', `/api/v1/invites/${token}`, w.tokens.bram);
      assert.equal(r.status, 404);
      assert.equal(r.body.error, 'deze link werkt niet (meer): verlopen, ingetrokken of onbekend');
    };
    await gone(b.token);
    await gone('tki_' + 'x'.repeat(43));
    await gone('onzin');
    w.clock.now += 86_400_000; // een dag later
    await gone(a.token);
    assert.deepEqual((await w.call('GET', `/api/v1/projects/${P}/invites`, w.tokens.anna)).body.invites.map((i: any) => i.id), [c.id], 'alleen wat nog werkt');
    // Anna draagt het project over aan Cor: haar links werken niet meer
    w.sync(w.anna.id, [{ type: 'project_share', uuid: 'inv-0000000003', args: { project_id: P, username: 'cor' } }, { type: 'project_transfer', uuid: 'inv-0000000004', args: { project_id: P, user_id: w.cor.id } }]);
    await gone(c.token);
    assert.equal(w.roleOf(w.bram.id), null);
  } finally { await w.close(); }
});

test('hooguit 20 links per project tegelijk, en een paar pogingen per persoon', async () => {
  const w = await world();
  try {
    for (let i = 0; i < 20; i++) assert.equal((await w.call('POST', `/api/v1/projects/${P}/invites`, w.tokens.anna, {})).status, 200);
    assert.equal((await w.call('POST', `/api/v1/projects/${P}/invites`, w.tokens.anna, {})).status, 409);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await w.call('GET', `/api/v1/invites/tki_${'y'.repeat(43)}`, w.tokens.bram)).status;
    assert.equal(last, 429, 'na 30 pogingen even niet');
  } finally { await w.close(); }
});

test('een account verwijderen ruimt de links op die je maakte', async () => {
  const w = await world();
  try {
    await w.call('POST', `/api/v1/projects/${P}/invites`, w.tokens.anna, {});
    w.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(w.bram.id);
    deleteAccount(w.db, w.anna.id, () => {});
    assert.equal(Number((w.db.prepare('SELECT COUNT(*) AS n FROM project_invites').get() as any).n), 0);
  } finally { await w.close(); }
});
