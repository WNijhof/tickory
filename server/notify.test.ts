// Meldingen bij samenwerken (notify.ts): wie krijgt wat, wie ziet wat, wat er verdwijnt, en de grenzen.
// Elke test begint met drie gebruikers (Anna, Bram, Carla) en een project "Gezin" van Anna dat ze met Bram deelt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { createSchema, SCHEMA_VERSION } from './schema.ts';
import { audienceSince, currentRev, handleSync } from './sync.ts';
import type { Command, SyncResponse } from './sync.ts';
import { pruneNotifications } from './notify.ts';
import { addUser, freshDb } from './testutil.ts';
import { updateUser } from './users.ts';
import type { UserRow } from './users.ts';
import { MAX_NOTIFICATIONS_PER_USER } from '../shared/notifications.js';

type Row = Record<string, any>;

let n = 0;
const cmd = (type: string, args: Record<string, unknown> = {}): Command => ({ type, uuid: `ntf-${String(++n).padStart(8, '0')}`, args });
const run = (db: DatabaseSync, as: UserRow, commands: Command[], token = '*', resources?: string[]): SyncResponse =>
  handleSync(db, { sync_token: token, commands, ...(resources ? { resource_types: resources } : {}) }, as.id);
const ok = (res: SyncResponse, ...cs: Command[]) => { for (const c of cs) assert.equal(res.sync_status[c.uuid], 'ok', `${c.type}: ${JSON.stringify(res.sync_status[c.uuid])}`); };
const err = (res: SyncResponse, c: Command, code: string) => {
  const s = res.sync_status[c.uuid];
  assert.ok(typeof s === 'object' && s.error_code === code, `${c.type}: verwacht ${code}, kreeg ${JSON.stringify(s)}`);
};
const mine = (db: DatabaseSync, u: UserRow): Row[] => (run(db, u, []).notifications as Row[]);
/** De meldingen van iemand als [soort, wie, taak of project], gesorteerd. */
const brief = (db: DatabaseSync, u: UserRow): string[] => mine(db, u).map((x) => `${x.kind}:${x.actor_id}:${x.task_id ?? x.project_id}${x.comment_id ? `:${x.comment_id}` : ''}`).sort();

const P = 'project-gezin-001', T = 'task-gezin-00001', T2 = 'task-gezin-00002';

function world() {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  const carla = addUser(db, 'carla', 'Carla');
  const cs = [cmd('project_add', { id: P, name: 'Gezin' }), cmd('project_share', { project_id: P, username: 'bram' }), cmd('task_add', { id: T, project_id: P, content: 'Boodschappen' })];
  ok(run(db, anna, cs), ...cs);
  // Bram kreeg bij het delen al een melding; die halen we voor de duidelijkheid van elke test weg
  const clear = cmd('notification_read_all');
  ok(run(db, bram, [clear]), clear);
  return { db, anna, bram, carla };
}
const unread = (db: DatabaseSync, u: UserRow) => mine(db, u).filter((x) => !x.is_read);

test('toevoegen aan een project: de nieuwe persoon krijgt één melding (ook met subprojecten), de eigenaar niets', () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const bram = addUser(db, 'bram', 'Bram');
  const cs = [cmd('project_add', { id: P, name: 'Gezin' }), cmd('project_add', { id: 'project-gezin-sub', name: 'Vakantie', parent_id: P }), cmd('project_share', { project_id: P, username: 'bram' })];
  ok(run(db, anna, cs), ...cs);
  assert.deepEqual(brief(db, bram), [`shared:${anna.id}:${P}`]);
  assert.deepEqual(mine(db, anna), []);
  const again = cmd('project_share', { project_id: P, username: 'bram' });
  ok(run(db, anna, [again]), again);
  assert.equal(mine(db, bram).length, 1, 'al lid: geen tweede melding');
  const n0 = mine(db, bram)[0];
  assert.deepEqual(Object.keys(n0).sort(), ['actor_id', 'comment_id', 'created_at', 'id', 'is_deleted', 'is_read', 'kind', 'owner_id', 'project_id', 'task_id', 'updated_at']);
  assert.equal(n0.owner_id, bram.id);
  assert.equal(n0.is_read, false);
});

