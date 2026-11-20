// Een melding van Windows met knoppen (zoals de Todoist-app: Voltooien en Uitstellen), en de adressen tickory://… waarmee Windows de
// app terugroept als je op de melding of een knop tikt. Zuiver: alleen tekst, te testen zonder Windows.

const ID = /^[A-Za-z0-9_-]{8,40}$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** Het adres van een handeling: tickory://open?task=…, tickory://complete?task=…&reminder=…&moment=…, tickory://snooze?… */
export function actionUrl(action, { taskId, reminderId = null, moment = null }) {
  const q = new URLSearchParams({ task: taskId });
  if (reminderId) q.set('reminder', reminderId);
  if (moment) q.set('moment', moment);
  return `tickory://${action}?${q}`;
}

/** Leest een tickory://-adres terug; alleen bekende handelingen en geldige id's. */
export function parseActionUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== 'tickory:') return null;
  const action = u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0];
  if (!['open', 'complete', 'snooze', 'quick-add'].includes(action)) return null;
  if (action === 'quick-add') return { action };
  const taskId = u.searchParams.get('task');
  if (!ID.test(taskId ?? '')) return null;
  const reminderId = u.searchParams.get('reminder');
  const moment = u.searchParams.get('moment');
  return {
    action, taskId,
    reminderId: reminderId && ID.test(reminderId) ? reminderId : null,
    moment: moment && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(moment) ? moment : null,
  };
}

/**
 * De XML van de melding (ToastGeneric) met de titel, de tijd en twee knoppen. Alles via het protocol, zodat het ook werkt als de
 * melding uit het Actiecentrum komt terwijl de app al is gesloten.
 */
export function reminderToastXml({ title, time, taskId, reminderId, moment, t, canComplete = true }) {
  const ref = { taskId, reminderId, moment };
  const actions = [
    canComplete ? `<action content="${esc(t('complete'))}" activationType="protocol" arguments="${esc(actionUrl('complete', ref))}"/>` : '',
    `<action content="${esc(t('snooze'))}" activationType="protocol" arguments="${esc(actionUrl('snooze', ref))}"/>`,
  ].join('');
  return `<toast activationType="protocol" launch="${esc(actionUrl('open', ref))}" scenario="reminder">`
    + `<visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(time ? `${t('reminder')} · ${time}` : t('reminder'))}</text></binding></visual>`
    + `<actions>${actions}</actions></toast>`;
}
