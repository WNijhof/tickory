// Tests voor het zoekveld (client/core/search.js) en het vouwen van tekst (client/core/fold.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from './reducer.js';
import { markSegments, search } from './search.js';
import { foldMap, foldText, foldWords, foldedField, occurrences } from './fold.js';

const ME = 'u-anna';
let n = 0;
const key = () => `k${String(++n).padStart(5, '0')}`;

function world(extra) {
  const v = emptyState();
  const put = (res, row) => v[res].set(row.id, { order_key: key(), ...row });
  put('projects', { id: 'p-thuis', name: 'Thuis' });
  put('projects', { id: 'p-tuin', name: 'Tuinieren', parent_id: 'p-thuis', color: 'green' });
  put('projects', { id: 'p-oud', name: 'Oud tuinproject', is_archived: true });
  put('sections', { id: 's-tuin', project_id: 'p-thuis', name: 'In de tuin' });
  put('sections', { id: 's-oud', project_id: 'p-oud', name: 'Tuin oud' });
  put('sections', { id: 's-arch', project_id: 'p-thuis', name: 'Tuin archief', is_archived: true });
  put('labels', { id: 'l-tuin', name: 'tuinwerk', owner_id: ME });
  put('labels', { id: 'l-ander', name: 'Tuinman', owner_id: 'u-bram' });
  put('filters', { id: 'f-tuin', name: 'Tuin deze week', query: 'deze week & #Tuinieren', owner_id: ME });
  put('filters', { id: 'f-ander', name: 'Tuin van een ander', query: 'p1', owner_id: 'u-bram' });
  extra?.(put);
  return v;
}
const task = (id, content, o = {}) => ({ id, project_id: 'p-thuis', section_id: null, parent_id: null, content, description: '', priority: 4, labels: [], due: null, checked: false, ...o });
const ids = (hits) => hits.map((h) => `${h.kind}:${h.id}`);

// ---------- fold ----------

test('fold: hoofdletters, accenten, ontleed getypt, spaties', () => {
  for (const s of ['Café', 'CAFÉ', 'cafe', 'Cafe\u0301', 'CAFE\u0301', 'cafÉ']) assert.equal(foldText(s), 'cafe', s);
  assert.equal(foldText('  Veel   spaties\n\tin  '), ' veel spaties in ');
  assert.equal(foldText('Zoë Ïjsselmeer'), 'zoe ijsselmeer');
  assert.equal(foldText('ĳs'), 'ijs');
  assert.equal(foldText('Straße'), 'straße');
  assert.equal(foldText(null), '');
  assert.equal(foldText(undefined), '');
  assert.equal(foldText(5), '5');
  assert.deepEqual(foldWords('  Tandarts  bellen  tandarts '), ['tandarts', 'bellen']);
  assert.deepEqual(foldWords(''), []);
  assert.deepEqual(foldWords('a b c d', { maxWords: 2 }), ['a', 'b']);
});

test('fold: foldMap geeft dezelfde tekst als foldText en wijst terug naar het origineel', () => {
  const samples = ['Café bezoeken', 'Cafe\u0301 bezoeken', 'a   b', 'ĳs en Zoë', '😀 smile é', 'x\u0301y', '', 'ÀÉÎ\u0308', 'tab\tnew\nline'];
  for (const s of samples) {
    const m = foldMap(s);
    assert.equal(m.text, foldText(s), JSON.stringify(s));
    assert.equal(m.starts.length, m.text.length);
    assert.equal(m.ends.length, m.text.length);
    for (let i = 0; i < m.text.length; i++) assert.ok(m.starts[i] >= 0 && m.ends[i] <= s.length && m.starts[i] < m.ends[i], `${s} @${i}`);
  }
  // "cafe" in "Cafe\u0301 bezoeken": het accent hoort bij de laatste e
  const m = foldMap('Cafe\u0301 bezoeken');
  assert.equal(m.starts[3], 3);
  assert.equal(m.ends[3], 5);
  // "ĳ" wordt "ij": beide tekens wijzen naar hetzelfde teken
  const ij = foldMap('ĳs');
  assert.deepEqual([ij.starts[0], ij.ends[0], ij.starts[1], ij.ends[1]], [0, 1, 0, 1]);
});

