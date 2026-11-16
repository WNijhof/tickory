// Het document van een notitie als regels met opmaak, voor de editor (ui/noteEditor.js) en de kaarten (ui/notes.js). Geen scherm.
//
// Een notitie wordt bewaard als Markdown (core/markdown.js leest dat ook), maar de editor werkt met blokken: één blok per regel,
// zoals in Anchor. Een blok is
//   { type: 'p' | 'h1' | 'h2' | 'h3' | 'bullet' | 'number' | 'check' | 'quote' | 'code' | 'table' | 'rule', level, checked?, runs }
// waarbij `level` (0-5) het inspringen van een lijstpunt is en `runs` de tekst met opmaak:
//   { text, b?, i?, u?, s?, code?, hl?: 'yellow' | 'green' | 'blue' | 'pink' | 'purple', link?: 'https://…' }
// Een codeblok en een tabel hebben één run met de letterlijke tekst (met regeleinden). Een lege regel is een leeg 'p'-blok.
//
// fromMarkdown(toMarkdown(blokken)) geeft dezelfde blokken terug (de tests controleren dat); wat hier wordt bewaard, is gewone
// Markdown die elke andere app ook leest.

import { HIGHLIGHTS, parseInline, safeHref } from './markdown.js';

export const BLOCK_TYPES = Object.freeze(['p', 'h1', 'h2', 'h3', 'bullet', 'number', 'check', 'quote', 'code', 'table', 'rule']);
export const LIST_TYPES = Object.freeze(['bullet', 'number', 'check']);
export const MAX_LEVEL = 5;
const MARKS = ['hl', 'b', 'i', 'u', 's']; // van buiten naar binnen; code zit altijd binnenin
const RAW = new Set(['code', 'table']);

export const isList = (b) => LIST_TYPES.includes(b?.type);
export const isRaw = (b) => RAW.has(b?.type);

// ---------- runs ----------

const markKey = (r) => `${r.hl ?? ''}|${r.b ? 1 : 0}${r.i ? 1 : 0}${r.u ? 1 : 0}${r.s ? 1 : 0}${r.code ? 1 : 0}|${r.link ?? ''}`;
const marksOf = (r) => {
  const out = {};
  for (const m of ['b', 'i', 'u', 's', 'code']) if (r[m]) out[m] = true;
  if (r.hl) out.hl = r.hl;
  if (r.link) out.link = r.link;
  return out;
};

/** Voegt naast elkaar liggende runs met dezelfde opmaak samen en laat lege weg. */
export function normalizeRuns(runs) {
  const out = [];
  for (const r of runs ?? []) {
    if (!r || !r.text) continue;
    const last = out.at(-1);
    if (last && markKey(last) === markKey(r)) last.text += r.text;
    else out.push({ text: r.text, ...marksOf(r) });
  }
  return out;
}

export const runsText = (runs) => (runs ?? []).map((r) => r.text).join('');
export const runsLength = (runs) => runsText(runs).length;

/** De runs tussen twee tekenposities. */
export function sliceRuns(runs, from, to = Infinity) {
  const out = [];
  let pos = 0;
  for (const r of runs ?? []) {
    const end = pos + r.text.length;
    const a = Math.max(from, pos);
    const b = Math.min(to, end);
    if (a < b) out.push({ ...r, text: r.text.slice(a - pos, b - pos) });
    pos = end;
  }
  return normalizeRuns(out);
}

/** Tekst invoegen op `at`, met de opmaak van het teken ervoor (of `marks` als die gegeven is). */
export function insertText(runs, at, text, marks = null) {
  if (!text) return normalizeRuns(runs);
  let pos = 0;
  let style = null;
  for (const r of runs ?? []) {
    if (at > pos && at <= pos + r.text.length) { style = marksOf(r); break; }
    pos += r.text.length;
  }
  const piece = { text, ...(marks ?? style ?? {}) };
  return normalizeRuns([...sliceRuns(runs, 0, at), piece, ...sliceRuns(runs, at)]);
}

/** Heeft elk teken tussen `from` en `to` opmaak `mark` (met waarde `value` bij hl en link)? Bij een lege keuze: het teken ervoor. */
export function hasMark(runs, from, to, mark) {
  if (from === to) {
    const piece = sliceRuns(runs, Math.max(0, from - 1), from)[0];
    return Boolean(piece?.[mark]);
  }
  const part = sliceRuns(runs, from, to);
  return part.length > 0 && part.every((r) => Boolean(r[mark]));
}

