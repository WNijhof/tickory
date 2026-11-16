// Tests voor de Markdown-parser (core/markdown.js): opmaak, Nederlandse tekst, veiligheid en rekentijd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INLINE, MAX_TEXT, parseInline, parseMarkdown, plainText, safeHref, toggleTask } from './markdown.js';

const text = (v) => ({ t: 'text', v });
const para = (...c) => [{ t: 'paragraph', c }];

test('gewone tekst blijft een alinea; regeleinden blijven regeleinden', () => {
  assert.deepEqual(parseMarkdown('Hallo wereld'), para(text('Hallo wereld')));
  assert.deepEqual(parseMarkdown('regel één\nregel twee'), para(text('regel één'), { t: 'br' }, text('regel twee')));
  assert.deepEqual(parseMarkdown('a\n\nb'), [...para(text('a')), ...para(text('b'))]);
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown(null), []);
  assert.deepEqual(parseMarkdown('a\r\nb'), para(text('a'), { t: 'br' }, text('b')));
});

test('vet, cursief, doorgehaald en code, ook genest', () => {
  assert.deepEqual(parseInline('**vet** en *cursief* en ~~weg~~ en `code`'), [
    { t: 'strong', c: [text('vet')] }, text(' en '), { t: 'em', c: [text('cursief')] }, text(' en '), { t: 'del', c: [text('weg')] }, text(' en '), { t: 'code', v: 'code' },
  ]);
  assert.deepEqual(parseInline('__vet__ _cursief_'), [{ t: 'strong', c: [text('vet')] }, text(' '), { t: 'em', c: [text('cursief')] }]);
  assert.deepEqual(parseInline('**vet met *cursief* erin**'), [{ t: 'strong', c: [text('vet met '), { t: 'em', c: [text('cursief')] }, text(' erin')] }]);
});

test('geen opmaak waar het geen opmaak is: spaties, snake_case, losse sterren, wiskunde', () => {
  assert.deepEqual(parseInline('2 * 3 * 4'), [text('2 * 3 * 4')]);
  assert.deepEqual(parseInline('een_snake_case_naam'), [text('een_snake_case_naam')]);
  assert.deepEqual(parseInline('**niet gesloten'), [text('**niet gesloten')]);
  assert.deepEqual(parseInline('* los *'), [text('* los *')]);
  assert.deepEqual(parseInline('`niet gesloten'), [text('`niet gesloten')]);
});

test('een backslash zet een teken letterlijk; code beschermt zijn inhoud', () => {
  assert.deepEqual(parseInline('\\*geen cursief\\*'), [text('*geen cursief*')]);
  assert.deepEqual(parseInline('`**niet vet**`'), [{ t: 'code', v: '**niet vet**' }]);
  assert.deepEqual(parseInline('``met ` erin``'), [{ t: 'code', v: 'met ` erin' }]);
  assert.deepEqual(parseInline('c:\\temp'), [text('c:\\temp')]);
});

test('Nederlandse tekst: accenten, ij, ë en emoji blijven heel', () => {
  assert.deepEqual(parseInline('**Éva** at *één* ijsje 🍦 met crème brûlée'), [
    { t: 'strong', c: [text('Éva')] }, text(' at '), { t: 'em', c: [text('één')] }, text(' ijsje 🍦 met crème brûlée'),
  ]);
  assert.deepEqual(parseInline('_één_ en ëën'), [{ t: 'em', c: [text('één')] }, text(' en ëën')]);
});

test('koppen, lijn en citaat', () => {
  assert.deepEqual(parseMarkdown('# Titel\n## Kleiner ##\n####### zeven'), [
    { t: 'heading', level: 1, c: [text('Titel')] }, { t: 'heading', level: 2, c: [text('Kleiner')] }, ...para(text('####### zeven')),
  ]);
  assert.deepEqual(parseMarkdown('boven\n\n---\n\nonder'), [...para(text('boven')), { t: 'rule' }, ...para(text('onder'))]);
  assert.deepEqual(parseMarkdown('> citaat\n> **vet**'), [{ t: 'quote', c: para(text('citaat'), { t: 'br' }, { t: 'strong', c: [text('vet')] }) }]);
  assert.deepEqual(parseMarkdown('#geen kop'), para(text('#geen kop')));
});

