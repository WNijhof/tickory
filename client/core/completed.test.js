// Het overzicht Voltooid: welke taken erin horen, de volgorde, het groeperen per dag (ook in andere tijdzones), zoeken, en vlot blijven bij
// duizenden voltooide taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from './reducer.js';
import { completedDay, completedGroups, completedProjects, completedTasks, completedTime } from './completed.js';

const ME = 'user-anna';
let n = 0;

/** Een toestand met projecten en leden; `tasks` zijn korte beschrijvingen. */
function viewWith(projects, tasks) {
  const v = emptyState();
  for (const p of projects) {
    v.projects.set(p.id, { id: p.id, name: p.name, parent_id: p.parent_id ?? null, is_archived: Boolean(p.is_archived), color: 'charcoal' });
    v.members.set(`m-${p.id}`, { id: `m-${p.id}`, project_id: p.id, user_id: ME, role: 'owner' });
  }
  for (const t of tasks) {
    v.tasks.set(t.id, {
      id: t.id, project_id: t.project, parent_id: t.parent ?? null, section_id: null, content: t.content ?? t.id, description: t.description ?? '',
      checked: t.checked ?? true, completed_at: t.at ?? null, priority: 4, labels: [], due: null, order_key: `a${++n}`,
    });
  }
  return v;
}

test('alleen afgevinkte taken, nieuwste eerst; bij gelijke tijd op id', () => {
  const v = viewWith([{ id: 'p1', name: 'Thuis' }], [
    { id: 't-oud', project: 'p1', at: '2026-11-10T08:00:00.000Z' },
    { id: 't-nieuw', project: 'p1', at: '2026-11-13T08:00:00.000Z' },
    { id: 't-open', project: 'p1', checked: false },
    { id: 't-gelijk-b', project: 'p1', at: '2026-11-12T08:00:00.000Z' },
    { id: 't-gelijk-a', project: 'p1', at: '2026-11-12T08:00:00.000Z' },
    { id: 't-zonder', project: 'p1', at: null },
  ]);
  assert.deepEqual(completedTasks(v).map((t) => t.id), ['t-nieuw', 't-gelijk-a', 't-gelijk-b', 't-oud', 't-zonder']);
});

test('gearchiveerde projecten (en alles eronder), projecten waar je geen lid van bent en verdwenen projecten tellen niet mee', () => {
  const v = viewWith([{ id: 'p1', name: 'Thuis' }, { id: 'pa', name: 'Oud', is_archived: true }, { id: 'pb', name: 'Onder oud', parent_id: 'pa' }, { id: 'px', name: 'Van een ander' }], [
    { id: 'a', project: 'p1', at: '2026-11-13T08:00:00.000Z' },
    { id: 'b', project: 'pa', at: '2026-11-13T08:00:00.000Z' },
    { id: 'c', project: 'pb', at: '2026-11-13T08:00:00.000Z' },
    { id: 'd', project: 'px', at: '2026-11-13T08:00:00.000Z' },
    { id: 'e', project: 'bestaat-niet', at: '2026-11-13T08:00:00.000Z' },
  ]);
  v.members.delete('m-px'); // je bent er geen lid meer van, maar de rij is er nog
  assert.deepEqual(completedTasks(v, { userId: ME }).map((t) => t.id), ['a']);
  assert.deepEqual(completedProjects(v, { userId: ME }).map((x) => [x.project.id, x.count]), [['p1', 1]]);
});

test('een subtaak die met haar ouder is afgevinkt staat er niet apart; een subtaak van een open taak wel', () => {
  const v = viewWith([{ id: 'p1', name: 'Thuis' }], [
    { id: 'ouder', project: 'p1', at: '2026-11-13T08:00:00.000Z' },
    { id: 'kind', project: 'p1', parent: 'ouder', at: '2026-11-13T08:00:00.000Z' },
    { id: 'open-ouder', project: 'p1', checked: false },
    { id: 'los-kind', project: 'p1', parent: 'open-ouder', at: '2026-11-12T08:00:00.000Z' },
  ]);
  assert.deepEqual(completedTasks(v).map((t) => t.id), ['ouder', 'los-kind']);
});

test('filter op project en zoeken: hoofdletters en accenten maken niet uit, titel en beschrijving tellen', () => {
  const v = viewWith([{ id: 'p1', name: 'Thuis' }, { id: 'p2', name: 'Werk' }], [
    { id: 'a', project: 'p1', content: 'Café reserveren', at: '2026-11-13T08:00:00.000Z' },
    { id: 'b', project: 'p2', content: 'CAFÉ-rapport', at: '2026-11-12T08:00:00.000Z' },
    { id: 'c', project: 'p1', content: 'Boodschappen', description: 'bij de crème-winkel', at: '2026-11-11T08:00:00.000Z' },
  ]);
  assert.deepEqual(completedTasks(v, { query: 'cafe' }).map((t) => t.id), ['a', 'b']);
  assert.deepEqual(completedTasks(v, { query: 'café', projectId: 'p2' }).map((t) => t.id), ['b']);
  assert.deepEqual(completedTasks(v, { query: 'CREME' }).map((t) => t.id), ['c']);
  assert.deepEqual(completedTasks(v, { query: 'zzz' }), []);
  assert.deepEqual(completedProjects(v).map((x) => [x.project.id, x.count]), [['p1', 2], ['p2', 1]]);
});

