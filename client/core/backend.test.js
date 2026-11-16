// De opslag van het sessietoken (core/backend.js): onthouden (localStorage) of alleen tot de browser sluit (een sessiecookie), en het
// signaal dat de gegevens op dit apparaat weg moeten als zo'n aanmelding met het sluiten van de browser verdween.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from './backend.js';

/** Een nagebootste document.cookie: zetten met attributen, lezen als "naam=waarde; …", Max-Age=0 wist. */
function fakeCookies() {
  const jar = new Map();
  return {
    jar,
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(text) {
      const [pair, ...attrs] = text.split(';').map((x) => x.trim());
      const [name, value] = pair.split('=');
      if (attrs.some((a) => /^max-age=0$/i.test(a))) jar.delete(name);
      else jar.set(name, value);
    },
  };
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('onthouden: het token in de opslag, geen cookie; niet onthouden: alleen in een sessiecookie, en daarna "vergeten"', () => {
  const doc = fakeCookies();
  globalThis.document = doc;
  try {
    const storage = memoryStorage();
    const b = createBackend({ clientId: 'test', storage });
    b.setToken('tky_onthouden');
    assert.equal(b.getToken(), 'tky_onthouden');
    assert.equal(doc.jar.size, 0);
    assert.equal(b.forgotten(), false);

    b.setToken('tky_kort', { remember: false });
    assert.equal(storage.getItem('tickory.token'), null, 'niet in de blijvende opslag');
    assert.equal(doc.jar.get('tickory_session'), 'tky_kort');
    assert.equal(b.getToken(), 'tky_kort');
    assert.equal(b.forgotten(), false, 'de browser is nog open');

    // de browser sluit: de sessiecookie is weg, de markering niet
    doc.jar.clear();
    assert.equal(b.getToken(), null);
    assert.equal(b.forgotten(), true, 'de gegevens op dit apparaat moeten weg');
    b.clearForgotten();
    assert.equal(b.forgotten(), false);

    // weer onthouden: de cookie en de markering gaan weg
    b.setToken('tky_kort2', { remember: false });
    b.setToken('tky_weer', { remember: true });
    assert.equal(doc.jar.size, 0);
    assert.equal(b.forgotten(), false);
    b.clearToken();
    assert.equal(b.getToken(), null);
  } finally {
    delete globalThis.document;
  }
});

test('zonder document (zoals in Node) werkt onthouden gewoon en geeft niet onthouden geen fout', () => {
  const storage = memoryStorage();
  const b = createBackend({ clientId: 'test', storage });
  b.setToken('tky_x');
  assert.equal(b.getToken(), 'tky_x');
  b.setToken('tky_y', { remember: false });
  assert.equal(b.getToken(), null);
});
