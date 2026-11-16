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
