// Notities importeren uit Google Keep en Markdown (core/noteImport.js): lijsten, kleuren, labels, archief en prullenbak, foto's in
// de zip, links, Markdown met een kop of YAML, Obsidian-afbeeldingen, en invoer die niet deugt.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeZip } from '../../scripts/zipFixture.ts';
import { KEEP_COLORS, keepNote, markdownNote, mediaTypeOf, plainToMarkdown, readNoteImport } from './noteImport.js';
import { fromMarkdown, runsText } from './noteDoc.js';
import { NOTE_BACKGROUNDS } from '../../shared/notes.js';
import { NOTE_LIMITS } from '../../shared/schema.js';

const enc = (s) => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('Keep: een lijst met vinkjes, kleur, labels en vastgepind; platte tekst blijft platte tekst', () => {
  const { note, warnings } = keepNote({
    color: 'TEAL', isTrashed: false, isPinned: true, isArchived: false, title: 'Boodschappen',
    listContent: [{ text: 'melk', isChecked: false }, { text: 'brood', isChecked: true }], labels: [{ name: 'Thuis' }, { name: 'thuis, extra' }],
    userEditedTimestampUsec: 1,
  });
  assert.deepEqual(warnings, []);
  assert.equal(note.content, '- [ ] melk\n- [x] brood');
  assert.deepEqual([note.title, note.background, note.is_pinned, note.is_archived, note.labels], ['Boodschappen', 'teal', true, false, ['Thuis', 'thuis extra']]);
  const text = keepNote({ textContent: '# geen kop\n- geen lijst\n**geen vet** en 1. geen nummer', title: '' }).note;
  assert.deepEqual(fromMarkdown(text.content).map((b) => [b.type, runsText(b.runs)]), [['p', '# geen kop'], ['p', '- geen lijst'], ['p', '**geen vet** en 1. geen nummer']], 'tekens die opmaak lijken blijven tekst');
  assert.equal(plainToMarkdown('a\n\nb'), 'a\n\nb');
});

test('Keep: elke kleur bestaat bij ons (of wordt geen achtergrond); gearchiveerd blijft gearchiveerd, prullenbak niet', () => {
  for (const v of Object.values(KEEP_COLORS)) assert.ok(v === null || NOTE_BACKGROUNDS.includes(v), String(v));
  assert.equal(keepNote({ textContent: 'x', color: 'GRAY' }).note.background, null);
  assert.equal(keepNote({ textContent: 'x', color: 'iets' }).note.background, null);
  const arch = keepNote({ textContent: 'x', isArchived: true, isPinned: true }).note;
  assert.deepEqual([arch.is_archived, arch.is_pinned], [true, false], 'gearchiveerd en vastgepind: alleen gearchiveerd');
  assert.deepEqual(keepNote({ textContent: 'x', isTrashed: true }), { note: null, reason: 'trashed', warnings: [] });
  assert.equal(keepNote({ foo: 1 }).reason, 'notKeep');
  assert.equal(keepNote([1, 2]).reason, 'notKeep');
});

test('Keep: links als lijst (alleen http en https), foto\'s uit de map, ander type of ontbrekend als waarschuwing', () => {
  const files = { 'foto.jpg': PNG };
  const { note, warnings } = keepNote({
    textContent: 'Kijk:', annotations: [{ url: 'https://example.org/recept', title: 'Recept' }, { url: 'javascript:alert(1)', title: 'x' }],
    attachments: [{ filePath: 'foto.jpg', mimetype: 'image/jpeg' }, { filePath: 'opname.3gp', mimetype: 'audio/3gpp' }, { filePath: 'weg.png', mimetype: 'image/png' }],
  }, (p) => files[p] ?? null);
  assert.equal(note.content, 'Kijk:\n\n- [Recept](https://example.org/recept)');
  assert.deepEqual(note.files.map((f) => [f.name, f.mime]), [['foto.jpg', 'image/jpeg']]);
  assert.deepEqual(warnings, ['fileType', 'fileMissing']);
});

test('Markdown: de titel uit de kop, uit "# …" of uit de bestandsnaam; tags uit de kop worden labels', () => {
  const a = markdownNote('---\ntitle: "Reisplan"\ntags: [vakantie, "Italië"]\n---\n# Dag 1\nRome', 'notities/reis.md').note;
  assert.deepEqual([a.title, a.content, a.labels], ['Reisplan', '# Dag 1\nRome', ['vakantie', 'Italië']]);
  const b = markdownNote('# Boodschappen\n\n- [ ] melk\n- [x] kaas', 'x.md').note;
  assert.deepEqual([b.title, b.content], ['Boodschappen', '- [ ] melk\n- [x] kaas']);
  const c = markdownNote('Gewoon een tekst\nmet **vet**', 'map/Mijn idee.markdown').note;
  assert.deepEqual([c.title, c.content], ['Mijn idee', 'Gewoon een tekst\nmet **vet**']);
  const d = markdownNote('---\ntags:\n  - werk\n  - "#plan"\n---\ntekst', 'a.txt').note;
  assert.deepEqual(d.labels, ['werk', 'plan']);
});

