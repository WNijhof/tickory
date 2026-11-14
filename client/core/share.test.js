import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shareDraft, shareFromHash } from './share.js';

const hashOf = (obj) => `#share=${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')}`;

test('een link met paginatitel: titel is de paginatitel, de link de beschrijving', () => {
  assert.deepEqual(shareDraft({ title: 'Fietsroute Texel', text: 'https://example.org/route' }), { title: 'Fietsroute Texel', description: 'https://example.org/route' });
});

test('alleen tekst: eerste regel is de titel, de rest de beschrijving', () => {
  assert.deepEqual(shareDraft({ text: 'Bel de huisarts\nvraag naar de uitslag\nen de afspraak' }), { title: 'Bel de huisarts', description: 'vraag naar de uitslag\nen de afspraak' });
});

test('alleen een link: die is de titel', () => {
  assert.deepEqual(shareDraft({ text: 'https://example.org/x' }), { title: 'https://example.org/x', description: '' });
});

test('onderwerp gelijk aan de tekst wordt niet dubbel getoond', () => {
  assert.deepEqual(shareDraft({ title: 'Melk', text: 'Melk' }), { title: 'Melk', description: '' });
});

test('niets of alleen witruimte geeft null', () => {
  assert.equal(shareDraft({}), null);
  assert.equal(shareDraft({ title: ' \n', text: '\t' }), null);
  assert.equal(shareDraft(null), null);
  assert.equal(shareDraft({ title: 5, text: { a: 1 } }), null);
});

test('regeleinden in een onderwerp worden spaties; Windows-regeleinden en besturingstekens verdwijnen', () => {
  assert.equal(shareDraft({ title: 'a\nb\r\nc' }).title, 'a b c');
  assert.deepEqual(shareDraft({ text: 'één\r\ntwee\u0000\u0007' }), { title: 'één', description: 'twee' });
});

test('een te lange titel wordt ingekort op een woordgrens en alles gaat naar de beschrijving', () => {
  const long = `${'woord '.repeat(60)}einde`;
  const d = shareDraft({ title: long, text: 'https://example.org' });
  assert.ok(d.title.length <= 201 && d.title.endsWith('…'));
  assert.ok(!d.title.slice(0, -1).endsWith(' '));
  assert.ok(d.description.startsWith(long) && d.description.endsWith('https://example.org'));
});

test('inkorten breekt geen emoji doormidden', () => {
  const d = shareDraft({ title: `${'a'.repeat(199)}😀😀` });
  assert.doesNotMatch(d.title, /[\ud800-\udbff](?![\udc00-\udfff])/);
  assert.doesNotMatch(d.title, /(?<![\ud800-\udbff])[\udc00-\udfff]/);
});

test('de beschrijving is begrensd', () => {
  assert.equal(shareDraft({ title: 'x', text: 'y'.repeat(50_000) }).description.length, 16_000);
});

test('HTML blijft tekst (niets wordt omgezet)', () => {
  assert.equal(shareDraft({ title: '<img src=x onerror=alert(1)>' }).title, '<img src=x onerror=alert(1)>');
});

test('#share=… uit het webadres, met Nederlandse tekens en emoji', () => {
  const d = shareFromHash(hashOf({ title: 'Café “Ñandú” ☕ 😀', text: 'https://example.org/é' }));
  assert.deepEqual(d, { title: 'Café “Ñandú” ☕ 😀', description: 'https://example.org/é' });
});

test('onleesbare of vreemde fragmenten geven null en gooien niet', () => {
  for (const h of ['#share=', '#share=@@@', '#share=aGVsbG8', '#share=e30', '#share=W10', '#share=bnVsbA', '#task=abc12345', '#add', '', null, undefined, '#share=/etc/passwd', `#share=${'a'.repeat(100_001)}`]) {
    assert.equal(shareFromHash(h), null, String(h));
  }
});

test('ongeldige UTF-8 in het fragment wordt geweigerd', () => {
  assert.equal(shareFromHash(`#share=${Buffer.from([...Buffer.from('{"text":"ab'), 0xff, 0xfe, ...Buffer.from('cd"}')]).toString('base64url')}`), null);
});

test('het fragment moet het hele adres zijn: geen voorvoegsel, geen achtervoegsel', () => {
  const ok = Buffer.from(JSON.stringify({ title: 'x' })).toString('base64url');
  assert.deepEqual(shareFromHash(`#share=${ok}`), { title: 'x', description: '' });
  assert.equal(shareFromHash(`?a=1#share=${ok}`), null);
  assert.equal(shareFromHash(`#share=${ok}=`), null);
  assert.equal(shareFromHash(`#share=${ok}&x=1`), null);
});

test('inkorten gebeurt op een woordgrens: er blijft geen half woord staan', () => {
  const d = shareDraft({ title: 'abcdefghij '.repeat(40) });
  const words = d.title.slice(0, -1).split(' ');
  assert.ok(words.every((w) => w === 'abcdefghij'), d.title);
});
