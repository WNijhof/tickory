// De handleiding in de app (Instellingen › Handleiding, of #help in het adres): dezelfde pagina's als op de website, gemaakt
// door scripts/build-help.ts in client/help/<taal>.js. Die worden pas geladen als je de handleiding opent, en de service worker
// bewaart ze, zodat de handleiding ook zonder verbinding te lezen is.
//
// De route is `{ type: 'help' }` (de inhoudsopgave met zoeken) of `{ type: 'help', id: 'herinneringen', anchor?: 'kop' }`.
// Een link in de handleiding naar een andere pagina is `#help=herinneringen` (met een kop: `#help=herinneringen~kop`).
//
// De pagina's komen uit de eigen repo, maar we bouwen ze toch op zonder innerHTML: DOMParser leest de tekst (en voert niets uit),
// en alleen bekende opmaak met veilige attributen gaat mee (geen script, geen style, geen andere adressen dan #help, https en mailto).

import { getLanguage, t } from '../core/i18n.js';
import { h, replace } from './dom.js';
import { icon } from './icons.js';
import { viewHooks } from './render.js';
import { helpRouteFromHash, helpSections, safeHref, searchHelp } from '../core/help.js';

export { helpRouteFromHash, isHelpRoute } from '../core/help.js';

const TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'pre', 'kbd',
  'strong', 'em', 'a', 'span', 'div', 'br', 'figure', 'figcaption', 'blockquote', 'small', 'sup', 'sub', 'b', 'i']);
const ATTRS = new Set(['class', 'id', 'href', 'colspan', 'rowspan', 'scope']);

