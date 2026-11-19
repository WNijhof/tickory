// De regels van de veegacties (ui/swipe.js): hoe ver je moet vegen en wat een veeg doet. Zonder scherm, zodat het te testen is.

const LIMIT = 120;

/** Hoe ver je moet vegen voordat loslaten de actie doet: een derde van de breedte, hooguit 120 pixels. */
export const swipeThreshold = (width) => Math.min(LIMIT, Math.round(width / 3));

/** De standaard, zoals in Todoist: naar rechts afvinken, naar links een datum kiezen (Instellingen › Algemeen kan dat veranderen). */
export const SWIPE_DEFAULTS = Object.freeze({ right: 'complete', left: 'schedule' });

/** Wat een veeg in die richting doet volgens de instelling; 'none' (niets) en iets onbekends zijn null. */
export function swipeActionFor(dx, prefs = SWIPE_DEFAULTS) {
  const a = dx > 0 ? prefs.right : prefs.left;
  return a === 'select' || a === 'complete' || a === 'schedule' || a === 'reminders' || a === 'delete' ? a : null;
}

/**
 * Wat een veeg van `dx` pixels doet (een negatieve dx is naar links): standaard naar rechts afvinken, naar links een datum kiezen;
 * `prefs` ({ right, left }) kiest iets anders, of niets.
 * @returns {'complete' | 'schedule' | 'select' | 'reminders' | 'delete' | null}
 */
export function swipeAction(dx, width, prefs = SWIPE_DEFAULTS) {
  if (!(width > 0) || Math.abs(dx) < swipeThreshold(width)) return null;
  return swipeActionFor(dx, prefs);
}
