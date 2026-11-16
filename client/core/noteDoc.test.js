// Tests voor het document van een notitie (core/noteDoc.js): Markdown heen en terug, opmaak, bewerkingen en checklists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backspaceAtStart, cardRows, checkedFolds, checklistCounts, deleteAtEnd, deleteChecked, deleteRange, fromMarkdown, hasMark, indent,
  insertBlocks, insertText, normalizeRuns, runsToMd, runsText, setMark, setType, sliceRuns, splitBlock, toMarkdown, toggleCheck, toggleMark,
  uncheckAll, wordCount,
} from './noteDoc.js';
import { parseMarkdown, plainText } from './markdown.js';

const p = (text, more = {}) => ({ type: 'p', level: 0, runs: text ? [{ text, ...more }] : [] });
const check = (text, checked = false, level = 0) => ({ type: 'check', level, checked, runs: [{ text }] });
const texts = (blocks) => blocks.map((b) => (b.type === 'check' ? `${b.checked ? 'x' : 'o'}${'.'.repeat(b.level)}${runsText(b.runs)}` : runsText(b.runs)));
const roundTrip = (md) => toMarkdown(fromMarkdown(md));

test('Markdown heen en terug: elke soort regel blijft gelijk', () => {
  const md = [
    '# Reis naar IJsland',
    '## Voorbereiden',
    '### Kleiner',
    'Gewone regel met **vet**, _cursief_, ++onder++, ~~weg~~, ==geel==, =={green}groen== en `code`.',
    'Een [link](https://example.org/a_b) en een regel.',
    '',
    '- punt',
    '  - dieper',
    '- [ ] open taak',
    '- [x] klaar',
    '  - [ ] subtaak',
    '1. een',
    '2. twee',
    '  1. genest',
    '> citaat',
    '---',
    '```',
    'const a = **1**;',
    '# geen kop',
    '```',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    'einde',
  ].join('\n');
  assert.equal(roundTrip(md), md);
  assert.equal(roundTrip(roundTrip(md)), md);
});

test('blokken: de soorten en het inspringen', () => {
  const blocks = fromMarkdown('# Kop\n- a\n  - b\n    - c\n- [x] taak\n3. nummer\n> citaat\n\nlos');
  assert.deepEqual(blocks.map((b) => [b.type, b.level]), [['h1', 0], ['bullet', 0], ['bullet', 1], ['bullet', 2], ['check', 0], ['number', 0], ['quote', 0], ['p', 0], ['p', 0]]);
  assert.equal(blocks[4].checked, true);
  assert.deepEqual(fromMarkdown('#### diep'), [{ type: 'h3', level: 0, runs: [{ text: 'diep' }] }], 'kop 4 tot 6 wordt kop 3');
  assert.deepEqual(fromMarkdown(''), [p('')]);
  assert.deepEqual(fromMarkdown('a\n\n\n'), [p('a')], 'lege regels aan het eind vallen weg');
});

test('lege regels tussen alinea\'s blijven, en een vervolgregel hoort bij het punt', () => {
  assert.equal(roundTrip('a\n\n\nb'), 'a\n\n\nb');
  const item = fromMarkdown('- een lang\n  punt\nlos');
  assert.deepEqual(item.map((b) => [b.type, runsText(b.runs)]), [['bullet', 'een lang\npunt'], ['p', 'los']]);
  assert.equal(toMarkdown(item), '- een lang\n  punt\nlos');
});

test('tekens die anders opmaak worden, blijven tekst', () => {
  const cases = ['2 * 3 * 4', 'een_snake_case_naam', '_rand_', 'C++ en i++', 'a == b', '[geen link]', '`backtick`', 'pad\\naar', '~~niet~~', '# geen kop', '- geen punt', '1. geen nummer', '> geen citaat', '---', '| geen tabel'];
  for (const text of cases) {
    const md = toMarkdown([p(text)]);
    const back = fromMarkdown(md);
    assert.equal(back.length, 1, `${text} → ${md}`);
    assert.equal(back[0].type, 'p', `${text} → ${md}`);
    assert.equal(runsText(back[0].runs), text, `${text} → ${md}`);
    assert.deepEqual(back[0].runs.map((r) => Object.keys(r)), [['text']], `${text}: zonder opmaak (${md})`);
    assert.equal(plainText(md), text, `ook de gewone lezer ziet "${text}" (${md})`);
  }
});