test('fold: een los accent aan het begin of tegen witruimte veroorzaakt geen fout', () => {
  assert.equal(foldText('\u0301abc'), 'abc');
  const lone = String.fromCharCode(0x301);
  assert.equal(foldText(` ${lone} `), foldMap(` ${lone} `).text);
  assert.deepEqual(foldMap('\u0301').text, '');
});

test('fold: occurrences vindt alle plekken zonder overlap en geeft niets bij een leeg woord', () => {
  assert.deepEqual(occurrences('aaaa', 'aa'), [[0, 2], [2, 4]]);
  assert.deepEqual(occurrences('abc', ''), []);
  assert.deepEqual(occurrences('abc', 'd'), []);
});

test('fold: foldedField onthoudt per rij, maar rekent opnieuw als de tekst verandert', () => {
  const row = { content: 'Café' };
  assert.equal(foldedField(row, 'content'), 'cafe');
  assert.equal(foldedField(row, 'content'), 'cafe');
  row.content = 'Thé';
  assert.equal(foldedField(row, 'content'), 'the');
  assert.equal(foldedField(row, 'description'), '');
  assert.equal(foldedField(null, 'content'), '');
});

// ---------- zoeken ----------

test('zoeken: een lege of lege-achtige zoekterm geeft niets', () => {
  const v = world((put) => put('projects', { id: 'p-x', name: 'x' }));
  for (const q of ['', '   ', '\n\t', null, undefined]) assert.deepEqual(search(v, q, { userId: ME }), [], JSON.stringify(q));
  assert.deepEqual(search(emptyState(), 'x'), []);
});

test('zoeken: volgorde: titel begint met > titel bevat > beschrijving/label; afgevinkt achteraan', () => {
  const v = world();
  for (const t of [
    task('t-contains', 'Afspraak tandarts maken'),
    task('t-starts', 'Tandarts bellen'),
    task('t-desc', 'Iets', { description: 'vraag het aan de tandarts' }),
    task('t-label', 'Boodschappen', { labels: ['l-tand'] }),
    task('t-done-starts', 'Tandarts betaald', { checked: true }),
    task('t-other', 'Melk'),
  ]) v.tasks.set(t.id, t);
  v.labels.set('l-tand', { id: 'l-tand', name: 'tandarts-lijst', owner_id: ME, order_key: key() });
  const hits = search(v, 'tandarts', { userId: ME });
  assert.deepEqual(ids(hits), ['label:l-tand', 'task:t-starts', 'task:t-contains', 'task:t-desc', 'task:t-label', 'task:t-done-starts']);
  assert.deepEqual(hits.map((h) => h.tier), [0, 0, 1, 2, 2, 0]);
  assert.deepEqual(hits.map((h) => h.checked), [false, false, false, false, false, true]);
});

test('zoeken: hoofdletters, accenten, ontleed getypt en spaties tellen niet mee', () => {
  const v = world();
  for (const t of [task('a', 'Café bezoeken'), task('b', 'CAFÉ DICHTBIJ'), task('c', 'Cafe\u0301 met Jan'), task('d', 'Naar het cafe'), task('e', 'Tuin')]) v.tasks.set(t.id, t);
  for (const q of ['café', 'CAFÉ', 'cafe', 'Cafe\u0301', '  cafe  ', 'CAFE\u0301']) {
    assert.deepEqual(ids(search(v, q, { userId: ME })).sort(), ['task:a', 'task:b', 'task:c', 'task:d'], JSON.stringify(q));
  }
});

test('zoeken: alle woorden moeten voorkomen, in willekeurige volgorde', () => {
  const v = world();
  for (const t of [task('a', 'Tandarts bellen'), task('b', 'Bellen met oma'), task('c', 'Tandarts', { description: 'bellen voor controle' }), task('d', 'Tandenborstel')]) v.tasks.set(t.id, t);
  assert.deepEqual(ids(search(v, 'bellen tandarts', { userId: ME })), ['task:a', 'task:c']);
  assert.deepEqual(ids(search(v, 'tandarts bellen', { userId: ME })), ['task:a', 'task:c']);
  assert.deepEqual(ids(search(v, 'tandarts bellen oma', { userId: ME })), []);
  assert.deepEqual(ids(search(v, 'tand', { userId: ME })), ['task:d', 'task:a', 'task:c'].sort((x, y) => ids(search(v, 'tand', { userId: ME })).indexOf(x) - ids(search(v, 'tand', { userId: ME })).indexOf(y)));
  assert.deepEqual(ids(search(v, 'tand', { userId: ME })).sort(), ['task:a', 'task:c', 'task:d']);
});

