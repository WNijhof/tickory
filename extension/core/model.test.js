// Het model van het venster: voorvullen uit pagina, link of selectie, de keuzelijst, de snelle invoer (met de echte herkenner van
// de web-app) met de paginatitel als letterlijk deel, de commando's (die de echte server aanneemt) en opnieuw proberen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseQuickAdd } from '../../client/core/quickadd.js';
import { createSchema } from '../../server/schema.ts';
import { handleSync } from '../../server/sync.ts';
import { createUser } from '../../server/users.ts';
import { messageFormatter } from './i18n.js';
import {
  PENDING_MS, buildCommands, contextDraft, defaultProject, listsFromSync, newAttempt, nextAttempt, outcomeOf, previewChips, projectOptions, randomBase,
  readTitle, shorten, splitLiteral, usableUrl, usePending,
} from './model.js';

const nl = messageFormatter(JSON.parse(readFileSync(new URL('../_locales/nl/messages.json', import.meta.url), 'utf8')));
const en = messageFormatter(JSON.parse(readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8')));
const NOW = new Date('2026-11-14T10:00:00'); // een zaterdag

test('de pagina: titel is de paginatitel, de beschrijving het adres; een selectie komt als citaat', () => {
  assert.deepEqual(contextDraft({ pageUrl: 'https://nos.nl/artikel/123', pageTitle: '  Morgen gratis parkeren \n in Utrecht  ' }, nl),
    { title: 'Morgen gratis parkeren in Utrecht', description: 'https://nos.nl/artikel/123' });
  const sel = contextDraft({ pageUrl: 'https://nos.nl/a', pageTitle: 'Nieuws', selectionText: 'Eerste regel.\r\n\r\n\r\n\r\nTweede regel  \n' }, nl);
  assert.equal(sel.description, 'https://nos.nl/a\n\n> Eerste regel.\n>\n> Tweede regel');
  // zonder titel: het adres; zonder bruikbaar adres (een pagina van de browser zelf): leeg
  assert.equal(contextDraft({ pageUrl: 'https://voorbeeld.nl/x', pageTitle: '' }, nl).title, 'https://voorbeeld.nl/x');
  assert.deepEqual(contextDraft({ pageUrl: 'chrome://newtab/', pageTitle: 'Nieuw tabblad' }, nl), { title: 'Nieuw tabblad', description: '' });
  assert.deepEqual(contextDraft({}, nl), { title: '', description: '' });
  assert.equal(contextDraft({ selectionText: 'Alleen een selectie\nmet twee regels' }, nl).title, 'Alleen een selectie', 'zonder pagina: de eerste regel van de selectie');
  // stuurtekens weg, NFC
  assert.equal(contextDraft({ pageUrl: 'https://a.nl/', pageTitle: 'Cafe\u0301\u0007 open' }, nl).title, 'Café open');
});

test('een link: de linktekst (of het adres) is de titel, het adres van de link de beschrijving, met de pagina waar hij stond', () => {
  const d = contextDraft({ pageUrl: 'https://blog.nl/post', pageTitle: 'Blog', linkUrl: 'https://boek.nl/titel', linkText: 'Een mooi boek' }, nl);
  assert.deepEqual(d, { title: 'Een mooi boek', description: 'https://boek.nl/titel\n\nGevonden op: https://blog.nl/post' });
  assert.equal(contextDraft({ pageUrl: 'https://blog.nl/post', linkUrl: 'https://boek.nl/titel' }, en).title, 'https://boek.nl/titel', 'Chrome geeft geen linktekst');
  assert.equal(contextDraft({ pageUrl: 'https://blog.nl/post', linkUrl: 'https://boek.nl/titel' }, en).description, 'https://boek.nl/titel\n\nFound on: https://blog.nl/post');
  assert.equal(contextDraft({ pageUrl: 'https://a.nl/', linkUrl: 'https://a.nl/' }, nl).description, 'https://a.nl/', 'een link naar dezelfde pagina: één keer');
  // een javascript-link is geen adres: dan geldt de pagina
  assert.deepEqual(contextDraft({ pageUrl: 'https://a.nl/', pageTitle: 'Pagina', linkUrl: 'javascript:alert(1)', linkText: 'Klik' }, nl), { title: 'Pagina', description: 'https://a.nl/' });
});

test('adressen: alleen http(s), zonder inloggegevens; lange titels netjes ingekort', () => {
  assert.equal(usableUrl('https://anna:geheim@a.nl/x?y=1#z'), 'https://a.nl/x?y=1#z');
  assert.equal(usableUrl('http://192.168.1.2:8080/'), 'http://192.168.1.2:8080/');
  for (const bad of ['file:///C:/x', 'data:text/html,hoi', 'chrome://settings', 'about:blank', 'javascript:alert(1)', 'geen adres', '', null, `https://a.nl/${'x'.repeat(5000)}`]) assert.equal(usableUrl(bad), '', String(bad).slice(0, 30));
  const long = contextDraft({ pageUrl: 'https://a.nl/', pageTitle: `${'woord '.repeat(60)}einde` }, nl).title;
  assert.ok(long.length <= 200 && long.endsWith('…'));
  assert.equal(shorten('kort', 10), 'kort');
  assert.equal(shorten('abcde', 5), 'abcde', 'precies de grens past nog');
  assert.equal(shorten('aaaaaa bbbbbbbbbb', 10), 'aaaaaa…', 'op een woordgrens als die niet te vroeg ligt');
  assert.equal(contextDraft({ pageUrl: 'https://a.nl/', pageTitle: 'Ti\u001btel\u007f' }, nl).title, 'Titel', 'ook escape en delete');
  assert.equal(shorten('aaaaaaaaaaaaaaaaaaaa', 10), 'aaaaaaaaa…', 'zonder spatie: hard afgekapt');
  assert.equal(shorten(`${'a'.repeat(8)}😀bbb`, 10), 'aaaaaaaa…', 'geen halve emoji');
  const quote = contextDraft({ pageUrl: 'https://a.nl/', selectionText: 'x'.repeat(10_000) }, nl).description;
  assert.ok(quote.length < 4100, 'een lange selectie wordt ingekort');
});

const sync = {
  me: { id: 'u1', username: 'anna', name: 'Anna', inbox_project_id: 'inbox-u1' },
  projects: [
    { id: 'inbox-u1', name: 'Inbox', order_key: 'a0', parent_id: null },
    { id: 'p-werk', name: 'Werk', order_key: 'b', parent_id: null },
    { id: 'p-thuis', name: 'Thuis', order_key: 'a', parent_id: null },
    { id: 'p-klus', name: 'Klussen', order_key: 'a', parent_id: 'p-thuis' },
    { id: 'p-oud', name: 'Oud', order_key: 'c', parent_id: null, is_archived: true },
    { id: 'p-onder-oud', name: 'Onder oud', order_key: 'a', parent_id: 'p-oud' },
    { id: 'p-weg', is_deleted: true },
    { id: 'p-club', name: 'Club', order_key: 'd', parent_id: null },
    { id: 'p-wees', name: 'Wees', order_key: 'e', parent_id: 'p-onbekend' },
  ],
  members: [
    { id: 'm1', project_id: 'p-club', user_id: 'u1', role: 'viewer' },
    { id: 'm2', project_id: 'p-werk', user_id: 'u1', role: 'owner' },
    { id: 'm3', project_id: 'p-werk', user_id: 'u2', role: 'viewer' },
    { id: 'm4', project_id: 'p-thuis', user_id: 'u1', role: 'viewer', is_deleted: true },
    { id: 'm5', project_id: 'p-thuis', user_id: 'u1', role: 'member' },
  ],
  sections: [{ id: 's1', project_id: 'p-werk', name: 'Lezen', order_key: 'a' }, { id: 's2', project_id: 'p-werk', name: 'Oud', is_archived: true }],
  labels: [{ id: 'l1', name: 'lezen', owner_id: 'u1' }, { id: 'l2', name: 'Uitgaan met Zoë', owner_id: 'u1' }, { id: 'l3', is_deleted: true }],
  settings: [{ id: 'settings-u1', owner_id: 'u1', auto_reminder: 15 }],
  tasks: [{ id: 't1', content: 'mag er niet in' }],
};
const lists = listsFromSync(sync);

test('de lijsten uit een sync: zonder gearchiveerd of verwijderd, met wat je alleen leest, en zonder taken', () => {
  assert.deepEqual(lists.user, { id: 'u1', username: 'anna', name: 'Anna' });
  assert.equal(lists.inboxId, 'inbox-u1');
  assert.deepEqual(lists.projects.map((p) => p.id), ['inbox-u1', 'p-werk', 'p-thuis', 'p-klus', 'p-club', 'p-wees']);
  assert.equal(lists.projects.find((p) => p.id === 'p-club').readOnly, true);
  assert.equal(lists.projects.find((p) => p.id === 'p-werk').readOnly, false, 'een lezer die iemand anders is, telt niet');
  assert.equal(lists.projects.find((p) => p.id === 'p-thuis').readOnly, false, 'een vervallen lidmaatschap telt niet');
  assert.equal(lists.projects[0].inbox, true);
  assert.deepEqual(lists.sections.map((s) => s.id), ['s1']);
  assert.deepEqual(lists.labels.map((l) => l.id), ['l1', 'l2']);
  assert.equal(lists.autoReminder, 15);
  assert.equal(JSON.stringify(lists).includes('mag er niet in'), false);
  assert.equal(listsFromSync({ me: { id: 'u1' } }).autoReminder, 30, 'standaard 30 minuten');
  assert.equal(listsFromSync({ me: { id: 'u1' }, settings: [{ id: 'settings-u1', owner_id: 'u1', auto_reminder: -1 }] }).autoReminder, -1, 'geen automatische herinnering');
  assert.deepEqual(listsFromSync(null).projects, []);
});

test('de keuzelijst: de Inbox eerst, dan de boom op volgorde; alleen lezen staat erin maar is niet te kiezen', () => {
  assert.deepEqual(projectOptions(lists).map((o) => `${'-'.repeat(o.depth)}${o.name}${o.disabled ? ' (x)' : ''}`),
    ['Inbox', 'Thuis', '-Klussen', 'Werk', 'Club (x)', 'Wees']);
  assert.equal(defaultProject(lists, 'p-werk'), 'p-werk', 'het laatst gekozen project');
  assert.equal(defaultProject(lists, 'p-club'), 'inbox-u1', 'alleen lezen: dan de Inbox');
  assert.equal(defaultProject(lists, 'p-weg'), 'inbox-u1', 'verdwenen: de Inbox');
  assert.equal(defaultProject(lists, null), 'inbox-u1');
  assert.equal(defaultProject(null, 'x'), null);
  assert.deepEqual(projectOptions(null), []);
});

test('de paginatitel blijft letterlijk; wat erachter getypt wordt, herkent de snelle invoer', () => {
  const title = 'Morgen gratis parkeren in Utrecht - NOS';
  assert.deepEqual(splitLiteral(title, title), { literal: title, rest: '' });
  assert.deepEqual(splitLiteral(`${title} vrijdag p1`, title), { literal: title, rest: ' vrijdag p1' });
  assert.deepEqual(splitLiteral('Plan de weekend morgen', 'Plan de week'), { literal: 'Plan de ', rest: 'weekend morgen' }, 'midden in een woord: terug naar de spatie');
  assert.deepEqual(splitLiteral('morgen bellen', 'Artikel'), { literal: '', rest: 'morgen bellen' }, 'een eigen titel: alles telt');
  assert.deepEqual(splitLiteral('iets', ''), { literal: '', rest: 'iets' });
  assert.deepEqual(splitLiteral('', 'Artikel'), { literal: '', rest: '' });
  assert.deepEqual(splitLiteral('Weerbericht voor morgen | knmi p1', 'Weerbericht voor morgen | KNMI'), { literal: 'Weerbericht voor morgen | ', rest: 'knmi p1' });

  const read = (text, prefilled = title, projectId = 'inbox-u1') => readTitle(text, { parse: parseQuickAdd, lists, prefilled, defaultProjectId: projectId, now: NOW });
  const plain = read(title);
  assert.equal(plain.content, title);
  assert.equal(plain.due, null, '"Morgen" in de paginatitel is geen datum');
  assert.equal(plain.priority, 4);
  const typed = read(`${title} vrijdag 9:00 p1 #Werk /Lezen @lezen @Uitgaan met Zoë @nieuw !30m =45m`);
  assert.equal(typed.content, title);
  assert.equal(typed.due.date, '2026-11-20T09:00');
  assert.equal(typed.priority, 1);
  assert.equal(typed.project_id, 'p-werk');
  assert.equal(typed.section_id, 's1');
  assert.deepEqual(typed.labels, ['l2', 'l1']);
  assert.deepEqual(typed.newLabels, ['nieuw']);
  assert.deepEqual(typed.reminders, [{ type: 'relative', minute_offset: 30 }]);
  assert.equal(typed.duration, 45);
  // alleen een datum erachter: de paginatitel blijft de titel
  const dated = read(`${title} morgen`);
  assert.equal(dated.content, title);
  assert.equal(dated.due.date, '2026-11-15');
  assert.equal(read('Artikel over koffie vrijdag om 9 uur', 'Artikel over koffie').due.date, '2026-11-20T09:00');
  // een eigen titel: alles telt mee, zoals in de web-app
  const own = read('Tandarts bellen morgen p2', title);
  assert.equal(own.content, 'Tandarts bellen');
  assert.equal(own.due.date, '2026-11-15');
  // #project dat je alleen leest, wordt niet herkend; het gekozen project is de standaard
  assert.equal(read('Iets #Club', '', 'p-thuis').project_id, 'p-thuis');
  assert.equal(read('Iets #Club', '', 'p-thuis').content, 'Iets #Club');
  // ~ zet de herkenning van een datum uit, zoals in de web-app
  assert.equal(read('Film ~morgen kijken', '').due, null);
});

test('het voorbeeld onder de titel: datum, prioriteit, project, sectie, labels, herinneringen en duur, in de taal van de extensie', () => {
  const parsed = readTitle('Lezen vrijdag 9:00 p1 #Werk /Lezen @lezen @nieuw !2u !0 !(morgen om 8 uur) !90m =45m {maandag}', { parse: parseQuickAdd, lists, defaultProjectId: 'inbox-u1', now: NOW });
  const texts = previewChips(parsed, lists, { defaultProjectId: 'inbox-u1', locale: 'nl-NL', msg: nl }).map((c) => `${c.kind}:${c.text}`);
  assert.deepEqual(texts, [
    'due:vrijdag 9:00 · vr 20 nov 09:00', 'deadline:deadline 2026-11-16', 'priority:P1', 'project:#Werk', 'section:/Lezen', 'label:@lezen', 'label:@nieuw (nieuw)',
    'reminder:herinnering 2 u vooraf', 'reminder:herinnering op het tijdstip', 'reminder:herinnering 2026-11-15 08:00', 'reminder:herinnering 90 min vooraf', 'duration:duur 45 min',
  ]);
  const english = previewChips(readTitle('x elke maandag !1d !15m', { parse: parseQuickAdd, lists, defaultProjectId: 'inbox-u1', now: NOW }), lists, { defaultProjectId: 'inbox-u1', locale: 'en-GB', msg: en });
  assert.deepEqual(english.map((c) => c.text), ['elke maandag · Mon 16 Nov ↻', 'reminder 1 d before', 'reminder 15 min before']);
  assert.deepEqual(previewChips(readTitle('Gewoon', { parse: parseQuickAdd, lists, defaultProjectId: 'p-werk', now: NOW }), lists, { defaultProjectId: 'p-werk', msg: nl }), [], 'niets herkend, geen stukjes');
});

/** Een server in het geheugen met Anna, om te zien dat de commando's echt worden aangenomen. */
function server() {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const anna = createUser(db, { username: 'anna', name: 'Anna', passwordHash: 'x' });
  return { db, anna, run: (commands) => handleSync(db, { sync_token: '*', resource_types: ['projects'], commands }, anna.id) };
}

test('de commando\'s: nieuwe labels, de taak en herinneringen, met vaste id\'s; de echte server neemt ze aan, en opnieuw sturen geeft geen dubbele taak', () => {
  const s = server();
  const realLists = listsFromSync(handleSync(s.db, { sync_token: '*', resource_types: ['projects', 'sections', 'labels', 'members', 'settings'] }, s.anna.id));
  assert.equal(realLists.inboxId, s.anna.inbox_project_id);
  const parsed = readTitle('Artikel lezen morgen 14:00 p2 @lezen @later {vrijdag} =1u', { parse: parseQuickAdd, lists: realLists, defaultProjectId: realLists.inboxId, now: NOW });
  const attempt = newAttempt('AbCdEfGhIjKlMnOp');
  const commands = buildCommands(parsed, { description: '  https://nos.nl/a\n\n> citaat\u0000  ', attempt, autoReminder: realLists.autoReminder });
  assert.deepEqual(commands.map((c) => c.type), ['label_add', 'label_add', 'task_add', 'reminder_add']);
  assert.deepEqual(commands.map((c) => c.uuid), ['ext-AbCdEfGhIjKlMnOp-label0', 'ext-AbCdEfGhIjKlMnOp-label1', 'ext-AbCdEfGhIjKlMnOp-task', 'ext-AbCdEfGhIjKlMnOp-reminder0']);
  const task = commands[2].args;
  assert.deepEqual(task, {
    id: 'AbCdEfGhIjKlMnOpT', project_id: realLists.inboxId, content: 'Artikel lezen', description: 'https://nos.nl/a\n\n> citaat', priority: 2,
    labels: ['AbCdEfGhIjKlMnOpL0', 'AbCdEfGhIjKlMnOpL1'], due: parsed.due, deadline: '2026-11-20', duration: 60,
  });
  assert.deepEqual(commands[3].args, { id: 'AbCdEfGhIjKlMnOpR0', task_id: 'AbCdEfGhIjKlMnOpT', type: 'relative', minute_offset: 30 }, 'de automatische herinnering bij een tijd');
  const res = s.run(commands);
  assert.ok(Object.values(res.sync_status).every((v) => v === 'ok'), JSON.stringify(res.sync_status));
  assert.deepEqual(outcomeOf(commands, res), { ok: true, warning: null });
  const again = s.run(commands); // hetzelfde verzoek nog eens (geen antwoord gekregen, opnieuw geprobeerd)
  assert.deepEqual(outcomeOf(commands, again), { ok: true, warning: null });
  const state = handleSync(s.db, { sync_token: '*' }, s.anna.id);
  assert.equal(state.tasks.length, 1, 'één taak, ook na twee keer versturen');
  assert.equal(state.tasks[0].content, 'Artikel lezen');
  assert.equal(state.labels.length, 2);
  assert.equal(state.reminders.length, 1);
});

test('zonder tijd geen automatische herinnering; met eigen herinneringen alleen die; zonder beschrijving geen veld', () => {
  const attempt = newAttempt('basisbasisbasis1');
  const at = (text, autoReminder = 30) => buildCommands(readTitle(text, { parse: parseQuickAdd, lists, defaultProjectId: 'inbox-u1', now: NOW }), { attempt, autoReminder });
  assert.deepEqual(at('Bellen morgen').map((c) => c.type), ['task_add']);
  assert.deepEqual(at('Bellen morgen 9:00', -1).map((c) => c.type), ['task_add'], 'automatische herinnering staat uit');
  const own = at('Bellen morgen 9:00 !10m !(morgen om 8 uur)');
  assert.deepEqual(own.slice(1).map((c) => c.args.type === 'absolute' ? c.args.due.date : c.args.minute_offset), [10, '2026-11-15T08:00']);
  const simple = at('Gewoon iets')[0].args;
  assert.deepEqual(Object.keys(simple).sort(), ['content', 'id', 'project_id']);
});

test('de echte server weigert een project dat je alleen leest: een nette fout, en een volgende poging met nieuwe uuid\'s', () => {
  const s = server();
  const bob = createUser(s.db, { username: 'bob', name: 'Bob', passwordHash: 'x' });
  handleSync(s.db, { commands: [{ type: 'project_add', uuid: 'proj-bob-1', args: { id: 'bobproject1', name: 'Van Bob' } }] }, bob.id);
  handleSync(s.db, { commands: [{ type: 'project_share', uuid: 'deel-bob-1', args: { project_id: 'bobproject1', username: 'anna', role: 'viewer' } }] }, bob.id);
  const attempt = newAttempt('pogingpogingpog1');
  const commands = buildCommands({ content: 'Iets', project_id: 'bobproject1', priority: 4, labels: [], newLabels: [] }, { attempt });
  const outcome = outcomeOf(commands, s.run(commands));
  assert.deepEqual(outcome, { ok: false, code: 'FORBIDDEN', retrySame: false });
  const next = nextAttempt(attempt, outcome, () => 'nieuwnieuwnieuw1');
  assert.equal(next.base, 'nieuwnieuwnieuw1');
  assert.deepEqual(outcomeOf(buildCommands({ content: 'x', project_id: 'bestaat-niet', labels: [], newLabels: [] }, { attempt: next }), s.run(buildCommands({ content: 'x', project_id: 'bestaat-niet', labels: [], newLabels: [] }, { attempt: next }))).code, 'NOT_FOUND');
});

test('uitkomsten: zonder antwoord dezelfde poging opnieuw, met een weigering een nieuwe; een mislukte herinnering is een waarschuwing', () => {
  const attempt = newAttempt('aaaaaaaaaaaaaaaa');
  const commands = buildCommands({ content: 'x', project_id: 'p', due: { date: '2026-11-15T09:00' }, labels: [], newLabels: [] }, { attempt, autoReminder: 30 });
  for (const code of ['OFFLINE', 'TIMEOUT', 'BUSY', 'HTTP_502']) {
    const o = outcomeOf(commands, null, { code });
    assert.equal(o.ok, false);
    assert.equal(o.retrySame, true, code);
    assert.equal(nextAttempt(attempt, o), attempt, 'dezelfde id\'s en uuid\'s');
  }
  for (const code of ['UNAUTHORIZED', 'TOO_LARGE', 'INVALID_REQUEST']) assert.equal(outcomeOf(commands, null, { code, status: 400 }).retrySame, false, code);
  assert.equal(outcomeOf(commands, null, { code: 'X', status: 500 }).retrySame, true);
  const [task, reminder] = commands;
  assert.deepEqual(outcomeOf(commands, { sync_status: { [task.uuid]: 'ok', [reminder.uuid]: { error_code: 'LIMIT_REACHED' } } }), { ok: true, warning: 'LIMIT_REACHED' });
  assert.deepEqual(outcomeOf(commands, { sync_status: { [task.uuid]: { error_code: 'NOT_FOUND' } } }), { ok: false, code: 'NOT_FOUND', retrySame: false });
  assert.deepEqual(outcomeOf(commands, {}), { ok: false, code: 'UNKNOWN', retrySame: false });
  assert.notEqual(nextAttempt(attempt, { ok: false, retrySame: false }).base, attempt.base);
});

test('id\'s en uuid\'s passen bij wat de server vraagt, en zijn willekeurig', () => {
  const a = newAttempt();
  assert.match(a.base, /^[A-Za-z0-9_-]{16}$/);
  assert.match(a.id('T'), /^[A-Za-z0-9_-]{8,40}$/);
  assert.match(a.uuid('reminder12'), /^[A-Za-z0-9_-]{8,64}$/);
  assert.notEqual(newAttempt().base, a.base);
  assert.equal(randomBase((n) => new Uint8Array(n).fill(64 + 3)), 'DDDDDDDDDDDDDDDD');
});

test('een keuze uit het contextmenu geldt alleen even, en alleen voor het tabblad waar hij vandaan kwam', () => {
  const now = 1_000_000;
  const p = { at: now - 1000, tabId: 7, linkUrl: 'https://a.nl/' };
  assert.equal(usePending(p, { now, tabId: 7 }), p);
  assert.equal(usePending(p, { now, tabId: null }), p, 'tabblad onbekend');
  assert.ok(usePending({ ...p, tabId: null }, { now, tabId: 3 }), 'de keuze kent het tabblad niet');
  assert.equal(usePending(p, { now, tabId: 8 }), null, 'een ander tabblad');
  assert.equal(usePending({ ...p, at: now - PENDING_MS - 1 }, { now, tabId: 7 }), null, 'te oud');
  assert.ok(usePending({ ...p, at: now - PENDING_MS }, { now, tabId: 7 }), 'precies op de grens');
  assert.equal(usePending({ ...p, at: now + 60_000 }, { now, tabId: 7 }), null, 'uit de toekomst');
  for (const bad of [null, undefined, 'x', {}, { at: '1' }]) assert.equal(usePending(bad, { now }), null);
});