/**
 * Zet opmaak aan of uit tussen `from` en `to`. `value`: true/false (b, i, u, s, code), een kleur of null (hl), een adres of null (link).
 * Code gaat niet samen met andere opmaak dan een link: wie code maakt, haalt de rest weg.
 */
export function setMark(runs, from, to, mark, value) {
  if (from >= to) return normalizeRuns(runs);
  const middle = sliceRuns(runs, from, to).map((r) => {
    const next = { ...r };
    if (value === null || value === false || value === undefined) delete next[mark];
    else next[mark] = value;
    if (mark === 'code' && value) for (const m of MARKS) delete next[m];
    if (mark !== 'code' && mark !== 'link' && value && next.code) delete next.code;
    return next;
  });
  return normalizeRuns([...sliceRuns(runs, 0, from), ...middle, ...sliceRuns(runs, to)]);
}

/** Aan als niet alles het al heeft, anders uit. */
export function toggleMark(runs, from, to, mark, value = true) {
  const on = mark === 'hl' || mark === 'link'
    ? sliceRuns(runs, from, to).every((r) => r[mark] === value)
    : hasMark(runs, from, to, mark);
  return setMark(runs, from, to, mark, on ? null : value);
}

// ---------- Markdown inlezen ----------

/** Inline-knooppunten (core/markdown.js) als runs. */
function nodesToRuns(nodes, marks = {}) {
  const out = [];
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out.push({ text: n.v, ...marks }); break;
      case 'br': out.push({ text: '\n', ...marks }); break;
      case 'code': out.push({ text: n.v, ...(marks.link ? { link: marks.link } : {}), code: true }); break;
      case 'strong': out.push(...nodesToRuns(n.c, { ...marks, b: true })); break;
      case 'em': out.push(...nodesToRuns(n.c, { ...marks, i: true })); break;
      case 'del': out.push(...nodesToRuns(n.c, { ...marks, s: true })); break;
      case 'u': out.push(...nodesToRuns(n.c, { ...marks, u: true })); break;
      case 'mark': out.push(...nodesToRuns(n.c, { ...marks, hl: n.color ?? 'yellow' })); break;
      case 'link': out.push(...nodesToRuns(n.c, { ...marks, link: n.href })); break;
      default: break;
    }
  }
  return out;
}

export const inlineRuns = (text) => normalizeRuns(nodesToRuns(parseInline(text)));

const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const indentOf = (ws) => [...ws].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);

/** Markdown als blokken: één blok per regel. Een lege tekst is één leeg blok. */
export function fromMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const body = [];
      const close = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}[ \\t]*$`);
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      blocks.push({ type: 'code', level: 0, runs: body.length ? [{ text: body.join('\n') }] : [] });
      continue;
    }
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      const body = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) body.push(lines[i++]);
      i--;
      blocks.push({ type: 'table', level: 0, runs: [{ text: body.join('\n') }] });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: `h${Math.min(3, heading[1].length)}`, level: 0, runs: inlineRuns(heading[2]) });
      continue;
    }
    if (RULE.test(line)) { blocks.push({ type: 'rule', level: 0, runs: [] }); continue; }
    const quote = QUOTE.exec(line);
    if (quote) {
      blocks.push({ type: 'quote', level: 0, runs: inlineRuns(quote[1].replace(/^(?:>[ \t]?)+/, '').trim()) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const level = Math.min(MAX_LEVEL, Math.floor(indentOf(item[1]) / 2));
      const task = /\d/.test(item[2]) ? null : TASK.exec(item[3]);
      const type = task ? 'check' : /\d/.test(item[2]) ? 'number' : 'bullet';
      const block = { type, level, runs: inlineRuns(task ? task[2] : item[3]) };
      if (type === 'check') block.checked = task[1] !== ' ';
      blocks.push(block);
      continue;
    }
    const prev = blocks.at(-1);
    if (line.trim() && isList(prev) && indentOf(/^[ \t]*/.exec(line)[0]) >= 2) {
      // een vervolgregel van het vorige punt (ingesprongen, zonder teken)
      prev.runs = normalizeRuns([...prev.runs, { text: '\n' }, ...inlineRuns(line.trim())]);
      continue;
    }
    blocks.push({ type: 'p', level: 0, runs: line.trim() ? inlineRuns(line.trim()) : [] });
  }
  while (blocks.length > 1 && blocks.at(-1).type === 'p' && blocks.at(-1).runs.length === 0) blocks.pop();
  return blocks.length > 0 ? blocks : [{ type: 'p', level: 0, runs: [] }];
}

// ---------- Markdown schrijven ----------

const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Tekens die anders opmaak zouden worden, met een backslash ervoor. */
function escapeText(text) {
  let out = '';
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    const next = text[k + 1];
    const edge = k === 0 || k === text.length - 1; // naast de rand kan een opmaakteken staan
    if (c === '\\' && (next === undefined || /[\\`*_{}[\]()#+\-.!|~>=]/.test(next))) out += '\\\\';
    else if (c === '*' || c === '`' || c === '[' || c === ']') out += `\\${c}`;
    else if (c === '_' && !(isWordChar(text[k - 1]) && isWordChar(next))) out += '\\_';
    else if ((c === '~' || c === '=' || c === '+') && (edge || next === c || text[k - 1] === c)) out += `\\${c}`;
    else out += c;
  }
  return out;
}

