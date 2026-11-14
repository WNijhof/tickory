// Het scherm "Productiviteit" (route `{ type: 'productivity' }`, via Voltooid en Instellingen; geen eigen regel in de zijbalk):
// vandaag en deze week tegenover je doelen, de reeksen dagen en weken, de laatste 7 dagen en de laatste 4 of 12 weken als
// staafdiagram, deze week per project, en de doelen zelf. Plus de korte kop boven Voltooid (`completedHeader`).
//
// De getallen komen van de server (`GET /api/v1/stats`, alleen je eigen afvinkingen; de demo rekent ze zelf); de rekenkern staat in
// core/productivity.js en het diagram in ui/charts.js. Het laatste antwoord blijft bewaard (localStorage, alleen van de aangemelde
// gebruiker; niet in de demo), zodat het scherm ook zonder verbinding iets toont, met wanneer het is bijgewerkt. Na een afvinking
// (hier of op een ander apparaat) wordt het overzicht bijgewerkt zolang het in beeld is, hooguit eens per 5 seconden.
//
// Geen punten, niveaus of beloningen: alleen wat je deed, je eigen doelen en of je ze haalde.

import { DAYS_OFF_MAX, GOALS, STATS_MAX_DAYS, goalsOf } from '../../shared/stats.js';
import { completionMark, createStatsFeed, summarize } from '../core/productivity.js';
import { dayLabel, isoWeekday, weekdayNames } from '../core/calendar.js';
import { addDays } from '../core/format.js';
import { colorClass } from '../core/colors.js';
import { getLocale, t } from '../core/i18n.js';
import { timeAgo } from '../core/timeAgo.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { viewHooks } from './render.js';
import { barChart } from './charts.js';

export const isProductivityRoute = (route) => Boolean(route) && route.type === 'productivity';

/** Op dit apparaat: 4 of 12 weken in het weekdiagram. */
const WEEKS_KEY = 'tickory.productivityWeeks';
/** Hoe lang een antwoord vers genoeg is om bij het openen niet opnieuw te vragen. */
const FRESH_MS = 30_000;
/** Niet vaker dan dit opnieuw vragen. */
const MIN_GAP_MS = 5_000;

const deviceZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
const storageOrNull = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const tasksText = (count) => t('productivity.tasks', { count });
/** Een balkje met een breedte in procenten. Via het CSSOM (`style.width`): een style-attribuut staat de Content-Security-Policy niet toe. */
function fill(className, percent) {
  const el = h('span', { class: className });
  el.style.width = `${percent}%`;
  return el;
}

/** "9–15 nov" in de taal van de interface. */
function weekRange(locale, start) {
  const f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'short' });
  return f.formatRange(new Date(`${start}T00:00:00Z`), new Date(`${addDays(start, 6)}T00:00:00Z`));
}

/**
 * @param {{
 *   store: import('../core/store.js').Store, api: { stats: (q: object) => Promise<object> }, actions: { updateSettings: (c: object) => Promise<unknown> },
 *   handlers: { refresh: () => void }, navigate: (route: object) => void, getRoute: () => object, persist: boolean,
 * }} options `persist`: het laatste antwoord en de weekkeuze bewaren (niet in de demo)
 */
