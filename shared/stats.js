// Het productiviteitsoverzicht (zie SPEC.md, hoofdstuk 5g): hoeveel taken jij per dag afvinkte, en de doelen in je instellingen.
// Gedeeld door de server (server/stats.ts, het eindpunt `GET /api/v1/stats`), de demo (die hetzelfde uit haar eigen logboek
// rekent) en de web-app (de doelen en hun standaardwaarden).
//
// De telling komt uit het activiteitenlogboek (shared/activity.js): elke regel `task_completed` van jou telt één keer, ook elke
// keer dat je een terugkerende taak afvinkte. Heropen je zelf een taak (`task_uncompleted`), dan telt je laatste afvinking van
// die taak niet meer: een vergissing die je herstelt, is geen werk. Wat een ander deed, telt nooit mee, ook niet als die jouw
// taak heropent. Alleen projecten die je nu ziet tellen mee (het logboek van een verwijderd project is weg), en het logboek gaat
// ACTIVITY_RETENTION_DAYS terug.
//
// Een dag is een kalenderdag in een tijdzone (IANA-naam): die van het apparaat, zoals Vandaag en Voltooid in de app. Zomer- en
// wintertijd tellen zo vanzelf goed (een dag van 23 of 25 uur), en een afvinking om 00:30 hoort bij de nieuwe dag.

import { ACTIVITY_RETENTION_DAYS } from './activity.js';

/** Zoveel dagen kan het overzicht teruggaan: zo lang bewaart de server het logboek. Ook de standaard. */
export const STATS_MAX_DAYS = ACTIVITY_RETENTION_DAYS;

/** De doelen en hun grenzen. `null` in de instellingen betekent: de standaard. 0 = geen doel. */
export const GOALS = {
  daily: { min: 0, max: 100, default: 5 },
  weekly: { min: 0, max: 700, default: 25 },
};
/** Vrije dagen (ISO: 1 = maandag … 7 = zondag): ze breken een reeks niet. Standaard het weekend. Minstens één dag telt mee. */
export const DAYS_OFF_DEFAULT = Object.freeze([6, 7]);
export const DAYS_OFF_MAX = 6;

/** Controle van `settings.days_off`: een lijst van hooguit zes verschillende weekdagen (1-7). Geeft een melding of null. */
export function daysOffCheck(v) {
  if (!Array.isArray(v)) return 'moet een lijst van weekdagen (1-7) zijn';
  if (v.length > DAYS_OFF_MAX) return `hooguit ${DAYS_OFF_MAX} vrije dagen; er moet een dag overblijven die meetelt`;
  if (!v.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) return 'elke weekdag is een geheel getal van 1 (maandag) tot 7 (zondag)';
  if (new Set(v).size !== v.length) return 'bevat dubbele weekdagen';
  return null;
}

const goal = (value, { min, max, default: fallback }) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);

/**
 * De doelen uit de instellingen, met de standaard voor wat ontbreekt (een oudere server of client kent de velden niet) of
 * ongeldig is. `daysOff` is gesorteerd.
 * @param {{ goal_daily?: unknown, goal_weekly?: unknown, days_off?: unknown } | null | undefined} settings
 * @returns {{ daily: number, weekly: number, daysOff: number[] }}
 */
export function goalsOf(settings) {
  const s = settings ?? {};
  const daysOff = s.days_off !== null && s.days_off !== undefined && daysOffCheck(s.days_off) === null ? [...s.days_off] : [...DAYS_OFF_DEFAULT];
  return { daily: goal(s.goal_daily, GOALS.daily), weekly: goal(s.goal_weekly, GOALS.weekly), daysOff: daysOff.sort((a, b) => a - b) };
}

// ---------- dagen ----------

const DAY_MS = 86_400_000;

/** Is dit een tijdzone die Intl kent (een IANA-naam zoals "Europe/Amsterdam", of "UTC")? */
export function isTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Een functie die van een tijdstip (milliseconden) de kalenderdag 'YYYY-MM-DD' in tijdzone `tz` maakt. Eén formatter voor alle
 * regels (er een per regel maken is traag). Een onbekende tijdzone geeft een RangeError.
 */
