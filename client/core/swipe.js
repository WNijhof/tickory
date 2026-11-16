// De regels van de veegacties (ui/swipe.js): hoe ver je moet vegen en wat een veeg doet. Zonder scherm, zodat het te testen is.

const LIMIT = 120;

/** Hoe ver je moet vegen voordat loslaten de actie doet: een derde van de breedte, hooguit 120 pixels. */
export const swipeThreshold = (width) => Math.min(LIMIT, Math.round(width / 3));

/**
 * Wat een veeg van `dx` pixels doet (een negatieve dx is naar links): naar rechts afvinken, naar links een datum kiezen.
 * @returns {'complete' | 'schedule' | null}
 */
export function swipeAction(dx, width) {
  if (!(width > 0) || Math.abs(dx) < swipeThreshold(width)) return null;
  return dx > 0 ? 'complete' : 'schedule';
}
