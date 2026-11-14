// "Delen naar Tickory": tekst of een link uit een andere app (Android-deelmenu) wordt een voorgevuld venster "Taak toevoegen".
// De Android-app geeft de tekst als `#share=<base64url van JSON {title, text}>` (zie android/.../core/ShareLink.kt).
// Alles wat hier binnenkomt is tekst van een andere app en dus onbetrouwbaar: alleen tekst, nooit HTML, en met grenzen.

const MAX_TITLE = 200; // een titel is een korte regel; wat langer is gaat naar de beschrijving
const MAX_DESCRIPTION = 16_000; // gelijk aan de grens van het veld

const clean = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : '');

/** Kapt af op een woordgrens (of anders hard), zonder een emoji (twee UTF-16-delen) doormidden te breken. */
function shorten(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * Titel en beschrijving voor een nieuwe taak uit gedeelde tekst. Met een onderwerp (de "titel" van de andere app, bijvoorbeeld
 * de paginatitel bij een gedeelde link) is dat de titel en de tekst (de link) de beschrijving. Zonder onderwerp is de eerste
 * regel de titel en de rest de beschrijving. Is de titel te lang voor een titel, dan wordt hij ingekort en gaat alles naar de beschrijving.
 * @param {{ title?: unknown, text?: unknown }} shared
 * @returns {{ title: string, description: string } | null} null als er niets bruikbaars is
 */
export function shareDraft(shared) {
  const subject = clean(shared?.title).replace(/\s*\n\s*/g, ' ');
  const text = clean(shared?.text);
  if (!subject && !text) return null;
  let title;
  let description;
  if (subject) {
    title = subject;
    description = text === subject ? '' : text;
  } else {
    const lines = text.split('\n');
    title = lines[0].trim();
    description = lines.slice(1).join('\n').trim();
  }
  if (title.length > MAX_TITLE) {
    description = description ? `${title}\n${description}` : title;
    title = shorten(title, MAX_TITLE);
  }
  return { title, description: description.slice(0, MAX_DESCRIPTION) };
}

/**
 * Leest `#share=…` uit het webadres. Geeft de voorgevulde taak terug, of null als het adres hier niet over gaat of niet te lezen is.
 * @param {string | null | undefined} hash
 */
export function shareFromHash(hash) {
  const m = /^#share=([A-Za-z0-9_-]{1,100000})$/.exec(hash ?? '');
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    return shareDraft(data);
  } catch {
    return null;
  }
}
