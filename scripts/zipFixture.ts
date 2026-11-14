// Een kleine zip-schrijver voor tests (client/core/zip.test.js, client/core/todoistImport.test.js en scripts/e2e-import.ts):
// maakt zips met opgeslagen of "deflate"-bestanden, met of zonder data descriptor, en kan bewust iets verkeerd doen (een
// verkeerde CRC, een versleutelvlag, een naam met ..) om te zien dat de lezer dat weigert. Geen onderdeel van de app.

type Entry = {
  name: string;
  data: Uint8Array | string;
  method?: 0 | 8;
  /** Schrijf de grootte en CRC niet in de lokale kop maar in een data descriptor erachter (vlag 3), zoals streamende programma's. */
  descriptor?: boolean;
  /** Andere vlaggen erbij (bijvoorbeeld 1 = versleuteld). */
  flags?: number;
  /** Bewust een verkeerde CRC of grootte in het register. */
  crc?: number;
  size?: number;
  /** De naam als ruwe bytes (zonder UTF-8-vlag), voor oude zips. */
  rawName?: Uint8Array;
};

const enc = new TextEncoder();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Zet de stukken achter elkaar. */
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function header(size: number, fill: (v: DataView) => void): Uint8Array {
  const b = new Uint8Array(size);
  fill(new DataView(b.buffer));
  return b;
}

/**
 * Maakt een zip. `options.zip64Locator` zet een (lege) ZIP64-verwijzing voor het einde; `options.comment` een commentaar.
 */
export async function makeZip(entries: Entry[], options: { comment?: string; zip64Locator?: boolean } = {}): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const method = e.method ?? 8;
    const body = method === 8 ? await deflateRaw(raw) : raw;
    const name = e.rawName ?? enc.encode(e.name);
    const flags = (e.rawName ? 0 : 0x800) | (e.descriptor ? 0x8 : 0) | (e.flags ?? 0);
    const crc = e.crc ?? crc32(raw);
    const size = e.size ?? raw.length;
    const local = header(30, (v) => {
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, flags, true);
      v.setUint16(8, method, true);
      v.setUint32(14, e.descriptor ? 0 : crc, true);
      v.setUint32(18, e.descriptor ? 0 : body.length, true);
      v.setUint32(22, e.descriptor ? 0 : size, true);
      v.setUint16(26, name.length, true);
    });
    const descriptor = e.descriptor ? header(16, (v) => {
      v.setUint32(0, 0x08074b50, true);
      v.setUint32(4, crc, true);
      v.setUint32(8, body.length, true);
      v.setUint32(12, size, true);
    }) : new Uint8Array(0);
    parts.push(local, name, body, descriptor);
    central.push(header(46, (v) => {
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 0x031e, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, flags, true);
      v.setUint16(10, method, true);
      v.setUint32(16, crc, true);
      v.setUint32(20, body.length, true);
      v.setUint32(24, size, true);
      v.setUint16(28, name.length, true);
      v.setUint32(42, offset, true);
    }), name);
    offset += local.length + name.length + body.length + descriptor.length;
  }
  const cd = concat(central);
  const comment = enc.encode(options.comment ?? '');
  const locator = options.zip64Locator ? header(20, (v) => v.setUint32(0, 0x07064b50, true)) : new Uint8Array(0);
  const end = header(22, (v) => {
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, entries.length, true);
    v.setUint16(10, entries.length, true);
    v.setUint32(12, cd.length, true);
    v.setUint32(16, offset, true);
    v.setUint16(20, comment.length, true);
  });
  return concat([...parts, cd, locator, end, comment]);
}
