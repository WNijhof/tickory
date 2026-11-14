// Meldingen bij samenwerken (zoals de meldingen van Todoist): de soorten, de standaardinstellingen voor push, en de controle op
// de lijst met vermelde personen in een opmerking. Gedeeld door server, web-app en demo.
//
// Een melding (`notification`) maakt alleen de server, voor een ander dan wie iets deed:
//   assigned   iemand wees je een taak toe
//   comment    een opmerking bij een taak die aan jou is toegewezen, die jij maakte of waar je eerder op reageerde, of bij een project waar je lid van bent
//   mention    iemand noemde je in een opmerking (@Naam); gaat voor `comment` bij dezelfde opmerking
//   completed  iemand vinkte een taak af die aan jou is toegewezen
//   shared     iemand voegde je toe aan een project

/** De soorten, in de volgorde waarin het instellingenscherm ze toont. */
export const NOTIFICATION_KINDS = ['assigned', 'comment', 'mention', 'completed', 'shared'];

/** Welke soorten standaard als pushmelding komen: alles behalve "afgevinkt". */
export const DEFAULT_PUSH = Object.freeze({ assigned: true, comment: true, mention: true, completed: false, shared: true });

/** Zoveel personen kan één opmerking vermelden. */
export const MAX_MENTIONS = 20;

/** Zoveel meldingen bewaart de server per gebruiker; de oudste vallen eraf. */
export const MAX_NOTIFICATIONS_PER_USER = 500;

/** Na zoveel dagen ruimt de server een melding op (de app toont oudere ook niet meer). */
export const NOTIFICATION_RETENTION_DAYS = 60;

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

/** Controle van `settings.notify_push`: een object met alleen bekende soorten en per soort true of false. */
export function notifyPushCheck(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'moet een object zijn';
  for (const [k, x] of Object.entries(v)) {
    if (!NOTIFICATION_KINDS.includes(k)) return `onbekende soort "${k}"`;
    if (typeof x !== 'boolean') return `${k} moet true of false zijn`;
  }
  return null;
}

/**
 * De pushkeuze per soort voor deze instellingen (een ontbrekende soort volgt de standaard).
 * @param {{ notify_push?: Record<string, boolean> | null } | null | undefined} settings
 * @returns {Record<string, boolean>}
 */
export function pushChoices(settings) {
  const own = settings?.notify_push && typeof settings.notify_push === 'object' ? settings.notify_push : {};
  const out = {};
  for (const k of NOTIFICATION_KINDS) out[k] = typeof own[k] === 'boolean' ? own[k] : DEFAULT_PUSH[k];
  return out;
}

/** Controle van `comment.mentions`: hooguit 20 verschillende gebruikers-id's. */
export function mentionsCheck(v) {
  if (!Array.isArray(v) || v.length > MAX_MENTIONS) return `moet een lijst van hooguit ${MAX_MENTIONS} gebruikers-id's zijn`;
  if (new Set(v).size !== v.length) return 'bevat dubbele waarden';
  return v.every((x) => typeof x === 'string' && ID_RE.test(x)) ? null : 'bevat een ongeldig id';
}

/**
 * Wie er na een wijziging van een opmerking nieuw vermeld is: alleen voor hen een melding (wie al vermeld was, krijgt er geen tweede).
 * @param {string[] | null | undefined} before
 * @param {string[] | null | undefined} after
 */
export function newMentions(before, after) {
  const had = new Set(before ?? []);
  return (after ?? []).filter((id) => !had.has(id));
}
