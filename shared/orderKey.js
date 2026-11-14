// Fractional indexing: sleutels (strings) waartussen je altijd een nieuwe sleutel kunt invoegen.
// Een verplaatsing wijzigt zo maar één rij, en twee gelijktijdige verplaatsingen botsen minder.
// Gedeeld door server en client.
//
// Een sleutel is een breuk in basis 62 (cijfers "0-9A-Za-z", oplopend in ASCII-volgorde) zonder de "0." ervoor.
// Vergelijken gaat dus met gewone stringvergelijking. Een sleutel eindigt nooit op "0" (canoniek).

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

function idx(c) {
  const i = DIGITS.indexOf(c);
  if (i < 0) throw new Error(`ongeldig teken in sleutel: ${JSON.stringify(c)}`);
  return i;
}

/** Geeft een sleutel m met a < m < b. `a` = '' betekent "begin", `b` = null betekent "einde". */
function midpoint(a, b) {
  if (b !== null && a >= b) throw new Error(`a moet kleiner zijn dan b (${a} >= ${b})`);
  if (a.endsWith('0') || (b !== null && b.endsWith('0'))) throw new Error('sleutels mogen niet op 0 eindigen');
  if (b !== null) {
    // gemeenschappelijk voorvoegsel eraf halen (a wordt opgevuld met nullen)
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? idx(a[0]) : 0;
  const db = b !== null ? idx(b[0]) : BASE;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  // opeenvolgende cijfers
  if (b !== null && b.length > 1) return b.slice(0, 1); // b[0] alleen ligt tussen a en b
  return DIGITS[da] + midpoint(a.slice(1), null);
}

/**
 * Nieuwe sleutel tussen `a` (of begin) en `b` (of einde).
 * @param {string | null} a
 * @param {string | null} b
 * @returns {string}
 */
export function keyBetween(a, b) {
  return midpoint(a ?? '', b);
}

/** @param {string | null} a */
export const keyAfter = (a) => keyBetween(a, null);
/** @param {string | null} b */
export const keyBefore = (b) => keyBetween(null, b);

/** Controle voor invoer van buiten: alleen geldige, canonieke sleutels. */
export function isValidKey(k) {
  if (typeof k !== 'string' || k.length === 0 || k.length > 64) return false;
  for (const c of k) if (!DIGITS.includes(c)) return false;
  return !k.endsWith('0');
}

/** `n` gelijkmatig verdeelde sleutels, bijvoorbeeld voor het herordenen van een hele lijst. */
export function keysEvenly(n) {
  const out = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    prev = keyAfter(prev);
    out.push(prev);
  }
  return out;
}

/**
 * `n` oplopende sleutels, allemaal achter `after` (null = vanaf het begin), zo kort mogelijk. Voor een hele reeks tegelijk, zoals
 * de taken van een sjabloon: `keyAfter` steeds op de vorige toepassen geeft na ruim driehonderd sleutels meer dan 64 tekens
 * (de bovengrens voor een sleutel die een client meestuurt), dit blijft bij duizend sleutels op een paar tekens.
 * @param {string | null} after
 * @param {number} n
 * @returns {string[]}
 */
export function keysAfter(after, n) {
  if (n <= 0) return [];
  const len = after ? after.length : 0;
  const base = BigInt(BASE);
  const need = BigInt(4 * (n + 1)); // ruimte genoeg dat de sleutels uit elkaar liggen, ook als `after` bijna tegen het einde zit
  let width = Math.max(len, 1);
  let start = 0n;
  let room = 0n;
  for (; ; width++) {
    start = 0n;
    if (after) for (const c of after) start = start * base + BigInt(idx(c));
    start *= base ** BigInt(width - len);
    room = base ** BigInt(width) - start;
    if (room > need) break;
  }
  const out = [];
  for (let i = 1; i <= n; i++) {
    let v = start + (room * BigInt(i)) / BigInt(n + 1);
    let digits = '';
    for (let d = 0; d < width; d++) {
      digits = DIGITS[Number(v % base)] + digits;
      v /= base;
    }
    out.push(digits.replace(/0+$/, ''));
  }
  return out;
}
