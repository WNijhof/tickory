// Tekst van een opmerking in stukken: gewone tekst en webadressen. De interface maakt van een webadres een gewone
// tekstlink (een <a> met tekst); er gaat nooit tekst van een gebruiker als HTML het document in.

const URL_RE = /https?:\/\/(?!\/)[^\s<>"'`]+/giu; // direct na // volgt de computernaam (niet nog een /)
const TRAILING = /[.,;:!?'"»”’…]+$/u;
const PAIRS = { ')': '(', ']': '[', '}': '{' };

/** Haalt leestekens aan het eind van een webadres eraf ("zie https://a.nl/b." → zonder punt), haakjes alleen als ze niet in paren staan. */
function trimUrl(raw) {
  let url = raw;
  for (let again = true; again;) {
    again = false;
    const plain = url.replace(TRAILING, '');
    if (plain !== url) {
      url = plain;
      again = true;
    }
    const last = url.at(-1);
    if (last && PAIRS[last]) {
      const open = [...url].filter((c) => c === PAIRS[last]).length;
      const close = [...url].filter((c) => c === last).length;
      if (close > open) {
        url = url.slice(0, -1);
        again = true;
      }
    }
  }
  return url;
}

/**
 * @param {string} text
 * @returns {({ text: string } | { text: string, href: string })[]} stukken in volgorde; wie ze achter elkaar zet, krijgt de oorspronkelijke tekst terug
 */
export function linkify(text) {
  const out = [];
  let last = 0;
  const source = String(text ?? '');
  for (const m of source.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    // Alleen http en https komen hier: de zoekpatroon hierboven laat niets anders door (geen javascript:, data: of file:).
    let href = null;
    try {
      href = new URL(url).href;
    } catch { /* geen geldig adres: gewone tekst */ }
    if (!href) continue;
    if (m.index > last) out.push({ text: source.slice(last, m.index) });
    out.push({ text: url, href });
    last = m.index + url.length;
  }
  if (last < source.length) out.push({ text: source.slice(last) });
  return out;
}
