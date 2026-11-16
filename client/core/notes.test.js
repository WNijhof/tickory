// Tests voor het lezen van notities (core/notes.js) en de reducer voor notities: lijst, zoeken, aantallen, voorbeeldtekst, opruimen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyState } from './reducer.js';
import { NOTE_TRASH_DAYS, expiredNotes, noteCounts, noteLabels, noteList, noteSnippet, noteTitle, trashDaysLeft } from './notes.js';

const ME = 'user-anna-0001';
let n = 0;
function world() {
  const v = emptyState();
  const put = (res, row) => {
    const full = { is_deleted: false, created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z', ...row };
    v[res].set(full.id, full);
    return full;
  };
  put('labels', { id: 'l-thuis', name: 'thuis', owner_id: ME });
  put('labels', { id: 'l-werk', name: 'Werk', owner_id: ME });
  const note = (over) => put('notes', { id: `note-${String(++n).padStart(6, '0')}`, title: '', content: '', color: 'charcoal', labels: [], is_pinned: false, is_archived: false, trashed_at: null, owner_id: ME, ...over });
  return { v, put, note };
}
const titles = (list) => list.map((x) => x.title);

test('de lijst: vastgepind eerst, dan de laatst gewijzigde; archief en prullenbak apart', () => {
  const { v, note } = world();
  note({ title: 'oud', updated_at: '2026-11-01T10:00:00.000Z' });
  note({ title: 'nieuw', updated_at: '2026-11-05T10:00:00.000Z' });
  note({ title: 'vast', is_pinned: true, updated_at: '2026-10-01T10:00:00.000Z' });
  note({ title: 'archief', is_archived: true });
  note({ title: 'weg', trashed_at: '2026-11-10T10:00:00.000Z' });
  note({ title: 'weg en vast', trashed_at: '2026-11-10T10:00:00.000Z', is_pinned: true, is_archived: true });
  assert.deepEqual(titles(noteList(v)), ['vast', 'nieuw', 'oud']);
  assert.deepEqual(titles(noteList(v, { scope: 'archive' })), ['archief']);
  assert.deepEqual(titles(noteList(v, { scope: 'trash' })).sort(), ['weg', 'weg en vast']);
  assert.deepEqual(noteCounts(v), { all: 3, archive: 1, trash: 2, perLabel: new Map() });
});

test('bij gelijke tijd beslist het id, zodat de volgorde overal gelijk is', () => {
  const { v, note } = world();
  note({ id: 'note-bbbbbbbb', title: 'b' });
  note({ id: 'note-aaaaaaaa', title: 'a' });
  assert.deepEqual(titles(noteList(v)), ['a', 'b']);
});

test('labels: filteren, tellen en lijst van gebruikte labels (zonder de prullenbak)', () => {
  const { v, note } = world();
  note({ title: 'een', labels: ['l-thuis'] });
  note({ title: 'twee', labels: ['l-thuis', 'l-werk'] });
  note({ title: 'drie', labels: ['l-werk'], trashed_at: '2026-11-10T10:00:00.000Z' });
  assert.deepEqual(titles(noteList(v, { labelId: 'l-thuis' })).sort(), ['een', 'twee']);
  assert.deepEqual(titles(noteList(v, { labelId: 'l-werk' })), ['twee']);
  assert.deepEqual(noteLabels(v).map((x) => [x.label.name, x.count]), [['thuis', 2], ['Werk', 1]]);
});

test('zoeken: hoofdletters, accenten en woordvolgorde tellen niet; titel eerst; ook in labelnamen', () => {
  const { v, note } = world();
  note({ title: 'Boodschappen', content: 'melk, brood en een crème brûlée', updated_at: '2026-11-02T10:00:00.000Z' });
  note({ title: 'Recept', content: 'Eerst de boodschappen doen', updated_at: '2026-11-09T10:00:00.000Z' });
  note({ title: 'Klus', content: '**vet** schroeven', labels: ['l-thuis'] });
  assert.deepEqual(titles(noteList(v, { query: 'BOODSCHAPPEN' })), ['Boodschappen', 'Recept'], 'titel eerst, dan de tekst');
  assert.deepEqual(titles(noteList(v, { query: 'creme brulee' })), ['Boodschappen'], 'zonder accenten');
  assert.deepEqual(titles(noteList(v, { query: 'brood melk' })), ['Boodschappen'], 'andere volgorde');
  assert.deepEqual(titles(noteList(v, { query: 'vet' })), ['Klus'], 'zonder de opmaaktekens');
  assert.deepEqual(titles(noteList(v, { query: '**' })), [], 'opmaaktekens zijn geen zoekwoord');
  assert.deepEqual(titles(noteList(v, { query: 'thuis' })), ['Klus'], 'labelnaam');
  assert.deepEqual(titles(noteList(v, { query: '   ' })).length, 3, 'een lege zoekterm filtert niet');
  assert.deepEqual(titles(noteList(v, { query: 'schroeven', labelId: 'l-werk' })), [], 'zoeken en label samen');
});

test('zoeken blijft binnen de gekozen groep: een notitie in de prullenbak komt niet in "alle"', () => {
  const { v, note } = world();
  note({ title: 'geheim', trashed_at: '2026-11-10T10:00:00.000Z' });
  assert.deepEqual(noteList(v, { query: 'geheim' }), []);
  assert.deepEqual(titles(noteList(v, { query: 'geheim', scope: 'trash' })), ['geheim']);
});

test('de titel: eigen titel, anders de eerste regel zonder opmaak, anders de vervanger', () => {
  assert.equal(noteTitle({ title: '  Plan  ', content: 'x' }), 'Plan');
  assert.equal(noteTitle({ title: '', content: '\n\n# Eerste regel\nmeer' }), 'Eerste regel');
  assert.equal(noteTitle({ title: '', content: '**vet** begin' }), 'vet begin');
  assert.equal(noteTitle({ title: '', content: '' }, 'Zonder titel'), 'Zonder titel');
  assert.equal(noteTitle({ title: '', content: 'a'.repeat(200) }).length, 80);
});

test('voorbeeldtekst: het begin zonder opmaak, of een stuk rond de treffer met markeringen', () => {
  const { note } = world();
  const short = note({ content: '# Titel\n\nEen **korte** tekst' });
  assert.deepEqual(noteSnippet(short), { text: 'Titel Een korte tekst', marks: [] });
  const long = note({ content: `${'begin '.repeat(60)}hier staat het GEZOCHTE woord ${'eind '.repeat(60)}` });
  const s = noteSnippet(long, 'gezochte', 100);
  assert.ok(s.text.startsWith('…') && s.text.endsWith('…'));
  assert.equal(s.marks.length, 1);
  assert.equal(s.text.slice(s.marks[0].start, s.marks[0].start + s.marks[0].length), 'GEZOCHTE');
  assert.ok(s.text.length <= 102);
  const accent = note({ content: 'Een crème brûlée toe' });
  const a = noteSnippet(accent, 'creme');
  assert.equal(a.text.slice(a.marks[0].start, a.marks[0].start + a.marks[0].length), 'crème');
});

test('opruimen: wat langer dan 30 dagen in de prullenbak ligt; en de dagen die er nog zijn', () => {
  const { v, note } = world();
  const NOW = Date.parse('2026-12-20T12:00:00.000Z');
  note({ title: 'lang geleden', trashed_at: '2026-11-10T12:00:00.000Z' });
  note({ title: 'net over', trashed_at: '2026-11-19T11:59:59.000Z' });
  note({ title: 'net niet', trashed_at: '2026-11-20T12:00:01.000Z' });
  note({ title: 'niet weg' });
  assert.deepEqual(expiredNotes(v, NOW).map((x) => x.title).sort(), ['lang geleden', 'net over']);
  assert.equal(NOTE_TRASH_DAYS, 30);
  assert.equal(trashDaysLeft({ trashed_at: '2026-12-19T12:00:00.000Z' }, NOW), 29);
  assert.equal(trashDaysLeft({ trashed_at: '2026-12-20T12:00:00.000Z' }, NOW), 30);
  assert.equal(trashDaysLeft({ trashed_at: '2026-10-01T12:00:00.000Z' }, NOW), 0);
  assert.equal(trashDaysLeft({ trashed_at: 'rommel' }, NOW), 30);
});

test('de reducer: toevoegen, wijzigen, verwijderen en een label dat verdwijnt (lengtes controleert de server)', () => {
  const { v } = world();
  const NOW = '2026-11-16T10:00:00.000Z';
  v.labels.set('l-thuis', { id: 'l-thuis', name: 'thuis', owner_id: ME });
  applyCommand(v, { type: 'note_add', args: { id: 'note-reducer-1', title: 'Hoi', labels: ['l-thuis'] } }, NOW, ME);
  const added = v.notes.get('note-reducer-1');
  assert.deepEqual([added.title, added.content, added.is_pinned, added.owner_id, added.labels], ['Hoi', '', false, ME, ['l-thuis']]);
  applyCommand(v, { type: 'note_update', args: { id: 'note-reducer-1', content: 'tekst', is_pinned: true } }, '2026-11-16T11:00:00.000Z', ME);
  assert.deepEqual([v.notes.get('note-reducer-1').content, v.notes.get('note-reducer-1').is_pinned, v.notes.get('note-reducer-1').updated_at], ['tekst', true, '2026-11-16T11:00:00.000Z']);
  applyCommand(v, { type: 'label_delete', args: { id: 'l-thuis' } }, NOW, ME);
  assert.deepEqual(v.notes.get('note-reducer-1').labels, []);
  applyCommand(v, { type: 'note_delete', args: { id: 'note-reducer-1' } }, NOW, ME);
  assert.equal(v.notes.has('note-reducer-1'), false);
});

test('kaartdatum: Vandaag, Gisteren, dag en maand, en het jaar alleen in een ander jaar', async () => {
  const { cardDate, editedText } = await import('./notes.js');
  const now = new Date(2026, 10, 16, 15, 0);
  assert.equal(cardDate(new Date(2026, 10, 16, 0, 5).toISOString(), now), 'Vandaag');
  assert.equal(cardDate(new Date(2026, 10, 15, 23, 59).toISOString(), now), 'Gisteren');
  assert.match(cardDate(new Date(2026, 8, 22, 12).toISOString(), now), /^22 sep$/);
  assert.match(cardDate(new Date(2025, 8, 22, 12).toISOString(), now), /^22 sep 2025$/);
  assert.equal(cardDate('rommel', now), '');
  assert.equal(editedText(new Date(2026, 10, 16, 14, 3).toISOString(), now), 'Bewerkt vandaag om 14:03');
  assert.equal(editedText(new Date(2026, 10, 15, 9, 15).toISOString(), now), 'Bewerkt gisteren om 09:15');
  assert.match(editedText(new Date(2026, 9, 22, 9, 15).toISOString(), now), /^Bewerkt 22 okt$/);
});

test('sorteren: laatst bewerkt, aangemaakt en titel (zonder titel achteraan), in beide richtingen', async () => {
  const { noteComparator } = await import('./notes.js');
  const rows = [
    { id: 'a', title: 'Zebra', created_at: '2026-01-03', updated_at: '2026-02-01' },
    { id: 'b', title: '', created_at: '2026-01-01', updated_at: '2026-03-01' },
    { id: 'c', title: 'appel', created_at: '2026-01-02', updated_at: '2026-01-01' },
    { id: 'd', title: 'Éclair', created_at: '2026-01-04', updated_at: '2026-02-15' },
  ];
  const ids = (sort, order) => [...rows].sort(noteComparator(sort, order)).map((r) => r.id).join('');
  assert.equal(ids('updated', 'desc'), 'bdac');
  assert.equal(ids('updated', 'asc'), 'cadb');
  assert.equal(ids('created', 'desc'), 'dacb');
  assert.equal(ids('created', 'asc'), 'bcad');
  assert.equal(ids('title', 'asc'), 'cdab', 'appel, Éclair, Zebra, en zonder titel achteraan');
  assert.equal(ids('title', 'desc'), 'adcb', 'ook aflopend blijft zonder titel achteraan');
});

test('groepen en zoeken: vastgepind apart, zoeken in "alle" vindt ook het archief', async () => {
  const { noteGroups } = await import('./notes.js');
  const { v, note } = world();
  note({ title: 'vast', is_pinned: true });
  note({ title: 'los' });
  note({ title: 'oud archief', is_archived: true, is_pinned: true });
  const list = noteList(v);
  assert.deepEqual(titles(list), ['vast', 'los']);
  const g = noteGroups(list);
  assert.deepEqual([titles(g.pinned), titles(g.others)], [['vast'], ['los']]);
  assert.deepEqual(noteGroups(list, 'archive').pinned, [], 'in het archief geen groepen');
  assert.deepEqual(titles(noteList(v, { query: 'archief' })), ['oud archief'], 'zoeken vindt ook wat in het archief staat');
  assert.deepEqual(noteGroups(noteList(v, { query: 'archief' })).pinned, [], 'een vastgepinde notitie in het archief staat niet bij Vastgepind');
});

import { noteReminderInfo, reminderPresets } from './notes.js';

test('de herinnering van een notitie om te tonen: de volgende keer, of de voorbije eenmalige als "te laat"', () => {
  const now = new Date(2026, 10, 16, 10, 0); // maandag 16 november, 10:00 (tijd van het toestel)
  assert.equal(noteReminderInfo({ remind_at: null }, now), null);
  assert.deepEqual(noteReminderInfo({ remind_at: '2026-11-16T18:00' }, now), { at: '2026-11-16T18:00', past: false, repeat: null, text: 'vandaag 18:00' });
  assert.deepEqual(noteReminderInfo({ remind_at: '2026-11-16T09:00' }, now), { at: '2026-11-16T09:00', past: true, repeat: null, text: 'vandaag 09:00' });
  const weekly = noteReminderInfo({ remind_at: '2026-11-02T09:00', remind_repeat: 'weekly' }, now);
  assert.deepEqual([weekly.at, weekly.past, weekly.repeat], ['2026-11-23T09:00', false, 'weekly']);
  assert.equal(noteReminderInfo({ remind_at: '2026-11-16T08:00', remind_repeat: 'daily' }, now).text, 'morgen 08:00');
});

test('snelle keuzes: later vandaag (18:00, of drie uur later), morgen 9:00, volgende maandag 9:00', () => {
  const at = (d) => reminderPresets(d).map((p) => `${p.id}=${p.at}`);
  assert.deepEqual(at(new Date(2026, 10, 16, 10, 0)), ['later=2026-11-16T18:00', 'tomorrow=2026-11-17T09:00', 'nextWeek=2026-11-23T09:00']);
  assert.deepEqual(at(new Date(2026, 10, 18, 19, 30)), ['later=2026-11-18T22:00', 'tomorrow=2026-11-19T09:00', 'nextWeek=2026-11-23T09:00']);
  assert.deepEqual(at(new Date(2026, 10, 22, 22, 0)), ['tomorrow=2026-11-23T09:00'], 'zondagavond: geen "later vandaag", en maandag staat er maar één keer');
  assert.deepEqual(at(new Date(2026, 11, 31, 12, 0)).slice(1), ['tomorrow=2027-01-01T09:00', 'nextWeek=2027-01-04T09:00']);
});

import { reminderFingerprint } from './android.js';

test('de vingerafdruk voor de Android-app verandert met de herinnering van een notitie, niet met een notitie zonder', () => {
  const s = emptyState();
  s.notes.set('note-fp-0001', { id: 'note-fp-0001', title: 'Plan', content: 'x', remind_at: null, remind_repeat: null, trashed_at: null });
  const empty = reminderFingerprint(s, ME);
  s.notes.set('note-fp-0002', { id: 'note-fp-0002', title: 'Geen', content: 'y', remind_at: null });
  assert.equal(reminderFingerprint(s, ME), empty, 'zonder herinnering telt een notitie niet');
  const changes = [{ remind_at: '2026-11-20T09:00' }, { remind_repeat: 'weekly' }, { title: 'Plan B' }, { trashed_at: '2026-11-16T10:00:00.000Z' }, { remind_at: null }];
  let last = empty;
  for (const change of changes) {
    s.notes.set('note-fp-0001', { ...s.notes.get('note-fp-0001'), ...change });
    const now = reminderFingerprint(s, ME);
    assert.notEqual(now, last, JSON.stringify(change));
    last = now;
  }
  assert.equal(last, empty);
});
