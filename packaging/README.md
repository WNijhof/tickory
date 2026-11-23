# Pakketten voor app-winkels en catalogi

Tickory klaar om in te dienen bij app-winkels van thuisservers en bij de Android-catalogi. Elke map is een **concept**: de winkels
draaien bij het indienen hun eigen controles, en de formaten veranderen soms. Vergelijk vóór het indienen met een app die er al in
staat, en installeer het pakket eerst zelf (een eigen of community-winkel kan bij alle drie).

Overal draait Tickory als gewone gebruiker (uid 1000), niet als root, met een alleen-lezen container: net als in
`docker-compose.yml`. De map voor `/data` moet beschrijfbaar zijn voor uid 1000; Umbrel doet dat zelf, bij Unraid en CasaOS
staat het in de uitleg.

| Map | Waar | Indienen | Vóór het indienen |
|---|---|---|---|
| `unraid/tickory.xml` | Unraid Community Applications | Formulier op https://ca.unraid.net/submit met de URL van deze repo (het sjabloon moet op `main` staan) | Op een Unraid-server installeren via *Add Container* › *Template* met de TemplateURL |
| `runtipi/tickory/` | Runtipi | Pull request op https://github.com/runtipi/runtipi-appstore (map `apps/tickory/`) | Kiezen tussen `docker-compose.json` (dit concept) en het nieuwere `docker-compose.yml` met `x-runtipi`; een vrije `port` kiezen; testen in een eigen app store |
| `umbrel/tickory/` en `umbrel/gallery/` | umbrelOS | Pull request op https://github.com/getumbrel/umbrel-apps; de afbeeldingen gaan naar de galerij-repo die de README daar noemt | Image vastpinnen op de digest, `submission` invullen, een vrije `port`, de categorie nakijken; testen in een community app store |
| `casaos/tickory/` | CasaOS / ZimaOS | Pull request op https://github.com/IceWhaleTech/CasaOS-AppStore (map `Apps/Tickory/`) | Het formaat van `x-casaos` (v1 of v2) vergelijken met een bestaande app; testen op een eigen CasaOS |
| `fdroid/io.github.wnijhof.tickory.yml` | F-Droid | Merge request op https://gitlab.com/fdroid/fdroiddata als `metadata/io.github.wnijhof.tickory.yml` | De versiecode (wordt uit `package.json` berekend) met de reviewers afstemmen; `fdroid build` lokaal of in hun CI |
| `../fastlane/` | F-Droid en IzzyOnDroid | Leest de catalogus zelf uit de repo | Na nieuwe schermafbeeldingen: `node scripts/fastlane-shots.ts`; per release een `changelogs/<versiecode>.txt` (0.10.6 = 1006) |

**IzzyOnDroid** (sneller dan F-Droid; neemt de APK van de GitHub-release): een aanvraag op https://codeberg.org/IzzyOnDroid/repodata/issues
met het sjabloon *App Request*. De APK is 2,9 MB, zonder bibliotheken van derden buiten AndroidX en zonder eigen updater. Leg in de
aanvraag de rechten uit: locatie op de achtergrond alleen voor herinneringen op een plek (aan te zetten door de gebruiker), de
microfoon alleen om in te spreken, exacte wekkers voor herinneringen.

De teksten om Tickory aan te kondigen (Reddit, Lemmy, Hacker News, AlternativeTo, Tweakers, …) staan niet in de repo.
