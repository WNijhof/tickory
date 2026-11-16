// De versiegeschiedenis van een notitie, zonder scherm (zie ui/noteHistory.js en server/noteHistory.ts): de versies per dag, en wat
// er tussen twee versies veranderd is, regel voor regel.

import { getLocale, t } from './i18n.js';
import { timeFormatOptions } from './format.js';

/** Het tijdstip van een versie: wanneer die tekst zo bewaard werd (`saved_at`), anders wanneer de versie gemaakt is. */
export const revisionTime = (r) => r.saved_at || r.created_at;

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "Vandaag", "Gisteren" of "16 november 2026". */
export function historyDayLabel(date, now = new Date()) {
  if (dayKey(date) === dayKey(now)) return t('note.today');
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return t('note.yesterday');
  return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

/** "14:03" in de taal van de app. */
export const historyTime = (iso) => new Intl.DateTimeFormat(getLocale(), timeFormatOptions()).format(new Date(iso));

/**
 * De versies (nieuwste eerst) per dag, in dezelfde volgorde.
 * @returns {{ key: string, label: string, entries: object[] }[]}
 */
export function groupRevisionsByDay(revisions, now = new Date()) {
  const days = [];
  for (const r of revisions) {
    const date = new Date(revisionTime(r));
    const key = dayKey(date);
    const last = days.at(-1);
    if (last?.key === key) last.entries.push(r);
    else days.push({ key, label: historyDayLabel(date, now), entries: [r] });
  }
  return days;
}

/** Boven zoveel regels (samen) vergelijken we niet meer regel voor regel: dat kost te veel. */
export const MAX_DIFF_LINES = 4000;

/**
 * Wat er van `before` naar `after` veranderd is, regel voor regel (langste gemeenschappelijke deelrij). Een blok verwijderde regels
 * direct gevolgd door toegevoegde telt als "gewijzigd" (zoveel als er paren zijn).
 * @returns {{ lines: { kind: 'same' | 'add' | 'del', text: string }[], added: number, removed: number, changed: number, tooLarge: boolean }}
 */
export function lineDiff(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  if (a.length + b.length > MAX_DIFF_LINES) return { lines: [], added: 0, removed: 0, changed: 0, tooLarge: true };
  // gelijke begin- en eindregels eerst weg: meestal verandert maar een klein stuk
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  // lengtes van de langste gemeenschappelijke deelrij, van achteren
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const lines = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) { lines.push({ kind: 'same', text: midA[i] }); i += 1; j += 1; }
    // bij gelijke keuze eerst wat weg is, dan wat erbij kwam: zo staat een vervangen regel als "oud, nieuw"
    else if (i < n && (j === m || table[i + 1][j] >= table[i][j + 1])) { lines.push({ kind: 'del', text: midA[i] }); i += 1; }
    else { lines.push({ kind: 'add', text: midB[j] }); j += 1; }
  }
  for (const text of a.slice(endA)) lines.push({ kind: 'same', text });
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (let k = 0; k < lines.length;) {
    let dels = 0;
    let adds = 0;
    while (k < lines.length && lines[k].kind === 'del') { dels += 1; k += 1; }
    while (k < lines.length && lines[k].kind === 'add') { adds += 1; k += 1; }
    if (dels === 0 && adds === 0) { k += 1; continue; }
    const pairs = Math.min(dels, adds);
    changed += pairs;
    removed += dels - pairs;
    added += adds - pairs;
  }
  return { lines, added, removed, changed, tooLarge: false };
}

/** Het label van een versie: "Eerdere versie" of "Vóór terugzetten". */
export const revisionCauseLabel = (cause) => (cause === 'restore' ? t('note.history.beforeRestore') : t('note.history.earlier'));
