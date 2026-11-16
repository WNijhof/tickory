// Markdown in een boom van gewone gegevens (geen scherm, nooit HTML). De interface (ui/markdown.js) maakt er knooppunten van met
// createElement en textContent; er gaat nooit tekst van een gebruiker als HTML het document in, en links zijn alleen http, https en
// mailto. Dit is bewust een kleine, voorspelbare deelverzameling, geen volledige CommonMark:
//
//   blokken:  # koppen (1-6), alinea's, > citaat, - * + lijsten (ook 1. genummerd en - [ ] / - [x] taken, genest door in te springen),
//             ``` code ```, --- lijn, tabellen (| a | b | met een regel |---|:---:|)
//   inline:   **vet** __vet__ *cursief* _cursief_ ~~doorgehaald~~ ++onderstreept++ ==gemarkeerd== (ook in een kleur: =={green}tekst==)
//             `code` [tekst](https://adres) en losse webadressen
//   regeleinden binnen een alinea blijven regeleinden; \* zet een teken letterlijk.
//
// Een lange of vreemd opgebouwde tekst kost nooit veel rekentijd: boven MAX_INLINE tekens per alinea (en bij te diep nesten) is de
// tekst gewone tekst met alleen herkende webadressen, en de totale invoer wordt afgekapt op MAX_TEXT.

import { linkify } from './commentText.js';

export const MAX_TEXT = 200_000;
export const MAX_INLINE = 20_000;
const MAX_DEPTH = 6;
const MAX_HREF = 2000;
const SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const PUNCT = /[\\`*_{}[\]()#+\-.!|~>=]/;

/** De kleuren van een markering (==tekst== is geel). */
export const HIGHLIGHTS = Object.freeze(['yellow', 'green', 'blue', 'pink', 'purple']);
const HIGHLIGHT_COLOR = /^\{(yellow|green|blue|pink|purple)\}/;

/** Het adres als het veilig is (http, https, mailto), anders null. */
export function safeHref(raw) {
  const url = String(raw ?? '').trim();
  if (!url || /[\s<>"]/u.test(url)) return null;
  try {
    const parsed = new URL(url);
    return SCHEMES.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

// ---------- inline ----------

const isSpace = (c) => c === undefined || /\s/u.test(c);
const isWord = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Gewone tekst met herkende webadressen als links. */
function plain(text) {
  return linkify(text).map((p) => (p.href ? { t: 'link', href: p.href, c: [{ t: 'text', v: p.text }] } : { t: 'text', v: p.text }));
}

/**
 * Een link die op `i` begint (`[tekst](adres)`): de plek van de sluitende ] en het eind (na de ")"), of null. In de tekst tellen
 * ontsnapte haken en codestukken niet mee; een niet-ontsnapte [ betekent: geen link. Haakjes in het adres mogen in paren.
 */
function linkAt(s, i) {
  if (s[i] !== '[') return null;
  let close = -1;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '`') {
      const run = /^`+/.exec(s.slice(j))[0];
      const end = s.indexOf(run, j + run.length);
      if (end !== -1) { j = end + run.length - 1; continue; }
      j += run.length - 1;
      continue;
    }
    if (s[j] === '[') return null;
    if (s[j] === ']') { close = j; break; }
  }
  if (close < 0 || s[close + 1] !== '(') return null;
  let level = 1;
  let end = close + 2;
  // een adres stopt bij witruimte of een haak, en is hooguit MAX_HREF tekens (zo blijft een lange rij "[](" snel)
  for (; end < s.length && level > 0 && end - close < MAX_HREF; end++) {
    if (s[end] === '(') level++;
    else if (s[end] === ')') level--;
    else if (/[\s[\]]/u.test(s[end])) return null;
  }
  if (level !== 0) return null;
  const href = safeHref(s.slice(close + 2, end - 1));
  const label = s.slice(i + 1, close);
  return href && label.trim() ? { close, end, href, label } : null;
}

/** Zoekt de sluiting van een opening op `from` (bij het begin van de inhoud): slaat codestukken, links en ontsnapte tekens over. */
function findClose(s, delim, from) {
  for (let j = from; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '[') {
      const link = linkAt(s, j);
      if (link) { j = link.end - 1; continue; }
    }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(j))[0];
      const end = s.indexOf(run, j + run.length);
      if (end === -1) continue;
      j = end + run.length - 1;
      continue;
    }
    // bij precies drie dezelfde tekens (***) sluit een dubbel teken met de laatste twee: het eerste hoort bij cursief erbinnen;
    // bij vier (====: een sluiting en meteen een nieuwe opening) sluit het met de eerste twee
    if (delim.length === 2 && s.startsWith(delim, j) && s[j + 2] === delim[0] && s[j + 3] !== delim[0]) continue;
    if (delim.length === 1 && s[j] === delim && s[j + 1] === delim) {
      // een reeks van twee of meer (*a **b** c*): een even reeks hoort bij iets anders; bij een oneven reeks (***) kan de laatste sluiten
      let run = 1;
      while (s[j + run] === delim) run++;
      j += run - 1;
      if (run % 2 === 0 || isSpace(s[j - run]) && run === 1) continue;
      if (delim === '_' && isWord(s[j + 1])) continue;
      return j;
    }
    if (s.startsWith(delim, j) && j > from && !isSpace(s[j - 1])) {
      if (delim[0] === '_' && isWord(s[j + delim.length])) continue; // snake_case blijft tekst
      return j;
    }
  }
  return -1;
}

/** Zet tekens uit de bron om in knooppunten. `depth` begrenst het nesten. */
export function parseInline(source, depth = 0) {
  const s = String(source ?? '');
  if (s.length > MAX_INLINE || depth > MAX_DEPTH) return plain(s);
  const out = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    out.push(...plain(buf));
    buf = '';
  };
  const push = (node) => { flush(); out.push(node); };
  // Heeft een teken vanaf een plek geen sluiting, dan vanaf een latere plek ook niet: dat onthouden houdt een lange rij losse tekens
  // ("*a *a *a …") lineair in plaats van kwadratisch.
  const noClose = new Map();
  const close = (delim, from) => {
    const known = noClose.get(delim);
    if (known !== undefined && from >= known) return -1;
    const at = findClose(s, delim, from);
    if (at < 0) noClose.set(delim, Math.min(known ?? Infinity, from));
    return at;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { buf += s[i + 1]; i++; continue; }
    if (ch === '\n') { push({ t: 'br' }); continue; }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(i))[0];
      const end = s.indexOf(run, i + run.length);
      if (end > i + run.length) {
        push({ t: 'code', v: s.slice(i + run.length, end).replace(/^ (.*) $/su, '$1') });
        i = end + run.length - 1;
        continue;
      }
      buf += run;
      i += run.length - 1;
      continue;
    }
    if (ch === '[') {
      const link = linkAt(s, i);
      if (link) {
        push({ t: 'link', href: link.href, c: parseInline(link.label, depth + 1).map((n) => (n.t === 'link' ? { t: 'text', v: n.c.map((x) => x.v).join('') } : n)) });
        i = link.end - 1;
        continue;
      }
    }
    const double = s.slice(i, i + 2);
    const kinds = { '**': 'strong', '__': 'strong', '~~': 'del', '++': 'u', '==': 'mark' };
    if (kinds[double]) {
      const color = double === '==' ? HIGHLIGHT_COLOR.exec(s.slice(i + 2, i + 12)) : null;
      const from = i + 2 + (color ? color[0].length : 0);
      if (!isSpace(s[from]) && !(double === '__' && isWord(s[i - 1]))) {
        const end = close(double, from);
        if (end > 0) {
          const node = { t: kinds[double], c: parseInline(s.slice(from, end), depth + 1) };
          if (double === '==') node.color = color ? color[1] : 'yellow';
          push(node);
          i = end + 1;
          continue;
        }
      }
    }
    if ((ch === '*' || ch === '_') && !isSpace(s[i + 1]) && !(ch === '_' && isWord(s[i - 1]))) {
      const end = close(ch, i + 1);
      if (end > 0) {
        push({ t: 'em', c: parseInline(s.slice(i + 1, end), depth + 1) });
        i = end;
        continue;
      }
    }
    buf += ch;
  }
  flush();
  return out;
}

// ---------- blokken ----------

const FENCE = /^ {0,3}(`{3,})[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

const indentOf = (ws) => [...ws].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);

