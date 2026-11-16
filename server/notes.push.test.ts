// Herinneringen op notities als melding in de browser (server/push.ts): op het juiste moment, één keer, alleen voor de eigenaar,
// met een herhaling elke keer opnieuw, en niet voor een notitie in de prullenbak. De pushdienst is nagebootst zoals in push.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPush } from './push.ts';
import { handleSync } from './sync.ts';
import type { Command } from './sync.ts';
import { addUser, freshDb, pushDevice } from './testutil.ts';
import { createSession } from './users.ts';
import type { UserRow } from './users.ts';

type Row = Record<string, any>;
const at = (iso: string) => Date.parse(iso);
let n = 0;
const cmd = (type: string, args: Record<string, unknown>): Command => ({ type, uuid: `note-push-${String(++n).padStart(7, '0')}`, args });

function world() {
  const db = freshDb();
  const alice = addUser(db, 'alice', 'Alice');
  const bob = addUser(db, 'bob', 'Bob');
  const state = { clock: at('2026-12-01T06:00:00Z') };
  const sent: { url: string; body: Buffer }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    sent.push({ url, body: init.body });
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  const push = createPush({ db, fetch: fetchFn, now: () => state.clock, defaultTimeZone: 'Europe/Amsterdam' });
  const run = (as: UserRow, commands: Command[]) => {
    const res = handleSync(db, { commands }, as.id);
    for (const c of commands) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`);
  };
  const device = (user: UserRow, name: string) => {
    const d = pushDevice(name);
    push.subscribe(user.id, createSession(db, user.id, name).id, d.subscription);
    return { received: () => sent.filter((s) => s.url === d.subscription.endpoint).map((s) => JSON.parse(d.decrypt(s.body)) as Row) };
  };
  return { db, alice, bob, push, state, run, device };
}

test('een herinnering op een notitie: op het moment zelf, één keer, met de titel en een link naar de notitie', async () => {
  const w = world();
  const phone = w.device(w.alice, 'telefoon');
  const bobPhone = w.device(w.bob, 'bob');
  w.run(w.alice, [cmd('note_add', { id: 'note-push-0001', title: '', content: '- [ ] **melk** halen', remind_at: '2026-12-01T09:00' })]);
  w.state.clock = at('2026-12-01T07:59:59Z'); // 08:59:59 in Amsterdam
  assert.equal((await w.push.tick()).due, 0);
  w.state.clock = at('2026-12-01T08:00:00Z');
  assert.equal((await w.push.tick()).due, 1);
  assert.equal((await w.push.tick()).due, 0, 'niet nog een keer');
  const [m] = phone.received();
  assert.deepEqual([m.type, m.id, m.note_id, m.title, m.moment], ['note-reminder', 'note:note-push-0001', 'note-push-0001', 'melk halen', '2026-12-01T09:00']);
  assert.equal(bobPhone.received().length, 0, 'niet naar een ander');
});

test('een herhaling komt de volgende keer opnieuw; te laat (meer dan een uur) niet meer; de prullenbak en weghalen stoppen het', async () => {
  const w = world();
  const phone = w.device(w.alice, 'telefoon');
  w.run(w.alice, [cmd('note_add', { id: 'note-push-0002', title: 'Water geven', remind_at: '2026-11-01T09:00', remind_repeat: 'daily' })]);
  w.state.clock = at('2026-12-01T08:10:00Z'); // 09:10: de keer van vandaag
  assert.equal((await w.push.tick()).due, 1);
  assert.equal(phone.received().at(-1).moment, '2026-12-01T09:00');
  w.state.clock = at('2026-12-02T09:30:00Z'); // 10:30 de volgende dag: anderhalf uur te laat
  assert.equal((await w.push.tick()).due, 0, 'na een uur niet meer');
  w.state.clock = at('2026-12-03T08:00:00Z');
  assert.equal((await w.push.tick()).due, 1, 'de dag erna wel weer');
  // in de prullenbak: niets meer
  w.run(w.alice, [cmd('note_update', { id: 'note-push-0002', trashed_at: '2026-12-03T08:30:00.000Z' })]);
  w.state.clock = at('2026-12-04T08:00:00Z');
  assert.equal((await w.push.tick()).due, 0);
  // terug, maar zonder herinnering: niets
  w.run(w.alice, [cmd('note_update', { id: 'note-push-0002', trashed_at: null, remind_at: null, remind_repeat: null })]);
  w.state.clock = at('2026-12-05T08:00:00Z');
  assert.equal((await w.push.tick()).due, 0);
  assert.equal(phone.received().length, 2);
});

test('de server weigert een herinnering op een tijdstip dat niet bestaat of een onbekende herhaling', () => {
  const w = world();
  for (const args of [{ remind_at: '2026-02-30T09:00' }, { remind_at: '2026-12-01' }, { remind_at: '2026-12-01T09:00', remind_repeat: 'hourly' }]) {
    const c = cmd('note_add', { id: `note-bad-${String(++n).padStart(5, '0')}`, ...args });
    const res = handleSync(w.db, { commands: [c] }, w.alice.id);
    assert.equal((res.sync_status[c.uuid] as Row).error_code, 'INVALID_ARG', JSON.stringify(args));
  }
});
