// Het scherm "Productiviteit", zonder scherm: van het antwoord van de server (`GET /api/v1/stats`, zie shared/stats.js en
// SPEC.md, 5g) naar wat het scherm toont: vandaag en deze week tegenover je doelen, de reeksen dagen en weken waarin je het doel
// haalde, de laatste 7 dagen, de laatste weken en de verdeling over projecten. Plus het bewaren van het laatste antwoord, zodat
// het overzicht ook zonder verbinding iets laat zien (met "laatst bijgewerkt").
//
// Alle datums zijn 'YYYY-MM-DD' en alles rekent in UTC op die tekst (core/calendar.js), zodat zomertijd hier nooit meetelt: de
// server heeft de afvinkingen al per kalenderdag in de tijdzone van het apparaat geteld. `today` geeft de aanroeper mee.
//
// Regels:
//   - een dag telt voor de dagreeks als je het dagdoel haalde; een vrije dag zonder gehaald doel breekt de reeks niet (en telt
//     niet mee), een vrije dag met gehaald doel telt wel mee; vandaag breekt de reeks nog niet (de dag is nog niet om);
//   - een week (ISO: maandag tot en met zondag) telt voor de weekreeks als je het weekdoel haalde; deze week breekt nog niet;
//   - doel 0 = uit: dan is er geen reeks;
//   - vóór `from` (180 dagen terug, zo lang bewaart de server het logboek) is niets bekend: een reeks begint daar op zijn vroegst.

import { goalsOf } from '../../shared/stats.js';
import { addDays } from './format.js';
import { isoWeek, isoWeekday, startOfWeek } from './calendar.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Het aantal afvinkingen per dag als Map (datum -> aantal). */
export function dayCounts(stats) {
  const out = new Map();
  for (const d of stats?.per_day ?? []) out.set(d.date, d.count);
  return out;
}

/**
 * De reeksen dagen waarin het dagdoel gehaald is, van `from` tot en met `today`.
 * @returns {{ current: number, longest: number } | null} null als het doel uit staat
 */
export function dayStreaks(counts, { from, today, goal, daysOff = [] }) {
  if (!(goal > 0)) return null;
  const off = new Set(daysOff);
  let run = 0;
  let longest = 0;
  for (let d = from; d <= today; d = addDays(d, 1)) {
    if ((counts.get(d) ?? 0) >= goal) {
      run += 1;
      if (run > longest) longest = run;
    } else if (d !== today && !off.has(isoWeekday(d))) run = 0;
  }
  return { current: run, longest };
}

/**
 * Het totaal per ISO-week, van de week van `from` tot en met die van `today`, de oudste eerst. `partial`: de week begint vóór
 * `from` (onvolledig bekend) of is de lopende week.
 * @returns {{ start: string, year: number, week: number, count: number, partial: boolean }[]}
 */
export function weekTotals(counts, { from, today }) {
  const weeks = [];
  const last = startOfWeek(today);
  for (let start = startOfWeek(from); start <= last; start = addDays(start, 7)) {
    let count = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(start, i);
      if (d >= from && d <= today) count += counts.get(d) ?? 0;
    }
    weeks.push({ start, ...isoWeek(start), count, partial: start < from || start === last });
  }
  return weeks;
}

/** De reeksen weken waarin het weekdoel gehaald is (de lopende week breekt nog niet). null als het doel uit staat. */
export function weekStreaks(weeks, goal) {
  if (!(goal > 0)) return null;
  let run = 0;
  let longest = 0;
  weeks.forEach((w, i) => {
    if (w.count >= goal) {
      run += 1;
      if (run > longest) longest = run;
    } else if (i !== weeks.length - 1) run = 0;
  });
  return { current: run, longest };
}

/**
 * Per project hoeveel jij afvinkte tussen `start` en `end` (inbegrepen): de `top` grootste, en de rest samen. Bij een gelijk
 * aantal beslist de naam (`nameOf`), dan het id.
 * @returns {{ items: { projectId: string, count: number }[], rest: number, restProjects: number, total: number }}
 */