/** Een regel van een tabel in cellen; `\|` is een letterlijke streep. */
function cells(line) {
  const text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const out = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') { cur += '|'; i++; continue; }
    if (text[i] === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += text[i];
  }
  out.push(cur.trim());
  return out;
}

const startsBlock = (line) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line);

/**
 * Markdown in blokken.
 * @returns {object[]} knooppunten: heading, paragraph, quote, list, code, rule en table (zie de kop van dit bestand)
 */
export function parseMarkdown(source, depth = 0) {
  const text = String(source ?? '').slice(0, MAX_TEXT).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[1]}\`*[ \\t]*$`).test(lines[i])) body.push(lines[i++]);
      i++; // de sluitende regel (ontbreekt die, dan loopt het blok tot het eind)
      blocks.push({ t: 'code', v: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'heading', level: heading[1].length, c: parseInline(heading[2], depth) });
      i++;
      continue;
    }
    if (RULE.test(line)) { blocks.push({ t: 'rule' }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])[1]);
      blocks.push({ t: 'quote', c: depth >= MAX_DEPTH ? [{ t: 'paragraph', c: plain(inner.join('\n')) }] : parseMarkdown(inner.join('\n'), depth + 1) });
      continue;
    }

    if (ITEM.test(line)) {
      const root = [];
      const stack = []; // { indent, list }
      let last = null;
      while (i < lines.length) {
        const cur = lines[i];
        const item = ITEM.exec(cur);
        if (!cur.trim()) {
          // een lege regel sluit de lijst, tenzij er nog een punt volgt
          let n = i + 1;
          while (n < lines.length && !lines[n].trim()) n++;
          if (n < lines.length && ITEM.test(lines[n]) && n - i <= 2) { i = n; continue; }
          break;
        }
        if (item) {
          const indent = indentOf(item[1]);
          while (stack.length > 0 && stack.at(-1).indent > indent) stack.pop();
          const ordered = /\d/.test(item[2]);
          if (stack.length === 0 || (stack.at(-1).indent < indent && last)) {
            if (stack.length >= MAX_DEPTH) { // te diep: als gewone regel in het vorige punt
              last.lines.push(item[3]);
              i++;
              continue;
            }
            const list = { t: 'list', ordered, start: ordered ? Number.parseInt(item[2], 10) : 1, items: [] };
            if (stack.length === 0) root.push(list);
            else last.children.push(list);
            stack.push({ indent, list });
          } else if (stack.at(-1).list.ordered !== ordered && stack.at(-1).indent === indent) {
            const list = { t: 'list', ordered, start: ordered ? Number.parseInt(item[2], 10) : 1, items: [] };
            root.push(list);
            stack[stack.length - 1] = { indent, list };
          }
          const task = TASK.exec(item[3]);
          last = { checked: task ? task[1] !== ' ' : null, lines: [task ? task[2] : item[3]], children: [] };
          stack.at(-1).list.items.push(last);
          i++;
          continue;
        }
        if (startsBlock(cur) || !last || indentOf(/^[ \t]*/.exec(cur)[0]) === 0) break;
        last.lines.push(cur.trim()); // een vervolgregel van het vorige punt
        i++;
      }
      const finish = (list) => ({
        t: 'list', ordered: list.ordered, start: list.start,
        items: list.items.map((it) => ({ checked: it.checked, c: parseInline(it.lines.join('\n'), depth), children: it.children.map(finish) })),
      });
      for (const list of root) blocks.push(finish(list));
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const sep = cells(lines[i + 1]);
      if (head.length === sep.length && head.length <= 30) {
        const align = sep.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|') && rows.length < 500) {
          const row = cells(lines[i++]);
          rows.push(head.map((_, k) => parseInline(row[k] ?? '', depth)));
        }
        blocks.push({ t: 'table', align, head: head.map((c) => parseInline(c, depth)), rows });
        continue;
      }
    }

    // alinea: tot een lege regel of het begin van een ander blok
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(lines[i].includes('|') && TABLE_SEP.test(lines[i + 1] ?? '') && lines[i].includes('|'))) para.push(lines[i++]);
    blocks.push({ t: 'paragraph', c: parseInline(para.map((l, k) => (k < para.length - 1 ? l.replace(/[ \t]+$/, '') : l.trim())).join('\n'), depth) });
  }
  return blocks;
}

