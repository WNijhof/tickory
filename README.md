# Tickory

Zelf te hosten, offline-first takenapp voor jezelf, je gezin of een klein team: een sync-server en een installeerbare web-app (PWA) in één Docker-container. Meerdere gebruikers, gedeelde projecten, taken toewijzen. Het protocol staat in [SPEC.md](SPEC.md); het is een eigen ontwerp, gebouwd op de bevindingen van een eerder onderzoek naar de werking van Todoist (niet onderdeel van deze repo).

Geen npm-pakketten en geen build-stap: Node 26 voert de TypeScript zelf uit en SQLite zit in Node. De image is daardoor klein en heeft vrijwel niets om te onderhouden.

## Draaien op je home server (Docker)

Je hebt Docker met `docker compose` nodig. De image is er voor `amd64` (gewone pc, mini-pc, NAS) en `arm64` (Raspberry Pi met 64-bit systeem; 32-bit wordt niet ondersteund).

```sh
git clone https://github.com/WNijhof/tickory.git
cd tickory
cp .env.example .env
```

1. **Eerste account.** Zet in `.env` de gebruikersnaam en het wachtwoord (minimaal 10 tekens) van het eerste account, `TODO_ADMIN_USER` en `TODO_ADMIN_PASSWORD`. Dat account wordt bij de allereerste start aangemaakt en is **beheerder**: daarmee maak je daarna in de app de andere accounts aan. Zet `.env` nooit in git (het staat al in `.gitignore`). Na de eerste start kun je het wachtwoord uit `.env` halen; het wordt dan niet meer gebruikt.
2. **Image.** Open `docker-compose.yml` en vul in de regel `image:` je GitHub-naam in. Liever zelf bouwen op de server? Haal dan de regel `image:` weg en zet `build: .` terug.
3. **Starten.**

   ```sh
   docker compose up -d
   docker compose ps          # na enkele seconden: (healthy)
   docker compose logs -f
   ```

De container is standaard alleen bereikbaar vanaf de server zelf (`127.0.0.1:8787`). Daarvoor staat er **HTTPS**, zie hieronder. Wil je het alleen op je thuisnetwerk gebruiken en zonder HTTPS (dan werkt alleen de computer-browser, zie de opmerking bij HTTPS), maak er dan `"8787:8787"` van en open `http://<ip-van-de-server>:8787`.

Open de app en log in met het eerste account.

### Accounts en gebruikers

- **In de app:** Instellingen, "Account, wachtwoord en apparaten". Daar wijzig je je wachtwoord en zie je op welke apparaten je bent aangemeld (en meld je er een af). Als beheerder staat daar ook "Gebruikersbeheer": accounts aanmaken, blokkeren, beheerder maken en wachtwoorden herstellen.
- **Vanaf de server**, bijvoorbeeld als je je wachtwoord kwijt bent:

  ```sh
  docker compose exec tickory node server/main.ts user list
  docker compose exec -e TODO_PASSWORD='een-goed-wachtwoord' tickory node server/main.ts user add anna --name "Anna de Vries"
  docker compose exec -it tickory node server/main.ts user passwd anna        # vraagt om het wachtwoord, ongezien
  docker compose exec tickory node server/main.ts user disable anna           # of: enable, logout-all
  ```

  Met `--admin` achter `user add` maak je een beheerder. Zonder `TODO_PASSWORD` en zonder terminal (`-it`) kan er geen wachtwoord worden gevraagd.
- Er is geen open registratie en geen wachtwoordherstel per e-mail: een beheerder maakt accounts aan en herstelt wachtwoorden. Er blijft altijd minstens één actieve beheerder.
- Elk apparaat krijgt bij het inloggen een eigen sessie die je kunt intrekken. Na tien keer een fout wachtwoord op een account (of veertig vanaf één adres) is inloggen een kwartier geblokkeerd.
- Een beheerder beheert accounts, niet andermans taken: ook een beheerder ziet alleen projecten waar die zelf lid van is.

