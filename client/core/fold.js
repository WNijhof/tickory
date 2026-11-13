// Tekst vergelijkbaar maken voor zoeken: hoofdletter-, accent- en spatieongevoelig.
//
//   "Café", "CAFÉ", "cafe" en "Cafe\u0301" (met los accent) worden allemaal "cafe"; "ĳs" wordt "ijs"; meerdere spaties en
//   regeleinden worden één spatie. Dit is bewust ruimer dan nameKey() uit shared/text.js (dat accenten laat staan en voor namen
//   dient): hier gaat het om zoeken, niet om gelijkheid van namen.
//
// foldMap() geeft er ook bij welke plek in de oorspronkelijke tekst bij elk teken van het resultaat hoort, zodat een treffer
// in de gevouwen tekst weer als markering in de oorspronkelijke tekst getoond kan worden.

const ASCII = /^[\x00-\x7f]*$/;
const MARK = /\p{M}/gu;
const SPACE = /\s/u;

/** Eén teken (code point) gevouwen: ontleed (NFKD), accenten weg, kleine letters. */
function foldChar(ch) {
  return ch.normalize('NFKD').replace(MARK, '').toLowerCase();
}

/**
 * De gevouwen tekst en, per teken (UTF-16-eenheid) daarvan, waar het in het origineel begon en eindigde.
 * @returns {{ text: string, starts: number[], ends: number[] }}
 */
export function foldMap(source) {
  const s = String(source ?? '');
  let text = '';
  const starts = [];
  const ends = [];
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const from = i;
    i += ch.length;
    if (SPACE.test(ch)) {
      // een reeks witruimte wordt één spatie
      while (i < s.length) {
        const next = String.fromCodePoint(s.codePointAt(i));
        if (!SPACE.test(next)) break;
        i += next.length;
      }
      text += ' ';
      starts.push(from);
      ends.push(i);
      continue;
    }
    const folded = foldChar(ch);
    if (folded === '') {
      // een los accent: hoort bij het teken ervoor
      for (let k = ends.length - 1; k >= 0 && ends[k] === from; k--) ends[k] = i;
      continue;
    }
    for (let k = 0; k < folded.length; k++) {
      starts.push(from);
      ends.push(i);
    }
    text += folded;
  }
  return { text, starts, ends };
}

/** De gevouwen tekst (zie bovenaan). */
export function foldText(source) {
  const s = String(source ?? '');
  if (ASCII.test(s)) return s.toLowerCase().replace(/\s+/g, ' ');
  return foldMap(s).text;
}

// Rijen in de lokale toestand worden vervangen, nooit aangepast; daarom mag de gevouwen tekst per rij onthouden worden.
// Voor de zekerheid bewaren we de brontekst erbij: is die anders, dan rekenen we opnieuw.
const cache = new WeakMap();

/** De gevouwen waarde van een tekstveld van een rij (bijvoorbeeld `content` van een taak), onthouden per rij. */
export function foldedField(row, field) {
  const src = typeof row?.[field] === 'string' ? row[field] : '';
  if (!row || typeof row !== 'object') return foldText(src);
  let entry = cache.get(row);
  if (!entry) {
    entry = {};
    cache.set(row, entry);
  }
  const hit = entry[field];
  if (hit && hit.src === src) return hit.folded;
  const folded = foldText(src);
  entry[field] = { src, folded };
  return folded;
}

/** Splitst een zoektekst in unieke gevouwen woorden. */
export function foldWords(text, { maxWords = 12 } = {}) {
  const words = foldText(text).split(' ').filter(Boolean);
  return [...new Set(words)].slice(0, maxWords);
}

/** Alle plekken waar `word` in `folded` voorkomt, als [start, eind) in de gevouwen tekst. */
export function occurrences(folded, word) {
  const out = [];
  if (!word) return out;
  for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + word.length)) out.push([at, at + word.length]);
  return out;
}
