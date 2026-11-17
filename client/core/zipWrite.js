// Een zip-bestand maken in de browser, zonder bibliotheken, voor de export (core/export.js, ui/exportDialog.js): elk project als
// CSV en de bijlagen zelf. Zonder compressie ("stored"): CSV's zijn klein en foto's en pdf's zijn al gecomprimeerd. Namen in UTF-8
// (vlag 11), dus ook "Café.csv" komt goed aan. Geen ZIP64: samen kleiner dan 4 GB en hooguit 65.535 bestanden; daarboven weigert
// `zipParts`. Te lezen met elk zip-programma, en met core/zip.js (de tests lezen elke zip daarmee terug).

import { crc32 } from './zip.js';

const enc = new TextEncoder();
export const ZIP_WRITE_MAX_BYTES = 0xfffffffe;
export const ZIP_WRITE_MAX_FILES = 0xffff;

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff;
const dosDate = (d) => (((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

/** Een naam voor in een zip of op een schijf: zonder tekens die Windows, macOS of Linux weigeren, niet leeg en niet te lang. */
export function safeFileName(name, fallback = '_') {
  const clean = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const short = [...clean].slice(0, 100).join('');
  return short && short !== '.' && short !== '..' ? short : fallback;
}

/** Een pad dat nog niet in `taken` staat: "naam (2).csv", "naam (3).csv", … (zonder op hoofdletters te letten, zoals Windows). */
export function uniquePath(taken, path) {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const [base, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
  let candidate = path;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base} (${i})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

const u16 = (view, at, v) => view.setUint16(at, v, true);
const u32 = (view, at, v) => view.setUint32(at, v >>> 0, true);

/**
 * De stukken van een zip (lokale kop en bytes per bestand, dan het centrale register), om er een Blob van te maken zonder alles
 * nog eens te kopiëren. `files`: `{ name, data }` met `data` als Uint8Array of tekst.
 * @returns {Uint8Array[]}
 */
export function zipParts(files, now = new Date()) {
  if (files.length > ZIP_WRITE_MAX_FILES) throw new Error('te veel bestanden voor één zip');
  const time = dosTime(now);
  const date = dosDate(now);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
    const name = enc.encode(file.name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50); u16(lv, 4, 20); u16(lv, 6, 0x0800); u16(lv, 8, 0); u16(lv, 10, time); u16(lv, 12, date);
    u32(lv, 14, crc); u32(lv, 18, data.length); u32(lv, 22, data.length); u16(lv, 26, name.length); u16(lv, 28, 0);
    local.set(name, 30);
    const head = new Uint8Array(46 + name.length);
    const cv = new DataView(head.buffer);
    u32(cv, 0, 0x02014b50); u16(cv, 4, 20); u16(cv, 6, 20); u16(cv, 8, 0x0800); u16(cv, 10, 0); u16(cv, 12, time); u16(cv, 14, date);
    u32(cv, 16, crc); u32(cv, 20, data.length); u32(cv, 24, data.length); u16(cv, 28, name.length); u16(cv, 30, 0); u16(cv, 32, 0);
    u16(cv, 34, 0); u16(cv, 36, 0); u32(cv, 38, 0); u32(cv, 42, offset);
    head.set(name, 46);
    parts.push(local, data);
    central.push(head);
    offset += local.length + data.length;
    if (offset > ZIP_WRITE_MAX_BYTES) throw new Error('te groot voor één zip (4 GB)');
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50); u16(ev, 4, 0); u16(ev, 6, 0); u16(ev, 8, files.length); u16(ev, 10, files.length);
  u32(ev, 12, size); u32(ev, 16, offset); u16(ev, 20, 0);
  return [...parts, ...central, end];
}

/** De hele zip als één Uint8Array (voor kleine zips en de tests). */
export function buildZip(files, now = new Date()) {
  const parts = zipParts(files, now);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