### Delen en samenwerken

- Open een project, kies **Delen**, en typ de gebruikersnaam van iemand anders van deze server. Die persoon ziet het project met alles erin (ook wat er al stond), en iedereen werkt in dezelfde taken, secties en subprojecten. Wie het project maakte is **eigenaar**; de anderen zijn **lid**.
- De eigenaar kan delen, mensen eruit halen, het project verplaatsen en verwijderen. Een lid kan in het project werken en er zelf uit gaan ("Project verlaten"). Een eigenaar kan niet weg zonder het project te verwijderen.
- Taken kun je **toewijzen** aan een lid ("voor Bob"). Verlaat of verdwijnt iemand, dan vervalt de toewijzing.
- Je **Inbox** is van jou alleen en kan niet worden gedeeld.
- **Persoonlijk blijft:** herinneringen, filters en labels. Labels die iemand anders op een taak in een gedeeld project zet, zie je wel (als `@label`), maar je kunt ze niet wijzigen of verwijderen.
- Subprojecten van een gedeeld project worden mee gedeeld. Verwijder je een project, dan blijft een subproject waar je geen eigenaar van bent staan, op het hoogste niveau.
- Bekende beperking: de **volgorde in de zijbalk** en het markeren als favoriet horen bij het project en zijn dus niet per persoon.

### Upgraden vanaf versie 0.1

Versie 0.1 had één token voor één persoon. Zet in `.env` `TODO_ADMIN_USER` en `TODO_ADMIN_PASSWORD` (je mag `TODO_TOKEN` weghalen), en start de nieuwe versie. Bij de eerste start wordt dat account aangemaakt en **neemt het alle bestaande gegevens over** (projecten, labels, filters, herinneringen), inclusief je Inbox. Daarna moet je op elk apparaat opnieuw inloggen. Maak vooraf een back-up (zie hieronder).

### HTTPS (nodig voor je telefoon)

Browsers staan **offline gebruik** (service worker) en **installeren als app** alleen toe via HTTPS; alleen `localhost` is een uitzondering. Zonder HTTPS werkt de app op je telefoon dus wel in de browser, maar niet offline en niet als geïnstalleerde app. Kies wat bij je netwerk past:

- **Tailscale** (het eenvoudigst, niets openbaar): installeer Tailscale op server en telefoon, schakel HTTPS in je tailnet in en draai op de server `tailscale serve --bg 8787`. Je krijgt een `https://…ts.net`-adres dat alleen je eigen apparaten bereiken.
- **Reverse proxy met een eigen domein** (Caddy, Traefik, Nginx Proxy Manager): laat de proxy naar `127.0.0.1:8787` wijzen en het certificaat regelen. Met Caddy is de hele configuratie:

  ```
  taken.voorbeeld.nl {
      reverse_proxy 127.0.0.1:8787
  }
  ```

  Zet daarbij in `.env` `TRUST_PROXY=1`, zodat het adres van de bezoeker (en niet dat van de proxy) telt bij het beperken van inlogpogingen. Zet dit **alleen** aan als er echt een proxy voor staat: anders kan een bezoeker zijn eigen adres opgeven.
- **Cloudflare Tunnel**: handig als je geen poorten wilt openzetten.

Zet de app niet zonder HTTPS op het open internet: wachtwoord en sessie reizen dan onversleuteld.

### Bijwerken

Zet je als beheerder een nieuwe versie-tag (zie hieronder), dan bouwt GitHub een nieuwe image. Op de server:

```sh
docker compose pull && docker compose up -d
```

Je gegevens staan in een Docker-volume en blijven behouden. Bouw je zelf: `git pull && docker compose up -d --build --pull always`. Let op: een nieuwe versie van de onderliggende Node-image (beveiligingsupdates) komt pas binnen als er een nieuwe image wordt gebouwd.

### Back-up en terugzetten