/** De tekst van de handleiding als DOM, met alleen bekende opmaak. */
export function helpNodes(html, doc = globalThis.document) {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  const copy = (node) => {
    if (node.nodeType === 3) return doc.createTextNode(node.nodeValue);
    if (node.nodeType !== 1) return null;
    const tag = node.tagName.toLowerCase();
    if (!TAGS.has(tag)) {
      // een onbekend element: de tekst blijft, het element niet (script en style helemaal niet)
      if (tag === 'script' || tag === 'style') return null;
      const frag = doc.createDocumentFragment();
      for (const child of node.childNodes) { const c = copy(child); if (c) frag.append(c); }
      return frag;
    }
    const el = doc.createElement(tag);
    for (const { name, value } of node.attributes) {
      if (!ATTRS.has(name)) continue;
      if (name === 'href') {
        const href = safeHref(value);
        if (!href) continue;
        el.setAttribute('href', href);
        if (!href.startsWith('#')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
      } else if (name === 'id') {
        el.setAttribute('id', `help-${value}`); // eigen voorvoegsel: botst niet met de id's van de app zelf
      } else {
        el.setAttribute(name, value);
      }
    }
    for (const child of node.childNodes) { const c = copy(child); if (c) el.append(c); }
    return el;
  };
  return [...parsed.body.childNodes].map(copy).filter(Boolean);
}

/**
 * Het scherm Handleiding.
 * @param {{ navigate: (route: object) => void, invalidate: () => void }} options
 */
export function installHelp({ navigate, invalidate }) {
  /** Per taal: de geladen handleiding, of een belofte zolang hij laadt; `failed` als laden niet lukte (geen verbinding, oude cache). */
  const loaded = new Map();
  let failed = false;
  let query = '';
  let sections = null;
  let scrolledFor = null;

  const load = (lang) => {
    if (loaded.has(lang)) return loaded.get(lang);
    const promise = import(`../help/${lang}.js`).then((m) => {
      loaded.set(lang, m.default);
      sections = null;
      failed = false;
      invalidate();
      return m.default;
    }, () => {
      loaded.delete(lang);
      failed = true;
      invalidate();
      return null;
    });
    loaded.set(lang, promise);
    return promise;
  };
  const dataNow = () => {
    const lang = getLanguage() === 'nl' ? 'nl' : 'en';
    const d = loaded.get(lang);
    if (d && !(d instanceof Promise)) return d;
    if (!d && !failed) load(lang);
    return null;
  };

  const go = (id, anchor = null) => navigate(id ? { type: 'help', id, ...(anchor ? { anchor } : {}) } : { type: 'help' });
  /** Een link in de tekst: #help=… blijft in de app (zonder het adres te veranderen), de rest opent in de browser. */
  const onClick = (e) => {
    const a = e.target.closest?.('a[href^="#help"]');
    if (!a) return;
    const route = helpRouteFromHash(a.getAttribute('href'));
    if (!route) return;
    e.preventDefault();
    if (!route.id) query = ''; // Alle onderwerpen: de inhoudsopgave, niet de vorige zoekresultaten
    go(route.id ?? null, route.anchor ?? null);
  };

  /** Het zoekveld en daaronder de resultaten (of de inhoudsopgave); typen ververst alleen dat deel, het veld blijft staan. */
  function searchArea(data) {
    const below = () => {
      const part = query.trim() ? results(data) : contents(data);
      return Array.isArray(part) ? part : [part];
    };
    const out = h('div', { class: 'help-search-out' }, below());
    const input = h('input', {
      type: 'search', class: 'field help-search-input', value: query, placeholder: t('help.searchPlaceholder'), 'aria-label': t('help.search'),
      autocomplete: 'off', dataset: { fk: 'help-search' },
      oninput: (e) => { query = e.target.value; replace(out, below()); },
    });
    return [h('div', { class: 'help-search', role: 'search' }, icon('search'), input), out];
  }

  function results(data) {
    sections ??= helpSections(data);
    const hits = searchHelp(data, query, { sections });
    return h('section', { class: 'help-results', 'aria-live': 'polite' },
      h('p', { class: 'hint' }, hits.length === 0 ? t('help.none') : t('help.results', { count: hits.length })),
      h('ol', { class: 'help-hit-list' }, hits.map((hit) => h('li', {},
        h('a', { href: `#help=${hit.id}${hit.anchor ? `~${hit.anchor}` : ''}`, class: 'help-hit', onclick: onClick },
          h('strong', {}, hit.heading === hit.page ? hit.page : `${hit.page} › ${hit.heading}`),
          h('span', { class: 'help-snippet' }, hit.snippet))))));
  }

  function contents(data) {
    return data.groups.map((g) => h('section', { class: 'help-group' },
      h('h2', { class: 'help-group-title' }, g.title),
      h('ul', { class: 'help-toc' }, g.pages.map((id) => {
        const p = data.pages[id];
        return p && h('li', {}, h('a', { href: `#help=${id}`, class: 'help-toc-link', dataset: { fk: `help:${id}` }, onclick: onClick },
          h('span', { class: 'help-toc-title' }, p.title),
          h('span', { class: 'help-toc-text' }, p.description),
          icon('chevronRight')));
      }))));
  }

  function article(data, id) {
    const page = data.pages[id];
    const order = data.groups.flatMap((g) => g.pages);
    const at = order.indexOf(id);
    const prev = at > 0 ? order[at - 1] : null;
    const next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
    const pagerLink = (target, label, dir) => target && h('a', { href: `#help=${target}`, class: `help-pager-link help-${dir}`, onclick: onClick },
      h('span', { class: 'hint' }, label), h('strong', {}, data.pages[target]?.title ?? target));
    const body = h('article', { class: 'help-prose', onclick: onClick }, helpNodes(page.html));
    return [
      h('nav', { class: 'help-crumbs', 'aria-label': t('help.title') },
        h('a', { href: '#help', class: 'link-button', dataset: { fk: 'help-back' }, onclick: onClick }, icon('chevronLeft'), t('help.allTopics'))),
      body,
      h('nav', { class: 'help-pager', 'aria-label': t('help.pager') }, pagerLink(prev, t('help.previous'), 'prev'), pagerLink(next, t('help.next'), 'next')),
      h('p', { class: 'help-site' }, h('a', { href: page.site, target: '_blank', rel: 'noopener' }, t('help.onWebsite'))),
    ];
  }

  /** Na het tekenen: naar de gevraagde kop, of bovenaan een nieuwe pagina. */
  const scrollAfter = (route) => {
    const key = `${route.id ?? ''}~${route.anchor ?? ''}`;
    if (scrolledFor === key) return;
    scrolledFor = key;
    requestAnimationFrame(() => {
      const target = route.anchor ? document.getElementById(`help-${route.anchor}`) : null;
      if (target) {
        target.scrollIntoView({ block: 'start' });
        return;
      }
      document.querySelector('main')?.scrollTo?.(0, 0);
      window.scrollTo(0, 0);
    });
  };

  viewHooks.help = ({ route }) => {
    const data = dataNow();
    const base = { title: t('help.title'), count: null, lead: icon('help'), actions: [] };
    if (!data) {
      return { ...base, nodes: [h('p', { class: 'hint help-loading' }, failed ? t('help.failed') : t('help.loading'))] };
    }
    if (route.id && data.pages[route.id]) {
      scrollAfter(route);
      return { ...base, title: data.pages[route.id].title, nodes: article(data, route.id) };
    }
    scrollAfter({ id: null });
    return {
      ...base,
      nodes: [h('div', { class: 'help-index' }, h('p', { class: 'help-intro' }, t('help.intro')), searchArea(data))],
    };
  };

  return { load: () => load(getLanguage() === 'nl' ? 'nl' : 'en') };
}