test('codeblok: inhoud blijft letterlijk, ook zonder sluiting', () => {
  assert.deepEqual(parseMarkdown('```js\nconst a = **1**;\n# geen kop\n```\nna'), [{ t: 'code', v: 'const a = **1**;\n# geen kop' }, ...para(text('na'))]);
  assert.deepEqual(parseMarkdown('```\nopen blok\nnog een regel'), [{ t: 'code', v: 'open blok\nnog een regel' }]);
});

test('lijsten: gewoon, genummerd, taken en genest', () => {
  assert.deepEqual(parseMarkdown('- een\n- twee'), [{ t: 'list', ordered: false, start: 1, items: [{ checked: null, c: [text('een')], children: [] }, { checked: null, c: [text('twee')], children: [] }] }]);
  const numbered = parseMarkdown('3. drie\n4. vier');
  assert.equal(numbered[0].ordered, true);
  assert.equal(numbered[0].start, 3);
  assert.equal(numbered[0].items.length, 2);
  const tasks = parseMarkdown('- [ ] open\n- [x] klaar\n- [X] ook klaar\n- [ ]geen taak');
  assert.deepEqual(tasks[0].items.map((x) => x.checked), [false, true, true, null]);
  const nested = parseMarkdown('- boven\n  - onder\n    - dieper\n- terug');
  assert.equal(nested[0].items.length, 2);
  assert.equal(nested[0].items[0].children[0].items[0].children[0].items[0].c[0].v, 'dieper');
  assert.equal(nested[0].items[1].c[0].v, 'terug');
});

test('een lijst met een vervolgregel en een lijst die eindigt voor een alinea', () => {
  const b = parseMarkdown('- een lang\n  punt\n\nlos');
  assert.deepEqual(b[0].items[0].c, [text('een lang'), { t: 'br' }, text('punt')]);
  assert.deepEqual(b[1], { t: 'paragraph', c: [text('los')] });
});

test('tabel met uitlijning, ontbrekende en extra cellen en een streep in een cel', () => {
  const [tbl] = parseMarkdown('| Naam | Aantal | Opmerking |\n|:--|--:|:-:|\n| appel | 3 |\n| peer \\| fruit | 4 | ok | extra |');
  assert.equal(tbl.t, 'table');
  assert.deepEqual(tbl.align, ['left', 'right', 'center']);
  assert.deepEqual(tbl.head.map((c) => c[0].v), ['Naam', 'Aantal', 'Opmerking']);
  assert.equal(tbl.rows.length, 2);
  assert.deepEqual(tbl.rows[0].map((c) => c[0]?.v ?? ''), ['appel', '3', '']);
  assert.deepEqual(tbl.rows[1].map((c) => c[0]?.v ?? ''), ['peer | fruit', '4', 'ok'], 'een extra cel valt weg');
  // zonder scheidingsregel is het geen tabel
  assert.equal(parseMarkdown('| a | b |\n| c | d |')[0].t, 'paragraph');
});

