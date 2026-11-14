// Verbinden met de eigen server, als gewone gegevens: het adres controleren (met dezelfde regel voor http als de Android-app),
// welke manieren van inloggen de server kent, de koppelcode uit de web-app lezen, en wat de extensie na het inloggen bewaart.
// Zonder browser-API's, zodat het in node te testen is (ook tegen een echte server, zie connect.test.js).

import { cleartextAllowed, parseServer, permissionPattern } from './address.js';

/**
 * Het adres controleren voordat de extensie iets vraagt of verstuurt.
 * @returns {{ ok: true, address: ReturnType<typeof parseServer> & { ok: true }, pattern: string } | { ok: false, code: string }}
 */
export function checkAddress(input) {
  const address = parseServer(input);
  if (!address.ok) return { ok: false, code: address.problem };
  // http naar een server op internet: wachtwoord en sessietoken zouden onversleuteld over de lijn gaan
  if (!cleartextAllowed(address)) return { ok: false, code: 'INSECURE' };
  return { ok: true, address, pattern: permissionPattern(address) };
}

/** Welke manieren van inloggen het venster toont: het wachtwoord (niet bij OIDC_ONLY) en altijd de koppelcode. */
export const loginOptions = (methods) => ({ password: methods?.password === true, pairCode: true, sso: typeof methods?.sso?.name === 'string' ? methods.sso.name : null });

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Een ingetypte of geplakte koppelcode in de vaste vorm (16 tekens Crockford-base32), of null. Zoals de server (server/pairing.ts):
 * spaties en streepjes tellen niet, kleine letters mogen, I en L zijn 1, O is 0. Zo ziet de gebruiker een tikfout meteen, zonder poging.
 */
export function pairCodeInput(text) {
  if (typeof text !== 'string' || text.length > 64) return null;
  const s = text.toUpperCase().replace(/[\s-]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return s.length === 16 && [...s].every((c) => ALPHABET.includes(c)) ? s.match(/.{4}/g).join('-') : null;
}

/** De naam van de extensie in de apparatenlijst van Tickory: "Browserextensie (Chrome)". */
export const deviceName = (browser, msg) => msg('deviceName', [browser]);

/** Welke browser dit is (voor de naam in de apparatenlijst); de server leest het soort zelf uit de verzoeken. */
export function browserName({ extensionUrl = '', userAgent = '' } = {}) {
  if (extensionUrl.startsWith('moz-extension:')) return 'Firefox';
  if (/\bEdg\//.test(userAgent)) return 'Edge';
  if (/\bOPR\//.test(userAgent)) return 'Opera';
  if (/\bVivaldi\//.test(userAgent)) return 'Vivaldi';
  return 'Chrome';
}

/**
 * Wat de extensie bewaart na een gelukte aanmelding (in chrome.storage.local, niet in sync: het token blijft op deze computer).
 * Gooit een fout met code NOT_TICKORY als het antwoord niet klopt.
 */
export function connectionFrom(result, address, browser) {
  if (typeof result?.token !== 'string' || !/^tky_[A-Za-z0-9_-]{20,200}$/.test(result.token) || typeof result.me?.id !== 'string') {
    throw Object.assign(new Error('NOT_TICKORY'), { code: 'NOT_TICKORY' });
  }
  return {
    origin: address.origin,
    pattern: permissionPattern(address),
    token: result.token,
    sessionId: typeof result.session_id === 'string' ? result.session_id : null,
    user: { id: result.me.id, username: String(result.me.username ?? ''), name: String(result.me.name ?? '') },
    browser,
  };
}