De database is één SQLite-bestand in het volume. Maak een consistente kopie terwijl de app draait:

```sh
docker compose exec -T tickory node server/backup.ts /data/backups/todo-$(date +%F).db
```

Dit overschrijft nooit een bestaande kopie. De kopieën staan in het volume zelf; haal ze regelmatig ook van de server af, bijvoorbeeld met `docker cp tickory:/data/backups ./backups`, en plan het commando in met `cron`. Oude kopieën ruim je zelf op. **Een kopie bevat alle taken van alle gebruikers, de wachtwoord-hashes en de (gehashte) sessies**: bewaar hem zoals je de database zelf bewaart.

Terugzetten van een kopie (de app moet stilstaan; vervang `backup.db` door je bestand):

```sh
docker compose down
docker run --rm -v tickory_tickory-data:/data -v "$PWD":/backup alpine sh -c \
  "rm -f /data/todo.db-wal /data/todo.db-shm && cp /backup/backup.db /data/todo.db && chown 1000:1000 /data/todo.db"
docker compose up -d
```

De volumenaam begint met de naam van de map waarin je `docker compose` draait (hier `tickory`); controleer hem met `docker volume ls`. **Meld daarna op elk apparaat af en weer aan** (Instellingen, "Afmelden en lokale gegevens wissen"). Een apparaat dat nog nieuwere wijzigingen kende dan de back-up merkt het teruggezette bestand alleen vanzelf op zolang de server nog niet voorbij zijn stand is gegroeid; opnieuw aanmelden is de zekere weg en kost niets, omdat alles op de server staat.

### Privé repo of image

Staat de repo of de image op privé (het begin), dan moet je server eenmalig inloggen om te kunnen pullen en clonen:

```sh
docker login ghcr.io -u <jouw-github-naam>     # wachtwoord: een token met alleen "read:packages"
```

Wil je het zonder inloggen kunnen ophalen, maak dan de repo en het pakket openbaar (er staan geen geheimen in; wachtwoorden en accounts zitten alleen in je eigen `.env` en database). Het pakket zet je om via GitHub: je profiel, Packages, `tickory`, Package settings, Change visibility.

## Een nieuwe versie publiceren (beheerder)

```sh
git tag v0.2.0 && git push origin v0.2.0
```

De workflow `Image publiceren` draait de tests, bouwt de image, **start hem met de beveiligingsinstellingen uit `docker-compose.yml` en controleert zijn gedrag** (gezond, juiste gebruiker, alleen `/data` beschrijfbaar, het eerste account en een tweede account, gescheiden gegevens, gegevens overleven een herstart, netjes stoppen, back-up werkt), en publiceert daarna `ghcr.io/WNijhof/tickory` met de tags `0.2.0`, `0.2` en `latest`. Slaagt één controle niet, dan wordt er niets gepubliceerd.

## Snel toevoegen

Typ één regel in het invoerveld; onder het veld zie je wat er herkend is.

```
Tandarts bellen morgen om 9 uur #Thuis /Keuken @bellen p1
Oud papier elke tweede dinsdag
Verjaardag Jan elk jaar op 5 december
Cadeau kopen voor Sinterklaas
Belasting regelen eind januari
Hardlopen elke ochtend om 7 uur
Aangifte doen {31-12} !!2
~Mei bellen          (het ~ zet de datumherkenning voor de hele regel uit)
```

`#project`, `/sectie` (binnen dat project), `@label` (onbekende labels worden aangemaakt), `p1` tot `p4` of `!!1` tot `!!4` (1 is de hoogste), `{deadline}`, en een datum of herhaling in gewone taal.

## Nederlands

Nederlands is de hoofdtaal van de app: de interface, de datumtaal en de foutmeldingen zijn Nederlands en er is geen Engelse terugval. Wat werkt:

- **Datums:** `morgen`, `overmorgen`, `vanavond`, `volgende week donderdag`, `aanstaande vrijdag`, `over twee weken`, `eind van de week`, `deze week` (= vrijdag), `25 december`, `3 maart 2027`, `begin december`, `midden mei`, `eind januari`, en tijden als `om 9 uur`, `om half 3`, `kwart over 2`, `14u30`, `2 uur 's middags`, `over een kwartier`.
- **Herhalingen:** `elke dag`, `elke maandag`, `elke ma en do`, `elke werkdag`, `doordeweeks`, `elke 2 weken`, `om de week`, `elke ochtend/middag/avond` (met een standaardtijd van 9, 15 en 20 uur, tenzij je er een tijd bij zet), `elke maand op de 15e`, `elke laatste dag van de maand`, `elk jaar op 5 december`, en de **n-de weekdag van de maand**: `elke eerste maandag`, `elke tweede dinsdag`, `elke laatste vrijdag` (eerste tot en met vierde, en laatste).
- **Feestdagen**, met een voorzetsel (`voor`, `tegen`, `op`, `uiterlijk`, `per`): Kerst en de eerste en tweede kerstdag, Oud en nieuw, Nieuwjaar, Sinterklaas en pakjesavond, Koningsdag, Bevrijdingsdag, Dodenherdenking, Goede Vrijdag, Pasen en tweede paasdag, Hemelvaart, Pinksteren en tweede pinksterdag. De datum van Pasen wordt voor elk jaar berekend.
- **Letters:** `é`, `ë`, `ï`, `ö` en dergelijke werken overal, hoofdletterongevoelig (`@ÉÉN` is het label `één`) en ook als een toetsenbord ze als losse tekens aflevert. Alle tekst wordt in dezelfde Unicode-vorm (NFC) bewaard, ook gebruikersnamen en wachtwoorden. Na het weghalen van een datum wordt `ijs` correct `IJs` (in het Nederlands is IJ één letter).
- **Meldingen** als de server een wijziging weigert, zijn begrijpelijk Nederlands, met wat je probeerde te doen.

Bewust niet aangeraakt, om geen verkeerde datum te raden: een titel met **twee** datums, een feestdag zonder voorzetsel (`Kerst inkopen doen` blijft een gewone taak), `Mei bellen`, `Zo snel mogelijk`, `Hoofdstuk 3`. Typ `~` voor een woord om de herkenning daar uit te zetten. Niet ondersteund: `elke vijfde dinsdag` (een vijfde bestaat niet altijd; gebruik `elke laatste dinsdag`) en `elke tweede week van de maand`.

## Lokaal draaien zonder Docker

Vereist Node 26. Handig om te proberen of te ontwikkelen.

```sh
TODO_ADMIN_USER=anna TODO_ADMIN_PASSWORD='een-goed-wachtwoord' node server/main.ts      # bash; http://127.0.0.1:8787
```

Op Windows: dubbelklik op `start.cmd`, of draai `.\start.cmd` in PowerShell. Bij de eerste keer vraagt dat om een gebruikersnaam en een wachtwoord (ongezien getypt) voor het eerste account, en daarna start de server; het scriptbeleid van Windows blijft ongewijzigd (zie `start.cmd`).

Omgevingsvariabelen: `TODO_ADMIN_USER`, `TODO_ADMIN_PASSWORD` en `TODO_ADMIN_NAME` (alleen bij de allereerste start), `PORT` (8787), `HOST` (127.0.0.1; in Docker 0.0.0.0), `DB_PATH` (`./data/todo.db`; in Docker `/data/todo.db`), `TRUST_PROXY` (`1` achter een eigen reverse proxy), `CORS_ORIGIN` (optioneel, één exacte oorsprong).

## Testen

```sh
npm test            # protocol, rechten, accounts, server, client, datumtaal, overzichten, back-up, offline-bestanden
npm run e2e         # de hele app in een echte browser (Edge of Chrome, zonder venster), 22 stappen
node scripts/docker-smoke.ts tickory:ci    # test van de image (vereist Docker, na: docker build -t tickory:ci .)
```

