// De emoji-kiezer zonder scherm (core/emoji.js): de lijst, zoeken in beide talen, de laatst gebruikte, en invoegen bij de cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_EMOJI, EMOJI_GROUPS, MAX_RECENT, emojiName, insertAtCaret, recentEmoji, rememberEmoji, searchEmoji } from './emoji.js';

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

test('de lijst: elke emoji een keer, met een Nederlandse en een Engelse naam', () => {
  assert.ok(EMOJI_GROUPS.length >= 8);
  const chars = ALL_EMOJI.map((e) => e.char);
  assert.equal(new Set(chars).size, chars.length, 'geen dubbele');
  for (const e of ALL_EMOJI) assert.ok(e.nl && e.en, e.char);
});

test('zoeken: in het Nederlands en het Engels, zonder accenten of hoofdletters; eerst wat ermee begint', () => {
  assert.equal(searchEmoji('koffie')[0].char, '☕');
  assert.equal(searchEmoji('Coffee')[0].char, '☕');
  assert.equal(searchEmoji('duim')[0].char, '👍');
  assert.ok(searchEmoji('hart').length >= 8, 'alle harten');
  assert.equal(searchEmoji('medaille')[0].char, '🥇');
  assert.deepEqual(searchEmoji(''), []);
  assert.deepEqual(searchEmoji('zzzqqq'), []);
});

test('namen voor een schermlezer in de taal van de app', () => {
  assert.equal(emojiName('🎉', 'nl'), 'feestje');
  assert.equal(emojiName('🎉', 'en'), 'party popper');
  assert.equal(emojiName('🦄', 'nl'), '');
});

test('de laatst gebruikte: nieuwste eerst, geen dubbele, hooguit zestien; kapotte opslag is leeg', () => {
  const s = memory();
  rememberEmoji('👍', s);
  rememberEmoji('🎉', s);
  rememberEmoji('👍', s);
  assert.deepEqual(recentEmoji(s), ['👍', '🎉']);
  for (const e of ALL_EMOJI.slice(0, 30)) rememberEmoji(e.char, s);
  assert.equal(recentEmoji(s).length, MAX_RECENT);
  const broken = { getItem: () => '{kapot', setItem: () => {} };
  assert.deepEqual(recentEmoji(broken), []);
  assert.deepEqual(recentEmoji({ getItem: () => JSON.stringify(['🦄', '👍', 3]) }), ['👍'], 'alleen bekende emoji');
});

test('invoegen bij de cursor, of in plaats van de selectie', () => {
  const field = { value: 'Goed gedaan!', selectionStart: 4, selectionEnd: 4, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } };
  insertAtCaret(field, ' 👏');
  assert.equal(field.value, 'Goed 👏 gedaan!');
  assert.equal(field.selectionStart, 'Goed 👏'.length, 'de cursor erachter');
  const sel = { value: 'Hoi daar', selectionStart: 4, selectionEnd: 8, setSelectionRange() {} };
  insertAtCaret(sel, '👋');
  assert.equal(sel.value, 'Hoi 👋');
  const none = { value: 'Klaar', selectionStart: null, selectionEnd: null };
  insertAtCaret(none, ' ✅');
  assert.equal(none.value, 'Klaar ✅');
});
