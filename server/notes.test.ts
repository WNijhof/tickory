// Notities op de server: ze zijn privé, de grenzen, labels (alleen eigen, en weg als het label verdwijnt), de prullenbak en synchroniseren.
// Alle namen en teksten zijn verzonnen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { audienceSince, handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { LIMITS } from './limits.ts';
import { NOTE_LIMITS } from '../shared/schema.js';
import { addUser, freshDb } from './testutil.ts';
import type { UserRow } from './users.ts';

type Row = Record<string, any>;

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `note-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[], token = '*'): SyncResponse => handleSync(db, { sync_token: token, commands }, as.id);
const code = (res: SyncResponse, c: Command): string => { const s = res.sync_status[c.uuid]; return s === 'ok' ? 'ok' : (s as Row).error_code; };
const ok = (res: SyncResponse, ...cs: Command[]) => { for (const c of cs) assert.equal(code(res, c), 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`); };
const err = (res: SyncResponse, c: Command, expected: string) => assert.equal(code(res, c), expected, `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`);
const notes = (res: SyncResponse): Row[] => res.notes as Row[];
const withLimit = (name: keyof typeof LIMITS, value: number, body: () => void) => {
  const before = LIMITS[name];
  LIMITS[name] = value;
  try { body(); } finally { LIMITS[name] = before; }
};

function world() {
  const db = freshDb();
  return { db, anna: addUser(db, 'anna', 'Anna'), bram: addUser(db, 'bram', 'Bram') };
}
const NOTE = { id: 'note-boodschap-1', title: 'Boodschappen', content: '# Lijst\n\n- [ ] melk\n- [x] brood' };

test('een notitie toevoegen: eigenaar is de gebruiker, standaardwaarden, tijdstempels', () => {
  const { db, anna } = world();
  const c = cmd('note_add', { id: 'note-minimaal-001' });
  const res = run(db, anna, [c]);
  ok(res, c);
  const r = notes(res)[0];
  assert.deepEqual([r.title, r.content, r.background, r.labels, r.is_pinned, r.is_archived, r.trashed_at, r.owner_id, r.is_deleted], ['', '', null, [], false, false, null, anna.id, false]);
  assert.ok(r.created_at && r.updated_at);
  const full = cmd('note_add', NOTE);
  ok(run(db, anna, [full]), full);
  assert.equal(notes(run(db, anna, [])).find((x) => x.id === NOTE.id)!.content, NOTE.content, 'de tekst komt ongewijzigd terug, met accenten en opmaak');
});

test('wijzigen: tekst, kleur, vastpinnen, archief en prullenbak; de eigenaar en onbekende velden niet', () => {
  const { db, anna } = world();
  ok(run(db, anna, [cmd('note_add', NOTE)]));
  const u = cmd('note_update', { id: NOTE.id, title: 'Café & thee', content: 'één ijsje', background: 'waves', is_pinned: true, is_archived: true, trashed_at: '2026-11-16T09:00:00.000Z' });
  const res = run(db, anna, [u]);
  ok(res, u);
  const r = notes(res)[0];
  assert.deepEqual([r.title, r.content, r.background, r.is_pinned, r.is_archived, r.trashed_at], ['Café & thee', 'één ijsje', 'waves', true, true, '2026-11-16T09:00:00.000Z']);
  const plainAgain = cmd('note_update', { id: NOTE.id, background: null });
  ok(run(db, anna, [plainAgain]), plainAgain);
  const back = cmd('note_update', { id: NOTE.id, trashed_at: null });
  ok(run(db, anna, [back]), back);
  const takeOver = cmd('note_update', { id: NOTE.id, owner_id: 'iemand-anders-1' });
  assert.notEqual(code(run(db, anna, [takeOver]), takeOver), 'ok', 'de eigenaar zet je niet zelf');
  assert.equal(notes(run(db, anna, [])).find((x) => x.id === NOTE.id)!.owner_id, anna.id);
});

