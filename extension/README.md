# Tickory: pagina als taak opslaan (browserextensie)

Een extensie voor Chrome, Edge en Firefox (Manifest V3) die de pagina die je leest, een link of geselecteerde tekst als taak in je
eigen Tickory opslaat. Zonder bibliotheken en zonder bundler; ze praat alleen met de server die de gebruiker kiest. Uitleg voor
gebruikers staat in de handleiding (pagina "Browserextensie"); het ontwerp in [SPEC.md](../SPEC.md), hoofdstuk 8a.

## Indeling

| Bestand | Wat |
|---|---|
| `manifest.json` | Het manifest voor Chrome en Edge, zonder versie (die komt bij het bouwen uit `package.json`); het manifest voor Firefox maakt `scripts/build-extension.ts` ervan |
| `popup.html`, `popup.js` | Het venster "Opslaan in Tickory" (pictogram, sneltoets `Alt+Shift+K`, contextmenu) |
| `options.html`, `options.js` | Verbinden: adres, toestemming voor die host, inloggen (wachtwoord met de tweede stap, of een koppelcode), uitloggen |
| `background.js` | Het contextmenu, en bij installeren de instellingen openen; geen netwerkverkeer |
| `core/` | De logica zonder browser-API's, met tests in node: `address.js` (adres en de http-regel, gelijk aan de Android-app), `connect.js`, `model.js` (voorvullen, keuzelijst, snelle invoer, commando's, opnieuw proberen), `api.js` (de verzoeken), `errors.js` (foutteksten), `i18n.js` |
| `_locales/en`, `_locales/nl` | De teksten; Engels is de standaard (`default_locale`) |
| `ui.css` | De stijl van beide pagina's, licht en donker |
| `*.test.js`, `build.test.js` | Tests (gaan niet mee in de zip) |

De snelle invoer is die van de web-app: bij het bouwen gaan `client/core/quickadd.js` en alles wat het importeert ongewijzigd mee naar
`lib/` (met hun eigen mappen, zodat de relatieve imports als ES-modules werken). Pas de herkenning dus aan in `client/core/`, niet hier.

## Bouwen en uitgepakt laden

```sh
node scripts/build-extension.ts
```

Dat maakt in `dist/`:

- `extension/chrome/` en `extension/firefox/`: de uitgepakte extensie per browser;
- `tickory-extension-<versie>.zip` (Chrome Web Store, Edge Add-ons) en `tickory-extension-<versie>-firefox.zip` (Mozilla).

De zip is reproduceerbaar (vaste volgorde en tijd): dezelfde bron geeft dezelfde zip. De workflow `Android-app en browserextensie`
(`.github/workflows/android.yml`) bouwt ze bij een tag `v*` en hangt ze aan de GitHub Release.

**Chrome en Edge.** Open `chrome://extensions` of `edge://extensions`, zet *Ontwikkelaarsmodus* aan, kies *Uitgepakte extensie laden* en
kies `dist/extension/chrome`. Na opnieuw bouwen: *Opnieuw laden* bij de extensie (de verbinding blijft bewaard).

**Firefox.** Open `about:debugging#/runtime/this-firefox`, kies *Tijdelijke add-on laden…* en kies `dist/extension/firefox/manifest.json`
(of de Firefox-zip). Zo'n tijdelijke add-on verdwijnt als Firefox sluit. Blijvend installeren kan alleen met een extensie die Mozilla
heeft ondertekend, ook als je haar niet openbaar maakt (zie hieronder). Firefox 140 of nieuwer.

## Testen

```sh
node --test extension/ server/pairing.http.test.ts   # de logica, het manifest, de zip en de koppelcodes (zit ook in npm test)
npm run e2e:extension                                 # in een echte browser, 12 stappen (Edge of Chrome, zonder venster)
```

De e2e laadt de extensie uitgepakt met `Extensions.loadUnpacked` en opent het venster met `Extensions.triggerAction`, via het
DevTools-protocol over een pipe (de vlag `--load-extension` werkt in de merkversies van Chrome en Edge niet meer). Een browser zonder
venster kan de vraag om toestemming voor de host niet tonen: daarom gebruikt de test een aparte bouw (`chrome-test`, alleen in de
werkmap van de test) met een vaste toestemming voor `http://127.0.0.1`. Het echte contextmenu is niet aan te klikken; de test roept de
functie erachter aan in de service worker. Firefox zelf wordt niet automatisch getest.

## Publiceren (doet de eigenaar zelf)

Elke winkel vraagt een eigen account van de uitgever, en elke nieuwe versie moet een hoger versienummer hebben (dat komt uit
`package.json`). Gebruik de zip van de GitHub Release of van `node scripts/build-extension.ts`.

### Chrome Web Store

1. Maak een ontwikkelaarsaccount in het [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) (eenmalig
   registratiegeld) en bevestig je e-mailadres.
