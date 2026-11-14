// Het adres van de server zoals de gebruiker het typt, teruggebracht tot de oorsprong ("https://taken.example.nl" of
// "http://192.168.1.10:8787"), en de regel wanneer onversleuteld (http) mag. Dezelfde regels als de Android-app
// (android/.../core/ServerAddress.kt en LocalNetwork.kt): https altijd; http alleen naar het eigen netwerk of de computer zelf,
// omdat wachtwoord en sessietoken anders onversleuteld over internet gaan. Alleen de tekst telt: een extensie zoekt geen namen
// op (de Android-app kijkt ook nog wat een naam in DNS is; hier geldt een gewone domeinnaam altijd als internet).
// Zonder browser-API's, zodat het in node te testen is.

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PORT = /^[0-9]{1,5}$/;
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.home.arpa', '.localdomain', '.fritz.box'];

/**
 * Leest wat de gebruiker typte. Zonder "http(s)://" ervoor nemen we https aan. Pad, zoekdeel en fragment vervallen.
 * @param {unknown} input
 * @returns {{ ok: true, origin: string, host: string, https: boolean, schemeAssumed: boolean }
 *   | { ok: false, problem: 'EMPTY' | 'SCHEME' | 'CREDENTIALS' | 'INVALID' }}
 */
export function parseServer(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return { ok: false, problem: 'EMPTY' };
  const match = SCHEME.exec(text);
  let scheme;
  let rest;
  if (match) {
    scheme = match[1].toLowerCase();
    rest = text.slice(match[0].length);
  } else {
    // "ftp:host" of "javascript:…" is geen serveradres; "nas:8787" (een naam met poort) wel
    if (text.includes('://')) return { ok: false, problem: 'SCHEME' };
    scheme = 'https';
    rest = text;
  }
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, problem: 'SCHEME' };
  const authority = rest.split(/[/?#]/, 1)[0];
  if (authority.includes('@')) return { ok: false, problem: 'CREDENTIALS' };
  if (!authority) return { ok: false, problem: 'INVALID' };
  // spaties, stuurtekens en backslashes horen niet in een hostnaam (een browser leest "\" als "/")
  if (/[\s\u0000-\u001f\u007f\\]/u.test(authority)) return { ok: false, problem: 'INVALID' };

  let rawHost;
  let rawPort = null;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return { ok: false, problem: 'INVALID' };
    rawHost = authority.slice(0, end + 1);
    const tail = authority.slice(end + 1);
    if (tail) {
      if (!tail.startsWith(':')) return { ok: false, problem: 'INVALID' };
      rawPort = tail.slice(1);
    }
  } else {
    const colon = authority.indexOf(':');
    rawHost = colon >= 0 ? authority.slice(0, colon) : authority;
    if (colon >= 0) rawPort = authority.slice(colon + 1);
  }
  const host = normalizeHost(rawHost);
  if (!host) return { ok: false, problem: 'INVALID' };
  const https = scheme === 'https';
  let port = null;
  if (rawPort !== null) {
    if (!PORT.test(rawPort)) return { ok: false, problem: 'INVALID' };
    const n = Number(rawPort);
    if (n < 1 || n > 65535) return { ok: false, problem: 'INVALID' };
    if (n !== (https ? 443 : 80)) port = n;
  }
  return { ok: true, origin: `${scheme}://${host}${port ? `:${port}` : ''}`, host, https, schemeAssumed: !match };
}

/** Een naam in kleine letters (internationale namen als punycode), of een IPv6-adres tussen blokhaken in de vaste vorm; anders null. */
function normalizeHost(raw) {
  if (raw.startsWith('[')) {
    const inner = raw.slice(1, -1).toLowerCase();
    if (!/^[0-9a-f:.]{2,45}$/.test(inner) || !inner.includes(':') || !ipv6Bytes(inner)) return null;
    // de vorm die de browser zelf gebruikt (zo past de toestemming voor de host op het adres van de verzoeken)
    return new URL(`http://[${inner}]/`).hostname;
  }
  if (!raw || raw.includes(':')) return null;
  let ascii = raw.toLowerCase();
  if (/[^\x00-\x7f]/.test(raw)) {
    try {
      ascii = new URL(`http://${raw}/`).hostname; // internationale naam: punycode, zoals IDN.toASCII
    } catch {
      return null;
    }
  }
  const name = ascii.endsWith('.') ? ascii.slice(0, -1) : ascii;
  if (!name || name.length > 253) return null;
  return name.split('.').every((l) => LABEL.test(l)) ? name : null;
}