test('toewijzen: bij toevoegen en wijzigen een melding voor de toegewezene; jezelf toewijzen of opnieuw hetzelfde niet', () => {
  const { db, anna, bram } = world();
  const a = cmd('task_add', { id: T2, project_id: P, content: 'Ramen lappen', assignee_id: bram.id });
  ok(run(db, anna, [a]), a);
  assert.deepEqual(brief(db, bram).filter((x) => x.startsWith('assigned')), [`assigned:${anna.id}:${T2}`]);
  const same = cmd('task_update', { id: T2, assignee_id: bram.id, content: 'Ramen lappen!' });
  const self = cmd('task_update', { id: T, assignee_id: anna.id });
  ok(run(db, anna, [same, self]), same, self);
  assert.equal(unread(db, bram).length, 1, 'zelfde toegewezene: geen nieuwe melding');
  assert.deepEqual(mine(db, anna), [], 'jezelf toewijzen geeft geen melding');
  const byBram = cmd('task_update', { id: T, assignee_id: bram.id });
  ok(run(db, bram, [byBram]), byBram);
  assert.equal(unread(db, bram).length, 1, 'jezelf (Bram) toewijzen: niets');
  const toAnna = cmd('task_update', { id: T, assignee_id: anna.id });
  ok(run(db, bram, [toAnna]), toAnna);
  assert.deepEqual(brief(db, anna), [`assigned:${bram.id}:${T}`]);
});

test('opmerking bij een taak: de toegewezene, de maker en eerdere schrijvers; niet de schrijver zelf, niet wie geen lid is', () => {
  const { db, anna, bram, carla } = world();
  const share = cmd('project_share', { project_id: P, username: 'carla' });
  ok(run(db, anna, [share]), share);
  const cr = cmd('notification_read_all');
  ok(run(db, carla, [cr]), cr);
  // Carla schrijft als eerste (Anna is maker), daarna Bram
  const c1 = cmd('comment_add', { id: 'comment-0000001', task_id: T, content: 'Ik doe de melk' });
  ok(run(db, carla, [c1]), c1);
  assert.deepEqual(brief(db, anna), [`comment:${carla.id}:${T}:comment-0000001`], 'de maker hoort het');
  assert.deepEqual(unread(db, bram), [], 'Bram heeft er niets mee te maken');
  const c2 = cmd('comment_add', { id: 'comment-0000002', task_id: T, content: 'En ik het brood' });
  ok(run(db, bram, [c2]), c2);
  assert.deepEqual(unread(db, carla).map((x) => [x.kind, x.comment_id]), [['comment', 'comment-0000002']], 'wie eerder reageerde hoort het');
  assert.equal(unread(db, anna).length, 2);
  assert.deepEqual(unread(db, bram), [], 'de schrijver zelf niet');
  // de toegewezene hoort het ook als die nooit reageerde
  const as = cmd('task_update', { id: T, assignee_id: bram.id });
  const rb = cmd('notification_read_all');
  ok(run(db, anna, [as]), as);
  ok(run(db, bram, [rb]), rb);
  const c3 = cmd('comment_add', { id: 'comment-0000003', task_id: T, content: 'Gedaan?' });
  ok(run(db, carla, [c3]), c3);
  assert.deepEqual(unread(db, bram).map((x) => x.kind), ['comment']);
  // Carla gaat weg: een nieuwe opmerking geeft haar niets meer, en haar oude meldingen over dit project verdwijnen
  const leave = cmd('project_leave', { project_id: P });
  ok(run(db, carla, [leave]), leave);
  const c4 = cmd('comment_add', { id: 'comment-0000004', task_id: T, content: 'Nog één' });
  ok(run(db, anna, [c4]), c4);
  assert.deepEqual(mine(db, carla), []);
});

test('opmerking bij een project: alle leden behalve de schrijver', () => {
  const { db, anna, bram, carla } = world();
  const c = cmd('comment_add', { id: 'comment-proj-001', project_id: P, content: 'Wie komt er zaterdag?' });
  ok(run(db, anna, [c]), c);
  assert.deepEqual(brief(db, bram).filter((x) => x.startsWith('comment')), [`comment:${anna.id}:${P}:comment-proj-001`]);
  assert.deepEqual(mine(db, anna), []);
  assert.deepEqual(mine(db, carla), [], 'geen lid');
});

