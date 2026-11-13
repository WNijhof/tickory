// Te makkelijk te raden wachtwoorden. Gedeeld door de server (die altijd zelf controleert) en de app (die de melding meteen
// toont). Dit is geen sterktemeter maar een ondergrens bovenop de lengte-eis van 10 tekens: een lijst van veelgebruikte
// wachtwoorden en woorden (ook met cijfers erachter), te weinig verschillende tekens, en een korte eenheid die zich herhaalt.

/** Minimaal zoveel verschillende tekens. */
export const MIN_DISTINCT_CHARACTERS = 5;

const COMMON = new Set([
  // wachtwoorden en woorden die overal bovenaan staan, Engels en Nederlands
  'password', 'passw0rd', 'p4ssw0rd', 'passwort', 'wachtwoord', 'wachtwoorden', 'welkom', 'welkom01', 'welkom123', 'geheim', 'geheimpje',
  'qwerty', 'qwertyuiop', 'qwertyui', 'qwertzuiop', 'azerty', 'azertyuiop', 'asdfgh', 'asdfghjkl', 'asdfghjk', 'zxcvbnm', 'qazwsx', 'qazwsxedc',
  'iloveyou', 'letmein', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'admin', 'administrator', 'welcome', 'master',
  'login', 'trustno1', 'changeme', 'secret', 'abc123', 'abcdefgh', 'abcdefghij', 'abcdefghijk', 'abcdefghijkl',
  'tickory', 'todoist', 'todolist', 'takenlijst', 'taken', 'gebruiker', 'beheerder', 'test', 'testtest', 'testen', 'hallo', 'hoi',
  'amsterdam', 'rotterdam', 'utrecht', 'denhaag', 'nederland', 'holland', 'oranje', 'voetbal', 'feyenoord', 'ajax', 'psv', 'liefde',
  'schatje', 'knuffel', 'vakantie', 'zomer', 'winter', 'lente', 'herfst', 'computer', 'internet', 'samsung', 'google', 'apple', 'microsoft',
  '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4', 'q1w2e3r4t5', '1qaz2wsx', 'zaq12wsx', 'qwe123qwe', 'asdasdasd', 'qweqweqwe',
]);

const TRAILING = /[0-9!@#$%^&*()._+=?-]+$/u;

/** De reden in het Nederlands, zoals de server die in zijn melding zet. */
export const WEAK_REASONS_NL = {
  few_characters: 'te weinig verschillende tekens',
  common: 'een veelgebruikt wachtwoord',
  digits_only: 'alleen cijfers en leestekens',
  like_username: 'lijkt op de gebruikersnaam',
  repetition: 'een herhaling van een kort stuk',
};

/**
 * Waarom een wachtwoord te makkelijk te raden is (een code uit WEAK_REASONS_NL), of null als het goed genoeg is. De server maakt
 * er een Nederlandse zin van; de app vertaalt de code in de taal van de interface.
 * @param {string} raw
 * @param {string} [username] een wachtwoord dat op de gebruikersnaam lijkt, telt ook als te makkelijk
 * @returns {'few_characters' | 'common' | 'digits_only' | 'like_username' | 'repetition' | null}
 */
export function weakPasswordReason(raw, username = '') {
  const s = String(raw).normalize('NFC').toLowerCase();
  if (new Set([...s]).size < MIN_DISTINCT_CHARACTERS) return 'few_characters';
  const base = s.replace(TRAILING, '').replace(/^\s+|\s+$/gu, '');
  if (COMMON.has(s) || COMMON.has(base)) return 'common';
  if (base === '' && s.length < 14) return 'digits_only';
  const user = String(username).normalize('NFC').toLowerCase().trim();
  if (user.length >= 3 && (base === user || s === user)) return 'like_username';
  // een korte eenheid die zich herhaalt: "abcabcabcabc", "wachtwoordwachtwoord"
  for (let unit = 1; unit <= Math.floor(s.length / 2); unit++) {
    if (s.length % unit === 0 && s.slice(0, unit).repeat(s.length / unit) === s && unit <= 12) return 'repetition';
  }
  if (base.length >= 3) {
    for (let unit = 1; unit <= Math.floor(base.length / 2); unit++) {
      if (base.length % unit === 0 && base.slice(0, unit).repeat(base.length / unit) === base && COMMON.has(base.slice(0, unit))) return 'common';
    }
  }
  return null;
}

export const isWeakPassword = (raw, username = '') => weakPasswordReason(raw, username) !== null;
