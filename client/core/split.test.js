// Twee lijsten of notities naast elkaar (core/split.js): welke kolom waar heen gaat, en wat er van een bewaarde toestand klopt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate, backFromNote, canShowBeside, closePane, navigateIn, noteRoute, openBeside, parseSide, settle, swapPanes } from './split.js';

const today = { type: 'today' };
const work = { type: 'project', id: 'project-werk-01' };
const home = { type: 'project', id: 'project-thuis-1' };
const notes = { type: 'notes' };

test('wat rechts kan staan: lijsten en notities, niet zoeken, instellingen of de handleiding', () => {
  for (const r of [today, { type: 'upcoming' }, work, { type: 'filter', id: 'filter-aaaa1111' }, { type: 'label', id: 'label-bbbb2222' }, notes, { type: 'notes', id: 'archive' }, { type: 'notes', id: 'label:label-1' }, { type: 'note', id: 'note-aaaa1111' }]) {
    assert.equal(canShowBeside(r), true, JSON.stringify(r));
  }
  for (const r of [null, {}, { type: 'help' }, { type: 'productivity' }, { type: 'search' }, { type: 'completed' }, { type: 'project' }, { type: 'project', id: 'a b' }, { type: 'note', id: '<x>' }]) {
    assert.equal(canShowBeside(r), false, JSON.stringify(r));
  }
});

test('de zijbalk werkt op de actieve kolom; wat rechts niet kan, gaat links open', () => {
  const one = { main: today, side: null, active: 'main' };
  assert.deepEqual(navigateIn(one, work), { main: work, side: null, active: 'main' });
  const two = { main: today, side: work, active: 'side' };
  assert.deepEqual(navigateIn(two, home), { main: today, side: home, active: 'side' });
  assert.deepEqual(navigateIn({ ...two, active: 'main' }, home), { main: home, side: work, active: 'main' });
  // de handleiding kan niet rechts: links, en links wordt actief
  assert.deepEqual(navigateIn(two, { type: 'help' }), { main: { type: 'help' }, side: work, active: 'main' });
});

test('naast elkaar openen, sluiten, wisselen en actief maken', () => {
  const one = { main: work, side: null, active: 'main' };
  // zonder route: hetzelfde als links; de rechter kolom wordt actief
  assert.deepEqual(openBeside(one), { main: work, side: work, active: 'side' });
  assert.deepEqual(openBeside(one, notes), { main: work, side: notes, active: 'side' });
  // links iets wat rechts niet kan (de handleiding): rechts Vandaag
  assert.deepEqual(openBeside({ main: { type: 'help' }, side: null, active: 'main' }), { main: { type: 'help' }, side: today, active: 'side' });
  const two = { main: work, side: notes, active: 'side' };
  assert.deepEqual(closePane(two), { main: work, side: null, active: 'main' });
  assert.deepEqual(closePane(two, 'main'), { main: notes, side: null, active: 'main' }, 'links sluiten: rechts schuift naar links');
  assert.equal(closePane(one), one);
  assert.deepEqual(swapPanes(two), { main: notes, side: work, active: 'main' });
  assert.equal(swapPanes({ main: { type: 'help' }, side: notes, active: 'main' }).main.type, 'help', 'de handleiding kan niet rechts: niet wisselen');
  assert.equal(activate(two, 'side'), two, 'al actief: dezelfde toestand');
  assert.deepEqual(activate(two, 'main'), { ...two, active: 'main' });
  assert.equal(activate(one, 'side').active, 'main', 'zonder rechter kolom blijft links actief');
});

test('een open notitie in een kolom: terug gaat naar de lijst waar je vandaan kwam', () => {
  assert.deepEqual(noteRoute('note-aaaa1111', { type: 'notes', id: 'archive' }), { type: 'note', id: 'note-aaaa1111', from: 'archive' });
  assert.deepEqual(noteRoute('note-aaaa1111', today), { type: 'note', id: 'note-aaaa1111', from: '' });
  assert.deepEqual(backFromNote({ type: 'note', id: 'note-aaaa1111', from: 'label:label-1' }), { type: 'notes', id: 'label:label-1' });
  assert.deepEqual(backFromNote({ type: 'note', id: 'note-aaaa1111', from: '' }), { type: 'notes' });
});

test('een bewaarde rechter kolom: alleen wat klopt', () => {
  assert.deepEqual(parseSide(JSON.stringify(work)), work);
  assert.deepEqual(parseSide(JSON.stringify(today)), today);
  assert.deepEqual(parseSide(JSON.stringify({ type: 'note', id: 'note-aaaa1111', from: 'trash' })), { type: 'note', id: 'note-aaaa1111', from: 'trash' });
  assert.deepEqual(parseSide(JSON.stringify({ type: 'note', id: 'note-aaaa1111', from: '<b>' })), { type: 'note', id: 'note-aaaa1111', from: '' });
  for (const bad of [null, '', 'geen json', '{"type":"help"}', '{"type":"project"}', '[1,2]']) assert.equal(parseSide(bad), null, String(bad));
});

test('wat weg is (een ander apparaat): links Vandaag, rechts dicht, een notitie wordt de lijst', () => {
  const gone = new Set(['project-thuis-1', 'note-weg-00001']);
  const exists = (r) => !gone.has(r.id);
  const state = { main: work, side: notes, active: 'side' };
  assert.equal(settle(state, exists), state, 'alles bestaat nog: dezelfde toestand');
  assert.deepEqual(settle({ main: home, side: work, active: 'side' }, exists), { main: today, side: work, active: 'side' });
  assert.deepEqual(settle({ main: work, side: home, active: 'side' }, exists), { main: work, side: null, active: 'main' });
  assert.deepEqual(settle({ main: work, side: { type: 'note', id: 'note-weg-00001', from: 'archive' }, active: 'side' }, exists),
    { main: work, side: { type: 'notes', id: 'archive' }, active: 'side' });
});
