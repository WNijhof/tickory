// Zoeken voor het zoekveld: taken (titel, beschrijving, labelnamen), opmerkingen, projecten, secties, labels en filters.
//
//   search(view, 'tandarts bel', { userId })   -> treffers, de beste eerst
//
// Hoofdletters, accenten en spaties tellen niet mee ("cafe" vindt "Café", ook als de é ontleed is getypt). Alle woorden
// moeten voorkomen, in willekeurige volgorde ("bel tandarts" vindt "Tandarts bellen"). Een woord is ook een stuk van een
// woord: "tand" vindt "tandarts".
//
// Volgorde: titel begint met een zoekwoord (0), titel bevat alle woorden (1), de woorden staan verspreid over titel,
// beschrijving en labels (2). Binnen dezelfde klasse eerst projecten, labels, filters en secties, dan taken; dan een titel
// waarin de zoektekst aaneengesloten staat, dan de kortste titel. Afgevinkte taken staan helemaal achteraan.
// Opmerkingen (bij een taak of een project) tellen alleen mee als alle woorden in dezelfde opmerking staan; ze komen na de
// taken, in klasse 2, en een opmerking bij een afgevinkte taak staat helemaal achteraan.
// Gearchiveerde projecten en secties (en wat daarin zit) doen niet mee. Een lege zoekterm geeft niets.

import { foldMap, foldText, foldWords, foldedField, occurrences } from './fold.js';
import { isForeignLabel } from './selectors.js';

const MAX_TEXT = 200;
const KIND_RANK = { project: 0, label: 1, filter: 2, section: 3, task: 4, comment: 5 };

/** Plekken in de oorspronkelijke tekst waar een van de woorden staat, samengevoegd: [{ start, length }]. */
function marksIn(text, words) {
  const fm = foldMap(text);
  const ranges = [];
  for (const w of words) {
    for (const [a, b] of occurrences(fm.text, w)) ranges.push([fm.starts[a], fm.ends[b - 1]]);
  }
  ranges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged.map(([start, end]) => ({ start, length: end - start }));
}

/**
 * Knipt een tekst in stukken om de markeringen van een treffer te tonen: [{ text, mark }], in volgorde, zonder lege stukken.
 * Geeft de stukken terug als gewone tekst (nooit als HTML); wie ze toont, zet de stukken met `mark: true` in een markering.
 * Markeringen buiten de tekst of die elkaar overlappen worden genegeerd.
 * @param {string} text
 * @param {{ start: number, length: number }[]} marks
 * @returns {{ text: string, mark: boolean }[]}
 */
export function markSegments(text, marks) {
  const s = String(text ?? '');
  const out = [];
  let at = 0;
  for (const m of marks ?? []) {
    const start = Math.max(m.start, at);
    const end = Math.min(m.start + m.length, s.length);
    if (!(m.length > 0) || end <= start) continue;
    if (start > at) out.push({ text: s.slice(at, start), mark: false });
    out.push({ text: s.slice(start, end), mark: true });
    at = end;
  }
  if (at < s.length) out.push({ text: s.slice(at), mark: false });
  return out;
}

/** Een stuk van een lange beschrijving rond de eerste treffer, op één regel; de markeringen horen bij de nieuwe tekst. */
function snippet(text, marks) {
  const flat = text.replace(/\s/gu, ' ');
  const first = marks[0]?.start ?? 0;
  const from = Math.max(0, first - 30);
  const to = Math.min(flat.length, from + 100);
  const lead = from > 0 ? '…' : '';
  return {
    text: `${lead}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`,
    marks: marks
      .filter((m) => m.start >= from && m.start < to)
      .map((m) => ({ start: m.start - from + lead.length, length: Math.min(m.length, to - m.start) })),
  };
}

/** De klasse (0, 1 of 2) van een naam of titel voor deze woorden, of null als niet alle woorden erin passen. */
function tierOf(title, words, rest) {
  let inTitle = true;
  let atStart = false;
  for (const w of words) {
    const at = title.indexOf(w);
    if (at < 0) inTitle = false;
    else if (at === 0) atStart = true;
  }
  if (inTitle) return atStart ? 0 : 1;
  if (rest === null) return null;
  for (const w of words) if (!title.includes(w) && !rest.includes(w)) return null;
  return 2;
}

/**
 * @param {{ projects: Map<string, object>, sections: Map<string, object>, tasks: Map<string, object>, labels: Map<string, object>, filters: Map<string, object> }} view
 * @param {string} text
 * @param {{ userId?: string | null, limit?: number }} [options]
 * @returns {{
 *   kind: 'task' | 'project' | 'section' | 'label' | 'filter' | 'comment',
 *   id: string,
 *   title: string,                        // titel of naam
 *   project: { id: string, name: string } | null,   // taak, sectie en opmerking: het project; subproject: het bovenliggende project
 *   on?: { kind: 'task' | 'project', id: string, name: string },   // alleen opmerkingen: waar de opmerking bij hoort
 *   checked: boolean,                     // afgevinkte taak
 *   foreign?: boolean,                    // label van iemand anders (alleen lezen)
 *   tier: 0 | 1 | 2,
 *   where: 'title' | 'name' | 'description' | 'label',   // waar de treffer is gevonden
 *   text: string,                         // de tekst waarin de markeringen staan (titel, een stuk beschrijving of labelnaam)
 *   marks: { start: number, length: number }[],          // plekken in `text`, op volgorde
 *   color: string | null,
 *   due?: object | null, priority?: number,              // alleen taken
 * }[]}
 */
