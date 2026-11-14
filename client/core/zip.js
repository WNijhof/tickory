// Een zip-bestand lezen in de browser, zonder bibliotheken: het centrale register lezen en elk bestand uitpakken, "deflate" met
// de ingebouwde DecompressionStream('deflate-raw') (moderne browsers en Node 26). Bedoeld voor de back-up van Todoist (een zip
// met een CSV per project, zie core/todoistImport.js), en dus voor een bestand van buiten: onbetrouwbare invoer.
//
// Daarom streng en met harde grenzen:
// - alleen het centrale register telt (zoals elk zip-programma); een lokale kop moet erbij passen en de gegevens moeten vóór het
//   register liggen, zonder overlap (een bekende truc voor zip-bommen is één blok gegevens dat vele keren wordt gebruikt);
// - hooguit `entries` records, `files` uit te pakken bestanden, `fileBytes` per bestand en `totalBytes` samen, uitgepakt
//   geteld tijdens het uitpakken (niet alleen wat de zip zegt): een zip-bom stopt bij de grens in plaats van het geheugen te vullen;
// - de uitgepakte grootte en de CRC-32 moeten kloppen met het register; anders is het bestand kapot;
// - versleutelde zips (ook AES) en ZIP64 worden geweigerd, net als een zip over meerdere schijven;
// - een naam met `..`, een `/` of `\` vooraan, een stationsletter of stuurtekens wordt overgeslagen (er wordt nooit iets naar een
//   pad geschreven, maar zo'n naam wordt ook niet getoond of gebruikt); mappen en de rommel van macOS (`__MACOSX/`, `._x`) ook.
// Er wordt niets uitgevoerd en niets opgehaald: de uitkomst is een lijst van namen met bytes.

export const ZIP_LIMITS = Object.freeze({
  /** Grootte van het zip-bestand zelf. */
  archiveBytes: 64 * 1024 * 1024,
  /** Records in het centrale register (ook mappen en overgeslagen bestanden). */
  entries: 5000,
  /** Bestanden die worden uitgepakt. */
  files: 1000,
  /** Uitgepakt, per bestand en samen. */
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
});

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SLICE = 4096; // zoveel gecomprimeerde bytes per keer naar de uitpakker, zodat de grens tussendoor wordt bewaakt

/** Fout bij het lezen van het archief als geheel. */
const fail = (code, detail = '') => ({ ok: false, code, detail });

// ---------- CRC-32 (IEEE, zoals in zip) ----------

let crcTable = null;
/** @param {Uint8Array} bytes */
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- namen ----------

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('windows-1252');

function decodeName(bytes, isUtf8) {
  if (isUtf8) {
    try {
      return utf8.decode(bytes);
    } catch {
      return null;
    }
  }
  // zonder de UTF-8-vlag: eerst toch UTF-8 proberen (de meeste programma's schrijven dat), anders de oude West-Europese codering
  try {
    return utf8.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

/**
 * Is deze naam veilig om te gebruiken? Geen absolute paden, geen `..`, geen stationsletter, geen stuurtekens, niet leeg.
 * Een `\` telt als scheidingsteken (sommige Windows-programma's schrijven die).
 */
export function isSafeZipName(name) {
  if (typeof name !== 'string' || name === '' || name.length > 1024) return false;
  if (/[\u0000-\u001f\u007f]/u.test(name)) return false;
  const path = name.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').some((part) => part === '..');
}

/** Mappen en wat macOS erbij stopt: stil overslaan. */
const isNoise = (path) => path.endsWith('/') || /(^|\/)__MACOSX\//.test(path) || /(^|\/)\._[^/]*$/.test(path) || /(^|\/)\.DS_Store$/.test(path);

// ---------- uitpakken ----------

/**
 * Pakt "deflate" uit met de ingebouwde uitpakker, in kleine stukjes, en stopt zodra er meer uitkomt dan `max`.
 * @returns {Promise<Uint8Array | 'tooBig' | 'corrupt'>}
 */
async function inflate(data, max) {
  if (typeof DecompressionStream !== 'function') return 'corrupt';
  let stream;
  try {
    stream = new DecompressionStream('deflate-raw');
  } catch {
    return 'corrupt';
  }
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let stopped = false;
  const pump = (async () => {
    for (let i = 0; i < data.length && !stopped; i += SLICE) {
      await writer.ready;
      if (stopped) return;
      writer.write(data.subarray(i, i + SLICE)).catch(() => {});
    }
    if (!stopped) await writer.close();
  })().catch(() => {});
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        stopped = true;
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});
        return 'tooBig';
      }
      chunks.push(value);
    }
  } catch {
    stopped = true;
    writer.abort().catch(() => {});
    return 'corrupt';
  }
  await pump;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------- het archief ----------

/** Zoekt het einde van het centrale register (vanaf achteren, binnen het maximale commentaar van 65535 bytes). */
function findEnd(view, length) {
  const stop = Math.max(0, length - 22 - 0xffff);
  for (let i = length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) !== SIG_END) continue;
    const commentLength = view.getUint16(i + 20, true);
    if (i + 22 + commentLength <= length) return i;
  }
  return -1;
}