/** De 16 bytes van een IPv6-adres (zonder blokhaken; ook "::" en een IPv4-staart), of null. */
export function ipv6Bytes(text) {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part) => (part ? part.split(':') : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const words = [];
  const all = [...head, ...tail];
  // een IPv4-adres mag alleen het laatste stuk zijn
  const last = all[all.length - 1];
  let v4 = null;
  if (last !== undefined && last.includes('.')) {
    if (halves.length === 2 && tail.length === 0) return null; // "1.2.3.4::": het IPv4-deel staat niet aan het eind
    const m = IPV4.exec(last);
    if (!m || m.slice(1).some((p) => Number(p) > 255)) return null;
    v4 = m.slice(1).map(Number);
    (tail.length ? tail : head).pop();
  }
  for (const g of [...head, ...tail]) if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  const count = head.length + tail.length + (v4 ? 2 : 0);
  if (halves.length === 1 ? count !== 8 : count > 7) return null;
  words.push(...head.map((g) => parseInt(g, 16)));
  if (halves.length === 2) for (let i = count; i < 8; i++) words.push(0);
  words.push(...tail.map((g) => parseInt(g, 16)));
  const bytes = words.flatMap((w) => [w >> 8, w & 0xff]);
  if (v4) bytes.push(...v4);
  return bytes;
}

/**
 * Privé-adressen (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), de gedeelde adresruimte van providers en
 * VPN's (100.64/10) en unieke lokale IPv6-adressen (fc00::/7). Het eigen toestel (127.0.0.1, ::1) telt niet mee.
 * @param {number[]} b 4 of 16 bytes
 */
export function isLocalAddress(b) {
  if (b.length === 4) return isLocalV4(b[0], b[1]);
  if (b.length !== 16) return false;
  const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (mapped) return isLocalV4(b[12], b[13]);
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10
  return (b[0] & 0xfe) === 0xfc; // fc00::/7
}

function isLocalV4(a, b) {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Ligt deze host (zoals in het serveradres: naam, IPv4-adres of IPv6-adres tussen blokhaken) vrijwel zeker op het eigen netwerk?
 * Eén woord zonder punt ("nas", "raspberrypi") en namen op .local, .lan, .home, .internal, .home.arpa, .localdomain en .fritz.box
 * tellen mee; een gewone domeinnaam niet, ook als die thuis naar een lokaal adres wijst.
 */
export function hostLooksLocal(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[')) {
    const bytes = h.endsWith(']') ? ipv6Bytes(h.slice(1, -1)) : null;
    return bytes ? isLocalAddress(bytes) : false;
  }
  const v4 = IPV4.exec(h);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return false;
    return isLocalAddress(parts);
  }
  if (!h.includes('.')) return h !== 'localhost'; // één woord, zoals "nas"; localhost is de computer zelf (zie hieronder)
  return LOCAL_SUFFIXES.some((s) => h.endsWith(s));
}

/** Is de host de computer zelf (localhost, 127.x.x.x, ::1)? Verkeer daarheen verlaat de computer niet. */
export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h === '[::1]' || IPV4.exec(h)?.[1] === '127';
}

/** Mag de extensie met dit adres verbinden? Met https altijd, met http alleen op het eigen netwerk of de computer zelf. */
export const cleartextAllowed = (address) => address.https || hostLooksLocal(address.host) || isLoopbackHost(address.host);

/**
 * Het patroon voor de toestemming van de browser: precies deze host, met dit schema. Zonder poort, want Firefox kent geen poort in
 * een patroon (zonder poort geldt het voor elke poort van die host; Chrome doet hetzelfde).
 */
export const permissionPattern = (address) => `${address.https ? 'https' : 'http'}://${address.host}/*`;
