// De menubalk onderaan op een telefoon (tot 760 pixels breed, ook in de Android-app), zoals in de Todoist-app: vier knoppen (Inbox,
// Vandaag met het aantal, Aankomend, Bladeren) en een ronde knop "+" rechtsonder die het venster Taak toevoegen opent, zoals de
// sneltoets `q`. Op een breder scherm staat alles in de zijbalk en zijn balk en knop verborgen (bottomnav.css).
//
// Bladeren is de zijbalk zelf, op een telefoon als scherm boven de balk (de klasse `nav-open` op body, net als vroeger het
// uitschuifmenu): bovenaan zoeken, dan Voltooid, Meldingen, filters, labels, favorieten, projecten en instellingen. Alles wat daar
// aanhaakt (ui/find.js, ui/inbox.js, ui/completed.js, slepen naar een project in ui/dragdrop.js) werkt zo vanzelf ook op een telefoon.
// De terugknop van Android (en van de browser) sluit Bladeren: bij openen komt er een stap in de geschiedenis bij.
//
// Welke knop actief is en waar "+" toevoegt, staat in core/bottomNav.js. Tijdens het selecteren staat de actiebalk van
// ui/selection.js onderaan in de plaats van de balk; terwijl je in een invoerveld typt en het toetsenbord open is, zijn balk en "+"
// weg, zodat ze niet boven het toetsenbord over het veld schuiven (in de Android-app maakt het toetsenbord de WebView kleiner). Een melding ("Ongedaan maken") staat boven de balk; de "+" schuift
// er dan boven.

import { TABS, activeTab, fabTarget, keyboardTracker } from '../core/bottomNav.js';
import { todayString } from '../core/format.js';
import { t } from '../core/i18n.js';
import { counts } from '../core/selectors.js';
import { isTyping } from '../core/shortcuts.js';
import { h } from './dom.js';
import { icon } from './icons.js';

const NARROW = '(max-width: 760px)';
/** De stap in de geschiedenis die Bladeren bij openen toevoegt (zodat "terug" het scherm sluit). */
const STATE_KEY = 'tickoryBrowse';

/**
 * @param {{
 *   store: import('../core/store.js').Store,
 *   handlers: { navigate: (route: object) => void, quickAdd: (target?: object | null) => unknown },
 *   getRoute: () => { type: string, id?: string },
 *   inboxId: () => string | null,
 * }} options
 * @returns {{ render: () => void }} `render` na elke keer tekenen van het scherm (app.js)
 */