test('groeperen per dag van afvinken met een grens; "Meer tonen" geeft de volgende', () => {
  const v = viewWith([{ id: 'p1', name: 'Thuis' }], Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, project: 'p1', at: `2026-11-${String(13 - Math.floor(i / 3)).padStart(2, '0')}T${String(8 + (i % 3)).padStart(2, '0')}:00:00.000Z` })));
  const all = completedTasks(v);
  const first = completedGroups(all, { limit: 4 });
  assert.equal(first.shown, 4);
  assert.equal(first.total, 7);
  assert.equal(first.groups.length, 2);
  assert.deepEqual(first.groups.map((g) => g.tasks.length), [3, 1]);
  const more = completedGroups(all, { limit: 8 });
  assert.equal(more.shown, 7);
  assert.deepEqual(more.groups.map((g) => g.tasks.length), [3, 3, 1]);
  assert.equal(completedGroups([], { limit: 5 }).groups.length, 0);
  assert.equal(completedGroups([{ id: 'x', completed_at: null }], { limit: 5 }).groups[0].day, null, 'zonder tijdstip: dag onbekend');
});

// ---------- tijdzones ----------
// Het tijdstip van afvinken komt van de server als UTC; de dag waarop de gebruiker afvinkte is de dag in de tijdzone van zijn apparaat.

function inZone(zone, fn) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (before === undefined) Reflect.deleteProperty(process.env, 'TZ');
    else process.env.TZ = before;
  }
}

test('de dag van afvinken volgt de tijdzone van het apparaat, en de uitkomst is voor elk tijdstip in elke zone gelijk aan een rekensom met de verschuiving', () => {
  // 23:30 UTC op 12 november: in Amsterdam al 13 november, in Los Angeles nog 12 november, in Auckland 13 november (12:30)
  const at = '2026-11-12T23:30:00.000Z';
  assert.equal(inZone('UTC', () => completedDay(at)), '2026-11-12');
  assert.equal(inZone('Europe/Amsterdam', () => completedDay(at)), '2026-11-13');
  assert.equal(inZone('America/Los_Angeles', () => completedDay(at)), '2026-11-12');
  assert.equal(inZone('Pacific/Auckland', () => completedDay(at)), '2026-11-13');
  assert.equal(inZone('Europe/Amsterdam', () => completedTime(at)), '00:30');
  assert.equal(inZone('America/Los_Angeles', () => completedTime(at)), '15:30');
  // de overgang naar zomertijd (29 maart 2026, 01:00 UTC): 00:59 UTC is nog wintertijd (01:59), 01:00 UTC al zomertijd (03:00)
  assert.equal(inZone('Europe/Amsterdam', () => completedTime('2026-03-29T00:59:00.000Z')), '01:59');
  assert.equal(inZone('Europe/Amsterdam', () => completedTime('2026-03-29T01:00:00.000Z')), '03:00');
  // een taak om 23:30 UTC staat in Amsterdam onder de volgende dag
  const v = viewWith([{ id: 'p1', name: 'Thuis' }], [{ id: 'a', project: 'p1', at }, { id: 'b', project: 'p1', at: '2026-11-12T10:00:00.000Z' }]);
  const days = (zone) => inZone(zone, () => completedGroups(completedTasks(v)).groups.map((g) => [g.day, g.tasks.map((t) => t.id)]));
  assert.deepEqual(days('UTC'), [['2026-11-12', ['a', 'b']]]);
  assert.deepEqual(days('Europe/Amsterdam'), [['2026-11-13', ['a']], ['2026-11-12', ['b']]]);
  assert.equal(completedDay('geen datum'), null);
  assert.equal(completedDay(null), null);
});

test('vijfduizend voltooide taken: filteren, zoeken en groeperen blijft vlot', () => {
  const v = viewWith([{ id: 'p1', name: 'Thuis' }, { id: 'p2', name: 'Werk' }], Array.from({ length: 5000 }, (_, i) => ({
    id: `t${i}`, project: i % 2 ? 'p1' : 'p2', content: `Taak ${i} café`, at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
  })));
  const started = performance.now();
  const all = completedTasks(v, { userId: ME });
  const found = completedTasks(v, { query: 'taak 49', userId: ME });
  const shown = completedGroups(all, { limit: 100 });
  const elapsed = performance.now() - started;
  assert.equal(all.length, 5000);
  assert.ok(found.length > 0 && found.length < 5000);
  assert.equal(shown.shown, 100);
  assert.equal(all[0].id, 't4999', 'nieuwste eerst');
  assert.ok(elapsed < 500, `te traag: ${Math.round(elapsed)} ms`);
});
