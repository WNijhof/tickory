// Web Push zonder afhankelijkheden: de server stuurt een melding naar de pushdienst van de browser (Google, Mozilla,
// Microsoft, Apple), en die bezorgt hem bij het apparaat, ook als de app dicht is.
//
// - VAPID (RFC 8292): de server bewijst met een handtekening dat het berichten van deze server zijn.
// - Versleuteling (RFC 8291, aes128gcm): alleen het apparaat kan de inhoud lezen, ook de pushdienst niet.
//
// Beveiliging: een apparaat meldt zelf het adres (endpoint) waar zijn berichten naartoe moeten. Dat adres mag nooit naar
// een willekeurige server wijzen, anders kan een aangemeld "apparaat" de server laten praten met je thuisnetwerk.
// Daarom staan alleen bekende pushdiensten toe (https, poort 443, geen IP-adressen), uit te breiden met PUSH_ALLOWED_HOSTS.

import { createECDH, createPrivateKey, createPublicKey, createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

// ---------- VAPID-sleutels ----------

export interface VapidKeys {
  /** Publieke sleutel: 65 bytes (ongecomprimeerd punt), base64url. Deze krijgt de browser bij het inschrijven. */
  publicKey: string;
  /** Privésleutel: PKCS#8 (DER), base64url. Geheim; staat alleen in de database van de server. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([0x04]), fromB64u(jwk.x as string), fromB64u(jwk.y as string)]);
  return { publicKey: b64u(raw), privateKey: b64u(privateKey.export({ format: 'der', type: 'pkcs8' })) };
}

/** De publieke sleutel (raw, 65 bytes) uit een privésleutel, om te controleren dat beide bij elkaar horen. */
export function publicKeyOf(privateKeyB64u: string): string {
  const jwk = createPublicKey(createPrivateKey({ key: fromB64u(privateKeyB64u), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  return b64u(Buffer.concat([Buffer.from([0x04]), fromB64u(jwk.x as string), fromB64u(jwk.y as string)]));
}

/** Een geldig VAPID-sleutelpaar: de publieke sleutel is 65 bytes en hoort bij de privésleutel. */
export function isValidVapid(keys: VapidKeys): boolean {
  try {
    return fromB64u(keys.publicKey).length === 65 && publicKeyOf(keys.privateKey) === keys.publicKey;
  } catch {
    return false;
  }
}

// ---------- VAPID-handtekening ----------

/** De waarde voor de Authorization-header (RFC 8292): "vapid t=<jwt>, k=<publieke sleutel>". */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs: number, lifetimeSeconds = 12 * 3600): string {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(nowMs / 1000) + Math.min(lifetimeSeconds, 24 * 3600); // meer dan 24 uur is niet toegestaan
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp, sub: subject })));
  const input = `${header}.${claims}`;
  const key: KeyObject = createPrivateKey({ key: fromB64u(keys.privateKey), format: 'der', type: 'pkcs8' });
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }); // r || s, zoals JWT het wil
  return `vapid t=${input}.${b64u(signature)}, k=${keys.publicKey}`;
}

// ---------- versleuteling (RFC 8291) ----------

export interface EncryptOptions {
  /** Alleen voor tests met vaste testwaarden: de privésleutel van de server (32 bytes) en de salt (16 bytes). */
  serverPrivateKey?: Buffer;
  salt?: Buffer;
  recordSize?: number;
}

/**
 * Versleutelt één bericht voor één apparaat. Resultaat: de volledige body van het verzoek aan de pushdienst
 * (kop met salt, recordgrootte en de publieke sleutel van de server, gevolgd door het versleutelde record).
 */