test('vermelden: gaat voor "opmerking", alleen leden worden bewaard, hooguit 20, bij bewerken alleen de nieuwe', () => {
  const { db, anna, bram, carla } = world();
  const c = cmd('comment_add', { id: 'comment-ment-001', task_id: T, content: '@Bram en @Carla, kijken jullie?', mentions: [bram.id, carla.id] });
  ok(run(db, anna, [c]), c);
  const stored = (run(db, anna, []).comments as Row[]).find((x) => x.id === 'comment-ment-001')!;
  assert.deepEqual(stored.mentions, [bram.id], 'Carla is geen lid en wordt stilzwijgend weggelaten');
  assert.deepEqual(unread(db, bram).map((x) => x.kind), ['mention']);
  assert.deepEqual(mine(db, carla), []);
  // Bram reageert en noemt Anna; Anna (maker en vermeld) krijgt één melding: "vermeld"
  const c2 = cmd('comment_add', { id: 'comment-ment-002', task_id: T, content: '@Anna ja', mentions: [anna.id] });
  ok(run(db, bram, [c2]), c2);
  assert.deepEqual(unread(db, anna).map((x) => [x.kind, x.comment_id]), [['mention', 'comment-ment-002']]);
  // jezelf vermelden geeft niets
  const c3 = cmd('comment_add', { id: 'comment-ment-003', project_id: P, content: '@Anna notitie', mentions: [anna.id] });
  ok(run(db, anna, [c3]), c3);
  assert.equal(unread(db, anna).length, 1);
  // bewerken: Carla wordt lid; een bewerking die Carla toevoegt geeft alleen haar een melding, Bram niet opnieuw
  const share = cmd('project_share', { project_id: P, username: 'carla' });
  ok(run(db, anna, [share]), share);
  const rb = cmd('notification_read_all'); const rc = cmd('notification_read_all');
  ok(run(db, bram, [rb]), rb);
  ok(run(db, carla, [rc]), rc);
  const edit = cmd('comment_update', { id: 'comment-ment-001', content: '@Bram en @Carla, kijken jullie nu?', mentions: [bram.id, carla.id] });
  ok(run(db, anna, [edit]), edit);
  assert.deepEqual(unread(db, carla).map((x) => [x.kind, x.comment_id]), [['mention', 'comment-ment-001']]);
  assert.deepEqual(unread(db, bram), []);
  const plain = cmd('comment_update', { id: 'comment-ment-001', content: 'zonder vermelding nu' });
  ok(run(db, anna, [plain]), plain);
  assert.deepEqual((run(db, anna, []).comments as Row[]).find((x) => x.id === 'comment-ment-001')!.mentions, [bram.id, carla.id], 'alleen de tekst wijzigen laat de vermeldingen staan');
  // ongeldige lijsten
  for (const [mentions, why] of [[Array.from({ length: 21 }, (_, i) => `user-xxxxxx-${String(i).padStart(2, '0')}`), 'meer dan 20'], [[bram.id, bram.id], 'dubbel'], [['kort'], 'ongeldig id'], ['bram', 'geen lijst']] as const) {
    const bad = cmd('comment_add', { id: `comment-bad-${String(++n).padStart(4, '0')}`, task_id: T, content: 'x', mentions });
    err(run(db, anna, [bad]), bad, 'INVALID_ARG');
    assert.ok(why);
  }
  // twintig onbekende maar geldige id's: geaccepteerd, maar niemand bewaard
  const twenty = cmd('comment_add', { id: 'comment-ment-020', task_id: T, content: 'veel', mentions: Array.from({ length: 20 }, (_, i) => `user-onbekend-${String(i).padStart(2, '0')}`) });
  ok(run(db, anna, [twenty]), twenty);
  assert.deepEqual((run(db, anna, []).comments as Row[]).find((x) => x.id === 'comment-ment-020')!.mentions, []);
});

test('afvinken: de toegewezene hoort het (ook bij een terugkerende taak), wie zelf afvinkt niet, opnieuw afvinken ook niet', () => {
  const { db, anna, bram } = world();
  const t = cmd('task_add', { id: T2, project_id: P, content: 'Vuilnis', assignee_id: bram.id, due: { date: '2030-01-07', recurrence: { freq: 'weekly' } } });
  const done = cmd('task_complete', { id: T2 });
  ok(run(db, anna, [t, done]), t, done);
  assert.deepEqual(unread(db, bram).map((x) => x.kind).sort(), ['assigned', 'completed']);
  const a = cmd('task_update', { id: T, assignee_id: bram.id });
  const c1 = cmd('task_complete', { id: T });
  const c2 = cmd('task_complete', { id: T });
  ok(run(db, anna, [a, c1, c2]), a, c1, c2);
  assert.equal(unread(db, bram).filter((x) => x.kind === 'completed').length, 2, 'een al afgevinkte taak nog eens afvinken: niets');
  const own = cmd('task_add', { id: 'task-gezin-00003', project_id: P, content: 'Zelf', assignee_id: bram.id });
  ok(run(db, anna, [own]), own);
  const ownDone = cmd('task_complete', { id: 'task-gezin-00003' });
  ok(run(db, bram, [ownDone]), ownDone);
  assert.equal(unread(db, bram).filter((x) => x.kind === 'completed').length, 2, 'zelf afvinken: geen melding');
});