test('een notitie is privé: een ander ziet, wijzigt of verwijdert haar niet, ook niet met haar id', () => {
  const { db, anna, bram } = world();
  ok(run(db, anna, [cmd('note_add', NOTE)]));
  assert.deepEqual(notes(run(db, bram, [])), []);
  const u = cmd('note_update', { id: NOTE.id, title: 'Van Bram' });
  err(run(db, bram, [u]), u, 'NOT_FOUND');
  const d = cmd('note_delete', { id: NOTE.id });
  err(run(db, bram, [d]), d, 'NOT_FOUND');
  assert.equal(notes(run(db, anna, [])).find((x) => x.id === NOTE.id)!.title, 'Boodschappen');
  // een vraag om alleen de eigen notities geeft nooit iets van een ander
  const mine = cmd('note_add', { id: 'note-van-bram-01', title: 'Bram' });
  ok(run(db, bram, [mine]), mine);
  assert.deepEqual(notes(run(db, bram, [])).map((x) => x.id), ['note-van-bram-01']);
  assert.deepEqual(notes(run(db, anna, [])).map((x) => x.id), [NOTE.id]);
});

test('grenzen: titel, tekst, kleur, tijdstip, onbekend veld en een leeg id', () => {
  const { db, anna } = world();
  const bad = (args: Record<string, unknown>, expected = 'INVALID_ARG') => { const c = cmd('note_add', { id: `note-slecht-${String(++n).padStart(4, '0')}`, ...args }); err(run(db, anna, [c]), c, expected); };
  bad({ title: 'x'.repeat(NOTE_LIMITS.title + 1) });
  bad({ content: 'x'.repeat(NOTE_LIMITS.content + 1) });
  bad({ trashed_at: 'gisteren' });
  bad({ background: 'charcoal' });
  bad({ background: '' });
  bad({ is_pinned: 'ja' });
  bad({ labels: 'spoed' });
  bad({ nonsens: 1 }, 'UNKNOWN_ARG');
  const exact = cmd('note_add', { id: 'note-precies-001', title: 'x'.repeat(NOTE_LIMITS.title), content: 'é'.repeat(NOTE_LIMITS.content) });
  ok(run(db, anna, [exact]), exact);
});

test('labels: alleen eigen en bestaande labels; een verwijderd label verdwijnt uit de notitie', () => {
  const { db, anna, bram } = world();
  ok(run(db, anna, [cmd('label_add', { id: 'label-spoed-0001', name: 'spoed' }), cmd('label_add', { id: 'label-thuis-0001', name: 'thuis' })]));
  ok(run(db, bram, [cmd('label_add', { id: 'label-bram-00001', name: 'bram' })]));
  const withLabels = cmd('note_add', { ...NOTE, labels: ['label-spoed-0001', 'label-thuis-0001'] });
  ok(run(db, anna, [withLabels]), withLabels);
  const missing = cmd('note_update', { id: NOTE.id, labels: ['label-nietbestaat1'] });
  err(run(db, anna, [missing]), missing, 'NOT_FOUND');
  const foreign = cmd('note_update', { id: NOTE.id, labels: ['label-bram-00001'] });
  err(run(db, anna, [foreign]), foreign, 'NOT_FOUND');
  const gone = cmd('label_delete', { id: 'label-spoed-0001' });
  const res = run(db, anna, [gone]);
  ok(res, gone);
  assert.deepEqual(notes(res).find((x) => x.id === NOTE.id)!.labels, ['label-thuis-0001']);
});

