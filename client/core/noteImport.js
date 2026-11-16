// Notities importeren (SPEC 5k), zonder scherm: uit Google Keep (de zip van Google Takeout, of losse .json-bestanden) en uit
// Markdown (.md, .markdown, .txt; ook een zip met een map, zoals een Obsidian-kluis). Alles is invoer van buiten: de zip wordt
// gelezen met dezelfde strenge lezer als bij de import uit Todoist (core/zip.js), tekst wordt nooit als HTML gebruikt, en foto's
// en geluid alleen als hun type op de vaste lijst staat (shared/notes.js). De uitkomst is een lijst notities om te maken; het
// maken zelf (labels, notities, bestanden) doet ui/noteImportDialog.js met de gewone commando's.

import { looksLikeZip, readZip } from './zip.js';
import { decodeText } from './todoistImport.js';
import { fromMarkdown, toMarkdown } from './noteDoc.js';
import { NOTE_LIMITS } from '../../shared/schema.js';
import { MAX_FILES_PER_NOTE, isNoteFileMime } from '../../shared/notes.js';

export const NOTE_IMPORT_LIMITS = Object.freeze({
  /** Zoveel notities in één keer. */
  notes: 2000,
  /** Het zip-bestand (een export van Keep met foto's kan groot zijn) en wat eruit komt. */
  archiveBytes: 400 * 1024 * 1024,
  entries: 20000,
  files: 8000,
  fileBytes: 25 * 1024 * 1024,
  totalBytes: 400 * 1024 * 1024,
  /** Een losse tekst of json. */
  textBytes: 4 * 1024 * 1024,
});

/** De kleuren van Keep en de dichtstbijzijnde achtergrond van Tickory (grijs en standaard: geen). */
export const KEEP_COLORS = Object.freeze({
  RED: 'red', ORANGE: 'orange', YELLOW: 'yellow', GREEN: 'green', TEAL: 'teal', BLUE: 'blue', CERULEAN: 'indigo',
  DARK_BLUE: 'indigo', PURPLE: 'purple', PINK: 'pink', BROWN: 'brown', GRAY: null, GREY: null, DEFAULT: null, WHITE: null,
});

const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const AUDIO_EXT = { webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac' };
/** Het type bij een bestandsnaam, alleen voor wat bij een notitie kan; anders null. */
export function mediaTypeOf(name, declared = '') {
  const decl = String(declared).toLowerCase().split(';')[0].trim();
  if (isNoteFileMime(decl)) return decl;
  const ext = String(name).toLowerCase().split('.').pop();
  return IMAGE_EXT[ext] ?? AUDIO_EXT[ext] ?? null;
}

const baseName = (path) => String(path).split('/').pop();
const dirName = (path) => { const i = String(path).lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i + 1); };
const withoutExt = (name) => baseName(name).replace(/\.(md|markdown|txt|json)$/i, '');

/** Een pad binnen de zip, relatief aan `dir`, zonder `..` en `./`; null als het buiten de zip zou wijzen of geen pad is. */
function resolvePath(dir, ref) {
  let raw = String(ref).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) return null; // een adres (https:, data:) of absoluut pad
  try { raw = decodeURIComponent(raw); } catch { /* laat zoals het is */ }
  const parts = [];
  for (const p of `${dir}${raw}`.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.join('/');
}

const plainBlocks = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => ({ type: 'p', level: 0, runs: line ? [{ text: line }] : [] }));
/** Platte tekst (zoals Keep die geeft) als Markdown, zo dat geen enkel teken als opmaak wordt gelezen. */
export const plainToMarkdown = (text) => toMarkdown(plainBlocks(text));