test('een geblokkeerd account krijgt geen meldingen', () => {
  const { db, anna, bram } = world();
  updateUser(db, bram.id, { is_disabled: true });
  const a = cmd('task_update', { id: T, assignee_id: bram.id });
  ok(run(db, anna, [a]), a);
  updateUser(db, bram.id, { is_disabled: false });
  assert.deepEqual(unread(db, bram), []);
});

test('alleen de ontvanger ziet een melding en wijzigt alleen is_read; aanmaken of verwijderen kan niemand', () => {
  const { db, anna, bram, carla } = world();
  const a = cmd('task_update', { id: T, assignee_id: bram.id });
  ok(run(db, anna, [a]), a);
  const id = unread(db, bram)[0].id;
  for (const who of [anna, carla]) {
    const peek = cmd('notification_update', { id, is_read: true });
    err(run(db, who, [peek]), peek, 'NOT_FOUND');
    assert.ok(!(run(db, who, []).notifications as Row[]).some((x) => x.id === id));
  }
  const readonly = ['kind', 'actor_id', 'task_id', 'project_id', 'comment_id', 'owner_id'];
  for (const field of readonly) {
    const c = cmd('notification_update', { id, [field]: field === 'kind' ? 'shared' : anna.id });
    err(run(db, bram, [c]), c, 'READONLY');
  }
  const unknown = cmd('notification_update', { id, kleur: 'rood' });
  err(run(db, bram, [unknown]), unknown, 'UNKNOWN_ARG');
  const notBool = cmd('notification_update', { id, is_read: 'ja' });
  err(run(db, bram, [notBool]), notBool, 'INVALID_ARG');
  for (const type of ['notification_add', 'notification_delete']) {
    const c = cmd(type, { id: type === 'notification_add' ? 'notif-zelfgemaakt' : id, kind: 'assigned' });
    err(run(db, bram, [c]), c, 'UNKNOWN_COMMAND');
  }
  const before = currentRev(db);
  const read = cmd('notification_update', { id, is_read: true });
  const res = run(db, bram, [read], String(before));
  ok(res, read);
  assert.deepEqual((res.notifications as Row[]).map((x) => [x.id, x.is_read]), [[id, true]], 'de delta bevat de gelezen melding');
  assert.deepEqual([...audienceSince(db, before, bram.id)].sort(), [bram.id].sort(), 'alleen Bram krijgt het signaal');
  const back = cmd('notification_update', { id, is_read: false });
  ok(run(db, bram, [back]), back);
  assert.equal(unread(db, bram).length, 1, 'terugzetten naar ongelezen kan');
});

test('alles gelezen: alleen eigen meldingen, en met up_to alleen wat de afzender al zag', () => {
  const { db, anna, bram } = world();
  const a = cmd('task_update', { id: T, assignee_id: bram.id });
  ok(run(db, anna, [a]), a);
  const seen = unread(db, bram)[0];
  const ra = cmd('comment_add', { id: 'comment-later-01', project_id: P, content: 'Later' });
  ok(run(db, anna, [ra]), ra);
  // de opmerking krijgt hetzelfde of een later tijdstip; maak het verschil zeker
  db.prepare('UPDATE notifications SET created_at = ? WHERE comment_id = ?').run('2999-01-01T00:00:00.000Z', 'comment-later-01');
  const upTo = cmd('notification_read_all', { up_to: seen.created_at });
  ok(run(db, bram, [upTo]), upTo);
  assert.deepEqual(unread(db, bram).map((x) => x.comment_id), ['comment-later-01'], 'wat na up_to binnenkwam blijft ongelezen');
  for (const bad of [{ up_to: 'gisteren' }, { up_to: 5 }, { iets: 1 }]) {
    const c = cmd('notification_read_all', bad);
    err(run(db, bram, [c]), c, Object.hasOwn(bad, 'iets') ? 'UNKNOWN_ARG' : 'INVALID_ARG');
  }
  const all = cmd('notification_read_all');
  ok(run(db, bram, [all]), all);
  assert.deepEqual(unread(db, bram), []);
  const fresh = cmd('task_add', { id: T2, project_id: P, content: 'Nieuw voor Bram', assignee_id: bram.id });
  ok(run(db, anna, [fresh]), fresh);
  const other = cmd('notification_read_all');
  ok(run(db, anna, [other]), other);
  assert.equal(unread(db, bram).length, 1, 'alles gelezen van Anna laat de meldingen van Bram met rust');
});

