// Tweestapsverificatie: tijdgebonden codes (TOTP, RFC 6238, op HOTP uit RFC 4226), herstelcodes en het versleutelen van het
// geheim. Zonder externe bibliotheken: alleen node:crypto.
//
// - Het geheim is 20 willekeurige bytes (160 bits, zoals RFC 4226 aanraadt), voor de app als base32 (RFC 4648) en als
//   otpauth://-adres. Codes: 6 cijfers, 30 seconden, HMAC-SHA1: wat elke authenticator-app kent.
// - Een code geldt in het huidige tijdvak en één tijdvak ervoor of erna (een klok die tot 30 seconden afwijkt). Een tijdvak
//   dat al eens is gebruikt, en elk eerder tijdvak, telt niet meer: dezelfde code twee keer gebruiken lukt dus niet.
// - Het geheim staat versleuteld in de database (AES-256-GCM, met het id van de gebruiker als extra gegevens, zodat een
//   geheim niet naar een andere rij te kopiëren is). De sleutel staat buiten de database, in een eigen bestand (zie main.ts):
//   een back-up van de database alleen geeft dus geen geheimen.
// - Herstelcodes: 10 stuks van 10 tekens (50 bits), eenmalig, opgeslagen als HMAC met een afgeleide sleutel van datzelfde
//   bestand. Zonder het sleutelbestand zijn ze uit een back-up niet terug te rekenen.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
/** Hoeveel tijdvakken voor en na het huidige ook gelden. */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

// ---------- base32 (RFC 4648, zonder opvulling) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Leest base32; spaties, streepjes, opvulling en kleine letters mogen. Geeft null bij een ongeldig teken. */
export function base32Decode(text: string): Buffer | null {
  const s = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------- HOTP en TOTP ----------

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** HOTP (RFC 4226): de code bij teller `counter`. */
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS, algorithm: TotpAlgorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Het tijdvak (de teller van TOTP) op tijdstip `ms`. */
export const stepAt = (ms: number, period = TOTP_PERIOD): number => Math.floor(ms / 1000 / period);

/** TOTP (RFC 6238): de code op tijdstip `ms`. */
export function totp(key: Uint8Array, ms: number, { digits = TOTP_DIGITS, period = TOTP_PERIOD, algorithm = 'sha1' as TotpAlgorithm } = {}): string {
  return hotp(key, stepAt(ms, period), digits, algorithm);
}

/** Een code zoals iemand hem intypt ("123 456"): alleen de cijfers, of null als het geen code van 6 cijfers is. */
export function cleanCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}

/**
 * Het tijdvak waarin `code` klopt, binnen het venster rond `ms`, en alleen als het later is dan `lastStep` (het laatst
 * gebruikte tijdvak). Geeft null als de code niet klopt of al gebruikt is.
 */
export function matchStep(key: Uint8Array, code: string, ms: number, lastStep: number | null): number | null {
  const now = stepAt(ms);
  const given = Buffer.from(code);
  let found: number | null = null;
  // Alle tijdvakken in het venster vergelijken (niet stoppen bij de eerste), in constante tijd per vergelijking.
  for (let step = now - TOTP_WINDOW; step <= now + TOTP_WINDOW; step++) {
    const expected = Buffer.from(hotp(key, step));
    if (expected.length === given.length && timingSafeEqual(expected, given) && (lastStep === null || step > lastStep) && found === null) found = step;
  }
  return found;
}

export const newSecret = (): Buffer => randomBytes(20);

/** Het adres dat een authenticator-app uit de QR-code leest (de opmaak van Google Authenticator, die alle apps kennen). */
export function otpauthUri(secret: Uint8Array, account: string, issuer = 'Tickory'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

// ---------- herstelcodes ----------

// Crockford-base32: geen i, l, o en u, dus geen verwarring tussen 1 en l of 0 en o bij het overtypen.
const RECOVERY_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Nieuwe herstelcodes, als "xxxxx-xxxxx". */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    let s = '';
    for (let i = 0; i < 10; i++) s += RECOVERY_ALPHABET[randomInt(32)];
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Een herstelcode zoals iemand hem intypt: kleine letters, zonder spaties en streepjes, i/l als 1 en o als 0. Null als het er geen kan zijn. */
export function cleanRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 40) return null;
  const s = input.toLowerCase().replace(/[\s-]/g, '').replace(/[il]/g, '1').replace(/o/g, '0');
  return s.length === 10 && [...s].every((c) => RECOVERY_ALPHABET.includes(c)) ? s : null;
}

// ---------- het geheim versleutelen ----------

export interface SecretBox {
  /** Versleutelt `plain` voor gebruiker `userId`. */
  seal(plain: Uint8Array, userId: string): string;
  /** Ontsleutelt; null als het niet lukt (andere sleutel, andere gebruiker, beschadigd). */
  open(sealed: string, userId: string): Buffer | null;
  /** De opgeslagen vorm van een (schoongemaakte) herstelcode. */
  codeHash(cleanCode: string, userId: string): string;
}

/** Maakt de versleuteling met een hoofdsleutel van 32 bytes; de sleutels voor versleutelen en voor herstelcodes zijn ervan afgeleid. */
export function createSecretBox(masterKey: Uint8Array): SecretBox {
  if (masterKey.length !== 32) throw new Error('de sleutel moet 32 bytes zijn');
  const encKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'tickory totp-geheim v1', 32));
  const macKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'tickory herstelcodes v1', 32));
  return {
    seal(plain, userId) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', encKey, iv);
      c.setAAD(Buffer.from(userId));
      const ct = Buffer.concat([c.update(plain), c.final()]);
      return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
    },
    open(sealed, userId) {
      const [v, iv, ct, tag] = sealed.split('.');
      if (v !== 'v1' || !iv || !ct || !tag) return null;
      try {
        const d = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
        d.setAAD(Buffer.from(userId));
        d.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
      } catch {
        return null;
      }
    },
    codeHash(code, userId) {
      return createHmac('sha256', macKey).update(`${userId}\n${code}`).digest('base64url');
    },
  };
}
