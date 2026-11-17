// Je eigen volgorde in Vandaag (zoals "day order" in Todoist). Per gebruiker in `settings.day_order`: een lijst taak-id's, bovenaan
// eerst. Het geldt alleen voor jou, ook bij taken in een gedeeld project, en alleen zolang Vandaag op "eigen volgorde" staat.
// Taken die niet in de lijst staan (nieuw voor vandaag, of nog nooit verschoven) komen erna, in de gewone volgorde: eerst zonder
// tijd, dan op tijd, dan op prioriteit. De web-app houdt de lijst klein: alleen open taken met een datum blijven erin.
// Gedeeld door server (controle), reducer, demo en web-app.

/** Zoveel taken onthoudt de volgorde; meer staat er zelden in Vandaag en Te laat samen. */
export const MAX_DAY_ORDER = 500;
const MAX_ID = 64;

/** Controle van `settings.day_order`: een lijst van verschillende id's (tekst). Geeft een melding of null. */
export function dayOrderCheck(v) {
  if (!Array.isArray(v)) return 'moet een lijst met taak-id\'s zijn';
  if (v.length > MAX_DAY_ORDER) return `hooguit ${MAX_DAY_ORDER} taken`;
  const seen = new Set();
  for (const id of v) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) return 'elk id is tekst van 1 tot 64 tekens';
    if (seen.has(id)) return 'een id staat er twee keer in';
    seen.add(id);
  }
  return null;
}

/**
 * De volgorde van een lijst taken met jouw eigen volgorde erover: eerst de taken uit `order` (in die volgorde), daarna de rest in
 * de volgorde waarin ze binnenkwamen. Geeft een nieuwe lijst; zonder volgorde dezelfde inhoud in dezelfde volgorde.
 * @template {{ id: string }} T
 * @param {T[]} tasks
 * @param {unknown} order
 * @returns {T[]}
 */
export function applyDayOrder(tasks, order) {
  if (!Array.isArray(order) || order.length === 0) return [...tasks];
  const index = new Map();
  order.forEach((id, i) => { if (typeof id === 'string' && !index.has(id)) index.set(id, i); });
  const listed = tasks.filter((t) => index.has(t.id)).sort((a, b) => index.get(a.id) - index.get(b.id));
  return [...listed, ...tasks.filter((t) => !index.has(t.id))];
}
