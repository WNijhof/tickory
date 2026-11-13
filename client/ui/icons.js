// Eigen pictogrammen als inline SVG (geen bestanden, geen lettertype). Elk pictogram is een lijntekening op een raster van
// 24 bij 24 in de kleur van de omringende tekst (currentColor). De pictogrammen zijn decoratief: de knop of regel eromheen
// heeft de tekst voor schermlezers.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Per pictogram: de tekenopdrachten. `d` is een pad, `dot` een gevuld bolletje [x, y, straal], `rect` een rechthoek [x, y, b, h, r]. */
const SHAPES = {
  plus: [{ d: 'M12 5v14M5 12h14' }],
  chevronLeft: [{ d: 'M15 6l-6 6 6 6' }],
  chevronRight: [{ d: 'M9 6l6 6-6 6' }],
  chevronDown: [{ d: 'M6 9l6 6 6-6' }],
  check: [{ d: 'M5 12.5l4.5 4.5L19 7.5' }],
  close: [{ d: 'M6 6l12 12M18 6L6 18' }],
  menu: [{ d: 'M4 6h16M4 12h16M4 18h16' }],
  more: [{ dot: [5, 12, 1.6] }, { dot: [12, 12, 1.6] }, { dot: [19, 12, 1.6] }],
  inbox: [{ d: 'M4 13l2.4-7h11.2L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5z' }, { d: 'M4 13h4.6l1 2h4.8l1-2H20' }],
  today: [{ rect: [4, 5, 16, 15, 3] }, { d: 'M4 10h16M8 3v4M16 3v4' }, { dot: [12, 15, 1.7] }],
  upcoming: [{ rect: [4, 5, 16, 15, 3] }, { d: 'M4 10h16M8 3v4M16 3v4' }, { dot: [8.5, 14.5, 1.1] }, { dot: [12, 14.5, 1.1] }, { dot: [15.5, 14.5, 1.1] }, { dot: [8.5, 17.5, 1.1] }, { dot: [12, 17.5, 1.1] }],
  calendar: [{ rect: [4, 5, 16, 15, 3] }, { d: 'M4 10h16M8 3v4M16 3v4' }],
  comment: [{ d: 'M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z' }],
  subtasks: [{ d: 'M10 6h10M10 12h10M10 18h10' }, { dot: [5, 6, 1.4] }, { dot: [5, 12, 1.4] }, { dot: [5, 18, 1.4] }],
  pencil: [{ d: 'M4 20h4L19 9l-4-4L4 16v4z' }, { d: 'M13.5 6.5l4 4' }],
  trash: [{ d: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12' }, { d: 'M10 11v5M14 11v5' }],
  users: [{ dot: [9, 8, 3], stroke: true }, { d: 'M3.5 19a5.5 5.5 0 0 1 11 0' }, { dot: [17, 9, 2.4], stroke: true }, { d: 'M15.5 14.2a5 5 0 0 1 5 4.8' }],
  star: [{ d: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z' }],
  search: [{ dot: [11, 11, 6.5], stroke: true }, { d: 'M16 16l4.5 4.5' }],
  tag: [{ d: 'M3.5 12.6V5.2a1.7 1.7 0 0 1 1.7-1.7h7.4l8 8a1.7 1.7 0 0 1 0 2.4l-6.5 6.5a1.7 1.7 0 0 1-2.4 0z' }, { dot: [8.2, 8.2, 1.3] }],
  funnel: [{ d: 'M4 5h16l-6 7.2V19l-4 1.5v-8.3z' }],
  help: [{ dot: [12, 12, 9], stroke: true }, { d: 'M9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.2.9-1.2 1.7M12 16.8h.01' }],
  archive: [{ rect: [3, 4, 18, 4, 1] }, { d: 'M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4' }],
  repeat: [{ d: 'M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4' }],
  keyboard: [{ rect: [2.5, 6, 19, 12, 2.5] }, { d: 'M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9' }],
  list: [{ d: 'M10 6h10M10 12h10M10 18h10' }, { dot: [5, 6, 1.4] }, { dot: [5, 12, 1.4] }, { dot: [5, 18, 1.4] }],
  board: [{ rect: [3, 4, 5, 16, 1.4] }, { rect: [9.5, 4, 5, 10, 1.4] }, { rect: [16, 4, 5, 13, 1.4] }],
  move: [{ d: 'M5 12h13M13 6.5l5.5 5.5-5.5 5.5' }],
  settings: [{ d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }, { dot: [15, 7, 2], stroke: true }, { dot: [9, 17, 2], stroke: true }],
};

const cache = new Map();

function build(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon icon-${name}`);
  for (const shape of SHAPES[name] ?? []) {
    let el;
    if (shape.d) {
      el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', shape.d);
    } else if (shape.rect) {
      const [x, y, w, h, r] = shape.rect;
      el = document.createElementNS(SVG_NS, 'rect');
      for (const [k, v] of Object.entries({ x, y, width: w, height: h, rx: r })) el.setAttribute(k, String(v));
    } else if (shape.dot) {
      const [cx, cy, r] = shape.dot;
      el = document.createElementNS(SVG_NS, 'circle');
      for (const [k, v] of Object.entries({ cx, cy, r })) el.setAttribute(k, String(v));
      if (!shape.stroke) el.setAttribute('class', 'icon-fill');
    }
    svg.append(el);
  }
  return svg;
}

/** Een nieuw pictogram met deze naam (zie SHAPES); een onbekende naam geeft een leeg pictogram. */
export function icon(name) {
  if (!cache.has(name)) cache.set(name, build(name));
  return cache.get(name).cloneNode(true);
}

/** De namen van alle pictogrammen (voor de test). */
export const ICON_NAMES = Object.keys(SHAPES);

/** De tekening bij een lege lijst: een kaartje met drie regels, waarvan er twee zijn afgevinkt. Decoratief. */
export function emptyArt() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 96');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'empty-art');
  const add = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  };
  add('rect', { x: 18, y: 10, width: 84, height: 76, rx: 12, class: 'art-card' });
  for (const [i, y] of [28, 48, 68].entries()) {
    add('circle', { cx: 36, cy: y, r: 7, class: i < 2 ? 'art-done' : 'art-open' });
    if (i < 2) add('path', { d: `M32.5 ${y}l2.5 2.6 4.8-5.2`, class: 'art-tick' });
    add('rect', { x: 50, y: y - 3, width: i === 0 ? 40 : i === 1 ? 30 : 36, height: 6, rx: 3, class: 'art-line' });
  }
  return svg;
}