test('opmaak met spaties aan de rand komt goed terug (de spatie gaat buiten de opmaak)', () => {
  const runs = [{ text: 'hallo ' }, { text: ' vet ', b: true }, { text: 'en ' }, { text: 'schuin', i: true }];
  const md = runsToMd(runs);
  assert.equal(md, 'hallo  **vet** en _schuin_');
  const back = fromMarkdown(md)[0].runs;
  assert.deepEqual(back, [{ text: 'hallo  ' }, { text: 'vet', b: true }, { text: ' en ' }, { text: 'schuin', i: true }]);
});

test('geneste opmaak, cursief midden in een woord en code met backticks', () => {
  const runs = [{ text: 'a', b: true }, { text: 'b', b: true, i: true }, { text: 'c', b: true }];
  assert.deepEqual(fromMarkdown(runsToMd(runs))[0].runs, runs);
  const word = [{ text: 'on' }, { text: 'der', i: true }, { text: 'woord' }];
  assert.deepEqual(fromMarkdown(runsToMd(word))[0].runs, word);
  const code = [{ text: 'a `b` c', code: true }];
  assert.deepEqual(fromMarkdown(runsToMd(code))[0].runs, code);
  const colors = [{ text: 'roze', hl: 'pink' }, { text: ' en ' }, { text: 'geel', hl: 'yellow', b: true }];
  assert.deepEqual(fromMarkdown(runsToMd(colors))[0].runs, colors);
  const link = [{ text: 'Wiki ', link: 'https://nl.wikipedia.org/wiki/Foo_(bar)' }, { text: 'vet', b: true, link: 'https://nl.wikipedia.org/wiki/Foo_(bar)' }];
  const back = fromMarkdown(runsToMd(link))[0].runs;
  assert.equal(runsText(back), 'Wiki vet');
  assert.ok(back.every((r) => r.link?.startsWith('https://nl.wikipedia.org/wiki/Foo_')), JSON.stringify(back));
});

test('een onveilige link wordt nooit een link, ook niet via het document', () => {
  const md = toMarkdown([{ type: 'p', level: 0, runs: [{ text: 'klik', link: 'javascript:alert(1)' }] }]);
  assert.equal(fromMarkdown(md)[0].runs.some((r) => r.link), false, md);
});

test('Nederlandse tekst en emoji blijven heel, ook met opmaak', () => {
  const runs = [{ text: 'Één ' }, { text: 'crème brûlée', b: true }, { text: ' bij café 🍰 ' }, { text: 'IJsland', hl: 'blue' }];
  assert.deepEqual(fromMarkdown(runsToMd(runs))[0].runs, runs);
});

test('runs: knippen, invoegen met de opmaak ervoor, samenvoegen', () => {
  const runs = [{ text: 'ab' }, { text: 'cd', b: true }, { text: 'ef' }];
  assert.deepEqual(sliceRuns(runs, 1, 5), [{ text: 'b' }, { text: 'cd', b: true }, { text: 'e' }]);
  assert.deepEqual(insertText(runs, 3, 'X'), [{ text: 'ab' }, { text: 'cXd', b: true }, { text: 'ef' }]);
  assert.deepEqual(insertText(runs, 4, 'X'), [{ text: 'ab' }, { text: 'cdX', b: true }, { text: 'ef' }], 'aan het eind van vet: ook vet');
  assert.deepEqual(insertText(runs, 0, 'X'), [{ text: 'Xab' }, { text: 'cd', b: true }, { text: 'ef' }]);
  assert.deepEqual(insertText([], 0, 'hoi'), [{ text: 'hoi' }]);
  assert.deepEqual(normalizeRuns([{ text: 'a', b: true }, { text: '' }, { text: 'b', b: true }]), [{ text: 'ab', b: true }]);
});