test('wat verdwijnt neemt de melding mee: taak, opmerking, project, lidmaatschap; een verhuisde taak verbergt haar meldingen', () => {
  const { db, anna, bram } = world();
  const t2 = cmd('task_add', { id: T2, project_id: P, content: 'Weg', assignee_id: bram.id });
  const c = cmd('comment_add', { id: 'comment-weg-0001', task_id: T, content: 'Hoi @Bram', mentions: [bram.id] });
  const pc = cmd('comment_add', { id: 'comment-weg-0002', project_id: P, content: 'Project' });
  ok(run(db, anna, [t2, c, pc]), t2, c, pc);
  const token = run(db, bram, []).sync_token;
  assert.equal(unread(db, bram).length, 3);
  const delTask = cmd('task_delete', { id: T2 });
  const delComment = cmd('comment_delete', { id: 'comment-weg-0001' });
  ok(run(db, anna, [delTask, delComment]), delTask, delComment);
  const delta = run(db, bram, [], token);
  assert.equal((delta.notifications as Row[]).filter((x) => x.is_deleted).length, 2, 'twee meldingen komen als verwijderd mee');
  assert.ok((delta.notifications as Row[]).every((x) => !x.is_deleted || Object.keys(x).join() === 'id,is_deleted'), 'zonder inhoud');
  assert.deepEqual(unread(db, bram).map((x) => x.comment_id), ['comment-weg-0002']);
  // een taak die naar Anna's Inbox verhuist: Bram ziet de taak en de melding niet meer; terug in het project: wel weer
  const a = cmd('task_update', { id: T, assignee_id: bram.id });
  ok(run(db, anna, [a]), a);
  const t1 = run(db, bram, []).sync_token;
  const away = cmd('task_move', { id: T, project_id: anna.inbox_project_id });
  ok(run(db, anna, [away]), away);
  assert.ok(!mine(db, bram).some((x) => x.task_id === T), 'na verhuizen niet meer te zien');
  const hidden = (db.prepare('SELECT id FROM notifications WHERE owner_id = ? AND task_id = ? AND is_deleted = 0').get(bram.id, T) as Row).id;
  const touch = cmd('notification_update', { id: hidden, is_read: true });
  err(run(db, bram, [touch]), touch, 'NOT_FOUND');
  const t2tok = run(db, bram, [], t1).sync_token;
  const back = cmd('task_move', { id: T, project_id: P });
  ok(run(db, anna, [back]), back);
  const again = run(db, bram, [], t2tok);
  assert.ok((again.notifications as Row[]).some((x) => x.task_id === T && !x.is_deleted), 'terug in het project: de melding komt met de taak mee terug, zoals haar opmerkingen');
  assert.ok(mine(db, bram).some((x) => x.task_id === T), 'en staat ook in een volledige sync');
  // het project weg: alle meldingen weg
  const delP = cmd('project_delete', { id: P });
  ok(run(db, anna, [delP]), delP);
  assert.deepEqual(mine(db, bram), []);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE owner_id = ? AND is_deleted = 0').get(bram.id) as Row).n, 0, 'ook in de database als verwijderd gemarkeerd');
});