export function projectShare(stats, { start, end, top = 5, nameOf = () => '' }) {
  const totals = new Map();
  for (const d of stats?.per_day ?? []) {
    if (d.date < start || d.date > end) continue;
    for (const [id, count] of Object.entries(d.projects ?? {})) totals.set(id, (totals.get(id) ?? 0) + count);
  }
  const sorted = [...totals.entries()]
    .map(([projectId, count]) => ({ projectId, count, name: String(nameOf(projectId) ?? '') }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || (a.projectId < b.projectId ? -1 : 1));
  const items = sorted.slice(0, top).map(({ projectId, count }) => ({ projectId, count }));
  const restList = sorted.slice(top);
  const total = sorted.reduce((sum, x) => sum + x.count, 0);
  return { items, rest: restList.reduce((sum, x) => sum + x.count, 0), restProjects: restList.length, total };
}

/**
 * Alles wat het scherm toont, uit het antwoord van de server en de instellingen.
 * @param {object | null} stats het antwoord van `GET /api/v1/stats` (of het bewaarde)
 * @param {{ settings?: object | null, today: string, weeks?: number, nameOf?: (projectId: string) => string }} options
 */
export function summarize(stats, { settings = null, today, weeks = 12, nameOf } = {}) {
  if (!stats || !DATE_RE.test(stats.from ?? '') || !DATE_RE.test(stats.today ?? '')) return null;
  const goals = goalsOf(settings);
  const counts = dayCounts(stats);
  // Is het antwoord van een eerdere dag (bewaard, zonder verbinding), dan is na stats.today nog niets bekend: die dagen tonen 0,
  // maar de reeksen lopen tot stats.today (een dag die we niet kennen, breekt geen reeks).
  const known = (d) => d >= stats.from && d <= stats.today;
  const end = today < stats.today ? today : stats.today;
  const from = stats.from;
  const off = new Set(goals.daysOff);
  const weekStart = startOfWeek(today);
  const allWeeks = weekTotals(counts, { from, today: end });
  const thisWeek = allWeeks.find((w) => w.start === weekStart) ?? { count: 0 };
  const shownWeeks = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(weekStart, -7 * i);
    const w = allWeeks.find((x) => x.start === start);
    shownWeeks.push(w ? { ...w, current: i === 0 } : { start, ...isoWeek(start), count: 0, partial: true, current: i === 0, unknown: true });
  }
  const todayCount = counts.get(today) ?? 0;
  return {
    goals,
    from,
    stale: today > stats.today,
    today: { date: today, count: todayCount, goal: goals.daily, met: goals.daily > 0 && todayCount >= goals.daily, off: off.has(isoWeekday(today)) },
    week: { start: weekStart, count: thisWeek.count, goal: goals.weekly, met: goals.weekly > 0 && thisWeek.count >= goals.weekly },
    dayStreak: dayStreaks(counts, { from, today: end, goal: goals.daily, daysOff: goals.daysOff }),
    weekStreak: weekStreaks(allWeeks, goals.weekly),
    days: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(today, i - 6);
      return { date, count: counts.get(date) ?? 0, off: off.has(isoWeekday(date)), known: known(date), today: date === today };
    }),
    weeks: shownWeeks,
    projects: projectShare(stats, { start: weekStart, end: today, nameOf }),
  };
}

/** Een getal dat verandert zodra er iets wordt afgevinkt of heropend (ook een terugkerende taak, via de teller): het teken om bij te werken. */
export function completionMark(view) {
  let checked = 0;
  let total = 0;
  for (const task of view?.tasks?.values?.() ?? []) {
    if (task.checked) checked += 1;
    total += Number(task.completed_count) || 0;
  }
  return `${checked}:${total}`;
}

