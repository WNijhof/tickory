// De meldingen van de desktop-app naast de herinneringen bij taken: bijhouden wat er veranderde (delta's), meldingen bij samenwerken,
// herinneringen op notities, het ochtendoverzicht en de avondreview, de testmelding en de adressen tickory://open?….
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FULL_EVERY_MS, RESOURCES, mergeSync, needsFull } from '../lib/syncCache.mjs';
import { MAX_AGE_MS, MAX_AT_ONCE, activityText, decideInbox, inboxSnapshot, inboxStateOf, oneLine } from '../lib/inboxPlan.mjs';
import { LATE_MS, overviewText, planNoteReminders, planOverviews } from '../lib/reminderPlan.mjs';
import { infoToastXml, noteToastXml, openUrl, parseActionUrl } from '../lib/toast.mjs';
import { settingsOf } from '../lib/settings.mjs';
import { translator } from '../lib/i18n.mjs';

const ME = 'user-anna-0001';
const BOB = 'user-bob-00001';
const nl = translator('nl');
const en = translator('en');

const full = (extra = {}) => ({
  sync_token: 'e-10', full_sync: true, me: { id: ME, name: 'Anna' }, users: [{ id: BOB, name: 'Bob' }],
  settings: [{ id: 'settings-anna', owner_id: ME, timezone: 'Europe/Amsterdam', general: { morning_overview: '08:00', evening_review: '18:00' } }],
  projects: [{ id: 'proj-inbox-01', name: 'Inbox' }, { id: 'proj-werk-001', name: 'Werk' }],
  tasks: [
    { id: 'taak-0001-aaaa', project_id: 'proj-werk-001', content: 'Offerte sturen', due: { date: '2026-11-20' } },
    { id: 'taak-0002-aaaa', project_id: 'proj-inbox-01', content: 'Boodschappen', due: { date: '2026-11-19' } },
    { id: 'taak-0003-aaaa', project_id: 'proj-werk-001', content: 'Af', due: { date: '2026-11-20' }, checked: true },
  ],
  reminders: [{ id: 'herinnering-01', owner_id: ME, task_id: 'taak-0001-aaaa', type: 'absolute', due: { date: '2026-11-20T10:00' } }],
  comments: [{ id: 'opmerking-0001', task_id: 'taak-0001-aaaa', project_id: null, content: 'Kun je  dit\nvandaag doen?' }],
  notes: [{ id: 'notitie-00001', owner_id: ME, title: 'Boekenlijst', content: '', remind_at: '2026-11-20T12:00', remind_repeat: null }],
  notifications: [],
  ...extra,
});

test('bijhouden: eerst alles, daarna alleen wat er veranderde (ook verwijderd, en een project waar je niet meer bij kunt)', () => {
  assert.ok(RESOURCES.includes('notifications') && RESOURCES.includes('notes'));
  const a = mergeSync(null, full());
  assert.equal(a.sync_token, 'e-10');
  assert.equal(a.tasks.length, 3);
  // een delta: een taak gewijzigd, een herinnering weg, een notitie erbij
  const b = mergeSync(a, {
    sync_token: 'e-11', full_sync: false, me: { id: ME },
    tasks: [{ id: 'taak-0002-aaaa', project_id: 'proj-inbox-01', content: 'Boodschappen doen', due: { date: '2026-11-19' } }],
    reminders: [{ id: 'herinnering-01', is_deleted: true }],
    notes: [{ id: 'notitie-00002', owner_id: ME, title: 'Nieuw' }],
  });
  assert.equal(b.sync_token, 'e-11');
  assert.equal(b.tasks.find((x) => x.id === 'taak-0002-aaaa').content, 'Boodschappen doen');
  assert.deepEqual(b.reminders, []);
  assert.deepEqual(b.notes.map((n) => n.id), ['notitie-00001', 'notitie-00002']);
  assert.deepEqual(b.users, a.users, 'geen lijst in het antwoord: de oude blijft');
  // niet meer in het project Werk: de taken, opmerkingen en herinneringen daarin gaan mee
  const c = mergeSync(a, { sync_token: 'e-12', full_sync: false, projects: [{ id: 'proj-werk-001', is_deleted: true }] });
  assert.deepEqual(c.tasks.map((x) => x.id), ['taak-0002-aaaa']);
  assert.deepEqual(c.reminders, []);
  assert.deepEqual(c.comments, []);
  // de server zegt dat alles opnieuw moet: dan telt alleen het nieuwe antwoord
  assert.deepEqual(mergeSync(a, { ...full({ tasks: [] }), sync_token: 'e-20' }).tasks, []);
  // een delta zonder eerdere stand is niet compleet; een kapot antwoord laat de stand staan
  assert.equal(mergeSync(null, { sync_token: 'e-1', full_sync: false, tasks: [] }), null);
  assert.equal(mergeSync(a, null), a);
  assert.equal(needsFull(null, 0, 1), true);
  assert.equal(needsFull(a, 1000, 2000), false);
  assert.equal(needsFull(a, 1000, 1000 + FULL_EVERY_MS), true);
  assert.equal(needsFull(a, 1000, 2000, true), true);
});