test('zoeken: een aaneengesloten zoektekst gaat voor, daarna de kortste titel', () => {
  const v = world();
  for (const t of [task('far', 'Tandarts voor oma bellen'), task('near', 'Bellen tandarts'), task('exact', 'Tandarts bellen'), task('long', 'Tandarts bellen voor een afspraak volgende week')]) v.tasks.set(t.id, t);
  assert.deepEqual(ids(search(v, 'tandarts bellen', { userId: ME })), ['task:exact', 'task:long', 'task:near', 'task:far']);
});

test('zoeken: projecten, secties, labels en filters; gearchiveerd en van een ander telt niet', () => {
  const v = world();
  v.tasks.set('t1', task('t1', 'Tuin harken', { project_id: 'p-tuin' }));
  v.tasks.set('t2', task('t2', 'Tuin oud', { project_id: 'p-oud' })); // gearchiveerd project
  const hits = search(v, 'tuin', { userId: ME });
  // klasse 0 (begint met): project, label, label van een ander, filter, taak; klasse 1 (bevat): sectie "In de tuin"
  assert.deepEqual(ids(hits), ['project:p-tuin', 'label:l-tuin', 'label:l-ander', 'filter:f-tuin', 'task:t1', 'section:s-tuin']);
  const byId = Object.fromEntries(hits.map((h) => [`${h.kind}:${h.id}`, h]));
  assert.equal(byId['project:p-tuin'].title, 'Tuinieren');
  assert.deepEqual(byId['project:p-tuin'].project, { id: 'p-thuis', name: 'Thuis' }, 'subproject: het bovenliggende project');
  assert.equal(byId['project:p-tuin'].color, 'green');
  assert.deepEqual(byId['section:s-tuin'].project, { id: 'p-thuis', name: 'Thuis' });
  assert.deepEqual(byId['task:t1'].project, { id: 'p-tuin', name: 'Tuinieren' });
  assert.equal(byId['label:l-tuin'].project, null);
  assert.equal(byId['label:l-ander'].foreign, true, 'label van een ander: alleen lezen');
  assert.equal(byId['label:l-tuin'].foreign, undefined);
  assert.ok(!byId['filter:f-ander'], 'filter van een ander');
  assert.ok(!byId['project:p-oud'] && !byId['section:s-oud'] && !byId['task:t2'] && !byId['section:s-arch'], 'gearchiveerd');
  // een eigen label gaat voor het label van een ander, bij gelijke klasse
  assert.ok(ids(hits).indexOf('label:l-tuin') < ids(hits).indexOf('label:l-ander'));
});

test('zoeken: een project met een treffer in de beschrijving, een filter op de filtertekst', () => {
  const v = world((put) => {
    put('projects', { id: 'p-b', name: 'Boekhouding', description: 'alles over de belasting' });
    put('filters', { id: 'f-b', name: 'Mijn lijst', query: 'p1 & belasting', owner_id: ME });
  });
  const hits = search(v, 'belasting', { userId: ME });
  assert.deepEqual(ids(hits), ['project:p-b', 'filter:f-b']);
  assert.deepEqual(hits.map((h) => h.where), ['description', 'description']);
  assert.equal(hits[1].text, 'p1 & belasting');
});