test('opmaak aan en uit; code haalt andere opmaak weg; markeren met een kleur', () => {
  let runs = [{ text: 'hallo wereld' }];
  runs = toggleMark(runs, 0, 5, 'b');
  assert.deepEqual(runs, [{ text: 'hallo', b: true }, { text: ' wereld' }]);
  assert.equal(hasMark(runs, 0, 5, 'b'), true);
  assert.equal(hasMark(runs, 0, 7, 'b'), false);
  assert.equal(hasMark(runs, 3, 3, 'b'), true, 'een lege keuze kijkt naar het teken ervoor');
  runs = toggleMark(runs, 0, 7, 'b');
  assert.deepEqual(runs, [{ text: 'hallo w', b: true }, { text: 'ereld' }], 'niet alles vet: alles vet');
  runs = toggleMark(runs, 0, 7, 'b');
  assert.deepEqual(runs, [{ text: 'hallo wereld' }], 'alles vet: uit');
  runs = setMark(toggleMark(runs, 0, 5, 'i'), 0, 12, 'code', true);
  assert.deepEqual(runs, [{ text: 'hallo wereld', code: true }]);
  runs = toggleMark([{ text: 'abc' }], 0, 3, 'hl', 'green');
  assert.deepEqual(runs, [{ text: 'abc', hl: 'green' }]);
  assert.deepEqual(toggleMark(runs, 0, 3, 'hl', 'pink'), [{ text: 'abc', hl: 'pink' }], 'een andere kleur vervangt');
  assert.deepEqual(toggleMark(runs, 0, 3, 'hl', 'green'), [{ text: 'abc' }], 'dezelfde kleur haalt weg');
});

test('Enter: splitsen, een lijst gaat door, een leeg punt stopt de lijst, een taak begint open', () => {
  let r = splitBlock([p('hallo wereld')], 0, 5);
  assert.deepEqual(texts(r.blocks), ['hallo', ' wereld']);
  assert.deepEqual([r.index, r.offset], [1, 0]);
  r = splitBlock([check('melk', true, 1)], 0, 4);
  assert.deepEqual(r.blocks.map((b) => [b.type, b.level, b.checked]), [['check', 1, true], ['check', 1, false]]);
  r = splitBlock([check('', false, 1)], 0, 0);
  assert.deepEqual(r.blocks.map((b) => [b.type, b.level]), [['check', 0]], 'leeg punt: eerst een niveau terug');
  r = splitBlock(r.blocks, 0, 0);
  assert.deepEqual(r.blocks.map((b) => b.type), ['p'], 'dan een gewone regel');
  r = splitBlock([{ type: 'h1', level: 0, runs: [{ text: 'Kop' }] }], 0, 3);
  assert.deepEqual(r.blocks.map((b) => b.type), ['h1', 'p'], 'na een kop: een gewone regel');
  r = splitBlock([{ type: 'h1', level: 0, runs: [{ text: 'Kop' }] }], 0, 0);
  assert.deepEqual(r.blocks.map((b) => [b.type, runsText(b.runs)]), [['p', ''], ['h1', 'Kop']], 'aan het begin van een kop: erboven een lege regel');
  r = splitBlock([{ type: 'p', level: 0, runs: [{ text: 'ab', b: true }] }], 0, 1);
  assert.deepEqual(r.blocks.map((b) => b.runs), [[{ text: 'a', b: true }], [{ text: 'b', b: true }]], 'de opmaak gaat mee');
});

