// De handleiding in de app: de bestanden in client/help passen bij de pagina's van de website, de links blijven in de app of gaan
// naar de website, en zoeken en het adres #help=… werken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { helpModule } from '../../scripts/build-help.ts';
import { helpRouteFromHash, helpSections, isHelpRoute, safeHref, searchHelp } from './help.js';
import nl from '../help/nl.js';
import en from '../help/en.js';

test('client/help/*.js is bijgewerkt met de pagina\'s van de website (anders: node scripts/build-help.ts)', () => {
  for (const lang of ['nl', 'en']) {
    const file = readFileSync(new URL(`../help/${lang}.js`, import.meta.url), 'utf8');
    assert.ok(file === helpModule(lang), `client/help/${lang}.js is verouderd: draai node scripts/build-help.ts`);
  }
});

test('de handleiding in de app: alle pagina\'s, geen schermafbeeldingen of website-elementen, en elke link is veilig', () => {
  for (const data of [nl, en]) {
    const ids = Object.keys(data.pages);
    assert.ok(ids.length >= 40, `${data.lang}: ${ids.length} pagina's`);
    assert.deepEqual(data.groups.flatMap((g) => g.pages).sort(), [...ids].sort(), 'elke pagina staat in de inhoudsopgave');
    for (const [id, page] of Object.entries(data.pages)) {
      assert.doesNotMatch(page.html, /<x-|\{\{|<img|<script|<style|\sstyle=/, `${data.lang}/${id}`);
      for (const [, href] of page.html.matchAll(/href="([^"]*)"/g)) {
        assert.ok(safeHref(href), `${data.lang}/${id}: onveilige of kapotte link ${href}`);
        const route = helpRouteFromHash(href);
        if (route?.id) assert.ok(data.pages[route.id], `${data.lang}/${id}: link naar een pagina die niet bestaat: ${href}`);
        if (route?.anchor) assert.ok(data.pages[route.id].html.includes(` id="${route.anchor}"`), `${data.lang}/${id}: kop ${href} bestaat niet`);
      }
      assert.match(page.site, /^https:\/\/wnijhof\.github\.io\/tickory\/(nl|en)\//);
    }
  }
});

test('#help in het adres: de inhoudsopgave, een pagina, of een pagina met een kop; al het andere niet', () => {
  assert.deepEqual(helpRouteFromHash('#help'), { type: 'help' });
  assert.deepEqual(helpRouteFromHash('#help=index'), { type: 'help' });
  assert.deepEqual(helpRouteFromHash('#help=herinneringen'), { type: 'help', id: 'herinneringen' });
  assert.deepEqual(helpRouteFromHash('#help=herinneringen~snel-toevoegen-met'), { type: 'help', id: 'herinneringen', anchor: 'snel-toevoegen-met' });
  for (const bad of ['', '#helpme', '#help=', '#help=../x', '#help=a b', '#view=help', null]) assert.equal(helpRouteFromHash(bad), null, String(bad));
  assert.equal(isHelpRoute({ type: 'help', id: 'x' }), true);
  assert.equal(isHelpRoute({ type: 'help', id: 3 }), false);
  for (const bad of ['javascript:alert(1)', 'http://x.nl', 'data:text/html,x', '/api/v1/sync', '#task=abc']) assert.equal(safeHref(bad), null, bad);
  assert.equal(safeHref('https://wnijhof.github.io/tickory/'), 'https://wnijhof.github.io/tickory/');
});

test('zoeken in de handleiding: alle woorden moeten erin staan, een woord in de kop telt zwaarder, en accenten tellen niet', () => {
  const data = { pages: {
    a: { title: 'Herinneringen', html: '<h1>Herinneringen</h1><p>Intro.</p><h2 id="snel">Snel toevoegen met !30m</h2><p>Een herinnering vooraf.</p>' },
    b: { title: 'Notities', html: '<h1>Notities</h1><p>Een notitie met een herinnering &amp; een foto. Café.</p>' },
  } };
  assert.equal(helpSections(data).length, 3);
  const hits = searchHelp(data, 'herinnering');
  assert.deepEqual(hits.map((h) => `${h.id}~${h.anchor}`).sort(), ['a~null', 'a~snel', 'b~null']);
  assert.equal(hits.at(-1).id, 'b', 'alleen in de tekst: achteraan');
  assert.deepEqual(searchHelp(data, 'herinnering foto').map((h) => h.id), ['b']);
  assert.deepEqual(searchHelp(data, 'cafe').map((h) => h.id), ['b'], 'zonder accent');
  assert.deepEqual(searchHelp(data, ' '), []);
  assert.match(searchHelp(data, 'foto')[0].snippet, /& een foto/);
  // de echte handleiding: "back-up" vindt de pagina Back-up
  assert.ok(searchHelp(nl, 'back-up').some((h) => h.id === 'back-up'));
  assert.ok(searchHelp(en, 'recurring').length > 0);
});