// ---------- tekst zonder opmaak ----------

const inlineText = (nodes) => nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? ' ' : n.c ? inlineText(n.c) : '')).join('');

function blockText(b) {
  switch (b.t) {
    case 'heading': case 'paragraph': return inlineText(b.c);
    case 'code': return b.v;
    case 'quote': return b.c.map(blockText).join(' ');
    case 'list': return b.items.map((it) => `${inlineText(it.c)} ${it.children.map(blockText).join(' ')}`.trim()).join(' ');
    case 'table': return [b.head, ...b.rows].map((r) => r.map(inlineText).join(' ')).join(' ');
    default: return '';
  }
}

/** De tekst zonder opmaaktekens, op één regel (voor zoeken en voorbeelden). */
/** Tekens die opmaak kunnen zijn; zonder één ervan is een regel gewoon tekst (snel pad voor lange lijsten). */
const MARKUP = /[*_~=`[\\+<]|https?:\/\/|mailto:/i;
export const hasInlineMarkup = (source) => MARKUP.test(String(source ?? ''));

/** De tekst van één regel zonder opmaaktekens: "**Melk** halen" wordt "Melk halen" (voor schermlezers, titels van meldingen). */
export function inlinePlain(source) {
  const text = String(source ?? '');
  if (!hasInlineMarkup(text)) return text;
  const walk = (nodes) => nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? ' ' : n.c ? walk(n.c) : '')).join('');
  return walk(parseInline(text.slice(0, MAX_INLINE)));
}

export const plainText = (source) => parseMarkdown(source).map(blockText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

// ---------- taken afvinken in de tekst ----------

const TASK_LINE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\]([ \t])/;

/**
 * Zet het `index`-e taakpunt (`- [ ]`, in de volgorde van de tekst, codeblokken niet meegeteld) aan of uit.
 * @returns {string | null} de nieuwe tekst, of null als er zo'n punt niet is
 */
export function toggleTask(source, index) {
  const lines = String(source ?? '').split('\n');
  let n = 0;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (fence) {
      if (new RegExp(`^ {0,3}${fence}\`*[ \t]*$`).test(lines[i])) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const m = TASK_LINE.exec(lines[i]);
    if (!m) continue;
    if (n++ !== index) continue;
    lines[i] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${lines[i].slice(m[0].length - 1)}`;
    return lines.join('\n');
  }
  return null;
}
