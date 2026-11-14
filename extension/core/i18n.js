// De teksten van de extensie staan in _locales/<taal>/messages.json (Nederlands en Engels; Nederlands is de standaard). De browser
// kiest de taal (chrome.i18n.getMessage); deze module zet ze in de pagina's en bootst getMessage na voor tests in node.

/** `msg(sleutel, invulwaarden)`: de tekst, of de sleutel zelf als hij ontbreekt (nooit een lege tekst). */
export const msgFrom = (getMessage) => (key, subs) => getMessage(key, subs) || key;

/**
 * Vult de teksten van een pagina in: `data-i18n` (de tekst), `data-i18n-placeholder`, `data-i18n-title` en `data-i18n-aria-label`.
 * Alleen als tekst, nooit als HTML.
 */
export function localize(root, msg) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = msg(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = msg(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', msg(el.dataset.i18nAriaLabel));
}

/**
 * getMessage zoals de browser hem doet, voor één messages.json: `$NAAM$` wordt de inhoud van de plaatshouder, en daarin `$1` … `$9`
 * de invulwaarden; `$$` is een dollarteken. Een onbekende sleutel geeft ''.
 */
export function messageFormatter(messages) {
  return (key, subs = []) => {
    const entry = Object.hasOwn(messages, key) ? messages[key] : null;
    if (!entry) return '';
    const list = Array.isArray(subs) ? subs : [subs];
    const fill = (text) => text.replace(/\$([1-9])/g, (_, n) => String(list[Number(n) - 1] ?? ''));
    const holders = Object.fromEntries(Object.entries(entry.placeholders ?? {}).map(([name, p]) => [name.toLowerCase(), fill(p.content)]));
    return entry.message.replace(/\$([A-Za-z0-9_@]+)\$|\$\$/g, (whole, name) => (name === undefined ? '$' : holders[name.toLowerCase()] ?? whole));
  };
}
