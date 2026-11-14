// Herinneringen op een locatie in een echte browser: het scherm Plaatsen, "gebruik mijn huidige positie" (de geolocatie van de
// browser wordt via het DevTools-protocol nagebootst), coördinaten en kaartlinks plakken, de keuze "Op een plek" in het taakvenster,
// het opruimen van herinneringen bij een verwijderde plaats, en de Android-brug (nagebootst). Wordt aangeroepen vanuit
// scripts/e2e.ts; de hulpfuncties van die test komen binnen via `c`. Alle plaatsen en coördinaten zijn verzonnen.

import assert from 'node:assert/strict';

export async function geoScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, alice, serverState, typeInto, clickText, click, nav, BASE } = c;

  const places = () => (serverState().places as any[]).filter((p) => !p.is_deleted).sort((a, b) => (a.name < b.name ? -1 : 1));
  const locationReminders = () => (serverState().reminders as any[]).filter((r) => r.type === 'location' && !r.is_deleted);
  const dialogText = () => evaluate<string>(`document.querySelector('dialog[open]')?.textContent ?? ''`);
  const openPlaces = async () => {
    await nav('Alice');
    await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
    await clickText('Plaatsen');
    await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Plaatsen'`, 'scherm Plaatsen');
  };
  const closeDialog = async () => {
    await clickText('Sluiten', `document.querySelector('dialog[open]')`);
    await waitFor(`!document.querySelector('dialog[open]')`, 'scherm gesloten');
  };
  const field = (role: string) => `dialog[open] [data-role="${role}"]`;
  const value = (role: string) => evaluate<string>(`document.querySelector(${js(field(role))}).value`);
  const setSelect = (selector: string, v: string) =>
    evaluate(`(() => { const s = document.querySelector(${js(selector)}); s.value = ${js(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const openTask = async (content: string) => {
    await waitFor(`!document.querySelector('#task-dialog')`, 'het vorige bewerkvenster is weg');
    await evaluate(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === ${js(content)}).querySelector('.task-body').click()`);
    await waitFor(`document.querySelector('#task-dialog[open]')`, 'bewerkvenster');
  };
  const reminderLines = () => evaluate<string[]>(`[...document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] li.device .device-info')].map((e) => e.textContent)`);

  // ---- in de browser ----
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingenmenu');
  assert.ok((await evaluate<string[]>(`[...document.querySelectorAll('dialog[open] .menu button')].map((b) => b.textContent.trim())`)).includes('Plaatsen'), 'Plaatsen staat in het instellingenmenu');
  await clickText('Plaatsen');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Plaatsen'`, 'scherm Plaatsen');
  let text = await dialogText();
  assert.ok(text.includes('gaat nooit naar de server'), 'de uitleg over privacy staat erin');
  assert.ok(text.includes('Nog geen plaatsen.'));
  assert.ok(text.includes('In de browser werken herinneringen op een plek niet') && text.includes('Android-app'), 'in de browser: uitleg dat de Android-app nodig is');
  assert.ok(!text.includes('Locatiecontrole aanzetten'), 'de locatiecontrole is er alleen in de Android-app');
  await shot('plaatsen-leeg');

  // "gebruik mijn huidige positie": de browser vraagt toestemming; hier nagebootst met een verzonnen positie
  await send('Browser.grantPermissions', { permissions: ['geolocation'], origin: BASE });
  await send('Emulation.setGeolocationOverride', { latitude: 52.0907, longitude: 5.1214, accuracy: 25 });
  await typeInto(field('place-name'), 'Thuis');
  await click(field('place-here'));
  await waitFor(`document.querySelector(${js(field('place-lat'))}).value === '52.0907'`, 'breedtegraad ingevuld');
  assert.equal(await value('place-lon'), '5.1214');
  assert.ok((await dialogText()).includes('Positie ingevuld (ongeveer 25 m nauwkeurig).'));
  assert.equal(await value('place-radius'), '150', 'standaardstraal 150 meter');
  assert.deepEqual(places(), [], 'nog niets opgeslagen: de positie staat alleen in het formulier');
  await clickText('Plaats toevoegen', `document.querySelector('dialog[open]')`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual(places().map((p) => [p.name, p.lat, p.lon, p.radius, p.owner_id]), [['Thuis', 52.0907, 5.1214, 150, alice.id]]);
  await waitFor(`document.querySelector('dialog[open] [data-role="place-list"]').textContent.includes('Thuis')`, 'plaats in de lijst');
  assert.equal(await value('place-name'), '', 'het formulier is weer leeg');
  step('Plaatsen: de huidige positie (nagebootste geolocatie) vult het formulier pas na een tik, en pas bij Plaats toevoegen gaat de plaats naar de server (alleen van Alice)');

  // een geplakte geo:-link, en wat geen coördinaten is
  await typeInto(field('place-name'), 'Werk');
  await typeInto(field('place-paste'), 'Hoofdstraat 1, Plaats');
  await evaluate(`document.querySelector(${js(field('place-paste'))}).dispatchEvent(new Event('change', { bubbles: true }))`);
  await waitFor(`document.querySelector(${js(field('place-error'))}).textContent.startsWith('Hier staan geen coördinaten in')`, 'melding bij een adres');
  await typeInto(field('place-paste'), 'geo:51.9244,4.4777?z=15');
  await waitFor(`document.querySelector(${js(field('place-lat'))}).value === '51.9244'`, 'geo-link ingelezen');
  assert.equal(await value('place-lon'), '4.4777');
  assert.equal(await evaluate(`document.querySelector(${js(field('place-error'))}).textContent`), '', 'de melding is weg');
  await setSelect(field('place-radius'), '500');
  await clickText('Plaats toevoegen', `document.querySelector('dialog[open]')`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual(places().map((p) => [p.name, p.lat, p.lon, p.radius]), [['Thuis', 52.0907, 5.1214, 150], ['Werk', 51.9244, 4.4777, 500]]);
  // een kaartlink
  await typeInto(field('place-paste'), 'https://www.openstreetmap.org/#map=16/52.3702/4.8952');
  await waitFor(`document.querySelector(${js(field('place-lat'))}).value === '52.3702'`, 'kaartlink ingelezen');
  await typeInto(field('place-name'), 'Supermarkt');
  await clickText('Plaats toevoegen', `document.querySelector('dialog[open]')`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(places().length, 3);
  step('Plaatsen: een geplakte geo:-link en een kaartlink vullen de coördinaten in (zonder iets op te zoeken); een adres geeft een duidelijke melding');

  // controles vóór het versturen
  await clickText('Plaats toevoegen', `document.querySelector('dialog[open]')`);
  assert.equal(await evaluate(`document.querySelector(${js(field('place-error'))}).textContent`), 'Geef de plaats een naam.');
  await typeInto(field('place-name'), 'Rare plaats');
  await typeInto(field('place-lat'), '95');
  await typeInto(field('place-lon'), '5');
  await clickText('Plaats toevoegen', `document.querySelector('dialog[open]')`);
  assert.match(await evaluate<string>(`document.querySelector(${js(field('place-error'))}).textContent`), /geldige breedte- en lengtegraad/);
  await typeInto(field('place-lat'), '52,5'); // met een komma als decimaalteken
  await typeInto(field('place-lon'), '5,5');
  await setSelect(field('place-radius'), '100');
  await clickText('Plaats toevoegen', `document.querySelector('dialog[open]')`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual(places().find((p) => p.name === 'Rare plaats')?.radius, 100);
  assert.equal(places().find((p) => p.name === 'Rare plaats').lat, 52.5);
  step('Plaatsen: zonder naam, met een onmogelijke breedtegraad of straal komt er een melding; een komma als decimaalteken werkt');

  // wijzigen
  await evaluate(`[...document.querySelectorAll('dialog[open] [data-role="place-list"] li')].find((l) => l.textContent.includes('Rare plaats')).querySelector('button').click()`);
  assert.equal(await value('place-name'), 'Rare plaats');
  await typeInto(field('place-name'), 'Zwembad');
  await setSelect(field('place-radius'), '250');
  await clickText('Wijzigingen opslaan', `document.querySelector('dialog[open]')`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual(places().filter((p) => p.name === 'Zwembad').map((p) => p.radius), [250]);
  assert.equal(places().filter((p) => p.name === 'Rare plaats').length, 0);
  await shot('plaatsen-lijst');

  // geweigerde toestemming voor de positie
  await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin: BASE }).catch(() => {});
  await click(field('place-here'));
  await waitFor(`document.querySelector(${js(field('place-error'))}).textContent.length > 0`, 'melding bij een geweigerde positie', 15_000);
  assert.match(await evaluate<string>(`document.querySelector(${js(field('place-error'))}).textContent`), /toestemming|niet te bepalen/);
  await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'granted', origin: BASE }).catch(() => {});
  await closeDialog();
  step('Plaatsen: een plaats wijzigen (naam en straal) werkt; een geweigerde positie geeft een duidelijke melding');

  // ---- het taakvenster: Op een plek ----
  await openTask('Bellen met de buren');
  await waitFor(`document.querySelector('#task-dialog[open] section[aria-label="Herinneringen"]')`, 'herinneringen in het taakvenster');
  const before = (await reminderLines()).length;
  await setSelect('#task-dialog select[aria-label="Wanneer?"]', 'place');
  await waitFor(`!document.querySelector('#task-dialog [data-role="reminder-place"]').hidden`, 'plaatskeuze zichtbaar');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog [data-role="reminder-place"] option')].map((o) => o.textContent)`), ['Supermarkt', 'Thuis', 'Werk', 'Zwembad']);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#task-dialog [data-role="reminder-trigger"] option')].map((o) => o.textContent)`), ['Bij aankomst', 'Bij vertrek']);
  const note = await evaluate<string>(`document.querySelector('#task-dialog [data-role="reminder-place-note"]').textContent`);
  assert.ok(note.includes('In de browser gaat een herinnering op een plek niet af') && note.includes('Android-app'), `hint dat de Android-app nodig is: ${note}`);
  const placeId = (name: string) => places().find((p) => p.name === name).id;
  await setSelect('#task-dialog [data-role="reminder-place"]', placeId('Thuis'));
  await setSelect('#task-dialog [data-role="reminder-trigger"]', 'leave');
  await clickText('Herinnering toevoegen', `document.querySelector('#task-dialog')`);
  await waitFor(`document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] li.device').length === ${before + 1}`, 'locatieherinnering toegevoegd');
  await setSelect('#task-dialog [data-role="reminder-place"]', placeId('Werk'));
  await setSelect('#task-dialog [data-role="reminder-trigger"]', 'enter');
  await clickText('Herinnering toevoegen', `document.querySelector('#task-dialog')`);
  await waitFor(`document.querySelectorAll('#task-dialog section[aria-label="Herinneringen"] li.device').length === ${before + 2}`, 'tweede locatieherinnering');
  await clickText('Herinnering toevoegen', `document.querySelector('#task-dialog')`); // precies dezelfde nog eens
  await sleep(300);
  assert.equal((await reminderLines()).length, before + 2, 'dezelfde herinnering op een plek telt één keer');
  const lines = await reminderLines();
  assert.ok(lines.includes('Bij vertrek: Thuis') && lines.includes('Bij aankomst: Werk'), `de regels: ${lines.join(' | ')}`);
  await shot('herinnering-op-een-plek');
  await clickText('Annuleren', `document.querySelector('#task-dialog')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'taakvenster gesloten');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const mine = locationReminders();
  assert.deepEqual(mine.map((r) => [r.place_id, r.trigger, r.owner_id, r.minute_offset, r.due]).sort(), [[placeId('Thuis'), 'leave', alice.id, null, null], [placeId('Werk'), 'enter', alice.id, null, null]].sort());
  step('taakvenster: "Op een plek…" met plaats en bij aankomst/bij vertrek, met de hint dat het in de browser niet afgaat; dezelfde herinnering twee keer telt één keer; op de server als locatieherinnering van Alice');

  // een plaats verwijderen haalt de herinneringen erop weg, na een vraag die dat zegt
  await openPlaces();
  await evaluate(`[...document.querySelectorAll('dialog[open] [data-role="place-list"] li')].find((l) => l.textContent.includes('Thuis')).querySelector('button[aria-label^="Plaats verwijderen"]').click()`);
  await waitFor(`document.querySelectorAll('dialog[open]').length === 2`, 'bevestiging');
  assert.ok((await evaluate<string>(`[...document.querySelectorAll('dialog[open]')].pop().textContent`)).includes('"Thuis" wordt verwijderd, met 1 herinnering op die plaats.'));
  await clickText('Verwijderen', `[...document.querySelectorAll('dialog[open]')].pop()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.deepEqual(places().map((p) => p.name), ['Supermarkt', 'Werk', 'Zwembad']);
  assert.deepEqual(locationReminders().map((r) => r.place_id), [placeId('Werk')], 'de herinnering op Thuis is mee verwijderd');
  await closeDialog();
  step('een plaats verwijderen: de vraag noemt het aantal herinneringen, en die verdwijnen mee (ook op de server)');

  // ---- de Android-brug, nagebootst ----
  const stub = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      const log = (name, args) => { const l = JSON.parse(sessionStorage.getItem('android-calls') || '[]'); l.push([name, ...args]); sessionStorage.setItem('android-calls', JSON.stringify(l)); };
      window.__geo = { enabled: false, precise: false, approximate: false, background: false, servicesOn: true, running: false, needed: true, declined: false, hasGps: true, lastCheckAt: 0, lastFixAt: 0, accuracy: null, places: [] };
      window.TickoryAndroid = {
        setSession: (t) => log('setSession', [t]), remindersChanged: () => log('remindersChanged', []), widgetsChanged: () => {},
        notificationStatus: () => JSON.stringify({ notifications: true, exactAlarms: true, batteryOptimized: false, appVersion: '0.3.0-test' }),
        locationStatus: () => JSON.stringify(window.__geo),
        requestLocationPermission: () => log('requestLocationPermission', []),
        setLocationEnabled: (on) => log('setLocationEnabled', [on]),
        checkLocationNow: () => log('checkLocationNow', []),
        openLocationSettings: () => log('openLocationSettings', []),
        requestCurrentPosition: () => { log('requestCurrentPosition', []); setTimeout(() => window.dispatchEvent(new CustomEvent('tickory-position', { detail: { lat: 52.1, lon: 5.2, accuracy: 9 } })), 50); },
      };
    })();` });
  await evaluate(`sessionStorage.removeItem('android-calls')`);
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready')`, 'app opnieuw gestart met de Android-brug');
  await waitFor(SYNCED, 'gesynchroniseerd');
  const calls = () => evaluate<any[][]>(`JSON.parse(sessionStorage.getItem('android-calls') || '[]')`);
  const names = async () => (await calls()).map((x) => x[0]).filter((n) => !['setSession', 'remindersChanged'].includes(n));
  await openPlaces();
  text = await dialogText();
  assert.ok(text.includes('De locatiecontrole staat uit.') && !text.includes('In de browser werken herinneringen op een plek niet'), 'in de app: de status van de locatiecontrole, niet de browser-uitleg');
  await clickText('Locatiecontrole aanzetten', `document.querySelector('dialog[open]')`);
  assert.deepEqual(await names(), ['requestLocationPermission']);
  // "gebruik mijn huidige positie" loopt via de app
  await typeInto(field('place-name'), 'Fietsenstalling');
  await click(field('place-here'));
  await waitFor(`document.querySelector(${js(field('place-lat'))}).value === '52.1'`, 'positie van de app ingevuld');
  assert.equal(await value('place-lon'), '5.2');
  assert.ok((await names()).includes('requestCurrentPosition'));
  await typeInto(field('place-name'), '');
  // de app meldt dat alles aan staat
  await evaluate(`Object.assign(window.__geo, { enabled: true, precise: true, background: true, running: true, lastCheckAt: Date.now() - 60000, lastFixAt: Date.now() - 60000, accuracy: 18, places: ${js([{ id: placeId('Werk'), name: 'Werk', distance: 320, inside: false }])} }); window.dispatchEvent(new Event('tickory-android-status'))`);
  await waitFor(`document.querySelector('dialog[open]').textContent.includes('De locatiecontrole staat aan en let op je plaatsen.')`, 'status: aan');
  text = await dialogText();
  assert.ok(text.includes('Laatste controle:') && text.includes('nauwkeurigheid ongeveer 18 m'), 'laatste controle en nauwkeurigheid');
  assert.ok(text.includes('320 m van hier'), 'afstand tot de plaats');
  await clickText('Controleer nu', `document.querySelector('dialog[open]')`);
  assert.ok((await names()).includes('checkLocationNow'));
  await shot('plaatsen-android');
  // uitgezet door de gebruiker
  await clickText('Uitzetten', `document.querySelector('dialog[open]')`);
  assert.ok((await calls()).some((x) => x[0] === 'setLocationEnabled' && x[1] === false));
  // toestemming ontbreekt
  await evaluate(`Object.assign(window.__geo, { enabled: true, precise: false, approximate: true, background: false, running: false }); window.dispatchEvent(new Event('tickory-android-status'))`);
  await waitFor(`document.querySelector('dialog[open]').textContent.includes('alleen bij benadering')`, 'uitleg bij een benaderde locatie');
  await evaluate(`Object.assign(window.__geo, { precise: true, approximate: false, background: false }); window.dispatchEvent(new Event('tickory-android-status'))`);
  await waitFor(`document.querySelector('dialog[open]').textContent.includes('Altijd toestaan')`, 'uitleg over Altijd toestaan');
  await closeDialog();
  step('Android-brug: Plaatsen toont de status van de locatiecontrole (aan/uit, toestemming, laatste controle, afstand tot je plaatsen), Controleer nu en Uitzetten, en "gebruik mijn huidige positie" loopt via de app');

  // de eerste locatieherinnering vraagt (pas dan) om de toestemming, en een weigering wordt niet steeds herhaald
  await evaluate(`sessionStorage.removeItem('android-calls'); Object.assign(window.__geo, { enabled: false, precise: false, approximate: false, background: false, declined: false, running: false })`);
  await openTask('Bellen met de buren');
  await waitFor(`document.querySelector('#task-dialog[open] section[aria-label="Herinneringen"]')`, 'taakvenster');
  await setSelect('#task-dialog select[aria-label="Wanneer?"]', 'place');
  assert.ok((await evaluate<string>(`document.querySelector('#task-dialog [data-role="reminder-place-note"]').textContent`)).includes('De Android-app let op je plaats'), 'in de app een andere hint dan in de browser');
  await setSelect('#task-dialog [data-role="reminder-place"]', placeId('Zwembad'));
  await setSelect('#task-dialog [data-role="reminder-trigger"]', 'enter');
  assert.deepEqual(await names(), [], 'tot hier is er nergens om locatie gevraagd');
  await clickText('Herinnering toevoegen', `document.querySelector('#task-dialog')`);
  await waitFor(`JSON.parse(sessionStorage.getItem('android-calls') || '[]').some((x) => x[0] === 'requestLocationPermission')`, 'toestemming gevraagd na de eerste locatieherinnering');
  await evaluate(`sessionStorage.removeItem('android-calls'); window.__geo.declined = true`);
  await setSelect('#task-dialog [data-role="reminder-place"]', placeId('Supermarkt'));
  await clickText('Herinnering toevoegen', `document.querySelector('#task-dialog')`);
  await sleep(400);
  assert.deepEqual(await names(), [], 'na een weigering vragen we niet opnieuw bij de volgende herinnering');
  await clickText('Annuleren', `document.querySelector('#task-dialog')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'taakvenster gesloten');
  await waitFor(SYNCED, 'gesynchroniseerd');
  await waitFor(`JSON.parse(sessionStorage.getItem('android-calls') || '[]').some((x) => x[0] === 'remindersChanged')`, 'de app hoort van de nieuwe herinneringen op een plek', 8000);
  step('Android-brug: de eerste herinnering op een plek laat de app om locatietoestemming vragen (met uitleg aan de kant van de app); na een weigering niet opnieuw');

  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stub.identifier });
  await evaluate(`sessionStorage.removeItem('android-calls')`);
  await send('Emulation.setGeolocationOverride', {}); // weer geen nagebootste positie
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready')`, 'app opnieuw gestart zonder brug');
  await waitFor(SYNCED, 'gesynchroniseerd');
}
