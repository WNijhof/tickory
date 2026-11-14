// Plaatsen voor herinneringen op een locatie: grenzen en rekenwerk dat server, web-app en tests delen.
// De Android-app rekent hetzelfde na in Kotlin (core/Geo.kt). Afstanden zijn in meters, hoeken in graden.

export const PLACE_RADIUS_MIN = 100;
export const PLACE_RADIUS_MAX = 5000;
export const PLACE_RADIUS_DEFAULT = 150;
/** De keuzes die de app aanbiedt voor de straal (meters). */
export const PLACE_RADIUS_PRESETS = [100, 150, 250, 500, 1000, 2000, 5000];

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg) => (deg * Math.PI) / 180;

/**
 * De afstand over het aardoppervlak tussen twee punten (haversine), in meters. Klopt ook vlak bij de polen en over de
 * datumgrens (180 graden), omdat alleen sinussen van verschillen worden gebruikt.
 */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Zijn dit geldige coordinaten? */
export const validCoordinates = (lat, lon) =>
  typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
  && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

const NUM = '[-+]?\\d{1,3}(?:[.,]\\d+)?';
const PAIR = new RegExp(`(${NUM})\\s*[,;\\s]\\s*(${NUM})`);
const FLOAT = '(-?\\d+(?:\\.\\d+)?)';

const num = (text) => Number(String(text).replace(',', '.'));

function pair(a, b) {
  const lat = num(a);
  const lon = num(b);
  return validCoordinates(lat, lon) ? { lat, lon } : null;
}

/**
 * Leest coordinaten uit wat een gebruiker plakt, zonder iets op te zoeken of aan te roepen:
 *   "52.0907, 5.1214"            twee getallen (komma of punt als decimaalteken)
 *   "geo:52.0907,5.1214"         een geo:-link, ook "geo:0,0?q=52.0907,5.1214(Naam)" en met ";u=20" of "?z=15"
 *   een kaartlink                .../@52.0907,5.1214,15z   ...!3d52.0907!4d5.1214   ...?q=52.0907,5.1214   ...?ll=...
 *                                openstreetmap: ...?mlat=52.0907&mlon=5.1214 of ...#map=16/52.0907/5.1214
 * Geeft { lat, lon } of null. Een adres of een plaatsnaam wordt niet opgezocht (dat zou een extern verzoek zijn).
 * @param {string} text
 * @returns {{ lat: number, lon: number } | null}
 */
export function parseCoordinates(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s || s.length > 2000) return null;
  let m;
  if (/^geo:/i.test(s)) {
    const body = s.slice(4);
    const q = /[?&]q=([^&]*)/i.exec(body);
    if (q) {
      let decoded = q[1].replace(/\+/g, ' ');
      try { decoded = decodeURIComponent(decoded); } catch { /* laat staan zoals het is */ }
      const inner = PAIR.exec(decoded);
      const found = inner && pair(inner[1], inner[2]);
      if (found && !(found.lat === 0 && found.lon === 0)) return found;
      return null; // "geo:0,0?q=adres" vraagt een kaartprogramma om een adres te zoeken; wij zoeken niets op
    }
    m = new RegExp(`^(${NUM})\\s*,\\s*(${NUM})`).exec(body);
    return m ? pair(m[1], m[2]) : null;
  }
  if (/^https?:\/\//i.test(s)) {
    if ((m = new RegExp(`!3d${FLOAT}!4d${FLOAT}`).exec(s))) return pair(m[1], m[2]);
    if ((m = new RegExp(`mlat=${FLOAT}&(?:amp;)?mlon=${FLOAT}`).exec(s))) return pair(m[1], m[2]);
    if ((m = new RegExp(`#map=\\d+/${FLOAT}/${FLOAT}`).exec(s))) return pair(m[1], m[2]);
    if ((m = new RegExp(`@${FLOAT},${FLOAT}`).exec(s))) return pair(m[1], m[2]);
    if ((m = new RegExp(`[?&](?:q|ll|query|center)=${FLOAT}(?:,|%2C)${FLOAT}`, 'i').exec(s))) return pair(m[1], m[2]);
    return null;
  }
  m = new RegExp(`^\\(?${PAIR.source}\\)?$`).exec(s);
  return m ? pair(m[1], m[2]) : null;
}

/** Een afstand als korte tekst: "85 m", "1,2 km" (met het decimaalteken dat je opgeeft, standaard een punt). */
export function formatDistance(meters, decimal = '.') {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${(km < 10 ? km.toFixed(1) : String(Math.round(km))).replace('.', decimal)} km`;
}
