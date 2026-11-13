// Snel toevoegen: één regel tekst wordt een taak met datum, project, sectie, labels en prioriteit.
//
//   "Tandarts bellen morgen om 9 uur #Thuis @bellen p1"
//
//   #project   een bestaand project (namen met spaties mogen: de langste passende naam wint)
//   /sectie    een bestaande sectie in dat project
//   @label     een label; een onbekend label wordt aangemaakt. Een bestaand label met spaties of leestekens in de naam
//              ("@Uitgaan met Zoë") wordt op naam gevonden; de langste passende naam wint
//   p1 … p4    prioriteit (ook !!1 … !!4); 1 is de hoogste
//   {vrijdag}  een deadline (los van de datum waarop je eraan wilt werken)
//   !30m       een herinnering: !30m, !1u, !2d (minuten, uren, dagen vooraf), !0 (op het tijdstip zelf), of tussen haakjes
//              in gewone taal: !(een kwartier ervoor), !(morgen om 8 uur). Meerdere mag.
//   datum      gewone taal, ook herhalingen ("elke maandag")
//
// Elk teken telt alleen aan het begin van een woord, zodat een e-mailadres of "en/of" met rust wordt gelaten.

import { parseDateText, parseDue } from './dateNl.js';
import { nameKey, normalizeText } from '../../shared/text.js';
import { hasTime, parseOffsetNl } from '../../shared/reminders.js';

const START = '(?<![^\\s])'; // begin van de tekst of na witruimte
const END = '(?![\\p{L}\\p{N}_-])';

/** Zoekt na elk `trigger`-teken de langste naam uit `items` die erop volgt. */
function matchNamed(text, trigger, items) {
  // namen in dezelfde NFC-vorm als de tekst (de invoer wordt hieronder ook genormaliseerd), anders valt "é" soms niet samen
  const names = items.map((item) => ({ item, name: normalizeText(item.name).trim().replace(/\s+/g, ' ') })).filter((x) => x.name).sort((a, b) => b.name.length - a.name.length);
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
 *   reminders: ({ type: 'relative', minute_offset: number } | { type: 'absolute', due: { date: string } })[],
 * }}
 */
export function parseQuickAdd(text, { view, now = new Date(), defaultProjectId, defaultSectionId = null, defaultDue = null }) {
  let rest = normalizeText(text).replace(/\s+/g, ' ').trim();
  const out = { content: '', project_id: defaultProjectId, section_id: defaultSectionId, labels: [], newLabels: [], priority: 4, due: defaultDue, deadline: null, reminders: [] };

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
  // Een label met een spatie of een ander teken dat in een gewoon woord niet voorkomt ("Uitgaan met Zoë", "a.b") wordt op naam gevonden,
  // zoals bij projecten: de langste passende naam wint. Alle andere labels volgen hieronder, op het woord na de @.
  const odd = [...view.labels.values()].filter((l) => !/^[\p{L}\p{N}_-]+$/u.test(normalizeText(l.name).trim()));
  for (let m = matchNamed(rest, '@', odd); m; m = matchNamed(rest, '@', odd)) {
    if (!out.labels.includes(m.item.id)) out.labels.push(m.item.id);
    rest = cut(rest, m.start, m.end);
  }
  // via nameKey: "@ÉÉN" is het label "één", en "@Zoë" ook als de ë ontleed is getypt
  const known = new Map([...view.labels.values()].map((l) => [nameKey(l.name), l.id]));
  const labelRe = new RegExp(`${START}@([\\p{L}\\p{N}_-]+)`, 'gu');
  rest = rest.replace(labelRe, (_, name) => {
    const id = known.get(nameKey(name));
    if (id) {
      if (!out.labels.includes(id)) out.labels.push(id);
    } else if (!out.newLabels.some((n) => nameKey(n) === nameKey(name))) {
      out.newLabels.push(name);
    }
    return '';
  }).replace(/\s+/g, ' ').trim();

  // herinneringen; wat niet te begrijpen is, blijft gewoon in de titel staan
  const UNITS = 'minuten|minuut|min|mv|m|uren|uur|uv|u|dagen|dag|dv|d|weken|week|w';
  const reminderRe = new RegExp(`${START}!(?:\\(([^()]{1,80})\\)|(\\d{1,4} ?(?:${UNITS})|0))${END}`, 'giu');
  rest = rest.replace(reminderRe, (whole, phrase, code) => {
    let spec = null;
    const offset = parseOffsetNl(phrase ?? code);
    if (offset !== null) {
      spec = { type: 'relative', minute_offset: offset };
    } else if (phrase) {
      const when = parseDateText(phrase, now);
      if (when && !when.recurrence && hasTime(when.date)) spec = { type: 'absolute', due: { date: when.date } };
    }
    if (!spec) return whole;
    const same = (r) => r.type === spec.type && (spec.type === 'absolute' ? r.due.date === spec.due.date : r.minute_offset === spec.minute_offset);
    if (!out.reminders.some(same)) out.reminders.push(spec);
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