test('zoeken: markeringen wijzen de gevonden plek aan in de oorspronkelijke tekst', () => {
  const v = world();
  v.tasks.set('a', task('a', 'CAFÉ dichtbij'));
  v.tasks.set('b', task('b', 'Bij Cafe\u0301 Rood om 8 uur'));
  v.tasks.set('c', task('c', 'Tandarts bellen'));
  v.tasks.set('d', task('d', 'Bel de tandarts, en de tandarts weer'));
  const by = (q) => Object.fromEntries(search(v, q, { userId: ME }).map((h) => [h.id, h]));
  const a = by('cafe').a;
  assert.equal(a.where, 'title');
  assert.deepEqual(a.marks, [{ start: 0, length: 4 }]);
  assert.equal(a.text.slice(0, 4), 'CAFÉ');
  const b = by('cafe').b;
  assert.deepEqual(b.marks, [{ start: 4, length: 5 }], 'de e met los accent hoort bij de markering');
  assert.equal(b.text.slice(4, 9), 'Cafe\u0301');
  assert.deepEqual(by('tandarts bellen').c.marks, [{ start: 0, length: 8 }, { start: 9, length: 6 }]);
  assert.deepEqual(by('tandarts').d.marks.map((m) => m.start), [7, 23]);
  assert.deepEqual(by('bel tandarts').c.marks, [{ start: 0, length: 8 }, { start: 9, length: 3 }], 'twee woorden, elk gemarkeerd');
  // overlappende en aansluitende woorden worden samengevoegd
  assert.deepEqual(by('tand tandarts').c.marks, [{ start: 0, length: 8 }]);
  assert.deepEqual(by('dichtbij café').a.marks, [{ start: 0, length: 4 }, { start: 5, length: 8 }]);
});

test('zoeken: een treffer in de beschrijving of een label toont die plek', () => {
  const v = world();
  const long = `${'Dit is een lange beschrijving met allerlei tekst. '.repeat(4)}En dan het woord Tandarts hier.\nNog een regel erna met meer tekst om af te kappen. ${'x'.repeat(100)}`;
  v.tasks.set('d', task('d', 'Iets', { description: long }));
  v.tasks.set('s', task('s', 'Kort', { description: 'bel de tandarts' }));
  v.tasks.set('l', task('l', 'Boodschappen', { labels: ['l-tuin'] }));
  const by = (q) => Object.fromEntries(search(v, q, { userId: ME }).map((h) => [`${h.kind}:${h.id}`, h]));
  const d = by('tandarts')['task:d'];
  assert.equal(d.where, 'description');
  assert.equal(d.title, 'Iets');
  assert.ok(d.text.startsWith('…') && d.text.endsWith('…'), d.text);
  assert.ok(!d.text.includes('\n'));
  assert.ok(d.text.length <= 102);
  assert.equal(d.marks.length, 1);
  assert.equal(d.text.slice(d.marks[0].start, d.marks[0].start + d.marks[0].length), 'Tandarts');
  const s = by('tandarts')['task:s'];
  assert.deepEqual([s.where, s.text, s.marks], ['description', 'bel de tandarts', [{ start: 7, length: 8 }]]);
  const l = by('tuinwerk')['task:l'];
  assert.deepEqual([l.where, l.text, l.tier, l.title], ['label', 'tuinwerk', 2, 'Boodschappen']);
  assert.deepEqual(l.marks, [{ start: 0, length: 8 }]);
  // een label van een ander op de taak telt ook mee
  v.tasks.set('f', task('f', 'Gedeeld', { labels: ['l-ander'] }));
  assert.equal(by('tuinman')['task:f'].where, 'label');
  // woorden verspreid: de ene in de titel, de andere in de beschrijving
  v.tasks.set('m', task('m', 'Bellen', { description: 'over de rekening' }));
  const m = by('bellen rekening')['task:m'];
  assert.deepEqual([m.tier, m.where, m.text], [2, 'description', 'over de rekening']);
  assert.deepEqual(m.marks, [{ start: 8, length: 8 }]);
});

test('zoeken: taken tonen hun project, datum en prioriteit', () => {
  const v = world();
  v.tasks.set('a', task('a', 'Gras maaien', { project_id: 'p-tuin', priority: 2, due: { date: '2026-11-12' } }));
  const [hit] = search(v, 'gras', { userId: ME });
  assert.deepEqual(hit, {
    kind: 'task', id: 'a', title: 'Gras maaien', project: { id: 'p-tuin', name: 'Tuinieren' }, checked: false, tier: 0, where: 'title',
    text: 'Gras maaien', marks: [{ start: 0, length: 4 }], color: null, due: { date: '2026-11-12' }, priority: 2,
  });
  v.tasks.set('b', task('b', 'Los', { project_id: 'p-weg' }));
  assert.equal(search(v, 'los')[0].project, null);
});

