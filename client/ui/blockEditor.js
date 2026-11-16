// De editor van een notitie: opmaak direct in beeld (zoals Anchor), opgeslagen als Markdown (core/noteDoc.js).
//
// Opbouw: één contenteditable-element met per regel een blok (`div.nb`), met daarin de tekst (`div.nb-text`) en bij een taakpunt
// een vinkje (`span.nb-box`, niet bewerkbaar). Het model (de blokken) is de waarheid. Gewoon typen binnen één regel laat de browser
// doen (dat werkt goed met toetsenborden op een telefoon en met samengestelde tekens); daarna wordt die regel opnieuw gelezen.
// Alles wat de structuur raakt — Enter, Backspace of Delete op een regelgrens, een selectie over regels heen, plakken, knippen,
// opmaak, ongedaan maken — gaat via het model, waarna de editor opnieuw wordt getekend en de cursor teruggezet.
//
// Extra's zoals in Anchor: een menu met "/" (soort regel kiezen), Markdown-sneltoetsen aan het begin van een regel ("- ", "1. ",
// "[] ", "# ", "> ", "```", "---"), checklists waarvan afgevinkte punten naar onderen gaan en inklappen ("2 afgevinkte punten"),
// een werkbalk met markeerkleuren, en een eigen geschiedenis voor Ctrl+Z.
//
// Veiligheid: de tekst gaat er alleen in met textContent en createElement; links zijn alleen http, https of mailto (safeHref);
// plakken uit HTML wordt gelezen met DOMParser (voert niets uit) en alleen de bekende opmaak blijft over.

import {
  HIGHLIGHTS, backspaceAtStart, checkedFolds, checklistCounts, deleteAtEnd, deleteChecked, deleteRange, fromMarkdown, indent,
  insertBlocks, insertText, isList, isRaw, normalizeRuns, runsLength, runsText, setMark, setType, sliceRuns, splitBlock, toMarkdown,
  toggleCheck, toggleMark, uncheckAll, wordCount,
} from '../core/noteDoc.js';
import { safeHref } from '../core/markdown.js';
import { t } from '../core/i18n.js';
import { h } from './dom.js';

const MAX_HISTORY = 300;
const TYPE_GROUP_MS = 900;
const MIME = 'application/x-tickory-blocks';

// ---------- tekenen ----------

const TAGS = [['code', 'code'], ['s', 's'], ['u', 'u'], ['i', 'em'], ['b', 'strong']]; // van binnen naar buiten

/** De knooppunten van runs (nooit HTML). */
function runNodes(runs) {
  return runs.map((r) => {
    let node = document.createTextNode(r.text);
    for (const [mark, tag] of TAGS) {
      if (!r[mark]) continue;
      const el = document.createElement(tag);
      el.append(node);
      node = el;
    }
    if (r.hl) {
      const el = document.createElement('mark');
      el.className = `md-mark hl-${HIGHLIGHTS.includes(r.hl) ? r.hl : 'yellow'}`;
      el.append(node);
      node = el;
    }
    if (r.link) {
      const href = safeHref(r.link);
      if (href) {
        const el = document.createElement('a');
        el.href = href;
        el.className = 'nb-link';
        el.rel = 'noopener noreferrer nofollow';
        el.target = '_blank';
        el.append(node);
        node = el;
      }
    }
    return node;
  });
}

/** Leest de tekst met opmaak uit een stuk van de pagina terug (wat de browser bij het typen maakte, telt alleen als bekende opmaak). */
export function readRuns(root, { raw = false } = {}) {
  const out = [];
  const walk = (node, marks) => {
    if (node.nodeType === Node.TEXT_NODE) {
      // de browser maakt van een spatie aan het eind vaak een vaste spatie (U+00A0): voor ons is dat gewoon een spatie
      if (node.data) out.push({ text: (raw ? node.data : node.data.replace(/\n/g, ' ')).replace(/ /g, ' '), ...marks });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {HTMLElement} */ (node);
    if (el.tagName === 'BR') {
      if (!el.dataset.filler) out.push({ text: raw ? '\n' : ' ', ...marks });
      return;
    }
    if (el.getAttribute('contenteditable') === 'false') return; // het vinkje van een taakpunt
    const next = { ...marks };
    switch (el.tagName) {
      case 'STRONG': case 'B': next.b = true; break;
      case 'EM': case 'I': next.i = true; break;
      case 'U': next.u = true; break;
      case 'S': case 'DEL': case 'STRIKE': next.s = true; break;
      case 'CODE': next.code = true; break;
      case 'MARK': next.hl = HIGHLIGHTS.find((c) => el.classList.contains(`hl-${c}`)) ?? 'yellow'; break;
      case 'A': { const href = safeHref(el.getAttribute('href')); if (href) next.link = href; break; }
      default: break;
    }
    const block = el !== root && /^(DIV|P|LI)$/.test(el.tagName);
    if (block && out.length > 0) out.push({ text: raw ? '\n' : ' ', ...marks });
    for (const child of el.childNodes) walk(child, next);
  };
  for (const child of root.childNodes) walk(child, {});
  return raw ? [{ text: out.map((r) => r.text).join('') }].filter((r) => r.text) : normalizeRuns(out.map((r) => (r.code ? { text: r.text, code: true, ...(r.link ? { link: r.link } : {}) } : r)));
}

/** HTML van het klembord als blokken: alleen de bekende opmaak, uitgevoerd wordt er niets (DOMParser laadt en draait niets). */
export function htmlToBlocks(html) {
  const doc = new DOMParser().parseFromString(String(html).slice(0, 500_000), 'text/html');
  const SKIP = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|IFRAME|OBJECT|EMBED|SVG|HEAD|META|LINK|TITLE)$/;
  const BLOCKISH = /^(P|DIV|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE|HR|TABLE|THEAD|TBODY|TR|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|FIGURE|DL|DT|DD)$/;
  const blocks = [];
  const isBlock = (n) => n.nodeType === Node.ELEMENT_NODE && BLOCKISH.test(n.tagName);

  /** Losse inline-stukken als één blok van soort `kind`. */
  const emit = (nodes, ctx) => {
    const wrap = doc.createElement('div');
    for (const n of nodes) wrap.append(n.cloneNode(true));
    const box = wrap.querySelector('input[type="checkbox"]');
    const runs = trimRuns(readRuns(wrap));
    if (!runsText(runs).trim()) return;
    const kind = ctx.item ? (box ? 'check' : ctx.kind) : ctx.kind;
    const block = { type: kind, level: ctx.item ? ctx.level : 0, runs };
    if (kind === 'check') block.checked = Boolean(box?.checked || box?.hasAttribute('checked'));
    blocks.push(block);
  };

  /** Een element met blokken en inline-tekst door elkaar: de inline-tekst tussen de blokken wordt telkens één blok. */
  const container = (el, ctx) => {
    let inline = [];
    const flush = () => { if (inline.length) emit(inline, ctx); inline = []; };
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && SKIP.test(child.tagName)) continue;
      if (isBlock(child)) { flush(); handle(child, ctx); } else inline.push(child);
    }
    flush();
  };

  const handle = (el, ctx) => {
    const tag = el.tagName;
    if (tag === 'UL' || tag === 'OL') {
      const level = ctx.item ? Math.min(5, ctx.level + 1) : 0;
      for (const li of el.children) if (li.tagName === 'LI') container(li, { kind: tag === 'OL' ? 'number' : 'bullet', level, item: true });
      return;
    }
    if (tag === 'LI') { container(el, { kind: ctx.kind === 'number' ? 'number' : 'bullet', level: ctx.level ?? 0, item: true }); return; }
    if (/^H[1-6]$/.test(tag)) { emit([...el.childNodes], { kind: tag === 'H1' ? 'h1' : tag === 'H2' ? 'h2' : 'h3' }); return; }
    if (tag === 'BLOCKQUOTE') { container(el, { kind: 'quote' }); return; }
    if (tag === 'PRE') { const text = el.textContent.replace(/\n$/, ''); if (text) blocks.push({ type: 'code', level: 0, runs: [{ text }] }); return; }
    if (tag === 'HR') { blocks.push({ type: 'rule', level: 0, runs: [] }); return; }
    if (tag === 'TR') {
      const cells = [...el.children].map((c) => c.textContent.trim()).filter(Boolean);
      if (cells.length) blocks.push({ type: 'p', level: 0, runs: [{ text: cells.join(' | ') }] });
      return;
    }
    if (tag === 'TABLE' || tag === 'THEAD' || tag === 'TBODY') { for (const c of el.children) handle(c, ctx); return; }
    container(el, ctx.kind === 'quote' ? ctx : { kind: 'p' });
  };

  container(doc.body, { kind: 'p' });
  return blocks.slice(0, 5000);
}