// ---------- het laatste antwoord, ook zonder verbinding ----------

/** Onder deze sleutel bewaart de app het laatste antwoord (per apparaat, alleen van de aangemelde gebruiker; afmelden wist het). */
export const STATS_KEY = 'tickory.stats';

/** Is dit een bruikbaar antwoord (van de server, of uit de opslag van dit apparaat)? */
export function validStats(x) {
  if (!x || typeof x !== 'object' || !DATE_RE.test(x.today ?? '') || !DATE_RE.test(x.from ?? '') || !Array.isArray(x.per_day)) return false;
  return x.per_day.every((d) => d && DATE_RE.test(d.date ?? '') && Number.isInteger(d.count) && d.count >= 0 && d.projects && typeof d.projects === 'object'
    && Object.values(d.projects).every((c) => Number.isInteger(c) && c >= 0));
}

/**
 * Het laatst opgehaalde overzicht, bewaard in `storage` (localStorage) zodat het ook na herstarten zonder verbinding te zien is.
 * `fetchStats({ days, tz })` geeft het antwoord van de server of gooit een fout met `code` ('OFFLINE', 'NOT_FOUND', …).
 * @param {{ fetchStats: (q: { tz: string }) => Promise<object>, storage?: Storage | null, onChange?: () => void, now?: () => number }} options
 */
export function createStatsFeed({ fetchStats, storage = null, onChange = () => {}, now = () => Date.now() }) {
  const state = { userId: null, data: null, fetchedAt: null, loading: false, error: null };
  const read = () => {
    try {
      return JSON.parse(storage?.getItem(STATS_KEY) ?? 'null');
    } catch {
      return null; // opslag geblokkeerd of onleesbaar: dan maar zonder
    }
  };
  const write = (value) => {
    try {
      if (value === null) storage?.removeItem(STATS_KEY);
      else storage?.setItem(STATS_KEY, JSON.stringify(value));
    } catch { /* opslag vol of geblokkeerd: het overzicht werkt dan alleen met verbinding */ }
  };

  /** Voor wie is het overzicht? Een andere gebruiker begint leeg (en krijgt nooit het bewaarde antwoord van een ander). */
  function use(userId) {
    if (userId === state.userId) return;
    Object.assign(state, { userId, data: null, fetchedAt: null, loading: false, error: null });
    const saved = userId ? read() : null;
    if (saved && saved.user === userId && validStats(saved.data) && typeof saved.fetched_at === 'string') {
      state.data = saved.data;
      state.fetchedAt = saved.fetched_at;
    }
  }

  let pending = null;
  /** Haalt het overzicht op (één tegelijk). Zonder verbinding blijft het vorige staan, met de fout erbij. */
  function refresh({ tz }) {
    if (!state.userId) return Promise.resolve(state);
    if (pending) return pending;
    const forUser = state.userId;
    state.loading = true;
    onChange();
    pending = (async () => {
      try {
        const data = await fetchStats({ tz });
        if (state.userId !== forUser) return state; // intussen afgemeld of een ander account
        if (!validStats(data)) throw Object.assign(new Error('onverwacht antwoord'), { code: 'FAILED' });
        state.data = data;
        state.fetchedAt = new Date(now()).toISOString();
        state.error = null;
        write({ user: forUser, fetched_at: state.fetchedAt, data });
      } catch (err) {
        if (state.userId === forUser) state.error = err?.code === 'OFFLINE' ? 'OFFLINE' : err?.status === 404 ? 'UNSUPPORTED' : 'FAILED';
      } finally {
        pending = null;
        state.loading = false;
        onChange();
      }
      return state;
    })();
    return pending;
  }

  /** Vergeet alles, ook wat bewaard is (afmelden). */
  function forget() {
    Object.assign(state, { userId: null, data: null, fetchedAt: null, loading: false, error: null });
    write(null);
  }

  return { state, use, refresh, forget };
}