test('een label van iemand anders dat je via een gedeeld project ziet, kun je niet op een notitie zetten', () => {
  const { db, anna, bram } = world();
  const share = [
    cmd('project_add', { id: 'project-gedeeld1', name: 'Samen' }),
    cmd('label_add', { id: 'label-bram-00002', name: 'samenlabel' }),
  ];
  ok(run(db, bram, share));
  const t = cmd('task_add', { id: 'task-gedeeld-001', project_id: 'project-gedeeld1', content: 'Iets', labels: ['label-bram-00002'] });
  ok(run(db, bram, [t, cmd('project_share', { project_id: 'project-gedeeld1', username: 'anna' })]));
  // Anna ziet het label nu, maar het is niet van haar
  assert.ok((run(db, anna, []).labels as Row[]).some((l) => l.id === 'label-bram-00002'));
  ok(run(db, anna, [cmd('note_add', { id: 'note-foreign-001' })]));
  const use = cmd('note_update', { id: 'note-foreign-001', labels: ['label-bram-00002'] });
  err(run(db, anna, [use]), use, 'INVALID_ARG');
});

test('de grens van notities per gebruiker, en een verwijderde notitie telt niet meer mee', () => {
  const { db, anna, bram } = world();
  withLimit('notesPerUser', 2, () => {
    ok(run(db, anna, [cmd('note_add', { id: 'note-limiet-0001' }), cmd('note_add', { id: 'note-limiet-0002' })]));
    const third = cmd('note_add', { id: 'note-limiet-0003' });
    err(run(db, anna, [third]), third, 'LIMIT_REACHED');
    ok(run(db, bram, [cmd('note_add', { id: 'note-bram-limiet1' })])); // de grens is per gebruiker
    const del = cmd('note_delete', { id: 'note-limiet-0001' });
    ok(run(db, anna, [del]), del);
    const again = cmd('note_add', { id: 'note-limiet-0004' });
    ok(run(db, anna, [again]), again);
  });
});

test('verwijderen: weg uit de lijst met een grafsteen, de andere notities blijven', () => {
  const { db, anna } = world();
  const start = run(db, anna, [cmd('note_add', NOTE), cmd('note_add', { id: 'note-tweede-0001', title: 'Blijft' })]);
  const d = cmd('note_delete', { id: NOTE.id });
  const res = run(db, anna, [d], start.sync_token); // een volgende vraag meldt de verwijdering (een volledige geeft geen grafstenen)
  ok(res, d);
  assert.equal(notes(res).find((x) => x.id === NOTE.id)!.is_deleted, true);
  assert.deepEqual(notes(run(db, anna, [])).filter((x) => !x.is_deleted).map((x) => x.id), ['note-tweede-0001']);
  const u = cmd('note_update', { id: NOTE.id, title: 'nog even' });
  err(run(db, anna, [u]), u, 'NOT_FOUND');
});

test('synchroniseren: alleen wat veranderd is, en alleen voor de eigenaar', () => {
  const { db, anna, bram } = world();
  const first = run(db, anna, [cmd('note_add', NOTE)]);
  const token = first.sync_token;
  assert.deepEqual(notes(run(db, anna, [], token)), [], 'niets nieuws');
  const second = run(db, anna, [cmd('note_update', { id: NOTE.id, is_pinned: true })], token);
  assert.deepEqual(notes(second).map((x) => [x.id, x.is_pinned]), [[NOTE.id, true]]);
  // wie hoort het te horen (realtime): alleen Anna
  const before = (run(db, bram, []).sync_token as unknown as number);
  run(db, anna, [cmd('note_update', { id: NOTE.id, title: 'Anders' })]);
  const audience = audienceSince(db, Number(before), anna.id);
  assert.equal(audience.has(anna.id), true);
  assert.equal(audience.has(bram.id), false, 'Bram krijgt geen signaal van een privénotitie van Anna');
});

test('een gedeeltelijke vraag: notes is een eigen resourcetype', () => {
  const { db, anna } = world();
  ok(run(db, anna, [cmd('note_add', NOTE)]));
  const res = handleSync(db, { sync_token: '*', resource_types: ['notes'] }, anna.id);
  assert.equal(notes(res).length, 1);
  assert.equal((res as Row).tasks, undefined);
});