test('Backspace aan het begin: terug, gewone regel, samenvoegen; Delete aan het eind', () => {
  const blocks = [p('boven'), { type: 'bullet', level: 1, runs: [{ text: 'punt' }] }];
  let r = backspaceAtStart(blocks, 1);
  assert.deepEqual(r.blocks[1].level, 0);
  r = backspaceAtStart(r.blocks, 1);
  assert.equal(r.blocks[1].type, 'p');
  r = backspaceAtStart(r.blocks, 1);
  assert.deepEqual(texts(r.blocks), ['bovenpunt']);
  assert.deepEqual([r.index, r.offset], [0, 5]);
  assert.equal(backspaceAtStart([p('a')], 0), null);
  r = backspaceAtStart([p('a'), { type: 'rule', level: 0, runs: [] }, p('b')], 2);
  assert.deepEqual(r.blocks.map((b) => b.type), ['p', 'p'], 'een lijn erboven verdwijnt');
  r = deleteAtEnd([p('a'), check('b')], 0);
  assert.deepEqual(r.blocks.map((b) => [b.type, runsText(b.runs)]), [['p', 'ab']]);
  assert.equal(deleteAtEnd([p('a')], 0), null);
});

test('een stuk wissen over blokken heen, en plakken van meerdere regels', () => {
  const blocks = [p('eerste regel'), check('midden'), p('laatste regel')];
  const r = deleteRange(blocks, { index: 2, offset: 4 }, { index: 0, offset: 6 });
  assert.deepEqual(texts(r.blocks), ['eersteste regel'], '"eerste" + "ste regel"');
  assert.deepEqual([r.index, r.offset], [0, 6]);
  const pasted = insertBlocks([p('ab')], 0, 1, fromMarkdown('- een\n- twee'));
  assert.deepEqual(pasted.blocks.map((b) => [b.type, runsText(b.runs)]), [['p', 'a'], ['bullet', 'een'], ['bullet', 'twee'], ['p', 'b']]);
  assert.deepEqual([pasted.index, pasted.offset], [2, 4]);
  const inline = insertBlocks([p('ab')], 0, 1, [p('XY')]);
  assert.deepEqual([texts(inline.blocks), inline.offset], [['aXYb'], 3]);
});

test('soort wijzigen en inspringen', () => {
  let blocks = setType([p('tekst')], 0, 'check');
  assert.deepEqual(blocks[0], { type: 'check', level: 0, checked: false, runs: [{ text: 'tekst' }] });
  blocks = setType(blocks, 0, 'code');
  assert.deepEqual(blocks[0].runs, [{ text: 'tekst' }]);
  blocks = [check('a'), check('b')];
  assert.equal(indent(blocks, 1, 1)[1].level, 1);
  assert.equal(indent(indent(blocks, 1, 1), 1, 1)[1].level, 1, 'niet verder dan één dieper dan het punt erboven');
  assert.equal(indent(blocks, 0, 1)[0].level, 0, 'het eerste punt springt niet in');
  assert.equal(indent([p('x')], 0, 1)[0].level, 0, 'een gewone regel springt niet in');
});

test('afvinken: naar het afgevinkte deel onderaan, met subpunten; weer open: onderaan het open deel', () => {
  let blocks = [p('Boodschappen'), check('melk'), check('brood'), check('kaas', false, 0), check('jong', false, 1), check('eieren', true), p('na')];
  let r = toggleCheck(blocks, 3); // kaas (met subpunt jong) afvinken
  assert.deepEqual(texts(r.blocks), ['Boodschappen', 'omelk', 'obrood', 'xkaas', 'o.jong', 'xeieren', 'na']);
  assert.equal(r.index, 3);
  r = toggleCheck(r.blocks, 1); // melk afvinken: bovenaan het afgevinkte deel
  assert.deepEqual(texts(r.blocks), ['Boodschappen', 'obrood', 'xmelk', 'xkaas', 'o.jong', 'xeieren', 'na']);
  assert.equal(r.index, 2);
  r = toggleCheck(r.blocks, 5); // eieren weer open: onderaan het open deel
  assert.deepEqual(texts(r.blocks), ['Boodschappen', 'obrood', 'oeieren', 'xmelk', 'xkaas', 'o.jong', 'na']);
  assert.equal(r.index, 2);
  r = toggleCheck(r.blocks, 5); // een subpunt sorteert binnen zijn punt
  assert.deepEqual(texts(r.blocks).slice(4, 6), ['xkaas', 'x.jong']);
  const still = toggleCheck([check('a'), check('b')], 0, { sort: false });
  assert.deepEqual(texts(still.blocks), ['xa', 'ob'], 'zonder sorteren blijft alles staan');
  assert.deepEqual(toggleCheck([p('x')], 0).blocks, [p('x')]);
});