/**
 * Leest een zip-bestand.
 * @param {Uint8Array} bytes het hele bestand
 * @param {{ accept?: (name: string) => boolean, limits?: Partial<typeof ZIP_LIMITS> }} [options]
 *   `accept`: welke bestanden uitgepakt worden (op naam; de rest wordt overgeslagen zonder uit te pakken)
 * @returns {Promise<{ ok: true, files: { name: string, bytes: Uint8Array }[], skipped: { name: string, reason: 'unsafe' | 'type' | 'tooBig' | 'method' | 'tooMany' }[] }
 *   | { ok: false, code: 'notZip' | 'corrupt' | 'encrypted' | 'zip64' | 'tooMany' | 'tooBig', detail: string }>}
 */
export async function readZip(bytes, { accept = () => true, limits = {} } = {}) {
  const lim = { ...ZIP_LIMITS, ...limits };
  if (!(bytes instanceof Uint8Array)) return fail('notZip', 'geen bytes');
  if (bytes.length > lim.archiveBytes) return fail('tooBig', 'het zip-bestand is te groot');
  if (bytes.length < 22) return fail(bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b ? 'corrupt' : 'notZip', 'te kort');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(view, bytes.length);
  if (end < 0) return fail(bytes[0] === 0x50 && bytes[1] === 0x4b ? 'corrupt' : 'notZip', 'geen einde van het register (afgekapt?)');
  if (end >= 20 && view.getUint32(end - 20, true) === SIG_ZIP64_LOCATOR) return fail('zip64', 'ZIP64');
  const disk = view.getUint16(end + 4, true);
  const cdDisk = view.getUint16(end + 6, true);
  const entriesHere = view.getUint16(end + 8, true);
  const entries = view.getUint16(end + 10, true);
  const cdSize = view.getUint32(end + 12, true);
  const cdOffset = view.getUint32(end + 16, true);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return fail('zip64', 'ZIP64');
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries) return fail('corrupt', 'een zip over meerdere schijven');
  if (entries > lim.entries) return fail('tooMany', `meer dan ${lim.entries} records`);
  if (cdOffset + cdSize > end) return fail('corrupt', 'het register valt buiten het bestand');

  // het centrale register
  const records = [];
  let p = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > cdOffset + cdSize || view.getUint32(p, true) !== SIG_CENTRAL) return fail('corrupt', `record ${i + 1} van het register is onleesbaar`);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressed = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const next = p + 46 + nameLength + extraLength + commentLength;
    if (next > cdOffset + cdSize) return fail('corrupt', `record ${i + 1} loopt buiten het register`);
    if (compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) return fail('zip64', 'ZIP64');
    if (flags & 0x1 || method === 99) return fail('encrypted', 'versleuteld');
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLength), Boolean(flags & 0x800));
    records.push({ name, method, crc, compressed, size, offset });
    p = next;
  }

  // elk record moet naar een eigen lokale kop wijzen, met de gegevens vóór het register en zonder overlap
  const ranges = [];
  for (const r of records) {
    if (r.offset + 30 > cdOffset || view.getUint32(r.offset, true) !== SIG_LOCAL) return fail('corrupt', 'een lokale kop ontbreekt');
    if (view.getUint16(r.offset + 6, true) & 0x1) return fail('encrypted', 'versleuteld');
    r.start = r.offset + 30 + view.getUint16(r.offset + 26, true) + view.getUint16(r.offset + 28, true);
    if (r.start + r.compressed > cdOffset) return fail('corrupt', 'gegevens lopen buiten het bestand (afgekapt?)');
    ranges.push([r.offset, r.start + r.compressed]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) return fail('corrupt', 'bestanden overlappen');

  const files = [];
  const skipped = [];
  let total = 0;
  for (const r of records) {
    if (r.name === null || !isSafeZipName(r.name)) {
      skipped.push({ name: r.name === null ? '?' : r.name.replace(/[\u0000-\u001f\u007f]/gu, '?').slice(0, 200), reason: 'unsafe' });
      continue;
    }
    const path = r.name.replace(/\\/g, '/');
    if (isNoise(path)) continue;
    if (!accept(path)) {
      skipped.push({ name: path, reason: 'type' });
      continue;
    }
    if (files.length >= lim.files) {
      skipped.push({ name: path, reason: 'tooMany' });
      continue;
    }
    if (r.size > lim.fileBytes || total + r.size > lim.totalBytes) {
      skipped.push({ name: path, reason: 'tooBig' });
      continue;
    }
    const data = bytes.subarray(r.start, r.start + r.compressed);
    let out;
    if (r.method === 0) {
      if (r.compressed !== r.size) return fail('corrupt', `${path}: verkeerde grootte`);
      out = data.slice();
    } else if (r.method === 8) {
      out = await inflate(data, Math.min(r.size, lim.fileBytes, lim.totalBytes - total));
      if (out === 'tooBig') return fail('corrupt', `${path}: groter dan het register zegt`);
      if (out === 'corrupt') return fail('corrupt', `${path}: kan niet worden uitgepakt`);
    } else {
      skipped.push({ name: path, reason: 'method' });
      continue;
    }
    if (out.length !== r.size) return fail('corrupt', `${path}: verkeerde grootte`);
    if (crc32(out) !== r.crc) return fail('corrupt', `${path}: controlegetal klopt niet`);
    total += out.length;
    files.push({ name: path, bytes: out });
  }
  return { ok: true, files, skipped };
}

/** Begint dit met de handtekening van een zip ("PK\3\4", of "PK\5\6" bij een lege zip)? */
export const looksLikeZip = (bytes) => bytes instanceof Uint8Array && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