test('zoeken: limit, en standaard 50', () => {
  const v = world();
  for (let i = 0; i < 80; i++) v.tasks.set(`t${i}`, task(`t${i}`, `Taak ${String(i).padStart(2, '0')}`));
  assert.equal(search(v, 'taak').length, 50);
  assert.equal(search(v, 'taak', { limit: 5 }).length, 5);
  assert.equal(search(v, 'taak', { limit: 500 }).length, 80);
  assert.equal(search(v, 'taak', { limit: 100000 }).length, 80);
  assert.equal(search(v, 'taak', { limit: 0 }).length, 1, 'minstens één');
  assert.equal(search(v, 'taak', { limit: 'x' }).length, 1);
  assert.deepEqual(search(v, 'taak', { limit: 3 }).map((h) => h.id), ['t0', 't1', 't2']);
});

test('zoeken: de volgorde is vast, ook bij gelijke titels', () => {
  const v = world();
  for (const id of ['z', 'a', 'm']) v.tasks.set(id, task(id, 'Dubbel'));
  assert.deepEqual(search(v, 'dubbel').map((h) => h.id), ['a', 'm', 'z']);
});

test('zoeken: een zeer lange zoektekst en vreemde tekens geven geen fout', () => {
  const v = world();
  v.tasks.set('a', task('a', 'x'));
  assert.ok(Array.isArray(search(v, 'x '.repeat(5000))));
  for (const q of ['(', ')', '\\', '[', '*', '.*', '😀', '\u0000', '\ud800', '#', '@', '$&']) assert.ok(Array.isArray(search(v, q)), q);
  assert.deepEqual(ids(search(v, 'x')), ['task:a']);
});

test('zoeken: willekeurige zoektermen geven geldige markeringen', () => {
  let s = 5;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pieces = ['Café', 'cafe\u0301', 'ÉÉN', 'één', 'tand', 'arts', ' ', '  ', 'ĳs', '😀', 'Zoë', 'x\u0301', 'a', 'b'];
  const v = world();
  const text = () => Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => pieces[Math.floor(rnd() * pieces.length)]).join(rnd() < 0.5 ? '' : ' ');
  for (let i = 0; i < 150; i++) v.tasks.set(`t${i}`, task(`t${i}`, text(), { description: text() }));
  let total = 0;
  for (let i = 0; i < 200; i++) {
    const q = text();
    const words = foldWords(q);
    for (const h of search(v, q, { limit: 500 })) {
      total++;
      let last = 0;
      for (const m of h.marks) {
        assert.ok(m.start >= last && m.length > 0 && m.start + m.length <= h.text.length, JSON.stringify([q, h.text, h.marks]));
        const folded = foldText(h.text.slice(m.start, m.start + m.length));
        assert.ok(words.some((w) => folded.includes(w)), `${JSON.stringify(h.text.slice(m.start, m.start + m.length))} bevat geen van ${words}`);
        last = m.start + m.length;
      }
      if (h.tier <= 1) assert.ok(h.marks.length > 0, `tier ${h.tier} zonder markering: ${JSON.stringify([q, h.text])}`);
    }
  }
  assert.ok(total > 200, `genoeg treffers (${total})`);
});

test('zoeken: markeringen die in elkaar liggen worden één, en een stuk beschrijving bevat alleen treffers die erin passen', () => {
  const v = world();
  v.tasks.set('a', task('a', 'abcdef'));
  assert.deepEqual(search(v, 'abcdef cd')[0].marks, [{ start: 0, length: 6 }]);
  assert.deepEqual(search(v, 'cd abcdef')[0].marks, [{ start: 0, length: 6 }]);
  assert.deepEqual(search(v, 'ab bc')[0].marks, [{ start: 0, length: 3 }], 'overlappend: één markering');
  assert.deepEqual(search(v, 'ab cd')[0].marks, [{ start: 0, length: 4 }], 'aansluitend: één markering');
  assert.deepEqual(search(v, 'ab ef')[0].marks, [{ start: 0, length: 2 }, { start: 4, length: 2 }], 'met ruimte ertussen: twee');
  const description = `tandarts aan het begin${' en dan weer een heleboel tekst'.repeat(12)} en tandarts aan het eind`;
  v.tasks.set('d', task('d', 'Iets', { description }));
  const d = search(v, 'tandarts')[0];
  assert.equal(d.where, 'description');
  assert.equal(d.marks.length, 1, 'de tweede treffer valt buiten het stuk');
  assert.ok(d.marks.every((m) => m.start + m.length <= d.text.length));
});