De tests omvatten onder meer een eigenschappentest voor de volgordesleutels en een **differentiële test**: honderden willekeurige handelingen worden zowel optimistisch in de client als door de echte server-engine uitgevoerd, en beide moeten op exact dezelfde toestand uitkomen. Voor meerdere gebruikers zijn er aparte tests van wie wat mag zien en doen (twee echte clients op één server), en de toegangsregels zijn gecontroleerd met opzettelijk gebroken code: elke gebroken regel moet een test laten falen. Ze slagen in elke tijdzone. De browsertest legt schermafbeeldingen vast in `.e2e/shots/`.

## Indeling

```
shared/    orderKey.js, recurrence.js, schema.js, text.js   gedeeld door server en client
server/    schema.ts, rows.ts, sync.ts, users.ts, main.ts, backup.ts
           tabellen, rijen, sync-engine met rechten, accounts en sessies, HTTP + SSE + bestanden, back-up
client/    index.html, app.css, sw.js, manifest             de web-app
client/core/   reducer, store, idb, syncClient, events, actions, auth, dateNl, quickadd, selectors, format, messages
client/ui/     app, render, taskDialog, shareDialog, accountDialogs, dom
client/vendor/ nlDatum.generated.js                         Nederlandse datumherkenner (met chrono-node, zie THIRD_PARTY_NOTICES.md)
scripts/       e2e.ts, docker-smoke.ts, smoke.ts, make-icons.js, start.ps1
```

## Status

Versie 0.2: meerdere gebruikers en gedeelde projecten. De kern werkt en is getest; veel functies uit apps als Todoist ontbreken nog.

**Wat de app kan:** meerdere accounts met een eigen Inbox, projecten delen met anderen en taken toewijzen, taken met subtaken, projecten met subprojecten, secties, labels (via snel toevoegen en het bewerkvenster), prioriteiten P1 tot P4, datum en tijd, deadlines, herhalingen, de overzichten Vandaag en Binnenkort, voltooide taken tonen of verbergen, afvinken met ongedaan maken, offline werken met synchronisatie, meerdere apparaten tegelijk, installeren als app, en apparaten en wachtwoorden beheren.

**Nog niet af (in ontwikkeling):**
- **Herinneringen met een melding.** De server kan herinneringen opslaan en synchroniseren, maar de app heeft er nog geen scherm voor en **er wordt nergens een melding verstuurd**.
- **Een Android-app (APK).** Tot die er is, gebruik je de web-app in de browser van je telefoon.

**Staat wel op de server, maar de app heeft er nog geen scherm of knop voor** (je kunt het dus niet gebruiken):
- **Opmerkingen** bij taken en projecten.
- **Filters** (opgeslagen zoekopdrachten): er is geen filtertaal en geen scherm.
- Favorieten, **archiveren** van projecten en secties, de **duur** van een taak, en bord- of kalenderweergave.

**Ontbreekt helemaal:**
- **Slepen of anderszins de volgorde van taken wijzigen.** Een nieuwe taak komt altijd achteraan.
- **Zoeken.**
- **Labels beheren** (hernoemen, verwijderen, op een label filteren).
- Bijlagen, statistieken, sjablonen, import en export, een iCal-feed, sneltoetsen, widgets, een eigen volgorde voor Vandaag, uitnodigen via een link of e-mail, en overdragen van de eigenaar van een project.

Wat erbij komt en in welke volgorde, bepaalt de eigenaar van de repo. Zie ook SPEC.md hoofdstuk 10.

## Licentie

Tickory is vrije software onder de [GNU Affero General Public License, versie 3](LICENSE) (AGPL-3.0). Je mag het gebruiken, aanpassen en verspreiden; wie een aangepaste versie als dienst aan anderen aanbiedt, moet de broncode daarvan beschikbaar stellen. Voor de meegebundelde datumherkenning geldt de MIT-licentie van chrono-node, zie [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