test('links: alleen http, https en mailto', () => {
  assert.deepEqual(parseInline('[Tickory](https://example.org/a?b=1)'), [{ t: 'link', href: 'https://example.org/a?b=1', c: [text('Tickory')] }]);
  assert.deepEqual(parseInline('[mail](mailto:iemand@example.org)'), [{ t: 'link', href: 'mailto:iemand@example.org', c: [text('mail')] }]);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', '//evil.example', '/pad', 'https://a b.nl']) {
    const nodes = parseInline(`[klik](${bad})`);
    assert.equal(nodes.some((n) => n.t === 'link' && n.c[0].v === 'klik'), false, `${bad} maakt van "klik" geen link`);
    assert.equal(nodes.some((n) => n.t === 'link' && !/^(https?:|mailto:)/.test(n.href)), false, 'wat er ook staat: nooit een ander soort adres');
    assert.equal(safeHref(bad), null);
  }
  // haakjes in het adres, losse webadressen en de punt erachter
  assert.equal(parseInline('[w](https://nl.wikipedia.org/wiki/Foo_(bar))')[0].href, 'https://nl.wikipedia.org/wiki/Foo_(bar)');
  const loose = parseInline('zie https://example.org/pad.');
  assert.deepEqual(loose.map((n) => n.href ?? n.v), ['zie ', 'https://example.org/pad', '.']);
  // een link in een link wordt gewone tekst
  assert.equal(parseInline('[a [b](https://x.nl) c](https://y.nl)').filter((n) => n.t === 'link').length >= 1, true);
});

test('HTML en scripts zijn gewone tekst', () => {
  const nodes = parseInline('<script>alert(1)</script> <img src=x onerror=alert(1)> &amp;');
  assert.equal(nodes.every((n) => n.t === 'text'), true);
  assert.equal(nodes.map((n) => n.v).join(''), '<script>alert(1)</script> <img src=x onerror=alert(1)> &amp;');
  assert.deepEqual(parseMarkdown('<div onclick="x()">hoi</div>'), para(text('<div onclick="x()">hoi</div>')));
  // afbeeldingen kennen we niet: de tekst blijft staan, het adres wordt niet geladen
  const img = parseInline('![alt](https://example.org/x.png)');
  assert.equal(img.some((n) => n.t === 'image'), false);
});

test('rekentijd: lange en pathologische invoer blijft snel', () => {
  const start = Date.now();
  parseMarkdown('*a '.repeat(5_000));
  parseMarkdown('**a_ '.repeat(3_000));
  parseMarkdown('[a]('.repeat(3_000));
  parseMarkdown('> '.repeat(500) + 'diep');
  parseMarkdown(`${'- '.repeat(300)}diep`);
  parseMarkdown('x'.repeat(500_000));
  parseMarkdown('| a | b |\n|-|-|\n'.concat('| 1 | 2 |\n'.repeat(5_000)));
  parseMarkdown('`'.repeat(10_000));
  assert.ok(Date.now() - start < 3_000, `duurde ${Date.now() - start} ms`);
  // boven de grens: gewone tekst met alleen de webadressen
  const long = `**vet** ${'a'.repeat(MAX_INLINE)} https://example.org`;
  const nodes = parseInline(long);
  assert.equal(nodes.some((n) => n.t === 'strong'), false);
  assert.equal(nodes.at(-1).href, 'https://example.org/');
});

test('te diep nesten wordt gewone tekst', () => {
  const deep = parseMarkdown('> '.repeat(20) + 'kern');
  let depth = 0;
  let node = deep[0];
  while (node?.t === 'quote') { depth++; node = node.c[0]; }
  assert.ok(depth <= 8, `nestdiepte ${depth}`);
  assert.equal(plainText('> '.repeat(20) + 'kern').includes('kern'), true);
});

test('plainText: de tekst zonder opmaaktekens op één regel', () => {
  assert.equal(plainText('# Titel\n\n**vet** en [link](https://x.nl)\n\n- [ ] punt\n- twee'), 'Titel vet en link punt twee');
  assert.equal(plainText('| a | b |\n|-|-|\n| 1 | 2 |'), 'a b 1 2');
  assert.equal(plainText('```\ncode\n```'), 'code');
  assert.equal(plainText(''), '');
});

test('adressen: datagegevens en spaties in een adres worden geweigerd', () => {
  assert.equal(safeHref('data:text/plain;base64,SGVsbG8='), null);
  assert.equal(safeHref('https://example.org/a b'), null, 'een adres met een spatie is geen adres');
  assert.equal(safeHref(' https://example.org/ '), 'https://example.org/', 'spaties eromheen mogen');
  assert.equal(safeHref(null), null);
});

