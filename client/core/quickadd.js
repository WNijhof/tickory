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
import { parseDuration } from './duration.js';
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

// =45m · =1u30 · =1,5u · =2 uur · =30 (minuten): alleen echte eenheden, zodat "=30 Tandarts" gewoon 30 minuten is
const DURATION_HOURS = 'u|uur|h|hr|hrs|hours?';
const DURATION_MINS = 'm|min|mins|minuut|minuten|minutes?';
const DURATION_TOKEN = new RegExp(String.raw`(?<![\p{L}\p{N}=])=(\d+(?:[.,]\d+)?\s?(?:${DURATION_HOURS})(?:\s?\d{1,2}(?:\s?(?:${DURATION_MINS}))?)?|\d+\s?(?:${DURATION_MINS})?)(?![\p{L}\p{N}])`, 'iu');

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
const TIME = '(\\d{1,2})(?:[:.](\\d{2}))?';
const RANGE = new RegExp(`(?<![\\p{L}\\p{N}:./-])(van\\s+)?${TIME}\\s*(?:-|–|tot(?:\\s+en\\s+met)?)\\s*${TIME}(\\s*uur)?(?![\\p{L}\\p{N}:./-])`, 'iu');

/**
 * Een tijdsbereik in een regel: "9:00-10:30", "18:00 - 19:30", "9-10 uur", "van 9 tot 10:30". Geeft het begin ("HH:MM"), de duur
 * in minuten en de plek, of null. Zonder dubbele punt, "uur" of "van … tot" is het geen tijd: "9-10" is 9 oktober.
 * @returns {{ start: string, minutes: number, index: number, length: number } | null}
 */
export function findTimeRange(text) {
  const m = RANGE.exec(String(text ?? ''));
  if (!m) return null;
  const [, van, h1, m1, h2, m2, uur] = m;
  const clear = Boolean(van) || Boolean(uur) || m1 !== undefined || m2 !== undefined;
  if (!clear || (van && !/tot/i.test(m[0]))) return null;
  const a = Number(h1) * 60 + Number(m1 ?? 0);
  const b = Number(h2) * 60 + Number(m2 ?? 0);
  if (Number(h1) > 23 || Number(h2) > 23 || Number(m1 ?? 0) > 59 || Number(m2 ?? 0) > 59 || b <= a) return null;
  return { start: `${String(h1).padStart(2, '0')}:${String(m1 ?? '00').padStart(2, '0')}`, minutes: b - a, index: m.index, length: m[0].length };
}

export function parseQuickAdd(text, { view, now = new Date(), defaultProjectId, defaultSectionId = null, defaultDue = null, canAddTo = () => true }) {
  let rest = normalizeText(text).replace(/\s+/g, ' ').trim();
  const out = { content: '', project_id: defaultProjectId, section_id: defaultSectionId, labels: [], newLabels: [], priority: 4, due: defaultDue, deadline: null, reminders: [] };

  // prioriteit
  const prio = new RegExp(`${START}(?:p|!!)([1-4])${END}`, 'iu').exec(rest);
  if (prio) {
    out.priority = Number(prio[1]);
    rest = cut(rest, prio.index, prio.index + prio[0].length);
  }

  // project
  // `canAddTo`: alleen projecten waar je een taak in kunt zetten (niet een project dat je alleen leest, zie core/access.js)
  const project = matchNamed(rest, '#', [...view.projects.values()].filter((p) => !p.is_archived && canAddTo(p.id)));
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

  // duur: =45m, =1u30, =1,5u (alleen als het een duur is; anders blijft de tekst staan)
  const du = DURATION_TOKEN.exec(rest);
  if (du) {
    const minutes = parseDuration(du[1]);
    if (minutes !== null) {
      out.duration = minutes;
      rest = cut(rest, du.index, du.index + du[0].length);
    }
  }

  // een tijdsbereik ("9:00-10:30", "18-19 uur", "van 9 tot 10:30"): het begin wordt de tijd, het verschil de duur (zoals Todoist).
  // "9-10" alleen is in het Nederlands een datum (9 oktober), dus pas met een dubbele punt, "uur" of "van … tot".
  const range = findTimeRange(rest);
  if (range) {
    rest = `${rest.slice(0, range.index)}om ${range.start}${rest.slice(range.index + range.length)}`.replace(/\s+/g, ' ').trim();
    if (out.duration === undefined) out.duration = range.minutes;
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