test('een verhuisde taak met haar meldingen komt terug bij wie het nieuwe project ziet (ook als de meldingen ouder zijn dan het token)', () => {
  const { db, anna, bram } = world();
  const Q = 'project-tweede-01';
  const cs = [cmd('project_add', { id: Q, name: 'Tweede' }), cmd('project_share', { project_id: Q, username: 'bram' }), cmd('task_add', { id: T2, project_id: Q, content: 'Met melding' })];
  ok(run(db, anna, cs), ...cs);
  const rb = cmd('notification_read_all');
  ok(run(db, bram, [rb]), rb);
  const c = cmd('comment_add', { id: 'comment-mee-0001', task_id: T2, content: '@Bram', mentions: [bram.id] });
  ok(run(db, anna, [c]), c);
  // Bram verlaat Q niet, maar de taak gaat eerst naar Anna's Inbox en dan naar P, waar Bram ook lid is
  const away = cmd('task_move', { id: T2, project_id: anna.inbox_project_id });
  ok(run(db, anna, [away]), away);
  const token = run(db, bram, []).sync_token;
  const toP = cmd('task_move', { id: T2, project_id: P });
  ok(run(db, anna, [toP]), toP);
  const delta = run(db, bram, [], token);
  assert.deepEqual((delta.notifications as Row[]).filter((x) => !x.is_deleted).map((x) => x.comment_id), ['comment-mee-0001']);
});

test('opnieuw lid worden: de meldingen van vroeger komen niet terug', () => {
  const { db, anna, bram } = world();
  const a = cmd('task_update', { id: T, assignee_id: bram.id });
  ok(run(db, anna, [a]), a);
  const out = cmd('project_unshare', { project_id: P, user_id: bram.id });
  ok(run(db, anna, [out]), out);
  assert.deepEqual(mine(db, bram), []);
  const back = cmd('project_share', { project_id: P, username: 'bram' });
  ok(run(db, anna, [back]), back);
  assert.deepEqual(mine(db, bram).map((x) => x.kind), ['shared'], 'alleen de nieuwe melding dat hij weer is toegevoegd');
});

test('grens: hooguit 500 per gebruiker; de oudste vallen eraf (als verwijderde rij in de delta)', () => {
  const { db, anna, bram } = world();
  const t2 = cmd('task_add', { id: T2, project_id: P, content: 'Voor Bram', assignee_id: bram.id });
  ok(run(db, anna, [t2]), t2);
  const token = run(db, bram, []).sync_token;
  const first = mine(db, bram).map((x) => x.id);
  assert.equal(first.length, 2);
  for (let round = 0; round < 6; round++) {
    // om en om bij het project en bij een taak van Bram: elk hooguit 500 opmerkingen (LIMITS.commentsPerParent)
    const cs = Array.from({ length: 100 }, (_, i) => cmd('comment_add', { id: `comment-veel-${String(round * 100 + i).padStart(4, '0')}`, ...(i % 2 ? { task_id: T2 } : { project_id: P }), content: `nr ${round * 100 + i}` }));
    ok(run(db, anna, cs), ...cs);
  }
  const live = mine(db, bram);
  assert.equal(live.length, MAX_NOTIFICATIONS_PER_USER);
  assert.ok(!live.some((x) => x.id === first[0]), 'de oudste is weg');
  const delta = run(db, bram, [], token);
  assert.ok((delta.notifications as Row[]).some((x) => x.id === first[0] && x.is_deleted));
});

test('opruimen na 60 dagen, en grafstenen na nog eens 30 dagen helemaal weg', () => {
  const { db, anna, bram } = world();
  const a = cmd('task_update', { id: T, assignee_id: bram.id });
  ok(run(db, anna, [a]), a);
  const token = run(db, bram, []).sync_token;
  assert.equal(pruneNotifications(db, Date.now() + 59 * 86_400_000), 0);
  assert.equal(pruneNotifications(db, Date.now() + 61 * 86_400_000), 2, 'de melding van het delen en van het toewijzen');
  assert.deepEqual(mine(db, bram), []);
  assert.equal((run(db, bram, [], token).notifications as Row[]).filter((x) => x.is_deleted).length, 2);
  pruneNotifications(db, Date.now() + (61 + 29) * 86_400_000);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as Row).n, 2, 'nog als grafsteen');
  pruneNotifications(db, Date.now() + (61 + 31) * 86_400_000);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as Row).n, 0);
});

test('het live-signaal: wie een melding krijgt hoort dat er iets is, ook zonder dat de taak zelf voor hem veranderde', () => {
  const { db, anna, bram, carla } = world();
  const before = currentRev(db);
  const c = cmd('comment_add', { id: 'comment-sein-001', project_id: P, content: 'x' });
  ok(run(db, anna, [c]), c);
  const audience = audienceSince(db, before, anna.id);
  assert.ok(audience.has(bram.id));
  assert.ok(!audience.has(carla.id));
});