const note = (id, kind, extra = {}) => ({ id, owner_id: ME, kind, actor_id: BOB, is_read: false, created_at: '2026-11-20T09:00:00Z', ...extra });

test('samenwerken: de eerste keer niets (geen stapel oude meldingen), daarna elke nieuwe ongelezen één keer', () => {
  const now = Date.parse('2026-11-20T09:05:00Z');
  const before = inboxSnapshot(mergeSync(null, full({ notifications: [note('melding-00001', 'assigned', { task_id: 'taak-0001-aaaa' })] })));
  const first = decideInbox(null, before, now, false);
  assert.deepEqual(first.show, []);
  assert.deepEqual(first.next.known, ['melding-00001']);

  const after = inboxSnapshot(mergeSync(null, full({
    notifications: [
      note('melding-00001', 'assigned', { task_id: 'taak-0001-aaaa' }),
      note('melding-00002', 'comment', { task_id: 'taak-0001-aaaa', comment_id: 'opmerking-0001' }),
      note('melding-00003', 'completed', { task_id: 'taak-0001-aaaa' }), // standaard geen melding (zoals in de browser)
      note('melding-00004', 'mention', { task_id: 'taak-0001-aaaa', is_read: true }), // al gelezen
      note('melding-00005', 'assigned', { task_id: 'taak-9999-zzzz' }), // de taak zie je niet (meer)
      note('melding-00006', 'shared', { project_id: 'proj-werk-001' }),
    ],
  })));
  const second = decideInbox(first.next, after, now, false);
  assert.deepEqual(second.show.map((x) => x.id), ['melding-00002', 'melding-00006']);
  assert.deepEqual(second.next.shown, ['melding-00002', 'melding-00006']);
  const text = activityText(second.show[0], nl);
  assert.equal(text.title, 'Bob reageerde op een taak');
  assert.deepEqual(text.lines, ['Offerte sturen · Werk', 'Kun je dit vandaag doen?']);
  assert.equal(activityText(second.show[1], en).title, 'Bob added you to a project');
  assert.deepEqual(activityText(second.show[1], en).lines, ['Werk']);
  // nog een keer: niets nieuws
  assert.deepEqual(decideInbox(second.next, after, now, false).show, []);
  // elders gelezen: weg uit beeld
  const read = inboxSnapshot(mergeSync(null, full({ notifications: [note('melding-00002', 'comment', { task_id: 'taak-0001-aaaa', comment_id: 'opmerking-0001', is_read: true }), note('melding-00006', 'shared', { project_id: 'proj-werk-001' })] })));
  const third = decideInbox(second.next, read, now, false);
  assert.deepEqual(third.cancel, ['melding-00002']);
  assert.deepEqual(third.next.shown, ['melding-00006']);
});