export function search(view, text, { userId = null, limit = 50 } = {}) {
  const typed = String(text ?? '').slice(0, MAX_TEXT);
  const words = foldWords(typed);
  if (words.length === 0) return [];
  const max = Math.min(Math.max(Math.trunc(Number(limit)) || 0, 1), 500);
  const phrase = foldText(typed).trim();

  const projects = view.projects ?? new Map();
  const hidden = new Set(); // gearchiveerde projecten
  for (const p of projects.values()) if (p.is_archived) hidden.add(p.id);
  const hiddenSections = new Set();
  for (const s of view.sections?.values() ?? []) if (s.is_archived || hidden.has(s.project_id)) hiddenSections.add(s.id);

  /** @type {{ kind: string, row: object, tier: number, title: string, rank: number[] }[]} */
  const found = [];
  const consider = (kind, row, rest, extra = 0) => {
    const title = foldedField(row, kind === 'task' || kind === 'comment' ? 'content' : 'name');
    let tier = tierOf(title, words, rest);
    if (tier === null) return;
    if (kind === 'comment') tier = 2; // een opmerking komt altijd na de taken, hoe goed de woorden ook passen
    found.push({ kind, row, tier, title, extra, contiguous: title.includes(phrase) ? 0 : 1, checked: (kind === 'task' ? row.checked : kind === 'comment' ? checkedParent : false) ? 1 : 0 });
  };
  let checkedParent = false; // voor opmerkingen: is de taak waar ze bij hoort afgevinkt

  for (const p of projects.values()) if (!hidden.has(p.id)) consider('project', p, foldedField(p, 'description'));
  for (const s of view.sections?.values() ?? []) if (!hiddenSections.has(s.id)) consider('section', s, null);
  for (const l of view.labels?.values() ?? []) consider('label', l, null, isForeignLabel(l, userId) ? 1 : 0);
  for (const f of view.filters?.values() ?? []) if (!isForeignLabel(f, userId)) consider('filter', f, foldedField(f, 'query'));
  for (const t of view.tasks?.values() ?? []) {
    if (hidden.has(t.project_id)) continue;
    const title = foldedField(t, 'content');
    // beschrijving en labelnamen tellen pas mee als de titel niet alle woorden bevat
    let rest = null;
    if (!words.every((w) => title.includes(w))) {
      const names = (t.labels ?? []).map((id) => view.labels?.get(id)).filter(Boolean).map((l) => foldedField(l, 'name'));
      rest = `${foldedField(t, 'description')} ${names.join(' ')}`;
    }
    consider('task', t, rest);
  }
  for (const c of view.comments?.values() ?? []) {
    const task = c.task_id ? view.tasks?.get(c.task_id) : null;
    if (c.task_id && !task) continue;
    if (hidden.has(task ? task.project_id : c.project_id)) continue;
    checkedParent = Boolean(task?.checked);
    consider('comment', c, null);
  }

  found.sort((a, b) => a.checked - b.checked || a.tier - b.tier || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.extra - b.extra
    || a.contiguous - b.contiguous || a.title.length - b.title.length || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
    || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));

  return found.slice(0, max).map((f) => {
    const { kind, row, tier } = f;
    if (kind === 'comment') return commentHit(view, row, words);
    const title = kind === 'task' ? row.content : row.name;
    const hit = { kind, id: row.id, title, project: null, checked: Boolean(row.checked) && kind === 'task', tier, where: kind === 'task' ? 'title' : 'name', text: title, marks: [], color: row.color ?? null };
    if (kind === 'task' || kind === 'section') {
      const p = projects.get(row.project_id);
      hit.project = p ? { id: p.id, name: p.name } : null;
    } else if (kind === 'project' && row.parent_id) {
      const p = projects.get(row.parent_id);
      hit.project = p ? { id: p.id, name: p.name } : null;
    }
    if (kind === 'label' && isForeignLabel(row, userId)) hit.foreign = true;
    if (kind === 'task') {
      hit.due = row.due ?? null;
      hit.priority = row.priority ?? 4;
    }
    if (tier <= 1) {
      hit.marks = marksIn(title, words);
      return hit;
    }
    // klasse 2: de treffer zit in de beschrijving, of anders in een label (bij projecten en filters: in de beschrijving/filtertekst)
    const description = kind === 'filter' ? row.query : row.description;
    const inDescription = typeof description === 'string' ? marksIn(description, words) : [];
    if (inDescription.length > 0) {
      Object.assign(hit, { where: 'description' }, snippet(description, inDescription));
      return hit;
    }
    for (const id of row.labels ?? []) {
      const label = view.labels?.get(id);
      const marks = label ? marksIn(label.name, words) : [];
      if (marks.length > 0) {
        Object.assign(hit, { where: 'label', text: label.name, marks });
        return hit;
      }
    }
    return hit;
  });
}

/** Het resultaat voor een opmerking: een stuk van de opmerking rond de treffer, en waar ze bij hoort. */
function commentHit(view, comment, words) {
  const task = comment.task_id ? view.tasks.get(comment.task_id) : null;
  const project = view.projects.get(task ? task.project_id : comment.project_id);
  const piece = snippet(comment.content, marksIn(comment.content, words));
  return {
    kind: 'comment',
    id: comment.id,
    title: piece.text,
    project: project ? { id: project.id, name: project.name } : null,
    on: task ? { kind: 'task', id: task.id, name: task.content } : { kind: 'project', id: project?.id ?? comment.project_id, name: project?.name ?? '' },
    checked: Boolean(task?.checked),
    tier: 2,
    where: 'comment',
    text: piece.text,
    marks: piece.marks,
    color: null,
  };
}