/**
 * Haalt opmaak van spaties aan de rand van een stuk opmaak (`** vet**` is in Markdown geen vet): de spatie komt buiten de opmaak.
 * Werkt per teken, dus ook als een spatie op de grens van twee runs ligt.
 */
export function tightenRuns(runs) {
  const chars = [];
  for (const r of runs) for (const ch of r.text) chars.push({ ch, ...marksOf(r) });
  for (const m of [...MARKS, 'link']) {
    let k = 0;
    while (k < chars.length) {
      if (!chars[k][m]) { k++; continue; }
      let end = k;
      while (end < chars.length && chars[end][m] === chars[k][m]) end++;
      let a = k;
      let b = end - 1;
      while (a <= b && /\s/u.test(chars[a].ch)) delete chars[a++][m];
      while (b >= a && /\s/u.test(chars[b].ch)) delete chars[b--][m];
      k = end;
    }
  }
  return normalizeRuns(chars.map(({ ch, ...rest }) => ({ text: ch, ...rest })));
}

function codeSpan(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((x) => x[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim()) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const OPENER = { u: () => '++', s: () => '~~', hl: (v) => (v === 'yellow' ? '==' : `=={${v}}`), link: () => '[' };
/** Een adres in een link: haakjes alleen coderen als ze niet in paren staan (de lezer kan paren aan). */
const hrefMd = (v) => {
  let depth = 0;
  for (const c of v) { if (c === '(') depth++; else if (c === ')' && --depth < 0) break; }
  return depth === 0 ? v : v.replace(/\(/g, '%28').replace(/\)/g, '%29');
};
const CLOSER = { u: () => '++', s: () => '~~', hl: () => '==', link: (v) => `](${hrefMd(v)})` };
const STACKED = ['hl', 'b', 'i', 'u', 's', 'link']; // de volgorde bij gelijke lengte: van buiten naar binnen

/**
 * Runs als Markdown (inline). Opmaak (ook een link) wordt netjes genest: wat het langst doorloopt, gaat het eerst open. Spaties staan
 * nooit direct binnen een opmaakteken ("** vet**" is in Markdown geen vet): op een grens komen ze erbuiten. Cursief en vet kiezen hun
 * teken pas bij het sluiten: cursief * midden in een woord en anders _, vet ** of __ (waar ** tegen een cursieve * aan zou komen: ***
 * is dubbelzinnig). Omdat ook dat niet altijd te voorzien is, wordt het resultaat terug gelezen en vergeleken; klopt het niet, dan
 * volgt een andere schrijfwijze. De eerste die precies terugkomt, wint.
 */
export function runsToMd(input) {
  const runs = tightenRuns(normalizeRuns(input)).map((r) => (r.link && !safeHref(r.link) ? (({ link, ...rest }) => rest)(r) : r));
  const variants = [
    { bold: '**', italic: 'auto' }, { bold: 'smart', italic: 'auto' }, { bold: 'under', italic: 'auto' },
    { bold: 'smart', italic: '*' }, { bold: 'under', italic: '*' }, { bold: '**', italic: '_' },
  ];
  for (const v of variants) {
    const md = writeRuns(runs, v);
    if (sameVisible(inlineRuns(md), runs)) return md;
  }
  // Vet en cursief samen midden in een woord ("1***a**b*") is in Markdown niet altijd eenduidig te schrijven. Dan liever die opmaak
  // kwijt dan sterretjes in de tekst: eerst zonder cursief, dan ook zonder vet.
  for (const drop of [['i'], ['i', 'b']]) {
    const plainer = normalizeRuns(runs.map((r) => { const c = { ...r }; for (const m of drop) delete c[m]; return c; }));
    for (const v of variants) {
      const md = writeRuns(plainer, v);
      if (sameVisible(inlineRuns(md), plainer)) return md;
    }
  }
  return writeRuns(normalizeRuns(runs.map(({ text, code, link }) => ({ text, ...(code ? { code } : {}), ...(link ? { link } : {}) }))), variants[0]);
}

/** Dezelfde tekst, en elk zichtbaar teken (geen spatie) met precies dezelfde opmaak. */
function sameVisible(a, b) {
  const flat = (runs) => {
    const out = [];
    for (const r of runs) {
      const key = `${r.b ? 1 : 0}${r.i ? 1 : 0}${r.u ? 1 : 0}${r.s ? 1 : 0}${r.code ? 1 : 0}|${r.hl ?? ''}|${r.link ?? ''}`;
      for (const ch of r.text) out.push(/\s/u.test(ch) ? ' ' : `${ch}${key}`);
    }
    return out.join('\u0000').trim();
  };
  return flat(a) === flat(b) && runsText(a) === runsText(b);
}

function writeRuns(runs, opts) {
  let out = '';
  let pending = ''; // spaties na de laatste tekst, nog niet geschreven (de sluittekens gaan ervoor)
  const stack = []; // { m, v, close?, pos?, before?, nearStar? }
  const extent = (k, m, v) => { let e = k; while (e < runs.length && (runs[e][m] ?? null) === v) e++; return e - k; };
  const wantOf = (k) => STACKED.filter((m) => runs[k]?.[m]).map((m) => ({ m, v: runs[k][m] }));
  const ws = (text) => text.replace(/\n/g, '\\\n');
  const patch = (pos, mark) => { out = `${out.slice(0, pos)}${mark}${out.slice(pos + mark.length)}`; };
  const starBefore = () => out.at(-1) === '*' && out.at(-2) !== '\\'; // een cursieve * (geen \* uit de tekst)

  // Sluit alles boven `keep`. `next.ch`: wat er na het laatste sluitteken komt; `next.italic`: daar opent cursief.
  const closeTo = (keep, next) => {
    while (stack.length > keep) {
      const top = stack.pop();
      const below = stack.length > keep ? stack.at(-1) : null; // het volgende sluitteken
      const after = below ? '*' : next.ch; // na een sluitteken volgt een teken dat geen letter is
      if (top.m === 'i') {
        const mark = opts.italic !== 'auto' ? opts.italic : isWordChar(top.before) || isWordChar(after) ? '*' : '_';
        patch(top.pos, mark);
        out += mark;
      } else if (top.m === 'b') {
        const canUnder = !isWordChar(top.before) && !isWordChar(after);
        const nearStar = top.nearStar || starBefore() || (below ? below.m === 'i' : next.italic);
        const mark = canUnder && (opts.bold === 'under' || (opts.bold === 'smart' && nearStar)) ? '__' : '**';
        patch(top.pos, mark);
        out += mark;
      } else out += top.close;
    }
  };

  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    if (r.code && !r.text.trim()) { pending += r.text; continue; } // code van alleen spaties: gewoon spaties
    const lead = r.code ? '' : /^\s*/u.exec(r.text)[0];
    const core = r.code ? r.text : r.text.slice(lead.length).replace(/\s+$/u, '');
    const trail = r.code ? '' : r.text.slice(lead.length + core.length);
    if (!core) { pending += r.text; continue; } // alleen spaties: die horen bij geen opmaak
    const want = wantOf(k);
    let keep = 0;
    while (keep < stack.length && want.some((w) => w.m === stack[keep].m && w.v === stack[keep].v)) keep++;
    const opening = want.filter((w) => !stack.slice(0, keep).some((x) => x.m === w.m))
      .sort((a, b) => extent(k, b.m, b.v) - extent(k, a.m, a.v) || STACKED.indexOf(a.m) - STACKED.indexOf(b.m));
    const spaced = Boolean(pending || lead);
    const firstChar = spaced ? ' ' : opening.length ? '[' : r.code ? '`' : core[0];
    closeTo(keep, { ch: firstChar, italic: !spaced && opening[0]?.m === 'i' });
    out += ws(pending + lead);
    pending = '';
    opening.forEach((w, n) => {
      if (w.m === 'i' || w.m === 'b') {
        // het teken wordt bij het sluiten gekozen; nu een plaatshouder van dezelfde lengte
        stack.push({ m: w.m, v: true, pos: out.length, before: out.at(-1), nearStar: w.m === 'b' && (starBefore() || opening[n + 1]?.m === 'i') });
        out += w.m === 'i' ? '_' : '**';
      } else {
        out += OPENER[w.m](w.v);
        stack.push({ m: w.m, v: w.v, close: CLOSER[w.m](w.v) });
      }
    });
    out += r.code ? codeSpan(core) : ws(escapeText(core));
    pending = trail;
  }
  closeTo(0, { ch: pending ? ' ' : undefined, italic: false });
  return out + ws(pending);
}

/** Een regel die anders als kop, lijst, citaat, lijn of code gelezen wordt, krijgt een backslash vooraan. */
function guardLineStart(md) {
  if (/^(#{1,6}[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t]|`{3,}[^`]*$|~{3,}|\|)/.test(md) || RULE.test(md)) {
    const m = /^(\d{1,9})([.)])/.exec(md);
    return m ? `${m[1]}\\${m[2]}${md.slice(m[0].length)}` : `\\${md}`;
  }
  return md;
}

/** De blokken als Markdown. */
export function toMarkdown(blocks) {
  const lines = [];
  const counters = [];
  let prevType = null;
  for (const b of blocks) {
    const level = isList(b) ? Math.min(MAX_LEVEL, Math.max(0, b.level ?? 0)) : 0;
    if (b.type !== 'number') counters.length = isList(b) ? level : 0;
    const pad = '  '.repeat(level);
    const text = isRaw(b) ? runsText(b.runs) : runsToMd(b.runs);
    // een regeleinde binnen een punt: de volgende regels springen in (vervolgregels)
    const cont = (s) => s.replace(/\\\n/g, `\n${pad}  `);
    switch (b.type) {
      case 'h1': case 'h2': case 'h3': lines.push(`${'#'.repeat(Number(b.type[1]))} ${text.replace(/\\\n/g, ' ').replace(/\s+$/u, '').replace(/(\s)(#+)$/, '$1\\$2')}`.trimEnd()); break;
      case 'quote': lines.push(`> ${guardLineStart(text.replace(/^[ \t]+/, '')).replace(/\\\n/g, '\n> ')}`.trimEnd()); break;
      case 'bullet': lines.push(`${pad}- ${cont(text)}`.trimEnd()); break;
      case 'check': lines.push(`${pad}- [${b.checked ? 'x' : ' '}] ${cont(text)}`.trimEnd()); break;
      case 'number': {
        counters.length = level + 1;
        counters[level] = (prevType === 'number' || isList({ type: prevType }) ? counters[level] ?? 0 : 0) + 1;
        lines.push(`${pad}${counters[level]}. ${cont(text)}`.trimEnd());
        break;
      }
      case 'code': {
        const body = runsText(b.runs);
        const longest = Math.max(2, ...[...body.matchAll(/^ {0,3}(`{3,})/gm)].map((x) => x[1].length));
        const fence = '`'.repeat(longest + 1);
        lines.push(fence, ...(body ? body.split('\n') : []), fence);
        break;
      }
      case 'table': lines.push(...runsText(b.runs).split('\n')); break;
      case 'rule': lines.push('---'); break;
      default: {
        // een gewone regel: na een lijst mag hij niet inspringen (dan hoort hij bij het punt)
        const md = guardLineStart(text.replace(/^[ \t]+/, '')).replace(/\\\n/g, '\n');
        lines.push(md.trimEnd());
      }
    }
    prevType = b.type;
  }
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

// ---------- bewerkingen op blokken ----------

const clone = (blocks) => blocks.map((b) => ({ ...b, runs: b.runs.map((r) => ({ ...r })) }));
const emptyLike = (type = 'p', level = 0) => (type === 'check' ? { type, level, checked: false, runs: [] } : { type, level, runs: [] });

/** Een nieuw blok met dit type, de tekst blijft. Een lijsttype houdt het inspringen; andere typen niet. */
export function setType(blocks, index, type) {
  const out = clone(blocks);
  const b = out[index];
  if (!b) return out;
  const text = isRaw(b) && !RAW.has(type) ? [{ text: runsText(b.runs) }] : b.runs;
  const next = { type, level: LIST_TYPES.includes(type) ? b.level ?? 0 : 0, runs: RAW.has(type) ? (runsText(text) ? [{ text: runsText(text) }] : []) : text };
  if (type === 'check') next.checked = Boolean(b.type === 'check' && b.checked);
  out[index] = next;
  return out;
}

/**
 * Enter: het blok splitsen op `offset`. Het nieuwe blok is van hetzelfde soort lijst (een taak is dan niet afgevinkt), anders een
 * gewone regel. Enter in een leeg lijstpunt: eerst een niveau terug, op het hoogste niveau een gewone regel.
 * @returns {{ blocks: object[], index: number, offset: number }} waar de cursor daarna staat
 */
export function splitBlock(blocks, index, offset) {
  const out = clone(blocks);
  const b = out[index];
  if (isList(b) && runsLength(b.runs) === 0) {
    out[index] = b.level > 0 ? { ...b, level: b.level - 1 } : emptyLike('p');
    return { blocks: out, index, offset: 0 };
  }
  if (b.type === 'rule') {
    out.splice(index + 1, 0, emptyLike('p'));
    return { blocks: out, index: index + 1, offset: 0 };
  }
  const before = sliceRuns(b.runs, 0, offset);
  const after = sliceRuns(b.runs, offset);
  const nextType = isList(b) || b.type === 'quote' ? b.type : 'p';
  out[index] = { ...b, runs: before };
  // Enter aan het begin van een niet-lege kop: de kop schuift mee naar beneden en erboven komt een lege regel
  if (offset === 0 && before.length === 0 && !isList(b) && b.type !== 'quote') {
    out[index] = emptyLike('p');
    out.splice(index + 1, 0, { ...b, runs: after });
    return { blocks: out, index: index + 1, offset: 0 };
  }
  out.splice(index + 1, 0, { ...emptyLike(nextType, isList(b) ? b.level : 0), runs: after });
  return { blocks: out, index: index + 1, offset: 0 };
}

/**
 * Backspace aan het begin van een blok: een lijstpunt gaat eerst een niveau terug, een kop of lijst wordt een gewone regel, en een
 * gewone regel gaat samen met de regel erboven (een lijn erboven verdwijnt).
 * @returns {{ blocks: object[], index: number, offset: number } | null} null: er is niets te doen (het eerste blok, al een gewone regel)
 */
export function backspaceAtStart(blocks, index) {
  const out = clone(blocks);
  const b = out[index];
  if (!b) return null;
  if (isList(b) && b.level > 0) { out[index] = { ...b, level: b.level - 1 }; return { blocks: out, index, offset: 0 }; }
  if (b.type !== 'p') { out[index] = { type: 'p', level: 0, runs: isRaw(b) ? (runsText(b.runs) ? [{ text: runsText(b.runs) }] : []) : b.runs }; return { blocks: out, index, offset: 0 }; }
  if (index === 0) return null;
  const prev = out[index - 1];
  if (prev.type === 'rule') { out.splice(index - 1, 1); return { blocks: out, index: index - 1, offset: 0 }; }
  const offset = runsLength(prev.runs);
  const merged = isRaw(prev) ? [{ text: runsText(prev.runs) + runsText(b.runs) }] : normalizeRuns([...prev.runs, ...b.runs]);
  out[index - 1] = { ...prev, runs: merged.filter((r) => r.text) };
  out.splice(index, 1);
  return { blocks: out, index: index - 1, offset };
}

/** Delete aan het eind van een blok: het volgende blok komt erachter (een lijn verdwijnt). */
export function deleteAtEnd(blocks, index) {
  const out = clone(blocks);
  const b = out[index];
  const next = out[index + 1];
  if (!b || !next) return null;
  const offset = runsLength(b.runs);
  if (next.type === 'rule') { out.splice(index + 1, 1); return { blocks: out, index, offset }; }
  out[index] = { ...b, runs: isRaw(b) ? [{ text: runsText(b.runs) + runsText(next.runs) }] : normalizeRuns([...b.runs, ...next.runs]) };
  out.splice(index + 1, 1);
  return { blocks: out, index, offset };
}

/**
 * Wist alles tussen twee posities ({ index, offset }), ook over blokken heen: het eerste blok houdt zijn soort en krijgt de rest van
 * het laatste erachter.
 */
export function deleteRange(blocks, a, b) {
  const [from, to] = a.index < b.index || (a.index === b.index && a.offset <= b.offset) ? [a, b] : [b, a];
  const out = clone(blocks);
  const first = out[from.index];
  const last = out[to.index];
  const head = isRaw(first) ? [{ text: runsText(first.runs).slice(0, from.offset) }] : sliceRuns(first.runs, 0, from.offset);
  const tail = isRaw(last) ? [{ text: runsText(last.runs).slice(to.offset) }] : sliceRuns(last.runs, to.offset);
  const runs = isRaw(first) ? [{ text: runsText(head) + runsText(tail) }].filter((r) => r.text) : normalizeRuns([...head, ...tail]);
  out.splice(from.index, to.index - from.index + 1, { ...first, runs });
  if (out.length === 0) out.push(emptyLike('p'));
  return { blocks: out, index: from.index, offset: from.offset };
}

/** Blokken invoegen op een positie (plakken): het huidige blok wordt gesplitst en de nieuwe komen ertussen. */
export function insertBlocks(blocks, index, offset, inserted) {
  if (inserted.length === 0) return { blocks: clone(blocks), index, offset };
  const out = clone(blocks);
  const b = out[index];
  if (inserted.length === 1 && !isRaw(inserted[0]) && inserted[0].type === 'p') {
    // één gewone regel: gewoon tekst invoegen
    const runs = isRaw(b) ? [{ text: runsText(b.runs).slice(0, offset) + runsText(inserted[0].runs) + runsText(b.runs).slice(offset) }] : normalizeRuns([...sliceRuns(b.runs, 0, offset), ...inserted[0].runs, ...sliceRuns(b.runs, offset)]);
    out[index] = { ...b, runs };
    return { blocks: out, index, offset: offset + runsLength(inserted[0].runs) };
  }
  const before = { ...b, runs: sliceRuns(b.runs, 0, offset) };
  const after = { ...b, runs: sliceRuns(b.runs, offset) };
  const parts = clone(inserted);
  const keepBefore = runsLength(before.runs) > 0 || b.type !== 'p';
  const keepAfter = runsLength(after.runs) > 0;
  const list = [...(keepBefore ? [before] : []), ...parts, ...(keepAfter ? [after] : [])];
  out.splice(index, 1, ...list);
  const lastIndex = index + (keepBefore ? 1 : 0) + parts.length - 1;
  return { blocks: out, index: lastIndex, offset: runsLength(out[lastIndex].runs) };
}

/** Inspringen (+1) of terug (-1), alleen voor lijstpunten; een punt springt hooguit één verder in dan het punt erboven. */
export function indent(blocks, index, delta) {
  const out = clone(blocks);
  const b = out[index];
  if (!isList(b)) return out;
  const prev = out[index - 1];
  const max = isList(prev) ? Math.min(MAX_LEVEL, prev.level + 1) : 0;
  out[index] = { ...b, level: Math.max(0, Math.min(max, b.level + delta)) };
  return out;
}

// ---------- checklists ----------

/** Het stuk aaneengesloten taakpunten waar `index` in staat, op het niveau van dat punt: [start, end) en het niveau. */
function siblingSpan(blocks, index) {
  const level = blocks[index].level;
  let start = index;
  while (start > 0 && blocks[start - 1].type === 'check' && blocks[start - 1].level >= level) start--;
  let end = index + 1;
  while (end < blocks.length && blocks[end].type === 'check' && blocks[end].level >= level) end++;
  return { start, end, level };
}

/** De groepen in een stuk: een punt op het niveau met zijn subpunten erachter. */
function groupsOf(blocks, start, end, level) {
  const groups = [];
  for (let k = start; k < end; k++) {
    if (blocks[k].level === level || groups.length === 0) groups.push({ at: k, items: [] });
    groups.at(-1).items.push(blocks[k]);
  }
  return groups;
}

/**
 * Een taakpunt afvinken of weer openzetten. Met `sort` gaat een afgevinkt punt (met zijn subpunten) naar boven in het afgevinkte deel
 * onderaan zijn lijst, en een weer geopend punt naar het eind van het open deel.
 * @returns {{ blocks: object[], index: number }} waar het punt nu staat
 */
export function toggleCheck(blocks, index, { sort = true } = {}) {
  const out = clone(blocks);
  const b = out[index];
  if (b?.type !== 'check') return { blocks: out, index };
  out[index] = { ...b, checked: !b.checked };
  if (!sort) return { blocks: out, index };
  const { start, end, level } = siblingSpan(out, index);
  const groups = groupsOf(out, start, end, level);
  const mine = groups.find((g) => g.at <= index && index < g.at + g.items.length);
  if (!mine || out[mine.at].level !== level) return { blocks: out, index };
  const rest = groups.filter((g) => g !== mine);
  const open = rest.filter((g) => !g.items[0].checked);
  const done = rest.filter((g) => g.items[0].checked);
  // afgevinkt: bovenaan het afgevinkte deel; weer open: onderaan het open deel. Beide komen neer op: na de open punten, voor de afgevinkte.
  const ordered = [...open, mine, ...done];
  const flat = ordered.flatMap((g) => g.items);
  out.splice(start, end - start, ...flat);
  const at = start + ordered.slice(0, ordered.indexOf(mine)).reduce((n, g) => n + g.items.length, 0);
  return { blocks: out, index: at + (index - mine.at) };
}

/**
 * Waar een lijst afgevinkte punten onderaan heeft (om in te klappen): per stuk het eerste blok van het afgevinkte deel, het blok na
 * het stuk en het aantal afgevinkte punten. Alleen als het afgevinkte deel echt onderaan staat (na alle open punten).
 */
export function checkedFolds(blocks) {
  const folds = [];
  let k = 0;
  while (k < blocks.length) {
    if (blocks[k].type !== 'check') { k++; continue; }
    // een stuk vanaf hier: taakpunten op dit niveau of dieper (subpunten vouwen mee met hun punt, niet apart)
    const level = blocks[k].level;
    let end = k + 1;
    while (end < blocks.length && blocks[end].type === 'check' && blocks[end].level >= level) end++;
    const groups = groupsOf(blocks, k, end, level);
    let first = groups.length;
    while (first > 0 && groups[first - 1].items[0].checked) first--;
    if (first < groups.length) folds.push({ start: groups[first].at, end, count: groups.length - first, all: first === 0 });
    k = end;
  }
  return folds;
}

/** Alle taakpunten weer open. */
export const uncheckAll = (blocks) => clone(blocks).map((b) => (b.type === 'check' ? { ...b, checked: false } : b));

/** Afgevinkte punten weg, met hun subpunten. */
export function deleteChecked(blocks) {
  const out = [];
  let skipBelow = null;
  for (const b of clone(blocks)) {
    if (skipBelow !== null && isList(b) && b.level > skipBelow) continue;
    skipBelow = null;
    if (b.type === 'check' && b.checked) { skipBelow = b.level; continue; }
    out.push(b);
  }
  return out.length > 0 ? out : [emptyLike('p')];
}

export const checklistCounts = (blocks) => ({
  items: blocks.filter((b) => b.type === 'check').length,
  checked: blocks.filter((b) => b.type === 'check' && b.checked).length,
});

// ---------- tellen en voorbeelden ----------

/** Het aantal woorden (titel niet meegeteld). */
export function wordCount(blocks) {
  let n = 0;
  for (const b of blocks) if (b.type !== 'rule') n += (runsText(b.runs).match(/[\p{L}\p{N}][\p{L}\p{N}'’.×-]*/gu) ?? []).length;
  return n;
}

/**
 * De regels voor een kaart in de lijst (zoals Anchor): lege regels weg, afgevinkte punten van een lijst samengevat als
 * { type: 'done', count, all }, een codeblok hooguit drie regels, en hooguit `maxRows` regels.
 * @returns {{ rows: object[], cut: boolean }}
 */
export function cardRows(blocks, maxRows = 6) {
  const shown = blocks.filter((b) => b.type !== 'rule' && runsText(b.runs).trim());
  const rows = [];
  let ticked = 0;
  let open = 0;
  const endList = () => {
    if (ticked) rows.push({ type: 'done', count: ticked, all: open === 0 });
    ticked = 0;
    open = 0;
  };
  for (const b of shown) {
    if (b.type !== 'check') endList();
    else if (b.checked) { ticked++; continue; } else open++;
    if (b.type === 'code') {
      const lines = runsText(b.runs).split('\n').filter((l, k, all) => l.trim() || (k > 0 && k < all.length - 1));
      rows.push({ ...b, runs: [{ text: lines.slice(0, 3).join('\n') }], cutCode: lines.length > 3 });
    } else rows.push(b);
  }
  endList();
  return { rows: rows.slice(0, maxRows), cut: rows.length > maxRows };
}

export { HIGHLIGHTS };
