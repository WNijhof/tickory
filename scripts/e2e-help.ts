// De handleiding in de app (ui/help.js) in een echte browser: via Instellingen › Handleiding, de inhoudsopgave met alle pagina's,
// zoeken, een pagina openen, een link naar een andere pagina (met een kop) volgen, Vorige/Volgende, terug naar de inhoudsopgave,
// #help in het adres, en op een telefoon zonder zijwaarts scrollen. Wordt aangeroepen vanuit scripts/e2e.ts.

import assert from 'node:assert/strict';
import nl from '../client/help/nl.js';

export async function helpScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, js, typeInto, click, clickText, nav } = c;
  const title = () => evaluate<string>(`document.getElementById('view-title').textContent`);
  const pages = Object.keys(nl.pages).length;
  const startView = await title(); // aan het eind weer hier: de onderdelen hierna gaan ervan uit

  // ---- via Instellingen ----
  await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  await nav('Vandaag');
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .settings-menu')`, 'instellingenmenu');
  await clickText('Handleiding', `document.querySelector('dialog[open]')`);
  await waitFor(`document.getElementById('view-title').textContent === 'Handleiding'`, 'de handleiding via Instellingen');
  await waitFor(`document.querySelectorAll('.help-toc-link').length === ${pages}`, `alle ${pages} pagina's in de inhoudsopgave`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.help-group-title')].map((e) => e.textContent)`), nl.groups.map((g) => g.title));
  await shot('handleiding-inhoud');

  // ---- zoeken: alleen de resultaten verversen, het veld houdt de focus ----
  await typeInto('.help-search-input', 'back-up');
  await waitFor(`document.querySelector('.help-hit')`, 'zoekresultaten');
  assert.equal(await evaluate(`document.activeElement?.classList.contains('help-search-input')`), true, 'het zoekveld houdt de focus');
  assert.ok(await evaluate(`[...document.querySelectorAll('.help-hit strong')].some((e) => e.textContent.startsWith('Back-up'))`), 'de pagina Back-up staat erbij');
  await evaluate(`[...document.querySelectorAll('.help-hit')].find((a) => a.querySelector('strong').textContent.startsWith('Back-up')).click()`);
  await waitFor(`document.getElementById('view-title').textContent === ${js(nl.pages['back-up'].title)}`, 'de pagina uit de zoekresultaten');
  assert.equal(await evaluate(`location.hash`), '', 'het adres blijft schoon');

  // ---- een pagina: tekst, knoppen uit de app, een link naar een andere pagina met een kop ----
  await click('[data-fk="help-back"]');
  await waitFor(`document.querySelector('.help-toc-link')`, 'terug naar de inhoudsopgave');
  await evaluate(`document.querySelector('.help-search-input').value = ''; document.querySelector('.help-search-input').dispatchEvent(new Event('input'))`);
  await click('[data-fk="help:account"]');
  await waitFor(`document.getElementById('view-title').textContent === ${js(nl.pages.account.title)}`, 'de pagina Account');
  assert.ok(await evaluate(`document.querySelectorAll('.help-prose h2').length > 3`), 'met koppen');
  assert.ok(await evaluate(`document.querySelectorAll('.help-prose .ui').length > 3`), 'met de namen van knoppen uit de app');
  assert.equal(await evaluate(`document.querySelectorAll('.help-prose script, .help-prose style, .help-prose [style], .help-prose img').length`), 0);
  assert.equal(await evaluate(`[...document.querySelectorAll('.help-prose a[href^="http"]')].every((a) => a.target === '_blank' && a.rel === 'noopener')`), true, 'links naar buiten in een nieuw venster');
  await shot('handleiding-pagina');
  // de link naar "afmelden" op de pagina Inloggen (een andere pagina, met een kop)
  await evaluate(`document.querySelector('.help-prose a[href="#help=inloggen~afmelden"]').click()`);
  await waitFor(`document.getElementById('view-title').textContent === ${js(nl.pages.inloggen.title)}`, 'de link naar een andere pagina');
  await waitFor(`(() => { const r = document.getElementById('help-afmelden')?.getBoundingClientRect(); return r && r.top >= -2 && r.top < 200; })()`, 'naar de kop gescrold');

  // ---- Vorige en Volgende volgen de volgorde van de inhoudsopgave ----
  const order = nl.groups.flatMap((g) => g.pages);
  const next = order[order.indexOf('inloggen') + 1];
  await evaluate(`document.querySelector('.help-next').click()`);
  await waitFor(`document.getElementById('view-title').textContent === ${js(nl.pages[next].title)}`, 'Volgende');
  await evaluate(`document.querySelector('.help-prev').click()`);
  await waitFor(`document.getElementById('view-title').textContent === ${js(nl.pages.inloggen.title)}`, 'Vorige');
  step(`handleiding: via Instellingen, ${pages} pagina's in groepen, zoeken (het veld houdt de focus), een pagina met de knoppen uit de app, links tussen pagina's naar de juiste kop, Vorige/Volgende`);

  // ---- #help in het adres (de knop Help van de desktop-app, een bladwijzer) ----
  await nav('Vandaag');
  await evaluate(`location.hash = '#help=herinneringen'`);
  await waitFor(`document.getElementById('view-title').textContent === ${js(nl.pages.herinneringen.title)}`, '#help=herinneringen');
  await waitFor(`location.hash === ''`, 'het adres weer schoon');

  // ---- op een telefoon: alles leesbaar, niets valt buiten beeld ----
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await waitFor(`document.querySelector('.help-prose')`, 'pagina op een telefoon');
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`), true, 'geen zijwaarts scrollen van de pagina (tabellen scrollen in hun eigen kader)');
  await shot('handleiding-telefoon');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
  step('handleiding: #help in het adres opent de pagina, en op een telefoon past alles zonder zijwaarts te scrollen');
}
