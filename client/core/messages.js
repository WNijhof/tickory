// Begrijpelijke meldingen voor wijzigingen die de server niet heeft doorgevoerd, in de taal van de interface.
// De server meldt een foutcode en een technische tekst met veldnamen ("task.priority: …"); dat is niet voor gebruikers.
//
// De server schrijft zijn tekst in het Nederlands. In het Nederlands tonen we die waar hij preciezer is dan een algemene
// tekst (delen en samenwerken); in een andere taal komt er een eigen vertaling op basis van de foutcode en het soort
// handeling, en is de tekst van de server alleen de laatste terugval.

import { DEFAULT_LANGUAGE, getLanguage, t } from './i18n.js';

/** De taal waarin de server zijn foutteksten schrijft. */
const SERVER_LANGUAGE = DEFAULT_LANGUAGE;

const NOUN = {
  task: () => t('command.noun.task'), project: () => t('command.noun.project'), section: () => t('command.noun.section'), label: () => t('command.noun.label'),
  comment: () => t('command.noun.comment'), attachment: () => t('command.noun.attachment'), reminder: () => t('command.noun.reminder'), filter: () => t('command.noun.filter'), template: () => t('command.noun.template'),
  notification: () => t('command.noun.notification'),
};
const VERB = {
  add: () => t('command.verb.add'), update: () => t('command.verb.update'), delete: () => t('command.verb.delete'),
  move: () => t('command.verb.move'), restore: () => t('command.verb.restore'), complete: () => t('command.verb.complete'), uncomplete: () => t('command.verb.uncomplete'),
};

// Delen en samenwerken hebben eigen zinnen; hun foutmeldingen van de server zijn al begrijpelijk Nederlands en preciezer dan een algemene tekst.
const SPECIAL = { project_share: () => t('command.share'), project_unshare: () => t('command.unshare'), project_leave: () => t('command.leave') };

const BY_CODE = {
  NOT_FOUND: () => t('error.notFound'),
  DUPLICATE: () => t('error.duplicateLabel'),
  CYCLE: () => t('error.cycle'),
  CONFLICT: () => t('error.conflict'),
  ID_EXISTS: () => t('error.idExists'),
  UNAUTHORIZED: () => t('error.unauthorized'),
  TOO_LARGE: () => t('error.tooLarge'),
  UNKNOWN_COMMAND: () => t('error.unknownCommand'),
  INTERNAL: () => t('error.internal'),
};
const INVALID = ['INVALID_ARG', 'MISSING_ARG', 'UNKNOWN_ARG', 'READONLY', 'IMMUTABLE', 'INVALID_REQUEST'];

/**
 * De eigen vertaling voor een foutcode bij één soort handeling, waar de algemene tekst per code te vaag of onjuist zou
 * zijn. Dit zijn de gevallen waarin de server een eigen, preciezere zin meestuurt (zie server/sync.ts).
 */