export function installProductivity({ store, api, actions, handlers, navigate, getRoute, persist }) {
  const storage = persist ? storageOrNull() : null;
  const visible = () => {
    const r = getRoute();
    return r.type === 'productivity' || (r.type === 'completed' && !r.id);
  };
  const feed = createStatsFeed({
    fetchStats: ({ tz }) => api.stats({ tz }),
    storage,
    onChange: () => queueMicrotask(() => { if (visible()) handlers.refresh(); }),
  });
  let weeks = 12;
  try {
    if (storage?.getItem(WEEKS_KEY) === '4') weeks = 4;
  } catch { /* geen opslag: 12 */ }

  // ---------- wanneer bijwerken ----------

  let lastFetch = 0;
  let lastMark = null;
  let timer = null;
  const mark = () => `${completionMark(store.view)}|${store.queueLength}`;
  const fetchNow = () => {
    lastFetch = Date.now();
    lastMark = mark();
    feed.refresh({ tz: deviceZone() });
  };
  /** Opnieuw vragen na `delay`, en niet binnen MIN_GAP_MS na de vorige keer (wat te vroeg komt, wacht tot het mag). */
  function schedule(delay) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!visible() || !store.me) return;
      const wait = MIN_GAP_MS - (Date.now() - lastFetch);
      if (wait > 0) {
        schedule(wait);
        return;
      }
      fetchNow();
    }, delay);
  }
  const follow = () => {
    // wie er is: zonder aangemelde gebruiker (afgemeld, of een ander account op komst) blijft er niets bewaard
    if (store.ready && !store.me) feed.forget();
    else if (store.me) feed.use(store.me.id);
    if (visible() && store.me && lastMark !== null && mark() !== lastMark) schedule(1500); // iets afgevinkt of heropend
  };
  store.subscribe(follow);
  follow();

  /**
   * Bij het tekenen: nog niets, te oud, van een eerdere dag, of is er iets afgevinkt sinds de vorige keer (ook terwijl een ander
   * scherm in beeld was)? Dan (zo meteen) opnieuw vragen; na een fout pas na FRESH_MS of na een nieuwe afvinking.
   */
  function ensureFresh(stale) {
    if (!store.me || feed.state.loading || timer) return;
    const age = Date.now() - lastFetch;
    const changed = lastMark !== null && mark() !== lastMark;
    if (age > FRESH_MS || changed || ((!feed.state.data || stale) && !feed.state.error && age > MIN_GAP_MS)) schedule(0);
  }

  const settingsRow = (view) => view.settings.get(`settings-${store.userId}`) ?? null;
  const nameOf = (view) => (id) => view.projects.get(id)?.name ?? '';

  function status() {
    const st = feed.state;
    const when = st.fetchedAt ? timeAgo(st.fetchedAt) : '';
    if (st.error === 'OFFLINE') return st.data ? t('productivity.offlineCached', { when }) : t('productivity.offlineEmpty');
    if (st.error === 'UNSUPPORTED') return t('productivity.unsupported');
    if (st.error) return st.data ? t('productivity.failedCached', { when }) : t('productivity.failed');
    if (!st.data) return st.loading ? t('common.loading') : '';
    return t('productivity.updated', { when });
  }

  // ---------- de kop boven Voltooid ----------

  const ofGoal = (x) => (x.goal > 0 ? t('productivity.ofGoal', { count: x.count, goal: x.goal }) : tasksText(x.count));

  /** De korte kop boven Voltooid (alle projecten): vandaag, deze week en de reeks, met een knop naar het hele overzicht. */
  function completedHeader({ view, today }) {
    const s = summarize(feed.state.data, { settings: settingsRow(view), today, weeks: 1 });
    ensureFresh(s?.stale);
    const item = (label, value, extra = null) => h('span', { class: 'stats-strip-item' }, h('span', { class: 'stats-strip-label' }, label), ' ', h('strong', { class: 'stats-strip-value' }, value), extra);
    const open = h('button', {
      class: 'button button-small stats-strip-open', type: 'button', dataset: { fk: 'productivity-open' }, onclick: () => navigate({ type: 'productivity' }),
    }, icon('chart'), h('span', {}, t('productivity.open')));
    if (!s) return h('section', { class: 'stats-strip', 'aria-label': t('productivity.headerLabel') }, h('span', { class: 'hint stats-strip-status', role: 'status' }, status()), open);
    return h('section', { class: 'stats-strip', 'aria-label': t('productivity.headerLabel') },
      item(t('productivity.today'), ofGoal(s.today), s.today.met && h('span', { class: 'stats-strip-met' }, icon('check'), h('span', { class: 'sr-only' }, t('productivity.goalMet')))),
      item(t('productivity.week'), ofGoal(s.week), s.week.met && h('span', { class: 'stats-strip-met' }, icon('check'), h('span', { class: 'sr-only' }, t('productivity.goalMet')))),
      s.dayStreak && item(t('productivity.dayStreak'), t('productivity.streakDays', { count: s.dayStreak.current })),
      open);
  }

  // ---------- de doelen (blijvende velden: een nieuw veld bij elke keer tekenen zou tijdens het typen zijn tekst kwijtraken) ----------

  const goalField = (key, limits) => {
    const input = h('input', {
      class: 'field goal-input', type: 'number', id: `goal-${key}`, min: String(limits.min), max: String(limits.max), step: '1', inputMode: 'numeric',
      dataset: { fk: `goal-${key}` }, 'aria-describedby': `goal-${key}-hint`,
    });
    const hint = h('p', { class: 'hint goal-hint', id: `goal-${key}-hint`, 'aria-live': 'polite' });
    const column = key === 'daily' ? 'goal_daily' : 'goal_weekly';
    input.addEventListener('change', () => {
      const text = input.value.trim();
      const n = Number(text);
      if (!/^\d{1,3}$/.test(text) || n < limits.min || n > limits.max) {
        input.setAttribute('aria-invalid', 'true');
        hint.textContent = t('productivity.goalInvalid', { min: limits.min, max: limits.max });
        hint.classList.add('hint-bad');
        return;
      }
      input.removeAttribute('aria-invalid');
      hint.classList.remove('hint-bad');
      hint.textContent = t('productivity.goalSaved');
      const now = goalsOf(settingsRow(store.view))[key];
      if (n !== now) actions.updateSettings({ [column]: n });
    });
    return { input, hint };
  };
  const daily = goalField('daily', GOALS.daily);
  const weekly = goalField('weekly', GOALS.weekly);
  const daysOffHint = h('p', { class: 'hint goal-hint', id: 'days-off-hint', 'aria-live': 'polite' });

  function goalsSection(goals) {
    const locale = getLocale();
    for (const [field, value] of [[daily, goals.daily], [weekly, goals.weekly]]) {
      if (document.activeElement !== field.input && field.input.getAttribute('aria-invalid') !== 'true') field.input.value = String(value);
    }
    const short = weekdayNames(locale, 'short');
    const long = weekdayNames(locale, 'long');
    const off = new Set(goals.daysOff);
    const toggle = (day, on) => {
      // de huidige instellingen, niet die van het laatste tekenen: twee snelle tikken binnen één beeldverversing tellen allebei
      const next = new Set(goalsOf(settingsRow(store.view)).daysOff);
      if (on) next.add(day);
      else next.delete(day);
      if (next.size > DAYS_OFF_MAX) {
        daysOffHint.textContent = t('productivity.daysOffMax');
        daysOffHint.classList.add('hint-bad');
        handlers.refresh();
        return;
      }
      daysOffHint.classList.remove('hint-bad');
      daysOffHint.textContent = t('productivity.goalSaved');
      actions.updateSettings({ days_off: [...next].sort((a, b) => a - b) });
    };
    const label = (forId, text) => h('label', { class: 'goal-label', for: forId }, text);
    return h('section', { class: 'stats-section stats-goals', 'aria-labelledby': 'stats-goals-title' },
      h('h2', { class: 'stats-heading', id: 'stats-goals-title' }, t('productivity.goals')),
      h('div', { class: 'goal-row' },
        h('div', { class: 'goal-field' }, label('goal-daily', t('productivity.goalDaily')), daily.input, daily.hint),
        h('div', { class: 'goal-field' }, label('goal-weekly', t('productivity.goalWeekly')), weekly.input, weekly.hint)),
      h('p', { class: 'hint' }, t('productivity.goalHint')),
      h('fieldset', { class: 'days-off', 'aria-describedby': 'days-off-hint days-off-help' },
        h('legend', { class: 'goal-label' }, t('productivity.daysOff')),
        h('div', { class: 'days-off-list' }, [1, 2, 3, 4, 5, 6, 7].map((day) => h('label', { class: 'day-toggle' },
          h('input', { type: 'checkbox', checked: off.has(day), dataset: { fk: `day-off-${day}` }, onchange: (e) => toggle(day, e.target.checked) }),
          h('span', { 'aria-hidden': 'true' }, short[day - 1]), h('span', { class: 'sr-only' }, long[day - 1])))),
        h('p', { class: 'hint', id: 'days-off-help' }, t('productivity.daysOffHelp')),
        daysOffHint));
  }

  // ---------- het scherm ----------

  function tiles(s) {
    const meter = (x) => (x.goal > 0 ? h('span', { class: 'stat-meter', 'aria-hidden': 'true' }, fill('stat-meter-fill', Math.min(100, Math.round((x.count / x.goal) * 100)))) : null);
    const tile = (label, value, sub, extra = null) => h('div', { class: 'stat-tile' }, h('p', { class: 'stat-label' }, label), h('p', { class: 'stat-value' }, value), sub && h('p', { class: 'stat-sub' }, sub), extra);
    const goalSub = (x, offDay = false) => (x.goal === 0 ? t('productivity.goalOff') : x.met ? t('productivity.goalMet') : offDay ? t('productivity.dayOff') : t('productivity.toGo', { count: x.goal - x.count }));
    const streak = (st, unit, longest) => (st === null
      ? tile(unit === 'days' ? t('productivity.dayStreak') : t('productivity.weekStreak'), '–', t('productivity.streakOff'))
      : tile(unit === 'days' ? t('productivity.dayStreak') : t('productivity.weekStreak'),
        unit === 'days' ? t('productivity.streakDays', { count: st.current }) : t('productivity.streakWeeks', { count: st.current }), longest(st.longest)));
    return h('div', { class: 'stat-tiles' },
      tile(t('productivity.today'), ofGoal(s.today), goalSub(s.today, s.today.off), meter(s.today)),
      tile(t('productivity.week'), ofGoal(s.week), goalSub(s.week), meter(s.week)),
      streak(s.dayStreak, 'days', (count) => t('productivity.longestDays', { count })),
      streak(s.weekStreak, 'weeks', (count) => t('productivity.longestWeeks', { count })));
  }

  function dayChart(s) {
    const locale = getLocale();
    const short = weekdayNames(locale, 'short');
    return h('section', { class: 'stats-section', 'aria-labelledby': 'stats-days-title' },
      h('h2', { class: 'stats-heading', id: 'stats-days-title' }, t('productivity.lastSeven')),
      barChart({
        bars: s.days.map((d) => ({
          label: short[isoWeekday(d.date) - 1], name: dayLabel(locale, d.date, 'long'), value: d.count,
          valueText: d.known ? tasksText(d.count) : t('productivity.unknown'), current: d.today, muted: d.off || !d.known,
        })),
        goal: s.goals.daily, goalLabel: t('productivity.goalPerDay', { goal: s.goals.daily }),
        caption: s.goals.daily > 0 ? t('productivity.lastSevenCaption', { goal: s.goals.daily }) : t('productivity.lastSeven'), columns: [t('productivity.columnDay'), t('productivity.columnCount')],
      }),
      s.goals.daysOff.length > 0 && h('p', { class: 'hint chart-note' }, t('productivity.daysOffShown')));
  }

  function weekChart(s) {
    const locale = getLocale();
    const highest = Math.max(...s.weeks.map((w) => w.count));
    const choice = (n) => h('button', {
      class: `button button-small view-switch-button${weeks === n ? ' active' : ''}`, type: 'button', 'aria-pressed': String(weeks === n), dataset: { fk: `stats-weeks-${n}` },
      onclick: () => {
        weeks = n;
        try {
          storage?.setItem(WEEKS_KEY, String(n));
        } catch { /* niet bewaren */ }
        handlers.refresh();
      },
    }, n === 4 ? t('productivity.fourWeeks') : t('productivity.twelveWeeks'));
    return h('section', { class: 'stats-section', 'aria-labelledby': 'stats-weeks-title' },
      h('div', { class: 'stats-section-head' },
        h('h2', { class: 'stats-heading', id: 'stats-weeks-title' }, t('productivity.perWeek')),
        h('div', { class: 'view-switch', role: 'group', 'aria-label': t('productivity.weeksLabel') }, choice(4), choice(12))),
      barChart({
        bars: s.weeks.map((w) => ({
          label: String(w.week), name: t('productivity.weekName', { week: w.week, range: weekRange(locale, w.start) }), value: w.count,
          valueText: w.unknown ? t('productivity.unknown') : tasksText(w.count), current: w.current, muted: Boolean(w.unknown),
          showValue: weeks <= 4 || w.current || (w.count === highest && w.count > 0),
        })),
        goal: s.goals.weekly, goalLabel: t('productivity.goalPerWeek', { goal: s.goals.weekly }), className: weeks > 4 ? 'chart-dense' : '',
        caption: s.goals.weekly > 0 ? t('productivity.weeksCaption', { count: weeks, goal: s.goals.weekly }) : t('productivity.perWeek'), columns: [t('calendar.week'), t('productivity.columnCount')],
      }),
      h('p', { class: 'hint chart-note' }, t('productivity.weekNumbers')));
  }

  function projectsSection(s, view) {
    const { items, rest, restProjects, total } = s.projects;
    const top = Math.max(1, ...items.map((x) => x.count), rest);
    const row = (name, dotClass, count) => h('li', { class: 'share-row' },
      h('span', { class: 'share-name' }, h('span', { class: `dot ${dotClass}`, 'aria-hidden': 'true' }), h('span', { class: 'share-text' }, name)),
      h('span', { class: 'share-bar', 'aria-hidden': 'true' }, fill(`share-fill ${dotClass}`, Math.max(2, Math.round((count / top) * 100)))),
      h('span', { class: 'share-count' }, String(count), h('span', { class: 'sr-only' }, ` ${tasksText(count)}`)));
    return h('section', { class: 'stats-section', 'aria-labelledby': 'stats-projects-title' },
      h('h2', { class: 'stats-heading', id: 'stats-projects-title' }, t('productivity.projects')),
      total === 0
        ? h('p', { class: 'hint' }, t('productivity.projectsEmpty'))
        : h('ul', { class: 'share-list' },
          items.map(({ projectId, count }) => {
            const p = view.projects.get(projectId);
            return row(p ? p.name : t('productivity.otherProject'), colorClass(p?.color), count);
          }),
          rest > 0 && row(t('productivity.restProjects', { count: restProjects }), 'share-rest', rest)));
  }

  viewHooks.productivity = ({ view, today }) => {
    const settings = settingsRow(view);
    const goals = goalsOf(settings);
    const s = summarize(feed.state.data, { settings, today, weeks, nameOf: nameOf(view) });
    ensureFresh(s?.stale);
    const st = feed.state;
    return {
      title: t('productivity.title'),
      count: null,
      lead: icon('chart'),
      actions: [
        h('button', {
          class: 'button button-small button-ghost', type: 'button', 'aria-label': t('productivity.toCompleted'), title: t('productivity.toCompleted'),
          dataset: { fk: 'productivity-completed' }, onclick: () => navigate({ type: 'completed' }),
        }, icon('completed'), h('span', { class: 'btn-label' }, t('nav.completed'))),
        h('button', {
          class: 'button button-small', type: 'button', disabled: st.loading || !store.me, dataset: { fk: 'productivity-refresh' },
          onclick: () => fetchNow(),
        }, t('productivity.refresh')),
      ],
      nodes: [
        h('p', { class: `hint stats-status${st.error && st.error !== 'OFFLINE' ? ' hint-bad' : ''}`, role: 'status' }, status()),
        s && tiles(s),
        s && dayChart(s),
        s && weekChart(s),
        s && projectsSection(s, view),
        store.me && goalsSection(goals),
        h('section', { class: 'stats-section stats-about' },
          h('p', { class: 'hint' }, t('productivity.note')),
          h('p', { class: 'hint' }, t('productivity.retention', { days: STATS_MAX_DAYS }))),
      ],
    };
  };

  return { completedHeader, forget: () => feed.forget(), feed };
}