test('zoeken: een zoektekst langer dan 200 tekens wordt afgekapt', () => {
  const v = world();
  v.tasks.set('a', task('a', 'a'.repeat(200)));
  assert.equal(search(v, `${'a'.repeat(200)} zzz`).length, 1);
  assert.equal(search(v, `${'a'.repeat(150)} zzz`).length, 0, 'onder de grens telt het laatste woord wel');
});

test('zoeken: 10.000 taken in redelijke tijd', (t) => {
  const v = world();
  const words = ['melk', 'brood', 'tandarts', 'café', 'bellen', 'tuin', 'belasting', 'fiets'];
  for (let i = 0; i < 10_000; i++) v.tasks.set(`t${i}`, task(`t${i}`, `${words[i % 8]} ${words[(i * 7) % 8]} ${i}`, { description: i % 3 ? '' : `over ${words[(i * 3) % 8]}`, checked: i % 10 === 0 }));
  search(v, 'melk'); // opwarmen
  for (const q of ['melk', 'cafe brood', 'tandarts bellen 77', 'zzz']) {
    const t0 = performance.now();
    const hits = search(v, q, { userId: ME });
    const ms = performance.now() - t0;
    t.diagnostic(`${ms.toFixed(1)} ms voor "${q}": ${hits.length} treffers`);
    assert.ok(ms < 1500, `te traag: ${ms.toFixed(0)} ms`);
  }
});

// ---------- opmerkingen en markeringen tonen ----------

const comment = (id, content, o = {}) => ({ id, task_id: null, project_id: null, content, author_id: ME, created_at: '2026-11-01T10:00:00Z', ...o });

test('zoeken: een opmerking bij een taak of project wordt gevonden, na de taken, met een stuk tekst en waar ze bij hoort', () => {
  const v = world((put) => {
    put('tasks', task('t-tand', 'Tandarts bellen'));
    put('tasks', task('t-ander', 'Iets anders'));
    put('comments', comment('c1', 'De praktijk van de tandarts is dicht op maandag', { task_id: 't-ander' }));
    put('comments', comment('c2', 'Offerte voor de tandarts nog opvragen', { project_id: 'p-tuin' }));
    put('comments', comment('c3', 'Niets over dit onderwerp', { task_id: 't-tand' }));
  });
  const hits = search(v, 'TANDARTS', { userId: ME });
  assert.deepEqual(ids(hits), ['task:t-tand', 'comment:c2', 'comment:c1'], 'eerst de taak, dan de opmerkingen (kortste eerst)');
  const [, c2, c1] = hits;
  assert.equal(c1.where, 'comment');
  assert.deepEqual(c1.on, { kind: 'task', id: 't-ander', name: 'Iets anders' });
  assert.deepEqual(c1.project, { id: 'p-thuis', name: 'Thuis' });
  assert.deepEqual(c2.on, { kind: 'project', id: 'p-tuin', name: 'Tuinieren' });
  assert.deepEqual(c2.project, { id: 'p-tuin', name: 'Tuinieren' });
  // de markering ligt in de getoonde tekst, niet in de oorspronkelijke
  assert.deepEqual(markSegments(c1.text, c1.marks).filter((s) => s.mark).map((s) => s.text), ['tandarts']);
  // alle woorden moeten in dezelfde opmerking staan
  assert.deepEqual(ids(search(v, 'tandarts maandag')).filter((x) => x.startsWith('comment')), ['comment:c1']);
  assert.deepEqual(ids(search(v, 'tandarts onderwerp')).filter((x) => x.startsWith('comment')), [], 'twee opmerkingen samen tellen niet');
});

