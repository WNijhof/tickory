// "Delen naar Tickory": tekst of een link uit een andere app (Android-deelmenu) wordt een voorgevuld venster "Taak toevoegen".
// De Android-app geeft de tekst als `#share=<base64url van JSON {title, text}>` (zie android/.../core/ShareLink.kt).
// Alles wat hier binnenkomt is tekst van een andere app en dus onbetrouwbaar: alleen tekst, nooit HTML, en met grenzen.
// Deelt de andere app ook bestanden, dan staan in hetzelfde JSON-object `token` en `files` ([{ name, mime, size }]): de inhoud van elk
// bestand haalt de pagina op bij `/__tickory_share/<token>/<nummer>`, dat de Android-app zelf beantwoordt (zie fetchSharedFiles).

import { cleanFileName, normalizeMime } from '../../shared/attachments.js';

const MAX_SHARED_FILES = 20;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const MAX_TITLE = 200; // een titel is een korte regel; wat langer is gaat naar de beschrijving
const MAX_DESCRIPTION = 16_000; // gelijk aan de grens van het veld

const clean = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : '');

/** Kapt af op een woordgrens (of anders hard), zonder een emoji (twee UTF-16-delen) doormidden te breken. */
function shorten(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * Titel en beschrijving voor een nieuwe taak uit gedeelde tekst. Met een onderwerp (de "titel" van de andere app, bijvoorbeeld
 * de paginatitel bij een gedeelde link) is dat de titel en de tekst (de link) de beschrijving. Zonder onderwerp is de eerste
 * regel de titel en de rest de beschrijving. Is de titel te lang voor een titel, dan wordt hij ingekort en gaat alles naar de beschrijving.
 * @param {{ title?: unknown, text?: unknown }} shared
 * @returns {{ title: string, description: string } | null} null als er niets bruikbaars is
 */
export function shareDraft(shared) {
  const subject = clean(shared?.title).replace(/\s*\n\s*/g, ' ');
  const text = clean(shared?.text);
  if (!subject && !text) return null;
  let title;
  let description;
  if (subject) {
    title = subject;
    description = text === subject ? '' : text;
  } else {
    const lines = text.split('\n');
    title = lines[0].trim();
    description = lines.slice(1).join('\n').trim();
  }
  if (title.length > MAX_TITLE) {
    description = description ? `${title}\n${description}` : title;
    title = shorten(title, MAX_TITLE);
  }
  return { title, description: description.slice(0, MAX_DESCRIPTION) };
}

/**
 * Leest `#share=…` uit het webadres. Geeft de voorgevulde taak terug, of null als het adres hier niet over gaat of niet te lezen is.
 * @param {string | null | undefined} hash
 */
export function shareFromHash(hash) {
  const m = /^#share=([A-Za-z0-9_-]{1,100000})$/.exec(hash ?? '');
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    const files = sharedFiles(data);
    const draft = shareDraft(data);
    if (files.length === 0) return draft;
    // Alleen bestanden: de titel is de naam van het eerste bestand (zonder uitgang), de gebruiker past hem nog aan.
    const first = files[0].name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
    return { title: draft?.title ?? first, description: draft?.description ?? '', files, token: data.token };
  } catch {
    return null;
  }
}

/**
 * De bestanden uit een deling, gecontroleerd: een geldig token, hooguit 20 bestanden, een schone naam en een bekend type.
 * Zonder geldig token of zonder bestanden is het resultaat leeg.
 * @returns {{ name: string, mime: string, size: number }[]}
 */
export function sharedFiles(data) {
  if (!TOKEN_RE.test(data?.token ?? '') || !Array.isArray(data.files)) return [];
  return data.files.slice(0, MAX_SHARED_FILES)
    .filter((f) => f && typeof f === 'object' && typeof f.name === 'string')
    .map((f) => ({ name: cleanFileName(f.name), mime: normalizeMime(f.mime), size: Number.isFinite(f.size) && f.size >= 0 ? Math.floor(f.size) : 0 }));
}

/**
 * Haalt de gedeelde bestanden op bij de Android-app en maakt er `File`-objecten van. Een bestand dat niet te halen is (verlopen,
 * niet in de app) wordt overgeslagen. `fetchFn` is voor tests.
 * @param {{ token: string, files: { name: string, mime: string, size: number }[] }} shared
 * @returns {Promise<File[]>}
 */
export async function fetchSharedFiles(shared, fetchFn = globalThis.fetch) {
  if (!TOKEN_RE.test(shared?.token ?? '')) return [];
  const out = [];
  for (const [index, meta] of shared.files.entries()) {
    try {
      const res = await fetchFn(`/__tickory_share/${shared.token}/${index}`, { cache: 'no-store' });
      if (!res.ok) continue;
      out.push(new File([await res.blob()], meta.name, { type: meta.mime }));
    } catch { /* dit bestand overslaan */ }
  }
  return out;
}
