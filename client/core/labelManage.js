// Labels beheren: controleren van een labelnaam vóór het versturen, met een melding in de taal van de interface.
// De server weigert dezelfde dingen (zie shared/schema.js), maar dan krijg je pas later een foutmelding.

import { nameKey, normalizeText } from '../../shared/text.js';
import { ENTITIES, validateValue } from '../../shared/schema.js';
import { t } from './i18n.js';

const NAME_COLUMN = ENTITIES.label.cols.find((c) => c.name === 'name');
const isOwn = (label, userId) => !label.owner_id || !userId || label.owner_id === userId;

/**
 * Kan dit de naam van een label zijn? Geeft null als het kan, anders de reden: 'empty', 'too_long', 'invalid' (een komma
 * of stuurteken) of 'duplicate' (je hebt al een label met die naam, zonder letter- of accentverschil).
 * @param {{ labels: Map<string, object> }} view
 * @param {string | null} userId
 * @param {string} name
 * @param {string | null} [exceptId] het label dat je hernoemt (dat mag zijn eigen naam houden)
 * @returns {'empty' | 'too_long' | 'invalid' | 'duplicate' | null}
 */
export function labelNameProblem(view, userId, name, exceptId = null) {
  const clean = normalizeText(String(name ?? '')).trim();
  if (clean === '') return 'empty';
  if (clean.length > NAME_COLUMN.maxLen) return 'too_long';
  if (validateValue(NAME_COLUMN, clean) !== null) return 'invalid';
  const key = nameKey(clean);
  for (const other of view.labels.values()) {
    if (other.id !== exceptId && isOwn(other, userId) && nameKey(other.name) === key) return 'duplicate';
  }
  return null;
}

/** De melding bij een reden van `labelNameProblem`, of bij een code van `actions.renameLabel` (NOT_FOUND, READONLY, INVALID_ARG, DUPLICATE). */
export function labelProblemText(code) {
  switch (code) {
    case 'empty': return t('label.err.empty');
    case 'too_long': return t('label.err.tooLong', { max: NAME_COLUMN.maxLen });
    case 'invalid': case 'INVALID_ARG': return t('label.err.invalid');
    case 'duplicate': case 'DUPLICATE': return t('label.err.duplicate');
    case 'READONLY': return t('label.err.readonly');
    case 'NOT_FOUND': return t('label.err.gone');
    default: return t('common.somethingWrong');
  }
}