const BY_COMMAND_AND_CODE = {
  'task_restore:CONFLICT': () => t('error.restoreLate'),
  'section_restore:CONFLICT': () => t('error.restoreLate'),
  'task_restore:FORBIDDEN': () => t('error.restoreForbidden'),
  'section_restore:FORBIDDEN': () => t('error.restoreForbidden'),
  'project_share:NOT_FOUND': () => t('error.shareUserNotFound'),
  'project_share:FORBIDDEN': () => t('error.shareOwnerOnly'),
  'project_share:CONFLICT': () => t('error.shareInbox'),
  'project_unshare:FORBIDDEN': () => t('error.unshareOwnerOnly'),
  'project_unshare:NOT_FOUND': () => t('error.unshareNotMember'),
  'project_unshare:CONFLICT': () => t('error.unshareOwner'),
  'project_leave:CONFLICT': () => t('error.leaveOwner'),
  'project_delete:FORBIDDEN': () => t('error.projectDeleteOwnerOnly'),
  'project_update:FORBIDDEN': () => t('error.projectMoveOwnerOnly'),
  'label_update:FORBIDDEN': () => t('error.labelForeign'),
  'label_delete:FORBIDDEN': () => t('error.labelForeign'),
  'filter_update:FORBIDDEN': () => t('error.filterForeign'),
  'filter_delete:FORBIDDEN': () => t('error.filterForeign'),
  'comment_update:FORBIDDEN': () => t('error.commentForeign'),
  'comment_delete:FORBIDDEN': () => t('error.commentForeign'),
  'attachment_delete:FORBIDDEN': () => t('error.attachmentForeign'),
  'attachment_add:NOT_FOUND': () => t('error.attachmentUploadGone'),
  'attachment_add:LIMIT_REACHED': () => t('error.attachmentLimit'),
};
/** Codes zonder algemene Nederlandse tekst (daar staat de tekst van de server), met een eigen vertaling voor de andere talen. */
const BY_CODE_TRANSLATED = {
  FORBIDDEN: () => t('error.forbidden'),
  LIMIT_REACHED: () => t('error.limitReached'), // in het Nederlands staat de precieze tekst van de server (welke grens, hoeveel)
  UNKNOWN: () => t('error.unknown'), // de client zelf meldt deze code als de server geen reden gaf (core/store.js)
};

/**
 * Een geweigerde wijziging aan een melding (gelezen zetten) hoeft niemand te zien: de melding is dan intussen weg (opgeruimd, of
 * de taak is verwijderd), en na de sync is ze ook hier weg.
 */
export const quietCommandError = (e) => /^notification_/.test(e.cmd?.type ?? '') && (e.error_code === 'NOT_FOUND' || e.error_code === 'UNKNOWN_COMMAND');

const pick = (table, key) => (Object.hasOwn(table, key ?? '') ? table[key]() : null);
const capitalize = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** "taak wijzigen", "label toevoegen", enzovoort; leeg als het commando niet te herkennen is. */
export function describeCommand(type) {
  const special = pick(SPECIAL, type);
  if (special) return special;
  const m = /^([a-z]+)_([a-z]+)$/.exec(type ?? '');
  const noun = m ? pick(NOUN, m[1]) : null;
  const verb = m ? pick(VERB, m[2]) : null;
  return noun && verb ? t('command.pattern', { noun, verb }) : '';
}

/**
 * @param {{ cmd?: { type?: string }, error_code?: string, error?: string }} e een geweigerd commando
 * @returns {string}
 */
export function describeCommandError(e) {
  const type = e.cmd?.type ?? '';
  const what = describeCommand(type);
  const sentence = (reason) => (what ? t('error.failedWhat', { what, reason: capitalize(reason) }) : t('error.failed', { reason: capitalize(reason) }));
  const general = INVALID.includes(e.error_code) ? t('error.invalid') : pick(BY_CODE, e.error_code);

  if (getLanguage() === SERVER_LANGUAGE) {
    if (Object.hasOwn(SPECIAL, type) && e.error) return sentence(`${e.error}${/[.!?]$/.test(e.error) ? '' : '.'}`);
    // terugzetten (te laat, geen recht): de eigen zin is duidelijker dan de algemene tekst bij CONFLICT en dan de technische tekst van de server
    if (type.endsWith('_restore')) {
      const own = pick(BY_COMMAND_AND_CODE, `${type}:${e.error_code}`);
      if (own) return sentence(own);
    }
    return sentence(general ?? e.error ?? t('error.notApplied'));
  }
  // Een andere taal dan die van de server: eerst de eigen vertaling, de tekst van de server alleen als er niets beters is.
  return sentence(pick(BY_COMMAND_AND_CODE, `${type}:${e.error_code}`) ?? general ?? pick(BY_CODE_TRANSLATED, e.error_code) ?? e.error ?? t('error.notApplied'));
}