/** Te lange tekst inkorten op een regelgrens; geeft [tekst, ingekort?]. */
function clip(content) {
  if (content.length <= NOTE_LIMITS.content) return [content, false];
  const cut = content.slice(0, NOTE_LIMITS.content);
  const nl = cut.lastIndexOf('\n');
  return [nl > NOTE_LIMITS.content * 0.8 ? cut.slice(0, nl) : cut, true];
}
const clipTitle = (title) => String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_LIMITS.title);
const cleanLabels = (list) => [...new Set(list.map((l) => String(l ?? '').replace(/[,\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean))].slice(0, 20);

/**
 * Een notitie uit Keep (één .json uit Takeout). `findFile(pad)` geeft de bytes van een bijlage in dezelfde map (of null).
 * @returns {{ note: object | null, reason?: string, warnings: string[] }}
 */
export function keepNote(json, findFile = () => null) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { note: null, reason: 'notKeep', warnings: [] };
  const isKeep = 'textContent' in json || 'listContent' in json || 'isTrashed' in json || 'userEditedTimestampUsec' in json;
  if (!isKeep) return { note: null, reason: 'notKeep', warnings: [] };
  if (json.isTrashed === true) return { note: null, reason: 'trashed', warnings: [] };
  const warnings = [];
  const blocks = [];
  if (Array.isArray(json.listContent) && json.listContent.length > 0) {
    for (const item of json.listContent.slice(0, 2000)) {
      if (!item || typeof item.text !== 'string') continue;
      // een regel van een lijstpunt kan meer regels bevatten: de eerste wordt het punt, de rest gewone tekst eronder
      const [first, ...rest] = item.text.replace(/\r\n?/g, '\n').split('\n');
      blocks.push({ type: 'check', level: 0, checked: item.isChecked === true, runs: first ? [{ text: first }] : [] });
      for (const line of rest) blocks.push({ type: 'p', level: 1, runs: line ? [{ text: line }] : [] });
    }
  }
  if (typeof json.textContent === 'string' && json.textContent !== '') {
    if (blocks.length) blocks.push({ type: 'p', level: 0, runs: [] });
    blocks.push(...plainBlocks(json.textContent));
  }
  // links die Keep bij de notitie bewaarde (alleen http en https)
  const links = (Array.isArray(json.annotations) ? json.annotations : [])
    .filter((a) => a && typeof a.url === 'string' && /^https?:\/\//i.test(a.url) && a.url.length <= 2000);
  if (links.length) {
    if (blocks.length) blocks.push({ type: 'p', level: 0, runs: [] });
    for (const a of links) blocks.push({ type: 'bullet', level: 0, runs: [{ text: (typeof a.title === 'string' && a.title.trim()) || a.url, link: a.url }] });
  }
  const [content, clipped] = clip(toMarkdown(blocks));
  if (clipped) warnings.push('tooLong');
  const files = [];
  for (const att of Array.isArray(json.attachments) ? json.attachments : []) {
    if (!att || typeof att.filePath !== 'string') continue;
    const mime = mediaTypeOf(att.filePath, att.mimetype);
    if (!mime) { warnings.push('fileType'); continue; }
    const bytes = findFile(att.filePath);
    if (!bytes) { warnings.push('fileMissing'); continue; }
    if (files.length >= MAX_FILES_PER_NOTE) { warnings.push('tooManyFiles'); break; }
    files.push({ name: baseName(att.filePath), mime, bytes });
  }
  return {
    note: {
      title: clipTitle(json.title),
      content,
      background: Object.hasOwn(KEEP_COLORS, String(json.color).toUpperCase()) ? KEEP_COLORS[String(json.color).toUpperCase()] : null,
      labels: cleanLabels((Array.isArray(json.labels) ? json.labels : []).map((l) => l?.name)),
      is_pinned: json.isPinned === true && json.isArchived !== true,
      is_archived: json.isArchived === true,
      files,
    },
    warnings,
  };
}

/** De eenvoudige YAML-kop van een Markdown-bestand (`---` … `---`): titel en tags; de rest laten we weg. */
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]{0,4000}?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { body: text, title: null, tags: [] };
  const lines = m[1].split(/\r?\n/);
  let title = null;
  const tags = [];
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(\w+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (key === 'title') title = value.replace(/^["']|["']$/g, '');
    if (key === 'tags' || key === 'labels') {
      if (value.startsWith('[')) tags.push(...value.replace(/^\[|\]$/g, '').split(','));
      else if (value) tags.push(...value.split(/[,\s]+/));
      else for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) tags.push(lines[j].replace(/^\s*-\s+/, ''));
    }
  }
  return { body: text.slice(m[0].length), title, tags: tags.map((t) => t.trim().replace(/^["'#]+|["']+$/g, '')) };
}

/**
 * Een notitie uit een Markdown-bestand. De titel: `title:` in de kop, anders een eerste regel `# …`, anders de bestandsnaam.
 * Afbeeldingen en geluid waarnaar de tekst verwijst (`![…](pad)` of `![[naam]]`, zoals Obsidian) en die in dezelfde zip zitten,
 * worden bestanden bij de notitie; die verwijzing verdwijnt dan uit de tekst.
 * @param {string} text
 * @param {string} path het pad (in de zip) of de naam van het bestand
 * @param {(path: string) => Uint8Array | null} [findFile] een bestand in de zip op pad
 * @param {(name: string) => string | null} [findByName] een pad in de zip bij alleen een naam (Obsidian)
 */
export function markdownNote(text, path, findFile = () => null, findByName = () => null) {
  const warnings = [];
  if (!String(text).trim()) return { note: null, reason: 'empty', warnings }; // een leeg bestand is geen notitie
  const fm = frontMatter(String(text).replace(/^﻿/, ''));
  let body = fm.body.replace(/\r\n?/g, '\n');
  let title = fm.title;
  if (!title) {
    const m = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/.exec(body);
    if (m) { title = m[1]; body = body.slice(m[0].length); } else title = withoutExt(path);
  }
  const files = [];
  const dir = dirName(path);
  const take = (ref) => {
    const full = resolvePath(dir, ref.split('|')[0]) ?? null;
    const at = full && findFile(full) ? full : findByName(baseName(ref.split('|')[0]));
    if (!at) return false;
    const mime = mediaTypeOf(at);
    if (!mime) return false;
    if (files.length >= MAX_FILES_PER_NOTE) { warnings.push('tooManyFiles'); return false; }
    if (!files.some((f) => f.path === at)) files.push({ name: baseName(at), mime, bytes: findFile(at), path: at });
    return true;
  };
  // ![tekst](pad) en ![[naam]]: een bestand dat er is, wordt een bijlage; de rest blijft staan zoals het was
  body = body.replace(/!\[[^\]\n]{0,300}\]\(([^)\s]{1,500})(?:\s+"[^"\n]*")?\)/g, (all, ref) => (take(ref) ? '' : all));
  body = body.replace(/!\[\[([^\]\n]{1,300})\]\]/g, (all, ref) => (take(ref) ? '' : all));
  body = body.replace(/^(?:[ \t]*\n)+/, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  // door het eigen model: zo staat er alleen opmaak die de editor kent
  const [content, clipped] = clip(toMarkdown(fromMarkdown(body)));
  if (clipped) warnings.push('tooLong');
  return { note: { title: clipTitle(title), content, background: null, labels: cleanLabels(fm.tags), is_pinned: false, is_archived: false, files: files.map(({ path: _p, ...f }) => f) }, warnings };
}

const isText = (name) => /\.(md|markdown|txt)$/i.test(name);
const isJson = (name) => /\.json$/i.test(name);

/**
 * Leest de gekozen bestanden. Wat niet te lezen is, of geen notitie, komt in `skipped` met een reden; de rest gaat door.
 * @param {{ name: string, bytes: Uint8Array }[]} inputs
 * @returns {Promise<{ notes: object[], skipped: { name: string, reason: string }[], warnings: { name: string, reason: string }[], source: 'keep' | 'markdown' | 'mixed' | null }>}
 */
export async function readNoteImport(inputs) {
  const notes = [];
  const skipped = [];
  const warnings = [];
  const kinds = new Set();
  const add = (name, result, kind) => {
    for (const w of result.warnings ?? []) warnings.push({ name, reason: w });
    if (!result.note) { skipped.push({ name, reason: result.reason ?? 'empty' }); return; }
    if (!result.note.title && !result.note.content && !result.note.files.length) { skipped.push({ name, reason: 'empty' }); return; }
    if (notes.length >= NOTE_IMPORT_LIMITS.notes) { skipped.push({ name, reason: 'tooMany' }); return; }
    kinds.add(kind);
    notes.push({ ...result.note, source: name });
  };
  const fromText = (name, bytes, findFile, findByName) => {
    if (bytes.length > NOTE_IMPORT_LIMITS.textBytes) { skipped.push({ name, reason: 'tooBig' }); return; }
    const text = decodeText(bytes);
    if (isJson(name)) {
      let json;
      try { json = JSON.parse(text); } catch { skipped.push({ name, reason: 'notKeep' }); return; }
      const dir = dirName(name);
      add(name, keepNote(json, (p) => findFile(resolvePath(dir, p) ?? '')), 'keep');
    } else {
      add(name, markdownNote(text, name, findFile, findByName), 'markdown');
    }
  };
  for (const input of inputs) {
    const name = String(input.name ?? '').slice(0, 300);
    const bytes = input.bytes;
    if (!(bytes instanceof Uint8Array)) { skipped.push({ name, reason: 'unreadable' }); continue; }
    if (looksLikeZip(bytes) || /\.zip$/i.test(name)) {
      const zip = await readZip(bytes, {
        accept: (path) => isText(path) || isJson(path) || mediaTypeOf(path) !== null,
        limits: NOTE_IMPORT_LIMITS,
      });
      if (!zip.ok) { skipped.push({ name, reason: `zip.${zip.code}` }); continue; }
      const byPath = new Map(zip.files.map((f) => [f.name, f.bytes]));
      const byName = new Map();
      for (const f of zip.files) if (!byName.has(baseName(f.name))) byName.set(baseName(f.name), f.name);
      const findFile = (p) => byPath.get(p) ?? null;
      const findByName = (n) => byName.get(n) ?? null;
      const texts = zip.files.filter((f) => isText(f.name) || isJson(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
      if (texts.length === 0) skipped.push({ name, reason: 'zip.noNotes' });
      // Keep zet in een Takeout ook "Labels.txt" naast de notities: een lijst labels, geen notitie
      for (const f of texts) if (!/(^|\/)Keep\/Labels\.txt$/i.test(f.name)) fromText(f.name, f.bytes, findFile, findByName);
    } else if (isText(name) || isJson(name)) {
      fromText(name, bytes, () => null, () => null);
    } else {
      skipped.push({ name, reason: 'notNotes' });
    }
  }
  const source = kinds.size === 0 ? null : kinds.size > 1 ? 'mixed' : [...kinds][0];
  return { notes, skipped, warnings, source };
}
