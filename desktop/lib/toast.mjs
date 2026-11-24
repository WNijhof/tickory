// Een melding van Windows met knoppen (zoals de Todoist-app: Voltooien en Uitstellen), en de adressen tickory://… waarmee Windows de
// app terugroept als je op de melding of een knop tikt. Ook de meldingen zonder knoppen voor Voltooien (een notitie, samenwerken, het
// dagelijks overzicht) openen zo de juiste plek. Zuiver: alleen tekst, te testen zonder Windows.

const ID = /^[A-Za-z0-9_-]{8,40}$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** Het adres van een handeling: tickory://open?task=…, tickory://complete?task=…&reminder=…&moment=…, tickory://snooze?… */
export function actionUrl(action, { taskId, reminderId = null, moment = null }) {
  const q = new URLSearchParams({ task: taskId });
  if (reminderId) q.set('reminder', reminderId);
  if (moment) q.set('moment', moment);
  return `tickory://${action}?${q}`;
}

/** Wat een tik op de melding opent: een taak, een notitie, een melding bij samenwerken of een vast overzicht (Vandaag). */
export function openUrl({ task = null, note = null, notification = null, view = null }) {
  const [key, value] = note ? ['note', note] : notification ? ['notification', notification] : view ? ['view', view] : ['task', task];
  return `tickory://open?${new URLSearchParams({ [key]: value })}`;
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
  if (action === 'open') {
    // een notitie, een melding bij samenwerken of een overzicht in plaats van een taak
    const note = u.searchParams.get('note');
    if (note !== null) return ID.test(note) ? { action, noteId: note } : null;
    const notification = u.searchParams.get('notification');
    if (notification !== null) return ID.test(notification) ? { action, notificationId: notification } : null;
    const view = u.searchParams.get('view');
    if (view !== null) return /^[a-z-]{1,30}$/.test(view) ? { action, view } : null;
  }
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

/** Een herinnering op een notitie: blijft staan tot je reageert, met alleen Openen (een notitie vink je niet af). */
export function noteToastXml({ title, time, noteId, t }) {
  const open = openUrl({ note: noteId });
  return `<toast activationType="protocol" launch="${esc(open)}" scenario="reminder">`
    + `<visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(time ? `${t('reminder')} · ${time}` : t('reminder'))}</text></binding></visual>`
    + `<actions><action content="${esc(t('open'))}" activationType="protocol" arguments="${esc(open)}"/></actions></toast>`;
}

/** Een gewone melding (samenwerken, het dagelijks overzicht, de testmelding): een titel, een paar regels, en wat een tik opent. */
export function infoToastXml({ title, lines = [], launch }) {
  return `<toast activationType="protocol" launch="${esc(launch)}">`
    + `<visual><binding template="ToastGeneric"><text>${esc(title)}</text>${lines.slice(0, 2).map((l) => `<text>${esc(l)}</text>`).join('')}</binding></visual></toast>`;
}