test('zoeken: opmerkingen bij een gearchiveerd project of een verdwenen taak doen niet mee, en bij een afgevinkte taak staan ze achteraan', () => {
  const v = world((put) => {
    put('tasks', task('t-oud', 'Oude klus', { project_id: 'p-oud' }));
    put('tasks', task('t-af', 'Klaar', { checked: true }));
    put('tasks', task('t-open', 'Open'));
    put('comments', comment('c-oud', 'wachtwoord wifi', { task_id: 't-oud' }));
    put('comments', comment('c-proj', 'wachtwoord wifi', { project_id: 'p-oud' }));
    put('comments', comment('c-weg', 'wachtwoord wifi', { task_id: 't-bestaat-niet' }));
    put('comments', comment('c-af', 'wachtwoord wifi', { task_id: 't-af' }));
    put('comments', comment('c-open', 'wachtwoord wifi', { task_id: 't-open' }));
  });
  assert.deepEqual(ids(search(v, 'wachtwoord')), ['comment:c-open', 'comment:c-af']);
  assert.equal(search(v, 'wachtwoord')[1].checked, true);
});

test('zoeken: accenten en hoofdletters gelden ook in opmerkingen, en een view zonder opmerkingen werkt gewoon', () => {
  const v = world((put) => {
    put('tasks', task('t1', 'Reservering'));
    put('comments', comment('c1', 'Café "De Gouden Leeuw" is gesloten', { task_id: 't1' }));
  });
  assert.deepEqual(ids(search(v, 'CAFÉ gouden')), ['comment:c1']);
  const without = world();
  delete without.comments;
  assert.deepEqual(ids(search(without, 'tuin')).length > 0, true);
});

test('zoeken: een opmerking komt na een taak waarvan de beschrijving het woord bevat, ook al past de opmerking beter', () => {
  const v = world((put) => {
    put('tasks', task('t-beschrijving', 'Iets anders', { description: 'de wifi hapert' }));
    put('tasks', task('t-ouder', 'Ander werk'));
    put('comments', comment('c-wifi', 'wifi', { task_id: 't-ouder' })); // de opmerking is precies het woord: sterkere treffer dan een beschrijving
  });
  assert.deepEqual(ids(search(v, 'wifi')), ['task:t-beschrijving', 'comment:c-wifi'], 'taken eerst, daarna de opmerkingen');
});

test('markSegments: stukken tekst met en zonder markering, zonder lege stukken', () => {
  assert.deepEqual(markSegments('abc', [{ start: 1 }]), [{ text: 'abc', mark: false }], 'een markering zonder lengte telt niet');
  assert.deepEqual(markSegments('Tandarts bellen', [{ start: 0, length: 8 }]), [{ text: 'Tandarts', mark: true }, { text: ' bellen', mark: false }]);
  assert.deepEqual(markSegments('abc', []), [{ text: 'abc', mark: false }]);
  assert.deepEqual(markSegments('abc', [{ start: 0, length: 3 }]), [{ text: 'abc', mark: true }]);
  assert.deepEqual(markSegments('', [{ start: 0, length: 2 }]), []);
  assert.deepEqual(markSegments(null, null), []);
  // een markering die over een eerdere heen ligt wordt ingekort; een markering voorbij het einde ook; lengte 0 telt niet
  assert.deepEqual(markSegments('abcdef', [{ start: 1, length: 3 }, { start: 2, length: 3 }, { start: 5, length: 9 }, { start: 0, length: 0 }]),
    [{ text: 'a', mark: false }, { text: 'bcd', mark: true }, { text: 'e', mark: true }, { text: 'f', mark: true }]);
  // met accenten uit zoeken: de stukken samen zijn weer de hele tekst
  const text = 'Café Zoë café';
  const hit = search(world((put) => put('tasks', task('t', text))), 'cafe').find((h) => h.kind === 'task');
  const segments = markSegments(hit.text, hit.marks);
  assert.equal(segments.map((s) => s.text).join(''), text);
  assert.deepEqual(segments.filter((s) => s.mark).map((s) => s.text), ['Café', 'café']);
});