export function dayIn(tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (ms) => {
    const p = {};
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
    return `${p.year.padStart(4, '0')}-${p.month}-${p.day}`;
  };
}

/** `n` kalenderdagen verder (of terug), op de tekst 'YYYY-MM-DD', in UTC gerekend (zonder zomertijd). */
export function shiftDay(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Controleert de vraag naar het overzicht (`?days=<1-180>&tz=<IANA-naam>`). Geeft `{ days, tz }` (tz null: de aanroeper kiest)
 * of `{ error }`.
 * @param {{ days?: string | null, tz?: string | null }} q
 */
export function parseStatsQuery(q) {
  const out = { days: STATS_MAX_DAYS, tz: null };
  if (q.days !== null && q.days !== undefined && q.days !== '') {
    if (!/^\d{1,3}$/.test(q.days) || Number(q.days) < 1 || Number(q.days) > STATS_MAX_DAYS) return { error: `days moet 1 tot ${STATS_MAX_DAYS} zijn` };
    out.days = Number(q.days);
  }
  if (q.tz !== null && q.tz !== undefined && q.tz !== '') {
    if (!isTimeZone(q.tz)) return { error: 'tz moet een bekende tijdzone zijn (bijvoorbeeld Europe/Amsterdam)' };
    out.tz = q.tz;
  }
  return out;
}

/** Vanaf dit tijdstip (ISO) moet de aanroeper regels ophalen: de periode plus een dag speling voor de tijdzone. */
export const statsSince = (nowMs, days) => new Date(nowMs - (days + 1) * DAY_MS).toISOString();

/**
 * Telt de eigen afvinkingen per dag en per project. `entries` zijn de eigen regels `task_completed` en `task_uncompleted`
 * (alleen van de gebruiker zelf, alleen uit projecten die hij nu ziet), de oudste eerst, met `at`, `kind`, `task_id` en
 * `project_id`. Een heropening schrapt de laatste nog tellende afvinking van dezelfde taak.
 * @param {{ at: string, kind: string, task_id: string | null, project_id: string }[]} entries
 * @param {{ tz: string, nowMs: number, days: number }} options
 * @returns {{ tz: string, today: string, from: string, days: number, retention_days: number, per_day: { date: string, count: number, projects: Record<string, number> }[] }}
 */
export function tallyCompletions(entries, { tz, nowMs, days }) {
  const day = dayIn(tz);
  const today = day(nowMs);
  const from = shiftDay(today, 1 - days);
  const counted = []; // { date, project_id, live }
  const open = new Map(); // taak -> indexen in `counted` van afvinkingen die nog tellen, de laatste achteraan
  for (const e of entries) {
    const ms = Date.parse(e.at);
    if (Number.isNaN(ms)) continue;
    if (e.kind === 'task_completed') {
      const i = counted.push({ date: day(ms), project_id: e.project_id, live: true }) - 1;
      if (e.task_id) {
        if (!open.has(e.task_id)) open.set(e.task_id, []);
        open.get(e.task_id).push(i);
      }
    } else if (e.kind === 'task_uncompleted' && e.task_id) {
      const last = open.get(e.task_id)?.pop();
      if (last !== undefined) counted[last].live = false;
    }
  }
  const perDay = new Map();
  for (const c of counted) {
    if (!c.live || c.date < from || c.date > today) continue;
    // zonder prototype: een project-id als "__proto__" (dat past in ID_RE) is dan gewoon een sleutel
    if (!perDay.has(c.date)) perDay.set(c.date, { date: c.date, count: 0, projects: Object.create(null) });
    const d = perDay.get(c.date);
    d.count += 1;
    d.projects[c.project_id] = (d.projects[c.project_id] ?? 0) + 1;
  }
  const per_day = [...perDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { tz, today, from, days, retention_days: ACTIVITY_RETENTION_DAYS, per_day };
}
