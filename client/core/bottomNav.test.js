// De menubalk onderaan op een telefoon: welke knop actief is en waar de ronde knop "+" een taak toevoegt (core/bottomNav.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from './reducer.js';
import { TABS, activeTab, fabTarget } from './bottomNav.js';

const INBOX = 'inbox-alice';
const ME = 'u-alice';

function sample() {
  const v = emptyState();
  const put = (res, row) => v[res].set(row.id, { is_archived: false, parent_id: null, ...row });
  put('projects', { id: INBOX, name: 'Inbox' });
  put('projects', { id: 'p-thuis', name: 'Thuis' });
  put('projects', { id: 'p-oud', name: 'Oud', is_archived: true });
  put('projects', { id: 'p-oud-sub', name: 'Onder oud', parent_id: 'p-oud' });
  put('projects', { id: 'p-bob', name: 'Van Bob' });
  put('projects', { id: 'p-samen', name: 'Samen' });
  // Alice leest het project van Bob alleen; in Samen kan ze bewerken
  put('members', { id: 'm1', project_id: 'p-bob', user_id: 'u-bob', role: 'owner' });
  put('members', { id: 'm2', project_id: 'p-bob', user_id: ME, role: 'viewer' });
  put('members', { id: 'm3', project_id: 'p-samen', user_id: 'u-bob', role: 'owner' });
  put('members', { id: 'm4', project_id: 'p-samen', user_id: ME, role: 'member' });
  put('labels', { id: 'l-thuis', name: 'thuis', owner_id: ME });
  put('labels', { id: 'l-bob', name: 'werk', owner_id: 'u-bob' });
  put('filters', { id: 'f-1', name: 'Belangrijk', query: 'p1' });
  return v;
}

test('vier knoppen: Inbox, Vandaag, Aankomend en Bladeren (geen aparte knop Zoeken)', () => {
  assert.deepEqual(TABS, ['inbox', 'today', 'upcoming', 'browse']);
});

test('actieve knop: Inbox, Vandaag en Aankomend bij hun eigen scherm, al het andere hoort bij Bladeren', () => {
  const opts = { inboxId: INBOX };
  assert.equal(activeTab({ type: 'project', id: INBOX }, opts), 'inbox');
  assert.equal(activeTab({ type: 'today' }, opts), 'today');
  assert.equal(activeTab({ type: 'upcoming' }, opts), 'upcoming');
  for (const route of [
    { type: 'project', id: 'p-thuis' }, { type: 'filter', id: 'f-1' }, { type: 'label', id: 'l-thuis' }, { type: 'filters' }, { type: 'labels' },
    { type: 'completed' }, { type: 'completed', id: 'p-thuis' }, { type: 'notifications' }, { type: 'productivity' }, { type: 'activity', id: 'p-thuis' },
  ]) {
    assert.equal(activeTab(route, opts), 'browse', JSON.stringify(route));
  }
});

test('actieve knop: met het scherm Bladeren open is Bladeren actief, ook boven Vandaag of de Inbox', () => {
  assert.equal(activeTab({ type: 'today' }, { inboxId: INBOX, browseOpen: true }), 'browse');
  assert.equal(activeTab({ type: 'project', id: INBOX }, { inboxId: INBOX, browseOpen: true }), 'browse');
});

test('actieve knop: zolang de Inbox nog niet bekend is (eerste sync), telt een project als Bladeren; geen route geeft geen fout', () => {
  assert.equal(activeTab({ type: 'project', id: INBOX }, {}), 'browse');
  assert.equal(activeTab({ type: 'project', id: INBOX }, { inboxId: null }), 'browse');
  assert.equal(activeTab(undefined, { inboxId: INBOX }), 'browse');
});

test('de "+" voegt toe zoals de sneltoets q: in het project, vandaag in Vandaag, de Inbox in Aankomend en in een filter', () => {
  const view = sample();
  const at = (route) => fabTarget(route, { view, userId: ME, inboxId: INBOX });
  assert.deepEqual(at({ type: 'project', id: INBOX }), { projectId: INBOX });
  assert.deepEqual(at({ type: 'project', id: 'p-thuis' }), { projectId: 'p-thuis' });
  assert.deepEqual(at({ type: 'project', id: 'p-samen' }), { projectId: 'p-samen' }, 'een gedeeld project waarin je kunt bewerken');
  assert.deepEqual(at({ type: 'today' }), { due: 'today' });
  assert.deepEqual(at({ type: 'upcoming' }), {});
  assert.deepEqual(at({ type: 'filter', id: 'f-1' }), {});
});

test('de "+" in een label vult het label al in; bij een label van een ander gewoon in de Inbox', () => {
  const view = sample();
  assert.deepEqual(fabTarget({ type: 'label', id: 'l-thuis' }, { view, userId: ME, inboxId: INBOX }), { text: '@thuis ' });
  assert.deepEqual(fabTarget({ type: 'label', id: 'l-bob' }, { view, userId: ME, inboxId: INBOX }), {});
});

test('geen "+" waar je niets kunt toevoegen', () => {
  const view = sample();
  const at = (route, extra = {}) => fabTarget(route, { view, userId: ME, inboxId: INBOX, ...extra });
  assert.equal(at({ type: 'project', id: 'p-bob' }), null, 'een project dat je alleen leest');
  assert.equal(at({ type: 'project', id: 'p-oud' }), null, 'een gearchiveerd project');
  assert.equal(at({ type: 'project', id: 'p-oud-sub' }), null, 'een subproject van een gearchiveerd project');
  assert.equal(at({ type: 'project', id: 'p-weg' }), null, 'een project dat er niet meer is');
  assert.equal(at({ type: 'label', id: 'l-weg' }), null, 'een label dat er niet meer is');
  assert.equal(at({ type: 'filter', id: 'f-weg' }), null, 'een filter dat er niet meer is');
  for (const type of ['completed', 'notifications', 'productivity', 'activity', 'filters', 'labels', 'iets-nieuws']) assert.equal(at({ type }), null, type);
  assert.equal(at({ type: 'today' }, { browseOpen: true }), null, 'het scherm Bladeren staat open');
  assert.equal(at({ type: 'today' }, { selecting: true }), null, 'tijdens het selecteren staat de actiebalk onderaan');
  assert.equal(fabTarget({ type: 'today' }, { view, userId: null, inboxId: null }), null, 'nog niet ingelogd (geen Inbox)');
  assert.equal(fabTarget(null, { view, userId: ME, inboxId: INBOX }), null);
});

test('zonder bekende gebruiker beslist de server: een gedeeld project houdt dan de "+"', () => {
  const view = sample();
  assert.deepEqual(fabTarget({ type: 'project', id: 'p-bob' }, { view, userId: null, inboxId: INBOX }), { projectId: 'p-bob' });
});
