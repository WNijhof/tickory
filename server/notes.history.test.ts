// Versiegeschiedenis van notities (noteHistory.ts): wanneer een versie wordt bewaard, hoeveel, terugzetten (en dat weer ongedaan
// maken), alleen voor de eigenaar, en weg met de notitie. Over HTTP: de lijst en één versie.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from './main.ts';
import { handleSync } from './sync.ts';
import type { Command } from './sync.ts';
import { REVISIONS_PER_NOTE, REVISION_GAP_MS, getRevision, listRevisions } from './noteHistory.ts';
import { addUser, freshDb } from './testutil.ts';
import { createSession, setPasswordCostForTests } from './users.ts';

setPasswordCostForTests(1024);

type Row = Record<string, any>;
let n = 0;
const cmd = (type: string, args: Record<string, unknown>): Command => ({ type, uuid: `hist-${String(++n).padStart(8, '0')}`, args });

function world() {
  const db = freshDb();
  const alice = addUser(db, 'alice', 'Alice');
  const bob = addUser(db, 'bob', 'Bob');
  let clock = Date.parse('2026-11-16T09:00:00Z');
  const at = (ms: number) => { clock = ms; };
  const run = (as: typeof alice, commands: Command[]) => {
    // de server neemt de tijd van new Date(); zet die even op de klok van de test
    mock.timers.enable({ apis: ['Date'], now: clock });
    try {
      return handleSync(db, { commands }, as.id);
    } finally { mock.timers.reset(); }
  };
  const ok = (as: typeof alice, commands: Command[]) => {
    const r = run(as, commands);
    for (const c of commands) assert.equal(r.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(r.sync_status[c.uuid])}`);
  };
  const note = () => (handleSync(db, { sync_token: '*' }, alice.id).notes as Row[]).find((x) => x.id === 'note-hist-0001');
  return { db, alice, bob, at, ok, run, note, minutes: (m: number) => { clock += m * 60_000; } };
}

test('een versie na een pauze van tien minuten; snel achter elkaar typen geeft er één; een lege notitie geen', (t) => {
  const w = world();
  w.ok(w.alice, [cmd('note_add', { id: 'note-hist-0001', title: '', content: '' })]);
  w.ok(w.alice, [cmd('note_update', { id: 'note-hist-0001', content: 'Eerste versie' })]);
  assert.equal(listRevisions(w.db, w.alice.id, 'note-hist-0001').revisions.length, 0, 'de lege begintoestand is geen versie');
  w.minutes(1);
  w.ok(w.alice, [cmd('note_update', { id: 'note-hist-0001', content: 'Eerste versie, aangevuld' })]);
  w.minutes(1);
  w.ok(w.alice, [cmd('note_update', { id: 'note-hist-0001', content: 'Eerste versie, nog meer' })]);
  let list = listRevisions(w.db, w.alice.id, 'note-hist-0001').revisions as Row[];
  assert.equal(list.length, 1, 'tijdens het typen: één versie (de stand van vóór deze sessie)');
  assert.equal((getRevision(w.db, w.alice.id, 'note-hist-0001', list[0].id) as Row).content, 'Eerste versie');
  w.minutes(REVISION_GAP_MS / 60_000 + 1);
  w.ok(w.alice, [cmd('note_update', { id: 'note-hist-0001', title: 'Plan' })]);
  list = listRevisions(w.db, w.alice.id, 'note-hist-0001').revisions as Row[];
  assert.deepEqual(list.map((r) => [r.version, r.cause]), [[2, 'edit'], [1, 'edit']], 'nieuwste eerst');
  assert.equal((getRevision(w.db, w.alice.id, 'note-hist-0001', list[0].id) as Row).content, 'Eerste versie, nog meer');
  // een wijziging van iets anders (vastpinnen, achtergrond) is geen nieuwe versie
  w.minutes(30);
  w.ok(w.alice, [cmd('note_update', { id: 'note-hist-0001', is_pinned: true, background: 'blue' })]);
  assert.equal(listRevisions(w.db, w.alice.id, 'note-hist-0001').revisions.length, 2);
  t.diagnostic(`${REVISIONS_PER_NOTE} per notitie`);
});

test('terugzetten: de oude tekst komt terug, de huidige wordt eerst bewaard (zo is het ongedaan te maken)', () => {
  const w = world();
  w.ok(w.alice, [cmd('note_add', { id: 'note-hist-0001', title: 'Recept', content: 'Versie A' })]);
  w.minutes(20);
  w.ok(w.alice, [cmd('note_update', { id: 'note-hist-0001', content: 'Versie B' })]);
  const [a] = listRevisions(w.db, w.alice.id, 'note-hist-0001').revisions as Row[];
  w.minutes(1);
  w.ok(w.alice, [cmd('note_restore', { id: 'note-hist-0001', revision_id: a.id, title: 'genegeerd', content: 'genegeerd' })]);
  assert.deepEqual([w.note().title, w.note().content], ['Recept', 'Versie A'], 'de server neemt de bewaarde versie, niet wat de client stuurt');
  const list = listRevisions(w.db, w.alice.id, 'note-hist-0001').revisions as Row[];
  assert.deepEqual(list.map((r) => r.cause), ['restore', 'edit']);
  // ongedaan maken = de versie van vóór het terugzetten terugzetten
  w.ok(w.alice, [cmd('note_restore', { id: 'note-hist-0001', revision_id: list[0].id })]);
  assert.equal(w.note().content, 'Versie B');
  // nog eens hetzelfde: verandert niets en maakt geen nieuwe versie
  const before = listRevisions(w.db, w.alice.id, 'note-hist-0001').revisions.length;
  w.ok(w.alice, [cmd('note_restore', { id: 'note-hist-0001', revision_id: list[0].id })]);
  assert.equal(listRevisions(w.db, w.alice.id, 'note-hist-0001').revisions.length, before);
});

test('alleen de eigenaar; een onbekende versie, een versie van een andere notitie of in de prullenbak: geweigerd', () => {
  const w = world();
  w.ok(w.alice, [cmd('note_add', { id: 'note-hist-0001', title: 'Geheim', content: 'A' }), cmd('note_add', { id: 'note-hist-0002', title: 'Ander', content: 'X' })]);
  w.minutes(20);
  w.ok(w.alice, [cmd('note_update', { id: 'note-hist-0001', content: 'B' }), cmd('note_update', { id: 'note-hist-0002', content: 'Y' })]);
  const [rev] = listRevisions(w.db, w.alice.id, 'note-hist-0001').revisions as Row[];
  const [other] = listRevisions(w.db, w.alice.id, 'note-hist-0002').revisions as Row[];
  assert.throws(() => listRevisions(w.db, w.bob.id, 'note-hist-0001'), /bestaat niet/);
  assert.throws(() => getRevision(w.db, w.bob.id, 'note-hist-0001', rev.id), /bestaat niet/);
  assert.throws(() => getRevision(w.db, w.alice.id, 'note-hist-0001', other.id), /bestaat niet/);
  const tries: [typeof w.alice, Record<string, unknown>, string][] = [
    [w.bob, { id: 'note-hist-0001', revision_id: rev.id }, 'NOT_FOUND'],
    [w.alice, { id: 'note-hist-0001', revision_id: other.id }, 'NOT_FOUND'],
    [w.alice, { id: 'note-hist-0001', revision_id: 'rev_bestaatniet00' }, 'NOT_FOUND'],
    [w.alice, { id: 'note-hist-0001', revision_id: rev.id, extra: 1 }, 'UNKNOWN_ARG'],
  ];
  for (const [who, args, code] of tries) {
    const c = cmd('note_restore', args);
    assert.equal((w.run(who, [c]).sync_status[c.uuid] as Row).error_code, code, JSON.stringify(args));
  }
  w.ok(w.alice, [cmd('note_update', { id: 'note-hist-0001', trashed_at: '2026-11-16T10:00:00.000Z' })]);
  const c = cmd('note_restore', { id: 'note-hist-0001', revision_id: rev.id });
  assert.equal((w.run(w.alice, [c]).sync_status[c.uuid] as Row).error_code, 'CONFLICT');
});

test('hooguit vijftig versies per notitie; definitief verwijderen neemt ze mee', () => {
  const w = world();
  w.ok(w.alice, [cmd('note_add', { id: 'note-hist-0001', title: 'Dagboek', content: 'dag 0' })]);
  for (let i = 1; i <= REVISIONS_PER_NOTE + 5; i++) {
    w.minutes(11);
    w.ok(w.alice, [cmd('note_update', { id: 'note-hist-0001', content: `dag ${i}` })]);
  }
  const list = listRevisions(w.db, w.alice.id, 'note-hist-0001').revisions as Row[];
  assert.equal(list.length, REVISIONS_PER_NOTE);
  assert.equal((getRevision(w.db, w.alice.id, 'note-hist-0001', list.at(-1).id) as Row).content, 'dag 5', 'de oudste zijn weg');
  w.ok(w.alice, [cmd('note_delete', { id: 'note-hist-0001' })]);
  assert.equal((w.db.prepare('SELECT COUNT(*) AS n FROM note_revisions').get() as Row).n, 0);
});

test('over HTTP: de lijst en één versie, alleen met je eigen aanmelding', async () => {
  const w = world();
  w.ok(w.alice, [cmd('note_add', { id: 'note-hist-0001', title: 'Plan', content: 'Oud' })]);
  w.minutes(20);
  w.ok(w.alice, [cmd('note_update', { id: 'note-hist-0001', content: 'Nieuw' })]);
  const app = createApp({ db: w.db });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const alice = createSession(w.db, w.alice.id, 't').token;
    const bob = createSession(w.db, w.bob.id, 't').token;
    const get = (token: string | null, path: string) => fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const list = await get(alice, '/api/v1/notes/note-hist-0001/revisions');
    assert.equal(list.status, 200);
    const body = await list.json() as Row;
    assert.equal(body.revisions.length, 1);
    assert.equal(body.revisions[0].content, undefined, 'de lijst zonder tekst');
    const one = await get(alice, `/api/v1/notes/note-hist-0001/revisions/${body.revisions[0].id}`);
    assert.equal((await one.json() as Row).content, 'Oud');
    assert.equal((await get(bob, '/api/v1/notes/note-hist-0001/revisions')).status, 404);
    assert.equal((await get(null, '/api/v1/notes/note-hist-0001/revisions')).status, 401);
    assert.equal((await get(alice, '/api/v1/notes/note-hist-0001/iets')).status, 404);
  } finally { await app.close(); }
});
