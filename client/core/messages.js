// Begrijpelijke Nederlandse meldingen voor wijzigingen die de server niet heeft doorgevoerd.
// De server meldt een foutcode en een technische tekst met veldnamen ("task.priority: …"); dat is niet voor gebruikers.

const NOUN = { task: 'taak', project: 'project', section: 'sectie', label: 'label', comment: 'opmerking', reminder: 'herinnering', filter: 'filter' };
const VERB = { add: 'toevoegen', update: 'wijzigen', delete: 'verwijderen', move: 'verplaatsen', complete: 'afvinken', uncomplete: 'heropenen' };

const BY_CODE = {
  NOT_FOUND: 'Dit bestaat niet meer; misschien is het op een ander apparaat verwijderd.',
  DUPLICATE: 'Er bestaat al een label met die naam.',
  CYCLE: 'Dat kan niet: een taak of project kan niet in zichzelf worden geplaatst.',
  CONFLICT: 'Dit past niet meer bij hoe het er nu voor staat, bijvoorbeeld omdat het intussen ergens anders is gewijzigd.',
  ID_EXISTS: 'Dit bestaat al.',
  TOO_LARGE: 'De wijziging is te groot om te versturen.',
  UNKNOWN_COMMAND: 'De server begrijpt dit niet. Ververs de pagina om de nieuwste versie van de app te krijgen.',
  INTERNAL: 'De server had een probleem. Probeer het later opnieuw.',
};
const INVALID = ['INVALID_ARG', 'MISSING_ARG', 'UNKNOWN_ARG', 'READONLY', 'IMMUTABLE', 'INVALID_REQUEST'];

/** "taak wijzigen", "label toevoegen", enzovoort; leeg als het commando niet te herkennen is. */
export function describeCommand(type) {
  const m = /^([a-z]+)_([a-z]+)$/.exec(type ?? '');
  return m && NOUN[m[1]] && VERB[m[2]] ? `${NOUN[m[1]]} ${VERB[m[2]]}` : '';
}

/**
 * @param {{ cmd?: { type?: string }, error_code?: string, error?: string }} e een geweigerd commando
 * @returns {string}
 */
export function describeCommandError(e) {
  const what = describeCommand(e.cmd?.type);
  const reason = INVALID.includes(e.error_code)
    ? 'Deze wijziging is ongeldig en niet doorgevoerd.'
    : BY_CODE[e.error_code] ?? e.error ?? 'De wijziging is niet doorgevoerd.';
  return `${what ? `Niet gelukt (${what}). ` : 'Niet gelukt. '}${reason}`;
}