test('inklappen: het afgevinkte deel onderaan elke lijst, met het aantal', () => {
  const blocks = [check('a'), check('b', true), check('sub', true, 1), check('c', true), p('tussen'), check('d', true), check('e', true), check('f')];
  assert.deepEqual(checkedFolds(blocks), [{ start: 1, end: 4, count: 2, all: false }]);
  assert.deepEqual(checkedFolds([check('x', true), check('y', true)]), [{ start: 0, end: 2, count: 2, all: true }]);
  assert.deepEqual(checkedFolds([check('x'), check('y')]), []);
});

test('alles uitvinken, afgevinkte verwijderen (met subpunten) en tellen', () => {
  const blocks = [check('a', true), check('sub', false, 1), check('b'), p('x')];
  assert.deepEqual(checklistCounts(blocks), { items: 3, checked: 1 });
  assert.deepEqual(texts(uncheckAll(blocks)), ['oa', 'o.sub', 'ob', 'x']);
  assert.deepEqual(texts(deleteChecked(blocks)), ['ob', 'x']);
  assert.deepEqual(deleteChecked([check('a', true)]), [p('')]);
});

test('woorden tellen', () => {
  assert.equal(wordCount(fromMarkdown('# Zes dagen\n- [ ] één twee\nhet is 4×4 en café-bezoek')), 9);
  assert.equal(wordCount(fromMarkdown('')), 0);
});

test('kaart: lege regels weg, afgevinkte punten samengevat, code drie regels, hooguit zoveel regels', () => {
  const blocks = fromMarkdown('Lijst\n\n- [ ] melk\n- [x] brood\n- [x] kaas\n```\n1\n2\n3\n4\n```\n- [x] a\n- [x] b\n---\neinde');
  const { rows, cut } = cardRows(blocks, 10);
  assert.deepEqual(rows.map((r) => (r.type === 'done' ? `done:${r.count}:${r.all}` : `${r.type}:${runsText(r.runs)}`)), ['p:Lijst', 'check:melk', 'done:2:false', 'code:1\n2\n3', 'done:2:true', 'p:einde']);
  assert.equal(rows[3].cutCode, true);
  assert.equal(cut, false);
  assert.equal(cardRows(blocks, 2).cut, true);
  assert.equal(cardRows(blocks, 2).rows.length, 2);
});

test('wat de editor bewaart, leest de gewone Markdown-lezer net zo (kaartvoorbeeld, zoeken)', () => {
  const md = toMarkdown(fromMarkdown('- [ ] melk\n- [x] brood\n**Doel:** sparen'));
  const tree = parseMarkdown(md);
  assert.equal(tree[0].t, 'list');
  assert.deepEqual(tree[0].items.map((x) => x.checked), [false, true]);
  assert.equal(plainText(md), 'melk brood Doel: sparen');
});

test('losse sterretjes en lage strepen in gewone tekst blijven tekst', () => {
  for (const text of ['a*b*c', '*nadruk*', '**geen vet**', 'x_y_z', '_a_', '~~niet~~', '==niet==', '++niet++']) {
    const back = fromMarkdown(toMarkdown([p(text)]));
    assert.deepEqual(back[0].runs, [{ text }], `${text} → ${toMarkdown([p(text)])}`);
  }
});

test('cursief midden in een woord direct voor vet: de schrijver kiest een schrijfwijze die precies terugkomt (geen ***)', () => {
  const runs = [{ text: 'a' }, { text: 'b', i: true }, { text: 'c', b: true }];
  const md = runsToMd(runs);
  assert.equal(md.includes('***'), false, md);
  assert.deepEqual(fromMarkdown(md)[0].runs, runs, md);
});