test('een lage streep midden in een woord is geen cursief, ook niet aan het begin', () => {
  assert.deepEqual(parseInline('_a_b'), [text('_a_b')]);
  assert.deepEqual(parseInline('_a_ b'), [{ t: 'em', c: [text('a')] }, text(' b')]);
});

test('heel diep geneste opmaak veroorzaakt geen stapeloverloop en blijft ondiep', () => {
  const levels = 1500;
  const source = `${'**a*a'.repeat(levels)}${'a*a**'.repeat(levels)}`;
  assert.ok(source.length < MAX_INLINE);
  const nodes = parseInline(source);
  const depthOf = (list) => Math.max(0, ...list.map((n) => (n.c ? 1 + depthOf(n.c) : 0)));
  assert.ok(depthOf(nodes) <= 8, `diepte ${depthOf(nodes)}`);
});

test('de invoer wordt afgekapt op MAX_TEXT', () => {
  const nodes = parseMarkdown('x'.repeat(MAX_TEXT + 500));
  assert.equal(nodes[0].c.map((n) => n.v).join('').length, MAX_TEXT);
});

test('toggleTask: het juiste punt aan- en uitzetten, geen codeblokken, citaten wel', () => {
  const src = '- [ ] een\n```\n- [ ] in code\n```\n- [x] twee\n  - [ ] drie\n> - [ ] vier';
  assert.equal(toggleTask(src, 0), '- [x] een\n```\n- [ ] in code\n```\n- [x] twee\n  - [ ] drie\n> - [ ] vier');
  assert.equal(toggleTask(src, 1), '- [ ] een\n```\n- [ ] in code\n```\n- [ ] twee\n  - [ ] drie\n> - [ ] vier');
  assert.equal(toggleTask(src, 2), '- [ ] een\n```\n- [ ] in code\n```\n- [x] twee\n  - [x] drie\n> - [ ] vier');
  assert.equal(toggleTask(src, 3), '- [ ] een\n```\n- [ ] in code\n```\n- [x] twee\n  - [ ] drie\n> - [x] vier');
  assert.equal(toggleTask(src, 4), null);
  assert.equal(toggleTask('geen punten', 0), null);
  assert.equal(toggleTask('- [X] hoofdletter', 0), '- [ ] hoofdletter');
  // de volgorde klopt met de boom: het n-de punt met een vinkje in de parser
  const checks = [];
  const walk = (b) => { if (b.t === 'list') b.items.forEach((it) => { if (it.checked !== null) checks.push(it.checked); it.children.forEach(walk); }); if (b.t === 'quote') b.c.forEach(walk); };
  parseMarkdown(src).forEach(walk);
  assert.deepEqual(checks, [false, true, false, false]);
});

test('markeren en onderstrepen: ==geel==, een kleur, ++onderstreept++, en niet bij losse tekens', () => {
  assert.deepEqual(parseInline('==let op=='), [{ t: 'mark', color: 'yellow', c: [text('let op')] }]);
  assert.deepEqual(parseInline('=={green}groen=='), [{ t: 'mark', color: 'green', c: [text('groen')] }]);
  assert.deepEqual(parseInline('=={rood}geen kleur=='), [{ t: 'mark', color: 'yellow', c: [text('{rood}geen kleur')] }], 'een onbekende kleur is gewone tekst in een gele markering');
  assert.deepEqual(parseInline('++onder++'), [{ t: 'u', c: [text('onder')] }]);
  assert.deepEqual(parseInline('**==vet en geel==**'), [{ t: 'strong', c: [{ t: 'mark', color: 'yellow', c: [text('vet en geel')] }] }]);
  assert.deepEqual(parseInline('a == b en C++ of i++ ++'), [text('a == b en C++ of i++ ++')]);
  assert.deepEqual(parseInline(String.raw`\==geen\==`), [text('==geen==')], 'een backslash zet = letterlijk');
});
