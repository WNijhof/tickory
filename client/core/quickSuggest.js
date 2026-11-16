// Suggesties tijdens het typen in snel toevoegen (zoals Todoist), zonder scherm: na `#` projecten, na `/` secties (van het gekozen
// project, anders van het project waarin je toevoegt), na `@` labels en na `{` een deadline. Welk stuk tekst je aan het typen bent,
// wat erbij past en hoe het wordt ingevuld; ui/quickSuggest.js tekent de lijst.

import { foldText } from './fold.js';
import { parseDateText } from './dateNl.js';
import { t } from './i18n.js';

/** Zo lang mag wat na het teken staat zijn om nog naar suggesties te zoeken (namen mogen spaties hebben). */
const MAX_QUERY = 40;
const TRIGGERS = new Set(['#', '/', '@', '{']);

/**
 * Het teken en de tekst die je nu typt, vóór de cursor: `{ trigger, start, query }`, of null. Het teken staat aan het begin of na een
 * spatie; voor `{` mag er nog geen `}` achter staan. Een query met twee spaties achter elkaar of een nieuw teken telt niet.
 */
export function tokenAt(text, caret) {
  const before = String(text ?? '').slice(0, caret);
  for (let i = before.length - 1; i >= 0 && before.length - i <= MAX_QUERY + 1; i--) {
    const ch = before[i];
    if (TRIGGERS.has(ch) && (i === 0 || /\s/.test(before[i - 1]))) {
      const query = before.slice(i + 1);
      if (/\s\s|[#@{}]/.test(query) || (ch === '/' && /\//.test(query))) return null;
      return { trigger: ch, start: i, query };
    }
    if (ch === '\n') return null;
  }
  return null;
}

/** De project-id na een `#Naam` die al in de tekst staat (het laatste), of null. */
function chosenProject(text, projects) {
  let found = null;
  for (const p of projects) {
    const i = foldText(text).lastIndexOf(`#${foldText(p.name)}`);
    if (i >= 0 && (!found || i > found.at)) found = { id: p.id, at: i };
  }
  return found?.id ?? null;
}

/**
 * De suggesties bij het teken dat je typt, hooguit `limit`, op naam (wat met de query begint eerst).
 * @param {{ trigger: string, query: string }} token
 * @param {{ projects: { id: string, name: string, color?: string }[], sections: { id: string, name: string, project_id: string }[],
 *   labels: { id: string, name: string, color?: string }[], text?: string, defaultProjectId?: string | null, now?: Date | null, limit?: number }} options
 * @returns {{ kind: 'project' | 'section' | 'label' | 'date', id: string, label: string, insert: string, hint?: string, color?: string }[]}
 */
export function suggestions(token, { projects = [], sections = [], labels = [], text = '', defaultProjectId = null, now = null, limit = 8 } = {}) {
  if (!token) return [];
  const q = foldText(token.query.trim());
  const rank = (name) => {
    const f = foldText(name);
    return f.startsWith(q) ? 0 : f.includes(q) ? 1 : 2;
  };
  const pick = (items, toItem) => items
    .map((x) => ({ x, r: rank(x.name) }))
    .filter(({ r }) => r < 2)
    .sort((a, b) => a.r - b.r || a.x.name.localeCompare(b.x.name, undefined, { sensitivity: 'base' }))
    .slice(0, limit)
    .map(({ x }) => toItem(x));
  switch (token.trigger) {
    case '#': return pick(projects, (p) => ({ kind: 'project', id: p.id, label: p.name, insert: `#${p.name} `, color: p.color }));
    case '@': return pick(labels, (l) => ({ kind: 'label', id: l.id, label: l.name, insert: `@${l.name} `, color: l.color }));
    case '/': {
      const projectId = chosenProject(text.slice(0, token.start), projects) ?? defaultProjectId;
      return pick(sections.filter((s) => s.project_id === projectId), (s) => ({ kind: 'section', id: s.id, label: s.name, insert: `/${s.name} ` }));
    }
    case '{': {
      if (!now) return [];
      // letterlijke sleutels: wat er in de tekst komt is Nederlands (de datumherkenning is Nederlands), het label in de taal van de app;
      // de datum ernaast rekent de datumherkenning zelf uit, zodat die precies klopt met wat er straks wordt bewaard
      const options = [
        { id: 'today', words: 'vandaag', label: t('quick.deadlineToday') },
        { id: 'tomorrow', words: 'morgen', label: t('quick.deadlineTomorrow') },
        { id: 'friday', words: 'vrijdag', label: t('quick.deadlineFriday') },
        { id: 'nextWeek', words: 'volgende week', label: t('quick.deadlineNextWeek') },
        { id: 'month', words: 'over een maand', label: t('quick.deadlineMonth') },
      ];
      return options.filter((o) => !q || foldText(`${o.words} ${o.label}`).includes(q))
        .map((o) => ({ kind: 'date', id: o.id, label: o.label, insert: `{${o.words}} `, hint: parseDateText(o.words, now)?.date?.slice(0, 10) }));
    }
    default: return [];
  }
}

/**
 * De regels van geplakte tekst om er losse taken van te maken: zonder lege regels, zonder opsommingstekens ("- ", "* ", "1. ",
 * "- [ ] ") aan het begin, hooguit 100.
 */
export function splitPastedLines(text) {
  return String(text ?? '').split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*+•]\s+(?:\[[ xX]\]\s+)?|\d{1,3}[.)]\s+)/, '').trim())
    .filter(Boolean)
    .slice(0, 100);
}

/** Vult een suggestie in: het teken met wat je typte wordt vervangen. Geeft de nieuwe tekst en cursor. */
export function applySuggestion(text, token, caret, item) {
  const before = String(text).slice(0, token.start);
  const after = String(text).slice(caret).replace(/^\s+/, '');
  const value = `${before}${item.insert}${after}`;
  return { text: value, caret: before.length + item.insert.length };
}
