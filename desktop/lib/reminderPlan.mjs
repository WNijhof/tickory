// Welke herinneringen de desktop-app zelf laat afgaan. Electron kent geen web-push, dus de app haalt (zoals de Android-app) de taken en
// herinneringen van de server en plant ze als gewone timers, met dezelfde regels als de server (shared/reminders.js): een absolute
// herinnering op haar tijdstip, een relatieve zoveel minuten vóór de taak met een tijd; alleen je eigen, alleen open taken. Daarnaast
// de herinneringen op je notities en het ochtendoverzicht en de avondreview, zoals in de Android-app.
import { epochToFloating, floatingToEpoch, reminderMoment } from '../shared/reminders.js';
import { generalOf } from '../shared/general.js';
import { nextNoteReminder, noteHeadline } from '../shared/notes.js';

/** Zo ver vooruit plannen we (een nieuwe verversing plant de rest). */
export const HORIZON_MS = 26 * 60 * 60 * 1000;
/** Een herinnering die we net misten (de pc sliep), tonen we nog als ze niet ouder is dan dit. */
export const LATE_MS = 15 * 60 * 1000;

/**
 * @param {object} sync het antwoord van POST /api/v1/sync (met tasks, reminders, settings, me)
 * @param {number} now ms sinds 1970
 * @param {Set<string> | string[]} shown sleutels "herinnering|moment" die al getoond zijn
 * @returns {{ id: string, taskId: string, title: string, moment: string, at: number, key: string }[]} op volgorde van afgaan
 */
