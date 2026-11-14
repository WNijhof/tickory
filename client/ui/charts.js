// Een eenvoudig staafdiagram als SVG (createElementNS, geen bibliotheek, geen innerHTML), voor het scherm Productiviteit.
// Eén reeks, dus één kleur: de accentkleur (licht, donker en de gekozen accentkleur volgen vanzelf via de css-tokens, zie
// productivity.css). De horizontale maat staat in procenten, zodat de staven meerekken met de breedte en de tekst zijn eigen
// grootte houdt. Wat schermlezers krijgen, is een gewone (verborgen) tabel met dezelfde getallen; de tekening zelf is decoratief.

import { h } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 168;
const TOP = 20; // ruimte voor de getallen boven de staven
const BOTTOM = 24; // ruimte voor de namen eronder
const RADIUS = 4;

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.append(c);
  return el;
}
const pct = (n) => `${Math.round(n * 1000) / 1000}%`;

/**
 * @param {{
 *   bars: { label: string, name: string, value: number, valueText: string, current?: boolean, muted?: boolean, showValue?: boolean }[],
 *   goal?: number, goalLabel?: string, caption: string, columns: [string, string], className?: string,
 * }} options `label` staat onder de staaf ("ma"), `name` in de tooltip en de tabel ("maandag 9 november"), `valueText` is het
 *   getal in woorden ("5 taken", of "niet bekend"); `columns`: de koppen van de verborgen tabel (bijvoorbeeld "Dag" en "Afgevinkt")
 */
export function barChart({ bars, goal = 0, goalLabel = '', caption, columns, className = '' }) {
  const max = Math.max(1, goal, ...bars.map((b) => b.value));
  const plot = HEIGHT - TOP - BOTTOM;
  const base = TOP + plot;
  const y = (v) => base - (v / max) * plot;
  const slot = 100 / bars.length;
  const width = slot * 0.56;
  const chart = svg('svg', { class: 'bar-chart', width: '100%', height: HEIGHT, 'aria-hidden': 'true', focusable: 'false' });
  chart.append(svg('line', { class: 'bar-axis', x1: '0', x2: '100%', y1: base + 0.5, y2: base + 0.5 }));
  bars.forEach((b, i) => {
    const x = slot * i + (slot - width) / 2;
    const cls = `bar${b.current ? ' bar-current' : ''}${b.muted ? ' bar-muted' : ''}`;
    const group = svg('g', { class: cls });
    if (b.value > 0) {
      const top = y(b.value);
      const h1 = base - top;
      // de afgeronde kop staat op de staaf; de onderkant blijft recht op de basislijn (een tweede, rechte rechthoek eroverheen).
      // De doorzichtigheid hoort bij de groep, zodat de overlap niet donkerder wordt.
      const shape = svg('g', { class: 'bar-shape' }, svg('rect', { class: 'bar-fill', x: pct(x), width: pct(width), y: top, height: h1, rx: Math.min(RADIUS, h1 / 2) }));
      if (h1 > RADIUS) shape.append(svg('rect', { class: 'bar-fill', x: pct(x), width: pct(width), y: base - RADIUS, height: RADIUS }));
      group.append(shape);
    }
    if (b.showValue !== false) group.append(svg('text', { class: 'bar-value', x: pct(slot * i + slot / 2), y: (b.value > 0 ? y(b.value) : base) - 6, 'text-anchor': 'middle' }, document.createTextNode(String(b.value))));
    group.append(svg('text', { class: 'bar-label', x: pct(slot * i + slot / 2), y: HEIGHT - 6, 'text-anchor': 'middle' }, document.createTextNode(b.label)));
    // een vlak over de hele hoogte voor de tooltip (groter dan de staaf zelf)
    group.append(svg('rect', { class: 'bar-hit', x: pct(slot * i), width: pct(slot), y: 0, height: HEIGHT }, svg('title', {}, document.createTextNode(`${b.name}: ${b.valueText}`))));
    chart.append(group);
  });
  if (goal > 0) {
    const gy = Math.round(y(goal)) + 0.5;
    chart.append(svg('line', { class: 'bar-goal', x1: '0', x2: '100%', y1: gy, y2: gy }));
  }
  // de uitleg van de stippellijn staat onder de tekening (in de tekening zou hij over een getal kunnen vallen)
  const legend = goal > 0 && goalLabel ? h('p', { class: 'chart-legend', 'aria-hidden': 'true' }, h('span', { class: 'chart-legend-goal' }), goalLabel) : null;
  // Een tabel trekt zich niets aan van width: 1px (hij wordt zo breed als zijn inhoud) en stak zo op een telefoon met een breed
  // lettertype buiten het scherm; daarom staat hij in een verborgen blok, waar hij voor schermlezers gewoon een tabel blijft.
  const table = h('div', { class: 'sr-only' }, h('table', {},
    h('caption', {}, caption),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, columns[0]), h('th', { scope: 'col' }, columns[1]))),
    h('tbody', {}, bars.map((b) => h('tr', {}, h('th', { scope: 'row' }, b.name), h('td', {}, b.valueText))))));
  return h('figure', { class: `chart${className ? ` ${className}` : ''}` }, chart, legend, table);
}