export function installBottomNav({ store, handlers, getRoute, inboxId }) {
  const body = document.body;
  const sidebar = document.getElementById('sidebar');
  const media = globalThis.matchMedia?.(NARROW) ?? null;
  const narrow = () => Boolean(media?.matches);
  const isOpen = () => body.classList.contains('nav-open');

  // ---------- de balk en de knop "+" ----------
  const icons = { inbox: 'inbox', today: 'today', upcoming: 'upcoming', browse: 'browse' };
  const labels = {};
  const buttons = {};
  const badge = h('span', { class: 'bnav-badge', 'aria-hidden': 'true' });
  for (const tab of TABS) {
    labels[tab] = h('span', { class: 'bnav-label' });
    buttons[tab] = h('button', { class: 'bnav-item', type: 'button', dataset: { tab, fk: `bnav:${tab}` }, onclick: () => choose(tab) },
      h('span', { class: 'bnav-icon' }, icon(icons[tab]), tab === 'today' && badge), labels[tab]);
  }
  buttons.browse.setAttribute('aria-controls', 'sidebar');
  const bar = h('nav', { id: 'bottom-nav', class: 'bottom-nav' }, TABS.map((tab) => buttons[tab]));
  const fab = h('button', { id: 'fab', class: 'fab', type: 'button', 'aria-keyshortcuts': 'q', hidden: true, onclick: () => add() }, icon('plus'));
  const toasts = document.getElementById('toasts');
  if (toasts) toasts.before(bar, fab);
  else body.append(bar, fab);

  function choose(tab) {
    if (tab === 'browse') {
      if (isOpen()) close();
      else open();
      return;
    }
    const id = inboxId();
    if (tab === 'inbox' && !id) return; // nog niet ingelogd: er is (nog) geen Inbox
    handlers.navigate(tab === 'inbox' ? { type: 'project', id } : { type: tab }); // sluit ook Bladeren
    buttons[tab].focus({ preventScroll: true }); // de focus blijft op de knop (ook als het scherm opnieuw is getekend)
    window.scrollTo({ top: 0, behavior: 'instant' }); // een ander scherm begint bovenaan; nog eens op dezelfde knop tikken gaat ook naar boven
  }

  function add() {
    const target = currentTarget();
    if (!target) return;
    handlers.quickAdd(Object.keys(target).length > 0 ? target : null); // leeg: zoals `q`, het huidige scherm bepaalt waar
  }

  const currentTarget = () => fabTarget(getRoute(), {
    view: store.view, userId: store.userId, inboxId: inboxId(), browseOpen: isOpen() && narrow(), selecting: body.classList.contains('select-mode'),
  });

  // ---------- Bladeren openen en sluiten ----------
  function open() {
    if (isOpen()) return;
    body.classList.add('nav-open');
    try {
      if (!history.state?.[STATE_KEY]) history.pushState({ ...(history.state ?? {}), [STATE_KEY]: true }, '');
    } catch { /* geen geschiedenis (een ingesloten pagina): dan sluit alleen de knop het scherm */ }
    // de focus naar het begin van het scherm (het zoekveld), zodat toetsenbord en schermlezer daar verdergaan
    requestAnimationFrame(() => {
      if (!isOpen()) return;
      const first = sidebar?.querySelector('.search-field') ?? sidebar?.querySelector('button');
      first?.focus({ preventScroll: true });
    });
  }

  function close() {
    body.classList.remove('nav-open');
  }

  /** Bladeren ging dicht (door de knop, Escape, een keuze in het scherm, of slepen dat klaar is). */
  function closed() {
    try {
      if (history.state?.[STATE_KEY]) history.back(); // de eigen stap weer weg; "terug" daarna gaat waar het eerst heen ging
    } catch { /* zie open() */ }
    // stond de focus in het scherm dat nu verdwijnt (of nergens meer, na een keuze daarin), dan naar de knop Bladeren: anders raakt
    // een toetsenbordgebruiker zijn plek kwijt
    const focused = document.activeElement;
    if (narrow() && (!focused || focused === body || sidebar?.contains(focused))) buttons.browse.focus({ preventScroll: true });
  }

  window.addEventListener('popstate', () => {
    if (isOpen()) close(); // "terug" (ook de terugknop van Android) sluit Bladeren
  });

  // Alles wat de klassen op body verandert (Bladeren, selecteren, typen) tekent de balk bij; ook als een ander onderdeel dat doet.
  let wasOpen = isOpen();
  new MutationObserver(() => {
    const now = isOpen();
    if (wasOpen && !now) closed();
    wasOpen = now;
    paint();
  }).observe(body, { attributes: true, attributeFilter: ['class'] });

  media?.addEventListener?.('change', () => {
    if (!narrow()) close(); // breder geworden (draaien): de zijbalk staat weer gewoon links
    paint();
    measure();
  });

  // ---------- typen: een invoerveld heeft de focus en het toetsenbord is open ----------
  // Alleen de focus is niet genoeg: na "klaar" of de terugknop gaat het toetsenbord dicht terwijl het veld de focus houdt.
  const viewport = globalThis.visualViewport ?? null;
  const keyboardOpen = keyboardTracker();
  const typing = () => {
    const open = keyboardOpen({ width: window.innerWidth, height: viewport?.height ?? window.innerHeight });
    const on = open && isTyping(document.activeElement);
    if (body.classList.contains('text-entry') !== on) body.classList.toggle('text-entry', on);
  };
  document.addEventListener('focusin', typing);
  document.addEventListener('focusout', () => setTimeout(typing, 0)); // de focus springt even naar body voordat hij op het volgende veld staat
  (viewport ?? window).addEventListener('resize', typing);
  typing();

  // ---------- maten: hoe hoog de balk is (met grote letters hoger) en hoeveel ruimte de meldingen innemen ----------
  function measure() {
    // verborgen tijdens typen of selecteren: de laatste maat houden, zodat de lijst niet verspringt
    if (!narrow()) body.style.removeProperty('--bnav-space');
    else if (getComputedStyle(bar).display !== 'none') body.style.setProperty('--bnav-space', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    fab.style.setProperty('--toasts-lift', `${toasts?.offsetHeight ?? 0}px`);
  }
  if (typeof ResizeObserver === 'function') {
    const resized = new ResizeObserver(() => measure());
    resized.observe(bar);
    if (toasts) resized.observe(toasts);
  } else if (toasts) {
    new MutationObserver(() => measure()).observe(toasts, { childList: true });
  }

  // ---------- tekenen ----------
  function paint() {
    const route = getRoute();
    const browseOpen = isOpen() && narrow();
    const active = activeTab(route, { inboxId: inboxId(), browseOpen });
    for (const tab of TABS) {
      const on = tab === active;
      if (buttons[tab].classList.contains('active') !== on) buttons[tab].classList.toggle('active', on);
      if (on) buttons[tab].setAttribute('aria-current', 'page');
      else buttons[tab].removeAttribute('aria-current');
    }
    buttons.browse.setAttribute('aria-expanded', String(browseOpen));
    // wat Bladeren afdekt, is zolang niet te bereiken met Tab of een schermlezer
    const main = document.querySelector('main.main');
    if (main && main.inert !== browseOpen) main.inert = browseOpen;
    const hide = !currentTarget();
    if (fab.hidden !== hide) fab.hidden = hide;
  }

  function render() {
    bar.setAttribute('aria-label', t('bottomNav.label'));
    labels.inbox.textContent = t('bottomNav.inbox');
    labels.today.textContent = t('nav.today');
    labels.upcoming.textContent = t('nav.upcoming');
    labels.browse.textContent = t('bottomNav.browse');
    // het aantal zoals in de zijbalk bij Vandaag (te laat en vandaag)
    const n = counts(store.view, todayString()).today;
    badge.textContent = n > 99 ? '99+' : n > 0 ? String(n) : '';
    if (n > 0) buttons.today.setAttribute('aria-label', t('bottomNav.todayCount', { count: n }));
    else buttons.today.removeAttribute('aria-label');
    fab.setAttribute('aria-label', t('quick.addTask'));
    fab.title = t('quick.addTask');
    paint();
  }

  measure();
  return { render };
}