export function encryptPayload(plaintext: Uint8Array, uaPublic: Buffer, authSecret: Buffer, options: EncryptOptions = {}): Buffer {
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('publieke sleutel van het apparaat is ongeldig');
  if (authSecret.length !== 16) throw new Error('auth-geheim van het apparaat is ongeldig');
  const rs = options.recordSize ?? 4096;
  if (plaintext.length > rs - 16 - 1) throw new Error('bericht is te groot voor één record');

  const ecdh = createECDH('prime256v1');
  if (options.serverPrivateKey) ecdh.setPrivateKey(options.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // 65 bytes
  const secret = ecdh.computeSecret(uaPublic); // de gedeelde ECDH-uitkomst
  const salt = options.salt ?? randomBytes(16);

  // RFC 8291, hoofdstuk 3.3 en 3.4. hkdfSync(sha256, ikm, salt, info, lengte) is HKDF-Extract gevolgd door HKDF-Expand.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, record]);
}

// ---------- toegestane pushdiensten ----------

/** Eindigt de hostnaam op een van deze achtervoegsels, dan is het een bekende pushdienst. */
const KNOWN_PUSH_SUFFIXES = ['.googleapis.com', '.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];

export function isAllowedEndpoint(endpoint: string, extraSuffixes: string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || (u.port !== '' && u.port !== '443') || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (/^[0-9.]+$/.test(host) || host.includes(':') || host === 'localhost') return false; // geen IP-adressen
  return [...KNOWN_PUSH_SUFFIXES, ...extraSuffixes.map((s) => (s.startsWith('.') ? s : `.${s}`).toLowerCase())].some((s) => host.endsWith(s));
}

// ---------- verzenden ----------

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface SendOptions {
  vapid: VapidKeys;
  /** mailto: of https-adres van wie deze server beheert; sommige pushdiensten (Apple) eisen een geldige waarde. */
  subject: string;
  /** Hoe lang de pushdienst het bericht mag bewaren als het apparaat onbereikbaar is. */
  ttlSeconds?: number;
  /** "high" doorbreekt de Doze-stand van Android; voor herinneringen is dat precies de bedoeling. */
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Een nieuw bericht met hetzelfde onderwerp vervangt een nog niet bezorgd oud bericht (max 32 tekens, base64url). */
  topic?: string;
  extraAllowedHosts?: string[];
  now?: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  /** Het apparaat bestaat niet meer (404/410): het abonnement kan worden weggegooid. */
  gone: boolean;
  /** Later opnieuw proberen heeft zin (netwerkfout, 429, 5xx). */
  retryable: boolean;
  retryAfterSeconds?: number;
  error?: string;
}

export async function sendWebPush(sub: PushSubscriptionData, payload: string | Uint8Array, options: SendOptions): Promise<SendResult> {
  if (!isAllowedEndpoint(sub.endpoint, options.extraAllowedHosts)) {
    return { ok: false, status: null, gone: false, retryable: false, error: 'adres van de pushdienst is niet toegestaan' };
  }
  let body: Buffer;
  try {
    const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    body = encryptPayload(bytes, fromB64u(sub.keys.p256dh), fromB64u(sub.keys.auth));
  } catch (err) {
    return { ok: false, status: null, gone: false, retryable: false, error: (err as Error).message };
  }
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization(sub.endpoint, options.vapid, options.subject, (options.now ?? Date.now)()),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(options.ttlSeconds ?? 3600),
    Urgency: options.urgency ?? 'high',
  };
  if (options.topic) headers.Topic = options.topic.slice(0, 32);
  try {
    const res = await (options.fetch ?? fetch)(sub.endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
    await res.arrayBuffer().catch(() => undefined); // antwoord leegmaken zodat de verbinding vrijkomt
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, gone: false, retryable: false };
    if (res.status === 404 || res.status === 410) return { ok: false, status: res.status, gone: true, retryable: false, error: 'apparaat bestaat niet meer' };
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryable = res.status === 429 || res.status >= 500;
    return {
      ok: false, status: res.status, gone: false, retryable,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      error: `pushdienst antwoordde met ${res.status}`,
    };
  } catch (err) {
    return { ok: false, status: null, gone: false, retryable: true, error: `geen verbinding met de pushdienst: ${(err as Error).message}` };
  }
}