test('oudere clients: zonder "notifications" in resource_types een gedeeltelijk antwoord; een opmerking zonder vermeldingen werkt', () => {
  const { db, anna, bram } = world();
  const old = run(db, bram, [], '*', ['tasks', 'projects', 'sections', 'labels', 'comments', 'reminders', 'filters', 'places', 'settings', 'members', 'templates', 'attachments']);
  assert.equal(old.partial, true);
  assert.equal(old.notifications, undefined);
  const c = cmd('comment_add', { id: 'comment-oud-0001', task_id: T, content: 'zonder vermeldingen' });
  ok(run(db, anna, [c]), c);
  assert.deepEqual((run(db, anna, []).comments as Row[]).find((x) => x.id === 'comment-oud-0001')!.mentions, []);
});

test('instellingen: welke soorten als push komen (notify_push), alleen bekende soorten en true/false', () => {
  const { db, bram } = world();
  const sid = `settings-${bram.id}`;
  const good = cmd('settings_update', { id: sid, notify_push: { completed: true, comment: false } });
  ok(run(db, bram, [good]), good);
  assert.deepEqual((run(db, bram, []).settings as Row[])[0].notify_push, { completed: true, comment: false });
  for (const bad of [{ onbekend: true }, { completed: 'ja' }, [true], 'alles']) {
    const c = cmd('settings_update', { id: sid, notify_push: bad });
    err(run(db, bram, [c]), c, 'INVALID_ARG');
  }
  const reset = cmd('settings_update', { id: sid, notify_push: null });
  ok(run(db, bram, [reset]), reset);
});

test('migratie: een database van vóór de meldingen krijgt de tabel, de kolommen en een lege lijst vermeldingen', () => {
  const db = freshDb();
  const anna = addUser(db, 'anna', 'Anna');
  const c = cmd('comment_add', { id: 'comment-voor-001', project_id: anna.inbox_project_id, content: 'Van vroeger' });
  ok(run(db, anna, [c]), c);
  db.exec('DROP TABLE notifications; DROP TABLE notification_outbox; ALTER TABLE comments DROP COLUMN mentions; ALTER TABLE user_settings DROP COLUMN notify_push');
  db.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
  createSchema(db);
  createSchema(db);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row).value, String(SCHEMA_VERSION));
  assert.equal(SCHEMA_VERSION, 6);
  const res = run(db, anna, []);
  assert.deepEqual((res.comments as Row[]).map((x) => [x.content, x.mentions]), [['Van vroeger', []]]);
  assert.equal((res.settings as Row[])[0].notify_push, null);
  assert.deepEqual(res.notifications, []);
});

// ---------- toegangsfuzz: willekeurige handelingen van drie mensen, daarna de regels nagaan ----------

