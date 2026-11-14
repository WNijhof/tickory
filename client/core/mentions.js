// @-vermeldingen in opmerkingen: herkennen dat je een naam aan het typen bent, de leden die erbij passen (hoofdletter- en
// accentongevoelig via fold.js, zodat "@jose" ook "José" vindt), de naam invoegen, en bij het versturen en tonen terugvinden
// wie er genoemd is.
//
// In de opmerking staat gewoon tekst ("@Anna de Vries"); wie er bedoeld is, staat apart in `mentions` (gebruikers-id's, zie
// shared/notifications.js). Zo blijft de tekst leesbaar in elke versie van de app, en de server controleert de lijst.

import { MAX_MENTIONS } from '../../shared/notifications.js';
import { foldText } from './fold.js';

/** Zoveel tekens mag wat je na de @ typt hooguit zijn (een voornaam met achternaam past ruim). */
const MAX_QUERY = 40;

/**
 * Typ je nu een vermelding? Dan het begin (de plek van de @) en wat je na de @ hebt getypt. De @ telt alleen aan het begin
 * of na een spatie of haakje (dus niet in een e-mailadres), en de vermelding stopt bij een regeleinde.
 * @param {string} text
 * @param {number} caret
 * @returns {{ start: number, query: string } | null}
 */
export function mentionAt(text, caret) {
  const before = String(text ?? '').slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/[\s([{"'“‘]/u.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY || /[\n\r@]/.test(query) || /^\s/.test(query) || /\s{2}/.test(query)) return null;
  return { start: at, query };
}

/**
 * De leden die passen bij wat je typt, de beste eerst: de naam begint ermee, dan een woord in de naam, dan de gebruikersnaam,
 * dan ergens in de naam. Jezelf staat er niet bij.
 * @param {{ id: string, name: string, username: string }[]} people
 * @param {string} query
 * @param {{ me?: string | null, limit?: number }} [options]
 */
export function mentionCandidates(people, query, { me = null, limit = 8 } = {}) {
  const q = foldText(query).trim();
  const scored = [];
  for (const p of people) {
    if (!p || p.id === me) continue;
    const name = foldText(p.name);
    const user = foldText(p.username);
    let score;
    if (q === '') score = 4;
    else if (name.startsWith(q)) score = 0;
    else if (name.split(' ').some((w) => w.startsWith(q))) score = 1;
    else if (user.startsWith(q)) score = 2;
    else if (name.includes(q) || user.includes(q)) score = 3;
    else continue;
    scored.push({ p, score, key: name });
  }
  scored.sort((a, b) => a.score - b.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return scored.slice(0, limit).map((x) => x.p);
}

/**
 * Zet de gekozen persoon op de plek van de getypte vermelding: "@Naam " (met een spatie erachter, zodat je verder kunt typen).
 * @returns {{ text: string, caret: number }}
 */
export function insertMention(text, start, caret, person) {
  const value = String(text ?? '');
  const after = value.slice(caret).replace(/^\S*/, ''); // de rest van een half getypt woord valt weg
  const piece = `@${person.name} `;
  const head = value.slice(0, start) + piece;
  return { text: head + (after.startsWith(' ') ? after.slice(1) : after), caret: head.length };
}

/** Komt "@Naam" als losse vermelding in de tekst voor (niet als begin van een langere naam)? */
function findMention(text, name, from = 0) {
  const needle = `@${name}`;
  for (let i = text.indexOf(needle, from); i >= 0; i = text.indexOf(needle, i + 1)) {
    const next = text[i + needle.length];
    const before = i === 0 ? ' ' : text[i - 1];
    if ((next === undefined || !/[\p{L}\p{N}]/u.test(next)) && !/[\p{L}\p{N}]/u.test(before)) return i;
  }
  return -1;
}

/**
 * Wie er bij het versturen nog echt genoemd wordt: van de personen die je koos (of die er al in stonden), alleen wie nog met
 * "@Naam" in de tekst staat. Hooguit 20.
 * @param {string} text
 * @param {Map<string, string> | [string, string][]} chosen id → naam
 * @returns {string[]}
 */
export function mentionIds(text, chosen) {
  const out = [];
  for (const [id, name] of chosen instanceof Map ? chosen : new Map(chosen)) {
    if (!name || out.includes(id)) continue;
    if (findMention(String(text ?? ''), name) >= 0) out.push(id);
    if (out.length === MAX_MENTIONS) break;
  }
  return out;
}

/**
 * De tekst van een opmerking in stukken: gewone tekst en vermeldingen (`{ text: '@Naam', mention: id }`) van wie in `mentions`
 * staat. Een langere naam gaat voor ("@Anna de Vries" voor "@Anna"). Alleen tekst: de interface maakt er elementen van.
 * @param {string} content
 * @param {string[] | null | undefined} mentions
 * @param {(id: string) => string | null} nameOf
 * @returns {{ text: string, mention?: string }[]}
 */
export function mentionParts(content, mentions, nameOf) {
  const text = String(content ?? '');
  const names = (mentions ?? []).map((id) => ({ id, name: nameOf(id) })).filter((x) => x.name).sort((a, b) => b.name.length - a.name.length);
  const hits = [];
  for (const { id, name } of names) {
    for (let i = findMention(text, name); i >= 0; i = findMention(text, name, i + 1)) {
      const end = i + name.length + 1;
      if (!hits.some((h) => i < h.end && end > h.start)) hits.push({ start: i, end, id });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const parts = [];
  let pos = 0;
  for (const h of hits) {
    if (h.start > pos) parts.push({ text: text.slice(pos, h.start) });
    parts.push({ text: text.slice(h.start, h.end), mention: h.id });
    pos = h.end;
  }
  if (pos < text.length || parts.length === 0) parts.push({ text: text.slice(pos) });
  return parts;
}
