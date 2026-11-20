// Welke herinneringen de desktop-app zelf laat afgaan. Electron kent geen web-push, dus de app haalt (zoals de Android-app) de taken en
// herinneringen van de server en plant ze als gewone timers, met dezelfde regels als de server (shared/reminders.js): een absolute
// herinnering op haar tijdstip, een relatieve zoveel minuten vóór de taak met een tijd; alleen je eigen, alleen open taken.
import { floatingToEpoch, reminderMoment } from '../shared/reminders.js';
import { generalOf } from '../shared/general.js';

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
