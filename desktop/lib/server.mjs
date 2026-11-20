// Het adres van je Tickory-server, zoals de Android-app het accepteert: https overal, http alleen in je eigen netwerk
// (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, of een naam op .local/.lan/.home.arpa). Zo gaat het token nooit onversleuteld het internet op.

const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./];

/** Is dit een adres in je eigen netwerk (waar http mag)? */
export function isLocalHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return true;
  if (PRIVATE.some((re) => re.test(h))) return true;
  return /\.(local|lan|home\.arpa|internal)$/.test(h) || (!h.includes('.') && !h.includes(':') && h.length > 0);
}

/**
 * Maakt van wat je typt een serveradres: "taken.voorbeeld.nl" wordt "https://taken.voorbeeld.nl", een pad of een slash aan het eind
 * verdwijnt. Geeft { origin } of { error } (een sleutel voor de tekst: 'empty', 'invalid', 'http').
 */
export function normalizeServer(input) {
  const text = String(input ?? '').trim();
  if (!text) return { error: 'empty' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'invalid' };
  if (url.username || url.password || !url.hostname) return { error: 'invalid' };
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) return { error: 'http' };
  return { origin: url.origin };
}

/** Hoort deze url bij de server (dezelfde origin)? Alleen die pagina's mogen in het venster; de rest gaat naar de browser. */
export function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