test('samenwerken: niet terwijl je in Tickory bezig bent, niet te oud, de keuze per soort, en een ander account begint opnieuw', () => {
  const now = Date.parse('2026-11-20T09:05:00Z');
  const empty = inboxSnapshot(mergeSync(null, full()));
  const state = decideInbox(null, empty, now, false).next;
  const one = inboxSnapshot(mergeSync(null, full({ notifications: [note('melding-00001', 'assigned', { task_id: 'taak-0001-aaaa' })] })));
  const visible = decideInbox(state, one, now, true);
  assert.deepEqual(visible.show, [], 'de app staat voor je: daar zie je hem al');
  assert.deepEqual(decideInbox(visible.next, one, now, false).show, [], 'en daarna ook niet alsnog');
  const old = inboxSnapshot(mergeSync(null, full({ notifications: [note('melding-00001', 'assigned', { task_id: 'taak-0001-aaaa', created_at: '2026-11-10T09:00:00Z' })] })));
  assert.deepEqual(decideInbox(state, old, now, false).show, []);
  assert.ok(MAX_AGE_MS >= 24 * 3600_000);
  // completed aangezet, assigned uit (Instellingen › Meldingen › Meldingen bij samenwerken)
  const chosen = full({
    settings: [{ id: 'settings-anna', owner_id: ME, notify_push: { assigned: false, completed: true } }],
    notifications: [note('melding-00001', 'assigned', { task_id: 'taak-0001-aaaa' }), note('melding-00002', 'completed', { task_id: 'taak-0001-aaaa' })],
  });
  assert.deepEqual(decideInbox(state, inboxSnapshot(mergeSync(null, chosen)), now, false).show.map((x) => x.id), ['melding-00002']);
  // veel tegelijk: alleen de nieuwste
  const many = full({ notifications: Array.from({ length: 15 }, (_, i) => note(`melding-${String(i).padStart(5, '0')}`, 'assigned', { task_id: 'taak-0001-aaaa', created_at: `2026-11-20T09:${String(i).padStart(2, '0')}:00Z` })) });
  assert.equal(decideInbox(state, inboxSnapshot(mergeSync(null, many)), now, false).show.length, MAX_AT_ONCE);
  // een ander account: alles bekend, niets in beeld, het oude weg
  const other = { ...decideInbox(state, one, now, false).next };
  const switched = decideInbox(other, { account: BOB, push: {}, items: [] }, now, false);
  assert.deepEqual(switched.show, []);
  assert.deepEqual(switched.cancel, ['melding-00001']);
  assert.equal(switched.next.account, BOB);
  // een gedeelde notitie, een opmerking bij een project, en iemand zonder naam
  const t = (item) => activityText(item, nl).title;
  assert.equal(t({ kind: 'shared', noteId: 'notitie-00001', actor: 'Bob' }), 'Bob heeft een notitie met je gedeeld');
  assert.equal(t({ kind: 'comment', taskId: null, actor: 'Bob' }), 'Bob schreef een opmerking bij het project');
  assert.equal(t({ kind: 'iets-nieuws', actor: '' }), 'Iemand deed iets in een gedeeld project');
  // zonder meldingen in het antwoord (een oudere server): niets
  assert.equal(inboxSnapshot({ me: { id: ME } }), null);
  assert.equal(oneLine('a\n\nb   c', 10), 'a b c');
  assert.equal(oneLine('x'.repeat(20), 10), `${'x'.repeat(9)}…`);
});

test('samenwerken: wat er bewaard wordt, komt heel terug, en iets kapots wordt niets', () => {
  const s = settingsOf({ inbox: { account: ME, known: ['melding-00001', '../x', 3], shown: ['melding-00001'] } });
  assert.deepEqual(s.inbox, { account: ME, known: ['melding-00001'], shown: ['melding-00001'] });
  assert.equal(settingsOf({}).inbox, null);
  assert.equal(inboxStateOf({ account: 'x' }), null);
});

test('herinneringen op notities: eigen notities, niet in de prullenbak, eenmalig of herhaald, in de tijdzone van je instellingen', () => {
  const now = Date.parse('2026-11-20T08:00:00Z'); // 09:00 in Amsterdam
  const data = mergeSync(null, full({
    notes: [
      { id: 'notitie-00001', owner_id: ME, title: 'Boekenlijst', remind_at: '2026-11-20T12:00', remind_repeat: null },
      { id: 'notitie-00002', owner_id: ME, title: '', content: '- [ ] **Melk** halen', remind_at: '2026-11-01T08:30', remind_repeat: 'daily' },
      { id: 'notitie-00003', owner_id: ME, title: 'Weg', remind_at: '2026-11-20T12:00', trashed_at: '2026-11-19T10:00:00Z' },
      { id: 'notitie-00004', owner_id: BOB, title: 'Van Bob', remind_at: '2026-11-20T12:00' },
      { id: 'notitie-00005', owner_id: ME, title: 'Voorbij', remind_at: '2026-11-19T12:00' },
    ],
  }));
  const plan = planNoteReminders(data, now);
  // dagelijks om 8:30: vandaag al voorbij (meer dan een kwartier), dus morgen
  assert.deepEqual(plan.map((r) => [r.noteId, r.moment, r.title]), [['notitie-00001', '2026-11-20T12:00', 'Boekenlijst'], ['notitie-00002', '2026-11-21T08:30', 'Melk halen']]);
  assert.equal(plan[0].at, Date.parse('2026-11-20T11:00:00Z'));
  assert.equal(plan[0].kind, 'note');
  assert.deepEqual(planNoteReminders(data, now, ['note:notitie-00001|2026-11-20T12:00']).map((r) => r.noteId), ['notitie-00002'], 'al getoond');
  // net gemist (de pc sliep): nog tonen binnen een kwartier
  assert.equal(planNoteReminders(data, Date.parse('2026-11-20T11:10:00Z'))[0].moment, '2026-11-20T12:00');
  assert.equal(planNoteReminders(data, Date.parse('2026-11-20T11:00:00Z') + LATE_MS + 1).some((r) => r.noteId === 'notitie-00001'), false);
});

