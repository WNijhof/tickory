// Snel toevoegen: één regel tekst wordt een taak met datum, project, sectie, labels en prioriteit.
//
//   "Tandarts bellen morgen om 9 uur #Thuis @bellen p1"
//
//   #project   een bestaand project (namen met spaties mogen: de langste passende naam wint)
//   /sectie    een bestaande sectie in dat project
//   @label     een label; een onbekend label wordt aangemaakt
//   p1 … p4    prioriteit (ook !!1 … !!4); 1 is de hoogste
//   {vrijdag}  een deadline (los van de datum waarop je eraan wilt werken)
//   datum      gewone taal, ook herhalingen ("elke maandag")
//
// Elk teken telt alleen aan het begin van een woord, zodat een e-mailadres of "en/of" met rust wordt gelaten.

import { parseDateText, parseDue } from './dateNl.js';

const START = '(?<![^\\s])'; // begin van de tekst of na witruimte
const END = '(?![\\p{L}\\p{N}_-])';

/** Zoekt na elk `trigger`-teken de langste naam uit `items` die erop volgt. */
function matchNamed(text, trigger, items) {
  const names = items.map((item) => ({ item, name: item.name.trim() })).filter((x) => x.name).sort((a, b) => b.name.length - a.name.length);
  const re = new RegExp(`${START}[${trigger}]`, 'gu'); // trigger is '#' of '/', veilig binnen een tekenklasse
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const after = text.slice(m.index + 1);
    for (const { item, name } of names) {
      if (after.toLowerCase().startsWith(name.toLowerCase()) && !/^[\p{L}\p{N}_-]/u.test(after.slice(name.length))) {
        return { item, start: m.index, end: m.index + 1 + name.length };
      }
    }
  }
  return null;
}

const cut = (text, start, end) => `${text.slice(0, start)} ${text.slice(end)}`.replace(/\s+/g, ' ').trim();

/**
 * @param {string} text
 * @param {{
 *   view: { projects: Map<string, object>, sections: Map<string, object>, labels: Map<string, object> },
 *   now?: Date,
 *   defaultProjectId: string,
 *   defaultSectionId?: string | null,
 *   defaultDue?: object | null,     // bijvoorbeeld "vandaag" in het overzicht Vandaag
 * }} context
 * @returns {{
 *   content: string, project_id: string, section_id: string | null, labels: string[], newLabels: string[],
 *   priority: number, due: object | null, deadline: string | null,
 * }}
 */
export function parseQuickAdd(text, { view, now = new Date(), defaultProjectId, defaultSectionId = null, defaultDue = null }) {
  let rest = text.replace(/\s+/g, ' ').trim();
  const out = { content: '', project_id: defaultProjectId, section_id: defaultSectionId, labels: [], newLabels: [], priority: 4, due: defaultDue, deadline: null };

  // prioriteit
  const prio = new RegExp(`${START}(?:p|!!)([1-4])${END}`, 'iu').exec(rest);
  if (prio) {
    out.priority = Number(prio[1]);
    rest = cut(rest, prio.index, prio.index + prio[0].length);
  }

  // project
  const project = matchNamed(rest, '#', [...view.projects.values()].filter((p) => !p.is_archived));
  if (project) {
    out.project_id = project.item.id;
    if (project.item.id !== defaultProjectId) out.section_id = null; // de standaardsectie hoort bij een ander project
    rest = cut(rest, project.start, project.end);
  }

  // sectie (binnen het gekozen project)
  const section = matchNamed(rest, '/', [...view.sections.values()].filter((s) => s.project_id === out.project_id && !s.is_archived));
  if (section) {
    out.section_id = section.item.id;
    rest = cut(rest, section.start, section.end);
  }

  // labels
  const known = new Map([...view.labels.values()].map((l) => [l.name.toLowerCase(), l.id]));
  const labelRe = new RegExp(`${START}@([\\p{L}\\p{N}_-]+)`, 'gu');
  rest = rest.replace(labelRe, (_, name) => {
    const id = known.get(name.toLowerCase());
    if (id) {
      if (!out.labels.includes(id)) out.labels.push(id);
    } else if (!out.newLabels.some((n) => n.toLowerCase() === name.toLowerCase())) {
      out.newLabels.push(name);
    }
    return '';
  }).replace(/\s+/g, ' ').trim();

  // deadline tussen accolades; blijft staan als de tekst geen datum is
  const dl = /\{([^{}]+)\}/u.exec(rest);
  if (dl) {
    const due = parseDateText(dl[1], now);
    if (due && !due.recurrence) {
      out.deadline = due.date.slice(0, 10);
      rest = cut(rest, dl.index, dl.index + dl[0].length);
    }
  }

  // datum of herhaling in gewone taal
  const parsed = parseDue(rest, now);
  if (parsed) {
    rest = parsed.content;
    if (parsed.due) out.due = parsed.due;
  }

  out.content = rest;
  return out;
}
