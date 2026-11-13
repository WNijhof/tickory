// De sneltoetsen voor zoeken: `/` (buiten invoervelden) en Ctrl+K of Cmd+K (overal). core/shortcuts.js laat deze toetsen bewust vrij.
// Dit bestand kent de pagina niet: `searchKey(event, opties)` krijgt een toetsaanslag en zegt of er gezocht moet worden.

import { isTyping } from './shortcuts.js';

/**
 * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean, target?: object, repeat?: boolean }} event
 * @param {{ blocked?: () => boolean }} [options]  `blocked`: true als een venster open staat; `/` doet dan niets (Ctrl+K wel: zoeken mag overal)
 * @returns {boolean} true als het zoekvenster geopend moet worden (de aanroeper roept dan preventDefault aan)
 */
export function searchKey(event, { blocked = () => false } = {}) {
  if (event.altKey || event.repeat) return false;
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  const chord = Boolean(event.ctrlKey || event.metaKey);
  if (chord) return key === 'k' && !event.shiftKey;
  return key === '/' && !isTyping(event.target) && !blocked();
}
