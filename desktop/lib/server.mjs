// Het adres van je Tickory-server, zoals de Android-app het accepteert (core/LocalNetwork.kt): https overal, http alleen in je
// eigen netwerk. Lokaal is: het apparaat zelf (localhost, 127.x, ::1), een privé-adres (10.x, 172.16-31.x, 192.168.x), link-local
// (169.254.x, fe80::/10), de adresruimte van providers en VPN's zoals Tailscale (100.64.0.0/10), unieke lokale IPv6-adressen
// (fc00::/7), één woord zonder punt ("nas"), of een naam op .local, .lan, .home, .internal, .home.arpa, .localdomain of .fritz.box.
// De adresreeksen gelden alleen voor een letterlijk IP-adres: "10.taken.voorbeeld.nl" is een gewone naam op internet. Zo gaat het
// token nooit onversleuteld het internet op.

const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.home.arpa', '.localdomain', '.fritz.box'];
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const localV4 = (a, b) => a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);

/** Een IPv6-adres als 8 getallen van 16 bits, of null. URL schrijft een adres met IPv4 erin al als hexadecimaal (::ffff:c0a8:101). */
function ipv6Words(text) {
  if (!/^[0-9a-f:]+$/.test(text) || (text.match(/::/g) ?? []).length > 1) return null;
  const [left, right] = text.includes('::') ? text.split('::') : [text, null];
  const part = (x) => (x ? x.split(':') : []);
  const l = part(left);
  const r = right === null ? [] : part(right);
  const missing = 8 - l.length - r.length;
  if (right === null ? l.length !== 8 : missing < 1) return null;
  const all = [...l, ...Array(right === null ? 0 : missing).fill('0'), ...r];
  if (all.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  return all.map((w) => parseInt(w, 16));
}

/** Is dit een adres in je eigen netwerk (waar http mag)? */
export function isLocalHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v4 = IPV4.exec(h);
  if (v4) {
    const p = v4.slice(1).map(Number);
    return p.every((n) => n <= 255) && localV4(p[0], p[1]);
  }
  if (h.includes(':')) {
    const w = ipv6Words(h);
    if (!w) return false;
    if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
    if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return localV4(w[6] >> 8, w[6] & 0xff); // ::ffff:a.b.c.d
    return (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xfe00) === 0xfc00; // fe80::/10, fc00::/7
  }
  if (!h.includes('.')) return true; // één woord, zoals "nas" of "raspberrypi"
  return LOCAL_SUFFIXES.some((suffix) => h.endsWith(suffix));
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
