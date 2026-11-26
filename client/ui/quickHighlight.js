// De herkende tekst gemarkeerd in een invoerveld van Taak toevoegen, zoals Todoist: bij "Tandarts morgen om 9 uur #Thuis p1" krijgen
// "morgen om 9 uur", "#Thuis" en "p1" een gekleurde achtergrond terwijl je typt. Een invoerveld kan zelf geen opmaak tonen; daarom staat
// er een spiegel achter (een element met dezelfde tekst in dezelfde letter, onzichtbaar op de markeringen na) en is het veld zelf
// doorzichtig. De stukken komen uit de herkenner (core/quickadd.js, parseQuickAddWithSpans), dus precies wat er ook echt herkend wordt.
// Gebruikt in het venster Taak toevoegen (ui/quickAdd.js) en de balk bovenaan de lijst (ui/app.js).

import { h } from './dom.js';

/** De stijl van het veld die de spiegel moet overnemen, zodat de letters precies over elkaar vallen. */
const COPY = ['font', 'letterSpacing', 'wordSpacing', 'padding', 'borderWidth', 'lineHeight', 'textIndent', 'textTransform'];

/**
 * Zet een spiegel achter `input` (in een nieuw omhulsel op de plek van het veld, of in `wrap` als die er al is).
 * @param {HTMLInputElement} input
 * @param {(text: string) => { start: number, end: number, kind: string }[]} getSpans de herkende stukken van de tekst
 * @returns {{ wrap: HTMLElement, paint: () => void }} `paint` tekent opnieuw (bijvoorbeeld als het project verandert)
 */
export function highlightInput(input, getSpans) {
  const mirror = h('div', { class: 'quick-mirror', 'aria-hidden': 'true' });
  const wrap = h('div', { class: 'quick-input-wrap' });
  if (input.parentNode) input.replaceWith(wrap);
  wrap.append(mirror, input);
  input.classList.add('quick-highlighted');
  let styled = false;

  const paint = () => {
    const text = input.value;
    let spans = [];
    try {
      spans = (getSpans(text) ?? []).filter((s) => s.start >= 0 && s.end <= text.length && s.end > s.start).sort((a, b) => a.start - b.start);
    } catch {
      spans = []; // de herkenner faalt nooit hard op tekst, maar een markering is het niet waard om het typen te hinderen
    }
    const nodes = [];
    let at = 0;
    for (const s of spans) {
      if (s.start < at) continue; // overlappend: het eerste stuk wint
      if (s.start > at) nodes.push(text.slice(at, s.start));
      nodes.push(h('mark', { class: `qh qh-${s.kind}` }, text.slice(s.start, s.end)));
      at = s.end;
    }
    if (at < text.length) nodes.push(text.slice(at));
    mirror.replaceChildren(...nodes);
    if (!styled && input.isConnected) {
      const cs = getComputedStyle(input);
      for (const key of COPY) mirror.style[key] = cs[key];
      styled = true;
    }
    mirror.scrollLeft = input.scrollLeft;
  };
  // het veld scrolt zijwaarts bij lange tekst (ook door de cursor te verplaatsen): de spiegel scrolt mee
  const follow = () => { mirror.scrollLeft = input.scrollLeft; };
  input.addEventListener('input', paint);
  for (const type of ['scroll', 'keyup', 'click', 'select', 'focus']) input.addEventListener(type, follow);
  queueMicrotask(paint);
  return { wrap, paint };
}