/** Een voorspelbare toevalsgenerator (mulberry32), zodat een mislukte ronde te herhalen is. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('toegangsfuzz: nooit een melding voor je eigen handeling, alleen over wat je ziet, en de delta komt op dezelfde stand als een volledige sync', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const random = rng(seed);
    const pick = <X>(xs: X[]): X => xs[Math.floor(random() * xs.length)];
    const db = freshDb();
    const people = [addUser(db, 'anna', 'Anna'), addUser(db, 'bram', 'Bram'), addUser(db, 'carla', 'Carla')];
    const projects = ['fuzz-proj-0001', 'fuzz-proj-0002'];
    const owner = new Map([[projects[0], people[0]], [projects[1], people[1]]]);
    for (const p of projects) ok(run(db, owner.get(p)!, [cmd('project_add', { id: p, name: p })]));
    const tasks: string[] = [];
    const comments: string[] = [];
    // ieder houdt een eigen kopie bij uit delta's, zoals een client
    const local = new Map(people.map((u) => [u.id, { token: '*', rows: new Map<string, Row>() }]));
    const absorb = (u: UserRow) => {
      const l = local.get(u.id)!;
      const res = run(db, u, [], l.token);
      if (res.full_sync) l.rows.clear();
      for (const r of res.notifications as Row[]) {
        if (r.is_deleted) l.rows.delete(r.id);
        else l.rows.set(r.id, r);
      }
      // zoals de client: wat bij een verdwenen taak of project hoort, ruimt hij zelf op (store.dropOrphans)
      const full = run(db, u, []);
      const seenTasks = new Set((full.tasks as Row[]).map((t) => t.id));
      const seenProjects = new Set((full.projects as Row[]).map((p) => p.id));
      for (const [id, r] of l.rows) if (r.task_id ? !seenTasks.has(r.task_id) : !seenProjects.has(r.project_id)) l.rows.delete(id);
      l.token = res.sync_token;
    };
    for (let step = 0; step < 120; step++) {
      const actor = pick(people);
      const project = pick(projects);
      const other = pick(people);
      const roll = random();
      let c: Command;
      if (roll < 0.12) c = cmd('project_share', { project_id: project, username: other.username });
      else if (roll < 0.18) c = cmd('project_unshare', { project_id: project, user_id: other.id });
      else if (roll < 0.22) c = cmd('project_leave', { project_id: project });
      else if (roll < 0.36) { const id = `fuzz-task-${String(step).padStart(4, '0')}`; tasks.push(id); c = cmd('task_add', { id, project_id: project, content: `taak ${step}`, ...(random() < 0.5 ? { assignee_id: other.id } : {}) }); }
      else if (roll < 0.48 && tasks.length) c = cmd('task_update', { id: pick(tasks), assignee_id: other.id });
      else if (roll < 0.56 && tasks.length) c = cmd('task_complete', { id: pick(tasks) });
      else if (roll < 0.60 && tasks.length) c = cmd('task_move', { id: pick(tasks), project_id: project });
      else if (roll < 0.64 && tasks.length) c = cmd('task_delete', { id: pick(tasks) });
      else if (roll < 0.80) { const id = `fuzz-comm-${String(step).padStart(4, '0')}`; comments.push(id); c = cmd('comment_add', { id, ...(random() < 0.6 && tasks.length ? { task_id: pick(tasks) } : { project_id: project }), content: 'x', mentions: [...new Set([pick(people).id, pick(people).id])] }); }
      else if (roll < 0.86 && comments.length) c = cmd('comment_update', { id: pick(comments), content: 'y', mentions: [pick(people).id] });
      else if (roll < 0.90 && comments.length) c = cmd('comment_delete', { id: pick(comments) });
      else if (roll < 0.95) c = cmd('notification_read_all');
      else c = cmd('task_uncomplete', { id: tasks.length ? pick(tasks) : 'fuzz-task-geen' });
      const before = new Map(people.map((u) => [u.id, new Set((db.prepare('SELECT id FROM notifications WHERE owner_id = ?').all(u.id) as Row[]).map((r) => r.id as string))]));
      run(db, actor, [c]);
      // regel 1: nooit een nieuwe melding voor jezelf, en elke nieuwe melding noemt de handelende persoon
      const fresh = db.prepare('SELECT * FROM notifications WHERE id NOT IN (SELECT value FROM json_each(?))').all(JSON.stringify(people.flatMap((u) => [...before.get(u.id)!]))) as Row[];
      for (const f of fresh) {
        assert.notEqual(f.owner_id, actor.id, `seed ${seed} stap ${step}: ${c.type} gaf een melding voor de handelende persoon zelf`);
        assert.equal(f.actor_id, actor.id, `seed ${seed} stap ${step}: de melding noemt iemand anders`);
      }
      if (random() < 0.3) absorb(pick(people));
    }
    for (const u of people) {
      const full = run(db, u, []);
      const seenTasks = new Set((full.tasks as Row[]).map((t) => t.id));
      const seenProjects = new Set((full.projects as Row[]).map((p) => p.id));
      const seenComments = new Set((full.comments as Row[]).map((x) => x.id));
      for (const x of full.notifications as Row[]) {
        // regel 2: alleen eigen meldingen, over iets dat je nu ziet
        assert.equal(x.owner_id, u.id, `seed ${seed}: melding van een ander zichtbaar`);
        assert.notEqual(x.actor_id, u.id);
        assert.ok(x.task_id ? seenTasks.has(x.task_id) : seenProjects.has(x.project_id), `seed ${seed}: melding over iets wat ${u.username} niet ziet`);
        if (x.comment_id) assert.ok(seenComments.has(x.comment_id), `seed ${seed}: melding over een opmerking die er niet (meer) is`);
        assert.ok((x.task_id === null) !== (x.project_id === null), 'precies één van taak en project');
      }
      // regel 3: een client die alleen delta's ophaalt, komt op dezelfde meldingen uit
      absorb(u);
      assert.deepEqual([...local.get(u.id)!.rows.keys()].sort(), (full.notifications as Row[]).map((x) => x.id).sort(), `seed ${seed}: delta en volledige sync verschillen voor ${u.username}`);
    }
  }
});
