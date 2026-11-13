# eigen-tool

Persoonlijke, offline-first takenapp: een sync-server en een installeerbare web-app (PWA) in één Docker-container. Het protocol staat in [SPEC.md](SPEC.md); het is een eigen ontwerp, gebouwd op de bevindingen van een eerder onderzoek naar de werking van Todoist (niet onderdeel van deze repo).

Geen npm-pakketten en geen build-stap: Node 26 voert de TypeScript zelf uit en SQLite zit in Node. De image is daardoor klein en heeft vrijwel niets om te onderhouden.

## Draaien op je home server (Docker)

Je hebt Docker met `docker compose` nodig. De image is er voor `amd64` (gewone pc, mini-pc, NAS) en `arm64` (Raspberry Pi met 64-bit systeem; 32-bit wordt niet ondersteund).

```sh
git clone https://github.com/<jouw-github-naam>/eigen-tool.git
cd eigen-tool
cp .env.example .env
```

1. **Token.** Zet in `.env` een geheim token van minimaal 24 tekens, bijvoorbeeld de uitvoer van `openssl rand -base64 32`. Het geeft toegang tot al je taken: deel het niet en zet `.env` nooit in git (het staat al in `.gitignore`).
2. **Image.** Open `docker-compose.yml` en vul in de regel `image:` je GitHub-naam in. Liever zelf bouwen op de server? Haal dan de regel `image:` weg en zet `build: .` terug.
3. **Starten.**

   ```sh
   docker compose up -d
   docker compose ps          # na enkele seconden: (healthy)
   docker compose logs -f
   ```

De container is standaard alleen bereikbaar vanaf de server zelf (`127.0.0.1:8787`). Daarvoor staat er **HTTPS** voor, zie hieronder. Wil je het alleen op je thuisnetwerk gebruiken en zonder HTTPS (dan werkt alleen de computer-browser, zie de opmerking bij HTTPS), maak er dan `"8787:8787"` van en open `http://<ip-van-de-server>:8787`.

Open de app, vul het token één keer in, en je kunt beginnen.

### HTTPS (nodig voor je telefoon)

Browsers staan **offline gebruik** (service worker) en **installeren als app** alleen toe via HTTPS; alleen `localhost` is een uitzondering. Zonder HTTPS werkt de app op je telefoon dus wel in de browser, maar niet offline en niet als geïnstalleerde app. Kies wat bij je netwerk past:

- **Tailscale** (het eenvoudigst, niets openbaar): installeer Tailscale op server en telefoon, schakel HTTPS in je tailnet in en draai op de server `tailscale serve --bg 8787`. Je krijgt een `https://…ts.net`-adres dat alleen je eigen apparaten bereiken.
- **Reverse proxy met een eigen domein** (Caddy, Traefik, Nginx Proxy Manager): laat de proxy naar `127.0.0.1:8787` wijzen en het certificaat regelen. Met Caddy is de hele configuratie:

  ```
  taken.voorbeeld.nl {
      reverse_proxy 127.0.0.1:8787
  }
  ```

- **Cloudflare Tunnel**: handig als je geen poorten wilt openzetten.

Zet de app niet zonder HTTPS op het open internet: het token reist dan onversleuteld.

### Bijwerken

Zet je als beheerder een nieuwe versie-tag (zie hieronder), dan bouwt GitHub een nieuwe image. Op de server:

```sh
docker compose pull && docker compose up -d
```

Je gegevens staan in een Docker-volume en blijven behouden. Bouw je zelf: `git pull && docker compose up -d --build --pull always`. Let op: een nieuwe versie van de onderliggende Node-image (beveiligingsupdates) komt pas binnen als er een nieuwe image wordt gebouwd.

### Back-up en terugzetten

De database is één SQLite-bestand in het volume. Maak een consistente kopie terwijl de app draait:

```sh
docker compose exec -T eigen-tool node server/backup.ts /data/backups/todo-$(date +%F).db
```

Dit overschrijft nooit een bestaande kopie. De kopieën staan in het volume zelf; haal ze regelmatig ook van de server af, bijvoorbeeld met `docker cp eigen-tool:/data/backups ./backups`, en plan het commando in met `cron`. Oude kopieën ruim je zelf op.

Terugzetten van een kopie (de app moet stilstaan; vervang `backup.db` door je bestand):

```sh
docker compose down
docker run --rm -v eigen-tool_eigen-tool-data:/data -v "$PWD":/backup alpine sh -c \
  "rm -f /data/todo.db-wal /data/todo.db-shm && cp /backup/backup.db /data/todo.db && chown 1000:1000 /data/todo.db"
docker compose up -d
```

De volumenaam begint met de naam van de map waarin je `docker compose` draait (hier `eigen-tool`); controleer hem met `docker volume ls`. **Meld daarna op elk apparaat af en weer aan** (Instellingen, "Afmelden en lokale gegevens wissen"). Een apparaat dat nog nieuwere wijzigingen kende dan de back-up merkt het teruggezette bestand alleen vanzelf op zolang de server nog niet voorbij zijn stand is gegroeid; opnieuw aanmelden is de zekere weg en kost niets, omdat alles op de server staat.

