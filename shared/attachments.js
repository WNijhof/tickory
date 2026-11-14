// Bijlagen: wat server en client over bestandsnamen en bestandstypen afspreken.
//
// Een bestand wordt op de server nooit onder zijn eigen naam bewaard (de naam is alleen tekst bij de bijlage), dus een
// vreemde naam kan geen pad raken. De schone naam is er voor de gebruiker: in de lijst, in "Opslaan als" en in de
// Content-Disposition van een download. De server eist dat een naam al schoon is (`cleanFileName(naam) === naam`); de
// client maakt hem schoon voordat hij hem verstuurt, zodat wat optimistisch getoond wordt gelijk is aan wat de server bewaart.

/** Maximale lengte van een bestandsnaam, in tekens (code points). */
export const MAX_NAME_LENGTH = 200;
export const DEFAULT_NAME = 'bijlage';

// Stuurtekens, tekens die de leesrichting omdraaien (een bekende truc om ".exe" als ".txt" te laten lijken) en onzichtbare tekens.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/gu;
// Tekens die in een bestandsnaam op Windows of in een pad een rol spelen.
const PATH_CHARS = /[\\/:*?"<>|]/g;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const cut = (text, max) => [...text].slice(0, max).join('');

/**
 * Maakt een bestandsnaam schoon: Unicode-vorm NFC, geen stuur- of onzichtbare tekens, geen padtekens, geen punten of spaties
 * aan de rand, een lengte tot MAX_NAME_LENGTH (het deel achter de laatste punt blijft behouden) en nooit leeg. Herhaald
 * toepassen verandert niets meer.
 * @param {unknown} raw
 * @returns {string}
 */
export function cleanFileName(raw) {
  let name = typeof raw === 'string' ? raw.normalize('NFC') : '';
  name = name.replace(/[\t\n\r\f\v]+/g, ' ').replace(INVISIBLE, '').replace(PATH_CHARS, '_').replace(/\s+/gu, ' ').trim();
  name = name.replace(/^[.\s]+|[.\s]+$/gu, '');
  if (!name) return DEFAULT_NAME;
  if ([...name].length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && [...name].length - [...name.slice(0, dot)].length <= 17 ? name.slice(dot) : '';
    name = cut(name.slice(0, ext ? dot : name.length), MAX_NAME_LENGTH - [...ext].length) + ext;
    name = name.replace(/^[.\s]+|[.\s]+$/gu, '') || DEFAULT_NAME;
  }
  // "CON.txt" is op Windows een apparaat, ook met een uitgang: een streepje ervoor maakt er een gewone naam van
  if (WINDOWS_DEVICE.test(name.split('.')[0].trim())) name = `_${name}`;
  return name;
}

/** Een bestandsnaam is geldig als hij al schoon is. */
export const fileNameProblem = (v) => (typeof v === 'string' && cleanFileName(v) === v ? null : 'moet een schone bestandsnaam zijn (zie cleanFileName)');

export const DEFAULT_MIME = 'application/octet-stream';
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** Een bestandstype zoals de browser of de app het opgeeft, in kleine letters, zonder parameters; onbekend of vreemd wordt `application/octet-stream`. */
export function normalizeMime(raw) {
  if (typeof raw !== 'string') return DEFAULT_MIME;
  const base = raw.split(';')[0].trim().toLowerCase();
  return MIME_RE.test(base) ? base : DEFAULT_MIME;
}

/**
 * De typen die de server desnoods in de browser zelf laat tonen (inline): rasterafbeeldingen en pdf. Nooit svg, html of iets
 * anders dat scripts kan bevatten. De server controleert bovendien de eerste bytes van het bestand zelf.
 */
export const INLINE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];
export const isInlineMime = (mime) => INLINE_MIMES.includes(mime);
/** Afbeeldingen die de app als voorbeeld laat zien. */
export const isPreviewMime = (mime) => isInlineMime(mime) && mime.startsWith('image/');

/**
 * Het type van een bestand aan de hand van zijn eerste bytes, voor de typen uit INLINE_MIMES; anders null.
 * @param {Uint8Array} head de eerste bytes (minstens 12, of het hele bestand als het korter is)
 */
export function sniffMime(head) {
  const b = head;
  const at = (i, ...bytes) => bytes.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (b.length >= 5 && at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  return null;
}

/**
 * Het type dat de server bewaart: wat de eerste bytes zeggen gaat voor; een type uit INLINE_MIMES dat de bytes niet bevestigen
 * wordt `application/octet-stream` (een "afbeelding" die geen afbeelding is, wordt nooit als afbeelding getoond).
 */
export function effectiveMime(declared, head) {
  const sniffed = sniffMime(head);
  if (sniffed) return sniffed;
  const mime = normalizeMime(declared);
  return isInlineMime(mime) ? DEFAULT_MIME : mime;
}

/** De hoofdletters en kleine letters van een uitgang, voor een pictogram of een label ("pdf", "docx"); leeg als er geen is. */
export function extensionOf(name) {
  const dot = String(name).lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : '';
}

/** Een grootte voor mensen: "340 kB", "2,4 MB". `locale` is bijvoorbeeld "nl" of "en". */
export function formatBytes(bytes, locale = 'nl') {
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = Number(bytes) || 0;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) { value /= 1000; i += 1; }
  const digits = i === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value)} ${units[i]}`;
}