2. *Nieuw item*: upload `tickory-extension-<versie>.zip`.
3. Vul de vermelding in: beschrijving (zie hieronder), categorie *Productiviteit*, het pictogram van 128 punten zit in de zip,
   schermafbeeldingen van 1280 x 800 of 640 x 400 (het venster en de instellingen; `npm run e2e:extension` maakt er een paar in
   `.e2e-ext/shots/`, die je als basis kunt gebruiken).
4. *Privacy*: één doel ("een webpagina als taak opslaan in je eigen Tickory-server"), de rechtvaardiging per recht (de tabel hieronder),
   en bij gegevensgebruik: *websitecontent* en *webgeschiedenis* (het adres van de pagina die je opslaat) en *authenticatiegegevens*,
   alleen verstuurd naar de server die de gebruiker zelf instelt, niet verkocht en niet voor iets anders gebruikt. Een privacybeleid is
   verplicht: verwijs naar het deel "Privacy en rechten" van de handleiding.
5. Kies de zichtbaarheid (openbaar, niet vermeld, of alleen voor testers) en dien in voor beoordeling. Een brede
   `optional_host_permissions` (`https://*/*`, `http://*/*`) kan om uitleg vragen: de extensie vraagt pas bij het verbinden toegang tot
   precies het adres van de eigen server, omdat elke gebruiker een ander adres heeft.

### Microsoft Edge Add-ons

Maak een (gratis) account in [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview) voor Edge, kies *Nieuwe
extensie*, upload dezelfde zip als voor Chrome en vul dezelfde gegevens in.

### Firefox Add-ons (addons.mozilla.org)

1. Maak een account op [addons.mozilla.org](https://addons.mozilla.org/developers/) en kies *Submit a New Add-on*.
2. Kies *On this site* (openbaar in de winkel) of *On your own* (niet vermeld: Mozilla ondertekent alleen, jij verspreidt het bestand
   zelf; ook dat is nodig om de extensie blijvend in Firefox te installeren).
3. Upload `tickory-extension-<versie>-firefox.zip`.
4. **Broncode.** Mozilla vraagt de bron van code die gegenereerd of gebundeld is. Dat geldt voor `lib/client/vendor/nlDatum.generated.js`:
   een bundel van chrono-node 2.10.3 (MIT) met een eigen Nederlandse laag, gemaakt in een eerder project. Lever de broncode van de
   repo bij die tag mee met deze uitleg (Node 26, `node scripts/build-extension.ts`, geen andere stappen), en voor die ene bundel de
   bron waaruit hij gemaakt is. Die bron staat niet in deze repo; zorg dat je hem bij de hand hebt voordat je indient.
5. De id `tickory@tickory.invalid` staat in het manifest (`browser_specific_settings.gecko.id`, in `scripts/build-extension.ts`).
   Wil je een andere id, wijzig hem dan vóór de eerste indiening: daarna hoort elke versie dezelfde id te hebben. Gebruik geen naam
   of e-mailadres van een persoon.
6. Mozilla vraagt bij nieuwe extensies welke gegevens ze versturen (`data_collection_permissions`): staat in het manifest als
   `browsingActivity`, `websiteContent` en `authenticationInfo`, alleen naar de eigen server van de gebruiker.

Met het programma `web-ext` van Mozilla kan het ook vanaf de opdrachtregel (`web-ext sign --channel=unlisted`, met je API-sleutels
van AMO); dat is een pakket van derden en hoort daarom niet bij deze repo.

### Teksten voor de winkels

Korte beschrijving: *Bewaar de pagina, een link of geselecteerde tekst als taak op je eigen Tickory-server.* (Engels: *Save the page, a
link or selected text as a task on your own Tickory server.*)

| Recht | Rechtvaardiging |
|---|---|
| `activeTab` | De titel, het adres en de selectie van het tabblad waarop de gebruiker de extensie zelf opent (pictogram, sneltoets, contextmenu) |
| `scripting` | Alleen om de geselecteerde tekst van dat tabblad te lezen (`getSelection()`), niets anders |
| `contextMenus` | Het menu-item "Opslaan in Tickory" op een pagina, link of selectie |
| `storage` | Het adres van de eigen server, het sessietoken van de extensie en de projectenlijst, lokaal (niet gesynchroniseerd) |
| `optional_host_permissions` | Pas bij het verbinden gevraagd, voor precies de host van de eigen server van de gebruiker (elke gebruiker heeft een ander adres) |

## Wat (nog) niet kan

- Niet gepubliceerd in de winkels (dat doet de eigenaar, zie hierboven); in Firefox dus alleen tijdelijk te laden.
- Getest in Edge (e2e) en in node; Firefox en Chrome zelf, en een klik in het echte contextmenu en op de toestemmingsvraag, niet automatisch.
- Geen wachtrij zonder verbinding (opnieuw proberen geeft nooit een dubbele taak), geen schermafbeelding of bijlage bij de taak, geen Safari
  en geen browsers op een telefoon.