### Privé repo of image

Staat de repo of de image op privé (het begin), dan moet je server eenmalig inloggen om te kunnen pullen en clonen:

```sh
docker login ghcr.io -u <jouw-github-naam>     # wachtwoord: een token met alleen "read:packages"
```

Wil je het zonder inloggen kunnen ophalen, maak dan de repo en het pakket openbaar (er staan geen geheimen in; je token zit alleen in je eigen `.env`). Het pakket zet je om via GitHub: je profiel, Packages, `eigen-tool`, Package settings, Change visibility.

## Een nieuwe versie publiceren (beheerder)

```sh
git tag v0.1.1 && git push origin v0.1.1
```

De workflow `Image publiceren` draait de tests, bouwt de image, **start hem met de beveiligingsinstellingen uit `docker-compose.yml` en controleert zijn gedrag** (gezond, juiste gebruiker, alleen `/data` beschrijfbaar, gegevens overleven een herstart, netjes stoppen, back-up werkt), en publiceert daarna `ghcr.io/<jouw-github-naam>/eigen-tool` met de tags `0.1.1`, `0.1` en `latest`. Slaagt één controle niet, dan wordt er niets gepubliceerd.

## Snel toevoegen

Typ één regel in het invoerveld; onder het veld zie je wat er herkend is.

```
Tandarts bellen morgen om 9 uur #Thuis /Keuken @bellen p1
Planten water geven elke vrijdag
Aangifte doen {31-12} !!2
~Mei bellen          (het ~ zet de datumherkenning voor de hele regel uit)
```

`#project`, `/sectie` (binnen dat project), `@label` (onbekende labels worden aangemaakt), `p1` tot `p4` of `!!1` tot `!!4` (1 is de hoogste), `{deadline}`, en een datum of herhaling in gewone taal ("volgende week donderdag", "elke ma en do", "om de week", "elke laatste dag van de maand").

## Lokaal draaien zonder Docker

Vereist Node 26. Handig om te proberen of te ontwikkelen.

```sh
export TODO_TOKEN=$(node server/main.ts --new-token)    # bash; toon met: echo "$TODO_TOKEN"
node server/main.ts                                      # http://127.0.0.1:8787
```

Op Windows: dubbelklik op `start.cmd`, of draai `.\start.cmd` in PowerShell. Dat maakt bij de eerste keer een token aan in `data\token.txt`, toont het, en start de server; het scriptbeleid van Windows blijft ongewijzigd (zie `start.cmd`). Omgevingsvariabelen: `TODO_TOKEN` (verplicht, minimaal 24 tekens), `PORT` (8787), `HOST` (127.0.0.1; in Docker 0.0.0.0), `DB_PATH` (`./data/todo.db`; in Docker `/data/todo.db`), `CORS_ORIGIN` (optioneel, één exacte oorsprong).

## Testen

```sh
npm test            # protocol, server, client, datumtaal, overzichten, back-up, offline-bestanden
npm run e2e         # de hele app in een echte browser (Edge of Chrome, zonder venster), 14 stappen
node scripts/docker-smoke.ts eigen-tool:ci    # test van de image (vereist Docker, na: docker build -t eigen-tool:ci .)
```

De tests omvatten onder meer een eigenschappentest voor de volgordesleutels en een **differentiële test**: honderden willekeurige handelingen worden zowel optimistisch in de client als door de echte server-engine uitgevoerd, en beide moeten op exact dezelfde toestand uitkomen. Ze slagen in elke tijdzone. De browsertest legt schermafbeeldingen vast in `.e2e/shots/`.

## Indeling

```
shared/    orderKey.js, recurrence.js, schema.js        gedeeld door server en client
server/    schema.ts, sync.ts, main.ts, backup.ts       tabellen, sync-engine, HTTP + SSE + bestanden, back-up
client/    index.html, app.css, sw.js, manifest         de web-app
client/core/   reducer, store, idb, syncClient, events, actions, dateNl, quickadd, selectors, format
client/ui/     app, render, taskDialog, dom
client/vendor/ nlDatum.generated.js                     Nederlandse datumherkenner (met chrono-node, zie THIRD_PARTY_NOTICES.md)
scripts/       e2e.ts, docker-smoke.ts, smoke.ts, make-icons.js, start.ps1
```

## Status

Werkt voor eigen gebruik: taken, projecten (met subprojecten), secties, subtaken, labels, prioriteiten, deadlines, herhalingen, Vandaag en Binnenkort, offline werken met synchronisatie, meerdere apparaten tegelijk, installeren als app. Nog te bouwen: filtertaal, herinneringen als meldingen, een Android-schil, Vandaag-volgorde (zie SPEC.md hoofdstuk 10).

## Licentie

Voor de eigen code is nog geen licentie gekozen. Voor de meegebundelde datumherkenning geldt de MIT-licentie van chrono-node, zie [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