test('Markdown: afbeeldingen in de zip worden bestanden (ook ![[naam]] zoals Obsidian); een adres of iets buiten de zip blijft tekst', () => {
  const zipFiles = { 'kluis/plaatjes/strand.png': PNG, 'kluis/bijlagen/zee.png': PNG };
  const find = (p) => zipFiles[p] ?? null;
  const byName = (n) => Object.keys(zipFiles).find((p) => p.endsWith(`/${n}`)) ?? null;
  const { note } = markdownNote('Strand:\n![strand](plaatjes/strand.png)\n![[zee.png]]\n![web](https://example.org/a.png)\n![weg](../../geheim.png)', 'kluis/vakantie.md', find, byName);
  assert.deepEqual(note.files.map((f) => f.name), ['strand.png', 'zee.png']);
  assert.ok(note.content.includes('![web](https://example.org/a.png)') || note.content.includes('web'), 'een adres blijft');
  assert.ok(!note.content.includes('strand.png'), 'de verwijzing naar een meegenomen bestand verdwijnt');
});

test('een te lange tekst wordt ingekort (met waarschuwing), een titel ook', () => {
  const long = Array.from({ length: 30000 }, (_, i) => `regel ${i}`).join('\n');
  const r = markdownNote(long, 'lang.md');
  assert.ok(r.note.content.length <= NOTE_LIMITS.content);
  assert.deepEqual(r.warnings, ['tooLong']);
  assert.equal(keepNote({ textContent: 'x', title: 't'.repeat(500) }).note.title.length, NOTE_LIMITS.title);
});

test('mediaTypeOf: alleen afbeeldingen en geluid die de app kan tonen', () => {
  assert.equal(mediaTypeOf('a.JPG'), 'image/jpeg');
  assert.equal(mediaTypeOf('a.m4a'), 'audio/mp4');
  assert.equal(mediaTypeOf('a.svg'), null);
  assert.equal(mediaTypeOf('a.3gp', 'audio/3gpp'), null);
  assert.equal(mediaTypeOf('zonder', 'image/webp'), 'image/webp');
});

test('readNoteImport: een Takeout-zip van Keep met foto, Labels.txt en de prullenbak; losse .md en .json; onzin', async () => {
  const keep = (o) => JSON.stringify({ isTrashed: false, userEditedTimestampUsec: 1, ...o });
  const zip = await makeZip([
    { name: 'Takeout/Keep/Boodschappen.json', data: keep({ title: 'Boodschappen', listContent: [{ text: 'melk', isChecked: false }], attachments: [{ filePath: 'foto.png', mimetype: 'image/png' }] }), method: 8 },
    { name: 'Takeout/Keep/Boodschappen.html', data: '<html>…</html>', method: 8 },
    { name: 'Takeout/Keep/foto.png', data: PNG, method: 0 },
    { name: 'Takeout/Keep/Weg.json', data: keep({ title: 'Weg', textContent: 'x', isTrashed: true }), method: 8 },
    { name: 'Takeout/Keep/Labels.txt', data: 'Thuis\nWerk', method: 8 },
  ]);
  const r = await readNoteImport([
    { name: 'takeout.zip', bytes: zip },
    { name: 'Idee.md', bytes: enc('# Idee\nEen app voor notities') },
    { name: 'los.json', bytes: enc(keep({ title: 'Los', textContent: 'tekst' })) },
    { name: 'kapot.json', bytes: enc('{ geen json') },
    { name: 'foto.png', bytes: PNG },
    { name: 'leeg.md', bytes: enc('   ') },
  ]);
  assert.deepEqual(r.notes.map((n) => [n.title, n.files.length]), [['Boodschappen', 1], ['Idee', 0], ['Los', 0]]);
  assert.deepEqual(r.skipped.map((s) => [s.name, s.reason]), [['Takeout/Keep/Weg.json', 'trashed'], ['kapot.json', 'notKeep'], ['foto.png', 'notNotes'], ['leeg.md', 'empty']]);
  assert.equal(r.source, 'mixed');
  const bad = await readNoteImport([{ name: 'kapot.zip', bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]) }]);
  assert.deepEqual(bad.skipped.map((s) => s.reason), ['zip.corrupt']);
  const none = await readNoteImport([{ name: 'leeg.zip', bytes: await makeZip([{ name: 'iets.csv', data: 'a,b', method: 0 }]) }]);
  assert.deepEqual(none.skipped.map((s) => s.reason), ['zip.noNotes']);
});
