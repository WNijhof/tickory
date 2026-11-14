// Grote foto's kleiner maken voordat ze worden geüpload (optioneel; een schakelaar in het taakvenster). Een foto van een telefoon is
// vaak 4 tot 8 MB; op 2048 pixels aan de lange kant is hij voor een bijlage ruim scherp genoeg en een tiende zo groot. Alleen
// JPEG, PNG en WebP; wat al klein genoeg is, of wat er niet kleiner van wordt, blijft zoals het is.

export const SHRINK_MAX_EDGE = 2048;
export const SHRINK_MIN_BYTES = 400_000;
const SHRINKABLE = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * @param {File} file
 * @param {{
 *   maxEdge?: number, quality?: number, minBytes?: number,
 *   decode?: (file: Blob) => Promise<{ width: number, height: number, close?: () => void }>,
 *   encode?: (bitmap: object, width: number, height: number, type: string, quality: number) => Promise<Blob | null>,
 * }} [options] `decode` en `encode` zijn de browser (createImageBitmap en een canvas); tests geven eigen versies mee.
 * @returns {Promise<File>} het verkleinde bestand, of het originele
 */
export async function shrinkImage(file, { maxEdge = SHRINK_MAX_EDGE, quality = 0.85, minBytes = SHRINK_MIN_BYTES, decode = browserDecode, encode = browserEncode } = {}) {
  if (!SHRINKABLE.includes(file.type) || file.size < minBytes) return file;
  let bitmap;
  try {
    bitmap = await decode(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) return file;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await encode(bitmap, width, height, type, quality);
    if (!blob || blob.size === 0 || blob.size >= file.size) return file;
    const name = file.type === 'image/webp' ? file.name.replace(/\.webp$/i, '.jpg') : file.name; // een webp wordt een jpeg
    return new File([blob], name, { type, lastModified: file.lastModified });
  } catch {
    return file; // kan het niet gedecodeerd of getekend worden, dan gaat het bestand onveranderd mee
  } finally {
    bitmap?.close?.();
  }
}

const browserDecode = (file) => createImageBitmap(file); // respecteert de draaiing uit de foto (EXIF)

function browserEncode(bitmap, width, height, type, quality) {
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
