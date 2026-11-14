// Plaatsen en de status van de locatiecontrole, als gewone gegevens (de schermen staan in ui/placesUi.js).
// De positie van de gebruiker komt hier niet in voor: die blijft op het toestel (Android-app) en gaat nooit naar de server.

import { PLACE_RADIUS_MAX, PLACE_RADIUS_MIN, validCoordinates } from '../../shared/places.js';
import { normalizeText } from '../../shared/text.js';
import { placeList } from './selectors.js';

/**
 * Wat de Android-app over de locatiecontrole meldt (`window.TickoryAndroid.locationStatus()`, als JSON-tekst).
 * @typedef {{
 *   enabled: boolean,          // de gebruiker heeft de locatiecontrole aangezet
 *   precise: boolean,          // nauwkeurige locatie toegestaan
 *   approximate: boolean,      // alleen bij benadering toegestaan (te grof voor een straal van enkele honderden meters)
 *   background: boolean,       // "altijd toestaan" (ook als de app dicht is)
 *   servicesOn: boolean,       // locatie staat aan op het toestel
 *   running: boolean,          // de controle draait nu
 *   needed: boolean,           // er is minstens één actieve locatieherinnering
 *   declined?: boolean,        // de gebruiker heeft de vraag eerder geweigerd
 *   hasGps?: boolean,
 *   lastCheckAt?: number,      // milliseconden sinds 1970, 0 = nog niet gecontroleerd
 *   lastFixAt?: number,
 *   accuracy?: number | null,  // meters
 *   places?: { id: string, name: string, distance: number | null, inside: boolean | null }[],
 * }} LocationStatus
 */

/**
 * Wat er nog nodig is om locatieherinneringen te laten werken, in volgorde van belang. Eén van:
 *   'off'          de gebruiker heeft de locatiecontrole nog niet aangezet
 *   'services'     locatie staat uit op het toestel
 *   'permission'   geen toestemming (of alleen bij benadering)
 *   'background'   wel toestemming, maar niet "altijd": de controle werkt alleen als de app open staat
 *   'ok'           alles staat goed
 * @param {LocationStatus | null} status
 */
export function locationAdvice(status) {
  if (!status) return 'off';
  if (!status.enabled) return 'off';
  if (!status.servicesOn) return 'services';
  if (!status.precise) return 'permission';
  if (!status.background) return 'background';
  return 'ok';
}

/** Een veld van een plaats controleren vóór het versturen. Geeft een sleutel voor de foutmelding of null. */
export function placeProblem({ name, lat, lon, radius }) {
  if (!normalizeText(String(name ?? '')).trim()) return 'name';
  if (!validCoordinates(lat, lon)) return 'coordinates';
  if (!Number.isInteger(radius) || radius < PLACE_RADIUS_MIN || radius > PLACE_RADIUS_MAX) return 'radius';
  return null;
}

/** "52.09070, 5.12140": vijf decimalen is ruim een meter nauwkeurig. */
export const formatCoordinates = (lat, lon) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

/** Afronden op vijf decimalen (een meter), zodat een plaats niet onnodig precies wordt opgeslagen. */
export const roundCoordinate = (value) => Math.round(value * 1e5) / 1e5;

/** Hoeveel eigen herinneringen er aan een plaats hangen (voor de vraag voor het verwijderen). */
export function remindersAtPlace(view, placeId, userId) {
  let n = 0;
  for (const r of view.reminders.values()) if (r.place_id === placeId && (!r.owner_id || !userId || r.owner_id === userId)) n += 1;
  return n;
}

/** De plaatsen met, als de app die kent, de afstand en of je er nu binnen bent. */
export function placeRows(view, userId, status) {
  const known = new Map((status?.places ?? []).map((p) => [p.id, p]));
  return placeList(view, userId).map((place) => ({ place, distance: known.get(place.id)?.distance ?? null, inside: known.get(place.id)?.inside ?? null }));
}

// ---------- de huidige positie, alleen na een tik van de gebruiker ----------

export class PositionError extends Error {
  /** @param {'denied' | 'unavailable' | 'timeout' | 'unsupported'} code */
  constructor(code) {
    super(code);
    this.name = 'PositionError';
    this.code = code;
  }
}

/**
 * Vraagt één keer de positie van dit toestel, om er een plaats van te maken. In de Android-app loopt dat via de app zelf
 * (de WebView heeft geen eigen locatie: ze staat bewust uit), in een browser via `navigator.geolocation`. De positie komt
 * alleen in het formulier terecht; pas als de gebruiker de plaats opslaat, gaat die als gewone plaats naar de server.
 * @param {{ bridge?: { available: boolean, requestCurrentPosition?: () => void }, geolocation?: Geolocation, win?: EventTarget, timeoutMs?: number }} [options]
 * @returns {Promise<{ lat: number, lon: number, accuracy: number | null }>}
 */
export function currentPosition({ bridge, geolocation = globalThis.navigator?.geolocation, win = globalThis.window, timeoutMs = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (bridge?.available) {
      let timer = null;
      const done = (event) => {
        win.removeEventListener('tickory-position', done);
        clearTimeout(timer);
        const d = event?.detail ?? {};
        if (validCoordinates(d.lat, d.lon)) resolve({ lat: d.lat, lon: d.lon, accuracy: Number.isFinite(d.accuracy) ? d.accuracy : null });
        else reject(new PositionError(['denied', 'unavailable', 'timeout'].includes(d.error) ? d.error : 'unavailable'));
      };
      win.addEventListener('tickory-position', done);
      timer = setTimeout(() => { win.removeEventListener('tickory-position', done); reject(new PositionError('timeout')); }, timeoutMs);
      if (typeof bridge.requestCurrentPosition === 'function') bridge.requestCurrentPosition();
      return;
    }
    if (!geolocation) {
      reject(new PositionError('unsupported'));
      return;
    }
    geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null }),
      (e) => reject(new PositionError(e?.code === 1 ? 'denied' : e?.code === 3 ? 'timeout' : 'unavailable')),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}