test('ochtendoverzicht en avondreview: elke dag op je tijd, hoeveel taken er (nog) zijn, zonder namen', () => {
  const data = mergeSync(null, full());
  const plan = planOverviews(data, Date.parse('2026-11-20T06:00:00Z')); // 07:00 in Amsterdam
  assert.deepEqual(plan.map((r) => [r.overview, r.moment]), [['morning', '2026-11-20T08:00'], ['evening', '2026-11-20T18:00'], ['morning', '2026-11-21T08:00']]);
  assert.equal(plan[0].at, Date.parse('2026-11-20T07:00:00Z'));
  assert.deepEqual(planOverviews(data, Date.parse('2026-11-20T06:00:00Z'), ['overview:morning|2026-11-20']).map((r) => r.key), ['overview:evening|2026-11-20', 'overview:morning|2026-11-21']);
  assert.deepEqual(planOverviews(mergeSync(null, full({ settings: [{ id: 'settings-anna', owner_id: ME, general: {} }] })), Date.now()), [], 'uit');
  // 's ochtends: 2 taken vandaag (Offerte, en Boodschappen van gisteren), waarvan 1 te laat; afgevinkt telt niet
  assert.deepEqual(overviewText('morning', data, '2026-11-20', nl), { title: 'Plan je dag', body: '2 taken vandaag, 1 over tijd' });
  assert.deepEqual(overviewText('evening', data, '2026-11-20', en), { title: 'Evening review', body: '2 tasks left for today' });
  const one = mergeSync(null, full({ tasks: [{ id: 'taak-0001-aaaa', project_id: 'proj-werk-001', content: 'x', due: { date: '2026-11-20' } }] }));
  assert.equal(overviewText('morning', one, '2026-11-20', nl).body, '1 taak vandaag');
  assert.equal(overviewText('evening', one, '2026-11-20', nl).body, 'Nog 1 taak voor vandaag');
  const none = mergeSync(null, full({ tasks: [] }));
  assert.deepEqual(overviewText('morning', none, '2026-11-20', nl), { title: 'Plan je dag', body: 'Niets gepland voor vandaag' });
  assert.equal(overviewText('evening', none, '2026-11-20', nl), null, 'alles af: de avondreview zwijgt');
});

test('meldingen van Windows: een notitie en een melding openen hun eigen plek, en het adres terug alleen met geldige id\'s', () => {
  const xml = noteToastXml({ title: 'Boeken & <platen>', time: '12:00', noteId: 'notitie-00001', t: nl });
  assert.match(xml, /scenario="reminder"/);
  assert.match(xml, /Boeken &amp; &lt;platen&gt;/);
  assert.match(xml, /content="Openen"/);
  assert.doesNotMatch(xml, /Voltooien|Uitstellen/);
  assert.match(xml, /launch="tickory:\/\/open\?note=notitie-00001"/);
  const info = infoToastXml({ title: 'Bob "x"', lines: ['een', 'twee', 'drie'], launch: openUrl({ notification: 'melding-00001' }) });
  assert.match(info, /Bob &quot;x&quot;/);
  assert.equal((info.match(/<text>/g) ?? []).length, 3, 'titel en hooguit twee regels');
  assert.doesNotMatch(info, /scenario=/);
  assert.deepEqual(parseActionUrl(openUrl({ note: 'notitie-00001' })), { action: 'open', noteId: 'notitie-00001' });
  assert.deepEqual(parseActionUrl(openUrl({ notification: 'melding-00001' })), { action: 'open', notificationId: 'melding-00001' });
  assert.deepEqual(parseActionUrl(openUrl({ view: 'today' })), { action: 'open', view: 'today' });
  assert.equal(parseActionUrl(openUrl({ task: 'taak-0001-aaaa' })).taskId, 'taak-0001-aaaa');
  for (const bad of ['tickory://open?note=../x', 'tickory://open?notification=kort', 'tickory://open?view=Today!', 'tickory://complete?note=notitie-00001']) {
    assert.equal(parseActionUrl(bad), null, bad);
  }
});