function trimRuns(runs) {
  const r = normalizeRuns(runs).map((x) => ({ ...x }));
  if (r.length) { r[0].text = r[0].text.replace(/^\s+/, ''); r.at(-1).text = r.at(-1).text.replace(/\s+$/, ''); }
  return normalizeRuns(r);
}

/** Platte tekst van het klembord als blokken: Markdown als het daarop lijkt, anders één regel per regel zonder opmaak. */
export function textToBlocks(text) {
  const clean = String(text).replace(/\r\n?/g, '\n').slice(0, 200_000);
  const looksLikeMarkdown = /^(\s*([-*+] |\d{1,9}[.)] |#{1,6} |> |- \[[ xX]\] |```)|.*(\*\*|__|~~|==|\[[^\]]+\]\(https?:))/m.test(clean);
  if (looksLikeMarkdown) return fromMarkdown(clean);
  return clean.split('\n').map((line) => ({ type: 'p', level: 0, runs: line ? [{ text: line }] : [] }));
}

// ---------- de editor ----------

/**
 * @param {{
 *   markdown: string, readOnly?: boolean, checkedBottom?: boolean,
 *   onChange?: () => void, onExitUp?: () => void, onLink?: (current: string | null) => Promise<string | null | undefined>,
 *   placeholder?: string,
 * }} options `onLink`: vraagt een adres (geeft null bij annuleren, '' om de link weg te halen)
 */
export function createBlockEditor({ markdown, readOnly = false, checkedBottom = true, onChange = () => {}, onExitUp = () => {}, onLink = async () => null, placeholder = '' }) {
  let blocks = fromMarkdown(markdown);
  let pendingMarks = null; // opmaak voor de volgende getypte tekst (Ctrl+B zonder selectie)
  let composing = false;
  let lastTyped = 0;
  const undoStack = [];
  const redoStack = [];
  const closedFolds = new Set(); // welke afgevinkte stukken zijn ingeklapt (op volgorde in de notitie)
  const root = h('div', {
    class: 'ned', contentEditable: readOnly ? 'false' : 'true', role: 'textbox', 'aria-multiline': 'true', spellcheck: true,
    'aria-label': t('note.contentLabel'), dataset: { fk: 'note-text' },
  });
  const listeners = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push(() => target.removeEventListener(type, fn, opts)); };

  // ---------- tekenen ----------
  function blockEl(b, i, numbers) {
    const el = h('div', { class: `nb nb-${b.type}${b.checked ? ' is-checked' : ''}`, dataset: { index: String(i), level: String(b.level ?? 0) } });
    if (b.type === 'rule') {
      el.contentEditable = 'false';
      el.append(h('hr'));
      return el;
    }
    if (b.type === 'number') el.dataset.n = `${numbers[i]}.`;
    if (b.type === 'check') {
      el.append(h('span', {
        class: 'nb-box', contentEditable: 'false', role: 'checkbox', 'aria-checked': String(Boolean(b.checked)), tabIndex: -1,
        'aria-label': runsText(b.runs).slice(0, 80) || t('note.checkItem'), dataset: { box: String(i) },
      }));
    }
    const text = h('div', { class: 'nb-text' });
    if (isRaw(b)) {
      const raw = runsText(b.runs);
      if (raw) text.append(document.createTextNode(raw));
      if (!raw || raw.endsWith('\n')) text.append(h('br', { dataset: { filler: '1' } }));
    } else if (b.runs.length) {
      text.append(...runNodes(b.runs));
    } else {
      text.append(h('br', { dataset: { filler: '1' } }));
      el.classList.add('is-empty');
    }
    el.append(text);
    return el;
  }

  function numbering() {
    const out = [];
    const counters = [];
    blocks.forEach((b, i) => {
      if (b.type === 'number') {
        counters.length = b.level + 1;
        counters[b.level] = (counters[b.level] ?? 0) + 1;
        out[i] = counters[b.level];
      } else if (!isList(b)) counters.length = 0;
      else counters.length = b.level;
    });
    return out;
  }

  function render(sel = null) {
    const numbers = numbering();
    const folds = checkedBottom ? checkedFolds(blocks) : [];
    const foldAt = new Map(folds.map((f, n) => [f.start, { ...f, n }]));
    const hidden = new Set();
    const nodes = [];
    blocks.forEach((b, i) => {
      const fold = foldAt.get(i);
      if (fold) {
        const isOpen = !closedFolds.has(fold.n);
        if (!isOpen) for (let k = fold.start; k < fold.end; k++) hidden.add(k);
        nodes.push(h('div', { class: 'nb-fold', contentEditable: 'false', dataset: { level: String(b.level) } },
          h('button', {
            type: 'button', class: 'nb-fold-button', 'aria-expanded': String(isOpen), dataset: { fold: String(fold.n), fk: `fold:${fold.n}` },
          }, h('span', { class: 'nb-fold-chevron', 'aria-hidden': 'true' }), t('note.checkedItems', { count: fold.count }))));
      }
      const el = blockEl(b, i, numbers);
      if (hidden.has(i)) el.hidden = true;
      nodes.push(el);
    });
    root.replaceChildren(...nodes);
    root.classList.toggle('ned-empty', blocks.length === 1 && blocks[0].type === 'p' && blocks[0].runs.length === 0);
    if (placeholder) root.dataset.placeholder = placeholder;
    if (sel && (document.activeElement === root || root.contains(document.activeElement))) setSelection(sel.a, sel.b ?? sel.a);
  }

  // ---------- selectie <-> model ----------
  const blockOf = (node) => (node instanceof Element ? node : node?.parentElement)?.closest?.('.nb');
  const textOf = (i) => root.querySelector(`.nb[data-index="${i}"] .nb-text`);

  /** De plek in het model van een plek in de pagina. */
  function toModel(node, offset) {
    const el = blockOf(node);
    if (!el || !root.contains(el)) {
      // tussen de blokken (bijvoorbeeld in de wortel): het dichtstbijzijnde blok
      if (node === root) {
        const child = root.childNodes[Math.min(offset, root.childNodes.length - 1)];
        const near = child?.closest?.('.nb') ?? child?.previousElementSibling?.closest?.('.nb');
        if (near) return { index: Number(near.dataset.index), offset: offset >= root.childNodes.length ? runsLength(blocks[Number(near.dataset.index)].runs) : 0 };
      }
      return null;
    }
    const index = Number(el.dataset.index);
    const text = el.querySelector('.nb-text');
    if (!text || !text.contains(node)) return { index, offset: node === el && offset > 0 ? runsLength(blocks[index]?.runs) : 0 };
    let count = 0;
    let found = null;
    const walk = (n) => {
      if (found !== null) return;
      if (n === node && n.nodeType !== Node.TEXT_NODE) {
        // een plek tussen de kinderen van een element: tel de kinderen ervoor
        for (let k = 0; k < offset && k < n.childNodes.length; k++) count += lengthOf(n.childNodes[k]);
        found = count;
        return;
      }
      if (n.nodeType === Node.TEXT_NODE) {
        if (n === node) { found = count + offset; return; }
        count += n.data.length;
        return;
      }
      if (n.nodeName === 'BR') { if (!n.dataset.filler) count += 1; return; }
      for (const c of n.childNodes) walk(c);
    };
    walk(text);
    return { index, offset: Math.min(found ?? count, runsLength(blocks[index]?.runs)) };
  }

  const lengthOf = (n) => {
    if (n.nodeType === Node.TEXT_NODE) return n.data.length;
    if (n.nodeName === 'BR') return n.dataset?.filler ? 0 : 1;
    let total = 0;
    for (const c of n.childNodes) total += lengthOf(c);
    return total;
  };

  /** De plek in de pagina van een plek in het model. */
  function toDom({ index, offset }) {
    const text = textOf(index);
    if (!text) {
      const el = root.querySelector(`.nb[data-index="${index}"]`);
      return el ? { node: el, offset: 0 } : { node: root, offset: 0 };
    }
    let left = offset;
    let result = null;
    const walk = (n) => {
      if (result) return;
      if (n.nodeType === Node.TEXT_NODE) {
        if (left <= n.data.length) { result = { node: n, offset: left }; return; }
        left -= n.data.length;
        return;
      }
      if (n.nodeName === 'BR') {
        if (n.dataset.filler) return;
        if (left === 0) { result = { node: n.parentNode, offset: [...n.parentNode.childNodes].indexOf(n) }; return; }
        left -= 1;
        if (left === 0) { result = { node: n.parentNode, offset: [...n.parentNode.childNodes].indexOf(n) + 1 }; }
        return;
      }
      for (const c of n.childNodes) walk(c);
    };
    walk(text);
    return result ?? { node: text, offset: text.childNodes.length && text.lastChild.nodeName === 'BR' && text.lastChild.dataset.filler ? text.childNodes.length - 1 : text.childNodes.length };
  }

  function getSelection() {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) return null;
    const a = toModel(sel.anchorNode, sel.anchorOffset);
    const b = toModel(sel.focusNode, sel.focusOffset);
    if (!a || !b) return null;
    const [from, to] = a.index < b.index || (a.index === b.index && a.offset <= b.offset) ? [a, b] : [b, a];
    return { a: from, b: to, collapsed: from.index === to.index && from.offset === to.offset };
  }

  function setSelection(a, b = a) {
    const sel = document.getSelection();
    if (!sel) return;
    const x = toDom(a);
    const y = toDom(b);
    try {
      sel.setBaseAndExtent(x.node, x.offset, y.node, y.offset);
    } catch { /* een plek die niet (meer) bestaat: laat de selectie zoals ze is */ }
  }

  // ---------- veranderen ----------
  const snapshot = () => ({ blocks: JSON.stringify(blocks), sel: getSelection() });
  function remember(kind = 'edit') {
    const now = Date.now();
    if (kind === 'type' && now - lastTyped < TYPE_GROUP_MS && undoStack.at(-1)?.kind === 'type') { lastTyped = now; return; }
    lastTyped = kind === 'type' ? now : 0;
    undoStack.push({ ...snapshot(), kind });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
  }

  /** Een nieuwe toestand: tekenen, cursor terugzetten, melden. */
  function commit(next, sel, kind = 'edit') {
    remember(kind);
    blocks = next.length ? next : [{ type: 'p', level: 0, runs: [] }];
    render(sel);
    onChange();
    updateToolbar();
  }

  function restore(from, to) {
    const item = from.pop();
    if (!item) return;
    to.push({ ...snapshot(), kind: 'edit' });
    blocks = JSON.parse(item.blocks);
    render(item.sel ? { a: item.sel.a, b: item.sel.b } : null);
    onChange();
    updateToolbar();
  }

  /** Leest één blok terug uit de pagina na gewoon typen; geeft true als het model veranderde. */
  function syncBlock(index) {
    const text = textOf(index);
    const b = blocks[index];
    if (!text || !b) return false;
    const runs = readRuns(text, { raw: isRaw(b) });
    const before = JSON.stringify(b.runs);
    const after = JSON.stringify(runs);
    if (before === after) return false;
    blocks[index] = { ...b, runs };
    return true;
  }

  /** Was de pagina na het typen anders opgebouwd dan wij tekenen (bijvoorbeeld een <font> of een <div> van de browser), teken opnieuw. */
  function canonical(index) {
    const text = textOf(index);
    if (!text) return true;
    const probe = h('div', {});
    const b = blocks[index];
    probe.append(...(isRaw(b) ? [document.createTextNode(runsText(b.runs))] : b.runs.length ? runNodes(b.runs) : []));
    const clean = (s) => s.replace(/<br data-filler="1">/g, '');
    return clean(text.innerHTML) === clean(probe.innerHTML) || (isRaw(b) && text.textContent === runsText(b.runs));
  }

  // ---------- Markdown-sneltoetsen en het /-menu ----------
  const SHORTCUTS = [
    [/^[-*+] $/, () => ({ type: 'bullet' })],
    [/^\d{1,3}[.)] $/, () => ({ type: 'number' })],
    [/^\[ ?\] $/, () => ({ type: 'check', checked: false })],
    [/^\[[xX]\] $/, () => ({ type: 'check', checked: true })],
    [/^- \[ ?\] $/, () => ({ type: 'check', checked: false })],
    [/^# $/, () => ({ type: 'h1' })],
    [/^## $/, () => ({ type: 'h2' })],
    [/^### $/, () => ({ type: 'h3' })],
    [/^> $/, () => ({ type: 'quote' })],
    [/^```$/, () => ({ type: 'code' })],
  ];

  function applyShortcut(index, offset) {
    const b = blocks[index];
    if (!b || (b.type !== 'p' && !(b.type === 'bullet' && /^\[ ?\] $/.test(runsText(b.runs).slice(0, offset))))) return false;
    const head = runsText(b.runs).slice(0, offset);
    if (b.type === 'p' && /^(-{3,}|\*{3,}|_{3,})$/.test(runsText(b.runs))) {
      const next = blocks.slice();
      next.splice(index, 1, { type: 'rule', level: 0, runs: [] }, { type: 'p', level: 0, runs: [] });
      commit(next, { a: { index: index + 1, offset: 0 } });
      return true;
    }
    for (const [re, make] of SHORTCUTS) {
      if (!re.test(head)) continue;
      const made = make(b);
      const next = blocks.slice();
      const rest = sliceRuns(b.runs, offset);
      next[index] = { ...made, level: b.type === 'bullet' ? b.level : 0, runs: made.type === 'code' ? (runsText(rest) ? [{ text: runsText(rest) }] : []) : rest };
      if (made.type === 'check' && made.checked === undefined) next[index].checked = false;
      commit(next, { a: { index, offset: 0 } });
      return true;
    }
    return false;
  }

  const slash = { open: false, index: -1, start: 0, active: 0, items: [], el: null };
  const SLASH_ITEMS = () => [
    { id: 'check', label: t('note.slash.check'), keys: 'checklist taak taken todo to-do task vinkje' },
    { id: 'h1', label: t('note.slash.headingOne'), keys: 'kop titel heading h1 title' },
    { id: 'h2', label: t('note.slash.headingTwo'), keys: 'kop ondertitel heading h2 subtitle' },
    { id: 'h3', label: t('note.slash.headingThree'), keys: 'kop klein heading h3' },
    { id: 'bullet', label: t('note.slash.bullet'), keys: 'lijst punten opsomming bullet list ul' },
    { id: 'number', label: t('note.slash.number'), keys: 'genummerd nummers numbered ordered list ol' },
    { id: 'quote', label: t('note.slash.quote'), keys: 'citaat quote blockquote' },
    { id: 'code', label: t('note.slash.code'), keys: 'code codeblok snippet pre' },
    { id: 'p', label: t('note.slash.text'), keys: 'tekst gewoon text paragraph plain' },
    { id: 'link', label: t('note.slash.link'), keys: 'link url adres web address' },
    { id: 'table', label: t('note.slash.table'), keys: 'tabel table grid' },
    { id: 'rule', label: t('note.slash.rule'), keys: 'lijn scheiding divider rule line hr' },
  ];
  const fold = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

  function slashQuery() {
    const sel = getSelection();
    if (!sel || !sel.collapsed || sel.a.index !== slash.index || sel.a.offset <= slash.start) return null;
    const q = runsText(blocks[slash.index].runs).slice(slash.start + 1, sel.a.offset);
    return /\s/.test(q) || q.length > 20 || runsText(blocks[slash.index].runs)[slash.start] !== '/' ? null : q;
  }

  function openSlash(index, start) {
    Object.assign(slash, { open: true, index, start, active: 0 });
    slash.el ??= h('div', { class: 'nb-slash', role: 'listbox', 'aria-label': t('note.slash.title') });
    root.after(slash.el);
    drawSlash('');
  }
  function closeSlash() {
    slash.open = false;
    slash.el?.remove();
  }
  function drawSlash(q) {
    const words = fold(q);
    slash.items = SLASH_ITEMS().filter((it) => !words || fold(`${it.label} ${it.keys}`).includes(words));
    if (slash.items.length === 0) { closeSlash(); return; }
    slash.active = Math.min(slash.active, slash.items.length - 1);
    slash.el.replaceChildren(...slash.items.map((it, n) => h('button', {
      type: 'button', class: `nb-slash-item${n === slash.active ? ' active' : ''}`, role: 'option', 'aria-selected': String(n === slash.active), tabIndex: -1,
      dataset: { slash: it.id }, onmousedown: (e) => { e.preventDefault(); chooseSlash(it); },
    }, h('span', { class: `nb-slash-icon nb-slash-${it.id}`, 'aria-hidden': 'true' }), it.label)));
    // onder de cursor
    const range = document.getSelection()?.rangeCount ? document.getSelection().getRangeAt(0) : null;
    const rect = range?.getClientRects()[0] ?? textOf(slash.index)?.getBoundingClientRect();
    const host = root.offsetParent ?? root.parentElement;
    if (rect && host) {
      const base = host.getBoundingClientRect();
      slash.el.style.left = `${Math.max(0, Math.min(rect.left - base.left, base.width - 240))}px`;
      slash.el.style.top = `${rect.bottom - base.top + host.scrollTop + 4}px`;
    }
    slash.el.querySelector('.active')?.scrollIntoView?.({ block: 'nearest' });
  }

  async function chooseSlash(item) {
    const sel = getSelection();
    const end = sel?.a.index === slash.index ? sel.a.offset : slash.start + 1;
    const index = slash.index;
    closeSlash();
    const b = blocks[index];
    const cleaned = normalizeRuns([...sliceRuns(b.runs, 0, slash.start), ...sliceRuns(b.runs, end)]);
    let next = blocks.slice();
    next[index] = { ...b, runs: cleaned };
    if (item.id === 'link') {
      commit(next, { a: { index, offset: slash.start } });
      await insertLink();
      return;
    }
    if (item.id === 'table') {
      const table = { type: 'table', level: 0, runs: [{ text: `| ${t('note.table.a')} | ${t('note.table.b')} |\n|---|---|\n|  |  |` }] };
      next.splice(index + 1, 0, table, { type: 'p', level: 0, runs: [] });
      if (!cleaned.length && b.type === 'p') next.splice(index, 1);
      commit(next, { a: { index: cleaned.length || b.type !== 'p' ? index + 1 : index, offset: 2 } });
      return;
    }
    if (item.id === 'rule') {
      // een lijn vervangt een lege regel, of komt na de regel; daarna altijd een regel om verder te typen
      const rule = { type: 'rule', level: 0, runs: [] };
      const at = cleaned.length || b.type !== 'p' ? index + 1 : index;
      next.splice(at, at === index ? 1 : 0, rule);
      if (!next[at + 1] || next[at + 1].type === 'rule') next.splice(at + 1, 0, { type: 'p', level: 0, runs: [] });
      commit(next, { a: { index: at + 1, offset: 0 } });
      return;
    }
    next = setType(next, index, item.id);
    commit(next, { a: { index, offset: Math.min(slash.start, runsLength(next[index].runs)) } });
  }

  // ---------- opmaak en soorten (werkbalk en sneltoetsen) ----------
  function eachInSelection(sel, fn) {
    for (let i = sel.a.index; i <= sel.b.index; i++) {
      const len = runsLength(blocks[i].runs);
      fn(i, i === sel.a.index ? sel.a.offset : 0, i === sel.b.index ? sel.b.offset : len);
    }
  }

  function toggleInline(mark, value = true) {
    const sel = getSelection();
    if (!sel || readOnly) return;
    if (sel.collapsed) {
      // geen selectie: geldt voor wat je hierna typt
      const b = blocks[sel.a.index];
      const current = sliceRuns(b.runs, Math.max(0, sel.a.offset - 1), sel.a.offset)[0] ?? {};
      const base = pendingMarks ?? { ...current, text: undefined };
      const on = mark === 'hl' ? base.hl === value : Boolean(base[mark]);
      pendingMarks = { ...base, [mark]: on ? undefined : value };
      if (mark === 'code' && !on) pendingMarks = { code: true };
      updateToolbar();
      return;
    }
    let all = true;
    eachInSelection(sel, (i, from, to) => {
      if (from === to || isRaw(blocks[i])) return;
      const part = sliceRuns(blocks[i].runs, from, to);
      if (!part.every((r) => (mark === 'hl' ? r.hl === value : r[mark]))) all = false;
    });
    const next = blocks.slice();
    eachInSelection(sel, (i, from, to) => {
      if (from === to || isRaw(blocks[i])) return;
      next[i] = { ...blocks[i], runs: setMark(blocks[i].runs, from, to, mark, all ? null : value) };
    });
    commit(next, sel);
  }

  function setBlockType(type) {
    const sel = getSelection();
    if (!sel || readOnly) return;
    let all = true;
    eachInSelection(sel, (i) => { if (blocks[i].type !== type) all = false; });
    let next = blocks.slice();
    eachInSelection(sel, (i) => { if (next[i].type !== 'rule') next = setType(next, i, all ? 'p' : type); });
    commit(next, { a: clampPos(sel.a, next), b: clampPos(sel.b, next) });
  }

  const clampPos = (p, list = blocks) => ({ index: Math.min(p.index, list.length - 1), offset: Math.min(p.offset, runsLength(list[Math.min(p.index, list.length - 1)].runs)) });

  function changeIndent(delta) {
    const sel = getSelection();
    if (!sel || readOnly) return false;
    let next = blocks.slice();
    let any = false;
    eachInSelection(sel, (i) => { if (isList(next[i])) { next = indent(next, i, delta); any = true; } });
    if (any) commit(next, sel);
    return any;
  }

  async function insertLink() {
    const sel = getSelection();
    if (!sel || readOnly) return;
    const b = blocks[sel.a.index];
    const current = sliceRuns(b.runs, sel.collapsed ? Math.max(0, sel.a.offset - 1) : sel.a.offset, sel.collapsed ? sel.a.offset : sel.b.offset)[0]?.link ?? null;
    const answer = await onLink(current);
    if (answer === null || answer === undefined) { setSelection(sel.a, sel.b); return; }
    const href = answer === '' ? null : safeHref(/^[a-z][a-z0-9+.-]*:/i.test(answer) ? answer : `https://${answer}`);
    if (answer !== '' && !href) return;
    const next = blocks.slice();
    if (sel.collapsed) {
      if (!href) return;
      next[sel.a.index] = { ...b, runs: insertText(b.runs, sel.a.offset, answer, { link: href }) };
      commit(next, { a: { index: sel.a.index, offset: sel.a.offset + answer.length } });
      return;
    }
    eachInSelection(sel, (i, from, to) => {
      if (from === to || isRaw(blocks[i])) return;
      next[i] = { ...blocks[i], runs: setMark(blocks[i].runs, from, to, 'link', href) };
    });
    commit(next, sel);
  }

  function toggleCheckAt(index) {
    if (readOnly || blocks[index]?.type !== 'check') return;
    const sel = getSelection();
    const r = toggleCheck(blocks, index, { sort: checkedBottom });
    const moved = sel && sel.a.index === index ? { a: { index: r.index, offset: sel.a.offset } } : sel;
    commit(r.blocks, moved);
  }

  // ---------- invoer ----------
  function replaceSelection(sel, inserted) {
    let r = sel.collapsed ? { blocks, index: sel.a.index, offset: sel.a.offset } : deleteRange(blocks, sel.a, sel.b);
    if (inserted) r = insertBlocks(r.blocks, r.index, r.offset, inserted);
    return r;
  }

  on(root, 'beforeinput', (e) => {
    if (readOnly) { e.preventDefault(); return; }
    const sel = getSelection();
    if (!sel) return;
    const type = e.inputType;
    const crosses = !sel.collapsed && sel.a.index !== sel.b.index;
    const onRule = blocks[sel.a.index]?.type === 'rule';
    switch (type) {
      case 'insertText': case 'insertReplacementText': {
        const data = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
        if (!crosses && !pendingMarks && !onRule) {
          remember('type');
          return; // de browser typt; daarna leest 'input' de regel terug
        }
        e.preventDefault();
        let r = sel.collapsed ? { blocks, index: sel.a.index, offset: sel.a.offset } : deleteRange(blocks, sel.a, sel.b);
        const b = r.blocks[r.index];
        const next = r.blocks.slice();
        if (b.type === 'rule') {
          next.splice(r.index + 1, 0, { type: 'p', level: 0, runs: [{ text: data }] });
          commit(next, { a: { index: r.index + 1, offset: data.length } }, 'type');
          return;
        }
        const marks = pendingMarks ? Object.fromEntries(Object.entries(pendingMarks).filter(([k, v]) => v && k !== 'text')) : null;
        next[r.index] = { ...b, runs: isRaw(b) ? [{ text: runsText(b.runs).slice(0, r.offset) + data + runsText(b.runs).slice(r.offset) }] : insertText(b.runs, r.offset, data, marks) };
        pendingMarks = null;
        commit(next, { a: { index: r.index, offset: r.offset + data.length } }, 'type');
        return;
      }
      case 'insertCompositionText': return;
      case 'insertParagraph': case 'insertLineBreak': {
        e.preventDefault();
        closeSlash();
        let r = sel.collapsed ? { blocks, index: sel.a.index, offset: sel.a.offset } : deleteRange(blocks, sel.a, sel.b);
        const b = r.blocks[r.index];
        if (isRaw(b)) {
          const text = runsText(b.runs);
          const lines = text.slice(0, r.offset).split('\n');
          // Enter op een lege laatste regel van een codeblok: eruit, met een gewone regel erna
          if (r.offset === text.length && lines.at(-1) === '' && text.length > 0) {
            const next = r.blocks.slice();
            next[r.index] = { ...b, runs: [{ text: text.replace(/\n$/, '') }].filter((x) => x.text) };
            next.splice(r.index + 1, 0, { type: 'p', level: 0, runs: [] });
            commit(next, { a: { index: r.index + 1, offset: 0 } });
            return;
          }
          const next = r.blocks.slice();
          next[r.index] = { ...b, runs: [{ text: `${text.slice(0, r.offset)}\n${text.slice(r.offset)}` }] };
          commit(next, { a: { index: r.index, offset: r.offset + 1 } });
          return;
        }
        r = splitBlock(r.blocks, r.index, r.offset);
        commit(r.blocks, { a: { index: r.index, offset: r.offset } });
        return;
      }
      case 'deleteContentBackward': case 'deleteWordBackward': case 'deleteSoftLineBackward': case 'deleteHardLineBackward': {
        if (!sel.collapsed) {
          if (!crosses && !onRule) { remember('edit'); return; }
          e.preventDefault();
          const r = deleteRange(blocks, sel.a, sel.b);
          commit(r.blocks, { a: { index: r.index, offset: r.offset } });
          return;
        }
        if (sel.a.offset > 0 && !onRule) { remember('type'); return; }
        e.preventDefault();
        if (onRule) {
          // een lijn weghalen; de cursor naar het eind van de regel erboven
          const next = blocks.filter((_, k) => k !== sel.a.index);
          const prev = Math.max(0, sel.a.index - 1);
          commit(next, { a: { index: Math.min(prev, next.length - 1), offset: next.length ? runsLength(next[Math.min(prev, next.length - 1)].runs) : 0 } });
          return;
        }
        const r = backspaceAtStart(blocks, sel.a.index);
        if (r) commit(r.blocks, { a: { index: r.index, offset: r.offset } });
        return;
      }
      case 'deleteContentForward': case 'deleteWordForward': case 'deleteSoftLineForward': case 'deleteHardLineForward': {
        if (!sel.collapsed) {
          if (!crosses && !onRule) { remember('edit'); return; }
          e.preventDefault();
          const r = deleteRange(blocks, sel.a, sel.b);
          commit(r.blocks, { a: { index: r.index, offset: r.offset } });
          return;
        }
        if (sel.a.offset < runsLength(blocks[sel.a.index].runs) && !onRule) { remember('type'); return; }
        e.preventDefault();
        const r = deleteAtEnd(blocks, sel.a.index);
        if (r) commit(r.blocks, { a: { index: r.index, offset: r.offset } });
        return;
      }
      case 'insertFromPaste': case 'insertFromDrop': case 'insertFromYank': case 'insertFromPasteAsQuotation': {
        e.preventDefault();
        if (type === 'insertFromDrop') return; // slepen binnen de editor doen we niet: dat haalt het model en de pagina uit elkaar
        const dt = e.dataTransfer;
        pasteFrom(dt, sel);
        return;
      }
      case 'deleteByCut': case 'deleteByDrag': {
        e.preventDefault();
        if (type === 'deleteByDrag' || sel.collapsed) return;
        const r = deleteRange(blocks, sel.a, sel.b);
        commit(r.blocks, { a: { index: r.index, offset: r.offset } });
        return;
      }
      case 'historyUndo': e.preventDefault(); restore(undoStack, redoStack); return;
      case 'historyRedo': e.preventDefault(); restore(redoStack, undoStack); return;
      case 'formatBold': e.preventDefault(); toggleInline('b'); return;
      case 'formatItalic': e.preventDefault(); toggleInline('i'); return;
      case 'formatUnderline': e.preventDefault(); toggleInline('u'); return;
      case 'formatStrikeThrough': e.preventDefault(); toggleInline('s'); return;
      default:
        if (type.startsWith('format') || crosses) e.preventDefault();
    }
  });

  function pasteFrom(dt, sel) {
    if (!dt) return;
    let inserted = null;
    const own = dt.getData(MIME);
    if (own) {
      try {
        const parsed = JSON.parse(own);
        if (Array.isArray(parsed)) inserted = fromMarkdown(toMarkdown(parsed.slice(0, 5000))); // langs Markdown: zo blijft alleen wat geldig is
      } catch { /* geen geldige inhoud: gewoon de tekst */ }
    }
    const html = dt.getData('text/html');
    if (!inserted && html) inserted = htmlToBlocks(html);
    if (!inserted || inserted.length === 0) inserted = textToBlocks(dt.getData('text/plain') ?? '');
    if (!inserted.length) return;
    const r = replaceSelection(sel, inserted);
    commit(r.blocks, { a: { index: r.index, offset: r.offset } });
  }

  on(root, 'input', (e) => {
    if (composing || e.isComposing) return;
    afterNativeInput();
  });
  on(root, 'compositionstart', () => { composing = true; });
  on(root, 'compositionend', () => { composing = false; afterNativeInput(); });

  function afterNativeInput() {
    // Eerst de regel terug lezen, dan pas de cursor in het model bepalen: die wordt begrensd op de lengte van de regel in het model,
    // en die is vóór het terug lezen nog de oude (anders staat de cursor één teken te vroeg).
    const anchor = document.getSelection()?.anchorNode;
    const el = anchor && root.contains(anchor) ? blockOf(anchor) : null;
    const index = el ? Number(el.dataset.index) : null;
    if (index === null) { resyncAll(); return; }
    // De browser kan bij het typen een regel splitsen of samenvoegen als wij een geval missen: dan alles terug lezen.
    if (root.querySelectorAll('.nb').length !== blocks.length || !root.querySelector(`.nb[data-index="${index}"]`)) { resyncAll(); return; }
    const changed = syncBlock(index);
    if (!changed) return;
    const sel = getSelection() ?? { a: { index, offset: runsLength(blocks[index].runs) } };
    root.querySelector(`.nb[data-index="${index}"]`)?.classList.toggle('is-empty', blocks[index].runs.length === 0);
    if (!canonical(index)) render(sel);
    if (applyShortcut(index, sel.a.offset)) return;
    // het /-menu: een / aan het begin of na een spatie
    const text = runsText(blocks[index].runs);
    const typed = text[sel.a.offset - 1];
    if (!slash.open && typed === '/' && (sel.a.offset === 1 || /\s/.test(text[sel.a.offset - 2] ?? ' ')) && !isRaw(blocks[index])) openSlash(index, sel.a.offset - 1);
    else if (slash.open) {
      const q = slashQuery();
      if (q === null) closeSlash(); else drawSlash(q);
    }
    root.classList.toggle('ned-empty', blocks.length === 1 && blocks[0].type === 'p' && blocks[0].runs.length === 0);
    onChange();
  }

  /** Noodgeval: de pagina en het model lopen uiteen. Lees alle tekst terug als gewone regels per blok. */
  function resyncAll() {
    const els = [...root.querySelectorAll('.nb')];
    const next = [];
    for (const el of els) {
      const i = Number(el.dataset.index);
      const old = blocks[i] ?? { type: 'p', level: 0, runs: [] };
      const text = el.querySelector('.nb-text');
      next.push(text ? { ...old, runs: readRuns(text, { raw: isRaw(old) }) } : old);
    }
    blocks = next.length ? next : [{ type: 'p', level: 0, runs: [] }];
    const sel = getSelection();
    render(sel);
    onChange();
  }

  // ---------- toetsen ----------
  on(root, 'keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (slash.open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slash.active = (slash.active + (e.key === 'ArrowDown' ? 1 : -1) + slash.items.length) % slash.items.length;
        drawSlash(slashQuery() ?? '');
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseSlash(slash.items[slash.active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSlash(); return; }
    }
    if (readOnly) return;
    if (mod && !e.altKey) {
      const key = e.key.toLowerCase();
      const shift = e.shiftKey;
      const act = {
        b: () => toggleInline('b'), i: () => toggleInline('i'), u: () => toggleInline('u'), e: () => toggleInline('code'), k: () => insertLink(),
        z: () => restore(shift ? redoStack : undoStack, shift ? undoStack : redoStack), y: () => restore(redoStack, undoStack),
      }[key];
      const shifted = shift ? { x: () => toggleInline('s'), h: () => toggleInline('hl', 'yellow'), 7: () => setBlockType('number'), 8: () => setBlockType('bullet'), 9: () => setBlockType('check') }[key] ?? { '&': () => setBlockType('number'), '*': () => setBlockType('bullet'), '(': () => setBlockType('check') }[e.key] : null;
      if (e.key === 'Enter') {
        const sel = getSelection();
        if (sel && blocks[sel.a.index]?.type === 'check') { e.preventDefault(); toggleCheckAt(sel.a.index); }
        return;
      }
      if (shifted) { e.preventDefault(); shifted(); return; }
      if (act && !(shift && key !== 'z')) { e.preventDefault(); act(); return; }
    }
    if (e.ctrlKey && e.altKey && /^[0-3]$/.test(e.key)) { e.preventDefault(); setBlockType(['p', 'h1', 'h2', 'h3'][Number(e.key)]); return; }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      const sel = getSelection();
      if (sel && isList(blocks[sel.a.index])) { e.preventDefault(); changeIndent(e.shiftKey ? -1 : 1); }
      return;
    }
    if (e.key === 'ArrowUp' && !e.shiftKey) {
      const sel = getSelection();
      if (sel?.collapsed && sel.a.index === 0 && sel.a.offset === 0) { e.preventDefault(); onExitUp(); }
    }
  });

  // een vinkje of een inklapregel aanklikken; een klik onder de laatste regel maakt een nieuwe regel als de laatste geen gewone is
  on(root, 'mousedown', (e) => {
    const box = e.target.closest?.('.nb-box');
    if (box) { e.preventDefault(); toggleCheckAt(Number(box.dataset.box)); return; }
    const foldButton = e.target.closest?.('.nb-fold-button');
    if (foldButton) {
      e.preventDefault();
      const n = Number(foldButton.dataset.fold);
      if (!closedFolds.delete(n)) closedFolds.add(n);
      render(getSelection());
      return;
    }
    const link = e.target.closest?.('a.nb-link');
    if (link && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(link.href, '_blank', 'noopener,noreferrer'); }
  });
  on(root, 'click', (e) => {
    if (readOnly || e.target !== root) return;
    const last = root.lastElementChild;
    if (last && e.clientY > last.getBoundingClientRect().bottom) {
      const b = blocks.at(-1);
      if (b.type !== 'p' || b.runs.length > 0) commit([...blocks, { type: 'p', level: 0, runs: [] }], { a: { index: blocks.length, offset: 0 } });
      else setSelection({ index: blocks.length - 1, offset: 0 });
    }
  });

  // kopiëren en knippen: als tekst (Markdown), als eenvoudige HTML en als blokken voor plakken in een andere notitie
  function selectedBlocks(sel) {
    const out = [];
    eachInSelection(sel, (i, from, to) => {
      const b = blocks[i];
      out.push({ ...b, runs: isRaw(b) ? [{ text: runsText(b.runs).slice(from, to) }].filter((r) => r.text) : sliceRuns(b.runs, from, to) });
    });
    return out;
  }
  const onCopy = (e) => {
    const sel = getSelection();
    if (!sel || sel.collapsed) return;
    const part = selectedBlocks(sel);
    e.preventDefault();
    const html = h('div', {}, part.map((b) => (b.type === 'rule' ? h('hr') : h(/^h[1-3]$/.test(b.type) ? b.type : b.type === 'quote' ? 'blockquote' : isList(b) ? 'li' : isRaw(b) ? 'pre' : 'p', {}, ...(isRaw(b) ? [runsText(b.runs)] : runNodes(b.runs))))));
    e.clipboardData.setData('text/plain', part.length === 1 && !isList(part[0]) && part[0].type === 'p' ? runsText(part[0].runs) : toMarkdown(part));
    e.clipboardData.setData('text/html', html.innerHTML);
    e.clipboardData.setData(MIME, JSON.stringify(part));
    if (e.type === 'cut' && !readOnly) {
      const r = deleteRange(blocks, sel.a, sel.b);
      commit(r.blocks, { a: { index: r.index, offset: r.offset } });
    }
  };
  on(root, 'copy', onCopy);
  on(root, 'cut', onCopy);
  on(root, 'paste', (e) => {
    // een browser zonder beforeinput voor plakken
    if (readOnly) { e.preventDefault(); return; }
    const sel = getSelection();
    if (!sel) return;
    e.preventDefault();
    pasteFrom(e.clipboardData, sel);
  });
  on(document, 'selectionchange', () => {
    const sel = getSelection();
    if (!sel) return;
    if (slash.open && slashQuery() === null) closeSlash();
    updateToolbar();
  });

  // ---------- werkbalk ----------
  const toolbar = h('div', { class: 'ned-toolbar', role: 'toolbar', 'aria-label': t('note.toolbar') });
  const tool = (id, glyph, label, run, extra = '') => h('button', {
    type: 'button', class: `ned-tool ${extra}`, title: label, 'aria-label': label, dataset: { fk: `note-tool:${id}`, tool: id },
    onmousedown: (e) => e.preventDefault(), // de selectie in de tekst blijft staan
    onclick: run,
  }, glyph);
  const HL_LABEL = { yellow: () => t('note.hl.yellow'), green: () => t('note.hl.green'), blue: () => t('note.hl.blue'), pink: () => t('note.hl.pink'), purple: () => t('note.hl.purple') };
  const hlPicker = h('div', { class: 'ned-hl-picker', hidden: true, role: 'group', 'aria-label': t('note.tb.highlight') },
    ...HIGHLIGHTS.map((c) => h('button', {
      type: 'button', class: `ned-hl-swatch hl-${c}`, title: HL_LABEL[c](), 'aria-label': HL_LABEL[c](), dataset: { fk: `note-hl:${c}` },
      onmousedown: (e) => e.preventDefault(), onclick: () => { hlPicker.hidden = true; toggleInline('hl', c); },
    })),
    h('button', { type: 'button', class: 'ned-hl-swatch ned-hl-none', title: t('note.hl.none'), 'aria-label': t('note.hl.none'), dataset: { fk: 'note-hl:none' }, onmousedown: (e) => e.preventDefault(), onclick: () => { hlPicker.hidden = true; clearHighlight(); } }, '×'));
  function clearHighlight() {
    const sel = getSelection();
    if (!sel || sel.collapsed) return;
    const next = blocks.slice();
    eachInSelection(sel, (i, from, to) => { if (from < to && !isRaw(blocks[i])) next[i] = { ...blocks[i], runs: setMark(blocks[i].runs, from, to, 'hl', null) }; });
    commit(next, sel);
  }
  const styleSelect = h('select', {
    class: 'ned-style', 'aria-label': t('note.tb.style'), dataset: { fk: 'note-tool:style' },
    onchange: (e) => { setBlockType(e.target.value); root.focus(); },
  }, ...[['p', t('note.slash.text')], ['h1', t('note.slash.headingOne')], ['h2', t('note.slash.headingTwo')], ['h3', t('note.slash.headingThree')]].map(([v, l]) => h('option', { value: v }, l)));
  if (!readOnly) {
    toolbar.append(
      styleSelect,
      tool('bold', 'B', `${t('note.tb.bold')} (Ctrl+B)`, () => toggleInline('b'), 'tb-bold'),
      tool('italic', 'I', `${t('note.tb.italic')} (Ctrl+I)`, () => toggleInline('i'), 'tb-italic'),
      tool('underline', 'U', `${t('note.tb.underline')} (Ctrl+U)`, () => toggleInline('u'), 'tb-underline'),
      tool('strike', 'S', `${t('note.tb.strike')} (Ctrl+Shift+X)`, () => toggleInline('s'), 'tb-strike'),
      h('span', { class: 'ned-hl-wrap' }, tool('highlight', 'A', t('note.tb.highlight'), () => { hlPicker.hidden = !hlPicker.hidden; }, 'tb-highlight'), hlPicker),
      tool('code', '</>', `${t('note.tb.code')} (Ctrl+E)`, () => toggleInline('code'), 'tb-code'),
      tool('link', '🔗', `${t('note.tb.link')} (Ctrl+K)`, () => insertLink()),
      h('span', { class: 'ned-sep', 'aria-hidden': 'true' }),
      tool('bullets', '•', t('note.tb.bullets'), () => setBlockType('bullet')),
      tool('numbers', '1.', t('note.tb.numbers'), () => setBlockType('number')),
      tool('tasks', '☐', t('note.tb.tasks'), () => setBlockType('check')),
      tool('quote', '❝', t('note.tb.quote'), () => setBlockType('quote')),
      tool('codeblock', '{ }', t('note.tb.codeBlock'), () => setBlockType('code'), 'tb-code'),
      tool('outdent', '⇤', `${t('note.tb.outdent')} (Shift+Tab)`, () => changeIndent(-1)),
      tool('indent', '⇥', `${t('note.tb.indent')} (Tab)`, () => changeIndent(1)),
      h('span', { class: 'ned-sep', 'aria-hidden': 'true' }),
      tool('undo', '↶', `${t('note.tb.undo')} (Ctrl+Z)`, () => restore(undoStack, redoStack)),
      tool('redo', '↷', `${t('note.tb.redo')} (Ctrl+Shift+Z)`, () => restore(redoStack, undoStack)),
    );
  }

  function updateToolbar() {
    if (readOnly) return;
    const sel = getSelection();
    if (!sel) return;
    const b = blocks[sel.a.index];
    const runs = b ? b.runs : [];
    const at = sel.collapsed ? sliceRuns(runs, Math.max(0, sel.a.offset - 1), sel.a.offset)[0] ?? {} : null;
    const has = (mark) => {
      if (pendingMarks && sel.collapsed) return Boolean(pendingMarks[mark]);
      if (at) return Boolean(at[mark]);
      let all = true;
      eachInSelection(sel, (i, from, to) => { if (from < to && !sliceRuns(blocks[i].runs, from, to).every((r) => r[mark])) all = false; });
      return all;
    };
    const press = (id, on) => toolbar.querySelector(`[data-tool="${id}"]`)?.setAttribute('aria-pressed', String(Boolean(on)));
    press('bold', has('b'));
    press('italic', has('i'));
    press('underline', has('u'));
    press('strike', has('s'));
    press('code', has('code'));
    press('highlight', has('hl'));
    press('link', has('link'));
    press('bullets', b?.type === 'bullet');
    press('numbers', b?.type === 'number');
    press('tasks', b?.type === 'check');
    press('quote', b?.type === 'quote');
    press('codeblock', b?.type === 'code');
    styleSelect.value = ['h1', 'h2', 'h3'].includes(b?.type) ? b.type : 'p';
    toolbar.querySelector('[data-tool="undo"]')?.toggleAttribute('disabled', undoStack.length === 0);
    toolbar.querySelector('[data-tool="redo"]')?.toggleAttribute('disabled', redoStack.length === 0);
  }

  render();
  updateToolbar();

  return {
    el: root,
    toolbar,
    getMarkdown: () => toMarkdown(blocks),
    blocks: () => blocks,
    wordCount: () => wordCount(blocks),
    counts: () => checklistCounts(blocks),
    /** Van buiten (bijvoorbeeld een ander apparaat): alleen als de tekst echt anders is, en zonder de cursor kwijt te raken als het kan. */
    setMarkdown(md) {
      if (md === toMarkdown(blocks)) return;
      const sel = getSelection();
      blocks = fromMarkdown(md);
      render(sel ? { a: clampPos(sel.a), b: clampPos(sel.b) } : null);
    },
    setCheckedBottom(v) { checkedBottom = v; render(getSelection()); },
    uncheckAll() { commit(uncheckAll(blocks), null); },
    deleteChecked() { commit(deleteChecked(blocks), { a: { index: 0, offset: 0 } }); },
    focus(where = 'start') {
      root.focus({ preventScroll: true });
      if (where === 'end') setSelection({ index: blocks.length - 1, offset: runsLength(blocks.at(-1).runs) });
      else setSelection({ index: 0, offset: 0 });
    },
    undo: () => restore(undoStack, redoStack),
    destroy() { closeSlash(); for (const off of listeners) off(); },
  };
}