export function planReminders(sync, now, shown = []) {
  const done = shown instanceof Set ? shown : new Set(shown);
  const me = sync?.me?.id ?? null;
  const tasks = new Map((sync?.tasks ?? []).filter((t) => t && !t.is_deleted && !t.checked).map((t) => [t.id, t]));
  const zone = (sync?.settings ?? []).find((s) => s && (!me || s.owner_id === me))?.timezone || null;
  const out = [];
  for (const r of sync?.reminders ?? []) {
    if (!r || r.is_deleted || (me && r.owner_id && r.owner_id !== me)) continue;
    const task = tasks.get(r.task_id);
    if (!task) continue;
    const moment = reminderMoment(r, task);
    if (!moment) continue;
    const at = floatingToEpoch(moment, zone);
    if (at === null || at > now + HORIZON_MS || at < now - LATE_MS) continue;
    const key = `${r.id}|${moment}`;
    if (done.has(key)) continue;
    out.push({ id: r.id, taskId: task.id, title: String(task.content ?? '').slice(0, 300), moment, at, key });
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * De uitgestelde herinneringen (settings.snoozes) als meldingen, zoals planReminders: alleen voor taken die nog open zijn (afgevinkt
 * of verwijderd intussen: niets meer), met de naam zoals die nu is. Een uitstel dat al lang voorbij is (een pc die uit stond) vervalt.
 */
export function planSnoozes(sync, snoozes, now) {
  const tasks = new Map((sync?.tasks ?? []).filter((t) => t && !t.is_deleted && !t.checked).map((t) => [t.id, t]));
  const me = sync?.me?.id ?? null;
  const zone = (sync?.settings ?? []).find((s) => s && (!me || s.owner_id === me))?.timezone || null;
  const out = [];
  for (const s of snoozes ?? []) {
    const task = tasks.get(s.taskId);
    if (!task || s.at < now - LATE_MS || s.at > now + HORIZON_MS) continue;
    out.push({ id: s.reminderId, snoozeId: s.id, taskId: task.id, title: String(task.content ?? '').slice(0, 300), moment: epochToFloating(s.at, zone), at: s.at, key: `snooze|${s.id}` });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Herinneringen op notities (zoals de server en de Android-app): één tijdstip per notitie (`remind_at`, zwevend, in de tijdzone van je
 * instellingen), eenmalig of herhaald (`remind_repeat`). Alleen je eigen notities, niet in de prullenbak. Per notitie de eerstvolgende
 * keer (of een net gemiste) binnen de planning; de keer daarna komt bij een volgende verversing.
 */
export function planNoteReminders(sync, now, shown = []) {
  const done = shown instanceof Set ? shown : new Set(shown);
  const me = sync?.me?.id ?? null;
  const zone = (sync?.settings ?? []).find((s) => s && (!me || s.owner_id === me))?.timezone || null;
  const from = epochToFloating(now - LATE_MS, zone);
  const out = [];
  for (const n of sync?.notes ?? []) {
    if (!n || n.is_deleted || n.trashed_at || !n.remind_at || (me && n.owner_id && n.owner_id !== me)) continue;
    const moment = nextNoteReminder(n.remind_at, n.remind_repeat ?? null, from);
    if (!moment) continue;
    const at = floatingToEpoch(moment, zone);
    if (at === null || at > now + HORIZON_MS || at < now - LATE_MS) continue;
    const key = `note:${n.id}|${moment}`;
    if (done.has(key)) continue;
    out.push({ kind: 'note', id: n.id, noteId: n.id, title: noteHeadline(n, 300), moment, at, key });
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Het ochtendoverzicht en de avondreview (Instellingen › Meldingen, `settings.general.morning_overview` en `evening_review`, "UU:MM"):
 * elke dag op die tijd, in de tijdzone van je instellingen. Vandaag en morgen; wat al getoond is (per dag) niet nog eens.
 */
export function planOverviews(sync, now, shown = []) {
  const done = shown instanceof Set ? shown : new Set(shown);
  const me = sync?.me?.id ?? null;
  const own = (sync?.settings ?? []).find((s) => s && (!me || s.owner_id === me)) ?? null;
  if (!own) return [];
  const zone = own.timezone || null;
  const general = generalOf(own);
  const out = [];
  for (const [overview, time] of [['morning', general.morning_overview], ['evening', general.evening_review]]) {
    if (typeof time !== 'string' || !TIME.test(time)) continue;
    const days = new Set([epochToFloating(now, zone).slice(0, 10), epochToFloating(now + 86_400_000, zone).slice(0, 10)]);
    for (const day of days) {
      const moment = `${day}T${time}`;
      const at = floatingToEpoch(moment, zone);
      if (at === null || at > now + HORIZON_MS || at < now - LATE_MS) continue;
      const key = `overview:${overview}|${day}`;
      if (done.has(key)) continue;
      out.push({ kind: 'overview', id: overview, overview, title: '', moment, at, key });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Wat het overzicht zegt (zoals de Android-app): 's ochtends hoeveel taken er vandaag zijn (en hoeveel daarvan te laat), 's avonds
 * hoeveel er nog over zijn. Zonder namen. Null: niets te melden (de avondreview zwijgt als alles af is).
 */
export function overviewText(overview, sync, day, t) {
  const { count, items } = todayItems(sync, day, Infinity);
  const overdue = items.filter((x) => x.overdue).length;
  if (overview === 'evening') {
    if (count === 0) return null;
    return { title: t('eveningTitle'), body: t(count === 1 ? 'leftOne' : 'leftOther', { n: count }) };
  }
  if (count === 0) return { title: t('morningTitle'), body: t('morningEmpty') };
  const today = t(count === 1 ? 'todayOne' : 'todayOther', { n: count });
  return { title: t('morningTitle'), body: overdue > 0 ? t('withOverdue', { today, n: overdue }) : today };
}

/** De duur van "Uitstellen" (Instellingen › Algemeen, standaard 10 minuten), in ms. */
export function snoozeMs(sync) {
  const me = sync?.me?.id ?? null;
  const own = (sync?.settings ?? []).find((s) => s && (!me || s.owner_id === me)) ?? null;
  return generalOf(own).snooze_minutes * 60_000;
}

/**
 * Vandaag voor het systeemvak en de badge, zoals Vandaag in de web-app: open taken met een datum vóór of op vandaag ([today]
 * 'YYYY-MM-DD'), eerst wat te laat is, dan op tijdstip en prioriteit. Hooguit [max] taken voor het menu; [count] is het totaal.
 */
export function todayItems(sync, today, max = 10) {
  const items = (sync?.tasks ?? [])
    .filter((t) => t && !t.is_deleted && !t.checked && typeof t.due?.date === 'string' && t.due.date.slice(0, 10) <= today)
    .map((t) => ({ id: t.id, title: String(t.content ?? '').slice(0, 120), priority: Number.isInteger(t.priority) ? t.priority : 4, due: t.due.date, overdue: t.due.date.slice(0, 10) < today }))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due.length > 10 ? a.due : `${a.due}T99`).localeCompare(b.due.length > 10 ? b.due : `${b.due}T99`) || a.priority - b.priority || a.id.localeCompare(b.id));
  return { count: items.length, items: items.slice(0, max) };
}
