// Tests voor de sneltoetsen van zoeken (core/searchKeys.js): `/` buiten invoervelden, Ctrl+K of Cmd+K altijd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchKey } from './searchKeys.js';

const body = { tagName: 'BODY' };
const input = { tagName: 'INPUT', type: 'text' };
const key = (k, extra = {}, options) => searchKey({ key: k, target: body, ...extra }, options);

test('/ zoekt buiten een invoerveld, ook met Shift (voor toetsenborden waar / een Shift-toets is)', () => {
  assert.equal(key('/'), true);
  assert.equal(key('/', { shiftKey: true }), true);
  assert.equal(key('/', { target: { tagName: 'BUTTON' } }), true, 'een knop heeft de focus: toch zoeken');
  assert.equal(key('/', { target: { tagName: 'INPUT', type: 'checkbox' } }), true, 'een selectievakje is geen tekstveld');
});

test('/ in een invoerveld, tekstvak of keuzelijst is gewoon een teken', () => {
  assert.equal(key('/', { target: input }), false);
  assert.equal(key('/', { target: { tagName: 'TEXTAREA' } }), false);
  assert.equal(key('/', { target: { tagName: 'SELECT' } }), false);
  assert.equal(key('/', { target: { tagName: 'DIV', isContentEditable: true } }), false);
});

test('/ doet niets als er een venster open staat (zoeken moet dan niet ineens over een taakvenster springen)', () => {
  assert.equal(key('/', {}, { blocked: () => true }), false);
  assert.equal(key('/', {}, { blocked: () => false }), true);
});

test('Ctrl+K en Cmd+K zoeken overal: in een invoerveld en bij een open venster', () => {
  for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.equal(key('k', mod), true);
    assert.equal(key('K', mod), true, 'met Caps Lock');
    assert.equal(key('k', { ...mod, target: input }), true);
    assert.equal(key('k', mod, { blocked: () => true }), true);
  }
});

test('andere combinaties doen niets: Alt, Ctrl+Shift+K (ontwikkelhulpmiddelen), een losse k, een toets die blijft hangen', () => {
  assert.equal(key('k'), false);
  assert.equal(key('k', { shiftKey: true }), false);
  assert.equal(key('k', { ctrlKey: true, shiftKey: true }), false);
  assert.equal(key('k', { ctrlKey: true, altKey: true }), false);
  assert.equal(key('/', { altKey: true }), false);
  assert.equal(key('/', { ctrlKey: true }), false, 'Ctrl+/ is niet van ons');
  assert.equal(key('/', { metaKey: true }), false);
  assert.equal(key('/', { repeat: true }), false);
  assert.equal(key('Escape'), false);
  assert.equal(key('Enter'), false);
  assert.equal(key('?'), false, '? is voor het overzicht van sneltoetsen');
  assert.equal(searchKey({ key: undefined }), false);
  assert.equal(searchKey({}), false);
});
